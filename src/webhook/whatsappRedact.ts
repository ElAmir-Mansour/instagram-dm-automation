/**
 * What a WhatsApp job's stored payload becomes once it has done its work and nobody needs the customer's content in it any more
 * (docs/specs/001-whatsapp-agent review C3; the hook is `JobResult.redactPayload`, src/jobs/types.ts). Pure: no I/O, no clock.
 *
 * A job's payload is Meta's event, kept verbatim so a fixed normaliser can replay a job that failed. The queue keeps a `done` row for 7 days and a
 * `failed` one for good, and until the privacy pages name WhatsApp the product stores nothing a stranger said. So a payload that is no longer
 * needed is cut down to what an audit and the dedupe need, and nothing a person wrote or that names them:
 *
 *   kept      `object`, `entryId`, `phoneNumberId`; per message the wamid, its type, its timestamp and the BSUID (a system message: the type and the
 *             two BSUIDs); per status the wamid, status, timestamp, pricing and error codes (Meta's words, not a person's)
 *   dropped   text, captions, titles, reply ids, media ids and mime types and filenames, locations and cards, referrals (ad id, click id, headline),
 *             `contacts` (profile name, username, `wa_id`), the raw `from` phone, `recipient_id`, the system message's body and phone
 *
 * The result still has the shape of a payload of its kind (`object: 'whatsapp'` and a `change` for a message), so a replay of a redacted job reaches
 * the same handler and ends in a log line (`wa.ignored`, `wa.job_empty`), never in the Instagram pipeline and never in a crash.
 *
 * Redacting a redacted payload gives it back unchanged.
 */
import type { WaEventPayload, WhatsAppDmPayload } from '../jobs/types.js';
import { normalizeWhatsAppChange } from './whatsapp.js';

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 200): string | undefined => (typeof value === 'string' && value ? value.slice(0, max) : undefined);

/** Drop the keys that hold nothing, so a redacted object is as small as it can be. */
function compact<T extends Obj>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null)) as T;
}

const secondsText = (seconds: number | null): string | undefined => (seconds === null ? undefined : String(seconds));

function metadataOf(phoneNumberId: string | null): Obj {
    return { phone_number_id: phoneNumberId };
}

/** A `dm.process` payload for one WhatsApp message, down to the audit minimum. */
export function redactedInboundPayload(payload: WhatsAppDmPayload): WhatsAppDmPayload {
    const messages = normalizeWhatsAppChange(payload.change).messages.map((message) => {
        if (message.kind === 'system') {
            return compact({
                id: message.metaMessageId,
                type: 'system',
                timestamp: secondsText(message.timestamp),
                system: compact({ type: message.systemType, user_id: message.userId, previous_user_id: message.rekey?.from }),
            });
        }
        // `messageType` is the value `messages.message_type` holds (`interactive.button_reply`, `image`, `reaction`, ...).
        return compact({
            id: message.metaMessageId ?? undefined,
            type: message.messageType ?? undefined,
            timestamp: secondsText(message.timestamp),
            from_user_id: message.senderId ?? undefined,
        });
    });
    return {
        object: 'whatsapp',
        entryId: payload.entryId,
        phoneNumberId: payload.phoneNumberId,
        change: { redacted: true, metadata: metadataOf(payload.phoneNumberId), messages },
    };
}

type StatusEvent = Extract<WaEventPayload, { kind: 'status' }>;
type PreferenceEvent = Extract<WaEventPayload, { kind: 'preference' }>;

/** A `wa.event` status payload: the wamid, the status, its time, its pricing and Meta's error codes; no recipient phone, no contact. */
export function redactedStatusPayload(payload: StatusEvent): StatusEvent {
    const statuses = normalizeWhatsAppChange(payload.change).statuses.map((status) =>
        compact({
            id: status.wamid,
            status: status.rawStatus,
            timestamp: secondsText(status.timestamp),
            recipient_user_id: status.recipientUserId ?? undefined,
            pricing: status.pricing
                ? compact({ billable: status.pricing.billable, category: status.pricing.category, type: status.pricing.type })
                : undefined,
            errors: status.errors?.map((e) => compact({ code: e.code, title: e.title, error_data: e.details ? { details: e.details } : undefined })),
        })
    );
    return { ...payload, change: { redacted: true, metadata: metadataOf(payload.phoneNumberId), statuses } };
}

/** A `wa.event` preference payload: what was chosen (category, value, time), not who chose it. */
export function redactedPreferencePayload(payload: PreferenceEvent): PreferenceEvent {
    const raw = isObj(payload.change) && Array.isArray(payload.change.user_preferences) ? payload.change.user_preferences.filter(isObj) : [];
    const user_preferences = raw.map((p) => compact({ category: text(p.category), value: text(p.value), timestamp: typeof p.timestamp === 'number' ? p.timestamp : text(p.timestamp, 20) }));
    return { ...payload, change: { redacted: true, metadata: metadataOf(payload.phoneNumberId), user_preferences } };
}
