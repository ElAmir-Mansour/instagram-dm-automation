/**
 * WhatsApp's own "stop / resume marketing messages" button, as a consent row (WhatsApp agent, W7, task T045).
 *
 * Meta sends a `user_preferences` webhook only when a person stops or resumes marketing messages from the business (not for the "interested /
 * not interested" feedback on the Offers and announcements setting). Each entry names the person (`wa_id`, the BSUID `user_id`, a
 * `parent_user_id` that is for identification only and is never used to apply a preference), a `category` (always `marketing_messages`), a
 * `value` (`stop` or `resume`), Meta's own `detail` sentence and a Unix `timestamp`.
 * Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/user_preferences (read 2026-10-19).
 *
 *   stop    -> a `marketing` row, action `withdrawn`, source `user_preferences`
 *   resume  -> a `marketing` row, action `granted`,   source `user_preferences`
 *
 * WIRING NOTE: called from the `preference` branch of `handleWhatsAppEvent` (src/services/whatsappStatus.ts, which today only logs it), with the
 * tenant that owns `payload.phoneNumberId`:  `await handleUserPreference(creatorId, payload)`. The `wa.event` payload (`{ kind: 'preference',
 * change }`) and the bare `change` (`{ user_preferences: [...] }`) are both accepted.
 *
 * Decisions worth knowing:
 *   - It writes the MARKETING category only and does NOT set `conversations.opted_out_at`. Meta's button ends promotional messages, not the
 *     conversation: `opted_out_at` blocks every send, including the service reply to a question the person just asked. (data-model.md says a
 *     marketing withdrawal "also sets opted_out_at"; v1 sends nothing promotional, so that line is left to the owner to confirm.) A person who
 *     writes «إيقاف» is a different case and goes through `withdrawAll`.
 *   - The row is dated by Meta's `timestamp` (never in the future), not by arrival: webhooks arrive out of order, and an old `resume` that
 *     lands after a newer `stop` must not become the current state.
 *   - The contact is the BSUID (`user_id`), which is how every WhatsApp thread is keyed. Without one (BSUIDs not enabled) the thread is looked up
 *     by phone (`wa_id`, stored on test-sender threads) and, failing that, the row is keyed by the phone digits, so a stop is never dropped.
 *   - Neither the phone nor the BSUID is logged.
 */
import { pool } from '../config/db.js';
import { log } from '../utils/log.js';
import { recordConsent } from './consent.js';
import type { ContactConsentRow } from '../db/rows.js';

/** Meta's `category` for the marketing opt-out. Any other category is not one this module knows how to apply. */
const MARKETING_CATEGORY = 'marketing_messages';

export interface PreferenceOutcome {
    /** The `marketing` rows written, in the order the preferences arrived. */
    recorded: ContactConsentRow[];
    /** Entries that were not applied: another category, a value that is not stop or resume, or no id for the person. */
    ignored: number;
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

function id(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/** Meta's `timestamp` (seconds, a number or a numeric string) as a date, clamped to now; `null` when it is not usable. */
function eventTime(value: unknown, now: number): Date | null {
    const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/.test(value.trim()) ? Number(value) : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    // Never in the future: a row dated ahead of now would outrank every row written after it.
    return new Date(Math.min(seconds * 1000, now));
}

/** The preferences inside a `wa.event` payload or a bare change value. */
function preferencesOf(event: unknown): Obj[] {
    const change = isObj(event) && 'change' in event ? event.change : event;
    return isObj(change) && Array.isArray(change.user_preferences) ? change.user_preferences.filter(isObj) : [];
}

/** The thread this person has with the tenant, if any: by BSUID (the thread key) or by phone. */
async function findThread(creatorId: string, ids: string[], bsuid: string | null): Promise<{ id: string; instagram_user_id: string } | null> {
    const found = await pool.query<{ id: string; instagram_user_id: string }>(
        `SELECT id, instagram_user_id
           FROM conversations
          WHERE creator_id = $1 AND platform = 'whatsapp' AND (instagram_user_id = ANY($2::text[]) OR wa_phone = ANY($2::text[]))
          LIMIT 5`,
        [creatorId, ids]
    );
    return found.rows.find((r) => r.instagram_user_id === bsuid) ?? found.rows[0] ?? null;
}

/**
 * Apply a `user_preferences` webhook for one tenant. Never throws on content it does not understand (a malformed entry is counted in `ignored`);
 * a database failure does throw, so the job is retried and the opt-out is not lost.
 */
export async function handleUserPreference(creatorId: string, event: unknown, now: number = Date.now()): Promise<PreferenceOutcome> {
    const outcome: PreferenceOutcome = { recorded: [], ignored: 0 };
    for (const preference of preferencesOf(event)) {
        const value = id(preference.value)?.toLowerCase();
        const action = value === 'stop' ? 'withdrawn' : value === 'resume' ? 'granted' : null;
        const bsuid = id(preference.user_id);
        const phone = id(preference.wa_id);
        if (id(preference.category) !== MARKETING_CATEGORY || action === null || (bsuid === null && phone === null)) {
            outcome.ignored++;
            continue;
        }

        const thread = await findThread(creatorId, [bsuid, phone].filter((x): x is string => x !== null), bsuid);
        outcome.recorded.push(await recordConsent({
            creatorId,
            conversationId: thread?.id ?? null,
            platform: 'whatsapp',
            contactRef: bsuid ?? thread?.instagram_user_id ?? (phone as string),
            category: 'marketing',
            action,
            source: 'user_preferences',
            wording: id(preference.detail) ?? `${MARKETING_CATEGORY}: ${value}`,
            at: eventTime(preference.timestamp, now),
        }));
    }
    log(outcome.recorded.length > 0 ? 'info' : 'warn', 'consent.user_preference', { creator_id: creatorId, recorded: outcome.recorded.length, ignored: outcome.ignored });
    return outcome;
}
