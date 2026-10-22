/**
 * Ads, phase A1 "safety foundation": the dashboard half (spec 002, T024).
 *
 * The REAL `ads.js` and `settings.js` in the shared `node:vm` harness, with the API stubbed to the A1 contract:
 *
 *   - `GET /ads/overview` answers 200 `{ configured: false, steps }` for a tenant that has not finished setting up: the Ads screen
 *     draws the steps checklist (each step with its hint and a help link), never the error panel it used to fall into on the 409;
 *   - a configured tenant's money comes from `overview.money`, carries the "excluding tax" note, and a guard that is blind or a token
 *     that is dead is a banner, not a silent screen;
 *   - the Settings ads card draws the four steps, the alert recipients block (required kinds checked and locked) and the account
 *     spending-limit row with the changes left today.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

const STEPS_NONE = [
    { id: 'token', done: false, hint: 'Paste a system-user token.', hintCode: 'token_missing' },
    { id: 'account', done: false, hint: 'Choose the ad account.', hintCode: 'account_missing' },
    { id: 'payment', done: false, hint: null, hintCode: null },
    { id: 'limits', done: false, hint: 'Set both limits.', hintCode: 'limits_missing' },
];

const ACCOUNT = {
    name: 'Main account', currency: 'USD', timezone: 'Europe/London', timezoneOffsetHours: 1, status: 1, statusLabel: 'active', disableReason: null,
    hasPaymentMethod: true, isPrepay: false, spendCap: null, amountSpent: 120.5, minDailyBudget: 1, billingUrl: 'https://example.test/billing',
    adsManagerUrl: 'https://example.test/manager', syncedAt: '2026-10-22T09:30:00.000Z',
};

const SETTINGS: Json = {
    enabled: true, configured: true,
    steps: [
        { id: 'token', done: true, hint: null }, { id: 'account', done: true, hint: null },
        { id: 'payment', done: true, hint: null }, { id: 'limits', done: true, hint: null },
    ],
    adAccountId: '1234567890',
    token: { set: true, last4: 'abcd', source: 'pasted', expiresAt: null, health: 'ok' },
    account: ACCOUNT, accountError: null,
    limits: { maxDailyBudget: 10, monthlyCap: 100 }, ceiling: { maxDailyBudget: 50, monthlyCap: 500 },
    alerts: {
        telegramChatId: '-1001', email: 'owner@example.test', lang: 'ar',
        kinds: { cap_paused: true, payment: true, account_disabled: false, ad_rejected: true, ad_issues: true, token_dead: true, token_expiring: true, guard_blind: true, version_mismatch: false },
        required: ['cap_paused', 'guard_blind', 'token_dead'],
    },
    spendCap: { amount: null, changesLeftToday: 7 },
    switches: { botContext: false, extendedWindow: { instagram: false, messenger: false } },
    helpUrl: '#/help/ads',
    tokenSource: 'pasted', tokenExpiresAt: null, maxDailyBudget: 10, monthlyCap: 100,
};

const OVERVIEW: Json = {
    configured: true, steps: SETTINGS.steps, account: ACCOUNT, accountError: null,
    spend: { today: 3, thisMonth: 40 },
    limits: { maxDailyBudget: 10, monthlyCap: 100, worstCaseThisMonth: 55 },
    money: { currency: 'USD', spentToday: 3, spentThisMonth: 40, worstCaseThisMonth: 55, monthlyCap: 100, remaining: 45, maxDailyBudget: 10, monthBoundaryTz: 'Europe/London' },
    tokenHealth: 'ok', guard: { lastCheckedAt: '2026-10-22T09:00:00.000Z', blind: false },
    helpUrl: '#/help/ads',
    syncedAt: '2026-10-22T09:30:00.000Z', provisionalFrom: '2026-10-20',
    counts: { campaigns: 5, active: 2, attention: 2 },
    attention: [
        { kind: 'rejected', objectId: 'ad-1', title: 'Spring sale ad', detail: 'The image has too much text.', at: '2026-10-22T08:00:00.000Z', helpSection: 'statuses' },
        { kind: 'op_failed', objectId: null, title: 'Old campaign', detail: 'Meta refused the change.', at: '2026-10-22T07:00:00.000Z', helpSection: 'queued-changes' },
    ],
    queued: [
        { id: 'op-1', kind: 'budget', state: 'pending', objectKey: 'c-1', objectName: 'Summer campaign', notBefore: '2099-01-01T14:05:00.000Z', attempts: 0, result: null, createdAt: '2026-10-22T09:00:00.000Z', finishedAt: null, actorVia: 'dashboard' },
        { id: 'op-2', kind: 'status', state: 'running', objectKey: 'c-2', objectName: null, notBefore: '2099-01-01T14:05:00.000Z', attempts: 1, result: null, createdAt: '2026-10-22T09:01:00.000Z', finishedAt: null, actorVia: 'dashboard' },
    ],
};

function stubApi(stubs: Json) {
    return new Proxy(stubs, { get: (target, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) });
}

async function renderAds(lang: 'ar' | 'en', overview: Json | Error, calls: string[] = []) {
    const h = loadDashboard({
        lang,
        files: ['dashboard/js/pages/ads.js'],
        globals: {
            API: stubApi({
                token: 't',
                getAdsOverview: async () => { if (overview instanceof Error) throw overview; return overview; },
                getAdsMoney: async () => { calls.push('getAdsMoney'); return {}; },
            }),
            App: { canAdminister: () => true },
        },
    });
    const container = h.el('page-container');
    const page: Json = h.run('AdsPage');
    await page.render();
    await settle();
    return { h, page, html: container.innerHTML, t: h.t };
}

async function renderSettings(lang: 'ar' | 'en', ads: Json) {
    const h = loadDashboard({
        lang,
        files: ['dashboard/js/pages/settings.js'],
        globals: {
            API: stubApi({
                token: 't',
                getTokenStatus: async () => ({ status: 'valid', type: 'PAGE', expiresAt: null, dataAccessExpiresAt: null, scopes: [], instagramPageId: 'ig-1', facebookPageId: 'fb-1', isActive: true }),
                getAdsSettings: async () => ads,
                getAdsAccounts: async () => ({ accounts: [{ id: 'act_1234567890', name: 'Main account', currency: 'USD', status: 1 }] }),
            }),
            App: {
                canAdminister: () => true, isAdmin: () => false, canOperate: () => true,
                hashParam: () => '', hashParams: () => ({}), route: (page: string, params: Record<string, string> = {}) => `#/${page}?${new URLSearchParams(params)}`,
                currentTheme: () => 'auto', loadPageModule: async () => null,
            },
        },
    });
    const container = h.el('page-container');
    const page: Json = h.run('SettingsPage');
    await page.render();
    await settle();
    return { h, page, html: container.innerHTML, t: h.t };
}

describe('Ads screen: a tenant that has not finished setting up gets the steps, not an error (T033)', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`/overview {configured:false, steps} renders the four steps with their hints and help links (${lang})`, async () => {
            const { html, t } = await renderAds(lang, { configured: false, steps: STEPS_NONE, money: null, helpUrl: '#/help/ads' });
            for (const id of ['token', 'account', 'payment', 'limits']) assert.match(html, new RegExp(`data-step="${id}"`), `step ${id}`);
            assert.ok(text(html).includes(lang === 'ar' ? 'الصق رمز مستخدم نظام' : 'Paste a system-user token with'), 'a step\'s hint is shown, in the reader\'s language');
            assert.ok(text(html).includes(t('ads.stepHint.limits_missing')));
            assert.match(html, /href="#\/help\/ads#connect"/, 'each step links to the connect help');
            assert.match(html, /href="#\/settings\?s=ads"/, 'the way into Settings');
            assert.equal(text(html).includes(t('ads.loadFailed')), false, 'not the error panel');
            assert.equal(html.includes('inline-error'), false);
            assert.equal(/\bads\.[a-zA-Z.]+/.test(text(html)), false, 'no raw key');
        });
    }

    it('a step that is done says so in a word, not by colour alone', async () => {
        const steps = STEPS_NONE.map((s, i) => (i === 0 ? { ...s, done: true, hint: null, hintCode: null } : s));
        const { html, t } = await renderAds('en', { configured: false, steps, money: null });
        assert.match(html, /data-step="token"[^>]*data-done="true"/);
        assert.match(html, /data-step="account"[^>]*data-done="false"/);
        assert.ok(text(html).includes(t('ads.step.done')));
        assert.ok(text(html).includes(t('ads.step.todo')));
    });

    it('a 404 ADS_DISABLED is a calm "not available" panel like the 403\'s, with its own words', async () => {
        for (const status of [403, 404]) {
            const err: Json = new Error('nope');
            err.status = status;
            if (status === 404) err.code = 'ADS_DISABLED';
            const { html, t } = await renderAds('en', err);
            assert.ok(text(html).includes(t(status === 404 ? 'ads.disabled.title' : 'ads.owner.title')), `status ${status}`);
            assert.equal(html.includes('inline-error'), false);
        }
    });
});

describe('Ads screen: money from the server, the tax note, and the two banners (T033)', () => {
    it('shows the figures of overview.money and the excluding-tax note; remaining replaces monthlyCap minus committed', async () => {
        const { html, t } = await renderAds('en', OVERVIEW);
        const said = text(html);
        assert.ok(said.includes(t('ads.tax.note')), 'every spend figure carries the note');
        assert.ok(said.includes('45'), 'remaining of the cap');
        assert.ok(said.includes('55'), 'worst case');
        assert.equal(html.includes('committedThisMonth'), false);
        assert.equal(said.includes('Committed by boosts'), false, 'the old "committed by boosts" line is gone');
        assert.equal(html.includes('ads-blind-banner'), false);
        assert.equal(html.includes('ads-token-dead-banner'), false);
    });

    it('guard.blind is a prominent banner with the troubleshooting help link', async () => {
        const { html, t } = await renderAds('en', { ...OVERVIEW, guard: { lastCheckedAt: null, blind: true } });
        assert.match(html, /id="ads-blind-banner"/);
        assert.ok(text(html).includes(t('ads.blind.title')));
        assert.match(html, /href="#\/help\/ads#troubleshooting"/);
    });

    it('tokenHealth dead is a banner that leads to Settings', async () => {
        const { html, t } = await renderAds('en', { ...OVERVIEW, tokenHealth: 'dead' });
        assert.match(html, /id="ads-token-dead-banner"/);
        assert.ok(text(html).includes(t('ads.tokenDead.title')));
        assert.match(html, /href="#\/settings\?s=ads"/);
    });
});

describe('Ads Overview: the stored copy as health, money, what needs attention and what is queued (T055)', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`draws the health strip, the money with its last update, attention with help links, and queued changes with when (${lang})`, async () => {
            const calls: string[] = [];
            const { html, t } = await renderAds(lang, OVERVIEW, calls);
            const said = text(html);

            // Health strip: account status, payment, token health, the guard's last check.
            assert.match(html, /id="ads-health"/);
            assert.match(html, /data-ads-account-status="active"/);
            assert.ok(said.includes(t('ads.account.status.active')));
            assert.ok(said.includes(t('ads.payment.on')), 'payment');
            assert.match(html, /data-ads-token="ok"/);
            assert.ok(said.includes(t('ads.health.token.ok')));
            assert.ok(said.includes(t('ads.health.guard.ok')));
            assert.ok(said.includes(t('ads.health.guard.last', { time: '' }).trim()), 'the guard\'s last check is stamped');

            // Money from overview.money, with when it was read and that the newest days are provisional.
            assert.ok(said.includes('45'), 'remaining of the cap');
            assert.ok(said.includes('55'), 'worst case');
            assert.match(html, /id="ads-synced"/);
            assert.ok(said.includes(t('ads.camp.updated', { time: '' }).replace(/\s*$/, '').trim()), 'last updated');
            assert.match(html, /id="ads-provisional"/);
            assert.ok(said.includes(t('ads.tax.note')));
            assert.ok(said.includes('Europe/London'), 'the month boundary zone');

            // Attention: kind, title, detail and the help link of each item; an object item leads to the Campaigns tab.
            const items: string[] = html.match(/<li class="ads-attn-item[\s\S]*?<\/li>/g) || [];
            assert.equal(items.length, 2);
            assert.match(items[0] ?? '', /data-attn-kind="rejected"/);
            assert.ok(text(items[0] ?? '').includes('Spring sale ad'));
            assert.ok(text(items[0] ?? '').includes('The image has too much text.'));
            assert.match(items[0] ?? '', /href="#\/help\/ads#statuses"/);
            assert.match(items[0] ?? '', /href="#\/ads_campaigns"/);
            assert.match(items[1] ?? '', /data-attn-kind="op_failed"/);
            assert.match(items[1] ?? '', /href="#\/help\/ads#queued-changes"/);
            assert.equal((items[1] ?? '').includes('href="#/ads_campaigns"'), false, 'no object to open');
            assert.equal(html.includes('ads-attn-empty'), false);

            // Queued changes: kind, state, the object, and when it should go out (not for the one already being sent).
            const queued: string[] = html.match(/<li class="ads-queue-item[\s\S]*?<\/li>/g) || [];
            assert.equal(queued.length, 2);
            assert.match(queued[0] ?? '', /data-op-state="pending"/);
            assert.ok(text(queued[0] ?? '').includes(t('ads.queue.kind.budget')));
            assert.ok(text(queued[0] ?? '').includes(t('ads.queue.state.pending')));
            assert.ok(text(queued[0] ?? '').includes('Summer campaign'));
            assert.equal((queued[0] ?? '').includes('ads-queue-due'), true, 'expected at');
            assert.ok(text(queued[1] ?? '').includes(t('ads.queue.state.running')));
            assert.equal((queued[1] ?? '').includes('ads-queue-due'), false, 'a change already being sent has no expected time');
            assert.match(html, /id="ads-queued"[\s\S]*href="#\/help\/ads#queued-changes"/);

            // Counts lead to the Campaigns tab; no campaign table, no live money call.
            assert.match(html, /id="ads-counts"[^>]*data-campaigns="5"[^>]*data-active="2"/);
            assert.match(html, /id="ads-campaigns-link"[\s\S]*href="#\/ads_campaigns"/);
            assert.equal(html.includes('ads-table'), false);
            assert.equal(/data-action="ads:(activate|pause|remove|editBudget)"/.test(html), false);
            assert.deepEqual(calls, [], 'GET /ads/money reads Meta live: not on load');
            assert.equal(/\bads\.[a-zA-Z.]+/.test(said), false, 'no raw key');
        });
    }

    it('nothing to attend to and nothing queued say so, instead of drawing empty lists', async () => {
        const { html, t } = await renderAds('en', { ...OVERVIEW, attention: [], queued: [], counts: { campaigns: 0, active: 0, attention: 0 } });
        assert.match(html, /id="ads-attn-empty"/);
        assert.ok(text(html).includes(t('ads.attn.none')));
        assert.match(html, /id="ads-queued-empty"/);
        assert.ok(text(html).includes(t('ads.queued.none')));
        assert.equal(html.includes('ads-attn-list'), false);
    });

    it('a stored copy that was never read says so; a null figure is a dash, never a zero', async () => {
        const money = { ...(OVERVIEW.money as Json), spentToday: null, spentThisMonth: null, worstCaseThisMonth: null, remaining: null };
        const { html, t } = await renderAds('en', { ...OVERVIEW, money, syncedAt: null, provisionalFrom: null });
        assert.ok(text(html).includes(t('ads.money.neverSynced')));
        assert.equal(html.includes('id="ads-provisional"'), false);
        assert.match(html, /id="ads-stat-today"[\s\S]*?<p class="stat-value">\s*—\s*<\/p>/);
    });

    it('a dead token and a blind guard show in the health strip as well as in the banners', async () => {
        const { html, t } = await renderAds('en', { ...OVERVIEW, tokenHealth: 'dead', guard: { lastCheckedAt: null, blind: true } });
        assert.match(html, /data-ads-token="dead"/);
        assert.ok(text(html).includes(t('ads.health.token.dead')));
        assert.ok(text(html).includes(t('ads.health.guard.blind')));
    });
});

describe('Settings: the Meta ads card (T034)', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`draws the four steps, the alert recipients and the account spending limit (${lang})`, async () => {
            const { html, t } = await renderSettings(lang, SETTINGS);
            const said = text(html);
            // The steps checklist, from settings.steps.
            for (const id of ['token', 'account', 'payment', 'limits']) assert.match(html, new RegExp(`data-check="${id}"`), `step ${id}`);
            // Alert recipients: both channels, the language, every kind, the save and the test.
            assert.match(html, /id="ads-alerts-form"/);
            assert.match(html, /name="telegramChatId"/);
            assert.match(html, /name="email"/);
            assert.match(html, /name="lang"/);
            for (const kind of Object.keys(SETTINGS.alerts.kinds)) assert.match(html, new RegExp(`name="kind_${kind}"`), `kind ${kind}`);
            assert.match(html, /data-action="settings:testAdsAlerts"/);
            assert.ok(said.includes(t('settings.ads.alerts.title')));
            // The account spending limit: the row, "none", and the changes left today.
            assert.match(html, /id="ads-spendcap"/);
            assert.match(html, /data-submit="settings:setAdsSpendCap"/);
            assert.ok(said.includes(t('settings.ads.spendCap.title')));
            assert.ok(said.includes(t('settings.ads.spendCap.left', { count: 7 })), 'changes left today');
            // Test connection, and the ceiling next to the limits.
            assert.match(html, /data-action="settings:testAdsConnection"/);
            assert.ok(said.includes(t('settings.ads.ceiling', { daily: '\u{2066}50 USD\u{2069}', monthly: '\u{2066}500 USD\u{2069}' })), 'the ceiling is said');
            assert.equal(html.includes('committedThisMonth'), false);
            assert.equal(/\b(boost|settings)\.ads\.[a-zA-Z.]+/.test(said), false, 'no raw key');
        });
    }

    it('kinds the server requires are checked and disabled; the others follow their saved value', async () => {
        const { html } = await renderSettings('en', SETTINGS);
        const box = (kind: string): string => (new RegExp(`<input[^>]*name="kind_${kind}"[^>]*>`).exec(html) || [''])[0];
        for (const kind of ['cap_paused', 'guard_blind', 'token_dead']) {
            assert.match(box(kind), /\bchecked\b/, `${kind} checked`);
            assert.match(box(kind), /\bdisabled\b/, `${kind} locked`);
        }
        assert.match(box('payment'), /\bchecked\b/);
        assert.equal(/\bdisabled\b/.test(box('payment')), false);
        assert.equal(/\bchecked\b/.test(box('account_disabled')), false, 'saved off stays off');
    });

    it('an unconfigured tenant still gets the steps and the hints, and no spending-limit row to press', async () => {
        const bare = { ...SETTINGS, configured: false, steps: STEPS_NONE, token: { set: false, last4: null, source: null, expiresAt: null, health: 'unknown' }, account: null, adAccountId: null, limits: { maxDailyBudget: null, monthlyCap: null }, ceiling: null };
        const { html } = await renderSettings('en', bare);
        assert.ok(/Choose the ad account \(the act=|اختر حساب الإعلانات/.test(text(html)), 'the hint of a step that is not done');
        assert.equal(html.includes('data-action="settings:testAdsConnection"'), false, 'no Test connection without a token');
        assert.equal(html.includes('data-submit="settings:setAdsSpendCap"'), false);
    });
});

describe('Settings: Test connection, the spending limit and the alerts act on the server\'s answers (T034)', () => {
    /** The card drawn once, with the confirm dialog and the toasts recorded. */
    async function card(api: Json) {
        const asked: Json[] = [];
        const toasts: Array<[string, string]> = [];
        const h = loadDashboard({
            lang: 'en',
            files: ['dashboard/js/pages/settings.js'],
            globals: {
                API: stubApi({
                    token: 't',
                    getTokenStatus: async () => ({ status: 'valid', type: 'PAGE', expiresAt: null, dataAccessExpiresAt: null, scopes: [], instagramPageId: 'ig-1', facebookPageId: 'fb-1', isActive: true }),
                    getAdsSettings: async () => SETTINGS,
                    getAdsAccounts: async () => ({ accounts: [] }),
                    ...api,
                }),
                Admin: { confirm: (options: Json) => { asked.push(options); } },
                App: {
                    canAdminister: () => true, isAdmin: () => false, canOperate: () => true,
                    hashParam: () => '', hashParams: () => ({}), route: (page: string, params: Record<string, string> = {}) => `#/${page}?${new URLSearchParams(params)}`,
                    currentTheme: () => 'auto', loadPageModule: async () => null,
                },
            },
        });
        h.el('page-container');
        const page: Json = h.run('SettingsPage');
        await page.render();
        await settle();
        h.UI.toast = (message: string, arg: unknown) => { toasts.push([String(message), typeof arg === 'string' ? arg : String((arg as Json)?.type ?? 'success')]); };
        return { h, page, asked, toasts };
    }

    it('Test connection redraws the steps, the picker and the spending limit from the answer, and says which permissions are missing', async () => {
        const answer = {
            ok: true, scopes: ['ads_management', 'ads_read'], missingScopes: ['business_management'],
            assets: { adAccounts: [{ id: 'act_999', name: 'Second account', currency: 'USD', status: 1 }], pages: [], igAccounts: [] },
            tier: 'standard', servedVersion: 'v26.0',
            settings: { ...SETTINGS, spendCap: { amount: 500, changesLeftToday: 3 } },
        };
        let calls = 0;
        const { h, page } = await card({ testAdsSettings: async () => { calls++; return answer; } });
        const top = h.el('ads-top');
        const region = h.el('ads-account-region');
        const cap = h.el('ads-spendcap-region');
        await page.testAdsConnection(h.el('ads-test-btn'));
        assert.equal(calls, 1);
        const said = text(top.innerHTML);
        assert.ok(said.includes(h.t('settings.ads.test.ok')));
        assert.ok(said.includes(h.t('settings.ads.test.missing', { count: 1 })));
        assert.ok(top.innerHTML.includes('business_management'));
        assert.ok(said.includes('standard') && said.includes('v26.0'), 'the tier and the served version');
        assert.ok(region.innerHTML.includes('Second account'), 'the picker is the list the test found');
        assert.ok(text(cap.innerHTML).includes(h.t('settings.ads.spendCap.left', { count: 3 })), 'the spending limit row follows the new settings');
    });

    it('a dead token says what to do, not the server\'s English', async () => {
        const err: Json = Object.assign(new Error('Meta says no'), { status: 400, code: 'TOKEN_INVALID', body: { code: 'TOKEN_INVALID' } });
        const { h, page } = await card({ testAdsSettings: async () => { throw err; } });
        const result = h.el('ads-test-result');
        await page.testAdsConnection(h.el('ads-test-btn'));
        assert.ok(text(result.innerHTML).includes(h.t('settings.ads.err.tokenInvalid')));
        assert.equal(result.innerHTML.includes('Meta says no'), false);
    });

    it('setting the spending limit asks first, then sends the amount with confirm: true', async () => {
        const sent: Json[] = [];
        const { h, page, asked, toasts } = await card({
            setAdsSpendCap: async (body: Json) => { sent.push(body); return { op: { id: 'o1', state: 'done', kind: 'spend_cap' }, spendCap: { amount: 25, changesLeftToday: 6 }, verified: true }; },
        });
        h.el('ads-spendcap-amount', { value: '25' });
        h.el('ads-spendcap-region');
        page.setAdsSpendCap(h.el('ads-spendcap-form'), { preventDefault() {} });
        assert.equal(sent.length, 0, 'nothing is sent before the question is answered');
        assert.equal(asked.length, 1);
        assert.ok(String(asked[0].body).includes('25'));
        await asked[0].onConfirm();
        assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ amount: 25, confirm: true }]);
        assert.ok(toasts.some(([m, type]) => m === h.t('settings.ads.spendCap.saved') && type === 'success'));
    });

    it('a spending limit Meta did not read back is said, not shown as plainly saved', async () => {
        const { h, page, asked, toasts } = await card({
            setAdsSpendCap: async () => ({ op: { id: 'o2', state: 'done', kind: 'spend_cap' }, spendCap: { amount: 25, changesLeftToday: 6 }, verified: false }),
        });
        h.el('ads-spendcap-amount', { value: '25' });
        page.setAdsSpendCap(h.el('ads-spendcap-form'), { preventDefault() {} });
        await asked[0].onConfirm();
        assert.ok(toasts.some(([m, type]) => m === h.t('settings.ads.spendCap.unverified') && type === 'warning'));
    });

    it('EDIT_LIMIT comes back to the dialog as a sentence with the time to try again', async () => {
        const err: Json = Object.assign(new Error('Too many edits'), { status: 429, code: 'EDIT_LIMIT', body: { code: 'EDIT_LIMIT', retryAt: '2026-10-23T08:30:00.000Z' } });
        const { h, page, asked } = await card({ setAdsSpendCap: async () => { throw err; } });
        h.el('ads-spendcap-amount', { value: '25' });
        page.setAdsSpendCap(h.el('ads-spendcap-form'), { preventDefault() {} });
        await assert.rejects(asked[0].onConfirm(), (thrown: Error) => {
            assert.ok(thrown.message.includes(h.UI.formatTime('2026-10-23T08:30:00.000Z')), thrown.message);
            assert.equal(thrown.message.includes('Too many edits'), false);
            return true;
        });
    });

    it('a blank or non-positive spending limit is refused in the page, before any question', async () => {
        const { h, page, asked } = await card({});
        for (const value of ['', '0', '-5']) {
            h.el('ads-spendcap-amount', { value });
            const error = h.el('ads-spendcap-error');
            page.setAdsSpendCap(h.el('ads-spendcap-form'), { preventDefault() {} });
            assert.ok(text(error.innerHTML).includes(h.t('settings.ads.spendCap.invalid')), `value "${value}"`);
        }
        assert.equal(asked.length, 0);
    });

    it('a limit over the platform ceiling is said with the ceiling, per field', async () => {
        const { h, page } = await card({});
        const err: Json = Object.assign(new Error('over'), { status: 400, code: 'OVER_CEILING', body: { code: 'OVER_CEILING', field: 'monthlyCap' } });
        assert.equal(page.adsFailure(err), h.t('settings.ads.err.overCeiling.monthlyCap', { limit: '\u{2066}500 USD\u{2069}' }));
    });
});

describe('Boost: the cap comes from /ads/money, and the dialog refuses what does not fit (T035)', () => {
    async function dialog(money: Json | Error, check: Json | Error) {
        const calls = { money: [] as string[], created: 0 };
        const answer = (value: Json | Error) => { if (value instanceof Error) throw value; return value; };
        const h = loadDashboard({
            lang: 'en',
            files: ['dashboard/js/pages/posts.js'],
            globals: {
                API: stubApi({
                    token: 't',
                    getAdsMoney: async (candidate?: string) => { calls.money.push(candidate ?? ''); return answer(candidate ? check : money); },
                    createBoost: async () => { calls.created++; return { boost: null }; },
                    getAdsSettings: async () => ({ configured: true, maxDailyBudget: 50 }),
                    getAdsEligibility: async () => ({ eligible: true }),
                }),
                App: { canAdminister: () => true },
            },
        });
        h.UI.showModal = () => {};
        h.UI.toast = () => {};
        const page: Json = h.run('PostsPage');
        page.ads.settings = { configured: true, maxDailyBudget: 50, monthlyCap: 100, account: { currency: 'USD' } };
        page._boost = { postId: 7, seq: 1, currency: 'USD', done: false, eligSeq: 0, money: undefined };
        const field = (value: string) => ({ value });
        const form = h.el('boost-form', { elements: { platform: field('instagram'), dailyBudget: field('10'), days: field('3'), objective: field('ENGAGEMENT'), country: field('SA'), link: field('') } } as Json);
        h.el('boost-platform', { options: [{ value: 'instagram' }] } as Json);
        const summary = h.el('boost-summary');
        const error = h.el('boost-error');
        return { h, page, form, summary, error, calls };
    }

    it('"fits" is worked out live from the server\'s remaining: no request per keystroke', async () => {
        const { h, page, summary, calls } = await dialog({ monthlyCap: 100, remaining: 20, maxDailyBudget: 50, fits: true }, {});
        await page.boostLoadMoney(1);
        const said = text(summary.innerHTML);
        assert.ok(said.includes(h.t('boost.dialog.overRemaining')), '10 a day for 3 days is 30, over the 20 left');
        assert.ok(said.includes(h.t('ads.tax.note')));
        page.boostRecalc();
        page.boostRecalc();
        assert.deepEqual(calls.money, [''], 'asked once, without a candidate');
    });

    it('an answer that could not be read says the cap is unknown, and the dialog still works', async () => {
        const { h, page, summary } = await dialog(new Error('offline'), {});
        await page.boostLoadMoney(1);
        assert.ok(text(summary.innerHTML).includes(h.t('boost.dialog.remainingUnknown')));
    });

    it('Create asks /ads/money with this boost as a lifetime candidate and stops when it does not fit', async () => {
        const { h, page, form, error, calls } = await dialog({}, { fits: false, reason: 'OVER_MONTHLY_CAP', remaining: 20, monthlyCap: 100 });
        await page.boostSubmit(form, { preventDefault() {} });
        assert.deepEqual(calls.money, ['lifetime:30:3']);
        assert.equal(calls.created, 0, 'the boost is not created');
        assert.ok(text(error.innerHTML).includes(h.t('boost.err.overMonthlyCap', { remaining: '\u{2066}20 USD\u{2069}', cap: '\u{2066}100 USD\u{2069}' })));
    });

    it('when it fits, the boost is created', async () => {
        const { page, form, calls } = await dialog({}, { fits: true, reason: null, remaining: 70, monthlyCap: 100 });
        await page.boostSubmit(form, { preventDefault() {} });
        assert.deepEqual(calls.money, ['lifetime:30:3']);
        assert.equal(calls.created, 1);
    });

    it('a failed read of the candidate does not block: the server weighs the cap again', async () => {
        const { page, form, calls } = await dialog({}, new Error('offline'));
        await page.boostSubmit(form, { preventDefault() {} });
        assert.equal(calls.created, 1);
    });

    it('RATE_LIMITED says when to try again; any other refusal is the server\'s own sentence', async () => {
        const { h, page } = await dialog({}, {});
        const limited: Json = Object.assign(new Error('slow down'), { status: 429, code: 'RATE_LIMITED', body: { retryAt: '2026-10-23T08:30:00.000Z' } });
        assert.ok(page.boostFailure(limited).includes(h.UI.formatTime('2026-10-23T08:30:00.000Z')));
        assert.equal(page.boostFailure(new Error('plain')), 'plain');
    });
});
