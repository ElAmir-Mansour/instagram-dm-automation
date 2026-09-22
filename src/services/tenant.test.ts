/**
 * Tenancy decisions.
 *
 * Three rules decide whether a request may see a row: may this session act as this tenant,
 * is this session still alive, and does the SQL actually filter. Each is asserted here
 * against the function that makes it, without a database — the membership lookup and the
 * user row are both injected, so what is under test is the decision and not `pg`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pool } from '../config/db.js';
import {
    assertTenantAccess, checkSessionValidity, interactionsOwnedBy, interactionsOwnedByExpr,
    INSUFFICIENT_ROLE_CODE, normalizeTenantRole, requireTenantRole, resolveTenant,
    resolveTenantAccess, tenantRoleAllows,
} from './tenant.js';

/** A membership lookup that answers yes only for the pairs it was given. */
function membershipsOf(...pairs: [string, string][]) {
    const calls: [string, string][] = [];
    const lookup = async (userId: string, tenantId: string) => {
        calls.push([userId, tenantId]);
        return pairs.some(([u, t]) => u === userId && t === tenantId);
    };
    return { lookup, calls };
}

describe('assertTenantAccess', () => {
    it('lets a platform_admin act as any tenant', async () => {
        // This is what powers the tenant switcher: an admin holds no memberships at all.
        const { lookup, calls } = membershipsOf();
        const allowed = await assertTenantAccess(
            { userId: 'u-1', role: 'platform_admin', tenantId: 'tenant-nobody-joined' },
            lookup
        );

        assert.equal(allowed, true);
        assert.equal(calls.length, 0, 'admin must not need a membership lookup');
    });

    it('still lets a platform_admin in after every membership is revoked', async () => {
        // This is what `DELETE /api/admin/users/:id/memberships/:creatorId` relies on, and why
        // that route is deliberately NOT guarded against admin lockout the way the role and
        // active flags are: a platform_admin reaches every tenant with no memberships at all,
        // so removing their last one cannot lock anybody out of anything.
        const { lookup } = membershipsOf();

        assert.equal(
            await assertTenantAccess({ userId: 'u-1', role: 'platform_admin', tenantId: 't-9' }, lookup),
            true
        );
    });

    it('lets a user act as a tenant they hold a membership in', async () => {
        const { lookup } = membershipsOf(['u-1', 't-1']);

        assert.equal(
            await assertTenantAccess({ userId: 'u-1', role: 'user', tenantId: 't-1' }, lookup),
            true
        );
    });

    it('refuses a user acting as someone else\'s tenant', async () => {
        // The whole point: holding a valid session for t-1 must not reach t-2.
        const { lookup } = membershipsOf(['u-1', 't-1']);

        assert.equal(
            await assertTenantAccess({ userId: 'u-1', role: 'user', tenantId: 't-2' }, lookup),
            false
        );
    });

    it('checks the membership against the database, not the token', async () => {
        // A token keeps asserting its tenant for a full 24h, so the check has to be live —
        // otherwise revoking a membership does nothing until the session happens to expire.
        const { lookup, calls } = membershipsOf(['u-1', 't-1']);
        await assertTenantAccess({ userId: 'u-1', role: 'user', tenantId: 't-1' }, lookup);

        assert.deepEqual(calls, [['u-1', 't-1']]);
    });

    it('refuses a session with no tenant at all', async () => {
        const { lookup } = membershipsOf(['u-1', 't-1']);

        assert.equal(
            await assertTenantAccess({ userId: 'u-1', role: 'user', tenantId: null }, lookup),
            false
        );
    });

    it('refuses a non-admin session carrying no user id', async () => {
        // There is nothing to look a membership up by, so it cannot be granted.
        const { lookup, calls } = membershipsOf();

        assert.equal(
            await assertTenantAccess({ userId: null, role: 'user', tenantId: 't-1' }, lookup),
            false
        );
        assert.equal(calls.length, 0);
    });

    it('does not treat an unrecognised role as admin', async () => {
        const { lookup } = membershipsOf();

        assert.equal(
            await assertTenantAccess({ userId: 'u-1', role: 'admin', tenantId: 't-1' }, lookup),
            false,
            "only the exact string 'platform_admin' grants cross-tenant access"
        );
    });
});

describe('checkSessionValidity', () => {
    const live = { token_version: 3, is_active: true };

    it('accepts a session whose token_version still matches', () => {
        assert.deepEqual(checkSessionValidity({ userId: 'u-1', tokenVersion: 3 }, live), { ok: true });
    });

    it('rejects a session minted before the version was bumped', () => {
        // Bumping users.token_version is the only way to kill a stateless 24h token.
        const result = checkSessionValidity({ userId: 'u-1', tokenVersion: 2 }, live);

        assert.equal(result.ok, false);
        assert.equal(result.reason, 'revoked');
    });

    it('rejects a session minted after the version was bumped', () => {
        // Not forgeable, but a mismatch in either direction means the token is not the
        // current one, and "newer" is not a reason to trust it.
        assert.equal(checkSessionValidity({ userId: 'u-1', tokenVersion: 4 }, live).ok, false);
    });

    it('rejects a disabled account', () => {
        const result = checkSessionValidity(
            { userId: 'u-1', tokenVersion: 3 },
            { token_version: 3, is_active: false }
        );

        assert.equal(result.ok, false);
        assert.equal(result.reason, 'disabled');
    });

    it('rejects a session naming a user that no longer exists', () => {
        for (const missing of [undefined, null]) {
            const result = checkSessionValidity({ userId: 'u-1', tokenVersion: 3 }, missing);
            assert.equal(result.ok, false);
            assert.equal(result.reason, 'unknown_user');
        }
    });

    it('lets the legacy shared-password session through', () => {
        // It carries no user row, so there is nothing to revoke against — it is bounded by
        // DASHBOARD_PASSWORD and the 24h TTL instead. Removing this branch would lock the
        // operator out of their own dashboard.
        assert.deepEqual(checkSessionValidity({ userId: null, tokenVersion: 0 }, undefined), { ok: true });
    });
});

describe('interactionsOwnedBy', () => {
    it('binds every tenant reference to the same placeholder', () => {
        const sql = interactionsOwnedBy(3);

        assert.match(sql, /i\.creator_id = \$3/);
        assert.equal(sql.includes('$1'), false, 'no stray placeholder from a copied predicate');
        assert.equal(sql.split('$3').length - 1, 1);
    });

    it('interpolates only the placeholder number, never a value', () => {
        // The tenant id is a parameter, never string-concatenated into SQL.
        assert.equal(/\$\d+/.test(interactionsOwnedBy(12)), true);
        assert.equal(interactionsOwnedBy(12).includes('$12'), true);
    });

    it('no longer carries the campaigns fallback, so the index can be used', () => {
        // It used to match `creator_id IS NULL` and join through `campaigns`, for rows the
        // webhook wrote before it set the column. Both writers set it now, and a read-only
        // audit of the live database found 0 of 96 interactions and 0 of 12 messages with a
        // NULL creator_id — so the fallback rescued nothing and cost every query the use of
        // `idx_interactions_creator`. If a NULL-writing path is ever reintroduced, this test
        // is the thing that should be reconsidered along with it.
        const sql = interactionsOwnedBy(1);

        assert.equal(sql.includes('IS NULL'), false);
        assert.equal(sql.includes('campaigns'), false);
    });

    it('takes a correlated expression for the cross-tenant health query', () => {
        // `/api/admin/ops` reports every tenant in one statement, so the tenant reference has
        // to be a column from the outer query rather than a bound parameter.
        assert.equal(interactionsOwnedByExpr('c.id'), 'i.creator_id = c.id');
    });
});

// ─── In-tenant roles ────────────────────────────────────────────────────────────────────
//
// `memberships.role` was decorative until now: stored, displayed, audited, and never read by
// any authorization decision. Turning a decorative column into an enforced one against a live
// deployment has exactly one way to go badly — somebody who can do their job today cannot do
// it after the deploy — so the tests below are weighted towards that, not towards the
// restriction working.

describe('normalizeTenantRole', () => {
    it('keeps the two restricted roles', () => {
        assert.equal(normalizeTenantRole('operator'), 'operator');
        assert.equal(normalizeTenantRole('viewer'), 'viewer');
    });

    it('resolves every value in the live database today to owner', () => {
        // The no-lockout guarantee, stated as a test. Every membership row that exists carries
        // 'owner' (the v12 default, and what every code path wrote) or 'member' (the only
        // other value the old grant form could produce). Both meant full access, because
        // nothing read the column. Both must keep meaning full access.
        assert.equal(normalizeTenantRole('owner'), 'owner');
        assert.equal(normalizeTenantRole('member'), 'owner');
    });

    it('fails OPEN on anything it does not recognise', () => {
        // Deliberate, and the opposite of the usual instinct. This function runs against rows
        // written when the column meant nothing; a closed default would refuse a real operator
        // their own campaigns on the first request after deploy. Restriction is opt-in — an
        // operator picks 'operator' or 'viewer' — exactly as match_mode was introduced in v14.
        const unrecognised: unknown[] = ['', ' ', 'admin', 'OWNER', 'Viewer', 'whatever', null, undefined, 0, {}, []];
        for (const value of unrecognised) {
            assert.equal(normalizeTenantRole(value), 'owner', `${JSON.stringify(value)} must not restrict`);
        }
    });
});

describe('tenantRoleAllows', () => {
    it('lets an owner do everything', () => {
        assert.equal(tenantRoleAllows('owner', 'owner'), true);
        assert.equal(tenantRoleAllows('owner', 'operator'), true);
        assert.equal(tenantRoleAllows('owner', 'viewer'), true);
    });

    it('stops an operator at the Meta connection', () => {
        // The one distinction two tiers could not express: running the account is not the same
        // permission as holding the credentials that post as the business anywhere.
        assert.equal(tenantRoleAllows('operator', 'operator'), true);
        assert.equal(tenantRoleAllows('operator', 'viewer'), true);
        assert.equal(tenantRoleAllows('operator', 'owner'), false);
    });

    it('lets a viewer only read', () => {
        assert.equal(tenantRoleAllows('viewer', 'viewer'), true);
        assert.equal(tenantRoleAllows('viewer', 'operator'), false);
        assert.equal(tenantRoleAllows('viewer', 'owner'), false);
    });
});

/** A membership-role lookup that answers with whatever it was given, and records the calls. */
function rolesOf(pairs: Record<string, string>) {
    const calls: [string, string][] = [];
    const lookup = async (userId: string, tenantId: string) => {
        const key = `${userId}:${tenantId}`;
        calls.push([userId, tenantId]);
        return Object.prototype.hasOwnProperty.call(pairs, key) ? pairs[key]! : null;
    };
    return { lookup, calls };
}

describe('resolveTenantAccess', () => {
    it('makes a platform_admin an owner of every tenant, with no lookup', async () => {
        const { lookup, calls } = rolesOf({});
        const access = await resolveTenantAccess(
            { userId: 'u-1', role: 'platform_admin', tenantId: 't-nobody-joined' }, lookup
        );

        assert.deepEqual(access, { allowed: true, role: 'owner' });
        assert.equal(calls.length, 0, 'an admin holds no membership to look up');
    });

    it('makes the legacy shared-password session an owner', async () => {
        // createLegacySession mints { userId: null, role: 'platform_admin' }. It has no user
        // row and therefore no membership, so the admin branch is the only one that can handle
        // it — and it is the only way into a deployment that has no users yet. Refusing it
        // here would lock the operator out of their own dashboard.
        const { lookup, calls } = rolesOf({});
        const access = await resolveTenantAccess(
            { userId: null, role: 'platform_admin', tenantId: 't-1' }, lookup
        );

        assert.deepEqual(access, { allowed: true, role: 'owner' });
        assert.equal(calls.length, 0);
    });

    it('gives an existing membership row the access it has today', async () => {
        const { lookup } = rolesOf({ 'u-1:t-1': 'owner', 'u-2:t-1': 'member' });

        assert.deepEqual(
            await resolveTenantAccess({ userId: 'u-1', role: 'user', tenantId: 't-1' }, lookup),
            { allowed: true, role: 'owner' }
        );
        // 'member' is the legacy value the old grant form wrote, and it never restricted
        // anything.
        assert.deepEqual(
            await resolveTenantAccess({ userId: 'u-2', role: 'user', tenantId: 't-1' }, lookup),
            { allowed: true, role: 'owner' }
        );
    });

    it('carries a restricted role through', async () => {
        const { lookup } = rolesOf({ 'u-3:t-1': 'operator', 'u-4:t-1': 'viewer' });

        assert.equal((await resolveTenantAccess({ userId: 'u-3', role: 'user', tenantId: 't-1' }, lookup)).role, 'operator');
        assert.equal((await resolveTenantAccess({ userId: 'u-4', role: 'user', tenantId: 't-1' }, lookup)).role, 'viewer');
    });

    it('refuses a session with no membership at all', async () => {
        const { lookup } = rolesOf({ 'u-1:t-1': 'owner' });

        assert.equal((await resolveTenantAccess({ userId: 'u-1', role: 'user', tenantId: 't-2' }, lookup)).allowed, false);
    });

    it('reads the role live, so a demotion takes effect at once', async () => {
        // The session token carries only the platform-wide role and is valid for 24h. If the
        // in-tenant role were read from it, demoting somebody would do nothing until their
        // token expired.
        const { lookup, calls } = rolesOf({ 'u-1:t-1': 'viewer' });
        await resolveTenantAccess({ userId: 'u-1', role: 'user', tenantId: 't-1' }, lookup);

        assert.deepEqual(calls, [['u-1', 't-1']]);
    });

    it('refuses a non-admin session carrying no user id', async () => {
        const { lookup } = rolesOf({});

        assert.equal((await resolveTenantAccess({ userId: null, role: 'user', tenantId: 't-1' }, lookup)).allowed, false);
    });

    it('does not treat an unrecognised platform role as admin', async () => {
        const { lookup } = rolesOf({});

        assert.equal(
            (await resolveTenantAccess({ userId: 'u-1', role: 'superuser', tenantId: 't-1' }, lookup)).allowed,
            false
        );
    });
});

/** A minimal Express double: enough for a middleware that reads the session and writes json. */
function fakeExchange(session: unknown, tenantRole?: string) {
    const res = {
        statusCode: 0,
        body: null as unknown,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
    let nextCalled = false;
    const req = { session, tenantRole, originalUrl: '/api/test' };
    return { req, res, next: () => { nextCalled = true; }, passed: () => nextCalled };
}

/**
 * `resolveTenant` is what puts the role on the request, and every guard below it reads that.
 *
 * Asserted against a stubbed pool rather than through the decision function, because the
 * decision function was never the risk: the wiring is. Hand every request the wrong role here
 * and the guards keep working perfectly on the wrong input.
 */
describe('resolveTenant — the role it carries', () => {
    async function runResolveTenant(session: unknown, storedRole: string | null) {
        const req = { session, tenantRole: undefined as string | undefined };
        const res = {
            statusCode: 0,
            body: null as unknown,
            status(code: number) { this.statusCode = code; return this; },
            json(payload: unknown) { this.body = payload; return this; },
        };
        let passed = false;

        const original = pool.query;
        (pool as unknown as { query: unknown }).query = async () => ({
            rows: storedRole === null ? [] : [{ role: storedRole }],
            rowCount: storedRole === null ? 0 : 1,
        });
        try {
            await resolveTenant(req as never, res as never, () => { passed = true; });
        } finally {
            (pool as unknown as { query: unknown }).query = original;
        }
        return { req, res, passed };
    }

    it('carries a restricted role from the database to the guards', async () => {
        const { req, passed } = await runResolveTenant(
            { userId: 'u-1', role: 'user', tenantId: 't-1' }, 'viewer'
        );

        assert.equal(passed, true, 'a viewer still holds a membership and may read');
        assert.equal(req.tenantRole, 'viewer');
    });

    it('carries owner for the row every membership has today', async () => {
        const { req, passed } = await runResolveTenant(
            { userId: 'u-1', role: 'user', tenantId: 't-1' }, 'owner'
        );

        assert.equal(passed, true);
        assert.equal(req.tenantRole, 'owner');
    });

    it('carries owner for the legacy value the old grant form wrote', async () => {
        const { req } = await runResolveTenant({ userId: 'u-1', role: 'user', tenantId: 't-1' }, 'member');

        assert.equal(req.tenantRole, 'owner', 'a "member" must keep the access they have today');
    });

    it('makes a platform_admin an owner without reading a membership', async () => {
        // `storedRole: null` means the stub would answer "no membership" — an admin must not
        // be denied by that, and must not be handed a restricted role either.
        const { req, passed } = await runResolveTenant(
            { userId: 'u-admin', role: 'platform_admin', tenantId: 't-1' }, null
        );

        assert.equal(passed, true);
        assert.equal(req.tenantRole, 'owner');
    });

    it('404s a session with no membership, and carries no role onward', async () => {
        const { req, res, passed } = await runResolveTenant(
            { userId: 'u-1', role: 'user', tenantId: 't-1' }, null
        );

        assert.equal(passed, false);
        assert.equal(res.statusCode, 404);
        assert.equal(req.tenantRole, undefined);
    });
});

describe('requireTenantRole', () => {
    it('lets an owner through every guard', async () => {
        // The single most important assertion in this file. Every membership that exists today
        // resolves to `owner`, so this is "nobody currently using the product loses anything".
        for (const minimum of ['owner', 'operator', 'viewer'] as const) {
            const x = fakeExchange({ userId: 'u-1', role: 'user', tenantId: 't-1' }, 'owner');
            await requireTenantRole(minimum)(x.req as never, x.res as never, x.next);

            assert.equal(x.passed(), true, `an owner must pass a ${minimum} guard`);
            assert.equal(x.res.statusCode, 0, 'and nothing may be written to the response');
        }
    });

    it('lets a platform_admin through without a resolved role on the request', async () => {
        // `req.tenantRole` can legitimately be absent — the guard resolves it rather than
        // guessing in either direction, and for an admin that resolution never touches the
        // database.
        const x = fakeExchange({ userId: 'u-admin', role: 'platform_admin', tenantId: 't-1' });
        await requireTenantRole('owner')(x.req as never, x.res as never, x.next);

        assert.equal(x.passed(), true);
    });

    it('lets the legacy shared-password session through', async () => {
        const x = fakeExchange({ userId: null, role: 'platform_admin', tenantId: 't-1' });
        await requireTenantRole('owner')(x.req as never, x.res as never, x.next);

        assert.equal(x.passed(), true, 'the only way into a deployment that has no users yet');
    });

    it('refuses an operator the Meta connection', async () => {
        const x = fakeExchange({ userId: 'u-3', role: 'user', tenantId: 't-1' }, 'operator');
        await requireTenantRole('owner')(x.req as never, x.res as never, x.next);

        assert.equal(x.passed(), false);
        // 403 and not 404 on purpose: the caller is a member and already sees the account, so
        // the existence-hiding reason for 404 elsewhere does not apply — and a 404 would send
        // them hunting for a row that is right in front of them.
        assert.equal(x.res.statusCode, 403);
        const body = x.res.body as Record<string, unknown>;
        assert.equal(body['code'], INSUFFICIENT_ROLE_CODE);
        assert.equal(body['requiredRole'], 'owner');
        assert.equal(body['role'], 'operator');
    });

    it('refuses a viewer every write', async () => {
        for (const minimum of ['owner', 'operator'] as const) {
            const x = fakeExchange({ userId: 'u-4', role: 'user', tenantId: 't-1' }, 'viewer');
            await requireTenantRole(minimum)(x.req as never, x.res as never, x.next);

            assert.equal(x.passed(), false, `a viewer must not pass a ${minimum} guard`);
            assert.equal(x.res.statusCode, 403);
        }
    });

    it('lets an operator run the account', async () => {
        const x = fakeExchange({ userId: 'u-3', role: 'user', tenantId: 't-1' }, 'operator');
        await requireTenantRole('operator')(x.req as never, x.res as never, x.next);

        assert.equal(x.passed(), true);
    });

    it('401s a request with no session at all', async () => {
        const x = fakeExchange(undefined);
        await requireTenantRole('viewer')(x.req as never, x.res as never, x.next);

        assert.equal(x.passed(), false);
        assert.equal(x.res.statusCode, 401);
    });

    it('carries the minimum it enforces, so the route table can be asserted', () => {
        assert.equal(requireTenantRole('owner').minimumRole, 'owner');
        assert.equal(requireTenantRole('operator').minimumRole, 'operator');
    });
});
