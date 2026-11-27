/**
 * The Studio's alarms on screen (research USE-1, USE-4): the helpers in attention.js that read `GET /api/attention`, the Today briefing's alerts, the
 * strip above every Studio screen, and the badge on the Studio nav item. The server decides what is an item (src/services/attention.test.ts); these pin
 * that the dashboard draws exactly those, in both languages, with one action each, and nothing it should not.
 *
 * The real shipped files, through `_harness.ts`. No network: `API` is a stub.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeEl, loadDashboard, type Json } from './_harness.js';

const AT = '2026-11-27T05:00:00.000Z';

const SIGNED_OUT = { type: 'mac_signed_out', severity: 'danger', count: 1, sentence: { key: 'attention.mac_signed_out', params: {} }, action: { verb: 'attention.verb.howToFix', href: '#/help/worker#claude-signed-out' }, oldestAt: AT };
const OFFLINE = { type: 'worker_offline', severity: 'warning', count: 1, sentence: { key: 'attention.worker_offline', params: { n: 3, minutes: 30 } }, action: { verb: 'attention.verb.howToFix', href: '#/help/worker#worker-offline' } };
const TIKTOK = { type: 'tiktok_draft', severity: 'info', count: 4, sentence: { key: 'attention.tiktok_draft', params: { n: 4, days: 3 } }, action: { verb: 'attention.verb.open', href: '#/posts?filter=needs-you' } };
const REELS = { type: 'reel_review', severity: 'warning', count: 2, sentence: { key: 'attention.reel_review', params: { n: 2 } }, action: { verb: 'attention.verb.review', href: '#/monteur' } };
const HANDOFF = { type: 'handoff', severity: 'warning', count: 1, sentence: { key: 'attention.handoff', params: { n: 1 } }, action: { verb: 'attention.verb.reply', href: '#/inbox?filter=todo' } };

const summary = (items: Json[], studio = items.length): Json => ({ checkedAt: AT, items, counts: { inbox: 0, studio, scheduler: 0 } });

describe('Attention: the Studio helpers', () => {
    const { Attention } = loadDashboard();

    it('takes only the Studio’s four item types, in the server’s order, and leaves the Inbox’s and the Posts’ to their own screens', () => {
        const items = Attention.studioItems(summary([SIGNED_OUT, HANDOFF, REELS, OFFLINE, TIKTOK]));
        assert.deepEqual(items.map((i: Json) => i.type), ['mac_signed_out', 'reel_review', 'worker_offline', 'tiktok_draft']);
    });

    it('drops anything that is not an item with a sentence and one action to a screen of this dashboard', () => {
        const bad = [
            { ...SIGNED_OUT, action: { verb: 'x', href: 'https://evil.example/' } },
            { ...SIGNED_OUT, action: { verb: 'x', href: 'javascript:alert(1)' } },
            { ...SIGNED_OUT, action: undefined },
            { ...SIGNED_OUT, sentence: undefined },
            null, 'x', { type: 'mac_signed_out' },
        ];
        assert.equal(Attention.studioItems(summary(bad)).length, 0);
        for (const nothing of [null, undefined, {}, { items: null }, { items: 'x' }]) assert.equal(Attention.studioItems(nothing).length, 0);
    });

    it('reads counts.studio as a whole number, and anything else as none', () => {
        assert.equal(Attention.studioCount(summary([], 3)), 3);
        assert.equal(Attention.studioCount(summary([], 2.9)), 2);
        for (const bad of [summary([], 0), summary([], -1), summary([], NaN), { counts: { studio: 'x' } }, { counts: null }, {}, null, undefined]) {
            assert.equal(Attention.studioCount(bad), 0, JSON.stringify(bad));
        }
    });

    it('formats numbers with the page’s formatter and leaves the rest as text', () => {
        const out = Attention.studioParams(OFFLINE, (n: number) => `<${n}>`);
        assert.deepEqual(JSON.parse(JSON.stringify(out)), { n: '<3>', minutes: '<30>' });
        assert.deepEqual(JSON.parse(JSON.stringify(Attention.studioParams(SIGNED_OUT, String))), {});
    });

    it('a danger is danger, a warning is warning, everything else is info', () => {
        assert.deepEqual([SIGNED_OUT, OFFLINE, TIKTOK, null].map((i) => Attention.studioLevel(i)), ['danger', 'warning', 'info', 'info']);
    });
});

function shell(lang: 'ar' | 'en' = 'en') {
    const h = loadDashboard({ app: true, lang, globals: { Admin: { confirm: () => {} } } });
    const host = h.el('studio-alarm');
    host.hidden = true;
    const item = new FakeEl('', 'a');
    item.dataset = { page: 'studio' };
    const badges: FakeEl[] = [];
    // `.nav-item[data-page="studio"]` finds the Studio item; its `.nav-count` is created on demand.
    h.document.querySelector = (selector: string) => (selector === '.nav-item[data-page="studio"]' ? item : null);
    (item as Json).querySelector = (selector: string) => (selector === '.nav-count' ? (badges[0] ?? null) : null);
    (item as Json).appendChild = (child: FakeEl) => { badges.push(child); return child; };
    h.document.createElement = (tag: string) => new FakeEl('', tag);
    return { h, App: h.App as Json, host, item, badges };
}

describe('the strip above the Studio', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`shows each item’s sentence and its one action on a Studio screen, in ${lang}`, () => {
            const { h, App, host } = shell(lang);
            App._studioAttention = summary([SIGNED_OUT, OFFLINE, REELS]);
            App.currentPage = 'monteur';
            App.renderStudioAlarm();
            assert.equal(host.hidden, false);
            assert.ok(host.innerHTML.includes(h.t('attention.mac_signed_out')), 'the sentence');
            assert.ok(host.innerHTML.includes(h.t('attention.mac_signed_out.body')), 'and what to do');
            assert.ok(host.innerHTML.includes(h.t('attention.worker_offline', { n: '3', minutes: '30' })), 'with its numbers');
            assert.equal((host.innerHTML.match(/<a class="btn btn-secondary btn-sm"/g) ?? []).length, 3, 'one action each');
            assert.ok(host.innerHTML.includes('href="#/help/worker#claude-signed-out"'));
            assert.ok(host.innerHTML.includes('role="alert"'), 'the danger is announced');
        });
    }

    it('has Arabic for every sentence, body and verb it can show (no English inside the Arabic page)', () => {
        const en = loadDashboard({ lang: 'en' });
        const ar = loadDashboard({ lang: 'ar' });
        for (const key of [
            'attention.mac_signed_out', 'attention.mac_signed_out.body', 'attention.worker_offline', 'attention.worker_offline.body',
            'attention.tiktok_draft', 'attention.tiktok_draft.body', 'attention.reel_review', 'attention.reel_review.body',
            'attention.verb.howToFix', 'attention.verb.open', 'attention.verb.review', 'nav.studioNeeds', 'studio.alarm.label',
        ]) {
            assert.notEqual(en.t(key), key, `${key} in English`);
            assert.notEqual(ar.t(key), key, `${key} in Arabic`);
            assert.notEqual(ar.t(key), en.t(key), `${key} is translated`);
        }
    });

    it('is not drawn on a screen that is not the Studio’s, and is removed there', () => {
        const { App, host } = shell();
        App._studioAttention = summary([SIGNED_OUT]);
        App.currentPage = 'monteur';
        App.renderStudioAlarm();
        assert.equal(host.hidden, false);
        App.currentPage = 'posts';
        App.renderStudioAlarm();
        assert.equal(host.hidden, true);
        assert.equal(host.innerHTML, '');
    });

    it('is drawn on all four Studio screens and nowhere else', () => {
        const { App } = shell();
        assert.deepEqual([...App.STUDIO_PAGES], ['studio', 'monteur', 'infographics', 'explainers']);
    });

    it('says nothing when the Studio has nothing for the owner, or before anything has been read', () => {
        const { App, host } = shell();
        App.currentPage = 'studio';
        App.renderStudioAlarm();
        assert.equal(host.hidden, true);
        App._studioAttention = summary([HANDOFF], 0);
        App.renderStudioAlarm();
        assert.equal(host.hidden, true, 'an Inbox item is not the Studio’s');
    });

    it('escapes what it draws: the server’s text is data', () => {
        const { App, host } = shell();
        App._studioAttention = summary([{ ...OFFLINE, sentence: { key: 'attention.worker_offline', params: { n: '<img src=x onerror=1>', minutes: 30 } } }]);
        App.currentPage = 'studio';
        App.renderStudioAlarm();
        assert.equal(host.innerHTML.includes('<img src=x'), false);
    });
});

describe('the Studio nav badge', () => {
    it('shows counts.studio, hidden at zero, and tells a screen reader what it counts', () => {
        const { h, App, badges } = shell();
        App._studioAttention = summary([REELS, TIKTOK], 6);
        App.renderStudioNeeds();
        assert.equal(badges.length, 1);
        assert.equal(badges[0]!.hidden, false);
        assert.ok(badges[0]!.innerHTML.includes('>6<'));
        assert.ok(badges[0]!.innerHTML.includes(h.t('nav.studioNeeds', { n: '6' })));
        App._studioAttention = summary([], 0);
        App.renderStudioNeeds();
        assert.equal(badges[0]!.hidden, true);
    });

    it('does not make a badge for nothing', () => {
        const { App, badges } = shell();
        App.renderStudioNeeds();
        assert.equal(badges.length, 0);
    });
});

describe('the poll', () => {
    it('keeps what it showed when a read fails: a failed read is not "all clear"', async () => {
        let fail = false;
        const calls: string[] = [];
        const h = loadDashboard({ app: true, globals: { API: { token: 't', request: async (path: string) => { calls.push(path); if (fail) throw new Error('500'); return summary([SIGNED_OUT]); } } } });
        const app = h.App as Json;
        await app.refreshStudioAttention();
        assert.deepEqual(calls, ['/attention']);
        assert.equal(app.studioAlarmItems().length, 1);
        fail = true;
        await app.refreshStudioAttention();
        assert.equal(app.studioAlarmItems().length, 1, 'still shown');
        app.stopStudioAttentionPoll();
        assert.equal(app.studioAlarmItems().length, 0, 'forgotten at sign-out');
    });

    it('asks every five minutes while the tab is visible, polls once however often it is started, and asks again on opening a Studio screen only when stale', async () => {
        const calls: string[] = [];
        const h = loadDashboard({ app: true, globals: { API: { token: 't', request: async (path: string) => { calls.push(path); return summary([]); } } } });
        const app = h.App as Json;
        assert.equal(app.STUDIO_ATTENTION_MS, 300000);
        app.startStudioAttentionPoll();
        app.startStudioAttentionPoll();
        await new Promise((r) => setImmediate(r));
        assert.equal(calls.length, 1, 'the second start changed nothing');
        app.refreshStudioAttentionIfStale();
        assert.equal(calls.length, 1, 'fresh: not asked again');
        app._studioAttentionAt = Date.now() - app.STUDIO_ATTENTION_FRESH_MS - 1;
        app.refreshStudioAttentionIfStale();
        assert.equal(calls.length, 2, 'stale: asked');
        app.stopStudioAttentionPoll();
        assert.equal(app._studioTimer, null);
    });
});

describe('the poll and the sign-out', () => {
    it('stops with the admin poll at every place a session ends, so a signed-out tab keeps no alarm', async () => {
        const h = loadDashboard({ app: true, globals: { API: { token: 't', request: async () => summary([SIGNED_OUT]) } } });
        const app = h.App as Json;
        app.startStudioAttentionPoll();
        await new Promise((r) => setImmediate(r));
        assert.ok(app._studioTimer, 'running');
        assert.equal(app.studioAlarmItems().length, 1);
        app.stopAdminStatusPoll();
        assert.equal(app._studioTimer, null);
        assert.equal(app.studioAlarmItems().length, 0);
    });

    it('does not keep a process alive for its five minutes (a test’s timer is unref’d; a page’s is a number)', () => {
        const h = loadDashboard({ app: true, globals: { API: { token: 't', request: async () => summary([]) } } });
        const app = h.App as Json;
        app.startStudioAttentionPoll();
        const timer = app._studioTimer;
        assert.ok(typeof timer.hasRef !== 'function' || timer.hasRef() === false);
        app.stopStudioAttentionPoll();
    });
});

describe('Today', () => {
    const ok = (value: unknown) => ({ status: 'fulfilled', value });
    const overview = (lang: 'ar' | 'en' = 'en') => {
        const h = loadDashboard({
            lang, files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/overview.js'],
            globals: { API: { token: 't' }, App: { isAdmin: () => true, canAdminister: () => true, canOperate: () => true, hashParam: () => '', hashParams: () => ({}), route: (p: string) => `#/${p}`, setInboxWaiting: () => undefined } },
        });
        return { h, OV: h.run<Json>('OverviewPage') };
    };
    const alerts = (OV: Json, attentionRes?: unknown) => JSON.parse(JSON.stringify(
        OV.buildAlerts({ activeCampaigns: 1 }, ok({ data: [] }), ok({ status: 'valid' }), ok([]), ok({ data: [] }), ok([]), ok(null), ok({}), attentionRes),
    )) as Json[];

    it('puts each Studio item in the briefing with its sentence, its way to fix it and ONE link, in the right tone', () => {
        const { h, OV } = overview();
        const list = alerts(OV, ok(summary([SIGNED_OUT, OFFLINE, TIKTOK, REELS])));
        assert.deepEqual(list.map((a) => [a.icon, a.level]), [['key-round', 'danger'], ['laptop', 'warning'], ['music-2', 'info'], ['scissors', 'warning']]);
        const first = list[0]!;
        assert.equal(first.title, h.t('attention.mac_signed_out'));
        assert.equal(first.body, h.t('attention.mac_signed_out.body'));
        assert.equal(first.action, h.t('attention.verb.howToFix'));
        assert.equal(first.href, '#/help/worker#claude-signed-out');
        assert.equal(first.target, undefined, 'one link, not two');
    });

    it('sorts the danger above the warnings', () => {
        const { OV } = overview();
        const sorted = JSON.parse(JSON.stringify(OV.sortAlerts(OV.buildAlerts({ activeCampaigns: 1 }, ok({ data: [] }), ok({ status: 'valid' }), ok([]), ok({ data: [] }), ok([]), ok(null), ok({}), ok(summary([REELS, SIGNED_OUT]))))));
        assert.equal(sorted[0].icon, 'key-round');
    });

    it('adds nothing when the read failed, when there is none, or when the server has no such items', () => {
        const { OV } = overview();
        assert.deepEqual(alerts(OV, { status: 'rejected', reason: new Error('x') }), []);
        assert.deepEqual(alerts(OV, undefined), []);
        assert.deepEqual(alerts(OV, ok(summary([HANDOFF], 0))), []);
        assert.deepEqual(alerts(OV, ok(null)), []);
    });

    it('draws the link as an anchor to the server’s address, and escapes the sentence', () => {
        const { OV } = overview();
        const list = alerts(OV, ok(summary([SIGNED_OUT])));
        const markup = String(OV.renderBriefing(list, new Date(AT)));
        assert.ok(markup.includes('href="#/help/worker#claude-signed-out"'));
    });

    it('says it in Arabic too', () => {
        const { h, OV } = overview('ar');
        const [first] = alerts(OV, ok(summary([SIGNED_OUT])));
        assert.equal(first!.title, h.t('attention.mac_signed_out'));
        assert.match(first!.title, /[؀-ۿ]/);
    });
});
