/**
 * WhatsApp entry links: the owner's QR codes and short links that open a chat with the agent, each tagged so the FIRST message that arrives
 * through one can be attributed to it (docs/specs/001-whatsapp-agent/research.md R13, tasks T048 / T049).
 *
 * **Meta holds the links; this app holds only their labels.** A QR code or short link is an object at Meta (`message_qrdls`, see
 * `whatsapp.ts`): its `code`, `prefilled_message`, `deep_link_url` and image are read from there, so a code made or deleted in WhatsApp
 * Manager shows up here (or goes) with no sync step. What Meta cannot hold is the owner's name for a link and the short code that tells the
 * agent where a conversation came from, and those live in the connection row, with no migration:
 *
 *     platform_connections.settings.entry_links = { [code]: { label, ref, created_at } }
 *
 * `ref` is also IN the prefilled message, appended as ` #<ref>`, so the map is not the only copy: lose the map (a disconnect resets
 * `settings`) and the ref is still recovered from Meta's message by `refFromText`. The same function reads it from the first inbound
 * message; the attribution itself (T049) is the integration step and is not here.
 *
 * Reading and writing the map are single atomic UPDATEs on the key (`jsonb_set`, `#-`), never a read-modify-write of the whole `settings`:
 * the owner's billing choices live in the same column and must not be overwritten by a label save racing a billing save.
 */
import { randomInt } from 'node:crypto';
import { queryCount, queryOne } from '../db/query.js';
import { QR_PREFILL_MAX_CHARS, type WhatsAppQrCode } from './whatsapp.js';

// ─── The words ──────────────────────────────────────────────────────────────────────────

/**
 * The machine codes the entry-point routes answer with in `code`, next to the ones this module's validators return (`invalid_label`,
 * `prefill_too_long` …) so the whole vocabulary of the entry points is in one place. The Settings section for entry links and ice breakers
 * (T052 / T053) needs a sentence for each in both dictionaries; `ENTRY_POINT_ERROR_CODES` is the list to translate, and a test keeps it
 * equal to the codes the source can actually send.
 *
 *   entry_links_unreadable / ice_breakers_unreadable   Meta refused a READ (400, in Meta's words); an unreachable Meta is `meta_unreachable`
 *   qr_refused / ice_breakers_refused                  Meta refused a WRITE (400, in Meta's words): the 2,000 limit, a message it rejects, a permission
 *   not_confirmed                                      Meta answered 200 without `success`: not claimed as done (502)
 *   not_found                                          the code is not one of this number's (404)
 *   invalid_code                                       the code in the path is not a QR code id (400)
 */
export const ENTRY_ERRORS = {
    linksUnreadable: 'entry_links_unreadable',
    iceBreakersUnreadable: 'ice_breakers_unreadable',
    qrRefused: 'qr_refused',
    iceBreakersRefused: 'ice_breakers_refused',
    notConfirmed: 'not_confirmed',
    notFound: 'not_found',
    invalidCode: 'invalid_code',
} as const;

/** Every `code` an entry-point route can answer with, for the dashboard to translate: the routes' own, then each validator's. */
export const ENTRY_POINT_ERROR_CODES: readonly string[] = [
    ...Object.values(ENTRY_ERRORS),
    // parseEntryLinkInput
    'invalid_label', 'label_too_long', 'invalid_prefill', 'prefill_too_long',
    // parseConversationalAutomation (whatsapp.ts)
    'invalid_prompts', 'too_many_prompts', 'prompt_too_long', 'prompt_has_emoji',
    'invalid_commands', 'too_many_commands', 'invalid_command_name', 'command_name_too_long',
    'invalid_command_description', 'command_description_too_long', 'command_has_emoji', 'duplicate_command',
];

// ─── The ref ────────────────────────────────────────────────────────────────────────────

/** Capitals and digits that cannot be misread when a person types or reads one aloud: no 0, O, 1, I or L. 23 letters + 8 digits. */
export const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const REF_LENGTH = 6;
const REF_DIGITS = '23456789';

/** A well-formed ref: six characters of the alphabet, at least one a digit. The digit keeps a six-letter word (`#SUMMER`) from being one. */
export function isRef(value: unknown): value is string {
    return typeof value === 'string'
        && value.length === REF_LENGTH
        && [...value].every((ch) => REF_ALPHABET.includes(ch))
        && [...value].some((ch) => REF_DIGITS.includes(ch));
}

/** A fresh ref. `pick(n)` is a random integer in [0, n): crypto-random by default, injectable so a test can fix it. */
export function newRef(pick: (n: number) => number = (n) => randomInt(n)): string {
    const chars = Array.from({ length: REF_LENGTH }, () => REF_ALPHABET.charAt(pick(REF_ALPHABET.length)));
    if (!chars.some((ch) => REF_DIGITS.includes(ch))) chars[pick(REF_LENGTH)] = REF_DIGITS.charAt(pick(REF_DIGITS.length));
    return chars.join('');
}

/** A ref not in `taken`. Ten tries at 31^6 possibilities: failing them means the generator is broken, and that is an error, not a loop. */
export function newUniqueRef(taken: ReadonlySet<string>, pick?: (n: number) => number): string {
    for (let i = 0; i < 10; i++) {
        const ref = newRef(pick);
        if (!taken.has(ref)) return ref;
    }
    throw new Error('Could not make an unused entry-link ref.');
}

/**
 * `#`, six alphabet characters, and neither a letter, a digit nor another `#` on either side. Both cases are accepted, spelled out rather than
 * with the `i` flag: under `iu`, `ſ` and the Kelvin sign fold onto `s` and `k`.
 */
const REF_IN_TEXT = /(?<![\p{L}\p{N}#])#([A-HJKMNP-Za-hjkmnp-z2-9]{6})(?![\p{L}\p{N}])/gu;

/**
 * The ref tagged on a message: the LAST well-formed ` #REF` token in `text`, upper-cased, or null. Pure.
 *
 * Last, not first: the ref is appended after the owner's own prefill, and Meta may add something after it (its create example answers
 * "Cyber Monday 1" to a request for "Cyber Monday"), so the end of the text is where ours is. This only EXTRACTS a candidate. A person can
 * type `#K7M3QA`, and the owner's own prefill may contain one; the caller trusts it only when it is one of the tenant's known refs.
 */
export function refFromText(text: unknown): string | null {
    if (typeof text !== 'string' || !text) return null;
    let found: string | null = null;
    for (const m of text.matchAll(REF_IN_TEXT)) {
        const candidate = m[1]!.toUpperCase();
        if (isRef(candidate)) found = candidate;
    }
    return found;
}

/** `text` without its trailing ` #ref` token: the owner's own prefill, as they typed it. The ref comes out only where it is found. */
export function stripRef(text: string, ref: string | null): string {
    if (!ref) return text.trim();
    let last: RegExpMatchArray | undefined;
    for (const m of text.matchAll(new RegExp(`\\s*#${ref}(?![\\p{L}\\p{N}])`, 'giu'))) last = m;
    if (!last || last.index === undefined) return text.trim();
    return (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
}

// ─── What the owner may send ────────────────────────────────────────────────────────────

/** The owner's own text. 120 + ` #ABC234` (8 characters) fits Meta's 140 with room to spare; `composePrefill` still checks the sum. */
export const ENTRY_PREFILL_MAX_CHARS = 120;
export const ENTRY_LABEL_MAX_CHARS = 60;

export interface EntryLinkInput { label: string; prefill: string }

export type EntryLinkParse = { value: EntryLinkInput } | { error: string; code: string };

/** The body of `POST /entry-links`, checked. A value is trimmed, never shortened: over a limit is an error that names it. Pure. */
export function parseEntryLinkInput(input: unknown): EntryLinkParse {
    const body = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const prefill = typeof body.prefill === 'string' ? body.prefill.trim() : '';
    if (!label) return { error: 'label is required: a name for this link, for example "Instagram bio".', code: 'invalid_label' };
    if (label.length > ENTRY_LABEL_MAX_CHARS) {
        return { error: `label is ${label.length} characters; the limit is ${ENTRY_LABEL_MAX_CHARS}.`, code: 'label_too_long' };
    }
    if (!prefill) return { error: 'prefill is required: the message the customer starts the chat with.', code: 'invalid_prefill' };
    if (prefill.length > ENTRY_PREFILL_MAX_CHARS) {
        return {
            error: `prefill is ${prefill.length} characters; the limit is ${ENTRY_PREFILL_MAX_CHARS} (WhatsApp allows ${QR_PREFILL_MAX_CHARS}, and the tracking code takes the rest).`,
            code: 'prefill_too_long',
        };
    }
    return { value: { label, prefill } };
}

/**
 * The prefilled message Meta is given: the owner's text, a space, `#ref`. Over Meta's 140 characters is an error, never a cut: a cut would
 * take the ref, the one part this app needs, off the end.
 */
export function composePrefill(prefill: string, ref: string): { text: string } | { error: string; code: string } {
    if (!isRef(ref)) throw new TypeError('ref is not a well-formed entry-link ref.');
    const text = `${prefill.trim()} #${ref}`;
    if (text.length > QR_PREFILL_MAX_CHARS) {
        return { error: `The message with its tracking code is ${text.length} characters; WhatsApp allows ${QR_PREFILL_MAX_CHARS}.`, code: 'prefill_too_long' };
    }
    return { text };
}

// ─── The label map ──────────────────────────────────────────────────────────────────────

export interface EntryLinkLabel {
    label: string;
    ref: string;
    /** ISO time the link was made here. */
    created_at: string;
}

export type EntryLinkLabels = Record<string, EntryLinkLabel>;

/** The stored map, read defensively: JSON this code wrote, but a column edited by hand is not trusted to be this shape. */
export function readEntryLinkLabels(value: unknown): EntryLinkLabels {
    const out: EntryLinkLabels = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [code, raw] of Object.entries(value as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue;
        const e = raw as Record<string, unknown>;
        if (typeof e.label !== 'string' || !isRef(e.ref)) continue;
        out[code] = { label: e.label, ref: e.ref, created_at: typeof e.created_at === 'string' ? e.created_at : '' };
    }
    return out;
}

const LIVE_CONNECTION = `creator_id = $1 AND platform = 'whatsapp' AND status <> 'revoked'`;

/** The tenant's labels, `{}` when there are none or no live connection. */
export async function getEntryLinkLabels(creatorId: string): Promise<EntryLinkLabels> {
    const row = await queryOne<{ entry_links: unknown }>(
        `SELECT settings -> 'entry_links' AS entry_links FROM platform_connections WHERE ${LIVE_CONNECTION}`,
        [creatorId]
    );
    return readEntryLinkLabels(row?.entry_links);
}

/** Add or replace one label: a single atomic UPDATE of the `entry_links` key, so the rest of `settings` is untouched. False when there is no live connection. */
export async function putEntryLinkLabel(creatorId: string, code: string, entry: EntryLinkLabel): Promise<boolean> {
    const n = await queryCount(
        `UPDATE platform_connections
            SET settings = jsonb_set(
                    COALESCE(settings, '{}'::jsonb),
                    '{entry_links}',
                    (CASE WHEN jsonb_typeof(settings -> 'entry_links') = 'object' THEN settings -> 'entry_links' ELSE '{}'::jsonb END) || $2::jsonb,
                    true),
                updated_at = NOW()
          WHERE ${LIVE_CONNECTION}`,
        [creatorId, JSON.stringify({ [code]: entry })]
    );
    return n > 0;
}

/** Remove one label. A code with no label is not an error. False when there is no live connection. */
export async function dropEntryLinkLabel(creatorId: string, code: string): Promise<boolean> {
    const n = await queryCount(
        `UPDATE platform_connections
            SET settings = COALESCE(settings, '{}'::jsonb) #- ARRAY['entry_links', $2::text],
                updated_at = NOW()
          WHERE ${LIVE_CONNECTION}`,
        [creatorId, code]
    );
    return n > 0;
}

// ─── The answer ─────────────────────────────────────────────────────────────────────────

/** One link as the dashboard shows it (contracts/dashboard-api.md, "Entry points"). Never a token: there is none to carry. */
export interface EntryLinkView {
    /** The Meta code, which is what DELETE takes. */
    id: string;
    code: string;
    /** The owner's name for it. Null for a code made in WhatsApp Manager. */
    label: string | null;
    /** The tracking code in the message: from the label map, else read from Meta's message. */
    ref: string | null;
    /** The owner's own text, without the tracking code. */
    prefill: string;
    /** What Meta holds, and so what the customer's first message says. */
    prefilled_message: string;
    /** The short link, `https://wa.me/message/<code>`. */
    url: string | null;
    qr_image_url: string | null;
    created_at: string | null;
    /** True when this app made it (a label exists); false for a code made elsewhere. */
    managed: boolean;
    /** Conversations that began through it. Null until attribution lands (T049): never a guess. */
    conversations: number | null;
}

export function entryLinkView(qr: WhatsAppQrCode, label?: EntryLinkLabel): EntryLinkView {
    const ref = label?.ref ?? refFromText(qr.prefilledMessage);
    return {
        id: qr.code,
        code: qr.code,
        label: label?.label ?? null,
        ref,
        prefill: stripRef(qr.prefilledMessage, ref),
        prefilled_message: qr.prefilledMessage,
        url: qr.deepLinkUrl,
        qr_image_url: qr.qrImageUrl,
        created_at: label?.created_at || null,
        managed: label !== undefined,
        conversations: null,
    };
}

/** Meta's list joined with the labels. Meta's order (newest first) is kept; a label whose code Meta no longer lists is not shown. */
export function mergeEntryLinks(codes: readonly WhatsAppQrCode[], labels: EntryLinkLabels): EntryLinkView[] {
    return codes.map((qr) => entryLinkView(qr, Object.hasOwn(labels, qr.code) ? labels[qr.code] : undefined));
}
