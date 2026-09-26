/**
 * A reel in the review queue (MONTEUR.md §5): edit it, approve it into the scheduler, or reject it.
 *
 *   rendering ─(worker)→ review ─approve→ scheduled
 *        ↑                 │ └─reject→ rejected
 *        └── edit of the title or keyword (burned into the video), or any edit of a failed clip
 *
 * Approve is modelled on the Studio's `scheduleDraft` (src/services/studio/schedule.ts): the rows
 * it writes are the rows `POST /api/posts/scheduled` writes, and they publish through the same
 * sweep. One Meta row (`both`, `instagram` or `facebook`, per the tenant's platforms) with the
 * video, its cover and the caption; a TikTok sibling on the same `group_id` with the TikTok
 * caption and the Studio's Direct Post options; and the keyword → DM campaign unless an active
 * one already answers the keyword. Everything is checked before the transaction; inside it the
 * clip is locked and re-checked, so two clicks schedule it once.
 */
import crypto from 'crypto';
import { pool } from '../../config/db.js';
import { queryRows } from '../../db/query.js';
import type { CampaignRow, ClipCopy, ClipDraftRow, ClipSchedule, MonteurSourceRow, ScheduledPostRow, TikTokPostOptions } from '../../db/rows.js';
import { normalizeArabic } from '../../utils/arabic.js';
import { log } from '../../utils/log.js';
import { getTikTokPostingFlags } from '../appSettings.js';
import { matchCampaign } from '../matching.js';
import { type Exec, isPlainObject, problemsError, StudioError, unique, withTransaction } from '../studio/common.js';
import {
    cancelClipRenders, deleteUnreferencedUploads, enqueueMonteurRender, markSourceDoneIfRendered,
} from '../studio/jobs.js';
import { askLine, tiktokLine } from '../studio/prompts.js';
import { assertDirectPostReady, studioTikTokOptions } from '../studio/schedule.js';
import { getStudioSettings } from '../studio/settings.js';
import { nextFreeSlots } from '../studio/slots.js';
import { accentsFor, buildRenderPayload, clipAccent } from './render.js';
import { MAX_TITLE } from './transcript.js';
import { type ClipView, loadClipView } from './view.js';

/** Instagram's caption limit; TikTok's is the same for a video's title. */
export const MAX_CAPTION = 2200;
const MAX_DM = 4000;
const MAX_ALT_TEXT = 1000;
const MAX_HASHTAGS = 30;
const MAX_VARIANTS = 10;
const COPY_KEYS: readonly (keyof ClipCopy)[] = [
    'caption', 'tiktok_caption', 'hashtags', 'keyword', 'variants', 'keyword_create', 'dm', 'alt_text',
];

/** One word: what a commenter types. */
function isOneWord(value: string): boolean {
    return value.length > 0 && value.length <= 30 && !/[\s,،]/.test(value);
}

async function lockClip(exec: Exec, creatorId: string, clipId: string): Promise<ClipDraftRow> {
    const { rows } = await exec.query<ClipDraftRow>(
        `SELECT id, creator_id, source_id, rank, status, start_s::float8 AS start_s, end_s::float8 AS end_s, title, hook, why,
                score::float8 AS score, copy, render, schedule, error, created_at, updated_at
           FROM clip_drafts WHERE id = $1 AND creator_id = $2 FOR UPDATE`,
        [clipId, creatorId]
    );
    if (!rows[0]) throw new StudioError(404, 'No such clip.');
    return rows[0];
}

// ─── PATCH ──────────────────────────────────────────────────────────────────────────────

export interface ClipPatch { title?: string; copy: Partial<ClipCopy> }

/** `{ title?, copy?: Partial<ClipCopy> }`, each field checked. A key that is not a field is refused. */
export function parseClipPatch(body: unknown): ClipPatch {
    if (!isPlainObject(body) || !('title' in body || 'copy' in body)) {
        throw new StudioError(400, 'Send the title or the copy to change.');
    }
    const problems: string[] = [];
    for (const key of Object.keys(body)) if (key !== 'title' && key !== 'copy') problems.push(`"${key}" cannot be changed here`);

    const patch: ClipPatch = { copy: {} };
    if ('title' in body) {
        const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
        if (!title) problems.push('title is the on-screen hook: it cannot be empty');
        else if (title.length > MAX_TITLE) problems.push(`title is ${title.length} characters; the limit is ${MAX_TITLE}`);
        else patch.title = title;
    }
    if ('copy' in body) {
        const raw = body.copy;
        if (!isPlainObject(raw)) {
            problems.push('copy must be an object');
        } else {
            for (const key of Object.keys(raw)) {
                if (!(COPY_KEYS as readonly string[]).includes(key)) problems.push(`copy.${key} is not a field`);
            }
            const text = (key: 'caption' | 'tiktok_caption' | 'dm' | 'alt_text', max: number, required: boolean): void => {
                if (!(key in raw)) return;
                const v = raw[key];
                if (typeof v !== 'string') problems.push(`copy.${key} must be text`);
                else if (required && !v.trim()) problems.push(`copy.${key} cannot be empty`);
                else if (v.length > max) problems.push(`copy.${key} is ${v.length} characters; the limit is ${max}`);
                else patch.copy[key] = key === 'alt_text' ? v.replace(/\s+/g, ' ').trim() : v.trim();
            };
            text('caption', MAX_CAPTION, true);
            text('tiktok_caption', MAX_CAPTION, true);
            text('dm', MAX_DM, true);
            text('alt_text', MAX_ALT_TEXT, false);
            if ('keyword' in raw) {
                const k = typeof raw.keyword === 'string' ? raw.keyword.trim() : '';
                if (!isOneWord(k)) problems.push('copy.keyword must be one word');
                else patch.copy.keyword = k;
            }
            const words = (key: 'hashtags' | 'variants', max: number, strip: boolean): void => {
                if (!(key in raw)) return;
                const v = raw[key];
                if (!Array.isArray(v) || v.some((w) => typeof w !== 'string')) {
                    problems.push(`copy.${key} must be a list of words`);
                    return;
                }
                const list = unique((v as string[]).map((w) => (strip ? w.trim().replace(/^#+/, '') : w.trim())).filter(Boolean));
                if (list.some((w) => !isOneWord(w))) problems.push(`copy.${key} must be single words`);
                else if (list.length > max) problems.push(`copy.${key} holds at most ${max}`);
                else patch.copy[key] = list;
            };
            words('hashtags', MAX_HASHTAGS, true);
            words('variants', MAX_VARIANTS, false);
            if ('keyword_create' in raw) {
                if (typeof raw.keyword_create !== 'boolean') problems.push('copy.keyword_create must be true or false');
                else patch.copy.keyword_create = raw.keyword_create;
            }
        }
    }
    if (problems.length) throw problemsError(problems, 'this clip');
    return patch;
}

/**
 * PATCH /clips/:id. A new title or keyword changes the burned-in video, so the clip is rendered
 * again; so is a failed clip, whatever the edit, since a new render is the only way forward for
 * it. A caption-only change on a clip in review keeps its video.
 *
 * A new keyword carries the caption's keyword ask with it (unless a caption is sent too), drops
 * the old keyword's variants, and is marked for a campaign. A caption or keyword change must
 * leave the caption asking for the keyword — the same rule a carousel's caption holds — or every
 * comment would arrive and none would be answered.
 */
export async function patchClip(creatorId: string, clipId: string, body: unknown): Promise<ClipView> {
    const patch = parseClipPatch(body);
    return withTransaction(async (client) => {
        const clip = await lockClip(client, creatorId, clipId);
        if (clip.status === 'scheduled') throw new StudioError(409, 'This reel is scheduled: edit its post in Posts instead.');
        if (clip.status === 'rejected') throw new StudioError(409, 'This reel was rejected.');
        const settings = await getStudioSettings(creatorId, client);

        const before = clip.copy;
        const copy: ClipCopy = { ...before, ...patch.copy };
        const keywordChanged = patch.copy.keyword !== undefined
            && normalizeArabic(patch.copy.keyword) !== normalizeArabic(before.keyword);
        if (keywordChanged) {
            const oldAsk = askLine(settings, before.keyword);
            if (patch.copy.caption === undefined && oldAsk) copy.caption = copy.caption.split(oldAsk).join(askLine(settings, copy.keyword));
            if (patch.copy.variants === undefined) copy.variants = [];
            if (patch.copy.keyword_create === undefined) copy.keyword_create = true;
        }

        const problems: string[] = [];
        if (patch.copy.caption !== undefined || keywordChanged) {
            const ask = askLine(settings, copy.keyword);
            if (ask && !copy.caption.includes(ask)) problems.push(`The caption must keep the keyword ask: «${ask}»`);
        }
        if (patch.copy.tiktok_caption !== undefined) {
            const link = tiktokLine(settings);
            if (link && !copy.tiktok_caption.includes(link)) problems.push(`The TikTok caption must keep the line «${link}»`);
        }
        if (problems.length) throw problemsError(problems, 'this clip');

        const title = patch.title ?? clip.title;
        const rerender = title !== clip.title || keywordChanged || clip.status === 'failed';
        await client.query(
            `UPDATE clip_drafts SET title = $3, copy = $4::jsonb, updated_at = NOW() WHERE id = $1 AND creator_id = $2`,
            [clip.id, creatorId, title, JSON.stringify(copy)]
        );
        if (rerender) {
            const { rows } = await client.query<Pick<MonteurSourceRow, 'id' | 'path' | 'words'>>(
                'SELECT id, path, words FROM monteur_sources WHERE id = $1 AND creator_id = $2', [clip.source_id, creatorId]
            );
            if (!rows[0]) throw new StudioError(409, 'This reel\'s video is gone, so it cannot be rendered again.');
            const accent = await clipAccent(client, creatorId, clip.id) ?? (await accentsFor(client, creatorId, settings, 1))[0]!;
            await enqueueMonteurRender(client, creatorId, buildRenderPayload({
                clipId: clip.id, source: rows[0], start: clip.start_s, end: clip.end_s, title, keyword: copy.keyword, accent, settings,
            }));
        }
        log('info', 'monteur.clip_edited', { clip_id: clip.id, rerender, fields: [...Object.keys(patch.copy), ...(patch.title ? ['title'] : [])] });
        return loadClipView(client, creatorId, clip.id);
    });
}

// ─── Approve ────────────────────────────────────────────────────────────────────────────

type CampaignPlan =
    | { create: true; triggers: string; dm: string }
    | { create: false; existing: CampaignRow };

/**
 * The campaign to create, unless an active one already triggers on the keyword. "Triggers on" is
 * decided by `matchCampaign` itself, as for the Studio: a substring campaign on a shorter word
 * answers this keyword too, and a second one beside it would never be the one that fires.
 */
async function planCampaign(creatorId: string, copy: ClipCopy): Promise<CampaignPlan> {
    const keyword = copy.keyword?.trim();
    if (!keyword) throw new StudioError(400, 'This reel has no keyword to create a campaign for.');
    const active = await queryRows<CampaignRow>(
        'SELECT * FROM campaigns WHERE creator_id = $1 AND is_active = TRUE', [creatorId]
    );
    // '' as the post id: only campaigns for every post can answer a post that is not live yet.
    const existing = matchCampaign(keyword, '', active);
    if (existing) return { create: false, existing };
    return { create: true, triggers: unique([keyword, ...(copy.variants ?? [])]).join(', '), dm: copy.dm };
}

/** Instagram and Facebook go out as one post: `both`, or the one of them that is on. */
export function metaPlatformFor(platforms: readonly string[]): 'both' | 'instagram' | 'facebook' | null {
    const ig = platforms.includes('instagram');
    const fb = platforms.includes('facebook');
    return ig && fb ? 'both' : ig ? 'instagram' : fb ? 'facebook' : null;
}

async function insertVideoPost(exec: Exec, row: {
    creatorId: string; platform: 'both' | 'instagram' | 'facebook' | 'tiktok'; caption: string; mediaUrl: string;
    coverUrl: string | null; when: Date; groupId: string; options: TikTokPostOptions | null;
}): Promise<ScheduledPostRow> {
    // The column list and order of POST /posts/scheduled's insert, so the two cannot drift.
    const { rows } = await exec.query<ScheduledPostRow>(
        `INSERT INTO scheduled_posts
             (creator_id, platform, post_type, caption, media_url, media_urls, scheduled_time, status, cover_url, group_id, platform_options, meta_options)
         VALUES ($1, $2, 'video', $3, $4, NULL, $5, 'PENDING', $6, $7, $8::jsonb, NULL) RETURNING *`,
        [
            row.creatorId, row.platform, row.caption, row.mediaUrl, row.when,
            // A cover image is an Instagram/Facebook concept; TikTok picks its own.
            row.platform === 'tiktok' ? null : row.coverUrl,
            row.groupId,
            row.options ? JSON.stringify(row.options) : null,
        ]
    );
    if (!rows[0]) throw new Error('scheduled_posts insert returned no row.');
    return rows[0];
}

export interface ApproveOutcome {
    clip: ClipView;
    scheduled_time: string;
    rows: ScheduledPostRow[];
    campaign: { id: string; trigger_keyword: string; created: boolean } | null;
}

/** POST /clips/:id/approve `{ scheduled_time? }`: the given time, or the next free posting slot. */
export async function approveClip(creatorId: string, clipId: string, body: unknown): Promise<ApproveOutcome> {
    const b = isPlainObject(body) ? body : {};
    let when: Date | null = null;
    if (b.scheduled_time !== undefined && b.scheduled_time !== null) {
        when = typeof b.scheduled_time === 'string' ? new Date(b.scheduled_time) : new Date(NaN);
        if (Number.isNaN(when.getTime())) {
            throw new StudioError(400, 'scheduled_time must be a date and time, e.g. 2026-10-01T16:00:00Z.');
        }
    }

    const { rows: found } = await pool.query<Pick<ClipDraftRow, 'id' | 'status' | 'copy' | 'render'>>(
        'SELECT id, status, copy, render FROM clip_drafts WHERE id = $1 AND creator_id = $2', [clipId, creatorId]
    );
    const clip = found[0];
    if (!clip) throw new StudioError(404, 'No such clip.');
    if (clip.status !== 'review' || !clip.render) {
        throw new StudioError(409, clip.status === 'scheduled'
            ? 'This reel is already scheduled.'
            : `This reel is ${clip.status}; only a reel in review can be approved.`);
    }
    const { render, copy } = clip;

    const settings = await getStudioSettings(creatorId);
    const { platforms, post_at: slots } = settings.monteur;
    if (!when) {
        const [slot] = await nextFreeSlots(creatorId, { timezone: settings.schedule.timezone, slots }, 1);
        if (!slot) throw new StudioError(409, 'Every posting slot for the next 90 days is taken: choose a time.');
        when = new Date(slot);
    }
    const meta = metaPlatformFor(platforms);
    let tiktokOptions: TikTokPostOptions | null = null;
    if (platforms.includes('tiktok')) {
        // Said at the click, as the Studio does, not at publish time in a card nobody reads.
        const flags = await getTikTokPostingFlags();
        await assertDirectPostReady(creatorId, flags).catch((err: unknown) => {
            if (err instanceof StudioError) throw new StudioError(err.status, `${err.message} Or take TikTok off the Monteur's platforms.`);
            throw err;
        });
        tiktokOptions = studioTikTokOptions(null, flags.audited, 'video');
    }
    // A DM campaign answers Instagram and Facebook comments only.
    const campaignPlan = meta && copy.keyword_create ? await planCampaign(creatorId, copy) : null;

    return withTransaction(async (client) => {
        const locked = await lockClip(client, creatorId, clip.id);
        if (locked.status !== 'review' || locked.render?.job_id !== render.job_id) {
            throw new StudioError(409, 'The reel changed while it was being approved. Reload it and try again.');
        }
        const groupId = crypto.randomUUID();
        const rows: ScheduledPostRow[] = [];
        let metaRow: ScheduledPostRow | null = null;
        let tiktokRow: ScheduledPostRow | null = null;
        if (meta) {
            metaRow = await insertVideoPost(client, {
                creatorId, platform: meta, caption: locked.copy.caption, mediaUrl: render.video_url, coverUrl: render.cover_url,
                when: when!, groupId, options: null,
            });
            rows.push(metaRow);
        }
        if (tiktokOptions) {
            tiktokRow = await insertVideoPost(client, {
                creatorId, platform: 'tiktok', caption: locked.copy.tiktok_caption, mediaUrl: render.video_url, coverUrl: null,
                when: when!, groupId, options: tiktokOptions,
            });
            rows.push(tiktokRow);
        }

        let campaign: ApproveOutcome['campaign'] = null;
        if (campaignPlan?.create) {
            // The insert POST /campaigns makes, with no public reply, every post, and its default mode.
            const { rows: created } = await client.query<CampaignRow>(
                `INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template, post_id, is_active, match_mode)
                 VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'substring')) RETURNING *`,
                [creatorId, campaignPlan.triggers, campaignPlan.dm, null, null, true, null]
            );
            campaign = { id: created[0]!.id, trigger_keyword: created[0]!.trigger_keyword, created: true };
        } else if (campaignPlan) {
            campaign = { id: campaignPlan.existing.id, trigger_keyword: campaignPlan.existing.trigger_keyword, created: false };
        }

        const schedule: ClipSchedule = {
            scheduled_time: when!.toISOString(),
            meta_row_id: metaRow?.id ?? null,
            tiktok_row_id: tiktokRow?.id ?? null,
            campaign_id: campaign?.id ?? null,
        };
        await client.query(
            `UPDATE clip_drafts SET status = 'scheduled', schedule = $3::jsonb, error = NULL, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2`,
            [clip.id, creatorId, JSON.stringify(schedule)]
        );
        return { clip: await loadClipView(client, creatorId, clip.id), scheduled_time: schedule.scheduled_time, rows, campaign };
    });
}

// ─── Reject ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /clips/:id/reject: out of the queue, its queued renders stopped and its files deleted —
 * nothing names a rejected clip's media. Rejecting twice is the same as once.
 */
export async function rejectClip(creatorId: string, clipId: string): Promise<ClipView> {
    return withTransaction(async (client) => {
        const clip = await lockClip(client, creatorId, clipId);
        if (clip.status === 'scheduled') {
            throw new StudioError(409, 'This reel is scheduled: delete its post in Posts instead.');
        }
        if (clip.status !== 'rejected') {
            await cancelClipRenders(client, creatorId, clip.id, 'The clip was rejected.');
            await client.query(
                `UPDATE clip_drafts SET status = 'rejected', updated_at = NOW() WHERE id = $1 AND creator_id = $2`,
                [clip.id, creatorId]
            );
            // After the status change, so the clip no longer counts as naming them.
            await deleteUnreferencedUploads(client, creatorId, [clip.render?.video_url, clip.render?.cover_url]);
            await markSourceDoneIfRendered(client, creatorId, clip.source_id);
        }
        return loadClipView(client, creatorId, clip.id);
    });
}
