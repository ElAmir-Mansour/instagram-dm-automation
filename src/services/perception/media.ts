/**
 * Getting the media of a word-less DM to the model (docs/specs/005-muse-sees T025, research R5): find the link in Meta's event, download the bytes,
 * and never keep them. Two halves, both without a database and without a log line (the caller logs the result, and a link is a signed URL, so it is
 * never logged: the host is).
 *
 *   mediaRefsOf(message)      what a messaging event holds to look at: `message.attachments[].payload` and `message.reply_to.story`, each with the
 *                             kind `webhook/attachments.ts` gives it, its link, and the caption and media id Meta sends with a shared post or reel.
 *   fetchMedia(link, opts)    the bytes behind a link, or why there are none. A RESULT, never a throw.
 *
 * ─── What the links are (production's own DMs, read 2026-10-30 from 400 stored inbound DMs, and a live test the same day) ───
 *   story mention            `lookaside.fbsbx.com`, `{ url }`. Dead (404) after the story's 24 hours.
 *   shared post              type `ig_post`, `lookaside.fbsbx.com`, `{ url, title, ig_post_media_id }`. The link serves the post's COVER IMAGE (`image/jpeg`),
 *                            not the video; `title` is its caption.
 *   shared reel              type `ig_reel` (Messenger's `reel` is the same), `{ url, title, reel_video_id }`. Its `url` is a WEB PAGE, `https://www.instagram.com/…`,
 *                            which answers `text/html` and never media: it is NOT downloaded (the ref's `url` is null, the address is kept as `pageUrl`), and its
 *                            host is not on the list. The video is the Graph API's: `GET /{reel_video_id}?fields=media_type,media_url` with the Page token says
 *                            `VIDEO`, its `owner`, and a `media_url` on `*.fna.fbcdn.net` that downloads as `video/mp4` (a step that comes later; `fetchMedia`
 *                            then downloads that `media_url`). The legacy `share` is accepted by its kind; it is not in the data.
 *   voice note               type `audio`, `lookaside.fbsbx.com`, `{ url }`. Served as `video/mp4`: AAC inside an MP4 container.
 *   photo                    type `image`, `lookaside.fbsbx.com` (Instagram) or `cdn.fbsbx.com` (Facebook, a signed link: 403 once it has expired), `{ url }`, `image/jpeg`.
 * So **the response decides what the bytes are, not the attachment's type** (`ig_post` is an image; a voice note is `video/mp4`): the kind of media is read
 * from the `Content-Type`, with one exception, a voice note, which stays audio whatever MP4 container it comes in. And a refused link (403, 404, 410) is
 * `expired_url`, a result like a missing link (`no_url`), because a story mention's link will not live to a retry.
 *
 * ─── What a download may do ───
 *   - HTTPS only, to `MEDIA_HOSTS` and nowhere else, with no credentials in the URL and no port. NO token goes with the request (these links are public to
 *     whoever holds them; the Page token is for the Graph API). A redirect is followed by hand, at most three times, and each hop must pass the same test.
 *   - Capped while it streams (`MEDIA_LIMITS`): a declared length over the cap is refused before a byte is read, and a body that outgrows it is cut off,
 *     so a link that lies about its size, or has none, cannot fill the function's memory. The cap is the kind's: image 8 MB, video 35 MB (base64 stays under
 *     the 50 MB inline limit), audio 10 MB.
 *   - 15 s for the connection and the headers, 30 s for the whole transfer. Both end the request itself, so a stalled socket frees the job.
 *   - Never written anywhere. The bytes live in this call's result and go to the model; `media_uploads` is not touched.
 */
import { kindOfAttachment } from '../../webhook/attachments.js';
import type { FetchLike } from '../llm/types.js';
import { oneLine } from './text.js';
import { isPerceivableKind, type FailReason, type PerceptionKind } from './types.js';

// ─── What may be fetched, and how much ───────────────────────────────────────────────────────────────────────────────────

/**
 * The hosts Meta serves a DM's media from, and the only ones this module will connect to. `*.` is any host under that domain (at least one label), never the
 * bare domain and never a lookalike (`evilfbcdn.net`, `fbcdn.net.example.com`). The first two are the hosts of the DM links read in production on 2026-10-30;
 * the last two are where a Graph API `media_url` for a reel's video points.
 */
export const MEDIA_HOSTS: readonly string[] = Object.freeze(['lookaside.fbsbx.com', 'cdn.fbsbx.com', '*.fbcdn.net', '*.cdninstagram.com']);

export type MediaKind = 'image' | 'video' | 'audio';

/** The most bytes of each kind, enforced while the body streams. */
export const MEDIA_LIMITS: Readonly<Record<MediaKind, number>> = Object.freeze({ image: 8 * 1024 * 1024, video: 35 * 1024 * 1024, audio: 10 * 1024 * 1024 });

/** How long the connection and the response headers may take, and the whole transfer. */
export const CONNECT_TIMEOUT_MS = 15_000;
export const TOTAL_TIMEOUT_MS = 30_000;

/** How many redirects are followed, each one re-checked. */
export const MAX_REDIRECTS = 3;

/** A caption, cut to this many characters: it is somebody's public post, shown to a model as context and never trusted. */
export const TITLE_MAX_CHARS = 600;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Does `host` (lower case) belong to `MEDIA_HOSTS`? */
export function isMediaHost(host: string): boolean {
    return MEDIA_HOSTS.some((pattern) =>
        pattern.startsWith('*.') ? host.length > pattern.length - 1 && host.endsWith(pattern.slice(1)) : host === pattern);
}

/** A link we may download: `https`, a host on the list, no user or password, no port. Anything else is null. */
export function parseMediaUrl(value: string): URL | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return isMediaHost(url.hostname.toLowerCase()) ? url : null;
}

// ─── What an event holds to look at ──────────────────────────────────────────────────────────────────────────────────────

export interface MediaRef {
    /** The word-less kind (`webhook/attachments.ts`): what the pipeline stores as the row's `message_type`. Only the kinds perception reads. */
    kind: PerceptionKind;
    /** Meta's own attachment type, lower case (`ig_post`, `story_mention`, `audio`, `image`…), or `reply_to_story` for the story a reply answers. */
    metaType: string;
    /**
     * The link to the media's bytes, as Meta sent it, or null when there is none to download: the event carried no link (a view-once has no payload), or it is a
     * shared reel (`kind: 'reel'`), whose `url` is a web page and is kept as `pageUrl`. Not yet checked: `fetchMedia` does that.
     */
    url: string | null;
    /**
     * A shared reel's `url`: its web page (`https://www.instagram.com/…`), which is HTML and never media. Never downloaded, and not for `fetchMedia`; kept because it
     * names the reel (the same address the owner's library holds). Null for every other kind.
     */
    pageUrl: string | null;
    /** A shared post's or reel's caption (`payload.title`), cleaned and cut: the owner's own, or another creator's. Null when there is none. */
    title: string | null;
    /** `payload.ig_post_media_id` of a shared post: the id the post has on Instagram, which says whose it is and lets it be read through the Graph API. */
    igPostMediaId: string | null;
    /**
     * `payload.reel_video_id` of a shared reel (`ig_reel`, Messenger's `reel`): the id to ask the Graph API for the reel with, `GET /{id}?fields=media_type,media_url`,
     * which names its owner and the `media_url` the video downloads from.
     */
    reelVideoId: string | null;
    /** `reply_to.story.id` of the story a reply answers. */
    storyId: string | null;
}

/** A string, trimmed, or null. */
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A Meta id as a string: letters, digits, `_` and `-` (it will be put in a Graph path), or a safe integer. Anything else is null. */
function metaId(v: unknown): string | null {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
    return typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null;
}

/** A caption made safe to carry: one line, with no control, invisible or direction-changing character in it (`oneLine`), cut to `TITLE_MAX_CHARS` whole characters. */
const caption = (v: unknown): string | null => oneLine(v, TITLE_MAX_CHARS) || null;

/**
 * Every thing in a messaging event's `message` that perception can look at, in the order `describeWordless` lists the kinds: the story a reply answers
 * first, then the attachments as they came. A sticker, a file, a view-once (type `ephemeral`, no payload) and whatever Meta adds next are not here. Pure.
 */
export function mediaRefsOf(message: unknown): MediaRef[] {
    if (!isObj(message)) return [];
    const refs: MediaRef[] = [];

    const story = isObj(message['reply_to']) ? message['reply_to']['story'] : undefined;
    if (isObj(story)) {
        refs.push({
            kind: 'story_reply', metaType: 'reply_to_story', url: text(story['url']), pageUrl: null, title: null, igPostMediaId: null, reelVideoId: null, storyId: metaId(story['id']),
        });
    }

    const attachments = message['attachments'];
    if (Array.isArray(attachments)) {
        for (const attachment of attachments) {
            const kind = kindOfAttachment(attachment);
            if (!isPerceivableKind(kind)) continue;
            const a = isObj(attachment) ? attachment : {};
            const payload = isObj(a['payload']) ? a['payload'] : {};
            // A shared reel's `url` is its web page, never media: it is kept, but not as a link to download.
            const link = text(payload['url']);
            refs.push({
                kind,
                metaType: typeof a['type'] === 'string' ? a['type'].toLowerCase() : '',
                url: kind === 'reel' ? null : link,
                pageUrl: kind === 'reel' ? link : null,
                title: caption(payload['title']),
                igPostMediaId: metaId(payload['ig_post_media_id']),
                reelVideoId: metaId(payload['reel_video_id']),
                storyId: null,
            });
        }
    }
    return refs;
}

// ─── The download ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the bytes are, from the response's `Content-Type`, or null when it is not media. The attachment's own type is NOT consulted, except for one case: a voice
 * note arrives as `video/mp4` (AAC in an MP4 container) and is still a voice note. Pure.
 */
export function mediaKindOf(contentType: string | null | undefined, from?: PerceptionKind): MediaKind | null {
    const mime = mimeOf(contentType);
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return from === 'audio' ? 'audio' : 'video';
    return null;
}

/** `image/jpeg; charset=…` as `image/jpeg`. */
const mimeOf = (contentType: string | null | undefined): string => (contentType ?? '').split(';')[0]!.trim().toLowerCase();

export interface DownloadedMedia {
    /** What the bytes are (`mediaKindOf`): the response decides, not the attachment. */
    mediaKind: MediaKind;
    /** The response's own `Content-Type`, without its parameters. */
    mime: string;
    bytes: Buffer;
    /** The host the bytes came from: for a log line, which never carries the link. */
    host: string;
    ms: number;
}

/** Why there is no media. `skipped`: there was nothing to ask for. `failed`: it was asked for and did not come. */
export type MediaResult =
    | { ok: true; media: DownloadedMedia }
    | { ok: false; status: 'skipped'; reason: 'no_url' }
    | { ok: false; status: 'failed'; reason: Extract<FailReason, 'too_large' | 'fetch_failed' | 'expired_url' | 'timeout'>; detail?: string };

export interface FetchMediaOptions {
    /** The word-less kind the link came from (`MediaRef.kind`): a voice note's `video/mp4` is audio. */
    kind?: PerceptionKind;
    fetchImpl?: FetchLike;
    /** Overrides of `MEDIA_LIMITS`, for a test that must not allocate 35 MB. */
    limits?: Partial<Record<MediaKind, number>>;
    connectMs?: number;
    totalMs?: number;
}

const REQUEST_HEADERS = {
    accept: 'image/*,video/*,audio/*;q=0.9,*/*;q=0.1',
    // The cap counts bytes the body really has, and a declared length means the same thing only when nothing is compressed.
    'accept-encoding': 'identity',
};

/** A refusal Meta's CDN gives for a link that has run out: signed links answer 403, a story that is over answers 404. */
const EXPIRED_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);

const skippedNoUrl = (): MediaResult => ({ ok: false, status: 'skipped', reason: 'no_url' });
const failed = (reason: Extract<MediaResult, { status: 'failed' }>['reason'], detail?: string): MediaResult => ({ ok: false, status: 'failed', reason, ...(detail ? { detail } : {}) });

/** What a transport error is, as a short code for a log: `ECONNRESET`, `ENOTFOUND`, `UND_ERR_SOCKET`… Never its message, which can carry the link. */
function errorCode(err: unknown): string {
    const e = err as { code?: unknown; cause?: { code?: unknown }; name?: unknown } | null;
    const code = e?.cause?.code ?? e?.code;
    if (typeof code === 'string') return code.slice(0, 40);
    return typeof e?.name === 'string' ? e.name.slice(0, 40) : 'error';
}

/** Let go of a response whose body is not wanted, so its socket is freed. */
async function discard(res: Response): Promise<void> {
    try {
        await res.body?.cancel();
    } catch {
        // already closed or errored: nothing to free
    }
}

/** The whole file's size when a 206 says it is the whole file (`bytes 0-N/N+1`), else null: a part of a file is not the file. */
function wholeSizeOf206(res: Response): number | null {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
    if (!m) return null;
    const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return start === 0 && end + 1 === total ? total : null;
}

/**
 * Download the media behind `link`. Never throws: every outcome is a `MediaResult`.
 *
 *   no link                     `skipped / no_url`
 *   not a link we may fetch     `failed / fetch_failed` (detail `blocked_url`, `blocked_redirect`, `too_many_redirects`): a web page such as a shared
 *                               reel's `www.instagram.com` address is one, and no request is made
 *   403, 404, 410               `failed / expired_url`
 *   any other status, a reset   `failed / fetch_failed` (detail `http_<status>` or the transport's error code)
 *   not an image, video or audio  `failed / fetch_failed` (detail `not_media`)
 *   over the kind's cap         `failed / too_large`
 *   connect > 15 s, total > 30 s  `failed / timeout`
 */
export async function fetchMedia(link: string | null | undefined, opts: FetchMediaOptions = {}): Promise<MediaResult> {
    if (typeof link !== 'string' || !link.trim()) return skippedNoUrl();
    const start = parseMediaUrl(link.trim());
    if (!start) return failed('fetch_failed', 'blocked_url');

    // Each cap by name, so an override that is `undefined` is the default and never "no cap".
    const limits: Record<MediaKind, number> = {
        image: opts.limits?.image ?? MEDIA_LIMITS.image,
        video: opts.limits?.video ?? MEDIA_LIMITS.video,
        audio: opts.limits?.audio ?? MEDIA_LIMITS.audio,
    };
    const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    const controller = new AbortController();
    const startedAt = Date.now();
    let timedOut = false;
    const expire = (): void => { timedOut = true; controller.abort(); };
    const totalTimer = setTimeout(expire, opts.totalMs ?? TOTAL_TIMEOUT_MS);
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const stopConnect = (): void => { if (connectTimer) clearTimeout(connectTimer); connectTimer = undefined; };

    try {
        let url = start;
        for (let hop = 0; ; hop++) {
            // Connection, TLS and the response headers: 15 s each hop. The body has the rest of the 30 s.
            stopConnect();
            connectTimer = setTimeout(expire, opts.connectMs ?? CONNECT_TIMEOUT_MS);
            const res = await doFetch(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: REQUEST_HEADERS });
            stopConnect();

            if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
                await discard(res);
                if (hop >= MAX_REDIRECTS) return failed('fetch_failed', 'too_many_redirects');
                let next: URL | null = null;
                try {
                    next = parseMediaUrl(new URL(res.headers.get('location')!, url).href);
                } catch {
                    next = null;
                }
                if (!next) return failed('fetch_failed', 'blocked_redirect');
                url = next;
                continue;
            }

            if (EXPIRED_STATUSES.has(res.status)) {
                await discard(res);
                return failed('expired_url', `http_${res.status}`);
            }
            const whole = res.status === 206 ? wholeSizeOf206(res) : null;
            if (res.status !== 200 && whole === null) {
                await discard(res);
                return failed('fetch_failed', res.status === 206 ? 'partial_content' : `http_${res.status}`);
            }

            const mime = mimeOf(res.headers.get('content-type'));
            const mediaKind = mediaKindOf(mime, opts.kind);
            if (!mediaKind) {
                await discard(res);
                return failed('fetch_failed', 'not_media');
            }
            const cap = limits[mediaKind];
            const declared = whole ?? (res.headers.has('content-length') ? Number(res.headers.get('content-length')) : NaN);
            if (Number.isFinite(declared) && declared > cap) {
                await discard(res);
                return failed('too_large', mediaKind);
            }
            if (!res.body) return failed('fetch_failed', 'no_body');

            const bytes = await readCapped(res.body, cap, controller);
            if (bytes === 'too_large') return failed('too_large', mediaKind);
            if (bytes.length === 0) return failed('fetch_failed', 'empty');
            return { ok: true, media: { mediaKind, mime, bytes, host: url.hostname.toLowerCase(), ms: Date.now() - startedAt } };
        }
    } catch (err) {
        // The deadline firing aborts the request, which surfaces here as whatever the transport calls an abort: it is a timeout.
        return timedOut ? failed('timeout') : failed('fetch_failed', errorCode(err));
    } finally {
        clearTimeout(totalTimer);
        stopConnect();
    }
}

/**
 * The body as one buffer, counted as it arrives: the moment it passes `cap` the stream is cancelled and the request aborted, and nothing past the cap is
 * kept. A body that errors (the deadline firing, a reset) rejects, for `fetchMedia` to classify.
 */
async function readCapped(body: ReadableStream<Uint8Array>, cap: number, controller: AbortController): Promise<Buffer | 'too_large'> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > cap) {
                await reader.cancel().catch(() => undefined);
                controller.abort();
                return 'too_large';
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
}
