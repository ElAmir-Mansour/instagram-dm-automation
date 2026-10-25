/**
 * Ads, phase A7: the Proposals tab (`#/ads_proposals`), the dashboard half (spec 002, T133).
 *
 * The REAL `ads_proposals.js` (with `ads_campaigns.js` for the tab bar) in the shared `node:vm` harness, the API stubbed:
 *   - a card shows the rationale, the evidence numbers and the spend effect (with the tax note), the policy warnings and the money note;
 *   - Approve asks first and sends `confirm: true` only after the yes; a refusal is said in words inside the question;
 *   - Edit in builder opens the full builder with the draft's spec; Reject asks first;
 *   - a drafting proposal is a waiting card, saying a Mac draft can take minutes, and the page follows it until it is ready;
 *   - a viewer sees no buttons; everything the model wrote is escaped.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/[⁦⁧⁨⁩]/g, '').replace(/\s+/g, ' ').trim();

const SPEC: Json = {
    name: 'Workshop — messages test', goal: 'messages', destinations: ['instagram'], specialCategory: 'none',
    budget: { home: 'campaign', kind: 'daily', amount: 10, start: '2026-11-01T00:00:00Z', end: '2026-11-08T00:00:00Z' },
    adsets: [{ name: 'EG', targeting: { countries: ['EG', 'SA'], ageMin: 22, ageMax: 45, advantageAudience: false }, placements: 'automatic' }],
    ads: [{ adsetIndex: 0, name: 'Ad', creative: { source: 'post', postId: 'p1', platform: 'instagram' }, copy: { primaryText: 'Learn AI from zero <b>now</b>' } }],
};

function proposal(over: Json = {}): Json {
    return {
        id: 'p-open', kind: 'new_campaign', source: 'request', state: 'open', request: 'promote the workshop', post: null, spec: SPEC, change: null,
        rationale: 'Messages cost less than clicks in your account <script>x</script>', assumptions: ['Ages 22–45 because your buyers are'],
        expected: { metric: 'conversations', range: [8, 14] }, evidence: { window: '7d', numbers: { spend: 70, costPerResult: 10 } },
        effect: { worstCaseDelta: 70, newWorstCase: 430, currency: 'USD' },
        checks: { policy: [{ ruleId: 'limited_time', severity: 'warn', field: 'x', message: 'Says limited time with no date' }], money: { ok: true, reason: null, note: 'The budget was reduced from 20 to 10 USD.' }, meta_validate: null },
        error: null, via: 'mac', expiresAt: new Date(Date.now() + 5 * 86400000).toISOString(), createdAt: new Date().toISOString(), decidedAt: null,
        ...over,
    };
}

interface Setup { list?: Json[]; owner?: boolean; api?: Json; builder?: boolean }

async function open(setup: Setup = {}) {
    const calls: Array<[string, unknown[]]> = [];
    const record = (name: string, fn: (...args: Json[]) => unknown) => (...args: Json[]) => { calls.push([name, args]); return fn(...args); };
    const api: Json = {
        token: 't',
        getAdsProposals: record('getAdsProposals', async () => ({ proposals: JSON.parse(JSON.stringify(setup.list ?? [proposal()])) })),
        getAdsProposal: record('getAdsProposal', async () => ({ proposal: proposal() })),
        approveAdsProposal: record('approveAdsProposal', async () => ({ proposal: proposal({ state: 'applying' }), ops: [{ id: 'op1' }] })),
        rejectAdsProposal: record('rejectAdsProposal', async () => ({ proposal: proposal({ state: 'rejected' }) })),
        requestAdsProposal: record('requestAdsProposal', async () => ({ proposal: proposal({ id: 'p-new', state: 'drafting', spec: null, rationale: null }) })),
        ...(setup.api ?? {}),
    };
    const opened: Json[] = [];
    const globals: Json = {
        API: new Proxy(api, { get: (target, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) }),
        App: { canOperate: () => setup.owner !== false, canAdminister: () => setup.owner !== false },
    };
    if (setup.builder !== false) globals.AdsCreatePage = { openWith: (preset: Json) => opened.push(preset) };
    const h = loadDashboard({ lang: 'en', files: ['dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_proposals.js'], globals });
    const toasts: string[] = [];
    h.UI.toast = (m: string) => { toasts.push(String(m)); };
    const confirms: Json[] = [];
    h.UI.confirm = (o: Json) => { confirms.push(o); };
    const modals: string[] = [];
    h.UI.showModal = (markup: unknown) => { modals.push(String(markup)); };
    h.UI.closeModal = () => {};
    const container = h.el('page-container');
    const page: Json = h.run('AdsProposalsPage');
    await page.render();
    await settle();
    return { h, page, calls, opened, toasts, confirms, modals, screen: (): string => String(container.innerHTML), called: (n: string) => calls.filter(([c]) => c === n) };
}

describe('Proposals tab: the cards (T133)', () => {
    it('shows the rationale, the evidence, the spend effect with the tax note, the warnings and the money note', async () => {
        const { h, screen } = await open();
        const html = screen();
        const words = text(html);
        assert.match(html, /id="adsprop-p-open"/);
        assert.match(html, /id="adsprop-rationale-p-open"/);
        assert.ok(words.includes('Messages cost less than clicks in your account'));
        assert.match(html, /id="adsprop-evidence-p-open"/);
        assert.ok(words.includes(h.t('ads.proposals.measure.costPerResult')));
        assert.match(html, /id="adsprop-effect-p-open"/);
        assert.ok(words.includes(text(h.t('ads.proposals.effect.adds', { amount: '70 USD' }))), words);
        assert.ok(words.includes(text(h.t('ads.tax.note'))));
        assert.ok(words.includes('Says limited time with no date'));
        assert.ok(words.includes('The budget was reduced from 20 to 10 USD.'));
        assert.ok(words.includes(h.t('ads.proposals.state.open')));
        assert.ok(html.includes('href="#/ads_proposals"') && /aria-current="page"[^>]*>|ads_proposals" aria-current/.test(html), 'the tab bar marks Proposals');
    });

    it('escapes everything the model wrote', async () => {
        const { screen } = await open();
        const html = screen();
        assert.ok(!html.includes('<script>x</script>'));
        assert.ok(!html.includes('<b>now</b>'));
        assert.ok(html.includes('&lt;script&gt;') || html.includes('&lt;b&gt;'));
    });

    it('shows a waiting card for a draft, with the Mac copy, and follows it until it is open', async () => {
        const drafting = proposal({ id: 'p-d', state: 'drafting', spec: null, rationale: null, via: 'mac', request: 'promote the workshop' });
        const { h, page, screen, called } = await open({ list: [drafting], api: { getAdsProposal: async () => ({ proposal: proposal({ id: 'p-d' }) }) } });
        let html = screen();
        assert.match(html, /id="adsprop-p-d"[^>]*aria-busy="true"/);
        assert.ok(text(html).includes(h.t('ads.proposals.drafting.mac')));
        assert.ok(page._polls['p-d'], 'the draft is followed');
        await page.pollOnce('p-d');
        html = screen();
        assert.match(html, /data-state="open"/);
        assert.equal(page._polls['p-d'], undefined, 'and no longer once it is open');
        assert.equal(called('getAdsProposals').length, 1);
        page.destroy();
    });

    it('says a server draft takes under a minute', async () => {
        const { h, page, screen } = await open({ list: [proposal({ id: 'p-d', state: 'drafting', spec: null, via: 'api' })] });
        assert.ok(text(screen()).includes(h.t('ads.proposals.drafting.api')));
        page.destroy();
    });

    it('drops a review that found nothing to change when the server forgets it (404)', async () => {
        const { page, screen } = await open({
            list: [proposal({ id: 'p-r', state: 'drafting', kind: 'change', source: 'daily_review', spec: null })],
            api: { getAdsProposal: async () => { const e: Json = new Error('No such proposal.'); e.status = 404; throw e; } },
        });
        await page.pollOnce('p-r');
        assert.ok(!screen().includes('id="adsprop-p-r"'));
    });
});

describe('Proposals tab: the shell', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`has its page title and subtitle in ${lang} (the shell reads page.<route>.subtitle)`, () => {
            const h = loadDashboard({ lang, files: ['dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_proposals.js'] });
            for (const key of ['nav.ads_proposals', 'page.ads_proposals.subtitle', 'ads.tabs.proposals']) assert.notEqual(h.t(key), key, key);
        });
    }
});

describe('Proposals tab: approve, edit, reject (T133)', () => {
    it('approve asks first, then sends confirm, and shows the new state', async () => {
        const { page, confirms, called, screen } = await open();
        page.approve('p-open');
        assert.equal(confirms.length, 1);
        assert.equal(called('approveAdsProposal').length, 0, 'nothing before the yes');
        await confirms[0].onConfirm();
        assert.deepEqual(called('approveAdsProposal')[0]![1], ['p-open']);
        assert.match(screen(), /data-state="applying"/);
    });

    it('a refusal is said in words inside the question', async () => {
        const refusal: Json = new Error('over'); refusal.code = 'OVER_MONTHLY_CAP';
        const { h, page, confirms } = await open({ api: { approveAdsProposal: async () => { throw refusal; } } });
        page.approve('p-open');
        await assert.rejects(confirms[0].onConfirm(), (e: Error) => e.message === h.t('ads.proposals.err.OVER_MONTHLY_CAP'));
    });

    it('edit in builder opens the full builder with the spec', async () => {
        const { page, opened } = await open();
        await page.edit('p-open');
        assert.equal(opened.length, 1);
        assert.equal(opened[0].spec.name, SPEC.name);
        assert.equal(opened[0].proposalId, 'p-open');
    });

    it('reject asks first and creates nothing', async () => {
        const { page, confirms, called, screen } = await open();
        page.reject('p-open');
        assert.equal(called('rejectAdsProposal').length, 0);
        await confirms[0].onConfirm();
        assert.equal(called('rejectAdsProposal').length, 1);
        assert.equal(called('approveAdsProposal').length, 0);
        assert.match(screen(), /data-state="rejected"/);
    });

    it('a viewer sees the card and no buttons', async () => {
        const { screen, h } = await open({ owner: false });
        const html = screen();
        assert.ok(!html.includes('data-action="adsprop:approve"'));
        assert.ok(!html.includes('data-action="adsprop:suggest"'));
        assert.ok(text(html).includes(h.t('ads.proposals.ownerDecides')));
    });

    it('approve is disabled while a check is unavailable on the deployment', async () => {
        const { screen } = await open({ list: [proposal({ checks: { policy: [], money: { ok: false, reason: 'NOT_WIRED', note: null }, meta_validate: null, unavailable: ['money'] } })] });
        assert.match(screen(), /data-action="adsprop:approve"[^>]*disabled|disabled[^>]*data-action="adsprop:approve"/);
    });

    it('"Suggest a campaign" sends the owner\'s words and shows the drafting card', async () => {
        const { h, page, modals, called, screen } = await open();
        page.suggest();
        assert.equal(modals.length, 1);
        h.el('adsprop-request', { value: 'messages for the workshop' } as Json);
        await page.suggestSend();
        assert.deepEqual(JSON.parse(JSON.stringify(called('requestAdsProposal')[0]![1])), [{ request: 'messages for the workshop' }]);
        assert.match(screen(), /id="adsprop-p-new"/);
        page.destroy();
    });
});
