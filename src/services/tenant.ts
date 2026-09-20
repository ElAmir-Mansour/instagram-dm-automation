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
