/**
 * The settings lock (docs/onboarding/01 §3, the mirror): a profile save mirrors into `studio_settings` and
 * `growth_settings`, and the Studio and Growth settings writers read a row, change it and write the whole row back. If a
 * writer read before a save's mirror and wrote after it, the stale row would go back over the mirror.
 *
 * So all three take one mutex first (the tenant's `creators` row, `FOR NO KEY UPDATE`), read the rows they are about to
 * change `FOR UPDATE`, and only then compute what to write. The order is the same in every writer, so no two can wait
 * on each other: creators, then creator_profiles, then studio_settings, then growth_settings. There is no real second
 * connection here, so what is pinned is the statements and their order, in a transaction that ends in a commit (or a
 * rollback that leaves no row changed).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import type { GrowthSettings, StudioSettings } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { GrowthError } from '../growth/common.js';
import { updateGrowthSettings } from '../growth/settings.js';
import { StudioError } from '../studio/common.js';
import { updateStudioSettings } from '../studio/settings.js';
import { ELAMIR_GROWTH } from '../studio/testFixtures.js';
import { defaultProfile } from './defaults.js';
import { saveProfile } from './store.js';
import { growthRow, installProfileDb, OTHER, OWNER, OWNER_STUDIO, type ProfileDb, seededState, studioRow, USER, type State } from './testDb.js';
import { richProfile } from './testSupport.js';

const MUTEX = /^SELECT id FROM creators WHERE id = \$1 FOR NO KEY UPDATE$/;
const PROFILE_ROW = /^SELECT profile, version FROM creator_profiles WHERE creator_id = \$1 FOR UPDATE$/;
const STUDIO_READ = /^SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic, explainer FROM studio_settings WHERE creator_id = \$1 FOR UPDATE$/;
const GROWTH_READ = /^SELECT keywords, hashtag_sets, competitors, audience, goal_followers, goal_views FROM growth_settings WHERE creator_id = \$1 FOR UPDATE$/;
const STUDIO_WRITE = /^INSERT INTO studio_settings /;
const GROWTH_WRITE = /^INSERT INTO growth_settings /;

let state: State;
let db: ProfileDb;
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    state = seededState();
    db = installProfileDb(state);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

const sql = (): string[] => db.statements.map((s) => s.sql);
/** Index of the first statement matching `pattern` (-1 when none). */
const first = (pattern: RegExp): number => sql().findIndex((s) => pattern.test(s));
const count = (pattern: RegExp): number => sql().filter((s) => pattern.test(s)).length;

/** The statements, with every `…` of the transaction named, for a failure message that shows the order. */
const trace = (): string => sql().map((s) => s.slice(0, 48)).join('\n');

/** The pattern's index must exist and be after the previous one's: asserts a whole sequence in one go. */
function inOrder(...steps: [string, RegExp][]): void {
    let previous = -1;
    for (const [name, pattern] of steps) {
        const at = sql().findIndex((s, i) => i > previous && pattern.test(s));
        assert.ok(at > previous, `${name} comes after the step before it\n${trace()}`);
        previous = at;
    }
}

/**
 * Whichever of the four locks a transaction takes, in the order it first takes them, must follow the one global order:
 * creators, creator_profiles, studio_settings, growth_settings.
 */
function lockOrderIsGlobal(): void {
    const ranks = [MUTEX, PROFILE_ROW, STUDIO_READ, GROWTH_READ].map((pattern) => first(pattern));
    const taken = ranks.map((at, rank) => ({ at, rank })).filter((r) => r.at >= 0).sort((a, b) => a.at - b.at).map((r) => r.rank);
    assert.deepEqual(taken, [...taken].sort((a, b) => a - b), `locks out of order\n${trace()}`);
}

describe('saveProfile takes the locks, in order, before it computes the mirror', () => {
    beforeEach(() => {
        state.profiles.set(OWNER, { profile: defaultProfile(), version: 1, activated_at: null, updated_by: null });
    });

    it('creators, then the profile row, then the Studio row, then the Growth row, each read FOR UPDATE before it is written', async () => {
        await saveProfile(OWNER, richProfile(), { expectVersion: 1, source: 'user', userId: USER });
        inOrder(
            ['BEGIN', /^BEGIN$/], ['the creators mutex', MUTEX], ['the profile row', PROFILE_ROW], ['the profile update', /^UPDATE creator_profiles/],
            ['the Studio row, locked', STUDIO_READ], ['the Studio mirror', STUDIO_WRITE],
            ['the Growth row, locked', GROWTH_READ], ['the Growth mirror', GROWTH_WRITE], ['COMMIT', /^COMMIT$/]
        );
        assert.equal(first(MUTEX), first(/^BEGIN$/) + 1, 'the mutex is the first thing the transaction does');
        lockOrderIsGlobal();
    });

    it('reads each settings row once, and the mutex once', async () => {
        await saveProfile(OWNER, richProfile(), { expectVersion: 1, source: 'user', userId: USER });
        assert.equal(count(STUDIO_READ), 1);
        assert.equal(count(GROWTH_READ), 1);
        assert.equal(count(MUTEX), 1);
        assert.equal(count(/FROM studio_settings WHERE creator_id = \$1$/), 0, 'no unlocked read of a row it is about to rewrite');
        assert.equal(count(/FROM growth_settings WHERE creator_id = \$1$/), 0);
    });

    it('a tenant\'s first save locks the settings rows too, for the legacy profile it reads from them, once', async () => {
        state.profiles.delete(OWNER);
        await saveProfile(OWNER, richProfile(), { expectVersion: null, source: 'wizard', userId: USER });
        inOrder(
            ['the creators mutex', MUTEX], ['the profile row (none)', PROFILE_ROW], ['the Studio row, locked', STUDIO_READ], ['the Growth row, locked', GROWTH_READ],
            ['the version-1 insert', /^INSERT INTO creator_profiles/], ['the profile update', /^UPDATE creator_profiles/], ['the Studio mirror', STUDIO_WRITE],
            ['the Growth mirror', GROWTH_WRITE], ['COMMIT', /^COMMIT$/]
        );
        assert.equal(count(STUDIO_READ), 1, 'the legacy read and the mirror share one locked read');
        assert.equal(count(GROWTH_READ), 1);
        lockOrderIsGlobal();
    });

    it('a save that is refused takes the mutex and the profile row and no settings row at all', async () => {
        await assert.rejects(saveProfile(OWNER, richProfile(), { expectVersion: 99, source: 'user', userId: USER }));
        assert.equal(count(MUTEX), 1);
        assert.equal(count(PROFILE_ROW), 1);
        assert.equal(count(STUDIO_READ) + count(GROWTH_READ), 0);
        assert.equal(count(/^ROLLBACK$/), 1);
        lockOrderIsGlobal();
    });

    it('inside a caller\'s transaction it locks through the client it was given, opens none', async () => {
        const calls: string[] = [];
        const client = { query: (q: string, p?: unknown[]) => { calls.push(q.replace(/\s+/g, ' ').trim()); return (pool as unknown as { query: (a: string, b?: unknown[]) => Promise<never> }).query(q, p); } };
        await saveProfile(OWNER, richProfile(), { expectVersion: 1, source: 'user', userId: USER }, client as never);
        assert.ok(MUTEX.test(calls[0]!), 'the mutex is first');
        assert.ok(calls.some((c) => STUDIO_READ.test(c)) && calls.some((c) => GROWTH_READ.test(c)));
        assert.equal(calls.filter((c) => /^(BEGIN|COMMIT)$/.test(c)).length, 0);
    });
});

describe('the Studio settings writer takes the same locks', () => {
    it('opens a transaction, takes the mutex, reads the row FOR UPDATE, and only then writes it', async () => {
        const { settings } = await updateStudioSettings(OWNER, { voice: { guide: 'Short.' } });
        assert.equal(settings.voice.guide, 'Short.');
        inOrder(['BEGIN', /^BEGIN$/], ['the creators mutex', MUTEX], ['the Studio row, locked', STUDIO_READ], ['the write', STUDIO_WRITE], ['COMMIT', /^COMMIT$/]);
        assert.equal(first(MUTEX), first(/^BEGIN$/) + 1);
        assert.equal(count(/FROM studio_settings WHERE creator_id = \$1$/), 0, 'no unlocked read');
        lockOrderIsGlobal();
    });

    it('still changes only what was sent, over what the row holds', async () => {
        await updateStudioSettings(OWNER, { voice: { guide: 'Short.' } });
        const row = state.studio.get(OWNER)!;
        assert.equal((row.voice as StudioSettings['voice']).guide, 'Short.');
        assert.deepEqual(row.brand, studioRow(OWNER_STUDIO).brand, 'the rest of the row is what it was');
        assert.deepEqual(row.cta, studioRow(OWNER_STUDIO).cta);
    });

    it('sees a profile save that landed before it: it reads the mirror, and writes it back, not the row it replaced', async () => {
        await saveProfile(OWNER, richProfile(), { expectVersion: null, source: 'wizard', userId: USER });
        db.statements.length = 0;
        await updateStudioSettings(OWNER, { voice: { guide: 'Short.' } });
        const row = state.studio.get(OWNER)!;
        assert.equal((row.brand as StudioSettings['brand']).name, 'Sami Fit Studio', 'the profile\'s brand name survived the settings write');
        assert.equal((row.schedule as StudioSettings['schedule']).timezone, 'Africa/Cairo');
        assert.equal((row.voice as StudioSettings['voice']).guide, 'Short.');
    });

    it('a patch the rules refuse rolls back having written nothing', async () => {
        await assert.rejects(updateStudioSettings(OWNER, { schedule: { slots: ['25:00'] } }), (err: unknown) => err instanceof StudioError && err.status === 400);
        inOrder(['BEGIN', /^BEGIN$/], ['the creators mutex', MUTEX], ['the Studio row, locked', STUDIO_READ], ['ROLLBACK', /^ROLLBACK$/]);
        assert.equal(count(STUDIO_WRITE), 0);
        assert.deepEqual(state.studio.get(OWNER), studioRow(OWNER_STUDIO));
    });

    it('an empty or malformed patch is refused before any statement, as it always was', async () => {
        await assert.rejects(updateStudioSettings(OWNER, {}), (err: unknown) => err instanceof StudioError && err.status === 400);
        await assert.rejects(updateStudioSettings(OWNER, 'brand'), (err: unknown) => err instanceof StudioError && err.status === 400);
        assert.deepEqual(sql(), []);
    });

    it('a tenant with no settings row yet: the mutex still serialises it (a row that does not exist locks nothing)', async () => {
        await updateStudioSettings(OTHER, { voice: { guide: 'Short.' } });
        inOrder(['the creators mutex', MUTEX], ['the Studio row, locked', STUDIO_READ], ['the write', STUDIO_WRITE]);
        assert.ok(state.studio.has(OTHER));
    });

    it('given a transaction\'s client it opens none, and takes its locks through it', async () => {
        const calls: string[] = [];
        const client = { query: (q: string, p?: unknown[]) => { calls.push(q.replace(/\s+/g, ' ').trim()); return (pool as unknown as { query: (a: string, b?: unknown[]) => Promise<never> }).query(q, p); } };
        await updateStudioSettings(OWNER, { voice: { guide: 'Short.' } }, client as never);
        assert.ok(MUTEX.test(calls[0]!));
        assert.ok(PROFILE_ROW.test(calls[1]!), 'the profile row is the second lock, whether or not the tenant has one');
        assert.ok(STUDIO_READ.test(calls[2]!));
        assert.equal(calls.filter((c) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(c)).length, 0, 'the caller commits');
    });
});

describe('the Growth settings writer takes the same locks', () => {
    it('opens a transaction, takes the mutex, reads the row FOR UPDATE, and only then writes it', async () => {
        const saved = await updateGrowthSettings(OWNER, { goal_followers: 20_000 });
        assert.equal(saved.goal_followers, 20_000);
        inOrder(['BEGIN', /^BEGIN$/], ['the creators mutex', MUTEX], ['the Growth row, locked', GROWTH_READ], ['the write', GROWTH_WRITE], ['COMMIT', /^COMMIT$/]);
        assert.equal(first(MUTEX), first(/^BEGIN$/) + 1);
        assert.equal(count(/FROM growth_settings WHERE creator_id = \$1$/), 0, 'no unlocked read');
        lockOrderIsGlobal();
    });

    it('still writes the whole row, normalised, over what the row holds', async () => {
        await updateGrowthSettings(OWNER, { keywords: ['ai '] });
        const row = state.growth.get(OWNER)!;
        assert.deepEqual(row.keywords, ['ai']);
        assert.deepEqual(row.competitors, ELAMIR_GROWTH.competitors);
        assert.deepEqual(row.audience, ELAMIR_GROWTH.audience);
        assert.equal(row.goal_followers, ELAMIR_GROWTH.goal_followers);
    });

    it('sees a profile save that landed before it', async () => {
        await saveProfile(OWNER, richProfile(), { expectVersion: null, source: 'wizard', userId: USER });
        await updateGrowthSettings(OWNER, { keywords: ['ai'] });
        const row = state.growth.get(OWNER)!;
        assert.deepEqual(row.audience, { countries: ['EG', 'SA'], languages: ['ar', 'en'], timezone: 'Asia/Dubai' }, 'the mirrored audience survived');
        assert.equal(row.goal_followers, 5000);
        assert.deepEqual(row.keywords, ['ai']);
    });

    it('a patch the rules refuse rolls back having written nothing, and is the same 400 as before', async () => {
        const err = await updateGrowthSettings(OWNER, { keywords: 'not a list' }).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof GrowthError && err.status === 400);
        assert.deepEqual(err.extra?.problems, ['keywords must be a list of search terms']);
        inOrder(['BEGIN', /^BEGIN$/], ['the creators mutex', MUTEX], ['the Growth row, locked', GROWTH_READ], ['ROLLBACK', /^ROLLBACK$/]);
        assert.equal(count(GROWTH_WRITE), 0);
        assert.deepEqual(state.growth.get(OWNER), growthRow(ELAMIR_GROWTH as GrowthSettings));
    });

    it('a failing write rolls the whole thing back', async () => {
        db.failOn = GROWTH_WRITE;
        await assert.rejects(updateGrowthSettings(OWNER, { keywords: ['ai'] }), /injected failure/);
        assert.deepEqual(state.growth.get(OWNER), growthRow(ELAMIR_GROWTH as GrowthSettings));
        assert.equal(count(/^COMMIT$/), 0);
    });
});
