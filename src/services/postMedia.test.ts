/**
 * The media rules a scheduled post is held to before it is accepted.
 *
 * Every refusal here is a sentence the dashboard shows as-is, and every one of them stands in
 * for a failure that would otherwise arrive at publish time: Instagram refusing a PNG child
 * container, TikTok failing to pull a PNG or a URL outside its verified prefix. The media store
 * is a fake, so no test reads a real upload.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setMediaStore, type MediaStore } from './storage.js';
import { imageProblem, validatePostMedia, type InspectedImage } from './postMedia.js';

const JPEG = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const JPEG2 = '1b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const PNG = '2b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const WEBP = '3b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const MP4 = '4b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const GONE = '5b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const STORED: Record<string, string> = {
    [JPEG]: 'image/jpeg', [JPEG2]: 'image/jpeg', [PNG]: 'image/png', [WEBP]: 'image/webp', [MP4]: 'video/mp4',
};
const up = (id: string, ext = '') => `https://msg-response-auto.vercel.app/api/uploads/${id}${ext}`;

let lookups: string[][] = [];
let previous: MediaStore | null = null;

beforeEach(() => {
    lookups = [];
    previous = setMediaStore({
        async put() { throw new Error('not in these tests'); },
        async get() { throw new Error('bytes must never be read to validate a post'); },
        async open() { throw new Error('bytes must never be read to validate a post'); },
        async mimeTypes(ids) {
            lookups.push([...ids]);
            return new Map(ids.filter((id) => STORED[id]).map((id) => [id, STORED[id]!]));
        },
        publicUrl(id, origin) { return `${origin}/api/uploads/${id}`; },
    });
});
afterEach(() => { setMediaStore(previous); });

const check = (platform: string, postType: string, mediaUrls: unknown, mediaUrl: unknown = undefined) =>
    validatePostMedia({ platform, postType, mediaUrl, mediaUrls });

describe('validatePostMedia — carousels', () => {
    it('stores the list in slide order and mirrors the first image into media_url', async () => {
        const urls = [up(JPEG2), up(JPEG, '.jpg'), 'https://cdn.example/three.jpg'];
        const result = await check('both', 'carousel', urls, 'https://ignored.example/other.jpg');

        assert.deepEqual(result, { ok: true, mediaUrl: urls[0], mediaUrls: urls });
    });

    it('holds Instagram, Facebook and both to 2–10 images', async () => {
        for (const platform of ['instagram', 'facebook', 'both']) {
            for (const count of [0, 1, 11]) {
                const urls = Array.from({ length: count }, (_, i) => `https://cdn.example/${i}.jpg`);
                const r = await check(platform, 'carousel', urls);
                assert.equal(r.ok, false, `${platform} with ${count}`);
                if (!r.ok) assert.equal(r.error, `A carousel takes 2 to 10 images — this one has ${count}.`);
            }
            assert.equal((await check(platform, 'carousel', [up(JPEG), up(JPEG2)])).ok, true);
        }
    });

    it('holds a TikTok carousel to 2–35 photos', async () => {
        const many = (n: number) => Array.from({ length: n }, () => up(JPEG));
        assert.equal((await check('tiktok', 'carousel', many(35))).ok, true);
        const over = await check('tiktok', 'carousel', many(36));
        assert.equal(over.ok, false);
        if (!over.ok) assert.equal(over.error, 'A TikTok carousel takes 2 to 35 photos — this one has 36.');
        assert.equal((await check('tiktok', 'carousel', many(1))).ok, false);
    });

    it('refuses a carousel with no list at all', async () => {
        const r = await check('instagram', 'carousel', undefined, up(JPEG));
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.error, /2 to 10 images — this one has 0/);
    });

    it('refuses entries that are not http(s) URL strings, naming the slide', async () => {
        for (const bad of ['javascript:alert(1)', 'ftp://x/y.jpg', 'not a url', '', 42, null]) {
            const r = await check('facebook', 'carousel', [up(JPEG), bad]);
            assert.equal(r.ok, false, JSON.stringify(bad));
            if (!r.ok) assert.equal(r.error, 'Image 2 is not a web address — it must start with http:// or https://.');
        }
        const notList = await check('facebook', 'carousel', up(JPEG));
        assert.equal(notList.ok, false);
    });

    it('tells Instagram posts they need JPEG, for our own uploads', async () => {
        for (const platform of ['instagram', 'both']) {
            const r = await check(platform, 'carousel', [up(JPEG), up(PNG)]);
            assert.equal(r.ok, false);
            if (!r.ok) assert.equal(r.error, 'Instagram needs JPEG images — image 2 is PNG. Save it as a JPEG and upload it again.');
        }
        // Facebook alone takes a PNG.
        assert.equal((await check('facebook', 'carousel', [up(JPEG), up(PNG)])).ok, true);
    });

    it('lets external URLs through for Meta, which fetches them itself', async () => {
        const r = await check('instagram', 'carousel', ['https://cdn.example/a.png', 'https://cdn.example/b.jpg']);
        assert.equal(r.ok, true);
        assert.deepEqual(lookups, [], 'nothing of ours to look up');
    });

    it('refuses a video as a slide, and an upload that is gone', async () => {
        const video = await check('facebook', 'carousel', [up(JPEG), up(MP4)]);
        assert.equal(video.ok, false);
        if (!video.ok) assert.equal(video.error, 'Image 2 is a video — carousels take images only for now.');

        const gone = await check('facebook', 'carousel', [up(GONE), up(JPEG)]);
        assert.equal(gone.ok, false);
        if (!gone.ok) assert.equal(gone.error, 'Image 1 can’t be found any more — upload it again.');
    });

    it('looks every upload up in one query, without reading a byte', async () => {
        await check('both', 'carousel', [up(JPEG), up(JPEG2), up(JPEG, '.jpg')]);
        assert.deepEqual(lookups, [[JPEG, JPEG2]]);
    });
});

describe('validatePostMedia — TikTok photos', () => {
    it('takes only our own JPEG or WebP uploads', async () => {
        assert.equal((await check('tiktok', 'carousel', [up(JPEG), up(WEBP, '.webp')])).ok, true);

        const png = await check('tiktok', 'carousel', [up(JPEG), up(PNG)]);
        assert.equal(png.ok, false);
        if (!png.ok) assert.equal(png.error, 'TikTok photos must be JPEG or WebP — image 2 is PNG.');

        // PULL_FROM_URL only fetches from the prefix verified in TikTok's portal.
        const outside = await check('tiktok', 'carousel', [up(JPEG), 'https://cdn.example/b.jpg']);
        assert.equal(outside.ok, false);
        if (!outside.ok) assert.match(outside.error, /TikTok can only take photos uploaded here — image 2 is a link to another site/);
    });

    it('posts a single photo from media_url, or from a one-item list, and keeps no list', async () => {
        assert.deepEqual(await check('tiktok', 'image', undefined, up(JPEG)), { ok: true, mediaUrl: up(JPEG), mediaUrls: null });
        assert.deepEqual(await check('tiktok', 'image', [up(WEBP)], up(JPEG)), { ok: true, mediaUrl: up(WEBP), mediaUrls: null });
        assert.deepEqual(await check('tiktok', 'image', [], up(JPEG)), { ok: true, mediaUrl: up(JPEG), mediaUrls: null });
    });

    it('refuses a single-photo post with several images, or none', async () => {
        const two = await check('tiktok', 'image', [up(JPEG), up(JPEG2)]);
        assert.equal(two.ok, false);
        if (!two.ok) assert.match(two.error, /takes one image — this one has 2\. Choose carousel/);

        const none = await check('tiktok', 'image', undefined, undefined);
        assert.equal(none.ok, false);
        if (!none.ok) assert.equal(none.error, 'TikTok needs a photo — upload one first.');
    });

    it('says a video is a video, not a bad photo', async () => {
        const r = await check('tiktok', 'image', undefined, up(MP4));
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.error, 'That file is a video — schedule it as a video post instead.');
    });
});

describe('validatePostMedia — everything else is untouched', () => {
    it('passes a video, reel, story or single Meta image through as before, ignoring any list', async () => {
        for (const [platform, postType] of [['tiktok', 'video'], ['both', 'video'], ['instagram', 'story'], ['facebook', 'image'], ['instagram', 'reel']]) {
            const r = await check(platform!, postType!, [up(PNG), up(MP4)], up(PNG));
            assert.deepEqual(r, { ok: true, mediaUrl: up(PNG), mediaUrls: null }, `${platform}/${postType}`);
        }
        assert.deepEqual(await check('facebook', 'feed', undefined, undefined), { ok: true, mediaUrl: null, mediaUrls: null });
        assert.deepEqual(lookups, [], 'no new checks on the existing post types');
    });
});

describe('imageProblem', () => {
    const img = (mimeType: string | null, uploadId: string | null = JPEG): InspectedImage => ({ url: 'u', uploadId, mimeType });

    it('reads the mime type as a word a person knows', () => {
        assert.match(imageProblem([img('image/webp')], { carousel: false, instagram: true, tiktok: false })!, /the image is WebP/);
        assert.match(imageProblem([img('image/heic')], { carousel: false, instagram: false, tiktok: true })!, /the image is HEIC/);
    });

    it('finds nothing wrong with a clean list', () => {
        assert.equal(imageProblem([img('image/jpeg'), img(null, null)], { carousel: true, instagram: true, tiktok: false }), null);
    });
});
