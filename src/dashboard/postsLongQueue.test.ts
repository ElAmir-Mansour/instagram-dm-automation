/**
 * The Scheduler with a long queue (live QA 2026-11-28: QA-01, QA-03; DW-S3).
 *
 * One live load of `#/posts` drew 326 cards: 231 `<video>` and 275 `<img>`, and 166 `/api/uploads/<id>` requests, 101 of them 404 because the retention
 * sweep had deleted the file while the post still named it. Pinned here:
 *   - the server says which media is gone (`annotateMissingMedia`: ONE query for the whole list, carousel slides and covers included);
 *   - a card whose media is gone draws a placeholder: no `<video>`, no `<img>`, no URL to request;
 *   - Upcoming draws the next 14 days with "Show N later", Done and Archived the first 30, "Show N more" adds 30; the chip still counts all;
 *   - a video's poster waits in `data-poster` until the card nears the screen; images are lazy;
 *   - "Needs you" counts POSTS (`group_id`, as Today does), one card per row, TikTok drafts one per row.
 * The measurement over a fixture of 326 rows, 100 with media gone, prints the before and after counts of what the markup would load.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { annotateMissingMedia } from '../services/postMedia.js';
import { loadDashboard, type Json } from './_harness.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const up = (n: number): string => `https://msg-response-auto.vercel.app/api/uploads/${uuid(n)}`;
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ─── The server's half ────────────────────────────────────────────────────────────────────────────

describe('annotateMissingMedia: which media the retention sweep has already deleted', () => {
    const rows = (): Json[] => [
        { id: 'a', media_url: up(1), cover_url: up(2), media_urls: null },
        { id: 'b', media_url: up(3), cover_url: null, media_urls: null },
        { id: 'c', media_url: up(4), cover_url: null, media_urls: [up(4), up(5), up(6)] },
        { id: 'd', media_url: 'https://cdn.example.com/x.mp4', cover_url: null, media_urls: null },
        { id: 'e', media_url: up(7), cover_url: up(8), media_urls: null },
    ];
    const present = new Set([1, 5, 6, 7].map(uuid));

    it('asks once for the whole list, however many rows, and flags exactly the rows whose media is gone', async () => {
        const asked: Array<{ sql: string; params: unknown[] }> = [];
        const out = await annotateMissingMedia(rows(), async (sql, params) => {
            asked.push({ sql, params });
            return { rows: (params[0] as string[]).filter((id) => present.has(id)).map((id) => ({ id })) };
        });
        assert.equal(asked.length, 1, 'one query for the list, not one per row');
        assert.match(asked[0]!.sql, /FROM media_uploads WHERE id = ANY\(\$1::uuid\[\]\)/);
        const byId = Object.fromEntries(out.map((r) => [r.id, r]));
        // a: the video is there, only its cover is gone: still playable, so not "missing", but the cover is named.
        assert.equal(byId.a.media_missing, false);
        assert.deepEqual(byId.a.media_missing_urls, [up(2)]);
        // b: the video is gone.
        assert.equal(byId.b.media_missing, true);
        // c: a carousel loses slide 1 (also media_url) only; slides 5 and 6 are there. media_url mirrors slide 1.
        assert.equal(byId.c.media_missing, true);
        assert.deepEqual(byId.c.media_missing_urls, [up(4)]);
        // d: another site's media cannot be checked and is never missing.
        assert.equal(byId.d.media_missing, false);
        assert.deepEqual(byId.d.media_missing_urls, []);
        // e: video there, cover gone.
        assert.equal(byId.e.media_missing, false);
    });

    it('asks nothing when no row names one of our uploads', async () => {
        let asks = 0;
        const out = await annotateMissingMedia([{ media_url: 'https://cdn.example.com/x.jpg' }, { media_url: null }], async () => { asks++; return { rows: [] }; });
        assert.equal(asks, 0);
        assert.deepEqual(out.map((r) => r.media_missing), [false, false]);
    });

    it('is wired into GET /posts/scheduled', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync('src/routes/api.ts', 'utf8');
        const start = src.indexOf("router.get('/posts/scheduled'");
        const body = src.slice(start, src.indexOf('router.post', start));
        assert.match(body, /annotateMissingMedia\(result\.rows,/);
    });
});

// ─── The dashboard's half ─────────────────────────────────────────────────────────────────────────

interface Rig { P: Json; h: ReturnType<typeof loadDashboard> }
function load(lang: 'ar' | 'en' = 'en'): Rig {
    const Admin = { emptyState: (_i: string, title: string, body: string) => `<div class="empty">${title} ${body}</div>`, confirm: () => {} };
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/posts.js'], globals: { API: { token: 'tok' }, Admin, App: { canOperate: () => true } } });
    const P = h.run('PostsPage');
    h.UI.setZone('Asia/Kuwait');
    return { P, h };
}
const base = (over: Json = {}): Json => ({
    id: 'p', platform: 'instagram', post_type: 'video', status: 'PENDING', caption: 'hello', media_url: null, cover_url: null, media_urls: null,
    scheduled_time: at(DAY), error_log: null, archived_at: null, group_id: null, media_missing: false, media_missing_urls: [], ...over,
});
const queue = (r: Rig, posts: Json[]): string => { r.P.posts = posts.map((p) => ({ ...p })); r.P.scheduledError = null; return String(r.P.renderScheduledQueue()); };
const count = (markup: string, re: RegExp): number => (markup.match(re) ?? []).length;
/** What the markup would ask the network for: `<video>`, `<img>`, and `/api/uploads` URLs in `src` or `poster` (a `data-poster` waits). */
function loads(markup: string): { video: number; img: number; uploads: number } {
    return {
        video: count(markup, /<video\b/g),
        img: count(markup, /<img\b/g),
        uploads: count(markup, /\s(?:src|poster)="[^"]*\/api\/uploads\/[^"]+"/g),
    };
}

describe('a card whose media is gone', () => {
    it('draws a placeholder: no <video>, no <img>, no URL to request', () => {
        const r = load();
        const markup = String(r.P.renderScheduledCard(base({ media_url: up(1), cover_url: up(2), media_missing: true, media_missing_urls: [up(1)] })));
        assert.deepEqual(loads(markup), { video: 0, img: 0, uploads: 0 });
        assert.ok(!markup.includes('/api/uploads/'), 'no upload URL anywhere on the card');
        assert.match(markup, /post-media-frame--gone/);
        assert.ok(text(markup).includes('Media no longer stored'), text(markup));
    });

    it('says it in Arabic', () => {
        const r = load('ar');
        const markup = String(r.P.renderScheduledCard(base({ media_url: up(1), media_missing: true, media_missing_urls: [up(1)] })));
        assert.ok(text(markup).includes('الوسائط لم تعد محفوظة'), text(markup));
    });

    it('a carousel marks only the slide that is gone', () => {
        const r = load();
        const slides = [up(1), up(2), up(3)];
        const markup = String(r.P.renderScheduledCard(base({ post_type: 'carousel', media_url: slides[0], media_urls: slides, media_missing: true, media_missing_urls: [slides[1]] })));
        assert.equal(count(markup, /<img\b/g), 2);
        assert.equal(count(markup, /post-slide-gone/g), 1);
        assert.ok(!markup.includes(uuid(2)));
    });

    it('a video whose cover alone is gone still plays, and the dead cover is never asked for', () => {
        const r = load();
        const markup = String(r.P.renderScheduledCard(base({ media_url: up(1), cover_url: up(2), media_missing_urls: [up(2)] })));
        assert.equal(count(markup, /<video\b/g), 1);
        assert.ok(!markup.includes(uuid(2)));
    });

    it('a video keeps its poster in data-poster until it nears the screen, then gets it; an image is lazy', () => {
        const r = load();
        const video = String(r.P.renderScheduledCard(base({ media_url: up(1), cover_url: up(2) })));
        assert.doesNotMatch(video, /\sposter=/);
        assert.match(video, /data-poster="[^"]*\/api\/uploads\//);
        assert.match(video, /preload="none"/);
        const image = String(r.P.renderScheduledCard(base({ post_type: 'image', media_url: up(3) })));
        assert.match(image, /<img[^>]*loading="lazy"[^>]*decoding="async"/);

        // hydratePosters: with no IntersectionObserver it sets the poster at once; with one, only when intersecting.
        const el = { attrs: { 'data-poster': 'P' } as Record<string, string | undefined>, getAttribute(k: string) { return this.attrs[k]; }, setAttribute(k: string, v: string) { this.attrs[k] = v; }, removeAttribute(k: string) { delete this.attrs[k]; } };
        r.P.hydratePosters({ querySelectorAll: () => [el] });
        assert.equal(el.attrs.poster, 'P');
        assert.equal(el.attrs['data-poster'], undefined);
    });
});

describe('a long queue is drawn in part (DW-S3)', () => {
    const upcoming = (n: number, startDay = 1): Json[] => Array.from({ length: n }, (_, i) => base({ id: `u${i}`, scheduled_time: at((startDay + i * 0.5) * DAY) }));

    it('Upcoming draws the next 14 days and a button for the rest; the chip counts all', () => {
        const r = load();
        // 28 posts, one every 12 h from day 1: day 1 .. day 14.5. Those due by day 14 are 27 (days 1, 1.5 .. 14).
        const rows = upcoming(28);
        const part = r.P.windowGroup('upcoming', r.P.groupQueue(rows, Date.now()).upcoming, Date.now());
        assert.equal(part.shown.length, 27);
        assert.equal(part.later, 1);
        const markup = queue(r, rows);
        assert.equal(count(markup, /<article class="post-card/g), 27);
        assert.ok(text(markup).includes('Show 1 later'), text(markup));
        assert.ok(text(markup).includes('27 of 28 shown'), text(markup));
        assert.match(markup, /data-action="posts:showMore"[^>]*data-key="upcoming"/);
        assert.ok(/>\s*28\s*<\/span>/.test(markup), 'the chip counts all 28');
    });

    it('"Show later" reveals 30 more at a time, to the end, and then the button is gone', () => {
        const r = load();
        const rows = [...upcoming(10), ...Array.from({ length: 75 }, (_, i) => base({ id: `f${i}`, scheduled_time: at((20 + i) * DAY) }))];
        let markup = queue(r, rows);
        assert.equal(count(markup, /<article class="post-card/g), 10);
        assert.ok(text(markup).includes('Show 30 later'));
        r.P.activeTab = 'scheduled';
        r.P.showMore('upcoming');
        markup = queue(r, rows);
        assert.equal(count(markup, /<article class="post-card/g), 40);
        r.P.showMore('upcoming');
        markup = queue(r, rows);
        assert.equal(count(markup, /<article class="post-card/g), 70);
        assert.ok(text(markup).includes('Show 15 later'), text(markup));
        r.P.showMore('upcoming');
        markup = queue(r, rows);
        assert.equal(count(markup, /<article class="post-card/g), 85);
        assert.doesNotMatch(markup, /posts:showMore/);
    });

    it('a fortnight with nothing in it still draws the nearest five, not an empty group with a button', () => {
        const r = load();
        const rows = Array.from({ length: 12 }, (_, i) => base({ id: `n${i}`, scheduled_time: at((30 + i) * DAY) }));
        const markup = queue(r, rows);
        assert.equal(count(markup, /<article class="post-card/g), 5);
        assert.ok(markup.includes('data-id="n0"') && markup.includes('data-id="n4"') && !markup.includes('data-id="n5"'));
    });

    it('a tenant switch forgets what was revealed', () => {
        const r = load();
        r.P._extra.upcoming = 60;
        r.P.resetTenantState();
        assert.deepEqual({ ...r.P._extra }, { upcoming: 0, done: 0, archived: 0 });
    });

    it('Done and Archived draw the first 30 (newest first), then "Show 30 more"', () => {
        const r = load();
        const done = Array.from({ length: 70 }, (_, i) => base({ id: `d${i}`, status: 'PUBLISHED', scheduled_time: at(-(i + 1) * DAY) }));
        const markup = queue(r, done);
        assert.equal(count(markup, /<article class="post-card/g), 30);
        assert.ok(text(markup).includes('Show 30 more'));
        assert.ok(markup.includes('data-id="d0"') && !markup.includes('data-id="d30"'));
        r.P.queueView = 'archived';
        const archived = Array.from({ length: 40 }, (_, i) => base({ id: `a${i}`, archived_at: at(-HOUR), scheduled_time: at(-(i + 1) * DAY) }));
        const view = queue(r, [...archived, base({ id: 'live', scheduled_time: at(2 * DAY) })]);
        assert.equal(count(view, /<article class="post-card/g), 30);
        assert.ok(text(view).includes('Show 10 more'), text(view));
    });

    it('Needs you is never cut, and stays first', () => {
        const r = load();
        const failed = Array.from({ length: 40 }, (_, i) => base({ id: `x${i}`, status: 'FAILED', error_log: 'boom', group_id: null, scheduled_time: at(-(i + 1) * HOUR) }));
        const markup = queue(r, [...upcoming(3), ...failed]);
        assert.equal(count(markup, /posts-group-attention-title/g), 2);
        assert.equal(count(markup, /<article class="post-card/g), 43);
        assert.ok(markup.indexOf('queue-group--attention') < markup.indexOf('queue-group--upcoming'));
    });
});

describe('Needs you counts posts, as Today does (QA-03)', () => {
    const chip = (markup: string): string => /posts-group-attention-title"[^>]*>[\s\S]*?class="chip">\s*([^<\s]+)\s*</.exec(markup)![1]!;
    const failed = (id: string, over: Json = {}): Json => base({ id, status: 'FAILED', error_log: 'boom', scheduled_time: at(-DAY), ...over });

    it('an Instagram + Facebook row and its TikTok sibling (one group_id) are one post, on two cards', () => {
        const r = load();
        const markup = queue(r, [
            failed('ig', { platform: 'both', group_id: 'g1' }), failed('tt', { platform: 'tiktok', group_id: 'g1' }),
            failed('solo1', { platform: 'tiktok' }), failed('solo2', { platform: 'tiktok' }),
        ]);
        assert.equal(count(markup, /<article class="post-card/g), 4, 'the cards stay one per row');
        assert.equal(chip(markup), '3', 'posts: 1 group + 2 standalone');
    });

    it('failed, held and overdue rows of one group are still one post', () => {
        const r = load();
        const markup = queue(r, [
            failed('a', { group_id: 'g' }),
            base({ id: 'b', group_id: 'g', status: 'PENDING', error_log: 'held', scheduled_time: at(-DAY) }),
            base({ id: 'c', group_id: 'g', status: 'PENDING', scheduled_time: at(-2 * DAY) }),
        ]);
        assert.equal(count(markup, /<article class="post-card/g), 3);
        assert.equal(chip(markup), '1');
    });

    it('a TikTok draft in the inbox counts once per row, grouped or not', () => {
        const r = load();
        const draft = (id: string): Json => base({ id, platform: 'tiktok', status: 'IN_INBOX', group_id: 'g', scheduled_time: at(-5 * DAY) });
        const markup = queue(r, [draft('d1'), draft('d2'), failed('f', { group_id: 'g' })]);
        assert.equal(chip(markup), '3');
    });

    it('other groups still count their rows', () => {
        const r = load();
        const markup = queue(r, [base({ id: 'u1', group_id: 'g', scheduled_time: at(DAY) }), base({ id: 'u2', group_id: 'g', scheduled_time: at(2 * DAY) })]);
        assert.ok(/>\s*2\s*<\/span>/.test(markup));
    });
});

// ─── The measurement ──────────────────────────────────────────────────────────────────────────────

/** 326 rows shaped like the live queue: 4 failed (a group of 3 rows and one more), 95 upcoming (34 inside 14 days), 207 done, 20 archived; 100 with media gone. */
function fixture326(): Json[] {
    const rows: Json[] = [];
    let n = 100;
    const media = (kind: 'video' | 'carousel' | 'image'): Json => {
        if (kind === 'carousel') { const s = [up(n++), up(n++), up(n++), up(n++), up(n++)]; return { post_type: 'carousel', media_url: s[0], media_urls: s, cover_url: null }; }
        if (kind === 'image') return { post_type: 'image', media_url: up(n++), media_urls: null, cover_url: null };
        return { post_type: 'video', media_url: up(n++), media_urls: null, cover_url: up(n++) };
    };
    const kindOf = (i: number): 'video' | 'carousel' | 'image' => (i % 10 < 6 ? 'video' : i % 10 < 8 ? 'carousel' : 'image');
    const add = (id: string, over: Json, i: number): void => { rows.push(base({ id, ...media(kindOf(i)), ...over })); };
    for (let i = 0; i < 4; i++) add(`f${i}`, { status: 'FAILED', error_log: 'x', group_id: i < 3 ? 'g1' : null, scheduled_time: at(-(i + 1) * DAY) }, i);
    for (let i = 0; i < 95; i++) add(`u${i}`, { scheduled_time: at((0.2 + i * (i < 34 ? 0.4 : 1.5)) * DAY) }, i);
    for (let i = 0; i < 207; i++) add(`d${i}`, { status: 'PUBLISHED', scheduled_time: at(-(i + 5) * DAY) }, i);
    for (let i = 0; i < 20; i++) add(`a${i}`, { status: 'PUBLISHED', archived_at: at(-HOUR), scheduled_time: at(-(i + 300) * DAY) }, i);
    // 100 of them lose their media: mostly old published posts, as live.
    let gone = 0;
    for (const row of rows) {
        if (gone >= 100) break;
        if (row.status === 'PUBLISHED' || (row.id.startsWith('u') && gone < 4)) {
            const own = [row.media_url, ...(row.media_urls ?? [])].filter(Boolean);
            row.media_missing = true;
            row.media_missing_urls = [...new Set<string>([...own, ...(row.cover_url ? [row.cover_url] : [])])];
            gone++;
        }
    }
    assert.equal(rows.length, 326);
    assert.equal(rows.filter((r) => r.media_missing).length, 100);
    return rows;
}

describe('326 rows, 100 with their media gone: what the page would load', () => {
    it('loads a fraction of what it did, and nothing for media that is gone', () => {
        const r = load();
        const rows = fixture326();
        // BEFORE: the same rows as an older server sends them (no flags) with every group drawn in full.
        const old = rows.map((p) => ({ ...p, media_missing: false, media_missing_urls: [] }));
        r.P.UPCOMING_DAYS = 100000; r.P.PAGE_STEP = 100000;
        const before = loads(queue(r, old) + (r.P.queueView = 'archived', queue(r, old)));
        r.P.queueView = 'active';
        // AFTER: the shipped limits, the active view (what opens). Archived is a second view, counted apart.
        r.P.UPCOMING_DAYS = 14; r.P.PAGE_STEP = 30;
        const active = queue(r, rows);
        const after = loads(active);
        r.P.queueView = 'archived';
        const archived = loads(queue(r, rows));
        r.P.queueView = 'active';
        // eslint-disable-next-line no-console
        console.log(`# 326 rows, 100 media gone. before (every card, both views, as 2026-11-28 live): ${JSON.stringify(before)}; after (active view as it opens): ${JSON.stringify(after)}; archived view on its own: ${JSON.stringify(archived)}`);
        assert.ok(after.video + after.img < 0.25 * (before.video + before.img), `drew ${after.video} videos and ${after.img} images`);
        assert.ok(after.uploads < 0.25 * before.uploads, `${after.uploads} upload URLs`);
        // Media that is gone is never asked for.
        const goneIds = new Set(rows.filter((p) => p.media_missing).flatMap((p) => p.media_missing_urls as string[]));
        for (const url of goneIds) assert.ok(!active.includes(url), `asked for ${url}`);
        assert.doesNotMatch(active, /\sposter=/, "no eager poster");
    });
});
