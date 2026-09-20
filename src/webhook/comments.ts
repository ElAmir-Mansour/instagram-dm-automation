/**
 * The comment pipeline: `entry.changes` → campaign match → private reply (+ public reply).
 *
 * Handles both platforms. Instagram sends `field: 'comments'`; Facebook Pages send
 * `field: 'feed'` with `item: 'comment'`, and the two payloads name nothing the same way.
 */
import { pool } from '../config/db.js';
import { sendPrivateReply, sendPublicReply, sendDirectMessage, likeComment } from '../services/instagram.js';
import { getCreatorByPageId } from '../services/tenant.js';
import { matchCampaign } from '../services/matching.js';
import { checkSendQuota, canDmRecipient, recordDmSent } from '../utils/rateLimiter.js';
import { classifyDmError } from './errors.js';

interface CampaignRow {
    id: string;
    trigger_keyword: string;
    dm_template: string;
    public_reply_template: string | null;
    post_id: string | null;
    is_active: boolean;
    created_at: string;
}

interface NormalizedComment {
    commentId: string;
    postId: string;
    text: string;
    senderUsername: string;
    senderId: string;
    isFacebookComment: boolean;
}

/**
 * Comment ids this process created by replying publicly.
 *
 * Self-comments are normally filtered by comparing `value.from.id` to the stored page id, but
 * on Instagram-Login comment webhooks `from.id` is an app-scoped IGSID that may not equal the
 * business account id we store. If it does not, our own public reply comes back as a webhook
 * with a *new* comment_id — which the interactions ON CONFLICT cannot suppress — and the app
 * can answer itself indefinitely. Remembering what we just posted closes that loop.
 *
 * TODO: verify the IGSID-equals-business-account-id assumption against production logs; if it
 * holds, the pageOwnerId check alone is sufficient and this becomes belt-and-braces.
 *
 * Best effort only: this is per-instance memory, so a cold start between our reply and the
 * echo webhook loses it. The DB-backed fix is a `self_authored` marker on interactions.
 */
const selfAuthoredCommentIds = new Set<string>();
const SELF_AUTHORED_CAP = 500;

function rememberSelfAuthored(commentId: string | undefined): void {
    if (!commentId) return;
    // Bounded: a warm instance handling thousands of comments must not grow this forever.
    if (selfAuthoredCommentIds.size >= SELF_AUTHORED_CAP) {
        const oldest = selfAuthoredCommentIds.values().next().value;
        if (oldest) selfAuthoredCommentIds.delete(oldest);
    }
    selfAuthoredCommentIds.add(commentId);
}

/** Flatten the Instagram and Facebook comment payloads into one shape. */
function normalizeComment(change: any): NormalizedComment | null {
    if (change?.field === 'comments') {
        // Instagram comment webhook: field = 'comments'
        const v = change.value;
        return {
            commentId: v?.id,
            postId: v?.media?.id,
            text: v?.text?.toLowerCase() || '',
            senderUsername: v?.from?.username || v?.from?.id,
            senderId: v?.from?.id,
            isFacebookComment: false,
        };
    }

    if (change?.field === 'feed' && change.value?.item === 'comment' && change.value?.verb === 'add') {
        // Facebook Page comment webhook: field = 'feed', item = 'comment'
        const v = change.value;
        return {
            commentId: v?.comment_id,
            postId: v?.post_id,
            text: v?.message?.toLowerCase() || '',
            senderUsername: v?.from?.name || v?.from?.id,
            senderId: v?.from?.id,
            isFacebookComment: true,
        };
    }

    console.log(`⏭️  Skipping unhandled change field: ${change?.field} (item: ${change?.value?.item})`);
    return null;
}

export async function handleCommentChange(change: any, entryId: string): Promise<void> {
    const comment = normalizeComment(change);
    if (!comment) return;

    const { commentId, postId, text, senderUsername, senderId, isFacebookComment } = comment;

    console.log(`💬 [${isFacebookComment ? 'FB' : 'IG'}] Comment: "${text}" by @${senderUsername} (ID: ${senderId})`);

    if (commentId && selfAuthoredCommentIds.has(commentId)) {
        console.log('⏭️  Ignoring a comment this app posted itself (public reply echo).');
        return;
    }

    // Fetch Creator config — matches by IG page ID or FB page ID
    const creator = await getCreatorByPageId(entryId);
    if (!creator) {
        console.log(`⚠️  No active creator found for entryId=${entryId}.`);
        return;
    }

    // Ignore self-comments — use the correct page ID field per platform
    const pageOwnerId = isFacebookComment ? creator.facebook_page_id : creator.instagram_page_id;
    if (senderId === pageOwnerId) {
        console.log('⏭️  Ignoring self-comment from page owner.');
        return;
    }

    // Fetch campaigns & match keyword with Arabic normalization & post_id targeting.
    // ORDER BY is not cosmetic: without it Postgres returns heap order, so a generic campaign
    // could shadow a post-specific one on the same keyword and the winner could change after
    // a VACUUM. Most specific first, then longest keyword, then newest.
    const campaignRes = await pool.query(
        `SELECT id, trigger_keyword, dm_template, public_reply_template, post_id, is_active, created_at
           FROM campaigns
          WHERE creator_id = $1 AND is_active = true
          ORDER BY (post_id IS NOT NULL) DESC, length(trigger_keyword) DESC, created_at DESC`,
        [creator.id]
    );

    const matchedCampaign = matchCampaign<CampaignRow>(text, postId, campaignRes.rows);

    if (!matchedCampaign) {
        console.log('⏭️  No active campaign matched the comment text.');
        return;
    }
    console.log(`🎯 Matched campaign: keyword="${matchedCampaign.trigger_keyword}"`);

    // Log interaction as PENDING. The UNIQUE on comment_id makes this the idempotency claim:
    // no row back means another delivery of the same comment already owns it.
    const interactionLog = await pool.query(
        `INSERT INTO interactions (campaign_id, comment_id, sender_username, post_id, status, platform)
         VALUES ($1, $2, $3, $4, 'PENDING', $5)
         ON CONFLICT (comment_id) DO NOTHING
         RETURNING id`,
        [matchedCampaign.id, commentId, senderUsername, postId, isFacebookComment ? 'facebook' : 'instagram']
    );

    if (interactionLog.rows.length === 0) {
        console.log(`⏭️  Duplicate comment event ignored (comment_id: ${commentId})`);
        return;
    }

    const interactionId = interactionLog.rows[0]?.id;

    // ── Rate limits, checked before anything leaves the building ──────────────
    if (!(await canDmRecipient(creator.id, senderId))) {
        console.log(`⏭️  @${senderUsername} already received an automated DM in the last 24h — skipping send.`);
        await pool.query(
            'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
            ['FAILED', 'Skipped: recipient already received an automated DM within 24 hours.', interactionId]
        );
        return;
    }

    const quota = await checkSendQuota(creator.id, 'dm');
    if (!quota.allowed) {
        console.error(`🛑 Hourly DM quota reached (${quota.count}/${quota.limit}) — skipping send to @${senderUsername}.`);
        await pool.query(
            'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
            [
                'FAILED',
                `Skipped: hourly DM quota reached (${quota.count}/${quota.limit}). Meta throttles automated sends at ~200/hr.`,
                interactionId,
            ]
        );
        return;
    }

    // Dispatch Messages
    try {
        // ── Step 1: Send Private DM (the core action) ──────────────────
        const fbPageId = isFacebookComment ? creator.facebook_page_id ?? undefined : undefined;
        console.log('📩 Sending private DM...');
        const dmText: string = matchedCampaign.dm_template.replace(/{username}/g, senderUsername);

        if (dmText.includes('[SPLIT]')) {
            const parts = dmText.split('[SPLIT]');

            // First message must be a private reply to the comment to initiate the conversation
            console.log('📩 Sending first message via private reply...');
            await sendPrivateReply(commentId, (parts[0] ?? '').trim(), creator.page_access_token, fbPageId);

            // Subsequent messages can be sent as direct messages to the user ID
            for (let i = 1; i < parts.length; i++) {
                const part = (parts[i] ?? '').trim();
                if (part) {
                    console.log(`📩 Sending part ${i + 1} via direct message...`);
                    await new Promise((resolve) => setTimeout(resolve, 500)); // 500ms delay to keep ordering
                    await sendDirectMessage(senderId, { text: part }, creator.page_access_token, fbPageId);
                }
            }
        } else {
            await sendPrivateReply(commentId, dmText, creator.page_access_token, fbPageId);
        }

        // Mark SENT immediately — DM is what matters
        await pool.query('UPDATE interactions SET status = $1 WHERE id = $2', ['SENT', interactionId]);
        await recordDmSent(creator.id, senderId);
        console.log(`✅ Private DM sent to @${senderUsername}`);

        // ── Step 1.5: Auto-Like Comment (best-effort algorithmic boost) ──
        try {
            console.log('👍 Auto-liking comment...');
            await likeComment(commentId, creator.page_access_token);
            console.log('👍 Auto-liked comment.');
        } catch (likeErr: any) {
            console.warn('⚠️  Auto-liking comment failed (non-critical):', likeErr.message);
        }
    } catch (dmError: any) {
        // Private DM failed → FAILED
        console.error('❌ Private DM Error:', dmError.message);

        const classified = classifyDmError(dmError);
        await pool.query(
            'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
            [classified.status, classified.error, interactionId]
        );
        return; // skip public reply
    }

    // ── Step 2: Public Reply (best-effort, won't affect SENT status) ──
    if (matchedCampaign.public_reply_template) {
        try {
            console.log('💬 Sending public reply...');

            // Split public replies by | and pick a random variation
            const replyTemplates = matchedCampaign.public_reply_template.split('|');
            const chosenReply = (replyTemplates[Math.floor(Math.random() * replyTemplates.length)] ?? '').trim();
            const publicReplyText = chosenReply.replace(/{username}/g, senderUsername);

            console.log(`💬 Chosen public reply: "${publicReplyText}"`);

            // Instagram: /{commentId}/replies  |  Facebook: /{commentId}/comments
            const posted = await sendPublicReply(
                commentId,
                publicReplyText,
                creator.page_access_token,
                isFacebookComment
            );
            // Meta echoes our own reply back as a new comment webhook; remember its id so the
            // next delivery is recognised as ours rather than answered.
            rememberSelfAuthored(posted?.id);
            console.log('✅ Public reply sent.');
        } catch (publicErr: any) {
            // Public reply failed but DM already succeeded — log but keep SENT
            console.warn('⚠️  Public reply failed (non-critical):', publicErr.message);

            let errorMsg = publicErr.message;
            if (errorMsg.includes('Code: 200')) {
                errorMsg = `App missing permission. Please add 'pages_manage_engagement' in Meta Developer Console -> App Review, and regenerate your Page Access Token. (${publicErr.message})`;
            }

            await pool.query(
                'UPDATE interactions SET error_log = $1 WHERE id = $2',
                [`Public reply failed: ${errorMsg}`, interactionId]
            );
        }
    }
}
