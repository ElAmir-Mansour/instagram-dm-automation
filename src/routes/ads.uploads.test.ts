/**
 * The full builder's routes (Meta Ads Manager A5, task T104), through the whole router as Express calls it:
 *   - POST /uploads/sign is the owner's, refuses a type or a size an ad cannot use, and answers a signed Storage URL and a media id;
 *   - POST /creatives/from-media hands an image's bytes to `adimages` (and remembers the hash), and a video to `advideos` by its public URL
 *     (never its bytes), and refuses a video without a cover;
 *   - GET /targeting/search is the operator's and answers Meta's items; GET /minimum-budgets is any member's;
 *   - POST /objects/:id/duplicate enqueues ONE `/copies` write, PAUSED, renamed as a copy, and calls Meta only from the queue;
 *   - POST /drafts/validate of an uploaded video with a 9:16 version answers the reach estimate and a preview per placement.
 *
 * The database, Meta and `waitUntil` are A2's kit (src/services/ads/testing/objects/testDb.ts).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { metaHttp } from '../services/http.js';
import { forgetMinimums } from '../services/ads/drafts.js';
import { clearTargetingCache } from '../services/ads/targetingSearch.js';
import { setMediaStore, SupabaseStorageMediaStore, type MediaStore } from '../services/storage.js';
import { setStorageFetch } from '../services/supabaseStorage.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { ACC, CAMPAIGN_ID, CAMPAIGN_META, objectRow, TENANT, installObjectsKit, type ObjectsKit } from '../services/ads/testing/objects/testDb.js';
import { adsRouter } from './ads.js';

type Role = 'viewer' | 'operator' | 'owner';

interface FakeRes { statusCode: number; body: any; status(code: number): FakeRes; json(payload: unknown): FakeRes; setHeader(): void; getHeader(): undefined }

async function call(method: string, url: string, opts: { role?: Role; body?: unknown; query?: Record<string, string> } = {}): Promise<FakeRes> {
    return new Promise((resolve, reject) => {
        const res: FakeRes = {
            statusCode: 200, body: undefined,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; resolve(this); return this; },
            setHeader() {}, getHeader() { return undefined; },
        };
        const req = {
            method, url, originalUrl: `/api/ads${url}`, baseUrl: '', path: url.split('?')[0], headers: {}, params: {}, query: opts.query ?? {}, body: opts.body ?? {},
            session: { userId: 'u1', role: 'user', tenantId: TENANT }, tenantRole: opts.role ?? 'owner',
        };
        (adsRouter as any)(req, res, (err?: unknown) => (err ? reject(err) : resolve({ ...res, statusCode: 404, body: { error: 'no route' } })));
    });
}

const BASE = 'https://msg-response-auto.vercel.app';
const IMG = 'e1111111-1111-4111-8111-111111111111';
const VID = 'e2222222-2222-4222-8222-222222222222';
const COVER = 'e3333333-3333-4333-8333-333333333333';
const VERT = 'e4444444-4444-4444-8444-444444444444';
const MIME: Record<string, string> = { [IMG]: 'image/jpeg', [VID]: 'video/mp4', [COVER]: 'image/jpeg', [VERT]: 'video/mp4' };

/** The store as Meta and the creative code see it; `get` counts reads so a test can prove a video's bytes are never read. */
function fakeStore(reads: string[]): MediaStore {
    return {
        async put() { throw new Error('not used'); },
        async get(id) { reads.push(id); return MIME[id] ? { id, mimeType: MIME[id]!, data: Buffer.from('jpeg-bytes') } as never : null; },
        async open() { return null; },
        async mimeTypes(ids) { return new Map(ids.filter((id) => MIME[id]).map((id) => [id, MIME[id]!])); },
        publicUrl: (id, origin) => `${origin}/api/uploads/${id}`,
    };
}

interface Posted { url: string; body: Record<string, string> }

describe('/api/ads full builder routes (A5)', () => {
    let kit: ObjectsKit;
    let posted: Posted[];
    let gets: Array<{ url: string; params: Record<string, string> }>;
    let reads: string[];
    let previousStore: MediaStore | null;
    let previousFetch: ReturnType<typeof setStorageFetch>;

    beforeEach(() => {
        kit = installObjectsKit();
        kit.configure({ maxDailyBudget: 20, monthlyCap: 100 });
        kit.settings.set('app.public_base_url', BASE);
        invalidateTenantCache();
        forgetMinimums();
        clearTargetingCache();
        posted = [];
        gets = [];
        reads = [];
        previousStore = setMediaStore(fakeStore(reads));
        previousFetch = null;
        kit.db.on(/FROM media_uploads WHERE id = \$1 AND creator_id = \$2/, (p) => ({ rows: p[1] === TENANT && MIME[p[0]] ? [{ mime_type: MIME[p[0]], size_bytes: 9 * 1024 * 1024 }] : [] }));
        kit.db.on(/FROM creators WHERE id = \$1/, () => ({ rows: [{ id: TENANT, instagram_page_id: '1784', facebook_page_id: '1001' }] }));
        kit.db.on(/FROM ai_agents WHERE creator_id = \$1/, () => ({ rows: [] }));
        kit.db.on(/FROM platform_connections WHERE creator_id = \$1 AND platform = 'whatsapp'/, () => ({ rows: [] }));
        (metaHttp as any).post = async (url: string, form: URLSearchParams) => {
            const body = Object.fromEntries(new URLSearchParams(String(form ?? '')));
            posted.push({ url, body });
            kit.meta.push({ method: 'POST', url });
            if (url.endsWith('/adimages')) return { data: { images: { 'bytes': { hash: 'hash-abc', url: 'https://x/i.jpg' } } }, headers: {} };
            if (url.endsWith('/advideos')) return { data: { id: '880001' }, headers: {} };
            return { data: { success: true }, headers: {} };
        };
        (metaHttp as any).get = async (url: string, cfg: { params?: Record<string, string> } = {}) => {
            gets.push({ url, params: cfg.params ?? {} });
            kit.meta.push({ method: 'GET', url });
            if (url.endsWith('/search')) return { data: { data: [{ id: '6003', name: 'Programming', audience_size_lower_bound: 1000, audience_size_upper_bound: 2000 }] }, headers: {} };
            if (url.endsWith('/minimum_budgets')) return { data: { data: [{ currency: 'USD', min_daily_budget_imp: 100 }] }, headers: {} };
            if (url.endsWith('/reachestimate')) return { data: { data: { users_lower_bound: 120000, users_upper_bound: 340000 } }, headers: {} };
            if (url.endsWith('/generatepreviews')) return { data: { data: [{ body: `<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?f=${cfg.params?.['ad_format']}"></iframe>` }] }, headers: {} };
            if (url.endsWith('/880001') || url.endsWith('/880002')) return { data: { status: { video_status: 'ready' } }, headers: {} };
            return { data: {}, headers: {} };
        };
    });
    afterEach(() => {
        kit.restore();
        setMediaStore(previousStore);
        setStorageFetch(previousFetch);
    });

    describe('POST /uploads/sign', () => {
        it('is the owner\'s only', async () => {
            for (const role of ['viewer', 'operator'] as const) {
                assert.equal((await call('POST', '/uploads/sign', { role, body: { filename: 'a.mp4', mime: 'video/mp4', size: 1000 } })).statusCode, 403, role);
            }
        });

        it('refuses a type or a size an ad cannot use, before signing', async () => {
            let res = await call('POST', '/uploads/sign', { body: { filename: 'a.gif', mime: 'image/gif', size: 1000 } });
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.field, 'mime');
            res = await call('POST', '/uploads/sign', { body: { filename: 'a.mp4', mime: 'video/mp4', size: 51 * 1024 * 1024 } });
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.field, 'size');
        });

        it('answers a signed Storage URL and a media id, for a video over Vercel\'s 4.5 MB limit', async () => {
            previousFetch = setStorageFetch(async (input) => {
                const path = new URL(String(input)).pathname.replace('/storage/v1', '');
                return new Response(JSON.stringify({ url: `${path}?token=signed` }), { status: 200, headers: { 'content-type': 'application/json' } });
            });
            setMediaStore(new SupabaseStorageMediaStore({ url: 'https://abcd1234.supabase.co', key: 'sb_secret_0123456789abcdefghijKLMNOP', source: { url: 'database', key: 'database' } }));
            const inserts: unknown[][] = [];
            kit.db.on(/^INSERT INTO media_uploads/, (p) => { inserts.push(p); return { rows: [] }; });
            const res = await call('POST', '/uploads/sign', { body: { filename: 'reel.mp4', mime: 'video/mp4', size: 12 * 1024 * 1024 } });
            assert.equal(res.statusCode, 201, JSON.stringify(res.body));
            assert.match(res.body.mediaId, /^[0-9a-f-]{36}$/);
            assert.equal(res.body.url, `${BASE}/api/uploads/${res.body.mediaId}`);
            assert.equal(res.body.upload.method, 'PUT');
            assert.match(res.body.upload.url, /token=signed/);
            assert.equal(inserts.length, 1);
        });
    });

    describe('POST /creatives/from-media', () => {
        it('an image: its bytes go to adimages, and the hash is remembered for the draft', async () => {
            const res = await call('POST', '/creatives/from-media', { body: { mediaId: IMG, kind: 'image' } });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            assert.equal(res.body.media.imageHash, 'hash-abc');
            assert.ok(posted[0]!.url.endsWith(`/act_${ACC}/adimages`));
            assert.equal(posted[0]!.body['bytes'], Buffer.from('jpeg-bytes').toString('base64'));
            assert.equal(JSON.parse(kit.settings.get(`ads.media.${TENANT}`)!)[IMG].imageHash, 'hash-abc');
        });

        it('a video: Meta pulls it from its public URL (file_url), its bytes are never read here, and the cover is required', async () => {
            const refused = await call('POST', '/creatives/from-media', { body: { mediaId: VID, kind: 'video' } });
            assert.equal(refused.statusCode, 400);
            assert.equal(refused.body.field, 'coverMediaId');
            assert.equal(posted.length, 0);
            const res = await call('POST', '/creatives/from-media', { body: { mediaId: VID, kind: 'video', coverMediaId: COVER } });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            assert.equal(res.body.media.videoId, '880001');
            assert.equal(res.body.media.coverUrl, `${BASE}/api/uploads/${COVER}`);
            assert.ok(posted[0]!.url.endsWith(`/act_${ACC}/advideos`));
            assert.equal(posted[0]!.body['file_url'], `${BASE}/api/uploads/${VID}`);
            assert.deepEqual(reads, [], 'a video is never buffered');
        });

        it('refuses another tenant\'s (or an unknown) upload, a mismatched kind, and a non-owner', async () => {
            assert.equal((await call('POST', '/creatives/from-media', { body: { mediaId: 'e9999999-9999-4999-8999-999999999999', kind: 'image' } })).statusCode, 404);
            assert.equal((await call('POST', '/creatives/from-media', { body: { mediaId: VID, kind: 'image' } })).statusCode, 400);
            assert.equal((await call('POST', '/creatives/from-media', { role: 'operator', body: { mediaId: IMG, kind: 'image' } })).statusCode, 403);
            assert.equal(posted.length, 0);
        });
    });

    describe('GET /targeting/search and /minimum-budgets', () => {
        it('searches Meta for the operator, once per query a day', async () => {
            const res = await call('GET', '/targeting/search', { role: 'operator', query: { type: 'adinterest', q: 'programming' } });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body.items, [{ id: '6003', name: 'Programming', type: 'adinterest', sizeLower: 1000, sizeUpper: 2000 }]);
            await call('GET', '/targeting/search', { role: 'operator', query: { type: 'adinterest', q: 'Programming ' } });
            assert.equal(gets.filter((g) => g.url.endsWith('/search')).length, 1);
            assert.equal((await call('GET', '/targeting/search', { role: 'viewer', query: { type: 'adinterest', q: 'x1' } })).statusCode, 403);
            assert.equal((await call('GET', '/targeting/search', { role: 'operator', query: { type: 'nope', q: 'abc' } })).statusCode, 400);
        });

        it('answers Meta\'s minimum per goal to any member', async () => {
            const res = await call('GET', '/minimum-budgets', { role: 'viewer' });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            assert.equal(res.body.byGoal.traffic, 1);
        });
    });

    describe('POST /objects/:id/duplicate', () => {
        it('enqueues one /copies write: PAUSED, renamed as a copy; Meta is called by the queue, not the request', async () => {
            kit.rows.push(objectRow({ status: 'ACTIVE', effectiveStatus: 'ACTIVE' }));
            const res = await call('POST', `/objects/${CAMPAIGN_ID}/duplicate`, { body: { deep: true } });
            assert.equal(res.statusCode, 202, JSON.stringify(res.body));
            assert.equal(kit.ops.length, 1);
            const exec = kit.ops[0]!.payload.exec as { path: string; params: Record<string, any> };
            assert.equal(exec.path, `${CAMPAIGN_META}/copies`);
            assert.equal(exec.params['status_option'], 'PAUSED');
            assert.equal(exec.params['deep_copy'], true);
            assert.match(exec.params['rename_options'].rename_suffix, /copy AR·/);
            assert.equal(kit.meta.length, 0);
            assert.equal((await call('POST', `/objects/${CAMPAIGN_ID}/duplicate`, { role: 'operator' })).statusCode, 403);
        });
    });

    describe('POST /drafts/validate with an uploaded video and its 9:16 version (the spec\'s Story 4)', () => {
        it('answers the reach estimate and a preview for the feed and Reels', async () => {
            kit.settings.set(`ads.media.${TENANT}`, JSON.stringify({
                [VID]: { kind: 'video', videoId: '880001', videoStatus: 'processing', at: '2026-10-22T10:00:00Z' },
                [VERT]: { kind: 'video', videoId: '880002', videoStatus: 'ready', at: '2026-10-22T10:00:00Z' },
            }));
            const start = new Date(Date.now() + 60_000);
            const spec = {
                name: 'Go course', goal: 'traffic', specialCategory: 'none',
                budget: { home: 'adset', kind: 'lifetime', amount: 25, start: start.toISOString(), end: new Date(start.getTime() + 5 * 86_400_000).toISOString() },
                adsets: [{ name: 'EG+SA', placements: { instagram: ['reels', 'story'] }, targeting: { countries: ['EG', 'SA'], ageMin: 22, ageMax: 45, advantageAudience: false } }],
                ads: [{ adsetIndex: 0, name: 'Video', copy: { primaryText: 'تعلّم Go', cta: 'LEARN_MORE' }, link: { url: 'https://example.com/go' }, creative: { source: 'media', mediaId: VID, coverMediaId: COVER, verticalMediaId: VERT } }],
            };
            const res = await call('POST', '/drafts/validate', { role: 'operator', body: { spec } });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body.problems, []);
            assert.equal(res.body.meta.ok, true, JSON.stringify(res.body.meta));
            assert.deepEqual(res.body.estimate, { lower: 120000, upper: 340000 });
            assert.deepEqual(res.body.previews.map((p: any) => [p.placement, p.frame, typeof p.html]), [['instagram_reels', '9:16', 'string']]);
            const creative = posted.find((p) => p.url.endsWith('/adcreatives'))!.body;
            assert.equal(JSON.parse(creative['asset_feed_spec']!).optimization_type, 'PLACEMENT');
            // The processing video was read once, found ready, and stored as ready.
            assert.equal(JSON.parse(kit.settings.get(`ads.media.${TENANT}`)!)[VID].videoStatus, 'ready');
        });

        it('a video Meta is still processing is a problem in Review, and nothing is sent to Meta', async () => {
            (metaHttp as any).get = async (url: string) => ({ data: url.endsWith('/880001') ? { status: { video_status: 'processing' } } : {}, headers: {} });
            kit.settings.set(`ads.media.${TENANT}`, JSON.stringify({ [VID]: { kind: 'video', videoId: '880001', videoStatus: 'processing', at: '2026-10-22T10:00:00Z' } }));
            const start = new Date(Date.now() + 60_000);
            const spec = {
                name: 'Go', goal: 'traffic', specialCategory: 'none',
                budget: { home: 'adset', kind: 'lifetime', amount: 25, start: start.toISOString(), end: new Date(start.getTime() + 5 * 86_400_000).toISOString() },
                adsets: [{ name: 'EG', placements: 'automatic', targeting: { countries: ['EG'], ageMin: 18, advantageAudience: true } }],
                ads: [{ adsetIndex: 0, name: 'V', copy: { primaryText: 'x', cta: 'LEARN_MORE' }, link: { url: 'https://example.com/go' }, creative: { source: 'media', mediaId: VID, coverMediaId: COVER } }],
            };
            const res = await call('POST', '/drafts/validate', { role: 'operator', body: { spec } });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            assert.match(res.body.problems[0].message, /still processing/);
            assert.equal(posted.length, 0);
        });
    });
});
