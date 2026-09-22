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

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /**
             * The role this session holds INSIDE `session.tenantId`, resolved once by
             * `resolveTenant`. Distinct from `session.role`, which is the platform-wide
             * `platform_admin` / `user` split.
             */
            tenantRole?: TenantRole;
        }
    }
}

export interface TenantSummary {
    id: string;
    name: string | null;
    instagram_page_id: string | null;
    facebook_page_id: string | null;
    token_status: string | null;
    /**
     * The session's role in this tenant, as `normalizeTenantRole` resolves it. `owner` for a
     * platform_admin, who reaches every tenant without a membership row.
     */
    role: TenantRole;
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
    return (await membershipRoleInDb(userId, tenantId)) !== null;
}

/**
 * The same lookup, returning the stored role instead of a boolean.
 *
 * `null` means there is no membership row at all — which is the only thing that denies
 * access. A row always has a role (`NOT NULL DEFAULT 'owner'` since v12), but it may hold a
 * value this build has never heard of, which is what `normalizeTenantRole` is for.
 */
async function membershipRoleInDb(userId: string, tenantId: string): Promise<string | null> {
    const res = await pool.query(
        `SELECT role FROM memberships WHERE user_id = $1 AND creator_id = $2 LIMIT 1`,
        [userId, tenantId]
    );
    if (res.rows.length === 0) return null;
    return typeof res.rows[0]?.role === 'string' ? res.rows[0].role : '';
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

// ─── In-tenant roles ────────────────────────────────────────────────────────────────────
//
// `memberships.role` has existed since v12 with `DEFAULT 'owner'`. It was stored, shown on the
// Users page, written into the audit log — and never read by any authorization decision.
// `assertTenantAccess` above answers on membership EXISTENCE, so a person granted as a
// "member" could delete campaigns, rotate the Meta page token and publish to the live
// account. The only role split the app actually enforced was platform_admin vs user.
//
// Three tiers, chosen because each maps to a distinction somebody would really draw:
//
//   owner     the Meta connection itself — the page access token, the webhook verify token.
//             Break these and the tenant goes dark; they are also the credentials that let
//             you post as the business anywhere, so they are the account-holder's, not the
//             agency's.
//   operator  runs the account day to day: campaigns, scheduled posts, the inbox, the AI
//             persona. Everything that spends the tenant's reach but not its credentials.
//   viewer    reads. Stats, campaigns, posts, the inbox, activity — no writes at all.
//
// Two tiers would have forced "can publish" and "can rotate the token" to be the same
// permission, which is the exact pairing a marketing freelancer makes uncomfortable. Five
// would be invented distinctions nobody asked for.
//
// ── Nobody loses access on deploy ──
// Read `normalizeTenantRole` before changing anything here. The restriction is opt-in in the
// strongest sense available: a role this build does not recognise — including every row that
// exists today, all of which are 'owner', and the 'member' value the old grant form could
// write — resolves to `owner`, i.e. to exactly the access it has now. Restricting somebody is
// an explicit act by an operator who picks 'operator' or 'viewer' from the grant form. This
// mirrors how `match_mode` was introduced in v14: the new behaviour exists, the default is
// still yesterday's.

export type TenantRole = 'owner' | 'operator' | 'viewer';

/** The vocabulary, most privileged first — the order the grant form lists them in. */
export const TENANT_ROLES: readonly TenantRole[] = ['owner', 'operator', 'viewer'];

/** Higher is more. Compared with `>=`, so a guard names the MINIMUM it needs. */
const TENANT_ROLE_RANK: Record<TenantRole, number> = { viewer: 0, operator: 1, owner: 2 };

export function isTenantRole(value: unknown): value is TenantRole {
    return typeof value === 'string' && (TENANT_ROLES as readonly string[]).includes(value);
}

/**
 * A stored `memberships.role` as an effective role. **Fails open, deliberately.**
 *
 * Only the two restricted values are honoured; everything else — 'owner', the legacy 'member'
 * the old grant form offered, an empty string, a typo, a value some future build writes and
 * this one is rolled back behind — becomes `owner`, which is the access every one of those
 * rows has today.
 *
 * Failing closed here would be the outage: this function runs against production data that
 * was written when the column meant nothing, and the first request after deploy would refuse
 * an operator their own campaigns. A guard that denies more than it was asked to is not the
 * safe direction when the alternative is a documented, auditable, opt-in downgrade.
 */
export function normalizeTenantRole(raw: unknown): TenantRole {
    if (raw === 'operator' || raw === 'viewer') return raw;
    return 'owner';
}

/** Does `role` reach `minimum`? */
export function tenantRoleAllows(role: TenantRole, minimum: TenantRole): boolean {
    return TENANT_ROLE_RANK[role] >= TENANT_ROLE_RANK[minimum];
}

export interface TenantAccess {
    allowed: boolean;
    /** The role this session acts with inside the tenant. Meaningless when `allowed` is false. */
    role: TenantRole;
}

/**
 * `assertTenantAccess`, plus the role the session carries inside the tenant.
 *
 * Kept as a second function rather than folded into the first because the two answer
 * different questions: `assertTenantAccess` is asked about a tenant the session is *not* in
 * (the switcher, `POST /auth/switch-tenant`), where there is no in-tenant role to carry yet.
 * This one is asked about the tenant the request is acting as, and its answer is stashed on
 * the request so the whole chain costs one membership query, not one per guard.
 *
 * `platform_admin` resolves to `owner` unconditionally — the same bypass `assertTenantAccess`
 * already grants, said out loud — and so does the legacy shared-password session, which has
 * no user row to hold a membership at all.
 */
export async function resolveTenantAccess(
    session: { userId: string | null; role: string; tenantId: string | null },
    membershipRole: (userId: string, tenantId: string) => Promise<string | null> = membershipRoleInDb
): Promise<TenantAccess> {
    if (!session.tenantId) return { allowed: false, role: 'viewer' };
    if (session.role === 'platform_admin') return { allowed: true, role: 'owner' };
    if (!session.userId) return { allowed: false, role: 'viewer' };

    const stored = await membershipRole(session.userId, session.tenantId);
    if (stored === null) return { allowed: false, role: 'viewer' };
    return { allowed: true, role: normalizeTenantRole(stored) };
}

/** The machine-readable code on a refusal, so the dashboard need not match on prose. */
export const INSUFFICIENT_ROLE_CODE = 'INSUFFICIENT_TENANT_ROLE';

/** What each tier may do, in one sentence, for the refusal body. */
const ROLE_REFUSAL: Record<TenantRole, string> = {
    owner: 'Only an owner of this account can change the Meta connection — the page access token and the webhook verify token.',
    operator: 'This is a read-only membership. Ask an owner of this account for operator access to change campaigns, posts, the inbox or the AI agent.',
    viewer: 'This membership cannot act on this account.',
};

/**
 * Express middleware factory: require at least `minimum` inside the tenant.
 *
 * Mount it **below** `resolveTenant`, which is what puts `req.tenantRole` there; it composes
 * as `requireAuth` → `requireLiveSession` → `resolveTenant` → `requireTenantRole('operator')`.
 * If `req.tenantRole` is somehow absent it resolves the role itself rather than guessing in
 * either direction — that path costs one query and cannot be reached from the router as
 * mounted today.
 *
 * **403, not 404.** The 404-instead-of-403 convention elsewhere in this app hides the
 * existence of a tenant from somebody who is not in it. That reasoning does not apply here:
 * the caller is a member, they already see the account, and telling them "your role cannot do
 * this" discloses nothing they did not know while a 404 would send them hunting for a row
 * that is right there.
 */
export interface TenantRoleGuard {
    (req: Request, res: Response, next: NextFunction): Promise<void>;
    /**
     * The minimum this guard enforces, readable off the mounted middleware.
     *
     * This is what lets `src/routes/api.test.ts` assert the actual router stack — that every
     * mutating route below `resolveTenant` carries a guard, and which one — rather than
     * asserting that a function exists somewhere. A guard nobody mounted is the failure this
     * whole change is about; a test that cannot see the mount cannot catch it.
     */
    readonly minimumRole: TenantRole;
}

export function requireTenantRole(minimum: TenantRole): TenantRoleGuard {
    const guard = async function tenantRoleGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
        const session = req.session;
        if (!session) {
            res.status(401).json({ error: 'Unauthorized.' });
            return;
        }

        let role = req.tenantRole;
        if (!role) {
            const access = await resolveTenantAccess(session);
            if (!access.allowed) {
                res.status(404).json({ error: 'Not found.' });
                return;
            }
            role = access.role;
            req.tenantRole = role;
        }

        if (tenantRoleAllows(role, minimum)) {
            next();
            return;
        }

        log('warn', 'auth.tenant_role_refused', {
            user_id: session.userId,
            tenant_id: session.tenantId,
            role,
            required: minimum,
            path: req.originalUrl,
        });
        res.status(403).json({
            error: ROLE_REFUSAL[minimum],
            code: INSUFFICIENT_ROLE_CODE,
            role,
            requiredRole: minimum,
        });
    };

    return Object.assign(guard, { minimumRole: minimum });
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

    // One membership query answers both questions — may this session act as this tenant, and
    // with what role. Stashed on the request so every `requireTenantRole` below costs nothing.
    const access = await resolveTenantAccess(session);
    if (!access.allowed) {
        // Deliberately 404, not 403: confirming a tenant exists is itself a disclosure.
        res.status(404).json({ error: 'Not found.' });
        return;
    }
    req.tenantRole = access.role;

    next();
}

// ─── Tenant predicates for SQL ──────────────────────────────────────────────────────────
//
// v12 added `creator_id` to `interactions` and `messages` and backfilled it. This predicate
// used to match the direct column and then fall back, for NULLs only, to the relationship the
// v12 backfill itself used — because at the time the webhook writers still INSERTed without
// the column, so every row arriving *then* was NULL and filtering on the column alone would
// have emptied the dashboard of that day's activity.
//
// That is no longer true, and the fallback has been removed. Both writers now set the column
// explicitly (src/webhook/comments.ts:166, src/webhook/messaging.ts:175 and :388), and the
// live database was audited read-only: 0 of 96 `interactions` rows and 0 of 12 `messages` rows
// have a NULL `creator_id`, and the fallback's own EXISTS clause rescued 0 rows. So it was
// matching nothing while forcing every query through it to give up
// `idx_interactions_creator` — a sequential scan to find rows that do not exist.

/**
 * Rows of `interactions` (aliased `i`) owned by the tenant named by a SQL expression.
 *
 * `tenantExpr` is interpolated into SQL, so it must be a literal written here in the source —
 * `'$1'`, `'c.id'` — and never a value that came from a request. The cross-tenant health query
 * needs the correlated form (`c.id`), which a bound parameter cannot express; every other
 * caller wants a parameter and uses `interactionsOwnedBy` below.
 */
export function interactionsOwnedByExpr(tenantExpr: string): string {
    return `i.creator_id = ${tenantExpr}`;
}

/** Rows of `interactions` (aliased `i`) owned by the tenant bound at `$n`. */
export function interactionsOwnedBy(n: number): string {
    return interactionsOwnedByExpr(`$${n}`);
}

// `messages` has no equivalent helper because nothing reads it by tenant directly: the inbox
// reaches messages through a conversation, and ownership is checked on the conversation, which
// does carry a reliable `creator_id`.

/**
 * Tenants this session may act as — the tenant switcher's data source.
 *
 * Each row carries the role the session holds there, because that is the only place the
 * dashboard can learn it: the session token predates in-tenant roles and carries only the
 * platform-wide one, and re-deriving it per screen would mean a membership query per page.
 * A `platform_admin` is an `owner` everywhere, which is what `resolveTenantAccess` decides.
 */
export async function listTenantsForSession(
    session: { userId: string | null; role: string }
): Promise<TenantSummary[]> {
    if (session.role === 'platform_admin') {
        const rows = await queryRows<Omit<TenantSummary, 'role'>>(
            `SELECT id, name, instagram_page_id, facebook_page_id, token_status
               FROM creators WHERE is_active = true ORDER BY name NULLS LAST, created_at`
        );
        return rows.map((row) => ({ ...row, role: 'owner' as TenantRole }));
    }
    if (!session.userId) return [];

    const rows = await queryRows<Omit<TenantSummary, 'role'> & { role: string }>(
        `SELECT c.id, c.name, c.instagram_page_id, c.facebook_page_id, c.token_status, m.role
           FROM creators c
           JOIN memberships m ON m.creator_id = c.id
          WHERE m.user_id = $1 AND c.is_active = true
          ORDER BY c.name NULLS LAST, c.created_at`,
        [session.userId]
    );
    return rows.map((row) => ({ ...row, role: normalizeTenantRole(row.role) }));
}
