/**
 * The DM pipeline: `entry.messaging` → Gemini → Meta Send API.
 *
 * Previously ~180 lines inline in the webhook handler, sharing one try/catch with the comment
 * pipeline — so a duplicate-key error here aborted the comment events queued behind it.
 */
import { pool } from '../config/db.js';
import { generateAiResponse } from '../services/ai.js';
import { sendDirectMessage } from '../services/instagram.js';
import { getCreatorByPageId, type Creator } from '../services/tenant.js';
import { checkSendQuota } from '../utils/rateLimiter.js';
import { toMetaMessage, applyDisclosure, type MetaMessagePayload } from './meta-payload.js';

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
        console.log(`💬 User clicked Quick Reply button: text="${text}", payload="${payload}"`);
    }

    if (event?.postback) {
        text = event.postback.title || '';
        payload = event.postback.payload || '';
        console.log(`🎯 User clicked Postback button: title="${text}", payload="${payload}"`);
    }

    let isStoryMention = false;
    if (Array.isArray(event?.message?.attachments)) {
        const storyMention = event.message.attachments.find((att: any) => att.type === 'story_mention');
        if (storyMention) {
            isStoryMention = true;
            console.log(`📖 Received a Story Mention from sender: ${senderId}`);
        }
    }

    if (!senderId || (!text && !payload && !isStoryMention)) {
        console.log('⏭️  Skipping empty message/postback event.');
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
        console.log('⏭️  Ignoring echo message sent by the Page.');
        return;
    }

    const dm = normalizeDm(event);
    if (!dm) return;

    console.log(
        `📨 Incoming DM from IGSID ${dm.senderId} → recipient ${recipientId}: "${dm.text}" (payload: ${dm.payload})`
    );

    // recipientId from message events = Instagram Business Account ID (most reliable)
    // entryId = could be IG ID (app-level sub) or FB Page ID (page-level sub)
    const creator = await getCreatorByPageId(recipientId, entryId);
    if (!creator) {
        console.log(`⚠️  No creator found for recipientId=${recipientId} or entryId=${entryId}. Skipping.`);
        return;
    }
    console.log(`✅ Creator found: ${creator.id}`);

    // 1. Fetch or create the conversation thread.
    //    One statement, not SELECT-then-INSERT: two DMs a second apart raced on the
    //    unique_creator_user constraint and the loser's duplicate-key error killed the batch.
    //    The DO UPDATE also replaces the separate last_message_at write.
    const convRes = await pool.query(
        `INSERT INTO conversations (creator_id, instagram_user_id, status)
         VALUES ($1, $2, 'active')
         ON CONFLICT (creator_id, instagram_user_id)
         DO UPDATE SET last_message_at = NOW()
         RETURNING id, is_bot_active, ai_disclosed_at`,
        [creator.id, dm.senderId]
    );

    const conversation = convRes.rows[0];
    const conversationId: string = conversation.id;

    // 2. Log the inbound message — and claim it.
    //    `meta_message_id` is UNIQUE, so a Meta redelivery inserts nothing and returns no row.
    //    This gate has to sit before Gemini: without it every retry re-ran a paid model call,
    //    re-sent a DM to a real person, and left duplicate inbound rows poisoning the
    //    15-message history ai.ts reads back.
    const claim = await pool.query(
        `INSERT INTO messages (conversation_id, direction, message_type, text, payload, raw_payload, meta_message_id)
         VALUES ($1, 'inbound', $2, $3, $4, $5, $6)
         ON CONFLICT (meta_message_id) WHERE meta_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
            conversationId,
            dm.isStoryMention ? 'story_mention' : 'text',
            dm.text || (dm.isStoryMention ? '[Story Mention]' : ''),
            dm.payload || null,
            JSON.stringify(event),
            dm.metaMessageId,
        ]
    );

    if (claim.rows.length === 0) {
        console.log(`⏭️  Duplicate messaging event ignored (mid: ${dm.metaMessageId})`);
        return;
    }

    // 3. Call AI Agent to reply if Bot is active
    if (!conversation.is_bot_active) {
        console.log('⏭️  AI Bot is paused for this conversation thread. Manual reply required.');
        return;
    }

    try {
        // Query Gemini
        console.log('🤖 Invoking Gemini to construct response...');
        const aiRes = await generateAiResponse(conversationId, dm.text || dm.payload, creator.id);

        // null means the creator's AI agent is switched off — a deliberate "say nothing",
        // not a failure. Every real failure throws, so there is nothing to paper over here.
        if (!aiRes) {
            console.log('⏭️  AI agent is switched off for this creator — no reply sent.');
            return;
        }
        console.log('🤖 Gemini Response Type:', aiRes.message_type);

        // Format Meta payload
        let metaMessagePayload: MetaMessagePayload = toMetaMessage(aiRes);

        // One quota check per reply, not per network call: a disclosure that has to travel as
        // its own message is still one logical reply to one person.
        const quota = await checkSendQuota(creator.id, 'dm');
        if (!quota.allowed) {
            console.error(
                `🛑 Hourly DM quota reached (${quota.count}/${quota.limit}) — skipping reply to ${dm.senderId}. ` +
                'Meta throttles automated sends at roughly 200/hr; blowing through it risks the app.'
            );
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
                console.log('ℹ️  Sending AI disclosure as its own message (template payload has no text field).');
                await sendDirectMessage(
                    dm.senderId,
                    { text: disclosure.standalone },
                    creator.page_access_token,
                    pageId
                );
            }
        }

        // Send DM using Meta Send API
        console.log(`📩 Sending Meta response of type: ${aiRes.message_type}`);
        await sendDirectMessage(dm.senderId, metaMessagePayload, creator.page_access_token, pageId);

        // Recorded only after a successful send, so a failed first reply still discloses next time.
        if (discloseNow) {
            await pool.query('UPDATE conversations SET ai_disclosed_at = NOW() WHERE id = $1', [conversationId]);
        }

        // Log outbound message
        await pool.query(
            `INSERT INTO messages (conversation_id, direction, message_type, text, raw_payload)
             VALUES ($1, 'outbound', $2, $3, $4)`,
            [
                conversationId,
                aiRes.message_type,
                metaMessagePayload.text || '[Structured Template]',
                JSON.stringify(metaMessagePayload),
            ]
        );
    } catch (aiError: any) {
        console.error('❌ AI Pipeline / Send Error:', aiError.message);
    }
}
