import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import { pool } from './config/db.js';
import { validateEnv } from './config/env.js';
import { verifyMetaSignature } from './utils/signature.js';
import { rateLimiter } from './utils/rateLimiter.js';
import { sendPrivateReply, sendPublicReply, sendDirectMessage } from './services/instagram.js';
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

    // 2. Ensure it's an Instagram event
    const body = req.body;
    if (body.object !== 'instagram') {
        console.log('⏭️  Not an Instagram event:', body.object);
        res.sendStatus(200);
        return;
    }

    try {
        for (const entry of body.entry) {
            const pageId = entry.id;
            console.log(`\n── Processing entry for Page ID: ${pageId}`);

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

                    console.log(`📨 Incoming DM from IGSID ${senderId}: "${text}" (payload: ${payload})`);

                    // 1. Fetch or create conversation thread
                    let conversationId = '';
                    let isBotActive = true;
                    
                    const dbConversation = await pool.query(
                        `SELECT id, is_bot_active FROM conversations 
                         WHERE creator_id = (SELECT id FROM creators WHERE instagram_page_id = $1) 
                           AND instagram_user_id = $2`,
                        [pageId, senderId]
                    );

                    if (dbConversation.rows.length === 0) {
                        const newConv = await pool.query(
                            `INSERT INTO conversations (creator_id, instagram_user_id, status)
                             VALUES ((SELECT id FROM creators WHERE instagram_page_id = $1), $2, 'active')
                             RETURNING id, is_bot_active`,
                            [pageId, senderId]
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
                            const creatorRes = await pool.query(
                                'SELECT id, page_access_token FROM creators WHERE instagram_page_id = $1 AND is_active = true',
                                [pageId]
                            );

                            if (creatorRes.rows.length > 0) {
                                const creator = creatorRes.rows[0];
                                
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
                            }
                        } catch (aiError: any) {
                            console.error('❌ AI Pipeline / Send Error:', aiError.message);
                        }
                    } else {
                        console.log('⏭️  AI Bot is paused for this conversation thread. Manual reply required.');
                    }
                }
            }

            // ─── B. Process Instagram Comment webhooks ──────────────────────────────
            if (entry.changes && Array.isArray(entry.changes)) {
                for (const change of entry.changes) {
                    if (change.field !== 'comments') {
                        console.log(`⏭️  Skipping non-comment field: ${change.field}`);
                        continue;
                    }

                    const commentData = change.value;
                    const commentId = commentData.id;
                    const postId = commentData.media?.id;
                    const text = commentData.text?.toLowerCase() || '';
                    const senderUsername = commentData.from?.username;
                    const senderId = commentData.from?.id;

                    console.log(`💬 Comment: "${text}" by @${senderUsername} (ID: ${senderId})`);

                    // Ignore comments made by the page itself
                    if (senderId === pageId) {
                        console.log('⏭️  Ignoring self-comment from page owner.');
                        continue;
                    }

                    // 3. Fetch Creator config
                    const creatorRes = await pool.query(
                        'SELECT * FROM creators WHERE instagram_page_id = $1 AND is_active = true',
                        [pageId]
                    );

                    if (creatorRes.rows.length === 0) {
                        console.log('⚠️  No active creator found for this Page ID.');
                        continue;
                    }
                    const creator = creatorRes.rows[0];

                    // 4. Fetch campaigns & match keyword
                    const campaignRes = await pool.query(
                        'SELECT * FROM campaigns WHERE creator_id = $1',
                        [creator.id]
                    );

                    const matchedCampaign = campaignRes.rows.find((c: any) =>
                        text.includes(c.trigger_keyword.toLowerCase())
                    );

                    if (!matchedCampaign) {
                        console.log('⏭️  No campaign matched the comment text.');
                        continue;
                    }
                    console.log(`🎯 Matched campaign: keyword="${matchedCampaign.trigger_keyword}"`);

                    // 7. Log interaction as PENDING
                    const interactionLog = await pool.query(
                        `INSERT INTO interactions (campaign_id, comment_id, sender_username, post_id, status)
                         VALUES ($1, $2, $3, $4, 'PENDING') RETURNING id`,
                        [matchedCampaign.id, commentId, senderUsername, postId]
                    );
                    const interactionId = interactionLog.rows[0]?.id;

                    // 8. Dispatch Messages
                    try {
                        // Send DM (Private Reply)
                        console.log('📩 Sending private DM...');
                        await sendPrivateReply(commentId, matchedCampaign.dm_template, creator.page_access_token);

                        // Optional: Send Public Reply
                        if (matchedCampaign.public_reply_template) {
                            console.log('💬 Sending public reply...');
                            await sendPublicReply(commentId, matchedCampaign.public_reply_template, creator.page_access_token);
                        }

                        // Update status to SENT
                        await pool.query(
                            'UPDATE interactions SET status = $1 WHERE id = $2',
                            ['SENT', interactionId]
                        );
                        console.log(`✅ Successfully processed comment from @${senderUsername}`);

                    } catch (dispatchError: any) {
                        console.error('❌ Dispatch Error:', dispatchError.message);
                        await pool.query(
                            'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
                            ['FAILED', dispatchError.message, interactionId]
                        );
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
