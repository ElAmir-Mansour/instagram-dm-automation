/**
 * The paced write queue (tasks T045; research R3; data-model `ads_ops`). The limits and the state machine are pure functions and are tested
 * directly; the SQL shape and the transaction boundaries are tested against the fake pool of ./testDb.ts, which records every statement in
 * order. The structural promise is that no Graph call runs between BEGIN and COMMIT, so the stubbed Graph functions leave a marker in
 * the same ordered list.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { setWaitUntil } from '../../utils/waitUntil.js';
import { AdsGraphError } from './graph.js';
import {
    claimNext, drainAdsOps, editsLeftThisHour, enqueue, enqueueAndTryInline, execute, fillPlaceholders, getOp, limitWaitUntil, listOps, nextMidnightIn, outcomeFor, placeholderOps,
    reap, runOpInline, sendExec, type DoneRecord, type GraphDeps, type Op, type RunOpts,
} from './ops.js';
import { installFakeDb, type AdsFakeDb } from './testing/testDb.js';

const T0 = new Date('2026-10-22T10:00:00Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const TOKEN = 'EAAB-this-token-must-never-be-stored';
const CAMPAIGN_UUID = '7b1c0e52-3f0e-4d7e-9d4e-0a1b2c3d4e5f';

function op(over: Partial<Op> = {}): Op {
    return {
        id: 'op-1', creatorId: 'creator-1', adAccountId: 'act_111', objectKey: CAMPAIGN_UUID, kind: 'status',
        payload: { exec: { method: 'POST', path: '555', params: { status: 'PAUSED' } } }, idempotencyKey: null, dependsOn: null, state: 'running',
        notBefore: T0, attempts: 1, result: null, actor: { userId: 'user-1', via: 'owner' }, proposalId: null, createdAt: at(-MIN), startedAt: T0, finishedAt: null,
        ...over,
    };
}

/** A row as Postgres returns it. */
function row(over: Record<string, unknown> = {}) {
    return {
        id: 'op-1', creator_id: 'creator-1', ad_account_id: 'act_111', object_key: CAMPAIGN_UUID, kind: 'status',
        payload: { exec: { method: 'POST', path: '555', params: { status: 'PAUSED' } } }, idempotency_key: 'k:1', depends_on: null, state: 'pending',
        not_before: at(-SEC), attempts: 0, result: null, actor: { userId: 'user-1', via: 'owner' }, proposal_id: null, created_at: at(-MIN),
        started_at: null, finished_at: null, dep_state: null, ...over,
    };
}

const done = (kind: string, objectKey: string, agoMs: number, adsetKey: string | null = null): DoneRecord => ({ kind, objectKey, adsetKey, finishedAt: at(-agoMs) });

/** A Graph error as graph.ts raises it. */
function graphError(klass: AdsGraphError['klass'], over: { code?: number; subcode?: number; status?: number | null; retryAt?: Date | null; message?: string } = {}) {
    const source = over.code === undefined ? { code: 'ECONNABORTED' } : { response: { status: over.status ?? 400, data: { error: { code: over.code, error_subcode: over.subcode, message: over.message ?? 'meta says no', fbtrace_id: 'TRACE1' } } } };
    return new AdsGraphError(over.message ?? 'meta says no', source, klass, over.retryAt ?? null, over.code === undefined ? null : 'TRACE1', over.status === undefined ? (over.code === undefined ? null : 400) : over.status);
}

// ─── Pure: the per-object limits ────────────────────────────────────────────────────────────

describe('limitWaitUntil: budget edits per ad set per rolling hour', () => {
    const budgetOp = (adset = 'adset-1') => op({ kind: 'budget', objectKey: 'obj-b', payload: { adsetMetaId: adset, exec: { method: 'POST', path: adset, params: { daily_budget: 5000 } } } });

    it('lets a fifth edit wait until the oldest of the last four is an hour old', () => {
        const history = [done('budget', 'obj-b', 50 * MIN, 'adset-1'), done('budget', 'obj-b', 40 * MIN, 'adset-1'), done('budget', 'obj-b', 30 * MIN, 'adset-1'), done('budget', 'obj-b', 5 * MIN, 'adset-1')];
        assert.equal(limitWaitUntil(budgetOp(), history, T0)?.toISOString(), at(10 * MIN).toISOString());
    });

    it('allows the fourth edit and not the fifth', () => {
        const three = [done('budget', 'obj-b', 50 * MIN, 'adset-1'), done('budget', 'obj-b', 40 * MIN, 'adset-1'), done('budget', 'obj-b', 31 * MIN, 'adset-1')];
        assert.equal(limitWaitUntil(budgetOp(), three, T0), null);
        assert.notEqual(limitWaitUntil(budgetOp(), [...three, done('budget', 'obj-b', 31 * SEC, 'adset-1')].slice(0, 4).concat([]), T0), null, 'four done in the hour: the next waits');
    });

    it('does not count an edit that is more than an hour old, nor another ad set, nor a status write', () => {
        const history = [done('budget', 'obj-b', 61 * MIN, 'adset-1'), done('budget', 'obj-b', 40 * MIN, 'adset-1'), done('budget', 'obj-b', 31 * MIN, 'adset-1'), done('budget', 'obj-b', 32 * MIN, 'adset-1')];
        assert.equal(limitWaitUntil(budgetOp(), history, T0), null, 'only three are inside the hour');
        const others = [1, 2, 3, 4].map((i) => done('budget', `other-${i}`, i * 5 * MIN, 'adset-2'));
        assert.equal(limitWaitUntil(budgetOp('adset-1'), others, T0), null);
        const statuses = [1, 2, 3, 4].map((i) => done('status', 'obj-b', (i + 1) * 5 * MIN, 'adset-1'));
        assert.equal(limitWaitUntil(budgetOp(), statuses, T0), null);
    });

    it('falls back to the object key when the payload names no ad set', () => {
        const bare = op({ kind: 'budget', objectKey: 'obj-z', payload: { exec: { method: 'POST', path: 'z', params: { daily_budget: 1 } } } });
        const history = [10, 20, 30, 40].map((m) => done('budget', 'obj-z', m * MIN));
        assert.equal(limitWaitUntil(bare, history, T0)?.toISOString(), at(20 * MIN).toISOString());
    });

    it('with more than four in the hour, waits until enough of them have aged out', () => {
        const five = [55, 45, 35, 25, 15].map((m) => done('budget', 'obj-b', m * MIN, 'adset-1'));
        // sorted oldest first: the second oldest (45 min ago) must expire: 15 min from now.
        assert.equal(limitWaitUntil(budgetOp(), five, T0)?.toISOString(), at(15 * MIN).toISOString());
    });
});

describe('limitWaitUntil: 30 seconds between edits of one object', () => {
    it('waits out the rest of the 30 s after the last done op on the same object', () => {
        assert.equal(limitWaitUntil(op(), [done('status', CAMPAIGN_UUID, 10 * SEC)], T0)?.toISOString(), at(20 * SEC).toISOString());
    });

    it('is free at 30 s, and another object is never affected', () => {
        assert.equal(limitWaitUntil(op(), [done('status', CAMPAIGN_UUID, 30 * SEC)], T0), null);
        assert.equal(limitWaitUntil(op(), [done('status', 'someone-else', 1 * SEC)], T0), null);
    });

    it('takes the longer of the two waits when both apply', () => {
        const budgetOp = op({ kind: 'budget', objectKey: 'obj-b', payload: { adsetMetaId: 'a1', exec: { method: 'POST', path: 'a1', params: { daily_budget: 1 } } } });
        const history = [done('budget', 'obj-b', 50 * MIN, 'a1'), done('budget', 'obj-b', 40 * MIN, 'a1'), done('budget', 'obj-b', 30 * MIN, 'a1'), done('budget', 'obj-b', 20 * MIN, 'a1')];
        assert.equal(limitWaitUntil(budgetOp, history, T0)?.toISOString(), at(10 * MIN).toISOString(), 'the hour rule is later than the 30 s one');
    });
});

describe('limitWaitUntil: 10 spend-cap changes per account per calendar day', () => {
    const capOp = (tz?: string) => op({ kind: 'spend_cap', objectKey: 'account', payload: { ...(tz ? { tz } : {}), exec: { method: 'POST', path: 'act_111', params: { spend_cap: 1000 } } } });
    const tenToday = Array.from({ length: 10 }, (_, i) => done('spend_cap', 'account', (i + 1) * 10 * MIN));

    it('waits until the next midnight, UTC by default', () => {
        assert.equal(limitWaitUntil(capOp(), tenToday, T0)?.toISOString(), '2026-10-23T00:00:00.000Z');
    });

    it('allows the tenth and not the eleventh', () => {
        assert.equal(limitWaitUntil(capOp(), tenToday.slice(0, 9), T0), null);
    });

    it("counts the account's own calendar day: yesterday's changes do not count", () => {
        const yesterday = Array.from({ length: 10 }, (_, i) => done('spend_cap', 'account', 11 * HOUR + i * MIN));
        assert.equal(limitWaitUntil(capOp(), yesterday, T0), null, '2026-10-21 in UTC');
    });

    it('uses the time zone of the payload for the day boundary', () => {
        // 10:00Z is 13:00 in Riyadh; those ten ran 8 to 9 hours ago = 01:00 to 02:00 local, the same Riyadh day.
        const sameRiyadhDay = Array.from({ length: 10 }, (_, i) => done('spend_cap', 'account', 8 * HOUR + i * MIN));
        assert.equal(limitWaitUntil(capOp('Asia/Baghdad'), sameRiyadhDay, T0)?.toISOString(), '2026-10-22T21:00:00.000Z');
        // At 22:30Z (01:30 on the 23rd in Riyadh) the same ten belong to yesterday there.
        assert.equal(limitWaitUntil(capOp('Asia/Baghdad'), sameRiyadhDay, at(12.5 * HOUR)), null);
    });

    it('treats an unknown zone as UTC', () => {
        assert.equal(limitWaitUntil(capOp('Not/AZone'), tenToday, T0)?.toISOString(), '2026-10-23T00:00:00.000Z');
    });

    it('nextMidnightIn is the start of the account\'s next day', () => {
        assert.equal(nextMidnightIn('Asia/Baghdad', T0).toISOString(), '2026-10-22T21:00:00.000Z');
        assert.equal(nextMidnightIn('UTC', T0).toISOString(), '2026-10-23T00:00:00.000Z');
        assert.equal(nextMidnightIn('America/Los_Angeles', T0).toISOString(), '2026-10-23T07:00:00.000Z');
    });
});

// ─── Pure: the outcome of one Graph call ────────────────────────────────────────────────────

describe('outcomeFor', () => {
    it('success: done, with the id and Meta\'s answer', () => {
        const out = outcomeFor(op(), { ok: true, data: { id: '123', success: true } }, T0);
        assert.equal(out.state, 'done');
        assert.deepEqual(out.result, { id: '123', success: true });
    });

    it('throttle: back to pending at the time Meta named, never a retry loop', () => {
        const retryAt = at(5 * MIN);
        const out = outcomeFor(op(), { ok: false, error: graphError('throttle', { code: 17, subcode: 2446079, retryAt }) }, T0);
        assert.equal(out.state, 'pending');
        assert.equal(out.notBefore?.toISOString(), retryAt.toISOString());
    });

    it('a throttle with no time uses the pacer\'s default 300 s', () => {
        const out = outcomeFor(op(), { ok: false, error: graphError('throttle', { code: 4 }) }, T0);
        assert.equal(out.notBefore?.toISOString(), at(300 * SEC).toISOString());
    });

    it('budget_limit waits an hour; object_busy 30 s', () => {
        assert.equal(outcomeFor(op(), { ok: false, error: graphError('budget_limit', { code: 613, subcode: 1487632 }) }, T0).notBefore?.toISOString(), at(HOUR).toISOString());
        const busy = outcomeFor(op(), { ok: false, error: graphError('object_busy', { code: 613, subcode: 4841018 }) }, T0);
        assert.equal(busy.state, 'pending');
        assert.equal(busy.notBefore?.toISOString(), at(30 * SEC).toISOString());
    });

    it('spend_cap_limit: failed EDIT_LIMIT with the next midnight in the account\'s zone', () => {
        const cap = op({ kind: 'spend_cap', objectKey: 'account', payload: { tz: 'Asia/Baghdad', exec: { method: 'POST', path: 'act_111', params: { spend_cap: 1 } } } });
        const out = outcomeFor(cap, { ok: false, error: graphError('spend_cap_limit', { code: 17, subcode: 1885172 }) }, T0);
        assert.equal(out.state, 'failed');
        assert.equal(out.result?.['code'], 'EDIT_LIMIT');
        assert.equal(out.result?.['retryAt'], '2026-10-22T21:00:00.000Z');
    });

    it('token_dead: failed TOKEN_INVALID and the loop stops', () => {
        const out = outcomeFor(op(), { ok: false, error: graphError('token_dead', { code: 190 }) }, T0);
        assert.equal(out.state, 'failed');
        assert.equal(out.result?.['code'], 'TOKEN_INVALID');
        assert.equal(out.stop, 'token_dead');
    });

    it('a create that timed out may have landed: verify, never failed and never resent', () => {
        const create = op({ kind: 'create', payload: { exec: { method: 'POST', path: 'act_111/campaigns', edge: 'campaigns', params: { name: 'x' } } } });
        const out = outcomeFor(create, { ok: false, error: graphError('other') }, T0);
        assert.equal(out.state, 'verify');
        assert.deepEqual(out.result?.['verifyChecks'], []);
    });

    it('a 5xx on a create also goes to verify; a 400 fails it', () => {
        const create = op({ kind: 'create', payload: { exec: { method: 'POST', path: 'act_111/campaigns', edge: 'campaigns', params: { name: 'x' } } } });
        assert.equal(outcomeFor(create, { ok: false, error: graphError('other', { code: 2, status: 503 }) }, T0).state, 'verify');
        assert.equal(outcomeFor(create, { ok: false, error: graphError('other', { code: 100, subcode: 33, status: 400 }) }, T0).state, 'failed');
    });

    it('a timeout on an ordinary write (a status change) may also have landed: verify reads it back', () => {
        assert.equal(outcomeFor(op(), { ok: false, error: graphError('other') }, T0).state, 'verify');
    });

    it('any other error fails with Meta\'s code, subcode, message and trace id and nothing else', () => {
        const out = outcomeFor(op(), { ok: false, error: graphError('other', { code: 100, subcode: 1885, message: 'Invalid parameter' }) }, T0);
        assert.equal(out.state, 'failed');
        assert.deepEqual(Object.keys(out.result ?? {}).sort(), ['code', 'fbtrace_id', 'message', 'subcode']);
        assert.equal(out.result?.['code'], 100);
        assert.equal(out.result?.['subcode'], 1885);
        assert.equal(out.result?.['fbtrace_id'], 'TRACE1');
    });

    it('keeps resent=true through a second timeout, so the next verify knows it was already resent', () => {
        const create = op({ kind: 'create', result: { resent: true, verifyChecks: ['2026-10-22T09:00:00.000Z'] }, payload: { exec: { method: 'POST', path: 'act_111/campaigns', edge: 'campaigns', params: { name: 'x' } } } });
        const out = outcomeFor(create, { ok: false, error: graphError('other') }, T0);
        assert.equal(out.state, 'verify');
        assert.equal(out.result?.['resent'], true);
        assert.deepEqual(out.result?.['verifyChecks'], []);
    });
});

// ─── The queue on the fake pool ─────────────────────────────────────────────────────────────

let db: AdsFakeDb;
let logged: string[];
let restoreLog: ReturnType<typeof setLogSink>;

beforeEach(() => {
    db = installFakeDb();
    logged = [];
    restoreLog = setLogSink((_level, line) => { logged.push(line); });
});
afterEach(() => {
    db.restore();
    setLogSink(restoreLog);
});

/** The two statements every recorded outcome needs an answer for. */
function answerFinishes() {
    db.on(/^UPDATE ads_ops SET state = \$2/, (p) => ({ rows: [{ id: p[0] }] }));
}

interface GraphCall { method: 'GET' | 'POST' | 'DELETE'; path: string; params?: Record<string, unknown>; token: string; opts: Record<string, any> }
function graphStub(impl: { get?: (c: GraphCall) => unknown; post?: (c: GraphCall) => unknown; del?: (c: GraphCall) => unknown } = {}) {
    const calls: GraphCall[] = [];
    const run = async (c: GraphCall, f?: (c: GraphCall) => unknown) => {
        calls.push(c);
        db.mark('graph');
        const out = f ? await f(c) : { id: '999' };
        return { data: out };
    };
    const graph: GraphDeps = {
        get: (path, params, token, opts) => run({ method: 'GET', path, params, token, opts }, impl.get),
        post: (path, params, token, opts) => run({ method: 'POST', path, params, token, opts }, impl.post),
        del: (path, token, opts) => run({ method: 'DELETE', path, token, opts }, impl.del),
    };
    return { calls, graph };
}

const stmts = (pattern: RegExp) => db.ran(pattern);
const auditRows = () => stmts(/^INSERT INTO audit_log/);
const auditAction = (s: { params: any[] }) => s.params[2];
const auditDetail = (s: { params: any[] }) => JSON.parse(s.params[5]);

describe('enqueue', () => {
    const input = {
        creatorId: 'creator-1', adAccountId: 'act_111', objectKey: CAMPAIGN_UUID, kind: 'status' as const,
        payload: { exec: { method: 'POST' as const, path: '555', params: { status: 'PAUSED' } } },
        idempotencyKey: 'action-9:1', actor: { userId: 'user-1', role: 'owner', via: 'owner' as const }, proposalId: null,
    };

    it('inserts with ON CONFLICT (idempotency_key) DO NOTHING and audits ads.op_enqueued with the actor', async () => {
        db.on(/^INSERT INTO ads_ops/, () => ({ rows: [row({ idempotency_key: 'action-9:1' })] }));
        const view = await enqueue(input);
        assert.equal(view.id, 'op-1');
        assert.equal(view.state, 'pending');
        assert.equal(view.actorVia, 'owner');
        const insert = stmts(/^INSERT INTO ads_ops/)[0]!;
        assert.match(insert.sql, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
        assert.equal(insert.params[5], 'action-9:1');
        assert.equal(JSON.parse(insert.params[8]).via, 'owner');
        const audit = auditRows();
        assert.equal(audit.length, 1);
        assert.equal(auditAction(audit[0]!), 'ads.op_enqueued');
        assert.equal(audit[0]!.params[0], 'user-1', 'the actor of the op');
        assert.equal(audit[0]!.params[3], 'ads_op');
        assert.equal(audit[0]!.params[4], 'op-1');
        assert.deepEqual(auditDetail(audit[0]!), { kind: 'status', object_key: CAMPAIGN_UUID, via: 'owner', creator_id: 'creator-1' });
        assert.ok(db.timeline().indexOf(insert.sql) < db.timeline().findIndex((s) => s.startsWith('INSERT INTO audit_log')), 'the audit row follows the op');
    });

    it('a reused idempotency key returns the existing op: no second row, no second audit', async () => {
        db.on(/^INSERT INTO ads_ops/, () => ({ rows: [] }));
        db.on(/^SELECT \* FROM ads_ops WHERE idempotency_key = \$1 AND creator_id = \$2/, () => ({ rows: [row({ id: 'op-existing', state: 'done', finished_at: T0 })] }));
        const view = await enqueue(input);
        assert.equal(view.id, 'op-existing');
        assert.equal(view.state, 'done');
        assert.equal(stmts(/^INSERT INTO ads_ops/).length, 1);
        assert.equal(auditRows().length, 0);
    });

    it("never hands one tenant another tenant's op when the keys collide: the lookup is scoped to the tenant and finds nothing", async () => {
        db.on(/^INSERT INTO ads_ops/, () => ({ rows: [] }));
        db.on(/^SELECT \* FROM ads_ops WHERE idempotency_key = \$1 AND creator_id = \$2/, () => ({ rows: [] }));
        await assert.rejects(() => enqueue(input), /idempotency key/i);
        assert.deepEqual(stmts(/idempotency_key = \$1 AND creator_id/)[0]!.params, ['action-9:1', 'creator-1']);
    });

    it("writes inside the caller's transaction when given its executor, and audits through it too (after the caller's lock, before its commit)", async () => {
        const seen: string[] = [];
        const exec = { query: async (sql: string) => { seen.push(sql.replace(/\s+/g, ' ').trim()); return /^INSERT INTO ads_ops/.test(seen[seen.length - 1]!) ? { rows: [row()], rowCount: 1 } : { rows: [{ id: 'a1' }], rowCount: 1 }; } };
        await enqueue(input, exec as any);
        assert.ok(seen.some((s) => s.startsWith('INSERT INTO ads_ops')));
        assert.ok(seen.some((s) => s.startsWith('INSERT INTO audit_log')));
        assert.equal(db.statements.length, 0, 'nothing went to the pool');
    });

    it('does not throw over a failing audit write', async () => {
        db.on(/^INSERT INTO ads_ops/, () => ({ rows: [row()] }));
        db.on(/^INSERT INTO audit_log/, () => { throw new Error('audit table gone'); });
        const view = await enqueue(input);
        assert.equal(view.id, 'op-1');
    });

    it('refuses a path that could leave the object (a query string, "..", a leading slash)', async () => {
        for (const path of ['555?access_token=x', '../me', '/555', '']) {
            await assert.rejects(() => enqueue({ ...input, payload: { exec: { method: 'POST', path, params: {} } } }), /path/i, path);
        }
    });
});

describe('getOp, listOps, editsLeftThisHour', () => {
    it('getOp is scoped to the tenant and a malformed id is no such op', async () => {
        db.on(/^SELECT \* FROM ads_ops WHERE id = \$1 AND creator_id = \$2/, () => ({ rows: [row({ id: CAMPAIGN_UUID })] }));
        assert.equal((await getOp('creator-1', CAMPAIGN_UUID))?.id, CAMPAIGN_UUID);
        assert.equal(await getOp('creator-1', 'not-a-uuid'), null);
        assert.equal(stmts(/^SELECT \* FROM ads_ops WHERE id/).length, 1);
    });

    it('listOps asks for the states, the tenant and a limit', async () => {
        db.on(/FROM ads_ops WHERE creator_id = \$1 AND state = ANY/, () => ({ rows: [row(), row({ id: 'op-2' })] }));
        const ops = await listOps('creator-1', ['pending', 'running'], 20);
        assert.equal(ops.length, 2);
        const q = stmts(/state = ANY/)[0]!;
        assert.deepEqual(q.params, ['creator-1', ['pending', 'running'], 20]);
    });

    it('editsLeftThisHour is 4 minus the budget ops done in the last hour, per ad set', async () => {
        db.on(/GROUP BY/, () => ({ rows: [{ k: 'adset-1', n: '3' }, { k: 'adset-2', n: '4' }] }));
        const left = await editsLeftThisHour('creator-1', ['adset-1', 'adset-2', 'adset-3']);
        assert.deepEqual([...left], [['adset-1', 1], ['adset-2', 0], ['adset-3', 4]]);
        const q = stmts(/GROUP BY/)[0]!;
        assert.match(q.sql, /kind = 'budget'/);
        assert.match(q.sql, /state = 'done'/);
    });

    it('editsLeftThisHour with no ad sets asks nothing', async () => {
        assert.equal((await editsLeftThisHour('creator-1', [])).size, 0);
        assert.equal(db.statements.length, 0);
    });
});

describe('claimNext', () => {
    /** Answers the candidate select, then the history, and the claim itself. */
    function candidates(...batches: Array<Array<Record<string, unknown>>>) {
        let call = 0;
        db.on(/FROM ads_ops p LEFT JOIN ads_ops d/, () => ({ rows: batches[Math.min(call++, batches.length - 1)] ?? [] }));
        db.on(/^UPDATE ads_ops SET state = 'running'/, (p) => {
            const pick = batches.flat().find((r) => r['id'] === p[0])!;
            return { rows: [{ ...pick, state: 'running', attempts: Number(pick['attempts']) + 1, started_at: p[1] }] };
        });
    }
    const history = (...rows: Array<{ kind: string; object_key: string; adset_key?: string | null; agoMs: number }>) =>
        db.on(/AS adset_key/, () => ({ rows: rows.map((r) => ({ kind: r.kind, object_key: r.object_key, adset_key: r.adset_key ?? null, finished_at: at(-r.agoMs) })) }));

    it('claims the oldest due op in one short transaction: pending to running, started_at and attempts + 1', async () => {
        history();
        candidates([row({ id: 'op-a' }), row({ id: 'op-b', object_key: 'other' })]);
        const claimed = await claimNext('act_111', T0, { creatorId: 'creator-1' });
        assert.equal(claimed?.id, 'op-a');
        assert.equal(claimed?.state, 'running');
        assert.equal(claimed?.attempts, 1);
        const tl = db.timeline();
        assert.equal(tl[0], 'BEGIN');
        assert.equal(tl[tl.length - 1], 'COMMIT');
        assert.equal(tl.filter((s) => s === 'BEGIN').length, 1, 'one transaction');
        const up = stmts(/^UPDATE ads_ops SET state = 'running'/)[0]!;
        assert.match(up.sql, /started_at = \$2/);
        assert.match(up.sql, /attempts = attempts \+ 1/);
        assert.match(up.sql, /WHERE id = \$1 AND creator_id = \$3 AND state = 'pending'/, 'the update re-checks the tenant and the state');
        assert.deepEqual(up.params, ['op-a', T0, 'creator-1']);
    });

    it('the select is the claim: oldest first, FOR UPDATE SKIP LOCKED, due, with an exec, one op at a time per object and in order per object', async () => {
        history();
        candidates([]);
        assert.equal(await claimNext('act_111', T0, { creatorId: 'creator-1' }), null);
        const select = stmts(/FROM ads_ops p LEFT JOIN ads_ops d/)[0]!;
        assert.match(select.sql, /p\.state = 'pending'/);
        assert.match(select.sql, /p\.not_before <= \$2/);
        assert.match(select.sql, /p\.payload \? 'exec'/, 'an op written by the synchronous path is never executed by the drain');
        assert.match(select.sql, /NOT EXISTS \(SELECT 1 FROM ads_ops r WHERE r\.creator_id = p\.creator_id AND r\.ad_account_id = p\.ad_account_id AND r\.object_key = p\.object_key AND r\.state IN \('running', 'verify'\)\)/);
        assert.match(select.sql, /NOT EXISTS \(SELECT 1 FROM ads_ops e WHERE e\.creator_id = p\.creator_id AND .*e\.state = 'pending' AND \(e\.created_at, e\.id\) < \(p\.created_at, p\.id\)\)/, 'an older pending op on the same object goes first');
        assert.match(select.sql, /ORDER BY p\.created_at, p\.id/);
        assert.match(select.sql, /FOR UPDATE OF p SKIP LOCKED/);
        assert.deepEqual(select.params.slice(0, 2), ['act_111', T0]);
        assert.match(select.sql, /p\.creator_id = \$4/, 'scoped to the tenant when the caller names it');
    });

    it('an op whose dependency is done is claimed; one whose dependency is still pending is skipped, and so is a later op on its object', async () => {
        history();
        candidates([
            row({ id: 'op-child', depends_on: 'op-parent', dep_state: 'pending', object_key: 'k1' }),
            row({ id: 'op-later-same-object', object_key: 'k1' }),
            row({ id: 'op-ready', depends_on: 'op-done', dep_state: 'done', object_key: 'k2' }),
        ]);
        assert.equal((await claimNext('act_111', T0, { creatorId: 'creator-1' }))?.id, 'op-ready');
    });

    it('an op whose dependency failed or was cancelled becomes cancelled, and the next claimable one is taken', async () => {
        history();
        candidates([
            row({ id: 'op-orphan', depends_on: 'op-parent', dep_state: 'failed', object_key: 'k1' }),
            row({ id: 'op-ok', object_key: 'k2' }),
        ]);
        assert.equal((await claimNext('act_111', T0, { creatorId: 'creator-1' }))?.id, 'op-ok');
        const cancel = stmts(/^UPDATE ads_ops SET state = 'cancelled'/)[0]!;
        assert.equal(cancel.params[0], 'op-orphan');
        assert.equal(JSON.parse(cancel.params[1]).code, 'DEPENDENCY_FAILED');
        assert.match(cancel.sql, /WHERE id = \$1 AND creator_id = \$4 AND state = 'pending'/);
    });

    it('a cancelled op scrubs its params in the same statement when the payload asks for it', async () => {
        history();
        candidates([row({ id: 'op-orphan', depends_on: 'op-parent', dep_state: 'cancelled', payload: { scrub: true, exec: { method: 'POST', path: '{dep}/users', params: { payload: { data: ['hash'] } } } } })], []);
        await claimNext('act_111', T0, { creatorId: 'creator-1' });
        const cancel = stmts(/^UPDATE ads_ops SET state = 'cancelled'/)[0]!;
        assert.match(cancel.sql, /jsonb_set\(payload, '\{exec,params\}', '\{\}'::jsonb\)/);
        assert.match(cancel.sql, /payload->>'scrub' = 'true'/);
    });

    it('a budget op over the 4-an-hour limit has its not_before pushed and the next op is tried', async () => {
        history(...[50, 40, 30, 5].map((m) => ({ kind: 'budget', object_key: 'obj-b', adset_key: 'adset-1', agoMs: m * MIN })));
        candidates([
            row({ id: 'op-budget', kind: 'budget', object_key: 'obj-b', payload: { adsetMetaId: 'adset-1', exec: { method: 'POST', path: 'adset-1', params: { daily_budget: 1 } } } }),
            row({ id: 'op-other', object_key: 'k2' }),
        ]);
        assert.equal((await claimNext('act_111', T0, { creatorId: 'creator-1' }))?.id, 'op-other');
        const push = stmts(/^UPDATE ads_ops SET not_before = \$2/)[0]!;
        assert.equal(push.params[0], 'op-budget');
        assert.equal(push.params[2], 'creator-1');
        assert.match(push.sql, /creator_id = \$3/);
        assert.equal((push.params[1] as Date).toISOString(), at(10 * MIN).toISOString());
        assert.equal(stmts(/^UPDATE ads_ops SET state = 'running'/).length, 1, 'the limited op never started');
    });

    it('an op on an object edited under 30 s ago is pushed; a later op on that object is not taken instead', async () => {
        history({ kind: 'status', object_key: 'k1', agoMs: 10 * SEC });
        candidates([row({ id: 'op-a', object_key: 'k1' }), row({ id: 'op-b', object_key: 'k1' })]);
        assert.equal(await claimNext('act_111', T0, { creatorId: 'creator-1' }), null);
        const push = stmts(/^UPDATE ads_ops SET not_before = \$2/);
        assert.equal(push.length, 1);
        assert.equal((push[0]!.params[1] as Date).toISOString(), at(20 * SEC).toISOString());
    });

    it('the 11th spend-cap change of the day is pushed to midnight', async () => {
        history(...Array.from({ length: 10 }, (_, i) => ({ kind: 'spend_cap', object_key: 'account', agoMs: (i + 1) * 10 * MIN })));
        candidates([row({ id: 'op-cap', kind: 'spend_cap', object_key: 'account', payload: { exec: { method: 'POST', path: 'act_111', params: { spend_cap: 5 } } } })]);
        assert.equal(await claimNext('act_111', T0, { creatorId: 'creator-1' }), null);
        assert.equal((stmts(/^UPDATE ads_ops SET not_before = \$2/)[0]!.params[1] as Date).toISOString(), '2026-10-23T00:00:00.000Z');
    });

    it('the history it reads is the account\'s done ops of the last two days', async () => {
        history();
        candidates([row()]);
        await claimNext('act_111', T0, { creatorId: 'creator-1' });
        const h = stmts(/AS adset_key/)[0]!;
        assert.match(h.sql, /state = 'done'/);
        assert.match(h.sql, /finished_at > \$3/);
        assert.match(h.sql, /creator_id = \$1/);
        assert.deepEqual([h.params[0], h.params[1]], ['creator-1', 'act_111']);
    });

    it('can be asked for one op only (the inline run): the same select with that id', async () => {
        history();
        candidates([row({ id: 'op-x' })]);
        assert.equal((await claimNext('act_111', T0, { creatorId: 'creator-1', onlyId: 'op-x' }))?.id, 'op-x');
        assert.equal(stmts(/FROM ads_ops p LEFT JOIN ads_ops d/)[0]!.params[2], 'op-x');
    });
});

describe('execute: {op:<id>} placeholders in params (A4 drafts: an ad names its ad set and its creative)', () => {
    const ADSET_OP = '11111111-1111-4111-8111-111111111111';
    const CREATIVE_OP = '22222222-2222-4222-8222-222222222222';
    const adOp = () => op({
        id: 'op-ad', kind: 'create', objectKey: 'k',
        payload: { exec: { method: 'POST', path: 'act_111/ads', edge: 'ads', params: { name: 'Ad', adset_id: `{op:${ADSET_OP}}`, creative: { creative_id: `{op:${CREATIVE_OP}}` }, status: 'PAUSED' } } },
    });

    it('placeholderOps finds every op named at any depth; fillPlaceholders replaces only exact placeholders', () => {
        assert.deepEqual([...placeholderOps({ a: `{op:${ADSET_OP}}`, b: [{ c: `{op:${CREATIVE_OP}}` }], d: `x {op:${ADSET_OP}}` })].sort(), [ADSET_OP, CREATIVE_OP]);
        const filled = fillPlaceholders({ a: `{op:${ADSET_OP}}`, d: `x {op:${ADSET_OP}}`, n: 3 }, new Map([[ADSET_OP, '900']]));
        assert.deepEqual(filled, { a: '900', d: `x {op:${ADSET_OP}}`, n: 3 });
    });

    it('fills each from that op\'s result id, read for this tenant and only when done', async () => {
        answerFinishes();
        db.on(/^SELECT id, result FROM ads_ops WHERE creator_id = \$1 AND id = ANY/, (params) => {
            assert.equal(params[0], 'creator-1');
            return { rows: [{ id: ADSET_OP, result: { id: '9001' } }, { id: CREATIVE_OP, result: { id: '9002' } }] };
        });
        const g = graphStub({ post: () => ({ id: '9003' }) });
        const out = await execute(adOp(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(out.state, 'done');
        assert.equal(g.calls[0]!.params?.['adset_id'], '9001');
        assert.deepEqual(g.calls[0]!.params?.['creative'], { creative_id: '9002' });
        assert.match(stmts(/^SELECT id, result FROM ads_ops/)[0]!.sql, /state = 'done'/);
    });

    it('fails without calling Meta when one of them made no id', async () => {
        answerFinishes();
        db.on(/^SELECT id, result FROM ads_ops WHERE creator_id = \$1 AND id = ANY/, () => ({ rows: [{ id: ADSET_OP, result: { id: '9001' } }] }));
        const g = graphStub();
        const out = await execute(adOp(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(out.state, 'failed');
        assert.equal(g.calls.length, 0);
    });
});

describe('execute: the Graph call is outside every transaction', () => {
    it('success: the call, then ONE short transaction recording done; nothing but the Graph call between the two', async () => {
        answerFinishes();
        const g = graphStub({ post: () => ({ success: true }) });
        const out = await execute(op(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(out.state, 'done');
        assert.equal(g.calls.length, 1);
        assert.equal(db.markedInsideTransaction('graph'), false, 'no Graph call between BEGIN and COMMIT');
        assert.deepEqual(db.timeline().slice(0, 2), ['-- graph', 'BEGIN']);
        const finish = stmts(/^UPDATE ads_ops SET state = \$2/)[0]!;
        assert.match(finish.sql, /WHERE id = \$1 AND creator_id = \$7 AND state = \$6/);
        assert.equal(finish.params[6], 'creator-1');
        assert.equal(finish.params[1], 'done');
        assert.equal(finish.params[5], 'running');
        assert.equal(g.calls[0]!.token, TOKEN);
        assert.equal(g.calls[0]!.path, '555');
        assert.deepEqual(g.calls[0]!.params, { status: 'PAUSED' });
    });

    it('runs inside the tenant and ad account context and labels the call', async () => {
        answerFinishes();
        const g = graphStub();
        await execute(op(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(g.calls[0]!.opts['creatorId'], 'creator-1');
        assert.equal(g.calls[0]!.opts['adAccountId'], 'act_111');
        assert.equal(g.calls[0]!.opts['label'], 'ads.op.status');
        assert.notEqual(g.calls[0]!.opts['creates'], true);
    });

    it('the token is never written to the database or to the audit trail', async () => {
        answerFinishes();
        const g = graphStub();
        await execute(op(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(JSON.stringify(db.statements).includes(TOKEN), false);
        assert.equal(logged.join('\n').includes(TOKEN), false);
    });

    it('a DELETE op calls DELETE on its path', async () => {
        answerFinishes();
        const g = graphStub();
        await execute(op({ kind: 'delete', payload: { exec: { method: 'DELETE', path: '555' } } }), TOKEN, { graph: g.graph, now: () => T0 });
        assert.deepEqual(g.calls.map((c) => [c.method, c.path]), [['DELETE', '555']]);
    });

    it('a create carries the AR·<op id> tag in its name and is sent with the creates rule', async () => {
        answerFinishes();
        const g = graphStub({ post: () => ({ id: '12345' }) });
        const create = op({ id: 'op-77', kind: 'create', objectKey: 'k', payload: { exec: { method: 'POST', path: 'act_111/campaigns', edge: 'campaigns', params: { name: 'Eid sale', objective: 'OUTCOME_TRAFFIC' } } } });
        await execute(create, TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(g.calls[0]!.params?.['name'], 'Eid sale AR·op-77');
        assert.equal(g.calls[0]!.params?.['objective'], 'OUTCOME_TRAFFIC');
        assert.equal(g.calls[0]!.opts['creates'], true);
    });

    it('does not tag twice when the name already has the tag, and names an unnamed create by the tag alone', async () => {
        answerFinishes();
        const g = graphStub();
        const tagged = op({ id: 'op-77', kind: 'create', objectKey: 'k', payload: { exec: { method: 'POST', path: 'act_111/campaigns', edge: 'campaigns', params: { name: 'Eid AR·op-77' } } } });
        await execute(tagged, TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(g.calls[0]!.params?.['name'], 'Eid AR·op-77');
        const bare = op({ id: 'op-78', kind: 'create', objectKey: 'k', payload: { exec: { method: 'POST', path: 'act_111/adsets', edge: 'adsets', params: {} } } });
        await execute(bare, TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(g.calls[1]!.params?.['name'], 'AR·op-78');
    });

    it('an audience_create is a create too: tagged, creates rule, verified by the tag', async () => {
        answerFinishes();
        const g = graphStub();
        const aud = op({ id: 'op-aud', kind: 'audience_create', objectKey: 'audience:1', payload: { exec: { method: 'POST', path: 'act_111/customaudiences', edge: 'customaudiences', params: { name: 'Buyers' } } } });
        await execute(aud, TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(g.calls[0]!.params?.['name'], 'Buyers AR·op-aud');
        assert.equal(g.calls[0]!.opts['creates'], true);
    });

    it('a create that succeeds sets meta_id on its ads_objects row, once, and never onto another row\'s meta id', async () => {
        answerFinishes();
        const g = graphStub({ post: () => ({ id: '12345' }) });
        const create = op({ id: 'op-77', kind: 'create', objectKey: CAMPAIGN_UUID, payload: { exec: { method: 'POST', path: 'act_111/campaigns', edge: 'campaigns', params: { name: 'x' } } } });
        await execute(create, TOKEN, { graph: g.graph, now: () => T0 });
        const adopt = stmts(/^UPDATE ads_objects SET meta_id = \$3/)[0]!;
        assert.deepEqual(adopt.params, [CAMPAIGN_UUID, 'creator-1', '12345']);
        assert.match(adopt.sql, /meta_id IS NULL/);
        assert.match(adopt.sql, /NOT EXISTS/, 'a row the sync already inserted for this id is not collided with');
        const tl = db.timeline();
        assert.ok(tl.indexOf(adopt.sql) < tl.lastIndexOf('COMMIT'), 'in the same transaction as the outcome');
    });

    it('a status op sets the stored copy\'s status optimistically; an archive sets status and effective_status', async () => {
        answerFinishes();
        const g = graphStub();
        await execute(op(), TOKEN, { graph: g.graph, now: () => T0 });
        const up = stmts(/^UPDATE ads_objects SET status = \$3/)[0]!;
        assert.deepEqual(up.params, [CAMPAIGN_UUID, 'creator-1', 'PAUSED']);
        assert.doesNotMatch(up.sql, /effective_status/);
        db.statements.length = 0;
        const archive = op({ kind: 'archive', payload: { exec: { method: 'POST', path: '555', params: { status: 'ARCHIVED' } } } });
        await execute(archive, TOKEN, { graph: g.graph, now: () => T0 });
        assert.match(stmts(/^UPDATE ads_objects SET status = \$3/)[0]!.sql, /effective_status = \$3/);
    });

    it('a budget op sets budget_kind and budget_amount in major units from the object\'s currency', async () => {
        answerFinishes();
        db.on(/^SELECT currency FROM ads_objects/, () => ({ rows: [{ currency: 'USD' }] }));
        const g = graphStub();
        const budget = op({ kind: 'budget', payload: { adsetMetaId: 'a1', exec: { method: 'POST', path: 'a1', params: { daily_budget: 2550 } } } });
        await execute(budget, TOKEN, { graph: g.graph, now: () => T0 });
        const up = stmts(/^UPDATE ads_objects SET budget_kind = \$3/)[0]!;
        assert.deepEqual(up.params, [CAMPAIGN_UUID, 'creator-1', 'daily', 25.5]);
    });

    it('an op on an object key that is not an ads_objects id touches no ads_objects row', async () => {
        answerFinishes();
        const g = graphStub();
        await execute(op({ objectKey: 'account', kind: 'spend_cap', payload: { exec: { method: 'POST', path: 'act_111', params: { spend_cap: 5 } } } }), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(stmts(/ads_objects/).length, 0);
    });

    it('failure: failed with Meta\'s error, audited ads.op_failed with the op\'s actor and proposal', async () => {
        answerFinishes();
        const g = graphStub({ post: () => { throw graphError('other', { code: 100, subcode: 33, message: 'Unsupported' }); } });
        const proposed = op({ proposalId: 'prop-1', actor: { userId: null, via: 'proposal' } });
        const out = await execute(proposed, TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(out.state, 'failed');
        assert.equal(stmts(/^UPDATE ads_objects/).length, 0, 'a failed write changes nothing in the stored copy');
        const audit = auditRows();
        assert.equal(audit.length, 1);
        assert.equal(auditAction(audit[0]!), 'ads.op_failed');
        assert.equal(audit[0]!.params[3], 'ads_op');
        assert.equal(auditDetail(audit[0]!).via, 'proposal');
        assert.equal(auditDetail(audit[0]!).proposal_id, 'prop-1');
        assert.equal(audit[0]!.params[0], null);
        assert.match(String(audit[0]!.params[1]), /proposal/, 'a rule or proposal is named in the actor column');
        assert.ok(db.timeline().findIndex((s) => s.startsWith('INSERT INTO audit_log')) > db.timeline().lastIndexOf('COMMIT'), 'audited after the commit');
    });

    it('success is audited ads.op_applied with the actor\'s user id', async () => {
        answerFinishes();
        const g = graphStub();
        await execute(op(), TOKEN, { graph: g.graph, now: () => T0 });
        const audit = auditRows();
        assert.equal(auditAction(audit[0]!), 'ads.op_applied');
        assert.equal(audit[0]!.params[0], 'user-1');
    });

    it('a throttled op goes back to pending at Meta\'s time and is not audited as an outcome', async () => {
        answerFinishes();
        const retryAt = at(5 * MIN);
        const g = graphStub({ post: () => { throw graphError('throttle', { code: 17, subcode: 2446079, retryAt }); } });
        const out = await execute(op(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(out.state, 'pending');
        const finish = stmts(/^UPDATE ads_ops SET state = \$2/)[0]!;
        assert.equal(finish.params[1], 'pending');
        assert.equal((finish.params[2] as Date).toISOString(), retryAt.toISOString());
        assert.equal(finish.params[4], null, 'not finished');
        assert.equal(g.calls.length, 1, 'no retry loop');
        assert.equal(auditRows().length, 0);
    });

    it('a create that timed out is recorded as verify (one call, no resend)', async () => {
        answerFinishes();
        const g = graphStub({ post: () => { throw graphError('other'); } });
        const create = op({ kind: 'create', objectKey: 'k', payload: { exec: { method: 'POST', path: 'act_111/campaigns', edge: 'campaigns', params: { name: 'x' } } } });
        const out = await execute(create, TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(out.state, 'verify');
        assert.equal(g.calls.length, 1);
        assert.equal(stmts(/^UPDATE ads_ops SET state = \$2/)[0]!.params[1], 'verify');
    });

    it('token_dead: failed TOKEN_INVALID and the caller is told to stop', async () => {
        answerFinishes();
        const g = graphStub({ post: () => { throw graphError('token_dead', { code: 190 }); } });
        const out = await execute(op(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(out.stop, 'token_dead');
        assert.equal(JSON.parse(stmts(/^UPDATE ads_ops SET state = \$2/)[0]!.params[3]).code, 'TOKEN_INVALID');
    });

    it('does not record an outcome over an op the reaper already moved (the state guard matches nothing)', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, () => ({ rows: [] }));
        const g = graphStub();
        await execute(op({ objectKey: CAMPAIGN_UUID }), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(stmts(/^UPDATE ads_objects/).length, 0);
        assert.equal(auditRows().length, 0);
    });

    it('a failure to record the outcome is logged, not thrown (the reaper picks the op up)', async () => {
        db.on(/^UPDATE ads_ops SET state = \$2/, () => { throw new Error('connection lost'); });
        const g = graphStub();
        const out = await execute(op(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(out.state, 'done');
        assert.ok(logged.some((l) => l.includes('ads.op_record_failed')));
    });
});

describe('execute: the path from a dependency', () => {
    const users = (over: Partial<Op> = {}) => op({
        id: 'op-users', kind: 'audience_users', objectKey: 'audience:1', dependsOn: 'op-aud',
        payload: { exec: { method: 'POST', path: '{dep}/users', params: { payload: { schema: ['EMAIL_SHA256'], data: [['abc']] } } } }, ...over,
    });

    it("replaces {dep} with the dependency's result id at execution time", async () => {
        answerFinishes();
        db.on(/^SELECT result FROM ads_ops WHERE id = \$1 AND creator_id = \$2/, (p) => ({ rows: [{ result: p[0] === 'op-aud' ? { id: '6001' } : null }] }));
        const g = graphStub();
        await execute(users(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(g.calls[0]!.path, '6001/users');
        assert.equal(db.markedInsideTransaction('graph'), false);
    });

    it('fails with reason dependency_without_id when the dependency left no id, and never calls Meta', async () => {
        answerFinishes();
        db.on(/^SELECT result FROM ads_ops WHERE id = \$1 AND creator_id = \$2/, () => ({ rows: [{ result: { success: true } }] }));
        const g = graphStub();
        const out = await execute(users(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(out.state, 'failed');
        assert.equal(out.result?.['reason'], 'dependency_without_id');
        assert.equal(g.calls.length, 0);
    });

    it('a {dep} path with no dependency at all fails the same way', async () => {
        answerFinishes();
        const g = graphStub();
        const out = await execute(users({ dependsOn: null }), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(out.result?.['reason'], 'dependency_without_id');
        assert.equal(g.calls.length, 0);
    });
});

describe('scrub on finish', () => {
    const upload = (over: Partial<Op> = {}) => op({ kind: 'audience_users', objectKey: 'audience:1', payload: { scrub: true, exec: { method: 'POST', path: '6001/users', params: { payload: { data: [['hash']] } } } }, ...over });
    const finishSql = () => stmts(/^UPDATE ads_ops SET state = \$2/)[0]!.sql;

    it('empties exec.params in the SAME statement that records done, failed or cancelled, and only then', async () => {
        answerFinishes();
        const g = graphStub();
        await execute(upload(), TOKEN, { graph: g.graph, now: () => T0 });
        const sql = finishSql();
        assert.match(sql, /payload = CASE WHEN \$5::timestamptz IS NOT NULL AND payload->>'scrub' = 'true' THEN jsonb_set\(payload, '\{exec,params\}', '\{\}'::jsonb\) ELSE payload END/);
        assert.equal(stmts(/^UPDATE ads_ops SET state = \$2/)[0]!.params[4] instanceof Date, true, 'a terminal state has finished_at, which is what switches the scrub on');
    });

    it('a throttled upload keeps its params (it will be sent again): finished_at is null so the CASE leaves the payload', async () => {
        answerFinishes();
        const g = graphStub({ post: () => { throw graphError('throttle', { code: 17, retryAt: at(MIN) }); } });
        await execute(upload(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(stmts(/^UPDATE ads_ops SET state = \$2/)[0]!.params[4], null);
    });

    it('a failed upload is scrubbed too', async () => {
        answerFinishes();
        const g = graphStub({ post: () => { throw graphError('other', { code: 100, status: 400 }); } });
        const out = await execute(upload(), TOKEN, { graph: g.graph, now: () => T0 });
        assert.equal(out.state, 'failed');
        assert.equal(stmts(/^UPDATE ads_ops SET state = \$2/)[0]!.params[4] instanceof Date, true);
    });

    it('the reaper\'s abandoned ops are scrubbed in the same statement', async () => {
        db.on(/SET state = 'failed'/, () => ({ rows: [] }));
        await reap(T0);
        const sql = stmts(/SET state = 'failed'/)[0]!.sql;
        assert.match(sql, /jsonb_set\(payload, '\{exec,params\}', '\{\}'::jsonb\)/);
    });
});

describe('reap', () => {
    it('moves a running op older than 5 minutes: to verify for creates and ops without an exec, otherwise back to pending', async () => {
        db.on(/^UPDATE ads_ops SET state = CASE/, () => ({ rows: [{ id: 'a' }, { id: 'b' }] }));
        db.on(/SET state = 'failed'/, () => ({ rows: [{ id: 'c' }] }));
        const n = await reap(T0);
        assert.equal(n, 3);
        const up = stmts(/^UPDATE ads_ops SET state = CASE/)[0]!;
        assert.match(up.sql, /WHEN payload #>> '\{exec,edge\}' IS NOT NULL OR kind = 'audience_create' OR NOT \(payload \? 'exec'\) THEN 'verify' ELSE 'pending'/);
        assert.match(up.sql, /WHERE state = 'running' AND started_at < \$2/);
        assert.match(up.sql, /RETURNING id, creator_id/);
        assert.equal((up.params[1] as Date).toISOString(), at(-5 * MIN).toISOString());
    });

    it('fails a verify op older than 24 hours with reason abandoned', async () => {
        db.on(/^UPDATE ads_ops SET state = CASE/, () => ({ rows: [] }));
        db.on(/SET state = 'failed'/, () => ({ rows: [{ id: 'old' }] }));
        await reap(T0);
        const up = stmts(/SET state = 'failed'/)[0]!;
        assert.match(up.sql, /'abandoned'/);
        assert.match(up.sql, /WHERE state = 'verify' AND COALESCE\(started_at, created_at\) < \$2/);
        assert.equal((up.params[1] as Date).toISOString(), at(-24 * HOUR).toISOString());
    });
});

describe('drainAdsOps', () => {
    const accounts = (...rows: Array<{ creator_id: string; ad_account_id: string }>) => db.on(/SELECT DISTINCT creator_id, ad_account_id FROM ads_ops/, () => ({ rows }));
    const quiet = () => { db.on(/^UPDATE ads_ops SET state = CASE/, () => ({ rows: [] })); db.on(/SET state = 'failed'/, () => ({ rows: [] })); db.on(/AS adset_key/, () => ({ rows: [] })); };
    const opts = (g: GraphDeps, over: Partial<RunOpts> = {}): RunOpts => ({ graph: g, now: () => T0, loadToken: async () => TOKEN, blockedUntil: async () => null, ...over });

    it('reaps first, then runs every due op of an account one at a time until nothing is due', async () => {
        quiet();
        accounts({ creator_id: 'creator-1', ad_account_id: 'act_111' });
        answerFinishes();
        const queue = [row({ id: 'op-1', object_key: 'k1' }), row({ id: 'op-2', object_key: 'k2' })];
        db.on(/FROM ads_ops p LEFT JOIN ads_ops d/, () => ({ rows: queue.length ? [queue[0]!] : [] }));
        db.on(/^UPDATE ads_ops SET state = 'running'/, () => ({ rows: [{ ...queue.shift()!, state: 'running', attempts: 1, started_at: T0 }] }));
        db.on(/FROM ads_ops v/, () => ({ rows: [] }));
        const g = graphStub();
        const stats = await drainAdsOps(Date.now() + 60_000, opts(g.graph));
        assert.deepEqual(stats, { ran: 2, done: 2, failed: 0, deferred: 0, reaped: 0 });
        assert.equal(g.calls.length, 2);
        assert.equal(db.markedInsideTransaction('graph'), false);
        const tl = db.timeline();
        assert.ok(tl.findIndex((s) => s.startsWith('UPDATE ads_ops SET state = CASE')) < tl.findIndex((s) => s.startsWith('SELECT DISTINCT')), 'reap came first');
    });

    it('skips an account whose pacer is blocked and counts it as deferred', async () => {
        quiet();
        accounts({ creator_id: 'creator-1', ad_account_id: 'act_111' });
        const g = graphStub();
        const stats = await drainAdsOps(Date.now() + 60_000, opts(g.graph, { blockedUntil: async () => at(5 * MIN) }));
        assert.equal(stats.ran, 0);
        assert.equal(stats.deferred, 1);
        assert.equal(g.calls.length, 0);
        assert.equal(stmts(/p LEFT JOIN/).length, 0, 'not even a claim');
    });

    it('does not claim anything for a tenant with no token', async () => {
        quiet();
        accounts({ creator_id: 'creator-1', ad_account_id: 'act_111' });
        const g = graphStub();
        const stats = await drainAdsOps(Date.now() + 60_000, opts(g.graph, { loadToken: async () => null }));
        assert.equal(stats.ran, 0);
        assert.equal(stmts(/p LEFT JOIN/).length, 0);
    });

    it('stops an account\'s loop for the run when its token is dead', async () => {
        quiet();
        accounts({ creator_id: 'creator-1', ad_account_id: 'act_111' });
        answerFinishes();
        db.on(/FROM ads_ops p LEFT JOIN ads_ops d/, () => ({ rows: [row({ id: 'op-1' })] }));
        db.on(/^UPDATE ads_ops SET state = 'running'/, () => ({ rows: [{ ...row({ id: 'op-1' }), state: 'running', attempts: 1, started_at: T0 }] }));
        db.on(/FROM ads_ops v/, () => ({ rows: [] }));
        const g = graphStub({ post: () => { throw graphError('token_dead', { code: 190 }); } });
        const stats = await drainAdsOps(Date.now() + 60_000, opts(g.graph));
        assert.equal(g.calls.length, 1, 'one call, then the loop stopped');
        assert.equal(stats.failed, 1);
    });

    it('counts a throttled op as deferred and does not call again', async () => {
        quiet();
        accounts({ creator_id: 'creator-1', ad_account_id: 'act_111' });
        answerFinishes();
        db.on(/FROM ads_ops p LEFT JOIN ads_ops d/, () => ({ rows: [row({ id: 'op-1' })] }));
        db.on(/^UPDATE ads_ops SET state = 'running'/, () => ({ rows: [{ ...row({ id: 'op-1' }), state: 'running', attempts: 1, started_at: T0 }] }));
        db.on(/FROM ads_ops v/, () => ({ rows: [] }));
        const g = graphStub({ post: () => { throw graphError('throttle', { code: 17, retryAt: at(5 * MIN) }); } });
        const stats = await drainAdsOps(Date.now() + 60_000, opts(g.graph));
        assert.equal(stats.deferred, 1);
        assert.equal(g.calls.length, 1, 'a throttle ends that account\'s run: nothing is retried in a loop');
    });

    it('stops at the deadline minus three seconds', async () => {
        quiet();
        accounts({ creator_id: 'creator-1', ad_account_id: 'act_111' });
        const g = graphStub();
        const stats = await drainAdsOps(Date.now() + 2_000, opts(g.graph));
        assert.equal(stats.ran, 0);
        assert.equal(stmts(/p LEFT JOIN/).length, 0);
    });

    it('never throws, even when the database does', async () => {
        db.on(/^UPDATE ads_ops SET state = CASE/, () => { throw new Error('db down'); });
        db.on(/SELECT DISTINCT creator_id/, () => { throw new Error('db down'); });
        const g = graphStub();
        const stats = await drainAdsOps(Date.now() + 60_000, opts(g.graph));
        assert.deepEqual(stats, { ran: 0, done: 0, failed: 0, deferred: 0, reaped: 0 });
        assert.ok(logged.some((l) => l.includes('ads.drain')));
    });
});

describe('runOpInline and enqueueAndTryInline', () => {
    const opts = (g: GraphDeps, over: Partial<RunOpts> = {}): RunOpts => ({ graph: g, now: () => T0, loadToken: async () => TOKEN, blockedUntil: async () => null, ...over });

    it('claims that one op if it is claimable, runs it and records it', async () => {
        db.on(/^SELECT creator_id, ad_account_id FROM ads_ops WHERE id = \$1/, () => ({ rows: [{ creator_id: 'creator-1', ad_account_id: 'act_111' }] }));
        db.on(/AS adset_key/, () => ({ rows: [] }));
        db.on(/FROM ads_ops p LEFT JOIN ads_ops d/, () => ({ rows: [row({ id: 'op-x' })] }));
        db.on(/^UPDATE ads_ops SET state = 'running'/, () => ({ rows: [{ ...row({ id: 'op-x' }), state: 'running', attempts: 1, started_at: T0 }] }));
        answerFinishes();
        const g = graphStub();
        await runOpInline('op-x', opts(g.graph));
        assert.equal(g.calls.length, 1);
        assert.equal(stmts(/FROM ads_ops p LEFT JOIN ads_ops d/)[0]!.params[2], 'op-x');
        assert.equal(db.markedInsideTransaction('graph'), false);
    });

    it('does nothing when the op is not claimable (another op is running on the object, or a limit applies)', async () => {
        db.on(/^SELECT creator_id, ad_account_id FROM ads_ops WHERE id = \$1/, () => ({ rows: [{ creator_id: 'creator-1', ad_account_id: 'act_111' }] }));
        db.on(/FROM ads_ops p LEFT JOIN ads_ops d/, () => ({ rows: [] }));
        const g = graphStub();
        await runOpInline('op-x', opts(g.graph));
        assert.equal(g.calls.length, 0);
    });

    it('leaves the op pending when the account is blocked or the tenant has no token', async () => {
        db.on(/^SELECT creator_id, ad_account_id FROM ads_ops WHERE id = \$1/, () => ({ rows: [{ creator_id: 'creator-1', ad_account_id: 'act_111' }] }));
        const g = graphStub();
        await runOpInline('op-x', opts(g.graph, { blockedUntil: async () => at(MIN) }));
        await runOpInline('op-x', opts(g.graph, { loadToken: async () => null }));
        assert.equal(stmts(/p LEFT JOIN/).length, 0);
    });

    it('never throws', async () => {
        db.on(/^SELECT creator_id, ad_account_id FROM ads_ops WHERE id = \$1/, () => { throw new Error('db down'); });
        await runOpInline('op-x', opts(graphStub().graph));
    });

    it('enqueueAndTryInline enqueues, then hands runOpInline to waitUntil', async () => {
        const handed: Promise<unknown>[] = [];
        const previous = setWaitUntil((work) => { handed.push(work); });
        try {
            db.on(/^INSERT INTO ads_ops/, () => ({ rows: [row({ id: 'op-new' })] }));
            db.on(/^SELECT creator_id, ad_account_id FROM ads_ops WHERE id = \$1/, () => ({ rows: [] }));
            const view = await enqueueAndTryInline({
                creatorId: 'creator-1', adAccountId: 'act_111', objectKey: 'k', kind: 'status', payload: { exec: { method: 'POST', path: '555', params: { status: 'PAUSED' } } },
                idempotencyKey: 'x:1', actor: { userId: null, via: 'owner' },
            });
            assert.equal(view.id, 'op-new');
            assert.equal(handed.length, 1);
            await handed[0];
        } finally {
            setWaitUntil(previous);
        }
    });

    it('with the caller\'s own executor it does not try inline (the row is not committed yet)', async () => {
        const handed: Promise<unknown>[] = [];
        const previous = setWaitUntil((work) => { handed.push(work); });
        try {
            const exec = { query: async (sql: string) => (/^INSERT INTO ads_ops/.test(sql.replace(/\s+/g, ' ').trim()) ? { rows: [row()], rowCount: 1 } : { rows: [{ id: 'a' }], rowCount: 1 }) };
            await enqueueAndTryInline({
                creatorId: 'creator-1', adAccountId: 'act_111', objectKey: 'k', kind: 'status', payload: { exec: { method: 'POST', path: '555', params: { status: 'PAUSED' } } },
                idempotencyKey: 'x:2', actor: { userId: null, via: 'owner' },
            }, exec as any);
            assert.equal(handed.length, 0);
        } finally {
            setWaitUntil(previous);
        }
    });
});

describe('every Graph send goes through sendExec', () => {
    it('sendExec runs one call inside the tenant\'s ads context with the token, and is what execute uses', async () => {
        const g = graphStub();
        const res = await sendExec(op(), { method: 'GET', path: '555', params: { fields: 'status' }, label: 'ads.op_verify' }, { ...g.graph, token: TOKEN });
        assert.deepEqual(res, { data: { id: '999' } });
        assert.deepEqual(g.calls.map((c) => [c.method, c.path, c.token, c.opts['creatorId'], c.opts['adAccountId'], c.opts['label']]), [['GET', '555', TOKEN, 'creator-1', 'act_111', 'ads.op_verify']]);
        const post = await sendExec(op(), { method: 'POST', path: '555', params: { status: 'PAUSED' }, label: 'ads.op.status', creates: true }, { ...g.graph, token: TOKEN });
        assert.ok(post);
        assert.equal(g.calls[1]!.opts['creates'], true);
        const del = await sendExec(op(), { method: 'DELETE', path: '555', label: 'ads.op.delete' }, { ...g.graph, token: TOKEN });
        assert.ok(del);
        assert.equal(g.calls[2]!.method, 'DELETE');
    });
});

describe('tenant isolation: every statement on an ads_* table names creator_id', () => {
    it('across enqueue, claim, execute (done and failed), the drain, the inline run and the reaper', async () => {
        answerFinishes();
        db.on(/^INSERT INTO ads_ops/, () => ({ rows: [row()] }));
        db.on(/^SELECT currency FROM ads_objects/, () => ({ rows: [{ currency: 'USD' }] }));
        db.on(/AS adset_key/, () => ({ rows: [] }));
        db.on(/FROM ads_ops p LEFT JOIN ads_ops d/, () => ({ rows: [row({ id: 'op-1' })] }));
        db.on(/^UPDATE ads_ops SET state = 'running'/, () => ({ rows: [{ ...row({ id: 'op-1' }), state: 'running', attempts: 1, started_at: T0 }] }));
        db.on(/SELECT DISTINCT creator_id/, () => ({ rows: [{ creator_id: 'creator-1', ad_account_id: 'act_111' }] }));
        db.on(/^UPDATE ads_ops SET state = CASE/, () => ({ rows: [] }));
        db.on(/SET state = 'failed'/, () => ({ rows: [] }));
        db.on(/^SELECT creator_id, ad_account_id FROM ads_ops WHERE id/, () => ({ rows: [{ creator_id: 'creator-1', ad_account_id: 'act_111' }] }));
        const g = graphStub();
        const env: RunOpts = { graph: g.graph, now: () => T0, loadToken: async () => TOKEN, blockedUntil: async () => null };
        await enqueue({ creatorId: 'creator-1', adAccountId: 'act_111', objectKey: CAMPAIGN_UUID, kind: 'budget', payload: { adsetMetaId: 'a1', exec: { method: 'POST', path: 'a1', params: { daily_budget: 1000 } } }, idempotencyKey: 'k:1', actor: { userId: null, via: 'owner' } });
        await getOp('creator-1', CAMPAIGN_UUID);
        await listOps('creator-1', ['pending']);
        await editsLeftThisHour('creator-1', ['a1']);
        await execute(op({ kind: 'budget', payload: { adsetMetaId: 'a1', exec: { method: 'POST', path: 'a1', params: { daily_budget: 1000 } } } }), TOKEN, env);
        await execute(op({ kind: 'create', payload: { exec: { method: 'POST', path: 'act_111/campaigns', edge: 'campaigns', params: { name: 'x' } } } }), TOKEN, env);
        await claimNext('act_111', T0, { creatorId: 'creator-1' });
        await runOpInline('op-1', { ...env, creatorId: 'creator-1' });
        await drainAdsOps(Date.now() + 60_000, env);
        await reap(T0);
        const touching = db.statements.filter((s) => /\bads_(ops|objects|insights_daily|alerts)\b/.test(s.sql));
        assert.ok(touching.length > 15, `only ${touching.length} statements seen`);
        assert.deepEqual(touching.filter((s) => !/creator_id/.test(s.sql)).map((s) => s.sql), []);
    });
});
