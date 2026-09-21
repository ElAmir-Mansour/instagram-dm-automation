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
import { queryOne, queryRows } from '../db/query.js';
import type { CreatorRow, UserRow } from '../db/rows.js';
import { decryptSecret } from '../config/crypto.js';
import { log } from '../utils/log.js';

/**
 * A creator row, as the column-list API below returns it.
 *
 * Everything past `page_access_token` is optional because these functions take an explicit
 * column list and most callers do not ask for them — `is_active` in particular is selected
 * by exactly one route (the token-status check) and by none of the webhook paths. It was
 * declared required here, which was simply untrue: `pool.query` returns `any`, so the lie
 * typechecked, and `creator.is_active` on the webhook path would have been `undefined` while
 * the compiler insisted it was a boolean. Adding row types to this module is what surfaced
 * it. The four required fields are the ones every default column list includes.
 */
export interface Creator {
    id: string;
    instagram_page_id: string | null;
    facebook_page_id: string | null;
    page_access_token: string;
    is_active?: boolean;
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

    const row = await queryOne<Pick<CreatorRow, 'id'>>(
        `SELECT id FROM creators WHERE is_active = true ORDER BY created_at LIMIT 1`
    );
    if (!row) return null;

    cachedId = { value: row.id, at: Date.now() };
    return cachedId.value;
}

/**
 * Every read of a creator row goes through here so that decryption happens in exactly one
 * place. Miss it on a single path and that path sends `enc:v1:...` to Meta as a bearer token,
 * which surfaces as a generic OAuth error with nothing pointing at the cause.
 *
 * `decryptSecret` returns a value without the `enc:v1:` prefix unchanged, so a row that has
 * not been rewritten since encryption landed still works.
 */
function withDecryptedToken<T extends Partial<Creator>>(row: T | undefined): T | null {
    if (!row) return null;
    if (typeof row.page_access_token === 'string') {
        row.page_access_token = decryptSecret(row.page_access_token);
    }
    return row;
}

/** Same resolution, returning the columns asked for. Pass explicit columns — never `*`. */
export async function getActiveCreator(
    columns: string[] = ['id', 'instagram_page_id', 'facebook_page_id', 'page_access_token']
): Promise<Creator | null> {
    const cols = columns.join(', ');
    const res = await pool.query(
        `SELECT ${cols} FROM creators WHERE is_active = true ORDER BY created_at LIMIT 1`
    );
    return withDecryptedToken<Creator>(res.rows[0]);
}

/**
 * The tenant-scoped counterpart of `getActiveCreator`: fetch one creator by id.
 *
 * This is what the dashboard routes use now that the session names the tenant. It does not
 * filter on `is_active`, because an operator disabling a tenant should still be able to look
 * at its settings — the webhook path is the one that must ignore inactive creators, and that
 * is `getCreatorByPageId` below.
 */
export async function getTenant(
    tenantId: string,
    columns: string[] = ['id', 'instagram_page_id', 'facebook_page_id', 'page_access_token']
): Promise<Creator | null> {
    const cols = columns.join(', ');
    const res = await pool.query(`SELECT ${cols} FROM creators WHERE id = $1`, [tenantId]);
    return withDecryptedToken<Creator>(res.rows[0]);
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

    // The one query on the webhook's critical path. Typed to exactly the columns selected,
    // so adding a field to `Creator` without adding it here is a compile error rather than
    // an `undefined` that reaches the Meta API as a missing page id.
    type Row = Pick<CreatorRow, 'id' | 'instagram_page_id' | 'facebook_page_id' | 'page_access_token'>;
    const row = await queryOne<Row>(
        `SELECT id, instagram_page_id, facebook_page_id, page_access_token
           FROM creators
          WHERE is_active = true
            AND (instagram_page_id = ANY($1::text[]) OR facebook_page_id = ANY($1::text[]))
          ORDER BY created_at
          LIMIT 1`,
        [ids]
    );
    // Decrypted here rather than at the two webhook call sites, so the comment and DM
    // pipelines keep working unchanged the moment a token is first written encrypted.
    return withDecryptedToken<Creator>(row ?? undefined);
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

/** The membership lookup, separated out so the decision logic above it can be tested. */
async function hasMembershipInDb(userId: string, tenantId: string): Promise<boolean> {
    const res = await pool.query(
        `SELECT 1 FROM memberships WHERE user_id = $1 AND creator_id = $2 LIMIT 1`,
        [userId, tenantId]
    );
    return res.rows.length > 0;
}

/**
 * Confirm the session may act as the tenant it claims.
 *
 * A platform_admin may act as any tenant (this is what powers the tenant switcher). Everyone
 * else must hold a membership. Verified against the database rather than trusted from the
 * token, so revoking a membership takes effect immediately instead of at token expiry.
 *
 * `hasMembership` is injectable only so the branch logic can be exercised without a live
 * pool; every caller uses the default.
 */
export async function assertTenantAccess(
    session: { userId: string | null; role: string; tenantId: string | null },
    hasMembership: (userId: string, tenantId: string) => Promise<boolean> = hasMembershipInDb
): Promise<boolean> {
    if (!session.tenantId) return false;
    if (session.role === 'platform_admin') return true;
    if (!session.userId) return false;

    return hasMembership(session.userId, session.tenantId);
}

export interface SessionValidity {
    ok: boolean;
    /** Present when `ok` is false — the reason, for the response body. */
    reason?: 'revoked' | 'disabled' | 'unknown_user';
}

/**
 * Decide whether a user-backed session is still live, given the user row it names.
 *
 * Split from the query so the revocation rule itself is testable: `token_version` is the only
 * kill switch this system has, and a session that outlives a bump is a leaked token that
 * cannot be taken back for 24 hours.
 */
export function checkSessionValidity(
    session: { userId: string | null; tokenVersion: number },
    user: { token_version: number; is_active: boolean } | undefined | null
): SessionValidity {
    // Legacy shared-password sessions carry no user row, so there is nothing to revoke
    // against. They are bounded by the DASHBOARD_PASSWORD itself and the 24h TTL.
    if (!session.userId) return { ok: true };
    if (!user) return { ok: false, reason: 'unknown_user' };
    if (!user.is_active) return { ok: false, reason: 'disabled' };
    if (user.token_version !== session.tokenVersion) return { ok: false, reason: 'revoked' };
    return { ok: true };
}

/**
 * Express middleware: reject a session whose user has been revoked or disabled.
 *
 * Separate from `resolveTenant` because the admin router has to run before a tenant can be
 * resolved — on a fresh deployment there is no creator to resolve — and skipping the
 * revocation check there would leave the highest-privilege surface as the one place a revoked
 * token still worked.
 */
export async function requireLiveSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    const session = req.session;
    if (!session) {
        res.status(401).json({ error: 'Unauthorized.' });
        return;
    }

    // A legacy shared-password session has no user row, so there is nothing to look up.
    if (!session.userId) {
        next();
        return;
    }

    try {
        const user = await queryOne<Pick<UserRow, 'token_version' | 'is_active'>>(
            'SELECT token_version, is_active FROM users WHERE id = $1',
            [session.userId]
        );
        const validity = checkSessionValidity(session, user);
        if (!validity.ok) {
            res.status(401).json({
                error: validity.reason === 'disabled'
                    ? 'This account has been disabled.'
                    : 'Session has been revoked — please login again.'
            });
            return;
        }
    } catch (err) {
        // Fail closed. A database that cannot confirm the session is live is not a reason to
        // assume it is.
        log('error', 'auth.session_check_failed', { message: (err as Error)?.message });
        res.status(503).json({ error: 'Could not verify the session — try again.' });
        return;
    }

    next();
}

/**
 * Express middleware. Run after requireAuth, and after `requireLiveSession` — this function
 * deliberately does not repeat the revocation lookup, so that it is one query per request
 * rather than two.
 */
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

// ─── Tenant predicates for SQL ──────────────────────────────────────────────────────────
//
// v12 added `creator_id` to `interactions` and `messages` and backfilled it, so the obvious
// filter is `i.creator_id = $n`. It is not sufficient *yet*: the webhook writers
// (src/webhook/comments.ts, src/webhook/messaging.ts) still INSERT without the column, so
// every row arriving right now is NULL. Filtering on the column alone would empty the
// dashboard of today's activity — a regression that looks exactly like the webhook having
// stopped, which is the single hardest failure in this project to diagnose.
//
// So each predicate matches the direct column and falls back, only for NULLs, to the
// relationship the v12 backfill itself used. Once the writers set `creator_id`, delete the
// second half of each predicate; the first half is already correct.

/** Rows of `interactions` (aliased `i`) owned by the tenant bound at `$n`. */
export function interactionsOwnedBy(n: number): string {
    return `(i.creator_id = $${n} OR (i.creator_id IS NULL AND EXISTS (
        SELECT 1 FROM campaigns tc WHERE tc.id = i.campaign_id AND tc.creator_id = $${n})))`;
}

// `messages` has no equivalent helper because nothing reads it by tenant directly: the inbox
// reaches messages through a conversation, and ownership is checked on the conversation, which
// does carry a reliable `creator_id`.

/** Tenants this session may act as — the tenant switcher's data source. */
export async function listTenantsForSession(
    session: { userId: string | null; role: string }
): Promise<TenantSummary[]> {
    if (session.role === 'platform_admin') {
        return queryRows<TenantSummary>(
            `SELECT id, name, instagram_page_id, facebook_page_id, token_status
               FROM creators WHERE is_active = true ORDER BY name NULLS LAST, created_at`
        );
    }
    if (!session.userId) return [];

    return queryRows<TenantSummary>(
        `SELECT c.id, c.name, c.instagram_page_id, c.facebook_page_id, c.token_status
           FROM creators c
           JOIN memberships m ON m.creator_id = c.id
          WHERE m.user_id = $1 AND c.is_active = true
          ORDER BY c.name NULLS LAST, c.created_at`,
        [session.userId]
    );
}
