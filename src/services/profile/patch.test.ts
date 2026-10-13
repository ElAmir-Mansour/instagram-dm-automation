/**
 * Changing the profile by a patch (P5): `mergePatch`, `changedSections` and `patchProfile`, the part of
 * `PATCH /api/profile` that is not HTTP (the route's own tests are `src/routes/profile.test.ts`).
 *
 * Pinned here: how a patch merges (objects by key, everything else replaced, `null` removing an entry from the maps keyed
 * by name and the heatmap timezone), that a patch cannot write through `__proto__`, that a stale version never reaches a
 * merge, that a patch that changes nothing writes nothing, that what is stored is validated, versioned, historied and
 * mirrored like any save, and the three things the transaction is for: the read the merge is made on is taken under the
 * tenant's mutex (a settings write that lands first is merged onto, not overwritten), nothing that refuses takes the mutex,
 * and a tenant whose legacy rows are not a valid profile can still be repaired.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { resetProfileTableWarning, ProfileError } from './store.js';
import { changedSections, MAX_PATCH_DEPTH, mergePatch, nestedTooDeep, patchProfile, readProfileState } from './patch.js';
import { defaultProfile } from './defaults.js';
import { installProfileDb, OWNER, OWNER_STUDIO, type ProfileDb, seededState, USER, type State } from './testDb.js';
import { deepFreeze, richProfile, throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';

describe('mergePatch', () => {
    const base = (): CreatorProfile => richProfile();

    it('merges objects key by key, recursively, and leaves what the patch does not name', () => {
        const out = mergePatch(base(), { identity: { niche: 'Strength for beginners', display_name: { en: 'Sami' } } }) as CreatorProfile;
        assert.equal(out.identity.niche, 'Strength for beginners');
        assert.deepEqual(out.identity.display_name, { ar: 'سامي للياقة', en: 'Sami' }, 'a sibling key is kept');
        assert.equal(out.identity.role, 'fitness coach');
        assert.deepEqual(out.offers, base().offers);
    });

    it('replaces a list with the list sent, and a scalar with the scalar', () => {
        const out = mergePatch(base(), { content: { pillars: ['Mobility'] }, voice: { emoji: 'none' }, goals: { views: 7 } }) as CreatorProfile;
        assert.deepEqual(out.content.pillars, ['Mobility'], 'not appended to');
        assert.equal(out.voice.emoji, 'none');
        assert.deepEqual(out.goals, { followers: 5000, views: 7 });
        assert.deepEqual(out.content.never_mention, ['steroids', 'crash diets']);
        const offers = [richProfile().offers[1]!];
        assert.deepEqual((mergePatch(base(), { offers }) as CreatorProfile).offers, offers, 'a list of objects is replaced whole, not merged by position');
    });

    it('sets a field null with null, and fills a null one with an object (a presenter, a handoff)', () => {
        const cleared = mergePatch(base(), { presenter: null, dm: { handoff: null, hours: null }, identity: { kind: null } }) as CreatorProfile;
        assert.equal(cleared.presenter, null);
        assert.equal(cleared.dm.handoff, null);
        assert.equal(cleared.dm.hours, null);
        assert.equal(cleared.identity.kind, null);
        assert.deepEqual(cleared.dm.faq, base().dm.faq, 'a sibling is kept');
        const filled = mergePatch(defaultProfile(), { presenter: { name: 'Sami', pronouns: 'they', on_camera: 'face' }, dm: { handoff: { when: 'A refund', message: 'Soon.' } } }) as CreatorProfile;
        assert.deepEqual(filled.presenter, { name: 'Sami', pronouns: 'they', on_camera: 'face' });
        assert.deepEqual(filled.dm.handoff, { when: 'A refund', message: 'Soon.' });
        assert.equal(filled.dm.hours, null);
        // An object that is already there merges: a presenter's pronouns alone.
        const merged = mergePatch(base(), { presenter: { pronouns: 'he' } }) as CreatorProfile;
        assert.deepEqual(merged.presenter, { name: 'Sami', pronouns: 'he', on_camera: 'mixed' });
    });

    it('merges the maps keyed by name, and a null there removes the entry', () => {
        // richProfile: carousel { language: 'en' }, infographic { language: 'ar', register: 'msa' }, dm { register: 'levantine' }.
        const set = mergePatch(base(), { language: { surfaces: { reels: { register: 'gulf' }, dm: { language: 'ar' } } } }) as CreatorProfile;
        assert.deepEqual(set.language.surfaces, {
            carousel: { language: 'en' }, infographic: { language: 'ar', register: 'msa' }, dm: { register: 'levantine', language: 'ar' }, reels: { register: 'gulf' },
        }, 'a surface is merged into, another added, the rest kept');
        const dropped = mergePatch(base(), { language: { surfaces: { dm: null, infographic: { register: null } } } }) as CreatorProfile;
        assert.deepEqual(dropped.language.surfaces, { carousel: { language: 'en' }, infographic: { language: 'ar' } }, 'a null takes a surface, or one field of it, away');
        const links = mergePatch(base(), { socials: { links: { instagram: null, youtube: 'https://youtube.com/@sami' } } }) as CreatorProfile;
        assert.deepEqual(links.socials.links, { youtube: 'https://youtube.com/@sami' });
        assert.equal(links.socials.handle, '@sami.fit');
    });

    it('removes the heatmap timezone with null, as the Growth settings do, and a null for one that is not there is nothing', () => {
        const out = mergePatch(base(), { audience: { timezone: null } }) as CreatorProfile;
        assert.ok(!('timezone' in out.audience), 'the key is gone, not null');
        assert.deepEqual({ ...out.audience, timezone: 'Asia/Dubai' }, base().audience, 'and nothing else of the audience moved');
        const absent = mergePatch(out, { audience: { timezone: null } }) as CreatorProfile;
        assert.deepEqual(absent, out);
        assert.deepEqual(changedSections(out, absent), []);
        assert.equal(((mergePatch(base(), { audience: { timezone: 'Europe/London' } }) as CreatorProfile).audience.timezone), 'Europe/London', 'a value still sets it');
    });

    it('does not remove an ordinary field by sending null for it: that is a value, and the validator judges it', () => {
        const out = mergePatch(base(), { identity: { niche: null } }) as CreatorProfile;
        assert.equal(out.identity.niche, null);
    });

    it('changes neither argument, and shares nothing with the patch', () => {
        const current = deepFreeze(base());
        const patch = deepFreeze({ content: { pillars: ['Mobility'] }, offers: [richProfile().offers[0]] });
        const out = mergePatch(current, patch) as CreatorProfile;
        assert.notEqual(out.content.pillars, (patch.content as { pillars: string[] }).pillars);
        assert.notEqual(out.offers[0], patch.offers[0]);
        assert.notEqual(out.identity, current.identity);
    });

    it('a patch key named __proto__ is an ordinary key (the validator then refuses it), never a prototype', () => {
        const patch = JSON.parse('{"__proto__": {"polluted": true}, "identity": {"__proto__": {"polluted": true}}}');
        const out = mergePatch(base(), patch) as Record<string, any>;
        assert.equal(Object.getPrototypeOf(out), Object.prototype);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
        assert.ok(Object.hasOwn(out, '__proto__'), 'kept as an own key, which an unknown-key check sees');
        assert.ok(Object.hasOwn(out.identity, '__proto__'));
    });

    it('recurses only as deep as the profile does: a nested patch under a scalar field is just a value', () => {
        let nested: unknown = 'x';
        for (let i = 0; i < 6; i++) nested = { a: nested };
        const out = mergePatch(base(), { identity: { niche: nested } }) as CreatorProfile;
        assert.deepEqual(out.identity.niche, nested);
    });
});

describe('nestedTooDeep', () => {
    const nest = (levels: number): unknown => {
        let v: unknown = 'x';
        for (let i = 0; i < levels; i++) v = { a: v };
        return v;
    };

    it('allows everything a profile can hold, and stops at MAX_PATCH_DEPTH without overflowing however deep the value is', () => {
        const deepest = { offers: [{ campaign: { keywords: ['a'] } }] };
        assert.equal(nestedTooDeep(deepest), false, 'the deepest field a profile has');
        assert.equal(nestedTooDeep(nest(MAX_PATCH_DEPTH)), false);
        assert.equal(nestedTooDeep(nest(MAX_PATCH_DEPTH + 1)), true);
        assert.equal(nestedTooDeep(nest(200_000)), true, 'does not recurse past the limit');
        assert.equal(nestedTooDeep([[[[[[[[[1]]]]]]]]]), true, 'lists count too');
        assert.equal(nestedTooDeep('x'), false);
        assert.equal(nestedTooDeep(null), false);
    });
});

describe('changedSections', () => {
    it('names the top-level sections that differ, in the profile\'s order, and says nothing of values', () => {
        const before = richProfile();
        const after = mergePatch(before, { voice: { emoji: 'none' }, identity: { niche: 'x' }, offers: [] }) as CreatorProfile;
        assert.deepEqual(changedSections(before, after), ['identity', 'offers', 'voice']);
        assert.deepEqual(changedSections(before, structuredClone(before)), []);
    });

    it('is blind to key order, sees a section a patch invented, and sees a removed one', () => {
        const before = richProfile();
        const reordered = throughJsonb(before) as CreatorProfile;
        assert.deepEqual(changedSections(before, reordered), []);
        assert.deepEqual(changedSections(before, { ...before, zebra: 1, apple: 2 } as never), ['apple', 'zebra']);
        const { goals: _goals, ...without } = before;
        assert.deepEqual(changedSections(before, without as never), ['goals']);
    });
});

// ─── patchProfile ────────────────────────────────────────────────────────────────────────────

describe('patchProfile', () => {
    let state: State;
    let db: ProfileDb;
    let restoreSink: (() => void) | undefined;
    const ACTOR = { userId: USER };

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

    const store = (profile: unknown = richProfile(), version = 3): void => {
        state.profiles.set(OWNER, { profile: throughJsonb(profile), version, activated_at: null, updated_by: null });
    };
    const stored = (): CreatorProfile => state.profiles.get(OWNER)!.profile as CreatorProfile;
    const writes = (): string[] => db.statements.map((s) => s.sql).filter((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql));

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

    it('merges the patch into the stored profile, stores it as the next version with its history, and mirrors the settings', async () => {
        store();
        const out = await patchProfile(OWNER, { version: 3, patch: { identity: { timezone: 'Asia/Riyadh', niche: 'Strength' } } }, ACTOR);
        assert.equal(out.version, 4);
        assert.equal(out.stored, true);
        assert.deepEqual(out.changed, ['identity']);
        assert.equal(out.profile.identity.timezone, 'Asia/Riyadh');
        assert.equal(out.profile.identity.role, 'fitness coach', 'what the patch did not name is kept');
        assert.equal(stored().identity.niche, 'Strength');
        assert.equal(state.profiles.get(OWNER)!.version, 4);
        assert.equal(state.profiles.get(OWNER)!.updated_by, USER, 'the writer is recorded');
        const history = state.versions.filter((v) => v.creator_id === OWNER);
        assert.deepEqual(history.map((v) => [v.version, v.source, v.updated_by]), [[4, 'user', USER]]);
        assert.equal((state.studio.get(OWNER)!.schedule as { timezone: string }).timezone, 'Asia/Riyadh', 'the mirror carries the new timezone into the Studio row');
        assert.deepEqual(out.activationMissing, []);
    });

    it('answers `activationMissing` for what the profile still lacks', async () => {
        store(defaultProfile(), 1);
        const out = await patchProfile(OWNER, { version: 1, patch: { identity: { niche: 'Candles' } } }, ACTOR);
        assert.deepEqual(out.activationMissing, ['identity.display_name', 'identity.kind', 'identity.timezone', 'offers.primary.name']);
    });

    it('refuses an invalid result with every problem, and writes nothing', async () => {
        store();
        const before = JSON.stringify(stored());
        const err = await refused(
            () => patchProfile(OWNER, { version: 3, patch: { identity: { role: 'x'.repeat(41), timezone: 'Mars/Olympus' }, voice: { emoji: 'confetti' } } }, ACTOR),
            'PROFILE_INVALID', 400,
        );
        assert.equal(err.detail.problems!.length, 3, err.detail.problems!.join(' | '));
        assert.equal(JSON.stringify(stored()), before);
        assert.equal(state.versions.length, 0);
        assert.equal(state.profiles.get(OWNER)!.version, 3);
    });

    it('refuses a key the profile has no field for, however deep', async () => {
        store();
        for (const patch of [{ nonsense: 1 }, { identity: { nonsense: 1 } }, JSON.parse('{"__proto__": {"x": 1}}'), JSON.parse('{"identity": {"__proto__": {"x": 1}}}')]) {
            const err = await refused(() => patchProfile(OWNER, { version: 3, patch }, ACTOR), 'PROFILE_INVALID', 400);
            assert.ok(err.detail.problems!.some((p) => /nonsense|__proto__|unknown|not a field/i.test(p)), err.detail.problems!.join(' | '));
        }
        assert.equal(state.profiles.get(OWNER)!.version, 3);
    });

    it('a stale version is a 409 with the current one, before anything is merged or written', async () => {
        store(richProfile(), 5);
        const err = await refused(() => patchProfile(OWNER, { version: 4, patch: { identity: { niche: 'x' } } }, ACTOR), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(err.detail.currentVersion, 5);
        assert.deepEqual(writes(), [], 'not a single write');
        assert.equal(db.ran(/FOR UPDATE/).length, 0, 'not even a lock: the check is made on the read');
        // A client that read the virtual profile (null) loses to a profile that has been stored since.
        const nullErr = await refused(() => patchProfile(OWNER, { version: null, patch: { identity: { niche: 'x' } } }, ACTOR), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(nullErr.detail.currentVersion, 5);
        // And a client that read a stored version loses when there is none stored now.
        state.profiles.delete(OWNER);
        const noneErr = await refused(() => patchProfile(OWNER, { version: 2, patch: { identity: { niche: 'x' } } }, ACTOR), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(noneErr.detail.currentVersion, undefined);
    });

    it('a write that lands between the read and the save is still a conflict, caught inside the transaction', async () => {
        store(richProfile(), 3);
        db.onStatement = (sql) => {
            // Another writer's commit, landing just before this save's own lock on the row.
            if (/FOR UPDATE$/.test(sql) && /creator_profiles/.test(sql) && state.profiles.get(OWNER)!.version === 3) state.profiles.get(OWNER)!.version = 4;
        };
        const err = await refused(() => patchProfile(OWNER, { version: 3, patch: { identity: { niche: 'x' } } }, ACTOR), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(err.detail.currentVersion, 4);
        assert.equal(state.versions.length, 0);
    });

    it('a profile written by a newer release takes no write: PROFILE_NEWER_SCHEMA, 409', async () => {
        store({ ...richProfile(), schema: 2, future: { kept: true } }, 8);
        const err = await refused(() => patchProfile(OWNER, { version: 8, patch: { identity: { niche: 'x' } } }, ACTOR), 'PROFILE_NEWER_SCHEMA', 409);
        assert.equal(err.detail.currentVersion, 8);
        assert.deepEqual(writes(), []);
        assert.deepEqual((state.profiles.get(OWNER)!.profile as unknown as { future: unknown }).future, { kept: true });
    });

    it('a patch that changes nothing is not a write: no version, no history, the profile as it is', async () => {
        store();
        const out = await patchProfile(OWNER, { version: 3, patch: { identity: { niche: richProfile().identity.niche }, voice: { emoji: richProfile().voice.emoji } } }, ACTOR);
        assert.deepEqual(out.changed, []);
        assert.equal(out.version, 3);
        assert.deepEqual(writes(), []);
        assert.equal(state.versions.length, 0);
        assert.deepEqual(out.profile, richProfile());
    });

    it('the first patch of a tenant with no stored profile (version null) stores the legacy profile as version 1 and the change as version 2', async () => {
        const read = await readProfileState(OWNER);
        assert.equal(read.version, null);
        assert.equal(read.stored, false);
        const out = await patchProfile(OWNER, { version: null, patch: { identity: { niche: 'Home workouts', kind: 'coach' } } }, ACTOR);
        assert.equal(out.version, 2);
        assert.equal(out.stored, true);
        assert.deepEqual(state.versions.filter((v) => v.creator_id === OWNER).map((v) => [v.version, v.source]), [[1, 'backfill'], [2, 'user']]);
        assert.equal(stored().identity.niche, 'Home workouts');
        assert.equal(stored().identity.kind, 'coach');
        assert.equal(stored().identity.role, 'tech educator', 'the rest is what his settings described');
        assert.equal(stored().brand.theme, OWNER_STUDIO.infographic.theme);
    });

    it('a no-op patch of a virtual profile answers the virtual profile and stores nothing', async () => {
        const read = await readProfileState(OWNER);
        const out = await patchProfile(OWNER, { version: null, patch: { identity: { kind: read.profile.identity.kind } } }, ACTOR);
        assert.deepEqual(out.changed, []);
        assert.equal(out.version, null);
        assert.equal(out.stored, false);
        assert.deepEqual(writes(), []);
        assert.equal(state.profiles.size, 0);
    });

    it('refuses a body that is not { version, patch }, with one problem and no read of the profile', async () => {
        store();
        for (const [body, text] of [
            [undefined, /Send \{/], [null, /Send \{/], ['x', /Send \{/], [[], /Send \{/],
            [{ patch: { identity: { niche: 'x' } } }, /version is required/],
            [{ version: '3', patch: { identity: { niche: 'x' } } }, /whole number/],
            [{ version: 3.5, patch: { identity: { niche: 'x' } } }, /whole number/],
            [{ version: 0, patch: { identity: { niche: 'x' } } }, /whole number/],
            [{ version: -1, patch: { identity: { niche: 'x' } } }, /whole number/],
            [{ version: 3 }, /patch must be an object/],
            [{ version: 3, patch: {} }, /patch must be an object/],
            [{ version: 3, patch: [] }, /patch must be an object/],
            [{ version: 3, patch: 'x' }, /patch must be an object/],
            [{ version: 3, patch: null }, /patch must be an object/],
        ] as const) {
            const err = await refused(() => patchProfile(OWNER, body, ACTOR), 'PROFILE_INVALID', 400);
            assert.match(err.message, text);
            assert.deepEqual(err.detail.problems, [err.message]);
        }
        assert.equal(db.statements.length, 0, 'a malformed request touches no table');
    });

    it('refuses a patch nested to overflow the stack with a 400, before it reads or clones anything', async () => {
        store();
        let nested: unknown = 'x';
        for (let i = 0; i < 100_000; i++) nested = { a: nested };
        const err = await refused(() => patchProfile(OWNER, { version: 3, patch: { identity: { niche: nested } } }, ACTOR), 'PROFILE_INVALID', 400);
        assert.match(err.message, /nested too deeply/);
        assert.equal(db.statements.length, 0);
    });

    it('a database without v33 cannot store a profile: 503, nothing written', async () => {
        db.v33 = false;
        await refused(() => patchProfile(OWNER, { version: null, patch: { identity: { niche: 'x' } } }, ACTOR), 'PROFILE_STORAGE_MISSING', 503);
    });

    /** Index of the first statement matching `pattern` at or after `from`, or -1. */
    const at = (pattern: RegExp, from = 0): number => db.statements.findIndex((st, i) => i >= from && pattern.test(st.sql));

    it('the merge is made on the rows as they are UNDER the lock: a Studio write that landed after the first read is merged onto, not overwritten', async () => {
        // A tenant with no stored profile reads as its legacy rows. Another writer commits to them just before this
        // request's transaction begins; the patch must be merged onto that, and the mirror must not put the old rows back.
        const first = await readProfileState(OWNER);
        assert.equal(first.profile.identity.timezone, 'Asia/Riyadh');
        let raced = false;
        db.onStatement = (sql) => {
            if (sql !== 'BEGIN' || raced) return;
            raced = true;
            const row = state.studio.get(OWNER)!;
            row.schedule = { ...(row.schedule as object), timezone: 'Asia/Dubai' };
            row.brand = { ...(row.brand as object), name: 'Renamed in Studio' };
        };
        const out = await patchProfile(OWNER, { version: null, patch: { identity: { niche: 'Home workouts' } } }, ACTOR);
        assert.ok(raced, 'the concurrent write really landed in the gap');
        assert.equal(out.profile.identity.niche, 'Home workouts', 'the patch');
        assert.equal(out.profile.identity.timezone, 'Asia/Dubai', 'the concurrent timezone survives');
        assert.equal(out.profile.identity.brand_name, 'Renamed in Studio', 'and so does the concurrent brand name');
        assert.equal(stored().identity.timezone, 'Asia/Dubai');
        const row = state.studio.get(OWNER)!;
        assert.equal((row.schedule as { timezone: string }).timezone, 'Asia/Dubai', 'the mirror did not put the stale rows back');
        assert.equal((row.brand as { name: string }).name, 'Renamed in Studio');
        // The baseline is what the rows said when the lock was taken: version 1 holds the concurrent change too.
        assert.equal((state.versions[0]!.profile as CreatorProfile).identity.timezone, 'Asia/Dubai');
    });

    it('a stored version that moved between the first read and the lock is a 409 from the read under the lock, and nothing is written', async () => {
        store(richProfile(), 3);
        db.onStatement = (sql) => { if (sql === 'BEGIN') state.profiles.get(OWNER)!.version = 4; };
        const err = await refused(() => patchProfile(OWNER, { version: 3, patch: { identity: { niche: 'x' } } }, ACTOR), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(err.detail.currentVersion, 4);
        assert.deepEqual(writes(), []);
        assert.ok(at(/^ROLLBACK$/) > 0, 'the transaction ended');
        assert.equal(state.versions.length, 0);
    });

    it('a change that a concurrent write already made is nothing to write: unchanged, from the read under the lock', async () => {
        let raced = false;
        db.onStatement = (sql) => {
            if (sql !== 'BEGIN' || raced) return;
            raced = true;
            const row = state.studio.get(OWNER)!;
            row.schedule = { ...(row.schedule as object), timezone: 'Asia/Dubai' };
        };
        const out = await patchProfile(OWNER, { version: null, patch: { identity: { timezone: 'Asia/Dubai' } } }, ACTOR);
        assert.ok(raced);
        assert.deepEqual(out.changed, []);
        assert.equal(out.version, null);
        assert.equal(out.stored, false);
        assert.equal(out.profile.identity.timezone, 'Asia/Dubai');
        assert.deepEqual(writes(), []);
        assert.equal(state.profiles.size, 0);
    });

    it('takes the lock first and reads under it: BEGIN, the tenant mutex, the profile row FOR UPDATE, then the legacy rows, in the order every settings writer uses', async () => {
        await patchProfile(OWNER, { version: null, patch: { identity: { niche: 'x' } } }, ACTOR);
        const begin = at(/^BEGIN$/);
        const mutex = at(/^SELECT id FROM creators WHERE id = \$1 FOR NO KEY UPDATE$/);
        const profileRow = at(/FROM creator_profiles WHERE creator_id = \$1 FOR UPDATE$/, begin);
        const legacyRead = at(/^SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic FROM studio_settings/, mutex);
        const insert = at(/^INSERT INTO creator_profiles/);
        const commit = at(/^COMMIT$/);
        assert.ok(begin >= 0 && begin < mutex && mutex < profileRow && profileRow < legacyRead && legacyRead < insert && insert < commit, JSON.stringify({ begin, mutex, profileRow, legacyRead, insert, commit }));
        // Before the transaction: reads only, none of them locking.
        for (const st of db.statements.slice(0, begin)) assert.match(st.sql, /^SELECT (?!.*FOR (NO KEY )?UPDATE)/, st.sql);
        assert.ok(begin > 0, 'the first read is outside it');
    });

    it('a patch that refuses (stale version, newer schema, invalid, nothing to change) never takes the tenant\'s lock or opens a transaction', async () => {
        store(richProfile(), 3);
        const locking = (): number => db.ran(/FOR (NO KEY )?UPDATE|^BEGIN$/).length;
        await refused(() => patchProfile(OWNER, { version: 2, patch: { identity: { niche: 'x' } } }, ACTOR), 'PROFILE_VERSION_CONFLICT', 409);
        await refused(() => patchProfile(OWNER, { version: 3, patch: { voice: { emoji: 'confetti' }, identity: { timezone: 'Mars/Olympus' } } }, ACTOR), 'PROFILE_INVALID', 400);
        await refused(() => patchProfile(OWNER, { version: 3, patch: { schema: 2 } }, ACTOR), 'PROFILE_INVALID', 400);
        await patchProfile(OWNER, { version: 3, patch: { identity: { niche: richProfile().identity.niche } } }, ACTOR);
        store({ ...richProfile(), schema: 2 }, 3);
        await refused(() => patchProfile(OWNER, { version: 3, patch: { identity: { niche: 'x' } } }, ACTOR), 'PROFILE_NEWER_SCHEMA', 409);
        assert.equal(locking(), 0);
    });

    it('a patch that sets schema to 2 is a 400 naming schema, and a patch that leaves it at 1 changes nothing', async () => {
        store(richProfile(), 3);
        const err = await refused(() => patchProfile(OWNER, { version: 3, patch: { schema: 2 } }, ACTOR), 'PROFILE_INVALID', 400);
        assert.ok(err.detail.problems!.some((p) => /schema/.test(p)), err.detail.problems!.join(' | '));
        assert.equal(stored().schema, 1);
        assert.equal(state.profiles.get(OWNER)!.version, 3);
        const same = await patchProfile(OWNER, { version: 3, patch: { schema: 1 } }, ACTOR);
        assert.deepEqual(same.changed, []);
    });

    it('removes the heatmap timezone with null, in the profile and in the Growth row it mirrors into', async () => {
        store(richProfile(), 3);
        const out = await patchProfile(OWNER, { version: 3, patch: { audience: { timezone: null } } }, ACTOR);
        assert.deepEqual(out.changed, ['audience']);
        assert.ok(!('timezone' in out.profile.audience));
        assert.ok(!('timezone' in stored().audience));
        assert.equal((state.growth.get(OWNER)!.audience as { timezone?: string }).timezone, undefined, 'the mirror carries the removal into growth_settings');
        const again = await patchProfile(OWNER, { version: 4, patch: { audience: { timezone: null } } }, ACTOR);
        assert.deepEqual(again.changed, [], 'removing what is not there is not a write');
    });

    describe('a tenant whose legacy rows are not a valid profile on their own', () => {
        beforeEach(() => {
            // A stored row can hold anything the validators never saw: an infographic colour that is no colour.
            const row = state.studio.get(OWNER)!;
            row.infographic = { ...(row.infographic as object), primary: 'red' };
        });

        it('can be repaired by a patch: the merged result is what is validated, and it is stored as version 1, with nothing before it', async () => {
            const out = await patchProfile(OWNER, { version: null, patch: { brand: { primary: '#112233' } } }, ACTOR);
            assert.equal(out.version, 1);
            assert.equal(out.stored, true);
            assert.equal(out.profile.brand.primary, '#112233');
            assert.deepEqual(state.versions.map((v) => [v.version, v.source, v.updated_by]), [[1, 'user', USER]], 'no baseline that cannot exist');
            assert.equal(state.profiles.get(OWNER)!.updated_by, USER);
            assert.equal((state.studio.get(OWNER)!.infographic as { primary: string }).primary, '#112233', 'and the mirror carries the repair into the row');
            assert.equal(stored().identity.role, 'tech educator', 'the rest is what the rows described');
        });

        it('a patch that does not repair it is a 400 about the merged profile, before any lock, and nothing is stored', async () => {
            const err = await refused(() => patchProfile(OWNER, { version: null, patch: { identity: { niche: 'x' } } }, ACTOR), 'PROFILE_INVALID', 400);
            assert.ok(err.detail.problems!.some((p) => p.includes('brand.primary')), err.detail.problems!.join(' | '));
            assert.doesNotMatch(err.message, /settings this profile starts from/, 'it is about what the caller sent, merged');
            assert.equal(db.ran(/FOR (NO KEY )?UPDATE|^BEGIN$/).length, 0);
            assert.equal(state.profiles.size, 0);
            assert.deepEqual(state.versions, []);
        });

        it('keeps the baseline when the legacy profile is valid: version 1 is the rows (backfill), the patch is version 2', async () => {
            const row = state.studio.get(OWNER)!;
            row.infographic = { ...(row.infographic as object), primary: '#ABCDEF' };
            const out = await patchProfile(OWNER, { version: null, patch: { identity: { niche: 'x' } } }, ACTOR);
            assert.equal(out.version, 2);
            assert.deepEqual(state.versions.map((v) => [v.version, v.source]), [[1, 'backfill'], [2, 'user']]);
        });
    });

    it('the actor with no user (the shared-password login) is recorded as no one', async () => {
        store();
        await patchProfile(OWNER, { version: 3, patch: { identity: { niche: 'x' } } }, { userId: null });
        assert.equal(state.profiles.get(OWNER)!.updated_by, null);
        assert.equal(state.versions.find((v) => v.version === 4)!.updated_by, null);
    });
});
