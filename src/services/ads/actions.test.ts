/**
 * The owner's actions on stored objects (tasks T052, T054): `ownObject`'s tenant and account fence, pause / resume / budget / archive /
 * delete each becoming one `ads_ops` row, the money rule enqueuing INSIDE the locked transaction after the live month was read OUTSIDE it,
 * and a failed op as the error the v1 adapters show.
 *
 * Database and Meta are faked by ./objectsTestDb.ts: the statement timeline says what ran between BEGIN and COMMIT, `metaHttp` records
 * every Graph call (and marks it in that timeline), and `waitUntil` collects what the action handed over.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AdsError } from '../adBoosts.js';
import { pool } from '../../config/db.js';
import { withAdsContext } from './graph.js';
import { enqueueWrite, ownObject, refusalOf, requestArchive, requestBudget, requestDelete, requestStatus, type ActionContext } from './actions.js';
import type { OpView } from './ops.js';
import { ACC, ADSET_ID, ADSET_META, CAMPAIGN_ID, CAMPAIGN_META, OTHER_ACC, OTHER_TENANT, TENANT, adsetRow, indexOfSql, installObjectsKit, objectRow, type ObjectsKit } from './testing/objects/testDb.js';

/** 2026-10-22 10:00 UTC: 10 days (a day begun counts) left of the account's October. */
const NOW = new Date('2026-10-22T10:00:00Z');
const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({ creatorId: TENANT, actor: { userId: 'u1', role: 'owner', via: 'owner' }, requestId: 'press-000001', now: NOW, ...over });

/** Run `fn` the way the router does: with the tenant and its ad account as the Graph context. */
const inTenant = <T>(fn: () => Promise<T>): Promise<T> => withAdsContext({ creatorId: TENANT, adAccountId: ACC }, fn);

async function refused(promise: Promise<unknown>): Promise<AdsError> {
    try {
        await promise;
    } catch (err) {
        assert.ok(err instanceof AdsError, `expected an AdsError, got ${String(err)}`);
        return err;
    }
    assert.fail('expected the action to be refused');
}

const code = (e: AdsError) => ({ status: e.status, code: e.code, field: e.field });

describe('ads actions', () => {
    let kit: ObjectsKit;
    beforeEach(() => { kit = installObjectsKit(); });
    afterEach(() => kit.restore());

    describe('ownObject', () => {
        it('returns the row when the creator and the ad account match, by our id or by Meta\'s', async () => {
            kit.rows.push(objectRow());
            assert.equal((await ownObject(TENANT, ACC, CAMPAIGN_ID)).id, CAMPAIGN_ID);
            assert.equal((await ownObject(TENANT, ACC, CAMPAIGN_META)).id, CAMPAIGN_ID);
        });

        it('is 404 NOT_FOUND for another tenant\'s row', async () => {
            kit.rows.push(objectRow({ creatorId: OTHER_TENANT }));
            assert.deepEqual(code(await refused(ownObject(TENANT, ACC, CAMPAIGN_ID))), { status: 404, code: 'NOT_FOUND', field: undefined });
            assert.deepEqual(code(await refused(ownObject(TENANT, ACC, CAMPAIGN_META))), { status: 404, code: 'NOT_FOUND', field: undefined });
        });

        it('is 404 NOT_FOUND for a row of another ad account (the tenant switched away), and when no account is set', async () => {
            kit.rows.push(objectRow({ adAccountId: OTHER_ACC }));
            assert.equal((await refused(ownObject(TENANT, ACC, CAMPAIGN_ID))).code, 'NOT_FOUND');
            kit.rows[0] = objectRow();
            assert.equal((await refused(ownObject(TENANT, null, CAMPAIGN_ID))).code, 'NOT_FOUND');
        });

        it('is 404 NOT_FOUND for a missing row', async () => {
            assert.deepEqual(code(await refused(ownObject(TENANT, ACC, 'f0000000-0000-4000-8000-00000000ffff'))), { status: 404, code: 'NOT_FOUND', field: undefined });
            assert.equal((await refused(ownObject(TENANT, ACC, '999999'))).code, 'NOT_FOUND');
        });

        it('is 404 NOT_FOUND for a malformed id, without touching the database', async () => {
            for (const id of ['x', '', '../etc/passwd', 'a b c d e', "1; DROP TABLE ads_objects;--", 'a'.repeat(41), 12345, undefined, null, {}, ['a']]) {
                assert.equal((await refused(ownObject(TENANT, ACC, id))).code, 'NOT_FOUND', String(id));
            }
            assert.equal(kit.db.ran(/FROM ads_objects/).length, 0);
        });
    });

    describe('requestStatus PAUSED', () => {
        it('enqueues a status op with the exec and an idempotency key, and makes no Graph call before it', async () => {
            const row = objectRow({ status: 'ACTIVE', effectiveStatus: 'ACTIVE' });
            kit.configure();
            const op = await inTenant(() => requestStatus(ctx(), row, 'PAUSED', undefined));
            assert.deepEqual({ kind: op.kind, state: op.state, objectKey: op.objectKey, actorVia: op.actorVia }, { kind: 'status', state: 'pending', objectKey: CAMPAIGN_ID, actorVia: 'owner' });
            assert.equal(kit.ops.length, 1);
            const stored = kit.ops[0]!;
            assert.deepEqual(stored.payload['exec'], { method: 'POST', path: CAMPAIGN_META, params: { status: 'PAUSED' } });
            assert.equal(stored.idempotency_key, `${TENANT}:status:${CAMPAIGN_ID}:{"status":"PAUSED"}:press-000001`);
            assert.equal(stored.ad_account_id, ACC);
            assert.equal('worst_case_delta' in stored.payload, false, 'pausing is never counted as spend');
            assert.equal(kit.meta.length, 0, 'no Graph call from the action itself');
            assert.equal(kit.db.ran(/pg_advisory_xact_lock/).length, 0, 'no money transaction for a pause');
            assert.equal(kit.waits.length, 1, 'the inline attempt is handed to waitUntil');
            await Promise.all(kit.waits);
            assert.equal(kit.meta.length, 0, 'and the attempt finds nothing claimable in this fake');
        });

        it('a second press with the same requestId is the same op, not a second row; a new one is a new op', async () => {
            const row = objectRow({ status: 'ACTIVE' });
            kit.configure();
            const first = await requestStatus(ctx(), row, 'PAUSED', undefined);
            const again = await requestStatus(ctx(), row, 'PAUSED', undefined);
            assert.equal(again.id, first.id);
            assert.equal(kit.ops.length, 1);
            const other = await requestStatus(ctx({ requestId: 'press-000002' }), row, 'PAUSED', undefined);
            assert.notEqual(other.id, first.id);
            assert.equal(kit.ops.length, 2);
        });

        it('without a requestId (or a malformed one) the key is a 10-second bucket of the time', async () => {
            const row = objectRow({ status: 'ACTIVE' });
            kit.configure();
            await requestStatus(ctx({ requestId: null }), row, 'PAUSED', undefined);
            await requestStatus(ctx({ requestId: 'x y!' }), row, 'PAUSED', undefined);
            assert.equal(kit.ops.length, 1, 'both fall to the same bucket');
            assert.match(kit.ops[0]!.idempotency_key!, new RegExp(`:t${Math.floor(NOW.getTime() / 10_000)}$`));
        });

        it('is for this tenant: the key starts with the creator id', async () => {
            kit.configure();
            await requestStatus(ctx(), objectRow({ status: 'ACTIVE' }), 'PAUSED', undefined);
            assert.ok(kit.ops[0]!.idempotency_key!.startsWith(`${TENANT}:`));
            assert.equal(kit.ops[0]!.creator_id, TENANT);
        });

        it('is refused before anything is queued: a bad status, a creative, an ended object, a tenant that is not set up', async () => {
            kit.configure();
            assert.deepEqual(code(await refused(requestStatus(ctx(), objectRow(), 'RUNNING', true))), { status: 400, code: 'INVALID', field: 'status' });
            assert.equal((await refused(requestStatus(ctx(), objectRow({ level: 'creative' }), 'PAUSED', true))).status, 409);
            assert.equal((await refused(requestStatus(ctx(), objectRow({ metaId: null }), 'PAUSED', true))).status, 409);
            assert.equal((await refused(requestStatus(ctx(), objectRow({ status: 'ARCHIVED' }), 'PAUSED', true))).status, 409);
            assert.equal((await refused(requestStatus(ctx(), objectRow({ status: 'DELETED' }), 'ACTIVE', true))).status, 409);
            kit.settings.delete(`ads.token.${TENANT}`);
            assert.deepEqual(code(await refused(requestStatus(ctx(), objectRow(), 'PAUSED', undefined))), { status: 409, code: 'ADS_NOT_CONFIGURED', field: undefined });
            assert.equal(kit.ops.length, 0);
        });
    });

    describe('requestStatus ACTIVE', () => {
        const campaign = (over: Record<string, unknown> = {}) => kit.setLive(CAMPAIGN_META, { daily_budget: '200', adsets: { data: [{ id: ADSET_META, status: 'PAUSED' }] }, ...over });

        it('is refused without confirm (400 INVALID field confirm): nothing read, nothing queued', async () => {
            kit.configure();
            for (const confirm of [undefined, false, 'true', 1, null]) {
                assert.deepEqual(code(await refused(inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', confirm)))), { status: 400, code: 'INVALID', field: 'confirm' }, String(confirm));
            }
            assert.equal(kit.meta.length, 0);
            assert.equal(kit.ops.length, 0);
            assert.equal(kit.db.ran(/pg_advisory_xact_lock/).length, 0);
        });

        it('is refused with PAYMENT_METHOD_MISSING when the stored health says there is no payment method (after confirm, before Meta)', async () => {
            kit.configure({ hasPaymentMethod: false });
            assert.deepEqual(code(await refused(inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', true)))), { status: 409, code: 'PAYMENT_METHOD_MISSING', field: undefined });
            assert.equal(kit.meta.length, 0);
            assert.equal(kit.ops.length, 0);
            // confirm is asked first: an unconfirmed request is not told about the payment method
            assert.equal((await refused(inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', undefined)))).code, 'INVALID');
        });

        it('a payment method that is not known (null) does not stop it', async () => {
            kit.configure({ hasPaymentMethod: null });
            campaign();
            const op = await inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', true));
            assert.equal(op.kind, 'status');
        });

        it('reads the live month OUTSIDE a transaction and enqueues INSIDE the locked one, with worst_case_delta in the payload', async () => {
            kit.configure();
            campaign();
            const op = await inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', true));

            // The Graph reads: the campaign, then the account's month (insights + campaigns), all before BEGIN.
            const urls = kit.meta.map((c) => c.url);
            assert.ok(urls.some((u) => u.endsWith(`/${CAMPAIGN_META}`)), 'the live campaign');
            assert.ok(urls.some((u) => u.endsWith(`/act_${ACC}/insights`)) && urls.some((u) => u.endsWith(`/act_${ACC}/campaigns`)), 'the live month');
            assert.equal(kit.meta.every((c) => c.method === 'GET'), true);
            assert.equal(kit.db.markedInsideTransaction(`graph GET ${urls[0]}`), false);
            for (const c of kit.meta) assert.equal(kit.db.markedInsideTransaction(`graph ${c.method} ${c.url}`), false, `${c.url} was called inside a transaction`);

            const tl = kit.db.timeline();
            const lastGraph = tl.map((s, i) => (s.startsWith('-- graph') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
            const lock = indexOfSql(kit.db, 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
            const begin = tl.lastIndexOf('BEGIN', lock); // the pacer's own short transactions come earlier; this one is the money lock's
            const about = indexOfSql(kit.db, /^SELECT COALESCE\(SUM\(\(payload->>'worst_case_delta'\)/);
            const insert = indexOfSql(kit.db, /^INSERT INTO ads_ops /);
            const commit = tl.indexOf('COMMIT', lock);
            assert.ok(lastGraph >= 0 && begin > lastGraph, 'BEGIN comes after the last Graph read');
            assert.ok(begin < lock && lock < about && about < insert && insert < commit, `order: ${[begin, lock, about, insert, commit].join(' < ')}`);
            assert.equal(kit.db.ran(/^INSERT INTO ads_ops /).length, 1, 'one op row');
            assert.deepEqual(kit.db.statements.find((s) => s.sql === 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))')!.params, [`ads:${TENANT}`]);

            // The op: pending, the exec and the delta (2 USD a day, 10 days left: 2 * (1.75 + 9) = 21.5).
            assert.equal(kit.ops.length, 1);
            const stored = kit.ops[0]!;
            assert.equal(op.id, stored.id);
            assert.equal(stored.kind, 'status');
            assert.equal(stored.state, 'pending');
            assert.equal(stored.payload['worst_case_delta'], 21.5);
            assert.equal(stored.payload['to'], 'ACTIVE');
            assert.equal(stored.payload['campaign_id'], CAMPAIGN_META);
            assert.deepEqual(stored.payload['exec'], { method: 'POST', path: CAMPAIGN_META, params: { status: 'ACTIVE' } });
            assert.equal(stored.idempotency_key, `${TENANT}:status:${CAMPAIGN_ID}:ACTIVE:press-000001`);
            assert.equal(kit.waits.length, 1, 'then handed to waitUntil');
            await Promise.all(kit.waits);
        });

        it('switching on an ad set counts the whole campaign above it and writes to the ad set', async () => {
            kit.configure();
            kit.rows.push(objectRow(), adsetRow());
            campaign();
            await inTenant(() => requestStatus(ctx(), adsetRow(), 'ACTIVE', true));
            const stored = kit.ops[0]!;
            assert.equal(stored.object_key, ADSET_ID);
            assert.equal(stored.payload['campaign_id'], CAMPAIGN_META);
            assert.deepEqual(stored.payload['exec'], { method: 'POST', path: ADSET_META, params: { status: 'ACTIVE' } });
            assert.ok(kit.meta.some((c) => c.url.endsWith(`/${CAMPAIGN_META}`)), 'the campaign is the one read');
            assert.equal(stored.payload['worst_case_delta'], 21.5);
        });

        it('a candidate over the monthly cap is 400 OVER_MONTHLY_CAP, rolled back, and no op is made', async () => {
            kit.configure();
            kit.spent.value = '95';
            campaign();
            const err = await refused(inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', true)));
            assert.deepEqual(code(err), { status: 400, code: 'OVER_MONTHLY_CAP', field: undefined });
            assert.match(err.message, /monthly cap of 100/);
            assert.equal(kit.ops.length, 0);
            assert.equal(kit.db.ran(/^INSERT INTO ads_ops /).length, 0);
            const afterLock = kit.db.timeline().slice(indexOfSql(kit.db, /pg_advisory_xact_lock/));
            assert.ok(afterLock.includes('ROLLBACK') && !afterLock.includes('COMMIT'), 'the locked transaction was rolled back');
            assert.equal(kit.waits.length, 0);
        });

        it('counts what is already about to run: a pending spend op can make the candidate not fit', async () => {
            kit.configure();
            campaign();
            kit.aboutToRun.total = 40; // 50 spent + 40 about to run + 21.5 > 100
            assert.equal((await refused(inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', true)))).code, 'OVER_MONTHLY_CAP');
            kit.aboutToRun.total = 20; // 50 + 20 + 21.5 = 91.5
            await inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', true));
            assert.equal(kit.ops.length, 1);
        });

        it('a daily budget over the max daily budget is 400 OVER_DAILY_MAX before the month is read or any lock is taken', async () => {
            kit.configure();
            campaign({ daily_budget: '3000' });
            assert.deepEqual(code(await refused(inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', true)))), { status: 400, code: 'OVER_DAILY_MAX', field: undefined });
            assert.equal(kit.meta.length, 1, 'only the campaign was read');
            assert.equal(kit.db.ran(/pg_advisory_xact_lock/).length, 0);
        });

        it('is 404 when the live campaign belongs to another ad account', async () => {
            kit.configure();
            campaign({ account_id: OTHER_ACC });
            assert.equal((await refused(inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', true)))).code, 'NOT_FOUND');
            assert.equal(kit.ops.length, 0);
        });

        it('an ad set whose campaign is not stored yet is asked to refresh', async () => {
            kit.configure();
            const err = await refused(inTenant(() => requestStatus(ctx(), adsetRow(), 'ACTIVE', true)));
            assert.equal(err.status, 409);
            assert.match(err.message, /refresh/);
            assert.equal(kit.meta.length, 0);
        });

        it('a replayed press returns the op it already made, with no second row', async () => {
            kit.configure();
            campaign();
            const first = await inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', true));
            const again = await inTenant(() => requestStatus(ctx(), objectRow(), 'ACTIVE', true));
            assert.equal(again.id, first.id);
            assert.equal(kit.ops.length, 1);
        });
    });

    describe('requestBudget', () => {
        const running = { status: 'ACTIVE', effectiveStatus: 'ACTIVE' };
        const liveRunning = (over: Record<string, unknown> = {}) => kit.setLive(CAMPAIGN_META, { status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '500', adsets: { data: [{ id: ADSET_META, status: 'ACTIVE' }] }, ...over });

        it('a cut enqueues a budget op as it is: no confirm, no money rule, no Meta read, no transaction', async () => {
            kit.configure();
            kit.rows.push(adsetRow());
            const { op, endOp } = await requestBudget(ctx(), objectRow({ ...running }), { amount: 3 });
            assert.equal(endOp, null);
            assert.equal(op.kind, 'budget');
            const stored = kit.ops[0]!;
            assert.deepEqual(stored.payload['exec'], { method: 'POST', path: CAMPAIGN_META, params: { daily_budget: 300 } });
            assert.equal(stored.payload['adsetMetaId'], ADSET_META, 'the 4-an-hour rule counts on the single ad set under a campaign budget');
            assert.equal('worst_case_delta' in stored.payload, false);
            assert.equal(kit.meta.length, 0);
            assert.equal(kit.db.ran(/pg_advisory_xact_lock/).length, 0);
            assert.equal(stored.idempotency_key, `${TENANT}:budget:${CAMPAIGN_ID}:{"daily_budget":300}:press-000001`);
        });

        it('an equal amount is not a raise: it needs no confirm either', async () => {
            kit.configure();
            kit.rows.push(adsetRow());
            await requestBudget(ctx(), objectRow({ ...running }), { amount: 5 });
            assert.equal(kit.ops.length, 1);
        });

        it('a raise on a PAUSED object needs no confirm and no money rule (it spends nothing yet)', async () => {
            kit.configure();
            kit.rows.push(adsetRow());
            await requestBudget(ctx(), objectRow(), { amount: 9 });
            assert.equal(kit.ops.length, 1);
            assert.equal('worst_case_delta' in kit.ops[0]!.payload, false);
            assert.equal(kit.meta.length, 0);
        });

        it('a raise on an ACTIVE object needs confirm (400 INVALID field confirm), before any Meta call', async () => {
            kit.configure();
            kit.rows.push(adsetRow());
            for (const confirm of [undefined, false, 'yes']) {
                assert.deepEqual(code(await refused(inTenant(() => requestBudget(ctx(), objectRow({ ...running }), { amount: 8, confirm })))), { status: 400, code: 'INVALID', field: 'confirm' });
            }
            assert.equal(kit.ops.length, 0);
            assert.equal(kit.meta.length, 0);
        });

        it('a confirmed raise on an ACTIVE object runs the money rule: live read outside, the op enqueued inside the lock with the extra as the delta', async () => {
            kit.configure();
            kit.spent.value = '10';
            kit.rows.push(adsetRow());
            liveRunning();
            const { op } = await inTenant(() => requestBudget(ctx(), objectRow({ ...running }), { amount: 8, confirm: true }));
            assert.equal(op.kind, 'budget');
            for (const c of kit.meta) assert.equal(kit.db.markedInsideTransaction(`graph ${c.method} ${c.url}`), false);
            const lock = indexOfSql(kit.db, 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
            const begin = kit.db.timeline().lastIndexOf('BEGIN', lock);
            const insert = indexOfSql(kit.db, /^INSERT INTO ads_ops /);
            const commit = kit.db.timeline().indexOf('COMMIT', lock);
            assert.ok(begin >= 0 && begin < lock && lock < insert && insert < commit, 'lock, then the op row, then COMMIT, in one transaction');
            const lastGraph = Math.max(...kit.db.timeline().map((q, i) => (q.startsWith('-- graph') ? i : -1)));
            assert.ok(lastGraph < begin, 'every Graph read is before the money transaction');
            const stored = kit.ops[0]!;
            // 5 USD a day over 10 days left: 53.75 now; 8 USD: 86; the raise adds 32.25. 10 spent + 53.75 + 32.25 = 96 <= 100.
            assert.equal(stored.payload['worst_case_delta'], 32.25);
            assert.deepEqual(stored.payload['exec'], { method: 'POST', path: CAMPAIGN_META, params: { daily_budget: 800 } });
            assert.equal(stored.payload['adsetMetaId'], ADSET_META);
            assert.equal(stored.payload['campaign_id'], CAMPAIGN_META);
            assert.equal(stored.payload['tz'], 'UTC');
            assert.equal(stored.kind, 'budget');
        });

        it('a confirmed raise that does not fit the monthly cap is 400 OVER_MONTHLY_CAP and makes no op', async () => {
            kit.configure();
            kit.spent.value = '20'; // 20 + 53.75 + 32.25 = 106 > 100
            kit.rows.push(adsetRow());
            liveRunning();
            const err = await refused(inTenant(() => requestBudget(ctx(), objectRow({ ...running }), { amount: 8, confirm: true })));
            assert.equal(err.code, 'OVER_MONTHLY_CAP');
            assert.equal(kit.ops.length, 0);
            assert.ok(kit.db.timeline().includes('ROLLBACK'));
        });

        it('is refused with PAYMENT_METHOD_MISSING on a confirmed raise when Meta has no payment method', async () => {
            kit.configure({ hasPaymentMethod: false });
            kit.rows.push(adsetRow());
            assert.equal((await refused(inTenant(() => requestBudget(ctx(), objectRow({ ...running }), { amount: 8, confirm: true })))).code, 'PAYMENT_METHOD_MISSING');
        });

        it('EDIT_LIMIT: 429 with retryAt (an hour on) when the ad set has no budget edits left this hour', async () => {
            kit.configure();
            kit.rows.push(adsetRow());
            kit.editsUsed.set(ADSET_META, 4);
            const err = await refused(requestBudget(ctx(), objectRow(), { amount: 3 }));
            assert.deepEqual(code(err), { status: 429, code: 'EDIT_LIMIT', field: 'amount' });
            assert.equal(err.extra.retryAt?.toISOString(), new Date(NOW.getTime() + 3_600_000).toISOString());
            assert.equal(kit.ops.length, 0);
            // three used: one left, so it goes through
            kit.editsUsed.set(ADSET_META, 3);
            await requestBudget(ctx(), objectRow(), { amount: 3 });
            assert.equal(kit.ops.length, 1);
        });

        it('EDIT_LIMIT on an ad set counts that ad set itself', async () => {
            kit.configure();
            kit.editsUsed.set(ADSET_META, 4);
            assert.equal((await refused(requestBudget(ctx(), adsetRow(), { amount: 3 }))).code, 'EDIT_LIMIT');
            kit.editsUsed.clear();
            await requestBudget(ctx(), adsetRow(), { amount: 3 });
            assert.equal(kit.ops[0]!.payload['adsetMetaId'], ADSET_META);
        });

        it('an end date on a campaign is refused (it is set on an ad set)', async () => {
            kit.configure();
            kit.rows.push(adsetRow());
            const err = await refused(requestBudget(ctx(), objectRow(), { amount: 3, endTime: '2026-11-30T00:00:00Z' }));
            assert.deepEqual(code(err), { status: 400, code: 'INVALID', field: 'endTime' });
            assert.equal(kit.ops.length, 0);
        });

        it('an end date less than an hour away, or not a date, is refused', async () => {
            kit.configure();
            for (const endTime of ['2026-10-22T10:30:00Z', '2026-10-01T00:00:00Z', 'tomorrow-ish', 12345]) {
                assert.deepEqual(code(await refused(requestBudget(ctx(), adsetRow(), { amount: 3, endTime }))), { status: 400, code: 'INVALID', field: 'endTime' }, String(endTime));
            }
            assert.equal(kit.ops.length, 0);
        });

        it('an end date on an ad set queues a second op, an update with end_time', async () => {
            kit.configure();
            const { op, endOp } = await requestBudget(ctx(), adsetRow(), { amount: 3, endTime: '2026-11-05T12:00:00Z' });
            assert.equal(op.kind, 'budget');
            assert.equal(endOp?.kind, 'update');
            assert.equal(kit.ops.length, 2);
            assert.deepEqual(kit.ops[1]!.payload['exec'], { method: 'POST', path: ADSET_META, params: { end_time: '2026-11-05T12:00:00+0000' } });
        });

        it('OVER_DAILY_MAX: a daily amount over the max, and a lifetime amount whose average a day is over it', async () => {
            kit.configure(); // max 20 a day
            const daily = await refused(requestBudget(ctx(), objectRow(), { amount: 25 }));
            assert.deepEqual(code(daily), { status: 400, code: 'OVER_DAILY_MAX', field: 'amount' });
            const lifetime = objectRow({ budgetKind: 'lifetime', budgetAmount: 100, startTime: '2026-10-20T00:00:00Z', endTime: '2026-10-30T00:00:00Z' });
            assert.equal((await refused(requestBudget(ctx(), lifetime, { amount: 300 }))).code, 'OVER_DAILY_MAX'); // 300 / 10 days = 30
            assert.equal(kit.ops.length, 0);
            await requestBudget(ctx(), lifetime, { amount: 150 }); // 15 a day
            assert.deepEqual(kit.ops[0]!.payload['exec'], { method: 'POST', path: CAMPAIGN_META, params: { lifetime_budget: 15000 } });
        });

        it('refuses what has no budget to edit, a different kind, and an amount that is not above 0', async () => {
            kit.configure();
            assert.equal((await refused(requestBudget(ctx(), objectRow({ budgetKind: 'none' }), { amount: 3 }))).code, 'BUDGET_NOT_EDITABLE');
            assert.equal((await refused(requestBudget(ctx(), objectRow({ level: 'ad' }), { amount: 3 }))).code, 'BUDGET_NOT_EDITABLE');
            assert.deepEqual(code(await refused(requestBudget(ctx(), objectRow(), { kind: 'lifetime', amount: 3 }))), { status: 400, code: 'INVALID', field: 'kind' });
            for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined, 0.004]) {
                assert.deepEqual(code(await refused(requestBudget(ctx(), objectRow(), { amount }))), { status: 400, code: 'INVALID', field: 'amount' }, String(amount));
            }
            assert.equal(kit.ops.length, 0);
        });
    });

    describe('requestDelete and requestArchive', () => {
        it('delete is refused without confirm, whatever the object', async () => {
            kit.configure();
            for (const confirm of [undefined, false, 'true', 1]) {
                assert.deepEqual(code(await refused(requestDelete(ctx(), objectRow(), confirm))), { status: 400, code: 'INVALID', field: 'confirm' });
            }
            assert.equal(kit.ops.length, 0);
        });

        it('delete is refused with CAMPAIGN_ACTIVE on an ACTIVE object, by its status or its effective status', async () => {
            kit.configure();
            assert.deepEqual(code(await refused(requestDelete(ctx(), objectRow({ status: 'ACTIVE', effectiveStatus: 'ACTIVE' }), true))), { status: 409, code: 'CAMPAIGN_ACTIVE', field: undefined });
            assert.equal((await refused(requestDelete(ctx(), objectRow({ status: 'PAUSED', effectiveStatus: 'ACTIVE' }), true))).code, 'CAMPAIGN_ACTIVE');
            assert.equal(kit.ops.length, 0);
        });

        it('delete enqueues a DELETE op with no params otherwise', async () => {
            kit.configure();
            const op = await requestDelete(ctx(), objectRow(), true);
            assert.equal(op.kind, 'delete');
            assert.deepEqual(kit.ops[0]!.payload['exec'], { method: 'DELETE', path: CAMPAIGN_META });
            assert.equal(kit.ops[0]!.object_key, CAMPAIGN_ID);
            assert.equal(kit.meta.length, 0);
            await requestDelete(ctx({ requestId: 'press-000002' }), objectRow({ status: 'ARCHIVED', effectiveStatus: 'ARCHIVED' }), true);
            assert.equal(kit.ops.length, 2, 'an archived object can be deleted');
        });

        it('delete is refused for a creative, an object with no Meta id, an object already deleted, and a tenant not set up', async () => {
            kit.configure();
            assert.equal((await refused(requestDelete(ctx(), objectRow({ level: 'creative' }), true))).status, 409);
            assert.equal((await refused(requestDelete(ctx(), objectRow({ metaId: null }), true))).status, 409);
            assert.equal((await refused(requestDelete(ctx(), objectRow({ status: 'DELETED', effectiveStatus: 'DELETED' }), true))).status, 409);
            kit.settings.delete(`ads.settings.${TENANT}`);
            assert.equal((await refused(requestDelete(ctx(), objectRow(), true))).code, 'ADS_NOT_CONFIGURED');
            assert.equal(kit.ops.length, 0);
        });

        it('archive enqueues a status op to ARCHIVED, also on a running object (no confirm needed: it stops spend)', async () => {
            kit.configure();
            const op = await requestArchive(ctx(), objectRow({ status: 'ACTIVE', effectiveStatus: 'ACTIVE' }));
            assert.equal(op.kind, 'archive');
            assert.deepEqual(kit.ops[0]!.payload['exec'], { method: 'POST', path: CAMPAIGN_META, params: { status: 'ARCHIVED' } });
            assert.equal(kit.meta.length, 0);
        });

        it('archive is refused for a creative, an ended object and a tenant not set up', async () => {
            kit.configure();
            assert.equal((await refused(requestArchive(ctx(), objectRow({ level: 'creative' })))).status, 409);
            assert.equal((await refused(requestArchive(ctx(), objectRow({ status: 'ARCHIVED' })))).status, 409);
            assert.equal((await refused(requestArchive(ctx(), objectRow({ status: 'DELETED' })))).status, 409);
            kit.settings.delete(`ads.token.${TENANT}`);
            assert.equal((await refused(requestArchive(ctx(), objectRow()))).code, 'ADS_NOT_CONFIGURED');
            assert.equal(kit.ops.length, 0);
        });
    });

    describe('enqueueWrite and how an op is kicked', () => {
        it('inside a caller\'s transaction it only enqueues: nothing is handed to waitUntil', async () => {
            const exec = { query: (sql: string, params?: unknown[]) => (pool as any).query(sql, params) };
            const op = await enqueueWrite(ctx(), ACC, { objectKey: CAMPAIGN_ID, kind: 'status', metaId: CAMPAIGN_META, params: { status: 'PAUSED' } }, exec as any);
            assert.equal(op.state, 'pending');
            assert.equal(kit.ops.length, 1);
            assert.equal(kit.waits.length, 0);
        });

        it('with wait: true the inline attempt is awaited (not handed over) and the op comes back as it now stands', async () => {
            kit.configure();
            kit.onInline.fn = (op) => { op.state = 'failed'; op.result = { code: 'EDIT_LIMIT', message: 'Too many edits', retryAt: '2026-10-22T11:00:00.000Z' }; };
            const op = await requestStatus(ctx({ wait: true }), objectRow({ status: 'ACTIVE' }), 'PAUSED', undefined);
            assert.equal(kit.waits.length, 0);
            assert.equal(op.state, 'failed');
            const e = refusalOf(op)!;
            assert.deepEqual({ status: e.status, code: e.code, message: e.message }, { status: 429, code: 'EDIT_LIMIT', message: 'Too many edits' });
        });

        it('without wait the op is answered as queued and the attempt is under waitUntil', async () => {
            kit.configure();
            const op = await requestArchive(ctx(), objectRow());
            assert.equal(op.state, 'pending');
            assert.equal(kit.waits.length, 1);
        });
    });

    describe('refusalOf', () => {
        const view = (state: OpView['state'], result: OpView['result']): OpView => ({
            id: 'op-1', kind: 'status', state, objectKey: CAMPAIGN_ID, notBefore: NOW.toISOString(), attempts: 1, result, createdAt: NOW.toISOString(), finishedAt: null, actorVia: 'owner',
        });

        it('is null unless the op failed', () => {
            for (const state of ['pending', 'running', 'verify', 'done', 'cancelled'] as const) assert.equal(refusalOf(view(state, { code: 'EDIT_LIMIT' })), null, state);
        });

        it('maps EDIT_LIMIT to 429 with Meta\'s message and retryAt', () => {
            const e = refusalOf(view('failed', { code: 'EDIT_LIMIT', message: 'You can change this 4 times an hour.', retryAt: '2026-10-22T11:00:00.000Z' }))!;
            assert.deepEqual({ status: e.status, code: e.code, message: e.message }, { status: 429, code: 'EDIT_LIMIT', message: 'You can change this 4 times an hour.' });
            assert.equal(e.extra.retryAt?.toISOString(), '2026-10-22T11:00:00.000Z');
            assert.equal(refusalOf(view('failed', { code: 'EDIT_LIMIT' }))!.extra.retryAt, null, 'no time given');
        });

        it('maps TOKEN_INVALID to 409 on the token field, without Meta\'s own text', () => {
            const e = refusalOf(view('failed', { code: 'TOKEN_INVALID', message: 'Error validating access token: EAAB-secret' }))!;
            assert.deepEqual({ status: e.status, code: e.code, field: e.field }, { status: 409, code: 'TOKEN_INVALID', field: 'token' });
            assert.doesNotMatch(e.message, /EAAB/);
        });

        it('maps anything else to 502 META_ERROR with the message, Meta\'s numeric code and subcode', () => {
            const e = refusalOf(view('failed', { code: 100, subcode: 1487225, message: 'Invalid parameter' }))!;
            assert.deepEqual({ status: e.status, code: e.code, message: e.message, metaCode: e.metaCode, subcode: e.extra.metaSubcode }, { status: 502, code: 'META_ERROR', message: 'Invalid parameter', metaCode: 100, subcode: 1487225 });
            const bare = refusalOf(view('failed', null))!;
            assert.deepEqual({ status: bare.status, code: bare.code, message: bare.message, metaCode: bare.metaCode }, { status: 502, code: 'META_ERROR', message: 'Meta refused the change.', metaCode: undefined });
            assert.equal(refusalOf(view('failed', { code: 'SOMETHING', message: 7 }))!.code, 'META_ERROR');
        });
    });
});
