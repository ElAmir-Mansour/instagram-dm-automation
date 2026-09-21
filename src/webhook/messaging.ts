/**
 * The DM pipeline: `entry.messaging` → Gemini → Meta Send API.
 *
 * Previously ~180 lines inline in the webhook handler, sharing one try/catch with the comment
 * pipeline — so a duplicate-key error here aborted the comment events queued behind it.
 */
import { queryCount, queryOne } from '../db/query.js';
import type { ConversationRow, MessageRow } from '../db/rows.js';
import { generateAiResponse } from '../services/ai.js';
import { sendDirectMessage } from '../services/instagram.js';
import { getCreatorByPageId, type Creator } from '../services/tenant.js';
import { checkSendQuota } from '../utils/rateLimiter.js';
import { toMetaMessage, applyDisclosure, type MetaMessagePayload } from './meta-payload.js';
import { describeError, log, withLogContext } from '../utils/log.js';

/**
 * Meta asks for a fresh disclosure "after a significant lapse of time". The policy never
 * quantifies it; a week is long enough that the thread reads as a new conversation to the
 * person on the other end.
 */
const DISCLOSURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface NormalizedDm {
    senderId: string;
    text: string;
    payload: string;
    isStoryMention: boolean;
    /** Meta's message id — the idempotency key. Null for events that carry none. */
    metaMessageId: string | null;
}

/**
 * Flatten the three shapes a messaging event arrives in (plain message, quick reply,
 * postback) into one. Returns null for events with nothing to reply to.
 */
function normalizeDm(event: any): NormalizedDm | null {
    const senderId = event?.sender?.id;

    let text: string = event?.message?.text || '';
    let payload = '';

    if (event?.message?.quick_reply) {
        payload = event.message.quick_reply.payload || '';
        log('debug', 'dm.quick_reply', { payload });
    }

    if (event?.postback) {
        text = event.postback.title || '';
        payload = event.postback.payload || '';
        log('debug', 'dm.postback', { payload });
    }

    let isStoryMention = false;
    if (Array.isArray(event?.message?.attachments)) {
        const storyMention = event.message.attachments.find((att: any) => att.type === 'story_mention');
        if (storyMention) {
            isStoryMention = true;
            log('debug', 'dm.story_mention', { sender_id: senderId });
        }
    }

    if (!senderId || (!text && !payload && !isStoryMention)) {
        log('debug', 'dm.skipped_empty');
        return null;
    }

    return {
        senderId,
        text,
        payload,
        isStoryMention,
        metaMessageId: event?.message?.mid ?? event?.postback?.mid ?? null,
    };
}

/**
 * Which endpoint the Send API call has to use.
 *
 * Meta requires `/{page-id}/messages` for Page access tokens; `/me/messages` only resolves
 * correctly for Instagram-Login tokens. The comment path has always threaded the Facebook
 * Page id through — the DM path never did, so every Facebook Messenger reply went to `/me`.
 * There is no `field === 'feed'` marker on a messaging event, so the signal is the page id
 * the event is addressed to.
 */
function resolveDmPageId(creator: Creator, addressedTo: (string | undefined)[]): string | undefined {
    if (!creator.facebook_page_id) return undefined;
    return addressedTo.some((id) => id && id === creator.facebook_page_id)
        ? creator.facebook_page_id
        : undefined;
}

function needsDisclosure(disclosedAt: string | Date | null | undefined): boolean {
    if (!disclosedAt) return true;
    const at = disclosedAt instanceof Date ? disclosedAt.getTime() : Date.parse(disclosedAt);
    if (Number.isNaN(at)) return true;
    return Date.now() - at > DISCLOSURE_MAX_AGE_MS;
}

export async function handleMessagingEvent(event: any, entryId: string): Promise<void> {
    const recipientId = event?.recipient?.id;

    // Ignore echo messages (sent by the page itself)
    if (event?.message?.is_echo) {
        log('debug', 'dm.skipped_echo');
        return;
    }

    const dm = normalizeDm(event);
    if (!dm) return;

    // The Meta message id is the idempotency key, so it is the field to correlate on: every
    // line below belongs to this one inbound message, retries included.
    return withLogContext({ mid: dm.metaMessageId, sender_id: dm.senderId }, () =>
        processDm(dm, event, recipientId, entryId)
    );
}

async function processDm(
    dm: NormalizedDm,
    event: any,
    recipientId: string | undefined,
    entryId: string
): Promise<void> {
    log('info', 'dm.received', { is_story_mention: dm.isStoryMention, has_payload: Boolean(dm.payload) });

    // recipientId from message events = Instagram Business Account ID (most reliable)
    // entryId = could be IG ID (app-level sub) or FB Page ID (page-level sub)
    const creator = await getCreatorByPageId(recipientId, entryId);
    if (!creator) {
        log('warn', 'dm.no_creator', { recipient_id: recipientId, entry_id: entryId });
        return;
    }

    // 1. Fetch or create the conversation thread.
    //    One statement, not SELECT-then-INSERT: two DMs a second apart raced on the
    //    unique_creator_user constraint and the loser's duplicate-key error killed the batch.
    //    The DO UPDATE also replaces the separate last_message_at write.
    const conversation = await queryOne<Pick<ConversationRow, 'id' | 'is_bot_active' | 'ai_disclosed_at'>>(
        `INSERT INTO conversations (creator_id, instagram_user_id, status)
         VALUES ($1, $2, 'active')
         ON CONFLICT (creator_id, instagram_user_id)
         DO UPDATE SET last_message_at = NOW()
         RETURNING id, is_bot_active, ai_disclosed_at`,
        [creator.id, dm.senderId]
    );

    if (!conversation) {
        // An upsert with DO UPDATE always returns its row, so no row means the statement did
        // not do what this code assumes. Previously this read `convRes.rows[0].id` and threw
        // a TypeError three lines later, from a place that said nothing about the cause.
        log('error', 'dm.conversation_upsert_empty', { creator_id: creator.id });
        return;
    }
    const conversationId: string = conversation.id;

    // 2. Log the inbound message — and claim it.
    //    `meta_message_id` is UNIQUE, so a Meta redelivery inserts nothing and returns no row.
    //    This gate has to sit before Gemini: without it every retry re-ran a paid model call,
    //    re-sent a DM to a real person, and left duplicate inbound rows poisoning the
    //    15-message history ai.ts reads back.
    const claim = await queryOne<Pick<MessageRow, 'id'>>(
        `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, payload, raw_payload, meta_message_id)
         VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7)
         ON CONFLICT (meta_message_id) WHERE meta_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
            conversationId,
            creator.id,
            dm.isStoryMention ? 'story_mention' : 'text',
            dm.text || (dm.isStoryMention ? '[Story Mention]' : ''),
            dm.payload || null,
            JSON.stringify(event),
            dm.metaMessageId,
        ]
    );

    if (!claim) {
        // The gate that stops a Meta redelivery re-running a paid Gemini call and re-sending
        // a DM to a real person.
        log('info', 'dm.duplicate_ignored');
        return;
    }

    // 3. Call AI Agent to reply if Bot is active
    if (!conversation.is_bot_active) {
        log('info', 'dm.bot_paused', { conversation_id: conversationId });
        return;
    }

    try {
        // Query Gemini. Timed, because this is both the dominant marginal cost of the product
        // and the reason the webhook cannot finish inside Meta's timeout.
        const startedAt = Date.now();
        const aiRes = await generateAiResponse(conversationId, dm.text || dm.payload, creator.id);
        log('info', 'ai.replied', {
            creator_id: creator.id,
            duration_ms: Date.now() - startedAt,
            message_type: aiRes?.message_type ?? null,
        });

        // null means the creator's AI agent is switched off — a deliberate "say nothing",
        // not a failure. Every real failure throws, so there is nothing to paper over here.
        if (!aiRes) {
            log('info', 'ai.agent_disabled', { creator_id: creator.id });
            return;
        }

        // Format Meta payload
        let metaMessagePayload: MetaMessagePayload = toMetaMessage(aiRes);

        // One quota check per reply, not per network call: a disclosure that has to travel as
        // its own message is still one logical reply to one person.
        const quota = await checkSendQuota(creator.id, 'dm');
        if (!quota.allowed) {
            // Meta throttles automated sends at roughly 200/hr; blowing through it risks the
            // app. Real customers are going unanswered, so this is alert-worthy.
            log('error', 'dm.quota_exhausted', {
                creator_id: creator.id, count: quota.count, limit: quota.limit, source: 'dm',
            });
            return;
        }

        const pageId = resolveDmPageId(creator, [recipientId, entryId]);

        // Meta policy: disclose the automated service at the start of a thread, and again
        // after a long gap.
        const discloseNow = needsDisclosure(conversation.ai_disclosed_at);
        if (discloseNow) {
            const disclosure = applyDisclosure(metaMessagePayload);
            metaMessagePayload = disclosure.payload;
            if (disclosure.standalone) {
                log('info', 'dm.disclosure_standalone');
                await sendDirectMessage(
                    dm.senderId,
                    { text: disclosure.standalone },
                    creator.page_access_token,
                    pageId
                );
            }
        }

        // Send DM using Meta Send API
        await sendDirectMessage(dm.senderId, metaMessagePayload, creator.page_access_token, pageId);
        log('info', 'dm.sent', {
            creator_id: creator.id, message_type: aiRes.message_type, disclosed: discloseNow,
        });

        // Recorded only after a successful send, so a failed first reply still discloses next time.
        if (discloseNow) {
            await queryCount('UPDATE conversations SET ai_disclosed_at = NOW() WHERE id = $1', [conversationId]);
        }

        // Log outbound message
        await queryCount(
            `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload)
             VALUES ($1, $2, 'outbound', $3, $4, $5)`,
            [
                conversationId,
                creator.id,
                aiRes.message_type,
                metaMessagePayload.text || '[Structured Template]',
                JSON.stringify(metaMessagePayload),
            ]
        );
    } catch (aiError: any) {
        log('error', 'dm.pipeline_failed', { creator_id: creator.id, ...describeError(aiError) });
    }
}
