/**
 * The WhatsApp Cloud API, as a thin typed client over the Graph calls the rest of the app already makes (`metaHttp`, `withRetry`,
 * `GRAPH_BASE`): no SDK (docs/specs/001-whatsapp-agent/research.md R9), one function per endpoint, and nothing here knows about tenants,
 * databases or conversations. Which phone number and which token to use is the caller's business (`whatsappConnections.ts` owns them).
 *
 *   getPhoneNumberHealth   GET    /{phone_number_id}?fields=…        the facts the Settings card shows (quality, name status, limits)
 *   subscribeApp           POST   /{waba_id}/subscribed_apps         the app starts receiving this account's webhooks
 *   unsubscribeApp         DELETE /{waba_id}/subscribed_apps         …and stops
 *   sendMessage            POST   /{phone_number_id}/messages        a message to a person. NEVER retried once it may have been sent
 *   markReadWithTyping     POST   /{phone_number_id}/messages        read receipt + typing indicator. Best effort, never retried
 *   getMediaUrl            GET    /{media_id}                        the short-lived URL of an inbound file
 *   downloadMedia          GET    <that url>                         its bytes
 *
 * Nothing calls `sendMessage` yet: the sending path (`channels/send.ts`) is a later phase, and until then this file only reads.
 *
 * The token travels in the `Authorization` header and never in a URL, as for every other Graph call in this app. A Graph failure is
 * rewrapped by `metaFailure` into a `MetaApiError` that keeps `metaCode` / `metaSubcode`, so a caller can classify it (a dead token is
 * 190, a closed 24 h window is 131047 …) without parsing prose.
 *
 * What is deliberately NOT here: WhatsApp's own error-code policy. The shared `PERMANENT_CODES` in `http.ts` stays `{190, 200, 10903}`
 * so Instagram's retries and handoffs do not move; a WhatsApp-only set (131047, 131026, …) is a later task and lives beside this file.
 */
import { metaHttp, withRetry } from './http.js';
import { GRAPH_BASE, metaFailure } from './instagram.js';
import { log } from '../utils/log.js';

const authorization = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A message with the token taken out of it. Meta does not echo one back; this is the guarantee that nothing built from its words can. */
export function scrubToken(message: string, token: string): string {
    return token ? message.split(token).join('[token]') : message;
}

/**
 * `metaFailure`, with the token scrubbed out of the message. Every error that leaves this module goes through it, so a message that a caller
 * logs, stores in `last_error` or shows the owner cannot carry the credential it was made with.
 */
function failure(prefix: string, error: any, token: string) {
    const wrapped = metaFailure(prefix, error);
    wrapped.message = scrubToken(wrapped.message, token);
    return wrapped;
}

/** Phone-number and WhatsApp-business-account ids are numeric strings. Checked before one goes into a URL path. */
const NUMERIC_ID = /^\d{1,32}$/;
/** A media id is numeric today; the looser class keeps a format change from becoming a path-injection. */
const MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/;

function numericId(value: unknown, what: string): string {
    if (typeof value !== 'string' || !NUMERIC_ID.test(value)) throw new TypeError(`${what} must be a numeric Meta id.`);
    return value;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

// ─── The phone number: what Meta says about it ──────────────────────────────────────────

/**
 * The fields read on every connect and refresh. Exactly the list the W0 probe is specified to read (tasks T002): a field Meta does not
 * serve for an account fails the WHOLE call with code 100, so this list only holds fields confirmed to be served.
 */
export const PHONE_NUMBER_FIELDS = 'display_phone_number,verified_name,quality_rating,code_verification_status,name_status,throughput';

/**
 * Two more facts the card shows, asked for in a request of their own: the number's operating status (CONNECTED, FLAGGED, …) and the
 * messaging limit tier (research/01-capabilities.md §1 names `whatsapp_business_manager_messaging_limit`; the older `messaging_limit_tier`
 * is deprecated). Neither is on the confirmed list above, so a refusal here costs these two values and nothing else.
 */
export const PHONE_NUMBER_EXTRA_FIELDS = 'status,whatsapp_business_manager_messaging_limit';

export interface PhoneNumberHealth {
    displayPhoneNumber: string | null;
    /** The business name WhatsApp shows (`verified_name`); once approved. */
    verifiedName: string | null;
    /** GREEN | YELLOW | RED | UNKNOWN. */
    qualityRating: string | null;
    /** VERIFIED | NOT_VERIFIED | EXPIRED. */
    codeVerificationStatus: string | null;
    /** APPROVED | AVAILABLE_WITHOUT_REVIEW | DECLINED | EXPIRED | PENDING_REVIEW | NONE. */
    nameStatus: string | null;
    /** `throughput.level`: STANDARD | HIGH | NOT_APPLICABLE. */
    throughput: string | null;
    /** CONNECTED | FLAGGED | RESTRICTED | … — null when the extra read was refused. */
    numberStatus: string | null;
    /** TIER_250 … TIER_UNLIMITED — null when the extra read was refused. */
    messagingLimit: string | null;
    /** See `looksLikeTestNumber`. A heuristic: Meta serves no field that says so. */
    isTestNumber: boolean;
}

/**
 * Meta's free test numbers are `+1 555 …` numbers. Nothing on the phone-number node says "test", so this reads the number itself, and is
 * the one place a guess lives: it only ever DISABLES something (the go-live gate refuses a test number), never enables it.
 */
export function looksLikeTestNumber(displayPhoneNumber: string | null): boolean {
    return typeof displayPhoneNumber === 'string' && displayPhoneNumber.replace(/\D/g, '').startsWith('1555');
}

/** Meta's answers, kept to what the card shows. Pure: a body that is not an object maps to all nulls. */
export function mapPhoneNumberHealth(core: unknown, extras?: unknown): PhoneNumberHealth {
    const c = (core && typeof core === 'object' ? core : {}) as Record<string, unknown>;
    const e = (extras && typeof extras === 'object' ? extras : {}) as Record<string, unknown>;
    const throughput = c.throughput && typeof c.throughput === 'object' ? text((c.throughput as Record<string, unknown>).level) : null;
    const displayPhoneNumber = text(c.display_phone_number);
    return {
        displayPhoneNumber,
        verifiedName: text(c.verified_name),
        qualityRating: text(c.quality_rating),
        codeVerificationStatus: text(c.code_verification_status),
        nameStatus: text(c.name_status),
        throughput,
        numberStatus: text(e.status),
        messagingLimit: text(e.whatsapp_business_manager_messaging_limit) ?? text(e.messaging_limit_tier),
        isTestNumber: looksLikeTestNumber(displayPhoneNumber),
    };
}

/**
 * Read the number's health. Throws a `MetaApiError` when the CORE read fails (a dead token is 190, a missing permission 200); the two extra
 * facts are best effort and come back null when Meta refuses them.
 */
export async function getPhoneNumberHealth(phoneNumberId: string, token: string): Promise<PhoneNumberHealth> {
    const url = `${GRAPH_BASE}/${numericId(phoneNumberId, 'phone_number_id')}`;
    let core: unknown;
    try {
        const response = await withRetry(
            () => metaHttp.get(url, { params: { fields: PHONE_NUMBER_FIELDS }, headers: authorization(token) }),
            { label: 'whatsapp.getPhoneNumberHealth', retries: 1 }
        );
        core = response.data;
    } catch (error: any) {
        throw failure('WhatsApp phone number read failed', error, token);
    }

    let extras: unknown;
    try {
        const response = await withRetry(
            () => metaHttp.get(url, { params: { fields: PHONE_NUMBER_EXTRA_FIELDS }, headers: authorization(token) }),
            { label: 'whatsapp.getPhoneNumberExtras', retries: 0 }
        );
        extras = response.data;
    } catch (error: any) {
        log('warn', 'whatsapp.health_extras_unavailable', {
            phone_number_id: phoneNumberId,
            meta_code: error?.response?.data?.error?.code ?? null,
            message: scrubToken(String(error?.response?.data?.error?.message ?? error?.message), token),
        });
    }
    return mapPhoneNumberHealth(core, extras);
}

// ─── The token: what Meta's debug_token says about it ───────────────────────────────────

/** What a token needs: send and receive (`messaging`), and read the account and subscribe the app (`management`). */
export const WHATSAPP_REQUIRED_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'] as const;

export interface WhatsAppTokenInspection {
    isValid: boolean;
    /** `SYSTEM_USER` for the token this channel is meant to run on; `USER` for the 24 h one the API Setup page hands out. */
    type: string | null;
    scopes: string[];
    missingScopes: string[];
    /** Null for a token that never expires (`expires_at: 0`). */
    expiresAt: Date | null;
    /** The first thing wrong with it, in words the owner can act on, or null. */
    error: string | null;
}

/**
 * `debug_token`'s `data`, read for this channel. Pure, and separate from the HTTP call (`tokenHealth.fetchDebugToken`), because the
 * interesting cases are all shapes of answer: a valid token missing a scope, one issued to another app, one that expires tomorrow.
 *
 * A token issued to a DIFFERENT app than `expectedAppId` is refused outright: it would pass every read, `POST /{waba}/subscribed_apps` would
 * subscribe THAT app, and the webhooks would go to that app's callback — a connection that reads healthy and never receives a message.
 */
export function inspectWhatsAppToken(data: unknown, expectedAppId?: string | null): WhatsAppTokenInspection {
    const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const scopes = Array.isArray(d.scopes) ? d.scopes.filter((s): s is string => typeof s === 'string') : [];
    const missingScopes = WHATSAPP_REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
    const isValid = d.is_valid === true;
    const expiresAt = typeof d.expires_at === 'number' && d.expires_at > 0 ? new Date(d.expires_at * 1000) : null;
    const appId = d.app_id === undefined || d.app_id === null ? null : String(d.app_id);

    let error: string | null = null;
    if (!isValid) {
        const reason = text((d.error as Record<string, unknown> | undefined)?.message);
        error = reason ? `Meta reports the token as not valid: ${reason}` : 'Meta reports the token as not valid.';
    } else if (expectedAppId && appId && appId !== expectedAppId) {
        error = 'That token was issued for a different Meta app than this one — generate it for the app this site is connected to.';
    } else if (missingScopes.length) {
        error = `The token is missing ${missingScopes.join(' and ')}. Generate it with whatsapp_business_messaging and whatsapp_business_management.`;
    }
    return { isValid, type: text(d.type), scopes, missingScopes, expiresAt, error };
}

// ─── The webhook subscription ───────────────────────────────────────────────────────────

/**
 * `POST /{waba_id}/subscribed_apps`: the token's own app starts receiving this account's webhooks. Idempotent, so an ordinary retry is safe.
 * Returns whether Meta said `success`.
 */
export async function subscribeApp(wabaId: string, token: string): Promise<boolean> {
    const url = `${GRAPH_BASE}/${numericId(wabaId, 'waba_id')}/subscribed_apps`;
    try {
        const response = await withRetry(
            () => metaHttp.post(url, {}, { headers: authorization(token) }),
            { label: 'whatsapp.subscribeApp', retries: 1 }
        );
        return response.data?.success === true;
    } catch (error: any) {
        throw failure('WhatsApp webhook subscription failed', error, token);
    }
}

/** `DELETE /{waba_id}/subscribed_apps`: the app stops receiving this account's webhooks. Returns whether Meta said `success`. */
export async function unsubscribeApp(wabaId: string, token: string): Promise<boolean> {
    const url = `${GRAPH_BASE}/${numericId(wabaId, 'waba_id')}/subscribed_apps`;
    try {
        const response = await withRetry(
            () => metaHttp.delete(url, { headers: authorization(token) }),
            { label: 'whatsapp.unsubscribeApp', retries: 1 }
        );
        return response.data?.success === true;
    } catch (error: any) {
        throw failure('WhatsApp webhook unsubscription failed', error, token);
    }
}

// ─── Sending ────────────────────────────────────────────────────────────────────────────

/**
 * A message as Meta takes it, minus `messaging_product` (set here). The caller shapes it (`toWhatsAppMessage`, a later phase): the addressing
 * is `recipient: <BSUID>` — never `to`, unless only a phone number is known — and `type` names the object that carries the content.
 */
export interface WhatsAppSendPayload {
    /** A business-scoped user id. Preferred. */
    recipient?: string;
    /** A phone number in E.164 digits. When both are present Meta uses this one. */
    to?: string;
    recipient_type?: 'individual';
    type: string;
    context?: { message_id: string };
    [content: string]: unknown;
}

export interface WhatsAppSendResult {
    /** The `wamid` the message got. Null when Meta answered 200 with no id: the message may be on its way, and nothing can track it. */
    messageId: string | null;
    /** The phone number Meta resolved the recipient to, when it said. */
    waId: string | null;
    /** The recipient's BSUID, when it said. */
    userId: string | null;
}

/** Meta's answer to a send, kept to the three facts a caller stores. Pure. */
export function mapSendResult(data: unknown): WhatsAppSendResult {
    const d = (data && typeof data === 'object' ? data : {}) as Record<string, any>;
    const first = Array.isArray(d.messages) ? d.messages[0] : undefined;
    const contact = Array.isArray(d.contacts) ? d.contacts[0] : undefined;
    return { messageId: text(first?.id), waId: text(contact?.wa_id), userId: text(contact?.user_id) };
}

/**
 * Send one message. **Never retried once it may have been sent** (`creates: true` in `withRetry`, the rule that came out of a Facebook reel
 * posted twice): only a 429, the throttling codes Meta refused the request with, and a connection that never went out are tried again. A
 * timeout, a reset or a 5xx may come AFTER WhatsApp delivered, and a duplicate message to a customer is worse than a failed one that the
 * caller hands off.
 *
 * Throws a `MetaApiError` (with `metaCode`) on any failure; the message text is never in the error or in a log line.
 */
export async function sendMessage(phoneNumberId: string, token: string, payload: WhatsAppSendPayload): Promise<WhatsAppSendResult> {
    const url = `${GRAPH_BASE}/${numericId(phoneNumberId, 'phone_number_id')}/messages`;
    if (!payload || typeof payload !== 'object' || !payload.type) throw new TypeError('A WhatsApp message needs a type.');
    if (!payload.recipient && !payload.to) throw new TypeError('A WhatsApp message needs a recipient (a BSUID) or a to (a phone number).');
    const body = { ...payload, messaging_product: 'whatsapp' };
    try {
        const response = await withRetry(
            () => metaHttp.post(url, body, { headers: authorization(token) }),
            { label: 'whatsapp.sendMessage', creates: true }
        );
        return mapSendResult(response.data);
    } catch (error: any) {
        throw failure('WhatsApp send failed', error, token);
    }
}

/**
 * Mark an inbound message read and show "typing…" until the reply lands or 25 s pass (contracts/outbound-send.md §2). It is not a message.
 * BEST EFFORT, and made to be called that way: not retried (a late "typing" is worse than none), and it throws so the caller can log and go
 * on — the reply is the point, these are decoration.
 */
export async function markReadWithTyping(phoneNumberId: string, token: string, wamid: string): Promise<void> {
    const url = `${GRAPH_BASE}/${numericId(phoneNumberId, 'phone_number_id')}/messages`;
    if (typeof wamid !== 'string' || !wamid) throw new TypeError('markReadWithTyping needs the wamid of the inbound message.');
    try {
        await metaHttp.post(url, {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: wamid,
            typing_indicator: { type: 'text' },
        }, { headers: authorization(token) });
    } catch (error: any) {
        throw failure('WhatsApp read receipt failed', error, token);
    }
}

// ─── Inbound media ──────────────────────────────────────────────────────────────────────

export interface WhatsAppMediaInfo {
    /** Valid for about five minutes: download in the same job. */
    url: string;
    mimeType: string | null;
    sha256: string | null;
    fileSize: number | null;
}

/**
 * `GET /{media_id}`. Passing `phoneNumberId` makes Meta answer only when the file belongs to that number, so a media id a webhook carried
 * can never be resolved through another tenant's number.
 */
export async function getMediaUrl(mediaId: string, token: string, phoneNumberId?: string): Promise<WhatsAppMediaInfo> {
    if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) throw new TypeError('mediaId is not a Meta media id.');
    const url = `${GRAPH_BASE}/${mediaId}`;
    const params = phoneNumberId ? { phone_number_id: numericId(phoneNumberId, 'phone_number_id') } : undefined;
    try {
        const response = await withRetry(
            () => metaHttp.get(url, { ...(params ? { params } : {}), headers: authorization(token) }),
            { label: 'whatsapp.getMediaUrl', retries: 2 }
        );
        const d = (response.data && typeof response.data === 'object' ? response.data : {}) as Record<string, unknown>;
        const mediaUrl = text(d.url);
        if (!mediaUrl) throw new Error('Meta answered without a media url.');
        const size = typeof d.file_size === 'number' ? d.file_size : Number(d.file_size);
        return {
            url: mediaUrl,
            mimeType: text(d.mime_type),
            sha256: text(d.sha256),
            fileSize: Number.isFinite(size) && size >= 0 ? size : null,
        };
    } catch (error: any) {
        throw failure('WhatsApp media lookup failed', error, token);
    }
}

/**
 * The hosts Meta serves WhatsApp media from. The bearer token is sent to whatever URL is downloaded, so it goes only to these: the URL
 * comes out of a Graph answer (or a signed webhook), and a token must not follow a value to a host nobody listed.
 */
export const MEDIA_HOST_SUFFIXES = ['fbsbx.com', 'fbcdn.net', 'whatsapp.net', 'whatsapp.com', 'facebook.com'] as const;

export function isMetaMediaUrl(value: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    return MEDIA_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** WhatsApp takes up to 100 MB; this app never needs more than a voice note or a screenshot. A caller that does passes `maxBytes`. */
export const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export interface DownloadedMedia {
    data: Buffer;
    contentType: string | null;
}

/**
 * Download an inbound file from the URL `getMediaUrl` returned (or a webhook carried). A GET, so retried like one. A 404 means the URL has
 * expired — ask `getMediaUrl` again; the error's `cause` is the axios failure with `response.status`.
 */
export async function downloadMedia(url: string, token: string, opts: { maxBytes?: number } = {}): Promise<DownloadedMedia> {
    if (!isMetaMediaUrl(url)) throw new TypeError('Refusing to send the WhatsApp token to a host that is not a Meta media host.');
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    try {
        const response = await withRetry(
            () => metaHttp.get(url, {
                headers: authorization(token),
                responseType: 'arraybuffer',
                timeout: 30_000,
                maxContentLength: maxBytes,
                maxBodyLength: maxBytes,
            }),
            { label: 'whatsapp.downloadMedia', retries: 2 }
        );
        const data = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data as ArrayBuffer);
        const contentType = response.headers?.['content-type'];
        return { data, contentType: typeof contentType === 'string' && contentType ? contentType : null };
    } catch (error: any) {
        throw failure('WhatsApp media download failed', error, token);
    }
}
