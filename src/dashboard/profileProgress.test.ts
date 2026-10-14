/**
 * The Overview's profile card, the one-field sheet an agent opens (`ProfileAsk`), and Operations' onboarding funnel (P30, P31).
 *
 * The real dashboard files run in a `node:vm` context with the real dictionaries, as in welcome.test.ts, so what is asserted is what a
 * person reads. What is pinned, because each is a way these screens hurt somebody:
 *
 *   - **Escaping.** Everything the server or the person supplies is rendered as text or a quoted attribute; an action id, a link or a
 *     field name that is not one of ours is never put in the page at all, and a card built from an answer that is not an answer is
 *     no card (the region stays empty: it can never break the Overview).
 *   - **The card is the server's.** It shows the percentage and the actions it is given, in both languages, with a button only where
 *     the session can carry the action out (an operator is told who to ask; only the platform admin can open a tenant's setup).
 *   - **The sheet can ask for what the server's 409 can name**, and every patch it builds is accepted by the REAL profile validator.
 *     Its limits are the profile's own, so a form can never produce something the server refuses.
 *   - **A switch-on that is refused is asked about once**, and the very same request is sent again when the person answered.
 *   - **The funnel** shows counts and times for 30 or 90 days, never anything from a response that is not one of the wizard's own ids.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { ACTION_IDS, nextBestActions } from '../services/profile/completeness.js';
import { AGENT_REQUIRES, GATED_AGENTS } from '../services/profile/agentGate.js';
import { defaultProfile } from '../services/profile/defaults.js';
import { FITNESS_EN } from '../services/profile/fixtures.js';
import { mergePatch } from '../services/profile/patch.js';
import { PROFILE_LIMITS, validateProfile } from '../services/profile/validate.js';
import { WIZARD_STEPS } from '../services/onboardingWizard.js';

// ─── The sandbox ─────────────────────────────────────────────────────────────────────────────────

function element(initial: string[] = []): Record<string, any> {
    const classes = new Set(initial);
    const attrs: Record<string, string> = {};
    return {
        classes, attrs, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, dataset: {}, offsetWidth: 120,
        classList: {
            add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c),
            toggle: (c: string, force?: boolean) => { const on = force === undefined ? !classes.has(c) : force; if (on) classes.add(c); else classes.delete(c); return on; },
            contains: (c: string) => classes.has(c),
        },
        setAttribute: (k: string, v: string) => { attrs[k] = String(v); }, getAttribute: (k: string) => (k in attrs ? attrs[k]! : null), removeAttribute: (k: string) => { delete attrs[k]; },
        focus: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, remove: () => undefined,
        querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false, appendChild: () => undefined,
    };
}

interface Loaded {
    ctx: Record<string, any>;
    OverviewPage: any;
    OperationsPage: any;
    ProfileAsk: any;
    API: any;
    UI: any;
    Admin: any;
    I18N: any;
    modal: Record<string, any>;
    toasts: Array<{ message: string; type: string }>;
    calls: Array<{ fn: string; args: unknown[] }>;
    region: Record<string, any>;
    fetches: Array<{ url: string; init: any }>;
}

type Answer = { status: number; body: unknown };

function load(options: { lang?: 'ar' | 'en'; role?: 'owner' | 'operator' | 'viewer'; admin?: boolean; api?: Record<string, (...a: any[]) => any>; replies?: Answer[] } = {}): Loaded {
    const lang = options.lang ?? 'en';
    const noop = (): void => {};
    const modal = element(['hidden']);
    const content = element();
    const region = element();
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const fetches: Array<{ url: string; init: any }> = [];
    const toasts: Array<{ message: string; type: string }> = [];
    const replies = [...(options.replies ?? [])];
    const elements: Record<string, Record<string, any>> = { 'modal-overlay': modal, 'modal-content': content };
    const api: Record<string, any> = {};
    for (const name of ['getProfile', 'patchProfile', 'getProfileProgress', 'getOnboardingFunnel']) {
        api[name] = (...args: any[]) => { calls.push({ fn: name, args }); return options.api?.[name] ? options.api[name](...args) : Promise.resolve({}); };
    }
    const stubEl = element();
    class FakeFormData {
        private rows: Array<[string, string]>;
        constructor(form: { __entries?: Array<[string, string]> }) { this.rows = form.__entries ?? []; }
        forEach(cb: (v: string, k: string) => void): void { for (const [k, v] of this.rows) cb(v, k); }
    }
    const ctx: Record<string, any> = {
        document: {
            ...stubEl, createElement: () => element(), body: element(), head: element(), documentElement: { ...element(), lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => elements[id] ?? null, activeElement: null, querySelector: () => null, querySelectorAll: () => [], contains: () => true, addEventListener: noop,
        },
        window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
        location: { hash: '' }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        Intl, console, setTimeout, clearTimeout, URL, URLSearchParams, FormData: FakeFormData,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang, userAgent: 'Mozilla/5.0 Chrome/120' },
        CSS: { escape: (v: string) => String(v) },
        fetch: async (url: string, init: any) => {
            fetches.push({ url, init });
            const reply = replies.shift() ?? { status: 200, body: {} };
            return { ok: reply.status < 400, status: reply.status, text: async () => JSON.stringify(reply.body) };
        },
        Motion: { announce: noop, line: () => '', tableCard: () => '', statsGrid: () => '', busy: () => '', clearSkeleton: noop, beginLoad: () => ({ done: noop }), toolbar: () => '', cardGrid: () => '' },
        Charts: {},
        App: {
            pages: { settings: { src: 'settings' }, infographics: { src: 'infographics' }, operations: { src: 'operations', adminOnly: true }, welcome: { src: 'welcome', routable: false }, overview: { src: 'overview' } },
            session: { tenantRole: options.role ?? 'owner' },
            isAdmin: () => options.admin === true,
            canAdminister: () => (options.role ?? 'owner') === 'owner',
            canOperate: () => (options.role ?? 'owner') !== 'viewer',
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const file of [
        'dashboard/js/i18n.js', `dashboard/js/i18n.${lang}.js`, 'dashboard/js/components.js', 'dashboard/js/api.js', 'dashboard/js/pages/admin_common.js',
        'dashboard/js/pages/overview.js', 'dashboard/js/pages/operations.js',
    ]) vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
    vm.runInContext(`I18N.lang = '${lang}'`, ctx);
    // The real API object, with only the four calls this file drives replaced; the retry test uses its real `request`.
    vm.runInContext('API.__real = { request: API.request.bind(API) }', ctx);
    for (const name of Object.keys(api)) ctx[`__stub_${name}`] = api[name];
    vm.runInContext(`for (const n of ${JSON.stringify(Object.keys(api))}) API[n] = globalThis['__stub_' + n];`, ctx);
    vm.runInContext(`UI.toast = (message, type) => globalThis.__toast(String(message), type || 'success'); UI.icons = () => undefined;`, ctx);
    ctx.__toast = (message: string, type: string) => { toasts.push({ message, type }); };
    const out = vm.runInContext('({ OverviewPage, OperationsPage, ProfileAsk, API, UI, Admin, I18N })', ctx);
    // The Overview's region lookup reads the container; give it one region to paint into.
    elements['page-container'] = { ...element(), querySelector: (sel: string) => (sel.includes('data-region="profile"') || sel.includes('data-region="funnel"') ? region : null) } as Record<string, any>;
    Object.assign(elements, { 'page-container': elements['page-container'] });
    return { ctx, ...out, modal: content, toasts, calls, region, fetches } as Loaded;
}

const plain = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;
const PAYLOAD = '<img src=x onerror=alert(document.cookie)>';

function assertInert(markup: string, label: string): void {
    assert.ok(!markup.includes('<img src=x'), `${label}: no live img tag`);
    assert.ok(!markup.includes('<script'), `${label}: no live script tag`);
    assert.ok(!/\son[a-z]+\s*=/i.test(markup.replace(/&lt;[^<>]*/g, '')), `${label}: no live handler`);
    assert.ok(!/javascript:/i.test(markup), `${label}: no javascript: address`);
    assert.ok(!/\sstyle="/.test(markup), `${label}: no inline style`);
}

const NEW_TENANT_CARD = {
    percent: 46, complete: false, legacy: false, dm: false, canEdit: true, connections: { meta: false, tiktok: false, youtube: false }, missing: [],
    actions: [
        { id: 'connect_meta', unlocks: 'comments', link: { kind: 'page', target: 'settings' }, paths: [] },
        { id: 'voice_samples', unlocks: 'captions', link: { kind: 'ask', fields: ['voice.samples'] }, paths: ['voice.samples'] },
        { id: 'presenter', unlocks: 'reels', link: { kind: 'ask', fields: ['presenter'] }, paths: ['presenter'] },
    ],
};

// ─── The Overview card ───────────────────────────────────────────────────────────────────────────

describe('the Overview profile card', () => {
    it('shows the percentage, a meter, and the actions it was given, each with its words and a button where there is somewhere to go', () => {
        const { OverviewPage, I18N } = load();
        const markup = String(OverviewPage.renderProfileCard(NEW_TENANT_CARD));
        assert.match(markup, /Profile \u2066?46%\u2069? complete/);
        assert.ok(markup.includes('\u206646%\u2069'), 'the percentage is a left-to-right isolate: in Arabic a bare 46% shows as %46');
        assert.match(markup, /<progress class="studio-meter profile-card-meter" max="100" value="46"/);
        for (const id of ['connect_meta', 'voice_samples', 'presenter']) assert.ok(markup.includes(`data-action-id="${id}"`), id);
        assert.match(markup, /Connect Instagram and Facebook/);
        assert.match(markup, /Add 3 posts you’re proud of/);
        assert.match(markup, /Say who is on screen/);
        assert.match(markup, /data-action="app:navigate" data-target="settings"/);
        assert.match(markup, /data-action="overview:ask" data-fields="voice.samples" data-agent="voice_samples"/);
        assert.match(markup, /data-action="overview:ask" data-fields="presenter" data-agent="presenter"/);
        assert.equal(I18N.lang, 'en');
        assertInert(markup, 'a new tenant\'s card');
    });

    it('says the same in Arabic, with the number written the way the page writes numbers', () => {
        const { OverviewPage } = load({ lang: 'ar' });
        const markup = String(OverviewPage.renderProfileCard(NEW_TENANT_CARD));
        assert.match(markup, /اكتمل ملفك \u2066?46%\u2069?/);
        assert.ok(markup.includes('\u206646%\u2069'), 'isolated, so the sign stays after the number in an Arabic sentence');
        assert.match(markup, /اربط إنستجرام وفيسبوك/);
        assert.match(markup, /أضف 3 منشورات تفخر بها/);
        assert.doesNotMatch(markup, /Profile 46%|Connect Instagram/);
    });

    it('is one quiet line for a finished profile, which is what the owner sees when his setup is whole', () => {
        const { OverviewPage } = load();
        const markup = String(OverviewPage.renderProfileCard({ percent: 100, complete: true, actions: [], canEdit: true }));
        assert.match(markup, /Your profile is complete/);
        assert.match(markup, /profile-card--done/);
        assert.doesNotMatch(markup, /<progress|<ul class="profile-actions/);
    });

    it('with nothing to do but not complete still shows the meter and says there is nothing to add', () => {
        const { OverviewPage } = load();
        const markup = String(OverviewPage.renderProfileCard({ percent: 71, complete: false, actions: [], canEdit: true }));
        assert.match(markup, /value="71"/);
        assert.match(markup, /Nothing to add right now/);
    });

    it('offers a sheet only to a session that can fill it in: anyone else is told who to ask', () => {
        const { OverviewPage } = load();
        const markup = String(OverviewPage.renderProfileCard({ ...NEW_TENANT_CARD, canEdit: false }));
        assert.doesNotMatch(markup, /data-action="overview:ask"/);
        assert.match(markup, /Ask the owner/);
        assert.match(markup, /data-target="settings"/, 'a screen to open is still a screen to open');
    });

    it('opens the setup only for the platform admin: the tenant is sent there by the gate, nobody else can open it from here', () => {
        const wizard = { ...NEW_TENANT_CARD, actions: [{ id: 'finish_setup', unlocks: 'setup', link: { kind: 'wizard' }, paths: [] }] };
        assert.match(String(load({ admin: true }).OverviewPage.renderProfileCard(wizard)), /data-action="overview:wizard"/);
        assert.doesNotMatch(String(load({ admin: false }).OverviewPage.renderProfileCard(wizard)), /overview:wizard/);
    });

    it('never puts an action it does not know, a screen it may not open, or a field that is not a string into the page', () => {
        const { OverviewPage } = load();
        const hostile = {
            percent: 40, complete: false, canEdit: true,
            actions: [
                { id: PAYLOAD, link: { kind: 'page', target: 'settings' } },
                { id: 'constructor', link: { kind: 'page', target: 'settings' } },
                { id: 'portrait', link: { kind: 'page', target: 'javascript:alert(1)' } },
                { id: 'portrait', link: { kind: 'page', target: 'operations' } },
                { id: 'portrait', link: { kind: 'page', target: 'welcome' } },
                { id: 'portrait', link: { kind: 'page', target: '__proto__' } },
                { id: 'audience', link: { kind: 'ask', fields: [PAYLOAD, 7, null, 'audience.description'] } },
                { id: 'presenter', link: null },
                null, 'x', 4,
            ],
        };
        const markup = String(OverviewPage.renderProfileCard(hostile));
        assertInert(markup, 'a hostile answer');
        assert.equal((markup.match(/data-action-id=/g) ?? []).length, 6, 'only the six known ids: portrait x4, audience, presenter');
        assert.doesNotMatch(markup, /data-target="(?:javascript|operations|welcome|__proto__)/);
        assert.match(markup, /data-fields="&lt;img src=x onerror=alert\(document\.cookie\)&gt;,audience\.description"/, 'a field name is an escaped attribute, and anything that is not text is gone');
        assert.equal((markup.match(/data-action="overview:ask"/g) ?? []).length, 1);
    });

    it('clamps the percentage to a whole number from 0 to 100, whatever it is sent', () => {
        const { OverviewPage } = load();
        const percent = (v: unknown) => OverviewPage.profilePercent({ percent: v });
        assert.deepEqual([percent(46.6), percent(-5), percent(1e9), percent('62'), percent('x'), percent(null), percent(undefined)], [47, 0, 100, 62, 0, 0, 0]);
    });

    it('fills the region from an answer, and leaves it EMPTY for anything that is not one: it cannot break the Overview', () => {
        const { OverviewPage, region } = load();
        OverviewPage.fillProfile({ status: 'fulfilled', value: NEW_TENANT_CARD });
        assert.match(String(region.innerHTML), /Profile \u2066?46%\u2069? complete/);
        for (const bad of [
            { status: 'rejected', reason: new Error('403') }, { status: 'fulfilled', value: null }, { status: 'fulfilled', value: 'x' },
            { status: 'fulfilled', value: {} }, { status: 'fulfilled', value: { percent: 'abc' } }, undefined,
        ]) {
            region.innerHTML = 'before';
            OverviewPage.fillProfile(bad);
            assert.equal(region.innerHTML, '', JSON.stringify(bad));
        }
    });

    it('is a region of the page, above the briefing', () => {
        const { OverviewPage } = load();
        const skeleton = String(OverviewPage.skeleton());
        assert.ok(skeleton.indexOf('data-region="profile"') >= 0 && skeleton.indexOf('data-region="profile"') < skeleton.indexOf('data-region="briefing"'));
    });

    it('has words, in both languages, for every action the server can name, and the server\'s action ids are the card\'s icons', () => {
        for (const lang of ['en', 'ar'] as const) {
            const { I18N, OverviewPage } = load({ lang });
            const dict = I18N.strings[lang];
            for (const id of ACTION_IDS) {
                assert.ok(dict[`profileCard.action.${id}`], `${lang}: title for ${id}`);
                assert.ok(dict[`profileCard.action.${id}.why`], `${lang}: reason for ${id}`);
                assert.ok(OverviewPage.PROFILE_ICONS[id], `an icon for ${id}`);
            }
            assert.deepEqual(Object.keys(OverviewPage.PROFILE_ICONS).sort(), [...ACTION_IDS].sort(), 'and no icon for an action that does not exist');
        }
    });

    it('can open every sheet the server\'s "ask" actions name, and every extra field an agent\'s 409 can name', () => {
        const { ProfileAsk } = load();
        const asked = new Set<string>();
        // Every combination of what a person adds after the wizard, so each "ask" action gets its turn among the top three.
        const adds: Array<(p: typeof FITNESS_EN) => void> = [
            (p) => { p.voice.samples = ['a', 'b', 'c']; }, (p) => { p.presenter = { name: 'x', pronouns: 'they', on_camera: 'face' }; },
            (p) => { p.audience.description = 'a'; }, (p) => { p.brand.portrait_url = '/api/uploads/1'; }, (p) => { p.dm.handoff = { when: 'w', message: 'm' }; },
        ];
        for (let mask = 0; mask < 1 << adds.length; mask++) {
            const profile = structuredClone(defaultProfile({ lang: 'en' }));
            profile.identity = { ...profile.identity, display_name: { ar: '', en: 'N' }, kind: 'shop', niche: 'n', timezone: 'Europe/London' };
            profile.offers = [{ id: 'm', kind: 'product', name: 'x', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }];
            adds.forEach((add, bit) => { if (mask & (1 << bit)) add(profile); });
            for (const dm of [false, true]) {
                for (const a of nextBestActions(profile, { meta: true, tiktok: true, youtube: true }, { dm })) if (a.link.kind === 'ask') a.link.fields.forEach((f) => asked.add(f));
            }
        }
        for (const a of nextBestActions(defaultProfile({ lang: 'ar' }), { meta: true, tiktok: true, youtube: true })) if (a.link.kind === 'ask') a.link.fields.forEach((f) => asked.add(f));
        assert.deepEqual([...asked].sort(), ['audience.description', 'dm.handoff', 'presenter', 'voice.samples']);
        for (const path of asked) assert.ok(ProfileAsk.FIELDS.includes(path), path);
        for (const agent of GATED_AGENTS) for (const path of AGENT_REQUIRES[agent]) assert.ok(ProfileAsk.FIELDS.includes(path), `the ${agent}'s ${path}`);
        assert.deepEqual([...ProfileAsk.FIELDS].sort(), ['audience.description', 'dm.handoff', 'presenter', 'voice.samples']);
    });
});

// ─── The one-field sheet ─────────────────────────────────────────────────────────────────────────

describe('ProfileAsk: what a save sends', () => {
    const merged = (base: unknown, patch: unknown) => validateProfile(mergePatch(base, patch));
    const values = (over: Record<string, string> = {}) => ({
        sample0: 'Post one', sample1: 'Post two', sample2: '', handoffWhen: 'A refund', handoffMessage: 'A person will reply.',
        presenterName: 'Nour', presenterPronouns: 'she', presenterCamera: 'face', audience: 'Parents with an hour a day', ...over,
    });

    it('builds a patch the REAL profile validator accepts, for every field it can ask', () => {
        const { ProfileAsk } = load();
        for (const base of [defaultProfile({ lang: 'ar' }), FITNESS_EN]) {
            const built = plain<{ patch: any }>(ProfileAsk.buildPatch(ProfileAsk.FIELDS, values(), base));
            assert.deepEqual(Object.keys(built.patch).sort(), ['audience', 'dm', 'presenter', 'voice']);
            const result = merged(base, built.patch);
            assert.ok('profile' in result, JSON.stringify(result));
            assert.deepEqual((result as any).profile.voice.samples.slice(0, 2), ['Post one', 'Post two']);
            assert.deepEqual((result as any).profile.dm.handoff, { when: 'A refund', message: 'A person will reply.' });
            assert.deepEqual((result as any).profile.presenter, { name: 'Nour', pronouns: 'she', on_camera: 'face' });
            assert.equal((result as any).profile.audience.description, 'Parents with an hour a day');
        }
    });

    it('holds the profile\'s own limits: the longest it will send is the longest the profile will take', () => {
        const { ProfileAsk } = load();
        assert.equal(ProfileAsk.SAMPLE_MAX, PROFILE_LIMITS.samples.each);
        assert.equal(ProfileAsk.SAMPLES_KEPT, PROFILE_LIMITS.samples.items);
        assert.equal(ProfileAsk.HANDOFF_WHEN_MAX, PROFILE_LIMITS.handoffWhen);
        assert.equal(ProfileAsk.HANDOFF_MESSAGE_MAX, PROFILE_LIMITS.handoffMessage);
        assert.equal(ProfileAsk.AUDIENCE_MAX, PROFILE_LIMITS.audienceDescription);
        assert.equal(ProfileAsk.NAME_MAX, PROFILE_LIMITS.presenterName);
        const long = 'x'.repeat(5000);
        const built = plain<{ patch: any }>(ProfileAsk.buildPatch(ProfileAsk.FIELDS, values({ sample0: long, handoffWhen: long, handoffMessage: long, presenterName: long, audience: long }), defaultProfile({ lang: 'ar' })));
        assert.ok('profile' in merged(defaultProfile({ lang: 'ar' }), built.patch), 'over-long text is cut, not refused');
        assert.equal(built.patch.voice.samples[0].length, 2200);
        assert.equal(built.patch.dm.handoff.when.length, 300);
    });

    it('keeps what the profile already holds beyond the three boxes, and never more than five samples', () => {
        const { ProfileAsk } = load();
        const profile = { voice: { samples: ['a', 'b', 'c', 'd', 'e'] } };
        const built = plain<{ patch: any }>(ProfileAsk.buildPatch(['voice.samples'], values({ sample0: 'new', sample1: '', sample2: '' }), profile));
        assert.deepEqual(built.patch.voice.samples, ['new', 'd', 'e']);
        const full = plain<{ patch: any }>(ProfileAsk.buildPatch(['voice.samples'], values({ sample0: '1', sample1: '2', sample2: '3' }), profile));
        assert.deepEqual(full.patch.voice.samples, ['1', '2', '3', 'd', 'e']);
    });

    it('asks again, with the first thing wrong, instead of sending something empty', () => {
        const { ProfileAsk } = load();
        const err = (asks: string[], over: Record<string, string>) => plain<{ error?: string }>(ProfileAsk.buildPatch(asks, values(over), {})).error;
        assert.equal(err(['voice.samples'], { sample0: '  ', sample1: '', sample2: '' }), 'profileAsk.err.samples');
        assert.equal(err(['dm.handoff'], { handoffWhen: '', handoffMessage: 'x' }), 'profileAsk.err.handoff');
        assert.equal(err(['dm.handoff'], { handoffWhen: 'x', handoffMessage: '   ' }), 'profileAsk.err.handoff');
        assert.equal(err(['presenter'], { presenterPronouns: 'it' }), 'profileAsk.err.presenter');
        assert.equal(err(['presenter'], { presenterCamera: '' }), 'profileAsk.err.presenter');
        assert.equal(err(['audience.description'], { audience: '' }), 'profileAsk.err.audience');
        for (const key of ['samples', 'handoff', 'presenter', 'audience']) {
            for (const lang of ['en', 'ar'] as const) assert.ok(load({ lang }).I18N.strings[lang][`profileAsk.err.${key}`], `${lang} ${key}`);
        }
    });

    it('accepts a presenter with no name: the name is optional, the pronouns and the camera are not', () => {
        const { ProfileAsk } = load();
        const built = plain<{ patch: any }>(ProfileAsk.buildPatch(['presenter'], values({ presenterName: '' }), {}));
        assert.deepEqual(built.patch.presenter, { name: '', pronouns: 'she', on_camera: 'face' });
        assert.ok('profile' in merged(defaultProfile({ lang: 'en' }), built.patch));
    });

    it('builds nothing for a field it was not asked about', () => {
        const { ProfileAsk } = load();
        const built = plain<{ patch: any }>(ProfileAsk.buildPatch(['audience.description'], values(), {}));
        assert.deepEqual(Object.keys(built.patch), ['audience']);
        assert.deepEqual(plain(ProfileAsk.buildPatch(['identity.niche', 'dm.faq'], values(), {})), { patch: {} });
    });
});

describe('ProfileAsk: the sheet', () => {
    /** What the page hands `save`: the form's named fields, and the one method `UI.formBusy` asks it for. */
    const fakeForm = (entries: Array<[string, string]>) => ({ __entries: entries, querySelector: () => null });
    const profileAnswer = (over: Record<string, unknown> = {}) => ({ profile: { ...structuredClone(defaultProfile({ lang: 'en' })), ...over }, version: 3 });

    it('asks only for what can be asked and was named: the wizard\'s fields are not its business', async () => {
        const { ProfileAsk, calls, modal } = load({ api: { getProfile: async () => profileAnswer() } });
        assert.equal(await ProfileAsk.require(['identity.niche', 'language.register'], { agent: 'dm' }), false);
        assert.equal(await ProfileAsk.require([], {}), false);
        assert.equal(await ProfileAsk.require(undefined, {}), false);
        assert.equal(calls.length, 0, 'nothing was read');
        assert.equal(modal.innerHTML, '');
    });

    it('shows one fieldset for each field named, in the words of the agent that asked, and nothing it typed is live markup', async () => {
        const L = load({ api: { getProfile: async () => profileAnswer({ presenter: { name: PAYLOAD, pronouns: 'they', on_camera: 'voice' }, audience: { ...defaultProfile().audience, description: PAYLOAD } }) } });
        const answer = L.ProfileAsk.require(['presenter', 'audience.description', 'identity.niche'], { agent: 'monteur' });
        await new Promise((r) => setTimeout(r, 0));
        const markup = String(L.modal.innerHTML);
        assert.match(markup, /The Monteur cuts reels with you in them/);
        assert.match(markup, /Who is on screen\?/);
        assert.match(markup, /Who is your content for\?/);
        assert.doesNotMatch(markup, /Three posts you’re proud of|hand a chat to you/, 'nothing it was not asked for');
        assert.equal((markup.match(/<fieldset|<textarea/g) ?? []).length, 2);
        assertInert(markup, 'the sheet');
        assert.match(markup, /&lt;img src=x onerror=alert\(document\.cookie\)&gt;/);
        assert.match(markup, /<option value="they" selected>They \/ them/);
        assert.match(markup, /<option value="voice" selected>Voice only/);
        vm.runInContext('UI.closeModal()', L.ctx as vm.Context);
        assert.equal(await answer, false);
    });

    it('is told who to ask when the session is not the owner, and opens nothing', async () => {
        const { ProfileAsk, toasts, calls } = load({ role: 'operator' });
        assert.equal(await ProfileAsk.require(['presenter'], {}), false);
        assert.deepEqual(toasts.map((t) => t.type), ['error']);
        assert.match(toasts[0]!.message, /Only the account owner can fill this in/);
        assert.equal(calls.length, 0);
    });

    it('answers every caller that asks while it is open with the one answer: two refusals at once ask once, and closing answers both "no"', async () => {
        const L = load({ api: { getProfile: async () => profileAnswer() } });
        const first = L.ProfileAsk.require(['presenter'], { agent: 'monteur' });
        const second = L.ProfileAsk.require(['presenter'], { agent: 'monteur' });
        assert.equal(first, second, 'the same promise');
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(L.calls.filter((c) => c.fn === 'getProfile').length, 1);
        assert.match(String(L.modal.innerHTML), /Who is on screen/, 'the sheet is open');
        vm.runInContext('UI.closeModal()', L.ctx as vm.Context);
        assert.equal(await first, false);
        assert.equal(L.ProfileAsk._open, null, 'and nothing is left open');
    });

    it('closes by being replaced, too: a sheet that another modal pushes aside has been answered "no"', async () => {
        const L = load({ api: { getProfile: async () => profileAnswer() } });
        const answer = L.ProfileAsk.require(['audience.description'], { agent: 'coach' });
        await new Promise((r) => setTimeout(r, 0));
        vm.runInContext('UI.showModal(html`<p>another dialog</p>`)', L.ctx as vm.Context);
        assert.equal(await answer, false);
    });

    it('saves what was typed with the version it read, tells the person, closes, and answers "yes"', async () => {
        const L = load({ api: { getProfile: async () => profileAnswer(), patchProfile: async () => ({ version: 4 }) } });
        const answer = L.ProfileAsk.require(['audience.description'], { agent: 'coach' });
        await new Promise((r) => setTimeout(r, 0));
        await L.ProfileAsk.save(fakeForm([['audience', 'Parents with an hour a day']]), { preventDefault: () => undefined });
        assert.equal(await answer, true);
        const patch = L.calls.find((c) => c.fn === 'patchProfile')!;
        assert.deepEqual(plain(patch.args), [3, { audience: { description: 'Parents with an hour a day' } }]);
        assert.deepEqual(L.toasts.map((t) => [t.message, t.type]), [['Saved', 'success']]);
        assert.equal(L.ProfileAsk._open, null);
    });

    it('sends nothing for an empty form: it says what is missing and stays open, with what was typed kept', async () => {
        const L = load({ api: { getProfile: async () => profileAnswer() } });
        const answer = L.ProfileAsk.require(['dm.handoff'], { agent: 'dm' });
        await new Promise((r) => setTimeout(r, 0));
        await L.ProfileAsk.save(fakeForm([['handoffWhen', 'A refund'], ['handoffMessage', '   ']]), { preventDefault: () => undefined });
        assert.equal(L.calls.some((c) => c.fn === 'patchProfile'), false);
        const markup = String(L.modal.innerHTML);
        assert.match(markup, /Fill in both: when to hand over, and what it says/);
        assert.match(markup, />A refund</, 'what was typed is still there');
        assert.ok(L.ProfileAsk._open, 'still open');
        vm.runInContext('UI.closeModal()', L.ctx as vm.Context);
        assert.equal(await answer, false);
    });

    it('reloads the sheet with what is there now when somebody else wrote in between, and says so, and keeps the sheet open', async () => {
        let reads = 0;
        const L = load({ api: {
            getProfile: async () => { reads += 1; return profileAnswer({ audience: { ...defaultProfile().audience, description: reads > 1 ? 'Written meanwhile' : '' } }); },
            patchProfile: async () => { throw Object.assign(new Error('conflict'), { status: 409, body: { code: 'PROFILE_VERSION_CONFLICT', currentVersion: 4 } }); },
        } });
        const answer = L.ProfileAsk.require(['audience.description'], { agent: 'coach' });
        await new Promise((r) => setTimeout(r, 0));
        await L.ProfileAsk.save(fakeForm([['audience', 'Mine']]), { preventDefault: () => undefined });
        assert.equal(reads, 2);
        const markup = String(L.modal.innerHTML);
        assert.match(markup, /Your profile changed while this was open/);
        assert.match(markup, />Written meanwhile</);
        assert.ok(L.ProfileAsk._open, 'not answered yet: it is still open, and the first caller is still waiting');
        vm.runInContext('UI.closeModal()', L.ctx as vm.Context);
        assert.equal(await answer, false);
    });

    it('shows the server\'s own reasons when it refuses what was typed, and stays open', async () => {
        const L = load({ api: {
            getProfile: async () => profileAnswer(),
            patchProfile: async () => { throw Object.assign(new Error('The profile is not valid.'), { status: 400, body: { code: 'PROFILE_INVALID', problems: ['presenter.name must be at most 40 characters'] } }); },
        } });
        const answer = L.ProfileAsk.require(['presenter'], { agent: 'monteur' });
        await new Promise((r) => setTimeout(r, 0));
        await L.ProfileAsk.save(fakeForm([['presenterName', 'x'], ['presenterPronouns', 'they'], ['presenterCamera', 'face']]), { preventDefault: () => undefined });
        assert.match(String(L.modal.innerHTML), /presenter\.name must be at most 40 characters/);
        assert.ok(L.ProfileAsk._open);
        vm.runInContext('UI.closeModal()', L.ctx as vm.Context);
        await answer;
    });

    it('says it could not read the profile, and answers "no", when the profile cannot be read', async () => {
        const L = load({ api: { getProfile: async () => { throw new Error('offline'); } } });
        assert.equal(await L.ProfileAsk.require(['presenter'], {}), false);
        assert.deepEqual(L.toasts.map((t) => [t.message, t.type]), [['offline', 'error']]);
        assert.equal(L.ProfileAsk._open, null);
    });
});

// ─── A refused switch-on is asked about once ─────────────────────────────────────────────────────

describe('API.request and a refused switch-on', () => {
    const REFUSED: Answer = { status: 409, body: { error: 'Fill in presenter before switching on the monteur.', code: 'PROFILE_INCOMPLETE', agent: 'monteur', missing: ['presenter'], fixStep: 'ask' } };

    it('opens the sheet for what is missing, and sends the very same request again once it is answered', async () => {
        const L = load({ replies: [REFUSED, { status: 200, body: { job: { id: 'j1' } } }] });
        const asked: Array<{ fields: unknown; options: unknown }> = [];
        L.ctx.__ask = (fields: unknown, options: unknown) => { asked.push({ fields, options }); return Promise.resolve(true); };
        vm.runInContext('ProfileAsk.require = (f, o) => globalThis.__ask(f, o);', L.ctx);
        const result = await L.API.__real.request('/studio/monteur/run', { method: 'POST', body: '{}' });
        assert.deepEqual(plain(result), { job: { id: 'j1' } });
        assert.equal(L.fetches.length, 2);
        assert.deepEqual(L.fetches.map((f) => f.url), ['/api/studio/monteur/run', '/api/studio/monteur/run']);
        assert.deepEqual(plain(asked), [{ fields: ['presenter'], options: { agent: 'monteur' } }]);
        for (const f of L.fetches) assert.equal(f.init.method, 'POST');
        for (const f of L.fetches) assert.equal('profileAsked' in f.init, false, 'our marker never reaches fetch');
    });

    it('does not ask a second time: a request that is refused again after the answer fails, in the person\'s own language', async () => {
        const L = load({ replies: [REFUSED, REFUSED] });
        let asks = 0;
        L.ctx.__ask = () => { asks += 1; return Promise.resolve(true); };
        vm.runInContext('ProfileAsk.require = (f, o) => globalThis.__ask(f, o);', L.ctx);
        await assert.rejects(L.API.__real.request('/studio/monteur/run', { method: 'POST' }), (err: any) => {
            assert.equal(err.status, 409);
            assert.equal(err.body.code, 'PROFILE_INCOMPLETE');
            assert.equal(err.message, 'Finish your profile before switching this on.');
            return true;
        });
        assert.equal(asks, 1);
        assert.equal(L.fetches.length, 2);
    });

    it('fails with the same words, and sends nothing again, when the sheet was closed', async () => {
        const L = load({ lang: 'ar', replies: [REFUSED] });
        L.ctx.__ask = () => Promise.resolve(false);
        vm.runInContext('ProfileAsk.require = (f, o) => globalThis.__ask(f, o);', L.ctx);
        await assert.rejects(L.API.__real.request('/settings/ai', { method: 'POST' }), (err: any) => err.message === 'أكمل ملفك قبل تشغيل هذا.');
        assert.equal(L.fetches.length, 1);
    });

    it('leaves every other 409 alone', async () => {
        const L = load({ replies: [{ status: 409, body: { error: 'Version conflict.', code: 'PROFILE_VERSION_CONFLICT' } }] });
        let asks = 0;
        L.ctx.__ask = () => { asks += 1; return Promise.resolve(true); };
        vm.runInContext('ProfileAsk.require = (f, o) => globalThis.__ask(f, o);', L.ctx);
        await assert.rejects(L.API.__real.request('/profile', { method: 'PATCH' }), (err: any) => err.message === 'Version conflict.');
        assert.equal(asks, 0);
    });
});

// ─── The funnel card ─────────────────────────────────────────────────────────────────────────────

const STEPS = WIZARD_STEPS.filter((s) => s.enabled && s.id !== 'done').map((s) => s.id);
const FUNNEL = {
    days: 30, since: '2026-09-14T00:00:00.000Z', cohort: 8,
    stages: [['invited', 8], ['opened', 7], ['accepted', 6], ...STEPS.map((s, i) => [s, 5 - i]), ['completed', 2]].map(([id, reached]) => ({ id, reached, pct: Math.round(100 * (reached as number) / 8) })),
    steps: STEPS.map((step, i) => ({ step, reached: 5 - i, completed: 4 - i, skipped: i === 2 ? 1 : 0, median_ms: 90_000 * (i + 1) })),
    completed: 2, abandoned: 3, in_progress: 3,
    medians: { invite_to_open_ms: 120_000, invite_to_accept_ms: 400_000, open_to_complete_ms: 4 * 60_000, accept_to_complete_ms: 3 * 60_000 },
    drafts: { started: 5, ready: 4, failed: 1 }, target_open_to_complete_ms: 300_000,
};

describe('the Operations funnel card', () => {
    const paint = (L: Loaded, _unused: Record<string, unknown> = {}, funnel: Record<string, unknown> = {}) => {
        L.OperationsPage.funnel = { days: 30, data: FUNNEL, failed: false, loading: false, seq: 1, ...funnel };
        return String(L.OperationsPage.renderFunnel());
    };

    it('shows the stages as counts against the cohort, the median times against the target, the steps and the drafts', () => {
        const markup = paint(load());
        assert.match(markup, /Onboarding funnel/);
        assert.match(markup, /Invited/);
        assert.match(markup, /8 of 8/);
        assert.match(markup, /Finished/);
        assert.match(markup, /<progress class="studio-meter" max="8" value="7" aria-label="Opened the link: 7 of 8">/);
        assert.match(markup, /Link opened to finished/);
        assert.match(markup, /4m/);
        assert.match(markup, /Within the target/);
        assert.match(markup, /Target: 5m or less/);
        assert.match(markup, /AI drafts: 5 started, 4 ready, 1 failed/);
        for (const step of STEPS) assert.ok(markup.includes(`>${load().I18N.strings.en[`ops.funnel.stage.${step}`]}<`), step);
        assertInert(markup, 'the funnel');
    });

    it('says when a median is over the target, and "—" for one nobody has', () => {
        const L = load();
        const over = paint(L, {}, { data: { ...FUNNEL, medians: { ...FUNNEL.medians, open_to_complete_ms: 9 * 60_000, invite_to_open_ms: null } } });
        assert.match(over, /Over the target/);
        assert.match(over, /—/);
    });

    it('writes durations as a person says them, in both languages', () => {
        const { OperationsPage } = load();
        const d = (ms: unknown) => OperationsPage.duration(ms);
        assert.deepEqual([d(30_000), d(4 * 60_000), d(80 * 60_000), d(60 * 60_000), d(30 * 3_600_000), d(null), d(-1), d('x'), d(undefined)], ['under a minute', '4m', '1h 20m', '1h', '1d', '—', '—', '—', '—']);
        assert.equal(load({ lang: 'ar' }).OperationsPage.duration(80 * 60_000), '1 س 20 د');
    });

    it('marks the window that is showing and offers both', () => {
        const markup = paint(load(), {}, { days: 90 });
        assert.match(markup, /data-action="ops:funnelWindow" data-days="30"\s+aria-pressed="false">Last 30 days/);
        assert.match(markup, /data-action="ops:funnelWindow" data-days="90"\s+aria-pressed="true">Last 90 days/);
    });

    it('says so when nobody has been invited, when it is loading, and when it could not be loaded, with a Retry', () => {
        const L = load();
        assert.match(paint(L, {}, { data: { ...FUNNEL, cohort: 0 } }), /No tenant has been invited in this period yet/);
        assert.match(paint(L, {}, { data: null, loading: true }), /Loading/);
        const failed = paint(L, {}, { data: null, failed: true });
        assert.match(failed, /The funnel could not be loaded/);
        assert.match(failed, /data-action="ops:funnelRetry"/);
        assert.doesNotMatch(failed, /Invited/);
    });

    it('never draws a stage or a step whose id is not one of the wizard\'s own, and escapes whatever else it is given', () => {
        const hostile = {
            ...FUNNEL,
            stages: [{ id: PAYLOAD, reached: 3 }, { id: 'constructor', reached: 3 }, { id: 'invited', reached: '<b>5</b>' }, null, 7],
            steps: [{ step: PAYLOAD, reached: 1 }, { step: 'about', reached: PAYLOAD, completed: '<i>', skipped: {}, median_ms: PAYLOAD }],
            drafts: { started: PAYLOAD, ready: 'x', failed: null },
        };
        const markup = paint(load(), {}, { data: hostile });
        assertInert(markup, 'a hostile funnel');
        assert.doesNotMatch(markup, /<b>5/);
        assert.equal((markup.match(/class="funnel-stage"/g) ?? []).length, 1, 'only the invited stage');
        assert.equal((markup.match(/<th scope="row">/g) ?? []).length, 1, 'only the about step');
    });

    it('has words for every stage in both languages, and only for ids the wizard and the funnel can produce', () => {
        for (const lang of ['en', 'ar'] as const) {
            const L = load({ lang });
            for (const id of L.OperationsPage.STAGE_IDS) assert.ok(L.I18N.strings[lang][`ops.funnel.stage.${id}`], `${lang} ${id}`);
        }
        const L = load();
        assert.deepEqual([...L.OperationsPage.STAGE_IDS].sort(), ['invited', 'opened', 'accepted', 'completed', ...WIZARD_STEPS.filter((s) => s.id !== 'done').map((s) => s.id)].sort());
    });

    it('asks for the window it is told and drops an answer that comes after a newer question', async () => {
        let release: (v: unknown) => void = () => undefined;
        const slow = new Promise((resolve) => { release = resolve; });
        const L = load({ api: { getOnboardingFunnel: (days: number) => (days === 30 ? slow : Promise.resolve({ ...FUNNEL, days })) } });
        const first = L.OperationsPage.loadFunnel(30);
        await L.OperationsPage.loadFunnel(90);
        assert.equal(L.OperationsPage.funnel.days, 90);
        assert.equal(L.OperationsPage.funnel.data.days, 90);
        release({ ...FUNNEL, days: 30 });
        await first;
        assert.equal(L.OperationsPage.funnel.days, 90, 'the late 30-day answer did not replace the 90-day one');
        assert.deepEqual(L.calls.filter((c) => c.fn === 'getOnboardingFunnel').map((c) => c.args[0]), [30, 90]);
    });

    it('treats a window it does not offer as 30, and a failed request as a failed card, not an exception', async () => {
        const L = load({ api: { getOnboardingFunnel: () => Promise.reject(new Error('boom')) } });
        await L.OperationsPage.loadFunnel(7);
        assert.equal(L.OperationsPage.funnel.days, 30);
        assert.equal(L.OperationsPage.funnel.failed, true);
        assert.equal(L.OperationsPage.funnel.loading, false);
    });
});

// ─── The dictionaries ────────────────────────────────────────────────────────────────────────────

describe('the copy', () => {
    it('has every key of this change in both languages, with the same placeholders', () => {
        const en = load({ lang: 'en' }).I18N.strings.en as Record<string, string>;
        const ar = load({ lang: 'ar' }).I18N.strings.ar as Record<string, string>;
        const keys = Object.keys(en).filter((k) => /^(?:profileCard|profileAsk|ops\.funnel)\./.test(k));
        assert.ok(keys.length > 90, `${keys.length} keys`);
        const holders = (s: string) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
        for (const key of keys) {
            assert.ok(typeof ar[key] === 'string' && ar[key]!.length > 0, `ar: ${key}`);
            assert.equal(holders(ar[key]!), holders(en[key]!), `placeholders of ${key}`);
        }
    });

    it('writes no digit of its own into Arabic: every number is the page\'s', () => {
        const ar = load({ lang: 'ar' }).I18N.strings.ar as Record<string, string>;
        for (const [key, value] of Object.entries(ar)) {
            if (/^(?:profileCard|profileAsk|ops\.funnel)\./.test(key)) assert.doesNotMatch(value, /[٠-٩۰-۹]/, key);
        }
    });
});
