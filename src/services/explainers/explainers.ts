/**
 * Illustrated explainers (v59): the rows, and what Studio → Explainers does with them. state.ts is the status machine, spec.ts the rules a script is held to,
 * payloads.ts the four Mac jobs' payloads, apply.ts what their results do, writing.ts who writes. This file is the lifecycle the routes call:
 *
 *   create        a topic → a `writing` row and a write job (Claude's, for the Mac, or Gemini's own when the owner chose it)
 *   edit          the owner's changes to the draft, the choices of sound and subtitles; a narration edit makes the audio out of date
 *   rewrite       a new draft from a note; the old one stays until the new one arrives
 *   approve       gate 1: the script, at the version the owner read, with no problem left in it → voicing
 *   revoice       the narration changed after it was voiced → voicing again
 *   startDraw     queue the unattended drawing of the scenes that have no picture (resume after a pause or a failure)
 *   approvePictures  gate 2: every scene has a picture, the audio is fresh, the track is there → rendering
 *   render        the same, from `ready`: a new render, the old files kept until it lands
 *   retry         the failed step again
 *   delete        the row, its job, and its files (but not the ones a post names)
 *
 * Every function names the tenant (`creator_id`), takes the row's lock before it decides anything, and writes the explainer, its scenes and its job in one
 * transaction: a job is queued only with the move that makes it the explainer's job (`job_id`), which is how the result of an older job is told apart and
 * dropped. Nothing here calls a network service inside a transaction: Gemini's run is started after the commit (writing.ts).
 */
import type {
    ExplainerAudio, ExplainerDraft, ExplainerPicture, ExplainerRender, ExplainerReply, ExplainerRow, ExplainerSceneRow, ExplainerSchedule, ExplainerSource, ExplainerStatus,
    ExplainerStep,
} from '../../db/rows.js';
import { pool } from '../../config/db.js';
import { log } from '../../utils/log.js';
import { getPublicBaseUrl } from '../appSettings.js';
import { clipText, type Exec, isPlainObject, problemsError, StudioError, UUID_PATTERN, withTransaction } from '../studio/common.js';
import { deleteUnreferencedUploads, enqueueJob } from '../studio/jobs.js';
import { getStudioSettings } from '../studio/settings.js';
import type { ExplainerLanguage, ExplainerLengthTier, ExplainerSoundMode, StudioSettings } from '../studio/settingsTypes.js';
import { workerSummary } from '../studio/worker.js';
import { ExplainerError } from './errors.js';
import { drawPayload, previousDraftOf, renderPayload, voicePayload } from './payloads.js';
import { checkDraft, type DraftFinding, type DraftInput, LENGTH_TIERS, MAX_SCENES } from './spec.js';
import { isAudioStale, RETRY_STATUS, transitionExplainer } from './state.js';
import { type ExplainerFields, loadScenes, lockExplainer, replaceScenes, type SceneInput, updateExplainerFields, updateSceneText } from './store.js';
import { queueWrite, reconcileWriting, startGeminiRun, type GeminiRun } from './writing.js';

export const MIN_TOPIC = 3;
export const MAX_TOPIC = 300;
export const MAX_NOTES = 2000;
export const MAX_REWRITE_NOTE = 2000;
export const MAX_SOURCE_LINKS = 10;
export const MAX_LINK_CHARS = 500;
/** The newest ones, on the screen. Older rows stay until deleted. */
export const LIST_LIMIT = 60;
const MAX_REPLIES = 10;
const MAX_SOURCES = 20;
/** A scene's drawing that has been "drawing" this long is a crash, not a picture on its way (a draw answers in 30 s). */
const STALE_DRAWING_MINUTES = 2;

// ─── The views ─────────────────────────────────────────────────────────────────────────────────

export interface ExplainerSummary {
    id: string;
    status: ExplainerStatus;
    title: string | null;
    topic: string;
    language: ExplainerLanguage;
    length_tier: ExplainerLengthTier;
    /** The spoken words ÷ the narrator's pace, from the draft; null until there is one. */
    est_seconds: number | null;
    /** While drawing: how many scenes have a picture. */
    progress: { done: number; total: number } | null;
    updated_at: Date | string;
    /** The first scene's chosen picture. */
    thumb_url: string | null;
}

export interface SceneView {
    position: number;
    narration: string;
    spoken: string;
    label: string;
    brief: string;
    characters: string[];
    continues: boolean;
    start_s: number | null;
    end_s: number | null;
    picture: ExplainerPicture | null;
    pictures: ExplainerPicture[];
    draw_status: ExplainerSceneRow['draw_status'];
    draw_error: string | null;
    draw_note: string | null;
}

export interface ExplainerView extends ExplainerSummary {
    failed_step: ExplainerStep | null;
    /** The reason of the last failure, or the note of a pause (waiting for the allowance, for Gemini's quota, why Gemini is writing). */
    error: string | null;
    sound_mode: ExplainerSoundMode;
    music_track_id: string | null;
    subtitles: boolean;
    notes: string | null;
    source_links: { url: string }[];
    draft: ExplainerDraft | null;
    draft_version: number;
    audio: ExplainerAudio | null;
    /** The narration changed since the audio was made: Re-voice is offered, and pictures cannot be approved until it is done. */
    audio_stale: boolean;
    render: ExplainerRender | null;
    /** The render was made for another version of the narration, or another sound: "render is older than your edits". */
    render_stale: boolean;
    schedule: ExplainerSchedule | null;
    draw_paused_until: Date | string | null;
    scenes: SceneView[];
    /** What the script breaks that a person must fix before approving: computed now from the scenes, never a stored copy that could go stale. */
    problems: DraftFinding[];
    /** The job working on it, and where it is. A job that is `pending` with a `not_before` in the future is waiting for a time, not for the Mac. */
    job: { status: string; progress: string | null; not_before: Date | string | null } | null;
    /** Whether the Mac is there to do the work: only read when the explainer is read. */
    worker: { online: boolean; lastSeen: string | null; name: string | null } | null;
    /** The image allowance, from the pictures service; null until it is wired or when no provider is set. */
    allowance: unknown | null;
}

type DetailRow = ExplainerRow & { job_status: string | null; job_progress: string | null; job_not_before: Date | string | null };

const DETAIL_SQL = `
    SELECT e.*, j.status AS job_status, j.progress AS job_progress, j.not_before AS job_not_before
      FROM explainers e
      LEFT JOIN studio_jobs j ON j.id = e.job_id AND j.creator_id = e.creator_id
     WHERE e.id = $1 AND e.creator_id = $2`;

const SUMMARY_SQL = `
    SELECT e.id, e.status, e.title, e.topic, e.language, e.length_tier, (e.draft->>'est_seconds')::float8 AS est_seconds, e.updated_at,
           (SELECT s.picture->>'url' FROM explainer_scenes s WHERE s.explainer_id = e.id AND s.creator_id = e.creator_id AND s.position = 0) AS thumb_url,
           CASE WHEN e.status = 'drawing' THEN (SELECT COUNT(*)::int FROM explainer_scenes s WHERE s.explainer_id = e.id AND s.creator_id = e.creator_id AND s.draw_status = 'done') END AS drawn,
           CASE WHEN e.status = 'drawing' THEN (SELECT COUNT(*)::int FROM explainer_scenes s WHERE s.explainer_id = e.id AND s.creator_id = e.creator_id) END AS total
      FROM explainers e
     WHERE e.creator_id = $1
     ORDER BY e.created_at DESC
     LIMIT ${LIST_LIMIT}`;

/** GET /explainers: the newest ones, as the list shows them. */
export async function listExplainers(creatorId: string): Promise<ExplainerSummary[]> {
    const { rows } = await pool.query<Omit<ExplainerSummary, 'progress'> & { drawn: number | null; total: number | null }>(SUMMARY_SQL, [creatorId]);
    return rows.map(({ drawn, total, ...rest }) => ({ ...rest, progress: drawn !== null && total !== null ? { done: drawn, total } : null }));
}

/** What a scene needs to be held to the draft rules: the stored row and the owner's edit of it both have it. */
type SceneText = Pick<SceneInput, 'narration' | 'spoken' | 'label' | 'brief' | 'characters' | 'continues'>;

function draftInputOf(row: Pick<ExplainerRow, 'title' | 'draft'>, scenes: readonly SceneText[]): DraftInput {
    return {
        title: row.title,
        scenes: scenes.map((s) => ({ narration: s.narration, spoken: s.spoken, label: s.label, brief: s.brief, characters: s.characters, continues: s.continues })),
        sources: row.draft?.sources, captions: row.draft?.captions, first_comment: row.draft?.first_comment,
    };
}

const sceneView = (s: ExplainerSceneRow): SceneView => ({
    position: s.position, narration: s.narration, spoken: s.spoken, label: s.label, brief: s.brief, characters: s.characters, continues: s.continues, start_s: s.start_s, end_s: s.end_s,
    picture: s.picture, pictures: s.pictures, draw_status: s.draw_status, draw_error: s.draw_error, draw_note: s.draw_note,
});

/** The explainer and its scenes as the dashboard reads them. Pure: what is read from elsewhere (the worker, the allowance) is handed in. */
export function presentExplainer(
    row: DetailRow, scenes: readonly ExplainerSceneRow[], extras: { worker?: ExplainerView['worker']; allowance?: unknown } = {}
): ExplainerView {
    const problems = row.draft ? checkDraft(draftInputOf(row, scenes), { tier: row.length_tier, language: row.language }).problems : [];
    const drawn = scenes.filter((s) => s.draw_status === 'done').length;
    return {
        id: row.id, status: row.status, title: row.title, topic: row.topic, language: row.language, length_tier: row.length_tier, est_seconds: row.draft?.est_seconds ?? null,
        progress: row.status === 'drawing' ? { done: drawn, total: scenes.length } : null, updated_at: row.updated_at, thumb_url: scenes[0]?.picture?.url ?? null,
        failed_step: row.failed_step, error: row.error, sound_mode: row.sound_mode, music_track_id: row.music_track_id, subtitles: row.subtitles, notes: row.notes,
        source_links: row.source_links, draft: row.draft, draft_version: row.draft_version, audio: row.audio, audio_stale: isAudioStale(row), render: row.render,
        render_stale: row.render !== null && (row.render.version !== row.draft_version || row.render.sound_mode !== row.sound_mode), schedule: row.schedule,
        draw_paused_until: row.draw_paused_until, scenes: scenes.map(sceneView), problems,
        job: row.job_id && row.job_status ? { status: row.job_status, progress: row.job_progress, not_before: row.job_not_before } : null,
        worker: extras.worker ?? null, allowance: extras.allowance ?? null,
    };
}

/** The explainer and its scenes, read through `exec` (a transaction's client, or the pool). A 404 when it is not this tenant's. */
export async function loadView(exec: Exec, creatorId: string, id: string, extras: { worker?: ExplainerView['worker']; allowance?: unknown } = {}): Promise<ExplainerView> {
    const { rows } = await exec.query<DetailRow>(DETAIL_SQL, [id, creatorId]);
    if (!rows[0]) throw notFound();
    return presentExplainer(rows[0], await loadScenes(exec, creatorId, id), extras);
}

const notFound = (): ExplainerError => new ExplainerError('EXPLAINER_NOT_FOUND', 'No such explainer.');

/** A route's `:id`, or a 404 with the explainer code: checked before any query, since Postgres answers a malformed uuid with an error. */
export function explainerIdOf(raw: unknown): string {
    if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) throw notFound();
    return raw.toLowerCase();
}

/** What GET /explainers/:id adds to the row: whether the Mac is there, and the image allowance when the pictures service gives it. */
export interface ReadExtras {
    allowance?: () => Promise<unknown>;
}

/**
 * GET /explainers/:id. Looks first at whether the writing is stuck in a way Gemini can fix (a Mac that is signed out or has not picked the job up in ten
 * minutes, a Gemini run that died): that check can start a run, which goes on after the response.
 */
export async function getExplainer(creatorId: string, rawId: unknown, extras: ReadExtras = {}): Promise<ExplainerView> {
    const id = explainerIdOf(rawId);
    await reconcileWriting(creatorId, id);
    const [worker, allowance] = await Promise.all([workerSummary(creatorId).catch(() => null), extras.allowance ? extras.allowance().catch(() => null) : Promise.resolve(null)]);
    return loadView(pool, creatorId, id, { worker, allowance });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────────────────────

const today = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** Fail a job nobody has claimed, because a newer one replaces it: the Mac must not do work whose answer would be dropped. A claimed one runs on and is dropped. */
async function supersede(exec: Exec, creatorId: string, jobId: string | null, reason: string): Promise<void> {
    if (!jobId) return;
    await exec.query(`UPDATE studio_jobs SET status = 'failed', error = $3, updated_at = NOW() WHERE id = $1 AND creator_id = $2 AND status = 'pending'`, [jobId, creatorId, reason]);
}

/** The state the move needs, or the 409 that says where the explainer is. */
function requireStatus(row: Pick<ExplainerRow, 'status'>, allowed: readonly ExplainerStatus[], to: string): void {
    if (!allowed.includes(row.status)) {
        throw new ExplainerError('EXPLAINER_BAD_STATE', `This explainer is ${row.status}, so it cannot ${to}.`, { status: row.status, to });
    }
}

async function loadLocked(exec: Exec, creatorId: string, id: string): Promise<ExplainerRow> {
    const row = await lockExplainer(exec, creatorId, id);
    if (!row) throw notFound();
    return row;
}

/** The refusal of a script that breaks a rule: every finding, so the owner fixes it in one pass. */
function draftRefused(findings: readonly DraftFinding[]): ExplainerError {
    const message = findings.length === 1 ? findings[0]!.message : `${findings.length} problems with this script.`;
    return new ExplainerError('EXPLAINER_DRAFT_REFUSED', message, { count: findings.length }, { findings, problems: findings.map((f) => f.message) });
}

// ─── Create ────────────────────────────────────────────────────────────────────────────────────

interface Created {
    topic: string;
    language: ExplainerLanguage;
    length_tier: ExplainerLengthTier;
    sound_mode: ExplainerSoundMode;
    music_track_id: string | null;
    subtitles: boolean;
    notes: string | null;
    source_links: { url: string }[];
}

/** The links the owner gave: http or https, a sane length, no duplicates, at most ten. */
function parseLinks(raw: unknown, problems: string[]): { url: string }[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        problems.push('source_links must be a list of links');
        return [];
    }
    if (raw.length > MAX_SOURCE_LINKS) problems.push(`source_links has ${raw.length} links; at most ${MAX_SOURCE_LINKS}`);
    const seen = new Set<string>();
    const links: { url: string }[] = [];
    raw.slice(0, MAX_SOURCE_LINKS).forEach((item: unknown, i: number) => {
        const url = typeof item === 'string' ? item.trim() : isPlainObject(item) && typeof item.url === 'string' ? item.url.trim() : '';
        let valid = false;
        try {
            valid = /^https?:$/.test(new URL(url).protocol);
        } catch {
            valid = false;
        }
        if (!valid || url.length > MAX_LINK_CHARS) {
            problems.push(`source_links[${i}] is not an http or https link of at most ${MAX_LINK_CHARS} characters`);
            return;
        }
        if (!seen.has(url)) links.push({ url });
        seen.add(url);
    });
    return links;
}

function parseCreate(body: unknown, settings: StudioSettings): Created {
    const b = isPlainObject(body) ? body : {};
    const problems: string[] = [];
    const topic = clipText(b.topic, MAX_TOPIC + 1);
    if (!topic || topic.length < MIN_TOPIC) problems.push(`topic: say what the video is about, in at least ${MIN_TOPIC} characters`);
    else if (topic.length > MAX_TOPIC) problems.push(`topic is longer than ${MAX_TOPIC} characters`);
    const defaults = settings.explainer.defaults;
    const language = b.language ?? defaults.language;
    if (language !== 'ar' && language !== 'en') problems.push('language must be ar or en');
    const tier = b.length_tier ?? defaults.length_tier;
    if (!(LENGTH_TIERS as readonly unknown[]).includes(tier)) problems.push(`length_tier must be ${LENGTH_TIERS.join(', ')}`);
    const sound = b.sound_mode ?? defaults.sound_mode;
    if (sound !== 'music' && sound !== 'sfx') problems.push('sound_mode must be music or sfx');
    const subtitles = b.subtitles ?? defaults.subtitles;
    if (typeof subtitles !== 'boolean') problems.push('subtitles must be true or false');
    const notes = clipText(b.notes, MAX_NOTES + 1);
    if (notes && notes.length > MAX_NOTES) problems.push(`notes are longer than ${MAX_NOTES} characters`);
    let track: string | null = null;
    if (b.music_track_id !== undefined && b.music_track_id !== null) {
        if (typeof b.music_track_id !== 'string') problems.push('music_track_id must be the key of a track in your library');
        else if (sound === 'music') {
            if (!settings.explainer.music.some((t) => t.key === b.music_track_id)) problems.push(`music_track_id "${b.music_track_id}" is not a track in your library`);
            else track = b.music_track_id;
        }
    }
    const links = parseLinks(b.source_links, problems);
    if (problems.length) throw problemsError(problems, 'this explainer');
    return {
        topic: topic!, language: language as ExplainerLanguage, length_tier: tier as ExplainerLengthTier, sound_mode: sound as ExplainerSoundMode, music_track_id: track,
        subtitles: subtitles as boolean, notes, source_links: links,
    };
}

/** POST /explainers `{ topic, language?, length_tier?, sound_mode?, music_track_id?, subtitles?, notes?, source_links? }`: a `writing` explainer and its job. */
export async function createExplainer(creatorId: string, body: unknown, now: number = Date.now()): Promise<ExplainerView> {
    const settings = await getStudioSettings(creatorId);
    const input = parseCreate(body, settings);
    const { view, run } = await withTransaction(async (client) => {
        const { rows } = await client.query<ExplainerRow>(
            `INSERT INTO explainers (creator_id, status, topic, language, length_tier, sound_mode, music_track_id, subtitles, notes, source_links)
             VALUES ($1, 'writing', $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
             RETURNING *`,
            [creatorId, input.topic, input.language, input.length_tier, input.sound_mode, input.music_track_id, input.subtitles, input.notes, JSON.stringify(input.source_links)]
        );
        const row = rows[0]!;
        const queued = await queueWrite(client, row, settings, { today: today(now) });
        await updateExplainerFields(client, creatorId, row.id, { job_id: queued.jobId });
        const created = await loadView(client, creatorId, row.id);
        return { view: created, run: queued.writer === 'gemini' ? ({ creatorId, explainerId: row.id, jobId: queued.jobId } satisfies GeminiRun) : null };
    });
    // After the commit: the run reads the row, and a transaction still open would hide it.
    if (run) startGeminiRun(run);
    log('info', 'explainer.created', { explainer_id: view.id, language: view.language, tier: view.length_tier, sound_mode: view.sound_mode, writer: run ? 'gemini' : 'claude_mac' });
    return view;
}

// ─── Edit ──────────────────────────────────────────────────────────────────────────────────────

interface Edit {
    title?: string;
    captions?: ExplainerDraft['captions'];
    first_comment?: string;
    replies?: ExplainerReply[];
    sources?: ExplainerSource[];
    scenes?: SceneInput[];
    sound_mode?: ExplainerSoundMode;
    music_track_id?: string | null;
    subtitles?: boolean;
}

const EDIT_KEYS = ['title', 'draft', 'scenes', 'sound_mode', 'music_track_id', 'subtitles'] as const;
const DRAFT_EDIT_KEYS = ['captions', 'first_comment', 'replies', 'sources'] as const;

/** A string field of at most `max` characters (code points); the text as given, trimmed. */
function text(value: unknown, where: string, max: number, problems: string[], required = false): string | undefined {
    if (typeof value !== 'string') {
        problems.push(`${where} must be text`);
        return undefined;
    }
    const trimmed = value.trim();
    if (required && !trimmed) problems.push(`${where} is empty`);
    else if ([...trimmed].length > max) problems.push(`${where} is longer than ${max} characters`);
    return trimmed;
}

function parseEdit(body: unknown, settings: StudioSettings): Edit {
    if (!isPlainObject(body) || Object.keys(body).length === 0) {
        throw new StudioError(400, `Send what to change: ${EDIT_KEYS.join(', ')}.`);
    }
    const problems: string[] = [];
    for (const key of Object.keys(body)) if (!(EDIT_KEYS as readonly string[]).includes(key)) problems.push(`${key} is not something an explainer's edit can change`);
    const edit: Edit = {};

    if (body.title !== undefined) {
        // The length is a finding of `checkDraft` (field_too_long), like every other limit, so that it comes back with the rest.
        const title = text(body.title, 'title', 100_000, problems, true);
        if (title !== undefined) edit.title = title;
    }
    if (body.draft !== undefined) {
        if (!isPlainObject(body.draft)) problems.push('draft must be an object with captions, first_comment, replies, sources');
        else {
            const d = body.draft;
            for (const key of Object.keys(d)) if (!(DRAFT_EDIT_KEYS as readonly string[]).includes(key)) problems.push(`draft.${key} is not something an explainer's edit can change`);
            if (d.captions !== undefined) {
                const c = isPlainObject(d.captions) ? d.captions : null;
                const y = c && isPlainObject(c.youtube) ? c.youtube : null;
                if (!c || !y) problems.push('draft.captions must be { meta, youtube: { title, description }, tiktok }');
                else {
                    const meta = text(c.meta, 'draft.captions.meta', 2200, problems);
                    const yt = text(y.title, 'draft.captions.youtube.title', 100, problems);
                    const yd = text(y.description, 'draft.captions.youtube.description', 5000, problems);
                    const tt = text(c.tiktok, 'draft.captions.tiktok', 2200, problems);
                    if (meta !== undefined && yt !== undefined && yd !== undefined && tt !== undefined) edit.captions = { meta, youtube: { title: yt, description: yd }, tiktok: tt };
                }
            }
            if (d.first_comment !== undefined) {
                const fc = text(d.first_comment, 'draft.first_comment', 1500, problems);
                if (fc !== undefined) edit.first_comment = fc;
            }
            if (d.replies !== undefined) {
                if (!Array.isArray(d.replies) || d.replies.length > MAX_REPLIES) problems.push(`draft.replies must be a list of at most ${MAX_REPLIES} { q, a }`);
                else {
                    const replies = d.replies.map((r: unknown, i: number): ExplainerReply | null => {
                        const o = isPlainObject(r) ? r : {};
                        const q = text(o.q, `draft.replies[${i}].q`, 300, problems);
                        const a = text(o.a, `draft.replies[${i}].a`, 600, problems);
                        return q === undefined || a === undefined ? null : { q, a };
                    });
                    if (replies.every((r) => r !== null)) edit.replies = replies as ExplainerReply[];
                }
            }
            if (d.sources !== undefined) {
                if (!Array.isArray(d.sources) || d.sources.length > MAX_SOURCES) problems.push(`draft.sources must be a list of at most ${MAX_SOURCES} { title, by, year, url }`);
                else {
                    const sources = d.sources.map((s: unknown, i: number): ExplainerSource | null => {
                        const o = isPlainObject(s) ? s : {};
                        const title = text(o.title, `draft.sources[${i}].title`, 300, problems);
                        const by = text(o.by, `draft.sources[${i}].by`, 300, problems);
                        const year = text(o.year, `draft.sources[${i}].year`, 10, problems);
                        const url = text(o.url, `draft.sources[${i}].url`, 500, problems);
                        if (url !== undefined && url !== '' && !/^https?:\/\//i.test(url)) problems.push(`draft.sources[${i}].url must be an http or https link`);
                        return title === undefined || by === undefined || year === undefined || url === undefined ? null : { title, by, year, url };
                    });
                    if (sources.every((s) => s !== null)) edit.sources = sources as ExplainerSource[];
                }
            }
        }
    }
    if (body.scenes !== undefined) {
        if (!Array.isArray(body.scenes) || body.scenes.length === 0 || body.scenes.length > MAX_SCENES) {
            problems.push(`scenes must be the whole list, in order: from 1 to ${MAX_SCENES} scenes`);
        } else {
            const known = new Set(settings.explainer.characters.map((c) => c.key));
            const scenes: SceneInput[] = [];
            body.scenes.forEach((raw: unknown, i: number) => {
                const o = isPlainObject(raw) ? raw : {};
                const where = `scenes[${i}]`;
                const narration = text(o.narration, `${where}.narration`, 100_000, problems);
                const spoken = text(o.spoken, `${where}.spoken`, 100_000, problems);
                const label = text(o.label, `${where}.label`, 100_000, problems);
                const brief = text(o.brief, `${where}.brief`, 100_000, problems);
                if (typeof o.continues !== 'boolean') problems.push(`${where}.continues must be true or false`);
                let characters: string[] = [];
                if (!Array.isArray(o.characters) || o.characters.some((c: unknown) => typeof c !== 'string')) problems.push(`${where}.characters must be a list of character keys`);
                else {
                    characters = [...new Set((o.characters as string[]).map((c) => c.trim()).filter(Boolean))];
                    for (const key of characters) if (!known.has(key)) problems.push(`${where}.characters names "${key}", which is not one of your characters`);
                }
                if (narration !== undefined && spoken !== undefined && label !== undefined && brief !== undefined && typeof o.continues === 'boolean') {
                    scenes.push({ narration, spoken, label, brief, characters, continues: o.continues });
                }
            });
            if (scenes.length === body.scenes.length) edit.scenes = scenes;
        }
    }
    if (body.sound_mode !== undefined) {
        if (body.sound_mode !== 'music' && body.sound_mode !== 'sfx') problems.push('sound_mode must be music or sfx');
        else edit.sound_mode = body.sound_mode;
    }
    if (body.music_track_id !== undefined) {
        if (body.music_track_id === null) edit.music_track_id = null;
        else if (typeof body.music_track_id !== 'string' || !settings.explainer.music.some((t) => t.key === body.music_track_id)) problems.push('music_track_id must be the key of a track in your library, or null');
        else edit.music_track_id = body.music_track_id;
    }
    if (body.subtitles !== undefined) {
        if (typeof body.subtitles !== 'boolean') problems.push('subtitles must be true or false');
        else edit.subtitles = body.subtitles;
    }
    if (problems.length) throw problemsError(problems.slice(0, 20), 'this edit');
    return edit;
}

/** What a state refuses to have changed, because the step running in it reads it (contracts/http-api.md: 409 while writing, voicing or rendering). */
function assertEditable(row: ExplainerRow, edit: Edit, existing: readonly ExplainerSceneRow[], changed: { narration: boolean; label: boolean }): void {
    const refuse = (what: string): never => {
        throw new ExplainerError('EXPLAINER_BAD_STATE', `This explainer is ${row.status}: ${what} cannot be changed until that step is done.`, { status: row.status, to: 'edit' });
    };
    const touchesDraft = edit.captions !== undefined || edit.first_comment !== undefined || edit.replies !== undefined || edit.sources !== undefined || edit.scenes !== undefined || edit.title !== undefined;
    if (row.status === 'scheduled') refuse('a scheduled explainer');
    if (row.status === 'writing' && (touchesDraft)) refuse('the script, which Claude or Gemini is writing now,');
    if (row.status === 'voicing' && changed.narration) refuse('the narration, which is being voiced,');
    if (row.status === 'rendering') {
        if (edit.title !== undefined) refuse('the title');
        if (changed.label) refuse('a label');
        if (edit.sound_mode !== undefined || edit.music_track_id !== undefined || edit.subtitles !== undefined) refuse('the sound and the subtitles');
    }
    if (touchesDraft && !row.draft && row.status !== 'draft') {
        throw new ExplainerError('EXPLAINER_BAD_STATE', 'This explainer has no draft yet, so there is nothing to edit.', { status: row.status, to: 'edit' });
    }
    // The scenes can be added, removed or reordered only before the narration was voiced: a picture and a time belong to a scene's place in the list.
    if (edit.scenes && edit.scenes.length !== existing.length && (row.audio !== null || existing.some((s) => s.picture !== null || s.start_s !== null))) {
        throw new ExplainerError(
            'EXPLAINER_BAD_STATE', 'The scenes cannot be added or removed once the narration is voiced: edit them in place, or ask for a rewrite.', { status: row.status, to: 'edit' }
        );
    }
}

const sameFinding = (a: DraftFinding, b: DraftFinding): boolean => a.code === b.code && a.scene === b.scene && a.field === b.field;

/**
 * PATCH /explainers/:id: the owner's changes. A save may not ADD a problem to the script (a closing line that is not a question, engagement bait, a woman in a
 * brief, a field past its limit): it is refused with every finding (422 `EXPLAINER_DRAFT_REFUSED`) and nothing is stored. A problem the draft already has stays
 * listed, and a save that does not touch it goes through: only approving needs the script clean. A change to the narration after the voice was made makes the
 * audio out of date (`draft_version` + 1): Re-voice is offered. Label, brief and character edits never do.
 */
export async function editExplainer(creatorId: string, rawId: unknown, body: unknown): Promise<ExplainerView> {
    const id = explainerIdOf(rawId);
    const settings = await getStudioSettings(creatorId);
    const edit = parseEdit(body, settings);
    return withTransaction(async (client) => {
        const row = await loadLocked(client, creatorId, id);
        const existing = await loadScenes(client, creatorId, id, true);

        let changedNarration = false;
        let changedLabel = false;
        if (edit.scenes) {
            const same = edit.scenes.length === existing.length;
            changedNarration = !same || edit.scenes.some((s, i) => s.narration !== existing[i]!.narration || s.spoken !== existing[i]!.spoken);
            changedLabel = !same || edit.scenes.some((s, i) => s.label !== existing[i]!.label);
        }
        assertEditable(row, edit, existing, { narration: changedNarration, label: changedLabel });

        const nextScenes: SceneInput[] = edit.scenes ?? existing;
        const nextDraft: ExplainerDraft | null = row.draft ? {
            ...row.draft,
            ...(edit.captions ? { captions: edit.captions } : {}), ...(edit.first_comment !== undefined ? { first_comment: edit.first_comment } : {}),
            ...(edit.replies ? { replies: edit.replies } : {}), ...(edit.sources ? { sources: edit.sources } : {}),
        } : null;
        const nextTitle = edit.title ?? row.title;
        const contentTouched = edit.scenes !== undefined || edit.title !== undefined || edit.captions !== undefined || edit.first_comment !== undefined || edit.replies !== undefined || edit.sources !== undefined;

        const fields: ExplainerFields = {};
        if (contentTouched && nextDraft) {
            const ctx = { tier: row.length_tier, language: row.language, pace: settings.explainer.pace[row.language] };
            const before = checkDraft(draftInputOf(row, existing), ctx).problems;
            const after = checkDraft(draftInputOf({ title: nextTitle, draft: nextDraft }, nextScenes), ctx);
            if (after.problems.some((p) => !before.some((b) => sameFinding(p, b)))) throw draftRefused(after.problems);
            // What the script was flagged for beyond its own checks (it was written without a web read) stays: an edit does not research anything.
            const provenance = nextDraft.warnings.filter((w) => w.code === 'research_limited');
            nextDraft.est_seconds = after.est_seconds;
            nextDraft.warnings = [...after.warnings, ...provenance];
            fields.draft = nextDraft;
        }
        if (edit.title !== undefined) fields.title = edit.title;
        if (edit.sound_mode !== undefined) fields.sound_mode = edit.sound_mode;
        if (edit.music_track_id !== undefined) fields.music_track_id = edit.music_track_id;
        if (edit.subtitles !== undefined) fields.subtitles = edit.subtitles;
        if (changedNarration) fields.draft_version = row.draft_version + 1;

        if (edit.scenes) {
            if (edit.scenes.length !== existing.length) await replaceScenes(client, creatorId, id, edit.scenes);
            else await updateSceneText(client, creatorId, id, edit.scenes.map((s, position) => ({ ...s, position })));
        }
        if (Object.keys(fields).length) await updateExplainerFields(client, creatorId, id, fields);
        log('info', 'explainer.edited', {
            explainer_id: id, status: row.status, fields: Object.keys(fields), scenes: edit.scenes?.length, narration_changed: changedNarration, audio_now_stale: changedNarration && row.audio !== null,
        });
        return loadView(client, creatorId, id);
    });
}

// ─── Rewrite, approve, revoice ─────────────────────────────────────────────────────────────────

/** POST /explainers/:id/rewrite `{ note }`: a new draft from the note. The explainer is `writing`; the old draft stays on screen until the new one arrives. */
export async function rewriteExplainer(creatorId: string, rawId: unknown, body: unknown, now: number = Date.now()): Promise<ExplainerView> {
    const id = explainerIdOf(rawId);
    const note = clipText(isPlainObject(body) ? body.note : undefined, MAX_REWRITE_NOTE + 1);
    if (!note) throw problemsError(['note: say what to change, e.g. "a shorter hook, and add the 2020 result"'], 'this rewrite');
    if (note.length > MAX_REWRITE_NOTE) throw problemsError([`note is longer than ${MAX_REWRITE_NOTE} characters`], 'this rewrite');
    const settings = await getStudioSettings(creatorId);
    const { view, run } = await withTransaction(async (client) => {
        const row = await loadLocked(client, creatorId, id);
        requireStatus(row, ['draft'], 'be rewritten');
        const scenes = await loadScenes(client, creatorId, id);
        const queued = await queueWrite(client, row, settings, { today: today(now), rewrite: { note, previous: previousDraftOf(row, scenes) } });
        await transitionExplainer(client, id, ['draft'], 'writing', { rewrite_note: note, job_id: queued.jobId }, creatorId);
        return { view: await loadView(client, creatorId, id), run: queued.writer === 'gemini' ? ({ creatorId, explainerId: id, jobId: queued.jobId } satisfies GeminiRun) : null };
    });
    if (run) startGeminiRun(run);
    return view;
}

/**
 * POST /explainers/:id/approve `{ version }`: gate 1. The script must be the one the owner read (`version` is its `draft_version`: 409 `CHANGED_MEANWHILE`
 * otherwise) and must have no problem left (422 `EXPLAINER_DRAFT_REFUSED` with every finding). Then it is voiced: status `voicing`, with the job queued.
 */
export async function approveExplainer(creatorId: string, rawId: unknown, body: unknown): Promise<ExplainerView> {
    const id = explainerIdOf(rawId);
    const version = isPlainObject(body) ? body.version : undefined;
    if (!(Number.isInteger(version) && (version as number) >= 0)) throw problemsError(['version: send the version of the script you read (draft_version)'], 'this approval');
    const settings = await getStudioSettings(creatorId);
    return withTransaction(async (client) => {
        const row = await loadLocked(client, creatorId, id);
        requireStatus(row, ['draft'], 'be approved');
        if (version !== row.draft_version) {
            throw new StudioError(409, 'The script changed since you opened it. Read it again, then approve.', undefined, 'CHANGED_MEANWHILE');
        }
        const scenes = await loadScenes(client, creatorId, id);
        const found = checkDraft(draftInputOf(row, scenes), { tier: row.length_tier, language: row.language, pace: settings.explainer.pace[row.language] }).problems;
        const problems: DraftFinding[] = [...found];
        if (!row.title?.trim()) problems.push({ code: 'field_empty', field: 'title', message: 'The title is empty.' });
        if (problems.length) throw draftRefused(problems);
        const job = await enqueueJob(client, creatorId, 'explainer_voice', voicePayload(row, scenes, settings));
        await supersede(client, creatorId, row.job_id, 'The script was approved.');
        await transitionExplainer(client, id, ['draft'], 'voicing', { job_id: job.id }, creatorId);
        log('info', 'explainer.approved', { explainer_id: id, version: row.draft_version, scenes: scenes.length, job_id: job.id });
        return loadView(client, creatorId, id);
    });
}

/** POST /explainers/:id/revoice: the narration changed after it was voiced, so it is voiced again. Refused while the audio is fresh. */
export async function revoiceExplainer(creatorId: string, rawId: unknown): Promise<ExplainerView> {
    const id = explainerIdOf(rawId);
    const settings = await getStudioSettings(creatorId);
    return withTransaction(async (client) => {
        const row = await loadLocked(client, creatorId, id);
        requireStatus(row, ['drawing', 'review', 'ready'], 'be voiced again');
        if (!isAudioStale(row)) {
            throw new ExplainerError('EXPLAINER_BAD_STATE', 'The narration has not changed since it was voiced, so there is nothing to voice again.', { status: row.status, to: 'voicing' });
        }
        const scenes = await loadScenes(client, creatorId, id);
        const job = await enqueueJob(client, creatorId, 'explainer_voice', voicePayload(row, scenes, settings));
        await supersede(client, creatorId, row.job_id, 'The narration is being voiced again.');
        await transitionExplainer(client, id, ['drawing', 'review', 'ready'], 'voicing', { job_id: job.id, draw_paused_until: null }, creatorId);
        log('info', 'explainer.revoiced', { explainer_id: id, version: row.draft_version, job_id: job.id });
        return loadView(client, creatorId, id);
    });
}

// ─── Draw ──────────────────────────────────────────────────────────────────────────────────────

/**
 * POST /explainers/:id/draw: draw the scenes that have no picture, unattended: the Mac's loop around the server's draw-next. For an explainer that is `drawing`:
 * after a pause (a waiting job is replaced by one that goes now: if the allowance is still spent it pauses again), after scenes failed (they are asked again),
 * or after the owner redrew some by hand. A drawing already on its way is left alone: pressing twice is one job.
 */
export async function startDraw(creatorId: string, rawId: unknown): Promise<ExplainerView> {
    const id = explainerIdOf(rawId);
    return withTransaction(async (client) => {
        const row = await loadLocked(client, creatorId, id);
        requireStatus(row, ['drawing'], 'start drawing');
        if (row.job_id) {
            const { rows } = await client.query<{ status: string; not_before: Date | string }>(
                `SELECT status, not_before FROM studio_jobs WHERE id = $1 AND creator_id = $2 AND kind = 'explainer_draw'`, [row.job_id, creatorId]
            );
            const job = rows[0];
            const waiting = job?.status === 'pending' && new Date(job.not_before).getTime() > Date.now();
            if (job && (job.status === 'claimed' || (job.status === 'pending' && !waiting))) return loadView(client, creatorId, id);
        }
        // Scenes that failed, and any whose drawing was left half done by a crash, are asked again: a failed scene has no picture to draw twice.
        await client.query(
            `UPDATE explainer_scenes SET draw_status = 'pending', draw_error = NULL, updated_at = NOW()
              WHERE explainer_id = $1 AND creator_id = $2
                AND (draw_status = 'failed' OR (draw_status = 'drawing' AND updated_at < NOW() - make_interval(mins => $3)))`,
            [id, creatorId, STALE_DRAWING_MINUTES]
        );
        await supersede(client, creatorId, row.job_id, 'Drawing was started again.');
        const job = await enqueueJob(client, creatorId, 'explainer_draw', drawPayload(row));
        await updateExplainerFields(client, creatorId, id, { job_id: job.id, error: null, draw_paused_until: null });
        log('info', 'explainer.draw_started', { explainer_id: id, job_id: job.id });
        return loadView(client, creatorId, id);
    });
}

// ─── Render ────────────────────────────────────────────────────────────────────────────────────

async function publicBase(): Promise<string> {
    const base = await getPublicBaseUrl(null);
    if (!base) throw new StudioError(500, 'No public address for this app: set it in Settings → TikTok app.');
    return base;
}

/** Queue a render of the explainer as it is now, after the checks every render needs (`renderReadiness`); the explainer moves to `rendering`. */
async function queueRender(client: Exec, row: ExplainerRow, from: readonly ExplainerStatus[], base: string, settings: StudioSettings): Promise<void> {
    const scenes = await loadScenes(client, row.creator_id, row.id);
    const payload = renderPayload(row, scenes, settings, base);
    const job = await enqueueJob(client, row.creator_id, 'explainer_render', payload);
    await supersede(client, row.creator_id, row.job_id, 'A newer render was asked for.');
    // The previous render stays on the row until the new one lands (FR-026): the transition does not touch `render`.
    await transitionExplainer(client, row.id, from, 'rendering', { job_id: job.id }, row.creator_id);
    log('info', 'explainer.render_queued', { explainer_id: row.id, job_id: job.id, version: row.draft_version, sound_mode: row.sound_mode, from: row.status });
}

/**
 * POST /explainers/:id/approve-pictures: gate 2. Every scene has a picture and the audio is the narration's (409 otherwise, saying which), and the track is
 * there when the sound is music. Then it is rendered: status `rendering`.
 */
export async function approvePictures(creatorId: string, rawId: unknown): Promise<ExplainerView> {
    const id = explainerIdOf(rawId);
    const [settings, base] = await Promise.all([getStudioSettings(creatorId), publicBase()]);
    return withTransaction(async (client) => {
        const row = await loadLocked(client, creatorId, id);
        requireStatus(row, ['review'], 'have its pictures approved');
        await queueRender(client, row, ['review'], base, settings);
        return loadView(client, creatorId, id);
    });
}

/** POST /explainers/:id/render: a new render of a `ready` explainer (a label or a picture changed, or the sound): the old files stay until it lands. */
export async function renderExplainer(creatorId: string, rawId: unknown): Promise<ExplainerView> {
    const id = explainerIdOf(rawId);
    const [settings, base] = await Promise.all([getStudioSettings(creatorId), publicBase()]);
    return withTransaction(async (client) => {
        const row = await loadLocked(client, creatorId, id);
        requireStatus(row, ['ready'], 'be rendered again');
        await queueRender(client, row, ['ready'], base, settings);
        return loadView(client, creatorId, id);
    });
}

// ─── Retry ─────────────────────────────────────────────────────────────────────────────────────

/** POST /explainers/:id/retry: the failed step, again, from the state it runs in. A failed schedule goes back to `ready`, where Schedule is pressed again. */
export async function retryExplainer(creatorId: string, rawId: unknown, now: number = Date.now()): Promise<ExplainerView> {
    const id = explainerIdOf(rawId);
    const settings = await getStudioSettings(creatorId);
    const base = await getPublicBaseUrl(null);
    const { view, run } = await withTransaction(async (client) => {
        const row = await loadLocked(client, creatorId, id);
        requireStatus(row, ['failed'], 'be retried');
        const step = row.failed_step!;
        let run: GeminiRun | null = null;
        if (step === 'write') {
            const scenes = await loadScenes(client, creatorId, id);
            const rewrite = row.rewrite_note && row.draft ? { note: row.rewrite_note, previous: previousDraftOf(row, scenes) } : null;
            const queued = await queueWrite(client, row, settings, { today: today(now), rewrite });
            await transitionExplainer(client, id, ['failed'], RETRY_STATUS.write, { job_id: queued.jobId }, creatorId);
            if (queued.writer === 'gemini') run = { creatorId, explainerId: id, jobId: queued.jobId };
        } else if (step === 'voice') {
            const scenes = await loadScenes(client, creatorId, id);
            const job = await enqueueJob(client, creatorId, 'explainer_voice', voicePayload(row, scenes, settings));
            await transitionExplainer(client, id, ['failed'], RETRY_STATUS.voice, { job_id: job.id }, creatorId);
        } else if (step === 'draw') {
            await client.query(
                `UPDATE explainer_scenes SET draw_status = 'pending', draw_error = NULL, updated_at = NOW()
                  WHERE explainer_id = $1 AND creator_id = $2 AND (draw_status = 'failed' OR draw_status = 'drawing')`, [id, creatorId]
            );
            const job = await enqueueJob(client, creatorId, 'explainer_draw', drawPayload(row));
            await transitionExplainer(client, id, ['failed'], RETRY_STATUS.draw, { job_id: job.id, draw_paused_until: null }, creatorId);
        } else if (step === 'render') {
            if (!base) throw new StudioError(500, 'No public address for this app: set it in Settings → TikTok app.');
            const scenes = await loadScenes(client, creatorId, id);
            const job = await enqueueJob(client, creatorId, 'explainer_render', renderPayload(row, scenes, settings, base));
            await transitionExplainer(client, id, ['failed'], RETRY_STATUS.render, { job_id: job.id }, creatorId);
        } else {
            await transitionExplainer(client, id, ['failed'], RETRY_STATUS.schedule, {}, creatorId);
        }
        log('info', 'explainer.retried', { explainer_id: id, step });
        return { view: await loadView(client, creatorId, id), run };
    });
    if (run) startGeminiRun(run);
    return view;
}

// ─── Delete ────────────────────────────────────────────────────────────────────────────────────

/** Every upload an explainer holds: its pictures (the chosen ones and the history), its audio and its rendered files. */
export function filesOf(row: Pick<ExplainerRow, 'audio' | 'render'>, scenes: readonly Pick<ExplainerSceneRow, 'picture' | 'pictures'>[]): string[] {
    const urls: string[] = [];
    for (const scene of scenes) {
        if (scene.picture) urls.push(scene.picture.url);
        for (const picture of scene.pictures) urls.push(picture.url);
    }
    if (row.audio) urls.push(row.audio.url);
    if (row.render) urls.push(row.render.vertical_url, row.render.horizontal_url, row.render.cover_url);
    return urls;
}

/**
 * DELETE /explainers/:id. The row and its scenes go, its job is failed if the worker has not taken it (one that is running finishes, and its answer is dropped:
 * there is no explainer to land on), and its files are deleted, except any a post names (a file already handed to a platform is the post's now).
 */
export async function deleteExplainer(creatorId: string, rawId: unknown): Promise<void> {
    const id = explainerIdOf(rawId);
    await withTransaction(async (client) => {
        const row = await loadLocked(client, creatorId, id);
        const scenes = await loadScenes(client, creatorId, id);
        await supersede(client, creatorId, row.job_id, 'The explainer was deleted.');
        await client.query('DELETE FROM explainers WHERE id = $1 AND creator_id = $2', [id, creatorId]);
        // After the delete, so nothing the row named still counts as named by it.
        const deleted = await deleteUnreferencedUploads(client, creatorId, filesOf(row, scenes));
        log('info', 'explainer.deleted', { explainer_id: id, status: row.status, files_deleted: deleted });
    });
}
