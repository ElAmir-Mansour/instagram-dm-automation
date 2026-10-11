/**
 * Mirror a Facebook video to Instagram (docs/agents/inbox/2026-10-11.md, proposal 2).
 *
 * A Facebook-only video that performed well becomes a NEW `scheduled_posts` row for Instagram:
 * `platform = 'instagram'`, `post_type = 'video'` (a reel — Instagram's REELS container, with
 * `share_to_feed` set at publish), the same media, the same cover, the same caption, and the
 * source's `group_id` so the two stay tied. It is a normal PENDING row at a time the operator
 * chose: nothing publishes here, the sweep does.
 *
 * Only a video WE published can be mirrored: its bytes must still be one of our own
 * `/api/uploads/<id>` files, because that is the URL Meta fetches. A Facebook video posted by
 * hand has no row, and a row whose upload was deleted has nothing to send — both say why.
 */
import crypto from 'crypto';
import { queryRows } from '../../db/query.js';
import type { ScheduledPostRow } from '../../db/rows.js';
import { log } from '../../utils/log.js';
import { type Exec, lockTenantPublishing, requireId, StudioError, withTransaction } from '../studio/common.js';
import { publishedPlatforms } from '../publishedIds.js';
import { getMediaStore, uploadIdFromUrl } from '../storage.js';

/** Why a Facebook video cannot be mirrored, as a code the dashboard has a sentence for. */
export type MirrorBlocker =
    | 'not_video'          // a photo, carousel or text post
    | 'not_published'      // not on Facebook yet, or failed
    | 'already_instagram'  // the row itself already targets Instagram ('both' or 'instagram')
    | 'has_instagram'      // a sibling Instagram row exists, pending, published or failed
    | 'no_media'           // not one of our uploads, or the upload is gone
    | 'no_cover';          // Instagram would pick frame 0 (CLAUDE.md)

export interface MirrorState {
    eligible: boolean;
    /** Null when eligible. */
    reason: MirrorBlocker | null;
    /** The scheduled_posts row the action runs on; null when the Facebook post has no row of ours. */
    scheduled_post_id: string | null;
}

type Source = Pick<ScheduledPostRow, 'platform' | 'post_type' | 'status' | 'media_url' | 'cover_url' | 'published_post_id'>;
type Sibling = Pick<ScheduledPostRow, 'platform'>;

/** First failing rule, or null. Pure: `mediaExists` is what the media store said about `media_url`. */
export function mirrorBlocker(source: Source, siblings: readonly Sibling[], mediaExists: boolean): MirrorBlocker | null {
    if (source.post_type !== 'video') return 'not_video';
    if (source.platform === 'both' || source.platform === 'instagram') return 'already_instagram';
    if (source.platform !== 'facebook') return 'not_video';
    if (source.status !== 'PUBLISHED' || !publishedPlatforms(source.published_post_id).fb) return 'not_published';
    if (siblings.some((s) => s.platform === 'instagram' || s.platform === 'both')) return 'has_instagram';
    if (!source.media_url || !mediaExists) return 'no_media';
    if (!source.cover_url) return 'no_cover';
    return null;
}

interface SourceRow extends Source { id: string; group_id: string | null; caption: string | null }

async function mediaExists(urls: readonly (string | null)[]): Promise<Map<string, boolean>> {
    const ids = new Map<string, string>();
    for (const url of urls) {
        const id = url ? uploadIdFromUrl(url) : null;
        if (url && id) ids.set(url, id);
    }
    const found = ids.size ? await (await getMediaStore()).mimeTypes([...new Set(ids.values())]) : new Map<string, string>();
    return new Map([...ids].map(([url, id]) => [url, found.has(id)]));
}

/**
 * The mirror state of each Facebook post that has a scheduled row, keyed by that row's id —
 * what the Growth table needs to show or hide the button. Two queries however many posts.
 */
export async function mirrorStates(creatorId: string, scheduledPostIds: readonly string[]): Promise<Map<string, MirrorState>> {
    const out = new Map<string, MirrorState>();
    if (!scheduledPostIds.length) return out;
    const sources = await queryRows<SourceRow>(
        `SELECT id, platform, post_type, status, media_url, cover_url, published_post_id, group_id, caption
           FROM scheduled_posts WHERE creator_id = $1 AND id = ANY($2::uuid[])`,
        [creatorId, [...scheduledPostIds]]
    );
    const groups = [...new Set(sources.map((s) => s.group_id).filter((g): g is string => !!g))];
    const siblings = groups.length
        ? await queryRows<{ group_id: string; id: string; platform: string }>(
            `SELECT group_id, id, platform FROM scheduled_posts WHERE creator_id = $1 AND group_id = ANY($2::uuid[])`,
            [creatorId, groups]
        )
        : [];
    const exists = await mediaExists(sources.map((s) => s.media_url));
    for (const s of sources) {
        const sibs = s.group_id ? siblings.filter((x) => x.group_id === s.group_id && x.id !== s.id) : [];
        const reason = mirrorBlocker(s, sibs, s.media_url ? exists.get(s.media_url) === true : false);
        out.set(s.id, { eligible: reason === null, reason, scheduled_post_id: s.id });
    }
    return out;
}

/** An hour out: time to read the confirmation and cancel, and past any in-flight sweep. */
export const DEFAULT_MIRROR_DELAY_MS = 60 * 60 * 1000;
/** A chosen time this far back is a mistake (a stale form), not a request to publish now. */
const PAST_TOLERANCE_MS = 60 * 1000;

/** The operator's `scheduled_time`, or `now + 1h`. Never in the past: that would publish on the next sweep. */
export function chooseMirrorTime(raw: unknown, now: Date = new Date()): Date {
    if (raw === undefined || raw === null || raw === '') return new Date(now.getTime() + DEFAULT_MIRROR_DELAY_MS);
    const when = new Date(typeof raw === 'string' || typeof raw === 'number' ? raw : NaN);
    if (Number.isNaN(when.getTime())) throw new StudioError(400, 'scheduled_time is not a valid date.');
    if (when.getTime() < now.getTime() - PAST_TOLERANCE_MS) throw new StudioError(400, 'scheduled_time is in the past.');
    return when;
}

const REFUSALS: Record<MirrorBlocker, [number, string]> = {
    not_video: [400, 'Only a Facebook video can be mirrored to Instagram.'],
    not_published: [409, 'This post is not published on Facebook yet.'],
    already_instagram: [409, 'This post already goes to Instagram.'],
    has_instagram: [409, 'This video already has an Instagram post — scheduled, published or failed.'],
    no_media: [409, 'The video file is no longer in the media library, so it cannot be sent to Instagram.'],
    no_cover: [409, 'This video has no cover image; Instagram would use a black first frame.'],
};

export async function mirrorToInstagram(
    creatorId: string, rawId: unknown, rawTime: unknown, now: Date = new Date()
): Promise<{ post: ScheduledPostRow; group_id: string }> {
    const id = requireId(rawId, 'post');
    const when = chooseMirrorTime(rawTime, now);
    return withTransaction(async (tx: Exec) => {
        // The tenant's publishing lock: two clicks at once must not both pass the duplicate check.
        await lockTenantPublishing(tx, creatorId);
        const { rows } = await tx.query<SourceRow>(
            `SELECT id, platform, post_type, status, media_url, cover_url, published_post_id, group_id, caption
               FROM scheduled_posts WHERE id = $1 AND creator_id = $2 FOR UPDATE`,
            [id, creatorId]
        );
        const source = rows[0];
        if (!source) throw new StudioError(404, 'No such post.');
        const { rows: sibs } = source.group_id
            ? await tx.query<Sibling>(
                'SELECT platform FROM scheduled_posts WHERE creator_id = $1 AND group_id = $2 AND id <> $3',
                [creatorId, source.group_id, source.id]
            )
            : { rows: [] as Sibling[] };
        const exists = source.media_url ? (await mediaExists([source.media_url])).get(source.media_url) === true : false;
        const blocker = mirrorBlocker(source, sibs, exists);
        if (blocker) throw new StudioError(...REFUSALS[blocker]);

        const groupId = source.group_id ?? crypto.randomUUID();
        if (!source.group_id) await tx.query('UPDATE scheduled_posts SET group_id = $1 WHERE id = $2', [groupId, source.id]);
        // The column list of POST /posts/scheduled's insert. The caption is carried unchanged, so
        // the comment-keyword ask stays; cover_url is carried so the grid tile is not frame 0.
        const inserted = await tx.query<ScheduledPostRow>(
            `INSERT INTO scheduled_posts
                 (creator_id, platform, post_type, caption, media_url, media_urls, scheduled_time, status, cover_url, group_id, platform_options, meta_options)
             VALUES ($1, 'instagram', 'video', $2, $3, NULL, $4, 'PENDING', $5, $6, NULL, NULL) RETURNING *`,
            [creatorId, source.caption, source.media_url, when, source.cover_url, groupId]
        );
        const post = inserted.rows[0];
        if (!post) throw new Error('scheduled_posts insert returned no row.');
        log('info', 'growth.mirror_to_instagram', { source_id: source.id, post_id: post.id, group_id: groupId, scheduled_time: when.toISOString() });
        return { post, group_id: groupId };
    });
}
