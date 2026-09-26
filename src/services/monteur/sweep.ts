/**
 * The pick sweep (MONTEUR.md §6), run by `GET /api/jobs/drain` after everything else it does.
 *
 *   claim one source     `transcribed`, or `picking` with a claim older than 10 minutes, atomically
 *   1. the Monteur       one call: which lines make the reels (pick.ts)
 *   2. the Marketer      one call for all of them: captions, keyword, DM (copy.ts)
 *   3. hand-off          clip rows `rendering`, one `monteur_render` job each, the source `rendering`
 *   the Analyst          when a tenant's lessons are due (analyst.ts)
 *
 * Each call takes at most ONE source, so a drain's time stays bounded by two Gemini calls. The
 * claim bumps `attempts`. A failed attempt keeps the claim, so the source waits the same 10
 * minutes a cut-off invocation would before it is tried again — which is the backoff — and the
 * third failure fails it, with the reason.
 *
 * The sweep is independent of the rest of the drain: it runs last, and api.ts catches what it
 * throws so that nothing here can fail the drain's response.
 */
import { pool } from '../../config/db.js';
import type { ClipCopy, MonteurSourceRow, SourcePick, StudioSettings, TranscriptWord } from '../../db/rows.js';
import { describeError, log } from '../../utils/log.js';
import { withTransaction } from '../studio/common.js';
import { buildGenContext } from '../studio/drafts.js';
import { toArabicDigits } from '../studio/generate.js';
import { enqueueMonteurRender } from '../studio/jobs.js';
import { getStudioSettings } from '../studio/settings.js';
import { currentLessons, runDueAnalyst } from './analyst.js';
import { writeCopy } from './copy.js';
import { pickClips } from './pick.js';
import { usageFields } from './model.js';
import { accentsFor, buildRenderPayload } from './render.js';
import type { PickedClip } from './transcript.js';

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
 RETURNING s.id, s.creator_id, s.name, s.path, s.duration::float8 AS duration, s.words, s.attempts`;

/** A stale claim that has used its attempts: failed, keeping the last attempt's reason. */
export const EXHAUST_SOURCES_SQL = `
    UPDATE monteur_sources
       SET status = 'failed', claimed_at = NULL, updated_at = NOW(),
           error = CASE WHEN error IS NULL THEN $3 ELSE $3 || ' The last error: ' || error END
     WHERE status = 'picking'
       AND claimed_at < NOW() - make_interval(mins => $1)
       AND attempts >= $2
 RETURNING id`;

type ClaimedSource = Pick<MonteurSourceRow, 'id' | 'creator_id' | 'name' | 'path' | 'duration' | 'words' | 'attempts'>;

/**
 * `rendering`: clips queued. `no_clips`: nothing worth a reel. `retry`: the attempt failed and
 * waits 10 minutes. `failed`: the third did. `lost`: another attempt holds the claim now.
 */
export type PickOutcomeKind = 'rendering' | 'no_clips' | 'retry' | 'failed' | 'lost';

export interface MonteurSweepResult {
    /** Sources failed because their claims went stale on the last attempt. */
    exhausted: number;
    pick: { source_id: string; outcome: PickOutcomeKind; clips?: number; error?: string } | null;
    analyst: { creator_id: string; status: string } | null;
    /** Why part of the sweep did not run. */
    skipped?: 'no_time_for_pick' | 'no_time_for_analyst';
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500);

async function claimSource(): Promise<ClaimedSource | null> {
    const { rows } = await pool.query<ClaimedSource>(CLAIM_SOURCE_SQL, [PICK_STALE_MINUTES, MAX_PICK_ATTEMPTS]);
    return rows[0] ?? null;
}

/**
 * The attempt failed. Before the third, the claim stays, so the source is retried once it is 10
 * minutes old; the third fails it. Both are guarded by the attempt number, so a sweep that took
 * too long cannot overwrite a newer attempt's claim.
 */
async function failAttempt(source: ClaimedSource, err: unknown): Promise<MonteurSweepResult['pick']> {
    const message = errorText(err);
    const final = source.attempts >= MAX_PICK_ATTEMPTS;
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

type ReadyClip = { clip: PickedClip; copy: ClipCopy };

/**
 * Clips, and their renders, in one transaction with the source's own move to `rendering` — and
 * only while this sweep still holds the claim (the same attempt number). A sweep that ran past its
 * claim's 10 minutes finds another attempt has it, and writes nothing.
 */
async function handOff(
    source: ClaimedSource, settings: StudioSettings, ready: readonly ReadyClip[], record: SourcePick
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
        for (const [i, { clip, copy }] of ready.entries()) {
            const title = digits(clip.title);
            const { rows: inserted } = await client.query<{ id: string }>(
                `INSERT INTO clip_drafts (creator_id, source_id, rank, status, start_s, end_s, title, hook, why, score, copy)
                 VALUES ($1, $2, $3, 'rendering', $4, $5, $6, $7, $8, $9, $10::jsonb)
                 RETURNING id`,
                [source.creator_id, source.id, i + 1, clip.start, clip.end, title, clip.hook, clip.why, clip.score, JSON.stringify(copy)]
            );
            await enqueueMonteurRender(client, source.creator_id, buildRenderPayload({
                clipId: inserted[0]!.id,
                source: { id: source.id, path: source.path, words: source.words as TranscriptWord[] | null },
                start: clip.start, end: clip.end, title, keyword: copy.keyword, accent: accents[i]!, settings,
            }));
        }
        return { outcome: 'rendering', clips: ready.length };
    });
}

/** One claimed source through both calls and the hand-off. Never throws for a model's failure. */
async function pickSource(source: ClaimedSource, deadline: number): Promise<MonteurSweepResult['pick']> {
    const began = Date.now();
    try {
        const settings = await getStudioSettings(source.creator_id);
        const lessons = await currentLessons(pool, source.creator_id);
        const words = Array.isArray(source.words) ? source.words : [];
        const picked = await pickClips({ words, duration: source.duration }, settings, lessons, deadline);
        const record: SourcePick = {
            model: picked.cost.model, tokens_in: picked.cost.tokens_in, tokens_out: picked.cost.tokens_out, considered: picked.considered,
        };
        log('info', 'monteur.pick', {
            source_id: source.id, creator_id: source.creator_id, ...usageFields(picked.cost),
            lines: picked.lines.length, considered: picked.considered, kept: picked.kept.length, ms: Date.now() - began,
        });

        if (!picked.kept.length) {
            const { rows } = await pool.query<{ id: string }>(
                `UPDATE monteur_sources SET status = 'no_clips', pick = $2::jsonb, error = NULL, claimed_at = NULL, updated_at = NOW()
                  WHERE id = $1 AND status = 'picking' AND attempts = $3
              RETURNING id`,
                [source.id, JSON.stringify(record), source.attempts]
            );
            return { source_id: source.id, outcome: rows[0] ? 'no_clips' : 'lost', clips: 0 };
        }

        const ctx = await buildGenContext(source.creator_id, settings);
        const copy = await writeCopy(picked.kept, picked.lines, settings, ctx, lessons, deadline);
        log('info', 'monteur.copy', {
            source_id: source.id, creator_id: source.creator_id, ...usageFields(copy.cost),
            clips: picked.kept.length, usable: copy.outcomes.filter((o) => 'copy' in o).length,
        });
        record.copy = { model: copy.cost.model, tokens_in: copy.cost.tokens_in, tokens_out: copy.cost.tokens_out };

        const ready: ReadyClip[] = [];
        const unusable: string[] = [];
        picked.kept.forEach((clip, i) => {
            const outcome = copy.outcomes[i];
            if (outcome && 'copy' in outcome) ready.push({ clip, copy: outcome.copy });
            else unusable.push(`clip ${i + 1}: ${outcome?.error ?? 'no copy'}`);
        });
        if (unusable.length) log('warn', 'monteur.copy_unusable', { source_id: source.id, dropped: unusable.length, reasons: unusable });
        if (!ready.length) throw new Error(`The Marketer's copy could not be used: ${unusable.join('; ')}`);

        const handed = await handOff(source, settings, ready, record);
        return { source_id: source.id, outcome: handed.outcome, clips: handed.clips };
    } catch (err) {
        return failAttempt(source, err);
    }
}

/**
 * One sweep: fail the exhausted claims, pick at most one source, then run the Analyst for one
 * tenant whose lessons are due — each only with time left before `deadline` for its calls.
 */
export async function sweepMonteur(opts: { deadline?: number } = {}): Promise<MonteurSweepResult> {
    const deadline = opts.deadline ?? sweepDeadline(Date.now());
    const { rowCount } = await pool.query(EXHAUST_SOURCES_SQL, [PICK_STALE_MINUTES, MAX_PICK_ATTEMPTS, EXHAUSTED_PICK_ERROR]);
    const result: MonteurSweepResult = { exhausted: rowCount ?? 0, pick: null, analyst: null };
    if (result.exhausted) log('warn', 'monteur.picks_exhausted', { sources: result.exhausted });

    if (deadline - Date.now() < MIN_PICK_MS) {
        result.skipped = 'no_time_for_pick';
        return result;
    }
    const source = await claimSource();
    if (source) result.pick = await pickSource(source, deadline);

    if (deadline - Date.now() < MIN_ANALYST_MS) {
        result.skipped = 'no_time_for_analyst';
        return result;
    }
    result.analyst = await runDueAnalyst(deadline);
    return result;
}
