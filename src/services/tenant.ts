/**
 * Tenant resolution.
 *
 * The schema has had `creator_id` everywhere since the beginning, but ~13 call sites each
 * re-derived the tenant with their own `SELECT id FROM creators WHERE is_active = true`.
 * Two of them added `ORDER BY created_at` and the rest did not, so with two active creators
 * different endpoints would silently have targeted different rows.
 *
 * This module makes that one decision instead of thirteen. It does not by itself make the
 * app multi-tenant — the dashboard API still has unscoped queries — but it is the seam that
 * a real tenant context slots into later: change `resolveTenantId` and every call site
 * follows.
 */
import { pool } from '../config/db.js';

export interface Creator {
    id: string;
    instagram_page_id: string | null;
    facebook_page_id: string | null;
    page_access_token: string;
    is_active: boolean;
    webhook_verify_token?: string | null;
}

/** Cache the active-creator lookup for the life of a warm instance. */
let cachedId: { value: string; at: number } | null = null;
const CACHE_MS = 30_000;

/**
 * The single canonical definition of "which tenant is this".
 *
 * Today: the one active creator. When real tenancy arrives this reads `req.tenantId` from
 * the session instead, and nothing else in the codebase needs to change.
 */
export async function getActiveCreatorId(): Promise<string | null> {
    if (cachedId && Date.now() - cachedId.at < CACHE_MS) return cachedId.value;

    const res = await pool.query(
        `SELECT id FROM creators WHERE is_active = true ORDER BY created_at LIMIT 1`
    );
    if (res.rows.length === 0) return null;

    cachedId = { value: res.rows[0].id, at: Date.now() };
    return cachedId.value;
}

/** Same resolution, returning the columns asked for. Pass explicit columns — never `*`. */
export async function getActiveCreator(
    columns: string[] = ['id', 'instagram_page_id', 'facebook_page_id', 'page_access_token']
): Promise<Creator | null> {
    const cols = columns.join(', ');
    const res = await pool.query(
        `SELECT ${cols} FROM creators WHERE is_active = true ORDER BY created_at LIMIT 1`
    );
    return res.rows[0] ?? null;
}

/**
 * Resolve the tenant that owns an incoming webhook, by Meta page id.
 *
 * This path was already correct — it routes by `entry.id` rather than assuming a single
 * tenant — so it is lifted here unchanged apart from dropping the implicit ambiguity.
 */
export async function getCreatorByPageId(...pageIds: (string | undefined)[]): Promise<Creator | null> {
    const ids = pageIds.filter((id): id is string => Boolean(id));
    if (ids.length === 0) return null;

    const res = await pool.query(
        `SELECT id, instagram_page_id, facebook_page_id, page_access_token
           FROM creators
          WHERE is_active = true
            AND (instagram_page_id = ANY($1::text[]) OR facebook_page_id = ANY($1::text[]))
          ORDER BY created_at
          LIMIT 1`,
        [ids]
    );
    return res.rows[0] ?? null;
}

/** Drop the cached id — call after any write that could change which creator is active. */
export function invalidateTenantCache(): void {
    cachedId = null;
}

// ─── Tenant context ─────────────────────────────────────────────────────────────────────
//
// Everything above resolves "the one active creator". Everything below resolves "the tenant
// THIS request is acting as". The two coexist during the transition: routes migrate to
// `getTenantId(req)` one at a time, and once none are left the functions above can go.

import type { Request, Response, NextFunction } from 'express';

export interface TenantSummary {
    id: string;
    name: string | null;
    instagram_page_id: string | null;
    facebook_page_id: string | null;
    token_status: string | null;
}

/**
 * The tenant this request is acting as. Throws rather than falling back, because a silent
 * fallback to "the first active creator" is precisely the bug this whole layer exists to
 * remove — it would look like it worked right up until it served the wrong customer's data.
 */
export function getTenantId(req: Request): string {
    const id = req.session?.tenantId;
    if (!id) {
        throw new Error('No tenant in session — requireAuth and resolveTenant must run first.');
    }
    return id;
}

/**
 * Confirm the session may act as the tenant it claims.
 *
 * A platform_admin may act as any tenant (this is what powers the tenant switcher). Everyone
 * else must hold a membership. Verified against the database rather than trusted from the
 * token, so revoking a membership takes effect immediately instead of at token expiry.
 */
export async function assertTenantAccess(
    session: { userId: string | null; role: string; tenantId: string | null }
): Promise<boolean> {
    if (!session.tenantId) return false;
    if (session.role === 'platform_admin') return true;
    if (!session.userId) return false;

    const res = await pool.query(
        `SELECT 1 FROM memberships WHERE user_id = $1 AND creator_id = $2 LIMIT 1`,
        [session.userId, session.tenantId]
    );
    return res.rows.length > 0;
}

/** Express middleware. Run after requireAuth. */
export async function resolveTenant(req: Request, res: Response, next: NextFunction): Promise<void> {
    const session = req.session;
    if (!session) {
        res.status(401).json({ error: 'Unauthorized.' });
        return;
    }

    // A legacy shared-password session predates the concept of choosing a tenant, so it
    // adopts whichever creator is active — the same thing every call site used to assume.
    if (!session.tenantId) {
        session.tenantId = await getActiveCreatorId();
    }

    if (!session.tenantId) {
        res.status(409).json({
            error: 'No creator account is configured yet. Add one before using the dashboard.'
        });
        return;
    }

    if (!(await assertTenantAccess(session))) {
        // Deliberately 404, not 403: confirming a tenant exists is itself a disclosure.
        res.status(404).json({ error: 'Not found.' });
        return;
    }

    next();
}

/** Tenants this session may act as — the tenant switcher's data source. */
export async function listTenantsForSession(
    session: { userId: string | null; role: string }
): Promise<TenantSummary[]> {
    if (session.role === 'platform_admin') {
        const res = await pool.query(
            `SELECT id, name, instagram_page_id, facebook_page_id, token_status
               FROM creators WHERE is_active = true ORDER BY name NULLS LAST, created_at`
        );
        return res.rows;
    }
    if (!session.userId) return [];

    const res = await pool.query(
        `SELECT c.id, c.name, c.instagram_page_id, c.facebook_page_id, c.token_status
           FROM creators c
           JOIN memberships m ON m.creator_id = c.id
          WHERE m.user_id = $1 AND c.is_active = true
          ORDER BY c.name NULLS LAST, c.created_at`,
        [session.userId]
    );
    return res.rows;
}
