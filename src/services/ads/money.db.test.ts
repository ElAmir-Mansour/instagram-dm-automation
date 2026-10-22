/**
 * The money rule against the database (research R7, tasks T009): two activations at once, each of which fits on its own, must not both
 * pass when together they exceed the cap. The fake pool (./testDb.ts) makes the advisory lock really wait and an op visible only once its
 * transaction commits, so this is the race as Postgres would run it: whoever takes the lock second sees the first's `running` op as
 * "about to run".
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installAdsFakeDb, type AdsFakeDb } from './testDb.js';
import { checkAndStartSpend, finishSpendOp, MoneyRefused, type MonthPicture } from './money.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ACC = '509787248064459';

const month = (over: Partial<Omit<MonthPicture, 'campaigns'>> = {}): Omit<MonthPicture, 'campaigns'> => ({ spentThisMonth: 50, othersRemaining: 0, readAt: new Date(), ...over });

const attempt = (objectKey: string, candidate: number, picture = month(), creatorId = TENANT) => checkAndStartSpend({
    creatorId, adAccountId: ACC, objectKey, kind: 'status', month: picture, candidate, monthlyCap: 100,
    payload: { to: 'ACTIVE' }, actor: { userId: null, via: 'owner' },
});

describe('checkAndStartSpend under the tenant lock', () => {
    let db: AdsFakeDb;
    beforeEach(() => { db = installAdsFakeDb(); });
    afterEach(() => db.restore());

    it('lets one of two concurrent activations through when together they pass the cap, and refuses the other with the numbers', async () => {
        const results = await Promise.allSettled([attempt('campaign-a', 30), attempt('campaign-b', 30)]);
        const ok = results.filter((r) => r.status === 'fulfilled');
        const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        assert.equal(ok.length, 1);
        assert.equal(refused.length, 1);
        assert.ok(refused[0]!.reason instanceof MoneyRefused);
        assert.equal(refused[0]!.reason.check.worstCase, 110);
        assert.equal(refused[0]!.reason.check.remaining, 20);
        assert.equal(db.ops.length, 1, 'only the one that fits is recorded');
        assert.equal(db.ops[0]!.payload['worst_case_delta'], 30);
        assert.equal(db.ran(/pg_advisory_xact_lock/).length, 2);
        assert.ok(db.ran(/pg_advisory_xact_lock/).every((s) => s.params[0] === `ads:${TENANT}`), 'the lock is ads:<tenant>');
    });

    it('lets both through when together they fit', async () => {
        const results = await Promise.allSettled([attempt('campaign-a', 20), attempt('campaign-b', 30)]);
        assert.ok(results.every((r) => r.status === 'fulfilled'));
        assert.equal(db.ops.length, 2);
    });

    it('still counts the first after it finished, when it finished after the second\'s month was read', async () => {
        const picture = month({ readAt: new Date() });
        const first = await attempt('campaign-a', 30);
        await finishSpendOp(TENANT, first.opId, 'done');
        await assert.rejects(attempt('campaign-b', 30, picture), MoneyRefused);
    });

    it('does not count an activation twice once a later month picture already includes it', async () => {
        const first = await attempt('campaign-a', 30);
        await finishSpendOp(TENANT, first.opId, 'done');
        db.ops[0]!.finished_at = new Date(Date.now() - 10 * 60_000);
        // The new picture was read after it was visible at Meta: its spend is in othersRemaining now.
        await attempt('campaign-b', 20, month({ othersRemaining: 30 }));
    });

    it('finishes an op only for its own tenant', async () => {
        const first = await attempt('campaign-a', 30);
        await finishSpendOp(OTHER, first.opId, 'failed');
        assert.equal(db.ops[0]!.state, 'running', 'another tenant cannot finish it');
        assert.ok(db.ran(/^UPDATE ads_ops .* WHERE id = \$1 AND creator_id = \$4/).length === 1);
        await finishSpendOp(TENANT, first.opId, 'failed');
        assert.equal(db.ops[0]!.state, 'failed');
    });

    it('keeps counting a call that may have landed (verify), and stops counting one that failed', async () => {
        const first = await attempt('campaign-a', 30);
        await finishSpendOp(TENANT, first.opId, 'verify');
        await assert.rejects(attempt('campaign-b', 30), MoneyRefused);
        await finishSpendOp(TENANT, first.opId, 'failed');
        await attempt('campaign-b', 30);
    });

    it('never counts another tenant, or the object being checked itself', async () => {
        await attempt('campaign-x', 40, month(), OTHER);
        await attempt('campaign-a', 30);
        // campaign-a again (a retry of the same activation) does not count its own earlier op against itself.
        await attempt('campaign-a', 30);
    });

    it('runs the caller\'s own writes inside the same locked transaction, and nothing is recorded when they throw', async () => {
        await assert.rejects(checkAndStartSpend({
            creatorId: TENANT, adAccountId: ACC, objectKey: 'campaign-a', kind: 'status', month: month(), candidate: 10, monthlyCap: 100,
            payload: {}, actor: { userId: null, via: 'owner' },
            inside: async () => { throw new Error('the boost changed meanwhile'); },
        }), /changed meanwhile/);
        assert.equal(db.ops.length, 0);
        assert.equal(db.ran(/^ROLLBACK$/).length, 1);
    });
});
