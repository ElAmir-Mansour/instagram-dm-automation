/**
 * Claude on the Mac (MONTEUR.md §6.3). With `monteur.brain: 'claude_mac'`, the Monteur's model
 * calls — the pick, the Marketer, the Editor and the Analyst — are not made from this app: each is
 * a `monteur_think` job that the Mac worker answers with the claude CLI on the owner's Claude plan,
 * and Gemini is never called for them (the owner's rule, 2026-09-28).
 *
 * A drain never waits for the Mac. Every call has a stable id, its `request` (the source, its pick
 * attempt and the call's purpose, or the Analyst's run), so the drain that asks and the drain that
 * finds the answer are usually two different ones. Each job is one try of a request:
 *
 *   no try yet                queue try 1                                              → waiting
 *   the latest try is open    under 20 minutes since its last sign of life             → waiting
 *                             past it (the Mac is asleep, its worker stopped): failed, then as below
 *   the latest try is done    its answer, parsed as Gemini's text would be             → the answer
 *                             (one that is not JSON fails the try, then as below)
 *   the latest try failed     a new try after 10 min, 30 min, then 2 h                 → waiting
 *   4 tries failed            "Claude on the Mac didn't answer: …", and the item stops. Its Retry
 *                             retires the tries, so the next one starts again from try 1.
 *
 * `ThinkWaiting` and `ThinkExhausted` are how a waiting or a stopped call reaches the sweep: they
 * are thrown through the step (pick.ts, copy.ts, editor.ts, analyst.ts) like any failed call, and the
 * sweep tells them apart from one.
 */
import { createHash } from 'node:crypto';
import { pool } from '../../config/db.js';
import type { MonteurThinkPayload, StudioJobStatus } from '../../db/rows.js';
import { log } from '../../utils/log.js';
import { isFiniteNumber, isPlainObject } from '../studio/common.js';
import type { GeminiSchema, ModelTurn } from '../studio/generate.js';
import type { CallCost } from './model.js';

/**
 * The model every think asks for, sent in the payload so the worker takes it from there: the owner
 * wants the latest Opus, never an alias that resolves to an older one.
 */
export const THINK_MODEL = 'claude-opus-5-5';
/** An open try with no sign of life for this long is presumed lost: the Mac is asleep, or its worker stopped. */
export const THINK_STALE_MINUTES = 20;
/** The wait before try 2, 3 and 4. */
export const THINK_BACKOFF_MINUTES: readonly number[] = [10, 30, 120];
/** The fourth failed try stops the item. */
export const MAX_THINK_TRIES = 4;
export const THINK_FAILED = 'Claude on the Mac didn\'t answer: ';
export const THINK_STALE_ERROR = `No answer within ${THINK_STALE_MINUTES} minutes: the Mac may be asleep, or its Studio worker stopped.`;

export type ThinkStep = MonteurThinkPayload['step'];

/** Where a step's calls go when the brain is Claude: the tenant, and the prefix of every request id. */
export interface ThinkOn {
    creatorId: string;
    /** e.g. `source/<id>/a2` (a source's second pick attempt) or `lessons/<run id>`. */
    key: string;
}

/** One call's route: its tenant, its request id, and which step it is. */
export interface ThinkRoute {
    creatorId: string;
    request: string;
    step: ThinkStep;
}

/** A call's route under `on`, or undefined (Gemini) when there is no `on`. */
export function thinkRoute(on: ThinkOn | undefined, purpose: string, step: ThinkStep): ThinkRoute | undefined {
    return on ? { creatorId: on.creatorId, request: `${on.key}/${purpose}`, step } : undefined;
}

/** A source's think key for one pick attempt. A new attempt asks again; the same one reads its answers. */
export const sourceThinkKey = (sourceId: string, attempt: number): string => `source/${sourceId}/a${attempt}`;

/** The Analyst's think key: one per run (the `studio_lessons` row). */
export const lessonsThinkKey = (runId: string): string => `lessons/${runId}`;

/**
 * The Editor's key also names the clips it is asked about, numbered C1… in order: its answer is by
 * number, so a different set of clips (the Marketer's copy dropped another one) is a new request.
 */
export function clipsThinkKey(key: string, clips: readonly { start: number; end: number }[]): string {
    const digest = createHash('sha1').update(clips.map((c) => `${c.start}-${c.end}`).join(',')).digest('hex').slice(0, 10);
    return `${key}/clips-${digest}`;
}

/** The call is waiting for the Mac: asked, answering, or between tries. Not a failure. */
export class ThinkWaiting extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ThinkWaiting';
    }
}

/** Every try failed: the item stops with this message, and waits for its Retry. */
export class ThinkExhausted extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ThinkExhausted';
    }
}

export const isThinkSignal = (err: unknown): err is ThinkWaiting | ThinkExhausted =>
    err instanceof ThinkWaiting || err instanceof ThinkExhausted;

// ─── The payload ────────────────────────────────────────────────────────────────────────

/**
 * Gemini's `responseSchema` as JSON Schema, for `claude --json-schema`: types lower-cased,
 * `propertyOrdering` dropped (Gemini's own), and every object closed with `additionalProperties:
 * false`. The array bounds go too, as they do for Gemini (`withoutArrayBounds`): structured output
 * refuses most of them, and the code that reads the answer enforces them anyway.
 */
export function toJsonSchema(schema: GeminiSchema): Record<string, unknown> {
    const out: Record<string, unknown> = { type: schema.type.toLowerCase() };
    if (schema.description !== undefined) out.description = schema.description;
    if (schema.enum) out.enum = [...schema.enum];
    if (schema.items) out.items = toJsonSchema(schema.items);
    if (schema.properties) {
        out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    }
    if (schema.required) out.required = [...schema.required];
    if (schema.type === 'OBJECT') out.additionalProperties = false;
    return out;
}

/**
 * The turns as one prompt: `claude -p` reads a single one on stdin. A repair round (the pick's)
 * is the first prompt, the answer it got, and what to fix.
 */
export function flattenTurns(turns: readonly ModelTurn[]): string {
    return turns.map((t) => (t.role === 'model' ? `Your previous answer:\n${t.text}` : t.text)).join('\n\n');
}

// ─── The tries ──────────────────────────────────────────────────────────────────────────

export interface ThinkTry {
    id: string;
    status: StudioJobStatus;
    result: unknown;
    error: string | null;
    try: number;
    /** Seconds since its last sign of life: the heartbeat, else the claim, else its creation. */
    quiet_s: number;
    /** Seconds since it last changed: for a failed try, since it failed. */
    since_s: number;
}

/** A request's tries, newest first, timed by the database's clock. A retired try is another round's. */
export const THINK_TRIES_SQL = `
    SELECT id, status, result, error, (payload->>'try')::int AS try,
           EXTRACT(EPOCH FROM NOW() - COALESCE(heartbeat_at, claimed_at, created_at))::float8 AS quiet_s,
           EXTRACT(EPOCH FROM NOW() - updated_at)::float8 AS since_s
      FROM studio_jobs
     WHERE creator_id = $1 AND kind = 'monteur_think' AND payload->>'request' = $2 AND NOT (payload ? 'retired')
     ORDER BY (payload->>'try')::int DESC, created_at DESC
     LIMIT 20`;

/**
 * One try. The unique index (v28) on `(request, try)` makes two drains asking at once queue it once.
 */
export const THINK_ENQUEUE_SQL = `
    INSERT INTO studio_jobs (creator_id, kind, payload)
    VALUES ($1, 'monteur_think', $2::jsonb)
    ON CONFLICT DO NOTHING
    RETURNING id`;

/** A try failed from here: gone quiet, or answered with something unusable. Only from `from`. */
export const THINK_FAIL_SQL = `
    UPDATE studio_jobs SET status = 'failed', error = $2, progress = NULL, updated_at = NOW()
     WHERE id = $1 AND status = ANY($3::text[])`;

/** A Retry's fresh start: the source's tries are retired, and an open one stops (the worker sees a 409). */
export const RETIRE_SOURCE_THINKS_SQL = `
    UPDATE studio_jobs
       SET payload = payload || '{"retired": true}'::jsonb,
           status = CASE WHEN status IN ('pending', 'claimed') THEN 'failed' ELSE status END,
           error = CASE WHEN status IN ('pending', 'claimed') THEN 'Superseded by a retry.' ELSE error END,
           progress = NULL, updated_at = NOW()
     WHERE creator_id = $1 AND kind = 'monteur_think' AND payload->>'request' LIKE $2 AND NOT (payload ? 'retired')`;

/** The prefix RETIRE_SOURCE_THINKS_SQL matches for one source, every attempt. */
export const sourceThinkPattern = (sourceId: string): string => `source/${sourceId}/%`;

export type ThinkNext =
    | { kind: 'answer'; try: ThinkTry }
    | { kind: 'stale'; try: ThinkTry }
    | { kind: 'ask'; try: number }
    | { kind: 'wait'; why: string }
    | { kind: 'exhausted'; error: string };

/** What to do about a request, from its tries (newest first). Pure. */
export function nextThinkStep(tries: readonly ThinkTry[]): ThinkNext {
    const latest = tries[0];
    if (!latest) return { kind: 'ask', try: 1 };
    if (latest.status === 'done') return { kind: 'answer', try: latest };
    if (latest.status === 'pending' || latest.status === 'claimed') {
        if (latest.quiet_s >= THINK_STALE_MINUTES * 60) return { kind: 'stale', try: latest };
        return { kind: 'wait', why: `try ${latest.try} is ${latest.status === 'pending' ? 'queued for the Mac' : 'with Claude on the Mac'}` };
    }
    const failed = tries.filter((t) => t.status === 'failed').length;
    if (failed >= MAX_THINK_TRIES) return { kind: 'exhausted', error: `${THINK_FAILED}${latest.error || 'no reason was given.'}` };
    const wait = THINK_BACKOFF_MINUTES[Math.min(failed, THINK_BACKOFF_MINUTES.length) - 1]! * 60;
    if (latest.since_s < wait) {
        return { kind: 'wait', why: `try ${latest.try} failed; try ${latest.try + 1} in ${Math.ceil((wait - latest.since_s) / 60)} min` };
    }
    return { kind: 'ask', try: latest.try + 1 };
}

export type ThinkAnswer =
    | { ok: true; output: unknown; model: string; tokensIn: number; tokensOut: number }
    | { ok: false; error: string };

/**
 * A done try's stored result as the step reads it: `output` is the parsed JSON, as `callGemini`
 * returns Gemini's text parsed — Claude's `structured_output` already is, its `result` text is
 * parsed here. The steps' own parse and clean functions take it from there.
 */
export function readThinkAnswer(result: unknown): ThinkAnswer {
    if (!isPlainObject(result)) return { ok: false, error: 'The worker stored no answer.' };
    let output = result.output;
    if (typeof output === 'string') {
        const text = output;
        try {
            output = JSON.parse(text);
        } catch (e) {
            return { ok: false, error: `Claude returned text that is not valid JSON (${(e as Error).message}). First 200 characters: ${text.slice(0, 200)}` };
        }
    }
    if (output === null || output === undefined) return { ok: false, error: 'Claude returned no answer.' };
    const usage = isPlainObject(result.usage) ? result.usage : {};
    const n = (v: unknown) => (isFiniteNumber(v) && v > 0 ? v : 0);
    return {
        ok: true,
        output,
        model: typeof result.model === 'string' && result.model ? result.model : THINK_MODEL,
        // The whole prompt, cached or not, as Gemini's promptTokenCount counts it.
        tokensIn: n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens),
        tokensOut: n(usage.output_tokens),
    };
}

export interface ThinkRequest {
    purpose: string;
    system: string;
    turns: ModelTurn[];
    schema: GeminiSchema;
}

async function loadTries(route: ThinkRoute): Promise<ThinkTry[]> {
    const { rows } = await pool.query<ThinkTry>(THINK_TRIES_SQL, [route.creatorId, route.request]);
    return rows.map((r) => ({ ...r, try: Number(r.try) || 0, quiet_s: Number(r.quiet_s) || 0, since_s: Number(r.since_s) || 0 }));
}

/**
 * The call, on the Mac: its answer when a try has one; else it queues or waits and throws
 * `ThinkWaiting`, or throws `ThinkExhausted` once every try has failed. Never calls Gemini.
 */
export async function think(route: ThinkRoute, req: ThinkRequest, cost: CallCost): Promise<unknown> {
    // A try failed here (stale, or an unusable answer) is decided on again at once: at most twice.
    for (let round = 0; round < 3; round++) {
        const next = nextThinkStep(await loadTries(route));
        const fields = { request: route.request, step: route.step, creator_id: route.creatorId };
        if (next.kind === 'answer') {
            const answer = readThinkAnswer(next.try.result);
            if (answer.ok) {
                cost.model = answer.model;
                cost.tokens_in += answer.tokensIn;
                cost.tokens_out += answer.tokensOut;
                cost.calls += 1;
                log('info', 'monteur.think_answered', { ...fields, try: next.try.try, model: answer.model });
                return answer.output;
            }
            await pool.query(THINK_FAIL_SQL, [next.try.id, answer.error, ['done']]);
            log('warn', 'monteur.think_unusable', { ...fields, try: next.try.try, error: answer.error });
            continue;
        }
        if (next.kind === 'stale') {
            await pool.query(THINK_FAIL_SQL, [next.try.id, THINK_STALE_ERROR, ['pending', 'claimed']]);
            log('warn', 'monteur.think_stale', { ...fields, try: next.try.try });
            continue;
        }
        if (next.kind === 'exhausted') {
            log('warn', 'monteur.think_exhausted', { ...fields, error: next.error });
            throw new ThinkExhausted(next.error);
        }
        if (next.kind === 'ask') {
            const payload: MonteurThinkPayload = {
                request: route.request, try: next.try, step: route.step, purpose: req.purpose, model: THINK_MODEL,
                system: req.system, user: flattenTurns(req.turns), schema: toJsonSchema(req.schema),
            };
            const { rows } = await pool.query<{ id: string }>(THINK_ENQUEUE_SQL, [route.creatorId, JSON.stringify(payload)]);
            log('info', 'monteur.think_queued', { ...fields, try: next.try, job_id: rows[0]?.id ?? null });
            throw new ThinkWaiting(`Waiting for Claude on the Mac: ${req.purpose}, try ${next.try} queued.`);
        }
        throw new ThinkWaiting(`Waiting for Claude on the Mac: ${req.purpose}, ${next.why}.`);
    }
    // Every round found a try to fail: the worker is moving under us. The next drain looks again.
    throw new ThinkWaiting(`Waiting for Claude on the Mac: ${req.purpose}.`);
}
