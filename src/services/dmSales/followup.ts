/**
 * The follow-up nudge, as rules (docs/DM_SALES_PLAN.md §7, S9). Pure: no database, no clock, no network. `followupJob.ts` is the part that reads and
 * sends; this is the part that says whether it may.
 *
 * The owner's decision (plan §14.5): ONE short nudge, a few hours after a sales DM sent a link (four by default), and only to a person who has
 * not answered, has not opened the link, has not asked to be left alone, and is not in the hands of a human. It is sent inside Meta's 24 hour
 * window or not at all (§2): the window is measured from the person's last message, and the rule here is 23 hours, an hour inside it, because the
 * clock that decides is Meta's and the send takes a moment.
 *
 *   followupEligible   the whole decision, for a conversation as it is NOW. The job re-reads the conversation when it comes due and asks this, so
 *                      a person who replied (or clicked, or said stop) in between is simply not eligible any more: nothing has to be cancelled.
 *   the delay          an operator setting, `dm.sales.followup_minutes` (0 to 1320, default 240; 0 is off), parsed here
 *   the job's keys     when the nudge is due, and the dedupe key that makes "one per link" true however many times a link is recorded
 *
 * What counts as a click: a person's. The tracked-link route marks HEAD requests, link-preview crawlers and speculative loads `is_prefetch`
 * (`links.ts`), and Meta's own crawler fetches a link the moment it is sent, so a prefetch is not interest and is not a reason to hold the nudge.
 */
import { answersWithSales, type SalesSettings } from './mode.js';
import type { Stage } from './types.js';

// ─── The delay: an operator setting ──────────────────────────────────────────────────────────

/** Four hours: the owner's choice (plan §14.5), and what an unset or unreadable setting means. */
export const FOLLOWUP_MINUTES_DEFAULT = 240;
/** `0` switches follow-ups off. */
export const FOLLOWUP_MINUTES_MIN = 0;
/** 22 hours: later than that, the nudge could never fall inside the 23 hour rule below, whenever the person last wrote. */
export const FOLLOWUP_MINUTES_MAX = 22 * 60;

const WHOLE_MINUTES = /^\d{1,4}$/;

/** A saved or typed number of minutes (a whole number, 0 to 1320), or null when it is anything else. */
export function parseFollowupMinutes(raw: unknown): number | null {
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (!WHOLE_MINUTES.test(text)) return null;
    const minutes = Number(text);
    return minutes >= FOLLOWUP_MINUTES_MIN && minutes <= FOLLOWUP_MINUTES_MAX ? minutes : null;
}

/**
 * The request's number of minutes, as the settings route reads it: a whole number in range is that number, and empty or null is `null` (clear the
 * setting, so the default answers again). Anything else is an error that names the range: a typo must not quietly save a different delay.
 */
export function followupMinutesInput(input: unknown): { minutes: number | null } | { error: string } {
    if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) return { minutes: null };
    const minutes = parseFollowupMinutes(input);
    if (minutes === null) return { error: `The follow-up delay must be a whole number of minutes, ${FOLLOWUP_MINUTES_MIN} to ${FOLLOWUP_MINUTES_MAX} (0 turns follow-ups off).` };
    return { minutes };
}

// ─── The rules ───────────────────────────────────────────────────────────────────────────────

/** One nudge per conversation, ever (the owner's decision). The plan's §7 allowed two; the stricter of the two holds. */
export const MAX_FOLLOWUPS_PER_CONVERSATION = 1;

/** Meta's window is 24 hours from the person's last message; a nudge is never sent after 23 (plan §2). */
export const FOLLOWUP_WINDOW_MS = 23 * 60 * 60 * 1000;

/** When the nudge for a link sent at `linkAt` is due. */
export function followupRunAfter(linkAt: Date, minutes: number): Date {
    return new Date(linkAt.getTime() + minutes * 60_000);
}

/**
 * One job per link SENT: the conversation and the message that carried it (plan §7). A second enqueue with this key is dropped by the queue
 * whatever the state of the first, which is what makes a retried turn or a re-run of the recording unable to schedule a second nudge.
 */
export function followupDedupeKey(conversationId: string, linkMessageId: string): string {
    return `dm-followup:${conversationId}:${linkMessageId}`;
}

/** What the nudge needs to know about the conversation, read when it comes due. */
export interface FollowupState {
    stage: Stage;
    /** The person's id on the platform (an IGSID, or a Messenger PSID): what `sales_test_senders` lists. */
    senderId: string;
    /** `conversations.is_bot_active`: false is "AI paused" (a hand-off, an opt-out, the owner took over, a loop). */
    botActive: boolean;
    /** The owner's AI agent is switched on. A switched-off agent says nothing, a nudge included. */
    agentActive: boolean;
    followupsSent: number;
    /** When the latest link went. */
    lastLinkAt: Date | null;
    /** When the person last wrote: the later of `conversations.last_inbound_at` and their newest message. The 24 hour window starts here. */
    lastInboundAt: Date | null;
    optedOutAt: Date | null;
    handoffAt: Date | null;
}

/** One visit to one of the conversation's tracked links. */
export interface LinkClickFact {
    clickedAt: Date;
    /** Not a person: a HEAD request, a preview crawler, a speculative load. Never a reason to hold the nudge. */
    isPrefetch: boolean;
}

/** What is true of the nudge itself, not of the conversation. */
export interface FollowupRules {
    /** The tenant's `sales_mode` and test senders, read now. */
    sales: SalesSettings;
    /** When the link this job was scheduled for went out (the job's own payload). */
    linkAt: Date;
    /** The operator's delay as it is now; 0 is "follow-ups are off". */
    delayMinutes: number;
}

export const FOLLOWUP_REASONS = [
    'ok',
    'sales_off',          // sales mode is off for the tenant
    'sender_not_allowed', // sales mode is test, and this person is not a listed test sender
    'disabled',           // the operator set the delay to 0
    'agent_off',          // the owner's agent is switched off
    'opted_out',          // they asked to be left alone
    'handoff',            // a person has been asked to take over
    'paused',             // the AI is paused for this conversation
    'already_nudged',     // the one nudge this conversation gets has gone
    'stage',              // the conversation is no longer at the link (closed, objecting, recommended again...)
    'no_link',            // no link on record: nothing to follow up
    'newer_link',         // a later link was sent: the job for that one is the one that counts
    'no_inbound',         // no message from the person on record: the window cannot be shown to be open
    'replied',            // they wrote since the link
    'clicked',            // a person opened the link
    'window_expired',     // 23 hours or more since their last message
] as const;
export type FollowupReason = (typeof FOLLOWUP_REASONS)[number];

export interface FollowupVerdict {
    send: boolean;
    reason: FollowupReason;
}

/**
 * May the nudge go out now? `{ send: true, reason: 'ok' }`, or `{ send: false, reason }` for the FIRST rule that stops it. The order is the
 * order of what matters: who may be sold to at all, what the person asked for, whether the nudge has gone, whether they are already engaged, and
 * last the clock. Pure.
 *
 * `clicks` are the visits to the conversation's tracked links, preview fetches included: only a person's visit (`isPrefetch` false) stops the
 * nudge. Any of the conversation's links counts, not only the one this job is for: someone who opened a link we sent is not chased about it.
 */
export function followupEligible(state: FollowupState, now: Date, clicks: readonly LinkClickFact[], rules: FollowupRules): FollowupVerdict {
    const no = (reason: FollowupReason): FollowupVerdict => ({ send: false, reason });

    if (rules.sales.mode === 'off') return no('sales_off');
    if (!answersWithSales(rules.sales, state.senderId)) return no('sender_not_allowed');
    if (!(rules.delayMinutes > 0)) return no('disabled');
    if (!state.agentActive) return no('agent_off');

    if (state.optedOutAt !== null) return no('opted_out');
    if (state.handoffAt !== null || state.stage === 'handoff') return no('handoff');
    if (!state.botActive) return no('paused');

    if (state.followupsSent >= MAX_FOLLOWUPS_PER_CONVERSATION) return no('already_nudged');
    if (state.stage !== 'link') return no('stage');
    if (state.lastLinkAt === null) return no('no_link');
    if (state.lastLinkAt.getTime() > rules.linkAt.getTime()) return no('newer_link');

    if (state.lastInboundAt === null) return no('no_inbound');
    if (state.lastInboundAt.getTime() > state.lastLinkAt.getTime()) return no('replied');
    if (clicks.some((click) => !click.isPrefetch)) return no('clicked');

    if (now.getTime() >= state.lastInboundAt.getTime() + FOLLOWUP_WINDOW_MS) return no('window_expired');
    return { send: true, reason: 'ok' };
}
