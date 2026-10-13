/**
 * What P19 added to `patchProfile` (`PatchActor`, the owner's locked rule), pinned apart from `patch.test.ts`, which holds how a patch merges.
 *
 * Pinned here:
 *
 *   - **the source**: a history row says `user`, or `admin` when an admin fills the profile in for the tenant;
 *   - **`onSaved`**: runs inside the save's own transaction, only when a version was made, and fails the save with it;
 *   - **the owner's rule** (docs/TENANT_ONBOARDING_PLAN.md §4b): a patch that takes `no_women_imagery` out of the platform owner's
 *     profile is 409 `OWNER_RULE_LOCKED` unless the body confirms it, whichever route it arrived by; it locks nothing else:
 *     not another tenant, not adding the rule, not a patch that leaves it alone; and it fails closed.
 *
 * The routes' own tests are `src/routes/adminProfile.test.ts` (the admin's) and `src/routes/profile.test.ts` (the tenant's).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { patchProfile, readProfileState, removesOwnerRule } from './patch.js';
import { ProfileError, resetProfileTableWarning } from './store.js';
import { installProfileDb, OTHER, OWNER, PLATFORM_OWNER_SQL, type ProfileDb, seededState, setPlatformOwner, type State, USER } from './testDb.js';
import { richProfile, throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';

let state: State;
let db: ProfileDb;
let restoreSink: (() => void) | undefined;
const ACTOR = { userId: USER };
const REMOVE_RULE = { content: { rules: [] as string[] } };

beforeEach(() => {
    resetProfileTableWarning();
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    state = seededState();
    db = installProfileDb(state);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

const store = (id = OWNER, profile: unknown = richProfile(), version = 3): void => {
    state.profiles.set(id, { profile: throughJsonb(profile), version, activated_at: null, updated_by: null });
};
const stored = (id = OWNER): CreatorProfile => state.profiles.get(id)!.profile as CreatorProfile;
const writes = (): string[] => db.statements.map((s) => s.sql).filter((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql));
const asksWhoOwns = (): number => db.ran(PLATFORM_OWNER_SQL).length;

async function refused(fn: () => Promise<unknown>, code: ProfileError['code'], status: number): Promise<ProfileError> {
    try {
        await fn();
    } catch (err) {
        assert.ok(err instanceof ProfileError, `a ProfileError, not ${String(err)}`);
        assert.equal(err.code, code);
        assert.equal(err.status, status);
        return err;
    }
    assert.fail(`expected ${code}`);
}

describe('removesOwnerRule', () => {
    const holding = (rules: CreatorProfile['content']['rules']): Pick<CreatorProfile, 'content'> => ({ content: { ...richProfile().content, rules } });

    it('is true only when the rule was there and is not any more', () => {
        assert.equal(removesOwnerRule(holding(['no_women_imagery']), holding([])), true);
        assert.equal(removesOwnerRule(holding(['no_women_imagery']), holding(['no_women_imagery'])), false);
        assert.equal(removesOwnerRule(holding([]), holding([])), false, 'removing what is not there');
        assert.equal(removesOwnerRule(holding([]), holding(['no_women_imagery'])), false, 'adding it');
    });
});

describe('the source of a patch', () => {
    it('is `user` by default, and `admin` when an admin fills the profile in: the history row says so, with the admin as the writer', async () => {
        store();
        await patchProfile(OWNER, { version: 3, patch: { identity: { niche: 'a' } } }, ACTOR);
        await patchProfile(OWNER, { version: 4, patch: { identity: { niche: 'b' } } }, { userId: USER, source: 'admin' });
        assert.deepEqual(state.versions.map((v) => [v.version, v.source, v.updated_by]), [[4, 'user', USER], [5, 'admin', USER]]);
    });

    it('is also the change\'s source for a tenant with no stored profile: the baseline stays `backfill`, the change is the admin\'s', async () => {
        await patchProfile(OWNER, { version: null, patch: { identity: { niche: 'x' } } }, { userId: USER, source: 'admin' });
        assert.deepEqual(state.versions.map((v) => [v.version, v.source]), [[1, 'backfill'], [2, 'admin']]);
    });
});

describe('onSaved', () => {
    it('runs inside the save\'s transaction, after the version, its history and the mirror, with what changed, and before the commit', async () => {
        store();
        const calls: { changed: string[]; version: number }[] = [];
        await patchProfile(OWNER, { version: 3, patch: { identity: { niche: 'x' } } }, {
            userId: USER,
            onSaved: async (tx, saved) => {
                calls.push(saved);
                await tx.query(`UPDATE onboarding SET filled_by = 'admin' WHERE creator_id = $1`, [OWNER]);
            },
        });
        assert.deepEqual(calls, [{ changed: ['identity'], version: 4 }]);
        const sql = db.statements.map((s) => s.sql);
        const at = (pattern: RegExp): number => sql.findIndex((x) => pattern.test(x));
        const hook = at(/^UPDATE onboarding /);
        assert.ok(at(/^BEGIN$/) < at(/^INSERT INTO creator_profile_versions /), 'the history row is written inside the transaction');
        assert.ok(at(/^INSERT INTO growth_settings /) < hook, 'after the mirror');
        assert.ok(hook < at(/^COMMIT$/), 'and before the commit: it commits with the save');
    });

    it('is not called for a patch that changes nothing, nor for one that is refused', async () => {
        store();
        let called = 0;
        const actor = { userId: USER, onSaved: async () => { called++; } };
        await patchProfile(OWNER, { version: 3, patch: { identity: { niche: richProfile().identity.niche } } }, actor);
        await refused(() => patchProfile(OWNER, { version: 2, patch: { identity: { niche: 'x' } } }, actor), 'PROFILE_VERSION_CONFLICT', 409);
        await refused(() => patchProfile(OWNER, { version: 3, patch: { identity: { role: 'x'.repeat(41) } } }, actor), 'PROFILE_INVALID', 400);
        assert.equal(called, 0);
    });

    it('failing rolls the whole save back: no new version, no history row, the profile as it was', async () => {
        store();
        const before = JSON.stringify(stored());
        await assert.rejects(
            patchProfile(OWNER, { version: 3, patch: { identity: { niche: 'x' } } }, { userId: USER, onSaved: async () => { throw new Error('the hook failed'); } }),
            /the hook failed/,
        );
        assert.equal(state.profiles.get(OWNER)!.version, 3);
        assert.equal(JSON.stringify(stored()), before);
        assert.deepEqual(state.versions, []);
        assert.ok(db.ran(/^ROLLBACK$/).length > 0);
    });
});

describe('the platform owner\'s rule (no_women_imagery)', () => {
    beforeEach(() => {
        setPlatformOwner(db, OWNER);
        store();
    });

    it('a patch that removes it from the platform owner\'s profile is 409 OWNER_RULE_LOCKED, with no lock taken and nothing written', async () => {
        const err = await refused(() => patchProfile(OWNER, { version: 3, patch: REMOVE_RULE }, ACTOR), 'OWNER_RULE_LOCKED', 409);
        assert.match(err.message, /no_women_imagery/);
        assert.match(err.message, /confirm_remove_owner_rule/);
        assert.deepEqual(stored().content.rules, ['no_women_imagery']);
        assert.deepEqual(writes(), []);
        assert.equal(db.ran(/FOR (NO KEY )?UPDATE|^BEGIN$/).length, 0, 'refused before the transaction: no mutex, no connection held');
        assert.equal(state.profiles.get(OWNER)!.version, 3);
    });

    it('says the same to the tenant\'s own route and to an admin\'s: it is decided in patchProfile, for either source', async () => {
        await refused(() => patchProfile(OWNER, { version: 3, patch: REMOVE_RULE }, { userId: USER, source: 'admin' }), 'OWNER_RULE_LOCKED', 409);
        await refused(() => patchProfile(OWNER, { version: 3, patch: REMOVE_RULE }, { userId: USER, source: 'user' }), 'OWNER_RULE_LOCKED', 409);
    });

    it('goes through with confirm_remove_owner_rule: true, and the rule is gone and versioned like any change', async () => {
        const out = await patchProfile(OWNER, { version: 3, patch: REMOVE_RULE, confirm_remove_owner_rule: true }, ACTOR);
        assert.equal(out.version, 4);
        assert.deepEqual(out.changed, ['content']);
        assert.deepEqual(stored().content.rules, []);
        assert.deepEqual(state.versions.map((v) => v.version), [4]);
        assert.equal(asksWhoOwns(), 0, 'a confirmed removal never asks who the owner is');
    });

    it('a confirmation that is not exactly a boolean is a 400, and a `false` one does not confirm', async () => {
        for (const confirm of ['true', 1, 'yes', null, {}]) {
            const err = await refused(() => patchProfile(OWNER, { version: 3, patch: REMOVE_RULE, confirm_remove_owner_rule: confirm }, ACTOR), 'PROFILE_INVALID', 400);
            assert.match(err.message, /confirm_remove_owner_rule must be true or false/);
        }
        await refused(() => patchProfile(OWNER, { version: 3, patch: REMOVE_RULE, confirm_remove_owner_rule: false }, ACTOR), 'OWNER_RULE_LOCKED', 409);
        assert.deepEqual(writes(), []);
    });

    it('does not lock any other tenant: the same removal on a tenant that is not the owner just happens', async () => {
        store(OTHER, richProfile(), 2);
        const out = await patchProfile(OTHER, { version: 2, patch: REMOVE_RULE }, ACTOR);
        assert.equal(out.version, 3);
        assert.deepEqual(stored(OTHER).content.rules, []);
        assert.deepEqual(stored().content.rules, ['no_women_imagery'], 'and the owner\'s is as it was');
    });

    it('compares ids as the same uuid whatever their case', async () => {
        await refused(() => patchProfile(OWNER.toUpperCase(), { version: 3, patch: REMOVE_RULE }, ACTOR), 'OWNER_RULE_LOCKED', 409);
    });

    it('locks only a REMOVAL: changing anything else about the owner\'s profile, removing what is not there, and putting it back are free', async () => {
        const out = await patchProfile(OWNER, { version: 3, patch: { content: { custom_rules: ['No flash'], pillars: ['x'] }, identity: { niche: 'n' } } }, ACTOR);
        assert.equal(out.version, 4);
        assert.deepEqual(stored().content.rules, ['no_women_imagery'], 'the rule is untouched');
        assert.equal(asksWhoOwns(), 0, 'a patch that leaves the rule alone never asks who the owner is');
        // A profile that does not hold the rule has none to remove.
        store(OWNER, { ...richProfile(), content: { ...richProfile().content, rules: [] } }, 8);
        const again = await patchProfile(OWNER, { version: 8, patch: { content: { rules: [], pillars: ['y'] } } }, ACTOR);
        assert.equal(again.version, 9);
        const back = await patchProfile(OWNER, { version: 9, patch: { content: { rules: ['no_women_imagery'] } } }, ACTOR);
        assert.equal(back.version, 10);
        assert.deepEqual(stored().content.rules, ['no_women_imagery']);
    });

    it('a patch that changes nothing is not a removal either', async () => {
        const out = await patchProfile(OWNER, { version: 3, patch: { content: { rules: ['no_women_imagery'] } } }, ACTOR);
        assert.deepEqual(out.changed, []);
        assert.equal(asksWhoOwns(), 0);
    });

    it('locks the owner whose profile is still the virtual one his settings describe: those hold the rule too', async () => {
        state.profiles.delete(OWNER);
        const read = await readProfileState(OWNER);
        assert.equal(read.version, null);
        assert.deepEqual(read.profile.content.rules, ['no_women_imagery']);
        await refused(() => patchProfile(OWNER, { version: null, patch: REMOVE_RULE }, ACTOR), 'OWNER_RULE_LOCKED', 409);
        assert.equal(state.profiles.size, 0, 'not even the baseline was stored');
        const out = await patchProfile(OWNER, { version: null, patch: REMOVE_RULE, confirm_remove_owner_rule: true }, ACTOR);
        assert.equal(out.version, 2);
        assert.deepEqual(stored().content.rules, []);
    });

    it('with no creators at all there is no owner to lock, and an owner lookup that fails refuses the removal instead of letting it through', async () => {
        setPlatformOwner(db, null);
        const out = await patchProfile(OWNER, { version: 3, patch: REMOVE_RULE }, ACTOR);
        assert.equal(out.version, 4);
        store(OWNER, richProfile(), 3);
        setPlatformOwner(db, new Error('the pool is down'));
        await assert.rejects(patchProfile(OWNER, { version: 3, patch: REMOVE_RULE }, ACTOR), /the pool is down/);
        assert.deepEqual(stored().content.rules, ['no_women_imagery'], 'fail closed');
        assert.equal(state.profiles.get(OWNER)!.version, 3);
    });

    it('the version is checked first: a stale removal is a version conflict, not a question about the rule', async () => {
        await refused(() => patchProfile(OWNER, { version: 2, patch: REMOVE_RULE }, ACTOR), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(asksWhoOwns(), 0);
    });

    it('an invalid removal is a 400 about the profile, not a question about the rule', async () => {
        await refused(() => patchProfile(OWNER, { version: 3, patch: { content: { rules: [], domain: 'sport' } } }, ACTOR), 'PROFILE_INVALID', 400);
        assert.equal(asksWhoOwns(), 0);
    });

    it('a removal the first read did not see, found under the lock, is never saved unasked: it is a conflict to reload', async () => {
        // The first read holds no rule, so the patch is not a removal; the row is then edited under the same version (a manual SQL
        // edit) to hold it, and the read under the lock finds the rule this patch would take away.
        store(OWNER, { ...richProfile(), content: { ...richProfile().content, rules: [] } }, 3);
        db.onStatement = (sql) => {
            if (sql === 'BEGIN') state.profiles.get(OWNER)!.profile = throughJsonb(richProfile());
        };
        const err = await refused(() => patchProfile(OWNER, { version: 3, patch: { content: { rules: [], custom_rules: ['x'] } } }, ACTOR), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(err.detail.currentVersion, 3);
        assert.deepEqual(stored().content.rules, ['no_women_imagery']);
        assert.deepEqual(state.versions, []);
    });
});
