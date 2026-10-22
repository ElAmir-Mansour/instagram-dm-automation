/**
 * Ads → Create, the full builder (Meta Ads Manager A5, task T105), loaded like the other dashboard suites: the REAL shipped files
 * (`ads_create.js`, `ads_builder.js` for the findings, `ads_campaigns.js` for the tab bar, both catalogues) in a `node:vm` context
 * through `_harness.ts`, with the API stubbed. No network, no Meta. What is pinned:
 *
 *   - the eight steps, in order, and the Create tab next to Overview and Campaigns;
 *   - only what is valid for a goal is offered: messages has destinations and a greeting, traffic a tracked offer link (a free address
 *     warned) and a button, engagement and reach a published post and nothing to upload; leads is shown, locked;
 *   - Advantage audience: no maximum age, and a minimum over 25 refused; a special category narrows targeting;
 *   - placements never offer Instagram Explore or Messenger Stories;
 *   - the CampaignSpec is the contract's: a total budget carries its end, a schedule only with a total budget, the 9:16 version and the
 *     covers by media id;
 *   - an upload is signed, PUT with progress, and handed to Meta; a video waits for its cover;
 *   - Review shows the money, Meta's check, the reach estimate and a preview per placement: Meta's iframe only from www.facebook.com,
 *     else the approximate mock with the text cut at 125 characters; Create is off until all of it is clean;
 *   - every `adsCreate.*` key, including the ones built from a value, is in both catalogues.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦-⁩]/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));

const SETTINGS = { configured: true, adAccountId: '1', limits: { maxDailyBudget: 50, monthlyCap: 500 }, account: { name: 'Main', currency: 'USD', minDailyBudget: 1 } };
const POSTS = [
    { id: 'p1', status: 'PUBLISHED', caption: 'Learn Go step by step', published_post_id: 'FB:99 | IG:178' },
    { id: 'p2', status: 'PUBLISHED', caption: 'Facebook only', published_post_id: 'FB:55' },
    { id: 'p3', status: 'SCHEDULED', caption: 'Not yet', published_post_id: null },
];

interface Rig {
    h: Dashboard;
    P: Json;
    calls: Array<{ method: string; args: Json[] }>;
    answers: Json;
    act(name: string, init?: Json): Json;
    page(): string;
    step(): string;
}

function load(lang: 'ar' | 'en' = 'en'): Rig {
    const calls: Rig['calls'] = [];
    const answers: Json = {
        validate: async () => ({
            policy: { blocked: false, findings: [] }, money: { fits: true, remaining: 400, currency: 'USD' }, meta: { ok: true, minimumBudget: 1 },
            problems: [], warnings: [], bots: [], estimate: { lower: 120000, upper: 340000 },
            previews: [
                { placement: 'instagram_feed', frame: '4:5', html: '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=1&amp;t=2" width="320"></iframe>' },
                { placement: 'instagram_reels', frame: '9:16', html: null, reason: 'no_preview_access' },
            ],
        }),
    };
    const record = (method: string, answer: (...a: Json[]) => Json) => (...args: Json[]) => { calls.push({ method, args: plain(args) }); return answer(...args); };
    const api: Json = {
        token: 'tok',
        getAdsSettings: record('settings', async () => SETTINGS),
        getAdsMinimumBudgets: record('minimum', async () => ({ currency: 'USD', byGoal: { messages: 1, engagement: 1, reach: 1, traffic: 1 } })),
        getProfile: record('profile', async () => ({ profile: { offers: [{ id: 'o1', name: 'Go class', url: 'https://learn.example.com/go' }] } })),
        getScheduledPosts: record('posts', async () => POSTS),
        getAdsMoney: record('money', async () => ({ currency: 'USD', fits: true, remaining: 400, monthlyCap: 500, maxDailyBudget: 50 })),
        checkAdsPolicy: record('policy', async () => ({ blocked: false, findings: [] })),
        validateAdsDraft: record('validate', (spec: Json) => answers.validate(spec)),
        createAdsDraft: record('create', async () => ({ campaignId: 'c1', ops: [] })),
        searchAdsTargeting: record('search', async () => ({ items: [{ id: '2430536', name: 'Riyadh', type: 'adgeolocation', region: 'Riyadh Region' }] })),
        signAdsUpload: record('sign', async () => ({ mediaId: 'm-main', url: 'https://app/api/uploads/m-main', upload: { method: 'PUT', url: 'https://x.supabase.co/storage/v1/object/upload/sign/media/a?token=t', headers: { 'content-type': 'video/mp4' } } })),
        prepareAdsMedia: record('prepare', async (body: Json) => ({ media: { mediaId: body.mediaId, kind: body.kind } })),
    };
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/ads_builder.js', 'dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_create.js'], globals: { API: api, App: { canOperate: () => true, canAdminister: () => true } } });
    h.document.getElementById = (id: string) => h.el(id);
    h.el('page-container', {});
    h.UI.toast = () => null;
    const P = h.run('AdsCreatePage');
    let n = 0;
    return {
        h, P, calls, answers,
        act: (name, init = {}) => h.UI._actions.adsc[name](h.el(`fake-${++n}`, init), { preventDefault() {}, stopPropagation() {} }),
        page: () => String(h.el('page-container').innerHTML),
        step: () => String(h.el('adsc-step').innerHTML),
    };
}

async function ready(lang: 'ar' | 'en' = 'en'): Promise<Rig> {
    const r = load(lang);
    await r.P.render();
    await settle();
    return r;
}

const field = (r: Rig, name: string, value: string): Json => r.act('field', { dataset: { field: name }, value });

/** Fill a traffic campaign up to the review: a post, EG and SA, automatic placements, a 5-day total budget. */
function trafficToReview(r: Rig): void {
    field(r, 'name', 'Go launch');
    r.act('next');                       // → destination (the first offer is chosen)
    r.act('next');                       // → creative
    field(r, 'source', 'post');
    field(r, 'postId', 'p1');
    r.act('next');                       // → copy
    r.act('next');                       // → audience
    r.act('next');                       // → placements
    r.act('next');                       // → budget
    field(r, 'amount', '25');
    r.act('next');                       // → review
}

describe('Ads → Create: the steps and the tab', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`the shell's title and subtitle for the page are real strings, not keys (${lang})`, async () => {
            const r = await ready(lang);
            assert.notEqual(r.h.t('nav.ads_create'), 'nav.ads_create');
            assert.notEqual(r.h.t('page.ads_create.subtitle'), 'page.ads_create.subtitle');
        });
    }

    it('has the eight steps in order, and the Create tab beside Overview and Campaigns', async () => {
        const r = await ready();
        assert.deepEqual(plain(r.P.STEPS), ['goal', 'destination', 'creative', 'copy', 'audience', 'placements', 'budget', 'review']);
        const page = r.page();
        for (const key of r.P.STEPS) assert.match(page, new RegExp(`data-step="${key}"`), key);
        assert.match(page, /href="#\/ads_create"[^>]*aria-current="page"/);
        assert.match(page, /href="#\/ads_campaigns"/);
        const registry = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(registry, /ads_create: \{ src: 'ads_create', page: \(\) => AdsCreatePage, navAs: 'ads' \}/);
    });

    it('says everything is created paused, and links every step to its help section', async () => {
        const r = await ready();
        assert.ok(text(r.page()).includes(r.h.t('adsCreate.pausedNote')));
        assert.match(r.page(), /href="#\/help\/ads#builder"/);
        for (const key of r.P.STEPS) assert.match(r.P.HELP[key], /^ads#(builder|creatives|targeting|budgets-and-schedule|policy-check)$/);
    });

    it('a step does not move on with what is missing, and says which field', async () => {
        const r = await ready();
        r.act('next');
        assert.equal(r.P.state.step, 0);
        assert.ok(text(r.step()).includes(r.h.t('adsCreate.err.name')));
    });
});

describe('only what is valid for the goal is offered', () => {
    it('leads is shown, locked; messages offers the three destinations and a greeting', async () => {
        const r = await ready();
        assert.match(r.page(), /id="adsc-goal-leads"[^>]*disabled/);
        field(r, 'goal', 'leads');
        assert.equal(r.P.state.goal, 'traffic', 'a locked goal cannot be chosen');
        field(r, 'goal', 'messages');
        field(r, 'name', 'x');
        r.act('next');
        for (const d of ['instagram', 'messenger', 'whatsapp']) assert.match(r.step(), new RegExp(`id="adsc-dest-${d}"`));
        r.P.state.step = 3;
        r.P.repaintStep();
        assert.match(r.step(), /id="adsc-greeting"/);
        assert.doesNotMatch(r.step(), /id="adsc-cta"/, 'a message ad carries its destination\'s button');
    });

    it('traffic offers a tracked offer link by default, a free address with a warning, and a button', async () => {
        const r = await ready();
        r.P.state.step = 1;
        r.P.repaintStep();
        assert.match(r.step(), /id="adsc-linkMode-offer"[^>]*checked/);
        assert.match(r.step(), /<option value="o1"/);
        field(r, 'linkMode', 'url');
        assert.ok(text(r.step()).includes(r.h.t('adsCreate.link.untracked')));
        r.P.state.step = 3;
        r.P.repaintStep();
        for (const cta of ['LEARN_MORE', 'SIGN_UP']) assert.match(r.step(), new RegExp(`<option value="${cta}"`));
    });

    it('engagement and reach run on a published post: nothing to upload, Facebook posts allowed', async () => {
        const r = await ready();
        field(r, 'goal', 'reach');
        r.P.state.step = 2;
        r.P.repaintStep();
        assert.doesNotMatch(r.step(), /id="adsc-file-media"/);
        assert.match(r.step(), /<option value="p2"/, 'a Facebook-only post may be used for reach');
        assert.doesNotMatch(r.step(), /<option value="p3"/, 'an unpublished post is not offered');
        field(r, 'goal', 'traffic');
        field(r, 'source', 'post');
        assert.doesNotMatch(r.step(), /<option value="p2"/, 'a link ad needs the Instagram copy');
    });

    it('placements never offer Instagram Explore or Messenger Stories', async () => {
        const r = await ready();
        r.P.state.step = 5;
        r.P.repaintStep();
        field(r, 'placementMode', 'manual');
        const s = r.step();
        assert.match(s, /id="adsc-pl-instagram-reels"/);
        assert.match(s, /id="adsc-pl-instagram-story"/);
        assert.doesNotMatch(s, /explore|messenger_stor|video_feeds/);
    });
});

describe('the audience rules', () => {
    it('Advantage audience hides the maximum age and refuses a minimum over 25', async () => {
        const r = await ready();
        r.P.state.step = 4;
        r.P.repaintStep();
        assert.equal(r.P.state.advantage, true);
        assert.doesNotMatch(r.step(), /id="adsc-age-max"/);
        field(r, 'ageMin', '30');
        r.act('next');
        assert.equal(r.P.state.step, 4);
        assert.ok(text(r.step()).includes(r.h.t('adsCreate.err.advantageAge')));
        r.act('advantage', { checked: false });
        assert.match(r.step(), /id="adsc-age-max"/);
    });

    it('a special category narrows targeting: no gender, no interests, 18+', async () => {
        const r = await ready();
        r.P.state.step = 4;
        r.P.repaintStep();
        field(r, 'gender', 'women');
        field(r, 'special', 'employment');
        assert.ok(text(r.step()).includes(r.h.t('adsCreate.special.warn')));
        assert.doesNotMatch(r.step(), /id="adsc-search-interests"/);
        assert.match(r.step(), /<option value="political"[^>]*disabled/);
        const spec = r.P.buildSpec(r.P.state);
        assert.equal(spec.specialCategory, 'employment');
        assert.equal(spec.adsets[0].targeting.ageMin, 18);
        assert.equal(spec.adsets[0].targeting.genders, undefined);
        assert.equal(spec.adsets[0].targeting.advantageAudience, false);
    });

    it('a city found by search is added with a radius', async () => {
        const r = await ready();
        r.P.SEARCH_DEBOUNCE_MS = 0;
        r.P.state.step = 4;
        r.P.repaintStep();
        r.act('search', { dataset: { type: 'adgeolocation' }, value: 'riy' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await settle();
        r.act('pick', { dataset: { kind: 'cities', index: '0' } });
        assert.deepEqual(plain(r.P.buildSpec(r.P.state).adsets[0].targeting.cities), [{ key: '2430536', radiusKm: 25 }]);
        assert.deepEqual(r.calls.filter((c) => c.method === 'search').map((c) => c.args), [['adgeolocation', 'riy']]);
    });
});

describe('the CampaignSpec', () => {
    it('carries the saved audiences the pickers chose (A8), and no exclusion under a special category', async () => {
        const r = await ready();
        const st = r.P.state;
        st.includeAudiences = ['aud-1'];
        st.excludeAudiences = ['aud-2'];
        let spec = r.P.buildSpec(st);
        assert.deepEqual(plain(spec.adsets[0].targeting.includeAudiences), ['aud-1']);
        assert.deepEqual(plain(spec.adsets[0].targeting.excludeAudiences), ['aud-2']);
        st.special = 'employment';
        spec = r.P.buildSpec(st);
        assert.equal(spec.adsets[0].targeting.excludeAudiences, undefined);
    });

    it('is the contract\'s shape: a total budget carries its end, a schedule only with a total budget', async () => {
        const r = await ready();
        const st = r.P.state;
        Object.assign(st, { name: 'Go', amount: '25', scheduled: true, days: [5, 4], fromHour: '18', toHour: '23', countries: 'eg, sa', ageMin: '22', advantage: false, ageMax: '45' });
        st.placementMode = 'manual';
        st.placements.instagram = ['reels', 'story'];
        st.locales = [{ id: '28', name: 'Arabic' }];
        st.source = 'media';
        st.media = { mediaId: 'm1', kind: 'video', status: 'processing' };
        st.cover = { mediaId: 'c1', kind: 'image', status: 'ready' };
        st.wantVertical = true;
        st.vertical = { mediaId: 'm9', kind: 'video', status: 'processing' };
        st.primaryText = 'تعلّم Go';
        const spec = r.P.buildSpec(st);
        assert.equal(spec.goal, 'traffic');
        assert.deepEqual(plain(spec.ads[0].link), { trackedOfferId: 'o1' });
        assert.deepEqual(plain(spec.ads[0].creative), { source: 'media', mediaId: 'm1', coverMediaId: 'c1', verticalMediaId: 'm9' });
        assert.equal(spec.budget.kind, 'lifetime');
        assert.ok(spec.budget.end, 'a total budget carries its end');
        assert.deepEqual(plain(spec.adsets[0].schedule), [{ days: [4, 5], startHour: 18, endHour: 23 }]);
        assert.deepEqual(plain(spec.adsets[0].targeting), { countries: ['EG', 'SA'], ageMin: 22, advantageAudience: false, ageMax: 45, locales: [28] });
        assert.deepEqual(plain(spec.adsets[0].placements), { instagram: ['reels', 'story'] });
        field(r, 'kind', 'daily');
        assert.equal(r.P.buildSpec(r.P.state).adsets[0].schedule, undefined, 'a daily budget has no schedule');
    });
});

describe('uploads', () => {
    it('signs, PUTs with progress, and hands an image to Meta; a video waits for its cover', async () => {
        const r = await ready();
        const puts: Json[] = [];
        r.P.put = async (upload: Json, file: Json, onProgress: (n: number) => void) => { puts.push({ url: upload.url, name: file.name }); onProgress(50); onProgress(100); };
        r.P.state.step = 2;
        r.P.repaintStep();
        await r.act('file', { dataset: { slot: 'media' }, files: [{ name: 'reel.mp4', type: 'video/mp4', size: 12 * 1024 * 1024 }] });
        assert.deepEqual(r.calls.filter((c) => c.method === 'sign').map((c) => c.args[0]), [{ filename: 'reel.mp4', mime: 'video/mp4', size: 12 * 1024 * 1024 }]);
        assert.equal(puts.length, 1);
        assert.equal(r.calls.filter((c) => c.method === 'prepare').length, 0, 'a video waits for its cover');
        assert.match(r.step(), /id="adsc-file-cover"/);
        await r.act('file', { dataset: { slot: 'cover' }, files: [{ name: 'cover.jpg', type: 'image/jpeg', size: 200_000 }] });
        assert.deepEqual(r.calls.filter((c) => c.method === 'prepare').map((c) => c.args[0]), [{ mediaId: 'm-main', kind: 'video', coverMediaId: 'm-main' }]);
    });

    it('refuses a file the ads cannot take before signing anything', async () => {
        const r = await ready();
        r.P.state.step = 2;
        r.P.repaintStep();
        await r.act('file', { dataset: { slot: 'media' }, files: [{ name: 'big.mp4', type: 'video/mp4', size: 51 * 1024 * 1024 }] });
        await r.act('file', { dataset: { slot: 'media' }, files: [{ name: 'a.gif', type: 'image/gif', size: 1000 }] });
        assert.equal(r.calls.filter((c) => c.method === 'sign').length, 0);
        assert.ok(text(r.step()).includes(r.h.t('adsCreate.upload.badType')));
    });
});

describe('review and create', () => {
    it('shows money, Meta\'s check, the reach estimate, Meta\'s iframe from www.facebook.com and the approximate mock', async () => {
        const r = await ready();
        trafficToReview(r);
        await settle();
        const s = r.step();
        assert.equal(r.calls.filter((c) => c.method === 'validate').length, 1);
        assert.match(s, /data-adsc="money"[^>]*data-fits="true"/);
        assert.match(s, /data-adsc="meta-ok"/);
        assert.ok(text(s).includes(r.h.t('adsCreate.review.estimate', { lower: '120,000', upper: '340,000' })), text(s));
        assert.match(s, /<iframe[^>]*src="https:\/\/www\.facebook\.com\/ads\/api\/preview_iframe\.php\?d=1&amp;t=2"/);
        assert.match(s, /data-placement="instagram_reels"[\s\S]*data-mock="true"/);
        assert.ok(text(s).includes(r.h.t('adsCreate.preview.approximate')));
        assert.equal(r.P.canCreate(r.P.state), true);
    });

    it('never frames anything but Meta\'s own preview page', async () => {
        const r = await ready();
        assert.equal(r.P.previewSrc('<iframe src="https://evil.example/x"></iframe>'), null);
        assert.equal(r.P.previewSrc('<iframe src="https://www.facebook.com.evil.example/x"></iframe>'), null);
        assert.equal(r.P.previewSrc('<script>alert(1)</script>'), null);
    });

    it('the mock cuts the text at 125 characters with "more", and draws no picture of a person', async () => {
        const r = await ready();
        const st = r.P.state;
        st.source = 'media';
        st.primaryText = `${'word '.repeat(40)}end`;
        const mock = String(r.P.mockPreview(st, '4:5'));
        assert.match(mock, /data-cut="true"/);
        assert.ok(text(mock).includes(r.h.t('adsCreate.preview.more')));
        const shown = /<p class="adsc-mock-text"[^>]*>([^<]*)</.exec(String(mock))![1]!;
        assert.ok(shown.length <= 125, `${shown.length}`);
        assert.match(mock, /class="adsc-mock-avatar"[^>]*>M</, 'the avatar is the Page\'s initial');
    });

    it('Create is off while blocked, while Meta refuses, or until warnings are read; then it sends what was reviewed', async () => {
        const r = await ready();
        r.answers.validate = async () => ({
            policy: { blocked: false, findings: [{ ruleId: 'x', severity: 'warn', field: 'primaryText', match: 'job', explain: { en: 'Could read as a job ad.' } }] },
            money: { fits: true, remaining: 400 }, meta: { ok: true, minimumBudget: 1 }, problems: [], warnings: [], bots: [], estimate: null, previews: [],
        });
        trafficToReview(r);
        await settle();
        assert.equal(r.P.canCreate(r.P.state), false, 'a warning needs its tick');
        r.act('ack', { checked: true });
        assert.equal(r.P.canCreate(r.P.state), true);
        await r.act('create');
        const created = r.calls.filter((c) => c.method === 'create');
        assert.equal(created.length, 1);
        assert.deepEqual(created[0]!.args[0], r.calls.filter((c) => c.method === 'validate')[0]!.args[0], 'exactly what was reviewed');
        assert.equal(created[0]!.args[1], true);
        r.answers.validate = async () => ({ policy: { blocked: true, findings: [] }, money: { fits: true }, meta: { ok: true }, problems: [], warnings: [], previews: [] });
        await r.act('review');
        await settle();
        assert.equal(r.P.canCreate(r.P.state), false);
    });

    it('a change after Review drops it: Create needs another Review', async () => {
        const r = await ready();
        trafficToReview(r);
        await settle();
        assert.ok(r.P.state.review);
        field(r, 'amount', '30');
        assert.equal(r.P.state.review, null);
        assert.equal(r.P.canCreate(r.P.state), false);
    });
});

describe('every adsCreate key is in both catalogues', () => {
    it('static and built keys alike', async () => {
        const source = readFileSync('dashboard/js/pages/ads_create.js', 'utf8');
        const keys = new Set([...source.matchAll(/t\('(adsCreate\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]!));
        const r = load();
        const P = r.P;
        for (const k of P.STEPS) { keys.add(`adsCreate.step.${k}`); keys.add(`adsCreate.help.${k}`); }
        for (const g of P.GOALS) { keys.add(`adsCreate.goal.${g}`); keys.add(`adsCreate.goal.${g}.hint`); }
        for (const list of Object.values(P.OPTIMIZATION) as string[][]) for (const o of list) { keys.add(`adsCreate.opt.${o}`); keys.add(`adsCreate.opt.${o}.hint`); }
        for (const d of P.DESTINATIONS) keys.add(`adsCreate.dest.${d}.hint`);
        for (const g of ['engagement', 'reach']) keys.add(`adsCreate.dest.onPost.${g}`);
        for (const c of P.CTAS) keys.add(`adsCreate.cta.${c}`);
        for (const s of ['uploading', 'uploaded', 'preparing', 'processing', 'ready', 'failed']) keys.add(`adsCreate.upload.${s}`);
        for (const g of ['all', 'men', 'women']) keys.add(`adsCreate.aud.gender.${g}`);
        for (const c of P.SPECIAL) keys.add(`adsCreate.special.${c}`);
        for (const [platform, list] of Object.entries(P.PLACEMENTS) as Array<[string, string[]]>) for (const pos of list) keys.add(`adsCreate.pl.${platform}.${pos}`);
        for (let d = 0; d < 7; d++) keys.add(`adsCreate.day.${d}`);
        for (const p of ['instagram_feed', 'instagram_story', 'instagram_reels', 'feed', 'facebook_reels']) keys.add(`adsCreate.preview.${p}`);
        for (const p of ['instagram', 'facebook']) keys.add(`adsCreate.platform.${p}`);
        for (const k of ['adsCreate.budget.amountDaily', 'adsCreate.budget.amountTotal', 'adsCreate.budget.endRequired', 'adsCreate.budget.endOptional',
            'adsCreate.money.total', 'adsCreate.money.dailyTotal', 'adsCreate.money.over', 'adsCreate.money.remaining', 'adsCreate.money.min', 'adsCreate.special.warn', 'adsCreate.special.hint']) keys.add(k);
        for (const lang of ['ar', 'en'] as const) {
            const dict = readFileSync(`dashboard/js/i18n.${lang}.js`, 'utf8');
            const missing = [...keys].filter((k) => !dict.includes(`'${k}':`));
            assert.deepEqual(missing, [], lang);
        }
    });
});
