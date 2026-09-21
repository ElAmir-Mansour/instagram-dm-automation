/**
 * The refusals, in the cases that matter.
 *
 * The lockout guard is the one rule in the admin surface whose failure has no in-product
 * recovery: demote the last active platform admin and the only way back in is an UPDATE in
 * the Supabase SQL editor. So every combination of role, active flag and admin count is
 * exercised here rather than reasoned about.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    isPageId, isUserRole, lockoutRefusal, LOCKOUT_CODE, MIN_PASSWORD_LENGTH, passwordProblem,
    readPageIdField, readVerifyTokenField,
} from './adminGuards.js';

const lastAdmin = { id: 'a', role: 'platform_admin', is_active: true };

describe('lockoutRefusal', () => {
    it('refuses to demote the last active platform admin', () => {
        const refusal = lockoutRefusal(lastAdmin, { role: 'user' }, 0);

        assert.ok(refusal);
        assert.equal(refusal.code, LOCKOUT_CODE);
        assert.match(refusal.error, /demote/);
        // The message has to say what to do instead, or it is just a wall.
        assert.match(refusal.error, /platform admin first/);
    });

    it('refuses to deactivate the last active platform admin', () => {
        const refusal = lockoutRefusal(lastAdmin, { is_active: false }, 0);

        assert.ok(refusal);
        assert.match(refusal.error, /deactivate/);
    });

    it('names both when a patch does both at once', () => {
        const refusal = lockoutRefusal(lastAdmin, { role: 'user', is_active: false }, 0);

        assert.ok(refusal);
        assert.match(refusal.error, /demote and deactivate/);
    });

    it('allows it when another active admin exists', () => {
        assert.equal(lockoutRefusal(lastAdmin, { role: 'user' }, 1), null);
        assert.equal(lockoutRefusal(lastAdmin, { is_active: false }, 3), null);
    });

    it('allows a patch that changes neither the role nor the active flag', () => {
        // Setting role to the value it already holds is not a demotion.
        assert.equal(lockoutRefusal(lastAdmin, { role: 'platform_admin' }, 0), null);
        assert.equal(lockoutRefusal(lastAdmin, { is_active: true }, 0), null);
        assert.equal(lockoutRefusal(lastAdmin, {}, 0), null);
    });

    it('does not fire for a target who is not an active platform admin', () => {
        // An already-inactive admin is not holding the door open, so there is nothing to lose.
        const inactive = { id: 'a', role: 'platform_admin', is_active: false };
        assert.equal(lockoutRefusal(inactive, { role: 'user' }, 0), null);

        const ordinary = { id: 'b', role: 'user', is_active: true };
        assert.equal(lockoutRefusal(ordinary, { role: 'user', is_active: false }, 0), null);
    });
});

describe('isUserRole', () => {
    it('accepts exactly the two roles the schema means', () => {
        assert.equal(isUserRole('user'), true);
        assert.equal(isUserRole('platform_admin'), true);
    });

    it('rejects anything else, including near-misses', () => {
        for (const value of ['admin', 'owner', 'Platform_Admin', '', null, undefined, 42, {}]) {
            assert.equal(isUserRole(value), false, `input ${JSON.stringify(value)}`);
        }
    });
});

describe('isPageId', () => {
    it('accepts a Meta page id', () => {
        assert.equal(isPageId('17841400000000000'), true);   // IG business account id
        assert.equal(isPageId('102938475601234'), true);     // FB page id
    });

    it('rejects the pastes people actually make', () => {
        for (const value of [
            'https://instagram.com/someone',
            '@someone',
            '17841400000000000\n',   // trailing newline from a copy
            '1784 1400',             // space in the middle
            '17841400000000000a',
            '12',                    // too short to be anything real
            '',
            null,
            17841400000000000,       // a number, not a string — JSON would lose precision
        ]) {
            assert.equal(isPageId(value), false, `input ${JSON.stringify(value)}`);
        }
    });
});

describe('readPageIdField', () => {
    it('reports an absent field as absent, not as a clear', () => {
        // The distinction is the whole reason this exists: the old COALESCE form could not
        // tell "leave it alone" from "set it to null", so a facebook_page_id could never be
        // unset once set.
        assert.deepEqual(readPageIdField(undefined, 'facebook_page_id', true), { kind: 'absent' });
    });

    it('treats null and empty string as an explicit clear when the column is nullable', () => {
        assert.deepEqual(readPageIdField(null, 'facebook_page_id', true), { kind: 'clear' });
        assert.deepEqual(readPageIdField('', 'facebook_page_id', true), { kind: 'clear' });
    });

    it('refuses to clear a column the webhook routes by', () => {
        const result = readPageIdField(null, 'instagram_page_id', false);

        assert.equal(result.kind, 'error');
        assert.match((result as { error: string }).error, /every webhook/);
    });

    it('trims before validating, so a copied id with whitespace still works', () => {
        assert.deepEqual(readPageIdField('  17841400000000000 ', 'instagram_page_id', false),
            { kind: 'set', value: '17841400000000000' });
    });

    it('explains what a page id is when it rejects one', () => {
        const result = readPageIdField('@someone', 'instagram_page_id', false);

        assert.equal(result.kind, 'error');
        assert.match((result as { error: string }).error, /digits only/);
    });
});

describe('readVerifyTokenField', () => {
    it('applies the same rules as POST /api/settings/webhook-token', () => {
        // Two endpoints accepting the same column with different rules is how a value one of
        // them rejects gets in through the other.
        assert.equal(readVerifyTokenField('short').kind, 'error');
        assert.equal(readVerifyTokenField('has a space in it').kind, 'error');
        assert.deepEqual(readVerifyTokenField('  a-good-token  '),
            { kind: 'set', value: 'a-good-token' });
    });

    it('allows clearing it, and leaves it alone when absent', () => {
        assert.deepEqual(readVerifyTokenField(null), { kind: 'clear' });
        assert.deepEqual(readVerifyTokenField(undefined), { kind: 'absent' });
    });

    it('rejects a non-string rather than coercing one', () => {
        assert.equal(readVerifyTokenField(12345678).kind, 'error');
    });
});

describe('passwordProblem', () => {
    it('accepts a long enough password', () => {
        assert.equal(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH)), null);
    });

    it('rejects one character short, and says the minimum', () => {
        const problem = passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH - 1));

        assert.ok(problem);
        assert.match(problem, new RegExp(String(MIN_PASSWORD_LENGTH)));
    });

    it('rejects a missing or non-string password', () => {
        for (const value of [undefined, null, 42, {}]) {
            assert.ok(passwordProblem(value), `input ${JSON.stringify(value)}`);
        }
    });
});
