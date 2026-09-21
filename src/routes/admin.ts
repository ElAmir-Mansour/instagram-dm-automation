/**
 * Platform administration.
 *
 * Two things live here that had no home before:
 *
 *  1. Creating a creator. There was no UI and no API for it at all — a fresh deployment was
 *     unusable until someone wrote an INSERT by hand in the Supabase SQL editor. That is the
 *     first-run path, and it is now an endpoint.
 *
 *  2. A cross-tenant view. Every other route in this app is deliberately pinned to one tenant;
 *     this is the one place that is allowed to look across them, because "is anything broken
 *     for anybody" is a question the per-tenant dashboard structurally cannot answer.
 *
 * Mounted under /api/admin from routes/api.ts, inside requireAuth + resolveTenant, and gated
 * again here on role. Deliberately small: every endpoint is one query and no cleverness.
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';
import { encryptSecret, hashPassword } from '../config/crypto.js';
import { describeError, log } from '../utils/log.js';
import { invalidateTenantCache } from '../services/tenant.js';

const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Meta's automation ceiling as this app enforces it.
 *
 * Mirrors DEFAULT_HOURLY_LIMIT in src/utils/rateLimiter.ts, which does not export it. It is
 * reported alongside the hourly count so the number means something to whoever reads it — "41"
 * is not information, "41 of 180" is.
 */
const DM_HOURLY_CEILING = 180;

/** Postgres unique-violation. A duplicate page id is a 409, not a 500. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Everything below is platform_admin only.
 *
 * 404 rather than 403: a non-admin has no business knowing this surface exists.
 */
function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
    if (req.session?.role !== 'platform_admin') {
        res.status(404).json({ error: 'Not found.' });
        return;
    }
    next();
}

router.use(requirePlatformAdmin);

// ─── Tenants ────────────────────────────────────────────────────────────────

/**
 * One row per creator, with the numbers that tell you whether it is healthy.
 *
 * `last_webhook_at` is the column worth having. This project's own notes call a webhook
 * signature failure invisible — the 403 happens before anything touches the database, so a
 * tenant whose deliveries stopped looks exactly like a tenant nobody is messaging. Derived
 * from the most recent inbound artefact of either pipeline: comments write `interactions`,
 * DMs write `messages`. GREATEST ignores NULLs, so a tenant that only ever gets one kind
 * still reports correctly, and NULL means genuinely nothing, ever.
 */
router.get('/tenants', async (_req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                c.id,
                c.name,
                c.instagram_page_id,
                c.facebook_page_id,
                c.is_active,
                c.token_status,
                c.token_last_checked_at,
                c.token_error,
                c.created_at,
                (SELECT COUNT(*)::int FROM campaigns ca WHERE ca.creator_id = c.id) AS campaigns,
                (SELECT COUNT(*)::int FROM scheduled_posts s WHERE s.creator_id = c.id) AS scheduled_posts,
                (SELECT COUNT(*)::int FROM conversations cv WHERE cv.creator_id = c.id) AS conversations,
                (SELECT COUNT(*)::int FROM scheduled_posts s
                  WHERE s.creator_id = c.id AND s.status = 'PUBLISHED'
                    AND s.scheduled_time > NOW() - INTERVAL '7 days') AS published_7d,
                (SELECT COUNT(*)::int FROM scheduled_posts s
                  WHERE s.creator_id = c.id AND s.status = 'FAILED'
                    AND s.scheduled_time > NOW() - INTERVAL '7 days') AS failed_7d,
                COALESCE((SELECT r.count FROM rate_limit_counters r
                           WHERE r.creator_id = c.id AND r.bucket = 'dm'
                             AND r.window_start = date_trunc('hour', NOW())), 0)::int AS dm_this_hour,
                GREATEST(
                    (SELECT MAX(i.timestamp) FROM interactions i
                      JOIN campaigns ca ON ca.id = i.campaign_id
                     WHERE ca.creator_id = c.id),
                    (SELECT MAX(m.created_at) FROM messages m
                      JOIN conversations cv ON cv.id = m.conversation_id
                     WHERE cv.creator_id = c.id)
                ) AS last_webhook_at
            FROM creators c
            ORDER BY c.name NULLS LAST, c.created_at
        `);

        res.json({
            dmHourlyCeiling: DM_HOURLY_CEILING,
            tenants: result.rows,
        });
    } catch (err) {
        log('error', 'admin.tenants_list_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch tenants.' });
    }
});

/**
 * Create a creator — the first-run path.
 *
 * `instagram_page_id` and `page_access_token` are NOT NULL in the schema, so both are
 * required. The token is encrypted here, which means a tenant created through this endpoint
 * never has a plaintext token in the database at any point.
 */
router.post('/tenants', async (req, res) => {
    try {
        const { name, instagram_page_id, facebook_page_id, page_access_token, webhook_verify_token } = req.body ?? {};

        if (typeof instagram_page_id !== 'string' || !instagram_page_id.trim()) {
            res.status(400).json({ error: 'instagram_page_id is required.' });
            return;
        }
        if (typeof page_access_token !== 'string' || !page_access_token.trim()) {
            res.status(400).json({ error: 'page_access_token is required.' });
            return;
        }

        let encrypted: string;
        try {
            encrypted = encryptSecret(page_access_token.trim());
        } catch (keyErr) {
            log('error', 'admin.tenant_encryption_failed', describeError(keyErr));
            res.status(500).json({
                error: 'TOKEN_ENCRYPTION_KEY is not configured. Generate one with `openssl rand -hex 32` and set it before creating a tenant.'
            });
            return;
        }

        const result = await pool.query(
            `INSERT INTO creators
                (name, instagram_page_id, facebook_page_id, page_access_token, webhook_verify_token, is_active, token_status)
             VALUES ($1, $2, $3, $4, $5, true, 'unknown')
             RETURNING id, name, instagram_page_id, facebook_page_id, is_active, token_status, created_at`,
            [
                typeof name === 'string' && name.trim() ? name.trim() : null,
                instagram_page_id.trim(),
                typeof facebook_page_id === 'string' && facebook_page_id.trim() ? facebook_page_id.trim() : null,
                encrypted,
                typeof webhook_verify_token === 'string' && webhook_verify_token.trim()
                    ? webhook_verify_token.trim()
                    : null,
            ]
        );

        // The "which creator is active" cache is keyed on nothing but time, so a new creator
        // must drop it or the legacy login keeps resolving the old one for up to 30 seconds.
        invalidateTenantCache();

        res.status(201).json(result.rows[0]);
    } catch (err: any) {
        if (err?.code === PG_UNIQUE_VIOLATION) {
            res.status(409).json({ error: 'A creator with that page id already exists.' });
            return;
        }
        log('error', 'admin.tenant_create_failed', describeError(err));
        res.status(500).json({ error: 'Failed to create tenant.' });
    }
});

/** Rename a tenant, or switch it on and off. Nothing else is editable from here on purpose. */
router.patch('/tenants/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, is_active } = req.body ?? {};

        if (!isUuid(id)) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }
        if (name === undefined && is_active === undefined) {
            res.status(400).json({ error: 'Nothing to update — send name and/or is_active.' });
            return;
        }

        const result = await pool.query(
            `UPDATE creators
                SET name = COALESCE($1, name),
                    is_active = COALESCE($2, is_active)
              WHERE id = $3
          RETURNING id, name, instagram_page_id, facebook_page_id, is_active, token_status, created_at`,
            [
                typeof name === 'string' && name.trim() ? name.trim() : null,
                typeof is_active === 'boolean' ? is_active : null,
                id,
            ]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Tenant not found.' });
            return;
        }

        // Deactivating the active creator changes which one the legacy session resolves to.
        invalidateTenantCache();

        res.json(result.rows[0]);
    } catch (err) {
        log('error', 'admin.tenant_update_failed', describeError(err));
        res.status(500).json({ error: 'Failed to update tenant.' });
    }
});

// ─── Users ──────────────────────────────────────────────────────────────────

/** Shortest password this will accept. Long enough to matter, low enough to not be theatre. */
const MIN_PASSWORD_LENGTH = 12;

router.get('/users', async (_req, res) => {
    try {
        // `password_hash` is never selected — not even to discard it.
        const result = await pool.query(`
            SELECT
                u.id, u.email, u.role, u.is_active, u.token_version,
                u.last_login_at, u.created_at,
                COALESCE((
                    SELECT json_agg(json_build_object(
                        'creator_id', m.creator_id, 'role', m.role, 'name', c.name
                    ) ORDER BY c.name NULLS LAST)
                    FROM memberships m JOIN creators c ON c.id = m.creator_id
                    WHERE m.user_id = u.id
                ), '[]'::json) AS memberships
            FROM users u
            ORDER BY u.created_at
        `);
        res.json(result.rows);
    } catch (err) {
        log('error', 'admin.users_list_failed', describeError(err));
        res.status(500).json({ error: 'Failed to fetch users.' });
    }
});

/**
 * Create a user, optionally with their first membership in the same call.
 *
 * Managed onboarding: there is no self-serve signup, and this is the only way a `users` row
 * comes into existence.
 */
router.post('/users', async (req, res) => {
    try {
        const { email, password, role, creator_id } = req.body ?? {};

        if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            res.status(400).json({ error: 'A valid email is required.' });
            return;
        }
        if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
            res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
            return;
        }
        if (role !== undefined && role !== 'user' && role !== 'platform_admin') {
            res.status(400).json({ error: "role must be 'user' or 'platform_admin'." });
            return;
        }
        if (creator_id !== undefined && !isUuid(creator_id)) {
            res.status(400).json({ error: 'creator_id must be a uuid.' });
            return;
        }

        const passwordHash = await hashPassword(password);

        const result = await pool.query(
            `INSERT INTO users (email, password_hash, role)
             VALUES (lower($1), $2, $3)
             RETURNING id, email, role, is_active, token_version, created_at`,
            [email.trim(), passwordHash, role ?? 'user']
        );
        const user = result.rows[0];

        // A user with no membership can log in and reach nothing, which is a confusing first
        // experience — so the common case grants the membership in the same request.
        if (creator_id) {
            await pool.query(
                `INSERT INTO memberships (user_id, creator_id, role) VALUES ($1, $2, 'owner')
                 ON CONFLICT (user_id, creator_id) DO NOTHING`,
                [user.id, creator_id]
            );
        }

        res.status(201).json(user);
    } catch (err: any) {
        if (err?.code === PG_UNIQUE_VIOLATION) {
            res.status(409).json({ error: 'A user with that email already exists.' });
            return;
        }
        log('error', 'admin.user_create_failed', describeError(err));
        res.status(500).json({ error: 'Failed to create user.' });
    }
});

/**
 * Revoke every session a user holds.
 *
 * Bumping `token_version` is the only kill switch this system has: sessions are stateless
 * HMACs with a 24h TTL, so before this column existed a leaked token simply could not be
 * taken back. `resolveTenant` compares the session's copy against this one on every request.
 */
router.post('/users/:id/revoke', async (req, res) => {
    try {
        const { id } = req.params;

        if (!isUuid(id)) {
            res.status(404).json({ error: 'User not found.' });
            return;
        }

        const result = await pool.query(
            'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING id, token_version',
            [id]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'User not found.' });
            return;
        }

        res.json({
            message: 'All sessions for this user are now invalid.',
            ...result.rows[0],
        });
    } catch (err) {
        log('error', 'admin.user_revoke_failed', describeError(err));
        res.status(500).json({ error: 'Failed to revoke sessions.' });
    }
});

/** Grant (or re-role) a membership. Idempotent, so it doubles as "change their role". */
router.post('/users/:id/memberships', async (req, res) => {
    try {
        const { id } = req.params;
        const { creator_id, role } = req.body ?? {};

        if (!isUuid(id)) {
            res.status(404).json({ error: 'User not found.' });
            return;
        }
        if (!isUuid(creator_id)) {
            res.status(400).json({ error: 'creator_id must be a uuid.' });
            return;
        }

        const result = await pool.query(
            `INSERT INTO memberships (user_id, creator_id, role) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, creator_id) DO UPDATE SET role = EXCLUDED.role
             RETURNING user_id, creator_id, role, created_at`,
            [id, creator_id, typeof role === 'string' && role.trim() ? role.trim() : 'owner']
        );

        res.status(201).json(result.rows[0]);
    } catch (err: any) {
        // Both FKs land here: an unknown user id and an unknown creator id are equally 404.
        if (err?.code === '23503') {
            res.status(404).json({ error: 'No such user or tenant.' });
            return;
        }
        log('error', 'admin.membership_failed', describeError(err));
        res.status(500).json({ error: 'Failed to grant membership.' });
    }
});

export default router;
