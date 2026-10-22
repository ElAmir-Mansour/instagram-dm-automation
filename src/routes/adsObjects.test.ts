/**
 * The Campaigns tab and the queue (`/api/ads/objects`, `/ops`, `/sync`; tasks T054) through the whole router, called as Express calls it:
 * the ADS_DISABLED gate, the role of each route (viewer reads, operator syncs, owner writes), reads that never touch Meta, the 15-minute
 * limit on a manual sync, the tenant fence on an op, and the error shape `{ error, code, field?, retryAt? }`.
 *
 * The database, Meta and `waitUntil` are faked by src/services/ads/objectsTestDb.ts.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
    ACC, ADSET_ID, ADSET_META, CAMPAIGN_ID, CAMPAIGN_META, OTHER_ACC, OTHER_TENANT, TENANT, adsetRow, installObjectsKit, objectRow, type ObjectsKit, type StoredOp,
} from '../services/ads/testing/objects/testDb.js';
import { adsRouter } from './ads.js';

type Role = 'viewer' | 'operator' | 'owner';

interface FakeRes {
    statusCode: number;
    body: any;
    status(code: number): FakeRes;
    json(payload: unknown): FakeRes;
    setHeader(): void;
    getHeader(): undefined;
}

async function call(method: string, url: string, opts: { role?: Role; body?: unknown } = {}): Promise<FakeRes> {
    const [path, qs] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs ?? ''));
    return new Promise((resolve, reject) => {
        const res: FakeRes = {
            statusCode: 200,
            body: undefined,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; resolve(this); return this; },
            setHeader() {},
            getHeader() { return undefined; },
        };
        const req = {
            method, url, originalUrl: `/api/ads${url}`, baseUrl: '', path, headers: {}, params: {}, query, body: opts.body ?? {},
            session: { userId: 'u1', role: 'user', tenantId: TENANT }, tenantRole: opts.role ?? 'owner',
        };
        (adsRouter as any)(req, res, (err?: unknown) => (err ? reject(err) : resolve({ ...res, statusCode: 404, body: { error: 'no route' } })));
    });
}

const OP_ID = '00000000-0000-4000-8000-0000000000aa';
const storedOp = (over: Partial<StoredOp> = {}): StoredOp => ({
    id: OP_ID, creator_id: TENANT, ad_account_id: ACC, object_key: CAMPAIGN_ID, kind: 'status', payload: { exec: { method: 'POST', path: CAMPAIGN_META, params: { status: 'PAUSED' } } },
    idempotency_key: 'k1', depends_on: null, state: 'pending', not_before: new Date(), attempts: 0, result: null, actor: { userId: 'u1', via: 'owner' }, proposal_id: null,
    created_at: new Date(), started_at: null, finished_at: null, ...over,
});

describe('/api/ads objects, ops and sync', () => {
    let kit: ObjectsKit;
    beforeEach(() => { kit = installObjectsKit(); });
    afterEach(() => kit.restore());

    describe('the ADS_DISABLED gate', () => {
        for (const [method, url] of [
            ['GET', '/objects'], ['GET', `/objects/${CAMPAIGN_ID}`], ['POST', `/objects/${CAMPAIGN_ID}/status`], ['POST', `/objects/${CAMPAIGN_ID}/budget`],
            ['POST', `/objects/${CAMPAIGN_ID}/archive`], ['DELETE', `/objects/${CAMPAIGN_ID}`], ['GET', '/ops'], ['GET', `/ops/${OP_ID}`], ['POST', '/sync'],
        ] as const) {
            it(`${method} ${url.replace(CAMPAIGN_ID, ':id').replace(OP_ID, ':id')} is 404 ADS_DISABLED when ads are off for the tenant, and nothing happens`, async () => {
                kit.settings.delete(`ads.enabled.${TENANT}`);
                kit.configure();
                kit.settings.delete(`ads.enabled.${TENANT}`);
                kit.rows.push(objectRow());
                const res = await call(method, url, { body: { status: 'PAUSED', amount: 3, confirm: true } });
                assert.equal(res.statusCode, 404);
                assert.equal(res.body.code, 'ADS_DISABLED');
                assert.equal(kit.meta.length, 0);
                assert.equal(kit.ops.length, 0);
                assert.equal(kit.waits.length, 0);
            });
        }
    });

    describe('roles', () => {
        beforeEach(() => { kit.configure(); kit.rows.push(objectRow({ status: 'ACTIVE', effectiveStatus: 'ACTIVE' })); kit.ops.push(storedOp()); });

        for (const url of ['/objects', `/objects/${CAMPAIGN_ID}`, '/ops', `/ops/${OP_ID}`]) {
            it(`a viewer may read GET ${url.replace(CAMPAIGN_ID, ':id').replace(OP_ID, ':id')}`, async () => {
                const res = await call('GET', url, { role: 'viewer' });
                assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            });
        }

        for (const [method, url] of [
            ['POST', `/objects/${CAMPAIGN_ID}/status`], ['POST', `/objects/${CAMPAIGN_ID}/budget`], ['POST', `/objects/${CAMPAIGN_ID}/archive`], ['DELETE', `/objects/${CAMPAIGN_ID}`],
        ] as const) {
            for (const role of ['viewer', 'operator'] as const) {
                it(`${method} ${url.replace(CAMPAIGN_ID, ':id')} is the owner's: a ${role} gets 403 and nothing is queued`, async () => {
                    const before = kit.ops.length;
                    const res = await call(method, url, { role, body: { status: 'PAUSED', amount: 3, confirm: true } });
                    assert.equal(res.statusCode, 403);
                    assert.equal(res.body.requiredRole, 'owner');
                    assert.equal(kit.ops.length, before);
                    assert.equal(kit.meta.length, 0);
                });
            }
        }

        it('POST /sync is the operator\'s: a viewer gets 403, an operator and an owner are let in', async () => {
            const viewer = await call('POST', '/sync', { role: 'viewer' });
            assert.equal(viewer.statusCode, 403);
            assert.equal(viewer.body.requiredRole, 'operator');
            assert.equal(kit.settings.has(`ads.sync.${TENANT}`), false, 'a refused request records nothing');
            const operator = await call('POST', '/sync', { role: 'operator' });
            assert.equal(operator.statusCode, 202, JSON.stringify(operator.body));
            kit.settings.delete(`ads.sync.${TENANT}`);
            const owner = await call('POST', '/sync', { role: 'owner' });
            assert.equal(owner.statusCode, 202);
            await Promise.all(kit.waits);
        });

        it('an owner can write: pause, budget, archive and delete each answer 202 with the op', async () => {
            kit.rows[0] = objectRow();
            const status = await call('POST', `/objects/${CAMPAIGN_ID}/status`, { body: { status: 'PAUSED', requestId: 'req-pause-1' } });
            assert.equal(status.statusCode, 202, JSON.stringify(status.body));
            assert.deepEqual({ kind: status.body.op.kind, state: status.body.op.state, objectKey: status.body.op.objectKey }, { kind: 'status', state: 'pending', objectKey: CAMPAIGN_ID });
            const budget = await call('POST', `/objects/${CAMPAIGN_ID}/budget`, { body: { amount: 3, requestId: 'req-budget-1' } });
            assert.equal(budget.statusCode, 202, JSON.stringify(budget.body));
            assert.equal(budget.body.op.kind, 'budget');
            assert.equal(budget.body.endOp, null);
            const archive = await call('POST', `/objects/${CAMPAIGN_ID}/archive`, { body: { requestId: 'req-archive-1' } });
            assert.equal(archive.statusCode, 202);
            assert.equal(archive.body.op.kind, 'archive');
            const del = await call('DELETE', `/objects/${CAMPAIGN_ID}`, { body: { confirm: true, requestId: 'req-delete-1' } });
            assert.equal(del.statusCode, 202, JSON.stringify(del.body));
            assert.equal(del.body.op.kind, 'delete');
            const written = kit.ops.slice(1); // the first is the op the suite started with
            assert.deepEqual(written.map((o) => o.kind), ['status', 'budget', 'archive', 'delete']);
            assert.ok(written.every((o) => o.creator_id === TENANT && o.ad_account_id === ACC));
            assert.equal(kit.meta.length, 0, 'answered at once: the Graph call is the queue\'s');
            assert.equal(kit.waits.length, 4, 'each op\'s inline attempt is under waitUntil');
            await Promise.all(kit.waits);
        });

        it('the actor on the op is the signed-in user and the role of the request', async () => {
            kit.rows[0] = objectRow();
            await call('POST', `/objects/${CAMPAIGN_ID}/archive`, { body: { requestId: 'req-archive-2' } });
            assert.deepEqual(kit.ops.at(-1)!.actor, { userId: 'u1', role: 'user', via: 'owner' });
        });
    });

    describe('GET never calls Meta', () => {
        it('every read answers from the stored copy: no HTTP at all', async () => {
            kit.configure();
            kit.rows.push(objectRow(), adsetRow());
            kit.ops.push(storedOp());
            const out = [
                await call('GET', '/objects'),
                await call('GET', '/objects?level=adset&status=active,paused'),
                await call('GET', `/objects?parentId=${CAMPAIGN_ID}`),
                await call('GET', `/objects/${CAMPAIGN_ID}`),
                await call('GET', `/objects/${ADSET_META}`),
                await call('GET', '/ops'),
                await call('GET', `/ops/${OP_ID}`),
            ];
            for (const r of out) assert.equal(r.statusCode, 200, JSON.stringify(r.body));
            assert.equal(kit.meta.length, 0, kit.meta.map((c) => `${c.method} ${c.url}`).join(', '));
        });

        it('GET /objects lists only the tenant\'s current ad account, with the queued ops of each row', async () => {
            kit.configure();
            kit.rows.push(
                objectRow(),
                objectRow({ id: 'c0000000-0000-4000-8000-0000000000bb', metaId: '120077', adAccountId: OTHER_ACC }),
                objectRow({ id: 'c0000000-0000-4000-8000-0000000000cc', metaId: '120088', creatorId: OTHER_TENANT }),
            );
            kit.ops.push(storedOp(), storedOp({ id: '00000000-0000-4000-8000-0000000000ab', state: 'done', idempotency_key: 'k2' }));
            const res = await call('GET', '/objects?level=campaign');
            assert.equal(res.statusCode, 200);
            assert.deepEqual(res.body.items.map((i: any) => i.id), [CAMPAIGN_ID]);
            assert.equal(res.body.items[0].queued.length, 1, 'only the unfinished op rides along');
            assert.ok('syncedAt' in res.body);
        });

        it('an ad set row carries the budget edits it has left this hour', async () => {
            kit.configure();
            kit.rows.push(objectRow(), adsetRow());
            kit.editsUsed.set(ADSET_META, 3);
            const res = await call('GET', '/objects?level=adset');
            assert.deepEqual(res.body.items.map((i: any) => [i.id, i.budget.editsLeftThisHour]), [[ADSET_ID, 1]]);
        });

        it('GET /objects?level=bogus is 400 INVALID on level', async () => {
            const res = await call('GET', '/objects?level=bogus');
            assert.deepEqual({ status: res.statusCode, code: res.body.code, field: res.body.field, hasError: typeof res.body.error }, { status: 400, code: 'INVALID', field: 'level', hasError: 'string' });
        });

        it('GET /objects/:id answers the object, its ad sets and the results window', async () => {
            kit.configure();
            kit.rows.push(objectRow(), adsetRow());
            const res = await call('GET', `/objects/${CAMPAIGN_ID}`);
            assert.equal(res.body.object.id, CAMPAIGN_ID);
            assert.deepEqual(res.body.children.map((c: any) => c.id), [ADSET_ID]);
            assert.deepEqual(Object.keys(res.body.results).sort(), ['daily', 'totals']);
        });

        it('GET /objects/:id is 404 NOT_FOUND for another tenant\'s object, another ad account\'s, a missing one and a malformed id', async () => {
            kit.configure();
            kit.rows.push(
                objectRow({ id: 'c0000000-0000-4000-8000-0000000000cc', metaId: '120088', creatorId: OTHER_TENANT }),
                objectRow({ id: 'c0000000-0000-4000-8000-0000000000bb', metaId: '120077', adAccountId: OTHER_ACC }),
            );
            for (const id of ['c0000000-0000-4000-8000-0000000000cc', '120088', 'c0000000-0000-4000-8000-0000000000bb', '120077', 'c0000000-0000-4000-8000-00000000ffff', 'x', '..%2F..']) {
                const res = await call('GET', `/objects/${id}`);
                assert.deepEqual({ id, status: res.statusCode, code: res.body.code }, { id, status: 404, code: 'NOT_FOUND' });
            }
            assert.equal(kit.meta.length, 0);
        });
    });

    describe('the write routes resolve :id through ownObject', () => {
        it('POST status on another tenant\'s object is 404 NOT_FOUND and queues nothing', async () => {
            kit.configure();
            kit.rows.push(objectRow({ creatorId: OTHER_TENANT }));
            const res = await call('POST', `/objects/${CAMPAIGN_ID}/status`, { body: { status: 'PAUSED' } });
            assert.equal(res.statusCode, 404);
            assert.equal(res.body.code, 'NOT_FOUND');
            assert.equal(kit.ops.length, 0);
        });

        it('a tenant with no ad account set gets 404 NOT_FOUND, not someone else\'s row', async () => {
            kit.rows.push(objectRow());
            const res = await call('POST', `/objects/${CAMPAIGN_ID}/archive`);
            assert.equal(res.statusCode, 404);
            assert.equal(res.body.code, 'NOT_FOUND');
        });

        it('resuming needs confirm: 400 INVALID on confirm, with nothing read from Meta', async () => {
            kit.configure();
            kit.rows.push(objectRow());
            const res = await call('POST', `/objects/${CAMPAIGN_ID}/status`, { body: { status: 'ACTIVE' } });
            assert.deepEqual({ status: res.statusCode, code: res.body.code, field: res.body.field }, { status: 400, code: 'INVALID', field: 'confirm' });
            assert.equal(kit.meta.length, 0);
        });

        it('DELETE needs confirm: true, and never runs on an ACTIVE object', async () => {
            kit.configure();
            kit.rows.push(objectRow());
            const noConfirm = await call('DELETE', `/objects/${CAMPAIGN_ID}`);
            assert.deepEqual({ status: noConfirm.statusCode, code: noConfirm.body.code, field: noConfirm.body.field }, { status: 400, code: 'INVALID', field: 'confirm' });
            kit.rows[0] = objectRow({ status: 'ACTIVE', effectiveStatus: 'ACTIVE' });
            const active = await call('DELETE', `/objects/${CAMPAIGN_ID}`, { body: { confirm: true } });
            assert.deepEqual({ status: active.statusCode, code: active.body.code }, { status: 409, code: 'CAMPAIGN_ACTIVE' });
            assert.equal(kit.ops.length, 0);
        });

        it('a tenant that is not set up is 409 ADS_NOT_CONFIGURED on a write', async () => {
            kit.settings.set(`ads.settings.${TENANT}`, JSON.stringify({ adAccountId: ACC }));
            kit.rows.push(objectRow());
            const res = await call('POST', `/objects/${CAMPAIGN_ID}/archive`);
            assert.deepEqual({ status: res.statusCode, code: res.body.code }, { status: 409, code: 'ADS_NOT_CONFIGURED' });
        });
    });

    describe('POST /sync', () => {
        it('answers 429 RATE_LIMITED with retryAt when the results were refreshed less than 15 minutes ago', async () => {
            kit.configure();
            const last = new Date(Date.now() - 5 * 60_000);
            kit.settings.set(`ads.sync.${TENANT}`, JSON.stringify({ todayAt: last.toISOString() }));
            const res = await call('POST', '/sync');
            assert.equal(res.statusCode, 429);
            assert.equal(res.body.code, 'RATE_LIMITED');
            assert.equal(typeof res.body.error, 'string');
            assert.equal(res.body.retryAt, new Date(last.getTime() + 15 * 60_000).toISOString());
            assert.equal(kit.waits.length, 0, 'no sync was started');
            assert.equal(kit.meta.length, 0);
        });

        it('a request within 15 minutes of an earlier REQUEST is refused too', async () => {
            kit.configure();
            const requested = new Date(Date.now() - 2 * 60_000);
            kit.settings.set(`ads.sync.${TENANT}`, JSON.stringify({ todayAt: new Date(Date.now() - 3_600_000).toISOString(), todayRequestedAt: requested.toISOString() }));
            const res = await call('POST', '/sync');
            assert.equal(res.statusCode, 429);
            assert.equal(res.body.retryAt, new Date(requested.getTime() + 15 * 60_000).toISOString());
        });

        it('queues one when the last refresh is older, records the request, and refuses a second right after', async () => {
            kit.configure();
            kit.settings.set(`ads.sync.${TENANT}`, JSON.stringify({ todayAt: new Date(Date.now() - 20 * 60_000).toISOString() }));
            const res = await call('POST', '/sync');
            assert.equal(res.statusCode, 202, JSON.stringify(res.body));
            assert.equal(res.body.queued, true);
            assert.ok(!Number.isNaN(Date.parse(res.body.notBefore)));
            assert.equal(kit.waits.length, 1, 'the sync runs under waitUntil');
            assert.ok(JSON.parse(kit.settings.get(`ads.sync.${TENANT}`)!).todayRequestedAt, 'the request is recorded');
            const again = await call('POST', '/sync');
            assert.equal(again.statusCode, 429);
            assert.equal(again.body.code, 'RATE_LIMITED');
            assert.equal(kit.waits.length, 1);
            await Promise.all(kit.waits);
        });

        it('a first sync (never refreshed) is queued', async () => {
            kit.configure();
            const res = await call('POST', '/sync');
            assert.equal(res.statusCode, 202);
            await Promise.all(kit.waits);
        });
    });

    describe('GET /ops', () => {
        it('GET /ops/:id is 404 NOT_FOUND for an op of another tenant, a missing op and a malformed id; the own op is answered', async () => {
            kit.configure();
            kit.ops.push(storedOp({ creator_id: OTHER_TENANT, idempotency_key: 'k-other' }));
            kit.ops.push(storedOp({ id: '00000000-0000-4000-8000-0000000000bb', idempotency_key: 'k-mine' }));
            const other = await call('GET', `/ops/${OP_ID}`);
            assert.deepEqual(other.body, { error: 'No such change.', code: 'NOT_FOUND' });
            assert.equal(other.statusCode, 404);
            for (const id of ['00000000-0000-4000-8000-0000000000ff', 'nope', '1', '00000000-0000-4000-8000-0000000000bb/../x']) {
                assert.equal((await call('GET', `/ops/${id}`)).statusCode, 404, id);
            }
            const mine = await call('GET', '/ops/00000000-0000-4000-8000-0000000000bb');
            assert.equal(mine.statusCode, 200);
            assert.equal(mine.body.op.id, '00000000-0000-4000-8000-0000000000bb');
            assert.equal(mine.body.op.state, 'pending');
        });

        it('an op as the screen gets it carries no payload (no exec, no token)', async () => {
            kit.configure();
            kit.ops.push(storedOp());
            const res = await call('GET', `/ops/${OP_ID}`);
            assert.equal('payload' in res.body.op, false);
            assert.doesNotMatch(JSON.stringify(res.body), /EAAB-token/);
        });

        it('GET /ops lists the tenant\'s unfinished ops by default, and the states asked for', async () => {
            kit.configure();
            kit.ops.push(
                storedOp({ idempotency_key: 'a' }),
                storedOp({ id: '00000000-0000-4000-8000-0000000000a2', state: 'verify', idempotency_key: 'b' }),
                storedOp({ id: '00000000-0000-4000-8000-0000000000a3', state: 'done', idempotency_key: 'c' }),
                storedOp({ id: '00000000-0000-4000-8000-0000000000a4', state: 'pending', creator_id: OTHER_TENANT, idempotency_key: 'd' }),
            );
            const open = await call('GET', '/ops');
            assert.deepEqual(open.body.ops.map((o: any) => o.state).sort(), ['pending', 'verify']);
            const finished = await call('GET', '/ops?state=done,failed');
            assert.deepEqual(finished.body.ops.map((o: any) => o.state), ['done']);
            const junk = await call('GET', '/ops?state=bogus,;DROP');
            assert.deepEqual(junk.body.ops.map((o: any) => o.state).sort(), ['pending', 'verify'], 'unknown states fall back to the open ones');
        });
    });

    describe('the error shape', () => {
        it('{ error, code } for a refusal without a field', async () => {
            kit.configure();
            const res = await call('GET', `/objects/${CAMPAIGN_ID}`);
            assert.deepEqual(Object.keys(res.body).sort(), ['code', 'error']);
            assert.equal(res.body.code, 'NOT_FOUND');
        });

        it('{ error, code, field } for a field refusal', async () => {
            kit.configure();
            kit.rows.push(objectRow());
            const res = await call('POST', `/objects/${CAMPAIGN_ID}/budget`, { body: { amount: -4 } });
            assert.equal(res.statusCode, 400);
            assert.deepEqual(Object.keys(res.body).sort(), ['code', 'error', 'field']);
            assert.deepEqual({ code: res.body.code, field: res.body.field }, { code: 'INVALID', field: 'amount' });
        });

        it('EDIT_LIMIT is 429 with field and retryAt as an ISO time', async () => {
            kit.configure();
            kit.rows.push(objectRow(), adsetRow());
            kit.editsUsed.set(ADSET_META, 4);
            const res = await call('POST', `/objects/${CAMPAIGN_ID}/budget`, { body: { amount: 3 } });
            assert.equal(res.statusCode, 429);
            assert.deepEqual({ code: res.body.code, field: res.body.field }, { code: 'EDIT_LIMIT', field: 'amount' });
            assert.ok(Math.abs(Date.parse(res.body.retryAt) - (Date.now() + 3_600_000)) < 60_000, res.body.retryAt);
            assert.equal(typeof res.body.error, 'string');
            assert.equal(kit.ops.length, 0);
        });

        it('OVER_MONTHLY_CAP on a resume is 400 with no op, and the month read is Meta\'s only (the stored copy does not stand in for it)', async () => {
            kit.configure();
            kit.spent.value = '95';
            kit.rows.push(objectRow());
            kit.setLive(CAMPAIGN_META, { daily_budget: '200', adsets: { data: [{ id: ADSET_META, status: 'PAUSED' }] } });
            const res = await call('POST', `/objects/${CAMPAIGN_ID}/status`, { body: { status: 'ACTIVE', confirm: true } });
            assert.deepEqual({ status: res.statusCode, code: res.body.code }, { status: 400, code: 'OVER_MONTHLY_CAP' });
            assert.equal(typeof res.body.error, 'string');
            assert.equal(kit.ops.length, 0);
        });

        it('a resume that fits answers 202 with the op, queued with its worst case', async () => {
            kit.configure();
            kit.rows.push(objectRow());
            kit.setLive(CAMPAIGN_META, { daily_budget: '200', adsets: { data: [{ id: ADSET_META, status: 'PAUSED' }] } });
            const res = await call('POST', `/objects/${CAMPAIGN_ID}/status`, { body: { status: 'ACTIVE', confirm: true, requestId: 'req-resume-01' } });
            assert.equal(res.statusCode, 202, JSON.stringify(res.body));
            assert.equal(res.body.op.kind, 'status');
            assert.equal(typeof kit.ops[0]!.payload['worst_case_delta'], 'number');
            await Promise.all(kit.waits);
        });

        it('an unexpected failure is 500 with a plain message and no internals', async () => {
            kit.configure();
            kit.rows.push(objectRow());
            kit.db.on(/^SELECT \* FROM ads_ops WHERE creator_id = \$1 AND state = ANY/, () => { throw new Error('connection refused to 10.0.0.1:5432'); });
            const res = await call('GET', '/ops');
            assert.equal(res.statusCode, 500);
            assert.deepEqual(Object.keys(res.body), ['error']);
            assert.doesNotMatch(res.body.error, /10\.0\.0\.1|refused/);
        });
    });
});
