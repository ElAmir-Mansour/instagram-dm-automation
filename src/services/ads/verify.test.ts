/**
 * Never create twice (tasks T046; research R6; contracts/meta-graph.md "Verify a create"). A create that timed out may have landed, so it is
 * searched for by the tag in its name (`AR·<op id>`) before anything is sent again. Not found twice, 60 s apart, resends exactly once with
 * the same tag; a second silence after that fails the op. A blind resend is never made.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { AdsGraphError } from './graph.js';
import { execute, nextVerifyStep, verify, type GraphDeps, type Op, type RunOpts } from './ops.js';
import { installFakeDb, type AdsFakeDb } from './testing/testDb.js';

const T0 = new Date('2026-10-22T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const SEC = 1000;
const HOUR = 3_600_000;
const TOKEN = 'EAAB-verify-test-token';
const OBJ = '7b1c0e52-3f0e-4d7e-9d4e-0a1b2c3d4e5f';

function create(over: Partial<Op> = {}): Op {
    return {
        id: 'op-77', creatorId: 'creator-1', adAccountId: 'act_111', objectKey: OBJ, kind: 'create',
        payload: { exec: { method: 'POST', path: 'act_111/campaigns', edge: 'campaigns', params: { name: 'Eid sale' } } },
        idempotencyKey: null, dependsOn: null, state: 'verify', notBefore: T0, attempts: 1, result: { verifyChecks: [] }, actor: { userId: 'user-1', via: 'owner' },
        proposalId: null, createdAt: at(-60 * SEC), startedAt: at(-30 * SEC), finishedAt: null, ...over,
    };
}

const timeout = () => new AdsGraphError('timed out', { code: 'ECONNABORTED' }, 'other', null, null, null);

// ─── Pure: the verify state machine ─────────────────────────────────────────────────────────

describe('nextVerifyStep for a create', () => {
    it('found: done, the id adopted', () => {
        const step = nextVerifyStep(create(), '12345', T0);
        assert.equal(step.state, 'done');
        assert.equal(step.result?.['id'], '12345');
    });

    it('the first not-found stays in verify and checks again in 60 s, with the check recorded', () => {
        const step = nextVerifyStep(create(), null, T0);
        assert.equal(step.state, 'verify');
        assert.equal(step.notBefore?.toISOString(), at(60 * SEC).toISOString());
        assert.deepEqual(step.result?.['verifyChecks'], [T0.toISOString()]);
    });

    it('a second look under 60 s after the first is not a second check', () => {
        const first = nextVerifyStep(create(), null, T0);
        const early = nextVerifyStep(create({ result: first.result }), null, at(30 * SEC));
        assert.equal(early.state, 'verify');
        assert.deepEqual(early.result?.['verifyChecks'], [T0.toISOString()], 'still one check');
        assert.equal(early.notBefore?.toISOString(), at(60 * SEC).toISOString());
    });

    it('not found twice, 60 s apart: pending again with resent=true (to be sent once more, with the same tag)', () => {
        const first = nextVerifyStep(create(), null, T0);
        const second = nextVerifyStep(create({ result: first.result }), null, at(61 * SEC));
        assert.equal(second.state, 'pending');
        assert.equal(second.result?.['resent'], true);
        assert.deepEqual(second.result?.['verifyChecks'], [], 'the checks start again for the resend');
    });

    it('after the one resend, nothing found twice fails the op, and never resends again', () => {
        const resent = create({ result: { resent: true, verifyChecks: [] } });
        const first = nextVerifyStep(resent, null, T0);
        assert.equal(first.state, 'verify');
        const second = nextVerifyStep(create({ result: first.result }), null, at(61 * SEC));
        assert.equal(second.state, 'failed');
        assert.equal(second.result?.['resent'], true);
        assert.ok(second.result?.['code']);
    });

    it('found after the resend is still adopted', () => {
        const step = nextVerifyStep(create({ result: { resent: true, verifyChecks: [T0.toISOString()] } }), '999', at(70 * SEC));
        assert.equal(step.state, 'done');
        assert.equal(step.result?.['id'], '999');
    });

    it('over the whole life of one create, "pending" (a send) is chosen exactly once', () => {
        let state: Op = create();
        let sends = 0;
        let now = 0;
        // Six checks, 61 s apart, and the object never shows up.
        for (let i = 0; i < 6 && state.state === 'verify'; i++) {
            now += 61 * SEC;
            const step = nextVerifyStep(state, null, at(now));
            if (step.state === 'pending') {
                sends++;
                // The resend times out again and goes back to verify, as outcomeFor does.
                state = create({ result: { resent: true, verifyChecks: [] } });
            } else {
                state = create({ state: step.state, result: step.result });
            }
        }
        assert.equal(sends, 1);
        assert.equal(state.state, 'failed');
    });
});

describe('nextVerifyStep for an ordinary write read back', () => {
    const status = (over: Partial<Op> = {}) => create({ kind: 'status', payload: { exec: { method: 'POST', path: '555', params: { status: 'PAUSED' } } }, result: null, ...over });

    it('a match is done', () => {
        assert.equal(nextVerifyStep(status(), true, T0).state, 'done');
    });

    it('a mismatch is sent once more (pending, resent), and a second mismatch fails it', () => {
        const first = nextVerifyStep(status(), false, T0);
        assert.equal(first.state, 'pending');
        assert.equal(first.result?.['resent'], true);
        const second = nextVerifyStep(status({ result: first.result }), false, at(HOUR));
        assert.equal(second.state, 'failed');
    });
});

describe('nextVerifyStep for an op written by the synchronous path (no payload.exec)', () => {
    const sync = (over: Partial<Op> = {}) => create({ kind: 'status', payload: { worst_case_delta: 40 }, result: null, ...over });

    it('is never executed or resolved by the drain: it stays in verify until 24 hours old', () => {
        const step = nextVerifyStep(sync({ startedAt: at(-23 * HOUR) }), null, T0);
        assert.equal(step.state, 'verify');
    });

    it('then fails with reason abandoned', () => {
        const step = nextVerifyStep(sync({ startedAt: at(-24 * HOUR) }), null, T0);
        assert.equal(step.state, 'failed');
        assert.equal(step.result?.['reason'], 'abandoned');
    });
});

// ─── The Graph read and the recording, on the fake pool ─────────────────────────────────────

let db: AdsFakeDb;
let restoreLog: ReturnType<typeof setLogSink>;

beforeEach(() => {
    db = installFakeDb();
    restoreLog = setLogSink(() => undefined);
});
afterEach(() => {
    db.restore();
    setLogSink(restoreLog);
});

interface Call { method: string; path: string; params?: Record<string, any>; opts: Record<string, any> }
/** A Graph stub: `reads` answers GETs in order (a function or a value), `post` answers POSTs. */
function graph(script: { reads?: Array<unknown | (() => unknown)>; post?: () => unknown } = {}) {
    const calls: Call[] = [];
    const reads = [...(script.reads ?? [])];
    const answer = async (c: Call, f: () => unknown) => { calls.push(c); db.mark('graph'); return { data: await f() }; };
    const deps: GraphDeps = {
        get: (path, params, _token, opts) => answer({ method: 'GET', path, params, opts }, () => { const r = reads.shift(); return typeof r === 'function' ? (r as () => unknown)() : r ?? { data: [] }; }),
        post: (path, params, _token, opts) => answer({ method: 'POST', path, params: params as any, opts }, script.post ?? (() => ({ id: '555' }))),
        del: (path, _token, opts) => answer({ method: 'DELETE', path, opts }, () => ({ success: true })),
        checkTarget: async () => {},
    };
    return { calls, deps };
}
const env = (deps: GraphDeps, now: Date): RunOpts => ({ graph: deps, now: () => now, loadToken: async () => TOKEN, blockedUntil: async () => null });
const recorded = () => db.ran(/^UPDATE ads_ops SET state = \$2/).map((s) => ({ state: s.params[1] as string, notBefore: s.params[2] as Date | null, result: s.params[3] ? JSON.parse(s.params[3]) : null, expected: s.params[5] as string }));

describe('verify: the tag search', () => {
    it('searches the parent edge for the tag, asks only for ids, and adopts the id it finds', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, (p) => ({ rows: [{ id: p[0] }] }));
        const g = graph({ reads: [{ data: [{ id: '12345' }] }] });
        const out = await verify(create(), TOKEN, env(g.deps, T0));
        assert.equal(out.state, 'done');
        assert.equal(g.calls.length, 1);
        assert.equal(g.calls[0]!.method, 'GET');
        assert.equal(g.calls[0]!.path, 'act_111/campaigns');
        assert.equal(g.calls[0]!.params?.['fields'], 'id');
        assert.deepEqual(JSON.parse(g.calls[0]!.params?.['filtering']), [{ field: 'name', operator: 'CONTAIN', value: 'AR·op-77' }]);
        assert.equal(g.calls[0]!.opts['creatorId'], 'creator-1');
        const [r] = recorded();
        assert.equal(r!.state, 'done');
        assert.equal(r!.expected, 'verify');
        assert.equal(r!.result.id, '12345');
        const adopt = db.ran(/^UPDATE ads_objects SET meta_id = \$3/)[0]!;
        assert.deepEqual(adopt.params, [OBJ, 'creator-1', '12345']);
        assert.equal(db.markedInsideTransaction('graph'), false);
        assert.equal(db.ran(/^INSERT INTO audit_log/)[0]!.params[2], 'ads.op_applied');
    });

    it('not found the first time: stays in verify, due again in 60 s, and sends nothing', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, (p) => ({ rows: [{ id: p[0] }] }));
        const g = graph({ reads: [{ data: [] }] });
        const out = await verify(create(), TOKEN, env(g.deps, T0));
        assert.equal(out.state, 'verify');
        assert.equal(g.calls.filter((c) => c.method !== 'GET').length, 0, 'a blind resend is never made');
        const [r] = recorded();
        assert.equal(r!.state, 'verify');
        assert.equal(r!.notBefore?.toISOString(), at(60 * SEC).toISOString());
        assert.deepEqual(r!.result.verifyChecks, [T0.toISOString()]);
    });

    it('not found the second time, 60 s later: pending with resent=true, and still no send from verify', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, (p) => ({ rows: [{ id: p[0] }] }));
        const g = graph({ reads: [{ data: [] }] });
        const out = await verify(create({ result: { verifyChecks: [T0.toISOString()] } }), TOKEN, env(g.deps, at(61 * SEC)));
        assert.equal(out.state, 'pending');
        assert.equal(recorded()[0]!.result.resent, true);
        assert.equal(g.calls.filter((c) => c.method !== 'GET').length, 0);
    });

    it('a throttled or failing read keeps the op in verify without counting a check', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, (p) => ({ rows: [{ id: p[0] }] }));
        const retryAt = at(5 * 60 * SEC);
        const throttled = graph({ reads: [() => { throw new AdsGraphError('slow down', null, 'throttle', retryAt, null, null); }] });
        const out = await verify(create(), TOKEN, env(throttled.deps, T0));
        assert.equal(out.state, 'verify');
        assert.equal(out.notBefore?.toISOString(), retryAt.toISOString());
        assert.deepEqual(out.result?.['verifyChecks'], []);
        const broken = graph({ reads: [() => { throw timeout(); }] });
        const out2 = await verify(create(), TOKEN, env(broken.deps, T0));
        assert.equal(out2.state, 'verify');
        assert.deepEqual(out2.result?.['verifyChecks'], []);
        assert.equal(out2.notBefore?.toISOString(), at(60 * SEC).toISOString());
    });

    it('a dead token fails the op and stops the loop', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, (p) => ({ rows: [{ id: p[0] }] }));
        const g = graph({ reads: [() => { throw new AdsGraphError('bad token', { response: { status: 400, data: { error: { code: 190, message: 'x' } } } }, 'token_dead', null, null, 400); }] });
        const out = await verify(create(), TOKEN, env(g.deps, T0));
        assert.equal(out.state, 'failed');
        assert.equal(out.stop, 'token_dead');
    });
});

describe('verify: an ordinary write is read back', () => {
    const status = () => create({ kind: 'status', payload: { exec: { method: 'POST', path: '555', params: { status: 'PAUSED' } } }, result: null });

    it('reads the object and marks the op done when it matches what was meant', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, (p) => ({ rows: [{ id: p[0] }] }));
        const g = graph({ reads: [{ status: 'PAUSED', daily_budget: '5000' }] });
        const out = await verify(status(), TOKEN, env(g.deps, T0));
        assert.equal(out.state, 'done');
        assert.equal(g.calls[0]!.path, '555');
        assert.equal(g.calls[0]!.params?.['fields'], 'status,daily_budget,lifetime_budget,end_time');
        assert.equal(db.ran(/^UPDATE ads_objects SET status = \$3/)[0]!.params[2], 'PAUSED');
    });

    it('a mismatch sends it once more (pending, resent) and the second mismatch fails it', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, (p) => ({ rows: [{ id: p[0] }] }));
        const g = graph({ reads: [{ status: 'ACTIVE' }, { status: 'ACTIVE' }] });
        const first = await verify(status(), TOKEN, env(g.deps, T0));
        assert.equal(first.state, 'pending');
        const second = await verify({ ...status(), result: first.result }, TOKEN, env(g.deps, at(HOUR)));
        assert.equal(second.state, 'failed');
    });

    it('compares budgets as text (Meta answers minor units as strings) and an end time as an instant', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, (p) => ({ rows: [{ id: p[0] }] }));
        const budget = create({ kind: 'budget', payload: { exec: { method: 'POST', path: '555', params: { daily_budget: 5000, end_time: '2026-11-01T00:00:00+0000' } } }, result: null });
        const g = graph({ reads: [{ daily_budget: '5000', end_time: '2026-11-01T00:00:00+0000' }] });
        assert.equal((await verify(budget, TOKEN, env(g.deps, T0))).state, 'done');
    });

    it('a delete is done when Meta no longer knows the object (code 100)', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, (p) => ({ rows: [{ id: p[0] }] }));
        const del = create({ kind: 'delete', payload: { exec: { method: 'DELETE', path: '555' } }, result: null });
        const gone = new AdsGraphError('does not exist', { response: { status: 400, data: { error: { code: 100, error_subcode: 33, message: 'gone' } } } }, 'other', null, null, 400);
        const g = graph({ reads: [() => { throw gone; }] });
        assert.equal((await verify(del, TOKEN, env(g.deps, T0))).state, 'done');
    });
});

describe('verify: an op without payload.exec is never touched on Meta', () => {
    it('makes no Graph call; abandoned after 24 hours', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, (p) => ({ rows: [{ id: p[0] }] }));
        const g = graph();
        const old = create({ kind: 'status', payload: { worst_case_delta: 40 }, result: null, startedAt: at(-25 * HOUR) });
        const out = await verify(old, TOKEN, env(g.deps, T0));
        assert.equal(out.state, 'failed');
        assert.equal(out.result?.['reason'], 'abandoned');
        assert.equal(g.calls.length, 0);
    });
});

describe('the whole life of a create that times out', () => {
    /** A one-row store: the recorded outcome becomes the op's next state, as the database would have it. */
    function store(initial: Op) {
        const box = { op: initial };
        db.on(/^UPDATE ads_ops SET state = \$2/, (p) => {
            box.op = { ...box.op, state: p[1], notBefore: p[2] ? new Date(p[2]) : box.op.notBefore, result: p[3] ? JSON.parse(p[3]) : null, finishedAt: p[4] };
            return { rows: [{ id: p[0] }] };
        });
        return box;
    }
    const pending = () => create({ state: 'running', result: null, attempts: 1 });

    it('timeout, then the search finds it: one POST in all, the id adopted', async () => {
        const box = store(pending());
        const g = graph({ post: () => { throw timeout(); }, reads: [{ data: [{ id: '777' }] }] });
        await execute(box.op, TOKEN, env(g.deps, T0));
        assert.equal(box.op.state, 'verify');
        await verify(box.op, TOKEN, env(g.deps, at(5 * SEC)));
        assert.equal(box.op.state, 'done');
        assert.equal(box.op.result?.['id'], '777');
        assert.equal(g.calls.filter((c) => c.method === 'POST').length, 1);
    });

    it('timeout, nothing found twice 60 s apart: sent exactly once more with the SAME tag, then done', async () => {
        const box = store(pending());
        let posts = 0;
        const g = graph({ post: () => { posts++; if (posts === 1) throw timeout(); return { id: '888' }; }, reads: [{ data: [] }, { data: [] }] });
        await execute(box.op, TOKEN, env(g.deps, T0));
        assert.equal(box.op.state, 'verify');
        await verify(box.op, TOKEN, env(g.deps, at(1 * SEC)));
        assert.equal(box.op.state, 'verify', 'the first not-found does not resend');
        assert.equal(posts, 1);
        await verify(box.op, TOKEN, env(g.deps, at(62 * SEC)));
        assert.equal(box.op.state, 'pending', 'the second not-found, 60 s later, queues one resend');
        assert.equal(posts, 1, 'verify itself never sends');
        await execute({ ...box.op, state: 'running' }, TOKEN, env(g.deps, at(63 * SEC)));
        assert.equal(posts, 2);
        assert.equal(box.op.state, 'done');
        const posted = g.calls.filter((c) => c.method === 'POST').map((c) => c.params?.['name']);
        assert.deepEqual(posted, ['Eid sale AR·op-77', 'Eid sale AR·op-77']);
    });

    it('timeout, the resend times out too, and nothing is found twice more: failed, two sends and no third', async () => {
        const box = store(pending());
        const g = graph({ post: () => { throw timeout(); }, reads: [{ data: [] }, { data: [] }, { data: [] }, { data: [] }] });
        await execute(box.op, TOKEN, env(g.deps, T0));
        await verify(box.op, TOKEN, env(g.deps, at(1 * SEC)));
        await verify(box.op, TOKEN, env(g.deps, at(62 * SEC)));
        assert.equal(box.op.state, 'pending');
        await execute({ ...box.op, state: 'running' }, TOKEN, env(g.deps, at(63 * SEC)));
        assert.equal(box.op.state, 'verify');
        await verify(box.op, TOKEN, env(g.deps, at(64 * SEC)));
        assert.equal(box.op.state, 'verify');
        await verify(box.op, TOKEN, env(g.deps, at(125 * SEC)));
        assert.equal(box.op.state, 'failed');
        assert.equal(g.calls.filter((c) => c.method === 'POST').length, 2, 'the original and exactly one resend');
    });
});
