/**
 * The coach and the keyword suggestions, with the model mocked: what they send (schema, language,
 * the numbers code worked out), and how they treat what comes back — capped, normalised, and never
 * trusted to name a post we didn't send.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import type { CallModel, ModelRequest } from '../studio/generate.js';
import { COACH_SCHEMA, coerceCoach, median, repostGroups, runCoach, toLevel } from './coach.js';
import { GrowthError } from './common.js';
import { coerceSuggestions, KEYWORDS_SCHEMA, suggestKeywords } from './keywords.js';
import { toPostInsight } from './overview.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-25T12:00:00Z');

let postRows: any[] = [];
let dayRows: any[] = [];
let language = 'ar';
let growthRow: Record<string, unknown> | null = null;
let lastSync: Record<string, unknown> | null = null;
const original = { query: pool.query };

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    postRows = [];
    dayRows = [];
    language = 'ar';
    growthRow = { keywords: ['برومبت'], hashtag_sets: [{ name: 'AI', tags: ['#ذكاء_اصطناعي'] }], competitors: [], audience: { countries: ['SA'] } };
    lastSync = null;
    (pool as any).query = async (sql: string) => {
        const flat = sql.replace(/\s+/g, ' ');
        if (/FROM post_insights/.test(flat)) return { rows: postRows };
        if (/DISTINCT ON \(platform\)/.test(flat)) return { rows: [{ platform: 'instagram', followers: 36 }] };
        if (/FROM account_insights_daily/.test(flat)) return { rows: dayRows };
        if (/SELECT last_sync FROM growth_settings/.test(flat)) return { rows: lastSync ? [{ last_sync: lastSync }] : [] };
        if (/FROM growth_settings/.test(flat)) return { rows: growthRow ? [growthRow] : [] };
        if (/FROM studio_settings/.test(flat)) return { rows: [{ voice: { language, guide: '', digits: 'arabic-indic' } }] };
        return { rows: [] };
    };
});
afterEach(() => {
    (pool as any).query = original.query;
});

function fakeModel(answer: unknown): { call: CallModel; requests: ModelRequest[] } {
    const requests: ModelRequest[] = [];
    return { requests, call: async (req) => { requests.push(req); return structuredClone(answer); } };
}

const row = (id: string, metrics: Record<string, number>, caption = 'reel caption long enough', type = 'REELS') => ({
    id: `row-${id}`, creator_id: TENANT, platform: 'instagram' as const, media_id: id, scheduled_post_id: null, media_type: type,
    permalink: null, caption, thumbnail_url: null, published_at: new Date('2026-09-20T18:00:00Z'), metrics, fetched_at: NOW,
});

const ANSWER = {
    summary: 'الريلز توصل لغير المتابعين، لكن الناس تطلع بعد ٣ ثوانٍ.',
    wins: ['١٣٠ مشاهدة للريل'],
    problems: ['متوسط المشاهدة ٣٫٢ ثانية'],
    actions: [
        { title: 'Cut the intro', why: '3.2s', how: 'Open on the result', effort: 'low', impact: 'medium' },
        { title: 'Hook first', why: '99% non-followers', how: 'Text on frame 1', effort: 'med', impact: 'high' },
    ],
    experiments: [{ hypothesis: 'A result-first hook lifts watch time', how: '3 reels', measure: 'avg watch time' }],
    post_notes: [{ media_id: 'r1', note: 'Strong first frame' }, { media_id: 'invented', note: 'x' }],
};

describe('coerceCoach', () => {
    it('orders actions by impact, normalises the levels, and drops notes for posts it wasn’t given', () => {
        const out = coerceCoach(ANSWER, new Set(['r1']));
        assert.deepEqual(out.actions.map((a) => [a.title, a.impact, a.effort]), [['Hook first', 'high', 'med'], ['Cut the intro', 'med', 'low']]);
        assert.deepEqual(out.post_notes, [{ media_id: 'r1', note: 'Strong first frame' }]);
        assert.equal(toLevel('Medium'), 'med');
        assert.equal(toLevel('HIGH'), 'high');
    });

    it('caps every list and every string', () => {
        const long = 'x'.repeat(5000);
        const out = coerceCoach({
            summary: long, wins: Array(20).fill('w'), problems: Array(20).fill('p'),
            actions: Array(20).fill({ title: 't', why: long }), experiments: Array(20).fill({ hypothesis: 'h' }),
        }, new Set());
        assert.ok(out.summary.length <= 1500);
        assert.equal(out.wins.length, 5);
        assert.equal(out.actions.length, 7);
        assert.ok(out.actions[0]!.why.length <= 500);
        assert.equal(out.experiments.length, 4);
    });

    it('is a 502, not an empty coach, when nothing usable came back', () => {
        assert.throws(() => coerceCoach({ wins: ['x'] }, new Set()), (e) => e instanceof GrowthError && e.status === 502);
        assert.throws(() => coerceCoach('not json', new Set()), GrowthError);
    });
});

describe('runCoach', () => {
    it('asks in the tenant’s voice language, with the schema, the numbers and the split', async () => {
        postRows = [row('r1', { views: 130, reach: 110, avg_watch_time_ms: 3100 }), row('r2', { views: 150, avg_watch_time_ms: 3300 })];
        dayRows = [{ platform: 'instagram', day: '2026-09-24', metrics: { reach_followers: 17, reach_non_followers: 1704 } }];
        const m = fakeModel(ANSWER);
        const out = await runCoach(TENANT, { callModel: m.call, now: NOW });

        const req = m.requests[0]!;
        assert.equal(req.purpose, 'growth-coach');
        assert.equal(req.schema, COACH_SCHEMA);
        assert.match(req.system, /Write every field in Arabic/);
        assert.match(req.system, /retention/);
        const prompt = req.turns[0]!.text;
        assert.match(prompt, /non-follower share 99%/);
        assert.match(prompt, /REELS: 2 posts, median views 140/);
        assert.match(prompt, /median avg watch 3\.2s/);
        assert.match(prompt, /Posts that share a caption/);
        assert.match(prompt, /search keywords: برومبت/);
        assert.equal(out.language, 'ar');
        assert.equal(out.metrics_available, true);
        assert.equal(out.generated_at, NOW.toISOString());
    });

    it('still coaches from the post history when there are no metrics, and says what is missing', async () => {
        language = 'en';
        postRows = [row('r1', { likes: 2 })];
        lastSync = { finished_at: NOW.toISOString(), missing: ['instagram_manage_insights'] };
        const m = fakeModel(ANSWER);
        const out = await runCoach(TENANT, { callModel: m.call, now: NOW });
        assert.match(m.requests[0]!.system, /Write every field in English/);
        assert.match(m.requests[0]!.turns[0]!.text, /lacks instagram_manage_insights/);
        assert.equal(out.metrics_available, false);
        assert.deepEqual(out.missing, ['instagram_manage_insights']);
    });

    it('turns a model failure into a 502 with the reason', async () => {
        const failing: CallModel = async () => { throw new Error('Gemini request failed [HTTP 429]'); };
        await assert.rejects(runCoach(TENANT, { callModel: failing, now: NOW }), (e) => e instanceof GrowthError && e.status === 502 && /429/.test(e.message));
    });

    it('finds reposts and medians in code, not in the model', () => {
        const posts = ['a', 'b', 'c'].map((id) => toPostInsight(row(id, { views: 150 }, 'Same reel, posted again today')));
        assert.equal(repostGroups(posts)[0]!.posts.length, 3);
        assert.equal(median([3, 1, 2]), 2);
        assert.equal(median([]), null);
    });
});

describe('suggestKeywords', () => {
    it('refuses a missing topic before calling the model', async () => {
        const m = fakeModel({});
        await assert.rejects(suggestKeywords(TENANT, { topic: ' ' }, { callModel: m.call }), (e) => e instanceof GrowthError && e.status === 400);
        assert.equal(m.requests.length, 0);
    });

    it('labels every term a suggestion, drops the tenant’s own, and normalises hashtags', async () => {
        const m = fakeModel({
            keywords: [{ term: 'برومبت', why: 'already have it' }, { term: 'هندسة البرومبت', why: 'how learners phrase it' }, { term: 'هندسة  البرومبت', why: 'dup' }],
            hashtags: ['ذكاء اصطناعي', '#برومبت', '#برومبت', 'bad tag!'],
        });
        const out = await suggestKeywords(TENANT, { topic: 'prompt engineering' }, { callModel: m.call });
        assert.equal(m.requests[0]!.schema, KEYWORDS_SCHEMA);
        assert.match(m.requests[0]!.turns[0]!.text, /Audience countries: SA/);
        assert.match(m.requests[0]!.system, /must not claim any/);
        assert.deepEqual(out.keywords, [{ term: 'هندسة البرومبت', why: 'how learners phrase it', kind: 'suggestion' }]);
        assert.deepEqual(out.hashtags, ['#ذكاء_اصطناعي', '#برومبت']);
        assert.match(out.note, /not search-volume data/);
    });

    it('is a 502 when nothing usable came back', () => {
        assert.throws(() => coerceSuggestions({ keywords: [], hashtags: ['!!'] }, []), (e) => e instanceof GrowthError && e.status === 502);
    });
});
