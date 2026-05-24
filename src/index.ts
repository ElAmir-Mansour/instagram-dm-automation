import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import { pool } from './config/db.js';
import { validateEnv } from './config/env.js';
import { verifyMetaSignature } from './utils/signature.js';
import { rateLimiter } from './utils/rateLimiter.js';
import { normalizeArabic } from './utils/arabic.js';
import { sendPrivateReply, sendPublicReply, sendDirectMessage, likeComment } from './services/instagram.js';
import { generateAiResponse } from './services/ai.js';
import apiRouter from './routes/api.js';


// ─── Startup ────────────────────────────────────────────────────────────────
validateEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Extend express Request type to include rawBody for signature verification
declare global {
    namespace Express {
        interface Request {
            rawBody: Buffer;
        }
    }
}

// Need raw body buffer for HMAC signature verification
app.use(bodyParser.json({
    limit: '15mb',
    verify: (req: any, _res, buf) => { req.rawBody = buf; }
}));

// ─── Dashboard Static Files ─────────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, '../dashboard')));

// ─── Local Documentation (gitignored, not deployed) ─────────────────────────
app.use('/docs', express.static(path.join(__dirname, '../docs')));

// ─── API Routes ─────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ─── Static Pages ───────────────────────────────────────────────────────────

// Privacy Policy (required by Meta App Review)
app.get('/privacy', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/privacy.html'));
});

// Eid Landing Page Redirection
app.get('/eid', (_req, res) => {
    res.redirect('/dashboard/eid.html');
});
app.get('/eidia', (_req, res) => {
    res.redirect('/dashboard/eid.html');
});

// Data Deletion Instructions (required by Meta App Review)
app.get('/data-deletion', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/data-deletion.html'));
});

// ─── Health Check ───────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
    try {
        const dbResult = await pool.query('SELECT NOW() as time');
        res.json({
            status: 'ok',
            database: 'connected',
            serverTime: new Date().toISOString(),
            dbTime: dbResult.rows[0]?.time,
        });
    } catch {
        res.status(500).json({
            status: 'error',
            database: 'disconnected',
            serverTime: new Date().toISOString(),
        });
    }
});

// ─── Webhook Verification (Meta Handshake) ──────────────────────────────────

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
        console.log('✅ Webhook verified successfully!');
        res.status(200).send(challenge);
    } else {
        console.warn('❌ Webhook verification failed. Token mismatch.');
        res.sendStatus(403);
    }
});

// ─── Webhook Payload Handler ────────────────────────────────────────────────

app.post('/webhook', async (req: express.Request, res: express.Response) => {
    console.log('\n═══ WEBHOOK RECEIVED ═══');
    console.log('Timestamp:', new Date().toISOString());

    // 1. Validate Signature (HMAC SHA-256)
    if (!verifyMetaSignature(req, req.rawBody)) {
        console.error('❌ Invalid signature — rejecting request.');
        res.sendStatus(403);
        return;
    }
    console.log('✅ Signature validated.');

    // 2. Accept both 'instagram' and 'page' object types
    // Page-level subscriptions (/{page-id}/subscribed_apps) send object:'page'
    // App-level subscriptions (/{app-id}/subscriptions) send object:'instagram'
    const body = req.body;
    console.log('📦 Webhook object type:', body.object);
    console.log('📦 Raw body preview:', JSON.stringify(body).substring(0, 300));

    const isInstagramEvent = body.object === 'instagram' || body.object === 'page';
    if (!isInstagramEvent) {
        console.log('⏭️  Unrecognized event object type:', body.object);
        res.sendStatus(200);
        return;
    }

    try {
        for (const entry of body.entry) {
            const entryId = entry.id;
            console.log(`\n── Processing entry ID: ${entryId} (object: ${body.object})`);

            // ─── A. Process Instagram Direct Messages & Postbacks ─────────────────────
            if (entry.messaging && Array.isArray(entry.messaging)) {
                console.log(`📨 Found ${entry.messaging.length} messaging events to process.`);
                for (const event of entry.messaging) {
                    const senderId = event.sender?.id;
                    const recipientId = event.recipient?.id;

                    // Ignore echo messages (sent by the page itself)
                    if (event.message?.is_echo) {
                        console.log('⏭️  Ignoring echo message sent by the Page.');
                        continue;
                    }

                    // Extract text content and payloads
                    let text = event.message?.text || '';
                    let payload = '';

                    // If they clicked a Quick Reply
                    if (event.message?.quick_reply) {
                        payload = event.message.quick_reply.payload || '';
                        console.log(`💬 User clicked Quick Reply button: text="${text}", payload="${payload}"`);
                    }

                    // If it is a Postback (e.g. from a carousel button click)
                    if (event.postback) {
                        text = event.postback.title || '';
                        payload = event.postback.payload || '';
                        console.log(`🎯 User clicked Postback button: title="${text}", payload="${payload}"`);
                    }

                    // Check for Story Mention attachment
                    let isStoryMention = false;
                    if (event.message?.attachments && Array.isArray(event.message.attachments)) {
                        const storyMention = event.message.attachments.find((att: any) => att.type === 'story_mention');
                        if (storyMention) {
                            isStoryMention = true;
                            console.log(`📖 Received a Story Mention from sender: ${senderId}`);
                        }
                    }

                    if (!senderId || (!text && !payload && !isStoryMention)) {
                        console.log('⏭️  Skipping empty message/postback event.');
                        continue;
                    }

                    console.log(`📨 Incoming DM from IGSID ${senderId} → recipient ${recipientId}: "${text}" (payload: ${payload})`);

                    // Look up creator by recipientId (IG Business ID) OR entryId (FB Page ID)
                    // recipientId from message events = Instagram Business Account ID (most reliable)
                    // entryId = could be IG ID (app-level sub) or FB Page ID (page-level sub)
                    const creatorLookup = await pool.query(
                        `SELECT id, is_bot_active, page_access_token FROM creators 
                         WHERE is_active = true 
                           AND (instagram_page_id = $1 OR instagram_page_id = $2 OR facebook_page_id = $2)
                         LIMIT 1`,
                        [recipientId, entryId]
                    );

                    if (creatorLookup.rows.length === 0) {
                        console.log(`⚠️  No creator found for recipientId=${recipientId} or entryId=${entryId}. Skipping.`);
                        continue;
                    }

                    const creator = creatorLookup.rows[0];
                    console.log(`✅ Creator found: ${creator.id}`);

                    // 1. Fetch or create conversation thread
                    let conversationId = '';
                    let isBotActive = true;
                    
                    const dbConversation = await pool.query(
                        `SELECT id, is_bot_active FROM conversations 
                         WHERE creator_id = $1 
                           AND instagram_user_id = $2`,
                        [creator.id, senderId]
                    );

                    if (dbConversation.rows.length === 0) {
                        const newConv = await pool.query(
                            `INSERT INTO conversations (creator_id, instagram_user_id, status)
                             VALUES ($1, $2, 'active')
                             RETURNING id, is_bot_active`,
                            [creator.id, senderId]
                        );
                        conversationId = newConv.rows[0].id;
                        isBotActive = newConv.rows[0].is_bot_active;
                    } else {
                        conversationId = dbConversation.rows[0].id;
                        isBotActive = dbConversation.rows[0].is_bot_active;
                        
                        // Update last_message_at
                        await pool.query(
                            'UPDATE conversations SET last_message_at = NOW() WHERE id = $1',
                            [conversationId]
                        );
                    }

                    // 2. Log inbound message in the database
                    await pool.query(
                        `INSERT INTO messages (conversation_id, direction, message_type, text, payload, raw_payload)
                         VALUES ($1, 'inbound', $2, $3, $4, $5)`,
                        [
                            conversationId, 
                            isStoryMention ? 'story_mention' : 'text', 
                            text || (isStoryMention ? '[Story Mention]' : ''), 
                            payload || null, 
                            JSON.stringify(event)
                        ]
                    );

                    // 3. Call AI Agent to reply if Bot is active
                    if (isBotActive) {
                        try {
                            // Query Gemini
                            console.log('🤖 Invoking Gemini to construct response...');
                            const aiRes = await generateAiResponse(conversationId, text || payload, creator.id);
                            console.log('🤖 Gemini Response Type:', aiRes.message_type);

                            // Format Meta payload
                            let metaMessagePayload: any = {};
                            if (aiRes.message_type === 'text') {
                                metaMessagePayload = { text: aiRes.text };
                            } else if (aiRes.message_type === 'quick_reply') {
                                metaMessagePayload = {
                                    text: aiRes.text,
                                    quick_replies: aiRes.quick_replies?.map((qr: any) => ({
                                        content_type: 'text',
                                        title: qr.title,
                                        payload: qr.payload
                                    }))
                                };
                            } else if (aiRes.message_type === 'carousel') {
                                metaMessagePayload = {
                                    attachment: {
                                        type: 'template',
                                        payload: {
                                            template_type: 'generic',
                                            elements: aiRes.carousel_elements?.map((el: any) => {
                                                const cleanElement: any = {
                                                    title: el.title
                                                };
                                                if (el.subtitle) cleanElement.subtitle = el.subtitle;
                                                if (el.image_url) cleanElement.image_url = el.image_url;
                                                if (el.buttons && el.buttons.length > 0) {
                                                    cleanElement.buttons = el.buttons.map((btn: any) => {
                                                        const cleanBtn: any = {
                                                            type: btn.type,
                                                            title: btn.title
                                                        };
                                                        if (btn.type === 'web_url') {
                                                            cleanBtn.url = btn.url;
                                                        } else {
                                                            cleanBtn.payload = btn.payload;
                                                        }
                                                        return cleanBtn;
                                                    });
                                                }
                                                return cleanElement;
                                            })
                                        }
                                    }
                                };
                            }

                            // Send DM using Meta Send API
                            console.log(`📩 Sending Meta response of type: ${aiRes.message_type}`);
                            await sendDirectMessage(senderId, metaMessagePayload, creator.page_access_token);

                            // Log outbound message
                            await pool.query(
                                `INSERT INTO messages (conversation_id, direction, message_type, text, raw_payload)
                                 VALUES ($1, 'outbound', $2, $3, $4)`,
                                [conversationId, aiRes.message_type, aiRes.text || '[Structured Template]', JSON.stringify(metaMessagePayload)]
                            );
                        } catch (aiError: any) {
                            console.error('❌ AI Pipeline / Send Error:', aiError.message);
                        }
                    } else {
                        console.log('⏭️  AI Bot is paused for this conversation thread. Manual reply required.');
                    }

                }
            }

            // ─── B. Process Comment webhooks (Instagram & Facebook) ─────────────────
            if (entry.changes && Array.isArray(entry.changes)) {
                for (const change of entry.changes) {

                    // ── Normalise the event into platform-agnostic variables ──────────
                    let commentId: string;
                    let postId: string;
                    let text: string;
                    let senderUsername: string;
                    let senderId: string;
                    let isFacebookComment = false;

                    if (change.field === 'comments') {
                        // Instagram comment webhook: field = 'comments'
                        const v = change.value;
                        commentId    = v.id;
                        postId       = v.media?.id;
                        text         = v.text?.toLowerCase() || '';
                        senderUsername = v.from?.username || v.from?.id;
                        senderId     = v.from?.id;

                    } else if (
                        change.field === 'feed' &&
                        change.value?.item === 'comment' &&
                        change.value?.verb === 'add'
                    ) {
                        // Facebook Page comment webhook: field = 'feed', item = 'comment'
                        const v = change.value;
                        commentId    = v.comment_id;
                        postId       = v.post_id;
                        text         = v.message?.toLowerCase() || '';
                        senderUsername = v.from?.name || v.from?.id;
                        senderId     = v.from?.id;
                        isFacebookComment = true;

                    } else {
                        console.log(`⏭️  Skipping unhandled change field: ${change.field} (item: ${change.value?.item})`);
                        continue;
                    }

                    console.log(`💬 [${isFacebookComment ? 'FB' : 'IG'}] Comment: "${text}" by @${senderUsername} (ID: ${senderId})`);

                    // Fetch Creator config — matches by IG page ID or FB page ID
                    const creatorRes = await pool.query(
                        `SELECT * FROM creators 
                         WHERE is_active = true 
                           AND (instagram_page_id = $1 OR facebook_page_id = $1)
                         LIMIT 1`,
                        [entryId]
                    );

                    if (creatorRes.rows.length === 0) {
                        console.log(`⚠️  No active creator found for entryId=${entryId}.`);
                        continue;
                    }
                    const creator = creatorRes.rows[0];

                    // Ignore self-comments — use the correct page ID field per platform
                    const pageOwnerId = isFacebookComment
                        ? creator.facebook_page_id
                        : creator.instagram_page_id;
                    if (senderId === pageOwnerId) {
                        console.log('⏭️  Ignoring self-comment from page owner.');
                        continue;
                    }

                    // Fetch campaigns & match keyword with Arabic normalization & post_id targeting
                    const campaignRes = await pool.query(
                        'SELECT * FROM campaigns WHERE creator_id = $1 AND is_active = true',
                        [creator.id]
                    );

                    const normalizedCommentText = normalizeArabic(text);

                    const matchedCampaign = campaignRes.rows.find((c: any) => {
                        // Split keywords by comma, trim, and normalize each
                        const triggerKeywordsList = c.trigger_keyword
                            .split(',')
                            .map((k: string) => normalizeArabic(k.trim()))
                            .filter(Boolean);

                        // Match if ANY of the normalized keywords are present in the normalized comment text
                        const keywordMatches = triggerKeywordsList.some((normalizedKeyword: string) =>
                            normalizedCommentText.includes(normalizedKeyword)
                        );

                        // If post_id filter is set, it must match the current comment's post_id
                        const postIdMatches = !c.post_id || c.post_id === postId;
                        
                        return keywordMatches && postIdMatches;
                    });

                    if (!matchedCampaign) {
                        console.log('⏭️  No active campaign matched the comment text.');
                        continue;
                    }
                    console.log(`🎯 Matched campaign: keyword="${matchedCampaign.trigger_keyword}"`);

                    // Log interaction as PENDING
                    const interactionLog = await pool.query(
                        `INSERT INTO interactions (campaign_id, comment_id, sender_username, post_id, status, platform)
                         VALUES ($1, $2, $3, $4, 'PENDING', $5)
                         ON CONFLICT (comment_id) DO NOTHING
                         RETURNING id`,
                        [matchedCampaign.id, commentId, senderUsername, postId, isFacebookComment ? 'facebook' : 'instagram']
                    );
                    
                    if (interactionLog.rows.length === 0) {
                        console.log(`⏭️  Duplicate comment event ignored (comment_id: ${commentId})`);
                        continue;
                    }
                    
                    const interactionId = interactionLog.rows[0]?.id;

                    // Dispatch Messages
                    try {
                        // ── Step 1: Send Private DM (the core action) ──────────────────
                        const fbPageId = isFacebookComment ? creator.facebook_page_id : undefined;
                        console.log('📩 Sending private DM...');
                        const dmText = matchedCampaign.dm_template.replace(/{username}/g, senderUsername);
                        
                        if (dmText.includes('[SPLIT]')) {
                            const parts = dmText.split('[SPLIT]');
                            
                            // First message must be a private reply to the comment to initiate the conversation
                            console.log('📩 Sending first message via private reply...');
                            await sendPrivateReply(commentId, parts[0].trim(), creator.page_access_token, fbPageId);
                            
                            // Subsequent messages can be sent as direct messages to the user ID
                            for (let i = 1; i < parts.length; i++) {
                                const part = parts[i].trim();
                                if (part) {
                                    console.log(`📩 Sending part ${i + 1} via direct message...`);
                                    await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay to keep ordering
                                    await sendDirectMessage(senderId, { text: part }, creator.page_access_token, fbPageId);
                                }
                            }
                        } else {
                            await sendPrivateReply(commentId, dmText, creator.page_access_token, fbPageId);
                        }

                        // Mark SENT immediately — DM is what matters
                        await pool.query(
                            'UPDATE interactions SET status = $1 WHERE id = $2',
                            ['SENT', interactionId]
                        );
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
                        await pool.query(
                            'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
                            ['FAILED', dmError.message, interactionId]
                        );
                        continue; // skip public reply
                    }

                    // ── Step 2: Public Reply (best-effort, won't affect SENT status) ──
                    if (matchedCampaign.public_reply_template) {
                        try {
                            console.log('💬 Sending public reply...');
                            
                            // Split public replies by | and pick a random variation
                            const replyTemplates = matchedCampaign.public_reply_template.split('|');
                            const chosenReply = replyTemplates[Math.floor(Math.random() * replyTemplates.length)].trim();
                            const publicReplyText = chosenReply.replace(/{username}/g, senderUsername);
                            
                            console.log(`💬 Chosen public reply: "${publicReplyText}"`);
                            
                            // Instagram: /{commentId}/replies  |  Facebook: /{commentId}/comments
                            await sendPublicReply(commentId, publicReplyText, creator.page_access_token, isFacebookComment);
                            console.log('✅ Public reply sent.');
                        } catch (publicErr: any) {
                            // Public reply failed but DM already succeeded — log but keep SENT
                            console.warn('⚠️  Public reply failed (non-critical):', publicErr.message);
                            await pool.query(
                                'UPDATE interactions SET error_log = $1 WHERE id = $2',
                                [`Public reply failed: ${publicErr.message}`, interactionId]
                            );
                        }
                    }

                }
            }
        }
    } catch (err) {
        console.error('❌ Pipeline Error:', err);
    } finally {
        // Send 200 OK to Meta after processing is complete so Vercel doesn't kill the function early
        res.sendStatus(200);
    }
});

// ─── Start Server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`   Health:   http://localhost:${PORT}/health`);
    console.log(`   Webhook:  http://localhost:${PORT}/webhook`);
    console.log(`   Privacy:  http://localhost:${PORT}/privacy\n`);
});
