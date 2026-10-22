/**
 * The pacer (research R5): one `ads_pacer` row per ad account, so every caller of the Marketing API (a screen, the guard, the health check,
 * an op) spends from the same budget.
 *
 *   - Meta's Limited tier gives an ad account about 60 points per 300 s and blocks it for 300 s once that is passed. The app keeps itself
 *     to 45 (25% headroom). A read counts 1, a write 3.
 *   - After each answer the estimate is replaced by Meta's own `acc_id_util_pct` whenever Meta sent it (a percent of the 60 points).
 *   - A throttle sets `blocked_until` to the time Meta named (`reset_time_duration`, else `estimated_time_to_regain_access`, else 300 s),
 *     and nothing calls that account until then. A blocked call is refused with that time, never retried in a loop.
 *
 * Every function here is one short transaction on that row and nothing else: no Meta call ever runs inside it.
 */
import { withTransaction, type Exec } from '../studio/common.js';
import { queryOne } from '../../db/query.js';
import { readUsage, type AdAccountUsage, type Usage } from './metaUsage.js';

export const LIMITED_POINTS = 60;
/** 75% of Limited's 60: the headroom keeps us out of Meta's 300 s block. */
export const LIMITED_BUDGET = 45;
/** Standard access allows far more (thousands of points); the same 75% of a conservative 9,000. */
const STANDARD_BUDGET = 6750;
export const WINDOW_MS = 300_000;
export const DEFAULT_BLOCK_MS = 300_000;
export const POINTS = { read: 1, write: 3 } as const;

export interface PacerState {
    scoreEstimate: number;
    windowStartedAt: Date;
    blockedUntil: Date | null;
    tier: string | null;
}

export function budgetFor(tier: string | null): number {
    return tier === 'standard_access' ? STANDARD_BUDGET : LIMITED_BUDGET;
}

function windowOpen(s: PacerState, now: Date): boolean {
    return now.getTime() - s.windowStartedAt.getTime() < WINDOW_MS;
}

function blocked(s: PacerState, now: Date): boolean {
    return s.blockedUntil !== null && s.blockedUntil.getTime() > now.getTime();
}

/**
 * May `points` be spent now? Never while Meta has us blocked. A `priority` call (the guard pausing campaigns: it spends nothing and stops
 * spend) skips our own estimate, since being refused by our own bookkeeping would let the money run on.
 */
export function canSpend(s: PacerState, points: number, now: Date, opts: { priority?: boolean } = {}): boolean {
    if (blocked(s, now)) return false;
    if (opts.priority) return true;
    const used = windowOpen(s, now) ? s.scoreEstimate : 0;
    return used + points <= budgetFor(s.tier);
}

/** When a refused call may be tried again: the end of Meta's block, else the end of the window. */
export function retryAtFor(s: PacerState, now: Date): Date {
    if (blocked(s, now)) return s.blockedUntil!;
    return windowOpen(s, now) ? new Date(s.windowStartedAt.getTime() + WINDOW_MS) : now;
}

export function nextAfterReserve(s: PacerState, points: number, now: Date): { scoreEstimate: number; windowStartedAt: Date } {
    return windowOpen(s, now) ? { scoreEstimate: s.scoreEstimate + points, windowStartedAt: s.windowStartedAt } : { scoreEstimate: points, windowStartedAt: now };
}

/** Meta's percentage replaces our count when it was sent; otherwise our count stands (a missing header is not 0%). */
export function nextAfterObserve(s: PacerState, usage: Pick<Usage, 'adAccount' | 'tier'>, now: Date): PacerState {
    const pct = usage.adAccount?.utilPct;
    const tier = usage.tier ?? s.tier;
    if (typeof pct !== 'number') return { ...s, tier };
    return {
        scoreEstimate: Math.round((pct / 100) * LIMITED_POINTS * 100) / 100,
        windowStartedAt: windowOpen(s, now) ? s.windowStartedAt : now,
        blockedUntil: s.blockedUntil,
        tier,
    };
}

/** How long Meta said to wait after a throttle. */
export function blockUntilFor(usage: { adAccount: AdAccountUsage | null; regainMinutes: number | null }, now: Date): Date {
    const seconds = usage.adAccount?.resetSeconds;
    if (typeof seconds === 'number' && seconds > 0) return new Date(now.getTime() + seconds * 1000);
    const minutes = usage.regainMinutes;
    if (typeof minutes === 'number' && minutes > 0) return new Date(now.getTime() + minutes * 60_000);
    return new Date(now.getTime() + DEFAULT_BLOCK_MS);
}

// ─── The row ────────────────────────────────────────────────────────────────────────────────

interface PacerRow {
    score_estimate: string | number;
    window_started_at: Date | string;
    blocked_until: Date | string | null;
    last_usage: Record<string, unknown> | null;
}

const SELECT = 'SELECT score_estimate, window_started_at, blocked_until, last_usage FROM ads_pacer WHERE ad_account_id = $1';

function toState(row: PacerRow | null | undefined, now: Date): { state: PacerState; lastUsage: Record<string, unknown> } {
    if (!row) return { state: { scoreEstimate: 0, windowStartedAt: now, blockedUntil: null, tier: null }, lastUsage: {} };
    const lastUsage = row.last_usage && typeof row.last_usage === 'object' ? row.last_usage : {};
    return {
        state: {
            scoreEstimate: Number(row.score_estimate) || 0,
            windowStartedAt: new Date(row.window_started_at),
            blockedUntil: row.blocked_until ? new Date(row.blocked_until) : null,
            tier: typeof lastUsage['tier'] === 'string' ? (lastUsage['tier'] as string) : null,
        },
        lastUsage,
    };
}

async function locked(tx: Exec, account: string, now: Date) {
    return toState((await tx.query<PacerRow>(`${SELECT} FOR UPDATE`, [account])).rows[0], now);
}

async function write(tx: Exec, account: string, creatorId: string, s: PacerState, lastUsage: Record<string, unknown>): Promise<void> {
    await tx.query(
        `INSERT INTO ads_pacer (ad_account_id, creator_id, score_estimate, window_started_at, blocked_until, last_usage, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (ad_account_id) DO UPDATE SET creator_id = EXCLUDED.creator_id, score_estimate = EXCLUDED.score_estimate,
             window_started_at = EXCLUDED.window_started_at, blocked_until = EXCLUDED.blocked_until, last_usage = EXCLUDED.last_usage,
             updated_at = NOW()`,
        [account, creatorId, s.scoreEstimate, s.windowStartedAt, s.blockedUntil, JSON.stringify(lastUsage)]
    );
}

export type Reservation = { ok: true } | { ok: false; retryAt: Date; blocked: boolean };

/** Take `points` from the account's budget, or say when to try again. */
export async function reserve(account: string, creatorId: string, points: number, opts: { now?: Date; priority?: boolean } = {}): Promise<Reservation> {
    const now = opts.now ?? new Date();
    return withTransaction(async (tx) => {
        const { state, lastUsage } = await locked(tx, account, now);
        if (!canSpend(state, points, now, { priority: opts.priority })) return { ok: false as const, retryAt: retryAtFor(state, now), blocked: blocked(state, now) };
        const next = nextAfterReserve(state, points, now);
        await write(tx, account, creatorId, { ...state, ...next }, lastUsage);
        return { ok: true as const };
    });
}

/** After an answer: Meta's usage replaces the estimate, and the raw headers, the tier and the served version are kept. */
export async function observe(account: string, creatorId: string, headers: unknown, opts: { now?: Date } = {}): Promise<Usage | null> {
    const usage = readUsage(headers);
    if (!usage.adAccount && !usage.buc && !usage.insights && !usage.servedVersion) return null;
    const now = opts.now ?? new Date();
    await withTransaction(async (tx) => {
        const { state, lastUsage } = await locked(tx, account, now);
        const next = nextAfterObserve(state, usage, now);
        await write(tx, account, creatorId, next, {
            ...lastUsage,
            ...(usage.adAccount ? { adAccountUsage: usage.adAccount } : {}),
            ...(usage.buc ? { businessUseCase: usage.buc } : {}),
            ...(usage.insights ? { insightsThrottle: usage.insights } : {}),
            ...(usage.tier ? { tier: usage.tier } : {}),
            ...(usage.servedVersion ? { servedVersion: usage.servedVersion } : {}),
            at: now.toISOString(),
        });
    });
    return usage;
}

/** Meta throttled the account: nothing calls it until `until` (a later block already stored wins). */
export async function block(account: string, creatorId: string, until: Date, opts: { now?: Date } = {}): Promise<void> {
    const now = opts.now ?? new Date();
    await withTransaction(async (tx) => {
        const { state, lastUsage } = await locked(tx, account, now);
        const blockedUntil = state.blockedUntil && state.blockedUntil.getTime() > until.getTime() ? state.blockedUntil : until;
        await write(tx, account, creatorId, { ...state, blockedUntil }, { ...lastUsage, blockedAt: now.toISOString() });
    });
}

export interface PacerStatus extends PacerState {
    servedVersion: string | null;
    lastUsage: Record<string, unknown>;
}

export async function status(account: string): Promise<PacerStatus | null> {
    const row = await queryOne<PacerRow>(SELECT, [account]);
    if (!row) return null;
    const { state, lastUsage } = toState(row, new Date());
    return { ...state, servedVersion: typeof lastUsage['servedVersion'] === 'string' ? (lastUsage['servedVersion'] as string) : null, lastUsage };
}
