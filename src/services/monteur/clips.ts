/**
 * A reel in the review queue (MONTEUR.md §5, §6.1): edit it, approve it into the scheduler,
 * render a failed one again, or reject it.
 *
 *   rendering ─(worker)→ review ─approve→ scheduled ─(its posts deleted or failed)→ review
 *        ↑                 │ └─reject→ rejected
 *        ├── an edit of the title or keyword (both are burned into the video)
 *        └── POST /rerender, for a failed clip
 *
 * Approve is modelled on the Studio's `scheduleDraft` (src/services/studio/schedule.ts): the rows
 * it writes are the rows `POST /api/posts/scheduled` writes, and they publish through the same
 * sweep. One Meta row (`both`, `instagram` or `facebook`, per the tenant's platforms) with the
 * video, its cover and the caption; a TikTok sibling on the same `group_id` with its own cut, the
 * TikTok caption and the Studio's Direct Post options; and — whenever there is a Meta row — a
 * campaign for every post that answers the keyword, reused or created. The slot, the campaign and
 * the inserts all happen under one per-tenant lock, so two approvals at once can neither take the
 * same slot nor create the same campaign twice.
 */
import crypto from 'crypto';
import { pool } from '../../config/db.js';
import type {
    CampaignRow, ClipCopy, ClipDraftRow, ClipSchedule, MonteurSourceRow, ScheduledPostRow, TikTokPostOptions,
} from '../../db/rows.js';
import { normalizeArabic } from '../../utils/arabic.js';
import { log } from '../../utils/log.js';
import { getTikTokPostingFlags } from '../appSettings.js';
import type { YouTubePostOptions } from '../youtubePublish.js';
import { matchCampaign, triggerClashes } from '../matching.js';
import {
    type Exec, isPlainObject, lockTenantPublishing, problemsError, StudioError, unique, withTransaction,
} from '../studio/common.js';
import {
    cancelClipRenders, deleteUnreferencedUploads, enqueueMonteurRender, markSourceDoneIfRendered,
} from '../studio/jobs.js';
import { tiktokLine } from '../studio/prompts.js';
import { assertDirectPostReady, studioTikTokOptions } from '../studio/schedule.js';
import { getStudioSettings } from '../studio/settings.js';
import { nextFreeSlots } from '../studio/slots.js';
import { keywordLongEnough, MIN_KEYWORD_LETTERS } from './copy.js';
import { inFlightTriggers } from './keywords.js';
import { accentsFor, buildRenderPayload, clipAccent } from './render.js';
import { MAX_TITLE } from './transcript.js';
import { type ClipView, loadClipView, releaseOrphanedClips } from './view.js';

/** Instagram's caption limit; TikTok's is the same for a video's title. */
export const MAX_CAPTION = 2200;
const MAX_DM = 4000;
const MAX_ALT_TEXT = 1000;
const MAX_HASHTAGS = 30;
const MAX_VARIANTS = 10;
/** A variant shorter than this fires on too much, as a short keyword would (MONTEUR.md §6.1). */
export const MIN_VARIANT_LETTERS = 3;
/** How many upcoming free slots Approve looks through for a day this video has no reel on. */
const SLOT_LOOKAHEAD = 30;
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
                score::float8 AS score, topic, hook_type, scores, text, copy, edits, direction, render, schedule, error, created_at, updated_at
           FROM clip_drafts WHERE id = $1 AND creator_id = $2 FOR UPDATE`,
        [clipId, creatorId]
    );
    if (!rows[0]) throw new StudioError(404, 'No such clip.');
    return rows[0];
}

const letterCount = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;
const norm = (s: string): string => normalizeArabic(s.trim());

async function liveCampaigns(exec: Exec, creatorId: string): Promise<CampaignRow[]> {
    const { rows } = await exec.query<CampaignRow>('SELECT * FROM campaigns WHERE creator_id = $1 AND is_active = TRUE', [creatorId]);
    return rows;
}

/**
 * Every real collision the reel's triggers — its keyword and its variants — would have once its
 * campaign is created, each as a problem starting with its field. Two sources:
 *
 *   live campaigns    `triggerClashes`, judged by each side's match mode; skipped when a live
 *                     campaign already answers the keyword, since Approve then reuses it and
 *                     creates nothing
 *   reels in flight   they become word-mode campaigns, which collide only on the same word: a
 *                     keyword equal to another reel's keyword is shared (one campaign), but any
 *                     other equality — a variant equal to their keyword or variant, or our keyword
 *                     equal to their variant — makes two campaigns fire on one word
 */
export async function triggerProblems(
    exec: Exec, creatorId: string, clipId: string | null, copy: Pick<ClipCopy, 'keyword' | 'variants'>
): Promise<string[]> {
    const problems: string[] = [];
    const variants = copy.variants ?? [];
    const label = (t: string): string => (norm(t) === norm(copy.keyword) ? 'copy.keyword' : 'copy.variants');
    const live = await liveCampaigns(exec, creatorId);
    if (!matchCampaign(copy.keyword, '', live)) {
        for (const c of triggerClashes(unique([copy.keyword, ...variants]), 'word', live)) {
            problems.push(`${label(c.trigger)}: «${c.trigger}» would fire alongside the live keyword «${c.live}»`);
        }
    }
    const other = await inFlightTriggers(exec, creatorId, clipId);
    const theirVariants = new Set(other.variants.map(norm));
    const theirWords = new Set([...other.keywords, ...other.variants].map(norm));
    if (theirVariants.has(norm(copy.keyword))) {
        problems.push(`copy.keyword: «${copy.keyword}» is another reel's variant: both campaigns would answer it`);
    }
    for (const v of variants) {
        if (theirWords.has(norm(v))) problems.push(`copy.variants: «${v}» is another reel's keyword or variant: both campaigns would answer it`);
    }
    return problems;
}

// ─── PATCH ──────────────────────────────────────────────────────────────────────────────

export interface ClipPatch { title?: string; copy: Partial<ClipCopy> }

/**
 * `{ title?, copy?: Partial<ClipCopy> }`, each field checked. A key that is not a field is
 * refused. Every problem starts with its field's path.
 */
export function parseClipPatch(body: unknown): ClipPatch {
    if (!isPlainObject(body) || !('title' in body || 'copy' in body)) {
        throw new StudioError(400, 'Send the title or the copy to change.');
    }
    const problems: string[] = [];
    for (const key of Object.keys(body)) if (key !== 'title' && key !== 'copy') problems.push(`${key} cannot be changed here`);

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
                else if (!keywordLongEnough(k)) problems.push(`copy.keyword must have at least ${MIN_KEYWORD_LETTERS} letters: a shorter one fires on too many comments`);
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
                if (list.some((w) => !isOneWord(w))) problems.push(`copy.${key} must be single words of at most 30 characters`);
                else if (list.length > max) problems.push(`copy.${key} holds at most ${max}`);
                else if (key === 'variants' && list.some((w) => letterCount(w) < MIN_VARIANT_LETTERS)) {
                    problems.push(`copy.variants must each have at least ${MIN_VARIANT_LETTERS} letters: a shorter one fires on too many comments`);
                } else patch.copy[key] = list;
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

async function queueRender(exec: Exec, creatorId: string, clip: ClipDraftRow, title: string, keyword: string): Promise<void> {
    const settings = await getStudioSettings(creatorId, exec);
    const { rows } = await exec.query<Pick<MonteurSourceRow, 'id' | 'path' | 'words'>>(
        'SELECT id, path, words FROM monteur_sources WHERE id = $1 AND creator_id = $2', [clip.source_id, creatorId]
    );
    if (!rows[0]) throw new StudioError(409, 'This reel\'s video is gone, so it cannot be rendered again.');
    const accent = await clipAccent(exec, creatorId, clip.id) ?? (await accentsFor(exec, creatorId, settings, 1))[0]!;
    await enqueueMonteurRender(exec, creatorId, buildRenderPayload({
        clipId: clip.id, source: rows[0], start: clip.start_s, end: clip.end_s, title, keyword, accent, settings,
        // The Editor's edits are the clip's, written once at the pick: every render carries them.
        edits: Array.isArray(clip.edits) ? clip.edits : [],
        // So are its human touches; buildRenderPayload leaves them out while `monteur.human` is off.
        direction: clip.direction && typeof clip.direction === 'object' ? clip.direction : null,
    }));
}

/**
 * PATCH /clips/:id. A new title or keyword changes the burned-in video, so the clip is rendered
 * again; a caption-only change keeps the video.
 *
 * A new keyword — any change of spelling counts, since the video shows it as typed — must be one
 * word of 4+ letters, and new variants words of 3+; together they must not collide, for real,
 * with a live campaign or another reel in flight (`triggerProblems`). A new keyword carries the
 * caption's «keyword» with it unless a caption is sent too, drops the old keyword's variants, and
 * is marked for a campaign. A caption or keyword change must leave the caption asking for
 * «keyword», or every comment would arrive and none would be answered.
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
        const keywordChanged = patch.copy.keyword !== undefined && patch.copy.keyword !== before.keyword;
        if (keywordChanged) {
            if (patch.copy.caption === undefined) copy.caption = copy.caption.split(`«${before.keyword}»`).join(`«${copy.keyword}»`);
            if (patch.copy.variants === undefined) copy.variants = [];
            if (patch.copy.keyword_create === undefined) copy.keyword_create = true;
        }
        // A variant spelled like the keyword adds nothing.
        copy.variants = (copy.variants ?? []).filter((v) => norm(v) !== norm(copy.keyword));
        if (keywordChanged || patch.copy.variants !== undefined) {
            const clashes = await triggerProblems(client, creatorId, clip.id, copy);
            if (clashes.length) throw problemsError(clashes, 'this clip', 409);
        }

        const problems: string[] = [];
        if ((patch.copy.caption !== undefined || keywordChanged) && !copy.caption.includes(`«${copy.keyword}»`)) {
            problems.push(`copy.caption must keep the keyword ask with «${copy.keyword}»`);
        }
        if (patch.copy.tiktok_caption !== undefined) {
            const link = tiktokLine(settings);
            if (link && !copy.tiktok_caption.includes(link)) problems.push(`copy.tiktok_caption must keep the line «${link}»`);
        }
        if (problems.length) throw problemsError(problems, 'this clip');

        const title = patch.title ?? clip.title;
        const rerender = title !== clip.title || keywordChanged;
        await client.query(
            // An edit answers an auto-approve refusal (a clip in review's `error`); a failed clip's
            // error is its render's, and stays until it renders.
            `UPDATE clip_drafts SET title = $3, copy = $4::jsonb, error = CASE WHEN status = 'review' THEN NULL ELSE error END, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2`,
            [clip.id, creatorId, title, JSON.stringify(copy)]
        );
        if (rerender) await queueRender(client, creatorId, clip, title, copy.keyword);
        log('info', 'monteur.clip_edited', { clip_id: clip.id, rerender, fields: [...Object.keys(patch.copy), ...(patch.title ? ['title'] : [])] });
        return loadClipView(client, creatorId, clip.id);
    });
}

/** POST /clips/:id/rerender: a failed clip, rendered again as it is. */
export async function rerenderClip(creatorId: string, clipId: string): Promise<ClipView> {
    return withTransaction(async (client) => {
        const clip = await lockClip(client, creatorId, clipId);
        if (clip.status !== 'failed') {
            throw new StudioError(409, `This reel is ${clip.status}; only a failed one is rendered again. Edit its title or keyword to change the video.`);
        }
        await queueRender(client, creatorId, clip, clip.title, clip.copy.keyword);
        return loadClipView(client, creatorId, clip.id);
    });
}

// ─── Approve ────────────────────────────────────────────────────────────────────────────

type CampaignPlan =
    | { create: true; triggers: string; dm: string }
    | { create: false; existing: CampaignRow };

/**
 * The campaign that will answer the reel's keyword. "Answers" is decided by `matchCampaign`
 * itself, with each campaign's own mode, and only a campaign for every post counts: one tied to
 * another post (`post_id`) never fires on this reel. When none answers, one is created, whatever
 * `keyword_create` says: asking for a keyword nothing answers is the silent failure this exists to
 * prevent. A keyword that sits inside a live keyword is refused: the longer word's comments would
 * then reach both campaigns.
 */
async function planCampaign(exec: Exec, creatorId: string, copy: ClipCopy): Promise<CampaignPlan> {
    const keyword = copy.keyword?.trim();
    if (!keyword) throw new StudioError(400, 'copy.keyword: this reel has no keyword to answer.');
    const active = await liveCampaigns(exec, creatorId);
    // '' as the post id: only campaigns for every post can answer a post that is not live yet.
    const existing = matchCampaign(keyword, '', active);
    if (existing) return { create: false, existing };
    // Every trigger the new word-mode campaign would carry, not just the keyword.
    const triggers = unique([keyword, ...(copy.variants ?? [])]);
    const clashes = triggerClashes(triggers, 'word', active);
    if (clashes.length) {
        throw problemsError(clashes.map((c) => `${norm(c.trigger) === norm(keyword) ? 'copy.keyword' : 'copy.variants'}: «${c.trigger}» would fire alongside the live keyword «${c.live}»`), 'this reel\'s keywords', 409);
    }
    return { create: true, triggers: triggers.join(', '), dm: copy.dm };
}

/**
 * A Short's description: the TikTok caption (hook, body, the "link in bio" line, hashtags) and the
 * course link under it — shown in full on the watch page, where a link in a Short's own
 * description is not clickable but can be copied.
 */
export function youtubeDescription(tiktokCaption: string, url: string | null | undefined): string {
    const link = (url ?? '').trim();
    return link && !tiktokCaption.includes(link) ? `${tiktokCaption.trim()}\n\n🔗 ${link}` : tiktokCaption.trim();
}

/** Instagram and Facebook go out as one post: `both`, or the one of them that is on. */
export function metaPlatformFor(platforms: readonly string[]): 'both' | 'instagram' | 'facebook' | null {
    const ig = platforms.includes('instagram');
    const fb = platforms.includes('facebook');
    return ig && fb ? 'both' : ig ? 'instagram' : fb ? 'facebook' : null;
}

/** The local calendar day of an instant in `timeZone`, `YYYY-MM-DD`. */
export function localDay(instant: number, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

async function insertVideoPost(exec: Exec, row: {
    creatorId: string; platform: 'both' | 'instagram' | 'facebook' | 'tiktok' | 'youtube'; caption: string; mediaUrl: string;
    coverUrl: string | null; when: Date; groupId: string; options: TikTokPostOptions | YouTubePostOptions | null;
}): Promise<ScheduledPostRow> {
    // The column list and order of POST /posts/scheduled's insert, so the two cannot drift.
    const { rows } = await exec.query<ScheduledPostRow>(
        `INSERT INTO scheduled_posts
             (creator_id, platform, post_type, caption, media_url, media_urls, scheduled_time, status, cover_url, group_id, platform_options, meta_options)
         VALUES ($1, $2, 'video', $3, $4, NULL, $5, 'PENDING', $6, $7, $8::jsonb, NULL) RETURNING *`,
        [
            row.creatorId, row.platform, row.caption, row.mediaUrl, row.when,
            // A cover image is an Instagram/Facebook concept; TikTok and YouTube pick their own.
            row.platform === 'tiktok' || row.platform === 'youtube' ? null : row.coverUrl,
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
    /** The campaign that answers the reel's keyword: created now, or an active one reused. Null without a Meta post. */
    campaign: { id: string; keyword: string; trigger_keyword: string; created: boolean } | null;
}

/**
 * POST /clips/:id/approve `{ scheduled_time? }`: the given time, or the next free posting slot
 * on a day no other reel of the same video is scheduled for (§6.1: never two from one source on
 * one day).
 */
export async function approveClip(creatorId: string, clipId: string, body: unknown, now: number = Date.now()): Promise<ApproveOutcome> {
    const b = isPlainObject(body) ? body : {};
    let requested: Date | null = null;
    if (b.scheduled_time !== undefined && b.scheduled_time !== null) {
        requested = typeof b.scheduled_time === 'string' ? new Date(b.scheduled_time) : new Date(NaN);
        if (Number.isNaN(requested.getTime())) {
            throw new StudioError(400, 'scheduled_time must be a date and time, e.g. 2026-10-01T16:00:00Z.');
        }
    }

    await releaseOrphanedClips(pool, creatorId, clipId);
    const { rows: found } = await pool.query<Pick<ClipDraftRow, 'id' | 'status' | 'render'>>(
        'SELECT id, status, render FROM clip_drafts WHERE id = $1 AND creator_id = $2', [clipId, creatorId]
    );
    const clip = found[0];
    if (!clip) throw new StudioError(404, 'No such clip.');
    if (clip.status !== 'review' || !clip.render) {
        throw new StudioError(409, clip.status === 'scheduled'
            ? 'This reel is already scheduled.'
            : `This reel is ${clip.status}; only a reel in review can be approved.`);
    }

    const settings = await getStudioSettings(creatorId);
    const { platforms, post_at: slots } = settings.monteur;
    const timezone = settings.schedule.timezone;
    const meta = metaPlatformFor(platforms);
    let tiktokOptions: TikTokPostOptions | null = null;
    if (platforms.includes('tiktok')) {
        // Said at the click, as the Studio does, not at publish time in a card nobody reads. Until
        // TikTok audits the app the post goes out private ("Only me"), as the owner chose.
        const flags = await getTikTokPostingFlags();
        await assertDirectPostReady(creatorId, flags).catch((err: unknown) => {
            if (err instanceof StudioError) throw new StudioError(err.status, `${err.message} Or take TikTok off the Monteur's platforms.`);
            throw err;
        });
        tiktokOptions = studioTikTokOptions(null, flags.audited, 'video');
    }

    return withTransaction(async (client) => {
        // One publishing write at a time per tenant — this approve, another, or the Studio's
        // schedule: the slot, the campaign and the rows are chosen and written under this lock,
        // so the next one sees them.
        await lockTenantPublishing(client, creatorId);
        const locked = await lockClip(client, creatorId, clip.id);
        if (locked.status !== 'review' || locked.render?.job_id !== clip.render!.job_id) {
            throw new StudioError(409, 'The reel changed while it was being approved. Reload it and try again.');
        }
        const render = locked.render!;
        const copy = locked.copy;

        const { rows: siblings } = await client.query<{ t: string | null }>(
            `SELECT schedule->>'scheduled_time' AS t FROM clip_drafts
              WHERE creator_id = $1 AND source_id = $2 AND status = 'scheduled' AND id <> $3`,
            [creatorId, locked.source_id, locked.id]
        );
        const taken = new Set(siblings.flatMap((r) => (r.t ? [localDay(Date.parse(r.t), timezone)] : [])));
        let when: Date;
        if (requested) {
            if (taken.has(localDay(requested.getTime(), timezone))) {
                throw new StudioError(409, `scheduled_time: another reel from this video is already on ${localDay(requested.getTime(), timezone)}. Choose another day.`);
            }
            when = requested;
        } else {
            const free = await nextFreeSlots(creatorId, { timezone, slots }, SLOT_LOOKAHEAD, now, { exec: client });
            const slot = free.find((s) => !taken.has(localDay(Date.parse(s), timezone)));
            if (!slot) throw new StudioError(409, 'There is no free posting slot on a day this video has no reel: choose a time.');
            when = new Date(slot);
        }
        // A DM campaign answers Instagram and Facebook comments only.
        const campaignPlan = meta ? await planCampaign(client, creatorId, copy) : null;

        const groupId = crypto.randomUUID();
        const rows: ScheduledPostRow[] = [];
        let metaRow: ScheduledPostRow | null = null;
        let tiktokRow: ScheduledPostRow | null = null;
        let youtubeRow: ScheduledPostRow | null = null;
        if (meta) {
            metaRow = await insertVideoPost(client, {
                creatorId, platform: meta, caption: copy.caption, mediaUrl: render.video_url, coverUrl: render.cover_url,
                when, groupId, options: null,
            });
            rows.push(metaRow);
        }
        if (tiktokOptions) {
            tiktokRow = await insertVideoPost(client, {
                creatorId, platform: 'tiktok', caption: copy.tiktok_caption,
                // TikTok's own cut, whose CTA says "link in bio" rather than "comment".
                mediaUrl: render.tiktok_video_url ?? render.video_url, coverUrl: null, when, groupId, options: tiktokOptions,
            });
            rows.push(tiktokRow);
        }
        if (platforms.includes('youtube')) {
            // Not checked against the connection here: a YouTube that is not connected must not keep
            // the reel off Instagram and Facebook. Its row fails at publish time, in Posts, saying so.
            youtubeRow = await insertVideoPost(client, {
                creatorId, platform: 'youtube', caption: youtubeDescription(copy.tiktok_caption, settings.product.url),
                // The "link in bio" cut, as TikTok's: YouTube cannot DM a commenter either.
                mediaUrl: render.tiktok_video_url ?? render.video_url, coverUrl: null, when, groupId,
                options: { title: locked.title, ...(settings.voice.language ? { language: settings.voice.language } : {}) },
            });
            rows.push(youtubeRow);
        }

        let campaign: ApproveOutcome['campaign'] = null;
        if (campaignPlan?.create) {
            // The insert POST /campaigns makes, with no public reply and every post — in word mode
            // (§6.1), so the keyword never fires inside a longer word.
            const { rows: created } = await client.query<CampaignRow>(
                `INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template, post_id, is_active, match_mode)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [creatorId, campaignPlan.triggers, campaignPlan.dm, null, null, true, 'word']
            );
            campaign = { id: created[0]!.id, keyword: copy.keyword, trigger_keyword: created[0]!.trigger_keyword, created: true };
        } else if (campaignPlan) {
            campaign = { id: campaignPlan.existing.id, keyword: copy.keyword, trigger_keyword: campaignPlan.existing.trigger_keyword, created: false };
        }

        const schedule: ClipSchedule = {
            scheduled_time: when.toISOString(),
            meta_row_id: metaRow?.id ?? null,
            tiktok_row_id: tiktokRow?.id ?? null,
            // Only when there is one, so a schedule without YouTube keeps the shape it always had.
            ...(youtubeRow ? { youtube_row_id: youtubeRow.id } : {}),
            campaign_id: campaign?.id ?? null,
            tiktok_privacy: tiktokOptions?.privacy_level ?? null,
        };
        await client.query(
            `UPDATE clip_drafts SET status = 'scheduled', schedule = $3::jsonb, error = NULL, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2`,
            [locked.id, creatorId, JSON.stringify(schedule)]
        );
        return { clip: await loadClipView(client, creatorId, locked.id), scheduled_time: schedule.scheduled_time, rows, campaign };
    });
}

// ─── Reject ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /clips/:id/reject: out of the queue — a failed clip too, which is how the page dismisses
 * one — its queued renders stopped and its files deleted: nothing names a rejected clip's media.
 * Rejecting twice is the same as once.
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
            await deleteUnreferencedUploads(client, creatorId, [clip.render?.video_url, clip.render?.tiktok_video_url, clip.render?.cover_url]);
            await markSourceDoneIfRendered(client, creatorId, clip.source_id);
        }
        return loadClipView(client, creatorId, clip.id);
    });
}
