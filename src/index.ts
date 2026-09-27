import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'url';

import { pool } from './config/db.js';
import { validateEnv } from './config/env.js';
import { appSecrets, verifyMetaSignature } from './utils/signature.js';
import { isDiagnosticProbe } from './utils/probe.js';
import { enqueueWebhookBody, processWebhookBody } from './webhook/router.js';
import { drainInline } from './jobs/drain.js';
import { currentRequestId, describeError, log, newRequestId, withLogContext } from './utils/log.js';
import apiRouter, { securityHeaders } from './routes/api.js';
import { getSiteSettings, getVerificationFiles, siteSettingsFromEnv } from './services/appSettings.js';
import { pageLangFromQuery, renderSiteTemplate, type PageLang } from './services/publicPages.js';


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

// ─── Public pages ───────────────────────────────────────────────────────────
// Every public page is read from disk once per process and run through
// `renderSiteTemplate` on each request: the WhatsApp link, the contact email and the Eid
// coupon expiry are Settings → Public site values (src/services/appSettings.ts), not
// literals in six HTML files. A database outage must not take the front door down, so the
// settings read falls back to the environment's answer alone.
//
// The Cache-Control below is what makes the per-request read affordable and what bounds
// how long a saved value takes to appear: Vercel's CDN serves a rendered page for five
// minutes (`s-maxage`), keeps handing out the stale copy for ten more while it refetches,
// and the browser itself never caches (`max-age=0`).
//
// `?lang=en` is part of the URL, so the CDN caches the English alternate as its own entry.
const PUBLIC_PAGE_CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=600';

// Every path is a LITERAL `path.join(__dirname, '../…')`, exactly the shape the old
// `res.sendFile` calls had. Vercel bundles the function by tracing file references
// statically; a path assembled from a variable is not traced, and the page would be missing
// from the deployed function — a 500 on every public URL that no local run can show.
const PUBLIC_PAGES = {
    landing: path.join(__dirname, '../public/landing.html'),
    privacy: path.join(__dirname, '../public/privacy.html'),
    terms: path.join(__dirname, '../public/terms.html'),
    dataDeletion: path.join(__dirname, '../public/data-deletion.html'),
    pricing: path.join(__dirname, '../public/pricing.html'),
    notFound: path.join(__dirname, '../public/404.html'),
    eid: path.join(__dirname, '../dashboard/eid.html'),
} as const;
type PublicPage = keyof typeof PUBLIC_PAGES;
/** Written in Arabic only: `?lang=en` must not flip them to left-to-right. */
const ARABIC_ONLY_PAGES: ReadonlySet<PublicPage> = new Set<PublicPage>(['eid']);

const publicPageSource = new Map<PublicPage, Promise<string>>();

async function renderPublicPage(page: PublicPage, lang: PageLang): Promise<string> {
    let source = publicPageSource.get(page);
    if (!source) {
        source = readFile(PUBLIC_PAGES[page], 'utf8');
        publicPageSource.set(page, source);
        // A read that failed must not be cached as a permanent failure.
        source.catch(() => publicPageSource.delete(page));
    }
    let site;
    try {
        site = await getSiteSettings();
    } catch (err) {
        log('error', 'public.site_settings_read_failed', describeError(err));
        site = siteSettingsFromEnv();
    }
    return renderSiteTemplate(await source, site, lang);
}

async function sendPublicPage(req: express.Request, res: express.Response, page: PublicPage, status = 200): Promise<void> {
    try {
        const lang = ARABIC_ONLY_PAGES.has(page) ? 'ar' : pageLangFromQuery(req.query.lang);
        const html = await renderPublicPage(page, lang);
        res.status(status);
        res.setHeader('Cache-Control', PUBLIC_PAGE_CACHE_CONTROL);
        res.type('html').send(html);
    } catch (err) {
        log('error', 'public.page_render_failed', { page, ...describeError(err) });
        res.status(500).type('text/plain').send('Page unavailable');
    }
}

// The Eid page moved to `/eid` (rendered, so `data-coupons-expire` is filled from Settings).
// Registered ahead of the static handler so the old address redirects. vercel.json routes
// /dashboard/* straight to the static file in production, where this line is never reached;
// there the page's own head script sends the visitor to /eid (dashboard/eid.html), and the
// unrendered token it carries until then is inert to the coupon script.
app.get('/dashboard/eid.html', (_req, res) => {
    res.redirect(301, '/eid');
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

// The landing page. Until this existed the bare domain 404'd — /pricing, /privacy,
// /data-deletion and /dashboard all worked, and the one URL a prospect is actually handed,
// or reaches by trimming the path off the /privacy link in Meta's app settings, served
// nothing. Bilingual in one file for the same reason the pages below are: `public/**` has no
// static handler, so anything not named by a route here is unreachable in production.
app.get('/', (req, res) => {
    void sendPublicPage(req, res, 'landing');
});

// Privacy Policy (required by Meta App Review)
app.get('/privacy', (req, res) => {
    void sendPublicPage(req, res, 'privacy');
});

// Terms of Service — TikTok requires a public terms URL (and a privacy URL) before an app can
// be registered at all.
app.get('/terms', (req, res) => {
    void sendPublicPage(req, res, 'terms');
});

// TikTok's URL-property verification: its developer portal hands out a `tiktok<token>.txt` file
// that must be served from the site root. The name and contents are pasted into the dashboard
// (TikTok app settings) rather than committed, so re-verifying never needs a deploy. Anything
// that does not match the saved name is a plain 404.
app.get(/^\/tiktok[A-Za-z0-9_-]{4,100}\.txt$/, async (req, res) => {
    try {
        // Every file ever saved stays servable: TikTok issues one per property, and a new one
        // must not take down the page an earlier property was verified against.
        const file = (await getVerificationFiles()).find((f) => req.path === `/${f.filename}`);
        if (!file) {
            res.status(404).send('Not Found');
            return;
        }
        res.type('text/plain').send(file.content);
    } catch (err) {
        log('error', 'tiktok.verification_file_failed', describeError(err));
        res.status(404).send('Not Found');
    }
});

// The Eid coupon page, served rendered so `data-coupons-expire` carries the date saved in
// Settings → Public site. It used to redirect to the static /dashboard/eid.html, where the
// attribute was a literal nobody filled and nine free-coupon links stayed live for months.
app.get(['/eid', '/eidia'], (req, res) => {
    void sendPublicPage(req, res, 'eid');
});

// Data Deletion Instructions (required by Meta App Review)
app.get('/data-deletion', (req, res) => {
    void sendPublicPage(req, res, 'dataDeletion');
});

// Pricing — the public sales page. Bilingual in one file for the same reason the two pages
// above are: `public/**` has no static handler, so anything not named by a route here is
// unreachable in production.
app.get('/pricing', (req, res) => {
    void sendPublicPage(req, res, 'pricing');
});

// The two root-level files every public page's <head> names. `public/**` has no static
// handler — vercel.json sends only /dashboard/* and /samples/* to static files and everything
// else here — so without these two routes /favicon.svg and /site.webmanifest would 404 on
// every page that links them. A day of caching: both are tiny, and neither carries a ?v=.
const ROOT_ASSET_MAX_AGE = 24 * 60 * 60 * 1000;
app.get('/favicon.svg', (_req, res) => {
    res.type('image/svg+xml');
    res.sendFile(path.join(__dirname, '../public/favicon.svg'), { maxAge: ROOT_ASSET_MAX_AGE });
});
app.get('/site.webmanifest', (_req, res) => {
    res.type('application/manifest+json');
    res.sendFile(path.join(__dirname, '../public/site.webmanifest'), { maxAge: ROOT_ASSET_MAX_AGE });
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
        // `probe` distinguishes diagnose.mjs proving this guard still holds from a real
        // rejection. The two were byte-identical in the logs, which is a trap in an app
        // whose documented worst failure is an invisible signature rejection. It is a
        // label only — see src/utils/probe.ts; a forged tag changes nothing here.
        log('error', 'webhook.signature_rejected', {
            secrets_tried: appSecrets().length,
            instagram_secret_set: Boolean(process.env.INSTAGRAM_APP_SECRET),
            probe: isDiagnosticProbe(req),
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

// ─── Not Found ──────────────────────────────────────────────────────────────
// A browser navigation to a path nothing above claims gets the bilingual public 404 page,
// with a real 404 status. Guarded three ways so nothing else changes:
//   · it is registered LAST, after every route and middleware, so it can only ever see
//     requests nothing else answered;
//   · it never touches /api — that router answers its own unknown paths, and an API client
//     must never be handed HTML;
//   · it fires only when the client accepts text/html. A webhook probe, a curl with an
//     explicit Accept, a fetch() asking for JSON — all fall through to Express's own plain
//     404 exactly as before.
app.use((req, res, next) => {
    if (req.path.startsWith('/api') || !req.accepts('html')) {
        next();
        return;
    }
    void sendPublicPage(req, res, 'notFound', 404);
});

// ─── Start Server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
    log('info', 'server.listening', { port: PORT });
});
