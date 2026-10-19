/**
 * The Posts queue: Archive, the Archived view, and honest times (UX US1: audit PO-11, PO-07 and the live walkthrough of 2026-10-19,
 * FR-003, FR-051, FR-052, FR-094; tasks T037 and T047).
 *
 * Loaded like the other dashboard suites: the REAL shipped files (`posts.js`, `components.js`, both catalogues) in a `node:vm` context
 * through `_harness.ts`, with the API stubbed. What is pinned is what a screenshot cannot:
 *
 *   - a PENDING post more than 15 minutes past its time is OVERDUE: it leaves "Upcoming" for "Needs attention", its pill says so and it
 *     keeps Publish now; at or under the grace it is only "due". No card, for any post at any hour, says "within about N minutes" (PO-11);
 *   - every time on a card is weekday + date + clock + the CITY of the tenant's zone, read from the settings Studio and the Monteur read
 *     (PO-07), and not the browser's zone;
 *   - Archive is offered on PENDING, FAILED and held posts and nowhere else; it asks no question (it can be undone), the request goes
 *     BEFORE the Undo is offered, and the Undo reverses it; an archived post is never in "Needs attention" or the Active view, never polled,
 *     and is listed under Archived, neutral and without the prompts to act;
 *   - unarchiving a PENDING post whose time has passed asks first, because it publishes at the next check.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { OVERDUE_GRACE_MINUTES } from '../services/attention.js';
import { loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** An ISO time `ms` from now (negative: in the past). The page reads the real clock, so the fixtures count from it too. */
const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦-⁩]/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const post = (over: Json = {}): Json => ({
    id: 'p1', platform: 'instagram', post_type: 'image', status: 'PENDING', caption: 'hello', media_url: null, cover_url: null,
    scheduled_time: at(DAY), error_log: null, archived_at: null, ...over,
});

interface Rig {
    h: Dashboard;
    P: Json;
    calls: Array<{ method: string; id: string }>;
    api: Json;
    toasts: Array<{ message: string; arg: Json }>;
    undos: Array<{ message: string; opts: Json }>;
    confirms: Json[];
    /** Make the API answer these, or fail. */
    failWith(err: Error | null): void;
}

function load(lang: 'ar' | 'en' = 'en', zone = 'Asia/Riyadh'): Rig {
    const calls: Rig['calls'] = [];
    let failure: Error | null = null;
    const api: Json = {
        token: 'tok',
        archiveScheduledPost: (id: string) => {
            calls.push({ method: 'archive', id });
            return failure ? Promise.reject(failure) : Promise.resolve({ id, archived_at: '2026-10-19T12:00:00.000Z' });
        },
        unarchiveScheduledPost: (id: string) => {
            calls.push({ method: 'unarchive', id });
            return failure ? Promise.reject(failure) : Promise.resolve({ id, archived_at: null });
        },
    };
    const Admin = { emptyState: (_icon: string, title: string, body: string) => `<div class="empty">${title} ${body}</div>`, confirm: () => {} };
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/posts.js'], globals: { API: api, Admin, App: { canOperate: () => true } } });
    const P = h.run('PostsPage');
    const toasts: Rig['toasts'] = [];
    const undos: Rig['undos'] = [];
    const confirms: Json[] = [];
    h.UI.toast = (message: string, arg: Json) => { toasts.push({ message, arg }); return null; };
    h.UI.undoToast = (message: string, opts: Json) => { undos.push({ message, opts }); return Promise.resolve(false); };
    h.UI.confirm = (opts: Json) => { confirms.push(opts); };
    h.UI.setZone(zone);
    return { h, P, calls, api, toasts, undos, confirms, failWith: (err) => { failure = err; } };
}

/** Put `posts` on the page as the queue, with the queue host on the page so a repaint has somewhere to write. */
function show(r: Rig, posts: Json[]): Json {
    r.P.posts = posts.map((p) => ({ ...p }));
    r.P.scheduledError = null;
    r.P.activeTab = 'scheduled';
    return r.h.el('posts-queue');
}

const card = (r: Rig, p: Json): string => String(r.P.renderScheduledCard(p));
const queue = (r: Rig): string => String(r.P.renderScheduledQueue());
const actions = (markup: string): string[] => [...markup.matchAll(/data-action="posts:(\w+)"/g)].map((m) => m[1]!);
/** Anything that reads as a promise of minutes, in either language. */
const MINUTES_PROMISE = /within about|within \d+ ?min|in about \d+ ?min|خلال \d+ دقائق|خلال \d+ دقيقة|دقائق تقريباً/;

// ─── Overdue ───────────────────────────────────────────────────────────────────────────────────

describe('a PENDING post more than 15 minutes past its time is overdue (PO-11)', () => {
    it('shows "Overdue" with the glyph, how late, and Publish now: it is in Needs attention, not Upcoming', () => {
        const r = load();
        const late = post({ scheduled_time: at(-(2 * HOUR)) });
        assert.equal(r.P.queueGroupOf(late, Date.now()), 'attention');
        const markup = card(r, late);
        assert.match(markup, /data-status="post\.overdue"/);
        assert.ok(text(markup).includes('Overdue'), text(markup));
        assert.match(markup, /status-pill-glyph" aria-hidden="true">▲</, 'a shape as well as a colour');
        assert.match(markup, /data-tone="warning"/);
        assert.ok(text(markup).includes('Overdue by 2h. It was not published at the last check.'), text(markup));
        assert.ok(actions(markup).includes('publishNow'), 'Publish now is on the card');
        assert.match(markup, /data-action="posts:publishNow"/);
        assert.ok(text(markup).includes('Publish now'));
        assert.doesNotMatch(markup, MINUTES_PROMISE);
    });

    it('says it in Arabic, in the product\'s words, with the catalogue\'s own short unit for how late', () => {
        const r = load('ar');
        const markup = card(r, post({ scheduled_time: at(-(3 * HOUR) - MIN) }));
        const said = text(markup);
        assert.ok(said.includes('تأخر موعده'), said);
        assert.ok(said.includes('تأخر 3 س. لم يُنشر في الفحص الأخير.'), said);
        assert.ok(said.includes('انشر الآن'), said);
        assert.doesNotMatch(said, MINUTES_PROMISE);
    });

    it('reads minutes under an hour and days over two, in the catalogue\'s own short forms', () => {
        const r = load();
        assert.equal(r.P.lateText(16 * MIN), '16m');
        assert.equal(r.P.lateText(59 * MIN), '59m');
        assert.equal(r.P.lateText(60 * MIN), '1h');
        assert.equal(r.P.lateText(47 * HOUR), '47h');
        assert.equal(r.P.lateText(5 * DAY), '5d');
    });

    it('is only "due" at or under the grace: still Upcoming, an hourglass, no Overdue pill', () => {
        const r = load();
        const now = Date.now();
        // 15 minutes less a margin: the card reads the clock again when it draws, so exactly 15 would have crept over by then.
        for (const lateBy of [1 * MIN, 14 * MIN, 15 * MIN - 2000]) {
            const p = post({ scheduled_time: new Date(now - lateBy).toISOString() });
            assert.equal(r.P.queueGroupOf(p, now), 'upcoming', `${lateBy / MIN} min late`);
            assert.equal(r.P.isOverdue(p, now), false, `${lateBy / MIN} min late`);
            assert.equal(r.P.overdueMs(p, now), 0);
            const markup = card(r, p);
            assert.doesNotMatch(markup, /post\.overdue/);
            assert.match(markup, /data-timing="due"/);
            assert.ok(text(markup).includes('Its time has come. It goes out at the next check.'), text(markup));
            assert.doesNotMatch(markup, MINUTES_PROMISE);
        }
        // Exactly 15 minutes is not overdue, one millisecond more is: the line is `>`, not `>=`.
        assert.equal(r.P.isOverdue(post({ scheduled_time: new Date(now - 15 * MIN).toISOString() }), now), false);
        assert.equal(r.P.isOverdue(post({ scheduled_time: new Date(now - 15 * MIN - 1).toISOString() }), now), true);
    });

    it('is overdue only while PENDING: a failed, published or publishing post of the same age is not "overdue"', () => {
        const r = load();
        const now = Date.now();
        for (const status of ['FAILED', 'PUBLISHED', 'PUBLISHING', 'PROCESSING', 'IN_INBOX']) {
            const p = post({ status, scheduled_time: new Date(now - 3 * HOUR).toISOString() });
            assert.equal(r.P.isOverdue(p, now), false, status);
            assert.doesNotMatch(card(r, p), /post\.overdue/, status);
            assert.equal(r.P.timingNote(p, now), null, status);
        }
    });

    it('uses ONE grace: the server\'s, Overview\'s and this page\'s are the same 15 minutes', () => {
        const r = load();
        assert.equal(r.P.OVERDUE_GRACE_MS, OVERDUE_GRACE_MINUTES * MIN);
        const overview = loadDashboard({ files: ['dashboard/js/pages/overview.js'], globals: { API: {}, App: {}, Admin: {} } }).run('OverviewPage');
        assert.equal(overview.OVERDUE_GRACE_MS, r.P.OVERDUE_GRACE_MS, 'Today\'s alert and this queue call a post overdue at the same moment');
    });
});

// ─── No promise of minutes ─────────────────────────────────────────────────────────────────────

describe('no card promises minutes, for any post at any hour (PO-11)', () => {
    it('a post for January says its date and weekday and nothing about minutes', () => {
        for (const lang of ['en', 'ar'] as const) {
            const r = load(lang);
            for (const status of ['PENDING', 'FAILED']) {
                const markup = card(r, post({ status, scheduled_time: '2027-01-01T00:00:00.000Z', error_log: status === 'FAILED' ? 'Replaced by the reel.' : null }));
                assert.doesNotMatch(markup, MINUTES_PROMISE, `${lang} ${status}`);
                assert.doesNotMatch(markup, /data-timing=/, 'a future post has no second line');
                assert.doesNotMatch(markup, /calendar-clock/, 'and no "expected window" line');
            }
        }
    });

    it('holds across every offset, both regimes of the sweep and both languages: the sentence of the form is never on a card', () => {
        for (const lang of ['en', 'ar'] as const) {
            for (const frequent of [true, false]) {
                const r = load(lang);
                r.P.FREQUENT_SWEEP = frequent;
                for (const offset of [-10 * DAY, -2 * HOUR, -16 * MIN, -14 * MIN, -1 * MIN, 1 * MIN, 1 * HOUR, 60 * DAY]) {
                    const markup = card(r, post({ scheduled_time: at(offset) }));
                    assert.doesNotMatch(markup, MINUTES_PROMISE, `${lang} frequent=${frequent} offset=${offset / MIN} min`);
                    const win = r.P.publishWindow(at(offset));
                    assert.ok(!markup.includes(r.P.publishWindowText(win)), 'the form\'s window sentence is not on the card');
                }
            }
        }
    });
});

// ─── The tenant's zone ─────────────────────────────────────────────────────────────────────────

describe('a card\'s time is weekday + date + clock + the CITY of the tenant\'s zone (PO-07)', () => {
    const INSTANT = '2027-01-01T00:00:00.000Z'; // Friday 03:00 in Riyadh (UTC+3), 04:00 in Dubai (UTC+4)

    it('reads it in the tenant\'s zone and names the city, in English', () => {
        const r = load('en', 'Asia/Riyadh');
        const markup = text(card(r, post({ scheduled_time: INSTANT })));
        assert.match(markup, /Fri/, 'the weekday');
        assert.match(markup, /Jan 1, 2027|1 Jan 2027/, 'the date, with the year');
        assert.match(markup, /\b03:00\b/, 'the clock in Riyadh, not in UTC and not in the browser\'s zone');
        assert.match(markup, /\(Riyadh\)/, 'and the city');
        assert.doesNotMatch(markup, /\b00:00\b/);
    });

    it('a different tenant zone is a different clock and a different city', () => {
        const r = load('en', 'Asia/Dubai');
        const markup = text(card(r, post({ scheduled_time: INSTANT })));
        assert.match(markup, /\b04:00\b/);
        assert.match(markup, /\(Dubai\)/);
    });

    it('says it in Arabic: the Arabic weekday and the Arabic name of the city', () => {
        const r = load('ar', 'Asia/Riyadh');
        const markup = text(card(r, post({ scheduled_time: INSTANT })));
        const weekday = new Intl.DateTimeFormat(r.h.I18N.locale(), { weekday: 'short', timeZone: 'Asia/Riyadh' }).format(new Date(INSTANT));
        assert.ok(markup.includes(weekday), `the weekday "${weekday}" in: ${markup}`);
        assert.ok(markup.includes(`(${r.h.t('studio.city.Riyadh')})`), markup);
        assert.ok(markup.includes('الرياض'));
    });

    it('is the same wording on the card\'s accessible name, so a screen reader hears the city too', () => {
        const r = load('en', 'Asia/Riyadh');
        const markup = card(r, post({ scheduled_time: INSTANT }));
        const label = /<article[^>]*aria-label="([^"]*)"/.exec(markup)![1]!;
        assert.match(label, /Fri/);
        assert.match(label, /\(Riyadh\)/);
    });

    it('is read from the settings Studio and the Monteur read (schedule.timezone), when the page loads', async () => {
        const r = load('en', 'UTC');
        r.h.UI.setZone('');
        const container = r.h.el('page-container');
        Object.assign(r.api, {
            getScheduledPosts: () => Promise.resolve([post({ scheduled_time: INSTANT })]),
            getLivePosts: () => Promise.resolve([]),
            getTikTokConnection: () => Promise.resolve(null),
            getStudioSettings: () => Promise.resolve({ settings: { schedule: { timezone: 'Asia/Riyadh' } } }),
        });
        await r.P.render();
        await settle();
        assert.equal(r.h.UI.zone(), 'Asia/Riyadh', 'the shared tenant zone is now Studio\'s');
        assert.match(text(container.innerHTML), /\b03:00\b.*\(Riyadh\)/);
    });

    it('a failed settings read does not blank the page or change the zone: times stay in the zone already known, and say which', async () => {
        const r = load('en', 'Asia/Dubai');
        const container = r.h.el('page-container');
        Object.assign(r.api, {
            getScheduledPosts: () => Promise.resolve([post({ scheduled_time: INSTANT })]),
            getLivePosts: () => Promise.resolve([]),
            getTikTokConnection: () => Promise.resolve(null),
            getStudioSettings: () => Promise.reject(new Error('boom')),
        });
        await r.P.render();
        await settle();
        assert.equal(r.h.UI.zone(), 'Asia/Dubai');
        assert.match(text(container.innerHTML), /\(Dubai\)/, 'still names a city');
    });

    it('settings with no zone say nothing: the zone is left as it was', () => {
        const r = load('en', 'Asia/Riyadh');
        r.P.shareZone({ status: 'fulfilled', value: { settings: { schedule: {} } } });
        r.P.shareZone({ status: 'fulfilled', value: {} });
        r.P.shareZone({ status: 'rejected', reason: new Error('x') });
        r.P.shareZone(null);
        assert.equal(r.h.UI.zone(), 'Asia/Riyadh');
    });

    it('a tenant switch forgets the zone and the Archived view, so the next tenant\'s times are never read in this one\'s', () => {
        const r = load('en', 'Asia/Riyadh');
        r.P.queueView = 'archived';
        r.P.resetTenantState();
        assert.equal(r.P.queueView, 'active');
        assert.notEqual(r.h.UI.zone(), 'Asia/Riyadh');
    });
});

// ─── Archive on the card ───────────────────────────────────────────────────────────────────────

describe('Archive is offered on PENDING, FAILED and held posts, and nowhere else', () => {
    it('PENDING, FAILED and a held PENDING post have Archive beside Publish now, Edit and Delete', () => {
        const r = load();
        const held = post({ status: 'PENDING', platform: 'tiktok', error_log: 'Waiting for TikTok: 5 drafts are pending.' });
        for (const p of [post(), post({ status: 'FAILED', error_log: 'Replaced by the reel.' }), held]) {
            const markup = card(r, p);
            assert.deepEqual(actions(markup).filter((a) => ['publishNow', 'showEditModal', 'archivePost', 'deletePost'].includes(a)),
                ['publishNow', 'showEditModal', 'archivePost', 'deletePost'], p.status);
            assert.match(markup, /data-action="posts:archivePost"[^>]*data-id="p1"|data-id="p1"[^>]*data-action="posts:archivePost"/);
            assert.ok(text(markup).includes('Archive'));
            assert.doesNotMatch(markup, /unarchivePost/);
        }
    });

    it('no other status has it: published, publishing, processing and a TikTok inbox draft', () => {
        const r = load();
        for (const status of ['PUBLISHED', 'PUBLISHING', 'PROCESSING', 'IN_INBOX']) {
            assert.ok(!actions(card(r, post({ status }))).includes('archivePost'), status);
        }
    });

    it('is a button with a name, a visible word, a stable focus key and an icon from the shipped set', () => {
        const r = load();
        const markup = card(r, post());
        assert.match(markup, /data-focus-key="post-archive-p1"/);
        assert.match(markup, /data-lucide="eye-off"/);
        // The icon subset (check:icon-subset) is built from the sources: a name it does not carry loads the full library at run time.
        const subset = readFileSync('dashboard/js/icons.js', 'utf8');
        for (const name of ['eye-off', 'rotate-ccw', 'folder-open', 'hourglass']) assert.ok(subset.includes(name), `${name} is in dashboard/js/icons.js`);
        assert.ok(text(card(load('ar'), post())).includes('أرشفة'));
    });
});

// ─── Archived posts: where they are, and where they are not ────────────────────────────────────

describe('an archived post is never in Needs attention, and is listed under Archived', () => {
    const parkedFailed = () => post({ id: 'f1', status: 'FAILED', error_log: 'Replaced by the reel.', scheduled_time: '2027-01-01T00:00:00.000Z', archived_at: '2026-10-19T09:00:00.000Z' });
    const parkedHeld = () => post({ id: 'h1', platform: 'tiktok', status: 'PENDING', error_log: 'Waiting for TikTok: 5 drafts are pending.', scheduled_time: '2027-01-01T00:00:00.000Z', archived_at: '2026-10-19T09:00:00.000Z' });
    const parkedOverdue = () => post({ id: 'o1', status: 'PENDING', scheduled_time: at(-5 * DAY), archived_at: '2026-10-19T09:00:00.000Z' });

    it('groups an archived row as archived whatever its status, FAILED, held or overdue included', () => {
        const r = load();
        const now = Date.now();
        for (const p of [parkedFailed(), parkedHeld(), parkedOverdue(), post({ status: 'PUBLISHED', archived_at: '2026-10-19T09:00:00.000Z' })]) {
            assert.equal(r.P.queueGroupOf(p, now), 'archived', `${p.id} ${p.status}`);
        }
        const groups = r.P.groupQueue([parkedFailed(), parkedHeld(), parkedOverdue(), post({ id: 'ok' })], now);
        assert.deepEqual(plain(groups.attention), [], 'nothing archived is in Needs attention');
        assert.deepEqual(plain(groups.archived.map((p: Json) => p.id)).sort(), ['f1', 'h1', 'o1']);
        assert.deepEqual(plain(groups.upcoming.map((p: Json) => p.id)), ['ok']);
    });

    it('the same rows, not archived, ARE in Needs attention (so the exclusion is the archive and nothing else)', () => {
        const r = load();
        const now = Date.now();
        const unparked = [parkedFailed(), parkedHeld(), parkedOverdue()].map((p) => ({ ...p, archived_at: null }));
        const groups = r.P.groupQueue(unparked, now);
        assert.deepEqual(plain(groups.attention.map((p: Json) => p.id)).sort(), ['f1', 'h1', 'o1']);
        assert.deepEqual(plain(groups.archived), []);
    });

    it('the Active view draws no archived card and no archived count in Needs attention; the switch says how many are put away', () => {
        const r = load();
        show(r, [parkedFailed(), parkedHeld(), post({ id: 'ok' }), post({ id: 'bad', status: 'FAILED', error_log: 'x' })]);
        const markup = queue(r);
        assert.ok(!markup.includes('data-id="f1"') && !markup.includes('data-id="h1"'), 'the parked rows are not in the list he works from');
        assert.ok(markup.includes('data-id="ok"') && markup.includes('data-id="bad"'));
        const attention = /<section class="queue-group queue-group--attention"[\s\S]*?<\/section>/.exec(markup)![0];
        assert.match(text(attention), /Needs attention 1\b/, 'Needs attention counts the one failure that is still his to look at');
        // The switch, with counts: 2 active (ok, bad), 2 archived.
        assert.match(markup, /data-action="posts:setQueueView"[^>]*data-key="active"|data-key="active"[^>]*data-action="posts:setQueueView"/);
        assert.match(text(markup), /Active 2/);
        assert.match(text(markup), /Archived 2/);
        assert.match(markup, /data-key="active"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-key="active"/);
    });

    it('with nothing archived there is no switch at all', () => {
        const r = load();
        show(r, [post(), post({ id: 'b', status: 'FAILED', error_log: 'x' })]);
        assert.doesNotMatch(queue(r), /posts:setQueueView/);
    });

    it('the Archived view lists them, neutral, and says what they are (not published, not counted)', () => {
        const r = load();
        show(r, [parkedFailed(), parkedHeld(), post({ id: 'ok' })]);
        r.P.queueView = 'archived';
        const markup = queue(r);
        assert.ok(markup.includes('data-id="f1"') && markup.includes('data-id="h1"'));
        assert.ok(!markup.includes('data-id="ok"'), 'only what was put away');
        assert.ok(text(markup).includes('Archived posts are never published and are not counted as needing attention.'));
        assert.match(markup, /data-key="archived"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-key="archived"/);
        // Neutral: the pill says both words, the glyph is the neutral one, and nothing on the card is red.
        const failedCard = card(r, parkedFailed());
        assert.match(failedCard, /data-status="post\.archived"/);
        assert.match(failedCard, /data-tone="neutral"/);
        assert.ok(text(failedCard).includes('Archived · Failed'), text(failedCard));
        assert.doesNotMatch(failedCard, /post-card-error|badge-danger|badge-warning|text-warning/);
        assert.ok(text(failedCard).includes('Replaced by the reel.'), 'what it said when it was put away is still readable');
    });

    it('an archived card has Unarchive and Delete, and none of the prompts to act: no Publish now, Edit, Archive or TikTok kit', () => {
        const r = load();
        const markup = card(r, parkedHeld());
        assert.deepEqual(actions(markup).filter((a) => !['app'].includes(a)), ['unarchivePost', 'deletePost']);
        assert.match(markup, /data-focus-key="post-unarchive-h1"/);
        assert.doesNotMatch(markup, /tiktok-next|tiktok-manual|posts:publishNow|posts:showEditModal|posts:archivePost"/);
        assert.ok(text(markup).includes('Unarchive'));
    });

    it('an archived overdue post is not "overdue": no Overdue pill, no late line (the owner put it away)', () => {
        const r = load();
        const markup = card(r, parkedOverdue());
        assert.doesNotMatch(markup, /post\.overdue/);
        assert.doesNotMatch(markup, /data-timing=/);
    });

    it('when the last archived post is restored while the Archived view is up, the page falls back to Active, not an empty list', () => {
        const r = load();
        show(r, [post({ id: 'ok' })]);
        r.P.queueView = 'archived';
        const markup = queue(r);
        assert.ok(markup.includes('data-id="ok"'));
        assert.doesNotMatch(markup, /posts:setQueueView/);
    });

    it('when everything is archived, the Active view says so and points at Archived instead of drawing nothing', () => {
        const r = load();
        show(r, [parkedFailed(), parkedHeld()]);
        const markup = queue(r);
        assert.ok(text(markup).includes('The queue is clear'));
        assert.ok(text(markup).includes('Everything you put away is under Archived.'));
        assert.match(markup, /posts:setQueueView/);
        assert.match(markup, /posts:showCreateModal/);
    });

    it('the switch repaints the queue and keeps the choice across the 15 s refresh', () => {
        const r = load();
        const host = show(r, [parkedFailed(), post({ id: 'ok' })]);
        r.P.setQueueView('archived');
        assert.equal(r.P.queueView, 'archived');
        assert.ok(host.innerHTML.includes('data-id="f1"') && !host.innerHTML.includes('data-id="ok"'));
        r.P.setQueueView('active');
        assert.ok(host.innerHTML.includes('data-id="ok"') && !host.innerHTML.includes('data-id="f1"'));
        r.P.setQueueView('nonsense');
        assert.equal(r.P.queueView, 'active', 'an unknown view is Active, never a blank page');
    });

    it('an archived post keeps no poll alive, while the same post unarchived and late does', () => {
        const r = load();
        const now = Date.now();
        const late = (archivedAt: string | null) => post({ scheduled_time: new Date(now - 3 * HOUR).toISOString(), archived_at: archivedAt });
        assert.equal(r.P.queueNeedsPoll([late(null)], now), true);
        assert.equal(r.P.queueNeedsPoll([late('2026-10-19T09:00:00.000Z')], now), false);
        assert.equal(r.P.queueNeedsPoll([post({ status: 'IN_INBOX', archived_at: '2026-10-19T09:00:00.000Z' })], now), false);
    });
});

// ─── The Archive action ────────────────────────────────────────────────────────────────────────

describe('Archive: no question, the request first, an Undo that reverses it', () => {
    it('sends the archive, takes the card out of the Active view, and offers an Undo that names what archiving means', async () => {
        const r = load();
        const host = show(r, [post({ id: 'p1', status: 'FAILED', error_log: 'Replaced by the reel.' }), post({ id: 'p2' })]);
        await r.P.archivePost('p1');

        assert.deepEqual(r.calls, [{ method: 'archive', id: 'p1' }]);
        assert.equal(r.confirms.length, 0, 'no question: it can be taken back');
        assert.equal(r.P.posts.find((p: Json) => p.id === 'p1').archived_at, '2026-10-19T12:00:00.000Z', 'the server\'s stamp is on the row');
        assert.ok(!host.innerHTML.includes('data-id="p1"'), 'the card has left the list he works from');
        assert.ok(host.innerHTML.includes('data-id="p2"'));
        assert.equal(r.undos.length, 1);
        assert.equal(r.undos[0]!.message, 'Archived. It will not be published, and it no longer counts as needing attention.');
        assert.equal(typeof r.undos[0]!.opts.onUndo, 'function');
        assert.equal(r.toasts.length, 0);
    });

    it('goes to the server BEFORE the Undo is offered (a sweep could publish a PENDING post while a toast waited)', async () => {
        const r = load();
        show(r, [post({ id: 'p1' })]);
        const order: string[] = [];
        r.api.archiveScheduledPost = (id: string) => { order.push('request'); return Promise.resolve({ id, archived_at: '2026-10-19T12:00:00.000Z' }); };
        r.h.UI.undoToast = () => { order.push('undo offered'); return Promise.resolve(false); };
        await r.P.archivePost('p1');
        assert.deepEqual(order, ['request', 'undo offered']);
    });

    it('the Undo restores the post: the server is asked, and the card is back in the list', async () => {
        const r = load();
        const host = show(r, [post({ id: 'p1', status: 'FAILED', error_log: 'x' })]);
        await r.P.archivePost('p1');
        assert.ok(!host.innerHTML.includes('data-id="p1"'));
        await r.undos[0]!.opts.onUndo();
        assert.deepEqual(r.calls.map((c) => c.method), ['archive', 'unarchive']);
        assert.equal(r.P.posts[0].archived_at, null);
        assert.ok(host.innerHTML.includes('data-id="p1"'), 'back in Needs attention');
    });

    it('the Undo is offered for the toast\'s whole life (UI.undoToast keeps it at least six seconds), and is the UI primitive', () => {
        const source = readFileSync('dashboard/js/pages/posts.js', 'utf8');
        assert.match(source, /UI\.undoToast\(t\('posts\.archived\.done'\)/);
        const ui = readFileSync('dashboard/js/components.js', 'utf8');
        assert.match(ui, /const seconds = Math\.max\(6, Number\(o\.seconds\) \|\| 6\)/);
    });

    it('a refusal leaves the post where it was, says why in a sentence, and offers no Undo', async () => {
        const r = load();
        const host = show(r, [post({ id: 'p1' })]);
        host.innerHTML = 'untouched';
        r.failWith(Object.assign(new Error('Scheduled post not found.'), { status: 404 }));
        await r.P.archivePost('p1');
        assert.equal(r.undos.length, 0);
        assert.equal(r.P.posts[0].archived_at, null);
        assert.equal(host.innerHTML, 'untouched', 'nothing was repainted');
        assert.equal(r.toasts.length, 1);
        assert.equal(r.toasts[0]!.arg, 'error');
        assert.ok(r.toasts[0]!.message.startsWith('The post could not be archived.'), r.toasts[0]!.message);
        assert.ok(r.toasts[0]!.message.includes('Scheduled post not found.'));
    });

    it('a double click is one request', async () => {
        const r = load();
        show(r, [post({ id: 'p1' })]);
        await Promise.all([r.P.archivePost('p1'), r.P.archivePost('p1')]);
        assert.equal(r.calls.filter((c) => c.method === 'archive').length, 1);
        assert.equal(r.undos.length, 1);
    });

    it('an unknown or already archived post is ignored', async () => {
        const r = load();
        show(r, [post({ id: 'p1', archived_at: '2026-10-19T09:00:00.000Z' })]);
        await r.P.archivePost('p1');
        await r.P.archivePost('nope');
        assert.deepEqual(r.calls, []);
    });

    it('is wired to the card\'s button through the page\'s actions (archivePost, unarchivePost, setQueueView)', () => {
        const r = load();
        const registered = r.h.UI._actions.posts;
        for (const name of ['archivePost', 'unarchivePost', 'setQueueView']) assert.equal(typeof registered[name], 'function', name);
        const archived: string[] = [];
        r.P.archivePost = (id: string) => { archived.push(id); };
        registered.archivePost({ dataset: { id: 'p9' } });
        assert.deepEqual(archived, ['p9']);
    });
});

describe('Unarchive: asks first only when it would publish', () => {
    const parked = (over: Json = {}) => post({ id: 'p1', archived_at: '2026-10-19T09:00:00.000Z', ...over });

    it('a PENDING post whose time has passed is asked about, naming what happens, and nothing is sent until "yes"', async () => {
        const r = load();
        show(r, [parked({ scheduled_time: at(-3 * HOUR) })]);
        r.P.unarchivePost('p1');
        assert.deepEqual(r.calls, [], 'nothing sent before the answer');
        assert.equal(r.confirms.length, 1);
        assert.equal(r.confirms[0]!.body, 'This post\'s time has passed, so it will be published to the live account at the next check.');
        assert.equal(r.confirms[0]!.title, 'Unarchive and publish?');
        assert.equal(r.confirms[0]!.tone, 'primary');
        await r.confirms[0]!.onConfirm();
        assert.deepEqual(r.calls, [{ method: 'unarchive', id: 'p1' }]);
        assert.equal(r.P.posts[0].archived_at, null);
    });

    it('a "yes" that fails throws, so the dialog shows why and stays open; the post stays archived', async () => {
        const r = load();
        show(r, [parked({ scheduled_time: at(-3 * HOUR) })]);
        r.P.unarchivePost('p1');
        r.failWith(new Error('nope'));
        await assert.rejects(() => r.confirms[0]!.onConfirm(), /nope/);
        assert.ok(r.P.posts[0].archived_at);
    });

    it('a FAILED post, and a PENDING post still in the future, come back with no question and a plain confirmation', async () => {
        for (const p of [parked({ status: 'FAILED', error_log: 'x', scheduled_time: at(-3 * HOUR) }), parked({ scheduled_time: at(2 * DAY) })]) {
            const r = load();
            show(r, [p]);
            await r.P.unarchivePost('p1');
            assert.equal(r.confirms.length, 0, p.status);
            assert.deepEqual(r.calls, [{ method: 'unarchive', id: 'p1' }]);
            assert.equal(r.P.posts[0].archived_at, null);
            assert.deepEqual(r.toasts.map((x) => x.message), ['Back in the queue.']);
        }
    });

    it('a failure without a question is a sentence in a toast, and the post stays archived', async () => {
        const r = load();
        show(r, [parked({ status: 'FAILED', error_log: 'x' })]);
        r.failWith(new Error('Failed to unarchive this post.'));
        await r.P.unarchivePost('p1');
        assert.ok(r.P.posts[0].archived_at);
        assert.ok(r.toasts[0]!.message.startsWith('The post could not be restored.'), r.toasts[0]!.message);
    });

    it('a post that is not archived is ignored', () => {
        const r = load();
        show(r, [post({ id: 'p1' })]);
        r.P.unarchivePost('p1');
        assert.deepEqual(r.calls, []);
        assert.equal(r.confirms.length, 0);
    });
});

describe('the new copy is in both languages and passes the voice rules', () => {
    const KEYS = [
        'posts.archive', 'posts.unarchive', 'posts.archived.done', 'posts.unarchived.done', 'posts.archiveFailed', 'posts.unarchiveFailed',
        'posts.archived.hint', 'posts.view.label', 'posts.view.active', 'posts.view.archived', 'posts.group.archived',
        'posts.emptyActiveTitle', 'posts.emptyActiveBody', 'posts.overdue.line', 'posts.due.line',
        'posts.unarchive.confirmTitle', 'posts.unarchive.confirmBody',
    ];
    it('every key has an Arabic and an English sentence, and neither is the key itself', () => {
        for (const lang of ['ar', 'en'] as const) {
            const { t } = loadDashboard({ lang });
            for (const key of KEYS) {
                const said = t(key, { reason: 'r', late: '2h' });
                assert.notEqual(said, key, `${lang}: ${key}`);
                assert.ok(said.length > 2);
            }
        }
    });

    it('no sentence promises minutes or uses a word the voice guard bans (instant, guaranteed, AI-powered, bot…)', () => {
        for (const lang of ['ar', 'en'] as const) {
            const { t } = loadDashboard({ lang });
            for (const key of KEYS) {
                const said = t(key, { reason: 'r', late: '2h' });
                assert.doesNotMatch(said, MINUTES_PROMISE, `${lang}: ${key}`);
                assert.doesNotMatch(said, /\b(instant|instantly|guaranteed|magic|bot)\b|فوراً|مضمون|بوت|سحري/i, `${lang}: ${key}`);
            }
        }
    });
});
