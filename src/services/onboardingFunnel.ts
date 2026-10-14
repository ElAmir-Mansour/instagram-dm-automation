/**
 * The onboarding funnel, for Operations (plan P31; docs/onboarding/02 §6): how many tenants got from an invite to a finished setup,
 * how far each one went, and how long it took, over the last 30 or 90 days.
 *
 * Built from `onboarding_events` and nothing else, so it holds counts and durations and no tenant's name, handle or answer.
 *
 * ─── What a stage means ───────────────────────────────────────────────────────────────────────
 *
 * Each tenant is placed at the FURTHEST stage its events reach (02 §6: "the furthest step reached per tenant"), and a stage's count
 * is the tenants that reached it or went past it, so the counts only ever fall from one stage to the next:
 *
 *   invited      every tenant the funnel has seen in the window (see "the cohort")
 *   opened       the link was opened          (invite_opened)
 *   accepted     a password was chosen        (invite_accepted)
 *   <step>       the wizard step was shown, finished or skipped (step_viewed | step_completed | step_skipped): one stage per switched-on step
 *   completed    Finish                       (wizard_completed)
 *
 * **The cohort** is the tenants whose FIRST event falls inside the window: a tenant counts in the window it entered, however long it
 * then took, so a tenant invited 31 days ago who finished yesterday is a 90-day tenant and not a 30-day one with a missing first
 * stage. A tenant whose link was made before events were written begins at the first event there is for it (usually opening the link).
 *
 * **Median times**, in milliseconds, each over the tenants that have both ends (so no tenant is counted as "0" for a step it never took):
 * invite to opened, invite to accepted, opened to completed (the plan's "five minutes from opening the link to the finished proof"),
 * accepted to completed, and per step the median `ms_on_step` its Continue recorded (the writer already caps one at an hour).
 *
 * **Abandoned** is derived, never stored: not completed and no event for a day (02 §6).
 *
 * The aggregation (`buildFunnel`) is pure and tested without a database; `loadFunnel` is the two statements that feed it.
 */
import { queryRows } from '../db/query.js';
import { WIZARD_STEPS } from './onboardingWizard.js';

export const FUNNEL_WINDOWS = [30, 90] as const;
export type FunnelWindow = (typeof FUNNEL_WINDOWS)[number];
export const DEFAULT_FUNNEL_WINDOW: FunnelWindow = 30;

export function parseFunnelWindow(raw: unknown): FunnelWindow | null {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_FUNNEL_WINDOW;
    // A query string can hold a list (`?days=30&days=90`) or an object (`?days[a]=1`): only a plain number or text is an answer.
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const n = Number(raw);
    return (FUNNEL_WINDOWS as readonly number[]).includes(n) ? (n as FunnelWindow) : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** No event for this long and an unfinished tenant has walked away. */
export const ABANDONED_AFTER_MS = DAY_MS;
/** The plan's target: opening the invite to a finished setup, at the median. */
export const TARGET_OPEN_TO_COMPLETE_MS = 5 * 60 * 1000;

// ─── The two statements ─────────────────────────────────────────────────────────────────────────

/** The tenants whose first event is `$1` or later. The cohort of both statements below. */
const COHORT_SQL = `SELECT creator_id FROM onboarding_events GROUP BY creator_id HAVING MIN(at) >= $1`;

/** One row per tenant, event and step: when it first happened, when it last did, and how often. */
export const FUNNEL_EVENTS_SQL = `SELECT creator_id, event, step, MIN(at) AS first_at, MAX(at) AS last_at, COUNT(*)::int AS n
  FROM onboarding_events
 WHERE creator_id IN (${COHORT_SQL})
 GROUP BY creator_id, event, step`;

/** The time each finished step took, for the cohort. Only a Continue that recorded one. */
export const FUNNEL_STEP_TIMES_SQL = `SELECT step, (props->>'ms_on_step')::numeric AS ms
  FROM onboarding_events
 WHERE event = 'step_completed' AND props ? 'ms_on_step' AND step IS NOT NULL
   AND creator_id IN (${COHORT_SQL})`;

export interface EventAggregate {
    creator_id: string;
    event: string;
    step: string | null;
    first_at: Date | string;
    last_at: Date | string;
    n: number;
}

export interface StepTime { step: string | null; ms: number | string | null }

// ─── The aggregation ────────────────────────────────────────────────────────────────────────────

export interface FunnelStage {
    /** `invited`, `opened`, `accepted`, a wizard step id, or `completed`. */
    id: string;
    /** Tenants that reached this stage or went past it. */
    reached: number;
    /** `reached` as a share of the cohort, 0 to 100. */
    pct: number;
}

export interface FunnelStep {
    step: string;
    /** Tenants that reached the step (or went past it). */
    reached: number;
    /** Tenants that pressed Continue / Skip on it. */
    completed: number;
    skipped: number;
    median_ms: number | null;
}

export interface Funnel {
    days: FunnelWindow;
    since: string;
    cohort: number;
    stages: FunnelStage[];
    steps: FunnelStep[];
    completed: number;
    abandoned: number;
    /** Not finished and not abandoned: still within a day of their last event. */
    in_progress: number;
    medians: {
        invite_to_open_ms: number | null;
        invite_to_accept_ms: number | null;
        open_to_complete_ms: number | null;
        accept_to_complete_ms: number | null;
    };
    drafts: { started: number; ready: number; failed: number };
    target_open_to_complete_ms: number;
}

const toMs = (value: Date | string | null | undefined): number | null => {
    if (value === null || value === undefined) return null;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
};

/** The middle value of `values` (the mean of the two middle ones when there is an even number), or null for none. */
export function median(values: readonly number[]): number | null {
    const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const mid = Math.floor(sorted.length / 2);
    return Math.round(sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** The switched-on form steps, in the wizard's order: the funnel follows the registry, so a step that goes live appears by itself. */
export function funnelSteps(): string[] {
    return WIZARD_STEPS.filter((s) => s.enabled && s.id !== 'done').map((s) => s.id);
}

interface PerTenant {
    first: Map<string, number>;
    last: number;
    steps: Map<string, { viewed: boolean; completed: boolean; skipped: boolean }>;
    furthest: number;
}

export function buildFunnel(
    rows: readonly EventAggregate[], times: readonly StepTime[],
    options: { days: FunnelWindow; now?: number; steps?: readonly string[] }
): Funnel {
    const now = options.now ?? Date.now();
    const steps = options.steps ?? funnelSteps();
    const stageIds = ['invited', 'opened', 'accepted', ...steps, 'completed'];
    const rankOfStep = new Map(steps.map((id, at) => [id, 3 + at]));
    const completedRank = stageIds.length - 1;

    const tenants = new Map<string, PerTenant>();
    const drafts = { started: 0, ready: 0, failed: 0 };
    for (const row of rows) {
        let t = tenants.get(row.creator_id);
        if (!t) {
            t = { first: new Map(), last: 0, steps: new Map(), furthest: 0 };
            tenants.set(row.creator_id, t);
        }
        const first = toMs(row.first_at);
        const last = toMs(row.last_at);
        if (first === null || last === null) continue;
        const known = t.first.get(row.event);
        if (known === undefined || first < known) t.first.set(row.event, first);
        t.last = Math.max(t.last, last);

        let rank = -1;
        if (row.event === 'invite_created') rank = 0;
        else if (row.event === 'invite_opened') rank = 1;
        else if (row.event === 'invite_accepted') rank = 2;
        else if (row.event === 'wizard_completed') rank = completedRank;
        else if (row.event === 'step_viewed' || row.event === 'step_completed' || row.event === 'step_skipped') {
            const at = row.step ? rankOfStep.get(row.step) : undefined;
            if (at !== undefined) {
                rank = at;
                const s = t.steps.get(row.step!) ?? { viewed: false, completed: false, skipped: false };
                if (row.event === 'step_viewed') s.viewed = true;
                else if (row.event === 'step_completed') s.completed = true;
                else s.skipped = true;
                t.steps.set(row.step!, s);
            }
        } else if (row.event === 'draft_started') drafts.started += row.n;
        else if (row.event === 'draft_ready') drafts.ready += row.n;
        else if (row.event === 'draft_failed') drafts.failed += row.n;
        if (rank > t.furthest) t.furthest = rank;
    }

    const cohort = tenants.size;
    const list = [...tenants.values()];
    const stages: FunnelStage[] = stageIds.map((id, at) => {
        const reached = at === 0 ? cohort : list.filter((t) => t.furthest >= at).length;
        return { id, reached, pct: cohort === 0 ? 0 : Math.round((100 * reached) / cohort) };
    });

    const stepTimes = new Map<string, number[]>();
    for (const row of times) {
        const ms = row.ms === null || row.ms === undefined ? NaN : Number(row.ms);
        if (!row.step || !Number.isFinite(ms)) continue;
        const bucket = stepTimes.get(row.step) ?? [];
        bucket.push(ms);
        stepTimes.set(row.step, bucket);
    }
    const stepRows: FunnelStep[] = steps.map((id) => {
        const rank = rankOfStep.get(id)!;
        return {
            step: id,
            reached: list.filter((t) => t.furthest >= rank).length,
            completed: list.filter((t) => t.steps.get(id)?.completed).length,
            skipped: list.filter((t) => t.steps.get(id)?.skipped).length,
            median_ms: median(stepTimes.get(id) ?? []),
        };
    });

    const between = (from: string, to: string): number[] =>
        list.flatMap((t) => {
            const a = t.first.get(from);
            const b = t.first.get(to);
            return a !== undefined && b !== undefined && b >= a ? [b - a] : [];
        });

    const completed = list.filter((t) => t.furthest >= completedRank).length;
    const abandoned = list.filter((t) => t.furthest < completedRank && now - t.last > ABANDONED_AFTER_MS).length;
    return {
        days: options.days,
        since: new Date(now - options.days * DAY_MS).toISOString(),
        cohort,
        stages,
        steps: stepRows,
        completed,
        abandoned,
        in_progress: cohort - completed - abandoned,
        medians: {
            invite_to_open_ms: median(between('invite_created', 'invite_opened')),
            invite_to_accept_ms: median(between('invite_created', 'invite_accepted')),
            open_to_complete_ms: median(between('invite_opened', 'wizard_completed')),
            accept_to_complete_ms: median(between('invite_accepted', 'wizard_completed')),
        },
        drafts,
        target_open_to_complete_ms: TARGET_OPEN_TO_COMPLETE_MS,
    };
}

/** The funnel for the last `days` days, from the database. Read-only. */
export async function loadFunnel(days: FunnelWindow, now: number = Date.now()): Promise<Funnel> {
    const since = new Date(now - days * DAY_MS);
    const [rows, times] = await Promise.all([
        queryRows<EventAggregate>(FUNNEL_EVENTS_SQL, [since]),
        queryRows<StepTime>(FUNNEL_STEP_TIMES_SQL, [since]),
    ]);
    return buildFunnel(rows, times, { days, now });
}
