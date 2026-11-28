/**
 * When a person's reply from the inbox can still reach the customer (UX Wave 1, R1-I1).
 *
 * ONE rule, used twice: `POST /conversations/:id/messages` refuses a send past it (409 `WINDOW_CLOSED`, before any call to Meta), and every
 * conversation the inbox lists carries it as `reply_window_ends_at`, which is what the composer and the countdown read. The page has no copy.
 *
 * What a manual send is, to Meta (`sendDirectMessage`, `src/services/instagram.ts`): `messaging_type: 'RESPONSE'` with NO message tag. There is no
 * HUMAN_AGENT tag on this path (it needs App Review, and nothing here asks for it), so the standard window is the real one: 24 hours from the
 * customer's last message. The one thing that moves it is the one the assistant's own sends honour: a conversation that began from a
 * click-to-message ad (`entry_source.kind = 'ctm'`) on a platform whose `ads.extended_window` switch the owner turned on may be written to for
 * 7 days less an hour FROM THE CLICK (`AD_WINDOW_MS`, CLAUDE.md "A3"), if that is later than the 24 hours. That switch is off until the owner's
 * day-2 test passes, so with it off every thread is simply 24 hours.
 *
 * The assistant keeps 23 hours (`DEFAULT_WINDOW_MS`, an hour of margin so its own sends never race the edge); a person typing is not given
 * that margin, because a reply sent in the last hour is still accepted and refusing it would be wrong.
 */
import { AD_WINDOW_MS } from './ads/attribution.js';
import { REPLY_WINDOW_MS } from './inboxAssistant.js';

export interface ReplyWindowInput {
    /** The customer's last message (`messages`, newest inbound), or null when they have not written. */
    lastInboundAt: Date | null;
    /** `conversations.entry_source`, parsed (or null). Only `kind`, `platform` and `at` are read. */
    entrySource?: { kind?: unknown; platform?: unknown; at?: unknown } | null;
    /** `ads.extended_window.<tenant>`: which platform's ad conversations get the longer window. */
    extendedWindow?: { instagram: boolean; messenger: boolean } | null;
}

/** When the window closes, or null when it cannot be known (the customer has not written): never a reason to refuse. Pure. */
export function replyWindowEndsAt(input: ReplyWindowInput): Date | null {
    const last = input.lastInboundAt;
    if (!last || !Number.isFinite(last.getTime())) return null;
    const standard = last.getTime() + REPLY_WINDOW_MS;
    const es = input.entrySource;
    const platform = es && (es.platform === 'instagram' || es.platform === 'messenger') ? es.platform : null;
    if (es && es.kind === 'ctm' && platform && input.extendedWindow && input.extendedWindow[platform] === true) {
        const clicked = typeof es.at === 'string' ? Date.parse(es.at) : NaN;
        if (Number.isFinite(clicked)) return new Date(Math.max(standard, clicked + AD_WINDOW_MS));
    }
    return new Date(standard);
}

/** The window has closed at `now`. False when it is not known to have: an unknown window is never a refusal. Pure. */
export function replyWindowClosed(input: ReplyWindowInput, now: Date = new Date()): { closed: false } | { closed: true; closedAt: Date } {
    const ends = replyWindowEndsAt(input);
    return ends && now.getTime() >= ends.getTime() ? { closed: true, closedAt: ends } : { closed: false };
}

/** The customer's last message of a conversation row: `last_inbound_message_at` (from `messages`), else the v39 `last_inbound_at`, as `windowEndsAtOf` reads them. Pure. */
export function lastInboundOf(row: { last_inbound_message_at?: unknown; last_inbound_at?: unknown }): Date | null {
    const at = (value: unknown): number => (value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN);
    const fromMessages = at(row.last_inbound_message_at);
    const ms = Number.isFinite(fromMessages) ? fromMessages : at(row.last_inbound_at);
    return Number.isFinite(ms) ? new Date(ms) : null;
}
