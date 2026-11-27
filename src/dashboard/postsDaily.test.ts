/**
 * The Scheduler's daily-work fixes (UX U1, audit DW-S1 and DW-S2).
 *
 *   - **"Needs you" comes first** (S1): failed, held and overdue posts, and a TikTok draft left in the creator's inbox for 3 days or more
 *     (the same number the server's Today item uses: `TIKTOK_DRAFT_DAYS`), are one group ABOVE Upcoming and Done; `#/posts?filter=needs-you`
 *     (the link the server sends) opens the queue on it, scrolls there and focuses its heading, once per address; with nothing in it the owner is told.
 *   - **The queue is drawn first** (S2): `render()` asks for the queue, the TikTok connection and the settings, never for `/posts/live`
 *     (Meta, ~3 s); the Published feed is read the first time it is opened, once per render, and a failure is an error panel with Retry.
 *     What the page already did about polling and video downloads still holds: the 15 s repaint only while a row is in flight, none for a draft in flight
 *     for over 2 days, `FREQUENT_SWEEP`, and `preload="none"` on a card's video (PR #302).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TIKTOK_DRAFT_DAYS } from '../services/attention.js';
import { loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
const post = (over: Json = {}): Json => ({
    id: 'p1', platform: 'instagram', post_type: 'image', status: 'PENDING', caption: 'hello', media_url: null, cover_url: null,
    scheduled_time: at(DAY), error_log: null, archived_at: null, ...over,
});

interface Rig {
    h: Dashboard;
    P: Json;
    calls: string[];
    toasts: string[];
    /** The queue the next `GET /posts/scheduled` answers. */
    queue: { posts: Json[] };
    /** Hold `GET /posts/live` until released; resolves with `live.posts`, or fails when `live.error` is set. */
    live: { posts: Json[]; error: Error | null; hold: boolean; release: () => void };
    heading: { scrolled: unknown[]; present: (on: boolean) => void };
    container: Json;
}

function load(lang: 'ar' | 'en' = 'en', hash = ''): Rig {
    const calls: string[] = [];
    const queue = { posts: [] as Json[] };
    let releaseLive: () => void = () => undefined;
    const live: Rig['live'] = { posts: [], error: null, hold: false, release: () => releaseLive() };
    const api: Json = {
        token: 'tok',
        getScheduledPosts: () => { calls.push('scheduled'); return Promise.resolve(JSON.parse(JSON.stringify(queue.posts))); },
        getLivePosts: () => {
            calls.push('live');
            const answer = () => (live.error ? Promise.reject(live.error) : Promise.resolve(JSON.parse(JSON.stringify(live.posts))));
            if (!live.hold) return answer();
            return new Promise((resolve) => { releaseLive = () => resolve(answer()); });
        },
        getTikTokConnection: () => Promise.resolve(null),
        getStudioSettings: () => Promise.resolve({ settings: { schedule: { timezone: 'Asia/Kuwait' } } }),
    };
    const Admin = { emptyState: (_icon: string, title: string, body: string) => `<div class="empty">${title} ${body}</div>`, confirm: () => {} };
    const holder: { h?: Dashboard } = {};
    const App = {
        canOperate: () => true,
        hashParam: (name: string) => new URLSearchParams(String(holder.h!.location.hash).split('?')[1] ?? '').get(name) ?? '',
    };
    const h = loadDashboard({
        lang, hash, files: ['dashboard/js/pages/posts.js'],
        globals: { API: new Proxy(api, { get: (t, p) => (p in t ? t[p as string] : () => Promise.reject(new Error(`API.${String(p)} is not stubbed`))) }), Admin, App },
    });
    holder.h = h;
    const P = h.run('PostsPage');
    const toasts: string[] = [];
    h.UI.toast = (message: unknown) => { toasts.push(String(message)); return null; };
    const container = h.el('page-container');
    const scrolled: unknown[] = [];
    const heading = {
        scrolled,
        present: (on: boolean) => {
            if (!on) { h.dom.delete('posts-group-attention-title'); return; }
            const el = h.el('posts-group-attention-title') as Json;
            el.scrollIntoView = (arg: unknown) => { scrolled.push(arg); };
        },
    };
    return { h, P, calls, toasts, queue, live, heading, container };
}

/** Run a full render over `posts` and let it finish. */
async function open(r: Rig, posts: Json[]): Promise<void> {
    r.queue.posts = posts;
    r.P.resetTenantState();
    await r.P.render();
    await settle();
}

const html = (r: Rig): string => String(r.container.innerHTML);
const FAILED = post({ id: 'failed', status: 'FAILED', error_log: 'boom' });
const OVERDUE = post({ id: 'overdue', scheduled_time: at(-2 * HOUR) });
const HELD = post({ id: 'held', error_log: 'five a day', scheduled_time: at(2 * DAY) });
const LATER = post({ id: 'later', scheduled_time: at(3 * DAY) });
const DONE = post({ id: 'done', status: 'PUBLISHED', scheduled_time: at(-3 * DAY) });

describe('Needs you comes first (DW-S1)', () => {
    it('draws the groups as Needs you, Upcoming, Done', async () => {
        const r = load();
        assert.deepEqual([...r.P.QUEUE_GROUPS], ['attention', 'upcoming', 'done']);
        await open(r, [LATER, DONE, FAILED]);
        const markup = html(r);
        const need = markup.indexOf('id="posts-group-attention-title"');
        const upcoming = markup.indexOf('id="posts-group-upcoming-title"');
        const done = markup.indexOf('id="posts-group-done-title"');
        assert.ok(need > 0 && need < upcoming && upcoming < done, `${need} ${upcoming} ${done}`);
    });

    it('calls the group "Needs you" in English and «بحاجة إليك» in Arabic', () => {
        assert.equal(load('en').P.queueGroupMeta('attention').label, 'Needs you');
        assert.equal(load('ar').P.queueGroupMeta('attention').label, 'بحاجة إليك');
    });

    it('holds failed, held and overdue posts, and a TikTok draft left for as long as the server counts', () => {
        const { P } = load();
        const now = Date.now();
        assert.equal(P.queueGroupOf(FAILED, now), 'attention');
        assert.equal(P.queueGroupOf(HELD, now), 'attention');
        assert.equal(P.queueGroupOf(OVERDUE, now), 'attention');
        assert.equal(P.queueGroupOf(LATER, now), 'upcoming');
        const draft = (days: number): Json => post({ platform: 'tiktok', status: 'IN_INBOX', scheduled_time: new Date(now - days * DAY).toISOString() });
        assert.equal(P.queueGroupOf(draft(32), now), 'attention', 'a month-old draft is waiting for the owner');
        assert.equal(P.queueGroupOf(draft(TIKTOK_DRAFT_DAYS), now), 'attention');
        assert.equal(P.queueGroupOf(draft(TIKTOK_DRAFT_DAYS - 0.5), now), 'upcoming', 'a fresh draft is not yet a thing to chase');
        assert.equal(P.TIKTOK_DRAFT_MS, TIKTOK_DRAFT_DAYS * DAY, 'the same number as src/services/attention.ts');
        assert.equal(P.queueGroupOf({ ...draft(40), archived_at: at(-DAY) }, now), 'archived');
    });

    it('opens on the group for #/posts?filter=needs-you: queue tab, scrolled to its heading, which gets focus', async () => {
        const r = load('en', '#/posts?filter=needs-you');
        r.heading.present(true);
        r.P.activeTab = 'live';
        r.P.queueView = 'archived';
        await open(r, [LATER, FAILED]);
        assert.equal(r.P.activeTab, 'scheduled');
        assert.equal(r.P.queueView, 'active');
        assert.equal(r.heading.scrolled.length, 1);
        const el = r.h.el('posts-group-attention-title');
        assert.equal(el.focusCalls.length, 1);
        assert.match(html(r), /id="posts-group-attention-title" tabindex="-1"/);
    });

    it('scrolls once per address: a repaint of the same page leaves the owner where they are; a new visit scrolls again', async () => {
        const r = load('en', '#/posts?filter=needs-you');
        r.heading.present(true);
        await open(r, [FAILED]);
        await r.P.render();
        await settle();
        assert.equal(r.heading.scrolled.length, 1, 'a second render of the same address');
        r.P.destroy();
        r.P.resetTenantState();
        await r.P.render();
        await settle();
        assert.equal(r.heading.scrolled.length, 2, 'after the page was left and came back');
    });

    it('does nothing for any other address, and says so when nothing needs the owner', async () => {
        const plainLoad = load('en', '#/posts');
        plainLoad.heading.present(true);
        await open(plainLoad, [FAILED]);
        assert.equal(plainLoad.heading.scrolled.length, 0);
        assert.deepEqual(plainLoad.toasts, []);

        const empty = load('en', '#/posts?filter=needs-you');
        await open(empty, [LATER]);
        assert.deepEqual(empty.toasts, ['Nothing in the queue needs you.']);
    });
});

describe('the queue is drawn first, the Published feed when it is opened (DW-S2)', () => {
    it('render() never asks for /posts/live', async () => {
        const r = load();
        await open(r, [LATER]);
        assert.ok(r.calls.includes('scheduled'));
        assert.ok(!r.calls.includes('live'), r.calls.join());
        assert.match(html(r), /id="posts-queue"/);
        assert.ok(html(r).includes('data-status') || html(r).includes('post-card'), 'the cards are on screen');
    });

    it('draws the queue while the feed has not answered, and reads the feed on the first open, once', async () => {
        const r = load();
        await open(r, [LATER]);
        r.live.hold = true;
        r.live.posts = [{ id: 'm1', platform: 'instagram', timestamp: at(-DAY), media_url: null, permalink: 'https://www.instagram.com/p/x/', caption: 'live one' }];
        r.P.switchTab('live');
        assert.deepEqual(r.calls.filter((c) => c === 'live'), ['live']);
        assert.match(html(r), /Loading the published feed/);
        assert.doesNotMatch(html(r), /id="posts-queue"/);
        r.live.release();
        await settle();
        assert.doesNotMatch(html(r), /Loading the published feed/);
        assert.match(html(r), /live one/);
        r.P.switchTab('scheduled');
        r.P.switchTab('live');
        assert.equal(r.calls.filter((c) => c === 'live').length, 1, 'opened again: no second request');
    });

    it('asks twice only when the page renders again, and then only if the feed tab is the open one', async () => {
        const r = load();
        await open(r, [LATER]);
        r.P.switchTab('live');
        await settle();
        assert.equal(r.calls.filter((c) => c === 'live').length, 1);
        await r.P.render();
        await settle();
        assert.equal(r.calls.filter((c) => c === 'live').length, 2, 'rendered with the feed open: it is read again, after the queue is drawn');
        r.P.switchTab('scheduled');
        await r.P.render();
        await settle();
        assert.equal(r.calls.filter((c) => c === 'live').length, 2, 'queue tab: not asked');
    });

    it('shows a failed feed as an error panel, not as an empty feed, and does not ask again until a render', async () => {
        const r = load();
        await open(r, [LATER]);
        r.live.error = new Error('meta down');
        r.P.switchTab('live');
        await settle();
        assert.match(html(r), /data-error-host/);
        assert.match(html(r), /Could not load the published feed/);
        assert.equal(r.calls.filter((c) => c === 'live').length, 1);
    });

    it('drops an answer that arrives after the page was left', async () => {
        const r = load();
        await open(r, [LATER]);
        r.live.hold = true;
        r.P.switchTab('live');
        r.P.destroy();
        r.live.release();
        await settle();
        assert.equal(r.P.liveLoaded, false);
        assert.equal(r.P.livePosts.length, 0);
    });

    it('keeps what the page already does about polling and video downloads', async () => {
        const r = load();
        const now = Date.now();
        assert.equal(r.P.FREQUENT_SWEEP, true);
        assert.equal(r.P.QUEUE_POLL_MS, 15000);
        assert.equal(r.P.queueNeedsPoll([post({ status: 'PUBLISHING', scheduled_time: new Date(now - HOUR).toISOString() })], now), true, 'a row in flight keeps the 15 s repaint');
        assert.equal(r.P.queueNeedsPoll([post({ status: 'IN_INBOX', scheduled_time: new Date(now - 3 * DAY).toISOString() })], now), false, 'in flight for over 2 days: no poll');
        assert.equal(r.P.queueNeedsPoll([LATER], now), false);
        const card = String(r.P.renderScheduledCard(post({ post_type: 'video', media_url: 'https://example.test/api/uploads/x', cover_url: 'https://example.test/api/uploads/c' })));
        assert.match(card, /<video[^>]*preload="none"/);

        // The poll re-reads the queue only: it never reaches for the feed.
        await open(r, [post({ status: 'PUBLISHING', scheduled_time: at(-HOUR) })]);
        r.calls.length = 0;
        await r.P.refreshQueue(r.P._seq, { manual: true });
        assert.deepEqual(r.calls, ['scheduled']);
        r.P.destroy();
    });
});
