/**
 * Where a DM's seconds go: how long each step of one piece of work took, and how many database statements it sent.
 *
 * Measured 2026-10-31: a text DM answered by the sales turn took ~6.6 s from the customer's message to the reply. The functions run in
 * `iad1` and `DATABASE_URL` is the Supabase pooler in `eu-west-1`, so every statement crosses the Atlantic. Whether those round trips
 * are where the seconds go is a question for a measurement, and this is it. Two pieces, both AsyncLocalStorage like the log context
 * (`log.ts`) and for the same reason: the steps are six frames deep in code that has no business threading a timer through.
 *
 *   1. A statement tally. `src/config/db.ts` counts every statement it sends against the tally in scope where the statement was
 *      ISSUED, with the milliseconds it waited for it, so work running concurrently in another scope is never counted here. The job
 *      runner opens one per job (`job.succeeded` reports it), and a timeline opens one when none is open.
 *   2. A timeline. `withTimeline(event, fn)` opens it, `lap(step)` ends a step (the time since the previous lap, and the statements
 *      sent in it), `noteTiming(fields)` adds what the work knows (the outcome, the model), and when `fn` settles ONE line is logged
 *      under `event`. A `withTimeline` inside another adds to the outer one instead of opening a second, so a DM's pipeline
 *      (`messaging.ts`) and its sales turn (`turn.ts`) are one line. Outside a timeline, `lap` and `noteTiming` do nothing.
 *
 * A step's statements are the ones issued while it was the current step, by the step or by anything running beside it (the sender's
 * profile lookup, the typing indicator): the totals are exact, and the split is as good as the steps are sequential.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { log, type LogFields } from './log.js';

interface Tally {
    /** Statements issued in this scope. */
    statements: number;
    /** What they took to settle, summed: statements sent side by side overlap, so this can be more than the wall time. */
    waitedMs: number;
}

const tallies = new AsyncLocalStorage<Tally>();

/** Run `fn` with a fresh statement tally: every statement `src/config/db.ts` sends inside it is counted there. */
export function withQueryTally<T>(fn: () => T): T {
    return tallies.run({ statements: 0, waitedMs: 0 }, fn);
}

/** Whether a tally is open here. `db.ts` hands out a counting transaction client only then. */
export function isTallying(): boolean {
    return tallies.getStore() !== undefined;
}

/** The tally in scope, as a log line's fields; empty outside one. */
export function queryTally(): { db_statements?: number; db_wait_ms?: number } {
    const tally = tallies.getStore();
    return tally ? { db_statements: tally.statements, db_wait_ms: Math.round(tally.waitedMs) } : {};
}

/**
 * Count one statement, issued now, against the tally in scope, and what it waited once `result` settles. `result` is handed back
 * untouched (the same promise, never a derived one, so a rejection reaches the caller exactly as before), and outside a tally nothing
 * is counted at all.
 */
export function countStatement<T>(result: T): T {
    const tally = tallies.getStore();
    if (!tally) return result;
    tally.statements++;
    const pending = result as unknown as PromiseLike<unknown> | null | undefined;
    if (pending && typeof pending.then === 'function') {
        const startedAt = Date.now();
        const settle = (): void => { tally.waitedMs += Date.now() - startedAt; };
        pending.then(settle, settle);
    }
    return result;
}

interface Timeline {
    tally: Tally;
    startedAt: number;
    /** Where the current step began, and the statements issued before it. */
    last: number;
    lastStatements: number;
    statementsAtStart: number;
    waitedAtStart: number;
    steps: Record<string, number>;
    db: Record<string, number>;
    fields: LogFields;
}

const timelines = new AsyncLocalStorage<Timeline>();

/**
 * Run `fn` as one timeline and log it as ONE line, `event`, when it settles (returned or thrown): `total_ms`, `steps_ms` and `steps_db`
 * per step in the order they ran, `db_statements` and `db_wait_ms` for the whole, and whatever `noteTiming` added. Inside another
 * timeline it is that one's: no second line. Never changes what `fn` returns or throws.
 */
export async function withTimeline<T>(event: string, fn: () => Promise<T>): Promise<T> {
    if (timelines.getStore()) return fn();
    const tally = tallies.getStore();
    if (!tally) return withQueryTally(() => withTimeline(event, fn));

    const now = Date.now();
    const timeline: Timeline = {
        tally, startedAt: now, last: now, lastStatements: tally.statements, statementsAtStart: tally.statements, waitedAtStart: tally.waitedMs,
        steps: {}, db: {}, fields: {},
    };
    return timelines.run(timeline, async () => {
        try {
            return await fn();
        } finally {
            emit(event, timeline);
        }
    });
}

/** End the current step of the timeline in scope: the time since the previous lap (or the start), and the statements issued in it. A step that runs twice (a second model call) adds up. */
export function lap(step: string): void {
    const timeline = timelines.getStore();
    if (timeline) close(timeline, step, Date.now());
}

/** Add fields to the timeline's line (what only the work knows: the outcome, the engine, the model). Later notes win. */
export function noteTiming(fields: LogFields): void {
    const timeline = timelines.getStore();
    if (timeline) Object.assign(timeline.fields, fields);
}

function close(timeline: Timeline, step: string, now: number): void {
    timeline.steps[step] = (timeline.steps[step] ?? 0) + (now - timeline.last);
    const sent = timeline.tally.statements - timeline.lastStatements;
    if (sent > 0) timeline.db[step] = (timeline.db[step] ?? 0) + sent;
    timeline.last = now;
    timeline.lastStatements = timeline.tally.statements;
}

/** The line itself. What ran after the last lap is `rest`, so the steps add up to `total_ms`; never throws (`log` does not). */
function emit(event: string, timeline: Timeline): void {
    const now = Date.now();
    if (now > timeline.last || timeline.tally.statements > timeline.lastStatements) close(timeline, 'rest', now);
    log('info', event, {
        ...timeline.fields,
        total_ms: now - timeline.startedAt,
        steps_ms: timeline.steps,
        steps_db: timeline.db,
        db_statements: timeline.tally.statements - timeline.statementsAtStart,
        db_wait_ms: Math.round(timeline.tally.waitedMs - timeline.waitedAtStart),
    });
}
