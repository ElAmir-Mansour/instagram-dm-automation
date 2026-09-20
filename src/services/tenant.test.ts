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
import { assertTenantAccess, checkSessionValidity, interactionsOwnedBy } from './tenant.js';

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
        // Two references, both $3: the direct column and the campaign fallback.
        assert.equal(sql.split('$3').length - 1, 2);
    });

    it('interpolates only the placeholder number, never a value', () => {
        // The tenant id is a parameter, never string-concatenated into SQL.
        assert.equal(/\$\d+/.test(interactionsOwnedBy(12)), true);
        assert.equal(interactionsOwnedBy(12).includes('$12'), true);
    });

    it('falls back through campaigns for rows the webhook wrote without a creator_id', () => {
        // src/webhook/comments.ts still inserts interactions without creator_id. Filtering on
        // the column alone would hide today's activity, which is indistinguishable from the
        // webhook having silently stopped — the failure this project is worst at diagnosing.
        const sql = interactionsOwnedBy(1);

        assert.match(sql, /i\.creator_id IS NULL/);
        assert.match(sql, /FROM campaigns/);
    });
});
