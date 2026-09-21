import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../config/db.js';
import {
    createLegacySession, createSession, requireAuth, createDownloadToken, consumeDownloadToken
} from '../middleware/auth.js';
import axios from 'axios';
import { sendDirectMessage, publishFacebookPost, publishInstagramPost, API_VERSION } from '../services/instagram.js';
import { generateAiResponse } from '../services/ai.js';
import {
    getActiveCreatorId, getTenant, getTenantId, resolveTenant, requireLiveSession,
    assertTenantAccess, listTenantsForSession, interactionsOwnedBy, invalidateTenantCache
} from '../services/tenant.js';
import { encryptSecret, decryptSecret, verifyPassword } from '../config/crypto.js';
import { pruneRateLimitData } from '../utils/rateLimiter.js';
import { pruneRawPayloads } from '../services/retention.js';
import { drainWorker } from '../jobs/drain.js';
import { describeError, log } from '../utils/log.js';
import { getMediaStore } from '../services/storage.js';
import adminRouter from './admin.js';


const router = Router();

/**
 * Constant-time string comparison.
 *
 * Hashing both sides first means `timingSafeEqual` always gets two equal-length buffers —
 * it throws on a length mismatch, and the length of the thrown-vs-returned path is itself
 * an oracle for the secret's length.
 */
function secretEquals(a: string, b: string): boolean {
    return crypto.timingSafeEqual(
        crypto.createHash('sha256').update(a).digest(),
        crypto.createHash('sha256').update(b).digest()
    );
}

// ─── Security headers ───────────────────────────────────────────────────────
// Mounted in src/index.ts. They cannot live in vercel.json: that file is still on the legacy
// `builds` + `routes` schema, which rejects a `headers` key outright.

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
    // `'unsafe-inline'` is here only because the dashboard renders inline onclick handlers
    // (dashboard/js/pages/campaigns.js, activity.js). Drop it from script-src once those
    // become delegated listeners — the rest of the policy already holds without it.
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        // Post previews are served straight off Meta's CDN, whose hostnames rotate.
        "img-src 'self' data: blob: https:",
        "media-src 'self' data: blob: https:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ].join('; '));
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
}

// ─── Auth ───────────────────────────────────────────────────────────────────

/**
 * Login throttle.
 *
 * Per-instance, so it is a speed bump and not a guarantee: Vercel keeps as many warm lambdas
 * as it likes and each one starts this Map empty, so an attacker spreading attempts across
 * instances multiplies the limit by however many are running. A shared store is the real fix
 * — the same one `rate_limit_counters` would be if it did not require a creator FK.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FREE_ATTEMPTS = 5;
const LOGIN_MAX_DELAY_MS = 5 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; windowStart: number; last: number }>();

function clientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    return (first || req.socket.remoteAddress || 'unknown').trim();
}

/** Seconds this IP must still wait, or 0 when it may try now. */
function loginRetryAfter(ip: string): number {
    const record = loginAttempts.get(ip);
    if (!record) return 0;

    const now = Date.now();
    if (now - record.windowStart > LOGIN_WINDOW_MS) {
        loginAttempts.delete(ip);
        return 0;
    }
    if (record.count <= LOGIN_FREE_ATTEMPTS) return 0;

    const delay = Math.min(2 ** (record.count - LOGIN_FREE_ATTEMPTS) * 1000, LOGIN_MAX_DELAY_MS);
    const remaining = record.last + delay - now;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

function recordLoginFailure(ip: string): void {
    const now = Date.now();
    const record = loginAttempts.get(ip);

    if (record && now - record.windowStart <= LOGIN_WINDOW_MS) {
        record.count += 1;
        record.last = now;
    } else {
        loginAttempts.set(ip, { count: 1, windowStart: now, last: now });
    }

    // Sweep stale entries occasionally so a spray across many IPs cannot grow the map forever.
    if (loginAttempts.size > 1000) {
        for (const [seen, entry] of loginAttempts) {
            if (now - entry.windowStart > LOGIN_WINDOW_MS) loginAttempts.delete(seen);
        }
    }
}

/**
 * The tenant a freshly logged-in user starts in.
 *
 * Their first membership, ordered so it is the same one every time. A platform_admin may hold
 * no memberships at all — they can see every tenant — so they fall back to whichever creator
 * is active, and switch from there via /auth/switch-tenant.
 */
async function initialTenantFor(userId: string, role: string): Promise<string | null> {
    const res = await pool.query(
        `SELECT creator_id FROM memberships WHERE user_id = $1 ORDER BY created_at, creator_id LIMIT 1`,
        [userId]
    );
    if (res.rows[0]?.creator_id) return res.rows[0].creator_id;
    return role === 'platform_admin' ? getActiveCreatorId() : null;
}

router.post('/auth/login', async (req, res) => {
    const ip = clientIp(req);
    const retryAfter = loginRetryAfter(ip);
    if (retryAfter > 0) {
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({ error: `Too many login attempts. Try again in ${retryAfter}s.` });
        return;
    }

    const { email, password } = req.body;
    const dashboardPassword = process.env.DASHBOARD_PASSWORD;

    // ── User account login ──────────────────────────────────────────────────
    // Only when an email is actually supplied. Everything below this block is the original
    // shared-password path, untouched: it is the operator's only way in and predates user
    // accounts entirely, so it keeps working exactly as before.
    if (typeof email === 'string' && email.trim()) {
        try {
            const userRes = await pool.query(
                `SELECT id, password_hash, role, token_version, is_active
                   FROM users WHERE lower(email) = lower($1)`,
                [email.trim()]
            );
            const user = userRes.rows[0];

            // One message for "no such user", "wrong password" and "disabled account" — the
            // distinction is free account enumeration otherwise. The throttle counts all three.
            const ok = user && user.is_active
                && typeof password === 'string'
                && await verifyPassword(password, user.password_hash);

            if (!ok) {
                recordLoginFailure(ip);
                res.status(401).json({ error: 'Invalid email or password.' });
                return;
            }

            loginAttempts.delete(ip);

            const tenantId = await initialTenantFor(user.id, user.role);
            const token = createSession({
                userId: user.id,
                role: user.role === 'platform_admin' ? 'platform_admin' : 'user',
                tenantId,
                tokenVersion: user.token_version,
            });

            await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

            // `token` and `expiresIn` are what the dashboard reads; the rest is additive.
            res.json({ token, expiresIn: '24h', userId: user.id, role: user.role, tenantId });
        } catch (err) {
            log('error', 'api.login_failed', describeError(err));
            res.status(500).json({ error: 'Login failed.' });
        }
        return;
    }

    if (!dashboardPassword) {
        log('error', 'auth.dashboard_password_unset');
        res.status(500).json({ error: 'Dashboard authentication is not configured.' });
        return;
    }

    if (typeof password !== 'string' || !secretEquals(password, dashboardPassword)) {
        recordLoginFailure(ip);
        res.status(401).json({ error: 'Invalid password.' });
        return;
    }

    loginAttempts.delete(ip);

    try {
        // createSession throws when a signing secret is missing rather than falling back to a
        // published default. Keep that a JSON 500 — the dashboard only parses JSON.
        //
        // This is the pre-tenancy shared-password login. It mints a platform_admin session
        // bound to whichever creator is active, which is exactly what every call site used to
        // assume implicitly. Once user accounts exist this becomes one of two login paths,
        // not the only one.
        const tenantId = await getActiveCreatorId();
        const token = createLegacySession(tenantId);
        res.json({ token, expiresIn: '24h' });
    } catch (err) {
        log('error', 'api.legacy_login_failed', describeError(err));
        res.status(500).json({ error: 'Dashboard authentication is not configured.' });
    }
});

// ─── Scheduled / machine-triggered endpoints ────────────────────────────────

/**
 * Shared bearer guard for the endpoints a scheduler calls.
 *
 * Returns false having already answered, so callers read as `if (!requireCronSecret(...))
 * return;`. Extracted when the drain endpoint arrived: two copies of a fail-closed auth check
 * is one copy too many, and this is the guard whose earlier `if (cronSecret && ...)` form
 * skipped itself entirely when the variable was unset.
 */
function requireCronSecret(req: Request, res: Response, route: string): boolean {
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
        log('error', 'cron.secret_missing', { route });
        res.status(500).json({ error: 'CRON_SECRET not configured.' });
        return false;
    }

    // Header only: a ?token= variant ends up in Vercel's access logs for their whole retention.
    const authHeader = req.headers['authorization'];
    if (typeof authHeader !== 'string' || !secretEquals(authHeader, `Bearer ${cronSecret}`)) {
        log('warn', 'cron.unauthorized', { route });
        res.status(401).json({ error: 'Unauthorized cron request.' });
        return false;
    }

    return true;
}

/**
 * Drain the job queue.
 *
 * This is the endpoint that makes the queue real. `vercel.json` can only schedule one cron a
 * day on the Hobby plan, which is why `scheduled_time` is effectively day-granular despite a
 * minute-precision UI — but nothing stops an *external* scheduler (QStash, GitHub Actions,
 * cron-job.org, an uptime pinger) calling this every minute with the same bearer token. Doing
 * so costs nothing here and is the single change that takes the architecture from
 * "opportunistic" to "durable": see ARCHITECTURE.md, stage 2.
 *
 * Idempotent and safe to call concurrently — the claim is atomic (`FOR UPDATE SKIP LOCKED`),
 * so two overlapping callers split the work rather than duplicating it.
 */
router.get('/jobs/drain', async (req, res) => {
    if (!requireCronSecret(req, res, '/api/jobs/drain')) return;

    try {
        const result = await drainWorker();
        res.json(result);
    } catch (err) {
        log('error', 'job.drain_endpoint_failed', describeError(err));
        res.status(500).json({ error: 'Drain failed.' });
    }
});

// ─── Cron: Publish Scheduled Posts ──────────────────────────────────────────

router.get('/cron/publish', async (req, res) => {
    if (!requireCronSecret(req, res, '/api/cron/publish')) return;

    try {
        log('info', 'cron.publish_start');

        // Release claims from runs that died mid-publish. Without this a lambda that timed out
        // leaves the row in PUBLISHING forever and nothing ever picks it up again.
        const reaped = await pool.query(`
            UPDATE scheduled_posts
               SET status = 'PENDING'
             WHERE status = 'PUBLISHING'
               AND claimed_at < NOW() - INTERVAL '15 minutes'
               AND attempts < 5
         RETURNING id
        `);
        if (reaped.rows.length > 0) {
            log('warn', 'cron.publish_claims_released', { count: reaped.rows.length });
        }

        // Past five tries it is not a transient failure; stop retrying it every day forever.
        await pool.query(`
            UPDATE scheduled_posts
               SET status = 'FAILED',
                   error_log = 'Abandoned after 5 publish attempts — each claim went stale without completing. Check the access token and the media URL, then re-save the post to retry.'
             WHERE status = 'PUBLISHING'
               AND claimed_at < NOW() - INTERVAL '15 minutes'
               AND attempts >= 5
        `);

        await pruneRateLimitData();
        await pruneRawPayloads();

        // The daily cron is also the backstop drain. If no external scheduler is calling
        // /api/jobs/drain, this is what eventually picks up work that was enqueued while an
        // invocation was being frozen — once a day is poor, but it is bounded, where before
        // that work was simply gone.
        await drainWorker();

        // Find pending posts due for publishing
        const result = await pool.query(`
            SELECT s.*, c.page_access_token, c.instagram_page_id, c.facebook_page_id
            FROM scheduled_posts s
            JOIN creators c ON c.id = s.creator_id
            WHERE s.status = 'PENDING' AND s.scheduled_time <= NOW()
            ORDER BY s.scheduled_time ASC
        `);

        if (result.rows.length === 0) {
            log('info', 'cron.publish_none_due');
            res.json({ message: 'No pending posts to publish.' });
            return;
        }

        log('info', 'cron.publish_due', { count: result.rows.length });
        const publishedIds: string[] = [];
        let claimed = 0;

        for (const post of result.rows) {
            // Claim atomically. The old SELECT-then-UPDATE let two concurrent cron hits both
            // read the row as PENDING and both publish it — a duplicate reel on the live
            // account, which cannot be undone from here.
            const claim = await pool.query(
                `UPDATE scheduled_posts
                    SET status = 'PUBLISHING', claimed_at = NOW(), attempts = attempts + 1
                  WHERE id = $1 AND status = 'PENDING'
              RETURNING id`,
                [post.id]
            );

            if ((claim.rowCount ?? 0) === 0) {
                log('info', 'cron.publish_already_claimed', { post_id: post.id });
                continue;
            }

            claimed++;
            log('info', 'cron.publish_claimed', {
                post_id: post.id, platform: post.platform, post_type: post.post_type,
            });

            try {
                let fbId: string | null = null;
                let igId: string | null = null;

                // Read straight off the joined creator row, so it has not been through the
                // tenant service's decryption — do it here.
                const token = decryptSecret(post.page_access_token);

                // 1. Publish to Facebook
                if (post.platform === 'facebook' || post.platform === 'both') {
                    if (!post.facebook_page_id) {
                        throw new Error('Facebook Page ID is missing for this creator.');
                    }
                    log('info', 'publish.facebook_start', { post_id: post.id });
                    const fbRes = await publishFacebookPost(
                        post.facebook_page_id,
                        post.post_type,
                        post.caption || '',
                        post.media_url,
                        token
                    );
                    fbId = fbRes.id || fbRes.post_id;
                    log('info', 'publish.facebook_done', { post_id: post.id, fb_post_id: fbId });
                }

                // 2. Publish to Instagram
                if (post.platform === 'instagram' || post.platform === 'both') {
                    if (!post.instagram_page_id) {
                        throw new Error('Instagram Account ID is missing for this creator.');
                    }
                    if (!post.media_url) {
                        throw new Error('Instagram requires a media URL to publish.');
                    }
                    log('info', 'publish.instagram_start', { post_id: post.id });
                    const igRes = await publishInstagramPost(
                        post.instagram_page_id,
                        post.post_type,
                        post.caption || '',
                        post.media_url,
                        token,
                        post.cover_url
                    );
                    igId = igRes.id;
                    log('info', 'publish.instagram_done', { post_id: post.id, ig_media_id: igId });
                }

                // Format published ID string
                let resultId = '';
                if (fbId && igId) {
                    resultId = `FB:${fbId} | IG:${igId}`;
                } else if (fbId) {
                    resultId = `FB:${fbId}`;
                } else if (igId) {
                    resultId = `IG:${igId}`;
                }

                await pool.query(
                    `UPDATE scheduled_posts 
                     SET status = 'PUBLISHED', published_post_id = $1, error_log = NULL 
                     WHERE id = $2`,
                    [resultId, post.id]
                );

                publishedIds.push(post.id);

            } catch (err: any) {
                log('error', 'cron.publish_failed', { post_id: post.id, ...describeError(err) });
                await pool.query(
                    `UPDATE scheduled_posts 
                     SET status = 'FAILED', error_log = $1 
                     WHERE id = $2`,
                    [err.message, post.id]
                );
            }
        }

        res.json({
            message: `Publishing sequence complete.`,
            processed: claimed,
            published: publishedIds
        });

    } catch (err: any) {
        log('error', 'cron.publish_error', describeError(err));
        res.status(500).json({ error: 'Cron publisher failed.' });
    }
});

/** What /upload will store, and therefore all this route will ever claim to be serving. */
const ALLOWED_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'video/quicktime',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A `/:id` that is not a uuid cannot match any row, but Postgres raises 22P02 on the malformed
 * literal before it gets that far — which surfaced as a 500 for what is really a 404.
 */
function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Decoded bytes, not base64 characters — see the note in POST /upload. */
const MAX_UPLOAD_BYTES = 3.2 * 1024 * 1024;

// Deliberately unauthenticated: Meta cURLs this URL itself when it ingests the media, so it
// has to be publicly fetchable. Everything below assumes the caller is hostile.
router.get('/uploads/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Postgres raises 22P02 on a malformed uuid literal, which surfaced as a 500 for what
        // is really just a URL that cannot match anything.
        if (!id || !UUID_PATTERN.test(id)) {
            res.status(404).send('Not Found');
            return;
        }

        const media = await getMediaStore().get(id);

        if (!media) {
            res.status(404).send('Not Found');
            return;
        }

        // Rows predating the upload allowlist can hold any string, and this origin also serves
        // the dashboard — an echoed text/html would be same-origin script. Serve anything
        // unrecognised as an opaque download instead.
        const contentType = ALLOWED_MIME_TYPES.has(media.mimeType) ? media.mimeType : 'application/octet-stream';

        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
        res.send(media.data);
    } catch (err) {
        log('error', 'media.serve_failed', describeError(err));
        res.status(500).send('Internal Server Error');
    }
});

// ─── Export Interactions (CSV download) ──────────────────────────────────────
//
// Sits above the blanket `requireAuth` because the dashboard reaches it with a plain browser
// navigation, which cannot set an Authorization header. Instead of putting the 24h session
// token in the query string — where Vercel's access logs, the browser history and any
// outbound Referer all keep a copy — the dashboard first POSTs to /interactions/export/token
// and spends the 60-second token it gets back.

const EXPORT_DOWNLOAD_SCOPE = 'interactions-export';

/**
 * The export runs above the auth boundary, so it has no session to read a tenant from — and
 * an unscoped export of every tenant's interactions is the largest single leak in this file.
 *
 * The tenant therefore travels inside the download token: `<tenantId>~<one-shot token>`, where
 * the token is minted over the path key `interactions-export:<tenantId>`. Editing the tenant
 * half invalidates the HMAC, so the value is self-authenticating. The dashboard treats the
 * whole string as opaque and passes it straight back, so nothing there changes.
 *
 * Exported only so the pairing with parseExportDownload can be tested directly.
 */
export function exportScopeFor(tenantId: string): string {
    return `${EXPORT_DOWNLOAD_SCOPE}:${tenantId}`;
}

/** Split `<tenantId>~<token>` back apart. Returns null for anything that is not that shape. */
export function parseExportDownload(raw: unknown): { tenantId: string; token: string } | null {
    if (typeof raw !== 'string') return null;
    const separator = raw.indexOf('~');
    if (separator <= 0) return null;

    const tenantId = raw.slice(0, separator);
    const token = raw.slice(separator + 1);
    if (!UUID_PATTERN.test(tenantId) || !token) return null;

    return { tenantId, token };
}

/**
 * Excel and Sheets evaluate any cell whose text begins with one of these. `sender_username`
 * is a Facebook display name, so the attacker picks it.
 */
function csvCell(value: unknown): string {
    const text = value === null || value === undefined ? '' : String(value);
    const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return guarded.replace(/"/g, '""');
}

/** `new Date(null).toISOString()` throws RangeError and took the whole export down with it. */
function csvTimestamp(value: unknown): string {
    if (!value) return '';
    const parsed = new Date(value as string);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

router.get('/interactions/export', async (req, res) => {
    const download = parseExportDownload(req.query.dl);
    if (!download || !consumeDownloadToken(download.token, exportScopeFor(download.tenantId))) {
        res.status(401).json({ error: 'Download link expired or already used — start the export again.' });
        return;
    }

    try {
        const platform = req.query.platform as string;
        const campaign_id = req.query.campaign_id as string;
        const status = req.query.status as string;
        const search = req.query.search as string;

        const params: any[] = [download.tenantId];
        const conditions: string[] = [interactionsOwnedBy(1)];

        if (status && ['SENT', 'FAILED', 'PENDING'].includes(status)) {
            params.push(status);
            conditions.push(`i.status = $${params.length}`);
        }

        if (search) {
            params.push(`%${search}%`);
            conditions.push(`i.sender_username ILIKE $${params.length}`);
        }

        if (platform && ['instagram', 'facebook'].includes(platform)) {
            params.push(platform);
            conditions.push(`i.platform = $${params.length}`);
        }

        if (campaign_id) {
            params.push(campaign_id);
            conditions.push(`i.campaign_id = $${params.length}`);
        }

        const whereClause = 'WHERE ' + conditions.join(' AND ');

        const dataQuery = `
            SELECT
                i.timestamp,
                i.sender_username,
                i.platform,
                c.trigger_keyword,
                i.post_id,
                i.status,
                i.error_log
            FROM interactions i
            LEFT JOIN campaigns c ON c.id = i.campaign_id
            ${whereClause}
            ORDER BY i.timestamp DESC
        `;

        const result = await pool.query(dataQuery, params);

        let csv = 'Timestamp,Username,Platform,Matched Keyword,Post ID,Status,Errors\n';
        for (const row of result.rows) {
            const time = csvTimestamp(row.timestamp);
            const username = csvCell(row.sender_username);
            const plat = csvCell(row.platform);
            const keyword = csvCell(row.trigger_keyword);
            const postId = csvCell(row.post_id);
            const stat = csvCell(row.status);
            const error = csvCell(row.error_log);

            csv += `"${time}","${username}","${plat}","${keyword}","${postId}","${stat}","${error}"\n`;
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=interactions_export.csv');
        res.status(200).send(csv);
    } catch (err) {
        log('error', 'api.export_failed', describeError(err));
        res.status(500).json({ error: 'Failed to export interactions.' });
    }
});

// ─── All routes below require authentication ────────────────────────────────
router.use(requireAuth);

// ...and a session that has not been revoked. `users.token_version` is the only kill switch
// there is for a 24h stateless token, and checking it here means it covers the admin router
// below as well as every tenant-scoped route.
router.use(requireLiveSession);

// ─── Platform admin ─────────────────────────────────────────────────────────
//
// Mounted *above* resolveTenant on purpose. resolveTenant 409s when the deployment has no
// creator at all, which is precisely the state POST /api/admin/tenants exists to fix — behind
// it, the first-run endpoint would be unreachable on exactly the deployment that needs it.
// The sub-router carries its own platform_admin guard.
router.use('/admin', adminRouter);

// ─── Session identity ───────────────────────────────────────────────────────
//
// Also above resolveTenant: a user holding no membership, or an admin on a deployment with no
// creators yet, must still be able to ask who they are and what they can switch into. Behind
// resolveTenant both would get a 409 and the switcher would have nothing to render.

/** Who am I, and which tenants may I act as — the tenant switcher's data source. */
router.get('/auth/me', async (req, res) => {
    try {
        const session = req.session!;
        const tenants = await listTenantsForSession(session);

        // A legacy shared-password session carries no tenant — resolveTenant fills one in, and
        // this route runs before that. Resolve it the same way resolveTenant would, so what the
        // switcher shows is what the rest of the API will actually act as. Null here is the
        // honest first-run answer: no creator exists yet.
        const tenantId = session.tenantId
            ?? (session.role === 'platform_admin' ? await getActiveCreatorId() : tenants[0]?.id ?? null);

        res.json({
            userId: session.userId,
            role: session.role,
            tenantId,
            tenants,
        });
    } catch (err) {
        log('error', 'api.session_identity_failed', describeError(err));
        res.status(500).json({ error: 'Failed to read session identity.' });
    }
});

/**
 * Swap the acting tenant.
 *
 * Mints a new token rather than mutating anything server-side: the session is a stateless
 * HMAC, so the tenant it carries can only change by issuing a different one. The old token
 * stays valid for its remaining TTL against its own tenant, which is correct — it was already
 * authorised for that one.
 */
router.post('/auth/switch-tenant', async (req, res) => {
    try {
        const session = req.session!;
        const tenantId = req.body?.tenantId;

        if (typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId)) {
            res.status(400).json({ error: 'A tenantId is required.' });
            return;
        }

        const permitted = await assertTenantAccess({
            userId: session.userId, role: session.role, tenantId
        });
        if (!permitted) {
            // 404 rather than 403, matching resolveTenant: confirming a tenant exists is
            // itself a disclosure.
            res.status(404).json({ error: 'Not found.' });
            return;
        }

        const token = createSession({
            userId: session.userId,
            role: session.role,
            tenantId,
            tokenVersion: session.tokenVersion,
        });
        res.json({ token, expiresIn: '24h', tenantId });
    } catch (err) {
        log('error', 'api.switch_tenant_failed', describeError(err));
        res.status(500).json({ error: 'Failed to switch tenant.' });
    }
});

// ─── Everything below acts as exactly one tenant ────────────────────────────
// resolveTenant pins it and enforces the membership check, so no route has to remember to.
// `getTenantId(req)` throws rather than falling back to "the first active creator" — that
// silent fallback is the bug this whole layer exists to remove — which is why it is safe to
// call inline inside a query.
router.use(resolveTenant);

// ─── Dashboard Stats ────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const owned = interactionsOwnedBy(1);

        // `activeCreators` is the one count here that is not about the tenant's own data. For a
        // platform_admin it stays what it always was — how many creators the deployment runs.
        // For a normal user that number is meaningless and mildly disclosive, so they get the
        // count of tenants they can actually see, which is what the tile means to them.
        const creatorsQuery = req.session?.role === 'platform_admin'
            ? pool.query('SELECT COUNT(*)::int as count FROM creators WHERE is_active = true')
            : pool.query(
                `SELECT COUNT(*)::int as count
                   FROM memberships m JOIN creators c ON c.id = m.creator_id
                  WHERE m.user_id = $1 AND c.is_active = true`,
                [req.session?.userId]
            );

        const [total, sent, failed, campaigns, creators, today, uniqueUsers, instagram, facebook] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int as count FROM interactions i WHERE ${owned}`, [tenantId]),
            pool.query(`SELECT COUNT(*)::int as count FROM interactions i WHERE ${owned} AND i.status = 'SENT'`, [tenantId]),
            pool.query(`SELECT COUNT(*)::int as count FROM interactions i WHERE ${owned} AND i.status = 'FAILED'`, [tenantId]),
            pool.query('SELECT COUNT(*)::int as count FROM campaigns WHERE creator_id = $1', [tenantId]),
            creatorsQuery,
            pool.query(`SELECT COUNT(*)::int as count FROM interactions i WHERE ${owned} AND i.timestamp > NOW() - INTERVAL '24 hours'`, [tenantId]),
            pool.query(`SELECT COUNT(DISTINCT i.sender_username)::int as count FROM interactions i WHERE ${owned}`, [tenantId]),
            pool.query(`SELECT COUNT(*)::int as count FROM interactions i WHERE ${owned} AND i.platform = 'instagram'`, [tenantId]),
            pool.query(`SELECT COUNT(*)::int as count FROM interactions i WHERE ${owned} AND i.platform = 'facebook'`, [tenantId]),
        ]);

        const totalCount = total.rows[0].count;
        const sentCount = sent.rows[0].count;

        res.json({
            totalInteractions: totalCount,
            sent: sentCount,
            failed: failed.rows[0].count,
            successRate: totalCount > 0 ? Math.round((sentCount / totalCount) * 100) : 0,
            activeCampaigns: campaigns.rows[0].count,
            activeCreators: creators.rows[0].count,
            todayActivity: today.rows[0].count,
            uniqueUsersReached: uniqueUsers.rows[0].count,
            instagramCount: instagram.rows[0].count,
            facebookCount: facebook.rows[0].count,
        });
    } catch (err) {
        log('error', 'api.stats_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

// ─── Hourly Stats (for chart) ───────────────────────────────────────────────

/**
 * The window these charts look back over, in days.
 *
 * `parseInt(...) || 7` kept this out of injection range, but it let anything through that
 * parsed as a number — and `?days=99999999999` reached Postgres and failed the whole request
 * with "interval field value out of range". Clamped, then bound as a parameter.
 */
function clampDays(raw: unknown, fallback: number): number {
    const parsed = parseInt(raw as string, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, 365);
}

router.get('/stats/hourly', async (req, res) => {
    try {
        const days = clampDays(req.query.days, 7);
        const result = await pool.query(`
            SELECT
                DATE_TRUNC('hour', i.timestamp) as hour,
                COUNT(*) FILTER (WHERE i.status = 'SENT')::int as sent,
                COUNT(*) FILTER (WHERE i.status = 'FAILED')::int as failed
            FROM interactions i
            WHERE ${interactionsOwnedBy(1)}
              AND i.timestamp > NOW() - ($2::text || ' days')::interval
            GROUP BY hour
            ORDER BY hour ASC
        `, [getTenantId(req), String(days)]);
        res.json(result.rows);
    } catch (err) {
        log('error', 'api.stats_hourly_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch hourly stats.' });
    }
});

// ─── Daily Stats (for chart) ────────────────────────────────────────────────

router.get('/stats/daily', async (req, res) => {
    try {
        const days = clampDays(req.query.days, 30);
        const result = await pool.query(`
            SELECT
                DATE_TRUNC('day', i.timestamp)::date as day,
                COUNT(*) FILTER (WHERE i.status = 'SENT')::int as sent,
                COUNT(*) FILTER (WHERE i.status = 'FAILED')::int as failed
            FROM interactions i
            WHERE ${interactionsOwnedBy(1)}
              AND i.timestamp > NOW() - ($2::text || ' days')::interval
            GROUP BY day
            ORDER BY day ASC
        `, [getTenantId(req), String(days)]);
        res.json(result.rows);
    } catch (err) {
        log('error', 'api.stats_daily_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch daily stats.' });
    }
});

// ─── Campaigns CRUD ─────────────────────────────────────────────────────────

router.get('/campaigns', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                c.*,
                COUNT(i.id)::int as total_interactions,
                COUNT(i.id) FILTER (WHERE i.status = 'SENT')::int as sent_count,
                COUNT(i.id) FILTER (WHERE i.status = 'FAILED')::int as failed_count
            FROM campaigns c
            LEFT JOIN interactions i ON i.campaign_id = c.id
            WHERE c.creator_id = $1
            GROUP BY c.id
            ORDER BY c.created_at DESC
        `, [getTenantId(req)]);
        res.json(result.rows);
    } catch (err) {
        log('error', 'api.campaigns_list_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch campaigns.' });
    }
});

router.post('/campaigns', async (req, res) => {
    try {
        const { trigger_keyword, dm_template, public_reply_template, post_id, is_active } = req.body;

        if (!trigger_keyword || !dm_template) {
            res.status(400).json({ error: 'trigger_keyword and dm_template are required.' });
            return;
        }

        // `creator_id` in the request body is deliberately ignored: honouring it would let any
        // session create a campaign inside another tenant. The session decides the owner, and
        // only the session. Use /auth/switch-tenant to write somewhere else.
        const creatorId = getTenantId(req);

        const result = await pool.query(
            `INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template, post_id, is_active)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [creatorId, trigger_keyword, dm_template, public_reply_template || null, post_id || null, is_active !== false]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        log('error', 'api.campaign_create_failed', describeError(err));
        res.status(500).json({ error: 'Failed to create campaign.' });
    }
});

router.put('/campaigns/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { trigger_keyword, dm_template, public_reply_template, post_id, is_active } = req.body;

        if (!isUuid(id)) {
            res.status(404).json({ error: 'Campaign not found.' });
            return;
        }

        const result = await pool.query(
            `UPDATE campaigns 
             SET trigger_keyword = COALESCE($1, trigger_keyword),
                 dm_template = COALESCE($2, dm_template),
                 public_reply_template = $3,
                 post_id = $4,
                 is_active = COALESCE($5, is_active)
             WHERE id = $6 AND creator_id = $7 RETURNING *`,
            [
                trigger_keyword,
                dm_template,
                public_reply_template || null,
                post_id || null,
                typeof is_active === 'boolean' ? is_active : null,
                id,
                getTenantId(req)
            ]
        );

        // No row means either no such campaign or one belonging to someone else. Both are 404:
        // the difference is exactly the information an attacker is probing for.
        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Campaign not found.' });
            return;
        }
        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'api.campaign_update_failed', describeError(err));
        res.status(500).json({ error: 'Failed to update campaign.' });
    }
});

router.delete('/campaigns/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!isUuid(id)) {
            res.status(404).json({ error: 'Campaign not found.' });
            return;
        }

        // The `AND creator_id` here is the whole point: unscoped, this endpoint let any
        // authenticated session delete any tenant's campaign by id.
        const result = await pool.query(
            'DELETE FROM campaigns WHERE id = $1 AND creator_id = $2 RETURNING id',
            [id, getTenantId(req)]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Campaign not found.' });
            return;
        }
        res.json({ message: 'Campaign deleted.', id: result.rows[0].id });
    } catch (err) {
        log('error', 'api.campaign_delete_failed', describeError(err));
        res.status(500).json({ error: 'Failed to delete campaign.' });
    }
});

// ─── Campaigns Stats Leaderboard ─────────────────────────────────────────────

router.get('/stats/campaigns', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                c.id,
                c.trigger_keyword,
                COUNT(i.id)::int as total_triggers,
                COUNT(i.id) FILTER (WHERE i.status = 'SENT')::int as sent_count,
                COUNT(i.id) FILTER (WHERE i.status = 'FAILED')::int as failed_count
            FROM campaigns c
            LEFT JOIN interactions i ON i.campaign_id = c.id
            WHERE c.creator_id = $1
            GROUP BY c.id, c.trigger_keyword
            ORDER BY total_triggers DESC
            LIMIT 5
        `, [getTenantId(req)]);
        res.json(result.rows);
    } catch (err) {
        log('error', 'api.campaign_stats_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch campaign stats.' });
    }
});

// ─── Export Interactions (CSV Exporter) ──────────────────────────────────────
// The download itself is registered above the auth boundary and carries its own one-shot
// token; this is the authenticated half that hands that token out.

router.post('/interactions/export/token', (req, res) => {
    // The tenant rides along in the token string (see parseExportDownload) because the
    // download itself runs above the auth boundary and has no session to read.
    const tenantId = getTenantId(req);
    res.json({ token: `${tenantId}~${createDownloadToken(exportScopeFor(tenantId))}` });
});

// ─── Interactions (Activity Log) ────────────────────────────────────────────

router.get('/interactions', async (req, res) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const status = req.query.status as string;
        const search = req.query.search as string;
        const platform = req.query.platform as string;
        const campaign_id = req.query.campaign_id as string;
        const offset = (page - 1) * limit;

        const params: any[] = [getTenantId(req)];
        const conditions: string[] = [interactionsOwnedBy(1)];

        if (status && ['SENT', 'FAILED', 'PENDING'].includes(status)) {
            params.push(status);
            conditions.push(`i.status = $${params.length}`);
        }

        if (search) {
            params.push(`%${search}%`);
            conditions.push(`i.sender_username ILIKE $${params.length}`);
        }

        if (platform && ['instagram', 'facebook'].includes(platform)) {
            params.push(platform);
            conditions.push(`i.platform = $${params.length}`);
        }

        if (campaign_id) {
            params.push(campaign_id);
            conditions.push(`i.campaign_id = $${params.length}`);
        }

        const whereClause = 'WHERE ' + conditions.join(' AND ');

        const countQuery = `SELECT COUNT(*)::int as total FROM interactions i ${whereClause}`;
        const countResult = await pool.query(countQuery, params);

        const dataParams = [...params, limit, offset];
        const dataQuery = `
            SELECT 
                i.*,
                c.trigger_keyword
            FROM interactions i
            LEFT JOIN campaigns c ON c.id = i.campaign_id
            ${whereClause}
            ORDER BY i.timestamp DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

        const dataResult = await pool.query(dataQuery, dataParams);

        res.json({
            data: dataResult.rows,
            pagination: {
                page,
                limit,
                total: countResult.rows[0].total,
                totalPages: Math.ceil(countResult.rows[0].total / limit),
            }
        });
    } catch (err) {
        log('error', 'api.interactions_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch interactions.' });
    }
});

// ─── Settings: Token Management ─────────────────────────────────────────────

/**
 * Record what Meta just said about a token, so the admin tenant list has something real to
 * show. Without this, `token_status` only ever changes when a token is saved, and a token
 * that expired last week still reads as the status it had the day it was pasted in.
 *
 * Best-effort: a failed write must not turn a successful status check into an error.
 */
async function recordTokenStatus(
    creatorId: string, status: 'valid' | 'invalid', error: string | null
): Promise<void> {
    try {
        await pool.query(
            `UPDATE creators
                SET token_status = $1, token_last_checked_at = NOW(), token_error = $2
              WHERE id = $3`,
            [status, error, creatorId]
        );
    } catch (err) {
        log('warn', 'token.status_record_failed', { message: (err as Error).message });
    }
}

router.get('/settings/token/status', async (req, res) => {
    try {
        const creatorId = getTenantId(req);
        const creator = await getTenant(creatorId, [
            'id', 'instagram_page_id', 'facebook_page_id', 'is_active', 'page_access_token'
        ]);

        if (!creator) {
            res.json({ status: 'no_creator', message: 'No creator account found.' });
            return;
        }

        // Already decrypted by getTenant — every creator read goes through one place.
        const token = creator.page_access_token;

        // Validate token against Meta API
        try {
            const debugRes = await axios.get('https://graph.facebook.com/debug_token', {
                params: { input_token: token, access_token: token }
            });

            const data = debugRes.data.data;
            await recordTokenStatus(
                creatorId,
                data.is_valid ? 'valid' : 'invalid',
                data.is_valid ? null : 'Meta reported the token as not valid.'
            );
            res.json({
                status: data.is_valid ? 'valid' : 'invalid',
                type: data.type,
                expiresAt: data.expires_at ? new Date(data.expires_at * 1000).toISOString() : null,
                scopes: data.scopes || [],
                instagramPageId: creator.instagram_page_id,
                facebookPageId: creator.facebook_page_id,
                pageId: creator.instagram_page_id,   // backwards compat
                isActive: creator.is_active,
            });
        } catch (metaErr: any) {
            await recordTokenStatus(
                creatorId, 'invalid',
                metaErr?.response?.data?.error?.message || 'Token validation call to Meta failed.'
            );
            res.json({
                status: 'invalid',
                message: 'Token validation failed — token may be expired or revoked.',
                instagramPageId: creator.instagram_page_id,
                facebookPageId: creator.facebook_page_id,
                pageId: creator.instagram_page_id,
                isActive: creator.is_active,
            });
        }
    } catch (err) {
        log('error', 'token.status_failed', describeError(err));
        res.status(500).json({ error: 'Failed to check token status.' });
    }
});

router.post('/settings/token', async (req, res) => {
    try {
        let { token } = req.body;

        if (!token) {
            res.status(400).json({ error: 'Token is required.' });
            return;
        }

        // Attempt to extend the token lifetime automatically
        const appId = process.env.META_APP_ID;
        const appSecret = process.env.META_APP_SECRET;
        if (appId && appSecret) {
            try {
                const extendRes = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
                    params: {
                        grant_type: 'fb_exchange_token',
                        client_id: appId,
                        client_secret: appSecret,
                        fb_exchange_token: token
                    }
                });
                if (extendRes.data && extendRes.data.access_token) {
                    token = extendRes.data.access_token;
                    log('info', 'token.extended');
                }
            } catch (extendErr: any) {
                log('warn', 'token.extend_skipped', describeError(extendErr));
                // Continue with the original token if extension fails
            }
        }

        // Validate the new token
        const debugRes = await axios.get('https://graph.facebook.com/debug_token', {
            params: { input_token: token, access_token: token }
        });

        const data = debugRes.data.data;

        if (!data.is_valid) {
            res.status(400).json({ error: 'Invalid token — Meta rejected it.' });
            return;
        }

        if (data.type !== 'PAGE') {
            res.status(400).json({ error: `Wrong token type: "${data.type}". You need a PAGE Access Token.` });
            return;
        }

        // Update the token in the database. Scoped to the session's tenant: the unscoped
        // `WHERE is_active = true` overwrote every active creator's token with this one.
        //
        // Encrypted on the way in. This is the write that migrates a legacy plaintext row —
        // there is no separate migration step, the row converts the next time it is saved.
        const creatorId = getTenantId(req);

        // encryptSecret throws when the key is unset. Say so plainly — the generic catch below
        // would render it as "Failed to update token", which points nowhere.
        let encryptedToken: string;
        try {
            encryptedToken = encryptSecret(token);
        } catch (keyErr) {
            log('error', 'token.encryption_failed', describeError(keyErr));
            res.status(500).json({
                error: 'TOKEN_ENCRYPTION_KEY is not configured. Generate one with `openssl rand -hex 32` and set it before saving a token.'
            });
            return;
        }

        const result = await pool.query(
            `UPDATE creators
                SET page_access_token = $1,
                    token_status = 'valid',
                    token_last_checked_at = NOW(),
                    token_error = NULL
              WHERE id = $2 RETURNING instagram_page_id`,
            [encryptedToken, creatorId]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'No active creator found to update.' });
            return;
        }

        invalidateTenantCache();

        res.json({
            message: 'Token updated successfully!',
            pageId: result.rows[0].instagram_page_id,
            type: data.type,
            expiresAt: data.expires_at ? new Date(data.expires_at * 1000).toISOString() : null,
            scopes: data.scopes || [],
        });
    } catch (err: any) {
        log('error', 'token.update_failed', describeError(err));
        res.status(500).json({ error: err.response?.data?.error?.message || 'Failed to update token.' });
    }
});

router.post('/settings/token/extend', async (req, res) => {
    try {
        const appId = process.env.META_APP_ID;
        const appSecret = process.env.META_APP_SECRET;

        if (!appId || !appSecret) {
            res.status(400).json({ error: 'META_APP_ID or META_APP_SECRET not configured in backend.' });
            return;
        }

        const creatorId = getTenantId(req);
        const creator = await getTenant(creatorId, ['id', 'page_access_token']);
        if (!creator) {
            res.status(404).json({ error: 'No active creator found.' });
            return;
        }

        const currentToken = creator.page_access_token;

        const extendRes = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
            params: {
                grant_type: 'fb_exchange_token',
                client_id: appId,
                client_secret: appSecret,
                fb_exchange_token: currentToken
            }
        });

        if (extendRes.data && extendRes.data.access_token) {
            const newToken = extendRes.data.access_token;

            // Same reason as in POST /settings/token: a missing encryption key must not be
            // reported as "failed to extend", which sends you looking at Meta instead.
            let encryptedToken: string;
            try {
                encryptedToken = encryptSecret(newToken);
            } catch (keyErr) {
                log('error', 'token.encryption_failed', describeError(keyErr));
                res.status(500).json({
                    error: 'TOKEN_ENCRYPTION_KEY is not configured. Generate one with `openssl rand -hex 32` and set it before saving a token.'
                });
                return;
            }

            await pool.query(
                `UPDATE creators
                    SET page_access_token = $1, token_status = 'valid',
                        token_last_checked_at = NOW(), token_error = NULL
                  WHERE id = $2`,
                [encryptedToken, creatorId]
            );
            invalidateTenantCache();
            res.json({ message: 'Token successfully extended to a never-expiring token.' });
        } else {
            res.status(400).json({ error: 'Failed to obtain an extended token from Meta.' });
        }
    } catch (err: any) {
        log('error', 'token.extend_failed', describeError(err));
        res.status(500).json({ error: err.response?.data?.error?.message || 'Failed to extend token.' });
    }
});

// ─── Creators ───────────────────────────────────────────────────────────────

// Listed every creator in the deployment to every session. It is now the tenants this session
// may act as — the same rows the switcher shows, in the shape the dashboard already expects.
router.get('/creators', async (req, res) => {
    try {
        const tenants = await listTenantsForSession(req.session!);
        const ids = tenants.map(t => t.id);

        const result = await pool.query(
            `SELECT id, instagram_page_id, is_active, created_at
               FROM creators WHERE id = ANY($1::uuid[]) ORDER BY created_at DESC`,
            [ids]
        );
        res.json(result.rows);
    } catch (err) {
        log('error', 'api.creators_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch creators.' });
    }
});

// ─── Posts Scheduler CRUD ────────────────────────────────────────────────────

router.get('/posts/scheduled', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM scheduled_posts WHERE creator_id = $1 ORDER BY scheduled_time DESC',
            [getTenantId(req)]
        );
        res.json(result.rows);
    } catch (err) {
        log('error', 'api.scheduled_list_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch scheduled posts.' });
    }
});

router.post('/posts/scheduled', async (req, res) => {
    try {
        const { platform, post_type, caption, media_url, scheduled_time, publish_now, cover_url } = req.body;

        if (!platform || !post_type || !scheduled_time) {
            res.status(400).json({ error: 'platform, post_type, and scheduled_time are required.' });
            return;
        }

        const creatorId = getTenantId(req);
        const creator = await getTenant(creatorId, [
            'id', 'page_access_token', 'instagram_page_id', 'facebook_page_id'
        ]);
        if (!creator) {
            res.status(400).json({ error: 'No active creator account found.' });
            return;
        }

        // Insert into database
        const result = await pool.query(
            `INSERT INTO scheduled_posts (creator_id, platform, post_type, caption, media_url, scheduled_time, status, cover_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
                creatorId,
                platform,
                post_type,
                caption || null,
                media_url || null,
                new Date(scheduled_time),
                'PENDING',
                cover_url || null
            ]
        );

        const newPost = result.rows[0];

        if (publish_now) {
            log('info', 'publish.immediate_requested', { post_id: newPost.id });

            const token = creator.page_access_token;

            try {
                let fbId: string | null = null;
                let igId: string | null = null;

                // Mark as publishing
                await pool.query("UPDATE scheduled_posts SET status = 'PUBLISHING' WHERE id = $1", [newPost.id]);

                // Facebook — the cron path already checked for a missing page id; without the
                // same check here the literal "null" went into the Graph URL and came back as
                // an unrelated Meta error.
                if (platform === 'facebook' || platform === 'both') {
                    if (!creator.facebook_page_id) {
                        throw new Error('Facebook Page ID is missing for this creator.');
                    }
                    const fbRes = await publishFacebookPost(creator.facebook_page_id, post_type, caption || '', media_url, token);
                    fbId = fbRes.id || fbRes.post_id;
                }

                // Instagram
                if (platform === 'instagram' || platform === 'both') {
                    if (!creator.instagram_page_id) {
                        throw new Error('Instagram Account ID is missing for this creator.');
                    }
                    const igRes = await publishInstagramPost(creator.instagram_page_id, post_type, caption || '', media_url, token, cover_url);
                    igId = igRes.id;
                }

                let resultId = '';
                if (fbId && igId) {
                    resultId = `FB:${fbId} | IG:${igId}`;
                } else if (fbId) {
                    resultId = `FB:${fbId}`;
                } else if (igId) {
                    resultId = `IG:${igId}`;
                }

                const finalRes = await pool.query(
                    `UPDATE scheduled_posts 
                     SET status = 'PUBLISHED', published_post_id = $1, error_log = NULL 
                     WHERE id = $2 RETURNING *`,
                    [resultId, newPost.id]
                );
                res.status(201).json(finalRes.rows[0]);
                return;
            } catch (publishErr: any) {
                log('error', 'publish.immediate_failed', { post_id: newPost.id, ...describeError(publishErr) });
                const finalRes = await pool.query(
                    `UPDATE scheduled_posts
                     SET status = 'FAILED', error_log = $1
                     WHERE id = $2 RETURNING *`,
                    [publishErr.message, newPost.id]
                );
                // 201 for a row we just marked FAILED read as success to every caller, so a
                // publish that Meta rejected looked identical to one that went live.
                res.status(502).json({
                    ...finalRes.rows[0],
                    status: 'FAILED',
                    error: publishErr.message
                });
                return;
            }
        }

        res.status(201).json(newPost);
    } catch (err) {
        log('error', 'api.scheduled_create_failed', describeError(err));
        res.status(500).json({ error: 'Failed to create scheduled post.' });
    }
});

router.put('/posts/scheduled/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { platform, post_type, caption, media_url, scheduled_time, cover_url } = req.body;

        if (!isUuid(id)) {
            res.status(404).json({ error: 'Scheduled post not found.' });
            return;
        }

        // cover_url was destructured and then dropped, so editing a reel silently kept its old
        // cover — which for a video fading up from black is the black frame 0.
        const result = await pool.query(
            `UPDATE scheduled_posts
             SET platform = COALESCE($1, platform),
                 post_type = COALESCE($2, post_type),
                 caption = COALESCE($3, caption),
                 media_url = COALESCE($4, media_url),
                 scheduled_time = COALESCE($5, scheduled_time)::timestamp with time zone,
                 cover_url = COALESCE($6, cover_url),
                 status = CASE WHEN status = 'FAILED' THEN 'PENDING' ELSE status END
             WHERE id = $7 AND creator_id = $8 RETURNING *`,
            [platform, post_type, caption, media_url, scheduled_time, cover_url, id, getTenantId(req)]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Scheduled post not found.' });
            return;
        }
        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'api.scheduled_update_failed', describeError(err));
        res.status(500).json({ error: 'Failed to update scheduled post.' });
    }
});

router.delete('/posts/scheduled/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!isUuid(id)) {
            res.status(404).json({ error: 'Scheduled post not found.' });
            return;
        }

        // Unscoped, this deleted any tenant's scheduled post by id.
        const result = await pool.query(
            'DELETE FROM scheduled_posts WHERE id = $1 AND creator_id = $2 RETURNING *',
            [id, getTenantId(req)]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Scheduled post not found.' });
            return;
        }
        res.json({ message: 'Scheduled post deleted.', id });
    } catch (err) {
        log('error', 'api.scheduled_delete_failed', describeError(err));
        res.status(500).json({ error: 'Failed to delete scheduled post.' });
    }
});

router.get('/posts/live', async (req, res) => {
    try {
        const creator = await getTenant(getTenantId(req), [
            'page_access_token', 'instagram_page_id', 'facebook_page_id'
        ]);

        if (!creator) {
            res.json([]);
            return;
        }

        const token = creator.page_access_token;
        const fbPageId = creator.facebook_page_id;
        const igUserId = creator.instagram_page_id;

        const livePosts: any[] = [];
        const promises: Promise<any>[] = [];

        // Fetch FB Page Posts
        if (fbPageId && token) {
            promises.push(
                axios.get(`https://graph.facebook.com/${API_VERSION}/${fbPageId}/feed`, {
                    params: {
                        fields: 'id,message,created_time,full_picture,permalink_url',
                        access_token: token,
                        limit: 10
                    }
                }).then(response => {
                    const posts = response.data?.data || [];
                    posts.forEach((p: any) => {
                        livePosts.push({
                            id: p.id,
                            platform: 'facebook',
                            caption: p.message || '',
                            media_url: p.full_picture || null,
                            permalink: p.permalink_url || null,
                            timestamp: p.created_time
                        });
                    });
                }).catch(err => {
                    log('warn', 'api.live_posts_facebook_failed', describeError(err));
                })
            );
        }

        // Fetch IG Media Posts
        if (igUserId && token) {
            promises.push(
                axios.get(`https://graph.facebook.com/${API_VERSION}/${igUserId}/media`, {
                    params: {
                        fields: 'id,caption,media_url,permalink,timestamp,media_type',
                        access_token: token,
                        limit: 10
                    }
                }).then(response => {
                    const media = response.data?.data || [];
                    media.forEach((m: any) => {
                        livePosts.push({
                            id: m.id,
                            platform: 'instagram',
                            caption: m.caption || '',
                            media_url: m.media_url || null,
                            permalink: m.permalink || null,
                            timestamp: m.timestamp
                        });
                    });
                }).catch(err => {
                    log('warn', 'api.live_posts_instagram_failed', describeError(err));
                })
            );
        }

        await Promise.all(promises);

        // Sort posts descending by timestamp
        livePosts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        res.json(livePosts);
    } catch (err) {
        log('error', 'api.live_posts_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch live posts from Meta.' });
    }
});

router.post('/upload', async (req, res) => {
    try {
        const { filename, mime_type, base64_data } = req.body;

        if (!filename || !mime_type || !base64_data) {
            res.status(400).json({ error: 'filename, mime_type, and base64_data are required.' });
            return;
        }

        // /api/uploads/:id echoes this value back as Content-Type to anyone who asks, on the
        // same origin the dashboard is served from. Pin it to what Meta will actually ingest.
        if (!ALLOWED_MIME_TYPES.has(mime_type)) {
            res.status(400).json({
                error: `Unsupported file type "${mime_type}". Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}.`
            });
            return;
        }

        // Clean base64 string if it contains data URI prefix
        const base64Clean = base64_data.replace(/^data:[^;]+;base64,/, '');

        // Decode base64 to binary buffer
        const buffer = Buffer.from(base64Clean, 'base64');

        // Measure the decoded bytes, and measure them *after* stripping the prefix — the old
        // check ran on the raw string and counted the data-URI header as payload.
        //
        // Vercel hard-caps the request body at 4.5MB and this endpoint takes base64 JSON, so
        // ~3.3MB of file is the true ceiling: the old 10MB limit could never be reached, the
        // platform 413'd first with nothing useful to show the user.
        if (buffer.length > MAX_UPLOAD_BYTES) {
            res.status(400).json({
                error: 'File is too large. This endpoint tops out at 3.2MB because Vercel caps the whole request at 4.5MB and the file is sent as base64. For anything bigger, write it straight into media_uploads over the database connection.'
            });
            return;
        }

        // Through the store rather than straight to SQL, so that moving the bytes to object
        // storage is a change to `getMediaStore()` and nothing else.
        //
        // `creator_id` arrived with v12. The row is still served unauthenticated by UUID —
        // Meta cURLs it — so this is attribution and cleanup-on-delete, not access control.
        const store = getMediaStore();
        const { id: newUploadId } = await store.put({
            creatorId: getTenantId(req),
            filename,
            mimeType: mime_type,
            data: buffer,
        });

        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.get('host');
        const publicUrl = store.publicUrl(newUploadId, `${protocol}://${host}`);

        res.status(201).json({
            id: newUploadId,
            url: publicUrl,
            filename
        });
    } catch (err) {
        log('error', 'media.upload_failed', describeError(err));
        res.status(500).json({ error: 'Failed to handle file upload.' });
    }
});

// ─── Direct Message Inbox & Chat ─────────────────────────────────────────────

router.get('/conversations', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const page = parseInt(req.query.page as string) || 1;
        const offset = (page - 1) * limit;

        const tenantId = getTenantId(req);

        const result = await pool.query(
            `SELECT c.*,
                    (SELECT text FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_text,
                    (SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_direction
             FROM conversations c
             WHERE c.creator_id = $1
             ORDER BY c.last_message_at DESC
             LIMIT $2 OFFSET $3`,
            [tenantId, limit, offset]
        );

        const countRes = await pool.query(
            'SELECT COUNT(*)::int as total FROM conversations WHERE creator_id = $1',
            [tenantId]
        );

        res.json({
            data: result.rows,
            pagination: {
                page,
                limit,
                total: countRes.rows[0].total,
                totalPages: Math.ceil(countRes.rows[0].total / limit)
            }
        });
    } catch (err) {
        log('error', 'api.conversations_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch conversations.' });
    }
});

router.get('/conversations/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;

        if (!isUuid(id)) {
            res.status(404).json({ error: 'Conversation not found.' });
            return;
        }

        // Ownership is checked on the conversation rather than filtered on the messages: this
        // endpoint took a `conversation_id` from the URL and returned its whole history with no
        // check at all, so any authenticated session could read any tenant's DMs by id.
        const owner = await pool.query(
            'SELECT 1 FROM conversations WHERE id = $1 AND creator_id = $2',
            [id, getTenantId(req)]
        );
        if (owner.rows.length === 0) {
            res.status(404).json({ error: 'Conversation not found.' });
            return;
        }

        const messages = await pool.query(
            'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 100',
            [id]
        );
        res.json(messages.rows);
    } catch (err) {
        log('error', 'api.messages_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch message history.' });
    }
});

router.post('/conversations/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const { text } = req.body;

        if (!text) {
            res.status(400).json({ error: 'Message text is required.' });
            return;
        }

        if (!isUuid(id)) {
            res.status(404).json({ error: 'Conversation not found.' });
            return;
        }

        const tenantId = getTenantId(req);

        // Fetch conversation and creator credentials. Scoped to the tenant: unscoped, this
        // sent a DM from another tenant's Instagram account, using their access token.
        const convRes = await pool.query(
            `SELECT c.*, cr.page_access_token
             FROM conversations c
             JOIN creators cr ON cr.id = c.creator_id
             WHERE c.id = $1 AND c.creator_id = $2`,
            [id, tenantId]
        );

        if (convRes.rows.length === 0) {
            res.status(404).json({ error: 'Conversation not found.' });
            return;
        }

        const conv = convRes.rows[0];

        // Send message to Instagram
        // Length, not content: this line used to put the operator's message body — and by
        // implication the private conversation it belongs to — into the log stream.
        log('info', 'inbox.manual_reply', { conversation_id: conv.id, chars: text.length });
        const metaPayload = { text };
        // Selected straight from `creators`, so it has not passed through the tenant service.
        await sendDirectMessage(conv.instagram_user_id, metaPayload, decryptSecret(conv.page_access_token));

        // Save message to database & pause the bot to avoid fighting the user
        await pool.query(
            `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload)
             VALUES ($1, $2, 'outbound', 'text', $3, $4)`,
            [id, tenantId, text, JSON.stringify(metaPayload)]
        );

        await pool.query(
            'UPDATE conversations SET last_message_at = NOW(), is_bot_active = false WHERE id = $1 AND creator_id = $2',
            [id, tenantId]
        );

        res.json({ success: true, message: 'Message sent manually. Bot is paused for this thread.' });
    } catch (err: any) {
        log('error', 'api.manual_send_failed', describeError(err));
        res.status(500).json({ error: err.message || 'Failed to send message.' });
    }
});

router.put('/conversations/:id/toggle-bot', async (req, res) => {
    try {
        const { id } = req.params;
        const { is_bot_active } = req.body;

        if (typeof is_bot_active !== 'boolean') {
            res.status(400).json({ error: 'is_bot_active must be a boolean.' });
            return;
        }

        if (!isUuid(id)) {
            res.status(404).json({ error: 'Conversation not found.' });
            return;
        }

        const result = await pool.query(
            'UPDATE conversations SET is_bot_active = $1 WHERE id = $2 AND creator_id = $3 RETURNING *',
            [is_bot_active, id, getTenantId(req)]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Conversation not found.' });
            return;
        }

        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'api.toggle_bot_failed', describeError(err));
        res.status(500).json({ error: 'Failed to toggle bot.' });
    }
});

// ─── AI Agent Settings ───────────────────────────────────────────────────────

router.get('/settings/ai', async (req, res) => {
    try {
        const creatorId = getTenantId(req);

        const agentRes = await pool.query('SELECT * FROM ai_agents WHERE creator_id = $1', [creatorId]);
        if (agentRes.rows.length === 0) {
            res.json({
                system_prompt: 'أنت مساعد ذكي يجيب على استفسارات المتابعين باللغة العربية.',
                knowledge_base: '',
                model: 'gemini-2.5-flash',
                temperature: 0.7,
                is_active: true
            });
            return;
        }

        res.json(agentRes.rows[0]);
    } catch (err) {
        log('error', 'api.ai_settings_read_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch AI settings.' });
    }
});

router.post('/settings/ai', async (req, res) => {
    try {
        const { system_prompt, knowledge_base, model, temperature, is_active } = req.body;

        if (!system_prompt) {
            res.status(400).json({ error: 'System prompt is required.' });
            return;
        }

        const creatorId = getTenantId(req);

        // `parseFloat(temperature) || 0.7` silently rewrote a deliberate 0 — the setting that
        // makes replies reproducible — into the default.
        const parsedTemperature = Number.parseFloat(temperature);
        const finalTemperature = Number.isFinite(parsedTemperature) ? parsedTemperature : 0.7;

        const result = await pool.query(
            `INSERT INTO ai_agents (creator_id, system_prompt, knowledge_base, model, temperature, is_active)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (creator_id) 
             DO UPDATE SET 
                system_prompt = EXCLUDED.system_prompt,
                knowledge_base = EXCLUDED.knowledge_base,
                model = EXCLUDED.model,
                temperature = EXCLUDED.temperature,
                is_active = EXCLUDED.is_active
             RETURNING *`,
            [
                creatorId,
                system_prompt,
                knowledge_base || '',
                model || 'gemini-2.5-flash',
                finalTemperature,
                is_active !== false
            ]
        );

        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'api.ai_settings_update_failed', describeError(err));
        res.status(500).json({ error: 'Failed to update AI settings.' });
    }
});

router.post('/settings/ai/test', async (req, res) => {
    try {
        const { system_prompt, knowledge_base, user_message } = req.body;

        if (!user_message) {
            res.status(400).json({ error: 'user_message is required.' });
            return;
        }

        const creatorId = getTenantId(req);

        const mockConvId = '00000000-0000-0000-0000-000000000000';

        // This used to upsert the draft prompt into the live ai_agents row and never put the
        // old one back, so trying a throwaway idea in the tester overwrote the tuned
        // production prompt. A test run must not write anything: pass the draft through.
        const aiRes = await generateAiResponse(mockConvId, user_message, creatorId, {
            system_prompt: typeof system_prompt === 'string' && system_prompt.trim() ? system_prompt : undefined,
            knowledge_base: typeof knowledge_base === 'string' ? knowledge_base : undefined,
        });

        // null means the agent is switched off. Say that, rather than rendering an empty reply
        // that looks like the model returned nothing.
        if (!aiRes) {
            res.status(409).json({ error: 'The AI agent is turned off — enable it to run a test.' });
            return;
        }

        res.json(aiRes);
    } catch (err: any) {
        log('error', 'api.ai_test_failed', describeError(err));
        res.status(500).json({ error: err.message || 'Simulation call failed.' });
    }
});

// ─── Webhook Verify Token ───────────────────────────────────────────────────
// Meta re-checks this value every time a webhook subscription is created or its
// callback URL changes. Keeping it in the database means it can be rotated from
// the dashboard and takes effect on the next request — no redeploy, and no
// dependency on an environment variable that can silently drift or be emptied.

router.get('/settings/webhook-token', async (req, res) => {
    try {
        const creator = await getTenant(getTenantId(req), ['webhook_verify_token']);
        const dbToken: string | null = creator?.webhook_verify_token ?? null;
        const proto = req.headers['x-forwarded-proto'] || 'https';

        res.json({
            configuredInDatabase: Boolean(dbToken),
            configuredInEnv: Boolean(process.env.META_VERIFY_TOKEN),
            // Never return the token itself. A masked preview is enough to tell
            // whether the saved value is the one you think it is.
            preview: dbToken
                ? `${dbToken.slice(0, 3)}${'•'.repeat(Math.max(dbToken.length - 5, 3))}${dbToken.slice(-2)}`
                : null,
            length: dbToken ? dbToken.length : 0,
            webhookUrl: `${proto}://${req.get('host')}/webhook`,
        });
    } catch (err: any) {
        // `err.message` here is Postgres driver text — it names tables and columns to anyone
        // who can reach the endpoint. Keep the detail in the logs.
        log('error', 'api.verify_token_read_failed', describeError(err));
        res.status(500).json({ error: 'Failed to read verify token.' });
    }
});

router.post('/settings/webhook-token', async (req, res) => {
    try {
        const raw = req.body?.token;
        if (typeof raw !== 'string') {
            res.status(400).json({ error: 'A verify token string is required.' });
            return;
        }
        const token = raw.trim();

        if (token.length < 8) {
            res.status(400).json({ error: 'Verify token must be at least 8 characters.' });
            return;
        }
        if (/\s/.test(token)) {
            res.status(400).json({ error: 'Verify token cannot contain spaces or line breaks.' });
            return;
        }

        // Scoped to one row on purpose: an unscoped UPDATE ... WHERE is_active
        // would overwrite every creator's token at once.
        const creatorId = getTenantId(req);

        const { rowCount } = await pool.query(
            'UPDATE creators SET webhook_verify_token = $1 WHERE id = $2',
            [token, creatorId]
        );

        if (!rowCount) {
            res.status(404).json({ error: 'No active creator account found.' });
            return;
        }

        invalidateTenantCache();

        res.json({
            success: true,
            message: 'Verify token saved. Paste the same value into Meta\u2019s webhook configuration — it works immediately, no redeploy needed.',
        });
    } catch (err: any) {
        log('error', 'api.verify_token_save_failed', describeError(err));
        res.status(500).json({ error: 'Failed to save verify token.' });
    }
});

export default router;
