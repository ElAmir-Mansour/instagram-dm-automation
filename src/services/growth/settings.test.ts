/**
 * Growth settings validation: what `PUT /api/growth/settings` normalises, what it refuses, and
 * that a partial update leaves the rest alone.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { GrowthError } from './common.js';
import {
    applyGrowthPatch, DEFAULT_GOALS, defaultGrowthSettings, getGrowthSettings, normalizeHashtag, normalizeUsername,
    resetGoalColumnsWarning, seoForWriter, updateGrowthSettings,
} from './settings.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const base = () => ({ ...defaultGrowthSettings(), keywords: ['برومبت'], audience: { countries: ['SA'], timezone: 'Asia/Riyadh' } });

describe('applyGrowthPatch', () => {
    it('normalises keywords: trimmed, one line, deduplicated across spelling variants', () => {
        const { settings, problems } = applyGrowthPatch(base(), { keywords: ['  ذكاء   اصطناعي ', 'ذكاء اصطناعى', 'Prompt', 'prompt', ''] });
        assert.deepEqual(problems, []);
        assert.deepEqual(settings.keywords, ['ذكاء اصطناعي', 'Prompt'], 'ى and ي are one keyword; case is one keyword');
    });

    it('adds the # to hashtags and refuses one with a space or punctuation', () => {
        assert.equal(normalizeHashtag('ذكاء_اصطناعي'), '#ذكاء_اصطناعي');
        assert.equal(normalizeHashtag('#AI2026'), '#AI2026');
        assert.equal(normalizeHashtag('two words'), null);
        const { settings, problems } = applyGrowthPatch(base(), { hashtag_sets: [{ name: ' AI ', tags: ['ai', '#AI', 'bad tag'] }] });
        assert.deepEqual(settings.hashtag_sets, [{ name: 'AI', tags: ['#ai'] }]);
        assert.equal(problems.length, 1);
        assert.match(problems[0]!, /«bad tag» is not a hashtag/);
    });

    it('refuses a set without a name, two sets with one name, and more than 30 tags in a set', () => {
        const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`);
        const { problems } = applyGrowthPatch(base(), { hashtag_sets: [{ name: '', tags: [] }, { name: 'A', tags }, { name: 'a', tags: [] }] });
        assert.ok(problems.some((p) => /hashtag_sets\[0\]\.name is required/.test(p)));
        assert.ok(problems.some((p) => /31 hashtags; Instagram allows 30/.test(p)));
        assert.ok(problems.some((p) => /Two hashtag sets are called «a»/.test(p)));
    });

    it('takes competitors as @name, name or a profile link, and refuses what isn’t a username', () => {
        assert.equal(normalizeUsername('@Rival.One'), 'rival.one');
        assert.equal(normalizeUsername('https://www.instagram.com/rival_two/?hl=en'), 'rival_two');
        const { settings, problems } = applyGrowthPatch(base(), { competitors: ['@Rival.One', 'rival.one', 'no spaces allowed'] });
        assert.deepEqual(settings.competitors, ['rival.one']);
        assert.match(problems[0]!, /is not an Instagram username/);
        assert.match(applyGrowthPatch(base(), { competitors: Array.from({ length: 11 }, (_, i) => `u${i}`) }).problems[0]!, /at most 10/);
    });

    it('merges the audience field by field and checks each', () => {
        const { settings, problems } = applyGrowthPatch(base(), { audience: { languages: ['AR', 'en'] } });
        assert.deepEqual(problems, []);
        assert.deepEqual(settings.audience, { countries: ['SA'], timezone: 'Asia/Riyadh', languages: ['ar', 'en'] });
        const bad = applyGrowthPatch(base(), { audience: { countries: ['Saudi'], timezone: 'Mars/Olympus', mood: 'x' } });
        assert.equal(bad.problems.length, 3);
        assert.deepEqual(applyGrowthPatch(base(), { audience: { timezone: null } }).settings.audience, { countries: ['SA'] }, 'null clears one field');
    });

    it('takes a goal as a number or as posted digits, refuses anything that is not a whole number above zero', () => {
        const { settings, problems } = applyGrowthPatch(base(), { goal_followers: 25000, goal_views: ' 2000000 ' });
        assert.deepEqual(problems, []);
        assert.equal(settings.goal_followers, 25000);
        assert.equal(settings.goal_views, 2000000);
        for (const bad of [0, -5, 1.5, 'ten thousand', '', true, {}]) {
            const r = applyGrowthPatch(base(), { goal_followers: bad });
            assert.equal(r.problems.length, 1, `refuses ${JSON.stringify(bad)}`);
            assert.match(r.problems[0]!, /goal_followers must be a whole number above zero/);
            assert.equal(r.settings.goal_followers, DEFAULT_GOALS.goal_followers, 'and keeps the current value');
        }
        assert.match(applyGrowthPatch(base(), { goal_views: 1e12 }).problems[0]!, /goal_views is at most/);
        assert.equal(applyGrowthPatch({ ...base(), goal_views: 5 }, { goal_views: null }).settings.goal_views, DEFAULT_GOALS.goal_views, 'null restores the default');
    });

    it('starts every tenant at the brief\'s goals, so a distance to goal exists before anything is set', () => {
        assert.equal(defaultGrowthSettings().goal_followers, 10000);
        assert.equal(defaultGrowthSettings().goal_views, 1000000);
        assert.equal(applyGrowthPatch(base(), { keywords: [] }).settings.goal_followers, 10000, 'a patch without goals keeps them');
    });

    it('refuses unknown keys and an empty body, and leaves unsent settings alone', () => {
        assert.match(applyGrowthPatch(base(), { keyword: ['x'] }).problems[0]!, /"keyword" is not a Growth setting/);
        assert.match(applyGrowthPatch(base(), {}).problems[0]!, /Send the settings to change/);
        assert.deepEqual(applyGrowthPatch(base(), { competitors: [] }).settings.keywords, ['برومبت']);
    });
});

describe('updateGrowthSettings and seoForWriter', () => {
    const original = { query: pool.query };
    let writes: { sql: string; params: any[] }[] = [];
    let restoreSink: (() => void) | undefined;
    before(() => {
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
    });
    after(() => restoreSink?.());
    beforeEach(() => {
        writes = [];
        (pool as any).query = async (sql: string, params: any[] = []) => {
            if (/^SELECT keywords/.test(sql.trim())) {
                return { rows: [{ keywords: ['برومبت'], hashtag_sets: [{ name: 'AI', tags: ['#ai', '#prompt'] }, { name: 'B', tags: ['#ai'] }], competitors: [], audience: {} }] };
            }
            writes.push({ sql, params });
            return { rows: [], rowCount: 1 };
        };
    });
    afterEach(() => {
        (pool as any).query = original.query;
    });

    it('writes the whole normalised row, and a 400 lists the problems without writing', async () => {
        const saved = await updateGrowthSettings(TENANT, { keywords: ['ai '] });
        assert.deepEqual(saved.keywords, ['ai']);
        assert.equal(writes.length, 1);
        assert.deepEqual(writes[0]!.params[1], ['ai']);
        assert.match(writes[0]!.sql, /goal_followers, goal_views/);
        assert.deepEqual(writes[0]!.params.slice(5, 7), [DEFAULT_GOALS.goal_followers, DEFAULT_GOALS.goal_views], 'the goals are written with the row');

        writes = [];
        const err = await updateGrowthSettings(TENANT, { keywords: 'not a list' }).then(() => null, (e) => e);
        assert.ok(err instanceof GrowthError && err.status === 400);
        assert.deepEqual(err.extra?.problems, ['keywords must be a list of search terms']);
        assert.equal(writes.length, 0);
    });

    it('reads a BIGINT goal back as a number and fills the defaults on a row written before v24', async () => {
        (pool as any).query = async () => ({ rows: [{ keywords: [], hashtag_sets: [], competitors: [], audience: {}, goal_followers: 500, goal_views: '2500000' }] });
        const s = await getGrowthSettings(TENANT);
        assert.equal(s.goal_followers, 500);
        assert.equal(s.goal_views, 2500000);
        (pool as any).query = async () => ({ rows: [{ keywords: [], hashtag_sets: [], competitors: [], audience: {} }] });
        assert.equal((await getGrowthSettings(TENANT)).goal_views, DEFAULT_GOALS.goal_views);
    });

    it('reads a database without the v24 columns: retried without the goals, the defaults, and one warning', async () => {
        const lines: { level: string; event: string }[] = [];
        const previous = setLogSink((level, line) => { lines.push({ level, event: JSON.parse(line).event }); });
        resetGoalColumnsWarning();
        const selects: string[] = [];
        (pool as any).query = async (sql: string) => {
            selects.push(sql);
            if (/goal_followers/.test(sql)) throw Object.assign(new Error('column "goal_followers" does not exist'), { code: '42703' });
            return { rows: [{ keywords: ['برومبت'], hashtag_sets: [], competitors: ['rival'], audience: { timezone: 'Asia/Riyadh' } }] };
        };
        try {
            const first = await getGrowthSettings(TENANT);
            assert.deepEqual(first.keywords, ['برومبت'], 'the v22 settings still come back');
            assert.deepEqual(first.competitors, ['rival']);
            assert.equal(first.goal_followers, DEFAULT_GOALS.goal_followers);
            assert.equal(first.goal_views, DEFAULT_GOALS.goal_views);
            assert.equal(selects.length, 2);
            assert.ok(!/goal_/.test(selects[1]!), 'the retry names no goal column');
            await getGrowthSettings(TENANT);
            const warned = lines.filter((l) => l.event === 'growth.goal_columns_missing');
            assert.equal(warned.length, 1, 'logged once, not on every read');
            assert.equal(warned[0]!.level, 'warn');

            // A missing TABLE is v22 missing: not papered over, so the route can name the migration.
            (pool as any).query = async () => { throw Object.assign(new Error('relation "growth_settings" does not exist'), { code: '42P01' }); };
            const err = await getGrowthSettings(TENANT).then(() => null, (e) => e);
            assert.equal(err?.code, '42P01');
            // Anything else is not a schema problem and is not retried.
            let calls = 0;
            (pool as any).query = async () => { calls++; throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); };
            await assert.rejects(getGrowthSettings(TENANT), /connection reset/);
            assert.equal(calls, 1);
        } finally {
            setLogSink(previous);
            resetGoalColumnsWarning();
        }
    });

    it('gives the writer the keywords and every set’s hashtags once, and nothing when the table is missing', async () => {
        assert.deepEqual(await seoForWriter(TENANT), { keywords: ['برومبت'], hashtags: ['#ai', '#prompt'] });
        (pool as any).query = async () => { throw Object.assign(new Error('relation "growth_settings" does not exist'), { code: '42P01' }); };
        assert.deepEqual(await seoForWriter(TENANT), { keywords: [], hashtags: [] });
    });
});
