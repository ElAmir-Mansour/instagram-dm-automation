/**
 * Every outbound Meta call, against a stubbed HTTP client.
 *
 * These are the writes — publishing a post, sending a DM, liking a comment — and they are the
 * one part of this codebase that cannot be verified against production, because "testing" them
 * means publishing a real post or messaging a real person. The note above `DEFAULT_API_VERSION`
 * says exactly that: the read paths were checked across v21/v26 on the live token, and the
 * write paths remain unproven. This file is what can be proven without acting on the account —
 * which URL each call goes to, and what body it carries.
 *
 * That is not incidental detail. Three of the assertions here are incidents:
 *
 *   - `post_type: 'reel'` used to fall past the `=== 'video'` branch and publish a
 *     caption-only text status on Facebook, with a post id returned and the row marked SENT.
 *   - `'story'` used to fall through to /feed for the same reason, so a Page story silently
 *     became a bare text post.
 *   - `sendDirectMessage` never sent `messaging_type`, so the send was evaluated outside the
 *     standard messaging window.
 *
 * `metaHttp.post`/`.get` are replaced for the whole file, with an implementation that throws
 * on any call a test did not arrange. There are live production credentials in `.env`; a test
 * here that reached the network could publish something.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from './http.js';
import {
    API_VERSION,
    MediaProcessingTimeoutError,
    MetaApiError,
    likeComment,
    publishFacebookCarousel,
    publishFacebookPost,
    publishInstagramCarousel,
    publishInstagramPost,
    sendDirectMessage,
    sendPrivateReply,
    sendPublicReply,
} from './instagram.js';

const BASE = `https://graph.facebook.com/${API_VERSION}`;
const TOKEN = 'EAAGtest-token';

interface Recorded {
    method: 'post' | 'get';
    url: string;
    body: unknown;
    config: any;
}

let calls: Recorded[] = [];
let onPost: (url: string, body: any, config: any) => Promise<any>;
let onGet: (url: string, config: any) => Promise<any>;

const originalPost = metaHttp.post;
const originalGet = metaHttp.get;

// The publish path logs a line per container transition by design. What it emits is covered
// by src/utils/log.test.ts; here it only buries the assertions.
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    calls = [];
    onPost = async (url) => {
        throw new Error(`no POST was arranged for ${url}`);
    };
    onGet = async (url) => {
        throw new Error(`no GET was arranged for ${url}`);
    };
    (metaHttp as any).post = (url: string, body: any, config: any) => {
        calls.push({ method: 'post', url, body, config });
        return onPost(url, body, config);
    };
    (metaHttp as any).get = (url: string, config: any) => {
        calls.push({ method: 'get', url, body: undefined, config });
        return onGet(url, config);
    };
});

afterEach(() => {
    (metaHttp as any).post = originalPost;
    (metaHttp as any).get = originalGet;
});

const ok = (data: unknown) => async () => ({ data });

/**
 * An axios-shaped Meta failure.
 *
 * Defaults to a 400 with code 100 specifically so `withRetry` refuses to retry it: a
 * retryable error would make these tests sit through real backoff sleeps.
 */
function metaError(code = 100, message = 'Bad thing', status = 400) {
    return Object.assign(new Error(message), {
        response: { status, data: { error: { code, message } } },
    });
}

const posts = () => calls.filter((c) => c.method === 'post');
const gets = () => calls.filter((c) => c.method === 'get');

describe('sendPrivateReply', () => {
    it('sends to /me/messages for Instagram, keyed on the comment id', async () => {
        onPost = ok({ message_id: 'm-1' });

        const result = await sendPrivateReply('comment-1', 'شكرا لك', TOKEN);

        assert.deepEqual(result, { message_id: 'm-1' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, `${BASE}/me/messages`);
        assert.deepEqual(calls[0]!.body, {
            recipient: { comment_id: 'comment-1' },
            message: { text: 'شكرا لك' },
            messaging_type: 'RESPONSE',
        });
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
    });

    it('sends to /{pageId}/messages when a Facebook page id is given', async () => {
        // A Page access token does not resolve /me; Meta requires the explicit page id.
        onPost = ok({ message_id: 'm-2' });

        await sendPrivateReply('comment-1', 'hi', TOKEN, '1112223334');

        assert.equal(calls[0]!.url, `${BASE}/1112223334/messages`);
    });

    it('wraps a Meta failure so the code survives for isPermanentMetaError', async () => {
        // The whole point of MetaApiError: flattening this into a string Error is what used to
        // make a dead token look transient and get retried.
        onPost = async () => {
            throw metaError(190, 'Invalid OAuth access token');
        };

        const err = await sendPrivateReply('c', 'x', TOKEN).then(
            () => null,
            (e) => e
        );

        assert.ok(err instanceof MetaApiError);
        assert.equal(err.metaCode, 190);
        assert.match(err.message, /Private Reply Failed \[me\]/);
        assert.match(err.message, /Code: 190/);
    });
});

describe('sendPublicReply', () => {
    it('uses the Instagram /replies edge by default', async () => {
        onPost = ok({ id: 'r-1' });

        await sendPublicReply('comment-9', 'تم', TOKEN);

        assert.equal(calls[0]!.url, `${BASE}/comment-9/replies`);
        assert.deepEqual(calls[0]!.body, { message: 'تم' });
    });

    it('uses the Facebook /comments edge when told it is Facebook', async () => {
        // The two platforms diverge on the same object: /replies simply does not exist on a
        // Facebook comment, so getting this wrong is a 100% failure rate on one platform.
        onPost = ok({ id: 'r-2' });

        await sendPublicReply('comment-9', 'تم', TOKEN, true);

        assert.equal(calls[0]!.url, `${BASE}/comment-9/comments`);
    });
});

describe('sendDirectMessage', () => {
    it('carries messaging_type RESPONSE', async () => {
        // It did not, for the life of the project. Without it the send is evaluated outside
        // the standard messaging window and is rejected once that window starts to matter.
        onPost = ok({ message_id: 'm-3' });

        await sendDirectMessage('igsid-1', { text: 'مرحبا' }, TOKEN);

        assert.equal((calls[0]!.body as any).messaging_type, 'RESPONSE');
        assert.deepEqual((calls[0]!.body as any).recipient, { id: 'igsid-1' });
    });

    it('passes a structured payload through untouched', async () => {
        // Quick replies and carousels are built by meta-payload.ts; this function must not
        // reshape them.
        onPost = ok({ message_id: 'm-4' });
        const payload = { attachment: { type: 'template', payload: { template_type: 'generic' } } };

        await sendDirectMessage('igsid-1', payload, TOKEN);

        assert.deepEqual((calls[0]!.body as any).message, payload);
    });

    it('routes to /me without a page id and /{pageId} with one', async () => {
        onPost = ok({});
        await sendDirectMessage('igsid-1', { text: 'a' }, TOKEN);
        await sendDirectMessage('igsid-1', { text: 'a' }, TOKEN, '1112223334');

        assert.equal(calls[0]!.url, `${BASE}/me/messages`);
        assert.equal(calls[1]!.url, `${BASE}/1112223334/messages`);
    });
});

describe('likeComment', () => {
    it('posts an empty body to /{commentId}/likes', async () => {
        onPost = ok({ success: true });

        await likeComment('comment-7', TOKEN);

        assert.equal(calls[0]!.url, `${BASE}/comment-7/likes`);
        assert.deepEqual(calls[0]!.body, {});
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
    });
});

describe('publishFacebookPost', () => {
    it('refuses a story instead of degrading it to a text post', async () => {
        // The incident. 'story' fell past the type checks to /feed and published the caption
        // as a bare text status — which returns a post id, so the row was marked SENT and
        // nothing anywhere said the media had been dropped.
        await assert.rejects(
            () => publishFacebookPost('page-1', 'story', 'caption', 'https://cdn/x.mp4', TOKEN),
            /Unsupported Facebook post_type: story/
        );

        assert.equal(calls.length, 0, 'it must not reach Meta at all');
    });

    it('publishes a reel through /videos, not as a caption-only status', async () => {
        // The other half of the same incident: only 'video' was handled, so a reel scheduled
        // for both platforms went out as text on Facebook.
        onPost = ok({ id: 'fb-1' });

        await publishFacebookPost('page-1', 'reel', 'وصف', 'https://cdn/reel.mp4', TOKEN);

        assert.equal(calls[0]!.url, `${BASE}/page-1/videos`);
        assert.deepEqual(calls[0]!.body, { file_url: 'https://cdn/reel.mp4', description: 'وصف' });
    });

    it('publishes a video through /videos', async () => {
        onPost = ok({ id: 'fb-2' });

        await publishFacebookPost('page-1', 'video', 'وصف', 'https://cdn/v.mp4', TOKEN);

        assert.equal(calls[0]!.url, `${BASE}/page-1/videos`);
        assert.deepEqual(calls[0]!.body, { file_url: 'https://cdn/v.mp4', description: 'وصف' });
    });

    it('publishes an image through /photos with url + caption', async () => {
        onPost = ok({ id: 'fb-3' });

        await publishFacebookPost('page-1', 'image', 'وصف', 'https://cdn/p.jpg', TOKEN);

        assert.equal(calls[0]!.url, `${BASE}/page-1/photos`);
        assert.deepEqual(calls[0]!.body, { url: 'https://cdn/p.jpg', caption: 'وصف' });
    });

    it('publishes a text-only post through /feed when there is no media', async () => {
        // Deliberately legal: media_url is nullable and a Facebook status is a real post type.
        onPost = ok({ id: 'fb-4' });

        await publishFacebookPost('page-1', 'image', 'نص فقط', null, TOKEN);

        assert.equal(calls[0]!.url, `${BASE}/page-1/feed`);
        assert.deepEqual(calls[0]!.body, { message: 'نص فقط' });
    });

    it("publishes the dashboard's `feed` type through /feed instead of rejecting it", async () => {
        // The incident: the composer offers `feed` for Facebook, and this function threw
        // "Unsupported Facebook post_type: feed" — every text post failed at publish time.
        onPost = ok({ id: 'fb-5' });

        await publishFacebookPost('page-1', 'feed', 'نص فقط', null, TOKEN);

        assert.equal(calls[0]!.url, `${BASE}/page-1/feed`);
        assert.deepEqual(calls[0]!.body, { message: 'نص فقط' });
    });

    it('shares a URL on a `feed` post as a link, not as an uploaded asset', async () => {
        onPost = ok({ id: 'fb-6' });

        await publishFacebookPost('page-1', 'feed', 'شاهد', 'https://example.com/a', TOKEN);

        assert.equal(calls[0]!.url, `${BASE}/page-1/feed`);
        assert.deepEqual(calls[0]!.body, { message: 'شاهد', link: 'https://example.com/a' });
    });

    it('wraps a publish failure with the Meta code intact', async () => {
        onPost = async () => {
            throw metaError(200, 'Insufficient permission');
        };

        const err = await publishFacebookPost('page-1', 'image', 'c', 'https://cdn/p.jpg', TOKEN)
            .then(() => null, (e) => e);

        assert.ok(err instanceof MetaApiError);
        assert.equal(err.metaCode, 200);
        assert.match(err.message, /Facebook Publish Failed/);
    });
});

describe('publishInstagramPost', () => {
    it('creates a container and publishes it, skipping the status poll for an image', async () => {
        // Images are ready on creation. Polling them would burn the invocation's budget for
        // nothing, so the absence of a status GET here is the assertion.
        onPost = async (url) => {
            if (url.endsWith('/media')) return { data: { id: 'container-1' } };
            if (url.endsWith('/media_publish')) return { data: { id: 'ig-media-1' } };
            throw new Error(`unexpected ${url}`);
        };

        const result = await publishInstagramPost('ig-1', 'image', 'وصف', 'https://cdn/p.jpg', TOKEN);

        assert.deepEqual(result, { id: 'ig-media-1' });
        assert.equal(gets().length, 0, 'an image must not be polled for processing status');
        assert.equal(posts()[0]!.url, `${BASE}/ig-1/media`);
        assert.deepEqual(posts()[0]!.body, { image_url: 'https://cdn/p.jpg', caption: 'وصف' });
        assert.equal(posts()[1]!.url, `${BASE}/ig-1/media_publish`);
        assert.deepEqual(posts()[1]!.body, { creation_id: 'container-1' });
    });

    it('threads cover_url through for a reel, instead of a frame-0 thumbnail', async () => {
        // Instagram defaults a reel's thumbnail to frame 0. Any video that fades up from
        // black gets a black tile in the profile grid — which is invisible from the API's
        // response and only shows up when someone looks at the account.
        onPost = async (url) =>
            url.endsWith('/media') ? { data: { id: 'c-2' } } : { data: { id: 'ig-2' } };
        onGet = async () => ({ data: { status_code: 'FINISHED' } });

        await publishInstagramPost(
            'ig-1', 'reel', 'وصف', 'https://cdn/r.mp4', TOKEN, 'https://cdn/cover.jpg'
        );

        const create = posts()[0]!.body as any;
        assert.equal(create.cover_url, 'https://cdn/cover.jpg');
        assert.equal(create.media_type, 'REELS');
        assert.equal(create.share_to_feed, true, 'without this a reel never reaches the main feed');
        assert.equal(
            'thumb_offset' in create, false,
            'cover_url wins over thumb_offset, so sending both would be ambiguous'
        );
    });

    it('falls back to thumb_offset when no cover is supplied', async () => {
        onPost = async (url) =>
            url.endsWith('/media') ? { data: { id: 'c-3' } } : { data: { id: 'ig-3' } };
        onGet = async () => ({ data: { status_code: 'FINISHED' } });

        await publishInstagramPost('ig-1', 'video', 'وصف', 'https://cdn/v.mp4', TOKEN, null);

        const create = posts()[0]!.body as any;
        assert.equal(create.thumb_offset, 1500);
        assert.equal('cover_url' in create, false);
        assert.equal(create.media_type, 'REELS', 'a video publishes through the REELS container');
    });

    it('polls until the container reports FINISHED, then publishes it', async () => {
        let polls = 0;
        onPost = async (url) =>
            url.endsWith('/media') ? { data: { id: 'c-4' } } : { data: { id: 'ig-4' } };
        onGet = async () => ({ data: { status_code: ++polls >= 2 ? 'FINISHED' : 'IN_PROGRESS' } });

        // A budget big enough for two polls at the 2.5s interval.
        const result = await publishInstagramPost(
            'ig-1', 'video', 'c', 'https://cdn/v.mp4', TOKEN, null, 6_000
        );

        assert.deepEqual(result, { id: 'ig-4' });
        assert.equal(polls, 2);
        assert.equal(gets()[0]!.url, `${BASE}/c-4`);
        assert.equal(gets()[0]!.config.params.access_token, TOKEN);
        assert.equal(posts().length, 2, 'it must publish exactly once');
    });

    it('throws MediaProcessingTimeoutError, unwrapped, when the budget runs out', async () => {
        // Distinct from a rejection on purpose: the container may well finish server-side a
        // moment later, so the caller needs to requeue rather than mark the post FAILED. That
        // only works if the error survives the catch at the bottom of the function instead of
        // being flattened into a MetaApiError.
        onPost = ok({ id: 'c-5' });
        onGet = async () => ({ data: { status_code: 'IN_PROGRESS', status: 'still transcoding' } });

        const err = await publishInstagramPost(
            'ig-1', 'reel', 'c', 'https://cdn/r.mp4', TOKEN, null, 40
        ).then(() => null, (e) => e);

        assert.ok(err instanceof MediaProcessingTimeoutError, `got ${err?.name}`);
        assert.equal(err instanceof MetaApiError, false, 'must not be rewrapped');
        assert.equal(err.code, 'IG_MEDIA_PROCESSING_TIMEOUT');
        assert.equal(err.containerId, 'c-5');
        assert.equal(err.lastStatus, 'still transcoding');
        assert.equal(
            posts().length, 1,
            'it must not publish a container that never finished processing'
        );
    });

    it('gives up immediately when Instagram reports the media as ERROR', async () => {
        onPost = ok({ id: 'c-6' });
        onGet = async () => ({ data: { status_code: 'ERROR', status: 'Unsupported format' } });

        const err = await publishInstagramPost(
            'ig-1', 'reel', 'c', 'https://cdn/r.mov', TOKEN, null, 3_000
        ).then(() => null, (e) => e);

        assert.ok(err instanceof MetaApiError);
        assert.match(err.message, /Instagram Publish Failed/);
        assert.match(err.message, /status: ERROR/);
        assert.match(err.message, /Unsupported format/);
        assert.equal(gets().length, 1, 'ERROR is terminal — no point polling on');
        assert.equal(posts().length, 1);
    });

    it('rides out a 9007 "media id not available" and publishes on the next attempt', async () => {
        // The container exists but is not publishable yet. withRetry rightly refuses to retry
        // a 400, so this race is ridden out inside the publish loop instead.
        let publishAttempts = 0;
        onPost = async (url) => {
            if (url.endsWith('/media')) return { data: { id: 'c-7' } };
            if (++publishAttempts === 1) throw metaError(9007, 'Media ID is not available');
            return { data: { id: 'ig-7' } };
        };

        const result = await publishInstagramPost('ig-1', 'image', 'c', 'https://cdn/p.jpg', TOKEN);

        assert.deepEqual(result, { id: 'ig-7' });
        assert.equal(publishAttempts, 2);
    });

    it('does not ride out an auth failure on publish', async () => {
        // Only 9007/100 are the not-ready race. A 190 retried three times is how an app
        // attracts Meta's enforcement attention.
        let publishAttempts = 0;
        onPost = async (url) => {
            if (url.endsWith('/media')) return { data: { id: 'c-8' } };
            publishAttempts++;
            throw metaError(190, 'Invalid OAuth access token');
        };

        const err = await publishInstagramPost('ig-1', 'image', 'c', 'https://cdn/p.jpg', TOKEN)
            .then(() => null, (e) => e);

        assert.ok(err instanceof MetaApiError);
        assert.equal(err.metaCode, 190);
        assert.equal(publishAttempts, 1);
    });

    it('builds a STORIES container, choosing video or image from the URL', async () => {
        onPost = async (url) =>
            url.endsWith('/media') ? { data: { id: 'c-9' } } : { data: { id: 'ig-9' } };
        onGet = async () => ({ data: { status_code: 'FINISHED' } });

        await publishInstagramPost('ig-1', 'story', '', 'https://cdn/s.mp4?v=2', TOKEN);
        assert.deepEqual(posts()[0]!.body, { media_type: 'STORIES', video_url: 'https://cdn/s.mp4?v=2' });

        calls = [];
        await publishInstagramPost('ig-1', 'story', '', 'https://cdn/s.jpg', TOKEN);
        assert.deepEqual(posts()[0]!.body, { media_type: 'STORIES', image_url: 'https://cdn/s.jpg' });
    });
});

describe('publishInstagramCarousel', () => {
    const slides = ['https://app/api/uploads/a.jpg', 'https://app/api/uploads/b.jpg', 'https://app/api/uploads/c.jpg'];

    /** Children get ids child-1.., the parent `parent-1`, the publish `ig-carousel-1`. */
    function arrangeCarousel() {
        let child = 0;
        onPost = async (url, body) => {
            if (url.endsWith('/media') && body.is_carousel_item) return { data: { id: `child-${++child}` } };
            if (url.endsWith('/media')) return { data: { id: 'parent-1' } };
            if (url.endsWith('/media_publish')) return { data: { id: 'ig-carousel-1' } };
            throw new Error(`unexpected ${url}`);
        };
        onGet = async () => ({ data: { status_code: 'FINISHED' } });
    }

    it('creates one flagged child per image, then a CAROUSEL parent that carries the caption', async () => {
        arrangeCarousel();

        const result = await publishInstagramCarousel('ig-1', 'وصف', slides, TOKEN);

        assert.deepEqual(result, { id: 'ig-carousel-1' });
        const creates = posts().filter((c) => c.url === `${BASE}/ig-1/media`);
        assert.equal(creates.length, 4, 'three children and one parent');
        // In slide order, flagged as items, and without a caption: the caption lives on the
        // parent, and a child container is not a post anyone sees.
        assert.deepEqual(creates.slice(0, 3).map((c) => c.body), slides.map((image_url) => ({
            image_url, is_carousel_item: true,
        })));
        assert.deepEqual(creates[3]!.body, {
            media_type: 'CAROUSEL', children: 'child-1,child-2,child-3', caption: 'وصف',
        });
        assert.equal(typeof (creates[3]!.body as any).children, 'string', 'children is a comma-joined string, not an array');
    });

    it('polls the parent, not the children, and publishes the parent exactly once', async () => {
        arrangeCarousel();

        await publishInstagramCarousel('ig-1', 'c', slides.slice(0, 2), TOKEN);

        assert.deepEqual(gets().map((c) => c.url), [`${BASE}/parent-1`]);
        const publishes = posts().filter((c) => c.url.endsWith('/media_publish'));
        assert.equal(publishes.length, 1);
        assert.deepEqual(publishes[0]!.body, { creation_id: 'parent-1' });
    });

    it('refuses fewer than 2 or more than 10 images before creating anything', async () => {
        for (const count of [0, 1, 11]) {
            const urls = Array.from({ length: count }, (_, i) => `https://cdn/${i}.jpg`);
            const err = await publishInstagramCarousel('ig-1', 'c', urls, TOKEN).then(() => null, (e) => e);
            assert.match(String(err?.message), /2 to 10 images/, `${count} images`);
        }
        assert.equal(calls.length, 0, 'no orphan child containers');
    });

    it('throws MediaProcessingTimeoutError, unwrapped, when the parent never finishes', async () => {
        arrangeCarousel();
        onGet = async () => ({ data: { status_code: 'IN_PROGRESS', status: 'still working' } });

        const err = await publishInstagramCarousel('ig-1', 'c', slides, TOKEN, 40).then(() => null, (e) => e);

        assert.ok(err instanceof MediaProcessingTimeoutError, `got ${err?.name}`);
        assert.equal(err.containerId, 'parent-1');
        assert.ok(!posts().some((c) => c.url.endsWith('/media_publish')), 'an unfinished carousel is never published');
    });

    it('rides out the 9007 not-ready race on publish, like a single post', async () => {
        arrangeCarousel();
        const publishAttempts = { n: 0 };
        const arranged = onPost;
        onPost = async (url, body, config) => {
            if (url.endsWith('/media_publish') && ++publishAttempts.n === 1) {
                throw metaError(9007, 'Media ID is not available');
            }
            return arranged(url, body, config);
        };

        const result = await publishInstagramCarousel('ig-1', 'c', slides, TOKEN);

        assert.deepEqual(result, { id: 'ig-carousel-1' });
        assert.equal(publishAttempts.n, 2);
    });

    it('wraps a rejected child with the Meta code intact, and stops there', async () => {
        onPost = async () => { throw metaError(36003, 'Only photo or video can be accepted as media type.'); };

        const err = await publishInstagramCarousel('ig-1', 'c', slides, TOKEN).then(() => null, (e) => e);

        assert.ok(err instanceof MetaApiError);
        assert.equal(err.metaCode, 36003);
        assert.match(err.message, /Instagram Publish Failed/);
        assert.equal(posts().length, 1, 'no parent is created once a child has been refused');
    });
});

describe('publishFacebookCarousel', () => {
    const slides = ['https://app/api/uploads/a.jpg', 'https://app/api/uploads/b.png'];

    it('uploads each photo unpublished, then attaches them all to one feed post', async () => {
        let photo = 0;
        onPost = async (url) => {
            if (url.endsWith('/photos')) return { data: { id: `photo-${++photo}` } };
            if (url.endsWith('/feed')) return { data: { id: 'page-1_post-1' } };
            throw new Error(`unexpected ${url}`);
        };

        const result = await publishFacebookCarousel('page-1', 'وصف', slides, TOKEN);

        assert.deepEqual(result, { id: 'page-1_post-1' });
        const uploads = posts().filter((c) => c.url === `${BASE}/page-1/photos`);
        // `published: false`, or every slide appears on the Page as a post of its own.
        assert.deepEqual(uploads.map((c) => c.body), [
            { url: slides[0], published: false },
            { url: slides[1], published: false },
        ]);
        const feed = posts().find((c) => c.url === `${BASE}/page-1/feed`);
        assert.deepEqual(feed?.body, {
            message: 'وصف',
            attached_media: [{ media_fbid: 'photo-1' }, { media_fbid: 'photo-2' }],
        });
        assert.equal(feed?.config.headers.Authorization, `Bearer ${TOKEN}`);
    });

    it('refuses an empty list instead of posting a caption-only status', async () => {
        const err = await publishFacebookCarousel('page-1', 'c', [], TOKEN).then(() => null, (e) => e);
        assert.ok(err);
        assert.equal(calls.length, 0);
    });

    it('wraps a failure with the Meta code intact', async () => {
        onPost = async () => { throw metaError(324, 'Missing or invalid image file'); };

        const err = await publishFacebookCarousel('page-1', 'c', slides, TOKEN).then(() => null, (e) => e);

        assert.ok(err instanceof MetaApiError);
        assert.equal(err.metaCode, 324);
        assert.match(err.message, /Facebook Publish Failed/);
    });
});

describe('reach levers — alt text, collaborators, trial reels (GROWTH.md §4)', () => {
    const creates = () => posts().filter((c) => c.url === `${BASE}/ig-1/media`);
    function arrange(refuse?: (body: any) => Error | null) {
        let child = 0;
        onPost = async (url, body) => {
            if (url.endsWith('/media')) {
                const err = refuse?.(body);
                if (err) throw err;
                return { data: { id: body.is_carousel_item ? `child-${++child}` : 'container-1' } };
            }
            if (url.endsWith('/media_publish')) return { data: { id: 'ig-media-1' } };
            throw new Error(`unexpected ${url}`);
        };
        onGet = async () => ({ data: { status_code: 'FINISHED' } });
    }

    it('sends alt_text and collaborators on an image container', async () => {
        arrange();
        const result = await publishInstagramPost('ig-1', 'image', 'c', 'https://cdn/p.jpg', TOKEN, null, undefined, {
            altText: 'A prompt on a dark slide', collaborators: ['partner.one'],
        });
        assert.deepEqual(result, { id: 'ig-media-1' }, 'nothing refused: the result is unchanged');
        assert.deepEqual(creates()[0]!.body, {
            image_url: 'https://cdn/p.jpg', caption: 'c', alt_text: 'A prompt on a dark slide', collaborators: ['partner.one'],
        });
    });

    it('sends collaborators and trial_params on a reel, and nothing on a story', async () => {
        arrange();
        await publishInstagramPost('ig-1', 'video', 'c', 'https://cdn/v.mp4', TOKEN, null, undefined, {
            collaborators: ['a'], trialReel: { graduation: 'SS_PERFORMANCE' }, altText: 'ignored on a reel',
        });
        const reel = creates()[0]!.body as any;
        assert.deepEqual(reel.trial_params, { graduation_strategy: 'SS_PERFORMANCE' });
        assert.deepEqual(reel.collaborators, ['a']);
        assert.equal(reel.share_to_feed, true);
        assert.equal('alt_text' in reel, false, 'Instagram takes no alt text on reels');

        calls = [];
        await publishInstagramPost('ig-1', 'story', '', 'https://cdn/s.jpg', TOKEN, null, undefined, { collaborators: ['a'], altText: 'x' });
        assert.deepEqual(creates()[0]!.body, { media_type: 'STORIES', image_url: 'https://cdn/s.jpg' });
    });

    it('puts alt text on each carousel child by slide, and collaborators on the parent only', async () => {
        arrange();
        await publishInstagramCarousel('ig-1', 'c', ['https://cdn/1.jpg', 'https://cdn/2.jpg', 'https://cdn/3.jpg'], TOKEN, undefined, {
            altTexts: ['first', null, 'third'], collaborators: ['a', 'b'],
        });
        const bodies = creates().map((c) => c.body as any);
        assert.deepEqual(bodies.slice(0, 3).map((b) => b.alt_text), ['first', undefined, 'third']);
        assert.ok(bodies.slice(0, 3).every((b) => !('collaborators' in b)));
        assert.deepEqual(bodies[3].collaborators, ['a', 'b']);
    });

    it('publishes without the levers when Instagram refuses them, once, and says which', async () => {
        arrange((body) => (body.collaborators ? metaError(100, 'Collaborators are not available for this account') : null));
        const result = await publishInstagramPost('ig-1', 'video', 'c', 'https://cdn/v.mp4', TOKEN, null, undefined, {
            collaborators: ['a'],
        });
        assert.equal(result.id, 'ig-media-1');
        assert.deepEqual(result.dropped.map((d: any) => d.field), ['collaborators']);
        assert.match(result.dropped[0].reason, /not available for this account \(Code: 100\)/);
        assert.equal(creates().length, 2, 'one refusal, one retry');
        const retry = creates()[1]!.body as any;
        assert.equal('collaborators' in retry, false);
        assert.equal(retry.share_to_feed, true, 'the rest of the payload is untouched');
    });

    it('never turns a refused trial reel into a normal reel: it stops, and says why', async () => {
        arrange((body) => (body.trial_params ? metaError(100, 'Trial reels are not available for this account') : null));
        const err = await publishInstagramPost('ig-1', 'video', 'c', 'https://cdn/v.mp4', TOKEN, null, undefined, {
            trialReel: { graduation: 'MANUAL' }, collaborators: ['a'],
        }).then(() => null, (e) => e);
        assert.ok(err instanceof MetaApiError, 'the publish fails');
        assert.match(err.message, /Trial Reel .* NOT published/);
        assert.match(err.message, /not available for this account/);
        assert.ok(creates().every((c) => 'trial_params' in (c.body as any)), 'no attempt without the trial');
        assert.equal(posts().some((c) => c.url.endsWith('/media_publish')), false, 'nothing published');
    });

    it('asks a carousel about alt text once, not once per slide', async () => {
        arrange((body) => (body.alt_text ? metaError(100, 'Invalid parameter') : null));
        const result = await publishInstagramCarousel('ig-1', 'c', ['https://cdn/1.jpg', 'https://cdn/2.jpg'], TOKEN, undefined, {
            altTexts: ['one', 'two'],
        });
        assert.deepEqual(result.dropped.map((d: any) => d.field), ['alt_text']);
        assert.equal(creates().length, 4, 'child 1 refused and retried, child 2 sent without, then the parent');
        assert.equal('alt_text' in (creates()[2]!.body as any), false);
    });

    it('does not retry a dead token, or a create that fails with no lever on it', async () => {
        arrange(() => metaError(190, 'Error validating access token'));
        const dead = await publishInstagramPost('ig-1', 'image', 'c', 'https://cdn/p.jpg', TOKEN, null, undefined, { altText: 'x' })
            .then(() => null, (e) => e);
        assert.ok(dead instanceof MetaApiError);
        assert.equal(dead.metaCode, 190);
        assert.equal(creates().length, 1);

        calls = [];
        arrange(() => metaError(9004, 'Only photo or video can be accepted'));
        const bare = await publishInstagramPost('ig-1', 'image', 'c', 'https://cdn/p.jpg', TOKEN).then(() => null, (e) => e);
        assert.equal(bare.metaCode, 9004);
        assert.equal(creates().length, 1, 'nothing to drop, so nothing to retry');
    });

    it('fails with the retry’s error when the post is refused without the levers too', async () => {
        let n = 0;
        arrange(() => metaError(++n === 1 ? 100 : 36003, n === 1 ? 'first' : 'the real problem'));
        const err = await publishInstagramPost('ig-1', 'image', 'c', 'https://cdn/p.jpg', TOKEN, null, undefined, { altText: 'x' })
            .then(() => null, (e) => e);
        assert.ok(err instanceof MetaApiError);
        assert.equal(err.metaCode, 36003);
        assert.match(err.message, /the real problem/);
        assert.ok(!posts().some((c) => c.url.endsWith('/feed')), 'no feed post without every photo');
    });
});
