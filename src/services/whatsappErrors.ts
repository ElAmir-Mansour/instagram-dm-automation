/**
 * What a WhatsApp Cloud API error code means for the send that produced it: stop, back off, or "we do not know".
 *
 * **WhatsApp-only, and deliberately not `PERMANENT_CODES` in `src/services/http.ts`.** That set is Instagram's
 * (`{190, 200, 10903}`), it drives `withRetry` and the DM handoff, and a pinned test (http.test.ts) keeps it
 * exactly that. Codes such as 131047 mean nothing on Instagram; folding them in would change how every
 * Instagram send retries. WhatsApp's own sends classify through here instead.
 *
 * **Most of these do not arrive as HTTP errors** (review M8). A Cloud API send is accepted (200 with a `wamid`)
 * and then fails asynchronously: the failure comes back later as a `statuses[]` webhook with `status: 'failed'`
 * and `errors[]` (see `WaStatus.errors` in `src/webhook/whatsapp.ts`). 131047, 131026, 131049, 131050 and 131042
 * are the usual ones. The HTTP path (`POST /{phone_number_id}/messages` answering 4xx) carries the token and
 * permission codes (190, 200, 10), throughput (130429) and the media codes. So the status handler and the send
 * path both ask this module, and what each does with the answer (notify, mark the connection invalid, record
 * consent as withdrawn) is theirs, not this file's.
 *
 * Every code below was checked on Meta's official pages on 2026-10-19; each says which page. A code that could
 * not be confirmed on an official page would be marked `// unconfirmed`; there are none today.
 *
 *   E = https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 *
 * Out of scope on purpose (they classify as 'unknown' and fall back to the caller's default):
 *   - 131049 (per-user marketing limit): marketing templates are not sent in v1 (review L1). Official page: E.
 *   - 131060 (message currently unavailable): arrives on an INBOUND message as `errors[]`, not on a send.
 *     https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/unsupported
 *   - 0, 3 and 200-299 (more token/permission codes, E "Authorization errors"): only 190, 200 and 10 are
 *     treated as permanent here, as specified; widen deliberately, with a test, if one is ever seen in production.
 */

export type WhatsAppErrorKind = 'permanent' | 'retryable' | 'unknown';

export type WhatsAppErrorReason =
    | 'window_closed'
    | 'undeliverable'
    | 'marketing_opt_out'
    | 'unsupported'
    | 'media_too_big'
    | 'bad_mime'
    | 'payment_issue'
    | 'token_or_permission'
    | 'pair_rate_limit'
    | 'throughput';

export interface WhatsAppErrorClassification {
    kind: WhatsAppErrorKind;
    /** Why, in a word the handlers switch on. Null exactly when `kind` is 'unknown'. */
    reason: WhatsAppErrorReason | null;
}

interface Entry {
    kind: 'permanent' | 'retryable';
    reason: WhatsAppErrorReason;
}

const ENTRIES: ReadonlyMap<number, Entry> = new Map<number, Entry>([
    // 131047: "More than 24 hours have passed since the recipient last replied to the sender number." Fix: send a
    // template instead. Never retried: the window does not reopen by waiting, only by the customer writing.
    // Confirmed on E (Other errors); the window rule itself is src/services/channels/window.ts.
    [131047, { kind: 'permanent', reason: 'window_closed' }],

    // 131026: "Unable to deliver message": not a WhatsApp number, has not accepted the new Terms, or an old client.
    // Confirmed on E (Other errors). None of those reasons is fixed by the business retrying; the page's advice is to
    // ask the customer, by other means, to update WhatsApp or accept the terms.
    [131026, { kind: 'permanent', reason: 'undeliverable' }],

    // 131050: "This recipient has chosen to stop receiving marketing messages." Meta: "Do not retry sending messages
    // to this user". Confirmed on E (Other errors). The consent record (`contact_consents`, withdrawn) is the status
    // handler's job; the user_preferences webhook is the other source of the same fact.
    [131050, { kind: 'permanent', reason: 'marketing_opt_out' }],

    // 131051: "Unsupported message type." Confirmed on E (Other errors), and on the unsupported-message webhook page
    // https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/unsupported
    // (error 131051 on an inbound `type: "unsupported"` message).
    [131051, { kind: 'permanent', reason: 'unsupported' }],

    // 131052: "Unable to download the media sent by the user." The media page ties it to size: the maximum for Cloud
    // API media is 100 MB and a larger file from the customer produces a webhook with 131052.
    // Confirmed on E (Other errors) and
    // https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
    // It is an INBOUND error (a messages[].errors entry), so a send never fails with it; classified so one place knows it.
    [131052, { kind: 'permanent', reason: 'media_too_big' }],

    // 131053: "Unable to upload the media used in the message." Meta names an unsupported media type as the example,
    // and the media page calls a mismatched MIME type (131053) "a common error". Confirmed on E (Other errors) and
    // on the media page above. The send would fail the same way again, so it is not retried.
    [131053, { kind: 'permanent', reason: 'bad_mime' }],

    // 131042: "There was an error related to your payment method." (no payment account attached, credit line over the
    // limit or inactive, account suspended, timezone/currency not set, ...). Confirmed on E (Other errors). Nothing the
    // retry loop can fix: the owner has to add or repair a payment method, so the connection is marked invalid.
    [131042, { kind: 'permanent', reason: 'payment_issue' }],

    // 190: "Your access token has expired." Confirmed on E (Authorization errors). Same code the Instagram path
    // treats as permanent, and for the same reason: hammering Meta with a dead token attracts enforcement attention.
    [190, { kind: 'permanent', reason: 'token_or_permission' }],

    // 200: on E (Authorization errors): "No access token was provided" on certain GET endpoints; the same page lists
    // 200-299 as "Permission is either not granted or has been removed". Confirmed on E.
    [200, { kind: 'permanent', reason: 'token_or_permission' }],

    // 10: "Permission is either not granted or has been removed." Confirmed on E (Authorization errors).
    [10, { kind: 'permanent', reason: 'token_or_permission' }],

    // 131056: pair rate limit: "Too many messages sent from the sender phone number to the same recipient phone
    // number in a short period of time." Meta: "Wait and retry". Confirmed on E (Throttling errors). The backoff rule
    // (retry after 4^X seconds, X from 0, +1 per failure) is on
    // https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform#pair-rate-limits
    // (1 message per 6 s to the same user, bursts of up to 45 borrow from the future quota).
    [131056, { kind: 'retryable', reason: 'pair_rate_limit' }],

    // 130429: "Cloud API message throughput has been reached." Meta: "Try again later or reduce the frequency".
    // Confirmed on E (Throttling errors) and https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput
    // ("the API will return error code 130429 until you are within your allowed level again").
    [130429, { kind: 'retryable', reason: 'throughput' }],
]);

/** The codes that must never be retried, for `src/services/whatsapp.ts`. Read-only; derived from the one table above. */
export const WHATSAPP_PERMANENT_CODES: ReadonlySet<number> = new Set(
    [...ENTRIES].filter(([, entry]) => entry.kind === 'permanent').map(([code]) => code),
);

/** The codes worth retrying with backoff (4^n seconds for the pair rate limit), for `src/services/whatsapp.ts`. */
export const WHATSAPP_RETRYABLE_CODES: ReadonlySet<number> = new Set(
    [...ENTRIES].filter(([, entry]) => entry.kind === 'retryable').map(([code]) => code),
);

/** An error code as it arrives: a JSON integer in a webhook, occasionally a digit string once it has been through a log or a DB column. */
function toCode(code: unknown): number | null {
    if (typeof code === 'number') return Number.isInteger(code) ? code : null;
    if (typeof code === 'string' && /^\d{1,9}$/.test(code.trim())) return Number(code.trim());
    return null;
}

/**
 * Classify a WhatsApp error code. 'unknown' (with a null reason) for a code that is not in the table, is not an
 * integer, or is missing: the caller decides its own default (the existing `withRetry` policy for an HTTP error, a
 * stored `failed` status with the code for a webhook one) rather than this function guessing.
 */
export function classifyWhatsAppError(code: unknown): WhatsAppErrorClassification {
    const numeric = toCode(code);
    const entry = numeric === null ? undefined : ENTRIES.get(numeric);
    return entry ? { kind: entry.kind, reason: entry.reason } : { kind: 'unknown', reason: null };
}
