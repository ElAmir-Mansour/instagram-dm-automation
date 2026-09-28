/**
 * The Analyst (MONTEUR.md §8): when it may run, what it reads from the Growth hub, and the row
 * each run leaves. Gemini is stood in for with `setModelCaller`.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { StudioError } from '../studio/common.js';
import { setModelCaller, type CallModel, type ModelRequest } from '../studio/generate.js';
import {
    ANALYST_FRESH_DAYS, ANALYST_MIN_POSTS, ANALYST_RETRY_HOURS, analystDue, parseLessons, recentReels, reelLine,
    refreshLessons, runAnalyst, runDueAnalyst,
} from './analyst.js';
import { installFakeDb, type FakeDb } from './testDb.js';
import { presentLessons } from './view.js';
import { pool } from '../../config/db.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-09-27T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms);

describe('analystDue — the sweep’s three conditions', () => {
    const due = { lastDoneAt: ago(8 * DAY), lastRunAt: ago(8 * DAY), posts: 5 };

    it('runs with no done row in 7 days, no row in 6 hours, and at least 5 reels with insights', () => {
        assert.equal(analystDue(due, NOW), true);
        assert.equal(analystDue({ lastDoneAt: null, lastRunAt: null, posts: 12 }, NOW), true, 'the first run');
        assert.deepEqual([ANALYST_FRESH_DAYS, ANALYST_RETRY_HOURS, ANALYST_MIN_POSTS], [7, 6, 5]);
    });

    it('waits while a done row is under 7 days old', () => {
        assert.equal(analystDue({ ...due, lastDoneAt: ago(7 * DAY - 60_000), lastRunAt: ago(7 * DAY - 60_000) }, NOW), false);
        assert.equal(analystDue({ ...due, lastDoneAt: ago(7 * DAY + 60_000), lastRunAt: ago(7 * DAY + 60_000) }, NOW), true);
    });

    it('waits 6 hours after any row — a failure too — so a failing run can’t hammer Gemini', () => {
        assert.equal(analystDue({ ...due, lastRunAt: ago(5 * HOUR) }, NOW), false);
        assert.equal(analystDue({ ...due, lastRunAt: ago(6 * HOUR + 60_000) }, NOW), true);
        assert.equal(analystDue({ lastDoneAt: null, lastRunAt: ago(HOUR), posts: 20 }, NOW), false);
    });

    it('needs 5 reels or videos with insights', () => {
        assert.equal(analystDue({ ...due, posts: 4 }, NOW), false);
    });
});

describe('what it reads', () => {
    let db: FakeDb;
    beforeEach(() => { db = installFakeDb(); });
    afterEach(() => db.restore());

    it('the latest 20 reels (Instagram) and videos (Facebook) from post_insights, by their real columns', async () => {
        await recentReels(pool, TENANT);
        const [q] = db.statements;
        assert.match(q!.sql, /SELECT id, platform, media_type, caption, published_at, metrics FROM post_insights/);
        assert.match(q!.sql, /media_type IN \('REELS', 'VIDEO'\) AND \(metrics \? 'views' OR metrics \? 'reach'\)/);
        assert.match(q!.sql, /ORDER BY published_at DESC NULLS LAST/);
        assert.deepEqual(q!.params, [TENANT, 20]);
    });

    it('sends each reel’s numbers as the Growth hub keys them, leaving out what is absent rather than sending 0', () => {
        const line = reelLine({
            id: 'p1', platform: 'instagram', media_type: 'REELS', caption: '\n  🔥 دفترك الذكي\nbody', published_at: new Date('2026-09-20T16:00:00Z'),
            metrics: { views: 1234, reach: 1100, skip_rate: 61.2, likes: 40, saved: 12 },
        }, 0);
        assert.equal(line, '1. 2026-09-20 IG reel | views 1,234 · reach 1,100 · skipped in 3s 61.2% · likes 40 · saves 12 | «🔥 دفترك الذكي»');
        assert.doesNotMatch(line, /comments|shares/);
    });

    it('cuts the answer to its limits: 10 lessons, 140 and 100 characters, a 280-character summary', () => {
        const long = 'word '.repeat(80);
        const { lessons, summary } = parseLessons({
            lessons: [...Array.from({ length: 12 }, () => ({ rule: long, evidence: long })), { rule: '  ', evidence: 'x' }],
            summary: long,
        });
        assert.equal(lessons.length, 10);
        assert.ok(lessons.every((l) => l.rule.length <= 140 && l.evidence.length <= 100));
        assert.ok(summary!.length <= 280);
    });
});

describe('runAnalyst', () => {
    let db: FakeDb;
    let calls: ModelRequest[];
    let answer: unknown;
    let previousCaller: CallModel;
    let restoreSink: (() => void) | undefined;
    const reel = { id: 'insight-1', platform: 'instagram', media_type: 'REELS', caption: 'hook', published_at: new Date('2026-09-20T16:00:00Z'), metrics: { views: 900 } };

    before(() => {
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
    });
    after(() => restoreSink?.());

    beforeEach(() => {
        db = installFakeDb();
        calls = [];
        answer = { lessons: [{ rule: 'Open on the result', evidence: 'skip 40% vs 70%' }], summary: 'Hooks work.' };
        previousCaller = setModelCaller(async (req) => {
            calls.push(req);
            if (answer instanceof Error) throw answer;
            req.onUsage?.({ model: 'gemini-test', tokensIn: 900, tokensOut: 100, thinking: 20 });
            return answer;
        });
        db.routes.push(
            [/FROM studio_settings/, () => ({ rows: [{ voice: { language: 'ar', digits: 'arabic-indic', guide: '' } }] })],
            [/^INSERT INTO studio_lessons/, () => ({ rows: [{ id: 'run-1', creator_id: TENANT, status: 'running', created_at: new Date() }] })],
            [/FROM post_insights WHERE creator_id = \$1 AND media_type/, () => ({ rows: [reel] })],
            [/FROM account_insights_daily/, () => ({ rows: [{ followers: '100', non_followers: '300' }] })],
            [/^SELECT lessons FROM studio_lessons/, () => ({ rows: [{ lessons: [{ rule: 'Old rule', evidence: 'old' }] }] })],
            [/^UPDATE studio_lessons SET status = 'done'/, (p) => ({ rows: [{ id: p[0], status: 'done', lessons: JSON.parse(p[1]), summary: p[2], basis: JSON.parse(p[3]), model: p[4], created_at: new Date() }] })],
            [/^UPDATE studio_lessons SET status = 'failed'/, (p) => ({ rows: [{ id: p[0], status: 'failed', error: p[1], lessons: null, created_at: new Date() }] })],
        );
    });
    afterEach(() => {
        db.restore();
        setModelCaller(previousCaller);
    });

    it('inserts a running row, then fills it done: lessons, summary, basis and model', async () => {
        const row = await runAnalyst(TENANT, Date.now() + 100_000);
        const order = db.statements.map((s) => s.sql);
        assert.ok(order.findIndex((s) => /^INSERT INTO studio_lessons/.test(s)) < order.findIndex((s) => /SET status = 'done'/.test(s)));
        assert.equal(row.status, 'done');
        assert.deepEqual(row.lessons, [{ rule: 'Open on the result', evidence: 'skip 40% vs 70%' }]);
        assert.deepEqual(row.basis, { posts: 1, from: '2026-09-20T16:00:00.000Z', to: '2026-09-20T16:00:00.000Z', post_ids: ['insight-1'] });
        assert.equal(row.model, 'gemini-test');

        const [call] = calls;
        assert.equal(call!.purpose, 'monteur.analyst');
        assert.match(call!.system, /in Arabic/);
        assert.match(call!.turns[0]!.text, /- Old rule \(old\)/, 'the current lessons go in');
        assert.match(call!.turns[0]!.text, /75% of the account's Instagram reach came from non-followers/);
        assert.equal(call!.maxOutputTokens, 8192, 'room above the thinking budget, which Gemini may overrun');
    });

    it('records a failure on the row instead of throwing, and keeps the current lessons', async () => {
        answer = new Error('Gemini request failed [HTTP 429]');
        const row = await runAnalyst(TENANT, Date.now() + 100_000);
        assert.equal(row.status, 'failed');
        assert.match(row.error ?? '', /HTTP 429/);
        answer = { lessons: [], summary: 'nothing' };
        assert.equal((await runAnalyst(TENANT, Date.now() + 100_000)).status, 'failed', 'no lessons is not a new set of lessons');
    });

    it('refreshes on request, but not twice at once, nor with nothing to read', async () => {
        db.routes.unshift([/AS running/, () => ({ rows: [{ running: 1, posts: 9 }] })]);
        await assert.rejects(refreshLessons(TENANT), (err: unknown) => err instanceof StudioError && err.status === 409);
        db.routes[0] = [/AS running/, () => ({ rows: [{ running: 0, posts: 0 }] })];
        await assert.rejects(refreshLessons(TENANT), (err: unknown) => err instanceof StudioError && err.status === 409);
        db.routes[0] = [/AS running/, () => ({ rows: [{ running: 0, posts: 3 }] })];
        assert.equal((await refreshLessons(TENANT)).status, 'done', 'the week’s guards are the sweep’s, not the operator’s');
    });

    it('runs from the sweep only for a tenant using the Monteur whose lessons are due', async () => {
        db.routes.unshift(
            [/^SELECT c\.id AS creator_id FROM creators c/, () => ({ rows: [{ creator_id: TENANT }] })],
            [/AS last_done_at/, () => ({ rows: [{ last_done_at: new Date(Date.now() - 2 * DAY), last_run_at: new Date(Date.now() - 2 * DAY), posts: 30 }] })],
        );
        assert.equal(await runDueAnalyst(Date.now() + 100_000), null, 'lessons 2 days old are fresh');
        assert.equal(calls.length, 0);
        const [tenants] = db.ran(/^SELECT c\.id AS creator_id FROM creators c/);
        assert.match(tenants!.sql, /s\.monteur->>'enabled' = 'true'\) OR EXISTS \(SELECT 1 FROM monteur_sources m WHERE m\.creator_id = c\.id\)/,
            'switched on, or with videos: Run now picks with the lessons even while the daily run is off');
        assert.match(tenants!.sql, /c\.is_active = TRUE/);

        db.routes[1] = [/AS last_done_at/, () => ({ rows: [{ last_done_at: null, last_run_at: null, posts: 30 }] })];
        assert.deepEqual(await runDueAnalyst(Date.now() + 100_000), { creator_id: TENANT, status: 'done' });
    });
});

describe('presentLessons', () => {
    it('shows a run cut off mid-way as failed, not running forever', () => {
        const view = presentLessons({
            id: 'r', creator_id: TENANT, status: 'running', lessons: null, summary: null, basis: null, model: null, error: null,
            created_at: new Date(Date.now() - 11 * 60 * 1000),
        });
        assert.equal(view.status, 'failed');
        assert.match(view.error ?? '', /never finished/);
        assert.deepEqual(view.basis, { posts: 0, from: null, to: null });
    });
});

describe('the Analyst on Claude on the Mac (monteur.brain = claude_mac, MONTEUR.md §6.3)', () => {
    let db: FakeDb;
    let gemini: ModelRequest[];
    let previousCaller: CallModel;
    let restoreSink: (() => void) | undefined;
    let tries: Record<string, unknown>[];
    const REQUEST = 'lessons/run-1/monteur.analyst';
    const reel = { id: 'insight-1', platform: 'instagram', media_type: 'REELS', caption: 'hook', published_at: new Date('2026-09-20T16:00:00Z'), metrics: { views: 900 } };
    const running = { id: 'run-1', creator_id: TENANT, status: 'running', lessons: null, summary: null, basis: null, model: null, error: null, created_at: new Date(Date.now() - 3 * HOUR) };
    const done = (output: unknown) => [{ id: 't1', status: 'done', try: 1, quiet_s: 1, since_s: 1, error: null, result: { output, model: 'claude-opus-5-5', usage: { input_tokens: 700, output_tokens: 90 } } }];

    before(() => {
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
    });
    after(() => restoreSink?.());

    beforeEach(() => {
        db = installFakeDb();
        gemini = [];
        tries = [];
        previousCaller = setModelCaller(async (req) => {
            gemini.push(req);
            throw new Error('Gemini was reached');
        });
        db.routes.push(
            [/FROM studio_settings/, () => ({ rows: [{ voice: { language: 'ar', digits: 'arabic-indic', guide: '' }, monteur: { brain: 'claude_mac' } }] })],
            [/^INSERT INTO studio_lessons/, () => ({ rows: [{ id: 'run-1', creator_id: TENANT, status: 'running', created_at: new Date() }] })],
            [/FROM post_insights WHERE creator_id = \$1 AND media_type/, () => ({ rows: [reel] })],
            [/FROM account_insights_daily/, () => ({ rows: [] })],
            [/^SELECT lessons FROM studio_lessons/, () => ({ rows: [] })],
            [/^SELECT id, status, result, error, \(payload->>'try'\)::int AS try/, (p) => ({ rows: p[1] === REQUEST ? tries : [] })],
            [/^INSERT INTO studio_jobs \(creator_id, kind, payload\) VALUES \(\$1, 'monteur_think'/, () => ({ rows: [{ id: 'think-job' }] })],
            [/^UPDATE studio_lessons SET status = 'done'/, (p) => ({ rows: [{ id: p[0], status: 'done', lessons: JSON.parse(p[1]), summary: p[2], basis: JSON.parse(p[3]), model: p[4], created_at: new Date() }] })],
            [/^UPDATE studio_lessons SET status = 'failed'/, (p) => ({ rows: [{ id: p[0], status: 'failed', error: p[1], lessons: null, created_at: new Date() }] })],
        );
    });
    afterEach(() => {
        db.restore();
        setModelCaller(previousCaller);
    });

    const queued = () => db.ran(/^INSERT INTO studio_jobs/).map((s) => JSON.parse(s.params[1]));

    it('queues its call for the Mac under the run’s id, and leaves the run running, not failed', async () => {
        const row = await runAnalyst(TENANT, Date.now() + 100_000);
        assert.equal(row.status, 'running');
        const [job] = queued();
        assert.deepEqual([job.request, job.step, job.model, job.purpose], [REQUEST, 'analyst', 'claude-opus-5-5', 'monteur.analyst']);
        assert.match(job.user, /Reels, newest first:/);
        assert.equal(db.ran(/^UPDATE studio_lessons/).length, 0);
        assert.equal(gemini.length, 0);
    });

    it('fills the run done from Claude’s answer, with Claude’s model', async () => {
        tries = done({ lessons: [{ rule: 'Open on the result', evidence: 'skip 40%' }], summary: 'Hooks work.' });
        const row = await runAnalyst(TENANT, Date.now() + 100_000, running as never);
        assert.equal(row.status, 'done');
        assert.deepEqual(row.lessons, [{ rule: 'Open on the result', evidence: 'skip 40%' }]);
        assert.equal(row.model, 'claude-opus-5-5');
        assert.equal(db.ran(/^INSERT INTO studio_lessons/).length, 0, 'the waiting run, resumed: no second row');
        assert.equal(gemini.length, 0);
    });

    it('fails the run once every try failed, saying Claude on the Mac didn’t answer', async () => {
        tries = [4, 3, 2, 1].map((n) => ({ id: `t${n}`, status: 'failed', try: n, quiet_s: 1e6, since_s: 1e6, error: 'claude not found', result: null }));
        const row = await runAnalyst(TENANT, Date.now() + 100_000, running as never);
        assert.equal(row.status, 'failed');
        assert.equal(row.error, 'Claude on the Mac didn\'t answer: claude not found');
        assert.equal(gemini.length, 0);
    });

    it('the sweep resumes a waiting run before any other, and never starts a second one beside it', async () => {
        db.routes.unshift(
            [/^SELECT l\.\* FROM studio_lessons l JOIN creators c/, () => ({ rows: [running] })],
            [/^SELECT c\.id AS creator_id FROM creators c/, () => ({ rows: [{ creator_id: TENANT }] })],
            [/AS last_done_at/, () => ({ rows: [{ last_done_at: null, last_run_at: null, posts: 30 }] })],
        );
        assert.equal(await runDueAnalyst(Date.now() + 100_000), null, 'still waiting, and its tenant is not due beside it');
        assert.equal(db.ran(/^INSERT INTO studio_lessons/).length, 0);
        const [waiting] = db.ran(/^SELECT l\.\* FROM studio_lessons l JOIN creators c/);
        assert.match(waiting!.sql, /l\.status = 'running' AND EXISTS \(SELECT 1 FROM studio_jobs j/);

        tries = done({ lessons: [{ rule: 'Keep it short', evidence: 'skip 30%' }], summary: null });
        assert.deepEqual(await runDueAnalyst(Date.now() + 100_000), { creator_id: TENANT, status: 'done' });
        assert.equal(gemini.length, 0);
    });

    it('Run now is refused while a run waits for the Mac, however old', async () => {
        db.routes.unshift([/AS running/, () => ({ rows: [{ running: 1, posts: 9 }] })]);
        await assert.rejects(refreshLessons(TENANT), (err: unknown) => err instanceof StudioError && err.status === 409);
        const [guard] = db.ran(/AS running/);
        assert.match(guard!.sql, /l\.created_at > NOW\(\) - make_interval\(secs => \$2\) OR EXISTS \(SELECT 1 FROM studio_jobs j/);
    });

    it('a waiting run shows as running, not as cut off after 10 minutes', () => {
        const view = presentLessons({ ...running, thinking: true } as never);
        assert.equal(view.status, 'running');
        assert.equal(presentLessons({ ...running, thinking: false } as never).status, 'failed', 'a Gemini run that old was cut off');
    });
});
