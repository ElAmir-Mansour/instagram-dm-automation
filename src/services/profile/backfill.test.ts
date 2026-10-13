/**
 * The profile backfill (`backfill.ts`): the assessment of a tenant's live rows, the decision to write, the report, and the
 * write itself against the in-memory stand-in for the tables (`testDb.ts`), so "a tenant that did not pass leaves
 * nothing behind" is asserted on the rows. The script that feeds it the live rows is `scripts/backfill-creator-profiles.mts`.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import type { GrowthSettings, StudioSettings } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { defaultGrowthSettings } from '../growth/settingsRow.js';
import type { Exec } from '../studio/common.js';
import { defaultStudioSettings } from '../studio/settingsMerge.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS, ELAMIR_SETTINGS, ENGLISH_SETTINGS } from '../studio/testFixtures.js';
import {
    type AppliedOutcome, assessTenant, backfillTenant, decideApply, diffPaths, differences, formatBackfillReport, hasProblems, readTenants,
    type TenantInput,
} from './backfill.js';
import { profileFromLegacy } from './legacy.js';
import { saveProfile } from './store.js';
import { growthRow, installProfileDb, OTHER, OWNER, OWNER_STUDIO, type ProfileDb, seededState, studioRow, type State } from './testDb.js';
import { throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';

const SECRET = 'SECRET-TOKEN-do-not-print';

const tenant = (studio: StudioSettings, growth: GrowthSettings, over: Partial<TenantInput> = {}): TenantInput => ({
    id: '11111111-1111-4111-8111-111111111111', label: 'Default', active: true, studio, growth,
    rows: { studio: true, growth: true }, stored: null, ...over,
});

/** A studio row whose timezone reads as UTC through the profile: the view cannot give '' back, so lens law 1 breaks. */
const brokenStudio = (): StudioSettings => ({ ...ELAMIR_SEED_SETTINGS, schedule: { ...ELAMIR_SEED_SETTINGS.schedule, timezone: '' } });

// ─── What is printed ────────────────────────────────────────────────────────────────────────

describe('diffPaths and differences: paths, kinds and lengths, never a value', () => {
    it('names a text that differs by its length, and the same length by saying so', () => {
        assert.deepEqual(diffPaths({ a: { b: 'x'.repeat(5) } }, { a: { b: 'y'.repeat(7) } }), ['a.b: text of 7 characters, expected 5']);
        assert.deepEqual(diffPaths({ a: 'abc' }, { a: 'abd' }), ['a: text differs (3 characters, as long as expected)']);
    });

    it('names a list by its length and the entry that differs', () => {
        assert.deepEqual(diffPaths({ l: ['a', 'b', 'c'] }, { l: ['a', 'b'] }), ['l: list of 2, expected 3']);
        assert.deepEqual(diffPaths({ l: ['a', 'b'] }, { l: ['a', 'bb'] }), ['l[1]: text of 2 characters, expected 1']);
    });

    it('names a key that is missing, one that is not expected, and a value of another kind', () => {
        assert.deepEqual(diffPaths({ a: 1, o: { x: 1 } }, { o: { x: 1, y: 2 }, z: null }), ['a: missing', 'o.y: not expected', 'z: not expected']);
        assert.deepEqual(diffPaths({ a: 'text' }, { a: ['text'] }), ['a: list, expected string']);
        assert.deepEqual(diffPaths({ n: 1 }, { n: 2 }), ['n: number differs']);
    });

    it('never prints a value, whatever the value is', () => {
        const out = [
            ...diffPaths({ token: 'one', list: [SECRET, 'a'], n: { k: SECRET } }, { token: SECRET, list: ['b'], n: { k: `${SECRET}!` } }),
            ...differences({ a: SECRET, b: 1 }, { b: 1, a: SECRET }),
        ].join('\n');
        assert.ok(out.length > 0);
        assert.doesNotMatch(out, /SECRET/);
        assert.doesNotMatch(out, /\bone\b/);
    });

    it('reports nothing for equal values, and a different key order for what deepStrictEqual cannot see', () => {
        assert.deepEqual(differences({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } }), []);
        assert.deepEqual(differences({ a: 1, b: { x: 1, y: 2 } }, { a: 1, b: { y: 2, x: 1 } }), ['b: keys are in another order']);
        assert.deepEqual(differences({ a: 1, b: 2 }, { b: 2, a: 1 }), ['(the whole object): keys are in another order']);
    });

    it('stops at twelve, so one broken row does not print a page', () => {
        const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 1]));
        assert.equal(diffPaths(wide, {}).length, 12);
    });
});

// ─── Assessing a tenant's rows ──────────────────────────────────────────────────────────────

describe('assessTenant', () => {
    const FIXTURES: [string, StudioSettings, GrowthSettings][] = [
        ['the owner\'s seed settings', ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH],
        ['the owner\'s fixture settings', ELAMIR_SETTINGS, ELAMIR_GROWTH],
        ['the owner\'s tenant as the database holds it (a left-to-right Arabic row, no examples)', OWNER_STUDIO, ELAMIR_GROWTH],
        ['the neutral English fixture', ENGLISH_SETTINGS, defaultGrowthSettings()],
        ['a tenant with only the defaults', defaultStudioSettings(), defaultGrowthSettings()],
    ];
    for (const [name, studio, growth] of FIXTURES) {
        it(`${name}: valid, every law holds, and the profile is the one a tenant with no stored profile is read as`, () => {
            const a = assessTenant(tenant(studio, growth));
            assert.deepEqual(a.problems, []);
            assert.deepEqual(a.lens, []);
            assert.equal(a.ok, true);
            assert.deepStrictEqual(a.profile, profileFromLegacy(studio, growth));
            assert.ok(a.bytes! > 500);
        });
    }

    it('reports an invalid profile by path and rule, and offers nothing to store', () => {
        const studio: StudioSettings = { ...ELAMIR_SEED_SETTINGS, schedule: { ...ELAMIR_SEED_SETTINGS.schedule, timezone: `Not/${SECRET}` }, infographic: { ...ELAMIR_SEED_SETTINGS.infographic, primary: 'red' } };
        const a = assessTenant(tenant(studio, ELAMIR_GROWTH));
        assert.equal(a.ok, false);
        assert.equal(a.profile, null);
        assert.ok(a.problems.includes('identity.timezone must be a timezone like Asia/Riyadh or Europe/London'), a.problems.join('\n'));
        assert.ok(a.problems.includes('brand.primary must be a colour like #FFD60A'));
        assert.doesNotMatch(JSON.stringify(a), /SECRET/, 'the offending value is not in the finding');
    });

    it('finds a lens law the live row breaks: a timezone the view reads as UTC', () => {
        const a = assessTenant(tenant(brokenStudio(), ELAMIR_GROWTH));
        assert.equal(a.ok, false);
        assert.deepEqual(a.problems, [], 'the profile itself is valid: it is the lens that does not give the row back');
        assert.deepEqual(a.lens.map((f) => f.law), ['studio view'], 'the profile reads back as it was: it is the view that cannot give the row\'s empty timezone back');
        assert.deepEqual(a.lens[0]!.diffs, ['schedule.timezone: text of 3 characters, expected 0']);
        assert.ok(a.profile, 'it is a valid profile: the refusal to store it comes from the lens, in decideApply');
    });

    it('finds a broken Growth law the same way', () => {
        // An audience whose timezone is not a string: the view and the profile cannot agree on it.
        const growth = { ...ELAMIR_GROWTH, audience: { ...ELAMIR_GROWTH.audience, timezone: 7 as unknown as string } };
        const a = assessTenant(tenant(ELAMIR_SEED_SETTINGS, growth));
        assert.equal(a.ok, false);
        assert.ok(a.problems.some((p) => p.startsWith('audience.timezone')), a.problems.join('\n'));
    });

    it('a row of a shape the code never saw is a finding, not a crash that hides the other tenants', () => {
        const a = assessTenant(tenant({ ...ELAMIR_SEED_SETTINGS, voice: null } as unknown as StudioSettings, ELAMIR_GROWTH));
        assert.equal(a.ok, false);
        assert.equal(a.profile, null);
        assert.match(a.problems[0]!, /^profileFromLegacy failed: TypeError/);
    });

    it('a stored profile that needed repair, or that a newer release wrote, is a problem even when the rows are fine', () => {
        const fine = assessTenant(tenant(OWNER_STUDIO, ELAMIR_GROWTH, { stored: { version: 3, repaired: [], newerSchema: false } }));
        assert.equal(fine.ok, true);
        const repaired = assessTenant(tenant(OWNER_STUDIO, ELAMIR_GROWTH, { stored: { version: 3, repaired: ['voice.emoji'], newerSchema: false } }));
        assert.deepEqual(repaired.problems, ['the stored profile needed repair at voice.emoji']);
        const newer = assessTenant(tenant(OWNER_STUDIO, ELAMIR_GROWTH, { stored: { version: 3, repaired: [], newerSchema: true } }));
        assert.deepEqual(newer.problems, ['the stored profile was written by a newer release']);
    });

    it('does not change the rows it is handed', () => {
        const studio = structuredClone(OWNER_STUDIO);
        const growth = structuredClone(ELAMIR_GROWTH);
        assessTenant(tenant(studio, growth));
        assert.deepStrictEqual(studio, OWNER_STUDIO);
        assert.deepStrictEqual(growth, ELAMIR_GROWTH);
    });
});

// ─── Deciding ───────────────────────────────────────────────────────────────────────────────

describe('decideApply', () => {
    const clean = assessTenant(tenant(OWNER_STUDIO, ELAMIR_GROWTH));

    it('applies a tenant that passed the dry run', () => {
        assert.deepEqual(decideApply(clean), { action: 'apply' });
    });

    it('refuses a tenant that did not: an invalid profile, or a lens law broken', () => {
        const invalid = assessTenant(tenant({ ...OWNER_STUDIO, infographic: { ...OWNER_STUDIO.infographic, primary: 'red' } }, ELAMIR_GROWTH));
        assert.equal(decideApply(invalid).action, 'refuse');
        assert.match((decideApply(invalid) as { reason: string }).reason, /the dry run does not pass \(\d+ invalid/);
        const lens = assessTenant(tenant(brokenStudio(), ELAMIR_GROWTH));
        assert.equal(lens.problems.length, 0);
        assert.equal(decideApply(lens).action, 'refuse', 'a valid profile is still refused when the lens does not give the row back');
        assert.match((decideApply(lens) as { reason: string }).reason, /\(1 lens law broken\)/);
    });

    it('leaves a tenant that has a profile alone, whatever the dry run says: it never overwrites', () => {
        const stored = assessTenant(tenant(OWNER_STUDIO, ELAMIR_GROWTH, { stored: { version: 2, repaired: [], newerSchema: false } }));
        assert.deepEqual(decideApply(stored), { action: 'skip', reason: 'a profile is already stored (version 2)' });
        const storedAndBroken = assessTenant(tenant(brokenStudio(), ELAMIR_GROWTH, { stored: { version: 2, repaired: [], newerSchema: false } }));
        assert.equal(decideApply(storedAndBroken).action, 'skip');
    });

    it('leaves a tenant with no studio_settings row virtual: the defaults say nothing about who it is', () => {
        const none = assessTenant(tenant(defaultStudioSettings(), defaultGrowthSettings(), { rows: { studio: false, growth: false } }));
        assert.equal(none.ok, true);
        assert.deepEqual(decideApply(none), { action: 'skip', reason: 'no studio_settings row: left virtual' });
        const growthOnly = assessTenant(tenant(defaultStudioSettings(), ELAMIR_GROWTH, { rows: { studio: false, growth: true } }));
        assert.equal(decideApply(growthOnly).action, 'skip');
    });
});

// ─── The report ─────────────────────────────────────────────────────────────────────────────

describe('formatBackfillReport', () => {
    const id = '06026423-ad15-45d7-8d02-4bc122a6bcff';
    const ok = assessTenant(tenant(OWNER_STUDIO, ELAMIR_GROWTH, { id }));
    const broken = assessTenant(tenant(
        { ...brokenStudio(), infographic: { ...brokenStudio().infographic, primary: `red-${SECRET}` } }, ELAMIR_GROWTH,
        { id: '22222222-2222-4222-8222-222222222222', label: 'Second' }
    ));

    it('a clean dry run: a block per tenant and the count that would be written', () => {
        const lines = formatBackfillReport([ok], { mode: 'dry-run', target: 'db.example:6543/postgres' }).split('\n');
        assert.equal(lines[0], 'profile backfill (dry-run) · db.example:6543/postgres · 1 tenant');
        assert.ok(lines.includes(`tenant ${id} "Default"`));
        assert.ok(lines.includes('  rows       studio_settings yes · growth_settings yes'));
        assert.ok(lines.includes('  profile    none stored'));
        assert.ok(lines.some((l) => /^ {2}valid {6}yes \(\d+ bytes\)$/.test(l)));
        assert.ok(lines.includes('  lens laws  studio view ok · growth view ok · profile round trip ok · storage ok'));
        assert.ok(lines.includes('  result     ok · would insert version 1 (source backfill)'));
        assert.equal(lines.at(-1), 'summary: 1 tenant · 1 ok · 0 with problems · 0 already stored · 1 would be written');
    });

    it('a tenant with problems: the paths, the laws, no values', () => {
        const text = formatBackfillReport([ok, broken], { mode: 'dry-run', target: 't' });
        assert.match(text, /valid {6}NO \(1 problem\)/);
        assert.match(text, /problem {4}brand\.primary must be a colour like #FFD60A/);
        assert.match(text, /lens laws {2}studio view BROKEN · growth view ok · profile round trip ok · storage ok/);
        assert.match(text, /lens {7}studio view: schedule\.timezone: text of 3 characters, expected 0/);
        assert.match(text, /result {5}PROBLEMS · would REFUSE: the dry run does not pass \(1 invalid, 1 lens law broken\)/);
        assert.doesNotMatch(text, /SECRET/);
        assert.match(text.split('\n').at(-1)!, /^summary: 2 tenants · 1 ok · 1 with problems · 0 already stored · 1 would be written$/);
    });

    it('says what --apply did, tenant by tenant', () => {
        const outcomes: AppliedOutcome[] = [
            { id, status: 'created', version: 1 },
            { id: broken.id, status: 'refused', reason: 'the dry run does not pass (1 invalid)', assessment: broken },
        ];
        const text = formatBackfillReport([ok, broken], { mode: 'apply', target: 't', outcomes });
        assert.match(text, /^profile backfill \(apply\)/);
        assert.match(text, /result {5}ok · CREATED version 1 \(source backfill\)/);
        assert.match(text, /PROBLEMS · REFUSED: the dry run does not pass/);
        assert.match(text.split('\n').at(-1)!, /· 1 created · 1 refused or failed$/);
    });

    it('marks a missing settings row, and an inactive tenant', () => {
        const a = assessTenant(tenant(defaultStudioSettings(), defaultGrowthSettings(), { active: false, rows: { studio: false, growth: true } }));
        const text = formatBackfillReport([a], { mode: 'dry-run', target: 't' });
        assert.match(text, /\(inactive\)/);
        assert.match(text, /studio_settings NO \(read as the defaults\) · growth_settings yes/);
        assert.match(text, /would skip: no studio_settings row: left virtual/);
    });

    it('a stored tenant is counted, and left alone', () => {
        const a = assessTenant(tenant(OWNER_STUDIO, ELAMIR_GROWTH, { stored: { version: 4, repaired: [], newerSchema: false } }));
        const text = formatBackfillReport([a], { mode: 'dry-run', target: 't' });
        assert.match(text, /profile {4}stored, version 4/);
        assert.match(text, /would skip: a profile is already stored \(version 4\)/);
        assert.match(text, /1 already stored · 0 would be written$/);
    });

    it('prints the same bytes for the same input: it holds no clock', () => {
        assert.equal(formatBackfillReport([ok, broken], { mode: 'dry-run', target: 't' }), formatBackfillReport([ok, broken], { mode: 'dry-run', target: 't' }));
    });
});

describe('hasProblems: the exit code', () => {
    const ok = assessTenant(tenant(OWNER_STUDIO, ELAMIR_GROWTH));
    const broken = assessTenant(tenant(brokenStudio(), ELAMIR_GROWTH));

    it('is false for clean tenants, however each was handled', () => {
        assert.equal(hasProblems([ok]), false);
        assert.equal(hasProblems([ok], [{ id: ok.id, status: 'created', version: 1 }]), false);
        assert.equal(hasProblems([ok], [{ id: ok.id, status: 'exists', version: 1 }, { id: ok.id, status: 'skipped', reason: 'x', assessment: ok }]), false);
    });

    it('is true for a tenant with a problem, and for one that was refused or failed under --apply', () => {
        assert.equal(hasProblems([ok, broken]), true);
        assert.equal(hasProblems([ok], [{ id: ok.id, status: 'refused', reason: 'x', assessment: ok }]), true);
        assert.equal(hasProblems([ok], [{ id: ok.id, status: 'error', reason: 'x' }]), true);
    });
});

// ─── Reading and writing, against the stand-in ──────────────────────────────────────────────

let state: State;
let db: ProfileDb;
let restoreSink: (() => void) | undefined;

const TENANT_LIST = /^SELECT c\.id, c\.name, c\.is_active, \(s\.creator_id IS NOT NULL\) AS has_studio, \(g\.creator_id IS NOT NULL\) AS has_growth FROM creators c LEFT JOIN studio_settings s ON s\.creator_id = c\.id LEFT JOIN growth_settings g ON g\.creator_id = c\.id (WHERE c\.id = \$1 )?ORDER BY c\.created_at, c\.id$/;
const ROWS_PRESENT = /^SELECT EXISTS \(SELECT 1 FROM studio_settings WHERE creator_id = \$1\) AS studio, EXISTS \(SELECT 1 FROM growth_settings WHERE creator_id = \$1\) AS growth$/;
const MUTEX = /^SELECT id FROM creators WHERE id = \$1 FOR NO KEY UPDATE$/;
const PROFILE_ROW = /^SELECT profile, version FROM creator_profiles WHERE creator_id = \$1 FOR UPDATE$/;
const STUDIO_READ = /^SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic FROM studio_settings WHERE creator_id = \$1 FOR UPDATE$/;
const GROWTH_READ = /^SELECT keywords, hashtag_sets, competitors, audience, goal_followers, goal_views FROM growth_settings WHERE creator_id = \$1 FOR UPDATE$/;

beforeEach(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    state = seededState();
    db = installProfileDb(state);
    // The two statements the stand-in does not know: the tenant list, and which settings rows exist.
    db.routes.push([TENANT_LIST, ([only]) => {
        const ids = [...new Set([OWNER, OTHER, ...state.studio.keys(), ...state.growth.keys()])].filter((id) => !only || id === only);
        return { rows: ids.map((id) => ({ id, name: id === OWNER ? 'Default' : 'Other', is_active: true, has_studio: state.studio.has(id), has_growth: state.growth.has(id) })) };
    }]);
    db.routes.push([ROWS_PRESENT, ([id]) => ({ rows: [{ studio: state.studio.has(id), growth: state.growth.has(id) }] })]);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

const sql = (): string[] => db.statements.map((s) => s.sql);
const writes = (): string[] => sql().filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s));
const at = (pattern: RegExp): number => sql().findIndex((s) => pattern.test(s));
const stored = (id = OWNER): CreatorProfile => state.profiles.get(id)!.profile as CreatorProfile;

describe('readTenants', () => {
    it('lists the tenants with their rows read as the app reads them, and their stored profile', async () => {
        const tenants = await readTenants(pool as unknown as Exec);
        assert.deepEqual(tenants.map((t) => [t.id, t.label, t.rows, t.stored]), [
            [OWNER, 'Default', { studio: true, growth: true }, null],
            [OTHER, 'Other', { studio: false, growth: false }, null],
        ]);
        const owner = tenants[0]!;
        assert.deepStrictEqual(owner.studio.voice, OWNER_STUDIO.voice);
        assert.deepStrictEqual(owner.growth.goal_followers, ELAMIR_GROWTH.goal_followers);
        // A tenant with no rows is read as the defaults.
        assert.deepStrictEqual(tenants[1]!.studio, defaultStudioSettings());
    });

    it('only the tenant asked for, and a stored profile with what reading it repaired', async () => {
        state.profiles.set(OWNER, { profile: { ...profileFromLegacy(OWNER_STUDIO, ELAMIR_GROWTH), voice: { ...profileFromLegacy(OWNER_STUDIO, ELAMIR_GROWTH).voice, emoji: 'confetti' } }, version: 3, activated_at: null, updated_by: null });
        const [one, ...rest] = await readTenants(pool as unknown as Exec, OWNER);
        assert.deepEqual(rest, []);
        assert.deepEqual(one!.stored, { version: 3, repaired: ['voice.emoji'], newerSchema: false });
        assert.equal(assessTenant(one!).ok, false, 'a profile that needed repair is a problem');
    });

    it('only SELECTs, and never selects a token or a secret', async () => {
        await readTenants(pool as unknown as Exec);
        assert.ok(db.statements.length > 4);
        for (const s of db.statements) {
            assert.match(s.sql, /^SELECT /, s.sql);
            assert.doesNotMatch(s.sql, /page_access_token|webhook_verify_token|token|secret|password|FOR UPDATE/i, s.sql);
        }
    });
});

describe('backfillTenant', () => {
    it('stores version 1 of the profile the rows describe, with its history row, and touches nothing else', async () => {
        const studioBefore = structuredClone(state.studio);
        const growthBefore = structuredClone(state.growth);
        const out = await backfillTenant(OWNER);
        assert.deepEqual(out, { id: OWNER, status: 'created', version: 1 });

        const expected = throughJsonb(profileFromLegacy(OWNER_STUDIO, ELAMIR_GROWTH));
        assert.deepStrictEqual(stored(), expected);
        const row = state.profiles.get(OWNER)!;
        assert.equal(row.version, 1);
        assert.equal(row.activated_at, null, 'finishing the wizard activates a profile, not a backfill');
        assert.equal(row.updated_by, null);
        assert.deepEqual(state.versions.map((v) => [v.creator_id, v.version, v.source, v.updated_by]), [[OWNER, 1, 'backfill', null]]);
        assert.deepStrictEqual(state.versions[0]!.profile, expected);
        // The rows already say what the profile says: nothing is mirrored back.
        assert.deepStrictEqual(state.studio, studioBefore);
        assert.deepStrictEqual(state.growth, growthBefore);
        assert.deepEqual(writes().map((s) => /^INSERT INTO (\w+)/.exec(s)![1]), ['creator_profiles', 'creator_profile_versions'], 'two inserts, and no settings row is written');
    });

    it('is exactly the row saveProfile\'s step 0 stores', async () => {
        await backfillTenant(OWNER);
        const viaBackfill = { profile: structuredClone(state.profiles.get(OWNER)), versions: structuredClone(state.versions) };

        db.restore();
        state = seededState();
        db = installProfileDb(state);
        await saveProfile(OWNER, profileFromLegacy(OWNER_STUDIO, ELAMIR_GROWTH), { expectVersion: null, source: 'wizard', userId: null });
        // Step 0 stored version 1 from the legacy settings; the save on top of it is version 2.
        assert.deepStrictEqual(state.versions[0], viaBackfill.versions[0]);
        assert.deepStrictEqual(state.versions[0]!.profile, viaBackfill.profile!.profile);
    });

    it('takes the tenant\'s lock first, reads the rows under it, and writes last, in one transaction', async () => {
        await backfillTenant(OWNER);
        const order = [/^BEGIN$/, MUTEX, PROFILE_ROW, STUDIO_READ, GROWTH_READ, ROWS_PRESENT, /^INSERT INTO creator_profiles /, /^INSERT INTO creator_profile_versions /, /^COMMIT$/].map(at);
        assert.ok(order.every((i) => i >= 0), `every step ran: ${order.join(',')}\n${sql().join('\n')}`);
        assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
    });

    it('is idempotent: a second run, and a run on a tenant that has a profile, write nothing', async () => {
        await backfillTenant(OWNER);
        const profile = structuredClone(state.profiles.get(OWNER));
        const versions = structuredClone(state.versions);
        db.statements.length = 0;

        assert.deepEqual(await backfillTenant(OWNER), { id: OWNER, status: 'exists', version: 1 });
        assert.deepEqual(writes(), []);
        assert.deepStrictEqual(state.profiles.get(OWNER), profile);
        assert.deepStrictEqual(state.versions, versions);

        // A profile another save has moved on is never reset to version 1.
        state.profiles.get(OWNER)!.version = 5;
        assert.deepEqual(await backfillTenant(OWNER), { id: OWNER, status: 'exists', version: 5 });
        assert.equal(state.profiles.get(OWNER)!.version, 5);
        assert.equal(state.versions.length, 1);
    });

    it('never overwrites a stored profile, whatever it holds', async () => {
        const mine = { ...profileFromLegacy(OWNER_STUDIO, ELAMIR_GROWTH), voice: { ...profileFromLegacy(OWNER_STUDIO, ELAMIR_GROWTH).voice, guide: 'edited by hand' } };
        state.profiles.set(OWNER, { profile: mine, version: 2, activated_at: null, updated_by: null });
        await backfillTenant(OWNER);
        assert.deepStrictEqual(stored(), mine);
        assert.deepEqual(state.versions, []);
    });

    it('APPLY WITHOUT PASSING THE DRY RUN IS REFUSED: a tenant whose lens law breaks gets no profile, no history and no write at all', async () => {
        state.studio.set(OWNER, studioRow(brokenStudio()));
        state.growth.set(OWNER, growthRow(ELAMIR_GROWTH));
        const before = { studio: structuredClone(state.studio), growth: structuredClone(state.growth) };

        const out = await backfillTenant(OWNER);
        assert.equal(out.status, 'refused');
        assert.ok('reason' in out && /the dry run does not pass \(1 lens law broken\)/.test(out.reason), out.status);
        assert.ok('assessment' in out && out.assessment.lens.length === 1);
        assert.equal(state.profiles.size, 0);
        assert.deepEqual(state.versions, []);
        assert.deepStrictEqual(state.studio, before.studio);
        assert.deepStrictEqual(state.growth, before.growth);
        assert.deepEqual(writes(), [], 'it did not even try to write');
        assert.equal(sql().at(-1), 'ROLLBACK', 'the transaction ended in a rollback');
    });

    it('refuses an invalid profile the same way', async () => {
        state.studio.set(OWNER, studioRow({ ...OWNER_STUDIO, infographic: { ...OWNER_STUDIO.infographic, primary: 'red' } }));
        const out = await backfillTenant(OWNER);
        assert.equal(out.status, 'refused');
        assert.ok('reason' in out && /1 invalid/.test(out.reason));
        assert.equal(state.profiles.size, 0);
        assert.deepEqual(writes(), []);
    });

    it('assesses the rows it reads under the lock, not what a dry run saw: a row that went bad in between is refused', async () => {
        const dry = assessTenant(tenant(OWNER_STUDIO, ELAMIR_GROWTH, { id: OWNER }));
        assert.equal(decideApply(dry).action, 'apply', 'the dry run passed');
        state.studio.set(OWNER, studioRow(brokenStudio())); // ... and then a settings write broke the row
        assert.equal((await backfillTenant(OWNER)).status, 'refused');
        assert.equal(state.profiles.size, 0);
    });

    it('leaves a tenant with no studio_settings row virtual', async () => {
        const out = await backfillTenant(OTHER);
        assert.equal(out.status, 'skipped');
        assert.ok('reason' in out && out.reason === 'no studio_settings row: left virtual');
        assert.equal(state.profiles.size, 0);
        assert.deepEqual(writes(), []);
    });

    it('rolls everything back when the history row cannot be written, so there is never a profile without its history', async () => {
        db.failOn = /^INSERT INTO creator_profile_versions /;
        await assert.rejects(backfillTenant(OWNER), /injected failure/);
        assert.equal(state.profiles.size, 0, 'the profile insert was rolled back with it');
        assert.deepEqual(state.versions, []);
    });

    it('does not apply to a database without v33: the error is the database\'s, and nothing is stored', async () => {
        db.v33 = false;
        await assert.rejects(backfillTenant(OWNER), /does not exist/);
        assert.equal(state.profiles.size, 0);
    });
});
