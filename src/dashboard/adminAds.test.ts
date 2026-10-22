/**
 * Ads, phase A11 (managed clients), the dashboard half (spec 002, T190–T193): the platform admin's Client ads page (`#/admin_ads`) and the
 * client's share-spend block on Settings → Meta ads. The REAL `admin_ads.js` and `ads_client_card.js` in the shared `node:vm` harness,
 * with the API stubbed:
 *   - a row shows health, cap use as a percentage (unknown is not zero) and the alerts;
 *   - spend shows only when the row carries it (the client shares it), with the tax note; otherwise one muted line and no figures;
 *   - the enable switch posts, and CEILING_REQUIRED is said next to the ceiling fields; the ceiling form posts both numbers;
 *   - sign-offs say "arrives with Audiences" while the server sends null; every name the server sends is escaped;
 *   - the client block draws nothing for a 404 or an unmanaged workspace, and its switch posts `{ on }`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeEl, loadDashboard, settle, type Json } from './_harness.js';

const words = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/[⁦⁧⁨⁩]/g, '').replace(/\s+/g, ' ').trim();

const SHARES = '22222222-2222-4222-8222-222222222222';
const PRIVATE = '33333333-3333-4333-8333-333333333333';

function rows(): Json[] {
    return [
        {
            tenantId: SHARES, name: 'Sharing <b>client</b>', enabled: true, isPlatformOwner: false, ceiling: { maxDailyBudget: 50, monthlyCap: 1500 },
            configured: true, tokenHealth: 'ok', accountStatus: 'active', paymentMethod: true, checkedAt: new Date().toISOString(), capUsePct: 25,
            openAlerts: [], shareSpend: true, spend: { currency: 'SAR', spentThisMonth: 250, spentToday: 12.5, monthlyCap: 1000, maxDailyBudget: 40 }, signoffs: null,
        },
        {
            tenantId: PRIVATE, name: 'Private client', enabled: false, isPlatformOwner: false, ceiling: null, configured: false, tokenHealth: 'dead',
            accountStatus: 'unsettled', paymentMethod: false, checkedAt: null, capUsePct: null,
            openAlerts: [{ kind: 'token_dead', count: 2, lastAt: new Date().toISOString() }], shareSpend: false, signoffs: null,
        },
    ];
}

async function openAdmin(api: Json = {}) {
    const calls: Array<[string, unknown[]]> = [];
    const record = (name: string, fn: (...a: Json[]) => unknown) => (...args: Json[]) => { calls.push([name, args]); return fn(...args); };
    const stubs: Json = {
        getAdminAdsTenants: record('getAdminAdsTenants', async () => ({ tenants: rows() })),
        setAdminAdsEnabled: record('setAdminAdsEnabled', async (_id: string, enabled: boolean) => ({ enabled })),
        setAdminAdsCeiling: record('setAdminAdsCeiling', async (_id: string, maxDailyBudget: number, monthlyCap: number) => ({ ceiling: { maxDailyBudget, monthlyCap } })),
        ...api,
    };
    for (const k of Object.keys(api)) stubs[k] = record(k, api[k]);
    const h = loadDashboard({
        lang: 'en', files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/admin_ads.js'],
        globals: {
            API: new Proxy(stubs, { get: (t, p) => (p in t ? t[p as string] : () => Promise.reject(new Error(`API.${String(p)} is not stubbed`))) }),
            App: { session: { tenants: [] }, dropAdminAccess: () => {}, canAdminister: () => true },
        },
    });
    const toasts: string[] = [];
    h.UI.toast = (m: string) => { toasts.push(String(m)); return null; };
    const container = h.el('page-container');
    const page: Json = h.run('AdminAdsPage');
    page.resetTenantState();
    await page.render();
    await settle();
    return { h, page, calls, toasts, screen: (): string => String(container.innerHTML), called: (n: string) => calls.filter(([c]) => c === n) };
}

/** The markup of the card for one tenant. */
function cardOf(markup: string, id: string): string {
    const at = markup.indexOf(`data-tenant-id="${id}"`);
    assert.ok(at > 0, `no card for ${id}`);
    const end = markup.indexOf('</article>', at);
    return markup.slice(at, end);
}

describe('Client ads page (A11): what each row shows', () => {
    it('shows health, cap use as a percentage, alerts, and "unknown" (not 0) when cap use cannot be told', async () => {
        const { h, screen } = await openAdmin();
        const shares = cardOf(screen(), SHARES);
        assert.match(shares, /data-cap="known"/);
        assert.ok(words(shares).includes(h.t('adsAdmin.cap.use', { pct: '25%' }).replace(/[⁦⁧⁨⁩]/g, '')));
        assert.ok(words(shares).includes(h.t('adsAdmin.token.ok')));
        const priv = cardOf(screen(), PRIVATE);
        assert.match(priv, /data-cap="unknown"/);
        assert.doesNotMatch(priv, /<progress/);
        assert.ok(words(priv).includes(h.t('adsAdmin.token.dead')));
        assert.ok(words(priv).includes(h.t('adsAdmin.account.unsettled')));
        assert.ok(words(priv).includes(h.t('adsAdmin.alert.token_dead')));
    });

    it('shows spend only for the client that shares it, with the tax note; the other shows no figure at all', async () => {
        const { h, screen } = await openAdmin();
        const shares = cardOf(screen(), SHARES);
        assert.match(shares, /data-spend="shared"/);
        assert.ok(words(shares).includes('250 SAR'));
        assert.ok(words(shares).includes(h.t('adsAdmin.excludesTax')));
        const priv = cardOf(screen(), PRIVATE);
        assert.match(priv, /data-spend="private"/);
        assert.ok(words(priv).includes(h.t('adsAdmin.spend.notShared')));
        assert.doesNotMatch(priv, /SAR|USD/);
    });

    it('escapes what the server sends', async () => {
        const { screen } = await openAdmin();
        assert.doesNotMatch(screen(), /<b>client<\/b>/);
        assert.match(screen(), /Sharing &lt;b&gt;client&lt;\/b&gt;/);
    });

    it('says sign-offs arrive with the Audiences phase while the server sends null, and shows no form', async () => {
        const { screen } = await openAdmin();
        const shares = cardOf(screen(), SHARES);
        assert.match(shares, /data-signoffs="pending"/);
        assert.doesNotMatch(shares, /adminAds:addSignoff/);
    });
});

describe('Client ads page (A11): the writes', () => {
    it('the switch posts the tenant and the new state', async () => {
        const { page, called, h } = await openAdmin();
        const input = new FakeEl('', 'input') as Json;
        input.checked = true;
        input.dataset = { id: PRIVATE };
        await page.setEnabled(input);
        await settle();
        assert.deepEqual(called('setAdminAdsEnabled').map(([, a]) => a), [[PRIVATE, true]]);
        assert.ok(h);
    });

    it('CEILING_REQUIRED puts the switch back and says so next to the ceiling fields', async () => {
        const refusal = Object.assign(new Error('Set a ceiling first.'), { code: 'CEILING_REQUIRED', status: 409 });
        const { page, h, toasts } = await openAdmin({ setAdminAdsEnabled: async () => { throw refusal; } });
        h.el('aa-ceiling-error-1'); // the card's error host, as the painted page has it (the fake DOM does not parse innerHTML)
        const input = new FakeEl('', 'input') as Json;
        input.checked = true;
        input.dataset = { id: PRIVATE };
        await page.setEnabled(input);
        await settle();
        assert.equal(input.checked, false);
        const host = h.el('aa-ceiling-error-1');
        assert.ok(words(host.innerHTML).includes(h.t('adsAdmin.err.ceilingRequired')));
        assert.deepEqual(toasts, []);
    });

    it('the ceiling form posts both numbers, and refuses an empty or zero one without a request', async () => {
        const { page, called } = await openAdmin();
        const form = (daily: string, monthly: string): Json => ({
            dataset: { id: PRIVATE },
            querySelector: (sel: string) => ({ value: sel.includes('maxDailyBudget') ? daily : monthly }),
        });
        await page.saveCeiling(form('0', '100'), { preventDefault() {} });
        await page.saveCeiling(form('', '100'), { preventDefault() {} });
        assert.equal(called('setAdminAdsCeiling').length, 0);
        await page.saveCeiling(form('50', '1500'), { preventDefault() {} });
        await settle();
        assert.deepEqual(called('setAdminAdsCeiling').map(([, a]) => a), [[PRIVATE, 50, 1500]]);
    });
});

async function openClient(answer: () => Promise<Json>, owner = true) {
    const posts: Json[] = [];
    const h = loadDashboard({
        lang: 'en', files: ['dashboard/js/pages/ads_client_card.js'],
        globals: {
            API: { getAdsShareSpend: answer, setAdsShareSpend: async (on: boolean) => { posts.push(on); return { shareSpend: on, ceiling: null, managed: true }; } },
            App: { canAdminister: () => owner },
        },
    });
    h.UI.toast = () => null;
    const host = h.el('ads-client-block');
    const card: Json = h.run('AdsClientCard');
    await card.mount();
    await settle();
    return { h, card, host, posts };
}

describe('Settings → Meta ads: the share-spend block (A11)', () => {
    it('draws nothing when ads are off (404) or the workspace is not managed', async () => {
        const off = await openClient(async () => { throw Object.assign(new Error('Ads are not available.'), { status: 404, code: 'ADS_DISABLED' }); });
        assert.equal(String(off.host.innerHTML).trim(), '');
        const own = await openClient(async () => ({ shareSpend: false, ceiling: null, managed: false }));
        assert.equal(String(own.host.innerHTML).trim(), '');
    });

    it('shows the switch off by default for a managed client, and turning it on posts { on: true }', async () => {
        const { h, card, host, posts } = await openClient(async () => ({ shareSpend: false, ceiling: { maxDailyBudget: 50, monthlyCap: 1500 }, managed: true }));
        assert.ok(words(host.innerHTML).includes(h.t('adsClient.share.label')));
        assert.doesNotMatch(String(host.innerHTML), /id="ads-client-share"[^>]*checked/);
        const input = new FakeEl('', 'input') as Json;
        input.checked = true;
        await card.toggle(input);
        assert.deepEqual(posts, [true]);
        assert.match(String(host.innerHTML), /id="ads-client-share"[^>]*checked/);
    });

    it('a member who is not the owner sees it disabled', async () => {
        const { host } = await openClient(async () => ({ shareSpend: true, ceiling: null, managed: true }), false);
        assert.match(String(host.innerHTML), /id="ads-client-share"[^>]*disabled/);
    });
});
