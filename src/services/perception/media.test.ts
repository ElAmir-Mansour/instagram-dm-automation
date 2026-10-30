/**
 * Getting the media of a word-less DM (`media.ts`): the links an event holds, and the download behind one. Nothing here reaches the network:
 * `fetchImpl` is a stand-in that hands back a `Response` built by hand, and the shapes of the events are the ones read in production on 2026-10-30.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, mock } from 'node:test';
import type { FetchLike } from '../llm/types.js';
import {
    CONNECT_TIMEOUT_MS, fetchMedia, isMediaHost, MAX_REDIRECTS, MEDIA_HOSTS, MEDIA_LIMITS, mediaKindOf, mediaRefsOf, parseMediaUrl, TITLE_MAX_CHARS,
    TOTAL_TIMEOUT_MS, type MediaRef, type MediaResult,
} from './media.js';

const GOOD = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=SECRETSIG123';
const MB = 1024 * 1024;

// ─── mediaRefsOf: what an event holds ────────────────────────────────────────────────────────────────────────────────────

describe('mediaRefsOf: the shapes production holds (read 2026-10-30, and a live test the same day)', () => {
    it('a story mention: kind story_mention, its link, nothing else', () => {
        const refs = mediaRefsOf({ mid: 'm1', attachments: [{ type: 'story_mention', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1' } }] });
        assert.deepEqual(refs, [{
            kind: 'story_mention', metaType: 'story_mention', url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1', pageUrl: null,
            title: null, igPostMediaId: null, reelVideoId: null, storyId: null,
        }]);
    });

    it('a shared post (ig_post): kind share, its link (the JPEG cover, downloadable), the caption as title, and the post\'s media id', () => {
        const refs = mediaRefsOf({
            attachments: [{ type: 'ig_post', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2', title: 'ريال واحد #reel', ig_post_media_id: '17900000000000001' } }],
        });
        assert.deepEqual(refs, [{
            kind: 'share', metaType: 'ig_post', url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2', pageUrl: null,
            title: 'ريال واحد #reel', igPostMediaId: '17900000000000001', reelVideoId: null, storyId: null,
        }]);
    });

    it('a shared reel (ig_reel, from the owner\'s own account): kind reel, its caption and reel_video_id, and NO link to download: its url is a web page', () => {
        const page = 'https://www.instagram.com/reel/DQ1abcdEFGh/?igsh=MWx4Y2dr';
        const refs = mediaRefsOf({ attachments: [{ type: 'ig_reel', payload: { url: page, title: 'ريال واحد', reel_video_id: '17900000000000009' } }] });
        assert.deepEqual(refs, [{
            kind: 'reel', metaType: 'ig_reel', url: null, pageUrl: page, title: 'ريال واحد', igPostMediaId: null, reelVideoId: '17900000000000009', storyId: null,
        }]);
    });

    it('so nothing is downloaded for a shared reel: no link, no request, and the web page is refused if it is offered anyway', async () => {
        const [reel] = mediaRefsOf({ attachments: [{ type: 'ig_reel', payload: { url: 'https://www.instagram.com/reel/DQ1abcdEFGh/', reel_video_id: '1790' } }] });
        let requests = 0;
        const fetchImpl: FetchLike = async () => { requests++; return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }); };
        assert.deepEqual(brief(await fetchMedia(reel!.url, { kind: reel!.kind, fetchImpl })), { ok: false, status: 'skipped', reason: 'no_url' });
        const page = await fetchMedia(reel!.pageUrl, { kind: reel!.kind, fetchImpl });
        assert.deepEqual(brief(page), { ok: false, status: 'failed', reason: 'fetch_failed', detail: 'blocked_url' });
        assert.equal(requests, 0);
    });

    it('a voice note: kind audio, its link', () => {
        const [ref] = mediaRefsOf({ attachments: [{ type: 'audio', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=3' } }] });
        assert.equal(ref!.kind, 'audio');
        assert.equal(ref!.metaType, 'audio');
        assert.equal(ref!.url, 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=3');
    });

    it('a Facebook photo: kind image, on cdn.fbsbx.com', () => {
        const [ref] = mediaRefsOf({ attachments: [{ type: 'image', payload: { url: 'https://cdn.fbsbx.com/v/t59.2708-21/abc.jpg?oh=1&oe=2' } }] });
        assert.equal(ref!.kind, 'image');
        assert.equal(ref!.url, 'https://cdn.fbsbx.com/v/t59.2708-21/abc.jpg?oh=1&oe=2');
    });
});

describe('mediaRefsOf: the kinds Meta documents that are not in the data yet', () => {
    it('ig_reel and reel keep their caption and reel_video_id, are the kind reel, and hand out no link to download: whatever the address is, it is the reel\'s page', () => {
        const refs = mediaRefsOf({
            attachments: [
                { type: 'ig_reel', payload: { url: 'https://www.instagram.com/reel/AAA/', title: 'A reel', reel_video_id: '123456' } },
                { type: 'reel', payload: { url: 'https://www.facebook.com/reel/654321', title: 'B reel', reel_video_id: '654321' } },
                { type: 'ig_reel', payload: { title: 'No address', reel_video_id: '777' } },
            ],
        });
        assert.deepEqual(refs.map((r) => [r.kind, r.metaType, r.url, r.pageUrl, r.title, r.reelVideoId, r.igPostMediaId]), [
            ['reel', 'ig_reel', null, 'https://www.instagram.com/reel/AAA/', 'A reel', '123456', null],
            ['reel', 'reel', null, 'https://www.facebook.com/reel/654321', 'B reel', '654321', null],
            ['reel', 'ig_reel', null, null, 'No address', '777', null],
        ]);
    });

    it('only a shared reel keeps its address as a page: every other kind\'s link is the media\'s own, and has no page', () => {
        const refs = mediaRefsOf({
            reply_to: { story: { url: 'https://lookaside.fbsbx.com/story', id: '1' } },
            attachments: [
                { type: 'ig_post', payload: { url: 'https://lookaside.fbsbx.com/p' } },
                { type: 'share', payload: { url: 'https://lookaside.fbsbx.com/s' } },
                { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/i' } },
                { type: 'audio', payload: { url: 'https://lookaside.fbsbx.com/a' } },
                { type: 'video', payload: { url: 'https://lookaside.fbsbx.com/v' } },
                { type: 'story_mention', payload: { url: 'https://lookaside.fbsbx.com/m' } },
            ],
        });
        assert.ok(refs.every((r) => r.url !== null && r.pageUrl === null), JSON.stringify(refs.map((r) => [r.kind, r.url, r.pageUrl])));
    });

    it('the legacy share, Messenger\'s post and a story are accepted by their kind', () => {
        const refs = mediaRefsOf({
            attachments: [
                { type: 'share', payload: { url: 'https://lookaside.fbsbx.com/s' } },
                { type: 'post', payload: { url: 'https://lookaside.fbsbx.com/p', title: 'P' } },
                { type: 'ig_story', payload: { url: 'https://lookaside.fbsbx.com/g' } },
                { type: 'video', payload: { url: 'https://lookaside.fbsbx.com/v' } },
            ],
        });
        assert.deepEqual(refs.map((r) => r.kind), ['share', 'share', 'story_share', 'video']);
    });

    it('the type is read in any case, and kept in lower case', () => {
        const [ref] = mediaRefsOf({ attachments: [{ type: 'IG_POST', payload: { url: 'https://lookaside.fbsbx.com/x' } }] });
        assert.equal(ref!.kind, 'share');
        assert.equal(ref!.metaType, 'ig_post');
    });
});

describe('mediaRefsOf: a reply to a story, and what it leaves out', () => {
    it('lists the story a reply answers first, with its link and id, then the attachments in order', () => {
        const refs = mediaRefsOf({
            reply_to: { story: { url: 'https://lookaside.fbsbx.com/story', id: '178000000000001' } },
            attachments: [{ type: 'image', payload: { url: 'https://lookaside.fbsbx.com/photo' } }],
        });
        assert.deepEqual(refs.map((r) => [r.kind, r.metaType, r.url, r.storyId]), [
            ['story_reply', 'reply_to_story', 'https://lookaside.fbsbx.com/story', '178000000000001'],
            ['image', 'image', 'https://lookaside.fbsbx.com/photo', null],
        ]);
    });

    it('a story reply whose story has no link is still a ref, with no url (the download answers no_url)', () => {
        assert.deepEqual(mediaRefsOf({ reply_to: { story: { id: '1' } } }).map((r) => [r.kind, r.url]), [['story_reply', null]]);
    });

    it('leaves out what perception does not read: stickers, files, a view-once with no payload, an unknown type', () => {
        const refs = mediaRefsOf({
            attachments: [
                { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/s', sticker_id: 369239263222822 } },
                { type: 'sticker', payload: { url: 'https://lookaside.fbsbx.com/t' } },
                { type: 'file', payload: { url: 'https://lookaside.fbsbx.com/f' } },
                { type: 'ephemeral' },
                { type: 'something_new', payload: { url: 'https://lookaside.fbsbx.com/n' } },
                { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/keep' } },
            ],
        });
        assert.deepEqual(refs.map((r) => r.url), ['https://lookaside.fbsbx.com/keep']);
    });

    it('is empty for a message that is not an object, has no attachments, or holds only junk', () => {
        for (const message of [null, undefined, 'text', 42, [], {}, { attachments: [] }, { attachments: 'x' }, { attachments: [null, 3, 'a', []] }, { reply_to: 'x' }, { reply_to: { story: 'x' } }]) {
            assert.deepEqual(mediaRefsOf(message), [], JSON.stringify(message));
        }
    });
});

describe('mediaRefsOf: what is taken from the payload, and cleaned', () => {
    const ref = (payload: unknown): MediaRef => mediaRefsOf({ attachments: [{ type: 'ig_post', payload }] })[0]!;

    it('a link that is missing, blank or not text is no link', () => {
        for (const url of [undefined, null, '', '   ', 5, {}, []]) assert.equal(ref({ url }).url, null, JSON.stringify(url));
        assert.equal(mediaRefsOf({ attachments: [{ type: 'image' }] })[0]!.url, null, 'no payload at all');
        assert.equal(mediaRefsOf({ attachments: [{ type: 'image', payload: 'x' }] })[0]!.url, null, 'a payload that is not an object');
    });

    it('trims the link and otherwise leaves it as Meta sent it', () => {
        assert.equal(ref({ url: '  https://lookaside.fbsbx.com/x?a=1&b=2  ' }).url, 'https://lookaside.fbsbx.com/x?a=1&b=2');
    });

    it('cleans a caption: control characters and line breaks become one space, and it is cut to whole characters with an ellipsis', () => {
        assert.equal(ref({ title: 'line one\nline\ttwo \u0000 three\u2028four' }).title, 'line one line two three four');
        assert.equal(ref({ title: '   ' }).title, null);
        assert.equal(ref({ title: 7 }).title, null);
        const long = ref({ title: 'x'.repeat(TITLE_MAX_CHARS + 50) }).title!;
        assert.equal(long.length, TITLE_MAX_CHARS);
        assert.ok(long.endsWith('…'));
        const emoji = ref({ title: '👨‍💻'.repeat(TITLE_MAX_CHARS) }).title!;
        assert.ok(!emoji.includes('�') && !/[\ud800-\udbff]$/.test(emoji.replace(/…$/, '')), 'no half of a character');
    });

    it('takes the direction-changing and invisible characters out of a caption too: it is somebody else\'s text, headed for a prompt', () => {
        const hostile = `a${String.fromCodePoint(0x202e)}b${String.fromCodePoint(0x200b)}c${String.fromCodePoint(...[...'hi'].map((c) => 0xe0000 + c.charCodeAt(0)))}d`;
        assert.equal(ref({ title: hostile }).title, 'abcd');
        assert.equal(ref({ title: String.fromCodePoint(0x202e, 0x200b) }).title, null, 'nothing visible left is no caption');
    });

    it('takes a media id as a string of letters, digits, _ and -, or a safe integer, and nothing else (it is going into a Graph path)', () => {
        assert.equal(ref({ ig_post_media_id: '17900000000000001' }).igPostMediaId, '17900000000000001');
        assert.equal(ref({ ig_post_media_id: 17900000000 }).igPostMediaId, '17900000000');
        for (const bad of ['../me', '12/34', 'a b', '', '1'.repeat(129), 1.5, -3, 17900000000000000000, null, {}, true]) {
            assert.equal(ref({ ig_post_media_id: bad }).igPostMediaId, null, JSON.stringify(bad));
        }
        assert.equal(ref({ reel_video_id: 'abc_DEF-12' }).reelVideoId, 'abc_DEF-12');
    });

    it('does not change the event it reads', () => {
        const message = { reply_to: { story: { url: 'https://lookaside.fbsbx.com/s', id: '1' } }, attachments: [{ type: 'ig_post', payload: { url: ' https://lookaside.fbsbx.com/x ', title: 'a\nb' } }] };
        const before = JSON.stringify(message);
        mediaRefsOf(message);
        assert.equal(JSON.stringify(message), before);
    });
});

// ─── The hosts ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the hosts a download may connect to', () => {
    it('are Meta\'s CDNs in ONE list: the two hosts the DM links came from, and the two domains a reel\'s media_url points under', () => {
        assert.deepEqual([...MEDIA_HOSTS], ['lookaside.fbsbx.com', 'cdn.fbsbx.com', '*.fbcdn.net', '*.cdninstagram.com']);
    });

    it('accept the exact hosts and any host under the two domains', () => {
        // `scontent-…fna.fbcdn.net` is where a Graph API `media_url` for a reel's mp4 points (read in a live test on 2026-10-30).
        for (const host of ['lookaside.fbsbx.com', 'cdn.fbsbx.com', 'scontent.xx.fbcdn.net', 'video-sjc3-1.xx.fbcdn.net', 'scontent-iad3-2.fna.fbcdn.net', 'a.fbcdn.net', 'scontent-sjc3-1.cdninstagram.com', 'x.cdninstagram.com']) {
            assert.equal(isMediaHost(host), true, host);
        }
    });

    it('refuse the bare domains, lookalikes, other Meta hosts, and anything that is not a name', () => {
        for (const host of [
            'fbcdn.net', 'cdninstagram.com', '.fbcdn.net', 'fbsbx.com', 'other.fbsbx.com', 'xlookaside.fbsbx.com', 'evilfbcdn.net', 'evil-cdninstagram.com',
            'fbcdn.net.evil.com', 'lookaside.fbsbx.com.evil.com', 'www.facebook.com', 'graph.facebook.com', 'instagram.com', 'www.instagram.com', 'lookaside.fbsbx.com.',
            '127.0.0.1', 'localhost', '[::1]', '',
        ]) {
            assert.equal(isMediaHost(host), false, JSON.stringify(host));
        }
    });
});

describe('parseMediaUrl', () => {
    it('accepts an https link to a listed host, in any case, with or without the default port', () => {
        for (const url of [GOOD, 'https://LOOKASIDE.FBSBX.COM/x', 'https://lookaside.fbsbx.com:443/x', 'https://scontent.xx.fbcdn.net/v/t.mp4?oh=1', 'https://cdn.fbsbx.com/x.jpg']) {
            assert.ok(parseMediaUrl(url), url);
        }
    });

    it('refuses http, credentials, another port, a host that is only after an @, a missing scheme, and what is not a URL', () => {
        for (const url of [
            'https://www.instagram.com/reel/DQ1abcdEFGh/', 'https://instagram.com/p/XYZ/', 'https://www.facebook.com/reel/654321',
            'http://lookaside.fbsbx.com/x', 'https://user:pw@lookaside.fbsbx.com/x', 'https://user@lookaside.fbsbx.com/x', 'https://lookaside.fbsbx.com:8443/x',
            'https://lookaside.fbsbx.com@evil.example/x', 'https://evil.example/https://lookaside.fbsbx.com/x', '//lookaside.fbsbx.com/x', 'lookaside.fbsbx.com/x',
            'ftp://lookaside.fbsbx.com/x', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'not a url', '', 'https://',
            // Cyrillic "а" in the name is another host (punycode), not ours.
            'https://lookаside.fbsbx.com/x',
        ]) {
            assert.equal(parseMediaUrl(url), null, url);
        }
    });
});

describe('mediaKindOf: the response decides what the bytes are', () => {
    it('reads image, video and audio from the Content-Type, with its parameters and in any case', () => {
        assert.equal(mediaKindOf('image/jpeg'), 'image');
        assert.equal(mediaKindOf('IMAGE/PNG; charset=binary'), 'image');
        assert.equal(mediaKindOf('image/webp'), 'image');
        assert.equal(mediaKindOf('video/mp4'), 'video');
        assert.equal(mediaKindOf('video/quicktime'), 'video');
        assert.equal(mediaKindOf('audio/mp4'), 'audio');
        assert.equal(mediaKindOf('audio/mpeg'), 'audio');
    });

    it('a shared post\'s link serves its cover image: ig_post is an image, whatever kind the attachment says', () => {
        assert.equal(mediaKindOf('image/jpeg', 'share'), 'image');
        assert.equal(mediaKindOf('image/jpeg', 'reel'), 'image');
        assert.equal(mediaKindOf('image/jpeg', 'audio'), 'image');
        assert.equal(mediaKindOf('video/mp4', 'share'), 'video');
        assert.equal(mediaKindOf('audio/mpeg', 'reel'), 'audio');
    });

    it('a voice note arrives as video/mp4 (AAC in an MP4 container) and stays audio; that is the only exception', () => {
        assert.equal(mediaKindOf('video/mp4', 'audio'), 'audio');
        assert.equal(mediaKindOf('video/mp4'), 'video');
        assert.equal(mediaKindOf('video/mp4', 'video'), 'video');
    });

    it('is null for what is not media: HTML, JSON, bytes of no type, a missing header', () => {
        for (const type of ['text/html', 'application/json', 'application/octet-stream', 'text/plain', 'binary/octet-stream', '', null, undefined]) {
            assert.equal(mediaKindOf(type), null, String(type));
        }
    });
});

// ─── fetchMedia: the stand-ins ───────────────────────────────────────────────────────────────────────────────────────────

interface Call { url: string; init: RequestInit }

/** A `fetchImpl` that answers each request with the next response (the last one repeats), and remembers what it was asked. */
function fetcher(...answers: (Response | ((c: Call) => Response | Promise<Response>))[]): { fetchImpl: FetchLike; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
        const call = { url, init };
        calls.push(call);
        // As fetch does: a request made with a signal that has already fired is refused at once.
        if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
        const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
        return typeof answer === 'function' ? answer(call) : answer;
    };
    return { fetchImpl, calls };
}

const reply = (body: Uint8Array | ReadableStream<Uint8Array> | string | null, headers: Record<string, string> = {}, status = 200): Response =>
    new Response(body as ConstructorParameters<typeof Response>[0], { status, headers });

const jpeg = (bytes = 100): Response => reply(new Uint8Array(bytes).fill(7), { 'content-type': 'image/jpeg' });

/** A stream whose reads are counted, and which says if it was cancelled. `highWaterMark: 0`: nothing is read ahead. */
function counted(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; state: { pulled: number; cancelled: boolean } } {
    const state = { pulled: 0, cancelled: false };
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            state.pulled++;
            if (i < chunks.length) controller.enqueue(chunks[i++]!);
            else controller.close();
        },
        cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 });
    return { stream, state };
}

/** A body that sends `first`, then waits, and errors the way a real one does when the request is aborted. */
function stalling(signal: AbortSignal, first?: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            if (first) controller.enqueue(first);
            signal.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')));
        },
    });
}

const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

/**
 * A result as a small object, for `deepEqual`: the bytes of a download are only counted. A test that compares a whole result and fails on a success would
 * otherwise print the buffer in its diff, and a diff of 35 MB takes minutes and gigabytes to build.
 */
const brief = (result: MediaResult): unknown =>
    result.ok ? { ok: true, mediaKind: result.media.mediaKind, mime: result.media.mime, size: result.media.bytes.length, host: result.media.host } : result;

const failureOf = (result: MediaResult): Extract<MediaResult, { ok: false }> => {
    assert.equal(result.ok, false, 'expected a failure');
    return result as Extract<MediaResult, { ok: false }>;
};

/** A download that was asked for and did not come (`failed`, which carries a detail), as opposed to one there was nothing to ask for (`skipped`). */
const failedOf = (result: MediaResult): Extract<MediaResult, { status: 'failed' }> => {
    const r = failureOf(result);
    assert.equal(r.status, 'failed', 'expected a download that failed');
    return r as Extract<MediaResult, { status: 'failed' }>;
};

describe('fetchMedia: what comes back', () => {
    it('a shared post\'s link is its cover image: an image, with its type, its bytes and the host it came from', async () => {
        const { fetchImpl } = fetcher(jpeg(100));
        const result = await fetchMedia(GOOD, { kind: 'share', fetchImpl });
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.media.mediaKind, 'image');
        assert.equal(result.media.mime, 'image/jpeg');
        assert.equal(result.media.bytes.length, 100);
        assert.ok(result.media.bytes.every((b) => b === 7));
        assert.equal(result.media.host, 'lookaside.fbsbx.com');
        assert.ok(Buffer.isBuffer(result.media.bytes));
        assert.ok(result.media.ms >= 0);
    });

    it('a voice note served as video/mp4 is audio when the attachment was a voice note, and a video when it was not', async () => {
        const mp4 = () => reply(new Uint8Array(50), { 'content-type': 'video/mp4' });
        const asAudio = await fetchMedia(GOOD, { kind: 'audio', fetchImpl: fetcher(mp4()).fetchImpl });
        assert.equal(asAudio.ok && asAudio.media.mediaKind, 'audio');
        assert.equal(asAudio.ok && asAudio.media.mime, 'video/mp4');
        const asVideo = await fetchMedia(GOOD, { kind: 'reel', fetchImpl: fetcher(mp4()).fetchImpl });
        assert.equal(asVideo.ok && asVideo.media.mediaKind, 'video');
    });

    it('keeps the Content-Type\'s own mime, without its parameters', async () => {
        const result = await fetchMedia(GOOD, { fetchImpl: fetcher(reply(new Uint8Array(4), { 'content-type': 'Image/PNG; charset=binary' })).fetchImpl });
        assert.equal(result.ok && result.media.mime, 'image/png');
    });

    it('reads a body that arrives in many pieces', async () => {
        const { stream } = counted([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])]);
        const result = await fetchMedia(GOOD, { fetchImpl: fetcher(reply(stream, { 'content-type': 'image/jpeg' })).fetchImpl });
        assert.deepEqual(result.ok && [...result.media.bytes], [1, 2, 3, 4, 5, 6]);
    });
});

describe('fetchMedia: what it sends, and to whom', () => {
    it('is one GET to the link, by hand on redirects, with no credential of any kind and no compression', async () => {
        const { fetchImpl, calls } = fetcher(jpeg());
        await fetchMedia(GOOD, { fetchImpl });
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, GOOD);
        assert.equal(calls[0]!.init.method, 'GET');
        assert.equal(calls[0]!.init.redirect, 'manual');
        assert.ok(calls[0]!.init.signal instanceof AbortSignal);
        const headers = Object.fromEntries(Object.entries(calls[0]!.init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
        assert.deepEqual(Object.keys(headers).sort(), ['accept', 'accept-encoding']);
        assert.equal(headers['accept-encoding'], 'identity');
        assert.equal(calls[0]!.init.credentials, undefined);
        assert.equal(calls[0]!.init.body, undefined);
    });

    it('trims the link it is given', async () => {
        const { fetchImpl, calls } = fetcher(jpeg());
        await fetchMedia(`  ${GOOD}  `, { fetchImpl });
        assert.equal(calls[0]!.url, GOOD);
    });

    it('never connects to a link that is not on the list, is not https, or carries a credential: no request is made', async () => {
        for (const link of [
            'http://lookaside.fbsbx.com/x', 'https://evil.example/x', 'https://www.instagram.com/reel/DQ1abcdEFGh/', 'https://user:pw@lookaside.fbsbx.com/x',
            'https://lookaside.fbsbx.com:8443/x', 'file:///etc/passwd', 'not a url',
        ]) {
            const { fetchImpl, calls } = fetcher(jpeg());
            const r = failedOf(await fetchMedia(link, { fetchImpl }));
            assert.deepEqual([r.status, r.reason, r.detail], ['failed', 'fetch_failed', 'blocked_url'], link);
            assert.equal(calls.length, 0, link);
        }
    });
});

describe('fetchMedia: no link, and a link that has run out', () => {
    it('no link is skipped / no_url, with no request: a view-once has no payload', async () => {
        for (const link of [null, undefined, '', '   ']) {
            const { fetchImpl, calls } = fetcher(jpeg());
            assert.deepEqual(brief(await fetchMedia(link, { fetchImpl })), { ok: false, status: 'skipped', reason: 'no_url' });
            assert.equal(calls.length, 0);
        }
    });

    it('403, 404 and 410 are expired_url, as results and not throws: a story\'s link is gone within a day, a signed one lapses', async () => {
        for (const status of [403, 404, 410]) {
            const r = await fetchMedia(GOOD, { fetchImpl: fetcher(reply('gone', { 'content-type': 'text/html' }, status)).fetchImpl });
            assert.deepEqual(brief(r), { ok: false, status: 'failed', reason: 'expired_url', detail: `http_${status}` }, String(status));
        }
    });

    it('any other answer is fetch_failed, with the status as the detail', async () => {
        for (const status of [400, 401, 429, 500, 502, 503, 204, 304]) {
            const r = failedOf(await fetchMedia(GOOD, { fetchImpl: fetcher(reply(null, {}, status)).fetchImpl }));
            assert.deepEqual([r.status, r.reason, r.detail], ['failed', 'fetch_failed', `http_${status}`], String(status));
        }
    });

    it('a 200 that is not media (a login page, JSON, no type) is fetch_failed / not_media', async () => {
        for (const type of ['text/html; charset=utf-8', 'application/json', 'application/octet-stream', undefined]) {
            const r = failedOf(await fetchMedia(GOOD, { fetchImpl: fetcher(reply(new Uint8Array(10), type ? { 'content-type': type } : {})).fetchImpl }));
            assert.deepEqual([r.reason, r.detail], ['fetch_failed', 'not_media'], String(type));
        }
    });

    it('an empty body is fetch_failed / empty, not an empty picture', async () => {
        const r = failedOf(await fetchMedia(GOOD, { fetchImpl: fetcher(reply(new Uint8Array(0), { 'content-type': 'image/jpeg' })).fetchImpl }));
        assert.deepEqual([r.reason, r.detail], ['fetch_failed', 'empty']);
    });
});

describe('fetchMedia: the caps are enforced while the body streams', () => {
    it('the caps are image 8 MB, video 35 MB, audio 10 MB', () => {
        assert.deepEqual({ ...MEDIA_LIMITS }, { image: 8 * MB, video: 35 * MB, audio: 10 * MB });
    });

    it('an override that is undefined is the default cap, never "no cap"', async () => {
        const chunk = new Uint8Array(MB);
        const over = counted([...Array.from({ length: 8 }, () => chunk), new Uint8Array(1)]);
        const r = await fetchMedia(GOOD, { limits: { image: undefined }, fetchImpl: fetcher(reply(over.stream, { 'content-type': 'image/jpeg' })).fetchImpl });
        assert.deepEqual(brief(r), { ok: false, status: 'failed', reason: 'too_large', detail: 'image' });
    });

    it('a declared length over the cap is refused before a byte is read, and the body is let go', async () => {
        const { stream, state } = counted([new Uint8Array(4)]);
        const r = await fetchMedia(GOOD, {
            limits: { image: 10 }, fetchImpl: fetcher(reply(stream, { 'content-type': 'image/jpeg', 'content-length': '11' })).fetchImpl,
        });
        assert.deepEqual(brief(r), { ok: false, status: 'failed', reason: 'too_large', detail: 'image' });
        assert.equal(state.pulled, 0, 'nothing was read');
        assert.equal(state.cancelled, true, 'and the stream was cancelled');
    });

    it('a body with no declared length that outgrows the cap is cut off, and nothing past the cap is kept', async () => {
        const { stream, state } = counted(Array.from({ length: 10 }, () => new Uint8Array(4)));
        const r = await fetchMedia(GOOD, { limits: { image: 10 }, fetchImpl: fetcher(reply(stream, { 'content-type': 'image/jpeg' })).fetchImpl });
        assert.deepEqual(brief(r), { ok: false, status: 'failed', reason: 'too_large', detail: 'image' });
        assert.equal(state.pulled, 3, 'three pieces of 4 bytes passed 10: the other seven were never asked for');
        assert.equal(state.cancelled, true);
    });

    it('a link that lies about its size is caught by the count: it said 5 bytes and sent 20', async () => {
        const { stream } = counted([new Uint8Array(10), new Uint8Array(10)]);
        const r = await fetchMedia(GOOD, { limits: { image: 10 }, fetchImpl: fetcher(reply(stream, { 'content-type': 'image/jpeg', 'content-length': '5' })).fetchImpl });
        assert.deepEqual(brief(r), { ok: false, status: 'failed', reason: 'too_large', detail: 'image' });
    });

    it('a body of exactly the cap is kept, and one byte more is not', async () => {
        const at = await fetchMedia(GOOD, { limits: { image: 10 }, fetchImpl: fetcher(reply(new Uint8Array(10), { 'content-type': 'image/jpeg' })).fetchImpl });
        assert.equal(at.ok && at.media.bytes.length, 10);
        const over = await fetchMedia(GOOD, { limits: { image: 10 }, fetchImpl: fetcher(reply(new Uint8Array(11), { 'content-type': 'image/jpeg' })).fetchImpl });
        assert.equal(failureOf(over).reason, 'too_large');
    });

    it('the cap is the one of what the bytes ARE: a link that says image but serves video is held to the video cap', async () => {
        const video = () => reply(new Uint8Array(30), { 'content-type': 'video/mp4' });
        const asImage = await fetchMedia(GOOD, { kind: 'share', limits: { image: 10, video: 50 }, fetchImpl: fetcher(video()).fetchImpl });
        assert.equal(asImage.ok && asImage.media.mediaKind, 'video');
        const small = await fetchMedia(GOOD, { kind: 'share', limits: { image: 100, video: 20 }, fetchImpl: fetcher(video()).fetchImpl });
        assert.deepEqual(brief(small), { ok: false, status: 'failed', reason: 'too_large', detail: 'video' });
    });

    it('a voice note is held to the audio cap, not the video cap its container would give it', async () => {
        const mp4 = () => reply(new Uint8Array(30), { 'content-type': 'video/mp4' });
        const r = await fetchMedia(GOOD, { kind: 'audio', limits: { audio: 20, video: 1000 }, fetchImpl: fetcher(mp4()).fetchImpl });
        assert.deepEqual(brief(r), { ok: false, status: 'failed', reason: 'too_large', detail: 'audio' });
    });

    it('holds an image to 8 MB by default: 8 MB is kept, one byte over is not', async () => {
        const chunk = new Uint8Array(MB);
        const ok = await fetchMedia(GOOD, { fetchImpl: fetcher(reply(counted(Array.from({ length: 8 }, () => chunk)).stream, { 'content-type': 'image/jpeg' })).fetchImpl });
        assert.equal(ok.ok && ok.media.bytes.length, 8 * MB);
        const over = counted([...Array.from({ length: 8 }, () => chunk), new Uint8Array(1)]);
        const refused = await fetchMedia(GOOD, { fetchImpl: fetcher(reply(over.stream, { 'content-type': 'image/jpeg' })).fetchImpl });
        assert.deepEqual(brief(refused), { ok: false, status: 'failed', reason: 'too_large', detail: 'image' });
    });

    it('holds a video to 35 MB by default and a voice note to 10 MB', async () => {
        const chunk = new Uint8Array(MB);
        const video = counted(Array.from({ length: 36 }, () => chunk));
        const tooBig = await fetchMedia(GOOD, { fetchImpl: fetcher(reply(video.stream, { 'content-type': 'video/mp4' })).fetchImpl });
        assert.deepEqual(brief(tooBig), { ok: false, status: 'failed', reason: 'too_large', detail: 'video' });
        assert.ok(video.state.pulled <= 36 && video.state.cancelled);
        const voice = counted(Array.from({ length: 11 }, () => chunk));
        const tooLong = await fetchMedia(GOOD, { kind: 'audio', fetchImpl: fetcher(reply(voice.stream, { 'content-type': 'video/mp4' })).fetchImpl });
        assert.deepEqual(brief(tooLong), { ok: false, status: 'failed', reason: 'too_large', detail: 'audio' });
    });
});

describe('fetchMedia: a partial answer is not the file', () => {
    it('accepts a 206 that says it is the whole file, and refuses one that is a part, or says nothing', async () => {
        const whole = reply(new Uint8Array(10), { 'content-type': 'image/jpeg', 'content-range': 'bytes 0-9/10' }, 206);
        const ok = await fetchMedia(GOOD, { fetchImpl: fetcher(whole).fetchImpl });
        assert.equal(ok.ok && ok.media.bytes.length, 10);
        for (const range of ['bytes 0-9/100', 'bytes 5-9/10', 'bytes 0-9/*', undefined]) {
            const part = reply(new Uint8Array(10), { 'content-type': 'image/jpeg', ...(range ? { 'content-range': range } : {}) }, 206);
            const r = failedOf(await fetchMedia(GOOD, { fetchImpl: fetcher(part).fetchImpl }));
            assert.deepEqual([r.reason, r.detail], ['fetch_failed', 'partial_content'], String(range));
        }
    });

    it('holds a 206\'s whole size to the cap before reading it', async () => {
        const whole = reply(new Uint8Array(10), { 'content-type': 'image/jpeg', 'content-range': 'bytes 0-99/100' }, 206);
        const r = await fetchMedia(GOOD, { limits: { image: 50 }, fetchImpl: fetcher(whole).fetchImpl });
        assert.deepEqual(brief(r), { ok: false, status: 'failed', reason: 'too_large', detail: 'image' });
    });
});

describe('fetchMedia: redirects are followed by hand, and every hop is checked', () => {
    const redirect = (to: string, status = 302): Response => reply(null, { location: to }, status);

    it('follows a redirect to another listed host, and the next request is to the new address', async () => {
        const { fetchImpl, calls } = fetcher(redirect('https://scontent.xx.fbcdn.net/v/t.jpg?oh=1'), jpeg(20));
        const r = await fetchMedia(GOOD, { fetchImpl });
        assert.equal(r.ok && r.media.host, 'scontent.xx.fbcdn.net');
        assert.deepEqual(calls.map((c) => c.url), [GOOD, 'https://scontent.xx.fbcdn.net/v/t.jpg?oh=1']);
    });

    it('resolves a relative Location against the current address', async () => {
        const { fetchImpl, calls } = fetcher(redirect('/other/path.jpg'), jpeg(20));
        await fetchMedia(GOOD, { fetchImpl });
        assert.equal(calls[1]!.url, 'https://lookaside.fbsbx.com/other/path.jpg');
    });

    it('refuses a redirect to a host that is not listed, to http, to a credential or to a port: the second request is never made', async () => {
        for (const to of ['https://evil.example/x', 'http://lookaside.fbsbx.com/x', 'https://user:pw@lookaside.fbsbx.com/x', 'https://lookaside.fbsbx.com:8443/x', 'ftp://lookaside.fbsbx.com/x', 'https://']) {
            const { fetchImpl, calls } = fetcher(redirect(to), jpeg());
            const r = failedOf(await fetchMedia(GOOD, { fetchImpl }));
            assert.deepEqual([r.reason, r.detail], ['fetch_failed', 'blocked_redirect'], to);
            assert.equal(calls.length, 1, to);
        }
    });

    it('follows at most three, and says so on the fourth', async () => {
        assert.equal(MAX_REDIRECTS, 3);
        const { fetchImpl, calls } = fetcher(redirect('/again'));
        const r = failedOf(await fetchMedia(GOOD, { fetchImpl }));
        assert.deepEqual([r.reason, r.detail], ['fetch_failed', 'too_many_redirects']);
        assert.equal(calls.length, 4, 'the first request and three redirects');
        const three = fetcher(redirect('/a'), redirect('/b'), redirect('/c'), jpeg(10));
        assert.equal((await fetchMedia(GOOD, { fetchImpl: three.fetchImpl })).ok, true, 'three redirects are followed');
    });

    it('a 3xx with no Location is not a redirect: it is fetch_failed with its status', async () => {
        const r = failedOf(await fetchMedia(GOOD, { fetchImpl: fetcher(reply(null, {}, 302)).fetchImpl }));
        assert.deepEqual([r.reason, r.detail], ['fetch_failed', 'http_302']);
    });

    it('an expired link behind a redirect is still expired_url', async () => {
        const { fetchImpl } = fetcher(redirect('https://cdn.fbsbx.com/signed'), reply(null, {}, 403));
        assert.deepEqual(brief(await fetchMedia(GOOD, { fetchImpl })), { ok: false, status: 'failed', reason: 'expired_url', detail: 'http_403' });
    });
});

describe('fetchMedia: time', () => {
    // The sequences run on mock timers, so nothing here depends on how busy the machine is: a deadline is crossed by `tick`, never by waiting.
    afterEach(() => mock.timers.reset());

    /** Lets every promise that can settle settle (`setImmediate` is not mocked). */
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const pending = (p: Promise<unknown>): { settled: () => boolean } => { let done = false; p.then(() => { done = true; }, () => { done = true; }); return { settled: () => done }; };
    const TIMEOUT: MediaResult = { ok: false, status: 'failed', reason: 'timeout' };

    /** A request that answers only when the test says so, and is ended by the signal as a real one is. */
    function gated(): { fetchImpl: FetchLike; answer: (response: Response) => void; signals: AbortSignal[] } {
        const resolvers: ((r: Response) => void)[] = [];
        const signals: AbortSignal[] = [];
        const fetchImpl: FetchLike = (_url, init) => new Promise((resolve, reject) => {
            const signal = init.signal as AbortSignal;
            signals.push(signal);
            resolvers.push(resolve);
            signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
        });
        return { fetchImpl, answer: (response) => resolvers.shift()!(response), signals };
    }

    it('the defaults are 15 s to connect and 30 s in all', () => {
        assert.equal(CONNECT_TIMEOUT_MS, 15_000);
        assert.equal(TOTAL_TIMEOUT_MS, 30_000);
    });

    it('a connection that does not answer is a timeout at 15 s, and the request is aborted', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { fetchImpl, signals } = gated();
        const p = fetchMedia(GOOD, { fetchImpl });
        const state = pending(p);
        await flush();
        mock.timers.tick(14_999);
        await flush();
        assert.equal(state.settled(), false, 'not yet: 14.999 s');
        assert.equal(signals[0]!.aborted, false);
        mock.timers.tick(1);
        assert.deepEqual(brief(await p), TIMEOUT);
        assert.equal(signals[0]!.aborted, true);
    });

    it('a body that stalls is cut off at 30 s in all, however well the headers came', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const fetchImpl: FetchLike = async (_url, init) => reply(stalling(init.signal as AbortSignal, new Uint8Array(3)), { 'content-type': 'image/jpeg' });
        const p = fetchMedia(GOOD, { fetchImpl });
        const state = pending(p);
        await flush();
        mock.timers.tick(29_999);
        await flush();
        assert.equal(state.settled(), false, 'not yet: 29.999 s');
        mock.timers.tick(1);
        assert.deepEqual(brief(await p), TIMEOUT);
    });

    it('the 15 s deadline stops once the headers are in: a body that takes 20 s is not cut off by it', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        let finish!: () => void;
        const body = new ReadableStream<Uint8Array>({ start(controller) { finish = () => { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); }; } });
        const p = fetchMedia(GOOD, { fetchImpl: fetcher(reply(body, { 'content-type': 'image/jpeg' })).fetchImpl });
        await flush();
        mock.timers.tick(20_000);
        await flush();
        finish();
        const r = await p;
        assert.deepEqual(r.ok && [...r.media.bytes], [1, 2, 3]);
    });

    it('each redirect gets its own 15 s to connect: one that does not answer ends the download at 15 s after the last hop, before the 30 s total', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const g = gated();
        const p = fetchMedia(GOOD, { fetchImpl: g.fetchImpl });
        const state = pending(p);
        await flush();
        mock.timers.tick(14_000);
        g.answer(reply(null, { location: '/next' }, 302));
        await flush();
        // The second request started at 14 s, so its own deadline is 29 s: a single deadline measured from the start would have ended it at 15 s.
        mock.timers.tick(14_999);
        await flush();
        assert.equal(state.settled(), false, 'at 28.999 s the second hop is still inside its 15 s');
        mock.timers.tick(1);
        assert.deepEqual(brief(await p), TIMEOUT, 'at 29 s it is over: the 15 s of the second hop, and 1 s short of the 30 s total');
    });

    it('the 30 s total runs across all the redirects', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const g = gated();
        const p = fetchMedia(GOOD, { fetchImpl: g.fetchImpl });
        await flush();
        mock.timers.tick(14_000);
        g.answer(reply(null, { location: '/a' }, 302));
        await flush();
        mock.timers.tick(14_000);
        g.answer(reply(null, { location: '/b' }, 302));
        await flush();
        // 28 s in, the third hop is waiting inside its own 15 s: it is the 30 s total that ends it.
        mock.timers.tick(2_000);
        assert.deepEqual(brief(await p), TIMEOUT);
        assert.equal(g.signals.length, 3);
        assert.equal(g.signals[2]!.aborted, true);
    });

    it('with real timers: a connection that does not answer ends, and no timer is left running', async () => {
        const g = gated();
        const before = timers();
        assert.deepEqual(brief(await fetchMedia(GOOD, { fetchImpl: g.fetchImpl, connectMs: 20, totalMs: 5_000 })), TIMEOUT);
        assert.equal(g.signals[0]!.aborted, true);
        assert.equal(timers(), before);
    });

    it('with real timers: a body that stalls ends, and no timer is left running', async () => {
        const fetchImpl: FetchLike = async (_url, init) => reply(stalling(init.signal as AbortSignal, new Uint8Array(3)), { 'content-type': 'image/jpeg' });
        const before = timers();
        assert.deepEqual(brief(await fetchMedia(GOOD, { fetchImpl, connectMs: 5_000, totalMs: 20 })), TIMEOUT);
        assert.equal(timers(), before);
    });
});

describe('fetchMedia: it never throws, and never says where it was sent', () => {
    it('a transport failure is fetch_failed with the code of the error, not its message', async () => {
        const fetchImpl: FetchLike = async () => { throw Object.assign(new TypeError(`fetch failed ${GOOD}`), { cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }) }); };
        const r = await fetchMedia(GOOD, { fetchImpl });
        assert.deepEqual(brief(r), { ok: false, status: 'failed', reason: 'fetch_failed', detail: 'ECONNRESET' });
        assert.ok(!JSON.stringify(r).includes('SECRETSIG'));
    });

    it('survives an error that is not an Error, and a body that breaks half way', async () => {
        const odd = await fetchMedia(GOOD, { fetchImpl: async () => { throw 'boom'; } });
        assert.deepEqual(brief(odd), { ok: false, status: 'failed', reason: 'fetch_failed', detail: 'error' });
        const broken = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array(3)); controller.error(new Error(`socket closed ${GOOD}`)); },
        });
        const r = await fetchMedia(GOOD, { fetchImpl: fetcher(reply(broken, { 'content-type': 'image/jpeg' })).fetchImpl });
        const f = failedOf(r);
        assert.deepEqual([f.status, f.reason], ['failed', 'fetch_failed']);
        assert.ok(!JSON.stringify(r).includes('SECRETSIG'), 'the message of an error can carry the link: only a code is kept');
    });

    it('no result holds the link: not on a success, not on any failure', async () => {
        const cases: MediaResult[] = [
            await fetchMedia(GOOD, { fetchImpl: fetcher(jpeg(3)).fetchImpl }),
            await fetchMedia(GOOD, { fetchImpl: fetcher(reply(null, {}, 404)).fetchImpl }),
            await fetchMedia(GOOD, { fetchImpl: fetcher(reply(null, {}, 500)).fetchImpl }),
            await fetchMedia(GOOD, { limits: { image: 1 }, fetchImpl: fetcher(jpeg(3)).fetchImpl }),
        ];
        for (const r of cases) assert.ok(!JSON.stringify(r).includes('asset_id') && !JSON.stringify(r).includes('SECRETSIG'));
    });

    it('leaves no timer behind on any path', async () => {
        const before = timers();
        await fetchMedia(GOOD, { fetchImpl: fetcher(jpeg(3)).fetchImpl });
        await fetchMedia(GOOD, { fetchImpl: fetcher(reply(null, {}, 403)).fetchImpl });
        await fetchMedia(GOOD, { fetchImpl: async () => { throw new Error('x'); } });
        await fetchMedia('https://evil.example/x');
        await fetchMedia(null);
        assert.equal(timers(), before);
    });
});

describe('media.ts: it keeps nothing', () => {
    const source = readFileSync(new URL('./media.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    it('imports no database and names no table: the bytes live in a result and go to the model, and media_uploads is not touched', () => {
        assert.doesNotMatch(code, /\bpool\b|db\/query|config\/db|media_uploads|\bINSERT\b|\bUPDATE\b|writeFile|createWriteStream/i);
    });

    it('sends no token: no Authorization header, no Bearer, and no setting is read', () => {
        assert.doesNotMatch(code, /authorization|bearer|access_token|appSettings|getSetting/i);
    });
});
