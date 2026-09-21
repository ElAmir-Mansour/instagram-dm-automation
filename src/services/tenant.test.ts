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
import {
    assertTenantAccess, checkSessionValidity, interactionsOwnedBy, interactionsOwnedByExpr,
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
