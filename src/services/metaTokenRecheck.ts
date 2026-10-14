/**
 * The daily recheck of every connected tenant's Meta token (plan P29; docs/onboarding/04 §2, "Token health").
 *
 * Until now a token's health was written by two kinds of thing: a failed send that ran into a code 190 (`noteMetaFailure`), and a
 * person pressing Re-check. Nothing looked at a tenant that was quiet, so a token Meta had revoked, or an Instagram data-access
 * window that was about to lapse (about 90 days after the person last approved the app: no `instagram_*` permission is exempt),
 * stayed `valid` on the dashboard until the first comment went unanswered. This is the sweep the daily cron runs next to the
 * TikTok and YouTube refreshes: it asks Meta (`debug_token`) about each connected tenant's Page token and writes what Meta said.
 *
 * ─── What it concludes, and what it refuses to conclude ─────────────────────
 * Four verdicts (`classifyDebugToken`, `classifyCheckFailure`):
 *
 *   valid      Meta says the token is valid, and it is a PAGE token with nothing about to lapse. A PAGE token with
 *              `expires_at: 0` (never expires: the owner's, and every one a Login connection produces) is valid.
 *   expiring   valid now, but `data_access_expires_at` (or a real `expires_at`) is less than `RECONNECT_DUE_DAYS` away.
 *   invalid    Meta answered, and the answer is a definitive no: `is_valid: false`, a token of the wrong type, or data access
 *              that has already lapsed (reads fail while the token still reports valid).
 *   transient  anything else: the call failed (a timeout, a 5xx, a rate limit, a refused app token, no network), or Meta's answer
 *              does not have the shape of an answer. **This is never written down.** Marking a working token invalid sends its
 *              owner to reconnect something that was never broken, and "Meta had a bad minute" is exactly what a daily sweep meets.
 *
 * "Reconnect due" is not a column of its own: it is what `getMetaConnection` derives from the stored status and dates, so only a
 * definitive `invalid` or `expiring` result can ever raise it, and the next valid result clears it (the person reconnected).
 *
 * ─── What it writes ──────────────────────────────────────────────────────────
 * For the three definitive verdicts, the five health columns a manual Re-check writes (`persistInspection`: status, error, the two
 * expiry dates, last-checked), and nothing else: not the Page ids, not the token, not the `meta_*` columns. For a transient
 * verdict, NOTHING: not even `token_last_checked_at`, so the tenant is also the first one the next sweep asks. The owner's tenant
 * is one of these rows like any other: his never-expiring PAGE token classifies as valid, and a Meta outage leaves his row exactly
 * as it was.
 */
import { queryRows } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { RECONNECT_DUE_DAYS } from './metaLogin.js';
import { getTenant } from './tenant.js';
import { describeInspection, fetchDebugToken, inspectionStatus, persistInspection, type TokenInspection } from './tokenHealth.js';

export type RecheckKind = 'valid' | 'expiring' | 'invalid' | 'transient';

export interface RecheckVerdict {
    kind: RecheckKind;
    /** Why, for a log line or an operator. Null for `valid`. Never carries a token. */
    reason: string | null;
    /** What to store: set for the three definitive verdicts, null for `transient`. */
    inspection: TokenInspection | null;
    /** For `expiring`: which date is near, and how many whole days are left (0 or more). */
    expiring: { by: 'data_access' | 'token'; days: number } | null;
}

/**
 * Codes that mean "Meta could not answer right now", not "the token is dead", whenever they show up inside an otherwise-parseable
 * `debug_token` answer: 1 and 2 (API unknown / service unavailable), 4, 17, 32 and 613 (rate limits), 341 and 368 (temporary blocks).
 */
const TRANSIENT_META_CODES: ReadonlySet<number> = new Set([1, 2, 4, 17, 32, 341, 368, 613]);

const DAY_MS = 86_400_000;

const transient = (reason: string): RecheckVerdict => ({ kind: 'transient', reason, inspection: null, expiring: null });

/**
 * A `debug_token` call that did not return an answer: never a verdict about the token. Every thrown error is transient, whatever
 * its code: when the call is made with the app's access token a code 190 on the CALL is about the app's own credentials (a
 * rotated secret), not about the tenant's token, and concluding "invalid" from it would flag every tenant at once.
 */
export function classifyCheckFailure(err: unknown): RecheckVerdict {
    const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
    return transient(typeof status === 'number' ? `Meta answered the check with HTTP ${status}.` : 'The check call to Meta did not complete.');
}

/**
 * What Meta's `data` object (the body of a successful `debug_token`) says about a token. Pure, so the shapes that matter are tested
 * without a network: the owner's never-expiring PAGE token, a token with a week of data access left, a revoked one, a body that is
 * not an answer at all.
 */
export function classifyDebugToken(data: unknown, now: number = Date.now()): RecheckVerdict {
    // Not an answer: no object, or no boolean `is_valid`. An empty 200, an error page, a proxy's body. `describeInspection` would
    // read all of those as "not valid", which is the one reading this module exists to avoid.
    if (typeof data !== 'object' || data === null || Array.isArray(data) || typeof (data as { is_valid?: unknown }).is_valid !== 'boolean') {
        return transient('Meta answered the check with something that is not a token inspection.');
    }

    const body = data as { is_valid: boolean; error?: { code?: unknown } };
    const inspection = describeInspection(body);

    if (!body.is_valid) {
        const code = body.error?.code;
        // "Not valid" because Meta could not look, not because the token is dead.
        if (typeof code === 'number' && TRANSIENT_META_CODES.has(code)) {
            return transient(`Meta could not inspect the token right now (code ${code}).`);
        }
        return { kind: 'invalid', reason: inspection.error, inspection, expiring: null };
    }

    // The same reading the rest of the product uses (`inspectionStatus`): a wrong type, or data access that already lapsed, is
    // invalid even though Meta calls the token valid.
    if (inspectionStatus(inspection) === 'invalid') {
        return { kind: 'invalid', reason: inspection.error, inspection, expiring: null };
    }

    // Valid, and the date that lapses first. `describeInspection` has already turned `0` (never expires) and a missing date into
    // null, so a token with no end date cannot be "expiring".
    const dated: Array<{ by: 'data_access' | 'token'; at: Date }> = [];
    if (inspection.dataAccessExpiresAt) dated.push({ by: 'data_access', at: inspection.dataAccessExpiresAt });
    if (inspection.expiresAt) dated.push({ by: 'token', at: inspection.expiresAt });
    const next = dated.sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    if (next && next.at.getTime() - now < RECONNECT_DUE_DAYS * DAY_MS) {
        const days = Math.max(0, Math.ceil((next.at.getTime() - now) / DAY_MS));
        return {
            kind: 'expiring',
            reason: next.by === 'data_access'
                ? `Instagram data access ends in ${days} day(s): the account must reconnect to renew it.`
                : `The access token expires in ${days} day(s).`,
            inspection,
            expiring: { by: next.by, days },
        };
    }
    return { kind: 'valid', reason: null, inspection, expiring: null };
}

// ─── The sweep ──────────────────────────────────────────────────────────────────────────

export interface RecheckSweepResult {
    /** Tenants Meta was asked about. */
    checked: number;
    valid: number;
    expiring: number;
    invalid: number;
    /** Meta could not be reached or did not answer: nothing was written for these. */
    transient: number;
    /** A connected tenant whose token could not be read or whose row vanished: nothing asked, nothing written. */
    skipped: number;
    /** There were more connected tenants than this run's limit or time budget allowed. They are first in line tomorrow. */
    moreRemaining: boolean;
}

export interface RecheckSweepOptions {
    /** At most this many tenants per run (default 100). */
    limit?: number;
    /** Stop asking after this long (default 20 s): one slow Meta must not eat the daily cron's whole invocation. */
    budgetMs?: number;
    /** The clock, for the deadline. */
    now?: () => number;
}

/** The outcome for one tenant, so a test can see what a single check decided. */
export async function recheckOneMetaToken(creatorId: string, now: number = Date.now()): Promise<RecheckKind | 'skipped'> {
    let token: string | null | undefined;
    try {
        token = (await getTenant(creatorId, ['id', 'page_access_token']))?.page_access_token;
    } catch (err) {
        // A token that cannot be decrypted (a rotated key) is an operator's problem and is not Meta's verdict on anything.
        log('warn', 'token.recheck_unreadable', { creator_id: creatorId, ...describeError(err) });
        return 'skipped';
    }
    if (!token) return 'skipped';

    let verdict: RecheckVerdict;
    try {
        verdict = classifyDebugToken(await fetchDebugToken(token), now);
    } catch (err) {
        verdict = classifyCheckFailure(err);
        log('warn', 'token.recheck_transient', { creator_id: creatorId, reason: verdict.reason, ...describeError(err) });
        return verdict.kind;
    }

    if (verdict.kind === 'transient' || !verdict.inspection) {
        log('warn', 'token.recheck_transient', { creator_id: creatorId, reason: verdict.reason });
        return 'transient';
    }

    const inspection = verdict.inspection;
    await persistInspection(
        creatorId, verdict.kind === 'invalid' ? 'invalid' : 'valid', inspection.error, inspection.expiresAt, inspection.dataAccessExpiresAt
    );
    if (verdict.kind === 'invalid' || verdict.kind === 'expiring') {
        // Alert-worthy: the tenant's replies stop (invalid) or will stop (expiring) unless its owner reconnects.
        log(verdict.kind === 'invalid' ? 'error' : 'warn', 'token.reconnect_due', {
            creator_id: creatorId, verdict: verdict.kind, reason: verdict.reason,
            expiring_by: verdict.expiring?.by, days_left: verdict.expiring?.days,
        });
    }
    return verdict.kind;
}

/**
 * Recheck every connected tenant, oldest check first (a tenant whose last attempt was transient wrote nothing and so sorts to the
 * front of the next run). Never throws: it runs inside the daily cron, whose publishes must not depend on it. Sequential, with a
 * deadline: Meta is asked about one token at a time, and a run that is out of time leaves the rest for tomorrow, in order.
 */
export async function recheckAllMetaTokens(options: RecheckSweepOptions = {}): Promise<RecheckSweepResult> {
    const clock = options.now ?? Date.now;
    const deadline = clock() + (options.budgetMs ?? 20_000);
    const limit = Math.max(1, Math.floor(options.limit ?? 100));
    const result: RecheckSweepResult = { checked: 0, valid: 0, expiring: 0, invalid: 0, transient: 0, skipped: 0, moreRemaining: false };

    let ids: string[];
    try {
        const rows = await queryRows<{ id: string }>(
            `SELECT id FROM creators
              WHERE page_access_token IS NOT NULL
              ORDER BY token_last_checked_at ASC NULLS FIRST, id
              LIMIT $1`,
            [limit + 1]
        );
        ids = rows.map((r) => r.id);
    } catch (err) {
        log('error', 'token.recheck_sweep_failed', describeError(err));
        return result;
    }
    if (ids.length > limit) {
        result.moreRemaining = true;
        ids = ids.slice(0, limit);
    }

    for (const id of ids) {
        if (clock() >= deadline) {
            result.moreRemaining = true;
            break;
        }
        try {
            const outcome = await recheckOneMetaToken(id, clock());
            if (outcome === 'skipped') {
                result.skipped++;
                continue;
            }
            result.checked++;
            result[outcome]++;
        } catch (err) {
            // Nothing in `recheckOneMetaToken` is meant to throw; a database failure writing one verdict is that tenant's alone.
            result.skipped++;
            log('error', 'token.recheck_row_failed', { creator_id: id, ...describeError(err) });
        }
    }
    return result;
}
