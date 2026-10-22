/**
 * Creatives for the ads builder (A5): the 9:16 placement version of an uploaded creative, the uploads themselves (`adimages`, `advideos`
 * with `file_url`), video status and the preview calls. The single image and video creatives, and the Advantage+ opt-outs, are spec.ts's.
 *
 * The builders are pure. The I/O functions take a `deps` object (the Graph port, the media store, the public origin) so nothing here
 * imports an HTTP client, a database or a setting: the callers wire the real ones, the tests wire stubs.
 */
import type { MediaStore } from '../storage.js';
import { actPath, type AdsCallContext, type AdsGraph } from './graphPort.js';

// ─── Errors ─────────────────────────────────────────────────────────────────────────────

/** A creative that cannot be built from what was chosen. `field` names the input to fix, `reason` is a stable code the screen words. */
export class CreativeError extends Error {
    readonly code = 'INVALID' as const;
    readonly field: string;
    readonly reason: string;

    constructor(field: string, reason: string, message?: string) {
        super(message ?? `Creative is invalid: ${field} (${reason}).`);
        this.name = 'CreativeError';
        this.field = field;
        this.reason = reason;
    }
}

// ─── The builders ───────────────────────────────────────────────────────────────────────

/** The words of an ad. `cta` is a Meta call-to-action type: LEARN_MORE, SIGN_UP, … */
export interface CreativeCopy {
    primaryText: string;
    headline?: string | undefined;
    cta: string;
}

function requireCover(coverUrl: string | undefined | null): string {
    // CLAUDE.md: a video's thumbnail defaults to frame 0, which is black, so a cover is always required.
    if (!coverUrl || !coverUrl.trim()) {
        throw new CreativeError('coverMediaId', 'cover_required', 'A video ad needs a cover image: its first frame is black.');
    }
    return coverUrl;
}

/**
 * Whether Meta accepts a `reels` / `facebook_reels` position in an asset customisation rule. Its documentation lists no such position,
 * so until a live check proves it this is false and only Stories gets the 9:16 version (research R11). Flip it once the check passes.
 */
export const REELS_CUSTOMISATION_LIVE_CHECKED = false;

/** Instagram positions that get the 9:16 version. */
export const VERTICAL_IG_POSITIONS: readonly string[] = REELS_CUSTOMISATION_LIVE_CHECKED ? ['story', 'reels'] : ['story'];
/** Facebook positions that get the 9:16 version. */
export const VERTICAL_FB_POSITIONS: readonly string[] = REELS_CUSTOMISATION_LIVE_CHECKED ? ['story', 'facebook_reels'] : ['story'];

/** One of the two assets of a placement creative: a hash (image) or a video id with its cover (video). */
export interface PlacementAsset {
    imageHash?: string | undefined;
    videoId?: string | undefined;
    coverUrl?: string | undefined;
}

export interface PlacementCreativeInput {
    kind: 'image' | 'video';
    /** The 4:5 (or 1:1) version, for the feeds. */
    feed: PlacementAsset;
    /** The 9:16 version, for Stories. */
    vertical: PlacementAsset;
    copy: CreativeCopy;
    link: string;
    /** Where the media came from. Meta supports placement customisation only on media we upload. */
    source: 'upload' | 'post';
}

/**
 * The `asset_feed_spec` of a creative with a different picture or video per placement group: the feeds get `feed`, Stories get `vertical`
 * (research R11: `optimization_type: PLACEMENT`, labelled assets, two `asset_customization_rules`). spec.ts puts it beside an
 * `object_story_spec` of just the Page and the Instagram account, and adds the usual opt-outs.
 */
export function placementAssetFeed(input: PlacementCreativeInput): Record<string, any> {
    if (input.source === 'post') {
        throw new CreativeError('source', 'vertical_needs_upload', 'A 9:16 version needs uploaded media: Meta does not customise placements of an existing post.');
    }
    const isVideo = input.kind === 'video';
    const labelled = (asset: PlacementAsset, label: 'feed' | 'vertical'): Record<string, any> => {
        const adlabels = [{ name: label }];
        if (isVideo) {
            if (!asset.videoId) throw new CreativeError(label, 'video_missing', `The ${label} version needs a video.`);
            return { video_id: asset.videoId, thumbnail_url: requireCover(asset.coverUrl), adlabels };
        }
        if (!asset.imageHash) throw new CreativeError(label, 'image_missing', `The ${label} version needs an image.`);
        return { hash: asset.imageHash, adlabels };
    };
    const assets = [labelled(input.feed, 'feed'), labelled(input.vertical, 'vertical')];
    const rule = (label: 'feed' | 'vertical', priority: number, spec: Record<string, any>): Record<string, any> => ({
        customization_spec: spec,
        [isVideo ? 'video_label' : 'image_label']: { name: label },
        priority,
    });
    const assetFeedSpec: Record<string, any> = {
        [isVideo ? 'videos' : 'images']: assets,
        bodies: [{ text: input.copy.primaryText }],
        link_urls: [{ website_url: input.link }],
        call_to_action_types: [input.copy.cta],
        ad_formats: [isVideo ? 'SINGLE_VIDEO' : 'SINGLE_IMAGE'],
        optimization_type: 'PLACEMENT',
        asset_customization_rules: [
            rule('feed', 1, {
                publisher_platforms: ['facebook', 'instagram'],
                facebook_positions: ['feed', 'marketplace', 'search'],
                instagram_positions: ['stream', 'profile_feed', 'ig_search'],
            }),
            rule('vertical', 2, {
                publisher_platforms: ['facebook', 'instagram'],
                facebook_positions: [...VERTICAL_FB_POSITIONS],
                instagram_positions: [...VERTICAL_IG_POSITIONS],
            }),
        ],
    };
    if (input.copy.headline) assetFeedSpec['titles'] = [{ text: input.copy.headline }];
    return assetFeedSpec;
}

// ─── Previews: formats and the local mock ───────────────────────────────────────────────

export type PreviewPlacement = 'feed' | 'instagram_feed' | 'instagram_story' | 'instagram_reels' | 'facebook_reels';

/** The `ad_format` Meta's preview endpoint wants for each placement we preview. */
export const PREVIEW_FORMATS: Record<PreviewPlacement, string> = {
    feed: 'MOBILE_FEED_STANDARD',
    instagram_feed: 'INSTAGRAM_STANDARD',
    instagram_story: 'INSTAGRAM_STORY',
    instagram_reels: 'INSTAGRAM_REELS',
    facebook_reels: 'FACEBOOK_REELS_MOBILE',
};

/** The frame a placement is drawn in: feeds are 4:5, Stories and Reels are 9:16. */
export function previewFrame(placement: PreviewPlacement): '4:5' | '9:16' {
    return placement === 'feed' || placement === 'instagram_feed' ? '4:5' : '9:16';
}

/**
 * The primary text as a feed shows it: cut at `limit` characters, at a word boundary when there is one, and the caller adds "…more".
 * `truncated` says whether anything was cut.
 */
export function truncatePrimaryText(text: string, limit = 125): { text: string; truncated: boolean } {
    if (text.length <= limit) return { text, truncated: false };
    const cut = text.slice(0, limit);
    // A word boundary exists when the character after the cut is a space (the cut is whole words) or the cut itself holds a space.
    const wholeWords = /\s/.test(text.charAt(limit));
    const lastSpace = cut.search(/\s\S*$/);
    const kept = wholeWords ? cut : lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
    return { text: kept.trimEnd(), truncated: true };
}

// ─── I/O, through injected deps ─────────────────────────────────────────────────────────

export interface CreativeDeps {
    graph: AdsGraph;
    store: Pick<MediaStore, 'get' | 'publicUrl' | 'mimeTypes'>;
    /** The public origin Meta fetches uploads from (`getPublicBaseUrl`). */
    publicBase: string;
}

function accountPath(ctx: AdsCallContext): string {
    return actPath(ctx.adAccountId);
}

/** Reads an upload's bytes and sends them to the ad account's image library. Returns the `image_hash` the creative references. */
export async function uploadImage(ctx: AdsCallContext, deps: CreativeDeps, mediaId: string): Promise<{ hash: string }> {
    const media = await deps.store.get(mediaId);
    if (!media) throw new CreativeError('mediaId', 'media_missing', 'The uploaded file no longer exists.');
    if (!media.mimeType.toLowerCase().startsWith('image/')) {
        throw new CreativeError('mediaId', 'not_an_image', `The uploaded file is ${media.mimeType}, not an image.`);
    }
    const answer = await deps.graph.post(`${accountPath(ctx)}/adimages`, { bytes: media.data.toString('base64') }, 'upload ad image');
    const first = Object.values<any>(answer?.images ?? {})[0];
    const hash = first?.hash;
    if (typeof hash !== 'string' || !hash) throw new Error('Meta ads (upload ad image): Meta answered without an image hash.');
    return { hash };
}

/**
 * Has Meta pull a video from our public upload URL. The bytes are never read here: Meta fetches the file itself, so Vercel's 4.5 MB
 * body limit never applies. The video is not usable until `readVideoStatus` says it is ready.
 */
export async function uploadVideo(ctx: AdsCallContext, deps: CreativeDeps, mediaId: string): Promise<{ videoId: string }> {
    const mime = (await deps.store.mimeTypes([mediaId])).get(mediaId);
    if (!mime) throw new CreativeError('mediaId', 'media_missing', 'The uploaded file no longer exists.');
    if (!mime.toLowerCase().startsWith('video/')) throw new CreativeError('mediaId', 'not_a_video', `The uploaded file is ${mime}, not a video.`);
    const videoId = await deps.graph.create(
        `${accountPath(ctx)}/advideos`,
        { file_url: deps.store.publicUrl(mediaId, deps.publicBase), name: `AutoReply video ${mediaId}` },
        'upload ad video',
    );
    return { videoId };
}

export interface VideoStatus {
    state: 'ready' | 'processing' | 'error';
    error?: string;
}

/** Where a video Meta is pulling stands. Anything Meta words differently from ready / error is treated as still processing. */
export async function readVideoStatus(_ctx: AdsCallContext, deps: CreativeDeps, videoId: string): Promise<VideoStatus> {
    const answer = await deps.graph.get(videoId, { fields: 'status' }, 'read video status');
    const status = answer?.status;
    const value = typeof status?.video_status === 'string' ? status.video_status.toLowerCase() : '';
    if (value === 'ready') return { state: 'ready' };
    if (value === 'error') {
        const phase = status?.processing_phase;
        const message = phase?.error?.message ?? phase?.errors?.[0]?.message ?? status?.error?.message;
        return { state: 'error', error: typeof message === 'string' && message ? message : 'Meta could not process the video.' };
    }
    return { state: 'processing' };
}

export interface PreviewResult {
    placement: PreviewPlacement;
    frame: '4:5' | '9:16';
    /** Meta's iframe markup, or null when there is none: the dashboard then draws its own approximate preview. */
    html: string | null;
    reason?: 'no_preview_access' | 'meta_error';
}

/** Meta's "this token may not do this" answers: error 10 (permission denied) and 200 (permissions error). 190 is a dead token, not this. */
function isPermissionFailure(error: unknown): boolean {
    const code = (error as { metaCode?: unknown } | null)?.metaCode;
    if (code === 10 || code === 200) return true;
    if (code === 190) return false;
    const message = error instanceof Error ? error.message : '';
    return /permission/i.test(message) && !/code:\s*190\b/i.test(message);
}

/**
 * Meta's own render of the ad for each placement. Never throws: a token that may not preview (a system-user token cannot) gives
 * `no_preview_access`, anything else `meta_error`, both with `html: null`.
 */
export async function generatePreviews(
    ctx: AdsCallContext,
    graph: AdsGraph,
    creativeSpec: object,
    placements: readonly PreviewPlacement[],
): Promise<PreviewResult[]> {
    const creative = JSON.stringify(creativeSpec);
    const out: PreviewResult[] = [];
    for (const placement of placements) {
        const frame = previewFrame(placement);
        try {
            const answer = await graph.get(
                `${accountPath(ctx)}/generatepreviews`,
                { creative, ad_format: PREVIEW_FORMATS[placement] },
                'generate ad preview',
            );
            const body = answer?.data?.[0]?.body;
            out.push(typeof body === 'string' && body
                ? { placement, frame, html: body }
                : { placement, frame, html: null, reason: 'meta_error' });
        } catch (error) {
            out.push({ placement, frame, html: null, reason: isPermissionFailure(error) ? 'no_preview_access' : 'meta_error' });
        }
    }
    return out;
}
