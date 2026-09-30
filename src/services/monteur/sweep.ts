/**
 * The pick sweep (MONTEUR.md §6), run by `GET /api/jobs/drain` after everything else it does.
 *
 *   auto mode            reels in review of tenants in `mode: 'auto'`, approved as Approve would (auto.ts)
 *   claim one source     `transcribed`, or `picking` with a claim older than 10 minutes, atomically
 *   1. the Monteur       one call: which lines make the reels (pick.ts)
 *   2. the Marketer      one call for all of them: captions, keyword, DM (copy.ts)
 *   3. the Editor        one call for all of them: the pro edits and the human touches on each reel
 *                        (editor.ts). Never blocks: a failed call renders the reels with neither
 *   4. hand-off          clip rows `rendering`, one `monteur_render` job each, the source `rendering`
 *   the Analyst          when a tenant's lessons are due (analyst.ts)
 *
 * Each call takes at most ONE source, so a drain's time stays bounded by its three Gemini calls. The
 * claim bumps `attempts`. A failed attempt keeps the claim, so the source waits the same 10
 * minutes a cut-off invocation would before it is tried again — which is the backoff — and the
 * third failure fails it, with the reason.
 *
 * With `monteur.brain: 'claude_mac'` the calls are Claude's, on the Mac (think.ts, MONTEUR.md §6.3),
 * and never Gemini's. A call still waiting there hands the source back as it was — `transcribed`,
 * the attempt not spent — and the sweep moves on to the next source; a later drain finds the answer
 * under the same request id and goes on from there. When every try of a call has failed, the source
 * stops with "Claude on the Mac didn't answer: …", whatever attempt it is on, until its Retry.
 *
 * The sweep is independent of the rest of the drain: it runs last, and api.ts catches what it
 * throws so that nothing here can fail the drain's response.
 */
import { pool } from '../../config/db.js';
import type { ClipCopy, ClipDirection, ClipEdit, MonteurSourceRow, SourcePick, StudioSettings, TranscriptWord } from '../../db/rows.js';
import { describeError, log } from '../../utils/log.js';
import { withTransaction } from '../studio/common.js';
import { buildGenContext } from '../studio/drafts.js';
import { toArabicDigits } from '../studio/generate.js';
import { enqueueMonteurRender } from '../studio/jobs.js';
import { getStudioSettings } from '../studio/settings.js';
import { currentLessons, runDueAnalyst } from './analyst.js';
import { autoApproveClips, type AutoApproveResult } from './auto.js';
import { askOf, writeCopy } from './copy.js';
import { writeEdits } from './editor.js';
import { inFlightTriggers } from './keywords.js';
import { pickClips, type PickOutcome } from './pick.js';
import { MIN_CALL_MS, usageFields } from './model.js';
import { clipsThinkKey, isThinkSignal, sourceThinkKey, ThinkExhausted, ThinkWaiting, type ThinkOn } from './think.js';
import { accentsFor, buildRenderPayload } from './render.js';
import { groupLines, type PickedClip } from './transcript.js';

/** A pick claim older than this belongs to an invocation that was cut off (or failed): retry it. */
export const PICK_STALE_MINUTES = 10;
/** The third failed attempt fails the source. */
export const MAX_PICK_ATTEMPTS = 3;
/**
 * The sweep's deadline, measured from the start of the drain request: under Vercel's 300 s, less
 * what the queue drain and the publish sweep already used. `MONTEUR_SWEEP_DEADLINE_MS` overrides.
 */
export const SWEEP_DEADLINE_MS = 270_000;
/** A pick is not started with less than this left: it is two calls. */
export const MIN_PICK_MS = 60_000;
/** Nor the Analyst with less than this: it is one. */
export const MIN_ANALYST_MS = 40_000;
/**
 * Sources one sweep looks at while each is waiting for Claude on the Mac: each costs a few queries,
 * and the loop ends at the first one that does real work, as a Gemini pick is one source per drain.
 */
export const MAX_WAITING_PER_SWEEP = 20;

export const EXHAUSTED_PICK_ERROR = `The pick did not finish ${MAX_PICK_ATTEMPTS} times.`;

/** The sweep's deadline for a drain that started at `startedAt`. */
export function sweepDeadline(startedAt: number): number {
    const configured = Number(process.env.MONTEUR_SWEEP_DEADLINE_MS);
    return startedAt + (Number.isFinite(configured) && configured > 0 ? configured : SWEEP_DEADLINE_MS);
}

/**
 * The claim. SKIP LOCKED makes two drains running at once take different sources (or one of them
 * none) instead of both picking the same video; the UPDATE runs on the row the CTE locked. A
 * deactivated tenant's sources wait, like its scheduled posts.
 */
export const CLAIM_SOURCE_SQL = `
    WITH picked AS (
        SELECT s.id
          FROM monteur_sources s
          JOIN creators c ON c.id = s.creator_id AND c.is_active = TRUE
         WHERE s.attempts < $2
           AND NOT (s.id = ANY($3::uuid[]))
           AND (s.status = 'transcribed'
                OR (s.status = 'picking' AND s.claimed_at < NOW() - make_interval(mins => $1)))
         ORDER BY s.updated_at, s.id
         LIMIT 1
           FOR UPDATE OF s SKIP LOCKED
    )
    UPDATE monteur_sources s
       SET status = 'picking', claimed_at = NOW(), attempts = s.attempts + 1, updated_at = NOW()
      FROM picked
     WHERE s.id = picked.id
 RETURNING s.id, s.creator_id, s.name, s.path, s.duration::float8 AS duration, s.words, s.pick, s.attempts`;

/** A stale claim that has used its attempts: failed, keeping the last attempt's reason. */
export const EXHAUST_SOURCES_SQL = `
    UPDATE monteur_sources
       SET status = 'failed', claimed_at = NULL, updated_at = NOW(),
           error = CASE WHEN error IS NULL THEN $3 ELSE $3 || ' The last error: ' || error END
     WHERE status = 'picking'
       AND claimed_at < NOW() - make_interval(mins => $1)
       AND attempts >= $2
 RETURNING id`;

type ClaimedSource = Pick<MonteurSourceRow, 'id' | 'creator_id' | 'name' | 'path' | 'duration' | 'words' | 'pick' | 'attempts'>;

/** What both prompts and the cut read besides the transcript (MONTEUR.md §6.1). */
export interface PickContext {
    /** The first lines of the tenant's 2 most-viewed posts of the last 90 days. */
    examples: string[];
    /** The words of every clip in flight or scheduled, and of every clip from the last 90 days. */
    existingTexts: string[];
    /** Keywords and variants reels in flight ask for: a new one must not overlap them. */
    inFlightKeywords: string[];
    inFlightVariants: string[];
    /** The tenant's last 5 asks, as templates. */
    recentAsks: string[];
}

export async function loadPickContext(creatorId: string): Promise<PickContext> {
    const firstLine = (text: string | null) => (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    const [examples, texts, keywords, asks] = await Promise.all([
        // Fail-soft: without the Growth hub's table the prompt just has no examples.
        pool.query<{ caption: string | null }>(
            `SELECT caption FROM post_insights
              WHERE creator_id = $1 AND caption IS NOT NULL AND metrics ? 'views'
                AND published_at > NOW() - make_interval(days => 90)
              ORDER BY (metrics->>'views')::numeric DESC
              LIMIT 2`,
            [creatorId]
        ).catch(() => ({ rows: [] as { caption: string | null }[] })),
        pool.query<{ text: string }>(
            `SELECT text FROM clip_drafts
              WHERE creator_id = $1 AND text IS NOT NULL
                AND (status IN ('rendering', 'review', 'scheduled') OR created_at > NOW() - make_interval(days => 90))`,
            [creatorId]
        ),
        inFlightTriggers(pool, creatorId),
        pool.query<{ caption: string | null; keyword: string | null }>(
            `SELECT copy->>'caption' AS caption, copy->>'keyword' AS keyword FROM clip_drafts
              WHERE creator_id = $1
              ORDER BY created_at DESC
              LIMIT 5`,
            [creatorId]
        ),
    ]);
    return {
        examples: examples.rows.map((r) => firstLine(r.caption).slice(0, 120)).filter(Boolean),
        existingTexts: texts.rows.map((r) => r.text),
        inFlightKeywords: keywords.keywords,
        inFlightVariants: keywords.variants,
        recentAsks: asks.rows.flatMap((r) => {
            const a = r.caption && r.keyword ? askOf(r.caption, r.keyword) : null;
            return a ? [a] : [];
        }),
    };
}

/**
 * `rendering`: clips queued. `no_clips`: nothing worth a reel. `retry`: the attempt failed and
 * waits 10 minutes. `failed`: the third did. `lost`: another attempt holds the claim now.
 * `waiting`: a call is with Claude on the Mac, and the source is back as it was, its attempt unspent.
 */
export type PickOutcomeKind = 'rendering' | 'no_clips' | 'retry' | 'failed' | 'lost' | 'waiting';

export interface MonteurSweepResult {
    /** Sources failed because their claims went stale on the last attempt. */
    exhausted: number;
    /** Auto mode's approvals this call; `error` when the step itself failed (the pick still ran). */
    auto: AutoApproveResult & { error?: string };
    /** The last source this sweep worked on. */
    pick: { source_id: string; outcome: PickOutcomeKind; clips?: number; error?: string } | null;
    /** Sources this sweep found waiting for Claude on the Mac, and moved past. */
    waiting: number;
    analyst: { creator_id: string; status: string } | null;
    /** Why part of the sweep did not run. */
    skipped?: 'no_time_for_pick' | 'no_time_for_analyst';
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/** `seen`: the sources this sweep already handed back, waiting for the Mac. */
async function claimSource(seen: readonly string[] = []): Promise<ClaimedSource | null> {
    const { rows } = await pool.query<ClaimedSource>(CLAIM_SOURCE_SQL, [PICK_STALE_MINUTES, MAX_PICK_ATTEMPTS, [...seen]]);
    return rows[0] ?? null;
}

/**
 * A call is with Claude on the Mac: the source goes back to `transcribed` with the claim's attempt
 * given back, so waiting never spends one, and the next drain's claim takes it up under the same
 * attempt, and so the same request ids. `updated_at` moves it to the back of the line, so a
 * source waiting hours between tries never holds the others up.
 */
async function releaseWaiting(source: ClaimedSource, err: ThinkWaiting): Promise<MonteurSweepResult['pick']> {
    const { rowCount } = await pool.query(
        `UPDATE monteur_sources SET status = 'transcribed', attempts = attempts - 1, claimed_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'picking' AND attempts = $2`,
        [source.id, source.attempts]
    );
    log('info', 'monteur.think_waiting', { source_id: source.id, creator_id: source.creator_id, attempt: source.attempts, why: err.message });
    return { source_id: source.id, outcome: rowCount ? 'waiting' : 'lost', clips: 0 };
}

/**
 * The attempt failed. Before the third, the claim stays, so the source is retried once it is 10
 * minutes old; the third fails it — and so does a call whose every try on the Mac failed
 * (`ThinkExhausted`), on any attempt: it stops until its Retry. Both are guarded by the attempt
 * number, so a sweep that took too long cannot overwrite a newer attempt's claim.
 */
async function failAttempt(source: ClaimedSource, err: unknown): Promise<MonteurSweepResult['pick']> {
    const message = errorText(err);
    const final = source.attempts >= MAX_PICK_ATTEMPTS || err instanceof ThinkExhausted;
    await pool.query(
        final
            ? `UPDATE monteur_sources SET status = 'failed', error = $2, claimed_at = NULL, updated_at = NOW()
                WHERE id = $1 AND status = 'picking' AND attempts = $3`
            : `UPDATE monteur_sources SET error = $2, updated_at = NOW()
                WHERE id = $1 AND status = 'picking' AND attempts = $3`,
        [source.id, message, source.attempts]
    );
    log('warn', 'monteur.pick_failed', {
        source_id: source.id, creator_id: source.creator_id, attempt: source.attempts, final, ...describeError(err),
    });
    return { source_id: source.id, outcome: final ? 'failed' : 'retry', error: message };
}

type ReadyClip = { clip: PickedClip; copy: ClipCopy; edits: ClipEdit[]; direction: ClipDirection | null };

/**
 * Clips, and their renders, in one transaction with the source's own move to `rendering` — and
 * only while this sweep still holds the claim (the same attempt number). A sweep that ran past its
 * claim's 10 minutes finds another attempt has it, and writes nothing.
 */
async function handOff(
    source: ClaimedSource, settings: StudioSettings, ready: readonly ReadyClip[], record: SourcePick, topic: string | null
): Promise<{ outcome: PickOutcomeKind; clips: number }> {
    return withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
            `UPDATE monteur_sources
                SET status = 'rendering', pick = $2::jsonb, error = NULL, claimed_at = NULL, updated_at = NOW()
              WHERE id = $1 AND status = 'picking' AND attempts = $3
          RETURNING id`,
            [source.id, JSON.stringify(record), source.attempts]
        );
        if (!rows[0]) return { outcome: 'lost', clips: 0 };
        const accents = await accentsFor(client, source.creator_id, settings, ready.length);
        const digits = settings.voice.digits === 'arabic-indic' ? toArabicDigits : (s: string) => s;
        for (const [i, { clip, copy, edits, direction }] of ready.entries()) {
            const title = digits(clip.title);
            const { rows: inserted } = await client.query<{ id: string }>(
                `INSERT INTO clip_drafts
                     (creator_id, source_id, rank, status, start_s, end_s, title, hook, why, score, topic, hook_type, scores, text, copy, edits, direction)
                 VALUES ($1, $2, $3, 'rendering', $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb, $15::jsonb, $16::jsonb)
                 RETURNING id`,
                [
                    source.creator_id, source.id, i + 1, clip.start, clip.end, title, clip.hook, clip.why, clip.score,
                    topic, clip.hookType, JSON.stringify(clip.scores), clip.text, JSON.stringify(copy), JSON.stringify(edits),
                    // SQL NULL, never the JSON null: "no plan" is the column's NULL (v29).
                    direction ? JSON.stringify(direction) : null,
                ]
            );
            await enqueueMonteurRender(client, source.creator_id, buildRenderPayload({
                clipId: inserted[0]!.id,
                source: { id: source.id, path: source.path, words: source.words as TranscriptWord[] | null },
                start: clip.start, end: clip.end, title, keyword: copy.keyword, accent: accents[i]!, settings, edits, direction,
            }));
        }
        return { outcome: 'rendering', clips: ready.length };
    });
}

/**
 * The Editor (MONTEUR.md §6.2): one call for the clips that got copy, numbered C1… in that order,
 * each clip's edits and human touches (its `direction`, null while `monteur.human` is off) set on
 * it. Best effort — any failure, the call's or its answer's, leaves every clip with no edits and
 * no touches and is logged; the reels go out regardless.
 */
async function editReady(
    source: ClaimedSource, settings: StudioSettings, ready: ReadyClip[], lines: PickOutcome['lines'],
    words: readonly TranscriptWord[], record: SourcePick, deadline: number, think?: ThinkOn,
): Promise<void> {
    let lastErr: unknown = null;
    // Asked about these clips, in this order: C1… is by position (think.ts, clipsThinkKey).
    const on = think ? { ...think, key: clipsThinkKey(think.key, ready.map((r) => r.clip)) } : undefined;
    for (let attempt = 0; ; attempt++) {
        try {
            const { edits, directions, cost } = await writeEdits(ready.map((r) => r.clip), lines, words, settings, deadline, on);
            ready.forEach((r, i) => {
                r.edits = edits[i] ?? [];
                r.direction = directions[i] ?? null;
            });
            record.edit = { model: cost.model, tokens_in: cost.tokens_in, tokens_out: cost.tokens_out };
            log('info', 'monteur.edit', {
                source_id: source.id, creator_id: source.creator_id, ...usageFields(cost),
                clips: ready.length, edits: edits.reduce((n, e) => n + e.length, 0), touches: directions.reduce((n, d) => n + touchCount(d), 0),
                attempt: attempt + 1,
            });
            return;
        } catch (err) {
            // With Claude as the brain the edits are waited for, never dropped: a call still on the
            // Mac hands the source back, one whose every try failed stops it, and anything else
            // (the queue unreachable) fails the attempt, to be tried again in 10 minutes.
            if (think || isThinkSignal(err)) throw err;
            lastErr = err;
            // A busy model clears in seconds (every model in the chain answered 503 "high demand"
            // at once on 2026-09-27, and that reel went out without its edits): wait and ask again,
            // while there is time before the drain's deadline.
            const wait = editRetryWaitsMs[attempt];
            if (wait === undefined || !transientModelError(err) || Date.now() + wait + MIN_CALL_MS > deadline) break;
            log('info', 'monteur.edit_retry', { source_id: source.id, attempt: attempt + 1, wait_ms: wait, error: errorText(err) });
            await new Promise((r) => setTimeout(r, wait));
        }
    }
    for (const r of ready) {
        r.edits = [];
        r.direction = null;
    }
    record.edit = { model: null, tokens_in: 0, tokens_out: 0, error: errorText(lastErr) };
    log('warn', 'monteur.edit_failed', { source_id: source.id, creator_id: source.creator_id, error: errorText(lastErr), ...describeError(lastErr) });
}

/** How many touches a plan holds, every list together. */
const touchCount = (d: ClipDirection | null): number => (d ? Object.values(d).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0) : 0);

/** How long the Editor waits before each retry of a busy model. Tests set it to [0, 0]. */
let editRetryWaitsMs: readonly number[] = [6_000, 20_000];
export function setEditRetryWaits(next: readonly number[]): readonly number[] {
    const prev = editRetryWaitsMs;
    editRetryWaitsMs = next;
    return prev;
}

/** A failure a short wait may cure: the model busy or rate-limited, not a bad request or a bad answer. */
export function transientModelError(err: unknown): boolean {
    return /\b(429|500|502|503|504)\b|high demand|overloaded|unavailable|RESOURCE_EXHAUSTED|timed out/i.test(errorText(err));
}

/** One claimed source through the three calls and the hand-off. Never throws for a model's failure. */
async function pickSource(source: ClaimedSource, deadline: number): Promise<MonteurSweepResult['pick']> {
    const began = Date.now();
    try {
        const settings = await getStudioSettings(source.creator_id);
        // Claude on the Mac, keyed by this attempt: the drain that finds an answer reads it by the same key.
        const think: ThinkOn | undefined = settings.monteur.brain === 'claude_mac'
            ? { creatorId: source.creator_id, key: sourceThinkKey(source.id, source.attempts) }
            : undefined;
        const [lessons, context] = await Promise.all([currentLessons(pool, source.creator_id), loadPickContext(source.creator_id)]);
        const words = Array.isArray(source.words) ? source.words : [];

        // A copy that failed last time is retried on the clips already chosen: the transcript is
        // most of the tokens, and it is not sent twice.
        const saved = source.pick?.saved;
        let picked: Pick<PickOutcome, 'kept' | 'topic' | 'considered' | 'lines'> & { problems?: string[] };
        let record: SourcePick;
        if (saved && Array.isArray(saved.clips) && saved.clips.length) {
            picked = { kept: saved.clips as PickedClip[], topic: saved.topic, considered: source.pick!.considered, lines: groupLines(words) };
            record = { ...source.pick! };
            log('info', 'monteur.pick_reused', { source_id: source.id, clips: saved.clips.length });
        } else {
            const fresh = await pickClips({ words, duration: source.duration }, settings, { ...context, lessons }, deadline, think);
            picked = fresh;
            record = {
                model: fresh.cost.model, tokens_in: fresh.cost.tokens_in, tokens_out: fresh.cost.tokens_out, considered: fresh.considered,
            };
            log('info', 'monteur.pick', {
                source_id: source.id, creator_id: source.creator_id, ...usageFields(fresh.cost),
                lines: fresh.lines.length, considered: fresh.considered, kept: fresh.kept.length, ms: Date.now() - began,
            });
            if (fresh.kept.length) {
                record.saved = { topic: fresh.topic, clips: fresh.kept };
                const { rowCount } = await pool.query(
                    `UPDATE monteur_sources SET pick = $2::jsonb, updated_at = NOW()
                      WHERE id = $1 AND status = 'picking' AND attempts = $3`,
                    [source.id, JSON.stringify(record), source.attempts]
                );
                // Another attempt holds the claim now (this one ran past its 10 minutes): its own
                // copy call will follow, so this one spends nothing more.
                if (!rowCount) return { source_id: source.id, outcome: 'lost', clips: 0 };
            }
        }

        if (!picked.kept.length) {
            // Say why, so the operator isn't left guessing: the repair round's own words, or that
            // the model rated every moment below the bar. Kept on `pick` for the record too.
            const problems = (picked.problems ?? []).slice(0, 8);
            if (problems.length) record.problems = problems;
            const why = problems.length
                ? problems.slice(0, 2).join(' · ')
                : picked.considered ? `The model rated all ${picked.considered} moment(s) it proposed below the bar (hook or standalone ≤ 1, or rank under 9).` : null;
            const { rows } = await pool.query<{ id: string }>(
                `UPDATE monteur_sources SET status = 'no_clips', pick = $2::jsonb, error = $4, claimed_at = NULL, updated_at = NOW()
                  WHERE id = $1 AND status = 'picking' AND attempts = $3
              RETURNING id`,
                [source.id, JSON.stringify(record), source.attempts, why]
            );
            return { source_id: source.id, outcome: rows[0] ? 'no_clips' : 'lost', clips: 0 };
        }

        const ctx = await buildGenContext(source.creator_id, settings);
        const copy = await writeCopy(picked.kept, picked.lines, settings, {
            activeKeywords: ctx.activeKeywords, seo: ctx.seo, recentAsks: context.recentAsks,
            inFlightKeywords: context.inFlightKeywords, inFlightVariants: context.inFlightVariants,
        }, lessons, deadline, think);
        log('info', 'monteur.copy', {
            source_id: source.id, creator_id: source.creator_id, ...usageFields(copy.cost),
            clips: picked.kept.length, usable: copy.outcomes.filter((o) => 'copy' in o).length,
        });
        record.copy = { model: copy.cost.model, tokens_in: copy.cost.tokens_in, tokens_out: copy.cost.tokens_out };

        const ready: ReadyClip[] = [];
        const unusable: string[] = [];
        picked.kept.forEach((clip, i) => {
            const outcome = copy.outcomes[i];
            if (outcome && 'copy' in outcome) ready.push({ clip, copy: outcome.copy, edits: [], direction: null });
            else unusable.push(`clip ${i + 1}: ${outcome?.error ?? 'no copy'}`);
        });
        if (unusable.length) log('warn', 'monteur.copy_unusable', { source_id: source.id, dropped: unusable.length, reasons: unusable });
        if (!ready.length) throw new Error(`The Marketer's copy could not be used: ${unusable.join('; ')}`);

        await editReady(source, settings, ready, picked.lines, words, record, deadline, think);
        const handed = await handOff(source, settings, ready, record, picked.topic);
        return { source_id: source.id, outcome: handed.outcome, clips: handed.clips };
    } catch (err) {
        if (err instanceof ThinkWaiting) return releaseWaiting(source, err);
        return failAttempt(source, err);
    }
}

/**
 * One sweep: fail the exhausted claims, approve auto mode's reels, pick at most one source, then
 * run the Analyst for one tenant whose lessons are due — the model calls each only with time left
 * before `deadline`. The approvals come first: they are a few queries, and need no model. A source
 * found waiting for Claude on the Mac does not count as the one: the sweep moves on to the next.
 */
export async function sweepMonteur(opts: { deadline?: number } = {}): Promise<MonteurSweepResult> {
    const deadline = opts.deadline ?? sweepDeadline(Date.now());
    const { rowCount } = await pool.query(EXHAUST_SOURCES_SQL, [PICK_STALE_MINUTES, MAX_PICK_ATTEMPTS, EXHAUSTED_PICK_ERROR]);
    const result: MonteurSweepResult = { exhausted: rowCount ?? 0, auto: { approved: 0, refused: 0 }, pick: null, waiting: 0, analyst: null };
    if (result.exhausted) log('warn', 'monteur.picks_exhausted', { sources: result.exhausted });
    try {
        result.auto = await autoApproveClips();
    } catch (err) {
        result.auto = { approved: 0, refused: 0, error: errorText(err) };
        log('error', 'monteur.auto_failed', describeError(err));
    }

    if (deadline - Date.now() < MIN_PICK_MS) {
        result.skipped = 'no_time_for_pick';
        return result;
    }
    const seen: string[] = [];
    while (seen.length < MAX_WAITING_PER_SWEEP && deadline - Date.now() >= MIN_PICK_MS) {
        const source = await claimSource(seen);
        if (!source) break;
        seen.push(source.id);
        result.pick = await pickSource(source, deadline);
        if (result.pick?.outcome !== 'waiting') break;
        result.waiting += 1;
    }

    if (deadline - Date.now() < MIN_ANALYST_MS) {
        result.skipped = 'no_time_for_analyst';
        return result;
    }
    result.analyst = await runDueAnalyst(deadline);
    return result;
}
