/**
 * Ads, the Tests tab (dashboard/js/pages/ads_tests.js): split tests, an A/B comparison of two ads or two audiences.
 *
 * Loaded like the other dashboard tests: the REAL shipped files in a `node:vm` context (src/dashboard/_harness.ts) with a fake DOM, a stub
 * `API` and a stub `UI.confirm`, so these test what ships. What is pinned, because a screenshot cannot check it:
 *
 *   - the list says what Meta found: the winner marked, its confidence (a null one is "—", never 0%), "no clear winner" as such, and the
 *     way to the proposal that is waiting;
 *   - a member who is not the owner reads the list and gets no button and no form;
 *   - START spends money: nothing is sent when it is pressed, the question names the daily budget, the days, the worst case and who is
 *     charged, and `confirm: true` leaves only after "yes"; the API client sends exactly that body and nowhere else;
 *   - CREATE spends nothing but still asks, and a BUSINESS_REQUIRED refusal opens the picker, saves the choice and sends the test again;
 *   - the equal split (3 arms are 34 / 33 / 33) and the worst case (daily x days) shown as the form is filled;
 *   - every `ads.tests.*` key the page uses exists in both languages, and each error code has a sentence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const PAGE = 'dashboard/js/pages/ads_tests.js';
const BIDI = /[⁦⁧⁨⁩​]/g;
/** Markup as a reader sees it: tags gone, isolates gone, white space folded. */
const plain = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(BIDI, '').replace(/\s+/g, ' ');

/** A value made in the page's vm realm, as one from this realm (deepEqual compares prototypes). */
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v));

const cell = (over: Json = {}): Json => ({
    name: 'Version A', objectId: 'o1', metaId: 'm1', objectName: 'Ad one', level: 'ad', treatmentPercentage: 50, winner: false, confidence: null, ...over,
});
const study = (over: Json = {}): Json => ({
    id: 's1', metaId: 'ms1', type: 'creative', name: 'Spring offer', state: 'ready', dailyBudget: 50, currency: 'SAR', start: '2026-11-01', end: '2026-11-08', days: 7,
    cells: [cell(), cell({ name: 'Version B', objectId: 'o2', metaId: 'm2', objectName: 'Ad two' })],
    result: null, proposalId: null, error: null, createdAt: '2026-10-22T10:00:00Z', adsManagerUrl: 'https://www.facebook.com/adsmanager/x', ...over,
});
const item = (id: string, over: Json = {}): Json => ({
    id, level: 'ad', name: `Ad ${id}`, status: 'PAUSED', parentId: 'set1', budget: { kind: 'none', amount: null, currency: 'SAR' }, creative: { thumbUrl: 'https://cdn.example.test/t.png' }, ...over,
});
const refusal = (code: string, status: number, body: Json = {}): Error => Object.assign(new Error(`server says ${code}`), { code, status, body: { code, ...body } });

interface Rig {
    h: ReturnType<typeof loadDashboard>;
    Tests: Json;
    host: Json;
    calls: Array<{ method: string; args: Json[] }>;
    confirms: Json[];
    modals: string[];
    toasts: string[];
    api: Record<string, (...args: Json[]) => unknown>;
}

function rig(options: { lang?: 'ar' | 'en'; owner?: boolean; studies?: Json[]; businessId?: string | null } = {}): Rig {
    const calls: Rig['calls'] = [];
    const api: Rig['api'] = {
        getAdsStudies: async () => ({ studies: options.studies ?? [study()], businessId: options.businessId ?? null }),
        getAdsObjects: async () => ({ items: [item('a1'), item('a2'), item('a3')] }),
    };
    const API = new Proxy(api, {
        get: (target, prop: string) => (prop === 'token' ? 'tok' : (...args: Json[]) => {
            calls.push({ method: prop, args });
            if (!(prop in target)) return Promise.reject(new Error(`API.${prop} is not stubbed`));
            return target[prop]!(...args);
        }),
    });
    const owner = options.owner !== false;
    const h = loadDashboard({ lang: options.lang ?? 'en', files: [PAGE], globals: { API, App: { canAdminister: () => owner } } });
    const confirms: Json[] = [];
    const modals: string[] = [];
    const toasts: string[] = [];
    h.UI.confirm = (o: Json): void => { confirms.push(o); };
    h.UI.showModal = (m: unknown): void => { modals.push(String(m)); };
    h.UI.closeModal = (): void => {};
    h.UI.toast = (message: string): void => { toasts.push(String(message)); };
    return { h, Tests: h.run('AdsTests'), host: h.el('tests-host'), calls, confirms, modals, toasts, api };
}

async function mounted(options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
    const r = rig(options);
    r.Tests.mount(r.host);
    await settle();
    return r;
}

/** A form element the page can read back: `elements.<name>.value`. */
const formOf = (values: Record<string, string>): Json => ({ querySelector: () => null, elements: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }])) });

describe('Ads tests: the list', () => {
    it('shows each test with its arms and shares, the winner marked with its confidence, and a null confidence as a dash', async () => {
        const done = study({
            state: 'ended',
            cells: [cell({ winner: true, confidence: 95, treatmentPercentage: 50 }), cell({ name: 'Version B', objectId: 'o2', confidence: null, treatmentPercentage: 50 })],
            result: { winnerObjectIds: ['o1'], confidenceByObjectId: { o1: 95 }, final: true, checkedAt: '2026-11-09T08:00:00Z', noWinner: false },
        });
        const r = await mounted({ studies: [done] });
        const markup = r.host.innerHTML as string;
        const text = plain(markup);
        assert.match(markup, /ads-test-arm--winner/);
        assert.ok(text.includes('Winner'));
        assert.ok(text.includes('Confidence: 95%'), text);
        assert.ok(text.includes('Confidence: —'), 'a null confidence is a dash, never 0%');
        assert.ok(text.includes('Share of the audience: 50%'));
        assert.ok(text.includes('Spring offer') && text.includes('Ad versions') && text.includes('Ended'));
        assert.ok(text.includes('50 SAR a day'));
        assert.ok(text.includes('Final result from Meta'));
        assert.equal(r.Tests.confidencePercent(0.95), 95, 'a share is read as a percentage');
        assert.equal(r.Tests.confidencePercent(null), null);
    });

    it('says "no clear winner" when Meta could not separate the arms, and links to the proposal that is waiting', async () => {
        const none = study({ state: 'ended', result: { winnerObjectIds: [], confidenceByObjectId: {}, final: true, checkedAt: null, noWinner: true } });
        const kept = study({ id: 's2', name: 'Audiences', state: 'ended', proposalId: 'p9', result: { winnerObjectIds: ['o1'], confidenceByObjectId: { o1: 90 }, final: true, checkedAt: null, noWinner: false } });
        const r = await mounted({ studies: [none, kept] });
        const text = plain(r.host.innerHTML);
        assert.ok(text.includes('No clear winner'));
        assert.ok(text.includes('A proposal to keep the winner is waiting'));
        assert.match(r.host.innerHTML as string, /href="#\/ads\/proposals"/);
        assert.equal((r.host.innerHTML as string).split('#/ads/proposals').length - 1, 1, 'only the test that has a proposal links to it');
    });

    it('draws each state: creating says so, failed shows its error, ready offers Start and Stop, running only Stop', async () => {
        const r = await mounted({ studies: [
            study({ id: 'c', name: 'C', state: 'creating' }),
            study({ id: 'f', name: 'F', state: 'failed', error: 'Meta said no' }),
            study({ id: 'r', name: 'R', state: 'ready' }),
            study({ id: 'u', name: 'U', state: 'running' }),
            study({ id: 'e', name: 'E', state: 'ended' }),
        ] });
        const card = (id: string): string => {
            const markup = r.host.innerHTML as string;
            const from = markup.indexOf(`id="ads-test-${id}"`);
            const to = markup.indexOf('</article>', from);
            return markup.slice(from, to);
        };
        assert.ok(plain(card('c')).includes('Being created at Meta'));
        assert.ok(plain(card('f')).includes('Meta said no'));
        assert.match(card('r'), /data-action="adstests:start"/);
        assert.match(card('r'), /data-action="adstests:stop"/);
        assert.equal(/data-action="adstests:start"/.test(card('u')), false);
        assert.match(card('u'), /data-action="adstests:stop"/);
        assert.equal(/data-action="adstests:(start|stop)"/.test(card('e')), false);
        assert.equal(/data-action="adstests:(start|stop)"/.test(card('c')), false);
    });

    it('has the intro and the help link to the split-tests section', async () => {
        const r = await mounted();
        assert.match(r.host.innerHTML as string, /href="#\/help\/ads#split-tests"/);
        assert.ok(plain(r.host.innerHTML).includes('Meta splits the audience'));
    });

    it('draws everything in Arabic with no raw key left, and escapes what a person typed', async () => {
        const r = await mounted({ lang: 'ar', studies: [study({ name: '<img src=x onerror=alert(1)>', state: 'ended', result: { noWinner: true, final: false, checkedAt: '2026-11-09T08:00:00Z' } })] });
        const markup = r.host.innerHTML as string;
        assert.equal(/ads\.tests\./.test(markup), false, 'no raw key');
        assert.equal(markup.includes('<img src=x'), false, 'the name is escaped');
        assert.ok(plain(markup).includes('لا فائز واضحاً'));
        r.Tests.openForm();
        await settle();
        const form = r.host.innerHTML as string;
        assert.equal(/ads\.tests\./.test(form), false, 'no raw key in the form either');
    });

    it('answers a stale read by painting nothing: a destroyed page stays empty', async () => {
        const r = rig();
        r.Tests.mount(r.host);
        r.Tests.destroy();
        await settle();
        assert.equal(r.Tests.studies.length, 0);
        assert.equal(String(r.host.innerHTML).includes('Spring offer'), false);
    });

    it('is a calm owners-only panel on a 403, and a retry on any other failure', async () => {
        const r = rig();
        r.api.getAdsStudies = async () => { throw Object.assign(new Error('no'), { status: 403 }); };
        r.Tests.mount(r.host);
        await settle();
        assert.ok(plain(r.host.innerHTML).includes(r.h.t('ads.owner.title')));
        assert.equal(r.toasts.length, 0);
        const f = rig();
        f.api.getAdsStudies = async () => { throw new Error('boom'); };
        f.Tests.mount(f.host);
        await settle();
        assert.match(f.host.innerHTML as string, /data-action="adstests:reload"/);
    });
});

describe('Ads tests: a viewer', () => {
    it('reads the list and gets no button, no form and no way to start or stop', async () => {
        const r = await mounted({ owner: false, studies: [study({ state: 'ready' }), study({ id: 's2', state: 'running' })] });
        const markup = r.host.innerHTML as string;
        assert.ok(plain(markup).includes('Spring offer'), 'the list is there');
        assert.equal(/data-action="adstests:/.test(markup), false, 'no action of ours');
        assert.equal(/<form/.test(markup), false);
        assert.equal(/<button/.test(markup), false);
        // Even called directly, nothing is asked and nothing is sent.
        r.Tests.start('s1');
        r.Tests.stop('s2');
        r.Tests.openForm();
        assert.equal(r.confirms.length, 0);
        assert.equal(r.Tests._form, null);
    });
});

describe('Ads tests: Start spends money, so it asks first', () => {
    it('sends nothing when Start is pressed; the question names the daily budget, the days, the worst case, the currency and who is charged', async () => {
        const r = await mounted();
        r.h.run('UI')._actions.adstests.start({ dataset: { id: 's1' } });
        assert.equal(r.confirms.length, 1);
        assert.equal(r.calls.some((c) => c.method === 'startAdsStudy'), false, 'nothing is sent by the press');
        const q = r.confirms[0];
        const said = plain(`${q.title} ${q.body} ${q.hint}`);
        assert.ok(said.includes('50 SAR a day'), said);
        assert.ok(said.includes('7 days'), said);
        assert.ok(said.includes('350 SAR'), 'the worst case: 50 x 7');
        assert.ok(said.includes('payment method'), said);
        assert.equal(typeof q.onConfirm, 'function');
        assert.notEqual(q.tone, 'primary', 'spending money is not dressed as a calm action');
    });

    it('sends confirm: true only after yes, and puts the answer on screen', async () => {
        const r = await mounted();
        const running = study({ state: 'running' });
        r.api.startAdsStudy = async () => ({ study: running, ops: [] });
        r.Tests.start('s1');
        // "No": the dialog is closed without calling onConfirm.
        assert.equal(r.calls.filter((c) => c.method === 'startAdsStudy').length, 0);
        await r.confirms[0].onConfirm();
        const sent = r.calls.filter((c) => c.method === 'startAdsStudy');
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0]!.args, ['s1']);
        assert.equal(r.Tests.findStudy('s1').state, 'running');
        assert.ok(r.toasts.includes(r.h.t('ads.tests.started')));
    });

    it('says a refusal inside the question, in our own words', async () => {
        const r = await mounted();
        r.api.startAdsStudy = async () => { throw refusal('OVER_MONTHLY_CAP', 409); };
        r.Tests.start('s1');
        await assert.rejects(() => r.confirms[0].onConfirm(), (err: Error) => err.message === r.h.t('ads.tests.err.OVER_MONTHLY_CAP'));
    });

    it('only a test that is ready can be started, and Stop asks with a short question', async () => {
        const r = await mounted({ studies: [study({ state: 'running' })] });
        r.Tests.start('s1');
        assert.equal(r.confirms.length, 0, 'a running test is not started again');
        r.Tests.stop('s1');
        assert.equal(r.confirms.length, 1);
        r.api.stopAdsStudy = async () => ({ study: study({ state: 'stopped' }), ops: [] });
        await r.confirms[0].onConfirm();
        assert.equal(r.Tests.findStudy('s1').state, 'stopped');
    });

    it('the API client sends confirm: true to /start and nothing to /stop, and never anywhere else', () => {
        const sent: Array<{ url: string; init: Json }> = [];
        const fetchStub = async (url: string, init: Json): Promise<Json> => { sent.push({ url, init }); return { ok: true, status: 200, text: async () => '{}' }; };
        const h = loadDashboard({ files: ['dashboard/js/api.js'], globals: { fetch: fetchStub } });
        const API = h.run('API');
        API.token = 'tok';
        API.startAdsStudy('a/b');
        API.stopAdsStudy('s1');
        API.getAdsObjects({ level: 'adset', status: 'PAUSED' });
        API.createAdsStudy({ type: 'creative', confirm: true });
        return settle().then(() => {
            const by = (suffix: string): { url: string; init: Json } => sent.find((s) => s.url.endsWith(suffix))!;
            assert.deepEqual(JSON.parse(by('/ads/studies/a%2Fb/start').init.body), { confirm: true });
            assert.equal(by('/ads/studies/s1/stop').init.body, undefined);
            assert.equal(by('/ads/studies/s1/stop').init.method, 'POST');
            assert.ok(by('/ads/objects?level=adset&status=PAUSED'));
            assert.equal(by('/ads/studies').init.method, 'POST');
        });
    });
});

describe('Ads tests: the form', () => {
    it('splits equally, the remainder going to the first arms: 3 arms are 34 / 33 / 33', async () => {
        const r = await mounted();
        assert.deepEqual(json(r.Tests.shares(2)), [50, 50]);
        assert.deepEqual(json(r.Tests.shares(3)), [34, 33, 33]);
        assert.deepEqual(json(r.Tests.shares(7)), [15, 15, 14, 14, 14, 14, 14]);
        for (let n = 2; n <= 7; n++) assert.equal(r.Tests.shares(n).reduce((a: number, b: number) => a + b, 0), 100);
        assert.deepEqual(json(r.Tests.shares(1)), []);
        assert.deepEqual(json(r.Tests.shares(0)), []);
    });

    it('shows the split and the worst case as the form is filled', async () => {
        const r = await mounted();
        r.Tests.openForm();
        await settle();
        for (const id of ['a1', 'a2', 'a3']) r.Tests.armToggled({ value: id, checked: true });
        const start = r.Tests.tomorrow();
        r.Tests.syncFrom(formOf({ dailyBudget: '20', name: '', start, end: r.Tests.addDays(start, 5) }));
        const summary = plain(r.Tests.summaryMarkup());
        assert.ok(summary.includes('Equal split: 34% / 33% / 33%'), summary);
        assert.ok(summary.includes('20 SAR a day for 5 days comes to 100 SAR'), summary);
        assert.ok(plain(r.Tests.summaryMarkup()).includes('monthly cap'));
    });

    it('offers the paused ads with their names and thumbnails, the start date from tomorrow, and says creating spends nothing', async () => {
        const r = await mounted();
        const cands = r.h.el('ads-tests-candidates');
        r.Tests.openForm();
        await settle();
        const markup = `${r.host.innerHTML} ${cands.innerHTML}`;
        assert.equal(JSON.stringify(r.calls.find((c) => c.method === 'getAdsObjects')!.args), JSON.stringify([{ level: 'ad', status: 'PAUSED' }]));
        assert.ok(plain(markup).includes('Ad a1'));
        assert.match(markup, /<img class="ads-test-thumb" src="https:\/\/cdn\.example\.test\/t\.png"/);
        assert.match(markup, new RegExp(`id="ads-tests-start"[^>]*min="${r.Tests.tomorrow()}"`));
        assert.ok(plain(markup).includes('Creating the test spends nothing'));
        r.Tests._form.type = 'audience';
        r.Tests.loadCandidates();
        await settle();
        assert.equal(JSON.stringify(r.calls.filter((c) => c.method === 'getAdsObjects').at(-1)!.args), JSON.stringify([{ level: 'adset', status: 'PAUSED' }]));
    });

    it('shows "build the versions first" when the objects route is not there yet (404), not an error', async () => {
        const r = await mounted();
        r.api.getAdsObjects = async () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
        r.Tests.openForm();
        await settle();
        assert.equal(r.Tests._cands.state, 'empty');
        const text = plain(r.Tests.candidatesMarkup());
        assert.ok(text.includes('Build the versions first in the builder'), text);
        assert.equal(/inline-error/.test(String(r.Tests.candidatesMarkup())), false);
    });

    it('takes at most as many arms as the kind allows', async () => {
        const r = await mounted();
        r.api.getAdsObjects = async () => ({ items: Array.from({ length: 9 }, (_, i) => item(`x${i}`, { level: 'adset' })) });
        r.Tests.openForm();
        await settle();
        r.Tests._form.type = 'audience';
        const boxes = Array.from({ length: 6 }, (_, i) => ({ value: `x${i}`, checked: true }));
        boxes.forEach((b) => r.Tests.armToggled(b));
        assert.equal(r.Tests._form.picked.length, 5, 'audiences take at most five');
        assert.equal(boxes[5]!.checked, false, 'the sixth box is put back');
    });

    it('refuses the common slips before asking anything: too few arms, a past start, a long run, ads of two ad sets', async () => {
        const r = await mounted();
        r.api.getAdsObjects = async () => ({ items: [item('a1'), item('a2', { parentId: 'other' })] });
        r.Tests.openForm();
        await settle();
        const start = r.Tests.tomorrow();
        const submit = (values: Record<string, string>): void => r.Tests.submit(formOf({ name: '', ...values }), { preventDefault() {} });
        submit({ dailyBudget: '10', start, end: r.Tests.addDays(start, 3) });
        assert.equal(r.confirms.length, 0, 'nothing picked');
        r.Tests.armToggled({ value: 'a1', checked: true });
        r.Tests.armToggled({ value: 'a2', checked: true });
        submit({ dailyBudget: '10', start, end: r.Tests.addDays(start, 3) });
        assert.equal(r.confirms.length, 0, 'two ad sets');
        assert.equal(r.Tests.problem(r.Tests._form).message, r.h.t('ads.tests.err.sameAdset'));
        r.api.getAdsObjects = async () => ({ items: [item('a1'), item('a2')] });
        r.Tests._cands.items = [item('a1'), item('a2')];
        submit({ dailyBudget: '0', start, end: r.Tests.addDays(start, 3) });
        assert.equal(r.Tests.problem(r.Tests._form).field, 'dailyBudget');
        submit({ dailyBudget: '10', start: r.Tests.today(), end: r.Tests.addDays(r.Tests.today(), 3) });
        assert.equal(r.Tests.problem(r.Tests._form).field, 'start');
        submit({ dailyBudget: '10', start, end: r.Tests.addDays(start, 31) });
        assert.equal(r.Tests.problem(r.Tests._form).field, 'end');
        submit({ dailyBudget: '10', start, end: start });
        assert.equal(r.Tests.problem(r.Tests._form).field, 'end', 'zero days');
        assert.equal(r.confirms.length, 0);
        assert.equal(r.calls.some((c) => c.method === 'createAdsStudy'), false);
    });

    it('creating asks a plain question that says nothing is spent, and sends confirm: true only after yes', async () => {
        const r = await mounted();
        const made = study({ id: 's9', name: 'New one', state: 'creating' });
        r.api.createAdsStudy = async () => ({ study: made, ops: [] });
        r.api.getAdsStudies = async () => ({ studies: [made, study()], businessId: null });
        r.Tests.openForm();
        await settle();
        r.Tests.armToggled({ value: 'a1', checked: true });
        r.Tests.armToggled({ value: 'a2', checked: true });
        const start = r.Tests.tomorrow();
        const end = r.Tests.addDays(start, 7);
        r.Tests.submit(formOf({ dailyBudget: '30', name: ' Spring ', start, end }), { preventDefault() {} });
        assert.equal(r.confirms.length, 1);
        assert.ok(plain(r.confirms[0].body).includes('nothing is spent until you start it'));
        assert.equal(r.confirms[0].tone, 'primary');
        assert.equal(r.calls.some((c) => c.method === 'createAdsStudy'), false, 'nothing is sent by the form alone');
        r.confirms[0].onConfirm();
        await settle();
        const sent = r.calls.filter((c) => c.method === 'createAdsStudy');
        assert.equal(sent.length, 1);
        assert.deepEqual(json(sent[0]!.args[0]), { type: 'creative', cells: ['a1', 'a2'], dailyBudget: 30, start, end, confirm: true, name: 'Spring' });
        assert.equal(r.Tests._form, null, 'the form closes');
        assert.equal(r.Tests.findStudy('s9').state, 'creating', 'the new test is at the top of the list');
        assert.equal(r.Tests.studies[0].id, 's9');
        assert.ok(r.toasts.includes(r.h.t('ads.tests.created')));
    });
});

describe('Ads tests: a business portfolio is required', () => {
    it('BUSINESS_REQUIRED opens the picker with the portfolios, saves the choice with the ads settings, then creates the test again', async () => {
        const r = await mounted();
        let attempt = 0;
        r.api.createAdsStudy = async () => {
            attempt++;
            if (attempt === 1) throw refusal('BUSINESS_REQUIRED', 409, { choices: [{ id: 'b1', name: 'Acme portfolio' }, { id: 'b2', name: 'Second portfolio' }] });
            return { study: made, ops: [] };
        };
        const made = study({ id: 's7', state: 'creating' });
        r.api.getAdsStudies = async () => ({ studies: [made, study()], businessId: 'b2' });
        r.api.saveAdsSettings = async () => ({ ok: true });
        r.Tests.openForm();
        await settle();
        r.Tests.armToggled({ value: 'a1', checked: true });
        r.Tests.armToggled({ value: 'a2', checked: true });
        const start = r.Tests.tomorrow();
        r.Tests.submit(formOf({ dailyBudget: '15', name: '', start, end: r.Tests.addDays(start, 4) }), { preventDefault() {} });
        r.confirms[0].onConfirm();
        await settle();
        assert.equal(r.modals.length, 1, 'the picker is open');
        const picker = plain(r.modals[0]);
        assert.ok(picker.includes('Acme portfolio') && picker.includes('Second portfolio'), picker);
        assert.equal(r.calls.some((c) => c.method === 'saveAdsSettings'), false, 'nothing is saved before the pick');
        // Submitting without choosing says so and sends nothing.
        await r.Tests.businessSubmit(formOf({}), { preventDefault() {} });
        assert.equal(r.calls.some((c) => c.method === 'saveAdsSettings'), false);
        r.Tests.businessChosen({ value: 'b2' });
        await r.Tests.businessSubmit(formOf({ business: 'b2' }), { preventDefault() {} });
        await settle();
        const saved = r.calls.find((c) => c.method === 'saveAdsSettings')!;
        assert.deepEqual(json(saved.args[0]), { businessId: 'b2' });
        const creates = r.calls.filter((c) => c.method === 'createAdsStudy');
        assert.equal(creates.length, 2, 'the same test is sent again');
        assert.deepEqual(json(creates[1]!.args[0]), json(creates[0]!.args[0]));
        assert.equal(creates[1]!.args[0].confirm, true);
        assert.equal(r.Tests.findStudy('s7').state, 'creating');
        assert.equal(r.Tests.businessId, 'b2');
    });

    it('with no portfolio to choose from, says so and offers no save', async () => {
        const r = await mounted();
        r.Tests.askBusiness([], { type: 'creative' });
        const picker = plain(r.modals[0]);
        assert.ok(picker.includes('Meta shows no business portfolio'));
        assert.equal(/ads-tests-business-save/.test(r.modals[0]!), false);
    });
});

describe('Ads tests: every refusal has a sentence', () => {
    it('words each code in both languages, and shows the server\'s own text for a code it does not know', async () => {
        for (const lang of ['en', 'ar'] as const) {
            const r = rig({ lang });
            for (const code of r.Tests.CODES as string[]) {
                if (code === 'RATE_LIMITED') continue;
                const said = r.Tests.sentence(refusal(code, 409));
                assert.equal(said, r.h.t(`ads.tests.err.${code}`), `${lang} ${code}`);
                assert.notEqual(said, `ads.tests.err.${code}`, `${lang} ${code} has words`);
            }
            const later = r.Tests.sentence(refusal('RATE_LIMITED', 429, { retryAt: '2026-11-01T10:00:00Z' }));
            assert.equal(later.includes('{time}'), false);
            assert.equal(r.Tests.sentence(refusal('RATE_LIMITED', 429)), r.h.t('ads.tests.err.RATE_LIMITED.soon'));
            assert.equal(r.Tests.sentence(refusal('SOMETHING_NEW', 400)), 'server says SOMETHING_NEW');
        }
    });

    it('says a create refusal on the form, naming the field the server points at', async () => {
        const r = await mounted();
        const input = r.h.el('ads-tests-daily');
        r.h.el('ads-tests-form-error');
        r.Tests.openForm();
        await settle();
        r.Tests.createFailed(refusal('OVER_DAILY_MAX', 409, { field: 'dailyBudget' }), {});
        assert.ok(plain(r.h.el('ads-tests-form-error').innerHTML).includes(r.h.t('ads.tests.err.OVER_DAILY_MAX')));
        assert.equal(input.getAttribute('aria-invalid'), 'true');
    });
});

describe('Ads tests: the copy', () => {
    const source = readFileSync(PAGE, 'utf8');

    it('has every ads.tests.* key the page uses in both languages (a plural family counts by its _other form)', () => {
        const literal = [...source.matchAll(/t\('(ads\.tests\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]!);
        assert.ok(literal.length > 60, `found ${literal.length} keys`);
        const r = rig();
        const dynamic: string[] = [
            ...(r.Tests.STATES as string[]).map((s) => `ads.tests.state.${s}`),
            ...(r.Tests.TYPES as string[]).flatMap((x) => [`ads.tests.type.${x}.hint`, `ads.tests.arms.legend.${x}`, `ads.tests.type.${x}`]),
            ...(r.Tests.CODES as string[]).map((c) => `ads.tests.err.${c}`),
        ];
        for (const lang of ['ar', 'en'] as const) {
            const dict = loadDashboard({ lang }).I18N.strings[lang] as Record<string, string>;
            for (const key of new Set([...literal, ...dynamic])) {
                assert.ok(dict[key] !== undefined || dict[`${key}_other`] !== undefined, `${lang}: ${key}`);
            }
        }
    });

    it('keeps every key of the namespace in both languages, with the same placeholders', () => {
        const en = loadDashboard({ lang: 'en' }).I18N.strings.en as Record<string, string>;
        const ar = loadDashboard({ lang: 'ar' }).I18N.strings.ar as Record<string, string>;
        const holes = (v: string): string => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
        const family = (k: string): string => k.replace(/_(zero|one|two|few|many|other)$/, '');
        for (const key of Object.keys(en).filter((k) => k.startsWith('ads.tests.'))) {
            assert.ok(ar[key] !== undefined || ar[`${family(key)}_other`] !== undefined, `ar is missing ${key}`);
        }
        for (const key of Object.keys(ar).filter((k) => k.startsWith('ads.tests.') && !/_(zero|one|two|few|many)$/.test(k))) {
            assert.ok(en[key] !== undefined, `en is missing ${key}`);
            if (en[key] !== undefined && !/_other$/.test(key)) assert.equal(holes(ar[key]!), holes(en[key]!), `placeholders of ${key}`);
        }
    });
});

describe('Ads tests: the routed tab', () => {
    it('is #/ads_tests, an Ads page (the Ads item stays current), and a tab in the shared Ads bar', () => {
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(app, /ads_tests: \{ src: 'ads_tests', page: \(\) => AdsTestsPage, navAs: 'ads' \}/);
        const tabs = readFileSync('dashboard/js/pages/ads_campaigns.js', 'utf8');
        assert.match(tabs, /key: 'tests', href: '#\/ads_tests', icon: 'split', label: 'ads\.tabs\.tests'/);
        const page = readFileSync(PAGE, 'utf8');
        assert.match(page, /AdsTabs\.markup\('tests'\)/);
        assert.match(page, /AdsTests\.mount\(document\.getElementById\('ads-tests-host'\)\)/);
    });

    it('a 404 (ads are off for this workspace) is the calm "ads are off" panel, not an error', async () => {
        const h = loadDashboard({ files: [PAGE], lang: 'en', globals: { API: { getAdsStudies: async () => { throw Object.assign(new Error('Not found'), { status: 404 }); } } } });
        const Tests = h.run('AdsTests');
        const host = h.el('ads-tests-host');
        await Tests.mount(host);
        await settle();
        assert.equal(Tests.view, 'disabled');
        assert.ok(plain(host.innerHTML).length > 0);
        assert.doesNotMatch(host.innerHTML, /ads-tests-load-error/);
    });
});
