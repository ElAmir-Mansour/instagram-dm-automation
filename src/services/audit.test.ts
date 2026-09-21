/**
 * The audit trail's two invariants.
 *
 * 1. It cannot fail the action it records. Every mutating admin route awaits `writeAudit`, so
 *    a throw here would 500 a change that already happened and invite the operator to repeat
 *    it — on a route like erasure, repeating it is the last thing anyone wants.
 * 2. It cannot persist a secret. `detail` is JSONB and is served back by an admin endpoint,
 *    so a token that landed in it would be both stored and published.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    actorFromSession, AUDIT_ACTIONS, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT, clampAuditLimit,
    isAuditAction, LEGACY_ACTOR_EMAIL, redactDetail, writeAudit,
} from './audit.js';

/** An executor that records what it was asked to insert. */
function recordingExecutor() {
    const calls: unknown[][] = [];
    return {
        calls,
        async query(_sql: string, params?: unknown[]) {
            calls.push(params ?? []);
            return { rows: [{ id: 'audit-1' }] };
        },
    };
}

describe('writeAudit', () => {
    it('writes the row and returns its id', async () => {
        const exec = recordingExecutor();

        const result = await writeAudit(
            { userId: 'u-1', email: 'a@b.co' },
            { action: AUDIT_ACTIONS.tenantUpdate, targetType: 'creator', targetId: 'c-1', detail: { fields: ['name'] } },
            exec
        );

        assert.deepEqual(result, { written: true, id: 'audit-1' });
        assert.deepEqual(exec.calls[0]?.slice(0, 5),
            ['u-1', 'a@b.co', 'tenant.update', 'creator', 'c-1']);
    });

    it('reports failure instead of throwing when the ledger is unreachable', async () => {
        // The likely cause is migration v15 not being applied. An operator who cannot
        // deactivate a tenant is worse off than one whose change went unrecorded.
        const exploding = {
            async query() { throw Object.assign(new Error('relation "audit_log" does not exist'), { code: '42P01' }); },
        };

        const result = await writeAudit(
            { userId: null, email: LEGACY_ACTOR_EMAIL },
            { action: AUDIT_ACTIONS.jobRetry },
            exploding as never
        );

        assert.deepEqual(result, { written: false, id: null });
    });

    it('redacts a secret-shaped key before it can be persisted', async () => {
        const exec = recordingExecutor();

        await writeAudit(
            { userId: null, email: LEGACY_ACTOR_EMAIL },
            {
                action: AUDIT_ACTIONS.tenantTokenWrite,
                detail: { page_access_token: 'EAAG-real-token', instagram_page_id: '17841400000000000' },
            },
            exec
        );

        const detail = JSON.parse(String(exec.calls[0]?.[5]));
        assert.equal(detail.page_access_token, '[redacted]');
        assert.equal(detail.instagram_page_id, '17841400000000000');
    });
});

describe('redactDetail', () => {
    it('blanks every key the log redactor would blank', async () => {
        const out = redactDetail({
            page_access_token: 'x', apiKey: 'x', API_KEY: 'x', password: 'x', passwd: 'x',
            secret: 'x', authorization: 'x', signature: 'x', cookie: 'x',
        });

        assert.ok(out);
        for (const value of Object.values(out)) assert.equal(value, '[redacted]');
    });

    it('keeps every key the admin routes actually write', () => {
        // Found by running a real re-check against a live Postgres: the detail on a
        // `tenant.token_recheck` row was `{token_status: "[redacted]", token_type:
        // "[redacted]"}` — it recorded that somebody pressed the button and nothing about the
        // answer, which is the half an operator needs. The routes now spell those two facts
        // without the trigger word, and this is the test that keeps them that way.
        const out = redactDetail({
            fields: ['name', 'is_active'],
            is_active: false,
            credential_replaced: true,
            credential_type: 'PAGE',
            result_status: 'invalid',
            missing_scopes: ['pages_messaging'],
            verify_value_changed: true,
            instagram_page_id: '17841400000000000',
        });

        assert.ok(out);
        assert.deepEqual(out.fields, ['name', 'is_active']);
        assert.equal(out.is_active, false);
        assert.equal(out.credential_replaced, true);
        assert.equal(out.credential_type, 'PAGE');
        assert.equal(out.result_status, 'invalid');
        assert.deepEqual(out.missing_scopes, ['pages_messaging']);
        assert.equal(out.verify_value_changed, true);
        assert.equal(out.instagram_page_id, '17841400000000000');
    });

    it('still blanks the trigger-word spellings, because the pattern stays broad', () => {
        // The pattern cannot tell `token_status: "invalid"` from `token: "EAAG..."`, and
        // erring towards blanking is the right direction. Asserted so nobody "fixes" the
        // pattern by narrowing it.
        const out = redactDetail({ token_status: 'invalid', token_type: 'PAGE' });

        assert.ok(out);
        assert.equal(out.token_status, '[redacted]');
        assert.equal(out.token_type, '[redacted]');
    });

    it('drops undefined rather than storing nulls for fields nobody touched', () => {
        const out = redactDetail({ kept: 1, dropped: undefined });

        assert.deepEqual(out, { kept: 1 });
    });

    it('maps an absent detail to null, not to an error', () => {
        assert.equal(redactDetail(null), null);
        assert.equal(redactDetail(undefined), null);
    });
});

describe('actorFromSession', () => {
    it('names the shared-password session rather than leaving the actor blank', async () => {
        // This is the only kind of session that exists on this deployment: the `users` table
        // is empty, so every admin action today is "somebody holding the dashboard password".
        // A NULL email would read as a bug in the ledger.
        assert.deepEqual(await actorFromSession({ userId: null, role: 'platform_admin' }), {
            userId: null, email: LEGACY_ACTOR_EMAIL,
        });
        assert.deepEqual(await actorFromSession(undefined), {
            userId: null, email: LEGACY_ACTOR_EMAIL,
        });
    });
});

describe('clampAuditLimit', () => {
    it('defaults when the limit is absent or unparseable', () => {
        for (const raw of [undefined, null, '', 'abc', {}]) {
            assert.equal(clampAuditLimit(raw), AUDIT_DEFAULT_LIMIT, `input ${JSON.stringify(raw)}`);
        }
    });

    it('clamps to the range rather than refusing', () => {
        assert.equal(clampAuditLimit('0'), 1);
        assert.equal(clampAuditLimit('-10'), 1);
        assert.equal(clampAuditLimit('100000'), AUDIT_MAX_LIMIT);
        assert.equal(clampAuditLimit('25'), 25);
        assert.equal(clampAuditLimit('25.9'), 25);
    });
});

describe('isAuditAction', () => {
    it('accepts every name this codebase writes', () => {
        for (const action of Object.values(AUDIT_ACTIONS)) {
            assert.equal(isAuditAction(action), true, action);
        }
    });

    it('rejects an unknown filter rather than returning an empty list', () => {
        // An operator filtering on a typo should be told, not shown "no results" — which
        // reads as "nothing has happened", the opposite of the truth.
        for (const value of ['tenant.updated', 'DROP TABLE', '', null, 42]) {
            assert.equal(isAuditAction(value), false, `input ${JSON.stringify(value)}`);
        }
    });
});
