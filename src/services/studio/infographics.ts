/**
 * Animated infographics (v31): the rows, and what the Infographics screen does with them.
 * infographicSpec.ts holds what one is and the checks; this file holds the lifecycle:
 *
 *   create     topic → a `writing` row and a render_infographic job whose payload asks Claude (on
 *              the Mac, the owner's plan) to write it first. The worker renders what Claude wrote
 *              and returns that spec, the caption and the three files; jobs.ts applies them.
 *              `theme: 'both'` writes once and renders twice: jobs.ts copies it into the other
 *              theme as soon as Claude's answer lands (`pair_theme`).
 *   edit       a spec edited in the dashboard → `rendering`, a job with the spec in it.
 *              A caption edited alone is only saved: the files don't change.
 *   render     the same spec in the other theme, or `rewrite`: Claude writes it again.
 *   copy       a new row with the same spec in the other theme: the light one AND the dark one.
 *   schedule   the MP4 with the caption, to the platforms `infographic.platforms` names, at the
 *              next free posting slot (the Monteur's `post_at`, which reels share) or a given time.
 *              Refused while the caption doesn't name every column the GIF shows.
 *
 * Every write of a job's id goes with the job's insert, in one transaction: `job_id` is how the
 * result of an older render is told apart from the latest (jobs.ts drops it).
 */
import crypto from 'crypto';
import { pool } from '../../config/db.js';
import type { InfographicRow, InfographicSchedule, RenderInfographicPayload, ScheduledPostRow } from '../../db/rows.js';
import { log } from '../../utils/log.js';
import { assertMacBrainAllowed } from '../macBrain.js';
import { insertVideoPost, metaPlatformFor } from '../monteur/clips.js';
import { THINK_MODEL } from '../monteur/think.js';
import { clipText, type Exec, isPlainObject, lockTenantPublishing, problemsError, requireId, StudioError, withTransaction } from './common.js';
import {
    captionProblems, dirFor, headline, payloadBrand, specProblems, THEMES, WRITE_SCHEMA, writeSystemPrompt, writeUserPrompt,
    type InfographicSpec,
} from './infographicSpec.js';
import { enqueueJob } from './jobs.js';
import { getStudioSettings } from './settings.js';
import type { InfographicTheme, StudioSettings } from './settingsTypes.js';
import { nextFreeSlots } from './slots.js';

export const MAX_TOPIC = 300;
export const MIN_TOPIC = 3;
export const MAX_NOTES = 2000;
/** The newest ones, on the screen. Older rows stay until deleted. */
export const LIST_LIMIT = 60;
const SLOT_LOOKAHEAD = 30;

export type InfographicView = Omit<InfographicRow, 'creator_id'> & {
    /** "A vs B: subtitle", or the topic until Claude has written it. */
    headline: string;
    /** What the spec or the caption breaks, one per line (the stored `error` of a ready row). */
    problems: string[];
    /** The latest job's state and progress line, while one is open. */
    job: { status: string; progress: string | null } | null;
};

const VIEW_SQL = `
    SELECT i.id, i.topic, i.notes, i.language, i.theme, i.pair_theme, i.status, i.spec, i.caption, i.review, i.render, i.schedule, i.job_id,
           i.error, i.created_at, i.updated_at, j.status AS job_status, j.progress AS job_progress
      FROM infographics i
      LEFT JOIN studio_jobs j ON j.id = i.job_id
     WHERE i.creator_id = $1`;

type ViewRow = Omit<InfographicRow, 'creator_id'> & { job_status: string | null; job_progress: string | null };

function present(row: ViewRow): InfographicView {
    const { job_status, job_progress, ...rest } = row;
    const open = rest.status === 'writing' || rest.status === 'rendering';
    return {
        ...rest,
        headline: rest.spec ? headline(rest.spec) : rest.topic,
        // A failed row's error is why it failed; a ready one's is what to fix.
        problems: rest.status === 'ready' && rest.error ? rest.error.split('\n') : [],
        job: open && job_status ? { status: job_status, progress: job_progress } : null,
    };
}

export async function listInfographics(creatorId: string): Promise<InfographicView[]> {
    const { rows } = await pool.query<ViewRow>(`${VIEW_SQL} ORDER BY i.created_at DESC LIMIT ${LIST_LIMIT}`, [creatorId]);
    return rows.map(present);
}

async function loadView(exec: Exec, creatorId: string, id: string): Promise<InfographicView> {
    const { rows } = await exec.query<ViewRow>(`${VIEW_SQL} AND i.id = $2`, [creatorId, id]);
    if (!rows[0]) throw new StudioError(404, 'No such infographic.');
    return present(rows[0]);
}

export async function getInfographic(creatorId: string, rawId: unknown): Promise<InfographicView> {
    return loadView(pool, creatorId, requireId(rawId, 'infographic'));
}

async function lockRow(exec: Exec, creatorId: string, id: string): Promise<InfographicRow> {
    const { rows } = await exec.query<InfographicRow>('SELECT * FROM infographics WHERE id = $1 AND creator_id = $2 FOR UPDATE', [id, creatorId]);
    if (!rows[0]) throw new StudioError(404, 'No such infographic.');
    return rows[0];
}

/** An open job means its result is still coming; anything that would queue another waits for it. */
function assertIdle(row: InfographicRow): void {
    if (row.status === 'writing') throw new StudioError(409, 'Claude is still writing this infographic.');
    if (row.status === 'rendering') throw new StudioError(409, 'This infographic is still rendering.');
    if (row.status === 'scheduled') throw new StudioError(409, 'This infographic is already scheduled. Make a copy to change it.');
}

function parseTheme(raw: unknown, fallback: InfographicTheme): InfographicTheme {
    if (raw === undefined || raw === null) return fallback;
    if (!THEMES.includes(raw as InfographicTheme)) throw new StudioError(400, `theme must be ${THEMES.join(' or ')}.`);
    return raw as InfographicTheme;
}

/** The job: Claude writes first (`write`), or the spec is rendered as it is. */
export function renderPayload(
    id: string, row: Pick<InfographicRow, 'topic' | 'notes' | 'language'>, theme: InfographicTheme, settings: StudioSettings,
    spec: unknown | null
): RenderInfographicPayload {
    const base: RenderInfographicPayload = { infographicId: id, theme, language: row.language, brand: payloadBrand(settings.infographic) };
    if (spec) return { ...base, spec };
    return {
        ...base,
        write: {
            model: THINK_MODEL,
            purpose: 'the infographic and its caption',
            system: writeSystemPrompt(row.language),
            user: writeUserPrompt({ topic: row.topic, notes: row.notes, language: row.language, avoid: settings.voice.avoid ?? [] }),
            schema: WRITE_SCHEMA as unknown as Record<string, unknown>,
        },
    };
}

async function queue(exec: Exec, creatorId: string, id: string, payload: RenderInfographicPayload, status: 'writing' | 'rendering'): Promise<void> {
    const job = await enqueueJob(exec, creatorId, 'render_infographic', payload);
    await exec.query(
        `UPDATE infographics SET status = $3, theme = $4, job_id = $5, error = NULL, updated_at = NOW()
          WHERE id = $1 AND creator_id = $2`,
        [id, creatorId, status, payload.theme, job.id]
    );
}

/** POST /infographics `{ topic, notes?, language?, theme? }` (theme dark, light or both): Claude writes it, then the Mac renders it. */
export async function createInfographic(creatorId: string, body: unknown): Promise<InfographicView> {
    const b = isPlainObject(body) ? body : {};
    const topic = clipText(b.topic, MAX_TOPIC + 1);
    const problems: string[] = [];
    if (!topic || topic.length < MIN_TOPIC) problems.push('topic: say what to compare, e.g. "RAG vs CAG vs KAG"');
    else if (topic.length > MAX_TOPIC) problems.push(`topic is longer than ${MAX_TOPIC} characters`);
    const notes = clipText(b.notes, MAX_NOTES + 1);
    if (notes && notes.length > MAX_NOTES) problems.push(`notes are longer than ${MAX_NOTES} characters`);
    if (b.language !== undefined && b.language !== 'ar' && b.language !== 'en') problems.push('language must be ar or en');
    if (problems.length) throw problemsError(problems, 'this infographic');
    // Claude writes it, on the Mac: only for the owner and the tenants the operator added, and before any row exists (G1).
    await assertMacBrainAllowed(creatorId);

    const settings = await getStudioSettings(creatorId);
    const language = (b.language as 'ar' | 'en' | undefined) ?? settings.infographic.language;
    const both = b.theme === 'both';
    // Both: the settings' theme first, the other one copied from it once it is written.
    const theme = both ? settings.infographic.theme : parseTheme(b.theme, settings.infographic.theme);
    const pair: InfographicTheme | null = both ? (theme === 'dark' ? 'light' : 'dark') : null;
    return withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
            `INSERT INTO infographics (creator_id, topic, notes, language, theme, pair_theme, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'writing') RETURNING id`,
            [creatorId, topic, notes, language, theme, pair]
        );
        const id = rows[0]!.id;
        await queue(client, creatorId, id, renderPayload(id, { topic: topic!, notes, language }, theme, settings, null), 'writing');
        log('info', 'studio.infographic_created', { infographic_id: id, language, theme, pair_theme: pair });
        return loadView(client, creatorId, id);
    });
}

/**
 * The spec as the dashboard sends it, made consistent with the row: `dir` from its language,
 * `title` from the columns' names. Everything else is checked as Claude's answer is.
 */
export function normaliseSpec(raw: unknown, language: 'ar' | 'en'): InfographicSpec {
    if (!isPlainObject(raw) || !Array.isArray(raw.columns)) throw problemsError(['spec must be an infographic, with columns'], 'this infographic');
    const columns = raw.columns as InfographicSpec['columns'];
    const spec = { ...raw, dir: dirFor(language), title: columns.map((c) => (isPlainObject(c) && typeof c.name === 'string' ? c.name : '')) };
    const problems = specProblems(spec);
    if (problems.length) throw problemsError(problems, 'this infographic');
    return spec as InfographicSpec;
}

/**
 * PATCH /infographics/:id `{ spec?, caption? }`. A new spec is rendered again; a caption alone is
 * only saved. Either way the stored problems are worked out again, so the screen and Schedule agree.
 */
export async function updateInfographic(creatorId: string, rawId: unknown, body: unknown): Promise<InfographicView> {
    const id = requireId(rawId, 'infographic');
    const b = isPlainObject(body) ? body : {};
    if (b.spec === undefined && b.caption === undefined) throw new StudioError(400, 'Send the spec, the caption, or both.');
    if (b.caption !== undefined && typeof b.caption !== 'string') throw new StudioError(400, 'caption must be text.');
    const settings = b.spec !== undefined ? await getStudioSettings(creatorId) : null;
    return withTransaction(async (client) => {
        const row = await lockRow(client, creatorId, id);
        assertIdle(row);
        const caption = typeof b.caption === 'string' ? b.caption.trim() : row.caption;
        if (b.spec !== undefined) {
            const spec = normaliseSpec(b.spec, row.language);
            await client.query('UPDATE infographics SET spec = $3::jsonb, caption = $4 WHERE id = $1 AND creator_id = $2', [id, creatorId, JSON.stringify(spec), caption]);
            await queue(client, creatorId, id, renderPayload(id, row, row.theme, settings!, spec), 'rendering');
        } else {
            if (!row.spec) throw new StudioError(409, 'Claude hasn\'t written this infographic yet: there is no caption to edit.');
            // A ready row's error is its list of problems, so it is worked out again; a failed row keeps why it failed.
            const problems = [...specProblems(row.spec), ...captionProblems(caption, row.spec)];
            const error = row.status === 'ready' ? (problems.length ? problems.join('\n') : null) : row.error;
            await client.query(
                `UPDATE infographics SET caption = $3, error = $4, updated_at = NOW() WHERE id = $1 AND creator_id = $2`,
                [id, creatorId, caption, error]
            );
        }
        return loadView(client, creatorId, id);
    });
}

/** POST /infographics/:id/render `{ theme?, rewrite? }`: this one again, in a theme, or written again by Claude. */
export async function rerenderInfographic(creatorId: string, rawId: unknown, body: unknown): Promise<InfographicView> {
    const id = requireId(rawId, 'infographic');
    const b = isPlainObject(body) ? body : {};
    // Written again by Claude on the Mac: the same gate as a new one, before the row is locked (G1). A row with no
    // spec yet is a rewrite whatever the body says, and `enqueueJob` refuses that one. A render alone needs none.
    if (b.rewrite === true) await assertMacBrainAllowed(creatorId);
    const settings = await getStudioSettings(creatorId);
    return withTransaction(async (client) => {
        const row = await lockRow(client, creatorId, id);
        assertIdle(row);
        const theme = parseTheme(b.theme, row.theme);
        const rewrite = b.rewrite === true || !row.spec;
        await queue(client, creatorId, id, renderPayload(id, row, theme, settings, rewrite ? null : row.spec), rewrite ? 'writing' : 'rendering');
        return loadView(client, creatorId, id);
    });
}

/** POST /infographics/:id/copy `{ theme }`: the same infographic in another theme, as a row of its own. */
export async function copyInfographic(creatorId: string, rawId: unknown, body: unknown): Promise<InfographicView> {
    const id = requireId(rawId, 'infographic');
    const b = isPlainObject(body) ? body : {};
    const settings = await getStudioSettings(creatorId);
    return withTransaction(async (client) => {
        const source = await lockRow(client, creatorId, id);
        if (!source.spec) throw new StudioError(409, 'Claude hasn\'t written this infographic yet: wait for it, then copy it.');
        const theme = parseTheme(b.theme, source.theme === 'dark' ? 'light' : 'dark');
        const { rows } = await client.query<{ id: string }>(
            `INSERT INTO infographics (creator_id, topic, notes, language, theme, status, spec, caption, review)
             VALUES ($1, $2, $3, $4, $5, 'rendering', $6::jsonb, $7, $8::jsonb) RETURNING id`,
            [creatorId, source.topic, source.notes, source.language, theme, JSON.stringify(source.spec), source.caption,
                source.review ? JSON.stringify(source.review) : null]
        );
        const copyId = rows[0]!.id;
        await queue(client, creatorId, copyId, renderPayload(copyId, source, theme, settings, source.spec), 'rendering');
        return loadView(client, creatorId, copyId);
    });
}

export interface InfographicScheduleOutcome {
    infographic: InfographicView;
    scheduled_time: string;
    rows: ScheduledPostRow[];
}

/**
 * POST /infographics/:id/schedule `{ scheduled_time? | now? }`: the MP4 and its caption into the
 * scheduler, one group: Instagram and Facebook as one row, YouTube as its sibling. The GIF is not
 * posted anywhere: it is the operator's, to download for LinkedIn, X and the rest.
 */
export async function scheduleInfographic(creatorId: string, rawId: unknown, body: unknown, now: number = Date.now()): Promise<InfographicScheduleOutcome> {
    const id = requireId(rawId, 'infographic');
    const b = isPlainObject(body) ? body : {};
    let requested: Date | null = null;
    if (b.now === true) requested = new Date(now);
    else if (b.scheduled_time !== undefined && b.scheduled_time !== null) {
        requested = typeof b.scheduled_time === 'string' ? new Date(b.scheduled_time) : new Date(NaN);
        if (Number.isNaN(requested.getTime())) throw new StudioError(400, 'scheduled_time must be a date and time, e.g. 2026-10-14T16:00:00Z.');
    }
    const settings = await getStudioSettings(creatorId);
    const platforms = settings.infographic.platforms;
    const meta = metaPlatformFor(platforms);
    const youtube = platforms.includes('youtube');
    if (!meta && !youtube) throw new StudioError(409, 'Choose where infographics are posted in the brand settings first.');

    return withTransaction(async (client) => {
        await lockTenantPublishing(client, creatorId);
        const row = await lockRow(client, creatorId, id);
        if (row.status !== 'ready' || !row.render) {
            throw new StudioError(409, row.status === 'scheduled' ? 'This infographic is already scheduled.' : `This infographic is ${row.status}; only a ready one can be scheduled.`);
        }
        const problems = captionProblems(row.caption, row.spec);
        if (problems.length) throw problemsError(problems, 'this caption', 409);

        let when = requested;
        if (!when) {
            const free = await nextFreeSlots(creatorId, { timezone: settings.schedule.timezone, slots: settings.monteur.post_at }, SLOT_LOOKAHEAD, now, { exec: client });
            if (!free[0]) throw new StudioError(409, 'There is no free posting slot in the next weeks: choose a time.');
            when = new Date(free[0]);
        }
        const groupId = crypto.randomUUID();
        const caption = row.caption!;
        const rows: ScheduledPostRow[] = [];
        if (meta) {
            rows.push(await insertVideoPost(client, {
                creatorId, platform: meta, caption, mediaUrl: row.render.mp4_url, coverUrl: row.render.cover_url, when, groupId, options: null,
            }));
        }
        if (youtube) {
            // Not checked against the connection, as the Monteur does: a YouTube that isn't connected
            // must not keep the post off Instagram and Facebook. Its row fails in Posts, saying so.
            rows.push(await insertVideoPost(client, {
                creatorId, platform: 'youtube', caption, mediaUrl: row.render.mp4_url, coverUrl: row.render.cover_url, when, groupId,
                options: { title: headline(row.spec), language: row.language },
            }));
        }
        const schedule: InfographicSchedule = { scheduled_time: when.toISOString(), group_id: groupId, row_ids: rows.map((r) => r.id) };
        await client.query(
            `UPDATE infographics SET status = 'scheduled', schedule = $3::jsonb, error = NULL, updated_at = NOW() WHERE id = $1 AND creator_id = $2`,
            [id, creatorId, JSON.stringify(schedule)]
        );
        log('info', 'studio.infographic_scheduled', { infographic_id: id, rows: rows.length, scheduled_time: schedule.scheduled_time });
        return { infographic: await loadView(client, creatorId, id), scheduled_time: schedule.scheduled_time, rows };
    });
}

/**
 * DELETE /infographics/:id. Its scheduled posts are left alone: they are Posts' now. A job still
 * waiting for the worker is failed so the Mac doesn't render it; one already running finishes and
 * its result is dropped. The files go with the media sweep.
 */
export async function deleteInfographic(creatorId: string, rawId: unknown): Promise<void> {
    const id = requireId(rawId, 'infographic');
    await withTransaction(async (client) => {
        const { rows } = await client.query<{ job_id: string | null }>(
            'DELETE FROM infographics WHERE id = $1 AND creator_id = $2 RETURNING job_id', [id, creatorId]
        );
        if (!rows[0]) throw new StudioError(404, 'No such infographic.');
        if (rows[0].job_id) {
            await client.query(
                `UPDATE studio_jobs SET status = 'failed', error = 'The infographic was deleted.', updated_at = NOW()
                  WHERE id = $1 AND creator_id = $2 AND status = 'pending'`,
                [rows[0].job_id, creatorId]
            );
        }
    });
}
