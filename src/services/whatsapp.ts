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
 *   createQrCode           POST   /{phone_number_id}/message_qrdls   an entry link + QR code. A create: NEVER retried once it may have landed
 *   listQrCodes / getQrCode / deleteQrCode                           …the same edge: list (cursor), one by code, delete
 *   getConversationalAutomation / setConversationalAutomation        the ice breakers and commands of the number
 *
 * `sendMessage` is called from one place, `channels/send.ts` (`sendWhatsAppReply`), which owns the window, the meter and the shaping
 * (`toWhatsAppMessage`); `markReadWithTyping` from the agent's turn (`webhook/whatsappAnswer.ts`).
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

// ─── Entry points: QR codes and short links ─────────────────────────────────────────────

/**
 * QR codes and short links, kept AT META (the object is the source of truth; this app stores only a label for each).
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/qr-codes.md
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-qr-code-management-api.md
 *
 *   POST   /{phone_number_id}/message_qrdls              { prefilled_message, generate_qr_image: 'PNG'|'SVG' }
 *                                                        → { code, prefilled_message, deep_link_url, qr_image_url }
 *   GET    /{phone_number_id}/message_qrdls              ?fields=code,prefilled_message,deep_link_url,qr_image_url.format(PNG)&limit≤25&after=<cursor>
 *                                                        → { data: [{ code, prefilled_message, deep_link_url, qr_image_url? }], paging? }
 *                                                        (newest first; `code=<code>` filters to one; no image unless `fields` asks for it)
 *   DELETE /{phone_number_id}/message_qrdls/{code}       → { success: true }
 *
 * Limits: 2,000 per number, the prefilled message ≤ 140 characters. Meta keeps no scan analytics for them.
 */
export const QR_PREFILL_MAX_CHARS = 140;
export const QR_CODES_MAX_PER_NUMBER = 2000;
/** Meta serves 25 at most per page of the list. */
const QR_PAGE_SIZE = 25;
/** A runaway guard for the cursor loop: 2,000 codes are 80 pages. */
const QR_MAX_PAGES = 100;
/** Meta documents a 14-character code. The looser class only keeps a changed format from becoming a path injection. */
const QR_CODE_ID = /^[A-Za-z0-9]{6,32}$/;

export const isQrCodeId = (value: unknown): value is string => typeof value === 'string' && QR_CODE_ID.test(value);

export interface WhatsAppQrCode {
    code: string;
    prefilledMessage: string;
    /** `https://wa.me/message/<code>`: the short link, which also masks the phone number. */
    deepLinkUrl: string | null;
    /** Only when the call asked for an image; a signed Meta (fbcdn) URL, so it is read fresh and never stored. */
    qrImageUrl: string | null;
}

/** One QR object as Meta answers it, or null when it has no usable code. Pure. */
export function mapQrCode(raw: unknown): WhatsAppQrCode | null {
    if (!raw || typeof raw !== 'object') return null;
    const d = raw as Record<string, unknown>;
    const code = text(d.code);
    if (!code || !QR_CODE_ID.test(code)) return null;
    return {
        code,
        prefilledMessage: typeof d.prefilled_message === 'string' ? d.prefilled_message : '',
        deepLinkUrl: text(d.deep_link_url),
        qrImageUrl: text(d.qr_image_url),
    };
}

/**
 * Create a QR code + short link. A CREATE: never retried once it may have landed (`creates: true`), because a retried timeout would leave
 * two codes behind and the owner could not tell which one is printed. Only a 429, the throttling codes and a connection that never went out
 * are tried again.
 *
 * `prefilledMessage` is checked here as well as by the caller: a payload over 140 characters is a TypeError, never a request.
 */
export async function createQrCode(
    phoneNumberId: string,
    token: string,
    prefilledMessage: string,
    opts: { format?: 'PNG' | 'SVG' } = {}
): Promise<WhatsAppQrCode> {
    const url = `${GRAPH_BASE}/${numericId(phoneNumberId, 'phone_number_id')}/message_qrdls`;
    if (typeof prefilledMessage !== 'string' || !prefilledMessage.trim()) throw new TypeError('A QR code needs a prefilled message.');
    if (prefilledMessage.length > QR_PREFILL_MAX_CHARS) {
        throw new TypeError(`A QR code's prefilled message is at most ${QR_PREFILL_MAX_CHARS} characters.`);
    }
    try {
        const response = await withRetry(
            () => metaHttp.post(url, { prefilled_message: prefilledMessage, generate_qr_image: opts.format ?? 'PNG' }, { headers: authorization(token) }),
            { label: 'whatsapp.createQrCode', creates: true }
        );
        const created = mapQrCode(response.data);
        if (!created) throw new Error('Meta answered without a QR code.');
        return created;
    } catch (error: any) {
        throw failure('WhatsApp QR code creation failed', error, token);
    }
}

/** The fields the list asks for. `qr_image_url.format(PNG)` is how the list is made to carry the image (the reference's own example). */
const QR_LIST_FIELDS_WITH_IMAGE = 'code,prefilled_message,deep_link_url,qr_image_url.format(PNG)';
const QR_LIST_FIELDS = 'code,prefilled_message,deep_link_url';

/**
 * Every QR code and short link on the number, newest first, following Meta's cursor (25 a page). A GET, so retried like one.
 *
 * The image is asked for in the same call. If Meta refuses that field spec (code 100) the list is asked again without it, so a card that only
 * needs the labels and links does not die on an image field: the codes then come back with `qrImageUrl: null`.
 */
export async function listQrCodes(phoneNumberId: string, token: string): Promise<WhatsAppQrCode[]> {
    const url = `${GRAPH_BASE}/${numericId(phoneNumberId, 'phone_number_id')}/message_qrdls`;
    const found: WhatsAppQrCode[] = [];
    let withImage = true;
    let after: string | undefined;
    try {
        for (let page = 0; page < QR_MAX_PAGES; page++) {
            let data: any;
            try {
                const response = await withRetry(
                    () => metaHttp.get(url, {
                        params: { fields: withImage ? QR_LIST_FIELDS_WITH_IMAGE : QR_LIST_FIELDS, limit: QR_PAGE_SIZE, ...(after ? { after } : {}) },
                        headers: authorization(token),
                    }),
                    { label: 'whatsapp.listQrCodes', retries: 2 }
                );
                data = response.data;
            } catch (error: any) {
                if (withImage && error?.response?.data?.error?.code === 100) {
                    withImage = false;
                    log('warn', 'whatsapp.qr_list_image_unavailable', { phone_number_id: phoneNumberId });
                    page -= 1;
                    continue;
                }
                throw error;
            }
            for (const raw of Array.isArray(data?.data) ? data.data : []) {
                const code = mapQrCode(raw);
                if (code) found.push(code);
            }
            const next = text(data?.paging?.cursors?.after);
            if (!data?.paging?.next || !next || next === after) break;
            after = next;
        }
        return found;
    } catch (error: any) {
        throw failure('WhatsApp QR code list failed', error, token);
    }
}

/**
 * One code on this number, or null when the number has no such code: the check a delete makes before it acts, so a code that belongs to
 * another number is never found through this one.
 *
 * Asked with the list's documented `code` filter first (one cheap call). The answer is trusted only when it IS that code; anything else,
 * including an empty answer, is checked against the number's whole list, so a filter Meta does not honour can make a delete slower but never
 * wrongly refused (or, worse, wrongly allowed). A code that is not there therefore costs a full read of the list: rare, and bounded.
 */
export async function getQrCode(phoneNumberId: string, token: string, code: string): Promise<WhatsAppQrCode | null> {
    const url = `${GRAPH_BASE}/${numericId(phoneNumberId, 'phone_number_id')}/message_qrdls`;
    if (!isQrCodeId(code)) throw new TypeError('code is not a QR code id.');
    try {
        const response = await withRetry(
            () => metaHttp.get(url, { params: { code, fields: QR_LIST_FIELDS, limit: 1 }, headers: authorization(token) }),
            { label: 'whatsapp.getQrCode', retries: 2 }
        );
        const rows: unknown[] = Array.isArray(response.data?.data) ? response.data.data : [];
        const hit = rows.map((row) => mapQrCode(row)).find((c) => c?.code === code);
        if (hit) return hit;
    } catch (error: any) {
        throw failure('WhatsApp QR code read failed', error, token);
    }
    return (await listQrCodes(phoneNumberId, token)).find((c) => c.code === code) ?? null;
}

/** Delete a QR code: the printed code and the short link both answer "expired" from now on. Returns whether Meta said `success`. */
export async function deleteQrCode(phoneNumberId: string, token: string, code: string): Promise<boolean> {
    if (!isQrCodeId(code)) throw new TypeError('code is not a QR code id.');
    const url = `${GRAPH_BASE}/${numericId(phoneNumberId, 'phone_number_id')}/message_qrdls/${code}`;
    try {
        const response = await withRetry(
            () => metaHttp.delete(url, { headers: authorization(token) }),
            { label: 'whatsapp.deleteQrCode', retries: 1 }
        );
        return response.data?.success === true;
    } catch (error: any) {
        throw failure('WhatsApp QR code deletion failed', error, token);
    }
}

// ─── Entry points: ice breakers and commands ────────────────────────────────────────────

/**
 * Conversational components: the tappable ice breakers and the `/commands` of a number.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/conversational-components.md
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/conversational-automation-api.md
 *
 *   POST /{phone_number_id}/conversational_automation   { prompts?: string[], commands?: [{ command_name, command_description }] }
 *                                                       → { success: true }
 *   GET  /{phone_number_id}?fields=conversational_automation
 *                                                       → { conversational_automation: { prompts, commands }, id }
 *
 * Limits: up to 4 ice breakers of ≤ 80 characters; up to 30 commands, a name ≤ 32 characters (sent WITHOUT the leading slash, unique per
 * number) and a hint ≤ 256; no emoji in any of them. A tap arrives as an ordinary inbound text message. WhatsApp hides the ice breakers when
 * the user opened the chat from a `wa.me` link with prefilled text, which is the case for every entry link made here.
 *
 * Not documented, and so not assumed: whether a POST replaces or merges what is set, and how to clear it. `prompts: []` is sent as it is and
 * Meta's own answer decides; the route re-reads the number after a write so the card shows what Meta holds, not what was sent.
 */
export const ICE_BREAKERS_MAX = 4;
export const ICE_BREAKER_MAX_CHARS = 80;
export const COMMANDS_MAX = 30;
export const COMMAND_NAME_MAX_CHARS = 32;
export const COMMAND_DESCRIPTION_MAX_CHARS = 256;

export interface ConversationalCommand {
    command_name: string;
    command_description: string;
}

export interface ConversationalAutomation {
    prompts: string[];
    commands: ConversationalCommand[];
}

/** An emoji or a pictographic symbol. `©`, `®` and `™` are plain text and allowed; digits and `#` are not emoji and are not caught. */
const EMOJI = /(?![©®™])\p{Extended_Pictographic}|\p{Emoji_Presentation}|[️⃣]/u;

export const hasEmoji = (value: string): boolean => EMOJI.test(value);

export interface ConversationalAutomationInput {
    prompts: string[];
    /** Absent when the caller did not send any: the commands already set are left alone. */
    commands?: ConversationalCommand[];
}

export type ConversationalAutomationParse =
    | { value: ConversationalAutomationInput }
    | { error: string; code: string };

/**
 * Check what an owner sent for ice breakers (and optionally commands) against Meta's limits. Pure. A value is trimmed, never silently
 * shortened, rewritten or dropped: anything over a limit is an error that says which limit.
 */
export function parseConversationalAutomation(input: unknown): ConversationalAutomationParse {
    const body = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;

    if (!Array.isArray(body.prompts)) return { error: 'prompts must be a list of strings (an empty list is allowed).', code: 'invalid_prompts' };
    if (body.prompts.length > ICE_BREAKERS_MAX) {
        return { error: `WhatsApp allows at most ${ICE_BREAKERS_MAX} ice breakers; ${body.prompts.length} were sent.`, code: 'too_many_prompts' };
    }
    const prompts: string[] = [];
    for (const [i, raw] of body.prompts.entries()) {
        const prompt = typeof raw === 'string' ? raw.trim() : '';
        if (!prompt) return { error: `Ice breaker ${i + 1} is empty.`, code: 'invalid_prompts' };
        if (prompt.length > ICE_BREAKER_MAX_CHARS) {
            return { error: `Ice breaker ${i + 1} is ${prompt.length} characters; the limit is ${ICE_BREAKER_MAX_CHARS}.`, code: 'prompt_too_long' };
        }
        if (hasEmoji(prompt)) return { error: `Ice breaker ${i + 1} has an emoji; WhatsApp does not support emoji in ice breakers.`, code: 'prompt_has_emoji' };
        prompts.push(prompt);
    }

    if (body.commands === undefined || body.commands === null) return { value: { prompts } };
    if (!Array.isArray(body.commands)) return { error: 'commands must be a list of { command_name, command_description }.', code: 'invalid_commands' };
    if (body.commands.length > COMMANDS_MAX) {
        return { error: `WhatsApp allows at most ${COMMANDS_MAX} commands; ${body.commands.length} were sent.`, code: 'too_many_commands' };
    }
    const commands: ConversationalCommand[] = [];
    const seen = new Set<string>();
    for (const [i, raw] of body.commands.entries()) {
        const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const name = typeof c.command_name === 'string' ? c.command_name.trim() : '';
        const description = typeof c.command_description === 'string' ? c.command_description.trim() : '';
        if (!name || /\s/.test(name) || name.startsWith('/')) {
            return { error: `Command ${i + 1} needs a name with no spaces and no leading slash.`, code: 'invalid_command_name' };
        }
        if (name.length > COMMAND_NAME_MAX_CHARS) {
            return { error: `Command ${i + 1}'s name is ${name.length} characters; the limit is ${COMMAND_NAME_MAX_CHARS}.`, code: 'command_name_too_long' };
        }
        if (!description) return { error: `Command ${i + 1} needs a hint (command_description).`, code: 'invalid_command_description' };
        if (description.length > COMMAND_DESCRIPTION_MAX_CHARS) {
            return { error: `Command ${i + 1}'s hint is ${description.length} characters; the limit is ${COMMAND_DESCRIPTION_MAX_CHARS}.`, code: 'command_description_too_long' };
        }
        if (hasEmoji(name) || hasEmoji(description)) return { error: `Command ${i + 1} has an emoji; WhatsApp does not support emoji in commands.`, code: 'command_has_emoji' };
        if (seen.has(name)) return { error: `Command name "${name}" is used twice; names must be unique.`, code: 'duplicate_command' };
        seen.add(name);
        commands.push({ command_name: name, command_description: description });
    }
    return { value: { prompts, commands } };
}

/** What Meta holds for the number, in the shape the card edits. Pure: a body without the object is "nothing set". */
export function mapConversationalAutomation(data: unknown): ConversationalAutomation {
    const root = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const ca = (root.conversational_automation && typeof root.conversational_automation === 'object' ? root.conversational_automation : {}) as Record<string, unknown>;
    const prompts = Array.isArray(ca.prompts) ? ca.prompts.filter((p): p is string => typeof p === 'string') : [];
    const commands: ConversationalCommand[] = [];
    for (const raw of Array.isArray(ca.commands) ? ca.commands : []) {
        const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        if (typeof c.command_name === 'string' && c.command_name) {
            commands.push({ command_name: c.command_name, command_description: typeof c.command_description === 'string' ? c.command_description : '' });
        }
    }
    return { prompts, commands };
}

/** `GET /{phone_number_id}?fields=conversational_automation`: the ice breakers and commands now set on the number. */
export async function getConversationalAutomation(phoneNumberId: string, token: string): Promise<ConversationalAutomation> {
    const url = `${GRAPH_BASE}/${numericId(phoneNumberId, 'phone_number_id')}`;
    try {
        const response = await withRetry(
            () => metaHttp.get(url, { params: { fields: 'conversational_automation' }, headers: authorization(token) }),
            { label: 'whatsapp.getConversationalAutomation', retries: 2 }
        );
        return mapConversationalAutomation(response.data);
    } catch (error: any) {
        throw failure('WhatsApp ice breakers read failed', error, token);
    }
}

/**
 * `POST /{phone_number_id}/conversational_automation`. Only the parts given are sent: `commands` left out means Meta is not told about
 * commands. Not a create (the call sets state, and setting it twice is the same state), so an ordinary retry is safe. Returns whether Meta
 * said `success`. The limits are re-checked here, so a payload that breaks one is a TypeError and never a request.
 */
export async function setConversationalAutomation(phoneNumberId: string, token: string, config: ConversationalAutomationInput): Promise<boolean> {
    const url = `${GRAPH_BASE}/${numericId(phoneNumberId, 'phone_number_id')}/conversational_automation`;
    const checked = parseConversationalAutomation(config);
    if ('error' in checked) throw new TypeError(checked.error);
    const body = { prompts: checked.value.prompts, ...(checked.value.commands ? { commands: checked.value.commands } : {}) };
    try {
        const response = await withRetry(
            () => metaHttp.post(url, body, { headers: authorization(token) }),
            { label: 'whatsapp.setConversationalAutomation', retries: 1 }
        );
        return response.data?.success === true;
    } catch (error: any) {
        throw failure('WhatsApp ice breakers update failed', error, token);
    }
}
