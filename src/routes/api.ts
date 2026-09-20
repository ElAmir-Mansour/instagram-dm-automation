import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../config/db.js';
import { createSession, requireAuth, createDownloadToken, consumeDownloadToken } from '../middleware/auth.js';
import axios from 'axios';
import { sendDirectMessage, publishFacebookPost, publishInstagramPost, API_VERSION } from '../services/instagram.js';
import { generateAiResponse } from '../services/ai.js';
import { getActiveCreatorId, getActiveCreator, invalidateTenantCache } from '../services/tenant.js';
import { pruneRateLimitData } from '../utils/rateLimiter.js';


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

router.post('/auth/login', (req, res) => {
    const ip = clientIp(req);
    const retryAfter = loginRetryAfter(ip);
    if (retryAfter > 0) {
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({ error: `Too many login attempts. Try again in ${retryAfter}s.` });
        return;
    }

    const { password } = req.body;
    const dashboardPassword = process.env.DASHBOARD_PASSWORD;

    if (!dashboardPassword) {
        console.error('❌ Login attempted while DASHBOARD_PASSWORD is unset.');
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
        const token = createSession();
        res.json({ token, expiresIn: '24h' });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Dashboard authentication is not configured.' });
    }
});

// ─── Cron: Publish Scheduled Posts ──────────────────────────────────────────

router.get('/cron/publish', async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;

    // Fail closed. `if (cronSecret && ...)` skipped the whole guard whenever the variable was
    // unset, which is exactly the deployment where you least want an open publish endpoint.
    if (!cronSecret) {
        console.error('❌ /api/cron/publish called but CRON_SECRET is not configured.');
        res.status(500).json({ error: 'CRON_SECRET not configured.' });
        return;
    }

    // Header only: a ?token= variant ends up in Vercel's access logs for their whole retention.
    const authHeader = req.headers['authorization'];
    if (typeof authHeader !== 'string' || !secretEquals(authHeader, `Bearer ${cronSecret}`)) {
        res.status(401).json({ error: 'Unauthorized cron request.' });
        return;
    }

    try {
        console.log('⏰ Running Post Publisher Cron Job...');

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
            console.log(`⏰ Released ${reaped.rows.length} stale claim(s) back to PENDING.`);
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

        // Find pending posts due for publishing
        const result = await pool.query(`
            SELECT s.*, c.page_access_token, c.instagram_page_id, c.facebook_page_id
            FROM scheduled_posts s
            JOIN creators c ON c.id = s.creator_id
            WHERE s.status = 'PENDING' AND s.scheduled_time <= NOW()
            ORDER BY s.scheduled_time ASC
        `);

        if (result.rows.length === 0) {
            console.log('⏰ No pending scheduled posts found.');
            res.json({ message: 'No pending posts to publish.' });
            return;
        }

        console.log(`⏰ Found ${result.rows.length} post(s) to publish.`);
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
                console.log(`⏰ Post ${post.id} was claimed by another run — skipping.`);
                continue;
            }

            claimed++;
            console.log(`⏰ Processing scheduled post ${post.id} (${post.platform} - ${post.post_type})...`);

            try {
                let fbId: string | null = null;
                let igId: string | null = null;

                const token = post.page_access_token;

                // 1. Publish to Facebook
                if (post.platform === 'facebook' || post.platform === 'both') {
                    if (!post.facebook_page_id) {
                        throw new Error('Facebook Page ID is missing for this creator.');
                    }
                    console.log(`⏰ Publishing to Facebook Page ${post.facebook_page_id}...`);
                    const fbRes = await publishFacebookPost(
                        post.facebook_page_id,
                        post.post_type,
                        post.caption || '',
                        post.media_url,
                        token
                    );
                    fbId = fbRes.id || fbRes.post_id;
                    console.log(`⏰ Published to Facebook. Post ID: ${fbId}`);
                }

                // 2. Publish to Instagram
                if (post.platform === 'instagram' || post.platform === 'both') {
                    if (!post.instagram_page_id) {
                        throw new Error('Instagram Account ID is missing for this creator.');
                    }
                    if (!post.media_url) {
                        throw new Error('Instagram requires a media URL to publish.');
                    }
                    console.log(`⏰ Publishing to Instagram Account ${post.instagram_page_id}...`);
                    const igRes = await publishInstagramPost(
                        post.instagram_page_id,
                        post.post_type,
                        post.caption || '',
                        post.media_url,
                        token,
                        post.cover_url
                    );
                    igId = igRes.id;
                    console.log(`⏰ Published to Instagram. Media ID: ${igId}`);
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
                console.error(`❌ Failed to publish scheduled post ${post.id}:`, err.message);
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
        console.error('❌ Scheduler Cron Error:', err);
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

        const result = await pool.query(
            'SELECT mime_type, data FROM media_uploads WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            res.status(404).send('Not Found');
            return;
        }

        const row = result.rows[0];

        // Rows predating the upload allowlist can hold any string, and this origin also serves
        // the dashboard — an echoed text/html would be same-origin script. Serve anything
        // unrecognised as an opaque download instead.
        const contentType = ALLOWED_MIME_TYPES.has(row.mime_type) ? row.mime_type : 'application/octet-stream';

        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
        res.send(row.data);
    } catch (err) {
        console.error('File stream error:', err);
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
    if (!consumeDownloadToken(req.query.dl, EXPORT_DOWNLOAD_SCOPE)) {
        res.status(401).json({ error: 'Download link expired or already used — start the export again.' });
        return;
    }

    try {
        const platform = req.query.platform as string;
        const campaign_id = req.query.campaign_id as string;
        const status = req.query.status as string;
        const search = req.query.search as string;

        let whereClause = '';
        const params: any[] = [];
        const conditions: string[] = [];

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

        if (conditions.length > 0) {
            whereClause = 'WHERE ' + conditions.join(' AND ');
        }

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
        console.error('Export Error:', err);
        res.status(500).json({ error: 'Failed to export interactions.' });
    }
});

// ─── All routes below require authentication ────────────────────────────────
router.use(requireAuth);

// ─── Dashboard Stats ────────────────────────────────────────────────────────

router.get('/stats', async (_req, res) => {
    try {
        const [total, sent, failed, campaigns, creators, today, uniqueUsers, instagram, facebook] = await Promise.all([
            pool.query('SELECT COUNT(*)::int as count FROM interactions'),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE status = 'SENT'"),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE status = 'FAILED'"),
            pool.query('SELECT COUNT(*)::int as count FROM campaigns'),
            pool.query('SELECT COUNT(*)::int as count FROM creators WHERE is_active = true'),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE timestamp > NOW() - INTERVAL '24 hours'"),
            pool.query('SELECT COUNT(DISTINCT sender_username)::int as count FROM interactions'),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE platform = 'instagram'"),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE platform = 'facebook'"),
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
        console.error('Stats Error:', err);
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
                DATE_TRUNC('hour', timestamp) as hour,
                COUNT(*) FILTER (WHERE status = 'SENT')::int as sent,
                COUNT(*) FILTER (WHERE status = 'FAILED')::int as failed
            FROM interactions
            WHERE timestamp > NOW() - ($1::text || ' days')::interval
            GROUP BY hour
            ORDER BY hour ASC
        `, [String(days)]);
        res.json(result.rows);
    } catch (err) {
        console.error('Hourly Stats Error:', err);
        res.status(500).json({ error: 'Failed to fetch hourly stats.' });
    }
});

// ─── Daily Stats (for chart) ────────────────────────────────────────────────

router.get('/stats/daily', async (req, res) => {
    try {
        const days = clampDays(req.query.days, 30);
        const result = await pool.query(`
            SELECT
                DATE_TRUNC('day', timestamp)::date as day,
                COUNT(*) FILTER (WHERE status = 'SENT')::int as sent,
                COUNT(*) FILTER (WHERE status = 'FAILED')::int as failed
            FROM interactions
            WHERE timestamp > NOW() - ($1::text || ' days')::interval
            GROUP BY day
            ORDER BY day ASC
        `, [String(days)]);
        res.json(result.rows);
    } catch (err) {
        console.error('Daily Stats Error:', err);
        res.status(500).json({ error: 'Failed to fetch daily stats.' });
    }
});

// ─── Campaigns CRUD ─────────────────────────────────────────────────────────

router.get('/campaigns', async (_req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                c.*,
                COUNT(i.id)::int as total_interactions,
                COUNT(i.id) FILTER (WHERE i.status = 'SENT')::int as sent_count,
                COUNT(i.id) FILTER (WHERE i.status = 'FAILED')::int as failed_count
            FROM campaigns c
            LEFT JOIN interactions i ON i.campaign_id = c.id
            GROUP BY c.id
            ORDER BY c.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Campaigns Error:', err);
        res.status(500).json({ error: 'Failed to fetch campaigns.' });
    }
});

router.post('/campaigns', async (req, res) => {
    try {
        const { creator_id, trigger_keyword, dm_template, public_reply_template, post_id, is_active } = req.body;

        if (!trigger_keyword || !dm_template) {
            res.status(400).json({ error: 'trigger_keyword and dm_template are required.' });
            return;
        }

        // If no creator_id provided, use the active creator
        let creatorId = creator_id;
        if (!creatorId) {
            creatorId = await getActiveCreatorId();
            if (!creatorId) {
                res.status(400).json({ error: 'No active creator found. Add a creator first.' });
                return;
            }
        }

        const result = await pool.query(
            `INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template, post_id, is_active)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [creatorId, trigger_keyword, dm_template, public_reply_template || null, post_id || null, is_active !== false]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Create Campaign Error:', err);
        res.status(500).json({ error: 'Failed to create campaign.' });
    }
});

router.put('/campaigns/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { trigger_keyword, dm_template, public_reply_template, post_id, is_active } = req.body;

        const result = await pool.query(
            `UPDATE campaigns 
             SET trigger_keyword = COALESCE($1, trigger_keyword),
                 dm_template = COALESCE($2, dm_template),
                 public_reply_template = $3,
                 post_id = $4,
                 is_active = COALESCE($5, is_active)
             WHERE id = $6 RETURNING *`,
            [
                trigger_keyword, 
                dm_template, 
                public_reply_template || null, 
                post_id || null, 
                typeof is_active === 'boolean' ? is_active : null, 
                id
            ]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Campaign not found.' });
            return;
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update Campaign Error:', err);
        res.status(500).json({ error: 'Failed to update campaign.' });
    }
});

router.delete('/campaigns/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM campaigns WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Campaign not found.' });
            return;
        }
        res.json({ message: 'Campaign deleted.', id: result.rows[0].id });
    } catch (err) {
        console.error('Delete Campaign Error:', err);
        res.status(500).json({ error: 'Failed to delete campaign.' });
    }
});

// ─── Campaigns Stats Leaderboard ─────────────────────────────────────────────

router.get('/stats/campaigns', async (_req, res) => {
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
            GROUP BY c.id, c.trigger_keyword
            ORDER BY total_triggers DESC
            LIMIT 5
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Campaign Stats Error:', err);
        res.status(500).json({ error: 'Failed to fetch campaign stats.' });
    }
});

// ─── Export Interactions (CSV Exporter) ──────────────────────────────────────
// The download itself is registered above the auth boundary and carries its own one-shot
// token; this is the authenticated half that hands that token out.

router.post('/interactions/export/token', (_req, res) => {
    res.json({ token: createDownloadToken(EXPORT_DOWNLOAD_SCOPE) });
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

        let whereClause = '';
        const params: any[] = [];
        const conditions: string[] = [];

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

        if (conditions.length > 0) {
            whereClause = 'WHERE ' + conditions.join(' AND ');
        }

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
        console.error('Interactions Error:', err);
        res.status(500).json({ error: 'Failed to fetch interactions.' });
    }
});

// ─── Settings: Token Management ─────────────────────────────────────────────

router.get('/settings/token/status', async (_req, res) => {
    try {
        const creator = await getActiveCreator([
            'id', 'instagram_page_id', 'facebook_page_id', 'is_active', 'page_access_token'
        ]);

        if (!creator) {
            res.json({ status: 'no_creator', message: 'No creator account found.' });
            return;
        }

        const token = creator.page_access_token;

        // Validate token against Meta API
        try {
            const debugRes = await axios.get('https://graph.facebook.com/debug_token', {
                params: { input_token: token, access_token: token }
            });

            const data = debugRes.data.data;
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
        } catch {
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
        console.error('Token Status Error:', err);
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
                    console.log('Successfully extended token to a never-expiring token.');
                }
            } catch (extendErr: any) {
                console.log('Token extension skipped or failed:', extendErr.response?.data?.error?.message || extendErr.message);
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

        // Update the token in the database. Scoped to the resolved creator: the unscoped
        // `WHERE is_active = true` overwrote every active creator's token with this one.
        const creatorId = await getActiveCreatorId();
        if (!creatorId) {
            res.status(404).json({ error: 'No active creator found to update.' });
            return;
        }

        const result = await pool.query(
            'UPDATE creators SET page_access_token = $1 WHERE id = $2 RETURNING instagram_page_id',
            [token, creatorId]
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
        console.error('Token Update Error:', err);
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

        const creator = await getActiveCreator(['id', 'page_access_token']);
        if (!creator) {
            res.status(404).json({ error: 'No active creator found.' });
            return;
        }

        const currentToken = creator.page_access_token;
        const creatorId = creator.id;

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
            await pool.query('UPDATE creators SET page_access_token = $1 WHERE id = $2', [newToken, creatorId]);
            invalidateTenantCache();
            res.json({ message: 'Token successfully extended to a never-expiring token.' });
        } else {
            res.status(400).json({ error: 'Failed to obtain an extended token from Meta.' });
        }
    } catch (err: any) {
        console.error('Token Extend Error:', err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data?.error?.message || 'Failed to extend token.' });
    }
});

// ─── Creators ───────────────────────────────────────────────────────────────

router.get('/creators', async (_req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, instagram_page_id, is_active, created_at FROM creators ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Creators Error:', err);
        res.status(500).json({ error: 'Failed to fetch creators.' });
    }
});

// ─── Posts Scheduler CRUD ────────────────────────────────────────────────────

router.get('/posts/scheduled', async (_req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM scheduled_posts ORDER BY scheduled_time DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Scheduled Posts Error:', err);
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

        const creator = await getActiveCreator([
            'id', 'page_access_token', 'instagram_page_id', 'facebook_page_id'
        ]);
        if (!creator) {
            res.status(400).json({ error: 'No active creator account found.' });
            return;
        }
        const creatorId = creator.id;

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
            console.log(`🚀 Immediate publishing requested for scheduled post ${newPost.id}...`);

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
                console.error('❌ Immediate publish failed:', publishErr.message);
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
        console.error('Create Scheduled Post Error:', err);
        res.status(500).json({ error: 'Failed to create scheduled post.' });
    }
});

router.put('/posts/scheduled/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { platform, post_type, caption, media_url, scheduled_time, cover_url } = req.body;

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
             WHERE id = $7 RETURNING *`,
            [platform, post_type, caption, media_url, scheduled_time, cover_url, id]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Scheduled post not found.' });
            return;
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update Scheduled Post Error:', err);
        res.status(500).json({ error: 'Failed to update scheduled post.' });
    }
});

router.delete('/posts/scheduled/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'DELETE FROM scheduled_posts WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Scheduled post not found.' });
            return;
        }
        res.json({ message: 'Scheduled post deleted.', id });
    } catch (err) {
        console.error('Delete Scheduled Post Error:', err);
        res.status(500).json({ error: 'Failed to delete scheduled post.' });
    }
});

router.get('/posts/live', async (_req, res) => {
    try {
        const creator = await getActiveCreator(['page_access_token', 'instagram_page_id', 'facebook_page_id']);

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
                    console.warn('⚠️ Failed to fetch live Facebook posts:', err.message);
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
                    console.warn('⚠️ Failed to fetch live Instagram posts:', err.message);
                })
            );
        }

        await Promise.all(promises);

        // Sort posts descending by timestamp
        livePosts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        res.json(livePosts);
    } catch (err) {
        console.error('Fetch Live Posts Error:', err);
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

        // Insert into database
        const result = await pool.query(
            'INSERT INTO media_uploads (filename, mime_type, data) VALUES ($1, $2, $3) RETURNING id',
            [filename, mime_type, buffer]
        );

        const newUploadId = result.rows[0].id;
        
        // Construct URL using req.get('host')
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.get('host');
        const publicUrl = `${protocol}://${host}/api/uploads/${newUploadId}`;

        res.status(201).json({
            id: newUploadId,
            url: publicUrl,
            filename
        });
    } catch (err) {
        console.error('Upload handling error:', err);
        res.status(500).json({ error: 'Failed to handle file upload.' });
    }
});

// ─── Direct Message Inbox & Chat ─────────────────────────────────────────────

router.get('/conversations', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const page = parseInt(req.query.page as string) || 1;
        const offset = (page - 1) * limit;

        const result = await pool.query(
            `SELECT c.*, 
                    (SELECT text FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_text,
                    (SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_direction
             FROM conversations c
             ORDER BY c.last_message_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        const countRes = await pool.query('SELECT COUNT(*)::int as total FROM conversations');

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
        console.error('Fetch Conversations Error:', err);
        res.status(500).json({ error: 'Failed to fetch conversations.' });
    }
});

router.get('/conversations/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const messages = await pool.query(
            'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 100',
            [id]
        );
        res.json(messages.rows);
    } catch (err) {
        console.error('Fetch Messages Error:', err);
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

        // Fetch conversation and creator credentials
        const convRes = await pool.query(
            `SELECT c.*, cr.page_access_token 
             FROM conversations c
             JOIN creators cr ON cr.id = c.creator_id
             WHERE c.id = $1`,
            [id]
        );

        if (convRes.rows.length === 0) {
            res.status(404).json({ error: 'Conversation not found.' });
            return;
        }

        const conv = convRes.rows[0];

        // Send message to Instagram
        console.log(`✉️ Manual response to ${conv.instagram_user_id}: "${text}"`);
        const metaPayload = { text };
        await sendDirectMessage(conv.instagram_user_id, metaPayload, conv.page_access_token);

        // Save message to database & pause the bot to avoid fighting the user
        await pool.query(
            `INSERT INTO messages (conversation_id, direction, message_type, text, raw_payload)
             VALUES ($1, 'outbound', 'text', $2, $3)`,
            [id, text, JSON.stringify(metaPayload)]
        );

        await pool.query(
            'UPDATE conversations SET last_message_at = NOW(), is_bot_active = false WHERE id = $1',
            [id]
        );

        res.json({ success: true, message: 'Message sent manually. Bot is paused for this thread.' });
    } catch (err: any) {
        console.error('Manual Send Error:', err);
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

        const result = await pool.query(
            'UPDATE conversations SET is_bot_active = $1 WHERE id = $2 RETURNING *',
            [is_bot_active, id]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Conversation not found.' });
            return;
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Toggle Bot Error:', err);
        res.status(500).json({ error: 'Failed to toggle bot.' });
    }
});

// ─── AI Agent Settings ───────────────────────────────────────────────────────

router.get('/settings/ai', async (_req, res) => {
    try {
        const creatorId = await getActiveCreatorId();
        if (!creatorId) {
            res.status(400).json({ error: 'No active creator found.' });
            return;
        }

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
        console.error('Get AI Settings Error:', err);
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

        const creatorId = await getActiveCreatorId();
        if (!creatorId) {
            res.status(400).json({ error: 'No active creator found.' });
            return;
        }

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
        console.error('Update AI Settings Error:', err);
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

        const creatorId = await getActiveCreatorId();
        if (!creatorId) {
            res.status(400).json({ error: 'No active creator found.' });
            return;
        }

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
        console.error('AI Test Error:', err);
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
        const creator = await getActiveCreator(['webhook_verify_token']);
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
        console.error('Read Verify Token Error:', err);
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
        const creatorId = await getActiveCreatorId();
        if (!creatorId) {
            res.status(404).json({ error: 'No active creator account found.' });
            return;
        }

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
        console.error('Save Verify Token Error:', err);
        res.status(500).json({ error: 'Failed to save verify token.' });
    }
});

export default router;
