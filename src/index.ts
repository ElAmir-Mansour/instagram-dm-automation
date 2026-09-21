import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import { pool } from './config/db.js';
import { validateEnv } from './config/env.js';
import { appSecrets, verifyMetaSignature } from './utils/signature.js';
import { enqueueWebhookBody, processWebhookBody } from './webhook/router.js';
import { drainInline } from './jobs/drain.js';
import { currentRequestId, describeError, log, newRequestId, withLogContext } from './utils/log.js';
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
    log('error', 'startup.validation_failed', { message: startupError.message });
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

// ─── Request correlation ────────────────────────────────────────────────────
// Every log line emitted while handling a request inherits these fields, so one Meta
// delivery — or one dashboard action — can be pulled out of interleaved output by filtering
// on a single id. Prefers Vercel's own `x-vercel-id` when present, because that is the id
// their log UI already shows: matching it makes platform logs and application logs joinable
// for free.
app.use((req, _res, next) => {
    const platformId = req.headers['x-vercel-id'];
    const requestId = typeof platformId === 'string' && platformId ? platformId : newRequestId();
    withLogContext({ request_id: requestId, method: req.method, path: req.path }, next);
});

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
        log('error', 'webhook.verify_token_read_failed', describeError(err));
    }

    if (candidates.some((c) => c === token)) {
        log('info', 'webhook.verified', { candidates: candidates.length });
        res.status(200).send(challenge);
        return;
    }

    // `candidates: 0` is the specific, actionable case: neither the environment nor the
    // creator row has a token set, so every subscription change Meta attempts will fail with
    // an opaque 403 while existing subscriptions keep delivering.
    log('warn', 'webhook.verify_failed', { candidates: candidates.length });
    res.sendStatus(403);
});

// ─── Webhook Payload Handler ────────────────────────────────────────────────

app.post('/webhook', async (req: express.Request, res: express.Response) => {
    // 1. Validate Signature (HMAC SHA-256)
    if (!verifyMetaSignature(req, req.rawBody)) {
        // Worth being loud here: a signature failure is indistinguishable from
        // "no events arriving" unless the log says which secrets were tried. This is the
        // line the project's own troubleshooting docs call invisible — as a structured
        // event it can finally be alerted on.
        log('error', 'webhook.signature_rejected', {
            secrets_tried: appSecrets().length,
            instagram_secret_set: Boolean(process.env.INSTAGRAM_APP_SECRET),
        });
        res.sendStatus(403);
        return;
    }

    // 2. Accept both 'instagram' and 'page' object types
    // Page-level subscriptions (/{page-id}/subscribed_apps) send object:'page'
    // App-level subscriptions (/{app-id}/subscriptions) send object:'instagram'
    const body = req.body;

    // A request with a non-JSON Content-Type never reaches body-parser's JSON branch, so
    // `req.body` is undefined and every property read below throws a TypeError — which Meta
    // sees as a 500 and answers with a redelivery storm. A flat 400 ends it.
    if (!body || typeof body !== 'object') {
        log('warn', 'webhook.body_not_json', { content_type: req.headers['content-type'] });
        res.sendStatus(400);
        return;
    }

    const isInstagramEvent = body.object === 'instagram' || body.object === 'page';
    if (!isInstagramEvent) {
        log('info', 'webhook.unrecognised_object', { object: body.object });
        res.sendStatus(200);
        return;
    }

    // 3. Make the work durable, acknowledge, then do as much of it as the budget allows.
    //
    // Meta's webhook timeout is ~20 seconds, and this pipeline involves a Gemini round-trip
    // (2-8s) plus however many Meta sends follow. It used to answer 200 and then keep working
    // in the same invocation — which on Vercel can be frozen at any point after the response,
    // losing the work permanently *and* having already told Meta it succeeded.
    //
    // Writing the events to `jobs` first changes the worst case from "silently lost" to
    // "still pending". The inline drain below then does the common case immediately, so
    // latency is unchanged in the happy path; anything it does not finish is picked up by
    // the next drain (another webhook, or GET /api/jobs/drain).

    // The same id the middleware put on every log line for this request, carried across the
    // queue boundary so the work and its acknowledgement share a correlation id.
    const requestId = currentRequestId();

    let enqueued = false;
    if (process.env.WEBHOOK_QUEUE !== 'off') {
        try {
            await enqueueWebhookBody(body, requestId);
            enqueued = true;
        } catch (err) {
            // The queue is the durability mechanism, so losing it is worth an error — but
            // not worth dropping the delivery over. Fall through to the inline path, which
            // is exactly the behaviour that shipped before the queue existed.
            //
            // A partial enqueue — some events written, then a failure — means those events
            // are processed inline here AND may be drained later. That is deliberately
            // tolerated: `interactions.comment_id` and `messages.meta_message_id` are both
            // UNIQUE, so the second pass claims nothing and returns. Doing the work twice is
            // recoverable; dropping it is not.
            log('error', 'webhook.enqueue_failed_falling_back', describeError(err));
        }
    }

    res.sendStatus(200);

    try {
        if (enqueued) await drainInline();
        else await processWebhookBody(body);
    } catch (err) {
        // Both paths isolate every entry and every event inside them, so reaching here means
        // something outside the per-event handlers broke. The response is already sent; all
        // that is left is to make it visible.
        log('error', 'webhook.pipeline_error', describeError(err));
    }
});

// ─── Start Server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
    log('info', 'server.listening', { port: PORT });
});
