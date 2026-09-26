/**
 * What a scheduled post's media may be: how many images a carousel holds, and which of our own
 * uploads each platform will take.
 *
 * Checked when the post is created or edited, because every one of these rules is otherwise
 * discovered at publish time — Instagram answers a PNG child container with an opaque Graph
 * error, TikTok answers a PNG or an unverified host with a failed pull — in a card nobody is
 * looking at, often days after the person who could fix it scheduled the post.
 *
 * External URLs cannot be inspected, so they are allowed wherever the platform fetches them
 * itself. TikTok is the exception: PULL_FROM_URL only works from the URL prefix verified in
 * TikTok's portal, which is this deployment, so a TikTok photo has to be one of our uploads.
 */
import { getMediaStore, uploadIdFromUrl } from './storage.js';

/** Instagram's API takes 2–10 carousel children. Facebook takes more, but `both` must fit both. */
export const META_CAROUSEL_MIN = 2;
export const META_CAROUSEL_MAX = 10;
/** TikTok photo posts take up to 35 images. One image is its own post type, `image`. */
export const TIKTOK_CAROUSEL_MIN = 2;
export const TIKTOK_CAROUSEL_MAX = 35;

/** TikTok's photo formats. PNG is not one of them. */
export const TIKTOK_PHOTO_MIME_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/webp']);

/** `image` and `carousel` go to TikTok as a photo post; `video` is the only other TikTok type. */
export function isTikTokPhotoType(postType: unknown): boolean {
    return postType === 'image' || postType === 'carousel';
}

/** One URL, and — when it is one of ours — what the media store holds for it. */
export interface InspectedImage {
    url: string;
    /** Null for a URL on another site. */
    uploadId: string | null;
    /** Null when it is not ours, or it is ours and no longer exists. */
    mimeType: string | null;
}

/** Look every URL up in one query. */
export async function inspectImages(urls: readonly string[]): Promise<InspectedImage[]> {
    const ids = urls.map((url) => uploadIdFromUrl(url));
    const ours = [...new Set(ids.filter((id): id is string => id !== null))];
    const mimes = ours.length > 0 ? await (await getMediaStore()).mimeTypes(ours) : new Map<string, string>();
    return urls.map((url, i) => {
        const uploadId = ids[i] ?? null;
        return { url, uploadId, mimeType: uploadId ? mimes.get(uploadId) ?? null : null };
    });
}

/** "PNG" rather than "image/png" — the sentence is read by whoever uploaded the file. */
function formatName(mime: string): string {
    const names: Record<string, string> = {
        'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP', 'image/gif': 'GIF', 'image/heic': 'HEIC',
    };
    return names[mime] ?? (mime.split('/')[1]?.toUpperCase() || 'an unknown type');
}

export interface ImageRules {
    /** Several images. Decides the wording, and that a video is refused as a slide. */
    carousel: boolean;
    /** Instagram takes JPEG only. */
    instagram: boolean;
    /** TikTok pulls only our own uploads, and only JPEG or WebP. */
    tiktok: boolean;
}

/**
 * The first image that breaks a rule, as the sentence the dashboard shows — or null.
 * Pure, so every rule is testable without a media store.
 */
export function imageProblem(images: readonly InspectedImage[], rules: ImageRules): string | null {
    for (const [i, image] of images.entries()) {
        const name = images.length === 1 ? 'The image' : `Image ${i + 1}`;
        const lower = name.charAt(0).toLowerCase() + name.slice(1);
        if (!image.uploadId) {
            if (rules.tiktok) {
                return `TikTok can only take photos uploaded here — ${lower} is a link to another site. Upload the image instead.`;
            }
            continue;
        }
        const mime = image.mimeType;
        if (!mime) return `${name} can’t be found any more — upload it again.`;
        if (!mime.startsWith('image/')) {
            const video = mime.startsWith('video/');
            if (!rules.carousel) {
                return video ? 'That file is a video — schedule it as a video post instead.' : 'That file is not an image.';
            }
            return video
                ? `${name} is a video — carousels take images only for now.`
                : `${name} is not an image — carousels take images only.`;
        }
        if (rules.instagram && mime !== 'image/jpeg') {
            return `Instagram needs JPEG images — ${lower} is ${formatName(mime)}. Save it as a JPEG and upload it again.`;
        }
        if (rules.tiktok && !TIKTOK_PHOTO_MIME_TYPES.has(mime)) {
            return `TikTok photos must be JPEG or WebP — ${lower} is ${formatName(mime)}.`;
        }
    }
    return null;
}

function isHttpUrl(value: string): boolean {
    try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

/** A list of http(s) URLs, trimmed, in the order given. */
function readUrlList(raw: unknown): { ok: true; urls: string[] } | { ok: false; error: string } {
    if (!Array.isArray(raw)) return { ok: false, error: 'The images must be sent as a list, in slide order.' };
    const urls: string[] = [];
    for (const [i, entry] of raw.entries()) {
        const url = typeof entry === 'string' ? entry.trim() : '';
        if (!url || !isHttpUrl(url)) {
            return { ok: false, error: `Image ${i + 1} is not a web address — it must start with http:// or https://.` };
        }
        urls.push(url);
    }
    return { ok: true, urls };
}

/** Absent, null and `[]` all mean "no list was sent". */
function listSent(raw: unknown): boolean {
    return raw !== undefined && raw !== null && !(Array.isArray(raw) && raw.length === 0);
}

export type PostMediaCheck =
    | { ok: true; mediaUrl: string | null; mediaUrls: string[] | null }
    | { ok: false; error: string };

/**
 * The media columns to store for one row, or the reason the post cannot be scheduled.
 *
 * A carousel's list goes in `media_urls` and its first image in `media_url` as well, so that
 * every reader which only knows `media_url` keeps seeing the lead image. A single-photo TikTok
 * post keeps its one image in `media_url` alone. Every other post type passes through exactly
 * as before — `media_urls` is ignored for it rather than refused, so a composer that still
 * carries a list after switching type does not block the post.
 */
export async function validatePostMedia(input: {
    platform: unknown;
    postType: unknown;
    mediaUrl: unknown;
    mediaUrls: unknown;
}): Promise<PostMediaCheck> {
    const tiktok = input.platform === 'tiktok';
    const instagram = input.platform === 'instagram' || input.platform === 'both';

    if (input.postType === 'carousel') {
        const list = readUrlList(listSent(input.mediaUrls) ? input.mediaUrls : []);
        if (!list.ok) return list;
        const [min, max] = tiktok ? [TIKTOK_CAROUSEL_MIN, TIKTOK_CAROUSEL_MAX] : [META_CAROUSEL_MIN, META_CAROUSEL_MAX];
        const count = list.urls.length;
        if (count < min || count > max) {
            return {
                ok: false,
                error: tiktok
                    ? `A TikTok carousel takes ${min} to ${max} photos — this one has ${count}.`
                    : `A carousel takes ${min} to ${max} images — this one has ${count}.`,
            };
        }
        const problem = imageProblem(await inspectImages(list.urls), { carousel: true, instagram, tiktok });
        if (problem) return { ok: false, error: problem };
        return { ok: true, mediaUrl: list.urls[0]!, mediaUrls: list.urls };
    }

    if (tiktok && input.postType === 'image') {
        let urls: string[];
        if (listSent(input.mediaUrls)) {
            const list = readUrlList(input.mediaUrls);
            if (!list.ok) return list;
            if (list.urls.length !== 1) {
                return {
                    ok: false,
                    error: `A single-photo TikTok post takes one image — this one has ${list.urls.length}. Choose carousel for more.`,
                };
            }
            urls = list.urls;
        } else if (typeof input.mediaUrl === 'string' && input.mediaUrl.trim()) {
            const list = readUrlList([input.mediaUrl]);
            if (!list.ok) return { ok: false, error: 'The image is not a web address — it must start with http:// or https://.' };
            urls = list.urls;
        } else {
            return { ok: false, error: 'TikTok needs a photo — upload one first.' };
        }
        const problem = imageProblem(await inspectImages(urls), { carousel: false, instagram: false, tiktok: true });
        if (problem) return { ok: false, error: problem };
        return { ok: true, mediaUrl: urls[0]!, mediaUrls: null };
    }

    return { ok: true, mediaUrl: (input.mediaUrl || null) as string | null, mediaUrls: null };
}
