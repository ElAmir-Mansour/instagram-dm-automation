/**
 * Meta's Deauthorize Callback (P33; docs/onboarding/04 §2, "Disconnect": "Later: a Deauthorize Callback that verifies `signed_request`").
 *
 * When a person removes the app from their Facebook account (Settings → Business Integrations), Meta POSTs a `signed_request` to the
 * "Deauthorize Callback URL" registered for the app, with no session and no user present. The person's tokens are already dead at Meta;
 * what is left is OUR copy of the Page token and the webhook subscription of every tenant that person connected. This module is the two
 * halves: reading the request (`parseSignedRequest`, pure) and acting on it (`disconnectMetaUser`).
 *
 * The format, from Meta's documentation of the callback's signed request
 * (https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback):
 *   - an HTTP POST whose form field `signed_request` is `<encoded signature>.<encoded payload>`;
 *   - both halves URL-safe base64 (`-` and `_` for `+` and `/`, padding dropped);
 *   - the signature is HMAC-SHA256 of the ENCODED payload string (not of its decoded JSON), keyed with the app secret;
 *   - the payload is JSON: `algorithm` (`HMAC-SHA256`), `issued_at`, optionally `expires`, and `user_id`, the app-scoped id of the person.
 * The Deauthorize Callback itself is described in the Facebook Login guide
 * (https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow, "Detecting When People Uninstall Apps"): it exists, it is
 * set in the App Dashboard, and the guide sends the reader to the page above for the request. It does not repeat the payload, so the format
 * implemented is that page's, and it has NOT been checked against a live deauthorize delivery (the App Dashboard's callback Test button, or
 * a real removal by a tester, is the check). Where Meta's text is silent (is `algorithm` always there? is `issued_at`?) the rule is: whatever
 * IS there must be right, and an absence is not a reason to turn a genuine request away.
 *
 * Three rules this module keeps, because the owner's tenant is connected today and his Page token must not move:
 *
 *   - **Nothing is acted on before the signature is.** The HMAC is checked, with every configured app secret (both, like
 *     `verifyMetaSignature`), before the payload is even parsed. A request with no secret to check it with is refused, never trusted.
 *   - **Only a tenant whose `meta_user_id` equals the id in the request, exactly, is touched.** The match is a parameterised `=` on a
 *     non-empty string: a NULL column (the owner's pasted-token connection, which has never had a `meta_user_id`) can never equal anything,
 *     and the clearing UPDATE repeats the condition, so a tenant reconnected by somebody else meanwhile is left alone too.
 *   - **A replayed request is stale.** Meta signs `issued_at`; one older than a day (or from the future) is refused, so a captured request
 *     cannot disconnect the tenant its person reconnects tomorrow.
 *
 * No secret, signature or payload is ever logged, and the audit row names the Pages and the outcome, never the person.
 */
import crypto from 'node:crypto';
import { queryRows } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { appSecrets } from '../utils/signature.js';
import { AUDIT_ACTIONS, writeAudit, type AuditActor } from './audit.js';
import { readCurrent, removeMetaConnection } from './metaLogin.js';

export const DEAUTHORIZE_PATH = '/api/meta/deauthorize';

/** Recorded as the actor of the audit rows this writes: nobody was signed in, and Meta said it. */
export const META_DEAUTHORIZE_ACTOR_EMAIL = 'system:meta-deauthorize';
const ACTOR: AuditActor = { userId: null, email: META_DEAUTHORIZE_ACTOR_EMAIL };

/** How old a signed request may be. Meta delivers within seconds; a day covers its retries and not a replay a week later. */
export const SIGNED_REQUEST_MAX_AGE_SECONDS = 24 * 60 * 60;
/** How far ahead of our clock `issued_at` may be before it is not believed. */
const CLOCK_SKEW_SECONDS = 5 * 60;
/** The most a `signed_request` field may hold: a real one is a few hundred characters. */
export const SIGNED_REQUEST_MAX_CHARS = 4096;

const SIGNATURE_BYTES = 32;
const BASE64 = /^[A-Za-z0-9_\-+/]+={0,2}$/;
/** An app-scoped user id: digits in practice. Wider on purpose (no id shape is promised), but never empty and never free text. */
const USER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export type SignedRequestFailure =
    | 'malformed'          // not `<signature>.<payload>`, not base64, not JSON, or a field of the wrong type
    | 'no_secret'          // nothing to check the signature with: refused, not trusted
    | 'bad_signature'      // the HMAC does not match any configured app secret
    | 'bad_algorithm'      // signed, but says something other than HMAC-SHA256
    | 'stale'              // issued too long ago or in the future, or past its `expires`
    | 'no_user';           // signed and fresh, but names nobody we can match on

export type ParsedSignedRequest =
    | { ok: true; userId: string; issuedAt: number | null }
    | { ok: false; reason: SignedRequestFailure; secretsTried: number };

const refuse = (reason: SignedRequestFailure, secretsTried = 0): ParsedSignedRequest => ({ ok: false, reason, secretsTried });

/** A decoded base64 (either alphabet) as bytes. */
const decode = (text: string): Buffer => Buffer.from(text, 'base64');

/**
 * Read and verify a `signed_request`. Pure: the clock and the secrets are arguments. Order matters and is the point: shape, then
 * signature, and only then the payload.
 */
export function parseSignedRequest(raw: unknown, opts: { secrets?: readonly string[]; now?: number } = {}): ParsedSignedRequest {
    const secrets = opts.secrets ?? appSecrets();
    const now = opts.now ?? Date.now();

    if (typeof raw !== 'string' || raw.length === 0 || raw.length > SIGNED_REQUEST_MAX_CHARS) return refuse('malformed');
    const parts = raw.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return refuse('malformed');
    const [encodedSignature, encodedPayload] = parts as [string, string];
    if (!BASE64.test(encodedSignature) || !BASE64.test(encodedPayload)) return refuse('malformed');

    const provided = decode(encodedSignature);
    // A signature of the wrong length is garbled, and would make timingSafeEqual throw rather than say no.
    if (provided.length !== SIGNATURE_BYTES) return refuse('malformed');

    if (secrets.length === 0) return refuse('no_secret');
    const signed = secrets.some((secret) => {
        const expected = crypto.createHmac('sha256', secret).update(encodedPayload).digest();
        return crypto.timingSafeEqual(expected, provided);
    });
    if (!signed) return refuse('bad_signature', secrets.length);

    // Only now is the payload read: it is Meta's.
    let payload: unknown;
    try {
        payload = JSON.parse(decode(encodedPayload).toString('utf8'));
    } catch {
        return refuse('malformed', secrets.length);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return refuse('malformed', secrets.length);
    const p = payload as Record<string, unknown>;

    if (p.algorithm !== undefined && (typeof p.algorithm !== 'string' || p.algorithm.toUpperCase() !== 'HMAC-SHA256')) return refuse('bad_algorithm', secrets.length);

    for (const field of ['issued_at', 'expires'] as const) {
        if (p[field] !== undefined && (typeof p[field] !== 'number' || !Number.isFinite(p[field]))) return refuse('malformed', secrets.length);
    }
    const issuedAt = typeof p.issued_at === 'number' ? p.issued_at : null;
    const nowSeconds = Math.floor(now / 1000);
    if (issuedAt !== null && (nowSeconds - issuedAt > SIGNED_REQUEST_MAX_AGE_SECONDS || issuedAt - nowSeconds > CLOCK_SKEW_SECONDS)) return refuse('stale', secrets.length);
    // `expires` of 0 or absent means "does not expire"; a time that has passed is a request that is no longer to be acted on.
    if (typeof p.expires === 'number' && p.expires > 0 && p.expires <= nowSeconds) return refuse('stale', secrets.length);

    // A number is not accepted for the id: JSON numbers past 2^53 are rounded, and a rounded id is somebody else's.
    if (typeof p.user_id !== 'string' || !USER_ID.test(p.user_id)) return refuse('no_user', secrets.length);
    return { ok: true, userId: p.user_id, issuedAt };
}

export interface DeauthOutcome {
    /** Tenants whose `meta_user_id` was this person's. */
    matched: number;
    /** Of those, connections cleared. */
    disconnected: number;
    /** Of those, ones that could not be cleared (a database error): the caller answers 5xx so Meta tries again. */
    failed: number;
}

/** Most tenants one person is expected to have connected. A bound on the work of one request, not a rule. */
const MAX_TENANTS_PER_PERSON = 100;

/**
 * Disconnect every tenant that this Facebook user connected: unsubscribe its Page from the webhook (best effort: the token is usually dead
 * already) and clear the ids, the token and the `meta_*` columns, as a Disconnect does, with one audit row per tenant. A tenant nobody
 * connected with this id is not looked at; a tenant with no `meta_user_id` (the owner's) is not a candidate for any id. Idempotent: a
 * second delivery finds nothing, because the first cleared the column it matches on.
 */
export async function disconnectMetaUser(metaUserId: string): Promise<DeauthOutcome> {
    // The same shape the signed request was accepted with, checked again where it becomes SQL: an empty or odd id must never reach a WHERE.
    if (!USER_ID.test(metaUserId)) return { matched: 0, disconnected: 0, failed: 0 };

    const tenants = await queryRows<{ id: string }>(
        'SELECT id FROM creators WHERE meta_user_id = $1 ORDER BY id LIMIT $2',
        [metaUserId, MAX_TENANTS_PER_PERSON]
    );
    const outcome: DeauthOutcome = { matched: tenants.length, disconnected: 0, failed: 0 };

    for (const { id } of tenants) {
        try {
            const current = await readCurrent(id);
            if (!current) continue;
            const { cleared, unsubscribed } = await removeMetaConnection(id, current, metaUserId);
            // Reconnected by someone else between the lookup and the write: not ours any more, and left as it is.
            if (!cleared) continue;
            outcome.disconnected++;
            await writeAudit(ACTOR, {
                action: AUDIT_ACTIONS.metaDeauthorize,
                targetType: 'creator',
                targetId: id,
                detail: {
                    facebook_page_id: current.facebookPageId,
                    instagram_page_id: current.instagramPageId,
                    unsubscribed_from_webhook: unsubscribed,
                    via: 'deauthorize_callback',
                },
            });
            log('info', 'meta.deauthorized', { creator_id: id, unsubscribed });
        } catch (err) {
            outcome.failed++;
            log('error', 'meta.deauthorize_failed', { creator_id: id, ...describeError(err) });
        }
    }
    return outcome;
}
