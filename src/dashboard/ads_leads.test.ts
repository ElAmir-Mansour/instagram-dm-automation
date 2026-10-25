/**
 * Ads, phase A10: the Leads tab (`#/ads_leads`), the dashboard half (spec 002, T175).
 *
 * The REAL `ads_leads.js` (with `ads_campaigns.js` for the tab bar) in the shared `node:vm` harness, the API stubbed:
 *   - LOCKED: one calm panel with the Help links, no "New form", no table, and the leads are never asked for;
 *   - unlocked: the sign-off's countries, the forms, the leads with their answers ESCAPED, a purged lead without answers, the CSV link
 *     carrying the filters; the "New form" dialog sends one idempotency key and refuses a restricted label before the server does;
 *   - a viewer sees the forms and not the leads; the leads never reach localStorage.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/[⁦⁧⁨⁩]/g, '').replace(/\s+/g, ' ').trim();

const FORM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function forms(over: Json = {}): Json {
    return {
        locked: false, signoff: { countries: ['EG'], recordedAt: '2026-10-20T00:00:00Z' }, retentionDays: 90, helpUrl: '#/help/ads#leads-and-privacy',
        forms: [{ id: FORM, metaId: '777', name: 'دورة <b>Go</b>', locale: 'AR_AR', status: 'active', origin: 'app', consentQuestion: true, questions: [], leadCount: 2, lastLeadAt: '2026-10-22T10:00:00Z', createdAt: '2026-10-21T10:00:00Z', error: null }],
        ...over,
    };
}

function leads(): Json {
    return {
        retentionDays: 90,
        leads: [
            { id: 'l1', createdTime: '2026-10-22T10:00:00Z', formId: FORM, formName: 'دورة', adId: '555', answers: [{ name: 'full_name', values: ['<img src=x onerror=alert(1)>'] }, { name: 'email', values: ['ali@example.com'] }], consentContact: true, handedTo: 'none', purged: false, retainUntil: '2027-01-20T10:00:00Z' },
            { id: 'l2', createdTime: '2026-06-01T10:00:00Z', formId: FORM, formName: 'دورة', adId: null, answers: null, consentContact: false, handedTo: 'none', purged: true, retainUntil: '2026-08-30T10:00:00Z' },
        ],
    };
}

async function open(setup: { forms?: Json; owner?: boolean; api?: Json } = {}) {
    const calls: Array<[string, unknown[]]> = [];
    const record = (name: string, fn: (...args: Json[]) => unknown) => (...args: Json[]) => { calls.push([name, args]); return fn(...args); };
    const api: Json = {
        token: 't',
        getAdsLeadForms: record('getAdsLeadForms', async () => JSON.parse(JSON.stringify(setup.forms ?? forms()))),
        getAdsLeads: record('getAdsLeads', async () => leads()),
        createAdsLeadForm: record('createAdsLeadForm', async (body: Json) => ({ form: { ...forms().forms[0], id: 'new', name: body.name, status: 'active' } })),
        ...(setup.api ?? {}),
    };
    const globals: Json = {
        API: new Proxy(api, { get: (target, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) }),
        App: { canOperate: () => setup.owner !== false, canAdminister: () => setup.owner !== false },
    };
    const h = loadDashboard({ lang: 'en', files: ['dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_leads.js'], globals });
    h.UI.toast = () => {};
    let modal = '';
    h.UI.showModal = (markup: unknown) => { modal = String(markup); };
    h.UI.closeModal = () => { modal = ''; };
    const container = h.el('page-container');
    const page: Json = h.run('AdsLeadsPage');
    await page.render();
    await settle();
    return { h, page, calls, screen: (): string => String(container.innerHTML), modal: () => modal, called: (n: string) => calls.filter(([c]) => c === n) };
}

describe('Leads tab: locked (T175)', () => {
    it('one calm panel with the Help links: no builder, no table, and the leads are never read', async () => {
        const { h, page, screen, called } = await open({ forms: forms({ locked: true, signoff: null, forms: [] }) });
        const html = screen();
        assert.match(html, /id="adsleads-locked"[^>]*data-locked="true"/);
        assert.ok(text(html).includes(text(h.t('ads.leads.locked.why'))));
        assert.ok(html.includes('leads-and-privacy') && html.includes('lead-ads'));
        assert.ok(!html.includes('adsleads:new') && !html.includes('id="adsleads-table"') && !html.includes('id="adsleads-csv"'));
        assert.equal(called('getAdsLeads').length, 0);
        assert.ok(/href="#\/ads_leads"[^>]*aria-current="page"/.test(html), 'the Leads tab is the current one');
        page.destroy();
    });
});

describe('Leads tab: unlocked (T175)', () => {
    it('shows the countries, the forms and the leads, escaping what people typed, and a purged lead without answers', async () => {
        const { h, page, screen } = await open();
        const html = screen();
        assert.ok(text(html).includes(text(h.t('ads.leads.covered', { countries: 'Egypt' }))) || text(html).includes('EG') || text(html).includes('Egypt'), text(html));
        assert.match(html, new RegExp(`id="adsleads-form-${FORM}"`));
        assert.ok(!html.includes('<b>Go</b>') && html.includes('&lt;b&gt;Go'));
        assert.ok(!html.includes('<img src=x') && html.includes('&lt;img src=x'));
        assert.ok(html.includes('ali@example.com'));
        assert.match(html, /id="adsleads-lead-l2"[^>]*data-purged="true"/);
        assert.ok(text(html).includes(text(h.t('ads.leads.purged', { days: '90' }))));
        assert.ok(text(html).includes(text(h.t('ads.leads.noContact'))));
        page.destroy();
    });

    it('the CSV link carries the filters and says the download is recorded', async () => {
        const { h, page, screen, called } = await open();
        assert.match(screen(), /id="adsleads-csv" href="\/api\/ads\/leads\.csv"/);
        h.el('adsleads-filter-form').value = FORM;
        h.el('adsleads-filter-from').value = '2026-10-01';
        h.el('adsleads-filter-to').value = '2026-10-31';
        await page.filter();
        await settle();
        assert.deepEqual(JSON.parse(JSON.stringify(called('getAdsLeads').at(-1)![1][0])), { formId: FORM, from: '2026-10-01', to: '2026-10-31' });
        const href = /id="adsleads-csv" href="([^"]+)"/.exec(screen())![1]!.replace(/&amp;/g, '&');
        assert.equal(href, `/api/ads/leads.csv?formId=${FORM}&from=2026-10-01&to=2026-10-31`);
        assert.ok(text(screen()).includes(h.t('ads.leads.csvAudited')));
        page.destroy();
    });

    it('New form: one idempotency key per dialog, a restricted label refused here, the standard questions sent', async () => {
        const { h, page, called, modal } = await open();
        page.openNew();
        assert.ok(modal().includes('id="adsleads-form"'));
        assert.ok(!modal().includes('DOB') && !modal().includes('NATIONAL_ID'), 'only allowed types are offered');
        h.el('adsleads-name').value = 'Go workshop';
        h.el('adsleads-q-FULL_NAME').checked = true;
        h.el('adsleads-q-PHONE').checked = true;
        h.el('adsleads-custom-label-0').value = 'What is your bank account number?';
        await page.create();
        assert.equal(called('createAdsLeadForm').length, 0, 'refused before the server');
        h.el('adsleads-custom-label-0').value = 'What is your level?';
        h.el('adsleads-consent').checked = true;
        h.el('adsleads-ty-url').value = 'https://example.com';
        await page.create();
        await settle();
        const sent = called('createAdsLeadForm');
        assert.equal(sent.length, 1);
        const body = sent[0]![1][0] as Json;
        assert.equal(body.consentQuestion, true);
        assert.ok(typeof body.idempotencyKey === 'string' && body.idempotencyKey.length >= 8);
        assert.deepEqual(JSON.parse(JSON.stringify(body.questions.map((q: Json) => q.type))), ['FULL_NAME', 'PHONE', 'CUSTOM']);
        page.destroy();
    });
});

describe('Leads tab: who sees what', () => {
    it('a viewer sees the forms, not the leads, and the leads are never read', async () => {
        const { page, screen, called } = await open({ owner: false });
        assert.match(screen(), /id="adsleads-leads"[^>]*data-owner="false"/);
        assert.ok(!screen().includes('id="adsleads-table"') && !screen().includes('adsleads:new'));
        assert.equal(called('getAdsLeads').length, 0);
        page.destroy();
    });

    it('never stores leads in the browser', () => {
        const source = readFileSync('dashboard/js/pages/ads_leads.js', 'utf8');
        assert.ok(!/\b(localStorage|sessionStorage|indexedDB)\b/.test(source));
    });

    for (const lang of ['en', 'ar'] as const) {
        it(`has its title, tab and every key it uses in ${lang}`, () => {
            const h = loadDashboard({ lang, files: ['dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_leads.js'] });
            for (const key of ['nav.ads_leads', 'page.ads_leads.subtitle', 'ads.tabs.leads', 'erasure.type.leads']) assert.notEqual(h.t(key), key, key);
            const source = readFileSync('dashboard/js/pages/ads_leads.js', 'utf8');
            for (const [, key] of source.matchAll(/t\('(ads\.leads\.[^']+)'/g)) assert.notEqual(h.t(key!), key, key);
            for (const s of ['pending', 'active', 'archived', 'failed']) assert.notEqual(h.t(`ads.leads.status.${s}`), `ads.leads.status.${s}`);
            for (const q of ['FULL_NAME', 'EMAIL', 'PHONE', 'CITY']) assert.notEqual(h.t(`ads.leads.q.${q}`), `ads.leads.q.${q}`);
            for (const c of ['LOCKED_LEGAL', 'RESTRICTED_QUESTION', 'NOT_CONNECTED', 'META_ERROR', 'ADS_DISABLED']) assert.notEqual(h.t(`ads.leads.err.${c}`), `ads.leads.err.${c}`);
        });
    }
});
