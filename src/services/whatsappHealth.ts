/**
 * The daily WhatsApp health read (docs/specs/001-whatsapp-agent task T024, review H6): every connected number is asked about once a day, so a
 * dead token, a restriction or a quality drop is found by the cron instead of by the next customer who gets no answer. Webhooks (`account_*`
 * events, `whatsappAccount.ts`) are the fast path; this is the one that cannot be missed, because Meta delivers a webhook once and a
 * subscription can drift.
 *
 * Per connection, `checkConnectionHealth`:
 *
 *   1. `refreshHealth` (whatsappConnections.ts): reads the number from Meta and stores the facts in `profile`. Meta refusing the token or a
 *      permission (190, 200, 10) marks the connection `invalid`; a hiccup (a timeout, a 5xx) changes nothing. The two extra reads it makes
 *      include `whatsapp_business_manager_messaging_limit` (review M12), best effort: a refusal costs the limit and nothing else.
 *   2. What changed since the last read becomes an alert, ONCE, through the same stored-value rule as the webhooks (whatsappAccount.ts): the
 *      quality rating, the messaging limit, the number's status, the name review. A first reading with nothing to compare it with is recorded,
 *      not announced.
 *   3. A connection that is `invalid` is reported once (`reportConnectionInvalid`), whichever path marked it: a token the sweep just saw
 *      refused, or one a send marked earlier and never told anyone about. One that came back to `active` after being reported says so.
 *
 * `refreshAllWhatsAppConnections` is the sweep for the daily cron. It NEVER throws: one tenant's failure is logged and counted and does not
 * stop the next, and a listing that fails returns zeros, because the cron that called it still has publishes to make.
 *
 * TODO(M12): the Messaging account's timezone (`GET /{waba_id}?fields=timezone_id`) is not read, so `channelUsage.periodOf` still counts in UTC
 * while Meta's free tier resets in the account's own month. It needs a WABA-level read that `getPhoneNumberHealth` does not make.
 */
import { queryRows } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { metaErrorCode } from './http.js';
import { commitAndNotify, reportConnectionInvalid, type Change } from './whatsappAccount.js';
import { getConnection, isAuthRefusal, refreshHealth, WhatsAppNotConnectedError, type WhatsAppConnection } from './whatsappConnections.js';

/** The ratings Meta reports, in the words the owner is told. `UNKNOWN` (not enough data yet) is not news. */
const RATINGS: ReadonlySet<string> = new Set(['GREEN', 'YELLOW', 'RED']);
/** Name-review results that are worth telling: the others (`PENDING_REVIEW`, `NONE`, `AVAILABLE_WITHOUT_REVIEW`) are a wait, not an answer. */
const NAME_ANSWERS: ReadonlySet<string> = new Set(['APPROVED', 'DECLINED', 'EXPIRED']);

/** What the daily read of one number made of it. */
export interface HealthCheck {
    /** `skipped`: nothing to read (no connection, disconnected, no token). `invalid`: the connection is not usable. */
    outcome: 'ok' | 'skipped' | 'invalid';
    /** Owner alerts sent (or deliberately off). */
    alerts: number;
    /** Alerts that could not be delivered; they are tried again tomorrow, because the stored value was given back. */
    alertFailures: number;
}

/** The changes between two reads of one connection, as `Change`s the stored-value rule can decide on. Pure. */
export function healthChanges(before: WhatsAppConnection, after: WhatsAppConnection): Change[] {
    const b = before.profile;
    const a = after.profile;
    const changes: Change[] = [];

    if (a.quality_rating) {
        const to = a.quality_rating;
        changes.push({
            key: 'quality', sig: to, fallback: () => b.quality_rating, silentWithoutPrevious: true, patch: { quality_rating: to },
            alert: (from) => (RATINGS.has(to) ? { kind: 'quality', from, to } : null),
        });
    }
    if (a.messaging_limit) {
        const to = a.messaging_limit;
        changes.push({
            key: 'limit', sig: to, fallback: () => b.messaging_limit, silentWithoutPrevious: true, patch: { messaging_limit: to },
            alert: (from) => ({ kind: 'limit', from, to }),
        });
    }
    if (a.number_status) {
        const to = a.number_status;
        changes.push({
            key: 'number_status', sig: to, fallback: () => b.number_status, silentWithoutPrevious: true, patch: { number_status: to },
            alert: (from) => ({ kind: 'number_status', from, to }),
        });
    }
    if (a.name_status) {
        const status = a.name_status;
        const name = after.displayName;
        changes.push({
            // The same value the `phone_number_name_update` webhook stores, so one review is one alert whichever Meta reports first.
            key: 'name', sig: `${status}:${name ?? ''}`,
            fallback: () => (b.name_status ? `${b.name_status}:${before.displayName ?? ''}` : null),
            silentWithoutPrevious: true,
            patch: { name_status: status },
            alert: () => (NAME_ANSWERS.has(status) ? { kind: 'name', decision: status, name, reason: null } : null),
        });
    }
    if (after.status === 'active') {
        // `active` is the stored value unless the owner was told the connection was invalid: only then is coming back news.
        changes.push({ key: 'connection', sig: 'active', fallback: () => 'active', alert: () => ({ kind: 'connection_restored' }) });
    }
    return changes;
}

/**
 * Read one tenant's number and tell the owner what changed. Throws only for what is neither a refusal of the token nor a skip (a timeout, a
 * database error): the sweep counts that against this tenant alone, and the next day asks again.
 */
export async function checkConnectionHealth(creatorId: string): Promise<HealthCheck> {
    const skipped: HealthCheck = { outcome: 'skipped', alerts: 0, alertFailures: 0 };
    const before = await getConnection(creatorId);
    if (!before || before.status === 'revoked' || !before.hasToken) return skipped;

    let after: WhatsAppConnection | null;
    let refusal: { code: number | null; reason: string } | null = null;
    try {
        after = await refreshHealth(creatorId);
    } catch (err) {
        if (err instanceof WhatsAppNotConnectedError) return skipped;
        if (!isAuthRefusal(err)) throw err;
        // `refreshHealth` has already marked it `invalid` with Meta's words; what is left is to tell the owner.
        refusal = { code: metaErrorCode(err) ?? null, reason: (err as Error).message };
        after = await getConnection(creatorId);
    }
    if (!after) return skipped;

    const tally = { alerts: 0, alertFailures: 0 };
    const count = (result: string) => {
        if (result === 'alerted') tally.alerts++;
        else if (result === 'alertFailed') tally.alertFailures++;
    };

    if (after.status === 'invalid') {
        count(await reportConnectionInvalid(after.id, refusal ?? { code: null, reason: after.lastError }));
        if (refusal) return { outcome: 'invalid', ...tally }; // the read failed: there are no new facts to compare
    }
    for (const change of healthChanges(before, after)) count(await commitAndNotify(after.id, change));
    log('info', 'wa.health_checked', { connection_id: after.id, creator_id: creatorId, status: after.status, alerts: tally.alerts });
    return { outcome: after.status === 'invalid' ? 'invalid' : 'ok', ...tally };
}

export interface HealthSweepResult {
    /** Numbers read (or refused: they were asked). */
    checked: number;
    /** Of those, connections that are not usable now. */
    invalid: number;
    alerts: number;
    alertFailures: number;
    /** Nothing to read: no token, or disconnected between the listing and the read. */
    skipped: number;
    /** Numbers whose read failed for a reason that is not the token (a timeout, a database error): left as they were. */
    failed: number;
    moreRemaining: boolean;
}

/** Meta's management API allows 200 reads an hour per account and each number costs three: a day's sweep is well inside it at this size. */
const SWEEP_LIMIT = 50;

/**
 * The daily sweep over every non-disconnected WhatsApp connection, least recently read first. NEVER throws, whatever a tenant or the database
 * does (see the header).
 */
export async function refreshAllWhatsAppConnections(options: { limit?: number } = {}): Promise<HealthSweepResult> {
    const limit = Math.max(1, options.limit ?? SWEEP_LIMIT);
    const result: HealthSweepResult = { checked: 0, invalid: 0, alerts: 0, alertFailures: 0, skipped: 0, failed: 0, moreRemaining: false };

    let rows: Array<{ creator_id: string }>;
    try {
        rows = await queryRows<{ creator_id: string }>(
            `SELECT creator_id FROM platform_connections
              WHERE platform = 'whatsapp' AND status <> 'revoked' AND access_token IS NOT NULL
              ORDER BY last_refreshed_at NULLS FIRST, id
              LIMIT $1`,
            [limit + 1]
        );
    } catch (err) {
        log('error', 'wa.health_sweep_failed', describeError(err));
        return result;
    }
    result.moreRemaining = rows.length > limit;

    for (const row of rows.slice(0, limit)) {
        try {
            const check = await checkConnectionHealth(row.creator_id);
            if (check.outcome === 'skipped') result.skipped++;
            else result.checked++;
            if (check.outcome === 'invalid') result.invalid++;
            result.alerts += check.alerts;
            result.alertFailures += check.alertFailures;
        } catch (err) {
            result.failed++;
            log('warn', 'wa.health_sweep_row_failed', { creator_id: row.creator_id, ...describeError(err) });
        }
    }
    return result;
}
