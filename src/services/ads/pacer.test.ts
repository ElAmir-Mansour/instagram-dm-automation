/**
 * The pacer (research R5): Meta's Limited tier gives an ad account about 60 points per 300 s and blocks it for 300 s when that is passed,
 * so the app keeps itself to 45 (25% headroom), counts a read as 1 and a write as 3, believes Meta's own `acc_id_util_pct` over its count
 * whenever Meta sends it, and stops calling until the time Meta named once it is throttled. Pure rules first, then the SQL with a fake pool.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import {
    budgetFor, blockUntilFor, canSpend, LIMITED_BUDGET, LIMITED_POINTS, nextAfterObserve, nextAfterReserve, POINTS, WINDOW_MS,
    block, observe, reserve, status, type PacerState,
} from './pacer.js';

const T0 = new Date('2026-10-22T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const fresh = (over: Partial<PacerState> = {}): PacerState => ({ scoreEstimate: 0, windowStartedAt: T0, blockedUntil: null, tier: null, ...over });

describe('the budget', () => {
    it('is 45 of the 60 Limited points per 300 s; a read costs 1 and a write 3', () => {
        assert.equal(LIMITED_POINTS, 60);
        assert.equal(LIMITED_BUDGET, 45);
        assert.equal(WINDOW_MS, 300_000);
        assert.deepEqual(POINTS, { read: 1, write: 3 });
        assert.equal(budgetFor(null), 45);
        assert.equal(budgetFor('development_access'), 45);
        assert.ok(budgetFor('standard_access') > 45, 'Standard access has far more room');
    });
});

describe('canSpend', () => {
    it('allows spending up to the budget inside one window, and not a point past it', () => {
        assert.equal(canSpend(fresh({ scoreEstimate: 42 }), 3, at(1000)), true);
        assert.equal(canSpend(fresh({ scoreEstimate: 43 }), 3, at(1000)), false);
    });

    it('starts a new window after 300 s, whatever was spent in the last', () => {
        assert.equal(canSpend(fresh({ scoreEstimate: 45 }), 3, at(WINDOW_MS + 1)), true);
    });

    it('is false while Meta has us blocked, even with an empty score, and true once the block is over', () => {
        const s = fresh({ blockedUntil: at(60_000) });
        assert.equal(canSpend(s, 1, at(59_000)), false);
        assert.equal(canSpend(s, 1, at(60_001)), true);
    });

    it('a priority call (the guard pausing campaigns) skips our own estimate but never Meta\'s block', () => {
        assert.equal(canSpend(fresh({ scoreEstimate: 45 }), 3, at(1000), { priority: true }), true);
        assert.equal(canSpend(fresh({ blockedUntil: at(5000) }), 3, at(1000), { priority: true }), false);
    });
});

describe('nextAfterReserve', () => {
    it('adds the points in the current window, and restarts the window when it is over', () => {
        assert.deepEqual(nextAfterReserve(fresh({ scoreEstimate: 10 }), 3, at(1000)), { scoreEstimate: 13, windowStartedAt: T0 });
        assert.deepEqual(nextAfterReserve(fresh({ scoreEstimate: 44 }), 1, at(WINDOW_MS + 5)), { scoreEstimate: 1, windowStartedAt: at(WINDOW_MS + 5) });
    });
});

describe('nextAfterObserve', () => {
    it('replaces the estimate with Meta\'s acc_id_util_pct (a percent of 60 points) when the header is there', () => {
        const next = nextAfterObserve(fresh({ scoreEstimate: 3 }), { adAccount: { utilPct: 50, resetSeconds: 0, tier: 'development_access' }, tier: 'development_access' }, at(1000));
        assert.equal(next.scoreEstimate, 30);
        assert.equal(next.tier, 'development_access');
    });

    it('keeps our own count when Meta sent no percentage (missing is not zero)', () => {
        assert.equal(nextAfterObserve(fresh({ scoreEstimate: 7 }), { adAccount: null, tier: null }, at(1000)).scoreEstimate, 7);
        assert.equal(nextAfterObserve(fresh({ scoreEstimate: 7 }), { adAccount: { utilPct: null, resetSeconds: null, tier: null }, tier: null }, at(1000)).scoreEstimate, 7);
    });
});

describe('blockUntilFor', () => {
    it('uses reset_time_duration (seconds), then estimated_time_to_regain_access (minutes), then 300 s', () => {
        assert.deepEqual(blockUntilFor({ adAccount: { utilPct: 100, resetSeconds: 90, tier: null }, regainMinutes: 10 }, T0), at(90_000));
        assert.deepEqual(blockUntilFor({ adAccount: null, regainMinutes: 10 }, T0), at(600_000));
        assert.deepEqual(blockUntilFor({ adAccount: { utilPct: 100, resetSeconds: 0, tier: null }, regainMinutes: 0 }, T0), at(300_000));
        assert.deepEqual(blockUntilFor({ adAccount: null, regainMinutes: null }, T0), at(300_000));
    });
});

// ─── The SQL ────────────────────────────────────────────────────────────────────────────────

describe('the ads_pacer row (fake pool)', () => {
    let db: FakeDb;
    let row: Record<string, any> | null;
    const ACC = '509787248064459';
    const TENANT = '11111111-1111-4111-8111-111111111111';

    beforeEach(() => {
        db = installFakeDb();
        row = null;
        db.routes.push(
            [/^SELECT score_estimate, window_started_at, blocked_until, last_usage FROM ads_pacer WHERE ad_account_id = \$1 FOR UPDATE$/, () => ({ rows: row ? [row] : [] })],
            [/^SELECT score_estimate, window_started_at, blocked_until, last_usage FROM ads_pacer WHERE ad_account_id = \$1$/, () => ({ rows: row ? [row] : [] })],
            [/^INSERT INTO ads_pacer/, (p) => {
                row = { ad_account_id: p[0], creator_id: p[1], score_estimate: String(p[2]), window_started_at: p[3], blocked_until: p[4], last_usage: JSON.parse(p[5]) };
                return { rows: [] };
            }],
        );
    });
    afterEach(() => db.restore());

    it('reserve writes the points and answers ok; past the budget it refuses with the time the window ends, and writes nothing', async () => {
        const a = await reserve(ACC, TENANT, 3, { now: at(1000) });
        assert.equal(a.ok, true);
        assert.equal(Number(row!.score_estimate), 3);
        row!.score_estimate = '44';
        const b = await reserve(ACC, TENANT, 3, { now: at(2000) });
        assert.equal(b.ok, false);
        assert.deepEqual(b.ok === false && b.retryAt, at(1000 + WINDOW_MS));
        assert.equal(Number(row!.score_estimate), 44);
        assert.ok(db.ran(/^BEGIN$/).length >= 2 && db.ran(/^COMMIT$/).length >= 1, 'each reserve is its own short transaction');
    });

    it('block stores Meta\'s time, and reserve then refuses until it', async () => {
        await block(ACC, TENANT, at(120_000), { now: at(0) });
        const s = await status(ACC);
        assert.deepEqual(s?.blockedUntil, at(120_000));
        const r = await reserve(ACC, TENANT, 1, { now: at(60_000) });
        assert.equal(r.ok, false);
        assert.deepEqual(r.ok === false && r.retryAt, at(120_000));
        assert.equal((await reserve(ACC, TENANT, 1, { now: at(120_001) })).ok, true);
    });

    it('observe keeps the raw headers, the tier and the served version', async () => {
        await observe(ACC, TENANT, { 'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 25, reset_time_duration: 0, ads_api_access_tier: 'development_access' }), 'facebook-api-version': 'v26.0' }, { now: at(0) });
        assert.equal(Number(row!.score_estimate), 15);
        assert.equal(row!.last_usage.tier, 'development_access');
        assert.equal(row!.last_usage.servedVersion, 'v26.0');
        assert.ok(row!.last_usage.adAccountUsage);
    });

    it('observe with no usage headers at all changes nothing', async () => {
        await observe(ACC, TENANT, {}, { now: at(0) });
        assert.equal(row, null);
    });
});
