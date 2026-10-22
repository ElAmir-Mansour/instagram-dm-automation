/**
 * Ads, phase A9: the Rules tab (`#/ads_rules`), the dashboard half (spec 002, T164).
 *
 * The REAL `ads_rules.js` (with `ads_campaigns.js` for the tab bar) in the shared `node:vm` harness, the API stubbed:
 *   - the four templates, each opening the dialog prefilled; the cost one asks for the owner's amount;
 *   - the custom form refuses what the server would (pause with resume, a rejected ad that does anything but tell, a bad percentage) and
 *     posts the server's shape; a rule that raises says it will only ever propose;
 *   - each rule in one sentence, "not watching" after 24 h, and the history: outcomes, reasons, what was done and why not;
 *   - viewers get no write controls; names the server wrote are escaped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/[⁦⁧⁨⁩]/g, '').replace(/\s+/g, ' ').trim();

const TEMPLATES = [
    { id: 'cpc_high_pause', needsValue: true, spec: { scope: { level: 'ad', objectIds: 'all' }, conditions: [{ metric: 'cost_per_conversation', op: '>', value: 15, window: '3d' }], minData: { impressions: 500 }, actions: [{ type: 'pause' }, { type: 'notify' }] } },
    { id: 'spending_fast_notify', needsValue: false, spec: { scope: { level: 'adset', objectIds: 'all' }, conditions: [{ metric: 'budget_pace', op: '>', value: 1.5, window: 'today' }], minData: {}, actions: [{ type: 'notify' }] } },
    { id: 'frequency_lower', needsValue: false, spec: { scope: { level: 'campaign', objectIds: 'all' }, conditions: [{ metric: 'frequency', op: '>', value: 3, window: 'today' }], minData: { impressions: 1000 }, actions: [{ type: 'lower_budget', percent: 20 }, { type: 'notify' }] } },
    { id: 'rejected_notify', needsValue: false, spec: { scope: { level: 'ad', objectIds: 'all' }, conditions: [{ metric: 'rejected', op: '>=', value: 1, window: 'today' }], minData: {}, actions: [{ type: 'notify' }] } },
];

function rule(over: Json = {}): Json {
    return {
        id: 'r1', name: 'Too expensive <b>x</b>', enabled: true, raises: false, blind: false,
        scope: { level: 'ad', objectIds: 'all' }, conditions: [{ metric: 'cost_per_conversation', op: '>', value: 15, window: '3d' }],
        minData: { impressions: 500 }, actions: [{ type: 'pause' }, { type: 'notify' }],
        approvedBy: 'u', approvedAt: '2026-10-22T08:00:00Z', lastOkAt: '2026-10-22T11:00:00Z', createdAt: '2026-10-22T08:00:00Z', updatedAt: '2026-10-22T08:00:00Z',
        lastRun: { ranAt: '2026-10-22T11:00:00Z', outcome: 'acted' },
        ...over,
    };
}

async function open(setup: { data?: Json; owner?: boolean; api?: Json } = {}) {
    const calls: Array<[string, unknown[]]> = [];
    const record = (name: string, fn: (...args: Json[]) => unknown) => (...args: Json[]) => { calls.push([name, args]); return fn(...args); };
    const api: Json = {
        token: 't',
        getAdsRules: record('getAdsRules', async () => JSON.parse(JSON.stringify(setup.data ?? { rules: [rule()], templates: TEMPLATES, currency: 'SAR' }))),
        createAdsRule: record('createAdsRule', async (body: Json) => ({ rule: rule({ id: 'r2', ...body }) })),
        updateAdsRule: record('updateAdsRule', async (id: string, patch: Json) => ({ rule: rule({ id, ...patch }) })),
        getAdsRuleRuns: record('getAdsRuleRuns', async () => ({ runs: [
            { id: 'run1', ranAt: '2026-10-22T11:00:00Z', outcome: 'acted', reason: null, proposalId: null, ops: ['op1'], matched: [
                { objectId: 'a1', metaId: 'm1', name: 'Spring ad', values: { 'cost_per_conversation:3d': 18.5 }, steps: [{ kind: 'op', objectId: 'a1', action: 'pause' }], skipped: [] },
                { objectId: 'a2', metaId: 'm2', name: 'Busy ad', values: { 'cost_per_conversation:3d': null }, steps: [], skipped: ['busy'] },
            ] },
            { id: 'run2', ranAt: '2026-10-22T10:00:00Z', outcome: 'blind', reason: 'throttled', proposalId: null, ops: [], matched: [] },
        ] })),
        ...(setup.api ?? {}),
    };
    const globals: Json = {
        API: new Proxy(api, { get: (target, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) }),
        App: { canOperate: () => setup.owner !== false, canAdminister: () => setup.owner !== false },
    };
    const h = loadDashboard({ lang: 'en', files: ['dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_rules.js'], globals });
    h.UI.toast = () => {};
    let modal = '';
    h.UI.showModal = (markup: unknown) => { modal = String(markup); };
    h.UI.closeModal = () => { modal = ''; };
    const container = h.el('page-container');
    const page: Json = h.run('AdsRulesPage');
    await page.render();
    await settle();
    return { h, page, calls, screen: (): string => String(container.innerHTML), modal: () => modal, called: (n: string) => calls.filter(([c]) => c === n) };
}

describe('Rules tab: the list (T164)', () => {
    it('marks the tab, says each rule in one sentence, escapes the name, and shows the last check', async () => {
        const { page, screen } = await open();
        const html = screen();
        assert.ok(html.includes('href="#/ads_rules"') && /aria-current="page"/.test(html));
        assert.ok(!html.includes('<b>x</b>') && html.includes('&lt;b&gt;'));
        const words = text(html);
        assert.match(words, /All Ads: when Cost per conversation \(last 3 days\) is over 15 SAR, after 500 impressions → pause, tell me\./);
        assert.match(words, /Last check: .* Acted/);
        page.destroy();
    });

    it('shows "not watching" and "asks you each time" when the server says so', async () => {
        const { page, screen } = await open({ data: { rules: [rule({ blind: true, raises: true, actions: [{ type: 'raise_budget', percent: 20 }] })], templates: TEMPLATES, currency: 'SAR' } });
        assert.match(screen(), /id="adsrule-blind-r1"/);
        assert.match(screen(), /id="adsrule-asks-r1"/);
        assert.match(text(screen()), /propose raising the daily budget 20%/);
        page.destroy();
    });

    it('the history lists outcomes, values, what was done and why not', async () => {
        const { h, page, screen } = await open();
        await page.history('r1');
        await settle();
        const words = text(screen());
        assert.match(words, /Spring ad ?: Cost per conversation \(last 3 days\) 18\.5 SAR → paused/);
        assert.match(words, /Busy ad ?: .*none yet left alone: a change is already waiting on it/);
        assert.match(words, /Could not check Meta is limiting requests/);
        page.destroy();
    });

    it('viewers read, with no write controls and no templates', async () => {
        const { page, screen } = await open({ owner: false });
        const html = screen();
        assert.ok(!html.includes('adsrule:new') && !html.includes('adsrule:edit') && !html.includes('adsrule:toggle') && !html.includes('adsrule:remove'));
        assert.ok(!html.includes('id="adsrule-templates"'));
        assert.ok(html.includes('adsrule:history'));
        page.destroy();
    });

    it('a 404 is "ads are off"', async () => {
        const { h, page, screen } = await open({ api: { getAdsRules: async () => { throw Object.assign(new Error('off'), { status: 404 }); } } });
        assert.ok(text(screen()).includes(h.t('ads.disabled.title')));
        page.destroy();
    });
});

describe('Rules tab: templates and the form (T164)', () => {
    it('offers the four templates; the cost one asks for the amount', async () => {
        const { page, screen, modal } = await open();
        for (const id of ['cpc_high_pause', 'spending_fast_notify', 'frequency_lower', 'rejected_notify']) assert.match(screen(), new RegExp(`id="adsrule-tpl-${id}"`));
        page.useTemplate('cpc_high_pause');
        await settle();
        assert.match(modal(), /id="adsrule-f-value-0"[^>]*value=""/);
        assert.equal(page.problem(page.draft), 'value');
        page.useTemplate('frequency_lower');
        await settle();
        assert.equal(page.problem(page.draft), null);
        assert.match(modal(), /id="adsrule-f-effect-lower_budget"[^>]*checked/);
        page.destroy();
    });

    it('refuses what the server refuses', async () => {
        const { page } = await open();
        const d = page.blankDraft();
        d.name = 'x';
        d.conditions[0].value = 10;
        assert.equal(page.problem(d), null);
        assert.equal(page.problem({ ...d, conditions: [{ metric: 'rejected', op: '>=', value: 1, window: 'today' }] }), 'rejected');
        assert.equal(page.problem({ ...d, effect: 'lower_budget', percent: 95 }), 'lowerPercent');
        assert.equal(page.problem({ ...d, effect: 'raise_budget', percent: 101 }), 'raisePercent');
        assert.equal(page.problem({ ...d, effect: 'none', notify: false }), 'noAction');
        assert.equal(page.problem({ ...d, level: 'adset', conditions: [{ metric: 'frequency', op: '>', value: 3, window: 'today' }] }), 'frequency');
        assert.equal(page.problem({ ...d, level: 'ad', conditions: [{ metric: 'budget_pace', op: '>', value: 1.5, window: 'today' }] }), 'pace');
        assert.equal(page.problem({ ...d, name: ' ' }), 'name');
        page.destroy();
    });

    it('posts the server\'s shape and says a raising rule only proposes', async () => {
        const { page, called, modal } = await open();
        const d = page.blankDraft();
        Object.assign(d, { name: 'Cheap chats', level: 'adset', effect: 'raise_budget', percent: 25, notify: false, minData: { impressions: '800', spend: '' } });
        d.conditions = [{ metric: 'cost_per_conversation', op: '<', value: '4', window: '7d' }];
        await page.openForm(d);
        assert.match(modal(), /id="adsrule-f-asks"/);
        assert.deepEqual(JSON.parse(JSON.stringify(page.toBody(d))), {
            name: 'Cheap chats', scope: { level: 'adset', objectIds: 'all' },
            conditions: [{ metric: 'cost_per_conversation', op: '<', value: 4, window: '7d' }],
            minData: { impressions: 800 }, actions: [{ type: 'raise_budget', percent: 25 }],
        });
        page.draft = d;
        page.readForm = () => d;
        await page.save();
        assert.equal(called('createAdsRule').length, 1);
        assert.equal((called('createAdsRule')[0]![1][0] as Json).name, 'Cheap chats');
        page.destroy();
    });
});

describe('Rules tab: the shell', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`has its title, tab and every key it uses in ${lang}`, () => {
            const h = loadDashboard({ lang, files: ['dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_rules.js'] });
            for (const key of ['nav.ads_rules', 'page.ads_rules.subtitle', 'ads.tabs.rules']) assert.notEqual(h.t(key), key, key);
            const source = readFileSync('dashboard/js/pages/ads_rules.js', 'utf8');
            for (const [, key] of source.matchAll(/t\('(ads\.rules\.[^']+)'/g)) assert.notEqual(h.t(key!), key, key);
            for (const group of [
                ['outcome', ['ok', 'acted', 'proposed', 'skipped_no_data', 'blind']],
                ['reason', ['not_configured', 'token_dead', 'throttled', 'stale', 'error']],
                ['skipped', ['busy', 'already_paused', 'no_budget', 'at_minimum', 'edit_limit', 'cooldown', 'taken']],
                ['metric', ['spend', 'results', 'cost_per_result', 'cost_per_conversation', 'ctr', 'frequency', 'cpm', 'budget_pace', 'rejected']],
                ['op', ['gt', 'gte', 'lt', 'lte']],
                ['effect', ['none', 'pause', 'lower_budget', 'raise_budget', 'resume']],
                ['tpl', ['cpc_high_pause', 'spending_fast_notify', 'frequency_lower', 'rejected_notify']],
            ] as const) for (const k of group[1]) assert.notEqual(h.t(`ads.rules.${group[0]}.${k}`), `ads.rules.${group[0]}.${k}`);
        });
    }
});
