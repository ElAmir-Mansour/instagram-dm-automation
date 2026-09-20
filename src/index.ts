import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import { pool } from './config/db.js';
import { validateEnv } from './config/env.js';
import { appSecrets, verifyMetaSignature } from './utils/signature.js';
import { processWebhookBody } from './webhook/router.js';
import apiRouter, { securityHeaders } from './routes/api.js';


// ─── Startup ────────────────────────────────────────────────────────────────
// validateEnv() throws rather than calling process.exit(1), because on Vercel this module is
// evaluated inside the request handler — exiting kills the invocation with no HTTP response
// at all, so every request becomes an opaque platform error with nothing to read.
//
// Catching it here turns that into something diagnosable: the process stays up, the reason is
// logged once, and every request gets a 503 that names the problem. Serving traffic with a
// missing secret would be worse than serving none, so the guard below refuses everything.
let startupError: Error | null = null;
try {
    validateEnv();
} catch (err) {
    startupError = err instanceof Error ? err : new Error(String(err));
    console.error('❌ Startup validation failed — refusing all requests:', startupError.message);
}

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

// ─── Security Headers ───────────────────────────────────────────────────────
// Ahead of every route so the dashboard's static files are covered too, not just /api.
app.use(securityHeaders);

// Refuse everything while the environment is invalid. This sits above the routes so a missing
// secret cannot be papered over by a route that happens not to read it.
app.use((_req, res, next) => {
    if (startupError) {
        res.status(503).json({ error: 'Service misconfigured', detail: startupError.message });
        return;
    }
    next();
});

// ─── Dashboard Static Files ─────────────────────────────────────────────────
app.use('/dashboard', express.static(path.join(__dirname, '../dashboard')));

// `/docs` used to be served statically from a gitignored directory. It 404s in production
// only by accident of the deploy contents — anyone who dropped a file there would have
// published TOKEN_GUIDE.md and friends unauthenticated. Removed rather than guarded: local
// docs are read from the working tree, not over HTTP.

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

app.get('/webhook', async (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode !== 'subscribe' || typeof token !== 'string') {
        res.sendStatus(403);
        return;
    }

    // The verify token may come from the environment or from the creator row.
    // The database copy exists so it can be changed from the dashboard without a
    // redeploy — Meta re-checks this on every subscription change, so a stale or
    // empty env var otherwise blocks all webhook reconfiguration.
    const candidates: string[] = [];
    if (process.env.META_VERIFY_TOKEN) candidates.push(process.env.META_VERIFY_TOKEN);
    try {
        const { rows } = await pool.query(
            'SELECT webhook_verify_token FROM creators WHERE is_active = true AND webhook_verify_token IS NOT NULL LIMIT 1'
        );
        const dbToken = rows[0]?.webhook_verify_token;
        if (dbToken) candidates.push(dbToken);
    } catch (err: any) {
        // A database outage must not make a correct env token stop working.
        console.error('⚠️  Could not read verify token from database:', err.message);
    }

    if (candidates.some((c) => c === token)) {
        console.log('✅ Webhook verified successfully!');
        res.status(200).send(challenge);
        return;
    }

    console.warn(
        `❌ Webhook verification failed. Checked ${candidates.length} configured token(s)` +
        (candidates.length === 0 ? ' — none are set, in the environment or the database.' : '.')
    );
    res.sendStatus(403);
});

// ─── Webhook Payload Handler ────────────────────────────────────────────────

app.post('/webhook', async (req: express.Request, res: express.Response) => {
    console.log('\n═══ WEBHOOK RECEIVED ═══');
    console.log('Timestamp:', new Date().toISOString());

    // 1. Validate Signature (HMAC SHA-256)
    if (!verifyMetaSignature(req, req.rawBody)) {
        // Worth being loud here: a signature failure is indistinguishable from
        // "no events arriving" unless the log says which secrets were tried.
        console.error(
            `❌ Invalid signature — rejecting request. Tried ${appSecrets().length} app secret(s).` +
            (process.env.INSTAGRAM_APP_SECRET
                ? ''
                : ' INSTAGRAM_APP_SECRET is not set, so Instagram Login events cannot validate.'),
        );
        res.sendStatus(403);
        return;
    }
    console.log('✅ Signature validated.');

    // 2. Accept both 'instagram' and 'page' object types
    // Page-level subscriptions (/{page-id}/subscribed_apps) send object:'page'
    // App-level subscriptions (/{app-id}/subscriptions) send object:'instagram'
    const body = req.body;

    // A request with a non-JSON Content-Type never reaches body-parser's JSON branch, so
    // `req.body` is undefined and every property read below throws a TypeError — which Meta
    // sees as a 500 and answers with a redelivery storm. A flat 400 ends it.
    if (!body || typeof body !== 'object') {
        console.warn('❌ Webhook body was not parsed as JSON — check the Content-Type header.');
        res.sendStatus(400);
        return;
    }

    console.log('📦 Webhook object type:', body.object);
    console.log('📦 Raw body preview:', JSON.stringify(body).substring(0, 300));

    const isInstagramEvent = body.object === 'instagram' || body.object === 'page';
    if (!isInstagramEvent) {
        console.log('⏭️  Unrecognized event object type:', body.object);
        res.sendStatus(200);
        return;
    }

    // 3. Acknowledge, then process.
    //
    // Meta's webhook timeout is ~20 seconds, and this pipeline awaits a Gemini round-trip
    // (2-8s) plus however many Meta sends follow. Answering only once that finished meant a
    // slow batch was redelivered while the first attempt was still working through it.
    //
    // STOPGAP: on Vercel, work that continues after the response can be killed when the
    // invocation is frozen, so the processing is still awaited below — the early 200 buys
    // headroom against the timeout, it does not make this fire-and-forget. The real fix is a
    // queue (Vercel Queues, QStash): the webhook enqueues and returns, a worker processes.
    // That same queue is the other half of the cron problem — the once-daily 00:00 UTC cron
    // is a Hobby-plan limit that makes `scheduled_time` day-granular, and a queue with a
    // scheduled consumer answers both.
    res.sendStatus(200);

    try {
        await processWebhookBody(body);
    } catch (err) {
        // processWebhookBody isolates every entry and every event inside it, so reaching here
        // means something outside the per-event handlers broke. The response is already sent;
        // all that is left is to make it visible.
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
