/**
 * What the Studio queue does with the four explainer job kinds when a job ends (jobs.ts `completeJob` and `failJob` call these, inside the job's
 * transaction, as they call `applyInfographicRender` for an infographic).
 *
 *   explainer_write   the script: scenes replaced, `draft_version` + 1, status `draft`, with what `checkDraft` found as warnings; a script written with no
 *                     web read at all (`research_rounds` 0) is flagged `research_limited`
 *   explainer_voice   the audio and the times of every scene and word, only for the version that was voiced; status `drawing`, and the drawing queued
 *   explainer_draw    `paused`: the next `explainer_draw` queued for the hour the allowance resets; `done`: the status is `review` already; `failed`: the
 *                     reason is kept and the explainer stays `drawing`, for the owner to redraw or press Continue
 *   explainer_render  the three files, status `ready`; a render for an older version is still stored, and flagged as older than the edits
 *
 * A result is applied only if the job is `explainers.job_id` (data-model §5): an older job's answer, or a job of an explainer that was deleted or has moved
 * on, is dropped and logged, never half-applied. The Gemini writer's answer goes through the same door (`completeJob` on its own job), so there is one way a
 * draft lands.
 *
 * The queue is handed in (`ExplainerApplyDeps`), not imported: jobs.ts imports this file, and this file needs jobs.ts's `enqueueJob`, so importing it would
 * be a cycle. jobs.ts passes its own functions; the tests pass the same ones.
 */
import type { ExplainerAudio, ExplainerDraft, ExplainerRow, ExplainerSceneRow, ExplainerStep, ExplainerWords, StudioJobKind, StudioJobRow } from '../../db/rows.js';
import { log } from '../../utils/log.js';
import { getPublicBaseUrl } from '../appSettings.js';
import { getMediaStore, uploadIdFromUrl } from '../storage.js';
import { type Exec, isFiniteNumber, isPlainObject, problemsError, UUID_PATTERN } from '../studio/common.js';
import { getStudioSettings } from '../studio/settings.js';
import { drawPayload, voicePayload } from './payloads.js';
import { checkDraft, type DraftFinding } from './spec.js';
import { transitionExplainer } from './state.js';
import { loadScenes, lockExplainer, replaceScenes, updateExplainerFields } from './store.js';
import { nextGeminiQuotaReset, nextUtcMidnight } from './time.js';
import { parseWriterOutput } from './writerOutput.js';

export const EXPLAINER_JOB_KINDS = ['explainer_write', 'explainer_voice', 'explainer_draw', 'explainer_render'] as const satisfies readonly StudioJobKind[];
export type ExplainerJobKind = (typeof EXPLAINER_JOB_KINDS)[number];

export function isExplainerJobKind(kind: string): kind is ExplainerJobKind {
    return (EXPLAINER_JOB_KINDS as readonly string[]).includes(kind);
}

/** The part of a locked `studio_jobs` row the appliers need: the job's tenant, its kind, and the payload it was queued with. */
export type ExplainerJob = Pick<StudioJobRow, 'id' | 'creator_id' | 'payload'> & { kind: ExplainerJobKind };

/** What `completeJob` stores and reports, as for every other kind: `dropped` is a result that was not applied. */
export interface ExplainerApplied {
    outcome: 'applied' | 'dropped';
    stored: unknown;
}

/** What the appliers need from the queue (jobs.ts): see the top of the file for why it is handed in. */
export interface ExplainerApplyDeps {
    enqueue(exec: Exec, creatorId: string, kind: StudioJobKind, payload: object, opts?: { notBefore?: Date }): Promise<{ id: string }>;
    /** Every file named is this tenant's upload, of the type named (jobs.ts `checkRenderFiles`). Throws a 400 when one is not. */
    checkFiles(exec: Exec, creatorId: string, wanted: readonly [id: string, mime: string, label: string][]): Promise<void>;
    /** Deletes these uploads unless a post or another record still names them (jobs.ts `deleteUnreferencedUploads`). */
    deleteFiles(exec: Exec, creatorId: string, urls: readonly (string | null | undefined)[], keep?: ReadonlySet<string>): Promise<number>;
    /** The clock, for the tests. */
    now?(): number;
}

/** The state each step runs in: a job's end is applied only to an explainer that is still there. */
const RUNS_IN = { explainer_write: 'writing', explainer_voice: 'voicing', explainer_draw: 'drawing', explainer_render: 'rendering' } as const;
const STEP_OF = { explainer_write: 'write', explainer_voice: 'voice', explainer_draw: 'draw', explainer_render: 'render' } as const satisfies Record<ExplainerJobKind, ExplainerStep>;

/** The most problems a refused result lists: the rest are the same mistake again. */
const MAX_PROBLEMS = 20;

// ─── Which explainer, and is this job still its job ────────────────────────────────────────────

function explainerIdOf(job: ExplainerJob): string | null {
    const id = isPlainObject(job.payload) ? job.payload.explainer_id : undefined;
    return typeof id === 'string' && UUID_PATTERN.test(id) ? id.toLowerCase() : null;
}

/**
 * The explainer this job is for, locked, when the job is still the one working on it: the row, or why not. Only the result of `explainers.job_id` is applied,
 * which is how an older write, a voice that was asked for again and a render that was superseded stop at the door.
 */
async function lockCurrent(exec: Exec, job: ExplainerJob): Promise<{ row: ExplainerRow } | { dropped: 'no_explainer' | 'gone' | 'superseded' }> {
    const id = explainerIdOf(job);
    if (!id) return { dropped: 'no_explainer' };
    const row = await lockExplainer(exec, job.creator_id, id);
    if (!row) return { dropped: 'gone' };
    if (row.job_id !== job.id) return { dropped: 'superseded' };
    return { row };
}

function dropped(job: ExplainerJob, reason: string, extra: Record<string, unknown> = {}): ExplainerApplied {
    log('info', 'explainer.result_dropped', { job_id: job.id, kind: job.kind, creator_id: job.creator_id, explainer_id: explainerIdOf(job), reason, ...extra });
    return { outcome: 'dropped', stored: { dropped: reason } };
}

// ─── explainer_write ───────────────────────────────────────────────────────────────────────────

/** Who wrote the script: the server-side Gemini run queues its own job and says so (fallback.ts); everything else is Claude on the Mac. */
export function writerOf(job: Pick<ExplainerJob, 'payload'>): 'claude_mac' | 'gemini' {
    return isPlainObject(job.payload) && job.payload.writer === 'gemini' ? 'gemini' : 'claude_mac';
}

/**
 * `research_rounds`: how many rounds of web reading the Mac's writer did. A whole number from 0, else unknown: a worker that does not send it, and a
 * Gemini run (its grounding gives its sources), are not "written from memory".
 */
function researchRoundsOf(result: Record<string, unknown>): number | null {
    const rounds = result.research_rounds;
    return typeof rounds === 'number' && Number.isInteger(rounds) && rounds >= 0 ? rounds : null;
}

/** What is said when the writer read no page at all. The owner may still approve over it, as over every warning. */
export const RESEARCH_LIMITED_MESSAGE =
    'The writer did not read any web page for this script: it was written from memory. Check every fact and every source before approving.';

async function applyWrite(exec: Exec, job: ExplainerJob, result: unknown): Promise<ExplainerApplied> {
    if (!isPlainObject(result)) throw problemsError(['An explainer_write result is { written, model }.'], 'the writer\'s result');
    const parsed = parseWriterOutput(result.written);
    if (!parsed.ok) throw problemsError(parsed.problems.slice(0, MAX_PROBLEMS), 'the writer\'s answer');

    const current = await lockCurrent(exec, job);
    if ('dropped' in current) return dropped(job, current.dropped);
    const { row } = current;
    if (row.status !== RUNS_IN.explainer_write) return dropped(job, `not_${RUNS_IN.explainer_write}`, { status: row.status });

    const settings = await getStudioSettings(row.creator_id, exec);
    const known = new Set(settings.explainer.characters.map((c) => c.key));
    let unknownKeys = 0;
    const scenes = parsed.output.scenes.map((scene) => {
        const characters = [...new Set(scene.characters)].filter((key) => known.has(key));
        unknownKeys += new Set(scene.characters).size - characters.length;
        return { ...scene, characters };
    });
    const output = { ...parsed.output, scenes };

    const check = checkDraft(output, { tier: row.length_tier, language: row.language, pace: settings.explainer.pace[row.language] });
    const rounds = writerOf(job) === 'claude_mac' ? researchRoundsOf(result) : null;
    const warnings: DraftFinding[] = [...check.warnings];
    if (rounds === 0) warnings.push({ code: 'research_limited', message: RESEARCH_LIMITED_MESSAGE });

    const writer = writerOf(job);
    const draft: ExplainerDraft = {
        writer, captions: output.captions, first_comment: output.first_comment, replies: output.replies, sources: output.sources,
        est_seconds: check.est_seconds, warnings,
    };
    await replaceScenes(exec, row.creator_id, row.id, scenes);
    await transitionExplainer(exec, row.id, [RUNS_IN.explainer_write], 'draft', { title: output.title, draft, draft_version: row.draft_version + 1, job_id: null }, row.creator_id);
    log('info', 'explainer.draft_written', {
        explainer_id: row.id, job_id: job.id, writer, model: typeof result.model === 'string' ? result.model.slice(0, 100) : null, scenes: scenes.length,
        sources: output.sources.length, est_seconds: check.est_seconds, problems: check.problems.map((p) => p.code), warnings: warnings.map((w) => w.code),
        research_rounds: rounds, unknown_characters_dropped: unknownKeys,
    });
    return {
        outcome: 'applied',
        stored: {
            scenes: scenes.length, sources: output.sources.length, est_seconds: check.est_seconds, writer, model: typeof result.model === 'string' ? result.model.slice(0, 100) : null,
            warnings: warnings.map((w) => w.code), problems: check.problems.map((p) => p.code), research_rounds: rounds,
        },
    };
}

// ─── explainer_voice ───────────────────────────────────────────────────────────────────────────

interface VoiceResult {
    audio: { url: string; mediaId: string; duration: number; voice: string; fallback: boolean };
    version: number;
    scenes: { position: number; start: number; end: number }[];
    words: ExplainerWords;
}

/** The longest a scene's words may be, and the most a result carries: a sentence is 8 to 16 words, so these are far past anything real. */
const MAX_WORDS_PER_SCENE = 300;
/** The audio may end this much after the last scene's end before the result is refused: the worker rounds floats. */
const TIMING_SLACK_S = 0.5;
/** Two scenes may overlap by this much (rounding) and no more. */
const OVERLAP_SLACK_S = 0.05;

/**
 * The worker's voice result as a typed value, or a 400 saying what is wrong with it (the job stays claimed and the worker reports the failure). The scenes
 * must be the explainer's own, every one, in order, with times that make a video: a result that is not would be stored and then fail every render.
 */
export function parseVoiceResult(raw: unknown, positions: readonly number[]): VoiceResult {
    const problems: string[] = [];
    if (!isPlainObject(raw)) throw problemsError(['A voice result is { audio, version, scenes, words }.'], 'the voice result');
    const audio = isPlainObject(raw.audio) ? raw.audio : null;
    const mediaId = audio && typeof audio.url === 'string' ? uploadIdFromUrl(audio.url) : null;
    if (!audio) problems.push('audio must be { url, duration, voice, fallback }');
    else {
        if (!mediaId) problems.push('audio.url is not one of this app\'s upload URLs');
        if (!(isFiniteNumber(audio.duration) && audio.duration > 0)) problems.push('audio.duration must be the audio\'s length in seconds');
        if (typeof audio.voice !== 'string' || !audio.voice.trim()) problems.push('audio.voice must be the voice that spoke');
        if (typeof audio.fallback !== 'boolean') problems.push('audio.fallback must be true or false');
    }
    if (!(Number.isInteger(raw.version) && (raw.version as number) >= 0)) problems.push('version must be the version that was voiced');

    const scenes: VoiceResult['scenes'] = [];
    if (!Array.isArray(raw.scenes)) problems.push('scenes must be a list of { position, start, end }');
    else {
        if (raw.scenes.length !== positions.length) problems.push(`scenes has ${raw.scenes.length} entries for ${positions.length} scenes`);
        raw.scenes.forEach((entry: unknown, i: number) => {
            const scene = isPlainObject(entry) ? entry : {};
            if (!(Number.isInteger(scene.position) && scene.position === positions[i])) problems.push(`scenes[${i}].position must be ${positions[i] ?? 'a scene of this explainer'}`);
            if (!(isFiniteNumber(scene.start) && scene.start >= 0)) problems.push(`scenes[${i}].start must be a time in seconds`);
            else if (!(isFiniteNumber(scene.end) && scene.end > scene.start)) problems.push(`scenes[${i}].end must be after its start`);
            else scenes.push({ position: scene.position as number, start: scene.start, end: scene.end });
        });
        for (let i = 1; i < scenes.length; i++) {
            if (scenes[i]!.start < scenes[i - 1]!.end - OVERLAP_SLACK_S) problems.push(`scenes[${i}] starts before the scene before it ends`);
        }
        const duration = audio && isFiniteNumber(audio.duration) && audio.duration > 0 ? audio.duration : null;
        const last = scenes.at(-1);
        if (duration !== null && last && last.end > duration + TIMING_SLACK_S) problems.push(`the last scene ends at ${last.end} s, after the audio's ${duration} s`);
    }

    const words: ExplainerWords = {};
    if (!isPlainObject(raw.words)) problems.push('words must be { "<position>": [[start, end, word], …] }');
    else {
        for (const [key, list] of Object.entries(raw.words)) {
            const position = Number(key);
            if (!Number.isInteger(position) || !positions.includes(position)) {
                problems.push(`words has "${key}", which is not a scene of this explainer`);
                continue;
            }
            if (!Array.isArray(list) || list.length > MAX_WORDS_PER_SCENE) {
                problems.push(`words["${key}"] must be a list of at most ${MAX_WORDS_PER_SCENE} [start, end, word]`);
                continue;
            }
            const kept = list.flatMap((w: unknown): [number, number, string][] =>
                Array.isArray(w) && isFiniteNumber(w[0]) && isFiniteNumber(w[1]) && w[1] >= w[0] && typeof w[2] === 'string' && w[2].length > 0 && w[2].length <= 100
                    ? [[w[0], w[1], w[2]]] : []);
            if (kept.length !== list.length) problems.push(`words["${key}"] has ${list.length - kept.length} entries that are not [start, end, word]`);
            words[String(position)] = kept;
        }
    }
    if (problems.length) throw problemsError(problems.slice(0, MAX_PROBLEMS), 'the voice result');
    return {
        audio: { url: audio!.url as string, mediaId: mediaId!, duration: audio!.duration as number, voice: (audio!.voice as string).trim(), fallback: audio!.fallback as boolean },
        version: raw.version as number, scenes, words,
    };
}

async function applyVoice(exec: Exec, job: ExplainerJob, result: unknown, deps: ExplainerApplyDeps): Promise<ExplainerApplied> {
    const id = explainerIdOf(job);
    const current = await lockCurrent(exec, job);
    if ('dropped' in current) return dropped(job, current.dropped);
    const { row } = current;
    if (row.status !== RUNS_IN.explainer_voice) return dropped(job, `not_${RUNS_IN.explainer_voice}`, { status: row.status });

    const scenes = await loadScenes(exec, row.creator_id, row.id, true);
    const voice = parseVoiceResult(result, scenes.map((s) => s.position));
    if (voice.version !== row.draft_version) {
        // The narration moved on while it was being voiced (an edit is refused during voicing, so this is a guard, not a flow). The audio is for words that are
        // no longer the script's: it is not stored, and the explainer is not left waiting for a result that will not come.
        log('warn', 'explainer.voice_stale', { explainer_id: row.id, job_id: job.id, voiced: voice.version, current: row.draft_version });
        await transitionExplainer(exec, row.id, ['voicing'], 'failed', {
            failed_step: 'voice', error: 'The narration changed while it was being voiced, so this audio is out of date. Voice it again.', job_id: null,
        }, row.creator_id);
        return { outcome: 'dropped', stored: { dropped: 'stale_version', voiced: voice.version, current: row.draft_version } };
    }

    await deps.checkFiles(exec, row.creator_id, [[voice.audio.mediaId, 'audio/mp4', 'audio.url']]);
    // Kept by id, rebuilt on our own address: never the string a worker sent (it could name one of our ids inside another host's URL).
    const base = await getPublicBaseUrl(null);
    if (!base) throw problemsError(['No public address for this app: set it in Settings → TikTok app.'], 'the voice result', 500);
    const url = (await getMediaStore()).publicUrl(voice.audio.mediaId, base);
    const audio: ExplainerAudio = {
        url, media_id: voice.audio.mediaId, duration: voice.audio.duration, voice: voice.audio.voice, version: voice.version, words_version: voice.version, fallback: voice.audio.fallback,
    };

    await exec.query(
        `UPDATE explainer_scenes s SET start_s = x.start, end_s = x."end", updated_at = NOW()
           FROM jsonb_to_recordset($3::jsonb) AS x(position INT, start NUMERIC, "end" NUMERIC)
          WHERE s.explainer_id = $1 AND s.creator_id = $2 AND s.position = x.position`,
        [row.id, row.creator_id, JSON.stringify(voice.scenes)]
    );
    // The old audio's file goes, unless this is the same one: a re-voice makes a new upload and the old one has no reader left.
    const previous = row.audio;
    const draw = await deps.enqueue(exec, row.creator_id, 'explainer_draw', drawPayload(row));
    await transitionExplainer(exec, row.id, ['voicing'], 'drawing', { audio, words: voice.words, job_id: draw.id, draw_paused_until: null }, row.creator_id);
    if (previous && previous.media_id !== audio.media_id) await deps.deleteFiles(exec, row.creator_id, [previous.url], new Set([audio.media_id]));
    log('info', 'explainer.voiced', { explainer_id: id, job_id: job.id, duration: audio.duration, scenes: voice.scenes.length, fallback: audio.fallback, draw_job_id: draw.id });
    return { outcome: 'applied', stored: { duration: audio.duration, scenes: voice.scenes.length, fallback: audio.fallback, draw_job_id: draw.id } };
}

// ─── explainer_draw ────────────────────────────────────────────────────────────────────────────

/**
 * When a paused drawing is asked to come back: the instant the worker said (`until`), if it is a time between a minute and two days away, else the next UTC
 * midnight plus five minutes (the image allowance is counted per UTC day). A worker that sends nonsense must not make the explainer wait for a year or spin.
 */
export function resumeAt(until: unknown, now: number): Date {
    const asked = typeof until === 'string' ? Date.parse(until) : Number.NaN;
    if (Number.isFinite(asked) && asked >= now + 60_000 && asked <= now + 48 * 3_600_000) return new Date(asked);
    return new Date(nextUtcMidnight(now).getTime() + 5 * 60_000);
}

const isPending = (scene: Pick<ExplainerSceneRow, 'draw_status'>): boolean => scene.draw_status === 'pending' || scene.draw_status === 'drawing';

async function applyDraw(exec: Exec, job: ExplainerJob, result: unknown, deps: ExplainerApplyDeps): Promise<ExplainerApplied> {
    if (!isPlainObject(result) || !['done', 'paused', 'failed'].includes(result.state as string)) {
        throw problemsError(['An explainer_draw result is { state: "done" | "paused" | "failed", until? }.'], 'the drawing result');
    }
    const state = result.state as 'done' | 'paused' | 'failed';
    const current = await lockCurrent(exec, job);
    if ('dropped' in current) return dropped(job, current.dropped);
    const { row } = current;
    const scenes = await loadScenes(exec, row.creator_id, row.id);
    const drawn = scenes.filter((s) => s.draw_status === 'done').length;
    const now = (deps.now ?? Date.now)();

    if (state === 'done') {
        // The draw-next route moves the explainer to review when nothing is pending. If the job ends first (a worker that stopped between the answer and the
        // call), this is the same move, and it is the only way out of `drawing`.
        if (row.status === 'drawing' && !scenes.some(isPending)) {
            await transitionExplainer(exec, row.id, ['drawing'], 'review', { job_id: null }, row.creator_id);
        } else if (row.job_id) {
            await updateExplainerFields(exec, row.creator_id, row.id, { job_id: null });
        }
        return { outcome: 'applied', stored: { state, drawn, total: scenes.length } };
    }

    if (row.status !== RUNS_IN.explainer_draw) return dropped(job, `not_${RUNS_IN.explainer_draw}`, { status: row.status });

    if (state === 'paused') {
        const until = resumeAt(result.until, now);
        const next = await deps.enqueue(exec, row.creator_id, 'explainer_draw', drawPayload(row), { notBefore: until });
        const note = `Waiting for the image allowance to reset (${drawn} of ${scenes.length} drawn). Drawing continues by itself after ${until.toISOString()}.`;
        await updateExplainerFields(exec, row.creator_id, row.id, { job_id: next.id, draw_paused_until: until, error: note });
        log('info', 'explainer.draw_paused', { explainer_id: row.id, job_id: job.id, next_job_id: next.id, until: until.toISOString(), drawn, total: scenes.length });
        return { outcome: 'applied', stored: { state, until: until.toISOString(), drawn, total: scenes.length, next_job_id: next.id } };
    }

    // failed: scenes kept failing. The explainer stays `drawing` (the owner redraws a scene, or presses Continue), with the last reason in words.
    const reason = [...scenes].filter((s) => s.draw_status === 'failed' && s.draw_error).sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))[0]?.draw_error;
    const note = `Drawing stopped after scenes kept failing (${drawn} of ${scenes.length} drawn)${reason ? `: ${reason}` : '.'}`;
    await updateExplainerFields(exec, row.creator_id, row.id, { error: note.slice(0, 2000), job_id: null, draw_paused_until: null });
    log('warn', 'explainer.draw_failed', { explainer_id: row.id, job_id: job.id, drawn, total: scenes.length });
    return { outcome: 'applied', stored: { state, drawn, total: scenes.length } };
}

// ─── explainer_render ──────────────────────────────────────────────────────────────────────────

async function applyRender(exec: Exec, job: ExplainerJob, result: unknown, deps: ExplainerApplyDeps): Promise<ExplainerApplied> {
    if (!isPlainObject(result)) throw problemsError(['A render result is { vertical_url, horizontal_url, cover_url, duration, version, sound_mode }.'], 'the render result');
    const problems: string[] = [];
    const ids: Record<'vertical_url' | 'horizontal_url' | 'cover_url', string> = { vertical_url: '', horizontal_url: '', cover_url: '' };
    for (const key of ['vertical_url', 'horizontal_url', 'cover_url'] as const) {
        const value = result[key];
        const media = typeof value === 'string' ? uploadIdFromUrl(value) : null;
        if (!media) problems.push(`${key} is not one of this app's upload URLs`);
        else ids[key] = media;
    }
    if (!(isFiniteNumber(result.duration) && result.duration > 0)) problems.push('duration must be the video\'s length in seconds');
    if (!(Number.isInteger(result.version) && (result.version as number) >= 0)) problems.push('version must be the version that was rendered');
    if (result.sound_mode !== 'music' && result.sound_mode !== 'sfx') problems.push('sound_mode must be music or sfx');
    if (problems.length) throw problemsError(problems, 'the render result');

    const current = await lockCurrent(exec, job);
    if ('dropped' in current) {
        // Nothing will ever name these files: the explainer is gone, or a newer render is the one that counts.
        const urls = [result.vertical_url, result.horizontal_url, result.cover_url] as string[];
        const out = dropped(job, current.dropped);
        await deps.deleteFiles(exec, job.creator_id, urls);
        return out;
    }
    const { row } = current;
    if (row.status !== RUNS_IN.explainer_render) return dropped(job, `not_${RUNS_IN.explainer_render}`, { status: row.status });

    await deps.checkFiles(exec, row.creator_id, [[ids.vertical_url, 'video/mp4', 'vertical_url'], [ids.horizontal_url, 'video/mp4', 'horizontal_url'], [ids.cover_url, 'image/jpeg', 'cover_url']]);
    const base = await getPublicBaseUrl(null);
    if (!base) throw problemsError(['No public address for this app: set it in Settings → TikTok app.'], 'the render result', 500);
    const store = await getMediaStore();
    const render = {
        vertical_url: store.publicUrl(ids.vertical_url, base), horizontal_url: store.publicUrl(ids.horizontal_url, base), cover_url: store.publicUrl(ids.cover_url, base),
        duration: result.duration as number, sound_mode: result.sound_mode as 'music' | 'sfx', version: result.version as number, job_id: job.id,
    };
    const previous = row.render;
    await transitionExplainer(exec, row.id, [RUNS_IN.explainer_render], 'ready', { render, job_id: null }, row.creator_id);
    // The previous render's files stay until this one has landed (FR-026), and go now unless a post names them.
    if (previous) await deps.deleteFiles(exec, row.creator_id, [previous.vertical_url, previous.horizontal_url, previous.cover_url], new Set(Object.values(ids)));
    const older = render.version !== row.draft_version;
    log(older ? 'warn' : 'info', 'explainer.rendered', { explainer_id: row.id, job_id: job.id, duration: render.duration, sound_mode: render.sound_mode, older_than_edits: older });
    return { outcome: 'applied', stored: { duration: render.duration, sound_mode: render.sound_mode, version: render.version, older_than_edits: older } };
}

// ─── The entry points jobs.ts calls ────────────────────────────────────────────────────────────

/**
 * Apply a finished job's result to its explainer, or drop it. `exec` is the job's transaction, so the explainer, its scenes and the next job are written
 * together or not at all. A result that is not what the contract says is a 400 (`problemsError`): the job stays claimed and the worker reports the failure.
 */
export async function applyExplainerResult(exec: Exec, job: ExplainerJob, result: unknown, deps: ExplainerApplyDeps): Promise<ExplainerApplied> {
    switch (job.kind) {
        case 'explainer_write': return applyWrite(exec, job, result);
        case 'explainer_voice': return applyVoice(exec, job, result, deps);
        case 'explainer_draw': return applyDraw(exec, job, result, deps);
        case 'explainer_render': return applyRender(exec, job, result, deps);
    }
}

/** A voice failure that is the free allowance running out: the worker's `VOICE_LIMIT: …` (aicourse-captions tts.mjs). */
export const VOICE_LIMIT_PREFIX = 'VOICE_LIMIT:';
/** A voice job asked again after a limit this many times is failed for real: a limit that lasts three days is not "tomorrow". */
export const MAX_VOICE_LIMIT_RETRIES = 3;

/**
 * When a voice that ran into Gemini's limit is tried again. The worker's message says whose limit it was: the minute's (try again after the wait it names, at
 * least a minute) or the day's (the quota resets at midnight Pacific). One that says neither is treated as the day's: a retry that fails on the same quota
 * costs a day, one that waits too long costs a day too, and the owner is told when.
 */
export function voiceRetryAt(message: string, now: number): Date {
    if (/the minute's limit/i.test(message)) {
        const named = /retry after (\d+)\s*s/i.exec(message);
        const seconds = Math.min(3600, Math.max(60, named ? Number(named[1]) : 60));
        return new Date(now + (seconds + 15) * 1000);
    }
    return new Date(nextGeminiQuotaReset(now).getTime() + 5 * 60_000);
}

/**
 * The explainer goes `failed` at the step the job was for, with `error`: the worker's own words, which the owner is shown and which Retry runs again from.
 * Two failures are not that: a voice that ran into the free allowance is asked again at the reset (the explainer stays `voicing`, with the reason and the time
 * as its note), and a draw job that crashes leaves the scenes as they are. The text of `error` is never logged: it may quote a prompt, a path or a key.
 */
export async function applyExplainerFailure(exec: Exec, job: ExplainerJob, error: string, deps: ExplainerApplyDeps): Promise<void> {
    const current = await lockCurrent(exec, job);
    if ('dropped' in current) {
        log('info', 'explainer.failure_ignored', { job_id: job.id, kind: job.kind, creator_id: job.creator_id, reason: current.dropped });
        return;
    }
    const { row } = current;
    if (row.status !== RUNS_IN[job.kind]) {
        log('info', 'explainer.failure_ignored', { job_id: job.id, kind: job.kind, creator_id: job.creator_id, reason: `not_${RUNS_IN[job.kind]}`, status: row.status });
        return;
    }
    const message = error.trim().slice(0, 2000) || 'The worker reported a failure without saying why.';

    if (job.kind === 'explainer_voice' && message.startsWith(VOICE_LIMIT_PREFIX)) {
        const retries = isPlainObject(job.payload) && Number.isInteger(job.payload.limit_retries) ? (job.payload.limit_retries as number) : 0;
        if (retries < MAX_VOICE_LIMIT_RETRIES) {
            const now = (deps.now ?? Date.now)();
            const at = voiceRetryAt(message, now);
            const scenes = await loadScenes(exec, row.creator_id, row.id);
            const settings = await getStudioSettings(row.creator_id, exec);
            const next = await deps.enqueue(
                exec, row.creator_id, 'explainer_voice', { ...voicePayload(row, scenes, settings), limit_retries: retries + 1 }, { notBefore: at }
            );
            const note = `${VOICE_LIMIT_PREFIX} voice limit reached, trying again at ${at.toISOString()}. ${message.slice(VOICE_LIMIT_PREFIX.length).trim()}`.slice(0, 2000);
            await updateExplainerFields(exec, row.creator_id, row.id, { job_id: next.id, error: note });
            log('info', 'explainer.voice_limit_requeued', { explainer_id: row.id, job_id: job.id, next_job_id: next.id, at: at.toISOString(), retries: retries + 1 });
            return;
        }
    }

    await transitionExplainer(exec, row.id, [RUNS_IN[job.kind]], 'failed', { failed_step: STEP_OF[job.kind], error: message, job_id: null }, row.creator_id);
    log('warn', 'explainer.step_failed', { explainer_id: row.id, job_id: job.id, kind: job.kind, step: STEP_OF[job.kind], writer: job.kind === 'explainer_write' ? writerOf(job) : undefined });
}
