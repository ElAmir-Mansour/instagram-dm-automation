/**
 * UX wave 3's dashboard half: the inbox's platform tags and sender tags (I8, I4), Analytics'
 * window and "why DMs fail" (A1, A5), Overview's "failed today" (O9), and the held state of a
 * scheduled post (CP12).
 *
 * Loaded like reading.test.ts: the REAL shipped files in a `node:vm` context with a fake DOM, in
 * both languages where the words are the claim. The held-state test takes its two markers from
 * the server's own code (IG_CONTAINER_PREFIX, TikTokInboxFullError), so the dashboard cannot drift
 * from what the publisher writes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { IG_CONTAINER_PREFIX } from '../routes/api.js';
import { TikTokInboxFullError } from '../services/tiktokPublish.js';

type Json = any;
type Translate = (key: string, params?: Record<string, unknown>) => string;

function fakeEl(id: string, props: Record<string, unknown> = {}): Json {
    const attrs = new Map<string, string>();
    const el: Json = {
        id, value: '', innerHTML: '', textContent: '', dataset: {}, children: [],
        scrollHeight: 0, scrollTop: 0, clientHeight: 0,
        classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
        setAttribute: (n: string, v: string) => { attrs.set(n, String(v)); },
        removeAttribute: (n: string) => { attrs.delete(n); },
        getAttribute: (n: string) => (attrs.has(n) ? attrs.get(n)! : null),
        insertAdjacentHTML: (_w: string, markup: string) => { el.innerHTML += markup; },
        focus: () => {}, closest: () => null, contains: () => false,
        querySelector: () => null, querySelectorAll: () => [],
    };
    return Object.assign(el, props);
}

interface Loaded {
    pages: Json;
    UI: Json;
    t: Translate;
    dom: Map<string, Json>;
    selectors: Map<string, Json>;
    api: Record<string, (...args: Json[]) => unknown>;
    calls: Array<{ method: string; args: Json[] }>;
    announced: string[];
    storage: Map<string, string>;
    host(id: string, props?: Record<string, unknown>): Json;
}

function load(lang: 'ar' | 'en' = 'en', opts: { storageThrows?: boolean; stored?: Record<string, string> } = {}): Loaded {
    const noop = (): void => {};
    const dom = new Map<string, Json>();
    const selectors = new Map<string, Json>();
    const api: Record<string, (...args: Json[]) => unknown> = {};
    const calls: Array<{ method: string; args: Json[] }> = [];
    const storage = new Map<string, string>(Object.entries(opts.stored || {}));
    const refuse = () => { throw new Error('SecurityError: storage is disabled'); };
    const stub = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '', textContent: '',
    };
    const ctx: Json = {
        document: {
            ...stub,
            createElement: () => ({ ...stub }),
            body: { ...stub }, head: { ...stub },
            documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => dom.get(id) ?? null,
            querySelector: (sel: string) => selectors.get(sel) ?? null,
            activeElement: null,
            visibilityState: 'visible',
        },
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
        location: { hash: '#/analytics', pathname: '/dashboard' },
        history: { replaceState: noop },
        Intl, console, clearTimeout, clearInterval, URLSearchParams,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        setTimeout: (fn: () => void, ms?: number) => { const h = setTimeout(fn, ms); (h as Json).unref?.(); return h; },
        setInterval: (fn: () => void, ms?: number) => { const h = setInterval(fn, ms); (h as Json).unref?.(); return h; },
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang },
        CSS: { escape: (v: string) => String(v) },
        API: new Proxy(api, {
            get: (target, prop: string) => (prop === 'token' ? 'tok' : prop in target
                ? (...args: Json[]) => { calls.push({ method: prop, args }); return target[prop]!(...args); }
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        Admin: { emptyState: (_i: string, title: string, body: string) => `<div class="empty-state">${title} ${body || ''}</div>`, confirm: noop },
        App: {
            currentTheme: () => 'auto', navigate: noop, session: { tenantId: 't1' }, hashParam: () => '',
            canOperate: () => true, canAdminister: () => true, go: noop, goWithQuery: noop, setInboxWaiting: noop,
        },
        localStorage: opts.storageThrows
            ? { getItem: refuse, setItem: refuse, removeItem: refuse }
            : {
                getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
                setItem: (k: string, v: string) => { storage.set(k, String(v)); },
                removeItem: (k: string) => { storage.delete(k); },
            },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/motion.js', 'dashboard/js/charts.js',
        'dashboard/js/pages/overview.js', 'dashboard/js/pages/inbox.js', 'dashboard/js/pages/analytics.js',
        'dashboard/js/pages/activity.js', 'dashboard/js/pages/posts.js',
    ]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const got = vm.runInContext(
        '({ pages: { Overview: OverviewPage, Inbox: InboxPage, Analytics: AnalyticsPage, Activity: ActivityPage, Posts: PostsPage }, UI, t, Motion })', ctx
    );
    const announced: string[] = [];
    got.Motion.announce = (m: unknown) => { announced.push(String(m)); };
    got.UI.toast = noop;
    const host = (id: string, props: Record<string, unknown> = {}) => {
        const el = fakeEl(id, props);
        dom.set(id, el);
        return el;
    };
    host('page-container');
    return { pages: got.pages, UI: got.UI, t: got.t, dom, selectors, api, calls, announced, storage, host };
}

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const LANGS = ['ar', 'en'] as const;
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦⁩]/g, '').replace(/\s+/g, ' ').trim();
const IG_TAG = '<span class="platform-tag ig">IG</span>';
const FB_TAG = '<span class="platform-tag fb">FB</span>';

// ─── I8: the platform ─────────────────────────────────────────────────────────────────────
describe('Inbox — which network a thread is on (I8)', () => {
    it('tags a thread row IG or FB, with the same tag the activity log uses, and nothing for an unknown one', () => {
        const s = load();
        const I = s.pages.Inbox;
        const row = (platform: unknown) => String(I.threadRow({ id: '1', username: 'sara', platform, is_bot_active: true }));
        assert.ok(row('instagram').includes(IG_TAG));
        assert.ok(row('facebook').includes(FB_TAG));
        for (const none of [null, undefined, 'tiktok']) assert.ok(!row(none).includes('platform-tag'), String(none));
        // One markup source: the activity log's user cell renders the very same tag.
        assert.ok(String(s.UI.userCell({ sender_username: 'x', platform: 'facebook' })).includes(FB_TAG));
        assert.ok(String(s.UI.userCell({ sender_username: 'x', platform: 'instagram' })).includes(IG_TAG));
    });

    for (const lang of LANGS) {
        it(`the chat header shows the tag and a neutral "ID" sub-line, not "User ID" (${lang})`, () => {
            const s = load(lang);
            const I = s.pages.Inbox;
            const pane = s.host('chat-pane-container');
            I.renderChatShell({ id: 'c1', username: 'sara', instagram_user_id: '123', platform: 'facebook', is_bot_active: true });
            assert.ok(pane.innerHTML.includes(FB_TAG));
            assert.ok(text(pane.innerHTML).includes(s.t('inbox.userId', { id: '' }).trim()));
            assert.equal(s.t('inbox.userId', { id: '1' }), lang === 'ar' ? 'المعرّف: 1' : 'ID: 1');

            I.renderChatShell({ id: 'c2', username: 'omar', instagram_user_id: '456', platform: null, is_bot_active: true });
            assert.ok(!pane.innerHTML.includes('platform-tag'), 'no platform, no tag');
        });
    }

    it('a thread that gets its platform on its next DM updates the header in place, once', () => {
        const s = load();
        const I = s.pages.Inbox;
        s.host('chat-pane-container');
        const thread = { id: 'c1', username: 'sara', instagram_user_id: '123', platform: null, is_bot_active: true };
        I.renderChatShell(thread);
        const slot = fakeEl('platform-slot', { dataset: { platform: '' } });
        s.selectors.set('[data-chat-platform]', slot);
        I.updateChatHeader({ ...thread });
        assert.equal(slot.innerHTML, '', 'nothing changed: nothing written');
        I.updateChatHeader({ ...thread, platform: 'instagram' });
        assert.equal(slot.innerHTML, IG_TAG);
        assert.equal(slot.dataset.platform, 'instagram');
    });
});

// ─── I4: who wrote it ─────────────────────────────────────────────────────────────────────
describe('Inbox — who wrote an outbound message (I4)', () => {
    for (const lang of LANGS) {
        it(`tags the AI's replies and the operator's own, as tints above the bubble (${lang})`, () => {
            const s = load(lang);
            const I = s.pages.Inbox;
            const ai = String(I.messageBubble({ id: 1, direction: 'outbound', sender: 'ai', text: 'x', created_at: new Date().toISOString() }));
            assert.ok(ai.includes(`<span class="sender-tag sender-tag--ai">${s.t('inbox.senderAi')}</span>`));
            assert.ok(ai.includes('message-row row-outbound message-row--tagged'));
            assert.ok(ai.indexOf('sender-tag') < ai.indexOf('message-bubble'), 'outside and above the gradient bubble');
            assert.equal(s.t('inbox.senderAi'), lang === 'ar' ? 'الذكاء الاصطناعي' : 'AI');

            const you = String(I.messageBubble({ id: 2, direction: 'outbound', sender: 'operator', text: 'y', created_at: new Date().toISOString() }));
            assert.ok(you.includes(`<span class="sender-tag sender-tag--operator">${s.t('inbox.senderOperator')}</span>`));
            assert.equal(s.t('inbox.senderOperator'), lang === 'ar' ? 'أنت' : 'You');
        });
    }

    it('says nothing for a row from before v26, or for what the customer wrote', () => {
        const s = load();
        const I = s.pages.Inbox;
        for (const msg of [
            { direction: 'outbound', sender: null },
            { direction: 'outbound' },
            { direction: 'inbound', sender: 'customer' },
            { direction: 'inbound', sender: 'ai' },   // nonsense, and still no tag on an inbound bubble
        ]) {
            const markup = String(I.messageBubble({ id: 3, text: 'z', created_at: new Date().toISOString(), ...msg }));
            assert.ok(!markup.includes('sender-tag'), JSON.stringify(msg));
            assert.ok(!markup.includes('message-row--tagged'));
        }
    });

    it('the reply still in flight is already the operator’s', () => {
        const s = load('ar');
        const pending = String(s.pages.Inbox.pendingBubble('pending:1', 'مرحبا'));
        assert.ok(pending.includes(`<span class="sender-tag sender-tag--operator">أنت</span>`));
        assert.ok(pending.includes('data-pending="pending:1"'));
    });
});

// ─── A1: the Analytics window ─────────────────────────────────────────────────────────────
function stubAnalytics(s: Loaded, failures: Json = { days: 30, total: 0, reasons: [] }): void {
    s.api.getStats = () => Promise.resolve({ totalInteractions: 40, sent: 30, failed: 10, successRate: 75, uniqueUsersReached: 12, instagramCount: 30, facebookCount: 10 });
    s.api.getDailyStats = () => Promise.resolve([{ day: '2026-09-27', sent: 3, failed: 1 }]);
    s.api.getCampaignStats = () => Promise.resolve([{ id: 'c1', trigger_keyword: 'price', total_triggers: 4, sent_count: 3, failed_count: 1 }]);
    s.api.getFailureReasons = () => Promise.resolve(failures);
    for (const id of ['analytics-strip', 'analytics-split', 'analytics-campaigns', 'analytics-failures']) s.host(id);
}

describe('Analytics — the window (A1)', () => {
    it('defaults to all time, asks Overview’s question, and names the window on every windowed tile and panel', async () => {
        const s = load('en');
        const A = s.pages.Analytics;
        A.range = null;
        stubAnalytics(s);
        await A.render();
        await settle();
        const byMethod = Object.fromEntries(s.calls.map((c) => [c.method, c.args]));
        assert.deepEqual(plain(byMethod.getStats), [null], 'all time sends no days');
        assert.deepEqual(plain(byMethod.getCampaignStats), [null]);
        assert.deepEqual(plain(byMethod.getDailyStats), [30]);
        assert.deepEqual(plain(byMethod.getFailureReasons), [30]);
        const page = s.dom.get('page-container')!.innerHTML;
        assert.ok(page.includes('role="group" aria-label="Period"'));
        assert.match(page, /id="analytics-range-all"[^>]*aria-pressed="true"/);
        assert.match(page, /id="analytics-range-7"[^>]*aria-pressed="false"/);
        assert.equal((page.match(/<p class="stat-sub" data-window>All time<\/p>/g) || []).length, 3, 'total, rate, people');
        assert.equal((page.match(/class="text-meta analytics-window">All time</g) || []).length, 3, 'status split, campaigns, platforms');
        assert.ok(page.includes('DMs over the last 30 days'), 'the strip says its own window');
    });

    it('remembers the choice per browser, and a switch re-asks with days and says so', async () => {
        const s = load('ar', { stored: { 'analytics:range': '28' } });
        const A = s.pages.Analytics;
        A.range = null;
        stubAnalytics(s);
        await A.render();
        await settle();
        assert.deepEqual(plain(s.calls.find((c) => c.method === 'getStats')!.args), [28]);
        let page = s.dom.get('page-container')!.innerHTML;
        assert.ok(page.includes('<p class="stat-sub" data-window>آخر 28 يوماً</p>'));
        assert.match(page, /id="analytics-range-28"[^>]*aria-pressed="true"/);

        s.calls.length = 0;
        await A.setRange({ dataset: { range: '7' } });
        await settle();
        assert.equal(s.storage.get('analytics:range'), '7');
        assert.deepEqual(plain(s.calls.filter((c) => c.method === 'getStats' || c.method === 'getCampaignStats').map((c) => [c.method, ...c.args])),
            [['getStats', 7], ['getCampaignStats', 7]]);
        page = s.dom.get('page-container')!.innerHTML;
        assert.ok(page.includes('class="text-meta analytics-window">آخر 7 أيام<'));
        assert.ok(s.announced.includes(s.t('analytics.range.loaded', { window: 'آخر 7 أيام' })));

        s.calls.length = 0;
        await A.setRange({ dataset: { range: '7' } });
        await A.setRange({ dataset: { range: '365' } });
        assert.equal(s.calls.length, 0, 'the same window, or one not on offer, asks nothing');
    });

    it('ignores a hand-edited entry, and works with storage switched off', async () => {
        const junk = load('en', { stored: { 'analytics:range': '"; DROP' } });
        assert.equal(junk.pages.Analytics.loadRange(), 'all');

        const s = load('en', { storageThrows: true });
        const A = s.pages.Analytics;
        A.range = null;
        stubAnalytics(s);
        await A.render();
        await A.setRange({ dataset: { range: '90' } });
        await settle();
        assert.equal(A.range, '90', 'the choice holds for the visit even when it cannot be remembered');
        assert.deepEqual(plain(s.calls.filter((c) => c.method === 'getStats').map((c) => c.args)), [[null], [90]]);
    });
});

// ─── A5: why DMs fail ─────────────────────────────────────────────────────────────────────
describe('Analytics — why DMs fail (A5)', () => {
    const summary = {
        days: 30,
        total: 19,
        reasons: [
            { reason_code: '190', count: 8, sample: 'Private Reply Failed: Error validating access token (Code: 190)', last_at: '2026-09-26T08:00:00.000Z' },
            { reason_code: 'recipient_cap', count: 5, sample: 'Skipped: recipient already received an automated DM within 24 hours.', last_at: '2026-09-27T08:00:00.000Z' },
            { reason_code: 'text:Instagram media processing failed with status: #.', count: 3, sample: 'Instagram media processing failed with status: 3.', last_at: null },
            { reason_code: '-1', count: 2, sample: 'Private Reply Failed: weird (Code: -1)', last_at: null },
            { reason_code: 'unknown', count: 1, sample: null, last_at: null },
        ],
    };

    for (const lang of LANGS) {
        it(`explains each reason in one line, with the count and a way into the log (${lang})`, async () => {
            const s = load(lang);
            const A = s.pages.Analytics;
            A.range = 'all';
            stubAnalytics(s, summary);
            await A.render();
            await settle();
            const page = s.dom.get('page-container')!.innerHTML;
            assert.ok(page.includes(s.t('analytics.failures.title', { days: A.daysText(30) })));
            assert.match(page, /data-action="app:navigate" data-target="activity" data-query="status=FAILED"/);

            const panel = s.dom.get('analytics-failures')!.innerHTML;
            const words = text(panel);
            assert.ok(words.includes(s.t('analytics.failures.total', { count: 19, n: '19' })));
            assert.ok(words.includes(s.t('activity.err.token')), 'a Meta code, in the interface’s language');
            assert.ok(words.includes(s.t('activity.err.recipientCap')), 'a send cap, named');
            assert.ok(words.includes('Instagram media processing failed with status: 3.'), 'no known reason: Meta’s own words');
            assert.ok(words.includes(s.t('analytics.failures.unknown')));
            assert.ok(panel.includes(`title="${summary.reasons[0]!.sample}"`), 'the raw text is one hover away');
            assert.ok(words.includes(s.t('analytics.failures.code', { code: '190' }).replace(/[⁦⁩]/g, '')));
            assert.equal((panel.match(/class="failure-reason"/g) || []).length, 5);
            assert.ok(panel.indexOf('>8<') < panel.indexOf('>5<'), 'in the order the server ranked them');
        });
    }

    it('says so when nothing failed, and gives the panel its own Retry', async () => {
        const s = load('en');
        const A = s.pages.Analytics;
        A.range = 'all';
        stubAnalytics(s);
        await A.render();
        await settle();
        assert.ok(s.dom.get('analytics-failures')!.innerHTML.includes('No failed DMs in the last 30 days.'));

        s.calls.length = 0;
        s.api.getFailureReasons = () => Promise.resolve(summary);
        await A.retryPanel('failures');
        assert.deepEqual(plain(s.calls.map((c) => [c.method, ...c.args])), [['getFailureReasons', 30]], 'that panel alone');
        assert.ok(s.dom.get('analytics-failures')!.innerHTML.includes('class="failure-reasons"'));
    });

    it('a failed read is an error panel, never "nothing failed"', () => {
        const s = load('en');
        const hostEl = s.host('analytics-failures');
        s.pages.Analytics.fillFailures({ status: 'rejected', reason: new Error('down') });
        assert.ok(hostEl.innerHTML.includes(s.t('analytics.failures.errorTitle')));
        assert.ok(!hostEl.innerHTML.includes('No failed DMs'));
    });
});

// ─── One copy of the Meta code map ────────────────────────────────────────────────────────
describe('UI.metaErrorText — one copy for Activity and Analytics', () => {
    it('Activity explains an error with the shared map, and holds no copy of its own', () => {
        const s = load('ar');
        assert.equal(s.pages.Activity.META_ERROR_KEYS, undefined);
        const raw = 'Private Reply Failed: Error validating access token (Code: 190)';
        assert.equal(s.pages.Activity.explainError(raw), s.UI.metaErrorText(190));
        assert.equal(s.UI.metaErrorText(190), s.t('activity.err.token'));
        assert.equal(s.UI.metaErrorText('613'), s.t('activity.err.rateLimit'));
        assert.equal(s.UI.metaErrorText(10), s.t('activity.err.permission'));
        assert.equal(s.UI.metaErrorText(1), '');
    });

    it('explains the one-private-reply refusal, whichever code Meta used for it', () => {
        const s = load('en');
        const line = s.t('activity.err.alreadyReplied');
        assert.equal(s.UI.explainMetaError('This comment already had its private reply (Meta allows one per comment, usually sent by hand from the app), so no DM was sent. (Private Reply Failed: x (Code: -1))'), line);
        assert.equal(s.UI.explainMetaError('Private Reply Failed: x (Code: 10900)'), line);
        assert.equal(s.UI.failureReasonText('already_replied'), line);
        assert.equal(s.UI.failureReasonText('text:whatever'), '');
    });
});

// ─── O9: failed today ─────────────────────────────────────────────────────────────────────
describe('Overview — DMs failed today (O9)', () => {
    const ok = (value: unknown) => ({ status: 'fulfilled', value });
    const pending = { status: 'rejected', reason: new Error('not under test') };
    const alertsFor = (s: Loaded, failedRes: Json) => s.pages.Overview.buildAlerts({ activeCampaigns: 1 }, failedRes, ok({ status: 'valid' }), ok([]), ok({ data: [] }), pending);
    const rows = (n: number) => Array.from({ length: n }, () => ({ timestamp: new Date().toISOString() }));

    it('asks for today only — since local midnight — and a full page', async () => {
        const s = load();
        const O = s.pages.Overview;
        for (const r of ['briefing', 'growth', 'stats', 'charts', 'recent', 'busy']) s.host(`region:${r}`);
        s.dom.get('page-container')!.querySelector = (sel: string) => s.dom.get(`region:${(/data-region="([a-z]+)"/.exec(sel) || [])[1]}`) ?? null;
        s.api.getStats = () => Promise.resolve({ activeCampaigns: 1 });
        s.api.getInteractions = () => Promise.resolve({ data: [], pagination: { total: 0 } });
        s.api.getTokenStatus = () => Promise.resolve({ status: 'valid' });
        s.api.getScheduledPosts = () => Promise.resolve([]);
        s.api.getConversations = () => Promise.resolve({ data: [] });
        s.api.getDailyStats = () => Promise.resolve([]);
        s.api.getGrowthOverview = () => Promise.resolve({});
        s.api.getGrowthSettings = () => Promise.resolve({});
        O.render();
        await settle();
        const failedCall = s.calls.find((c) => c.method === 'getInteractions' && c.args[0].status === 'FAILED')!;
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        assert.deepEqual(plain(failedCall.args[0]), { status: 'FAILED', limit: 100, since: midnight.toISOString() });
        O.destroy();
    });

    it('counts today’s failures exactly, and says "more than 100" only when the page was full', () => {
        const s = load('ar');
        const title = (res: Json) => (alertsFor(s, res).find((a: Json) => a.icon === 'send-horizontal') || {}).title;
        assert.equal(title(ok({ data: rows(3), pagination: { total: 3 } })), s.t('overview.alert.failedToday', { count: 3 }));
        assert.equal(title(ok({ data: rows(100), pagination: { total: 100 } })), s.t('overview.alert.failedToday', { count: 100 }), 'exactly a page is still exact');
        assert.equal(title(ok({ data: rows(100), pagination: { total: 137 } })), 'أكثر من 100 رسالة لم تُرسل اليوم');
        assert.equal(title(ok({ data: [], pagination: { total: 0 } })), undefined, 'nothing failed: no alert');
    });
});

// ─── CP12: the held state ─────────────────────────────────────────────────────────────────
describe('Posts — a held row says it is held (CP12)', () => {
    const base = { id: 'p1', post_type: 'video', scheduled_time: '2027-03-04T18:20:00.000Z', caption: 'x', status: 'PENDING' };
    const igHeld = { ...base, platform: 'both', external_publish_id: `${IG_CONTAINER_PREFIX}1789`, error_log: 'Instagram is still processing the video; the next sweep publishes it.' };
    const ttHeld = { ...base, platform: 'tiktok', error_log: new TikTokInboxFullError(5).message };

    it('recognises exactly the two holds the publisher writes', () => {
        const s = load();
        assert.equal(s.UI.heldReason(igHeld), 'ig_processing');
        assert.equal(s.UI.heldReason(ttHeld), 'tiktok_limit');
        // A FAILED row edited back to PENDING keeps its old error: waiting, not held.
        assert.equal(s.UI.heldReason({ ...base, platform: 'instagram', error_log: 'Instagram Publish Failed: x (Code: 100)' }), null);
        assert.equal(s.UI.heldReason({ ...ttHeld, status: 'FAILED' }), null);
        assert.equal(s.UI.heldReason({ ...igHeld, status: 'PUBLISHED' }), null);
        assert.equal(s.UI.heldReason({ ...ttHeld, platform: 'instagram' }), null, 'the TikTok note only holds a TikTok row');
        assert.equal(s.UI.heldReason(null), null);
    });

    for (const lang of LANGS) {
        it(`the card's pill reads «مؤجَّل حتى الفحص القادم» / "Held until the next sweep" (${lang})`, () => {
            const s = load(lang);
            const P = s.pages.Posts;
            const held = s.t('state.held');
            assert.equal(held, lang === 'ar' ? 'مؤجَّل حتى الفحص القادم' : 'Held until the next sweep');
            for (const post of [igHeld, ttHeld]) {
                const card = String(P.renderScheduledCard(post));
                assert.ok(text(card).includes(held), post.platform);
                assert.ok(!text(card).includes(s.t('state.pending')), 'not the plain pending label');
            }
            const waiting = String(P.renderScheduledCard({ ...base, platform: 'instagram' }));
            assert.ok(text(waiting).includes(s.t('state.pending')));
            assert.ok(!text(waiting).includes(held));
            assert.equal(s.UI.postStatusLabel({ ...base, status: 'PUBLISHED' }), s.t('state.published'));
        });
    }
});
