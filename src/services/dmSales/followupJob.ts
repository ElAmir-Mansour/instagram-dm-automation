/**
 * The follow-up nudge, end to end (docs/DM_SALES_PLAN.md §7, S9): scheduled when a sales DM sends a link, and sent, or not, when it comes due.
 * The rules are `followup.ts`; this is the part that reads the database and talks to Meta.
 *
 *   scheduleFollowup   called by the sales turn right after it recorded a reply that carried a link. One `dm.followup` job per link SENT, due
 *                      `dm.sales.followup_minutes` later, deduped on the conversation and the message that held the link.
 *   runFollowup        the job's handler. It reads the conversation as it is NOW, asks `followupEligible`, and only then sends the kit's nudge line.
 *
 * **A reply cancels nothing, and needs nothing cancelled.** Nobody writes to the job when the person answers, clicks or says stop. The job
 * runs anyway, finds the conversation changed and ends as done without a send: the check at run time is the cancellation. That is also what
 * makes the job safe against every way the world can move in the hours between the link and the nudge (an owner who paused the bot or flipped
 * `sales_mode` off, a hand-off, a newer link), none of which has to know a job exists.
 *
 * **At most once.** The nudge's right to go out is claimed with ONE conditional UPDATE (`followups_sent` + 1, stage `follow_up`) BEFORE anything is
 * sent, and the update repeats the rules that matter (the bot active, no opt-out, no hand-off, still at the link, no message from the person since).
 * A retry, a reaped claim or two drains at once therefore cannot send it twice: the second finds the claim taken. A send that fails releases the claim
 * (and is retried by the runner unless Meta's answer is final); a crash between the claim and the send loses the nudge, which is the right way round for a
 * message nobody asked for.
 *
 * Never a model, never a link: the nudge is the kit's line, so there is nothing to guard and no new URL to send.
 */
import { queryCount, queryOne, queryRows } from '../../db/query.js';
import type { ConversationEntrySource } from '../../db/rows.js';
import { getJobQueue } from '../../jobs/queue.js';
import type { JobPayloads } from '../../jobs/types.js';
import { describeError, log } from '../../utils/log.js';
import { checkFairSendQuota } from '../../utils/rateLimiter.js';
import { APP_SETTING_KEYS, getSetting } from '../appSettings.js';
import { adPlatformOf, isBusinessAiBlock, isWindowRefusal, noteBusinessAiBlock, noteWindowRefusal } from '../ads/attribution.js';
import { readExtendedWindow } from '../ads/switches.js';
import { isPermanentMetaError, metaErrorCode } from '../http.js';
import { sendDirectMessage } from '../instagram.js';
import { profileContextOrLegacy } from '../profile/context.js';
import { kitFor } from '../profile/kits.js';
import { getTenant } from '../tenant.js';
import { noteMetaFailure } from '../tokenHealth.js';
import {
    FOLLOWUP_MINUTES_DEFAULT, MAX_FOLLOWUPS_PER_CONVERSATION, followupDedupeKey, followupEligible, followupRunAfter, parseFollowupMinutes,
    type FollowupReason, type FollowupState, type LinkClickFact,
} from './followup.js';
import { readSalesSettings } from './mode.js';
import type { RecordedTurn } from './store.js';
import { STAGES, type Stage } from './types.js';

// ─── The operator's delay ────────────────────────────────────────────────────────────────────

/**
 * Minutes between a link and its nudge: the saved `dm.sales.followup_minutes` (0 to 1320), else four hours. A value that is saved but unreadable is
 * logged and answers with the default, never with "off": a typo must not silently end the follow-ups, nor stretch them. A database that cannot be
 * read throws, and the caller decides (the turn does not schedule; the job is retried).
 */
export async function getFollowupMinutes(): Promise<number> {
    const raw = await getSetting(APP_SETTING_KEYS.dmSalesFollowupMinutes);
    if (raw === null) return FOLLOWUP_MINUTES_DEFAULT;
    const minutes = parseFollowupMinutes(raw);
    if (minutes === null) {
        log('warn', 'dm.followup_minutes_unreadable', { setting: APP_SETTING_KEYS.dmSalesFollowupMinutes, saved: raw.slice(0, 20) });
        return FOLLOWUP_MINUTES_DEFAULT;
    }
    return minutes;
}

// ─── Scheduling: called by the sales turn ────────────────────────────────────────────────────

export interface FollowupSchedule {
    creatorId: string;
    conversationId: string;
    /** The person the link went to, and what the nudge will be sent to. */
    senderId: string;
    /** The Facebook Page id when it is a Messenger conversation; undefined for Instagram. */
    pageId: string | undefined;
    /** The offer whose link was sent. */
    offerId: string;
    /** What the recording statement said about the reply that carried the link. */
    recorded: RecordedTurn;
    /**
     * The channel, for a conversation that is not Instagram or Messenger. WhatsApp's is refused: a nudge is a free-form message hours later, which the 24 hour
     * window may no longer allow, and there is no consent or template layer yet to send one outside it (docs/specs/001-whatsapp-agent, out of W5's scope).
     * Absent for Instagram and Messenger, whose job is exactly what it was.
     */
    channel?: 'whatsapp';
}

export type ScheduleOutcome = 'scheduled' | 'deduped' | 'disabled' | 'unrecorded' | 'unsupported_channel' | 'failed';

/**
 * Queue the nudge for a link that was just sent. Best effort, and made to be called after the DM went out: it NEVER throws, because a failure here
 * must not turn into a retry of a turn that already answered the person (a duplicate reply is far worse than a missing nudge). The sales turn
 * only reaches it for a sender the sales mode answers, so `sales_mode = 'off'` (and a test sender who is not listed) never queues anything.
 */
export async function scheduleFollowup(input: FollowupSchedule): Promise<ScheduleOutcome> {
    const { creatorId, conversationId, offerId } = input;
    const { linkAt, replyId } = input.recorded;
    const logBase = { creator_id: creatorId, conversation_id: conversationId, offer_id: offerId };
    if (input.channel === 'whatsapp') {
        log('info', 'dm.followup_not_scheduled', { ...logBase, reason: 'channel', channel: input.channel });
        return 'unsupported_channel';
    }
    if (!linkAt || !replyId) {
        // The recording statement matched no conversation (or a database without the row): there is no link on record to follow up.
        log('warn', 'dm.followup_not_scheduled', { ...logBase, reason: 'link_not_recorded' });
        return 'unrecorded';
    }
    try {
        const minutes = await getFollowupMinutes();
        if (minutes <= 0) {
            log('debug', 'dm.followup_not_scheduled', { ...logBase, reason: 'disabled' });
            return 'disabled';
        }
        const payload: JobPayloads['dm.followup'] = {
            conversationId, creatorId, senderId: input.senderId, offerId, linkMessageId: replyId, linkAt: linkAt.toISOString(),
            ...(input.pageId ? { pageId: input.pageId } : {}),
        };
        const runAfter = followupRunAfter(linkAt, minutes);
        const jobId = await getJobQueue().enqueue({
            kind: 'dm.followup', payload, creatorId, dedupeKey: followupDedupeKey(conversationId, replyId), runAfter,
        });
        log('info', jobId ? 'dm.followup_scheduled' : 'dm.followup_deduped', { ...logBase, job_id: jobId, run_after: runAfter.toISOString(), minutes });
        return jobId ? 'scheduled' : 'deduped';
    } catch (err) {
        log('warn', 'dm.followup_schedule_failed', { ...logBase, ...describeError(err), effect: 'no nudge will be sent for this link' });
        return 'failed';
    }
}

// ─── Running: the job's handler ──────────────────────────────────────────────────────────────

const isStage = (value: unknown): value is Stage => typeof value === 'string' && (STAGES as readonly string[]).includes(value);

interface FactsRow {
    stage: string | null;
    sender_id: string;
    is_bot_active: boolean;
    last_link_at: Date | null;
    last_inbound_at: Date | null;
    last_inbound_message_at: Date | null;
    followups_sent: number | null;
    opted_out_at: Date | null;
    handoff_at: Date | null;
    agent_active: boolean | null;
    /** v50/v54: how the thread began. `kind: 'ctm'` is a click-to-message ad (its own window, `ads/attribution.ts`). */
    entry_source: ConversationEntrySource | null;
    /** `'instagram'`, `'facebook'` (Messenger) or `'whatsapp'`. */
    platform: string | null;
}

const asDate = (value: Date | string | null | undefined): Date | null => {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * The conversation as the nudge's rules need it, scoped to its tenant; null when it is gone. The person's last message is the LATER of the
 * stamp the sales turn keeps (`last_inbound_at`) and their newest stored message: either may be the only one there is, and the later of two true
 * times is never earlier than the truth, which is the direction a 24 hour window must err in.
 */
export async function loadFollowupState(conversationId: string, creatorId: string): Promise<FollowupState | null> {
    return (await loadFollowupConversation(conversationId, creatorId))?.state ?? null;
}

/** `loadFollowupState`, with the conversation's `platform` beside it (the send's ad refusal needs it). Same single statement. */
async function loadFollowupConversation(conversationId: string, creatorId: string): Promise<{ state: FollowupState; platform: string | null } | null> {
    const row = await queryOne<FactsRow & Record<string, unknown>>(
        `SELECT c.stage, c.instagram_user_id AS sender_id, c.is_bot_active, c.last_link_at, c.last_inbound_at,
                (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound') AS last_inbound_message_at,
                c.followups_sent, c.opted_out_at, c.handoff_at,
                COALESCE((SELECT a.is_active FROM ai_agents a WHERE a.creator_id = c.creator_id), FALSE) AS agent_active,
                c.entry_source, c.platform
           FROM conversations c
          WHERE c.id = $1 AND c.creator_id = $2`,
        [conversationId, creatorId]
    );
    if (!row) return null;
    const stamped = asDate(row.last_inbound_at);
    const stored = asDate(row.last_inbound_message_at);
    const entry = row.entry_source;
    const state: FollowupState = {
        stage: isStage(row.stage) ? row.stage : 'new',
        senderId: row.sender_id,
        botActive: row.is_bot_active === true,
        agentActive: row.agent_active === true,
        followupsSent: Number(row.followups_sent ?? 0),
        lastLinkAt: asDate(row.last_link_at),
        lastInboundAt: stamped && stored ? (stamped.getTime() >= stored.getTime() ? stamped : stored) : stamped ?? stored,
        optedOutAt: asDate(row.opted_out_at),
        handoffAt: asDate(row.handoff_at),
        // Only an ad conversation's source matters to the rules; any other is left off, so the state is what it was for a conversation without one.
        ...(entry && typeof entry === 'object' && entry.kind === 'ctm' ? { entrySource: { kind: entry.kind, platform: entry.platform, at: entry.at } } : {}),
    };
    return { state, platform: typeof row.platform === 'string' ? row.platform : null };
}

/**
 * The visits to every tracked link of this conversation, a person's first: the list is capped, and the order puts a real click ahead of the
 * preview fetches, so a link a crawler hit fifty times can never hide one person's tap behind them.
 */
export async function loadLinkClicks(conversationId: string, creatorId: string): Promise<LinkClickFact[]> {
    const rows = await queryRows<{ clicked_at: Date; is_prefetch: boolean } & Record<string, unknown>>(
        `SELECT lc.clicked_at, lc.is_prefetch
           FROM link_clicks lc
           JOIN tracked_links tl ON tl.code = lc.code
          WHERE tl.conversation_id = $1 AND tl.creator_id = $2
          ORDER BY lc.is_prefetch ASC, lc.clicked_at DESC
          LIMIT 20`,
        [conversationId, creatorId]
    );
    return rows.map((row) => ({ clickedAt: asDate(row.clicked_at) ?? new Date(0), isPrefetch: row.is_prefetch !== false }));
}

/**
 * The claim. ONE conditional UPDATE: it succeeds for exactly one caller, and only while the conversation still says the nudge may go. The
 * conditions repeat the ones that decide the person's own wishes, so a message, a stop or a pause that landed between the read and this
 * statement still wins. Returns whether this caller holds the claim.
 */
async function claimFollowup(conversationId: string, creatorId: string): Promise<boolean> {
    const claimed = await queryCount(
        `UPDATE conversations
            SET followups_sent = followups_sent + 1, stage = 'follow_up'
          WHERE id = $1 AND creator_id = $2
            AND followups_sent < $3
            AND stage = 'link'
            AND is_bot_active
            AND opted_out_at IS NULL
            AND handoff_at IS NULL
            AND last_link_at IS NOT NULL
            AND (last_inbound_at IS NULL OR last_inbound_at <= last_link_at)`,
        [conversationId, creatorId, MAX_FOLLOWUPS_PER_CONVERSATION]
    );
    return claimed > 0;
}

/** Give the claim back after a send that did not happen, unless the conversation has moved on since (then its stage is no longer ours to restore). */
async function releaseFollowup(conversationId: string, creatorId: string): Promise<void> {
    await queryCount(
        `UPDATE conversations
            SET followups_sent = GREATEST(followups_sent - 1, 0), stage = 'link'
          WHERE id = $1 AND creator_id = $2 AND stage = 'follow_up' AND followups_sent > 0`,
        [conversationId, creatorId]
    );
}

/**
 * Meta's answers that retrying cannot change: the permanent codes (a dead token, a missing permission, a recipient who blocked DMs), 100 (the
 * recipient or the request is not valid: a permanent DM failure here, as `dmFallbackReply` treats it, and Meta Business AI's hold on an Instagram thread,
 * 100 / 2534037), 10 (outside the allowed messaging window: the person's last message is older than Meta counts, whatever 23 hours says) and 551
 * ("this person isn't available right now", which an ad thread past its window also answers with).
 */
export function isFinalSendFailure(err: unknown): boolean {
    const code = metaErrorCode(err);
    return isPermanentMetaError(err) || code === 10 || code === 100 || code === 551;
}

export type FollowupOutcome =
    | { kind: 'sent' }
    | { kind: 'skipped'; reason: FollowupReason | 'bad_payload' | 'conversation_gone' | 'not_connected' | 'quota' | 'claim_lost' | 'send_refused' | 'channel' };

export interface RunFollowupOptions {
    /** Injected for tests. */
    now?: () => Date;
}

/**
 * Send the nudge if, and only if, the conversation still allows it. Returns what happened; throws only for a failure the runner should retry
 * (the database, a transient Meta error). Every "no" is a normal return: the job ends as done, and `dm.followup_skipped` says why.
 */
export async function runFollowup(payload: JobPayloads['dm.followup'], options: RunFollowupOptions = {}): Promise<FollowupOutcome> {
    const now = (options.now ?? (() => new Date()))();
    const { conversationId, creatorId } = payload;
    const logBase = { creator_id: creatorId, conversation_id: conversationId, offer_id: payload.offerId, link_message_id: payload.linkMessageId };
    const skip = (reason: Extract<FollowupOutcome, { kind: 'skipped' }>['reason'], extra: Record<string, unknown> = {}): FollowupOutcome => {
        log('info', 'dm.followup_skipped', { ...logBase, reason, ...extra });
        return { kind: 'skipped', reason };
    };

    // A job for WhatsApp is never written (`scheduleFollowup`); one that somehow exists must not send an Instagram message to a WhatsApp user id.
    if (payload.channel === 'whatsapp') return skip('channel');

    const linkAt = new Date(payload.linkAt);
    if (Number.isNaN(linkAt.getTime())) return skip('bad_payload');

    // Everything the decision rests on is read now, not taken from the job: the job is hours old.
    const [loaded, clicks, sales, delayMinutes] = await Promise.all([
        loadFollowupConversation(conversationId, creatorId),
        loadLinkClicks(conversationId, creatorId),
        readSalesSettings(creatorId),
        getFollowupMinutes(),
    ]);
    if (!loaded) return skip('conversation_gone');
    const { state } = loaded;
    // A conversation that began from a click-to-message ad may have a longer window, per platform (`ads.extended_window`). Only that conversation
    // reads the switch: every other one costs no extra statement and is judged on the 23 hour rule, as before.
    const isAd = state.entrySource?.kind === 'ctm';
    const extendedWindow = isAd ? await readExtendedWindow(creatorId) : undefined;

    const verdict = followupEligible(state, now, clicks, { sales, linkAt, delayMinutes, ...(extendedWindow ? { extendedWindow } : {}) });
    if (!verdict.send) return skip(verdict.reason, { stage: state.stage, real_clicks: clicks.filter((c) => !c.isPrefetch).length });

    // The person it goes to, through the tenant's own Meta connection. A tenant that is switched off or has no token sends nothing.
    const creator = await getTenant(creatorId, ['id', 'instagram_page_id', 'facebook_page_id', 'page_access_token', 'is_active']);
    if (!creator || creator.is_active === false || !creator.page_access_token) return skip('not_connected');

    // The wording is the tenant's: its language and register, from its profile (never the owner's by default).
    const ctx = await profileContextOrLegacy(creatorId, 'dm');
    const text = kitFor(ctx.language).sales.lines.nudge;

    // One quota check, as every send makes. A nudge nobody asked for is the first thing to give way when the hour's budget is spent.
    const quota = await checkFairSendQuota(creatorId, 'dm');
    if (!quota.allowed) {
        log('warn', 'dm.quota_exhausted', { ...logBase, count: quota.count, limit: quota.limit, blocked_by: quota.blockedBy, source: 'followup' });
        return skip('quota', { blocked_by: quota.blockedBy });
    }

    if (!(await claimFollowup(conversationId, creatorId))) return skip('claim_lost');

    try {
        await sendDirectMessage(payload.senderId, { text }, creator.page_access_token, payload.pageId);
    } catch (err) {
        // Nothing went out: give the nudge back, so `followups_sent` stays a count of nudges SENT. A failure to give it back must not hide the
        // send's own error from the runner (the claim then stays taken: no nudge, never two).
        try {
            await releaseFollowup(conversationId, creatorId);
        } catch (releaseErr) {
            log('error', 'dm.followup_release_failed', { ...logBase, ...describeError(releaseErr) });
        }
        await noteMetaFailure(creatorId, err);
        // Two refusals that belong to ad traffic. Both stay final (below): Meta's answer will not change, so neither is retried.
        if (isBusinessAiBlock(err)) await noteBusinessAiBlock(creatorId, conversationId);
        if (isAd && isWindowRefusal(err)) {
            const platform = adPlatformOf(loaded.platform) ?? state.entrySource?.platform ?? null;
            if (platform) await noteWindowRefusal(creatorId, platform, conversationId);
        }
        if (isFinalSendFailure(err)) {
            log('error', 'dm.followup_failed', { ...logBase, ...describeError(err), effect: 'not retried: Meta\'s answer will not change' });
            return skip('send_refused');
        }
        log('warn', 'dm.followup_send_failed', { ...logBase, ...describeError(err) });
        throw err;
    }
    log('info', 'dm.sent', { creator_id: creatorId, message_type: 'text', disclosed: false, sales: true, followup: true });

    // The row that shows the nudge in the thread. Its own statement and best effort: the nudge has gone, and the claim already makes a second
    // one impossible, so a failure here costs a bubble in the inbox and must not raise (a retry would find the claim taken and send nothing).
    try {
        await queryCount(
            `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload, sender, ai_meta)
             VALUES ($1, $2, 'outbound', 'text', $3, $4::jsonb, 'ai', $5::jsonb)`,
            [
                conversationId, creatorId, text, JSON.stringify({ text }),
                JSON.stringify({
                    kind: 'followup', engine: 'kit', stage: 'follow_up', next_action: 'reply', offer_id: payload.offerId, link_message_id: payload.linkMessageId,
                    delay_minutes: delayMinutes,
                }),
            ]
        );
    } catch (err) {
        log('error', 'dm.followup_record_failed', { ...logBase, ...describeError(err), effect: 'the nudge was sent; the thread does not show it' });
    }
    log('info', 'dm.followup_sent', { ...logBase, delay_minutes: delayMinutes });
    return { kind: 'sent' };
}
