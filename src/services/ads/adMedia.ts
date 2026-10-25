/**
 * Uploaded ad media, from our Storage to Meta and into a creative (A5; research R11).
 *
 *   1. The browser uploads the file straight to Supabase Storage through a signed URL (`adUploads.ts`), so Vercel's 4.5 MB body limit
 *      never applies: the file becomes a `media_uploads` row served at `/api/uploads/<id>`.
 *   2. `POST /api/ads/creatives/from-media` hands it to Meta: an image's bytes go to `adimages` (→ `image_hash`); a video is pulled by Meta
 *      itself from its public URL (`advideos` with `file_url` → a video id). What Meta answered is kept per tenant in `ads.media.<tenant>`.
 *   3. A draft names the upload by its media id; `resolveSpecMedia` turns that into the hash or video id `spec.ts` maps, checks a video is
 *      `ready` at Meta (1 point while it is still processing) and turns the chosen cover into its public URL.
 *
 * Not an `ads_ops` row: `adimages` answers `{ images }` and `advideos` a video id, not an object the queue can look for by its name tag, and
 * both are idempotent enough (the same bytes give the same hash; a second video upload is a harmless duplicate in the library). Both still go
 * through `ads/graph.ts`, so they are paced and a throttle is never retried.
 */
import { describeError, log } from '../../utils/log.js';
import { AdsError } from '../adBoosts.js';
import { getPublicBaseUrl, getSetting, setSetting, TENANT_SETTING_PREFIXES, tenantSettingKey } from '../appSettings.js';
import { getMediaStore } from '../storage.js';
import { CreativeError, readVideoStatus, uploadImage, uploadVideo, type CreativeDeps } from './creatives.js';
import { adsGraph, type AdsCallContext } from './graphPort.js';
import { assertOwnMedia } from './adUploads.js';
import type { CampaignSpec, SpecContext } from './spec.js';

export interface MediaRecord {
    kind: 'image' | 'video';
    imageHash?: string;
    videoId?: string;
    videoStatus?: 'ready' | 'processing' | 'error';
    videoError?: string;
    at: string;
}

const KEEP = 200;

export async function readMediaRecords(creatorId: string): Promise<Record<string, MediaRecord>> {
    const raw = await getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsMedia, creatorId));
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, MediaRecord> : {};
    } catch {
        return {};
    }
}

async function saveMediaRecord(creatorId: string, mediaId: string, record: MediaRecord): Promise<void> {
    const all = await readMediaRecords(creatorId);
    all[mediaId] = record;
    // The newest KEEP: an upload older than that is uploaded again if a draft ever names it.
    const kept = Object.entries(all).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, KEEP);
    await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsMedia, creatorId), JSON.stringify(Object.fromEntries(kept)), null);
}

async function depsFor(ctx: AdsCallContext): Promise<CreativeDeps> {
    const base = await getPublicBaseUrl(null);
    if (!base) throw new AdsError(409, 'INVALID', 'Set the public address of the app first: Meta fetches uploads from it.');
    return { graph: adsGraph(ctx), store: await getMediaStore(), publicBase: base };
}

function refusalOf(err: unknown): unknown {
    if (err instanceof CreativeError) return new AdsError(400, 'INVALID', err.message, err.field);
    return err;
}

/**
 * Hand one upload to Meta and remember the answer. A video's cover is checked to be the tenant's own image here, so a draft cannot fail on
 * it later. Answers what was stored, plus the cover's public URL.
 */
export async function prepareMedia(ctx: AdsCallContext, body: { mediaId?: unknown; kind?: unknown; coverMediaId?: unknown }): Promise<MediaRecord & { mediaId: string; coverUrl?: string }> {
    const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
    const kind = body.kind;
    if (kind !== 'image' && kind !== 'video') throw new AdsError(400, 'INVALID', 'kind is image or video.', 'kind');
    const own = await assertOwnMedia(ctx.tenantId, mediaId);
    if (!own.mime.startsWith(`${kind}/`)) throw new AdsError(400, 'INVALID', `That file is ${own.mime}, not an ${kind}.`, 'mediaId');
    let coverUrl: string | undefined;
    const deps = await depsFor(ctx);
    if (kind === 'video') {
        // CLAUDE.md: a video's thumbnail defaults to frame 0, which is black. A cover is required.
        if (typeof body.coverMediaId !== 'string' || !body.coverMediaId) throw new AdsError(400, 'INVALID', 'A video ad needs a cover image: its first frame is black.', 'coverMediaId');
        const cover = await assertOwnMedia(ctx.tenantId, body.coverMediaId);
        if (!cover.mime.startsWith('image/')) throw new AdsError(400, 'INVALID', 'The cover must be an image.', 'coverMediaId');
        coverUrl = deps.store.publicUrl(body.coverMediaId, deps.publicBase);
    }
    try {
        const record: MediaRecord = kind === 'image'
            ? { kind, imageHash: (await uploadImage(ctx, deps, mediaId)).hash, at: new Date().toISOString() }
            : { kind, videoId: (await uploadVideo(ctx, deps, mediaId)).videoId, videoStatus: 'processing', at: new Date().toISOString() };
        await saveMediaRecord(ctx.tenantId, mediaId, record);
        log('info', 'ads.media_prepared', { creator_id: ctx.tenantId, media_id: mediaId, kind });
        return { ...record, mediaId, ...(coverUrl ? { coverUrl } : {}) };
    } catch (err) {
        throw refusalOf(err);
    }
}

/** A video's state at Meta, read live only while it is not `ready` (1 point), and stored. */
export async function videoState(ctx: AdsCallContext, mediaId: string, record: MediaRecord): Promise<MediaRecord> {
    if (record.kind !== 'video' || !record.videoId || record.videoStatus === 'ready') return record;
    try {
        const status = await readVideoStatus(ctx, await depsFor(ctx), record.videoId);
        const next: MediaRecord = { ...record, videoStatus: status.state, ...(status.error ? { videoError: status.error } : {}) };
        if (next.videoStatus !== record.videoStatus) await saveMediaRecord(ctx.tenantId, mediaId, next);
        return next;
    } catch (err) {
        log('warn', 'ads.video_status_unreadable', { creator_id: ctx.tenantId, media_id: mediaId, ...describeError(err) });
        return record;
    }
}

/**
 * The `media` part of the SpecContext for every uploaded creative of a spec: the hash or the video id Meta gave, and the cover's public URL.
 * Refuses (400, with the field) an upload that was never handed to Meta, a video Meta is still processing or could not process.
 */
export async function resolveSpecMedia(ctx: AdsCallContext, spec: CampaignSpec): Promise<NonNullable<SpecContext['media']>> {
    const out: NonNullable<SpecContext['media']> = {};
    const ads = spec.ads.map((ad, i) => ({ ad, i })).filter(({ ad }) => ad.creative.source === 'media');
    if (ads.length === 0) return out;
    const records = await readMediaRecords(ctx.tenantId);
    const base = await getPublicBaseUrl(null);
    const store = await getMediaStore();
    const coverUrlOf = (id: string | undefined): string | undefined => (id && base ? store.publicUrl(id, base) : undefined);
    for (const { ad, i } of ads) {
        const c = ad.creative as Extract<CampaignSpec['ads'][number]['creative'], { source: 'media' }>;
        const pairs: Array<[string, string | undefined, string]> = [[c.mediaId, c.coverMediaId, `ads.${i}.creative.mediaId`]];
        if (c.verticalMediaId) pairs.push([c.verticalMediaId, c.verticalCoverMediaId ?? c.coverMediaId, `ads.${i}.creative.verticalMediaId`]);
        for (const [mediaId, coverId, field] of pairs) {
            if (out[mediaId]) continue;
            const stored = records[mediaId];
            if (!stored) throw new AdsError(400, 'INVALID', 'This upload has not been sent to Meta yet: upload it again.', field);
            const record = await videoState(ctx, mediaId, stored);
            if (record.kind === 'video' && record.videoStatus === 'error') throw new AdsError(400, 'INVALID', `Meta could not process this video: ${record.videoError ?? 'unknown error'}.`, field);
            if (record.kind === 'video' && record.videoStatus !== 'ready') throw new AdsError(409, 'VIDEO_PROCESSING', 'Meta is still processing this video. Try again in a minute.', field);
            out[mediaId] = { kind: record.kind, imageHash: record.imageHash, videoId: record.videoId, coverUrl: record.kind === 'video' ? coverUrlOf(coverId) : undefined };
        }
    }
    return out;
}
