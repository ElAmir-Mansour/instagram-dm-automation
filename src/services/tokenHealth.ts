/**
 * Noticing that the access token died, at the moment it dies.
 *
 * `creators.token_status` has existed since v12, and until now exactly two things wrote to it:
 * saving a token, and opening the dashboard's token page. Both are things a person does. So a
 * token that Meta revoked on Friday — because the password changed, or the app was
 * uninstalled, or the 60-day window elapsed — read as `valid` until somebody happened to look,
 * while every comment and every DM failed in the meantime. The whole product stops and nothing
 * says so.
 *
 * Meta does say so, on every single call, as code 190 with a subcode naming the reason. This
 * module is the hook that records it: every Meta send path calls `noteMetaFailure` in its catch
 * block, and a token death — and only a token death — flips the row.
 *
 * Deliberately narrow. It does not flip the status on a 10903 (the recipient blocked DMs), a
 * 200 (a missing scope, which is an app-review problem, not a token problem) or a transient
 * 500. Marking a working token invalid would send the operator to regenerate something that
 * was never broken, and there is no automatic path back to `valid` except the daily check.
 */
import axios from 'axios';
import { queryCount, queryOne } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { isTokenDeathError, metaErrorSubcode } from './http.js';
import { getTenant } from './tenant.js';

/** Why the token is dead, in words an operator can act on. Keyed by Meta's `error_subcode`. */
const SUBCODE_REASONS: Record<number, string> = {
    458: 'The app has been uninstalled or is no longer authorised for this account.',
    459: 'The account must log in to Facebook again (security checkpoint).',
    460: 'The account password was changed, which revokes every token issued before it.',
    463: 'The access token has expired.',
    467: 'The access token is invalid — the account has logged out.',
    492: 'The account is no longer an admin of the Page this token was issued for.',
};

export function tokenDeathReason(err: any): string {
    const subcode = metaErrorSubcode(err);
    const known = subcode !== undefined ? SUBCODE_REASONS[subcode] : undefined;
    const detail = known ?? 'Meta rejected the access token (code 190).';
    return subcode !== undefined ? `${detail} (subcode ${subcode})` : detail;
}

/**
 * Record a Meta failure against the creator's token health. Returns true if it flipped.
 *
 * Never throws: it runs inside catch blocks whose job is to record a *different* failure, and
 * masking that with a bookkeeping error would be strictly worse than not recording this.
 */
export async function noteMetaFailure(creatorId: string, err: any): Promise<boolean> {
    if (!isTokenDeathError(err)) return false;

    const reason = tokenDeathReason(err);

    try {
        // Only from 'valid'/'unknown', so that repeated failures across a batch of sends do not
        // rewrite the row (and its `token_last_checked_at`) once per failed send — the first
        // one is the interesting one, and it is the one that should be alerted on.
        const flipped = await queryCount(
            `UPDATE creators
                SET token_status = 'invalid',
                    token_error = $2,
                    token_last_checked_at = NOW()
              WHERE id = $1 AND token_status IS DISTINCT FROM 'invalid'`,
            [creatorId, reason]
        );

        if (flipped > 0) {
            // Alert on this one. It means the account is down until a human pastes a new token.
            log('error', 'token.death_detected', {
                creator_id: creatorId,
                meta_subcode: metaErrorSubcode(err) ?? null,
                reason,
            });
        }
        return flipped > 0;
    } catch (bookkeepingErr) {
        log('warn', 'token.death_record_failed', describeError(bookkeepingErr));
        return false;
    }
}

// ─── Asking Meta on purpose ─────────────────────────────────────────────────────────────
//
// Everything above is passive: it notices a token death that a real send already ran into.
// That is the right default — it costs nothing and it catches the failure at the moment it
// happens — but it leaves `token_status` unable to ever improve, and unable to say anything
// at all until something fails. In practice the column was weeks stale and read `valid`
// because the last person to open the dashboard's token page caught a working token.
//
// So there is now an explicit action. It is a deliberate outbound call triggered by a person,
// never by a page load: `GET /api/settings/token/status` already calls `debug_token` on every
// render, which is one Meta round-trip per dashboard visit. The health endpoint reads the
// stored columns instead, which is why the two dates below have to be persisted rather than
// returned and discarded.

/** The scopes this app's own paths need. Missing any one disables a feature silently. */
export const REQUIRED_SCOPES: readonly string[] = [
    'instagram_basic',
    'instagram_manage_comments',   // read comments, post public replies
    'instagram_manage_messages',   // private replies + DMs
    'instagram_content_publish',   // scheduled IG posts and reels
    'pages_messaging',             // Facebook DMs
    'pages_manage_engagement',     // comment replies / likes on FB
    'pages_manage_metadata',       // webhook subscription management
    'pages_manage_posts',          // scheduled FB posts
    'pages_read_engagement',
    'pages_read_user_content',
    'pages_show_list',
    'business_management',
];

/** What `debug_token` said, normalised. Never carries the token itself. */
export interface TokenInspection {
    isValid: boolean;
    /** 'PAGE' is the only type that can post private replies or publish. */
    type: string | null;
    expiresAt: Date | null;
    dataAccessExpiresAt: Date | null;
    scopes: string[];
    missingScopes: string[];
    /** Operator-facing reason the token is not healthy, or null. */
    error: string | null;
}

/**
 * Turn a `debug_token` response body into the columns and the words an operator needs.
 *
 * Pure, and separate from the HTTP call, because the interesting cases are all shapes of
 * response rather than shapes of network failure: a USER token Meta says is perfectly valid,
 * a never-expiring page token whose `expires_at` is 0, a data-access window that has already
 * lapsed, a valid token missing `instagram_manage_messages`.
 */
export function describeInspection(data: any): TokenInspection {
    const isValid = Boolean(data?.is_valid);
    const type = typeof data?.type === 'string' ? data.type : null;
    const scopes: string[] = Array.isArray(data?.scopes)
        ? data.scopes.filter((s: unknown): s is string => typeof s === 'string')
        : [];
    const missingScopes = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));

    // `expires_at: 0` means a never-expiring page token, which is what this app needs — so 0
    // is stored as NULL, not as the epoch. Getting that wrong would render "expired 56 years
    // ago" on a perfectly healthy token.
    const expiresAt = typeof data?.expires_at === 'number' && data.expires_at > 0
        ? new Date(data.expires_at * 1000)
        : null;
    const dataAccessExpiresAt = typeof data?.data_access_expires_at === 'number' && data.data_access_expires_at > 0
        ? new Date(data.data_access_expires_at * 1000)
        : null;

    // One reason, most severe first. The dashboard shows a single line, and "wrong type" is
    // more actionable than "missing scopes" on a token that cannot work at all.
    let error: string | null = null;
    if (!isValid) {
        const metaMessage = typeof data?.error?.message === 'string' ? data.error.message : null;
        error = metaMessage
            ? `Meta reports the token as not valid: ${metaMessage}`
            : 'Meta reports the token as not valid.';
    } else if (type && type !== 'PAGE') {
        error = `Wrong token type: "${type}". A PAGE access token is required — a USER token `
            + 'cannot post private replies or publish.';
    } else if (dataAccessExpiresAt && dataAccessExpiresAt.getTime() < Date.now()) {
        // Separate from expiry and easy to miss: data access lapses 90 days after the user
        // last re-authorised, and reads start failing while the token still reports valid.
        error = 'Data access has expired — the account must re-authorise the app. '
            + 'The token still reports valid, but reads will fail.';
    } else if (missingScopes.length) {
        error = `Missing ${missingScopes.length} required scope(s): ${missingScopes.join(', ')}.`;
    }

    return { isValid, type, expiresAt, dataAccessExpiresAt, scopes, missingScopes, error };
}

/**
 * The status this inspection should write to `creators.token_status`.
 *
 * A token Meta accepts but which is the wrong type, or has lost data access, is not `valid` in
 * any sense the product cares about — every send through it fails. Missing scopes are a
 * different thing: the token works, some features do not, and marking it invalid would send
 * the operator to regenerate something that is not broken. That case stays `valid` with the
 * reason in `token_error`.
 */
export function inspectionStatus(inspection: TokenInspection): 'valid' | 'invalid' {
    if (!inspection.isValid) return 'invalid';
    if (inspection.type && inspection.type !== 'PAGE') return 'invalid';
    if (inspection.dataAccessExpiresAt && inspection.dataAccessExpiresAt.getTime() < Date.now()) return 'invalid';
    return 'valid';
}

/**
 * Ask Meta about one token.
 *
 * Prefers an app access token (`{app-id}|{app-secret}`) for `access_token`, which is what
 * `scripts/diagnose.mjs` uses: it is the documented way to call `debug_token` and it reliably
 * returns `data_access_expires_at`, which inspecting a token with itself does not. Falls back
 * to the token inspecting itself when the app credentials are not configured, because that is
 * what `/api/settings/token/status` already does and it demonstrably works in production.
 *
 * Never logs or returns the token. A thrown axios error is the caller's to handle.
 */
export async function inspectToken(token: string): Promise<TokenInspection> {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const accessToken = appId && appSecret ? `${appId}|${appSecret}` : token;

    const response = await axios.get('https://graph.facebook.com/debug_token', {
        params: { input_token: token, access_token: accessToken },
        timeout: 10_000,
    });
    return describeInspection(response.data?.data);
}

/**
 * The persisted state after a re-check.
 *
 * Two naming conventions in one object, on purpose. The `token*` keys match
 * `GET /api/health/tenant`, so a re-check can be merged straight into a health object. The
 * bare `status` / `type` / `expiresAt` / `error` keys match `GET /api/settings/token/status`,
 * so the dashboard can feed a re-check response into the renderer it already has for the token
 * page and re-render without a second fetch. Duplicating four fields is cheaper than asking
 * the UI to keep two mappings in step, and much cheaper than changing the shape of either
 * existing endpoint.
 */
export interface TokenRecheckResult {
    tokenStatus: 'valid' | 'invalid' | 'no_token';
    tokenLastCheckedAt: string | null;
    tokenError: string | null;
    tokenType: string | null;
    tokenExpiresAt: string | null;
    dataAccessExpiresAt: string | null;
    scopes: string[];
    missingScopes: string[];

    /** Alias of `tokenStatus`, matching `/api/settings/token/status`. */
    status: 'valid' | 'invalid' | 'no_token';
    /** Alias of `tokenType`. */
    type: string | null;
    /** Alias of `tokenExpiresAt`. */
    expiresAt: string | null;
    /** Alias of `tokenError`. */
    error: string | null;
}

/**
 * Build the result once, so the two naming conventions cannot fall out of step.
 *
 * Every `return` in `recheckTenantToken` goes through here; adding a field to the interface
 * without adding it here is a compile error.
 */
function recheckResult(fields: {
    status: 'valid' | 'invalid' | 'no_token';
    checkedAt: string | null;
    error: string | null;
    type: string | null;
    expiresAt: string | null;
    dataAccessExpiresAt: string | null;
    scopes: string[];
    missingScopes: string[];
}): TokenRecheckResult {
    return {
        tokenStatus: fields.status,
        tokenLastCheckedAt: fields.checkedAt,
        tokenError: fields.error,
        tokenType: fields.type,
        tokenExpiresAt: fields.expiresAt,
        dataAccessExpiresAt: fields.dataAccessExpiresAt,
        scopes: fields.scopes,
        missingScopes: fields.missingScopes,

        status: fields.status,
        type: fields.type,
        expiresAt: fields.expiresAt,
        error: fields.error,
    };
}

/**
 * Write the four columns and return the timestamp that landed.
 *
 * `RETURNING token_last_checked_at` rather than `new Date()` so the response reports the
 * database's clock — the same clock the health endpoint reads back, and the one an operator
 * compares against `NOW()` when they wonder how stale a status is.
 */
async function persistInspection(
    creatorId: string,
    status: 'valid' | 'invalid',
    error: string | null,
    expiresAt: Date | null,
    dataAccessExpiresAt: Date | null
): Promise<string | null> {
    try {
        const row = await queryOne<{ token_last_checked_at: Date | null }>(
            `UPDATE creators
                SET token_status = $2,
                    token_error = $3,
                    token_expires_at = $4,
                    token_data_access_expires_at = $5,
                    token_last_checked_at = NOW()
              WHERE id = $1
          RETURNING token_last_checked_at`,
            [creatorId, status, error, expiresAt, dataAccessExpiresAt]
        );
        return row?.token_last_checked_at?.toISOString() ?? null;
    } catch (err) {
        // Best-effort, exactly like `recordTokenStatus` in routes/api.ts: a failed write must
        // not turn a successful check into an error. The likeliest cause is migration v15 not
        // being applied, in which case the two new columns do not exist yet — and then a
        // re-check still reports the truth to the caller, it just cannot remember it.
        log('warn', 'token.recheck_record_failed', describeError(err));
        return null;
    }
}

/**
 * Re-check one tenant's stored token against Meta and persist what came back.
 *
 * This is the action the dashboard had no way to trigger: `token_status` only ever changed as
 * a side effect of somebody opening a page, so a token that died on Friday read `valid` until
 * Monday, and a token that was fixed on Friday read `invalid` just as long.
 *
 * Returns `null` when there is no such creator. A network failure to Meta is recorded as
 * `invalid` with the reason, which is the same conclusion `GET /settings/token/status` already
 * draws — nobody can tell "Meta is down" from "the token is dead" from here, and the
 * actionable reading is that sends are failing right now.
 */
export async function recheckTenantToken(creatorId: string): Promise<TokenRecheckResult | null> {
    const creator = await getTenant(creatorId, ['id', 'page_access_token']);
    if (!creator) return null;

    // Already decrypted by getTenant — every creator read goes through one place.
    const token = creator.page_access_token;

    if (!token) {
        const reason = 'No access token is stored for this tenant.';
        const checkedAt = await persistInspection(creatorId, 'invalid', reason, null, null);
        return recheckResult({
            status: 'no_token', checkedAt, error: reason,
            type: null, expiresAt: null, dataAccessExpiresAt: null,
            scopes: [], missingScopes: [...REQUIRED_SCOPES],
        });
    }

    let inspection: TokenInspection;
    try {
        inspection = await inspectToken(token);
    } catch (err: any) {
        const metaMessage = err?.response?.data?.error?.message;
        const reason = typeof metaMessage === 'string'
            ? `Meta rejected the token check: ${metaMessage}`
            : 'The token check call to Meta failed.';
        // `describeError` redacts anything token-shaped, and the token is not in these fields.
        log('warn', 'token.recheck_call_failed', { creator_id: creatorId, ...describeError(err) });

        const checkedAt = await persistInspection(creatorId, 'invalid', reason, null, null);
        return recheckResult({
            status: 'invalid', checkedAt, error: reason,
            type: null, expiresAt: null, dataAccessExpiresAt: null,
            scopes: [], missingScopes: [...REQUIRED_SCOPES],
        });
    }

    const status = inspectionStatus(inspection);
    const checkedAt = await persistInspection(
        creatorId, status, inspection.error, inspection.expiresAt, inspection.dataAccessExpiresAt
    );

    log('info', 'token.rechecked', {
        creator_id: creatorId,
        token_status: status,
        token_type: inspection.type,
        missing_scopes: inspection.missingScopes.length,
    });

    return recheckResult({
        status,
        checkedAt,
        error: inspection.error,
        type: inspection.type,
        expiresAt: inspection.expiresAt?.toISOString() ?? null,
        dataAccessExpiresAt: inspection.dataAccessExpiresAt?.toISOString() ?? null,
        scopes: inspection.scopes,
        missingScopes: inspection.missingScopes,
    });
}
