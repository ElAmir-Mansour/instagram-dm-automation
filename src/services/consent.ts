/**
 * Consent and opt-out (WhatsApp agent, W7: docs/specs/001-whatsapp-agent, tasks T043 and T044, review C2).
 *
 * `contact_consents` (migration v50) is APPEND-ONLY: one row per grant or withdrawal, with the exact wording and the source. The current state
 * of a contact is the newest row for (creator, contact, category). Nothing here updates or deletes a consent row; the one exception in the
 * code base is the BSUID re-key in whatsappInbound.ts, which moves a person's history to their new id, and the erasure flow, which removes it.
 *
 * ## WIRING NOTE: where the integration step must call this
 *
 * Nothing imports this module yet. In `src/webhook/whatsappInbound.ts`, for a TEXT inbound from a WhatsApp contact, AFTER the message row is
 * stored and BEFORE the test-sender / mode gates hand it to the sales turn (an opt-out is honoured in every mode, test senders and `off` included):
 *
 *     const stop = matchStopMessage(text);                  // whole message only, never a substring
 *     if (stop) {
 *         const out = await withdrawAll({ creatorId, platform: 'whatsapp', contactRef: bsuid, conversationId, wording: text });
 *         // 1. the turn is SKIPPED: mark the inbound message `no_reply_reason = 'opted_out'`, never call the sales turn or the model.
 *         // 2. pending `dm.followup` jobs for the contact are already cancelled by withdrawAll (same transaction); nothing to do.
 *         // 3. send ONE confirmation, in the language of the phrase, and only if this opt-out is new:
 *         if (out.conversationsNewlyOptedOut > 0) send(confirmationText(stop.lang));   // a repeat "stop" gets no second confirmation
 *     }
 *
 * The confirmation is a free-form reply inside the 24 h window the stop message just opened, so it needs no template. Record it as an outbound
 * message like any reply. If the send fails, the opt-out STANDS: `opted_out_at` is already committed and every sender checks it; a lost
 * confirmation is a lesser harm than a lost opt-out.
 *
 * Instagram / Facebook: the same call, but only behind `ai_agents.optout_phrases_igfb` (default off, review C2). `isStopMessage` is a strict
 * matcher on purpose and does not read that setting; the caller decides whether the channel is allowed to use it.
 *
 * `user_preferences` webhooks (Meta's own "stop marketing" button) go through `handleUserPreference` in consentPreferences.ts, called from the
 * `preference` branch of `handleWhatsAppEvent` in whatsappStatus.ts.
 *
 * ## What counts as a stop message (review C2)
 *
 * The WHOLE message, normalised, must equal a phrase in the list: Arabic normalisation (alef forms, tatweel, diacritics, teh marbuta, yeh),
 * lower case, punctuation, emoji and invisible direction marks removed, at most three words. «عايز إلغاء الطلب» contains «إلغاء» and is a question
 * about an order; «موقف» and «توقف» inside a sentence are ordinary words; "nonstop" and "stop by tomorrow?" are not requests to stop. A false
 * match silences a real customer, so the list is short and exact. Bare «إلغاء» and "cancel" are deliberately NOT stop phrases: they cancel an
 * order as often as a subscription.
 */
import type { ContactConsentAction, ContactConsentCategory, ContactConsentRow, ContactConsentSource, ConversationPlatform } from '../db/rows.js';
import { pool } from '../config/db.js';
import { normalizeArabic } from '../utils/arabic.js';
import { log } from '../utils/log.js';
import { withTransaction, type Exec } from './studio/common.js';

// ─── Types ────────────────────────────────────────────────────────────────────────────────

export const CONSENT_CATEGORIES: readonly ContactConsentCategory[] = ['service', 'updates', 'marketing'];
const CONSENT_ACTIONS: readonly ContactConsentAction[] = ['granted', 'withdrawn'];
const CONSENT_SOURCES: readonly ContactConsentSource[] = ['agent_offer', 'stop_phrase', 'user_preferences', 'owner', 'in_app_signup'];

/** The language of a stop phrase, and of the confirmation that answers it. */
export type ConsentLang = 'ar' | 'en';

/** The longest `wording` kept. A stop message is three words; this bounds anything else a caller passes. */
const MAX_WORDING = 2000;

export interface ConsentInput {
    creatorId: string;
    /** The thread it happened in. Optional: a consent can be recorded from an event that has no thread (a preference webhook). */
    conversationId?: string | null;
    platform: ConversationPlatform;
    /** The platform's id for the person: a BSUID, an IGSID or a PSID. */
    contactRef: string;
    category: ContactConsentCategory;
    action: ContactConsentAction;
    source: ContactConsentSource;
    /** The exact text the person saw or sent. */
    wording?: string | null;
    /** When it happened, if the source says (a webhook's own timestamp). Default: now. Must not be in the future: the caller clamps it. */
    at?: Date | null;
}

/** The state of one category for one contact: the newest row. */
export interface CurrentConsent {
    action: ContactConsentAction;
    source: ContactConsentSource;
    at: Date;
    wording: string | null;
}

// ─── Reading and writing consent rows ─────────────────────────────────────────────────────

function requireText(value: unknown, what: string): string {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`consent: ${what} is required`);
    return value;
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Error(`consent: unknown ${what} "${String(value)}"`);
    return value as T;
}

function cleanWording(wording: string | null | undefined): string | null {
    if (typeof wording !== 'string') return null;
    const trimmed = wording.trim();
    return trimmed === '' ? null : trimmed.slice(0, MAX_WORDING);
}

/** `clock_timestamp()` and not the column's `NOW()`: two rows written in one transaction must still have an order, and `NOW()` is the same for both. */
const INSERT_CONSENT = `INSERT INTO contact_consents (creator_id, conversation_id, platform, contact_ref, category, action, source, wording, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, clock_timestamp()))
     RETURNING *`;

/**
 * Append one consent row. Never updates: a withdrawal is a new row, so the history stays what it was. Throws on an unknown category, action or
 * source (the CHECKs would too, later and less clearly). Pass `exec` to write inside a transaction.
 */
export async function recordConsent(input: ConsentInput, exec: Exec = pool): Promise<ContactConsentRow> {
    const creatorId = requireText(input.creatorId, 'creatorId');
    const contactRef = requireText(input.contactRef, 'contactRef');
    const platform = requireText(input.platform, 'platform');
    const category = requireOneOf(input.category, CONSENT_CATEGORIES, 'category');
    const action = requireOneOf(input.action, CONSENT_ACTIONS, 'action');
    const source = requireOneOf(input.source, CONSENT_SOURCES, 'source');
    const result = await exec.query<ContactConsentRow>(INSERT_CONSENT, [
        creatorId, input.conversationId ?? null, platform, contactRef, category, action, source, cleanWording(input.wording), input.at ?? null,
    ]);
    return result.rows[0] as ContactConsentRow;
}

/**
 * The current state of one category for one contact: the newest row for (creator, contact, category), or `null` when nothing was ever
 * recorded. No row is not consent and is not a withdrawal: the caller decides what "unknown" means for what it is about to send.
 */
export async function currentConsent(creatorId: string, contactRef: string, category: ContactConsentCategory, exec: Exec = pool): Promise<CurrentConsent | null> {
    const result = await exec.query<Pick<ContactConsentRow, 'action' | 'source' | 'wording' | 'created_at'>>(
        `SELECT action, source, wording, created_at
           FROM contact_consents
          WHERE creator_id = $1 AND contact_ref = $2 AND category = $3
          ORDER BY created_at DESC
          LIMIT 1`,
        [creatorId, contactRef, category]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { action: row.action, source: row.source, wording: row.wording ?? null, at: new Date(row.created_at as unknown as string | number | Date) };
}

// ─── Opting out ───────────────────────────────────────────────────────────────────────────

export interface WithdrawAllInput {
    creatorId: string;
    platform: ConversationPlatform;
    /** The person's id on that platform: the BSUID for WhatsApp. It is also the key of their thread (`conversations.instagram_user_id`). */
    contactRef: string;
    conversationId?: string | null;
    /** What they wrote. Default source is `stop_phrase`. */
    wording?: string | null;
    source?: ContactConsentSource;
}

export interface WithdrawAllOutcome {
    /** The three `withdrawn` rows written, one per category. */
    consents: ContactConsentRow[];
    /** Threads of this contact on this channel that were NOT opted out before and are now. Zero on a repeat: the caller sends the confirmation only when this is above zero. */
    conversationsNewlyOptedOut: number;
    /** Pending `dm.followup` jobs for this contact that were cancelled. */
    followupsCancelled: number;
}

/**
 * The person asked to be left alone. In ONE transaction: `withdrawn` for every category, `conversations.opted_out_at` for this tenant's thread(s)
 * with this contact on this platform (only a thread not yet opted out is touched, so the first time is kept), and every pending `dm.followup` job to that contact
 * cancelled. Either all of it happens or none: a withdrawal without the stamp would leave the bot free to write to someone who said stop.
 *
 * The follow-up job also re-reads `opted_out_at` when it runs (followupJob.ts), so the cancellation is belt and braces, not the only guard.
 */
export async function withdrawAll(input: WithdrawAllInput): Promise<WithdrawAllOutcome> {
    const creatorId = requireText(input.creatorId, 'creatorId');
    const contactRef = requireText(input.contactRef, 'contactRef');
    const platform = requireText(input.platform, 'platform');
    const source = requireOneOf(input.source ?? 'stop_phrase', CONSENT_SOURCES, 'source');
    const wording = cleanWording(input.wording);

    const outcome = await withTransaction(async (tx) => {
        const consents: ContactConsentRow[] = [];
        for (const category of CONSENT_CATEGORIES) {
            consents.push(await recordConsent({ creatorId, conversationId: input.conversationId ?? null, platform: platform as ConversationPlatform, contactRef, category, action: 'withdrawn', source, wording }, tx));
        }

        // `platform IS NULL` is an old Instagram thread (v26 backfilled most, not every one).
        const opted = await tx.query(
            `UPDATE conversations
                SET opted_out_at = NOW()
              WHERE creator_id = $1 AND instagram_user_id = $2
                AND (platform = $3 OR (platform IS NULL AND $3 = 'instagram'))
                AND opted_out_at IS NULL`,
            [creatorId, contactRef, platform]
        );

        // A job's `senderId` is the contact's id on the platform. `cancelled` is inert: no claim, reaper or sweep reads it (jobs/types.ts).
        const cancelled = await tx.query(
            `UPDATE jobs
                SET status = 'cancelled', last_error = '[cancelled: the contact opted out]', updated_at = NOW()
              WHERE kind = 'dm.followup' AND status = 'pending'
                AND creator_id = $1 AND payload->>'senderId' = $2`,
            [creatorId, contactRef]
        );

        return { consents, conversationsNewlyOptedOut: opted.rowCount ?? 0, followupsCancelled: cancelled.rowCount ?? 0 };
    });
    // The contact's id is not logged: on WhatsApp it can stand for a phone number.
    log('info', 'consent.withdrawn_all', {
        creator_id: creatorId, platform, source, conversations: outcome.conversationsNewlyOptedOut, followups_cancelled: outcome.followupsCancelled,
    });
    return outcome;
}

// ─── The stop-phrase matcher ──────────────────────────────────────────────────────────────

/** Most words a stop message may have. The longest phrase is two; the third word is slack for a filler the list does not name, and nothing more. */
const MAX_STOP_WORDS = 3;

/**
 * The phrases, written the way a person writes them. Each is put through `normaliseStopText` once, so «إيقاف» and «ايقاف» are one entry and a phrase
 * can be added in its natural spelling.
 */
const STOP_PHRASES: Readonly<Record<ConsentLang, readonly string[]>> = {
    ar: ['إيقاف', 'ايقاف', 'وقف', 'ستوب', 'إلغاء الاشتراك', 'الغاء الاشتراك', 'لا ترسل', 'لا ترسلوا', 'توقف'],
    en: ['stop', 'unsubscribe', 'stop messages', 'opt out', 'cancel subscription'],
};

/**
 * What is compared. The Arabic normalisation first (lower case, tatweel, alef forms, teh marbuta, yeh, diacritics), then everything that is not a
 * letter or a digit becomes a space: punctuation, emoji, variation selectors, quotes, hyphens ("opt-out" is "opt out"). Invisible direction marks
 * and zero-width characters (category Cf; phones put them around Arabic text) are removed, not spaced, so they cannot split a word.
 */
export function normaliseStopText(text: string): string {
    return normalizeArabic(text.normalize('NFKC'))
        .replace(/\p{Cf}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const STOP_SETS: Readonly<Record<ConsentLang, ReadonlySet<string>>> = {
    ar: new Set(STOP_PHRASES.ar.map(normaliseStopText)),
    en: new Set(STOP_PHRASES.en.map(normaliseStopText)),
};

/**
 * The language of the phrase the whole message equals, or `null` when it is not a stop message. `lang` limits the list to one language; omit it
 * to try both. Never throws: a message that is not text (a voice note, an image with no caption) is not a stop message.
 */
export function matchStopMessage(text: unknown, lang?: ConsentLang): { lang: ConsentLang; phrase: string } | null {
    if (typeof text !== 'string' || text === '') return null;
    const normalised = normaliseStopText(text);
    if (normalised === '') return null;
    // Cheap exit for any real sentence, before a set lookup: the words, not the characters, are what is limited.
    if (normalised.split(' ').length > MAX_STOP_WORDS) return null;
    for (const candidate of lang ? [lang] : (['ar', 'en'] as const)) {
        if (STOP_SETS[candidate].has(normalised)) return { lang: candidate, phrase: normalised };
    }
    return null;
}

/** True only when the WHOLE message is a stop phrase (see the top of this file). `lang` limits the list to one language. */
export function isStopMessage(text: unknown, lang?: ConsentLang): boolean {
    return matchStopMessage(text, lang) !== null;
}

// ─── The confirmation ─────────────────────────────────────────────────────────────────────

/**
 * The one line sent after an opt-out: no more messages, and they may write again whenever they like. Plain text, no emoji. Arabic in the light Gulf
 * register the rest of the agent uses; English plain.
 */
export function confirmationText(lang: ConsentLang): string {
    return lang === 'ar'
        ? 'تم، أوقفنا الرسائل. ما راح توصلك أي رسالة ثانية منا، وإذا حبيت تكلمنا مرة ثانية اكتب لنا في أي وقت.'
        : "Done, we've stopped messaging you. You won't get any more messages from us, and you can write to us again anytime.";
}
