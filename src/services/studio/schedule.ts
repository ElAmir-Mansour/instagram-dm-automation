/**
 * From a ready draft to scheduled posts (STUDIO.md §4 `/schedule`, `/tiktok/batch`).
 *
 * The rows written here are the same rows `POST /api/posts/scheduled` writes, and they publish
 * through the same sweep: a `both` + `carousel` row for Instagram and Facebook, and a separate
 * `tiktok` row for TikTok, tied by `group_id` (FLOWS.md §3.6). Nothing here publishes.
 *
 * TikTok goes out as Direct Post. Until TikTok audits the app, a direct post can only be
 * SELF_ONLY, so the Studio's usual path is to queue each draft's TikTok carousel, send the
 * queue as one batch, and make each post public by hand in the TikTok app — the
 * `tiktok_public_done` tick is the checklist for that last step.
 */
import crypto from 'crypto';
import { queryRows } from '../../db/query.js';
import type {
    CampaignRow, CarouselDraftRow, DraftSchedule, DraftTikTokIntent, MetaPostOptions, ScheduledPostRow, TikTokPostOptions,
} from '../../db/rows.js';
import { log } from '../../utils/log.js';
import { getTikTokPostingFlags, type TikTokPostingFlags } from '../appSettings.js';
import { matchCampaign } from '../matching.js';
import { validateMetaOptions } from '../metaOptions.js';
import { validatePostMedia } from '../postMedia.js';
import { getConnection } from '../tiktokConnections.js';
import { validateTikTokOptions } from '../tiktokPublish.js';
import type { Carousel } from './carouselTypes.js';
import { type Exec, isPlainObject, StudioError, unique, withTransaction } from './common.js';
import { presentDraft, type Draft } from './drafts.js';
import { altTextFor } from './generate.js';

/** Between the batch's rows. TikTok allows its photo init 6 calls a minute per token. */
export const BATCH_STAGGER_MS = 40_000;

export const TIKTOK_INTENTS: readonly DraftTikTokIntent[] = ['none', 'queue', 'scheduled'];

/**
 * The options every Studio TikTok carousel carries: direct, public once audited and private
 * until then, the carousel's own title, music, comments on, organic brand content. Consent is
 * the operator's click on schedule or batch. Run through `validateTikTokOptions`, so the same
 * rules as the composer's hold here.
 */
export function studioTikTokOptions(carousel: Carousel, audited: boolean): TikTokPostOptions {
    const checked = validateTikTokOptions({
        consent: true,
        privacy_level: audited ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY',
        title: carousel.captions?.tiktokTitle,
        auto_add_music: true,
        allow_comment: true,
        brand_organic: true,
    }, { audited, media: 'photo' });
    if (!checked.ok) throw new StudioError(400, checked.error);
    return checked.options;
}

/**
 * Said at the click, not at publish time in a card nobody is looking at: TikTok must be
 * connected, and able to Direct Post (the scope, and the operator's switch).
 */
async function assertDirectPostReady(creatorId: string, flags: TikTokPostingFlags): Promise<void> {
    const connection = await getConnection(creatorId);
    if (!connection || connection.status !== 'active') {
        throw new StudioError(409, 'TikTok is not connected. Connect it in Settings first.');
    }
    if (!(connection.scopes ?? []).includes('video.publish') || !flags.directPostEnabled) {
        throw new StudioError(409, 'Direct Post is not available: switch it on in Settings → TikTok app, then reconnect TikTok.');
    }
}

async function checkedMedia(platform: 'both' | 'tiktok', urls: unknown): Promise<{ mediaUrl: string; mediaUrls: string[] }> {
    const media = await validatePostMedia({ platform, postType: 'carousel', mediaUrl: null, mediaUrls: urls });
    if (!media.ok) throw new StudioError(400, media.error);
    return { mediaUrl: media.mediaUrl!, mediaUrls: media.mediaUrls! };
}

async function insertPost(exec: Exec, row: {
    creatorId: string; platform: 'both' | 'tiktok'; caption: string; mediaUrl: string; mediaUrls: string[];
    when: Date; groupId: string; options: TikTokPostOptions | null;
    /** Instagram's reach levers (v22), for the Meta row only. */
    metaOptions?: MetaPostOptions | null;
}): Promise<ScheduledPostRow> {
    // The column list and order of POST /posts/scheduled's insert, so the two cannot drift.
    const { rows } = await exec.query<ScheduledPostRow>(
        `INSERT INTO scheduled_posts
             (creator_id, platform, post_type, caption, media_url, media_urls, scheduled_time, status, cover_url, group_id, platform_options, meta_options)
         VALUES ($1, $2, 'carousel', $3, $4, $5::text[], $6, 'PENDING', NULL, $7, $8::jsonb, $9::jsonb) RETURNING *`,
        [
            row.creatorId, row.platform, row.caption, row.mediaUrl, row.mediaUrls, row.when, row.groupId,
            row.options ? JSON.stringify(row.options) : null,
            row.platform !== 'tiktok' && row.metaOptions ? JSON.stringify(row.metaOptions) : null,
        ]
    );
    if (!rows[0]) throw new Error('scheduled_posts insert returned no row.');
    return rows[0];
}

type CampaignPlan =
    | { create: true; triggers: string; dm: string }
    | { create: false; existing: CampaignRow };

/**
 * Create the keyword → DM campaign, unless an active campaign already triggers on the keyword.
 * "Triggers on" is decided by `matchCampaign` itself, with the campaign's own match mode — a
 * substring campaign on a shorter word answers this keyword too, and a second campaign beside
 * it would never be the one that fires.
 */
async function planCampaign(creatorId: string, draft: CarouselDraftRow): Promise<CampaignPlan> {
    const campaign = draft.campaign;
    const keyword = draft.carousel?.keyword?.trim();
    if (!campaign || !keyword) throw new StudioError(400, 'This draft has no campaign to create.');
    const active = await queryRows<CampaignRow>(
        'SELECT * FROM campaigns WHERE creator_id = $1 AND is_active = TRUE', [creatorId]
    );
    // '' as the post id: only campaigns for every post can answer a post that is not live yet.
    const existing = matchCampaign(keyword, '', active);
    if (existing) return { create: false, existing };
    return { create: true, triggers: unique([keyword, ...campaign.variants]).join(', '), dm: campaign.dm };
}

export interface ScheduleOutcome {
    draft: Draft;
    rows: ScheduledPostRow[];
    campaign: { id: string; trigger_keyword: string; created: boolean } | null;
}

/**
 * POST /drafts/:id/schedule. Everything is checked before the transaction; inside it the draft
 * is locked and re-checked, so two clicks schedule it once.
 */
export async function scheduleDraft(creatorId: string, draftId: string, body: unknown): Promise<ScheduleOutcome> {
    const b = isPlainObject(body) ? body : {};
    const when = typeof b.scheduled_time === 'string' ? new Date(b.scheduled_time) : new Date(NaN);
    if (Number.isNaN(when.getTime())) {
        throw new StudioError(400, 'scheduled_time must be a date and time, e.g. 2026-10-01T10:00:00Z.');
    }
    const tiktok = (b.tiktok ?? 'none') as DraftTikTokIntent;
    if (!TIKTOK_INTENTS.includes(tiktok)) throw new StudioError(400, `tiktok must be one of ${TIKTOK_INTENTS.join(', ')}.`);
    if (b.create_campaign !== undefined && typeof b.create_campaign !== 'boolean') {
        throw new StudioError(400, 'create_campaign must be true or false.');
    }

    const [draft] = await queryRows<CarouselDraftRow>(
        'SELECT * FROM carousel_drafts WHERE id = $1 AND creator_id = $2', [draftId, creatorId]
    );
    if (!draft) throw new StudioError(404, 'No such draft.');
    if (draft.status !== 'ready' || !draft.carousel || !draft.render) {
        throw new StudioError(409, draft.status === 'scheduled'
            ? 'This draft is already scheduled.'
            : 'This draft can be scheduled once its slides are rendered.');
    }
    const { carousel, render } = draft;

    const meta = await checkedMedia('both', render.ig);
    // Instagram's reach levers for the Meta row (GROWTH.md §4): an alt text per slide — the
    // schedule panel's when it sends its own, else the writer's, else the slide's own words — and
    // collaborators when chosen. Checked like the composer's: POST /posts/scheduled's rules.
    const metaOptions = validateMetaOptions({
        alt_texts: b.alt_texts !== undefined ? b.alt_texts : carousel.slides.slice(0, meta.mediaUrls.length).map(altTextFor),
        collaborators: b.collaborators,
    }, { platform: 'both', postType: 'carousel', slideCount: meta.mediaUrls.length });
    if (!metaOptions.ok) throw new StudioError(400, metaOptions.error);
    let tiktokMedia: { mediaUrl: string; mediaUrls: string[] } | null = null;
    let tiktokOptions: TikTokPostOptions | null = null;
    if (tiktok !== 'none') {
        // Checked for a queued one too, so a slide TikTok would refuse is found now, not at the batch.
        tiktokMedia = await checkedMedia('tiktok', render.tt);
    }
    if (tiktok === 'scheduled') {
        const flags = await getTikTokPostingFlags();
        if (!flags.audited) {
            throw new StudioError(409, 'TikTok has not audited this app yet, so its posts go out private: queue this one for the TikTok batch instead.');
        }
        await assertDirectPostReady(creatorId, flags);
        tiktokOptions = studioTikTokOptions(carousel, flags.audited);
    }
    const campaignPlan = b.create_campaign === true ? await planCampaign(creatorId, draft) : null;

    return withTransaction(async (client) => {
        const { rows: locked } = await client.query<Pick<CarouselDraftRow, 'status' | 'render'>>(
            'SELECT status, render FROM carousel_drafts WHERE id = $1 AND creator_id = $2 FOR UPDATE', [draft.id, creatorId]
        );
        if (locked[0]?.status !== 'ready' || locked[0]?.render?.job_id !== render.job_id) {
            throw new StudioError(409, 'The draft changed while it was being scheduled. Reload it and try again.');
        }

        const groupId = crypto.randomUUID();
        const rows = [await insertPost(client, {
            creatorId, platform: 'both', caption: carousel.captions.instagram,
            mediaUrl: meta.mediaUrl, mediaUrls: meta.mediaUrls, when, groupId, options: null,
            metaOptions: metaOptions.options,
        })];
        if (tiktok === 'scheduled' && tiktokMedia) {
            rows.push(await insertPost(client, {
                creatorId, platform: 'tiktok', caption: carousel.captions.tiktok,
                mediaUrl: tiktokMedia.mediaUrl, mediaUrls: tiktokMedia.mediaUrls, when, groupId, options: tiktokOptions,
            }));
        }

        let campaign: ScheduleOutcome['campaign'] = null;
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

        const schedule: DraftSchedule = {
            scheduled_time: when.toISOString(),
            meta_row_id: rows[0]!.id,
            tiktok,
            tiktok_row_id: rows[1]?.id ?? null,
            tiktok_public_done: false,
        };
        const { rows: saved } = await client.query<CarouselDraftRow>(
            `UPDATE carousel_drafts SET status = 'scheduled', schedule = $3::jsonb, error = NULL, updated_at = NOW()
              WHERE id = $1 AND creator_id = $2
          RETURNING *`,
            [draft.id, creatorId, JSON.stringify(schedule)]
        );
        return { draft: presentDraft(saved[0]!), rows, campaign };
    });
}

export interface BatchOutcome {
    queued: number;
    /** Drafts left in the queue, with the reason — one bad draft does not hold back the rest. */
    skipped: { draftId: string; error: string }[];
    rows: ScheduledPostRow[];
}

/**
 * POST /tiktok/batch: every queued TikTok carousel becomes a TikTok row due now, 40s apart.
 *
 * The queued drafts are locked FOR UPDATE, so a second click waits for the first and then finds
 * nothing left to queue, instead of queueing every post twice.
 */
export async function runTikTokBatch(creatorId: string, now: number = Date.now()): Promise<BatchOutcome> {
    const flags = await getTikTokPostingFlags();
    await assertDirectPostReady(creatorId, flags);

    return withTransaction(async (client) => {
        const { rows: drafts } = await client.query<CarouselDraftRow>(
            `SELECT * FROM carousel_drafts
              WHERE creator_id = $1 AND status = 'scheduled'
                AND schedule->>'tiktok' = 'queue' AND schedule->>'tiktok_row_id' IS NULL
              ORDER BY schedule->>'scheduled_time', created_at
                FOR UPDATE`,
            [creatorId]
        );
        const outcome: BatchOutcome = { queued: 0, skipped: [], rows: [] };
        for (const draft of drafts) {
            try {
                if (!draft.carousel || !draft.render) throw new StudioError(409, 'This draft has no rendered slides.');
                const media = await checkedMedia('tiktok', draft.render.tt);
                const options = studioTikTokOptions(draft.carousel, flags.audited);
                const { rows: meta } = await client.query<Pick<ScheduledPostRow, 'group_id'>>(
                    'SELECT group_id FROM scheduled_posts WHERE id = $1 AND creator_id = $2',
                    [draft.schedule?.meta_row_id ?? null, creatorId]
                );
                const row = await insertPost(client, {
                    creatorId, platform: 'tiktok', caption: draft.carousel.captions.tiktok,
                    mediaUrl: media.mediaUrl, mediaUrls: media.mediaUrls,
                    when: new Date(now + outcome.queued * BATCH_STAGGER_MS),
                    // The Meta sibling's group, so the two show as one post in Posts.
                    groupId: meta[0]?.group_id ?? crypto.randomUUID(),
                    options,
                });
                await client.query(
                    `UPDATE carousel_drafts
                        SET schedule = jsonb_set(schedule, '{tiktok_row_id}', to_jsonb($3::text)), updated_at = NOW()
                      WHERE id = $1 AND creator_id = $2`,
                    [draft.id, creatorId, row.id]
                );
                outcome.rows.push(row);
                outcome.queued += 1;
            } catch (err) {
                if (!(err instanceof StudioError)) throw err;
                outcome.skipped.push({ draftId: draft.id, error: err.message });
            }
        }
        log('info', 'studio.tiktok_batch', { queued: outcome.queued, skipped: outcome.skipped.length });
        return outcome;
    });
}

/** How many TikTok carousels are waiting for the batch — the status card's `tiktok.queued`. */
export async function queuedTikTokCount(creatorId: string): Promise<number> {
    const rows = await queryRows<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM carousel_drafts
          WHERE creator_id = $1 AND status = 'scheduled'
            AND schedule->>'tiktok' = 'queue' AND schedule->>'tiktok_row_id' IS NULL`,
        [creatorId]
    );
    return rows[0]?.n ?? 0;
}
