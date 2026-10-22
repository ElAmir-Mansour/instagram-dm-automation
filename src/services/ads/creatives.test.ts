/**
 * The A5 creatives: the 9:16 placement version, the video cover rule, the upload and preview calls. Nothing here reaches Meta or the database: the graph and the media store are stubs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AdsCallContext, AdsGraph } from './graphPort.js';
import {
    PREVIEW_FORMATS, REELS_CUSTOMISATION_LIVE_CHECKED, VERTICAL_FB_POSITIONS, VERTICAL_IG_POSITIONS, CreativeError,
    placementAssetFeed, generatePreviews, previewFrame, readVideoStatus,
    truncatePrimaryText, uploadImage, uploadVideo, type CreativeDeps,
} from './creatives.js';

const CTX: AdsCallContext = { tenantId: 't1', adAccountId: 'act_123', token: 'tok' };
const COPY = { primaryText: 'تعلّم البرمجة خطوة بخطوة', headline: 'ابدأ اليوم', cta: 'LEARN_MORE' };
const LINK = 'https://example.com/learn';

interface Call { method: string; path: string; params: Record<string, any>; label: string }

function fakeGraph(handlers: Partial<Record<'get' | 'post' | 'create', (path: string, params: any) => any>> = {}): AdsGraph & { calls: Call[] } {
    const calls: Call[] = [];
    return {
        calls,
        async get(path, params, label) { calls.push({ method: 'get', path, params, label }); return handlers.get ? handlers.get(path, params) : {}; },
        async post(path, params, label) { calls.push({ method: 'post', path, params, label }); return handlers.post ? handlers.post(path, params) : {}; },
        async create(path, params, label) { calls.push({ method: 'create', path, params, label }); return handlers.create ? handlers.create(path, params) : 'id1'; },
        async del() { /* not used */ },
    };
}

function deps(graph: AdsGraph, media: Record<string, { mimeType: string; data?: Buffer }> = {}): CreativeDeps {
    return {
        graph,
        publicBase: 'https://app.example.com',
        store: {
            async get(id) { const m = media[id]; return m ? { id, mimeType: m.mimeType, data: m.data ?? Buffer.from('x') } : null; },
            async mimeTypes(ids) { return new Map(ids.filter((id) => media[id]).map((id) => [id, media[id]!.mimeType])); },
            publicUrl: (id, origin) => `${origin}/api/uploads/${id}`,
        },
    };
}

describe('placement positions', () => {
    it('sends only Stories for the 9:16 version until reels customisation is live-checked', () => {
        assert.equal(REELS_CUSTOMISATION_LIVE_CHECKED, false);
        assert.deepEqual(VERTICAL_IG_POSITIONS, ['story']);
        assert.deepEqual(VERTICAL_FB_POSITIONS, ['story']);
    });
});

describe('placementAssetFeed', () => {
    const base = { copy: COPY, link: LINK, source: 'upload' as const };

    it('builds an image asset_feed_spec with a feed rule and a vertical rule', () => {
        const c = placementAssetFeed({ ...base, kind: 'image', feed: { imageHash: 'hf' }, vertical: { imageHash: 'hv' } });
        const afs = c;
        assert.deepEqual(afs.images, [{ hash: 'hf', adlabels: [{ name: 'feed' }] }, { hash: 'hv', adlabels: [{ name: 'vertical' }] }]);
        assert.deepEqual(afs.bodies, [{ text: COPY.primaryText }]);
        assert.deepEqual(afs.titles, [{ text: COPY.headline }]);
        assert.deepEqual(afs.link_urls, [{ website_url: LINK }]);
        assert.deepEqual(afs.call_to_action_types, ['LEARN_MORE']);
        assert.deepEqual(afs.ad_formats, ['SINGLE_IMAGE']);
        assert.equal(afs.optimization_type, 'PLACEMENT');
        assert.equal(afs.asset_customization_rules.length, 2);
        assert.deepEqual(afs.asset_customization_rules[0], {
            customization_spec: { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed', 'marketplace', 'search'], instagram_positions: ['stream', 'profile_feed', 'ig_search'] },
            image_label: { name: 'feed' }, priority: 1,
        });
        assert.deepEqual(afs.asset_customization_rules[1], {
            customization_spec: { publisher_platforms: ['facebook', 'instagram'], facebook_positions: VERTICAL_FB_POSITIONS, instagram_positions: VERTICAL_IG_POSITIONS },
            image_label: { name: 'vertical' }, priority: 2,
        });
    });

    it('builds a video asset_feed_spec with a cover on each video', () => {
        const c = placementAssetFeed({
            ...base, kind: 'video',
            feed: { videoId: 'vf', coverUrl: 'https://x/f.jpg' }, vertical: { videoId: 'vv', coverUrl: 'https://x/v.jpg' },
        });
        const afs = c;
        assert.deepEqual(afs.videos, [
            { video_id: 'vf', thumbnail_url: 'https://x/f.jpg', adlabels: [{ name: 'feed' }] },
            { video_id: 'vv', thumbnail_url: 'https://x/v.jpg', adlabels: [{ name: 'vertical' }] },
        ]);
        assert.deepEqual(afs.ad_formats, ['SINGLE_VIDEO']);
        assert.deepEqual(afs.asset_customization_rules.map((r: any) => r.video_label), [{ name: 'feed' }, { name: 'vertical' }]);
        assert.ok(afs.asset_customization_rules.every((r: any) => !('image_label' in r)));
        assert.ok(!('images' in afs));
    });

    it('leaves out the titles when there is no headline', () => {
        const c = placementAssetFeed({ ...base, copy: { primaryText: 'x', cta: 'SIGN_UP' }, kind: 'image', feed: { imageHash: 'a' }, vertical: { imageHash: 'b' } });
        assert.ok(!('titles' in c));
    });

    it('refuses a video whose cover is missing, either one', () => {
        for (const [feed, vertical] of [
            [{ videoId: 'a' }, { videoId: 'b', coverUrl: 'https://x/v.jpg' }],
            [{ videoId: 'a', coverUrl: 'https://x/f.jpg' }, { videoId: 'b' }],
        ] as const) {
            assert.throws(
                () => placementAssetFeed({ ...base, kind: 'video', feed, vertical }),
                (e: any) => e instanceof CreativeError && e.reason === 'cover_required' && e.field === 'coverMediaId',
            );
        }
    });

    it('refuses an existing post: Meta has no placement customisation there', () => {
        assert.throws(
            () => placementAssetFeed({ ...base, source: 'post', kind: 'image', feed: { imageHash: 'a' }, vertical: { imageHash: 'b' } }),
            (e: any) => e instanceof CreativeError && e.code === 'INVALID' && e.reason === 'vertical_needs_upload',
        );
    });

    it('refuses an asset that is missing', () => {
        assert.throws(() => placementAssetFeed({ ...base, kind: 'image', feed: { imageHash: 'a' }, vertical: {} }), (e: any) => e instanceof CreativeError);
        assert.throws(() => placementAssetFeed({ ...base, kind: 'video', feed: { coverUrl: 'c' }, vertical: { videoId: 'v', coverUrl: 'c' } }), (e: any) => e instanceof CreativeError);
    });
});

describe('previews: formats, frames, truncation', () => {
    it('maps each placement to Meta ad_format', () => {
        assert.deepEqual(PREVIEW_FORMATS, {
            feed: 'MOBILE_FEED_STANDARD', instagram_feed: 'INSTAGRAM_STANDARD', instagram_story: 'INSTAGRAM_STORY',
            instagram_reels: 'INSTAGRAM_REELS', facebook_reels: 'FACEBOOK_REELS_MOBILE',
        });
    });
    it('draws feeds 4:5 and stories and reels 9:16', () => {
        assert.equal(previewFrame('feed'), '4:5');
        assert.equal(previewFrame('instagram_feed'), '4:5');
        assert.equal(previewFrame('instagram_story'), '9:16');
        assert.equal(previewFrame('instagram_reels'), '9:16');
        assert.equal(previewFrame('facebook_reels'), '9:16');
    });
    it('leaves short text alone', () => {
        assert.deepEqual(truncatePrimaryText('short text'), { text: 'short text', truncated: false });
        const exact = 'a'.repeat(125);
        assert.deepEqual(truncatePrimaryText(exact), { text: exact, truncated: false });
    });
    it('cuts long text at a word boundary', () => {
        const text = `${'word '.repeat(40)}end`;
        const out = truncatePrimaryText(text);
        assert.equal(out.truncated, true);
        assert.ok(out.text.length <= 125);
        assert.ok(text.startsWith(out.text));
        assert.ok(out.text.endsWith('word'));
    });
    it('cuts hard when there is no space, and honours a custom limit', () => {
        const out = truncatePrimaryText('x'.repeat(300));
        assert.deepEqual(out, { text: 'x'.repeat(125), truncated: true });
        assert.deepEqual(truncatePrimaryText('one two three', 8), { text: 'one two', truncated: true });
    });
});

describe('uploadImage', () => {
    it('posts the bytes as base64 and returns the hash', async () => {
        const graph = fakeGraph({ post: () => ({ images: { 'cover.png': { hash: 'abc123', url: 'https://u' } } }) });
        const out = await uploadImage(CTX, deps(graph, { m1: { mimeType: 'image/png', data: Buffer.from('hello') } }), 'm1');
        assert.deepEqual(out, { hash: 'abc123' });
        assert.equal(graph.calls.length, 1);
        assert.equal(graph.calls[0]!.method, 'post');
        assert.equal(graph.calls[0]!.path, 'act_123/adimages');
        assert.deepEqual(graph.calls[0]!.params, { bytes: Buffer.from('hello').toString('base64') });
    });
    it('refuses a non-image and a missing file without calling Meta', async () => {
        const graph = fakeGraph();
        const d = deps(graph, { v: { mimeType: 'video/mp4' } });
        await assert.rejects(uploadImage(CTX, d, 'v'), (e: any) => e instanceof CreativeError && e.reason === 'not_an_image');
        await assert.rejects(uploadImage(CTX, d, 'nope'), (e: any) => e instanceof CreativeError && e.reason === 'media_missing');
        assert.equal(graph.calls.length, 0);
    });
    it('throws when Meta answers without a hash', async () => {
        const graph = fakeGraph({ post: () => ({ images: {} }) });
        await assert.rejects(uploadImage(CTX, deps(graph, { m: { mimeType: 'image/jpeg' } }), 'm'), /hash/);
    });
    it('accepts an ad account id without the act_ prefix', async () => {
        const graph = fakeGraph({ post: () => ({ images: { a: { hash: 'h' } } }) });
        await uploadImage({ ...CTX, adAccountId: '123' }, deps(graph, { m: { mimeType: 'image/jpeg' } }), 'm');
        assert.equal(graph.calls[0]!.path, 'act_123/adimages');
    });
});

describe('uploadVideo', () => {
    it('hands Meta the public URL and never reads the bytes', async () => {
        const graph = fakeGraph({ create: () => 'vid9' });
        const d = deps(graph, { m: { mimeType: 'video/mp4' } });
        d.store.get = async () => { throw new Error('a video must never be buffered'); };
        const out = await uploadVideo(CTX, d, 'm');
        assert.deepEqual(out, { videoId: 'vid9' });
        assert.equal(graph.calls[0]!.method, 'create');
        assert.equal(graph.calls[0]!.path, 'act_123/advideos');
        assert.equal(graph.calls[0]!.params['file_url'], 'https://app.example.com/api/uploads/m');
        assert.ok(typeof graph.calls[0]!.params['name'] === 'string');
    });
    it('refuses a non-video and a missing file', async () => {
        const graph = fakeGraph();
        const d = deps(graph, { i: { mimeType: 'image/png' } });
        await assert.rejects(uploadVideo(CTX, d, 'i'), (e: any) => e instanceof CreativeError && e.reason === 'not_a_video');
        await assert.rejects(uploadVideo(CTX, d, 'nope'), (e: any) => e instanceof CreativeError && e.reason === 'media_missing');
        assert.equal(graph.calls.length, 0);
    });
});

describe('readVideoStatus', () => {
    const read = async (answer: any) => readVideoStatus(CTX, deps(fakeGraph({ get: () => answer })), 'v1');
    it('reads ready, processing and error', async () => {
        assert.deepEqual(await read({ status: { video_status: 'ready' } }), { state: 'ready' });
        assert.deepEqual(await read({ status: { video_status: 'processing' } }), { state: 'processing' });
        const failed = await read({ status: { video_status: 'error', processing_phase: { error: { message: 'bad codec' } } } });
        assert.equal(failed.state, 'error');
        assert.equal(typeof failed.error, 'string');
    });
    it('treats anything else as still processing', async () => {
        assert.deepEqual(await read({ status: { video_status: 'upload_complete' } }), { state: 'processing' });
        assert.deepEqual(await read({}), { state: 'processing' });
    });
    it('asks for the status field of the video', async () => {
        const graph = fakeGraph({ get: () => ({ status: { video_status: 'ready' } }) });
        await readVideoStatus(CTX, deps(graph), 'v1');
        assert.equal(graph.calls[0]!.path, 'v1');
        assert.deepEqual(graph.calls[0]!.params, { fields: 'status' });
    });
});

describe('generatePreviews', () => {
    const spec = { name: 'n', object_story_spec: { page_id: 'p' } };
    it('asks Meta per placement and returns the iframe', async () => {
        const graph = fakeGraph({ get: () => ({ data: [{ body: '<iframe src="x"></iframe>' }] }) });
        const out = await generatePreviews(CTX, graph, spec, ['feed', 'instagram_story']);
        assert.deepEqual(out, [
            { placement: 'feed', frame: '4:5', html: '<iframe src="x"></iframe>' },
            { placement: 'instagram_story', frame: '9:16', html: '<iframe src="x"></iframe>' },
        ]);
        assert.equal(graph.calls[0]!.path, 'act_123/generatepreviews');
        assert.deepEqual(graph.calls[0]!.params, { creative: JSON.stringify(spec), ad_format: 'MOBILE_FEED_STANDARD' });
        assert.equal(graph.calls[1]!.params['ad_format'], 'INSTAGRAM_STORY');
    });
    it('answers null html with no_preview_access on a permission error, and never throws', async () => {
        for (const err of [Object.assign(new Error('x'), { metaCode: 10 }), Object.assign(new Error('x'), { metaCode: 200 }), new Error('(#10) Application does not have permission for this action')]) {
            const graph = fakeGraph({ get: () => { throw err; } });
            const out = await generatePreviews(CTX, graph, spec, ['feed']);
            assert.deepEqual(out, [{ placement: 'feed', frame: '4:5', html: null, reason: 'no_preview_access' }]);
        }
    });
    it('answers meta_error for any other failure, per placement', async () => {
        let n = 0;
        const graph = fakeGraph({ get: () => { if (n++ === 0) throw new Error('boom'); return { data: [{ body: '<iframe></iframe>' }] }; } });
        const out = await generatePreviews(CTX, graph, spec, ['feed', 'instagram_feed']);
        assert.deepEqual(out[0], { placement: 'feed', frame: '4:5', html: null, reason: 'meta_error' });
        assert.equal(out[1]!.html, '<iframe></iframe>');
    });
    it('answers meta_error when Meta answers without a body', async () => {
        const graph = fakeGraph({ get: () => ({ data: [] }) });
        const out = await generatePreviews(CTX, graph, spec, ['facebook_reels']);
        assert.deepEqual(out, [{ placement: 'facebook_reels', frame: '9:16', html: null, reason: 'meta_error' }]);
    });
});
