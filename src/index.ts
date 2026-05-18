import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import { pool } from './config/db.js';
import { validateEnv } from './config/env.js';
import { verifyMetaSignature } from './utils/signature.js';
import { rateLimiter } from './utils/rateLimiter.js';
import { sendPrivateReply, sendPublicReply } from './services/instagram.js';

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

    // Always respond 200 quickly — process in background
    res.sendStatus(200);

    try {
        for (const entry of body.entry) {
            const pageId = entry.id;
            console.log(`\n── Processing entry for Page ID: ${pageId}`);

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

                // 5. Spam / Duplicate prevention (24-hour window)
                const recentInteractions = await pool.query(
                    `SELECT id FROM interactions
                     WHERE sender_username = $1 AND post_id = $2
                     AND timestamp > NOW() - INTERVAL '24 hours'`,
                    [senderUsername, postId]
                );

                if (recentInteractions.rows.length > 0) {
                    console.log(`⏭️  Already messaged @${senderUsername} for this post in the last 24h.`);
                    continue;
                }

                // 6. Check rate limit
                if (!rateLimiter.canSend()) {
                    console.warn(`⚠️  Rate limit reached (${rateLimiter.getCount()}/${rateLimiter.limit} per hour). Skipping.`);
                    continue;
                }

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
                    rateLimiter.record();

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
    } catch (err) {
        console.error('❌ Pipeline Error:', err);
    }
});

// ─── Start Server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`   Health:   http://localhost:${PORT}/health`);
    console.log(`   Webhook:  http://localhost:${PORT}/webhook`);
    console.log(`   Privacy:  http://localhost:${PORT}/privacy\n`);
});
