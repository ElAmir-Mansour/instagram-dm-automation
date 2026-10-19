/**
 * WhatsApp Cloud API webhook payload (the `value` of one `entry[].changes[]`, `field: 'messages'`) -> the
 * app's own shapes. Pure: no I/O, no logging, no clock, no database. The caller (the router, the job
 * runner) logs and stores; this only says what each entry IS.
 *
 * Contract: docs/specs/001-whatsapp-agent/contracts/webhook-inbound.md section 4. Shapes come from Meta's
 * webhook reference (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages)
 * and the BSUID page (https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids),
 * and every one is run against Meta's own sample payloads in `__fixtures__/whatsapp/` (see `SOURCES.md` there).
 *
 * ## Identity: BSUID first, phone optional
 *
 * A contact is its business-scoped user id (`messages[].from_user_id`, else the matching `contacts[].user_id`).
 * The phone number (`from`, else `contacts[].wa_id`) is a nullable extra: Meta omits it once a user adopts a
 * username and has had no recent interaction with the business. A message with no BSUID is NOT given the phone
 * as an id (a phone and a BSUID are different keys for the same person, and mixing them splits a thread): it
 * becomes `Ignored{reason:'no_user_id'}`, which the caller logs as `wa.no_user_id`. Meta says every webhook has
 * carried a BSUID since April 2026; the older samples that predate it therefore normalise to `no_user_id` too.
 *
 * `system` messages (`user_changed_number`, `user_changed_user_id`) carry NO `contacts` and no `from_user_id`:
 * the new BSUID is `system.user_id`, the old one `system.previous_user_id`, and the NEW phone `system.wa_id`
 * (the message's `from` is the OLD number). They become a `WaSystemEvent` with the re-key `{from, to}`.
 *
 * ## How this maps onto `NormalizedDm` (src/webhook/messaging.ts), which the DM pipeline consumes
 *
 *   NormalizedDm field | WhatsApp source
 *   senderId           | the BSUID (see above). Never a phone.
 *   text               | text.body | interactive reply `title` | template `button.text` | media `caption` | '' (voice note: the transcript later)
 *   payload            | interactive reply `id` | template `button.payload` | ''
 *   isStoryMention     | always false (an Instagram concept)
 *   wordless           | `describeWordless` (attachments.ts) for image / video / document ('file') / sticker WITHOUT a caption,
 *                      | and for `location` / `contacts` (kind 'attachment': there is no map or card kind, and a row's
 *                      | `message_type` must be one of `WORDLESS_KINDS` to count as word-less). Null for anything with words,
 *                      | and for a voice note (its words come from transcription; failure is "please send text", not an ack).
 *   metaMessageId      | `messages[].id` (the wamid): the dedupe key. Always present here.
 *
 * `WaInbound extends NormalizedDm`, so a change to that interface breaks this file's typecheck rather than the pipeline at runtime.
 * What a `NormalizedDm` has no place for rides alongside: `messageType` (the value for `messages.message_type`, which keeps
 * the WhatsApp type: `text`, `audio`, `image`, `interactive.button_reply`, ...), `phone`, `username`, `profileName`,
 * `media`, `needsTranscript`, `entrySource` (a Click to WhatsApp ad), `contextMessageId`.
 *
 * Nothing here is imported by the live pipeline yet.
 */
import type { ConversationEntrySource } from '../db/rows.js';
import { describeWordless, type Wordless } from './attachments.js';
import type { NormalizedDm } from './messaging.js';

// ---------------------------------------------------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------------------------------------------------

export type WaMediaKind = 'audio' | 'image' | 'video' | 'document' | 'sticker';

export interface WaMedia {
    kind: WaMediaKind;
    /** Meta's media id: valid 7 days, exchanged for a URL that is valid 5 minutes. */
    id: string;
    mime: string | null;
    caption?: string;
    filename?: string;
    /** `audio.voice`: a voice note rather than an audio file. */
    voice?: boolean;
}

/** A Click to WhatsApp ad that started the conversation. The caller adds `at` when it stores this as `conversations.entry_source`. */
export type WaEntrySource = Omit<ConversationEntrySource, 'at' | 'kind' | 'ref'> & { kind: 'ctwa' };

/** A message to answer or store as the customer's words: the DM pipeline's input. */
export interface WaInbound extends NormalizedDm {
    kind: 'message';
    /** The wamid. */
    metaMessageId: string;
    /** For `messages.message_type`: Meta's `type`, with the reply flavour for interactive messages (`interactive.list_reply`). */
    messageType: string;
    /** `from`, else `contacts[].wa_id`: digits without a plus. Null when Meta cannot share it (a username user); never the key. */
    phone: string | null;
    username: string | null;
    profileName: string | null;
    parentUserId: string | null;
    /** `metadata.phone_number_id`: the tenant key. */
    phoneNumberId: string | null;
    /** Meta's `timestamp`, unix seconds. */
    timestamp: number | null;
    media: WaMedia | null;
    /** A voice note whose words do not exist until it is transcribed. */
    needsTranscript: boolean;
    entrySource: WaEntrySource | null;
    /** `context.id`: the message this one replies to or quotes (the wamid of OUR message when a button was tapped). */
    contextMessageId: string | null;
}

/** A user's BSUID changed. The caller re-keys the conversation (and its consents and test-sender entries) from `rekey.from` to `rekey.to`. */
export interface WaSystemEvent {
    kind: 'system';
    systemType: 'user_changed_number' | 'user_changed_user_id';
    metaMessageId: string;
    phoneNumberId: string | null;
    timestamp: number | null;
    /** The user's CURRENT BSUID (`system.user_id`). */
    userId: string;
    parentUserId: string | null;
    /** The user's NEW phone (`system.wa_id`), null when it cannot be shared. */
    phone: string | null;
    /** `{previous_user_id -> user_id}`; null when Meta omitted the previous id (nothing to re-key from) or it equals the new one. */
    rekey: { from: string; to: string } | null;
    body: string | null;
}

export type WaIgnoredReason =
    /** No BSUID anywhere. The caller logs `wa.no_user_id`. */
    | 'no_user_id'
    /** Sent from a group (`group_id`). Groups are out of scope. */
    | 'group'
    /** An emoji reaction: stored, never answered. */
    | 'reaction'
    /** A type or interactive flavour the agent cannot read (`unsupported`, `order`, `interactive.product`, an unknown future type). */
    | 'unsupported'
    /** `request_welcome`: Meta removed it (review L2); harmless if one still arrives. */
    | 'request_welcome'
    /** The message carries `errors[]` and is not an `unsupported` message. */
    | 'error'
    /** `edit` / `revoke`: a change to an earlier message (coexistence numbers only), not new content. */
    | 'edit_or_revoke'
    /** Not usable: no id, an empty text body, a reply with neither title nor id. */
    | 'malformed';

export interface WaIgnored {
    kind: 'ignored';
    reason: WaIgnoredReason;
    /** Meta's raw `type` (null when absent). */
    messageType: string | null;
    metaMessageId: string | null;
    senderId: string | null;
    phone: string | null;
    username: string | null;
    profileName: string | null;
    phoneNumberId: string | null;
    timestamp: number | null;
    /** Whether the contract keeps a row for it (a reaction, an unsupported message): metadata only, no reply. */
    store: boolean;
    /** What `messages.no_reply_reason` should say when `store` is true and the reason is "we cannot read it". */
    noReplyReason: 'unsupported_type' | null;
    /** The first `errors[].code` on the message, when there is one (131051 for an unsupported type, 131060 for an unavailable one). */
    errorCode: number | null;
}

export type WaStatusName = 'sent' | 'delivered' | 'read' | 'played' | 'failed';

export interface WaStatusError {
    code: number | null;
    title: string | null;
    /** `error_data.details`. */
    details: string | null;
}

export interface WaStatus {
    /** The wamid of OUR message. */
    wamid: string;
    /** A status name Meta documents, or 'unknown' with the raw value in `rawStatus` so the caller can log it. */
    status: WaStatusName | 'unknown';
    rawStatus: string;
    /** Unix seconds. */
    timestamp: number | null;
    phoneNumberId: string | null;
    /** `recipient_user_id`, else the matching `contacts[].user_id`. Null for a `failed` status of a message sent to a phone number. */
    recipientUserId: string | null;
    /** `recipient_id`; absent when we sent to a BSUID and Meta cannot share the phone, and for a group recipient. */
    recipientPhone?: string;
    /** On `sent` and `delivered`/`read` statuses only; `type` is absent on the older (CBP-model) samples. */
    pricing?: { billable: boolean | null; category: string | null; type: string | null };
    /** Present for a free-entry-point window (v24+) or on older payloads; `expiresAt` is unix seconds. */
    conversation?: { id: string; expiresAt: number | null; originType: string | null };
    /** On `failed` statuses. Classify with `classifyWhatsAppError` (src/services/whatsappErrors.ts). */
    errors?: WaStatusError[];
}

/** `value.errors[]`: a system-, app- or account-level problem, with no message attached. */
export interface WaValueError {
    code: number | null;
    title: string | null;
    details: string | null;
}

export interface WaChange {
    messages: (WaInbound | WaSystemEvent | WaIgnored)[];
    statuses: WaStatus[];
    errors: WaValueError[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading untrusted JSON
// ---------------------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objs(value: unknown): Obj[] {
    return Array.isArray(value) ? value.filter(isObj) : [];
}

/** An identifier: a non-blank string, trimmed. */
function ident(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/** A piece of text where only blank counts as absent; the text itself is kept exactly as sent. */
function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Unix seconds, from the string Meta sends (`"1749416383"`) or a number. */
function seconds(value: unknown): number | null {
    const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,15}$/.test(value.trim()) ? Number(value.trim()) : NaN;
    return Number.isFinite(n) ? n : null;
}

function code(value: unknown): number | null {
    if (typeof value === 'number') return Number.isInteger(value) ? value : null;
    if (typeof value === 'string' && /^\d{1,9}$/.test(value.trim())) return Number(value.trim());
    return null;
}

function errorsOf(value: unknown): WaValueError[] {
    return objs(value).map((error) => ({
        code: code(error.code),
        title: text(error.title) ?? text(error.message),
        details: isObj(error.error_data) ? text(error.error_data.details) : null,
    }));
}

function phoneNumberIdOf(metadata: unknown): string | null {
    return isObj(metadata) ? ident(metadata.phone_number_id) : null;
}

/**
 * The contact entry for a message or status. Matched by BSUID, then by phone; with exactly one contact in the
 * payload that one is used (the common case) unless it names a DIFFERENT user. Never guesses between several, so
 * a profile name can never end up on the wrong person.
 */
function contactFor(contacts: Obj[], userId: string | null, phone: string | null): Obj | null {
    if (userId) {
        const byId = contacts.find((c) => ident(c.user_id) === userId);
        if (byId) return byId;
    }
    if (phone) {
        const byPhone = contacts.find((c) => ident(c.wa_id) === phone);
        if (byPhone) return byPhone;
    }
    if (contacts.length === 1) {
        const only = contacts[0]!;
        const theirId = ident(only.user_id);
        if (userId && theirId && theirId !== userId) return null;
        return only;
    }
    return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------------------------------

interface Who {
    senderId: string | null;
    phone: string | null;
    username: string | null;
    profileName: string | null;
    parentUserId: string | null;
}

function whoSent(contacts: Obj[], message: Obj): Who {
    const fromUserId = ident(message.from_user_id);
    const from = ident(message.from);
    const contact = contactFor(contacts, fromUserId, from);
    const profile = contact && isObj(contact.profile) ? contact.profile : null;
    return {
        // BSUID first. `from_user_id ?? contacts[].user_id`: never the phone.
        senderId: fromUserId ?? ident(contact?.user_id),
        phone: from ?? ident(contact?.wa_id),
        username: profile ? ident(profile.username) : null,
        profileName: profile ? text(profile.name) : null,
        parentUserId: ident(message.from_parent_user_id) ?? ident(contact?.parent_user_id),
    };
}

function ignored(
    reason: WaIgnoredReason,
    message: Obj,
    who: Pick<Who, 'senderId' | 'phone' | 'username' | 'profileName'>,
    phoneNumberId: string | null,
    extra: { store?: boolean; noReplyReason?: 'unsupported_type' | null } = {},
): WaIgnored {
    const firstError = errorsOf(message.errors)[0];
    return {
        kind: 'ignored',
        reason,
        messageType: ident(message.type),
        metaMessageId: ident(message.id),
        senderId: who.senderId,
        phone: who.phone,
        username: who.username,
        profileName: who.profileName,
        phoneNumberId,
        timestamp: seconds(message.timestamp),
        store: extra.store ?? false,
        noReplyReason: extra.noReplyReason ?? null,
        errorCode: firstError?.code ?? null,
    };
}

function entrySourceOf(referral: unknown): WaEntrySource | null {
    if (!isObj(referral)) return null;
    const source: WaEntrySource = { kind: 'ctwa' };
    const adId = ident(referral.source_id);
    if (adId) source.ad_id = adId;
    // Omitted by Meta for WhatsApp Status ad placements.
    const clid = ident(referral.ctwa_clid);
    if (clid) source.ctwa_clid = clid;
    const headline = text(referral.headline);
    if (headline) source.headline = headline;
    return source;
}

/** Meta's media `type` as the attachment type `describeWordless` (the Instagram describer) already understands. */
const WORDLESS_ATTACHMENT_TYPE: Readonly<Record<string, string>> = {
    image: 'image',
    video: 'video',
    document: 'file',
    sticker: 'sticker',
    // Not kinds the inbox draws: they fall through to the generic 'attachment' kind.
    location: 'location',
    contacts: 'contacts',
    audio: 'audio',
};

function wordlessFor(type: string): Wordless | null {
    return describeWordless({ attachments: [{ type: WORDLESS_ATTACHMENT_TYPE[type] ?? type }] });
}

function mediaOf(type: WaMediaKind, body: unknown): WaMedia | null {
    if (!isObj(body)) return null;
    const id = ident(body.id);
    if (!id) return null;
    const media: WaMedia = { kind: type, id, mime: ident(body.mime_type) };
    const caption = text(body.caption);
    if (caption) media.caption = caption;
    const filename = ident(body.filename);
    if (filename) media.filename = filename;
    if (type === 'audio' && body.voice === true) media.voice = true;
    return media;
}

/**
 * One entry of `value.messages[]`.
 *
 * Order of the checks matters: a group message is ignored whoever sent it; a `system` message identifies its user
 * differently (no `contacts`); only then is a missing BSUID fatal; only then does the `type` decide.
 *
 * `metadata` is `value.metadata`, `contacts` is `value.contacts`, `message` is the entry. All three are untrusted JSON
 * and may be anything: this never throws.
 */
export function normalizeWhatsAppMessage(metadata: unknown, contacts: unknown, message: unknown): WaInbound | WaSystemEvent | WaIgnored {
    const phoneNumberId = phoneNumberIdOf(metadata);
    const contactList = objs(contacts);
    const m: Obj = isObj(message) ? message : {};
    const who = whoSent(contactList, m);
    const type = ident(m.type);
    const wamid = ident(m.id);

    // No id: nothing to dedupe on, store or ack against.
    if (!wamid) return ignored('malformed', m, who, phoneNumberId);

    if (ident(m.group_id)) return ignored('group', m, who, phoneNumberId);

    if (type === 'system') return systemEvent(m, wamid, phoneNumberId);

    if (!who.senderId) return ignored('no_user_id', m, who, phoneNumberId);

    // `errors[]` on a message: an unsupported type (131051) or an unavailable message (131060), or something new.
    if (objs(m.errors).length > 0) {
        return ignored(type === 'unsupported' ? 'unsupported' : 'error', m, who, phoneNumberId, { store: true, noReplyReason: 'unsupported_type' });
    }

    const base = {
        kind: 'message' as const,
        senderId: who.senderId,
        isStoryMention: false,
        metaMessageId: wamid,
        phone: who.phone,
        username: who.username,
        profileName: who.profileName,
        parentUserId: who.parentUserId,
        phoneNumberId,
        timestamp: seconds(m.timestamp),
        entrySource: entrySourceOf(m.referral),
        contextMessageId: isObj(m.context) ? ident(m.context.id) : null,
    };
    const inbound = (
        messageType: string,
        content: { text: string; payload: string; wordless: Wordless | null; media?: WaMedia | null; needsTranscript?: boolean },
    ): WaInbound => ({
        ...base,
        messageType,
        text: content.text,
        payload: content.payload,
        wordless: content.wordless,
        media: content.media ?? null,
        needsTranscript: content.needsTranscript ?? false,
    });

    switch (type) {
        case 'text': {
            const body = isObj(m.text) ? text(m.text.body) : null;
            if (body === null) return ignored('malformed', m, who, phoneNumberId);
            return inbound('text', { text: body, payload: '', wordless: null });
        }

        case 'interactive': {
            const interactive = isObj(m.interactive) ? m.interactive : {};
            const flavour = ident(interactive.type);
            if (flavour !== 'button_reply' && flavour !== 'list_reply') {
                // product, nfm_reply (a Flow response), address, ...: not something the agent reads in v1.
                return ignored('unsupported', m, who, phoneNumberId, { store: true, noReplyReason: 'unsupported_type' });
            }
            const reply = isObj(interactive[flavour]) ? (interactive[flavour] as Obj) : {};
            const title = text(reply.title) ?? '';
            const id = ident(reply.id) ?? '';
            if (!title && !id) return ignored('malformed', m, who, phoneNumberId);
            // Understood exactly like typed text (the same `text` + `payload` a quick reply gives on Instagram).
            return inbound(`interactive.${flavour}`, { text: title, payload: id, wordless: null });
        }

        case 'button': {
            // A template's quick-reply button.
            const button = isObj(m.button) ? m.button : {};
            const label = text(button.text) ?? '';
            const payload = ident(button.payload) ?? '';
            if (!label && !payload) return ignored('malformed', m, who, phoneNumberId);
            return inbound('button', { text: label, payload, wordless: null });
        }

        case 'audio': {
            const media = mediaOf('audio', m.audio);
            // Words come from transcription. Without a media id there is nothing to transcribe: degrade to a word-less voice note.
            return media
                ? inbound('audio', { text: '', payload: '', wordless: null, media, needsTranscript: true })
                : inbound('audio', { text: '', payload: '', wordless: wordlessFor('audio') });
        }

        case 'image':
        case 'video':
        case 'document':
        case 'sticker': {
            const media = mediaOf(type, m[type]);
            const caption = media?.caption ?? (isObj(m[type]) ? text((m[type] as Obj).caption) : null) ?? '';
            // A caption is words and is answered as it always was; without one the message is word-less.
            return inbound(type, { text: caption, payload: '', wordless: caption ? null : wordlessFor(type), media });
        }

        case 'location':
        case 'contacts':
            return inbound(type, { text: '', payload: '', wordless: wordlessFor(type) });

        case 'reaction':
            return ignored('reaction', m, who, phoneNumberId, { store: true });

        case 'request_welcome':
            return ignored('request_welcome', m, who, phoneNumberId);

        case 'edit':
        case 'revoke':
            return ignored('edit_or_revoke', m, who, phoneNumberId);

        default:
            // `unsupported` with no errors[], `order`, and whatever Meta adds next.
            return ignored('unsupported', m, who, phoneNumberId, { store: true, noReplyReason: 'unsupported_type' });
    }
}

function systemEvent(m: Obj, wamid: string, phoneNumberId: string | null): WaSystemEvent | WaIgnored {
    const system = isObj(m.system) ? m.system : {};
    const systemType = ident(system.type);
    const userId = ident(system.user_id);
    const shared = { senderId: userId, phone: ident(system.wa_id), username: null, profileName: null };

    if (systemType !== 'user_changed_number' && systemType !== 'user_changed_user_id') {
        // A system message type this app does not know (Meta has used others before): not user content.
        return ignored('unsupported', m, shared, phoneNumberId);
    }
    if (!userId) return ignored('no_user_id', m, shared, phoneNumberId);

    const previous = ident(system.previous_user_id);
    return {
        kind: 'system',
        systemType,
        metaMessageId: wamid,
        phoneNumberId,
        timestamp: seconds(m.timestamp),
        userId,
        parentUserId: ident(system.parent_user_id),
        // The NEW phone. `messages[].from` on this message is the OLD one, so it is deliberately not read.
        phone: ident(system.wa_id),
        rekey: previous && previous !== userId ? { from: previous, to: userId } : null,
        body: text(system.body),
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------------------------------------------------

const STATUS_NAMES: ReadonlySet<string> = new Set<WaStatusName>(['sent', 'delivered', 'read', 'played', 'failed']);

/**
 * One entry of `value.statuses[]`. Null only when it has no id to match a message by: nothing can be done with it.
 */
export function normalizeWhatsAppStatus(metadata: unknown, contacts: unknown, status: unknown): WaStatus | null {
    if (!isObj(status)) return null;
    const wamid = ident(status.id);
    if (!wamid) return null;

    const rawStatus = ident(status.status) ?? '';
    const recipient = ident(status.recipient_id);
    const isGroup = ident(status.recipient_type) === 'group';
    const recipientUserId = ident(status.recipient_user_id);
    const contact = contactFor(objs(contacts), recipientUserId, isGroup ? null : recipient);

    const out: WaStatus = {
        wamid,
        status: STATUS_NAMES.has(rawStatus) ? (rawStatus as WaStatusName) : 'unknown',
        rawStatus,
        timestamp: seconds(status.timestamp),
        phoneNumberId: phoneNumberIdOf(metadata),
        recipientUserId: recipientUserId ?? ident(contact?.user_id),
    };

    // For a group recipient `recipient_id` is the GROUP's id, not a phone.
    if (recipient && !isGroup) out.recipientPhone = recipient;

    if (isObj(status.pricing)) {
        out.pricing = {
            billable: typeof status.pricing.billable === 'boolean' ? status.pricing.billable : null,
            category: ident(status.pricing.category),
            type: ident(status.pricing.type),
        };
    }

    if (isObj(status.conversation)) {
        const id = ident(status.conversation.id);
        if (id) {
            out.conversation = {
                id,
                expiresAt: seconds(status.conversation.expiration_timestamp),
                originType: isObj(status.conversation.origin) ? ident(status.conversation.origin.type) : null,
            };
        }
    }

    const errors = errorsOf(status.errors);
    if (errors.length > 0) out.errors = errors;

    return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// One change
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The `value` of a `field: 'messages'` change: its inbound messages, its statuses, and its value-level errors.
 *
 * Never throws and never touches anything outside `value`; anything that is not the expected shape produces less
 * output, not an exception (a throw here would be a webhook that answers 500 and is redelivered for days).
 */
export function normalizeWhatsAppChange(value: unknown): WaChange {
    if (!isObj(value)) return { messages: [], statuses: [], errors: [] };
    const messages = objs(value.messages).map((message) => normalizeWhatsAppMessage(value.metadata, value.contacts, message));
    const statuses: WaStatus[] = [];
    for (const status of objs(value.statuses)) {
        const normalised = normalizeWhatsAppStatus(value.metadata, value.contacts, status);
        if (normalised) statuses.push(normalised);
    }
    return { messages, statuses, errors: errorsOf(value.errors) };
}
