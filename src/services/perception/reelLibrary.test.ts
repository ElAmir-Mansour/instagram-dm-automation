/**
 * The video memory's library and its queue (`reelLibrary.ts`, docs/specs/005-muse-sees T054): the owner's own reels listed from Instagram, a `pending` row and ONE
 * `muse.reel_index` job for each reel that has no `ok` row, once a day, and the daily run for the tenants that switched the memory on. Against the in-memory world of
 * `testing/testSupport.ts` (the table's statements were first run on a real PostgreSQL 17 holding migration v60's table). What is pinned:
 *
 *   - **dedupe by day**: the key is `reel:<id>:<yyyy-mm-dd>` (UTC), so a reel is queued once a day however often the queue is asked, and a reel that failed is queued
 *     again tomorrow; a re-index the owner asks for has a per-minute key of its own, so it is not swallowed by today's;
 *   - **new reels only**: a reel with an `ok` row is never queued again, a `failed` or `pending` one is, and the daily run asks only the tenants whose `memory` switch is on;
 *   - **nothing but ids in a job**, and no media link anywhere;
 *   - **the listing**: videos only (reels and feed videos), paged, bounded, the credential in a header;
 *   - **the table**: readers never cross tenants, and every row goes with its tenant.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
    findByMediaId, getLibraryRow, graphProblem, isMediaId, isRowId, linkYouTubeSiblings, listLibrary, listOkForRecall, listPublishedReels, MAX_LIST_PAGES, queueNewReelsForMemoryTenants, queueOneReel, queueReels,
    REEL_JOB_ATTEMPTS, REEL_LIST_FIELDS, reelJobKey, reelRedoKey, reelRouteReady, storeAnalysis, upsertPending, youtubeLinksFor, youtubeWatchUrl,
} from './reelLibrary.js';
import {
    configure, graphError, graphUnreachable, IG_USER, installWorld, OTHER_TENANT, PAGE_TOKEN, TENANT, type World,
} from './testing/testSupport.js';
import { GraphSession } from '../growth/graph.js';

let world: World;
let savedKey: string | undefined;
beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    world = installWorld();
});
afterEach(() => {
    world.restore();
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

const NOV1 = () => new Date('2026-11-01T09:00:00.000Z');
const media = (id: string, over: Record<string, unknown> = {}) => ({ id, media_type: 'VIDEO', media_product_type: 'REELS', permalink: `https://www.instagram.com/reel/${id}/`, timestamp: '2026-10-20T12:00:00+0000', ...over });
const row = (id: string) => world.reel.reels.find((r) => r.creator_id === TENANT && r.ig_media_id === id);
const jobs = () => world.queue.enqueued;
const ok = (id: string) => storeAnalysis(TENANT, id, { permalink: null, postedAt: null, youtubeUrl: null, result: { summary: 'S', topics: ['t'] }, model: 'muse-spark-1.3', ms: 1000, usd: 0.02 });

describe('the dedupe keys', () => {
    it('is one job per reel per UTC day: reel:<id>:<yyyy-mm-dd>, changing at midnight UTC and not before', () => {
        assert.equal(reelJobKey('9001', new Date('2026-11-01T00:00:00.000Z')), 'reel:9001:2026-11-01');
        assert.equal(reelJobKey('9001', new Date('2026-11-01T23:59:59.999Z')), 'reel:9001:2026-11-01');
        assert.equal(reelJobKey('9001', new Date('2026-11-02T00:00:00.000Z')), 'reel:9001:2026-11-02');
        assert.notEqual(reelJobKey('9001', NOV1()), reelJobKey('9002', NOV1()));
    });

    it('has a re-index its own key, per minute: it is never the daily key, so a press after today\'s analysis is not swallowed, and a double click is one job', () => {
        assert.equal(reelRedoKey('9001', new Date('2026-11-01T09:05:33.000Z')), 'reel:9001:2026-11-01:redo:0905');
        assert.equal(reelRedoKey('9001', new Date('2026-11-01T09:05:59.999Z')), 'reel:9001:2026-11-01:redo:0905');
        assert.equal(reelRedoKey('9001', new Date('2026-11-01T09:06:00.000Z')), 'reel:9001:2026-11-01:redo:0906');
        assert.notEqual(reelRedoKey('9001', NOV1()), reelJobKey('9001', NOV1()));
    });

    it('is tried up to three times by the runner', () => {
        assert.equal(REEL_JOB_ATTEMPTS, 3);
    });
});

describe('listing the owner\'s published reels', () => {
    const graph = () => new GraphSession(PAGE_TOKEN);

    it('keeps the videos, reels and feed videos alike, and nothing else: an image, a carousel and an id that is not one have nothing to watch', async () => {
        world.graph.pages.push({ data: [
            media('1'), media('2', { media_product_type: 'FEED' }), media('3', { media_type: 'IMAGE' }), media('4', { media_type: 'CAROUSEL_ALBUM' }),
            media('5', { media_type: 'VIDEO', id: '../etc' }), media('6', { id: undefined }), media('7', { permalink: '  ' , timestamp: 'not a date' }),
        ] });
        const { reels, truncated } = await listPublishedReels(graph(), IG_USER);
        assert.deepEqual(reels.map((r) => [r.igMediaId, r.productType]), [['1', 'REELS'], ['2', 'FEED'], ['7', 'REELS']]);
        assert.deepEqual([reels[0]!.permalink, reels[0]!.postedAt], ['https://www.instagram.com/reel/1/', '2026-10-20T12:00:00.000Z']);
        assert.deepEqual([reels[2]!.permalink, reels[2]!.postedAt], [null, null]);
        assert.equal(truncated, false);
    });

    it('asks for no link to the video and no caption, one page at a time, the credential in a header and never in the query', async () => {
        world.graph.pages.push({ data: [media('1')] });
        await listPublishedReels(graph(), IG_USER);
        assert.equal(REEL_LIST_FIELDS, 'id,media_type,media_product_type,permalink,timestamp');
        assert.doesNotMatch(REEL_LIST_FIELDS, /media_url|caption|thumbnail/);
        assert.deepEqual(world.graph.calls.map((c) => c.path), [`${IG_USER}/media`]);
        assert.deepEqual(world.graph.calls[0]!.params, { fields: REEL_LIST_FIELDS, limit: 50 });
        assert.equal(world.graph.calls[0]!.headers['Authorization'], `Bearer ${PAGE_TOKEN}`);
        assert.ok(!JSON.stringify(world.graph.calls[0]!.params).includes(PAGE_TOKEN));
    });

    it('follows the cursor to the next page, and stops when Meta gives no next one', async () => {
        world.graph.pages.push({ data: [media('1'), media('2')], after: 'CURSOR-1' }, { data: [media('3')] });
        const { reels } = await listPublishedReels(graph(), IG_USER);
        assert.deepEqual(reels.map((r) => r.igMediaId), ['1', '2', '3']);
        assert.deepEqual(world.graph.calls.map((c) => c.params['after']), [undefined, 'CURSOR-1']);
    });

    it('is bounded: six pages and no more, and it says the history was cut', async () => {
        for (let i = 0; i < MAX_LIST_PAGES + 2; i++) world.graph.pages.push({ data: [media(String(i))], after: `C${i}` });
        const { reels, truncated } = await listPublishedReels(graph(), IG_USER);
        assert.equal(reels.length, MAX_LIST_PAGES);
        assert.equal(world.graph.calls.length, MAX_LIST_PAGES);
        assert.equal(truncated, true);
    });

    it('throws what the Graph call throws, for the caller to turn into a reason', async () => {
        world.graph.pages.push(graphError(400, 190, 463));
        await assert.rejects(listPublishedReels(graph(), IG_USER));
    });

    it('turns a failed Graph call into a reason that never carries Meta\'s message: a dead credential and a missing media are final, an unreachable Meta is not', () => {
        for (const [err, reason, retryable] of [
            [graphError(400, 190), 'graph_auth', false], [graphError(404, 100), 'not_found', false], [graphError(400, 21), 'not_found', false], [graphError(403, 200), 'graph_failed', false],
            [graphError(500, 1), 'graph_unavailable', true], [graphError(429, 4), 'graph_unavailable', true], [graphUnreachable(), 'graph_unavailable', true], [new Error('weird'), 'graph_unavailable', true],
        ] as const) {
            assert.deepEqual(graphProblem(err), { reason, retryable }, reason);
        }
    });
});

describe('queueing the reels that have no analysis yet', () => {
    it('writes a pending row and queues one job for each, with the reel\'s page and date, the day\'s dedupe key, three attempts, and nothing but ids in the payload', async () => {
        world.graph.pages.push({ data: [media('9001'), media('9002', { timestamp: '2026-10-25T08:00:00+0000' })] });
        const r = await queueReels(TENANT, { now: NOV1 });
        assert.deepEqual(r, { ok: true, listed: 2, queued: 2, kept: 0, deduped: 0, truncated: false });
        assert.deepEqual(world.reel.reels.map((x) => [x.ig_media_id, x.status, x.permalink]), [['9001', 'pending', 'https://www.instagram.com/reel/9001/'], ['9002', 'pending', 'https://www.instagram.com/reel/9002/']]);
        assert.deepEqual(jobs().map((j) => [j.kind, j.dedupeKey, j.maxAttempts, j.creatorId, JSON.stringify(j.payload)]), [
            ['muse.reel_index', 'reel:9001:2026-11-01', 3, TENANT, JSON.stringify({ creatorId: TENANT, igMediaId: '9001' })],
            ['muse.reel_index', 'reel:9002:2026-11-01', 3, TENANT, JSON.stringify({ creatorId: TENANT, igMediaId: '9002' })],
        ]);
        const everything = JSON.stringify([jobs(), world.reel.statements, world.logs]);
        assert.ok(!everything.includes('media_url') && !everything.includes('cdninstagram') && !everything.includes(PAGE_TOKEN), 'no link to a video and no credential in a job, a statement or a log line');
        assert.deepEqual(world.logs.filter((l) => l.event === 'muse.reel_queue').map((l) => [l['listed'], l['queued'], l['kept']]), [[2, 2, 0]]);
    });

    it('queues NEW reels only: a reel with an ok row is kept and never queued again, a failed one and a pending one are', async () => {
        await ok('9001');
        await upsertPending(TENANT, [{ igMediaId: '9002', permalink: null, postedAt: null }, { igMediaId: '9003', permalink: null, postedAt: null }]);
        row('9003')!.status = 'failed';
        row('9003')!.result = { error: 'timeout' };
        world.graph.pages.push({ data: [media('9001'), media('9002'), media('9003'), media('9004')] });
        const r = await queueReels(TENANT, { now: NOV1 });
        assert.deepEqual(r, { ok: true, listed: 4, queued: 3, kept: 1, deduped: 0, truncated: false });
        assert.deepEqual(jobs().map((j) => (j.payload as { igMediaId: string }).igMediaId), ['9002', '9003', '9004']);
        assert.deepEqual(world.reel.reels.map((x) => [x.ig_media_id, x.status]), [['9001', 'ok'], ['9002', 'pending'], ['9003', 'pending'], ['9004', 'pending']], 'the failed one reads as queued again; the ok one is as it was');
        assert.equal(row('9001')!.model, 'muse-spark-1.3');
    });

    it('queues a reel once a day however often it is asked, and again tomorrow if it still has no ok row', async () => {
        const page = () => world.graph.pages.push({ data: [media('9001'), media('9002')] });
        page();
        assert.equal((await queueReels(TENANT, { now: NOV1 }) as { queued: number }).queued, 2);
        page();
        assert.deepEqual(await queueReels(TENANT, { now: () => new Date('2026-11-01T23:59:59Z') }), { ok: true, listed: 2, queued: 0, kept: 0, deduped: 2, truncated: false });
        assert.equal(jobs().length, 2, 'the same day: no second job, whatever state the first is in');
        // Tomorrow: 9001 got its analysis, 9002 failed. Only the failed one is queued.
        await ok('9001');
        row('9002')!.status = 'failed';
        page();
        const tomorrow = await queueReels(TENANT, { now: () => new Date('2026-11-02T00:00:05Z') });
        assert.deepEqual(tomorrow, { ok: true, listed: 2, queued: 1, kept: 1, deduped: 0, truncated: false });
        assert.deepEqual(jobs().map((j) => j.dedupeKey), ['reel:9001:2026-11-01', 'reel:9002:2026-11-01', 'reel:9002:2026-11-02']);
    });

    it('lists only the tenant\'s own reels and writes only its own rows: another tenant\'s analysis does not make a reel "kept"', async () => {
        await storeAnalysis(OTHER_TENANT, '9001', { permalink: null, postedAt: null, youtubeUrl: null, result: { summary: 'S', topics: ['t'] }, model: 'm', ms: 1, usd: 0 });
        world.graph.pages.push({ data: [media('9001')] });
        const r = await queueReels(TENANT, { now: NOV1 });
        assert.deepEqual([(r as { queued: number }).queued, (r as { kept: number }).kept], [1, 0]);
        assert.deepEqual(world.reel.reels.map((x) => [x.creator_id, x.ig_media_id, x.status]), [[OTHER_TENANT, '9001', 'ok'], [TENANT, '9001', 'pending']]);
    });

    it('says why it queued nothing, and writes nothing: no Meta connection, or Meta not answering', async () => {
        world.reel.creators.get(TENANT)!.page_access_token = null;
        assert.deepEqual(await queueReels(TENANT, { now: NOV1 }), { ok: false, reason: 'not_connected' });
        world.reel.creators.get(TENANT)!.page_access_token = PAGE_TOKEN;
        world.reel.creators.get(TENANT)!.instagram_page_id = null;
        assert.deepEqual(await queueReels(TENANT, { now: NOV1 }), { ok: false, reason: 'not_connected' });
        world.reel.creators.get(TENANT)!.instagram_page_id = IG_USER;
        for (const [err, reason] of [[graphError(400, 190), 'graph_auth'], [graphError(500, 1), 'graph_unavailable'], [graphError(403, 200), 'graph_failed']] as const) {
            world.graph.pages.push(err);
            assert.deepEqual(await queueReels(TENANT, { now: NOV1 }), { ok: false, reason });
        }
        assert.equal(world.reel.reels.length, 0);
        assert.equal(jobs().length, 0);
        // Logged the way every Graph failure in this codebase is (`describeError`): Meta's own code and message, for the owner to read; never a credential or a link.
        const listed = world.logs.filter((l) => l.event === 'muse.reel_list_failed');
        assert.deepEqual(listed.map((l) => l['reason']), ['graph_auth', 'graph_unavailable', 'graph_failed']);
        assert.deepEqual([listed[0]!['meta_code'], listed[2]!['meta_code']], [190, 200]);
        assert.ok(!JSON.stringify(world.logs).includes(PAGE_TOKEN));
    });

    it('says the history was cut when there were more reels than it lists', async () => {
        for (let i = 0; i < MAX_LIST_PAGES + 1; i++) world.graph.pages.push({ data: [media(String(100 + i))], after: `C${i}` });
        const r = await queueReels(TENANT, { now: NOV1 });
        assert.deepEqual([(r as { listed: number }).listed, (r as { truncated: boolean }).truncated], [MAX_LIST_PAGES, true]);
    });

    it('links a reel to its YouTube copy while it queues, with no model: a sibling published after the reel was watched is found', async () => {
        await ok('9001');
        const G = '33333333-3333-4333-8333-333333333333';
        world.reel.scheduled.push(
            { creator_id: TENANT, platform: 'both', status: 'PUBLISHED', published_post_id: 'FB:222 | IG:9001', group_id: G, scheduled_time: new Date('2026-10-20T12:00:00Z') },
            { creator_id: TENANT, platform: 'youtube', status: 'PUBLISHED', published_post_id: 'YT:AbCdEfGhIjK', group_id: G, scheduled_time: new Date('2026-10-21T12:00:00Z') },
        );
        world.graph.pages.push({ data: [media('9001')] });
        await queueReels(TENANT, { now: NOV1 });
        assert.equal(row('9001')!.youtube_url, 'https://www.youtube.com/watch?v=AbCdEfGhIjK');
        assert.equal(await linkYouTubeSiblings(TENANT), 0, 'once is enough');
    });
});

describe('a re-index the owner asked for', () => {
    it('is queued with its own key, per minute: not swallowed by today\'s job, and a double click is one job', async () => {
        world.graph.pages.push({ data: [media('9001')] });
        await queueReels(TENANT, { now: NOV1 });
        assert.equal(await queueOneReel(TENANT, '9001', { now: () => new Date('2026-11-01T09:05:10Z') }), true);
        assert.equal(await queueOneReel(TENANT, '9001', { now: () => new Date('2026-11-01T09:05:50Z') }), false, 'the same minute');
        assert.equal(await queueOneReel(TENANT, '9001', { now: () => new Date('2026-11-01T09:06:00Z') }), true, 'the next minute');
        assert.deepEqual(jobs().map((j) => j.dedupeKey), ['reel:9001:2026-11-01', 'reel:9001:2026-11-01:redo:0905', 'reel:9001:2026-11-01:redo:0906']);
        assert.deepEqual(jobs().map((j) => j.maxAttempts), [3, 3, 3]);
    });
});

describe('the daily run for the tenants that switched the memory on', () => {
    const second = '66666666-6666-4666-8666-666666666666';
    const third = '77777777-7777-4777-8777-777777777777';
    const addTenant = (id: string, over: Partial<{ is_active: boolean; page_access_token: string | null }> = {}) =>
        world.reel.creators.set(id, { id, instagram_page_id: IG_USER, page_access_token: PAGE_TOKEN, is_active: true, ...over });

    it('asks only the tenants whose memory switch is on: one with it off costs a settings read and no Graph call, and the owner\'s own default is off', async () => {
        configure(world, { memory: false, route: 'baseten' });
        const none = await queueNewReelsForMemoryTenants({ now: NOV1 });
        assert.deepEqual(none, { tenants: 1, memoryOn: 0, queued: 0, kept: 0, skipped: 0, failed: 0 });
        assert.equal(world.graph.calls.length, 0);
        configure(world, { route: 'baseten' });
        world.graph.pages.push({ data: [media('9001'), media('9002')] });
        const some = await queueNewReelsForMemoryTenants({ now: NOV1 });
        assert.deepEqual(some, { tenants: 1, memoryOn: 1, queued: 2, kept: 0, skipped: 0, failed: 0 });
        assert.equal(jobs().length, 2);
    });

    it('queues only what is new: reels with an ok row are kept, and tomorrow\'s run queues the failed one again and nothing else', async () => {
        configure(world, { route: 'baseten' });
        await ok('9001');
        world.graph.pages.push({ data: [media('9001'), media('9002')] });
        assert.equal((await queueNewReelsForMemoryTenants({ now: NOV1 })).queued, 1);
        row('9002')!.status = 'failed';
        world.graph.pages.push({ data: [media('9001'), media('9002'), media('9003')] });
        const next = await queueNewReelsForMemoryTenants({ now: () => new Date('2026-11-02T00:00:09Z') });
        assert.deepEqual([next.queued, next.kept], [2, 1]);
        assert.deepEqual(jobs().map((j) => j.dedupeKey), ['reel:9002:2026-11-01', 'reel:9002:2026-11-02', 'reel:9003:2026-11-02']);
    });

    it('skips a tenant with no route that can answer, with no Graph call and no job, and says so', async () => {
        configure(world, { route: 'baseten', keys: ['meta'] });
        const r = await queueNewReelsForMemoryTenants({ now: NOV1 });
        assert.deepEqual(r, { tenants: 1, memoryOn: 1, queued: 0, kept: 0, skipped: 1, failed: 0 });
        assert.equal(world.graph.calls.length, 0);
        assert.deepEqual(world.logs.filter((l) => l.event === 'muse.reel_queue_skipped').map((l) => l['reason']), ['no_key']);
    });

    it('is not stopped by one tenant failing: it counts it, logs it with no message of Meta\'s, and goes on to the next', async () => {
        configure(world, { route: 'baseten' });
        addTenant(second);
        addTenant(third);
        for (const t of [second, third]) world.ai.setSetting(`muse.switches.${t}`, JSON.stringify({ memory: true }));
        world.reel.failOn(/^SELECT ig_media_id, status FROM reel_analyses/, new Error('connection terminated'), 1);
        world.graph.pages.push({ data: [media('8001')] }, { data: [media('8002')] }, { data: [media('8003')] });
        const r = await queueNewReelsForMemoryTenants({ now: NOV1 });
        assert.deepEqual([r.tenants, r.memoryOn, r.failed, r.queued], [3, 3, 1, 2]);
        assert.equal(world.logs.filter((l) => l.event === 'muse.reel_queue_tenant_failed').length, 1);
    });

    it('looks only at active tenants with a Meta connection', async () => {
        configure(world, { route: 'baseten' });
        addTenant(second, { is_active: false });
        addTenant(third, { page_access_token: null });
        const r = await queueNewReelsForMemoryTenants({ now: NOV1 });
        assert.equal(r.tenants, 1);
    });

    it('stops for time at its budget, and says so', async () => {
        configure(world, { route: 'baseten' });
        const r = await queueNewReelsForMemoryTenants({ now: NOV1, budgetMs: -1 });
        assert.equal(r.memoryOn, 0);
        assert.equal(world.logs.filter((l) => l.event === 'muse.reel_queue_budget_spent').length, 1);
    });

    it('asks the providers layer for the reel indexer\'s route, and only "no provider" is a no', async () => {
        configure(world, { route: 'baseten' });
        assert.equal(await reelRouteReady(TENANT), true);
        world.ai.settings.delete('ai.providers.baseten.api_key');
        assert.equal(await reelRouteReady(TENANT), false);
    });
});

describe('the table\'s readers', () => {
    it('lists the owner\'s reels newest first, undated last, with the summary and hook score read out of the result and the reason a failed one failed', async () => {
        await upsertPending(TENANT, [
            { igMediaId: '1', permalink: 'https://www.instagram.com/reel/1/', postedAt: '2026-10-01T00:00:00.000Z' },
            { igMediaId: '2', permalink: null, postedAt: '2026-10-10T00:00:00.000Z' },
            { igMediaId: '3', permalink: null, postedAt: null },
            { igMediaId: '4', permalink: null, postedAt: '2026-09-01T00:00:00.000Z' },
        ]);
        await storeAnalysis(TENANT, '1', { permalink: null, postedAt: null, youtubeUrl: null, result: { summary: 'A reel', hook_score: 8 }, model: 'muse-spark-1.3', ms: 1, usd: 0.02 });
        row('2')!.status = 'failed';
        row('2')!.result = { error: 'too_large' };
        const list = await listLibrary(TENANT);
        assert.deepEqual(list.map((r) => [r.ig_media_id, r.status, r.summary, r.hook_score, r.error]), [
            ['2', 'failed', null, null, 'too_large'], ['1', 'ok', 'A reel', 8, null], ['4', 'pending', null, null, null], ['3', 'pending', null, null, null],
        ]);
        assert.deepEqual(Object.keys(list[0]!).sort(), ['error', 'hook_score', 'id', 'ig_media_id', 'model', 'permalink', 'posted_at', 'status', 'summary', 'updated_at', 'usd', 'youtube_url']);
        assert.equal(list[1]!.usd, 0.02);
        assert.equal(list[1]!.posted_at, '2026-10-01T00:00:00.000Z');
    });

    it('never reads across tenants: one tenant\'s list, row, lookup by media id and recall library are its own', async () => {
        await ok('9001');
        await storeAnalysis(OTHER_TENANT, '9001', { permalink: null, postedAt: null, youtubeUrl: null, result: { summary: 'OTHER', topics: ['t'] }, model: 'm', ms: 1, usd: 0 });
        const mine = (await listLibrary(TENANT)).map((r) => r.summary);
        assert.deepEqual(mine, ['S']);
        const id = row('9001')!.id;
        assert.equal((await getLibraryRow(TENANT, id))!.ig_media_id, '9001');
        assert.equal(await getLibraryRow(OTHER_TENANT, id), null);
        assert.equal((await findByMediaId(OTHER_TENANT, '9001'))!.result['summary'], 'OTHER');
        assert.deepEqual((await listOkForRecall(TENANT)).map((r) => r.result['summary']), ['S']);
        for (const sql of world.reel.statements.map((s) => s.sql).filter((s) => /FROM reel_analyses/.test(s))) assert.match(sql, /creator_id = \$1/, 'every statement names the tenant');
    });

    it('answers a reel the agent was sent by its media id: the row, or null for a reel with none and for an id that cannot be one', async () => {
        await ok('9001');
        assert.equal((await findByMediaId(TENANT, '9001'))!.status, 'ok');
        assert.equal(await findByMediaId(TENANT, '9999'), null);
        assert.equal(await findByMediaId(TENANT, '../9001'), null);
        assert.equal(world.reel.statements.filter((s) => /ig_media_id = \$2/.test(s.sql)).length, 2, 'a malformed id is refused before a statement');
    });

    it('gives recall the reels that were watched and understood, newest first, and none that are pending or failed', async () => {
        await upsertPending(TENANT, [{ igMediaId: '1', permalink: null, postedAt: '2026-10-01T00:00:00.000Z' }, { igMediaId: '2', permalink: null, postedAt: '2026-10-05T00:00:00.000Z' }, { igMediaId: '3', permalink: null, postedAt: '2026-10-09T00:00:00.000Z' }]);
        await ok('1');
        await ok('3');
        row('2')!.status = 'failed';
        const library = await listOkForRecall(TENANT);
        assert.deepEqual(library.map((r) => r.ig_media_id), ['3', '1']);
        assert.deepEqual(Object.keys(library[0]!).sort(), ['created_at', 'creator_id', 'id', 'ig_media_id', 'model', 'ms', 'permalink', 'posted_at', 'result', 'status', 'updated_at', 'usd', 'youtube_url']);
    });

    it('takes an id as a uuid and a media id as letters, digits, underscore and dash, and nothing else', () => {
        assert.equal(isRowId('00000000-0000-4000-8000-000000000001'), true);
        for (const bad of ['', 'abc', '00000000-0000-4000-8000-00000000000g', null, 42, '00000000-0000-4000-8000-000000000001; DROP']) assert.equal(isRowId(bad), false, String(bad));
        for (const good of ['17895695668004550', 'a_b-C9']) assert.equal(isMediaId(good), true, good);
        for (const bad of ['', '../x', 'a b', 'a/b', 'a?b', 'x'.repeat(129), null, 5]) assert.equal(isMediaId(bad), false, String(bad));
    });
});

describe('the YouTube sibling', () => {
    const G1 = '33333333-3333-4333-8333-333333333333';
    const G2 = '44444444-4444-4444-8444-444444444444';
    const at = (d: string) => new Date(d);

    it('is the PUBLISHED youtube row of the same group_id as the Meta row that holds IG:<media id>, for this tenant only, newest upload first', async () => {
        world.reel.scheduled.push(
            { creator_id: TENANT, platform: 'both', status: 'PUBLISHED', published_post_id: 'FB:111 | IG:100', group_id: G1, scheduled_time: at('2026-10-01T00:00:00Z') },
            { creator_id: TENANT, platform: 'youtube', status: 'PUBLISHED', published_post_id: 'YT:OlderUpload1', group_id: G1, scheduled_time: at('2026-10-01T00:00:00Z') },
            { creator_id: TENANT, platform: 'youtube', status: 'PUBLISHED', published_post_id: 'YT:NewerUpload2', group_id: G1, scheduled_time: at('2026-10-02T00:00:00Z') },
            { creator_id: TENANT, platform: 'instagram', status: 'PUBLISHED', published_post_id: 'IG:102', group_id: G2, scheduled_time: at('2026-10-03T00:00:00Z') },
            { creator_id: TENANT, platform: 'youtube', status: 'FAILED', published_post_id: 'YT:NeverUploaded', group_id: G2, scheduled_time: at('2026-10-03T00:00:00Z') },
            { creator_id: TENANT, platform: 'instagram', status: 'PUBLISHED', published_post_id: 'IG:555', group_id: null, scheduled_time: at('2026-10-04T00:00:00Z') },
            { creator_id: OTHER_TENANT, platform: 'both', status: 'PUBLISHED', published_post_id: 'FB:1 | IG:101', group_id: G1, scheduled_time: at('2026-10-05T00:00:00Z') },
        );
        assert.deepEqual([...await youtubeLinksFor(TENANT)], [['100', 'https://www.youtube.com/watch?v=NewerUpload2']]);
        assert.deepEqual([...await youtubeLinksFor(OTHER_TENANT)], [], 'another tenant\'s Instagram row does not borrow this tenant\'s YouTube upload');
        assert.equal(youtubeWatchUrl('AbCdEfGhIjK'), 'https://www.youtube.com/watch?v=AbCdEfGhIjK');
    });

    it('ignores a YouTube id that is not one, and a row with no group', async () => {
        world.reel.scheduled.push(
            { creator_id: TENANT, platform: 'both', status: 'PUBLISHED', published_post_id: 'IG:100', group_id: G1, scheduled_time: at('2026-10-01T00:00:00Z') },
            { creator_id: TENANT, platform: 'youtube', status: 'PUBLISHED', published_post_id: 'YT:bad id/../', group_id: G1, scheduled_time: at('2026-10-01T00:00:00Z') },
        );
        assert.deepEqual([...await youtubeLinksFor(TENANT)], []);
    });
});

describe('the retention claim: the library goes with the creator, and holds no media', () => {
    const sql = readFileSync(new URL('../../config/migration_v60_muse_perception.sql', import.meta.url), 'utf8');
    const table = /CREATE TABLE IF NOT EXISTS reel_analyses \(([\s\S]*?)\n\);/.exec(sql)![1]!;

    it('is keyed by the tenant with ON DELETE CASCADE, so deleting a creator deletes every one of its rows, and row level security is on', () => {
        assert.match(table, /creator_id\s+UUID NOT NULL REFERENCES creators\(id\) ON DELETE CASCADE/);
        assert.match(sql, /ALTER TABLE reel_analyses ENABLE ROW LEVEL SECURITY/);
    });

    it('has no column that could hold a video, a picture or a link to one: an analysis, a model, a time and a cost', () => {
        const columns = [...table.matchAll(/^\s{4}([a-z_]+)\s/gm)].map((m) => m[1]);
        assert.deepEqual(columns, ['id', 'creator_id', 'ig_media_id', 'permalink', 'youtube_url', 'posted_at', 'status', 'result', 'model', 'ms', 'usd', 'created_at', 'updated_at']);
        assert.doesNotMatch(table, /BYTEA|media_url|thumbnail|storage_path/i);
    });
});
