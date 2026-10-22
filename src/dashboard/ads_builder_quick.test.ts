/**
 * The ad builder's quick mode, opened from Posts' Boost (Meta Ads Manager A4: tasks T090, T095, T096; design contract section 3).
 *
 * Loaded like the other dashboard suites: the REAL shipped files (`ads_builder.js`, `posts.js`, `components.js`, both catalogues) in a
 * `node:vm` context through `_harness.ts`, with the API stubbed. No network, no Meta. What is pinned is what a screenshot cannot:
 *
 *   - Boost opens the builder with the post preselected: goal (Send messages by default when a destination exists), destinations,
 *     countries, daily budget, days, greeting and up to FOUR ice breakers (a fifth cannot be added); the old form is only the fallback
 *     for a module that cannot be loaded;
 *   - typing in the greeting / an ice breaker is checked after a 400 ms pause (never per keystroke), the findings are drawn with the
 *     matched span in an escaped <mark>, block and warn told apart, the explanation and the rewrite in the interface language, and Create
 *     is off while anything is blocked;
 *   - Review sends the CampaignSpec the form describes to `validateAdsDraft` and shows the money check, Meta's minimum budget, the
 *     problems and the warnings, and the bot-off / bot-test warning for each destination (nothing for a bot that is on);
 *   - warnings only: the "I have read the warnings" tick is required, and Create then sends `confirmPolicyWarnings: true`;
 *   - Create says the ad is PAUSED and links to #/ads; POLICY_BLOCKED draws the server's findings again; OVER_MONTHLY_CAP is said on
 *     the budget field; changing anything after a Review asks for another Review;
 *   - every `adsBuilder.*` key the file uses is in both catalogues, and a caption with markup in it is text.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦-⁩]/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SETTINGS = {
    configured: true, adAccountId: 'act_1', limits: { maxDailyBudget: 50, monthlyCap: 500 }, maxDailyBudget: 50, monthlyCap: 500,
    account: { name: 'Main', currency: 'USD', minDailyBudget: 1 },
};
const post = (over: Json = {}): Json => ({
    id: 'p1', platform: 'instagram', post_type: 'reel', status: 'PUBLISHED', caption: 'Learn Go step by step', published_post_id: 'FB:99 | IG:178', ...over,
});

interface Rig {
    h: Dashboard;
    B: Json;
    posts: Json;
    calls: Array<{ method: string; args: Json[] }>;
    answers: Json;
    created: Json[];
    toasts: string[];
    /** Run a registered `adsb:` action on a fresh fake element carrying `init`. */
    act(name: string, init?: Json): void;
    el(id: string): Json;
    modal(): string;
}

/** What validate answers when nothing is wrong. */
const OK_REVIEW = (): Json => ({
    policy: { blocked: false, findings: [] },
    money: { fits: true, remaining: 400, reason: null, currency: 'USD' },
    meta: { ok: true, minimumBudget: 1 },
    problems: [], warnings: [],
    bots: [{ destination: 'instagram', state: 'on' }],
});

function finding(over: Json = {}): Json {
    return {
        ruleId: 'income_figure', severity: 'block', field: 'greeting', start: 0, end: 13, match: 'Earn $500 a d',
        explain: { ar: 'تمنع ميتا ذكر مبالغ الدخل.', en: 'Meta rejects ads that promise an amount of income.' },
        rewrite: { ar: 'تعلّم مهارة خطوة بخطوة بمشاريع عملية.', en: 'Learn a skill step by step with hands-on projects.' },
        ...over,
    };
}

function load(lang: 'ar' | 'en' = 'en', files: string[] = ['dashboard/js/pages/ads_builder.js']): Rig {
    const calls: Rig['calls'] = [];
    const created: Json[] = [];
    const toasts: string[] = [];
    const answers: Json = {
        policy: async () => ({ version: 1, blocked: false, findings: [] }),
        validate: async () => OK_REVIEW(),
        create: async () => ({ campaignId: 'c1', ops: [] }),
        money: async () => ({ currency: 'USD', fits: true, remaining: 400, monthlyCap: 500, maxDailyBudget: 50, reason: null }),
    };
    const api: Json = {
        token: 'tok',
        checkAdsPolicy: (fields: Json) => { calls.push({ method: 'policy', args: [plain(fields)] }); return answers.policy(fields); },
        validateAdsDraft: (spec: Json) => { calls.push({ method: 'validate', args: [plain(spec)] }); return answers.validate(spec); },
        createAdsDraft: (spec: Json, confirm: boolean) => { calls.push({ method: 'create', args: [plain(spec), confirm] }); return answers.create(spec, confirm); },
        getAdsMoney: (candidate?: string) => { calls.push({ method: 'money', args: [candidate ?? null] }); return answers.money(candidate); },
    };
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/posts.js', ...files], globals: { API: api, Admin: { confirm: () => {} }, App: { canOperate: () => true, canAdminister: () => true } } });
    // Every id a page asks for exists, as in a browser where the markup was parsed: the fakes only record what is written to them.
    h.document.getElementById = (id: string) => h.el(id);
    h.el('modal-overlay', {}).classes.add('hidden');
    h.UI.toast = (message: string) => { toasts.push(String(message)); return null; };
    const B = files.length ? h.run('typeof AdsBuilder === "undefined" ? null : AdsBuilder') : null;
    const P = h.run('PostsPage');
    if (B) B.POLICY_DEBOUNCE_MS = 15;
    let n = 0;
    return {
        h, B, posts: P, calls, answers, created, toasts,
        act: (name, init = {}) => { h.UI._actions.adsb[name](h.el(`fake-${++n}`, init), { preventDefault() {}, stopPropagation() {} }); },
        el: (id) => h.el(id),
        modal: () => String(h.el('modal-content').innerHTML),
    };
}

/** Open quick mode the way Posts does, for a published Instagram reel. */
function open(r: Rig, over: Json = {}, settings: Json = SETTINGS, platforms: string[] = ['instagram', 'facebook']): void {
    r.B.openQuick({ post: post(over), platforms, settings, onCreated: (answer: Json) => r.created.push(answer) });
}
const field = (r: Rig, name: string, value: string, extra: Json = {}): void => r.act('field', { dataset: { field: name, ...extra }, value });
const typeGreeting = (r: Rig, value: string): void => field(r, 'greeting', value);
const policyCalls = (r: Rig): Json[] => r.calls.filter((c) => c.method === 'policy');

// ─── What quick mode shows ─────────────────────────────────────────────────────────────────────

describe('quick mode, opened from Posts → Boost', () => {
    it('shows the goal (Send messages first), destinations, countries, budget, days, greeting and ice breakers, for the preselected post', () => {
        const r = load();
        open(r);
        const m = r.modal();
        assert.match(m, /id="adsb-form"/);
        assert.match(m, /<select[^>]*id="adsb-goal"/);
        for (const goal of ['messages', 'engagement', 'reach', 'traffic']) assert.match(m, new RegExp(`<option value="${goal}"`), goal);
        assert.match(m, /<option value="messages"[^>]*selected/, 'Send messages is the default when a destination exists');
        assert.ok(text(m).includes('Send messages'), text(m));
        for (const d of ['instagram', 'messenger', 'whatsapp']) assert.match(m, new RegExp(`id="adsb-dest-${d}"`), d);
        assert.match(m, /id="adsb-dest-instagram"[^>]*checked/, 'Instagram is on by default for an Instagram reel');
        assert.match(m, /id="adsb-countries"[^>]*value="SA"/);
        assert.match(m, /id="adsb-daily"/);
        assert.match(m, /id="adsb-days"[^>]*value="3"/);
        assert.match(m, /id="adsb-greeting"/);
        assert.ok(text(m).includes('Hi! How can we help?'), 'the default greeting');
        assert.match(m, /data-action="adsb:iceAdd"/);
        assert.ok(text(m).includes('Learn Go step by step'), 'the post caption is shown (it is the ad text)');
        assert.match(m, /id="adsb-caption"/);
        assert.equal(r.B.state.post.id, 'p1');
        assert.equal(r.B.state.goal, 'messages');
    });

    it('speaks Arabic in the Arabic interface, right to left, with the greeting in the Arabic default', () => {
        const r = load('ar');
        open(r);
        const said = text(r.modal());
        assert.ok(said.includes('إرسال رسائل'), said);
        assert.ok(said.includes('مرحبًا! كيف يمكننا مساعدتك؟'), said);
        assert.doesNotMatch(r.modal(), /\bdir="ltr"[^>]*id="adsb-greeting"/);
    });

    it('countries come from the settings\' defaultCountries, else SA', () => {
        const r = load();
        open(r, {}, { ...SETTINGS, defaultCountries: ['AE', 'KW'] });
        assert.match(r.modal(), /id="adsb-countries"[^>]*value="AE, KW"/);
    });

    it('a Facebook-only post has no message destination that works yet, so it starts on Engagement', () => {
        const r = load();
        open(r, { platform: 'facebook', published_post_id: 'FB:99' }, SETTINGS, ['facebook']);
        assert.equal(r.B.state.goal, 'engagement');
        assert.match(r.modal(), /<option value="engagement"[^>]*selected/);
    });

    it('the goal decides which fields are on show: destinations, greeting and ice breakers for messages; the link for traffic only', () => {
        const r = load();
        open(r);
        assert.equal(r.el('adsb-messages').classes.has('hidden'), false);
        assert.equal(r.el('adsb-link-group').classes.has('hidden'), true);
        field(r, 'goal', 'traffic');
        assert.equal(r.el('adsb-messages').classes.has('hidden'), true);
        assert.equal(r.el('adsb-link-group').classes.has('hidden'), false);
        field(r, 'goal', 'engagement');
        assert.equal(r.el('adsb-link-group').classes.has('hidden'), true);
        field(r, 'goal', 'messages');
        assert.equal(r.el('adsb-messages').classes.has('hidden'), false);
    });

    it('offers up to four ice breakers: the fifth cannot be added, and the button says so', () => {
        const r = load();
        open(r);
        for (let i = 0; i < 4; i++) r.act('iceAdd');
        assert.equal(r.B.state.ice.length, 4);
        assert.match(String(r.el('adsb-ice').innerHTML), /data-action="adsb:iceAdd"[^>]*disabled/, 'the add button is off at four');
        r.act('iceAdd');
        assert.equal(r.B.state.ice.length, 4, 'a fifth is refused');
        r.act('iceRemove', { dataset: { index: '1' } });
        assert.equal(r.B.state.ice.length, 3);
        assert.doesNotMatch(String(r.el('adsb-ice').innerHTML), /data-action="adsb:iceAdd"[^>]*disabled/, 'room again');
    });

    it('the Boost button hands the post to the builder; a module that will not load is said, there is no old form any more', async () => {
        // The builder is there: Boost opens it, preselected, and never the old form.
        const r = load();
        r.posts.posts = [post()];
        r.posts.ads.settings = SETTINGS;
        await r.posts.boostOpen('p1');
        assert.match(r.modal(), /id="adsb-form"/);
        assert.doesNotMatch(r.modal(), /id="boost-form"/);
        assert.equal(r.B.state.post.id, 'p1');
        assert.deepEqual(plain(r.B.state.platforms), ['instagram', 'facebook']);

        // The module is not loaded and cannot be: the old form is gone (A5), so Boost says it failed rather than doing nothing.
        const f = load('en', []);
        f.posts.posts = [post()];
        f.posts.ads.settings = SETTINGS;
        f.h.ctx.App.loadPageModule = async () => null;
        const toasts: string[] = [];
        f.h.UI.toast = (message: string) => { toasts.push(message); };
        await f.posts.boostOpen('p1');
        assert.doesNotMatch(String(f.modal() ?? ''), /id="boost-form"/);
        assert.deepEqual(toasts, [f.h.t('error.unexpected')]);
    });

    it('loads the module on demand through the page registry, like ice_breakers', async () => {
        const f = load('en', []);
        f.posts.posts = [post()];
        f.posts.ads.settings = SETTINGS;
        const asked: string[] = [];
        f.h.ctx.App.loadPageModule = async (name: string) => { asked.push(name); f.h.evalFile('dashboard/js/pages/ads_builder.js'); return f.h.run('AdsBuilder'); };
        await f.posts.boostOpen('p1');
        assert.deepEqual(asked, ['ads_builder']);
        assert.match(f.modal(), /id="adsb-form"/);
        const registry = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(registry, /ads_builder: \{ src: 'ads_builder', page: \(\) => AdsBuilder, routable: false \}/);
    });
});

// ─── The live policy check ─────────────────────────────────────────────────────────────────────

describe('typing is checked after a pause, and the findings are drawn on the text', () => {
    it('waits 400 ms: nothing is asked on a keystroke, one question is asked once the typing stops', async () => {
        const r = load();
        assert.equal(r.B.POLICY_DEBOUNCE_MS, 15, 'the suite shortens the pause; the shipped one is checked next');
        const shipped = readFileSync('dashboard/js/pages/ads_builder.js', 'utf8');
        assert.match(shipped, /POLICY_DEBOUNCE_MS: 400/);
        open(r);
        await settle();
        const before = policyCalls(r).length; // the caption and the default greeting are checked as the dialog opens
        assert.equal(before, 1);
        typeGreeting(r, 'E');
        typeGreeting(r, 'Ea');
        typeGreeting(r, 'Earn');
        assert.equal(policyCalls(r).length, before, 'no call per keystroke');
        await sleep(60);
        await settle();
        assert.equal(policyCalls(r).length, before + 1, 'one call for the burst');
        assert.equal(policyCalls(r).at(-1)!.args[0].greeting, 'Earn');
    });

    it('sends the caption, the greeting and the filled ice breakers as named fields', async () => {
        const r = load();
        open(r);
        r.act('iceAdd');
        r.act('iceAdd');
        r.act('iceField', { dataset: { index: '0', part: 'title' }, value: 'How much is it?' });
        r.act('iceField', { dataset: { index: '0', part: 'response' }, value: 'It is free to start.' });
        await sleep(60);
        await settle();
        assert.deepEqual(policyCalls(r).at(-1)!.args[0], {
            caption: 'Learn Go step by step', greeting: 'Hi! How can we help?',
            'iceBreakers.0.title': 'How much is it?', 'iceBreakers.0.response': 'It is free to start.',
        }, 'the empty second row is not sent');
    });

    it('draws a block with the matched span in <mark>, escaped, with the explanation and the rewrite', async () => {
        const r = load();
        r.answers.policy = async () => ({
            version: 1, blocked: true,
            findings: [finding({ field: 'greeting', start: 4, end: 20, match: '<b>Earn $500</b>' })],
        });
        open(r);
        typeGreeting(r, 'Hey <b>Earn $500</b> a day');
        await sleep(60);
        await settle();
        const panel = String(r.el('adsb-policy').innerHTML);
        assert.match(panel, /<mark[^>]*>&lt;b&gt;Earn \$500&lt;\/b&gt;<\/mark>/, 'the span, escaped, inside mark');
        assert.doesNotMatch(panel, /<b>Earn/, 'user text is never markup');
        assert.match(panel, /data-severity="block"/);
        assert.match(panel, /data-rule="income_figure"/);
        const said = text(panel);
        assert.ok(said.includes('Meta rejects ads that promise an amount of income.'), said);
        assert.ok(said.includes('Learn a skill step by step with hands-on projects.'), said);
        assert.ok(said.includes('Greeting'), 'the field the text is in is named');
    });

    it('tells a warning from a block, and says the explanation and the rewrite in Arabic in the Arabic interface', async () => {
        const r = load('ar');
        r.answers.policy = async () => ({
            version: 1, blocked: false,
            findings: [finding({ ruleId: 'certificate', severity: 'warn', field: 'caption', start: 0, end: 13, match: 'Learn Go step' })],
        });
        open(r);
        await settle();
        const panel = String(r.el('adsb-policy').innerHTML);
        assert.match(panel, /data-severity="warn"/);
        assert.doesNotMatch(panel, /data-severity="block"/);
        assert.match(panel, /<mark[^>]*>Learn Go step<\/mark>/, 'the caption span is marked');
        const said = text(panel);
        assert.ok(said.includes('تمنع ميتا ذكر مبالغ الدخل.'), said);
        assert.ok(said.includes('تعلّم مهارة خطوة بخطوة بمشاريع عملية.'), said);
        assert.ok(said.includes(r.h.t('adsBuilder.policy.warnBadge')));
        assert.doesNotMatch(said, /Meta rejects/);
    });

    it('a finding whose text moved on (the offsets no longer fit) still shows what matched, never the wrong span', async () => {
        const r = load();
        r.answers.policy = async () => ({ version: 1, blocked: true, findings: [finding({ field: 'greeting', start: 0, end: 5, match: 'zzzzz' })] });
        open(r);
        await settle();
        const panel = String(r.el('adsb-policy').innerHTML);
        assert.match(panel, /<mark[^>]*>zzzzz<\/mark>/);
        assert.doesNotMatch(panel, /<mark[^>]*>Hi! H/);
    });

    it('is a polite live region, and the help link to the policy article sits in the panel', () => {
        const r = load();
        open(r);
        const m = r.modal();
        assert.match(m, /id="adsb-policy"[^>]*role="status"[^>]*aria-live="polite"|id="adsb-policy"[^>]*aria-live="polite"[^>]*role="status"/);
        assert.match(m, /href="#\/help\/ads#policy-check"/);
        assert.match(m, /href="#\/help\/ads#create-message-ad"/);
        assert.match(readFileSync('dashboard/js/pages/ads_builder.js', 'utf8'), /UI\.helpLink\(\s*'ads#policy-check'/);
        assert.match(readFileSync('dashboard/js/pages/ads_builder.js', 'utf8'), /UI\.helpLink\(\s*'ads#create-message-ad'/);
    });

    it('a slow answer for an older text never replaces the answer for the newer one', async () => {
        const r = load();
        const waits: Array<(v: Json) => void> = [];
        r.answers.policy = (fields: Json) => new Promise((resolve) => { waits.push((v) => resolve(v)); void fields; });
        open(r); // call 1: the dialog opening
        typeGreeting(r, 'second');
        await sleep(60);
        await settle(); // call 2
        assert.equal(waits.length, 2);
        waits[1]!({ version: 1, blocked: false, findings: [] });
        await settle();
        waits[0]!({ version: 1, blocked: true, findings: [finding({ field: 'caption', start: 0, end: 5, match: 'Learn' })] });
        await settle();
        assert.equal(r.B.state.policy.blocked, false, 'the late old answer is dropped');
    });
});


// ─── Review ────────────────────────────────────────────────────────────────────────────────────

/** Fill the form the way the owner would, then press Review and let the answer land. */
async function review(r: Rig): Promise<Json> {
    r.act('review');
    await settle();
    return r.calls.filter((c) => c.method === 'validate').at(-1)?.args[0];
}
const createdSpec = (r: Rig): Json => r.calls.filter((c) => c.method === 'create').at(-1);

describe('Review sends the spec the form describes and shows what the server found', () => {
    it('validateAdsDraft gets a CampaignSpec: goal messages, destinations, an ad-set lifetime budget (daily × days), countries, the post and the message', async () => {
        const r = load();
        open(r);
        field(r, 'daily', '5');
        field(r, 'days', '4');
        field(r, 'countries', 'sa, ae');
        typeGreeting(r, 'Welcome!');
        r.act('dest', { value: 'messenger', checked: true });
        r.act('iceAdd');
        r.act('iceAdd');
        r.act('iceField', { dataset: { index: '0', part: 'title' }, value: 'Prices?' });
        r.act('iceField', { dataset: { index: '0', part: 'response' }, value: '  ' });
        const spec = await review(r);
        assert.equal(spec.goal, 'messages');
        assert.deepEqual(spec.destinations, ['instagram', 'messenger']);
        assert.equal(spec.specialCategory, 'none');
        assert.equal(spec.budget.home, 'adset');
        assert.equal(spec.budget.kind, 'lifetime');
        assert.equal(spec.budget.amount, 20, 'daily × days, in major units');
        assert.ok(!Number.isNaN(Date.parse(spec.budget.start)) && !Number.isNaN(Date.parse(spec.budget.end)));
        assert.equal(Date.parse(spec.budget.end) - Date.parse(spec.budget.start), 4 * 24 * 3600 * 1000, 'four days long');
        assert.equal(spec.adsets.length, 1);
        assert.deepEqual(spec.adsets[0].targeting.countries, ['SA', 'AE']);
        assert.equal(spec.ads.length, 1);
        assert.equal(spec.ads[0].adsetIndex, 0);
        assert.deepEqual(spec.ads[0].creative, { source: 'post', postId: 'p1', platform: 'instagram' });
        assert.deepEqual(spec.ads[0].message, { greeting: 'Welcome!', iceBreakers: [{ title: 'Prices?' }] }, 'the blank row and the blank reply are left out');
        assert.equal(spec.ads[0].copy.primaryText, 'Learn Go step by step');
        assert.ok(String(spec.name).length > 0 && String(spec.adsets[0].name).length > 0 && String(spec.ads[0].name).length > 0, 'every object is named');
    });

    it('the other goals carry no message and no destinations; traffic carries the https link', async () => {
        const r = load();
        open(r);
        field(r, 'goal', 'engagement');
        let spec = await review(r);
        assert.equal(spec.goal, 'engagement');
        assert.equal(spec.destinations, undefined);
        assert.equal(spec.ads[0].message, undefined);
        field(r, 'goal', 'traffic');
        field(r, 'link', 'https://example.com/go');
        spec = await review(r);
        assert.equal(spec.goal, 'traffic');
        assert.deepEqual(spec.ads[0].link, { url: 'https://example.com/go' });
        assert.equal(spec.ads[0].message, undefined);
    });

    it('shows the money check with what is left, Meta\'s minimum budget, and no problems when there are none', async () => {
        const r = load();
        open(r);
        await review(r);
        const panel = String(r.el('adsb-review').innerHTML);
        const said = text(panel);
        assert.match(panel, /data-adsb="money"[^>]*data-fits="true"/);
        assert.ok(said.includes('Within your monthly limit') && said.includes('400'), said);
        assert.match(panel, /data-adsb="minimum"/);
        assert.ok(said.includes('Meta') && said.includes('minimum') && said.includes('1 USD'), said);
        assert.doesNotMatch(panel, /data-adsb="problem"/);
    });

    it('says plainly when the money does not fit, when Meta refuses, and lists the problems and the warnings; Create stays off', async () => {
        const r = load();
        r.answers.validate = async () => ({
            ...OK_REVIEW(),
            money: { fits: false, remaining: 3, reason: 'OVER_MONTHLY_CAP', currency: 'USD' },
            meta: { ok: false, error: 'Invalid parameter', minimumBudget: 2.5 },
            problems: [{ field: 'ads.0.creative', code: 'UNSUPPORTED', message: 'A Facebook post cannot be used here.' }],
            warnings: [{ code: 'UNTRACKED_LINK', field: 'ads.0.link', message: 'Clicks on this link will not be counted.' }],
        });
        open(r);
        await review(r);
        const panel = String(r.el('adsb-review').innerHTML);
        const said = text(panel);
        assert.match(panel, /data-adsb="money"[^>]*data-fits="false"/);
        assert.ok(said.includes('Over your monthly limit'), said);
        assert.ok(said.includes('Invalid parameter'), said);
        assert.ok(said.includes('2.5 USD'), said);
        assert.match(panel, /data-adsb="problem"/);
        assert.ok(said.includes('A Facebook post cannot be used here.'), said);
        assert.match(panel, /data-adsb="warning"/);
        assert.ok(said.includes('Clicks on this link will not be counted.'), said);
        assert.equal(r.el('adsb-create').disabled, true);
    });

    it('does not ask the server when the form itself is wrong, and says which field', async () => {
        const cases: Array<[string, () => void, string]> = [
            ['no budget', () => field(r0, 'daily', ''), 'adsb-daily'],
            ['over the owner\'s daily ceiling', () => field(r0, 'daily', '51'), 'adsb-daily'],
            ['days out of range', () => field(r0, 'days', '31'), 'adsb-days'],
            ['a country that is not a code', () => field(r0, 'countries', 'Saudi'), 'adsb-countries'],
            ['no greeting', () => typeGreeting(r0, '   '), 'adsb-greeting'],
            ['greeting too long', () => typeGreeting(r0, 'x'.repeat(301)), 'adsb-greeting'],
            ['no destination', () => { r0.act('dest', { value: 'instagram', checked: false }); }, 'adsb-dest-instagram'],
            ['a question over 80 characters', () => { r0.act('iceAdd'); r0.act('iceField', { dataset: { index: '0', part: 'title' }, value: 'q'.repeat(81) }); }, 'adsb-ice-title-0'],
        ];
        let r0 = load();
        for (const [name, apply, id] of cases) {
            r0 = load();
            open(r0);
            apply();
            r0.act('review');
            await settle();
            assert.equal(r0.calls.filter((c) => c.method === 'validate').length, 0, `${name}: no request`);
            assert.match(String(r0.el('adsb-error').innerHTML), /role="alert"/, name);
            assert.equal(r0.el(id).attrs.get('aria-invalid'), 'true', `${name}: ${id} is marked`);
        }
    });

    it('a reason that came from the server, with markup in it, is text', async () => {
        const r = load();
        r.answers.validate = async () => ({ ...OK_REVIEW(), problems: [{ field: 'x', code: 'INVALID', message: '<img src=x onerror=alert(1)>' }] });
        open(r);
        await review(r);
        const panel = String(r.el('adsb-review').innerHTML);
        assert.doesNotMatch(panel, /<img/);
        assert.match(panel, /&lt;img src=x/);
    });

    it('a failed Review says why in the server\'s own words and leaves the form as it was', async () => {
        const r = load();
        r.answers.validate = async () => { throw Object.assign(new Error('Meta is slow, try again'), { code: 'RATE_LIMITED' }); };
        open(r);
        field(r, 'daily', '7');
        r.act('review');
        await settle();
        assert.ok(text(r.el('adsb-error').innerHTML).includes('Meta is slow, try again'));
        assert.equal(r.B.state.daily, '7');
        assert.equal(r.el('adsb-create').disabled, true);
    });

    it('Create is off until a clean Review, and any change after it asks for another Review', async () => {
        const r = load();
        open(r);
        assert.match(r.modal(), /id="adsb-create"[^>]*disabled|disabled[^>]*id="adsb-create"/, 'off before any Review');
        await review(r);
        assert.equal(r.el('adsb-create').disabled, false, 'on after a clean Review');
        field(r, 'daily', '9');
        assert.equal(r.B.state.review, null, 'the Review no longer describes the form');
        assert.equal(r.el('adsb-create').disabled, true);
        assert.equal(String(r.el('adsb-review').innerHTML), '', 'the old answer is not left on screen');
        r.act('create');
        await settle();
        assert.equal(r.calls.filter((c) => c.method === 'create').length, 0, 'a stale form is never sent');
    });
});

// ─── The assistant behind the destination ──────────────────────────────────────────────────────

describe('the bot-off warning', () => {
    const bots = (state: string): Json => async () => ({ ...OK_REVIEW(), bots: [{ destination: 'instagram', state }] });

    it('off: a visible warning that names the destination and says what will happen, with the way to the settings', async () => {
        const r = load();
        r.answers.validate = bots('off');
        open(r);
        await review(r);
        const panel = String(r.el('adsb-review').innerHTML);
        assert.match(panel, /data-adsb="bot"[^>]*data-bot="instagram"[^>]*data-bot-state="off"|data-bot-state="off"[^>]*data-bot="instagram"/);
        const said = text(panel);
        assert.ok(said.includes('The assistant is off on Instagram'), said);
        assert.ok(said.includes('nobody will answer'), said);
        assert.match(panel, /href="#\/ai_settings"/, 'Instagram and Messenger answer from the DM assistant');
    });

    it('test mode is a different warning, not the same words', async () => {
        const r = load();
        r.answers.validate = bots('test');
        open(r);
        await review(r);
        const panel = String(r.el('adsb-review').innerHTML);
        assert.match(panel, /data-bot-state="test"/);
        const said = text(panel);
        assert.ok(said.includes('test mode') && said.includes('Instagram'), said);
        assert.ok(!said.includes('nobody will answer'), said);
    });

    it('sales in test: the assistant answers, and the warning says it sells only to the testers', async () => {
        const r = load();
        r.answers.validate = bots('sales_test');
        open(r);
        await review(r);
        const panel = String(r.el('adsb-review').innerHTML);
        assert.match(panel, /data-bot-state="sales_test"/);
        assert.ok(text(panel).includes('sells only to your testers'), text(panel));
        assert.equal(r.B.needsAck(r.B.state), true, 'it must be read before Create');
    });

    it('a destination that is not connected says that, and WhatsApp points to the WhatsApp settings', async () => {
        const r = load();
        r.answers.validate = async () => ({ ...OK_REVIEW(), bots: [{ destination: 'whatsapp', state: 'not_connected' }] });
        open(r);
        await review(r);
        const panel = String(r.el('adsb-review').innerHTML);
        assert.match(panel, /data-bot-state="not_connected"/);
        assert.ok(text(panel).includes('WhatsApp is not connected'), text(panel));
        assert.match(panel, /href="#\/settings\?s=whatsapp"/);
    });

    it('on: no warning at all', async () => {
        const r = load();
        r.answers.validate = bots('on');
        open(r);
        await review(r);
        const panel = String(r.el('adsb-review').innerHTML);
        assert.doesNotMatch(panel, /data-adsb="bot"/);
        assert.doesNotMatch(panel, /data-bot-state/);
        assert.equal(r.el('adsb-create').disabled, false, 'and nothing to tick');
    });

    it('says it in Arabic in the Arabic interface', async () => {
        const r = load('ar');
        r.answers.validate = bots('off');
        open(r);
        await review(r);
        const said = text(r.el('adsb-review').innerHTML);
        assert.ok(said.includes(r.h.t('adsBuilder.bot.off', { destination: r.h.t('adsBuilder.dest.instagram') })), said);
        assert.ok(said.includes('إنستغرام'), said);
    });
});

// ─── Warnings, Create and its refusals ─────────────────────────────────────────────────────────

describe('warnings only: the tick, then Create', () => {
    const warnOnly = async (): Promise<Json> => ({
        ...OK_REVIEW(),
        policy: { blocked: false, findings: [finding({ ruleId: 'certificate', severity: 'warn', field: 'caption', start: 6, end: 8, match: 'Go' })] },
    });

    it('needs "I have read the warnings" before Create, and Create then sends confirmPolicyWarnings: true', async () => {
        const r = load();
        r.answers.validate = warnOnly;
        open(r);
        await review(r);
        assert.match(String(r.el('adsb-review').innerHTML), /id="adsb-ack"/);
        assert.ok(text(r.el('adsb-review').innerHTML).includes('I have read the warnings'));
        assert.equal(r.el('adsb-create').disabled, true, 'off until it is ticked');
        r.act('create');
        await settle();
        assert.equal(r.calls.filter((c) => c.method === 'create').length, 0, 'not sent without the tick');
        r.act('ack', { checked: true });
        assert.equal(r.el('adsb-create').disabled, false);
        r.act('create');
        await settle();
        const sent = createdSpec(r);
        assert.ok(sent, 'createAdsDraft was called');
        assert.equal(sent.args[1], true);
        assert.equal(sent.args[0].goal, 'messages');
    });

    it('un-ticking turns Create off again', async () => {
        const r = load();
        r.answers.validate = warnOnly;
        open(r);
        await review(r);
        r.act('ack', { checked: true });
        r.act('ack', { checked: false });
        assert.equal(r.el('adsb-create').disabled, true);
    });

    it('with nothing to read there is no tick, and Create sends confirmPolicyWarnings: false', async () => {
        const r = load();
        open(r);
        await review(r);
        assert.doesNotMatch(String(r.el('adsb-review').innerHTML), /id="adsb-ack"/);
        r.act('create');
        await settle();
        assert.equal(createdSpec(r).args[1], false);
    });
});

describe('Create', () => {
    it('is off while the text is blocked, whatever else is true, and never sends', async () => {
        const r = load();
        r.answers.validate = async () => ({ ...OK_REVIEW(), policy: { blocked: true, findings: [finding({ field: 'greeting', start: 0, end: 3, match: 'Hi!' })] } });
        open(r);
        await review(r);
        assert.equal(r.el('adsb-create').disabled, true);
        assert.match(String(r.el('adsb-policy').innerHTML), /data-severity="block"/, 'the Review\'s findings are the ones on screen');
        r.act('create');
        await settle();
        assert.equal(r.calls.filter((c) => c.method === 'create').length, 0);
    });

    it('is off as soon as the live check says the text is blocked, even if a Review had been clean', async () => {
        const r = load();
        open(r);
        await review(r);
        r.answers.policy = async () => ({ version: 1, blocked: true, findings: [finding()] });
        typeGreeting(r, 'Earn $500 a day');
        await sleep(60);
        await settle();
        assert.equal(r.B.state.policy.blocked, true);
        assert.equal(r.el('adsb-create').disabled, true);
        assert.ok(text(r.el('adsb-policy').innerHTML).includes('Fix the highlighted text'), text(r.el('adsb-policy').innerHTML));
    });

    it('creates the draft and says it is PAUSED, that nothing is spent until Activate, with a link to #/ads; the page is told', async () => {
        const r = load();
        r.answers.create = async () => ({ campaignId: 'c1', ops: [{ id: 'o1' }] });
        open(r);
        await review(r);
        r.act('create');
        await settle();
        const sent = createdSpec(r);
        assert.deepEqual(plain(sent.args[0]), plain(r.calls.filter((c) => c.method === 'validate').at(-1)!.args[0]), 'what was reviewed is what is created');
        const m = r.modal();
        assert.ok(/paused/i.test(text(m)), text(m));
        assert.ok(text(m).includes('Nothing is spent until you Activate'), text(m));
        assert.match(m, /href="#\/ads"/);
        assert.equal(r.created.length, 1);
        assert.equal(r.created[0].campaignId, 'c1');
        assert.ok(r.toasts.length >= 1);
    });

    it('a second press while the first is out sends once', async () => {
        const r = load();
        let release: (v: Json) => void = () => {};
        r.answers.create = () => new Promise((resolve) => { release = resolve; });
        open(r);
        await review(r);
        r.act('create');
        r.act('create');
        await settle();
        assert.equal(r.calls.filter((c) => c.method === 'create').length, 1);
        release({ campaignId: 'c1', ops: [] });
        await settle();
        assert.ok(/paused/i.test(text(r.modal())));
    });

    it('POLICY_BLOCKED draws the findings the server sent, over the text, and keeps Create off', async () => {
        const r = load();
        r.answers.create = async () => { throw Object.assign(new Error('The text breaks Meta policy'), { code: 'POLICY_BLOCKED', status: 422, body: { code: 'POLICY_BLOCKED', findings: [finding({ field: 'greeting', start: 0, end: 12, match: 'Hi! How can ' })] } }); };
        open(r);
        await review(r);
        r.act('create');
        await settle();
        const panel = String(r.el('adsb-policy').innerHTML);
        assert.match(panel, /<mark[^>]*>Hi! How can <\/mark>/);
        assert.match(panel, /data-severity="block"/);
        assert.equal(r.el('adsb-create').disabled, true);
        assert.match(r.modal(), /id="adsb-form"/, 'the success dialog is not shown: the form stays');
    });

    it('OVER_MONTHLY_CAP is said on the budget field, which is marked and described by it', async () => {
        const r = load();
        r.answers.create = async () => { throw Object.assign(new Error('This is over your monthly cap: 3 USD left.'), { code: 'OVER_MONTHLY_CAP', status: 409, body: { code: 'OVER_MONTHLY_CAP', field: 'amount' } }); };
        open(r);
        await review(r);
        r.act('create');
        await settle();
        assert.ok(text(r.el('adsb-daily-error').innerHTML).includes('This is over your monthly cap: 3 USD left.'));
        assert.equal(r.el('adsb-daily').attrs.get('aria-invalid'), 'true');
        assert.match(r.el('adsb-daily').attrs.get('aria-describedby') ?? '', /adsb-daily-error/);
        assert.match(r.modal(), /id="adsb-form"/, 'the success dialog is not shown: the form stays');
        assert.equal(r.B.state.busy, false, 'the owner can change the budget and go again');
    });

    it('any other refusal is the server\'s sentence in the error strip', async () => {
        const r = load();
        r.answers.create = async () => { throw Object.assign(new Error('Meta said no.'), { code: 'META_ERROR', status: 502, body: { code: 'META_ERROR' } }); };
        open(r);
        await review(r);
        r.act('create');
        await settle();
        assert.ok(text(r.el('adsb-error').innerHTML).includes('Meta said no.'));
        assert.match(String(r.el('adsb-error').innerHTML), /role="alert"/);
    });
});

// ─── Escaping and the catalogues ───────────────────────────────────────────────────────────────

describe('what a person wrote is text', () => {
    it('a caption with a script in it is escaped in the dialog, the finding and the success text', async () => {
        const r = load();
        const caption = '<script>alert(1)</script> Learn Go';
        r.answers.policy = async () => ({ version: 1, blocked: true, findings: [finding({ field: 'caption', start: 0, end: 25, match: '<script>alert(1)</script>' })] });
        open(r, { caption });
        await settle();
        assert.doesNotMatch(r.modal(), /<script>alert/);
        assert.match(r.modal(), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        const panel = String(r.el('adsb-policy').innerHTML);
        assert.doesNotMatch(panel, /<script>/);
        assert.match(panel, /<mark[^>]*>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/mark>/);
    });

    it('a greeting or a question with a quote and a tag in it is escaped where it is shown again', () => {
        const r = load();
        open(r);
        r.act('iceAdd');
        r.act('iceField', { dataset: { index: '0', part: 'title' }, value: '"><img src=x>' });
        r.act('iceAdd'); // repaints the list with the first row's text in it
        assert.doesNotMatch(String(r.el('adsb-ice').innerHTML), /<img/);
        assert.match(String(r.el('adsb-ice').innerHTML), /&quot;&gt;&lt;img src=x&gt;/);
    });
});

describe('the catalogues', () => {
    const source = readFileSync('dashboard/js/pages/ads_builder.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const literals = [...new Set([...source.matchAll(/['"`](adsBuilder\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)].map((m) => m[1]!))];
    const prefixes = [...new Set([...source.matchAll(/`(adsBuilder\.[A-Za-z0-9_.]*?)\.?\$\{/g)].map((m) => m[1]!))];

    it('both catalogues carry the same adsBuilder.* keys, and every key the file uses is in both', () => {
        const ar = load('ar');
        const en = load('en');
        const mine = (h: Dashboard, lang: 'ar' | 'en'): string[] => Object.keys(h.I18N.strings[lang]).filter((k) => k.startsWith('adsBuilder.')).sort();
        const keysAr = mine(ar.h, 'ar');
        const keysEn = mine(en.h, 'en');
        assert.ok(keysEn.length > 40, `found ${keysEn.length}`);
        assert.deepEqual(keysAr, keysEn);

        const used = new Set(literals);
        const expand: Record<string, string[]> = {
            'adsBuilder.goal': en.B.GOALS, 'adsBuilder.dest': en.B.DESTINATIONS, 'adsBuilder.bot': en.B.BOT_ISSUES, 'adsBuilder.warn': en.B.WARNING_CODES,
        };
        for (const prefix of prefixes) {
            assert.ok(expand[prefix], `${prefix}.\${…} is built at run time: name its values in the module so this suite can check them`);
            for (const v of expand[prefix]!) used.add(`${prefix}.${v}`);
        }
        for (const lang of ['ar', 'en'] as const) {
            const dict = (lang === 'ar' ? ar : en).h.I18N.strings[lang] as Record<string, string>;
            const plural = (key: string): boolean => key in dict || ['one', 'two', 'few', 'many', 'other', 'zero'].some((s) => `${key}_${s}` in dict);
            const missing = [...used].filter((k) => !plural(k));
            assert.deepEqual(missing, [], `${lang} lacks`);
        }
        const unused = keysEn.filter((k) => !used.has(k) && ![...used].some((u) => k.startsWith(`${u}_`)));
        assert.deepEqual(unused, [], 'a catalogue key no code reads');
    });

    it('the Arabic is not the English, key for key (a copy-paste is a missing translation)', () => {
        const ar = load('ar');
        const en = load('en');
        const same = Object.keys(en.h.I18N.strings.en).filter((k) => k.startsWith('adsBuilder.'))
            .filter((k) => en.h.I18N.strings.en[k] === ar.h.I18N.strings.ar[k] && /[A-Za-z]{4}/.test(en.h.I18N.strings.en[k].replace(/\{[a-z]+\}/g, '')));
        assert.deepEqual(same, []);
    });
});

// ─── What is left of the month's cap ───────────────────────────────────────────────────────────

describe('the summary reads the month from GET /ads/money, not from the settings', () => {
    it('asks once when the dialog opens, then works out "over" live from `remaining`', async () => {
        const r = load();
        r.posts.posts = [post()];
        r.posts.ads.settings = SETTINGS;
        await r.posts.boostOpen('p1');
        await settle();
        assert.deepEqual(r.calls.filter((c) => c.method === 'money').map((c) => c.args), [[null]]);
        assert.match(text(r.el('adsb-summary').innerHTML), /Left of this month's limit: 400 USD of 500 USD/);
        r.act('field', { dataset: { field: 'daily' }, value: '50' });
        r.act('field', { dataset: { field: 'days' }, value: '9' });
        assert.match(text(r.el('adsb-summary').innerHTML), /This is more than what is left/);
        assert.equal(r.calls.filter((c) => c.method === 'money').length, 1, 'never per keystroke');
    });

    it('says so when the month could not be read, instead of guessing', async () => {
        const r = load();
        r.answers.money = async () => { throw new Error('down'); };
        r.posts.posts = [post()];
        r.posts.ads.settings = SETTINGS;
        await r.posts.boostOpen('p1');
        await settle();
        assert.match(text(r.el('adsb-summary').innerHTML), /could not be read now/);
    });
});
