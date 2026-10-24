/**
 * The Studio queue: the claim, and what each result does to the lessons and drafts.
 *
 * Two kinds of assertion, as in src/jobs/queue.test.ts. Behavioural ones run the services
 * against a pool that answers by SQL, with no database. Structural ones check SQL text where
 * the guarantee lives in Postgres rather than in TypeScript: the claim's SKIP LOCKED and its
 * tenant filter, the attempt ceiling, the "unless a scheduled post uses it" on every delete.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { MacBrainRefused, NEEDS_API_BRAIN_MESSAGE } from '../macBrain.js';
import { invalidateTenantCache } from '../tenant.js';
import { StudioError } from './common.js';
import {
    CLAIM_SQL, claimJob, completeJob, enqueueJob, enqueueRender, EXHAUSTED_ERROR, failJob, MAX_ATTEMPTS, MAX_MAC_BRAIN_REFUSALS_PER_CLAIM,
    parseScanResult, reportProgress, STALE_CLAIM_MINUTES, STUDIO_JOB_KINDS,
} from './jobs.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const JOB = '55555555-5555-4555-8555-555555555555';
const NEWER_JOB = '56565656-5656-4565-8565-565656565656';
const LESSON = '66666666-6666-4666-8666-666666666666';
const DRAFT = '77777777-7777-4777-8777-777777777777';
const uploadId = (prefix: string) => `${prefix}111111-1111-4111-8111-111111111111`;
const IG1 = uploadId('a1');
const IG2 = uploadId('a2');
const TT1 = uploadId('b1');
const TT2 = uploadId('b2');
const OLD1 = uploadId('c1');
const OLD2 = uploadId('c2');
const up = (id: string) => `https://msg-response-auto.vercel.app/api/uploads/${id}`;

type Rows = { rows: any[]; rowCount?: number };
interface Statement { sql: string; params: any[] }
let statements: Statement[] = [];
let routes: [RegExp, (params: any[]) => Rows][] = [];
const original = { query: pool.query, connect: pool.connect };
let restoreSink: (() => void) | undefined;

before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    statements = [];
    routes = [];
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        const route = routes.find(([pattern]) => pattern.test(flat));
        const r = route ? route[1](params) : { rows: [] };
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as unknown as { query: unknown }).query = run;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release() {} });
});
afterEach(() => {
    (pool as unknown as { query: unknown }).query = original.query;
    (pool as unknown as { connect: unknown }).connect = original.connect;
});

const ran = (pattern: RegExp) => statements.filter((s) => pattern.test(s.sql));
const LOCK = /^SELECT id, creator_id, kind, status, payload FROM studio_jobs/;
const LATEST = /ORDER BY created_at DESC, id DESC LIMIT 1/;

function lockReturns(job: Record<string, unknown>) {
    routes.push([LOCK, (params) => ({ rows: params[0] === job.id && params[1] === TENANT ? [{ creator_id: TENANT, ...job }] : [] })]);
}

const isStudioError = (status: number) => (err: unknown) => err instanceof StudioError && err.status === status;

// ─── Claim ──────────────────────────────────────────────────────────────────────────────

describe('claim — the SQL', () => {
    it('locks with SKIP LOCKED, so two claimers split the work instead of taking one job twice', () => {
        assert.match(CLAIM_SQL, /FOR UPDATE SKIP LOCKED/);
        assert.match(CLAIM_SQL, /LIMIT 1/);
        // No window function: Postgres rejects FOR UPDATE beside one (FLOWS.md §5.2).
        assert.doesNotMatch(CLAIM_SQL, /OVER \(/);
    });

    it('only ever looks at the worker’s own tenant', () => {
        assert.match(CLAIM_SQL, /WHERE creator_id = \$1/);
    });

    it('takes a pending job that is due, or a claimed one gone quiet for 15 minutes with claims left, oldest first', () => {
        const sql = CLAIM_SQL.replace(/\s+/g, ' ');
        assert.match(sql, /\(\(status = 'pending' AND not_before <= NOW\(\)\) OR \(status = 'claimed' AND COALESCE\(heartbeat_at, claimed_at, created_at\) < NOW\(\) - make_interval\(mins => \$2\) AND attempts < \$3\)\)/);
        assert.match(sql, /ORDER BY CASE kind WHEN 'pick_folder' THEN 0 WHEN 'render_carousel' THEN 1 WHEN 'monteur_think' THEN 1 WHEN 'render_infographic' THEN 1 WHEN 'ads_think' THEN 1 WHEN 'explainer_write' THEN 1 WHEN 'monteur_render' THEN 2 WHEN 'explainer_voice' THEN 2 WHEN 'explainer_render' THEN 2 WHEN 'scan_library' THEN 3 WHEN 'monteur_scan' THEN 3 WHEN 'explainer_draw' THEN 3 ELSE 4 END, created_at, id/,
            'the folder dialog first (someone is at the Mac), renders, infographics, Claude\'s thinks and an explainer\'s script next (someone is waiting at the screen; the Monteur waits on the think), the long transcribe and index backlog last');
        assert.match(sql, /attempts = j\.attempts \+ 1/);
        assert.match(sql, /heartbeat_at = NOW\(\)/);
    });
});

describe('claim — not_before (v59)', () => {
    // Whether a row is due is decided by Postgres, so the text of the statement is what is under test here: the fake pool cannot evaluate it.
    // jobs.sql.test.ts runs this same statement on a real PostgreSQL, against fixture rows, when a local database is named.
    const sql = CLAIM_SQL.replace(/\s+/g, ' ');

    /** The rank each kind is claimed at, read out of the statement's CASE; a kind it does not list is the ELSE. */
    function rankOf(kind: string): number {
        const ranks = new Map([...sql.matchAll(/WHEN '(\w+)' THEN (\d)/g)].map((m) => [m[1]!, Number(m[2])]));
        return ranks.get(kind) ?? Number(/ELSE (\d) END/.exec(sql)![1]);
    }

    it('claims a pending job only once its not_before has passed: one with a future not_before is skipped, and one that is due is taken', () => {
        // The pending branch is exactly this and nothing more: a due job is claimable at once, a delayed one is not.
        assert.match(sql, /\(status = 'pending' AND not_before <= NOW\(\)\)/);
        assert.doesNotMatch(sql, /status = 'pending' OR/, 'no way to a pending job that skips the clock');
    });

    it('reclaims a stale claim whatever its not_before says: that clock is for jobs nobody has started', () => {
        const stale = /\(status = 'claimed' AND .*? attempts < \$3\)/.exec(sql);
        assert.ok(stale, 'the stale branch is found');
        assert.doesNotMatch(stale![0], /not_before/);
    });

    it('reads not_before in that one place only: the order, the update and the returned columns do not', () => {
        assert.equal(sql.match(/not_before/g)?.length, 1);
        assert.doesNotMatch(/RETURNING .*/.exec(sql)![0], /not_before/);
    });

    it('leaves the rank of every existing kind where it was, and ranks the explainer kinds: write 1, voice 2, render 2, draw 3', () => {
        const before: [string, number][] = [
            ['pick_folder', 0], ['render_carousel', 1], ['monteur_think', 1], ['render_infographic', 1], ['ads_think', 1], ['monteur_render', 2],
            ['scan_library', 3], ['monteur_scan', 3], ['index_lesson', 4], ['monteur_transcribe', 4],
        ];
        for (const [kind, rank] of before) assert.equal(rankOf(kind), rank, kind);
        assert.deepEqual(['explainer_write', 'explainer_voice', 'explainer_render', 'explainer_draw'].map(rankOf), [1, 2, 2, 3]);
    });

    it('ranks every kind the queue knows, so none falls to the backlog by being left out of the CASE by mistake', () => {
        for (const kind of STUDIO_JOB_KINDS) {
            const listed = new RegExp(`WHEN '${kind}' THEN`).test(sql);
            if (!listed) assert.ok(['index_lesson', 'monteur_transcribe'].includes(kind), `${kind} is in the ELSE: the backlog`);
        }
    });

    it('is asked for the explainer kinds like any other: the kinds filter reaches the statement', async () => {
        routes.push([/^WITH picked AS/, () => ({ rows: [{ id: JOB, kind: 'explainer_voice', payload: { explainer_id: 'e' }, attempts: 1 }] })]);
        assert.equal((await claimJob(TENANT, ['explainer_voice', 'explainer_draw']))?.kind, 'explainer_voice');
        assert.deepEqual(ran(/^WITH picked AS/)[0]!.params[3], ['explainer_voice', 'explainer_draw']);
    });
});

describe('STUDIO_JOB_KINDS', () => {
    it('holds the four explainer kinds beside the others, each once', () => {
        for (const kind of ['explainer_write', 'explainer_voice', 'explainer_draw', 'explainer_render']) assert.ok(STUDIO_JOB_KINDS.includes(kind as never), kind);
        assert.equal(new Set(STUDIO_JOB_KINDS).size, STUDIO_JOB_KINDS.length);
        assert.equal(STUDIO_JOB_KINDS.length, 14);
    });
});

describe('claimJob', () => {
    it('passes the tenant, the 15-minute window and the 3-claim ceiling, and hands back id, kind and payload', async () => {
        routes.push([/^WITH picked AS/, () => ({ rows: [{ id: JOB, kind: 'scan_library', payload: { root: '/r' }, attempts: 1 }] })]);
        assert.deepEqual(await claimJob(TENANT), { id: JOB, kind: 'scan_library', payload: { root: '/r' } });
        const [claim] = ran(/^WITH picked AS/);
        assert.deepEqual(claim!.params, [TENANT, STALE_CLAIM_MINUTES, MAX_ATTEMPTS, null], 'no kinds: any job');
        assert.equal(STALE_CLAIM_MINUTES, 15);
        assert.equal(MAX_ATTEMPTS, 3);
    });

    it('returns null when there is nothing to do', async () => {
        assert.equal(await claimJob(TENANT), null);
    });

    it('first fails a claim that went quiet a third time, lesson included, instead of claiming it a fourth', async () => {
        routes.push([/SET status = 'failed', error = \$4/, () => ({
            rows: [{ id: JOB, creator_id: TENANT, kind: 'index_lesson', status: 'failed', payload: { lessonId: LESSON } }],
        })]);
        await claimJob(TENANT);

        const [exhaust] = ran(/SET status = 'failed', error = \$4/);
        assert.match(exhaust!.sql, /status = 'claimed'/);
        assert.match(exhaust!.sql, /attempts >= \$3/);
        assert.deepEqual(exhaust!.params, [TENANT, STALE_CLAIM_MINUTES, MAX_ATTEMPTS, EXHAUSTED_ERROR]);

        const [lesson] = ran(/^UPDATE course_lessons SET status = 'failed'/);
        assert.deepEqual(lesson!.params, [LESSON, TENANT, EXHAUSTED_ERROR]);
        // The reaping happens before the claim, so the claim cannot pick the row up again.
        const order = statements.map((s) => s.sql);
        assert.ok(order.findIndex((s) => /attempts >= \$3/.test(s)) < order.findIndex((s) => /^WITH picked AS/.test(s)));
    });
});

// ─── The Mac is the owner's (G1) ────────────────────────────────────────────────────────

describe('the Mac is the owner’s: Claude’s work reaches a worker only for the tenants on studio.mac_brain_tenants', () => {
    const NEW_TENANT = '88888888-8888-4888-8888-888888888888';
    const INFOGRAPHIC = '99999999-9999-4999-8999-999999999999';
    let saved: string | null;
    /** What the claim hands out next, in order; empty means nothing is pending. */
    let pending: { id: string; kind: string; payload: unknown }[];
    /** The jobs the claim has taken, by id: what `failJob` finds when it locks one. */
    let claimed: Map<string, { id: string; kind: string; payload: unknown }>;

    beforeEach(() => {
        invalidateTenantCache();
        saved = null;
        pending = [];
        claimed = new Map();
        routes.push(
            [/^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/, () => ({ rows: [{ id: TENANT }] })],
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({
                rows: p[0] === 'studio.mac_brain_tenants' && saved !== null ? [{ value: saved, is_secret: false }] : [],
            })],
            [/^WITH picked AS/, () => {
                const next = pending.shift();
                if (!next) return { rows: [] };
                claimed.set(next.id, next);
                return { rows: [{ ...next, attempts: 1 }] };
            }],
            [LOCK, (p) => {
                const job = claimed.get(p[0]);
                return { rows: job ? [{ ...job, creator_id: p[1], status: 'claimed' }] : [] };
            }],
        );
    });
    afterEach(() => invalidateTenantCache());

    const think = (id: string) => ({ id, kind: 'monteur_think', payload: { request: `source/x/a1/${id}`, try: 1, step: 'pick' } });
    const infographic = (id: string, write: boolean) => ({
        id, kind: 'render_infographic', payload: { infographicId: INFOGRAPHIC, theme: 'dark', ...(write ? { write: { model: 'm' } } : { spec: {} }) },
    });
    /** `failJob`'s statement: the reaper's (`error = $4`) and the folder dialog's are not it. */
    const failures = () => ran(/^UPDATE studio_jobs SET status = 'failed', error = \$2, progress = NULL/);

    it('fails a think for a tenant that is not on the list, with the reason, instead of handing it out', async () => {
        pending = [think(JOB)];
        assert.equal(await claimJob(NEW_TENANT), null, 'the worker is told there is nothing');
        assert.deepEqual(failures().map((f) => f.params), [[JOB, NEEDS_API_BRAIN_MESSAGE]]);
    });

    it('fails an infographic Claude would write, and the infographic goes failed with the reason', async () => {
        pending = [infographic(JOB, true)];
        assert.equal(await claimJob(NEW_TENANT), null);
        assert.deepEqual(failures().map((f) => f.params), [[JOB, NEEDS_API_BRAIN_MESSAGE]]);
        const [row] = ran(/^UPDATE infographics SET status = 'failed'/);
        assert.deepEqual(row!.params, [INFOGRAPHIC, NEW_TENANT, NEEDS_API_BRAIN_MESSAGE, JOB]);
    });

    it('goes on to the next job in the same claim: a refused think never holds up a scan', async () => {
        pending = [think(JOB), think(NEWER_JOB), { id: LESSON, kind: 'scan_library', payload: { root: '/r' } }];
        assert.deepEqual(await claimJob(NEW_TENANT), { id: LESSON, kind: 'scan_library', payload: { root: '/r' } });
        assert.deepEqual(failures().map((f) => f.params[0]), [JOB, NEWER_JOB]);
    });

    it('hands out a render alone, and every other kind, to a tenant that is not on the list', async () => {
        for (const job of [infographic(JOB, false), { id: NEWER_JOB, kind: 'monteur_render', payload: { clipId: 'c' } }, { id: LESSON, kind: 'pick_folder', payload: {} }]) {
            pending = [job];
            assert.equal((await claimJob(NEW_TENANT))?.id, job.id, job.kind);
        }
        assert.equal(failures().length, 0);
    });

    it('hands the owner his think and his infographic, with nothing configured', async () => {
        pending = [think(JOB)];
        assert.equal((await claimJob(TENANT))?.id, JOB);
        pending = [infographic(NEWER_JOB, true)];
        assert.equal((await claimJob(TENANT))?.id, NEWER_JOB);
        assert.equal(failures().length, 0);
    });

    const explainer = (id: string, kind: string) => ({ id, kind, payload: { explainer_id: 'e' } });

    it('fails an explainer’s script for a tenant that is not on the list, with the reason: it is Claude’s work', async () => {
        pending = [explainer(JOB, 'explainer_write')];
        assert.equal(await claimJob(NEW_TENANT), null);
        assert.deepEqual(failures().map((f) => f.params), [[JOB, NEEDS_API_BRAIN_MESSAGE]]);
    });

    it('hands that tenant the other three explainer jobs, which use no Claude: the switch keeps them the owner’s', async () => {
        for (const [i, kind] of (['explainer_voice', 'explainer_draw', 'explainer_render'] as const).entries()) {
            pending = [explainer(`5${i}555555-5555-4555-8555-555555555555`, kind)];
            assert.equal((await claimJob(NEW_TENANT))?.kind, kind, kind);
        }
        assert.equal(failures().length, 0);
    });

    it('hands the owner his explainer’s script, with nothing configured', async () => {
        pending = [explainer(JOB, 'explainer_write')];
        assert.equal((await claimJob(TENANT))?.id, JOB);
        assert.equal(failures().length, 0);
    });

    it('a saved list adds a tenant: it is handed its think, the owner his own, and a third is failed', async () => {
        saved = JSON.stringify([NEW_TENANT]);
        pending = [think(JOB)];
        assert.equal((await claimJob(NEW_TENANT))?.id, JOB);
        pending = [think(NEWER_JOB)];
        assert.equal((await claimJob(TENANT))?.id, NEWER_JOB, 'the owner is never taken off the Mac by the list');
        pending = [think(LESSON)];
        assert.equal(await claimJob('77777777-7777-4777-8777-777777777777'), null);
        assert.deepEqual(failures().map((f) => f.params), [[LESSON, NEEDS_API_BRAIN_MESSAGE]]);
    });

    it('asks who the Mac is for only when it meets Claude’s work: an ordinary claim reads no setting', async () => {
        pending = [{ id: JOB, kind: 'scan_library', payload: {} }];
        await claimJob(NEW_TENANT);
        assert.equal(ran(/FROM app_settings/).length, 0);
        pending = [think(NEWER_JOB), think(LESSON)];
        await claimJob(NEW_TENANT);
        assert.equal(ran(/FROM app_settings/).length, 1, 'once per claim, however many it refuses');
    });

    it('stops after exactly the bounded number of refusals; the next poll takes up the rest', async () => {
        pending = Array.from({ length: MAX_MAC_BRAIN_REFUSALS_PER_CLAIM + 20 }, (_, i) => think(`think-${i}`));
        assert.equal(await claimJob(NEW_TENANT), null);
        assert.equal(failures().length, MAX_MAC_BRAIN_REFUSALS_PER_CLAIM, 'not one more');
        assert.equal(ran(/^WITH picked AS/).length, MAX_MAC_BRAIN_REFUSALS_PER_CLAIM);
        assert.equal(pending.length, 20);
    });

    it('is never a hand-out when the list cannot be read: the claim is released, and the error reaches the route', async () => {
        routes.unshift([/FROM app_settings/, () => { throw new Error('connection reset'); }]);
        pending = [think(JOB)];
        await assert.rejects(claimJob(NEW_TENANT), /connection reset/);
        assert.equal(failures().length, 0, 'nothing is failed on a guess');
        const [release] = ran(/^UPDATE studio_jobs SET status = 'pending', attempts = attempts - 1/);
        assert.ok(release, 'the job is given back, not left claimed');
        assert.deepEqual(release!.params, [JOB, NEW_TENANT]);
        assert.match(release!.sql, /claimed_at = NULL, heartbeat_at = NULL/);
        assert.match(release!.sql, /WHERE id = \$1 AND creator_id = \$2 AND status = 'claimed'$/, 'only a claim still held');
    });

    it('releases the claim the same way when the owner lookup is what failed', async () => {
        routes.unshift([/^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/, () => { throw new Error('connection reset'); }]);
        pending = [think(JOB)];
        await assert.rejects(claimJob(TENANT), /connection reset/);
        assert.equal(ran(/^UPDATE studio_jobs SET status = 'pending', attempts = attempts - 1/).length, 1);
        assert.equal(failures().length, 0);
    });

    it('a failed release does not hide the error that caused it', async () => {
        routes.unshift(
            [/FROM app_settings/, () => { throw new Error('connection reset'); }],
            [/^UPDATE studio_jobs SET status = 'pending'/, () => { throw new Error('release failed too'); }],
        );
        pending = [think(JOB)];
        await assert.rejects(claimJob(NEW_TENANT), /connection reset/);
    });

    it('releases nothing on the way to a hand-out or a refusal', async () => {
        pending = [think(JOB), { id: LESSON, kind: 'scan_library', payload: {} }];
        await claimJob(NEW_TENANT);
        assert.equal(ran(/^UPDATE studio_jobs SET status = 'pending'/).length, 0);
    });
});

describe('enqueueJob — the net under every caller of Claude’s work', () => {
    const NEW_TENANT = '88888888-8888-4888-8888-888888888888';
    let saved: string | null;
    beforeEach(() => {
        invalidateTenantCache();
        saved = null;
        routes.push(
            [/^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/, () => ({ rows: [{ id: TENANT }] })],
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({
                rows: p[0] === 'studio.mac_brain_tenants' && saved !== null ? [{ value: saved, is_secret: false }] : [],
            })],
            [/^INSERT INTO studio_jobs/, (p) => ({ rows: [{ id: JOB, kind: p[1], status: 'pending', payload: JSON.parse(p[2]) }] })],
        );
    });
    afterEach(() => invalidateTenantCache());

    const inserted = () => ran(/^INSERT INTO studio_jobs/);
    const refused = (err: unknown) => err instanceof MacBrainRefused && err.status === 409 && err.code === 'NEEDS_API_BRAIN';

    it('refuses an infographic with `write` and a think for a tenant that is not on the list: nothing is inserted', async () => {
        await assert.rejects(enqueueJob(pool, NEW_TENANT, 'render_infographic', { infographicId: 'i', write: { model: 'm' } }), refused);
        await assert.rejects(enqueueJob(pool, NEW_TENANT, 'monteur_think', { request: 'r', try: 1 }), refused);
        assert.equal(inserted().length, 0);
    });

    it('queues a render alone, and every other kind, for that tenant', async () => {
        await enqueueJob(pool, NEW_TENANT, 'render_infographic', { infographicId: 'i', spec: {} });
        await enqueueJob(pool, NEW_TENANT, 'monteur_render', { clipId: 'c' });
        await enqueueJob(pool, NEW_TENANT, 'scan_library', {});
        assert.equal(inserted().length, 3);
    });

    it('refuses an explainer’s script for a tenant that is not on the list, with nothing inserted, and queues the other three explainer kinds', async () => {
        await assert.rejects(enqueueJob(pool, NEW_TENANT, 'explainer_write', { explainer_id: 'e' }), refused);
        assert.equal(inserted().length, 0);
        for (const kind of ['explainer_voice', 'explainer_draw', 'explainer_render'] as const) await enqueueJob(pool, NEW_TENANT, kind, { explainer_id: 'e' });
        assert.equal(inserted().length, 3);
    });

    it('queues the owner’s explainer script', async () => {
        await enqueueJob(pool, TENANT, 'explainer_write', { explainer_id: 'e' });
        assert.equal(inserted().length, 1);
    });

    it('queues the owner’s, and a listed tenant’s: the list adds to the owner, never replaces him', async () => {
        await enqueueJob(pool, TENANT, 'render_infographic', { infographicId: 'i', write: { model: 'm' } });
        saved = JSON.stringify([NEW_TENANT]);
        await enqueueJob(pool, NEW_TENANT, 'render_infographic', { infographicId: 'i', write: { model: 'm' } });
        await enqueueJob(pool, TENANT, 'render_infographic', { infographicId: 'i', write: { model: 'm' } });
        assert.equal(inserted().length, 3);
        await assert.rejects(enqueueJob(pool, '77777777-7777-4777-8777-777777777777', 'render_infographic', { infographicId: 'i', write: { model: 'm' } }), refused);
    });
});

// ─── Progress ───────────────────────────────────────────────────────────────────────────

describe('reportProgress', () => {
    it('is the heartbeat, keeping the last line when none is sent', async () => {
        routes.push([/^UPDATE studio_jobs SET progress/, () => ({ rows: [], rowCount: 1 })]);
        await reportProgress(TENANT, JOB, null);
        const [update] = ran(/^UPDATE studio_jobs SET progress/);
        assert.match(update!.sql, /progress = COALESCE\(\$3, progress\), heartbeat_at = NOW\(\)/);
        assert.match(update!.sql, /WHERE id = \$1 AND creator_id = \$2 AND status = 'claimed'/);
    });

    it('tells the worker to stop when the job is no longer claimed, and 404s one that is not its tenant’s', async () => {
        routes.push([/^SELECT status FROM studio_jobs/, (params) => ({ rows: params[0] === JOB ? [{ status: 'failed' }] : [] })]);
        await assert.rejects(reportProgress(TENANT, JOB, 'frame 3'), isStudioError(409));
        await assert.rejects(reportProgress(TENANT, NEWER_JOB, 'frame 3'), isStudioError(404));
    });
});

// ─── Complete ───────────────────────────────────────────────────────────────────────────

describe('completeJob — the lifecycle', () => {
    it('404s a job that is not this tenant’s, writing nothing', async () => {
        lockReturns({ id: JOB, kind: 'scan_library', status: 'claimed', payload: { root: '/r' } });
        await assert.rejects(completeJob('99999999-9999-4999-8999-999999999999', JOB, { lessons: [] }), isStudioError(404));
        assert.equal(ran(/^(INSERT|UPDATE|DELETE)/).length, 0);
    });

    it('answers a repeated delivery of a finished job without applying it twice', async () => {
        lockReturns({ id: JOB, kind: 'scan_library', status: 'done', payload: { root: '/r' } });
        assert.equal(await completeJob(TENANT, JOB, { lessons: [] }), 'already_done');
        assert.equal(ran(/^(INSERT|UPDATE|DELETE)/).length, 0);
    });

    it('refuses a job that is pending or failed', async () => {
        lockReturns({ id: JOB, kind: 'scan_library', status: 'failed', payload: { root: '/r' } });
        await assert.rejects(completeJob(TENANT, JOB, { lessons: [] }), isStudioError(409));
    });
});

describe('completeJob — scan_library', () => {
    const lesson = (path: string, title = 'Title') => ({
        lesson_no: '1.2', section_no: 1, section_title: 'Chapter 1', title, video_path: path, duration_s: 312.5,
    });

    it('upserts by video_path and never deletes', async () => {
        lockReturns({ id: JOB, kind: 'scan_library', status: 'claimed', payload: { root: '/r' } });
        await completeJob(TENANT, JOB, { lessons: [lesson('/r/a.mp4'), lesson('/r/b.mp4')] });

        const [upsert] = ran(/^INSERT INTO course_lessons/);
        assert.match(upsert!.sql, /ON CONFLICT \(creator_id, video_path\) DO UPDATE/);
        assert.equal(upsert!.params[0], TENANT);
        assert.deepEqual(JSON.parse(upsert!.params[1]).map((l: any) => l.video_path), ['/r/a.mp4', '/r/b.mp4']);
        assert.equal(ran(/^DELETE/).length, 0, 'a file gone from the Mac keeps its lesson');

        const [done] = ran(/SET status = 'done'/);
        assert.deepEqual(JSON.parse(done!.params[1]), { lessons: 2, skipped: [] });
    });

    it('keeps the last entry for a repeated path, which ON CONFLICT could not update twice', () => {
        const { lessons } = parseScanResult({ lessons: [lesson('/r/a.mp4', 'Old'), lesson('/r/a.mp4', 'New')] });
        assert.deepEqual(lessons.map((l) => l.title), ['New']);
    });

    it('skips an entry it cannot read, and names it, rather than refusing the whole library', () => {
        const { lessons, skipped } = parseScanResult({ lessons: [lesson('/r/a.mp4'), { ...lesson('relative.mp4') }, 'junk'] });
        assert.equal(lessons.length, 1);
        assert.equal(skipped.length, 2);
        assert.match(skipped[0]!, /lessons\[1\].*absolute path/);
    });

    it('refuses a result that is not { lessons: [...] }', () => {
        assert.throws(() => parseScanResult({ files: [] }), isStudioError(400));
    });
});

describe('completeJob — index_lesson', () => {
    const notes = {
        summary: 'ملخص', points: [{ title: 'فكرة', detail: 'تفصيل', t: 12 }],
        prompts: [{ text: 'prompt' }], tools: ['NotebookLM'], demos: [{ title: 'Demo', result: 'Works' }],
    };
    const moment = (t: number) => ({ t, description: 'Screen', kind: 'ui', clean: true, thumb_url: up(IG1) });

    beforeEach(() => {
        lockReturns({ id: JOB, kind: 'index_lesson', status: 'claimed', payload: { lessonId: LESSON } });
        routes.push([/^SELECT id FROM course_lessons WHERE id = \$1 AND creator_id = \$2 FOR UPDATE/, () => ({ rows: [{ id: LESSON }] })]);
    });

    it('replaces the moments, sets the notes, and marks the lesson indexed', async () => {
        await completeJob(TENANT, JOB, { notes, moments: [moment(3), moment(40)] });

        const [del] = ran(/^DELETE FROM lesson_moments/);
        assert.deepEqual(del!.params, [LESSON]);
        const [insert] = ran(/^INSERT INTO lesson_moments/);
        assert.equal(insert!.params[0], LESSON);
        assert.deepEqual(JSON.parse(insert!.params[1]).map((m: any) => m.t), [3, 40]);
        const [lesson] = ran(/^UPDATE course_lessons SET notes/);
        assert.match(lesson!.sql, /status = 'indexed', indexed_at = NOW\(\), error = NULL/);
        assert.equal(JSON.parse(lesson!.params[1]).summary, 'ملخص');
        // Delete before insert, or the new moments would be the ones deleted.
        const order = statements.map((s) => s.sql);
        assert.ok(order.findIndex((s) => /^DELETE FROM lesson_moments/.test(s)) < order.findIndex((s) => /^INSERT INTO lesson_moments/.test(s)));
    });

    it('refuses a malformed result whole, with the problems, and leaves the old moments in place', async () => {
        await assert.rejects(
            completeJob(TENANT, JOB, { notes: { summary: '' }, moments: [{ t: -1, description: '', kind: 'poster' }] }),
            (err: unknown) => err instanceof StudioError && err.status === 400
                && (err.problems ?? []).some((p) => /summary/.test(p))
                && (err.problems ?? []).some((p) => /moments\[0\]\.kind/.test(p))
        );
        assert.equal(ran(/^(DELETE|INSERT|UPDATE)/).length, 0);
    });
});

describe('completeJob — render_carousel', () => {
    const payload = { draftId: DRAFT, carousel: { slides: [{ kind: 'cover' }, { kind: 'cta' }] }, shots: {} };
    const result = { ig: [up(IG1), up(IG2)], tt: [up(TT1), up(TT2)] };
    let latest = JOB;
    let draftStatus = 'rendering';

    beforeEach(() => {
        latest = JOB;
        draftStatus = 'rendering';
        lockReturns({ id: JOB, kind: 'render_carousel', status: 'claimed', payload });
        routes.push([/^SELECT id FROM media_uploads/, (params) => ({ rows: params[0].map((id: string) => ({ id })) })]);
        routes.push([/^SELECT id, status, render FROM carousel_drafts/, () => ({
            rows: [{ id: DRAFT, status: draftStatus, render: { ig: [up(OLD1)], tt: [up(OLD2)], rendered_at: 'x', job_id: 'old' } }],
        })]);
        routes.push([LATEST, () => ({ rows: [{ id: latest }] })]);
        routes.push([/^DELETE FROM media_uploads/, (params) => ({ rows: [], rowCount: params[1].length })]);
        routes.push([/FROM app_settings WHERE key = \$1/, (params) => ({
            rows: params[0] === 'app.public_base_url' ? [{ value: 'https://msg-response-auto.vercel.app', is_secret: false }] : [],
        })]);
    });

    it('stores its slides on our own address, never the URLs the worker sent', async () => {
        const evil = { ig: [`https://evil.example/api/uploads/${IG1}`, `https://evil.example/x/api/uploads/${IG2}.jpg`], tt: result.tt };
        assert.equal(await completeJob(TENANT, JOB, evil), 'applied');
        const render = JSON.parse(ran(/^UPDATE carousel_drafts SET render/)[0]!.params[1]);
        assert.deepEqual(render.ig, [up(IG1), up(IG2)]);
        assert.ok(!JSON.stringify(render).includes('evil.example'));
    });

    it('lands the render on the draft, marks it ready, and deletes the previous render’s uploads', async () => {
        assert.equal(await completeJob(TENANT, JOB, result), 'applied');

        const [land] = ran(/^UPDATE carousel_drafts SET render/);
        assert.match(land!.sql, /status = 'ready'/);
        const render = JSON.parse(land!.params[1]);
        assert.deepEqual(render.ig, result.ig);
        assert.deepEqual(render.tt, result.tt);
        assert.equal(render.job_id, JOB);
        assert.ok(render.rendered_at);

        const [del] = ran(/^DELETE FROM media_uploads/);
        assert.deepEqual(del!.params, [TENANT, [OLD1, OLD2]]);
        // Unless a scheduled post still names one, in any state.
        assert.match(del!.sql, /NOT EXISTS \( SELECT 1 FROM scheduled_posts s/);
        assert.match(del!.sql, /array_to_string\(s\.media_urls, ' '\)/);
        assert.match(del!.sql, /m\.creator_id = \$1/);
    });

    it('drops a stale result — an edit queued a newer render meanwhile — and deletes its uploads', async () => {
        latest = NEWER_JOB;
        assert.equal(await completeJob(TENANT, JOB, result), 'dropped');

        assert.equal(ran(/^UPDATE carousel_drafts/).length, 0, 'the draft keeps waiting for the newer render');
        const [del] = ran(/^DELETE FROM media_uploads/);
        assert.deepEqual(del!.params, [TENANT, [IG1, IG2, TT1, TT2]]);
        const [done] = ran(/SET status = 'done'/);
        assert.equal(JSON.parse(done!.params[1]).dropped, 'superseded');
    });

    it('drops a result for a draft that was scheduled meanwhile', async () => {
        draftStatus = 'scheduled';
        assert.equal(await completeJob(TENANT, JOB, result), 'dropped');
        assert.equal(ran(/^UPDATE carousel_drafts/).length, 0);
    });

    it('refuses a render with a slide missing, before touching the draft', async () => {
        await assert.rejects(
            completeJob(TENANT, JOB, { ig: [up(IG1)], tt: result.tt }),
            (err: unknown) => err instanceof StudioError && err.status === 400
                && (err.problems ?? []).some((p) => /ig has 1 images for 2 slides/.test(p))
        );
        assert.equal(ran(/^(UPDATE carousel_drafts|DELETE)/).length, 0);
    });

    it('refuses a render naming an upload this tenant does not own', async () => {
        routes.unshift([/^SELECT id FROM media_uploads/, () => ({ rows: [{ id: IG1 }, { id: IG2 }, { id: TT1 }] })]);
        await assert.rejects(completeJob(TENANT, JOB, result), (err: unknown) =>
            err instanceof StudioError && err.status === 400 && (err.problems ?? []).some((p) => p.includes(TT2)));
    });
});

// ─── Fail ───────────────────────────────────────────────────────────────────────────────

describe('failJob', () => {
    it('fails the job, and its lesson with the worker’s error', async () => {
        lockReturns({ id: JOB, kind: 'index_lesson', status: 'claimed', payload: { lessonId: LESSON } });
        await failJob(TENANT, JOB, 'Gemini refused the file');
        assert.deepEqual(ran(/^UPDATE studio_jobs SET status = 'failed'/)[0]!.params, [JOB, 'Gemini refused the file']);
        assert.deepEqual(ran(/^UPDATE course_lessons SET status = 'failed'/)[0]!.params, [LESSON, TENANT, 'Gemini refused the file']);
    });

    it('fails the draft only when this is its latest render', async () => {
        lockReturns({ id: JOB, kind: 'render_carousel', status: 'claimed', payload: { draftId: DRAFT } });
        routes.push([LATEST, () => ({ rows: [{ id: JOB }] })]);
        await failJob(TENANT, JOB, 'Remotion crashed');
        const [draft] = ran(/^UPDATE carousel_drafts SET status = 'failed'/);
        assert.deepEqual(draft!.params, [DRAFT, TENANT, 'Remotion crashed']);
        assert.match(draft!.sql, /status <> 'scheduled'/);
    });

    it('leaves the draft alone when a newer render is on its way', async () => {
        lockReturns({ id: JOB, kind: 'render_carousel', status: 'claimed', payload: { draftId: DRAFT } });
        routes.push([LATEST, () => ({ rows: [{ id: NEWER_JOB }] })]);
        await failJob(TENANT, JOB, 'Remotion crashed');
        assert.equal(ran(/^UPDATE carousel_drafts/).length, 0);
    });

    it('is a no-op on a job already failed, and refused on one that finished', async () => {
        lockReturns({ id: JOB, kind: 'scan_library', status: 'failed', payload: {} });
        await failJob(TENANT, JOB, 'again');
        assert.equal(ran(/^UPDATE/).length, 0);

        routes = [];
        lockReturns({ id: JOB, kind: 'scan_library', status: 'done', payload: {} });
        await assert.rejects(failJob(TENANT, JOB, 'late'), isStudioError(409));
    });
});

// ─── Enqueue a render ───────────────────────────────────────────────────────────────────

describe('enqueueRender', () => {
    it('fails renders of the same draft still pending, queues this one, and marks the draft rendering', async () => {
        routes.push([/^INSERT INTO studio_jobs/, () => ({ rows: [{ id: NEWER_JOB, kind: 'render_carousel', status: 'pending' }] })]);
        routes.push([/^UPDATE carousel_drafts SET status = 'rendering'/, () => ({ rows: [{ id: DRAFT, status: 'rendering' }] })]);
        const payload = {
            draftId: DRAFT, carousel: {} as never, shots: {}, brand: {} as never, cta: {} as never, facts: [],
        };
        const { job, draft } = await enqueueRender(pool as never, TENANT, payload);
        assert.equal(job.id, NEWER_JOB);
        assert.equal(draft?.status, 'rendering');

        const [supersede] = ran(/^UPDATE studio_jobs SET status = 'failed'/);
        assert.match(supersede!.sql, /kind = 'render_carousel' AND status = 'pending' AND payload->>'draftId' = \$2/);
        assert.deepEqual(supersede!.params.slice(0, 2), [TENANT, DRAFT]);
        const order = statements.map((s) => s.sql);
        assert.ok(order.findIndex((s) => /^UPDATE studio_jobs/.test(s)) < order.findIndex((s) => /^INSERT INTO studio_jobs/.test(s)),
            'superseding after the insert would fail the new job too');
    });
});

// ─── The explainer kinds (v59) ──────────────────────────────────────────────────────────────────

describe('the explainer kinds are handed to explainers/apply.ts, which in E1 only logs', () => {
    const EXPLAINER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const KINDS = ['explainer_write', 'explainer_voice', 'explainer_draw', 'explainer_render'] as const;
    let events: { level: string; event: string; fields: Record<string, unknown> }[] = [];
    let restoreSink: (() => void) | undefined;

    beforeEach(() => {
        events = [];
        const previous = setLogSink((level, line) => { const { ts: _ts, level: _level, event, ...fields } = JSON.parse(line); events.push({ level, event, fields }); });
        restoreSink = () => setLogSink(previous);
    });
    afterEach(() => restoreSink?.());

    const unhandled = () => events.filter((e) => e.event === 'explainer.result_unhandled');
    /** Anything that would be an explainer being changed. */
    const explainerWrites = () => ran(/explainers|explainer_scenes|image_allowance/);

    for (const kind of KINDS) {
        it(`${kind}: a result is logged and dropped, the job is marked done, and no explainer table is touched`, async () => {
            lockReturns({ id: JOB, kind, status: 'claimed', payload: { explainer_id: EXPLAINER } });
            assert.equal(await completeJob(TENANT, JOB, { state: 'done' }), 'dropped');
            const [done] = ran(/SET status = 'done'/);
            assert.deepEqual(JSON.parse(done!.params[1]), { dropped: 'not_implemented' });
            assert.deepEqual(unhandled().map((e) => [e.level, e.fields]), [['warn', { job_id: JOB, kind, creator_id: TENANT, phase: 'result' }]]);
            assert.equal(explainerWrites().length, 0);
        });

        it(`${kind}: a failed job is failed, logged, and leaves every explainer table alone`, async () => {
            lockReturns({ id: JOB, kind, status: 'claimed', payload: { explainer_id: EXPLAINER } });
            await failJob(TENANT, JOB, 'The Mac is offline.');
            assert.deepEqual(ran(/^UPDATE studio_jobs SET status = 'failed'/)[0]!.params, [JOB, 'The Mac is offline.']);
            assert.deepEqual(unhandled().map((e) => e.fields.phase), ['failure']);
            assert.equal(explainerWrites().length, 0);
        });
    }

    it('a job that went quiet a third time is failed through the same door', async () => {
        routes.push([/SET status = 'failed', error = \$4/, () => ({
            rows: [{ id: JOB, creator_id: TENANT, kind: 'explainer_draw', status: 'failed', payload: { explainer_id: EXPLAINER } }],
        })]);
        await claimJob(TENANT);
        assert.deepEqual(unhandled().map((e) => [e.fields.kind, e.fields.phase]), [['explainer_draw', 'failure']]);
        assert.equal(explainerWrites().length, 0);
    });

    it('a kind it does not know is still refused: the explainer branch is not a catch-all', async () => {
        lockReturns({ id: JOB, kind: 'explainer_dance', status: 'claimed', payload: {} });
        await assert.rejects(completeJob(TENANT, JOB, {}), isStudioError(409));
        assert.equal(unhandled().length, 0);
    });
});
