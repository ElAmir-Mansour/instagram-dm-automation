/**
 * Ads, phase A8: the Audiences tab (`#/ads_audiences`), the dashboard half (spec 002, T155).
 *
 * The REAL `ads_audiences.js` (with `ads_campaigns.js` for the tab bar) in the shared `node:vm` harness, the API stubbed:
 *   - each audience shows its status and Meta's size; too small and flagged say why; one being created is followed;
 *   - the Custom Audience Terms banner links to Meta when they are not accepted;
 *   - the customer-list panel is always there: LOCKED shows what is needed and a Help link and no upload controls; unlocked, the upload
 *     button waits for the consent tick, sends the text once, then empties the box; the list never reaches localStorage;
 *   - names the server wrote are escaped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/[⁦⁧⁨⁩]/g, '').replace(/\s+/g, ' ').trim();

function audience(over: Json = {}): Json {
    return {
        id: 'a1', metaId: '6001', kind: 'ig_engagement', name: 'Engagers 30d <b>x</b>', status: 'ready', sizeLower: 12000, sizeUpper: 14000,
        seedAudienceId: null, spec: { event: 'engaged', retentionDays: 30 }, syncedAt: null, createdAt: '2026-10-22T10:00:00Z', usable: true, unusableReason: null, op: null,
        ...over,
    };
}

function answer(over: Json = {}): Json {
    return {
        audiences: [audience()], tosAccepted: { custom: true, lookalike: null }, tosUrl: 'https://business.facebook.com/ads/manage/customaudiences/tos/?act=1',
        customerList: { locked: true, countries: [], recordedAt: null, needed: ['legal_signoff'], helpUrl: '#/help/ads#customer-lists' },
        retentionMaxDays: { ig_engagement: 730, page_engagement: 730, messagers: 730, video_viewers: 365 },
        ...over,
    };
}

async function open(setup: { data?: Json; owner?: boolean; api?: Json } = {}) {
    const calls: Array<[string, unknown[]]> = [];
    const record = (name: string, fn: (...args: Json[]) => unknown) => (...args: Json[]) => { calls.push([name, args]); return fn(...args); };
    const api: Json = {
        token: 't',
        getAdsAudiences: record('getAdsAudiences', async () => JSON.parse(JSON.stringify(setup.data ?? answer()))),
        uploadAdsCustomerList: record('uploadAdsCustomerList', async () => ({ audience: audience({ id: 'a2', kind: 'customer_list', status: 'creating', name: 'List', spec: { columns: ['EMAIL'], rows_sent: 2, matched_estimate: null } }), op: { id: 'op1', state: 'pending', kind: 'audience_create' }, rowsAccepted: 2, rowsExcludedOptOut: 1, rowsInvalid: 0, rowsExcludedCountry: 0, rowsDuplicate: 0 })),
        ...(setup.api ?? {}),
    };
    const globals: Json = {
        API: new Proxy(api, { get: (target, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) }),
        App: { canOperate: () => setup.owner !== false, canAdminister: () => setup.owner !== false },
    };
    const h = loadDashboard({ lang: 'en', files: ['dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_audiences.js'], globals });
    h.UI.toast = () => {};
    const container = h.el('page-container');
    const page: Json = h.run('AdsAudiencesPage');
    await page.render();
    await settle();
    return { h, page, calls, screen: (): string => String(container.innerHTML), called: (n: string) => calls.filter(([c]) => c === n) };
}

describe('Audiences tab: the cards (T155)', () => {
    it('shows status and size, marks the tab, and escapes the name', async () => {
        const { h, page, screen } = await open();
        const html = screen();
        assert.match(html, /id="adsaud-a1"/);
        assert.ok(text(html).includes(text(h.t('ads.aud.size.range', { low: '12,000', high: '14,000' }))), text(html));
        assert.ok(text(html).includes(h.t('ads.aud.status.ready')));
        assert.ok(html.includes('href="#/ads_audiences"') && /ads_audiences" aria-current|aria-current="page"[^>]*>/.test(html));
        assert.ok(!html.includes('<b>x</b>') && html.includes('&lt;b&gt;'));
        page.destroy();
    });

    it('explains too small and flagged, and follows one being created', async () => {
        const { h, page, screen } = await open({ data: answer({ audiences: [
            audience({ id: 's', status: 'too_small', usable: false, unusableReason: 'too_small' }),
            audience({ id: 'f', status: 'flagged', usable: false, unusableReason: 'flagged' }),
            audience({ id: 'c', status: 'creating', usable: false, unusableReason: 'creating', sizeLower: null, sizeUpper: null, op: { id: 'op', state: 'running', kind: 'audience_create' } }),
        ] }) });
        const words = text(screen());
        assert.ok(words.includes(text(h.t('ads.aud.why.too_small'))));
        assert.ok(words.includes(text(h.t('ads.aud.why.flagged'))));
        assert.ok(words.includes(h.t('ads.aud.creatingAtMeta')));
        assert.ok(page._timer, 'the page asks again while one is being created');
        page.destroy();
        assert.equal(page._timer, null);
    });

    it('shows the terms banner with Meta\'s link when the terms are not accepted', async () => {
        const { page, screen } = await open({ data: answer({ tosAccepted: { custom: false, lookalike: null } }) });
        assert.match(screen(), /id="adsaud-terms-link"[^>]*|href="https:\/\/business\.facebook\.com\/ads\/manage\/customaudiences\/tos\/\?act=1"/);
        assert.ok(screen().includes('customaudiences/tos/?act=1'));
        page.destroy();
    });
});

describe('Audiences tab: customer lists (T155)', () => {
    it('locked: says what is needed, links Help, and has no upload controls', async () => {
        const { h, page, screen } = await open();
        const html = screen();
        assert.match(html, /id="adsaud-lists"[^>]*data-locked="true"/);
        assert.ok(text(html).includes(text(h.t('ads.aud.list.needed.legal_signoff'))));
        assert.ok(html.includes('customer-lists'));
        assert.ok(!html.includes('id="adsaud-list-text"') && !html.includes('id="adsaud-upload"'));
        page.destroy();
    });

    it('unlocked: the upload waits for the consent tick, sends once, then empties the box', async () => {
        const unlocked = answer({ customerList: { locked: false, countries: ['EG', 'SA'], recordedAt: '2026-10-22T00:00:00Z', needed: [], helpUrl: '#/help/ads#customer-lists' } });
        const { h, page, called, screen } = await open({ data: unlocked });
        assert.match(screen(), /id="adsaud-upload"[^>]*disabled/, 'disabled until consent');
        assert.ok(screen().includes('id="adsaud-list-text"'));
        h.el('adsaud-list-text').value = 'salma@example.com\nomar@example.org';
        h.el('adsaud-list-country').value = 'EG'; // the fake DOM does not read a <select>'s first option
        h.el('adsaud-list-columns').value = 'auto';
        await page.upload();
        assert.equal(called('uploadAdsCustomerList').length, 0, 'no consent, no upload');
        h.el('adsaud-list-consent').checked = true;
        page.consent();
        assert.equal(h.el('adsaud-upload').disabled, false);
        await page.upload();
        await settle();
        const sent = called('uploadAdsCustomerList');
        assert.equal(sent.length, 1);
        assert.equal((sent[0]![1][0] as Json).text, 'salma@example.com\nomar@example.org');
        assert.equal((sent[0]![1][0] as Json).defaultCountry, 'EG');
        assert.equal(h.el('adsaud-list-text').value, '', 'the box is emptied');
        assert.equal(h.el('adsaud-list-consent').checked, false);
        page.destroy();
    });

    it('never puts the list in localStorage or the address', () => {
        const source = readFileSync('dashboard/js/pages/ads_audiences.js', 'utf8');
        assert.ok(!/\b(localStorage|sessionStorage)\s*[.[]/.test(source));
        assert.ok(!/location\.(hash|search)\s*=/.test(source));
    });
});

describe('Audiences tab: the shell', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`has its title, tab and every key it uses in ${lang}`, () => {
            const h = loadDashboard({ lang, files: ['dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_audiences.js'] });
            for (const key of ['nav.ads_audiences', 'page.ads_audiences.subtitle', 'ads.tabs.audiences']) assert.notEqual(h.t(key), key, key);
            const source = readFileSync('dashboard/js/pages/ads_audiences.js', 'utf8');
            for (const [, key] of source.matchAll(/t\('(ads\.aud\.[^']+)'/g)) assert.notEqual(h.t(key!), key, key);
            for (const status of ['creating', 'ready', 'too_small', 'flagged', 'deleted']) assert.notEqual(h.t(`ads.aud.status.${status}`), `ads.aud.status.${status}`);
        });
    }
});
