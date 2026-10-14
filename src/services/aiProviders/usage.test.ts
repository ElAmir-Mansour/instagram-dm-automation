/**
 * `ai_usage` and the budgets (P20c): refusal at, under and over each limit, the reservation that makes check-and-insert one step, and
 * what two calls racing past a budget do. Against the stand-in in testDb.ts, which keeps Postgres's READ COMMITTED visibility and a real
 * advisory-lock mutex, so that "both calls read the same total and both pass" is what happens when the lock is missing and not what
 * happens with it.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import type { Budgets } from './settings.js';
import { AiError } from '../llm/errors.js';
import {
    ABANDONED_AFTER_MS, BudgetRefused, billedOfError, dayStart, firstReached, getUsageSummary, monthStart, recordCall, recordKeyCheck, reserveCall,
    settleCall, type ReserveArgs,
} from './usage.js';
import { installAiDb, type AiDb } from './testDb.js';

const TENANT = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';

const NO_BUDGET: Budgets = { dailyUsd: null, monthlyUsd: null, tenantDailyUsd: null, tenantMonthlyUsd: null };
const budgets = (over: Partial<Budgets>): Budgets => ({ ...NO_BUDGET, ...over });

let db: AiDb;
let logs: { level: string; line: string }[];
let restoreSink: (() => void) | undefined;
const NOW = new Date('2026-10-14T12:00:00.000Z');

beforeEach(() => {
    db = installAiDb();
    db.now = new Date(NOW);
    logs = [];
    const previous = setLogSink((level, line) => { logs.push({ level, line }); });
    restoreSink = () => setLogSink(previous);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

const reserve = (over: Partial<ReserveArgs> = {}) => reserveCall({
    creatorId: TENANT, purpose: 'onboarding_draft', provider: 'anthropic', model: 'claude-opus-5-5', estimateUsd: 0.1, priced: true,
    budgets: NO_BUDGET, now: NOW, ...over,
});

async function refusal(promise: Promise<unknown>): Promise<BudgetRefused> {
    try {
        await promise;
    } catch (err) {
        assert.ok(err instanceof BudgetRefused, `expected a BudgetRefused, got ${String(err)}`);
        return err;
    }
    return assert.fail('expected a refusal');
}

describe('periods', () => {
    it('are UTC days and months', () => {
        assert.equal(dayStart(new Date('2026-10-14T23:59:59.999Z')).toISOString(), '2026-10-14T00:00:00.000Z');
        assert.equal(dayStart(new Date('2026-10-15T00:00:00.000Z')).toISOString(), '2026-10-15T00:00:00.000Z');
        assert.equal(monthStart(new Date('2026-10-14T12:00:00Z')).toISOString(), '2026-10-01T00:00:00.000Z');
        assert.equal(monthStart(new Date('2026-12-31T23:00:00Z')).toISOString(), '2026-12-01T00:00:00.000Z');
    });
});

describe('firstReached: a limit is reached when the spend has got to it', () => {
    const spend = { globalDay: 0, globalMonth: 0, tenantDay: 0, tenantMonth: 0 };

    it('refuses AT the limit, allows UNDER it, refuses OVER it', () => {
        const limit = budgets({ dailyUsd: 5 });
        assert.equal(firstReached({ ...spend, globalDay: 4.999999 }, limit, true), null, 'under');
        assert.deepEqual(firstReached({ ...spend, globalDay: 5 }, limit, true), { scope: 'global_day', spent: 5, limit: 5 }, 'at');
        assert.deepEqual(firstReached({ ...spend, globalDay: 7.25 }, limit, true), { scope: 'global_day', spent: 7.25, limit: 5 }, 'over');
    });

    it('treats an unset budget as no limit and a budget of 0 as "refuse everything"', () => {
        assert.equal(firstReached({ globalDay: 1e9, globalMonth: 1e9, tenantDay: 1e9, tenantMonth: 1e9 }, NO_BUDGET, true), null);
        assert.equal(firstReached(spend, budgets({ tenantDailyUsd: 0 }), true)?.scope, 'tenant_day');
    });

    it('checks the platform before the tenant, and the day before the month', () => {
        const all = budgets({ dailyUsd: 1, monthlyUsd: 1, tenantDailyUsd: 1, tenantMonthlyUsd: 1 });
        const over = { globalDay: 2, globalMonth: 2, tenantDay: 2, tenantMonth: 2 };
        assert.equal(firstReached(over, all, true)?.scope, 'global_day');
        assert.equal(firstReached({ ...over, globalDay: 0 }, all, true)?.scope, 'global_month');
        assert.equal(firstReached({ ...over, globalDay: 0, globalMonth: 0 }, all, true)?.scope, 'tenant_day');
        assert.equal(firstReached({ ...over, globalDay: 0, globalMonth: 0, tenantDay: 0 }, all, true)?.scope, 'tenant_month');
    });

    it('ignores the tenant budgets for spend that belongs to no tenant', () => {
        assert.equal(firstReached({ ...spend, tenantDay: 99 }, budgets({ tenantDailyUsd: 1 }), false), null);
    });
});

describe('reserveCall: the budget, at, under and over the limit', () => {
    it('lets a call through under the limit and counts what it reserved', async () => {
        db.seedUsage({ usd: 4.5, at: NOW });
        const r = await reserve({ budgets: budgets({ dailyUsd: 5 }), estimateUsd: 0.4 });
        assert.match(r.id, /^\d+$/);
        const row = db.usage.find((u) => u.id === r.id)!;
        assert.equal(row.outcome, 'reserved');
        assert.equal(row.usd, 0.4);
        assert.equal(row.creator_id, TENANT);
        assert.equal(row.purpose, 'onboarding_draft');
    });

    it('refuses AT the limit with `budget`, naming the scope and what was spent, and does not reserve', async () => {
        db.seedUsage({ usd: 5, at: NOW });
        const err = await refusal(reserve({ budgets: budgets({ dailyUsd: 5 }) }));
        assert.equal(err.kind, 'budget');
        assert.equal(err.retryable, false, 'asking again today will not help');
        assert.equal(err.scope, 'global_day');
        assert.equal(err.spentUsd, 5);
        assert.equal(err.limitUsd, 5);
        assert.match(err.message, /The platform's daily AI budget is spent \(\$5\.00 of \$5\.00\)\. It resets at 00:00 UTC/);
        assert.equal(db.usage.filter((u) => u.outcome === 'reserved').length, 0);
    });

    it('refuses OVER the limit', async () => {
        db.seedUsage({ usd: 8, at: NOW });
        assert.equal((await refusal(reserve({ budgets: budgets({ dailyUsd: 5 }) }))).spentUsd, 8);
    });

    it('records the refusal as a zero-cost `budget` row, so it shows in the summary and adds nothing to the spend', async () => {
        db.seedUsage({ usd: 5, at: NOW });
        await refusal(reserve({ budgets: budgets({ dailyUsd: 5 }), provider: 'openai', model: 'gpt-6-astra' }));
        const row = db.usage.find((u) => u.outcome === 'budget')!;
        assert.equal(row.usd, 0);
        assert.equal(row.creator_id, TENANT);
        assert.equal(row.provider, 'openai');
        assert.equal(row.model, 'gpt-6-astra');
        assert.equal(row.purpose, 'onboarding_draft');
    });

    it('a budget of 0 refuses every call', async () => {
        assert.equal((await refusal(reserve({ budgets: budgets({ dailyUsd: 0 }) }))).scope, 'global_day');
    });

    it('with no budget set never refuses, however much has been spent', async () => {
        db.seedUsage({ usd: 1e6, at: NOW });
        await reserve();
    });

    it('refuses a tenant at ITS limit and no other tenant, and the platform at its own', async () => {
        db.seedUsage({ usd: 3, at: NOW, creator_id: TENANT });
        db.seedUsage({ usd: 1, at: NOW, creator_id: OTHER });
        const limits = budgets({ tenantDailyUsd: 3, dailyUsd: 10 });
        const err = await refusal(reserve({ budgets: limits }));
        assert.equal(err.scope, 'tenant_day');
        assert.match(err.message, /^This tenant's daily AI budget is spent \(\$3\.00 of \$3\.00\)/);
        await reserve({ budgets: limits, creatorId: OTHER });
        // The platform's own limit counts everyone, including calls that belong to no tenant.
        db.seedUsage({ usd: 6, at: NOW, creator_id: null });
        assert.equal((await refusal(reserve({ budgets: limits, creatorId: OTHER }))).scope, 'global_day');
    });

    it('checks the month as well as the day: yesterday does not count against today, but does against the month', async () => {
        db.seedUsage({ usd: 9, at: new Date('2026-10-13T20:00:00Z') });
        await reserve({ budgets: budgets({ dailyUsd: 5 }) });
        const err = await refusal(reserve({ budgets: budgets({ dailyUsd: 5, monthlyUsd: 9 }) }));
        assert.equal(err.scope, 'global_month');
        assert.match(err.message, /monthly AI budget.*first of the month/);
    });

    it('does not count last month, and a new UTC day starts again from nothing', async () => {
        db.seedUsage({ usd: 50, at: new Date('2026-09-30T23:59:59Z') });
        await reserve({ budgets: budgets({ monthlyUsd: 1 }) });
        db.usage.length = 0;
        db.seedUsage({ usd: 5, at: new Date('2026-10-14T23:59:59Z') });
        await refusal(reserve({ budgets: budgets({ dailyUsd: 5 }), now: new Date('2026-10-14T23:59:59Z') }));
        await reserve({ budgets: budgets({ dailyUsd: 5 }), now: new Date('2026-10-15T00:00:00Z') });
    });

    it('spend that belongs to no tenant (a key test) is checked against the platform\'s limits only', async () => {
        db.seedUsage({ usd: 99, at: NOW, creator_id: TENANT });
        await reserve({ creatorId: null, purpose: 'key_test', budgets: budgets({ tenantDailyUsd: 1 }) });
        assert.equal((await refusal(reserve({ creatorId: null, purpose: 'key_test', budgets: budgets({ dailyUsd: 50 }) }))).scope, 'global_day');
    });

    it('counts a call still in flight at its ceiling, so calls cannot each pass on the same spend', async () => {
        const limits = budgets({ dailyUsd: 1 });
        await reserve({ budgets: limits, estimateUsd: 1 });
        await refusal(reserve({ budgets: limits, estimateUsd: 0.01 }));
    });

    it('counts a reservation that was never settled (the function was killed) until its period ends: over-counting is the safe side', async () => {
        const stale = db.seedUsage({ usd: 2, at: new Date(NOW.getTime() - 3 * 60 * 60 * 1000), outcome: 'reserved' });
        await refusal(reserve({ budgets: budgets({ dailyUsd: 2 }) }));
        assert.equal(stale.outcome, 'reserved', 'it is not rewritten behind the call\'s back');
    });
});

describe('reserveCall is one step under a lock', () => {
    it('takes the advisory lock before it reads the spend, in one transaction, and commits', async () => {
        await reserve({ budgets: budgets({ dailyUsd: 5 }) });
        const kind = (sql: string) =>
            /^pg_advisory_xact_lock|^SELECT pg_advisory_xact_lock/.test(sql) ? 'lock'
            : /^SELECT COALESCE\(SUM/.test(sql) ? 'sums' : /^INSERT INTO ai_usage/.test(sql) ? 'insert' : sql;
        const mine = db.statements.filter((s) => s.client !== 0);
        assert.deepEqual(mine.map((s) => kind(s.sql)), ['BEGIN', 'lock', 'sums', 'insert', 'COMMIT']);
        assert.equal(new Set(mine.map((s) => s.client)).size, 1, 'one connection for all of it');
        assert.equal(db.openClients(), 0, 'and it is given back');
    });

    it('commits a refusal too, so the lock is released and the `budget` row is kept', async () => {
        db.seedUsage({ usd: 9, at: NOW });
        await refusal(reserve({ budgets: budgets({ dailyUsd: 5 }) }));
        const sql = db.statements.filter((s) => s.client !== 0).map((s) => s.sql);
        assert.equal(sql.at(-1), 'COMMIT');
        assert.ok(!sql.includes('ROLLBACK'));
        assert.equal(db.openClients(), 0);
    });

    it('two calls racing past a budget that is spent after the first: the second is refused, however they interleave', async () => {
        const limits = budgets({ dailyUsd: 1 });
        // The first reservation reaches the limit exactly, so a second that read it must be refused. Without the lock both would read 0.
        for (let round = 0; round < 20; round += 1) {
            db.usage.length = 0;
            const results = await Promise.allSettled([reserve({ budgets: limits, estimateUsd: 1 }), reserve({ budgets: limits, estimateUsd: 1 })]);
            const passed = results.filter((r) => r.status === 'fulfilled').length;
            assert.equal(passed, 1, `round ${round}: ${results.map((r) => r.status).join(', ')}`);
            const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
            assert.ok(refused.reason instanceof BudgetRefused);
            assert.equal(db.usage.filter((u) => u.outcome === 'reserved').length, 1);
        }
    });

    it('many calls at once overshoot by at most one call\'s ceiling, and the rest are refused', async () => {
        const limits = budgets({ dailyUsd: 1 });
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserve({ budgets: limits, estimateUsd: 0.4 })));
        const passed = results.filter((r) => r.status === 'fulfilled').length;
        assert.equal(passed, 3, '0 → 0.4 → 0.8 → 1.2: the third started under the limit; the fourth read 1.2');
        const reserved = db.usage.filter((u) => u.outcome === 'reserved').reduce((n, u) => n + u.usd, 0);
        assert.ok(reserved < 1 + 0.4 + 1e-9, `spend ${reserved} is within one call of the limit`);
        assert.equal(results.filter((r) => r.status === 'rejected').length, 5);
        assert.equal(db.openClients(), 0);
    });

    it('a tenant\'s racing calls are bounded by the tenant\'s budget, not only the platform\'s', async () => {
        const limits = budgets({ tenantDailyUsd: 1, dailyUsd: 100 });
        const results = await Promise.allSettled(Array.from({ length: 6 }, () => reserve({ budgets: limits, estimateUsd: 0.5 })));
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
        const other = await reserve({ budgets: limits, creatorId: OTHER, estimateUsd: 0.5 });
        assert.ok(other.id);
    });

    it('a failure part-way rolls back, gives the connection back and leaves nothing reserved', async () => {
        db.failOn(/^SELECT COALESCE\(SUM\(usd\)/, new Error('connection terminated unexpectedly'));
        await assert.rejects(reserve({ budgets: budgets({ dailyUsd: 5 }) }), /connection terminated/);
        assert.equal(db.usage.length, 0);
        assert.ok(db.statements.some((s) => s.sql === 'ROLLBACK'));
        assert.equal(db.openClients(), 0);
        // And the lock went with it: the next call is not left waiting on a transaction that ended.
        await reserve({ budgets: budgets({ dailyUsd: 5 }) });
    });

    it('a failed insert does not leave the lock held for the next call', async () => {
        db.failOn(/^INSERT INTO ai_usage/, new Error('disk full'));
        await assert.rejects(reserve(), /disk full/);
        await reserve();
        assert.equal(db.usage.filter((u) => u.outcome === 'reserved').length, 1);
    });
});

describe('settleCall', () => {
    const outcome = { outcome: 'ok' as const, provider: 'anthropic', model: 'claude-opus-5-5', tokensIn: 1200, tokensOut: 340, usd: 0.0116, priced: true, elapsedMs: 8123 };

    it('rewrites the reservation into the finished row: tokens, dollars, outcome, latency, and the model that answered', async () => {
        const r = await reserve({ estimateUsd: 0.5 });
        assert.equal(await settleCall(r, { ...outcome, model: 'claude-opus-4-8' }), true);
        const row = db.usage.find((u) => u.id === r.id)!;
        assert.deepEqual(
            { o: row.outcome, in: row.input_tokens, out: row.output_tokens, usd: row.usd, priced: row.priced, ms: row.elapsed_ms, model: row.model },
            { o: 'ok', in: 1200, out: 340, usd: 0.0116, priced: true, ms: 8123, model: 'claude-opus-4-8' }
        );
        assert.equal(db.usage.length, 1, 'one row per call');
    });

    it('writes the cache tokens beside the others, and 0 for a call that has none (the reservation starts at 0 too)', async () => {
        const r = await reserve();
        assert.deepEqual([db.usage[0]!.cache_read_tokens, db.usage[0]!.cache_write_tokens], [0, 0], 'a fresh reservation caches nothing');
        await settleCall(r, { ...outcome, cacheRead: 4000, cacheWrite: 250 });
        const cached = db.usage.find((u) => u.id === r.id)!;
        assert.deepEqual([cached.input_tokens, cached.cache_read_tokens, cached.cache_write_tokens], [1200, 4000, 250], 'input_tokens stays the uncached remainder');
        const plain = await reserve();
        await settleCall(plain, outcome);
        const row = db.usage.find((u) => u.id === plain.id)!;
        assert.deepEqual([row.cache_read_tokens, row.cache_write_tokens], [0, 0]);
    });

    it('clamps the cache tokens like the others: a negative or past-the-column count is written as what the column can hold', async () => {
        const r = await reserve();
        await settleCall(r, { ...outcome, cacheRead: -3, cacheWrite: 1e12 });
        const row = db.usage.find((u) => u.id === r.id)!;
        assert.deepEqual([row.cache_read_tokens, row.cache_write_tokens], [0, 2_147_483_647]);
    });

    it('releases what was reserved: the spend becomes what the call cost', async () => {
        const limits = budgets({ dailyUsd: 1 });
        const r = await reserve({ budgets: limits, estimateUsd: 1 });
        await refusal(reserve({ budgets: limits, estimateUsd: 0.1 }));
        await settleCall(r, { ...outcome, usd: 0.3 });
        await reserve({ budgets: limits, estimateUsd: 0.1 });
    });

    it('never throws: a failed write is logged without the row\'s values and reported as false', async () => {
        const r = await reserve();
        db.failOn(/^UPDATE ai_usage/, new Error('connection terminated'));
        assert.equal(await settleCall(r, outcome), false);
        assert.ok(logs.some((l) => l.level === 'error' && l.line.includes('ai.usage_settle_failed')));
        assert.equal(db.usage.find((u) => u.id === r.id)!.outcome, 'reserved', 'the reservation stays, at its ceiling');
    });

    it('clamps what the column cannot hold and writes a missing latency as null', async () => {
        const r = await reserve();
        await settleCall(r, { ...outcome, tokensIn: 1e12, tokensOut: -5, elapsedMs: null });
        const row = db.usage.find((u) => u.id === r.id)!;
        assert.equal(row.input_tokens, 2_147_483_647);
        assert.equal(row.output_tokens, 0);
        assert.equal(row.elapsed_ms, null);
    });
});

describe('recordCall and recordKeyCheck', () => {
    it('write one finished row, for what was never reserved', async () => {
        assert.equal(await recordCall({ creatorId: TENANT, purpose: 'onboarding_proof', provider: 'none', model: '', outcome: 'no_provider', tokensIn: 0, tokensOut: 0, usd: 0, priced: true, elapsedMs: 0 }), true);
        assert.equal(db.usage.length, 1);
        assert.equal(db.usage[0]!.outcome, 'no_provider');
    });

    it('a key check is a `key_test` row with no tokens, no cost and no tenant', async () => {
        await recordKeyCheck('openai', '', 'ok', 212);
        await recordKeyCheck('openai', '', 'auth', 90);
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.creator_id, u.input_tokens, u.output_tokens, u.usd, u.outcome]), [
            ['key_test', null, 0, 0, 0, 'ok'], ['key_test', null, 0, 0, 0, 'auth'],
        ]);
    });

    it('never throw', async () => {
        db.failOn(/^INSERT INTO ai_usage/, new Error('down'), 2);
        assert.equal(await recordKeyCheck('openai', '', 'ok', 1), false);
        assert.equal(await recordCall({ creatorId: null, purpose: 'key_test', provider: 'x', model: '', outcome: 'ok', tokensIn: 0, tokensOut: 0, usd: 0, priced: true, elapsedMs: 1 }), false);
    });
});

describe('billedOfError and the cache', () => {
    it('keeps the cache tokens of an error that carries only `usage`, and none it does not have', () => {
        const withCache = new AiError({ kind: 'refusal', provider: 'anthropic', model: 'm', message: 'x', usage: { in: 7, out: 9, cacheRead: 100, cacheWrite: 20 } });
        assert.deepEqual(billedOfError(withCache), [{ model: 'm', in: 7, out: 9, cacheRead: 100, cacheWrite: 20 }]);
        const without = new AiError({ kind: 'refusal', provider: 'anthropic', model: 'm', message: 'x', usage: { in: 7, out: 9 } });
        assert.deepEqual(billedOfError(without), [{ model: 'm', in: 7, out: 9 }]);
    });
});

describe('billedOfError', () => {
    it('is what a refused, cut-off or malformed answer was billed for', () => {
        const withBilled = new AiError({ kind: 'refusal', provider: 'anthropic', model: 'm', message: 'x', billed: [{ model: 'm', in: 10, out: 5 }], usage: { in: 10, out: 5 } });
        assert.deepEqual(billedOfError(withBilled), [{ model: 'm', in: 10, out: 5 }]);
        const usageOnly = new AiError({ kind: 'max_tokens', provider: 'anthropic', model: 'm', message: 'x', usage: { in: 7, out: 9 } });
        assert.deepEqual(billedOfError(usageOnly), [{ model: 'm', in: 7, out: 9 }]);
        assert.deepEqual(billedOfError(new AiError({ kind: 'auth', provider: 'anthropic', model: 'm', message: 'x' })), [], 'a call that never answered cost nothing');
    });
});

describe('getUsageSummary', () => {
    it('totals today and this month, and breaks the window down by purpose, tenant and outcome', async () => {
        db.seedUsage({ usd: 1.5, at: NOW, creator_id: TENANT, purpose: 'onboarding_draft', input_tokens: 1000, output_tokens: 500 });
        db.seedUsage({ usd: 0.5, at: NOW, creator_id: OTHER, purpose: 'onboarding_proof', outcome: 'refusal' });
        db.seedUsage({ usd: 0, at: NOW, creator_id: null, purpose: 'key_test', outcome: 'budget' });
        db.seedUsage({ usd: 7, at: new Date('2026-10-02T10:00:00Z'), creator_id: TENANT, purpose: 'onboarding_draft', priced: false });
        db.seedUsage({ usd: 99, at: new Date('2026-09-30T10:00:00Z'), creator_id: TENANT });

        const day = await getUsageSummary({ now: NOW });
        assert.equal(day.dayStart, '2026-10-14T00:00:00.000Z');
        assert.equal(day.monthStart, '2026-10-01T00:00:00.000Z');
        assert.deepEqual(day.today, { calls: 3, failed: 2, unpriced: 0, usd: 2 });
        assert.deepEqual(day.month, { calls: 4, failed: 2, unpriced: 1, usd: 9 });
        assert.equal(day.period, 'day');
        assert.deepEqual(day.byPurpose.map((p) => [p.purpose, p.calls, p.usd]).sort(), [['key_test', 1, 0], ['onboarding_draft', 1, 1.5], ['onboarding_proof', 1, 0.5]]);
        assert.deepEqual(day.byOutcome.map((o) => o.outcome).sort(), ['budget', 'ok', 'refusal']);
        assert.equal(day.byTenant.length, 3);

        const month = await getUsageSummary({ now: NOW, period: 'month' });
        assert.equal(month.period, 'month');
        assert.equal(month.byPurpose.find((p) => p.purpose === 'onboarding_draft')!.calls, 2);
    });

    it('shows a reservation nobody settled for ten minutes as abandoned', async () => {
        db.seedUsage({ usd: 1, at: new Date(NOW.getTime() - ABANDONED_AFTER_MS - 1000), outcome: 'reserved' });
        db.seedUsage({ usd: 1, at: new Date(NOW.getTime() - 60_000), outcome: 'reserved' });
        const outcomes = Object.fromEntries((await getUsageSummary({ now: NOW })).byOutcome.map((o) => [o.outcome, o.calls]));
        assert.deepEqual(outcomes, { abandoned: 1, reserved: 1 });
    });

    it('is empty and zero with nothing recorded', async () => {
        const s = await getUsageSummary({ now: NOW });
        assert.deepEqual(s.today, { calls: 0, failed: 0, unpriced: 0, usd: 0 });
        assert.deepEqual(s.byPurpose, []);
    });
});
