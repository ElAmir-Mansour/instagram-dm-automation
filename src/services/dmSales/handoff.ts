/**
 * Human handoff (docs/DM_SALES_PLAN.md §8, S8): when a conversation needs a person, the owner is told.
 *
 * **What a handoff is, and where each part happens.** `flow.ts` decides it (`handoffDecision`, or `loopDecision` for a conversation that
 * will not stop), and `turn.ts` carries it out in ONE statement with the customer's line (`recordTurn`, store.ts):
 *
 *   1. the bot is paused (`is_bot_active = false`, the same per-conversation switch the inbox toggle and a manual reply use),
 *   2. `stage = 'handoff'`, `handoff_at` and `handoff_reason` are written,
 *   3. the customer is sent the profile's own handoff line (`dm.handoff.message`) or the kit's: never the model's words.
 *
 * Those three are written together with the reply, after the send, so a failed send leaves the conversation as it was and the retry
 * answers again. They stay there. This module is the fourth part, which has to happen AFTER them and must never undo them:
 *
 *   4. the owner is told: which person, why, the last thing they wrote, the time Meta's window has left, and a link to the thread.
 *
 * **Notifications are best effort.** `notifyOwner` never throws and never blocks: it runs after the customer has been answered and the
 * state is recorded, a failure is logged (with a scrubbed reason: see `notify.ts`) and costs the customer nothing. The inbox flag
 * ("Needs you") and the dashboard badge do not depend on it.
 *
 * **Hot leads** are a different alert for a different moment: the reply that SENT the link, to a person whose intent was to buy (or to
 * learn what buying costs, or whether it fits them). They are for the owner to follow up personally, they do not pause the bot, and
 * they are switched off on their own (`notify.telegram_hot_leads`).
 *
 * **Alerts are the platform owner's.** The chat is configured once, for the deployment (`app_settings`). Until a tenant can have a
 * channel of its own, a customer of any other tenant is never sent to it: that tenant gets the inbox flag and the badge only.
 *
 * **Rate limited per conversation**, in Postgres (`rate_limit_counters`, the same table the send quotas use), so the number holds
 * across serverless instances: at most 3 handoff alerts and 1 hot-lead alert for one conversation in an hour.
 */
import { queryOne } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import { checkSendQuota } from '../../utils/rateLimiter.js';
import { getPublicBaseUrl } from '../appSettings.js';
import {
    buildNoticeText, inboxLink, readTelegramSettings, sendTelegramMessage, telegramReady, windowRemainingMs, type NoticeKind, type NoticeLang,
} from '../notify.js';
import { getPlatformOwnerId } from '../tenant.js';
import type { TurnDecision } from './flow.js';
import type { HandoffReason, Intent } from './types.js';

/**
 * The intents of a person who is worth a personal word once they have the link: they said they want it, or asked what it costs, or
 * whether it suits them. An objection, small talk or a question about something else is not.
 */
export const HOT_INTENTS: ReadonlySet<Intent> = new Set<Intent>(['ready_to_buy', 'price', 'level_fit']);

/** Alerts for one conversation in one hour (the counter's window is the clock hour). A handoff happens once per resume; the rest is slack. */
export const HANDOFF_ALERTS_PER_HOUR = 3;
export const HOT_LEAD_ALERTS_PER_HOUR = 1;

/**
 * `engine_failed` is a reason for the ALERT only (`failureHandoff.ts`: the reply failed on its last attempt): the conversation records it
 * as `unsure`, the closest value `conversations.handoff_reason` allows, and the owner is told what really happened.
 */
export type NoticePlan =
    | { kind: 'handoff'; reason: HandoffReason | 'engine_failed' }
    | { kind: 'hot_lead' };

/**
 * Does this turn end with an alert, and which? Pure.
 *
 *   handoff   the conversation is now in the `handoff` stage: a handoff, or a conversation that was paused for looping. NOT a second
 *             insult (stage `closed`: the plan's "pause the bot, no handoff ping") and NOT an opt-out on its own.
 *   hot lead  the link was sent in THIS reply (`linkSent`: the server really added one), to a person with a buying intent.
 */
export function noticeFor(decision: Pick<TurnDecision, 'stage' | 'action' | 'handoffReason'>, turn: { intent: Intent | null; linkSent: boolean }): NoticePlan | null {
    if (decision.stage === 'handoff') {
        return { kind: 'handoff', reason: decision.handoffReason === 'none' ? 'unsure' : decision.handoffReason };
    }
    if (decision.stage === 'link' && decision.action === 'send_link' && turn.linkSent && turn.intent !== null && HOT_INTENTS.has(turn.intent)) {
        return { kind: 'hot_lead' };
    }
    return null;
}

/** What `notifyOwner` did, for the log and the tests. */
export type NoticeOutcome =
    | 'sent'
    | 'off'              // alerts are not switched on, or the token or the chat id is missing
    | 'hot_leads_off'    // alerts are on, hot leads are not
    | 'not_owner'        // another tenant's conversation: its owner has no channel yet
    | 'rate_limited'     // this conversation has had its alerts for the hour
    | 'failed'           // Telegram said no, or did not answer
    | 'error';           // something on our side threw: logged, and costs nothing

export interface NoticeRequest {
    creatorId: string;
    conversationId: string;
    plan: NoticePlan;
    /** The language of the DM surface (`ctx.language.code`): Arabic gets the Arabic alert, anything else the English one. */
    language: string;
    /** The clock, for the window countdown. Tests only. */
    now?: Date;
}

interface ConversationFacts {
    username: string | null;
    instagram_user_id: string;
    last_inbound_text: string | null;
    last_inbound_at: Date | string | null;
}

/** The alert's language: the profile's own when it is Arabic, English otherwise. */
export const noticeLang = (code: string): NoticeLang => (code === 'ar' ? 'ar' : 'en');

/**
 * Tell the owner. NEVER throws, whatever fails: see the top of the file. Order of the checks is cheapest first and the one that spends
 * the conversation's hourly allowance last, so a turn that cannot alert (alerts off, someone else's tenant) spends nothing.
 */
export async function notifyOwner(req: NoticeRequest): Promise<NoticeOutcome> {
    const plan = req.plan;
    if (!plan) return 'off';
    const logBase = { conversation_id: req.conversationId, kind: plan.kind, reason: plan.kind === 'handoff' ? plan.reason : 'hot_lead' };
    try {
        const settings = await readTelegramSettings();
        if (!telegramReady(settings)) return 'off';
        if (plan.kind === 'hot_lead' && !settings.hotLeads) return 'hot_leads_off';

        if (req.creatorId !== (await getPlatformOwnerId())) {
            log('debug', 'dm.handoff_notify_skipped', { ...logBase, why: 'not_owner_tenant' });
            return 'not_owner';
        }

        // The allowance is spent before the send, so two turns racing for one conversation cannot both go out. A limiter that cannot be
        // read lets the alert through (a missed handoff is worse than a repeated one), and says so.
        const bucket = plan.kind === 'handoff' ? `notify:${req.conversationId}` : `notify_hot:${req.conversationId}`;
        const limit = plan.kind === 'handoff' ? HANDOFF_ALERTS_PER_HOUR : HOT_LEAD_ALERTS_PER_HOUR;
        try {
            const quota = await checkSendQuota(req.creatorId, bucket, limit);
            if (!quota.allowed) {
                log('info', 'dm.handoff_notify_rate_limited', { ...logBase, count: quota.count, limit });
                return 'rate_limited';
            }
        } catch (err) {
            log('warn', 'dm.handoff_notify_limiter_failed', { ...logBase, ...describeError(err) });
        }

        const facts = await queryOne<ConversationFacts>(
            `SELECT c.username, c.instagram_user_id,
                    (SELECT text FROM messages WHERE conversation_id = c.id AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1) AS last_inbound_text,
                    (SELECT created_at FROM messages WHERE conversation_id = c.id AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1) AS last_inbound_at
               FROM conversations c
              WHERE c.id = $1 AND c.creator_id = $2`,
            [req.conversationId, req.creatorId]
        );
        if (!facts) {
            log('warn', 'dm.handoff_notify_no_conversation', logBase);
            return 'error';
        }

        const kind: NoticeKind = plan.kind;
        const text = buildNoticeText({
            kind,
            reason: plan.kind === 'handoff' ? plan.reason : 'hot_lead',
            lang: noticeLang(req.language),
            username: facts.username,
            senderId: facts.instagram_user_id,
            lastMessage: facts.last_inbound_text ?? '',
            windowMs: windowRemainingMs(facts.last_inbound_at, req.now ?? new Date()),
            link: inboxLink(await getPublicBaseUrl(null), req.conversationId),
        });

        const result = await sendTelegramMessage({ token: settings.token, chatId: settings.chatId }, text);
        if (!result.ok) {
            // `description` has been scrubbed of the token (notify.ts); nothing else of the request is logged.
            log('warn', 'dm.handoff_notify_failed', { ...logBase, outcome: result.reason, status: result.status, description: result.description });
            return 'failed';
        }
        log('info', 'dm.handoff_notified', logBase);
        return 'sent';
    } catch (err) {
        log('warn', 'dm.handoff_notify_error', { ...logBase, ...describeError(err) });
        return 'error';
    }
}
