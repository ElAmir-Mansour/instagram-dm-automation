/**
 * One WhatsApp `entry` -> the jobs it implies (docs/specs/001-whatsapp-agent/contracts/webhook-inbound.md section 3). The WhatsApp branch of
 * `planJobs` (router.ts): pure apart from log lines, no database, and it never throws, because it runs before the 200 goes back to Meta.
 *
 * Nothing here decides what a message MEANS: `normalizeWhatsAppMessage` / `normalizeWhatsAppStatus` (whatsapp.ts) do, and the handler
 * (`whatsappInbound.ts`, `whatsappStatus.ts`) acts. This only decides which of the things in a delivery are work, and every thing it declines
 * to make work says so in the log (constitution IV): there is no silent drop in this file.
 *
 *   change.field                  job                       dedupe key                          tenantKey
 *   messages -> a message         dm.process                dm:<wamid>                          phone_number_id
 *   messages -> a status          wa.event {status}         wa:st:<wamid>:<status>              phone_number_id
 *   account_update, account_alerts, phone_number_quality_update, phone_number_name_update, business_capability_update
 *                                 wa.event {account}        wa:acct:<field>:<time>:<sha1>       entry.id (the WABA)
 *   user_preferences              wa.event {preference}     wa:pref:<sha1>                      phone_number_id
 *   anything else                 none: `wa.unhandled_field`
 *
 * A message that is a group message, or has no BSUID anywhere, becomes NO job (`wa.ignored`): there is nobody to store a thread for. Every other
 * kind of ignored message (a reaction, an unsupported type, `request_welcome`, an edit) still becomes a `dm.process` job: the handler stores a
 * row that says why nobody answered, or logs it. The `dm:` prefix is kept: the inbox's delivery chip reads the job through `dm:<mid>`.
 *
 * Each job carries ONE message (or status) with its own contact and the `metadata`, not the whole delivery: a batch holds several people, and a
 * job for one must not carry another's profile name.
 */
import { createHash } from 'node:crypto';
import type { EnqueueInput } from '../jobs/types.js';
import { log } from '../utils/log.js';
import { normalizeWhatsAppChange, normalizeWhatsAppMessage, normalizeWhatsAppStatus } from './whatsapp.js';

/** The `object` of a WhatsApp Business Account webhook body. */
export const WHATSAPP_OBJECT = 'whatsapp_business_account';

/** `change.field` values that describe the number or the account, not a message. Each is one `wa.event` of kind `account`. */
export const WA_ACCOUNT_FIELDS: ReadonlySet<string> = new Set([
    'account_update',
    'account_alerts',
    'phone_number_quality_update',
    'phone_number_name_update',
    'business_capability_update',
]);

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const objs = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isObj) : []);

function ident(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/** Unix seconds from a number or the numeric string Meta sends, else null. */
function unixSeconds(value: unknown): number | null {
    const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,15}$/.test(value.trim()) ? Number(value.trim()) : NaN;
    return Number.isFinite(n) ? n : null;
}

const sha1 = (value: unknown): string => createHash('sha1').update(JSON.stringify(value) ?? '').digest('hex');

/**
 * The contacts of a delivery that belong to one message or status: the ones its sender (or recipient) id and phone name, or, when none is
 * named, the lone contact of a one-contact delivery. The same rule the normaliser applies when it picks a contact (whatsapp.ts `contactFor`),
 * so what a job re-normalises to equals what was planned from; `router.test.ts` pins that against every fixture.
 */
function contactsFor(contacts: unknown, userId: unknown, phone: unknown): Obj[] {
    const list = objs(contacts);
    const id = ident(userId);
    const wa = ident(phone);
    const named = list.filter((c) => (id !== null && ident(c.user_id) === id) || (wa !== null && ident(c.wa_id) === wa));
    if (named.length > 0) return named;
    return list.length === 1 ? list : [];
}

/** `value` cut down to one entry of `list` (`messages` or `statuses`) and its own contacts. */
function trimmed(value: Obj, list: 'messages' | 'statuses', item: Obj, userId: unknown, phone: unknown): Obj {
    return {
        messaging_product: value.messaging_product,
        metadata: value.metadata,
        contacts: contactsFor(value.contacts, userId, phone),
        [list]: [item],
    };
}

function phoneNumberIdOf(value: unknown): string | null {
    return isObj(value) && isObj(value.metadata) ? ident(value.metadata.phone_number_id) : null;
}

function planMessagesChange(entryId: string, value: unknown, out: EnqueueInput[]): void {
    const phoneNumberId = phoneNumberIdOf(value);
    const fields = { phone_number_id: phoneNumberId };
    if (!isObj(value)) {
        log('info', 'wa.empty_change', fields);
        return;
    }
    const tenantKey = phoneNumberId ?? (entryId || undefined);
    const rawMessages = objs(value.messages);
    const rawStatuses = objs(value.statuses);

    // value-level errors (a system, app or account problem with no message attached) are the one thing here that is neither work nor noise.
    const valueErrors = normalizeWhatsAppChange({ errors: value.errors }).errors;
    if (valueErrors.length > 0) log('warn', 'wa.value_errors', { ...fields, codes: valueErrors.map((e) => e.code) });

    if (rawMessages.length === 0 && rawStatuses.length === 0 && valueErrors.length === 0) {
        log('info', 'wa.empty_change', fields);
        return;
    }

    for (const raw of rawMessages) {
        const message = normalizeWhatsAppMessage(value.metadata, value.contacts, raw);
        if (message.kind === 'ignored' && (message.reason === 'group' || message.reason === 'no_user_id')) {
            log('info', 'wa.ignored', { reason: message.reason, phone_number_id: phoneNumberId });
            continue;
        }
        out.push({
            kind: 'dm.process',
            payload: { object: 'whatsapp', entryId, phoneNumberId, change: trimmed(value, 'messages', raw, raw.from_user_id, raw.from) },
            dedupeKey: message.metaMessageId ? `dm:${message.metaMessageId}` : undefined,
            tenantKey,
        });
    }

    for (const raw of rawStatuses) {
        const status = normalizeWhatsAppStatus(value.metadata, value.contacts, raw);
        if (!status) {
            // No id to find a message by: there is nothing to update.
            log('info', 'wa.status_ignored', { reason: 'no_id', phone_number_id: phoneNumberId });
            continue;
        }
        out.push({
            kind: 'wa.event',
            payload: { kind: 'status', entryId, phoneNumberId, change: trimmed(value, 'statuses', raw, raw.recipient_user_id, raw.recipient_id) },
            dedupeKey: `wa:st:${status.wamid}:${status.status === 'unknown' ? status.rawStatus || 'unknown' : status.status}`,
            tenantKey,
        });
    }
}

/**
 * The jobs one WhatsApp `entry` implies. `entry.id` is the Messaging account (WABA) id.
 */
export function planWhatsAppEntry(entry: unknown): EnqueueInput[] {
    const out: EnqueueInput[] = [];
    const e = isObj(entry) ? entry : {};
    const entryId = typeof e.id === 'string' ? e.id : '';
    const entryTime = unixSeconds(e.time);
    const changes = objs(e.changes);

    if (changes.length === 0) {
        log('info', 'wa.empty_entry', { entry_id: entryId || null });
        return out;
    }

    for (const change of changes) {
        const field = typeof change.field === 'string' ? change.field : '';
        const value = change.value;

        if (field === 'messages') {
            planMessagesChange(entryId, value, out);
        } else if (WA_ACCOUNT_FIELDS.has(field)) {
            // Account events are keyed on WHEN as well as what (review M13): GREEN -> YELLOW -> GREEN -> YELLOW is four events, and a key on
            // the value alone would drop the fourth while the first job is still kept. Without any time the key is omitted, not guessed: a
            // duplicate is harmless (the handler compares with what is stored), a dropped alert is not.
            const time = entryTime ?? unixSeconds(change.time);
            out.push({
                kind: 'wa.event',
                payload: { kind: 'account', entryId, field, value, time },
                dedupeKey: time !== null ? `wa:acct:${field}:${time}:${sha1(value)}` : undefined,
                tenantKey: entryId || undefined,
            });
        } else if (field === 'user_preferences') {
            const phoneNumberId = phoneNumberIdOf(value);
            out.push({
                kind: 'wa.event',
                payload: { kind: 'preference', entryId, phoneNumberId, change: value },
                // Each preference inside carries its own timestamp, so the hash of the value already tells two events apart.
                dedupeKey: `wa:pref:${sha1(value)}`,
                tenantKey: phoneNumberId ?? (entryId || undefined),
            });
        } else {
            log('info', 'wa.unhandled_field', { field });
        }
    }
    return out;
}
