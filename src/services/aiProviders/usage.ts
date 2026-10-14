/**
 * `ai_usage`: one row per AI call, and the budgets that read it back (docs/onboarding/06 §2, "Usage, cost, budgets"; v34).
 *
 * **Reserve, call, settle.** A row is written *before* the provider is asked, with the call's worst-case cost, and corrected when it answers:
 *
 *   1. `reserveCall` takes a transaction-scoped advisory lock, sums the period's spend (settled rows and every reservation still in
 *      flight), and refuses with `budget` if a limit is already reached; otherwise it inserts the reservation. The lock is what makes
 *      check-and-insert one step: under READ COMMITTED two calls that both read "$0.90 of $1.00 spent" would both be let through, and
 *      with the lock the second one reads the first one's reservation. The lock is held for two statements, microseconds.
 *   2. `settleCall` rewrites the row with what the call really used and cost, its outcome and its latency.
 *
 * A call is refused once the spend *has reached* the limit (at it is over). A call that starts under the limit may end past it, by at most
 * its own cost: the reservation is that call's ceiling (the whole `maxTokens` at the output price, on an input estimate), so calls in
 * flight count against each other, and the overshoot is one call, not however many were racing. The price of that is conservatism under
 * concurrency: five calls reserving $0.30 each can refuse a sixth that would have fitted, until the first ones settle at what they cost.
 *
 * A reservation that is never settled (the function was killed mid-call) stays counted at its ceiling: the provider may have billed it,
 * and over-counting is the safe side of a budget. It rolls off with its period. The summary shows it as `abandoned` after ten minutes.
 *
 * Settling is bookkeeping and never fails a call that has already been paid for: a write that fails is logged, and the reservation stays.
 * A reservation that cannot be *made* does fail the call, before the provider is asked: a call that cannot be recorded cannot be limited.
 */
import { pool } from '../../config/db.js';
import { queryOne, queryRows } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import type { Budgets } from './settings.js';
import { AiError, type AiErrorKind } from '../llm/errors.js';
import { billedFromUsage } from '../llm/cost.js';
import type { Billed } from '../llm/types.js';
import type { ProviderId } from '../llm/registry.js';
import { KEY_TEST, type UsagePurpose } from './purposes.js';

const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

// ─── Periods ─────────────────────────────────────────────────────────────────────────────────

/** UTC midnight of the day `now` is in. Budgets are UTC days, as the spec says, so "today" is the same for the operator and the sweep. */
export const dayStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
/** UTC midnight of the first of the month. */
export const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** A reservation older than this was not settled by a call that finished: `abandoned` in the summary. Calls are capped at 150 s. */
export const ABANDONED_AFTER_MS = 10 * 60 * 1000;

// ─── Budgets ─────────────────────────────────────────────────────────────────────────────────

export type BudgetScope = 'global_day' | 'global_month' | 'tenant_day' | 'tenant_month';

const SCOPE_LABEL: Record<BudgetScope, string> = {
    global_day: "The platform's daily AI budget",
    global_month: "The platform's monthly AI budget",
    tenant_day: "This tenant's daily AI budget",
    tenant_month: "This tenant's monthly AI budget",
};

/** A limit was already reached, so the provider was never asked. `kind` is `budget` (final: asking again today will not help). */
export class BudgetRefused extends AiError {
    readonly reason = 'budget';
    constructor(readonly scope: BudgetScope, readonly spentUsd: number, readonly limitUsd: number, provider: string, model: string) {
        super({
            kind: 'budget', provider, model,
            message: `${SCOPE_LABEL[scope]} is spent ($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}). It resets ${scope.endsWith('day') ? 'at 00:00 UTC' : 'on the first of the month'}, or the operator can raise it.`,
        });
        this.name = 'BudgetRefused';
    }
}

export interface Spend {
    globalDay: number;
    globalMonth: number;
    tenantDay: number;
    tenantMonth: number;
}

/** The first limit already reached, in a fixed order (platform before tenant, day before month), or null. */
export function firstReached(spend: Spend, budgets: Budgets, hasTenant: boolean): { scope: BudgetScope; spent: number; limit: number } | null {
    const checks: [BudgetScope, number, number | null][] = [
        ['global_day', spend.globalDay, budgets.dailyUsd],
        ['global_month', spend.globalMonth, budgets.monthlyUsd],
        ...(hasTenant ? ([['tenant_day', spend.tenantDay, budgets.tenantDailyUsd], ['tenant_month', spend.tenantMonth, budgets.tenantMonthlyUsd]] as [BudgetScope, number, number | null][]) : []),
    ];
    for (const [scope, spent, limit] of checks) if (limit !== null && spent >= limit) return { scope, spent, limit };
    return null;
}

export interface Reservation {
    /** The `ai_usage` row, to settle. A bigint column: a string, as `pg` gives it. */
    id: string;
}

export interface ReserveArgs {
    creatorId: string | null;
    purpose: UsagePurpose;
    provider: ProviderId;
    model: string;
    /** The most the call can cost (`estimateUsd`). */
    estimateUsd: number;
    priced: boolean;
    budgets: Budgets;
    now?: Date;
}

/** Postgres's one int-keyed lock for the whole budget. A constant string through `hashtextextended`, as the publishing lock does. */
const BUDGET_LOCK = `SELECT pg_advisory_xact_lock(hashtextextended('ai_budget', 0))`;

/**
 * The check and the reservation, as one step under the lock. Throws `BudgetRefused` (after writing a zero-cost `budget` row, so the
 * refusal is in the summary) when a limit is reached.
 */
export async function reserveCall(args: ReserveArgs): Promise<Reservation> {
    const now = args.now ?? new Date();
    const client = await pool.connect();
    let refusal: BudgetRefused | null = null;
    let id: string | undefined;
    try {
        await client.query('BEGIN');
        await client.query(BUDGET_LOCK);
        const spent = await client.query<{ day: number; month: number; tenant_day: number; tenant_month: number }>(
            `SELECT COALESCE(SUM(usd) FILTER (WHERE at >= $1), 0)::float8 AS day,
                    COALESCE(SUM(usd), 0)::float8 AS month,
                    COALESCE(SUM(usd) FILTER (WHERE at >= $1 AND creator_id = $3::uuid), 0)::float8 AS tenant_day,
                    COALESCE(SUM(usd) FILTER (WHERE creator_id = $3::uuid), 0)::float8 AS tenant_month
               FROM ai_usage
              WHERE at >= $2`,
            [dayStart(now), monthStart(now), args.creatorId]
        );
        const row = spent.rows[0];
        const reached = firstReached(
            { globalDay: num(row?.day), globalMonth: num(row?.month), tenantDay: num(row?.tenant_day), tenantMonth: num(row?.tenant_month) },
            args.budgets,
            args.creatorId !== null
        );
        if (reached) {
            await client.query(
                `INSERT INTO ai_usage (creator_id, purpose, provider, model, usd, priced, outcome)
                 VALUES ($1, $2, $3, $4, 0, TRUE, 'budget')`,
                [args.creatorId, args.purpose, args.provider, args.model]
            );
            refusal = new BudgetRefused(reached.scope, reached.spent, reached.limit, args.provider, args.model);
        } else {
            const inserted = await client.query<{ id: string }>(
                `INSERT INTO ai_usage (creator_id, purpose, provider, model, usd, priced, outcome)
                 VALUES ($1, $2, $3, $4, $5, $6, 'reserved')
                 RETURNING id`,
                [args.creatorId, args.purpose, args.provider, args.model, args.estimateUsd, args.priced]
            );
            id = inserted.rows[0]?.id === undefined ? undefined : String(inserted.rows[0].id);
        }
        await client.query('COMMIT');
    } catch (err) {
        // Nothing may leave the lock or the transaction open: both end with it.
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
    if (refusal) throw refusal;
    if (id === undefined) throw new Error('The ai_usage reservation returned no id.');
    return { id };
}

// ─── Settling and recording ──────────────────────────────────────────────────────────────────

export interface Outcome {
    /** `ok`, or the `AiError` kind. */
    outcome: 'ok' | AiErrorKind;
    provider: string;
    model: string;
    /** What the call used, summed over `billed`. `tokensIn` is the input billed at the full price: Anthropic's cached input is counted apart. */
    tokensIn: number;
    tokensOut: number;
    /** Input served from, and written to, Anthropic's prompt cache (S2): `ai_usage.cache_read_tokens` and `cache_write_tokens`. Zero when absent. */
    cacheRead?: number;
    cacheWrite?: number;
    usd: number;
    priced: boolean;
    elapsedMs: number | null;
}

const INT_MAX = 2_147_483_647;
const int = (n: number): number => Math.min(Math.max(Math.round(Number.isFinite(n) ? n : 0), 0), INT_MAX);

/** Rewrites a reservation with what happened. Never throws: see the file comment. */
export async function settleCall(reservation: Reservation, o: Outcome): Promise<boolean> {
    try {
        await pool.query(
            `UPDATE ai_usage
                SET provider = $2, model = $3, input_tokens = $4, output_tokens = $5, usd = $6, priced = $7, outcome = $8, elapsed_ms = $9,
                    cache_read_tokens = $10, cache_write_tokens = $11
              WHERE id = $1`,
            [
                reservation.id, o.provider, o.model, int(o.tokensIn), int(o.tokensOut), o.usd, o.priced, o.outcome, o.elapsedMs === null ? null : int(o.elapsedMs),
                int(o.cacheRead ?? 0), int(o.cacheWrite ?? 0),
            ]
        );
        return true;
    } catch (err) {
        log('error', 'ai.usage_settle_failed', { usage_id: reservation.id, outcome: o.outcome, ...describeError(err) });
        return false;
    }
}

/**
 * One finished row written at once, for what was never reserved: a refusal for want of a provider, an operator's key check (free, so
 * nothing to limit). Never throws.
 */
export async function recordCall(args: { creatorId: string | null; purpose: UsagePurpose } & Outcome): Promise<boolean> {
    try {
        await pool.query(
            `INSERT INTO ai_usage (creator_id, purpose, provider, model, input_tokens, output_tokens, usd, priced, outcome, elapsed_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [args.creatorId, args.purpose, args.provider, args.model, int(args.tokensIn), int(args.tokensOut), args.usd, args.priced, args.outcome, args.elapsedMs === null ? null : int(args.elapsedMs)]
        );
        return true;
    } catch (err) {
        log('error', 'ai.usage_record_failed', { purpose: args.purpose, outcome: args.outcome, ...describeError(err) });
        return false;
    }
}

/** A key check: a call that costs nothing and belongs to no tenant. */
export function recordKeyCheck(provider: string, model: string, outcome: Outcome['outcome'], elapsedMs: number): Promise<boolean> {
    return recordCall({ creatorId: null, purpose: KEY_TEST, provider, model, tokensIn: 0, tokensOut: 0, usd: 0, priced: true, outcome, elapsedMs });
}

/** What a failed call was billed for: an answer that was refused, cut off or malformed was still paid for. */
export function billedOfError(err: AiError): Billed[] {
    if (err.billed?.length) return err.billed;
    return err.usage ? [billedFromUsage(err.model, err.usage)] : [];
}

// ─── The summary ─────────────────────────────────────────────────────────────────────────────

export interface Totals {
    calls: number;
    /** Calls that did not end `ok` (refusals for want of budget or a provider included). */
    failed: number;
    /** Calls charged at the table's ceiling because their model had no price. */
    unpriced: number;
    usd: number;
}

export interface UsageSummary {
    asOf: string;
    dayStart: string;
    monthStart: string;
    today: Totals;
    month: Totals;
    /** The window the breakdowns below cover. */
    period: 'day' | 'month';
    byPurpose: { purpose: string; provider: string; calls: number; failed: number; usd: number; tokensIn: number; tokensOut: number }[];
    byTenant: { creatorId: string | null; name: string | null; calls: number; usd: number }[];
    /** How many calls ended each way over the window: ok, auth, budget, … , abandoned. */
    byOutcome: { outcome: string; calls: number }[];
}

export async function getUsageSummary(opts: { period?: 'day' | 'month'; now?: Date } = {}): Promise<UsageSummary> {
    const now = opts.now ?? new Date();
    const period = opts.period ?? 'day';
    const [day, month] = [dayStart(now), monthStart(now)];
    const from = period === 'day' ? day : month;
    const abandonedBefore = new Date(now.getTime() - ABANDONED_AFTER_MS);

    const totals = await queryOne<Record<string, unknown>>(
        `SELECT COUNT(*) FILTER (WHERE at >= $1)::int AS day_calls,
                COUNT(*) FILTER (WHERE at >= $1 AND outcome NOT IN ('ok', 'reserved'))::int AS day_failed,
                COUNT(*) FILTER (WHERE at >= $1 AND NOT priced)::int AS day_unpriced,
                COALESCE(SUM(usd) FILTER (WHERE at >= $1), 0)::float8 AS day_usd,
                COUNT(*)::int AS month_calls,
                COUNT(*) FILTER (WHERE outcome NOT IN ('ok', 'reserved'))::int AS month_failed,
                COUNT(*) FILTER (WHERE NOT priced)::int AS month_unpriced,
                COALESCE(SUM(usd), 0)::float8 AS month_usd
           FROM ai_usage
          WHERE at >= $2`,
        [day, month]
    );
    const purposes = await queryRows<Record<string, unknown>>(
        `SELECT purpose, provider, COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE outcome NOT IN ('ok', 'reserved'))::int AS failed,
                COALESCE(SUM(usd), 0)::float8 AS usd,
                COALESCE(SUM(input_tokens), 0)::float8 AS tokens_in,
                COALESCE(SUM(output_tokens), 0)::float8 AS tokens_out
           FROM ai_usage
          WHERE at >= $1
          GROUP BY purpose, provider
          ORDER BY usd DESC, purpose
          LIMIT 100`,
        [from]
    );
    const tenants = await queryRows<Record<string, unknown>>(
        `SELECT u.creator_id, c.name, COUNT(*)::int AS calls, COALESCE(SUM(u.usd), 0)::float8 AS usd
           FROM ai_usage u
           LEFT JOIN creators c ON c.id = u.creator_id
          WHERE u.at >= $1
          GROUP BY u.creator_id, c.name
          ORDER BY usd DESC
          LIMIT 50`,
        [from]
    );
    const outcomes = await queryRows<Record<string, unknown>>(
        `SELECT CASE WHEN outcome = 'reserved' AND at < $2 THEN 'abandoned' ELSE outcome END AS outcome, COUNT(*)::int AS calls
           FROM ai_usage
          WHERE at >= $1
          GROUP BY 1
          ORDER BY calls DESC`,
        [from, abandonedBefore]
    );

    return {
        asOf: now.toISOString(),
        dayStart: day.toISOString(),
        monthStart: month.toISOString(),
        today: { calls: num(totals?.day_calls), failed: num(totals?.day_failed), unpriced: num(totals?.day_unpriced), usd: num(totals?.day_usd) },
        month: { calls: num(totals?.month_calls), failed: num(totals?.month_failed), unpriced: num(totals?.month_unpriced), usd: num(totals?.month_usd) },
        period,
        byPurpose: purposes.map((r) => ({
            purpose: String(r.purpose), provider: String(r.provider), calls: num(r.calls), failed: num(r.failed),
            usd: num(r.usd), tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out),
        })),
        byTenant: tenants.map((r) => ({ creatorId: r.creator_id === null ? null : String(r.creator_id), name: r.name === null ? null : String(r.name), calls: num(r.calls), usd: num(r.usd) })),
        byOutcome: outcomes.map((r) => ({ outcome: String(r.outcome), calls: num(r.calls) })),
    };
}
