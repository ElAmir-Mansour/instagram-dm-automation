/**
 * Today, built from the server's attention summary and cleared where it shows (U2: DW-T2, DW-T3).
 *
 * The real dashboard files are evaluated in a `vm` (the harness), with `API` stubbed. What is pinned:
 *   - the heartbeat line: the four facts, in both languages, the worker left out for a tenant that never had one, a quiet day warned about;
 *   - the failed-posts card: one line per reason with its count and age, "dated" instead of an age for a post still ahead, recent against old;
 *   - clearing: Archive these / Mark handled act at once with ONE undo toast and no question, Undo restores exactly what was cleared, a failure is
 *     said, a viewer is never offered either, and a double click is one request.
 * Nothing here reaches a network or a database.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();
const ok = (value: unknown) => ({ status: 'fulfilled', value });
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const failedItem = (over: Json = {}): Json => ({
    type: 'post_failed', severity: 'danger', count: 2, oldestAt: ago(3 * DAY),
    sentence: { key: 'attention.post_failed', params: { n: 2 } }, action: { verb: 'attention.verb.review', href: '#/posts?filter=needs-you' },
    detail: { reasons: [{ reason: 'media', count: 1, oldestAt: ago(3 * DAY) }, { reason: 'replaced', count: 1, oldestAt: ahead(30 * DAY) }], ids: [ID(1), ID(2), ID(3)] },
    ...over,
});
const oldItem = (over: Json = {}): Json => failedItem({
    type: 'post_failed_old', severity: 'info', count: 2, oldestAt: ago(35 * DAY),
    sentence: { key: 'attention.post_failed_old', params: { n: 2, days: 14 } },
    detail: { reasons: [{ reason: 'tiktok_private', count: 2, oldestAt: ago(35 * DAY) }], ids: [ID(4), ID(5)] }, ...over,
});
const handoffItem = (over: Json = {}): Json => ({
    type: 'handoff', severity: 'warning', count: 1, oldestAt: ago(17 * DAY),
    sentence: { key: 'attention.handoff', params: { n: 1 } }, action: { verb: 'attention.verb.reply', href: '#/inbox?filter=todo' },
    detail: { closed: { count: 1, ids: [ID(7)], oldestAt: ago(17 * DAY) } }, ...over,
});
const beat = (over: Json = {}): Json => ({
    lastCommentAt: ago(12 * DAY), lastDmAt: ago(4 * DAY), lastWebhookAt: ago(2 * HOUR),
    queue: { pending: 0, oldestPendingAt: null, failed: 0 }, worker: { online: true, lastSeenAt: ago(20_000) }, ...over,
});
const summary = (items: Json[], over: Json = {}): Json => ({
    checkedAt: new Date().toISOString(), heartbeat: beat(), items, counts: { inbox: 1, studio: 0, scheduler: 4 }, ...over,
});

interface Rig {
    h: ReturnType<typeof loadDashboard>;
    O: Json;
    calls: Array<{ method: string; id?: string }>;
    toasts: Array<{ message: string; kind: string; onUndo?: () => unknown }>;
    answers: { attention: Json; failOn: Set<string> };
    briefing: { innerHTML: string };
    stats: { innerHTML: string };
    badge: number[];
}

function rig(lang: 'ar' | 'en' = 'en', canOperate = true): Rig {
    const calls: Rig['calls'] = [];
    const answers = { attention: summary([failedItem(), oldItem()]), failOn: new Set<string>() };
    const act = (method: string) => (id: string) => {
        calls.push({ method, id });
        return answers.failOn.has(id) ? Promise.reject(new Error('Meta said no')) : Promise.resolve({ id });
    };
    const badge: number[] = [];
    const h = loadDashboard({
        lang, files: ['dashboard/js/pages/overview.js'],
        globals: {
            API: {
                token: 't',
                archiveScheduledPost: act('archive'), unarchiveScheduledPost: act('unarchive'),
                markConversationHandled: act('handled'), unmarkConversationHandled: act('unhandled'),
                getAttention: () => { calls.push({ method: 'getAttention' }); return Promise.resolve(answers.attention); },
            },
            App: { canOperate: () => canOperate, isAdmin: () => true, canAdminister: () => true, setInboxWaiting: (n: number) => { badge.push(n); } },
            Admin: {},
        },
    });
    const O = h.run<Json>('OverviewPage');
    const toasts: Rig['toasts'] = [];
    h.UI.undoToast = (message: string, options: Json) => { toasts.push({ message, kind: 'undo', onUndo: options && options.onUndo }); return Promise.resolve(false); };
    h.UI.toast = (message: string, type: string) => { toasts.push({ message, kind: String(type) }); return null; };
    const briefing = { innerHTML: '' };
    const stats = { innerHTML: '' };
    O.region = (name: string) => (name === 'briefing' ? briefing : name === 'stats' ? stats : null);
    O._briefingInputs = { statsRes: ok({ activeCampaigns: 1 }), failedRes: ok({ data: [] }), tokenRes: ok({ status: 'valid' }), dailyRes: ok([]), metaRes: ok(null), healthRes: ok({}) };
    O._statsInputs = { statsRes: ok({ activeCampaigns: 1 }), dailyRes: ok([]) };
    return { h, O, calls, toasts, answers, briefing, stats, badge };
}

const alertsOf = (r: Rig, res: Json = ok(r.answers.attention)): Json[] => plain(r.O.attentionAlerts(res, {}));
const btn = (key: string): Json => ({ dataset: { key }, disabled: false, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, style: {}, innerHTML: '', textContent: '' });

describe('the heartbeat (DW-T2): is it working, before what is wrong', () => {
    it('says the last comment, the last DM, that events are arriving and that the Mac worker is online', () => {
        const { h, O } = rig();
        const parts = plain(O.heartbeatParts(ok(summary([]))));
        assert.deepEqual(parts.map((p: Json) => [p.key, p.level, p.text]), [
            ['comments', 'info', 'Last comment 12 days ago'],
            ['dms', 'info', 'Last DM 4 days ago'],
            ['events', 'ok', 'Events arriving'],
            ['worker', 'ok', 'Mac worker online'],
        ]);
        const markup = String(O.renderHeartbeat(ok(summary([]))));
        assert.equal((markup.match(/class="heartbeat-item/g) || []).length, 4);
        assert.ok(markup.includes(h.t('overview.heartbeat.label')));
    });

    it('warns when no event has come for a day, and says for how long', () => {
        const { O } = rig();
        const parts = plain(O.heartbeatParts(ok(summary([], { heartbeat: beat({ lastWebhookAt: ago(3 * DAY) }) }))));
        assert.deepEqual(parts.find((p: Json) => p.key === 'events'), { key: 'events', level: 'warn', icon: 'activity', text: 'No events for 3 days' });
        const never = plain(O.heartbeatParts(ok(summary([], { heartbeat: beat({ lastWebhookAt: null, lastCommentAt: null, lastDmAt: null }) }))));
        assert.deepEqual(never.map((p: Json) => p.text).slice(0, 3), ['No comment yet', 'No DM yet', 'No events yet']);
    });

    it('leaves the worker out for a tenant that never registered one, and warns when it went offline', () => {
        const { O } = rig();
        const none = plain(O.heartbeatParts(ok(summary([], { heartbeat: beat({ worker: { online: false, lastSeenAt: null } }) }))));
        assert.equal(none.some((p: Json) => p.key === 'worker'), false, 'no Mac, nothing to be offline');
        const off = plain(O.heartbeatParts(ok(summary([], { heartbeat: beat({ worker: { online: false, lastSeenAt: ago(5 * HOUR) } }) }))));
        assert.deepEqual(off.find((p: Json) => p.key === 'worker'), { key: 'worker', level: 'warn', icon: 'laptop', text: 'Mac worker offline for 5 hours' });
    });

    it('draws nothing for a summary that has no heartbeat, or no summary', () => {
        const { O } = rig();
        assert.equal(String(O.renderHeartbeat(ok(summary([], { heartbeat: null })))), '');
        assert.equal(String(O.renderHeartbeat({ status: 'rejected', reason: new Error('x') })), '');
        assert.equal(String(O.renderHeartbeat(undefined)), '');
    });

    it('is in the briefing, above the cards', () => {
        const { O } = rig();
        const res = ok(summary([failedItem()]));
        const markup = String(O.renderBriefing(alertsOf(rig(), res), new Date(), res));
        assert.ok(markup.indexOf('class="heartbeat"') > -1 && markup.indexOf('class="heartbeat"') < markup.indexOf('class="briefing-list"'));
    });

    it('speaks فصحى with the right plural: dual for two days, «يومًا» past ten', () => {
        const { h, O } = rig('ar');
        const two = plain(O.heartbeatParts(ok(summary([], { heartbeat: beat({ lastCommentAt: ago(2 * DAY), lastDmAt: ago(12 * DAY) }) }))));
        assert.equal(two[0].text, 'آخر تعليق منذ يومين');
        assert.equal(two[1].text, 'آخر رسالة خاصة منذ 12 يومًا');
        assert.equal(two[2].text, h.t('overview.heartbeat.eventsOk'));
        assert.match(two[3].text, /عامل الماك متصل/);
    });
});

describe('the failed-posts card (DW-T3): why, and how old', () => {
    it('gives one line per reason with its count and age, from the posts\' real reasons', () => {
        const [card] = alertsOf(rig());
        assert.equal(card!.key, 'post_failed');
        assert.equal(card!.level, 'danger');
        assert.equal(card!.reasons.length, 2);
        assert.equal(card!.reasons[0], '1 had a problem with its media · 3 days ago');
        assert.match(card!.reasons[1], /^1 was replaced on purpose: nothing to fix, archive it · dated /, 'a post still ahead has a date, not an age');
        assert.equal(card!.body, 'Why each one failed is below. Archive the ones you no longer want to fix; they stay under Archived in the Scheduler.');
    });

    it('a count of 2 or more is plural, and the TikTok rule says what to do', () => {
        const [recent, old] = alertsOf(rig());
        assert.ok(recent);
        assert.equal(old!.key, 'post_failed_old');
        assert.equal(old!.level, 'info', 'old failures are one quiet line, not a red card');
        assert.equal(old!.title, '2 posts failed more than 14 days ago');
        assert.deepEqual(old!.reasons, ['2 TikTok direct posts need a private TikTok account · 35 days ago']);
    });

    it('the link is the server\'s, one verb, to exactly those posts', () => {
        const [card] = alertsOf(rig());
        assert.equal(card!.href, '#/posts?filter=needs-you');
        assert.equal(card!.action, 'Review');
    });

    it('in Arabic the reasons, ages and plural titles are Arabic, not the server\'s English', () => {
        const r = rig('ar');
        const [recent, old] = alertsOf(r);
        assert.match(recent!.title, /[؀-ۿ]/);
        assert.match(recent!.reasons[0], /^منشور واحد واجه مشكلة في وسائطه · منذ 3 أيام$/);
        assert.equal(old!.title, 'منشوران فشل نشرهما منذ أكثر من 14 يومًا');
        assert.equal(old!.reasons[0], 'منشوران بالنشر المباشر على تيك توك يحتاجان حسابًا خاصًا · منذ 35 يومًا');
        assert.equal(/[a-z]{4,}/i.test(recent!.reasons.join(' ').replace(/dated/gi, '')), false);
    });

    it('an unknown reason reads as "other", never as a missing string', () => {
        const r = rig();
        const [card] = alertsOf(r, ok(summary([failedItem({ detail: { reasons: [{ reason: 'something_new', count: 1, oldestAt: ago(DAY) }], ids: [ID(1)] } })])));
        assert.match(card!.reasons[0], /^1 failed for another reason/);
    });
});

describe('clearing from Today (DW-T3)', () => {
    it('offers "Archive these" on a failed card with the rows to archive, and "Mark handled" on a conversation card whose window has closed', () => {
        const r = rig();
        const list = alertsOf(r, ok(summary([failedItem(), handoffItem()])));
        const posts = list.find((a) => a.key === 'post_failed')!;
        assert.deepEqual(posts.clear, { kind: 'archive', ids: [ID(1), ID(2), ID(3)], count: 2, icon: 'eye-off', button: 'Archive these' });
        const waiting = list.find((a) => a.key === 'waiting')!;
        assert.equal(waiting.clear.kind, 'handled');
        assert.deepEqual(waiting.clear.ids, [ID(7)]);
        assert.equal(waiting.clear.button, 'Mark handled');
        assert.equal(waiting.clear.line, 'A reply can no longer reach 1 conversation: Meta’s 24-hour window has closed.');
    });

    it('offers nothing to clear when no conversation is past its window, and says "Archive it" for one post', () => {
        const r = rig();
        const list = alertsOf(r, ok(summary([failedItem({ count: 1, detail: { reasons: [{ reason: 'media', count: 1, oldestAt: ago(DAY) }], ids: [ID(1)] } }), handoffItem({ detail: undefined })])));
        assert.equal(list.find((a) => a.key === 'waiting')!.clear, undefined);
        assert.equal(list.find((a) => a.key === 'post_failed')!.clear.button, 'Archive it');
    });

    it('a viewer is shown neither action (the routes would answer 403)', () => {
        const r = rig('en', false);
        const list = alertsOf(r, ok(summary([failedItem(), oldItem(), handoffItem()])));
        assert.equal(list.length, 3);
        assert.deepEqual(list.map((a) => a.clear), [undefined, undefined, undefined]);
        assert.equal(String(r.O.renderBriefing(list, new Date(), ok(summary([])))).includes('overview:clear'), false);
    });

    it('draws the button with the one action and a key, never the ids, in the markup', () => {
        const r = rig();
        const markup = String(r.O.renderBriefing(alertsOf(r), new Date(), ok(r.answers.attention)));
        assert.equal((markup.match(/data-action="overview:clear"/g) || []).length, 2);
        assert.match(markup, /data-key="post_failed"/);
        assert.equal(markup.includes(ID(1)), false);
    });

    it('Archive these archives every row at once, asks nothing, offers ONE Undo, and reads the summary again', async () => {
        const r = rig();
        r.O.paintBriefing(r.briefing, ok(r.answers.attention));
        r.answers.attention = summary([oldItem()]);
        await r.O.clear(btn('post_failed'));
        assert.deepEqual(r.calls.filter((c) => c.method === 'archive').map((c) => c.id), [ID(1), ID(2), ID(3)]);
        assert.equal(r.h.native.confirms.length, 0, 'no question: Undo instead');
        assert.deepEqual(r.toasts.map((t) => t.kind), ['undo']);
        assert.equal(r.toasts[0]!.message, 'Archived 2 posts. They will not be published.');
        assert.equal(r.calls.filter((c) => c.method === 'getAttention').length, 1);
        assert.equal(r.briefing.innerHTML.includes('post_failed"'), false, 'the card is gone from the screen at once');
    });

    it('Undo really restores: it un-archives exactly the rows that were archived, then reads the summary again', async () => {
        const r = rig();
        r.O.paintBriefing(r.briefing, ok(r.answers.attention));
        await r.O.clear(btn('post_failed'));
        r.calls.length = 0;
        await r.toasts[0]!.onUndo!();
        assert.deepEqual(r.calls.filter((c) => c.method === 'unarchive').map((c) => c.id), [ID(1), ID(2), ID(3)]);
        assert.equal(r.calls.filter((c) => c.method === 'getAttention').length, 1);
        assert.equal(r.h.announcements.includes('Back in the queue.'), true);
    });

    it('Undo says so when a row could not be brought back, instead of pretending', async () => {
        const r = rig();
        r.O.paintBriefing(r.briefing, ok(r.answers.attention));
        await r.O.clear(btn('post_failed'));
        r.answers.failOn.add(ID(2));
        await assert.rejects(Promise.resolve(r.toasts[0]!.onUndo!()), /Could not bring everything back/);
    });

    it('Mark handled marks each conversation, with ONE Undo that reopens them', async () => {
        const r = rig();
        r.answers.attention = summary([handoffItem()]);
        r.O.paintBriefing(r.briefing, ok(r.answers.attention));
        await r.O.clear(btn('waiting'));
        assert.deepEqual(r.calls.filter((c) => c.method === 'handled').map((c) => c.id), [ID(7)]);
        assert.equal(r.toasts[0]!.message, 'Marked 1 conversation handled. If they write again, it comes back to your list.');
        r.calls.length = 0;
        await r.toasts[0]!.onUndo!();
        assert.deepEqual(r.calls.filter((c) => c.method === 'unhandled').map((c) => c.id), [ID(7)]);
    });

    it('a request that failed changes nothing and says so; a partial one undoes only what happened and reports the rest', async () => {
        const r = rig();
        r.O.paintBriefing(r.briefing, ok(r.answers.attention));
        for (const id of [ID(1), ID(2), ID(3)]) r.answers.failOn.add(id);
        await r.O.clear(btn('post_failed'));
        assert.deepEqual(r.toasts.map((t) => t.kind), ['error'], 'no undo for nothing');
        r.toasts.length = 0;
        r.answers.failOn.delete(ID(1));
        r.O.paintBriefing(r.briefing, ok(r.answers.attention));
        r.calls.length = 0;
        await r.O.clear(btn('post_failed'));
        assert.deepEqual(r.toasts.map((t) => t.kind), ['undo', 'error']);
        assert.equal(r.toasts[0]!.message, 'Archived 1 post. It will not be published.');
        assert.equal(r.toasts[1]!.message, '2 could not be changed. Try them again from the Scheduler or the Inbox.');
        await r.toasts[0]!.onUndo!();
        assert.deepEqual(r.calls.filter((c) => c.method === 'unarchive').map((c) => c.id), [ID(1)], 'only the row that was archived');
    });

    it('a viewer who somehow triggers it changes nothing', async () => {
        const r = rig('en', false);
        r.O._clears = { post_failed: { kind: 'archive', ids: [ID(1)], count: 1 } };
        await r.O.clear(btn('post_failed'));
        assert.deepEqual(r.calls, []);
    });

    it('a double click is one request set', async () => {
        const r = rig();
        r.O.paintBriefing(r.briefing, ok(r.answers.attention));
        const el = btn('post_failed');
        const first = r.O.clear(el);
        const second = r.O.clear(el);
        await Promise.all([first, second]);
        await settle();
        assert.equal(r.calls.filter((c) => c.method === 'archive').length, 3);
    });

    it('after a clear the waiting tile and the Inbox badge follow the new count', async () => {
        const r = rig();
        r.O.paintBriefing(r.briefing, ok(r.answers.attention));
        r.answers.attention = summary([], { counts: { inbox: 0, studio: 0, scheduler: 0 } });
        await r.O.refreshAttention();
        assert.deepEqual(r.badge, [0]);
        assert.match(r.stats.innerHTML, /id="stat-waiting">0</);
    });
});

describe('Today asks for what it needs (DW-T2)', () => {
    it('reads the attention summary once and no scheduled post or conversation list; the heartbeat and the cards come from it', async () => {
        const r = rig();
        const names: string[] = [];
        const api = r.h.ctx.API as Json;
        for (const m of ['getStats', 'getInteractions', 'getTokenStatus', 'getMetaConnection', 'getTenantHealth', 'getDailyStats', 'getGrowthOverview', 'getGrowthSettings', 'getProfileProgress', 'getAttention']) {
            api[m] = () => { names.push(m); return Promise.resolve(m === 'getAttention' ? summary([failedItem()]) : m === 'getInteractions' ? { data: [] } : m === 'getDailyStats' ? [] : {}); };
        }
        for (const region of ['briefing', 'growth', 'stats', 'charts', 'recent', 'busy', 'profile']) r.h.el(`region:${region}`);
        r.h.el('page-container');
        r.O.region = (name: string) => (name === 'briefing' ? r.briefing : name === 'stats' ? r.stats : null);
        r.O.render();
        await settle(20);
        assert.equal(names.filter((n) => n === 'getAttention').length, 1);
        assert.equal(names.includes('getScheduledPosts'), false);
        assert.equal(names.includes('getConversations'), false);
        assert.match(r.briefing.innerHTML, /class="heartbeat"/);
        assert.match(r.briefing.innerHTML, /2 posts failed to publish/);
        r.O.destroy();
    });
});
