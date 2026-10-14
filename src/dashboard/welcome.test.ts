/**
 * The setup wizard (P18): `#/welcome`, its steps, its gate, and the note for somebody inside an app's own browser.
 *
 * The real dashboard files run in a `node:vm` context (the real dictionaries too, so what is asserted is what a person reads), as
 * in escaping.test.ts and invites.test.ts. What is pinned, because each is a way the wizard hurts somebody:
 *
 *   - **Escaping.** Every value a person or the server supplies (the tenant's name, what they typed, the operator's hints, the
 *     profile's fields, the server's problem list, a workspace's name) is rendered as text or as a quoted attribute, on every
 *     step and in every state; a colour or a portrait address that is not what it must be is never put in the page at all.
 *   - **The gate.** An owner of an unfinished tenant is sent to the wizard from every route; a platform admin never is, an owner
 *     whose tenant is completed (the owner himself) never is, and a typed `#/welcome` does not open the wizard for either.
 *   - **What a step sends.** Every patch the wizard builds is accepted by the REAL profile validator, and every draft it autosaves
 *     is accepted by the REAL step-values check, so a form can never produce something the server refuses.
 *   - **Continue is the profile's optimistic write**: a 409 reloads the step with the newer values and a note, a refusal shows the
 *     server's problems, and a step is marked done only after its profile write went through.
 *   - **The copy.** Every key the page asks for exists in both languages with the same placeholders, and a register's sentence
 *     names the offer only through `<bdi>`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { defaultProfile } from '../services/profile/defaults.js';
import { mergePatch } from '../services/profile/patch.js';
import { activationMissing, validateProfile } from '../services/profile/validate.js';
import { nextStepAfter, onboardingGated, validateStepValues, WIZARD_STEPS } from '../services/onboardingWizard.js';

// ─── The sandbox ─────────────────────────────────────────────────────────────────────────────────

interface Store { map: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
function store(): Store {
    const map = new Map<string, string>();
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}

/** An element that remembers what the page does to it: classes, attributes, text, markup. */
function element(initial: string[] = []): Record<string, any> {
    const classes = new Set(initial);
    const attrs: Record<string, string> = {};
    const el: Record<string, any> = {
        classes, attrs, value: '', checked: false, textContent: '', innerHTML: '', disabled: false, style: {}, dataset: {}, offsetWidth: 120,
        classList: {
            add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c),
            toggle: (c: string, force?: boolean) => { const on = force === undefined ? !classes.has(c) : force; if (on) classes.add(c); else classes.delete(c); return on; },
            contains: (c: string) => classes.has(c),
        },
        setAttribute: (k: string, v: string) => { attrs[k] = String(v); }, getAttribute: (k: string) => (k in attrs ? attrs[k]! : null),
        removeAttribute: (k: string) => { delete attrs[k]; },
        focus: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, remove: () => undefined,
        querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false, appendChild: () => undefined,
    };
    return el;
}

interface Loaded {
    ctx: Record<string, any>;
    elements: Record<string, Record<string, any>>;
    WelcomePage: any;
    App: any;
    UI: any;
    I18N: any;
    html: (s: TemplateStringsArray, ...v: unknown[]) => { toString(): string };
    calls: Array<{ fn: string; args: unknown[] }>;
}

function load(options: { lang?: 'ar' | 'en'; hash?: string; userAgent?: string; api?: Record<string, (...a: any[]) => any> } = {}): Loaded {
    const lang = options.lang ?? 'en';
    const noop = (): void => {};
    const elements: Record<string, Record<string, any>> = {
        'login-screen': element(), app: element(['hidden']), 'invite-screen': element(['hidden']), 'welcome-screen': element(['hidden']), 'welcome-root': element(),
        'login-error': element(['hidden']), 'login-password': element(), 'login-email': element(), 'login-email-group': element(['hidden']), 'login-email-toggle': element(), 'login-keep': element(),
        'welcome-next': element(), 'welcome-save': element(), 'welcome-form': element(),
    };
    const stubEl = { ...element() };
    const location = { hash: options.hash ?? '', pathname: '/dashboard', search: '' };
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const history = {
        calls: [] as string[],
        replaceState(_s: unknown, _t: string, url: string) { this.calls.push(`replace ${url}`); location.hash = url.startsWith('#') ? url : ''; },
        pushState(_s: unknown, _t: string, url: string) { this.calls.push(`push ${url}`); location.hash = url.startsWith('#') ? url : ''; },
    };
    const api: Record<string, any> = {
        token: 'token', setToken: noop, clearToken: noop,
        ...(options.api ?? {}),
    };
    for (const name of ['getMe', 'getOnboarding', 'saveOnboardingStep', 'completeOnboarding', 'patchProfile', 'uploadMedia']) {
        const given = api[name];
        api[name] = (...args: any[]) => { calls.push({ fn: name, args }); return given ? given(...args) : Promise.resolve({}); };
    }
    const ctx: Record<string, any> = {
        document: {
            ...stubEl,
            createElement: () => ({ ...element() }),
            body: { ...element() }, head: { ...element() },
            documentElement: { ...element(), lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => elements[id] ?? null, activeElement: null, currentScript: null,
            querySelector: () => null, querySelectorAll: () => [], contains: () => true,
            addEventListener: noop,
        },
        window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location, scrollTo: noop, innerHeight: 800 },
        location, history, localStorage: store(), sessionStorage: store(),
        Intl, console, setTimeout, clearTimeout, URL, URLSearchParams,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang, userAgent: options.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' },
        crypto: { getRandomValues: (a: Uint8Array) => a },
        CSS: { escape: (v: string) => String(v) },
        API: api, Motion: { announce: noop, transition: (f: () => void) => { f(); return Promise.resolve(); }, markSkeleton: noop },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const file of [
        'dashboard/js/i18n.js', `dashboard/js/i18n.${lang}.js`, 'dashboard/js/components.js', 'dashboard/js/pages/welcome.js', 'dashboard/js/app.js',
    ]) {
        vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
    }
    vm.runInContext(`I18N.lang = '${lang}'`, ctx);
    const out = vm.runInContext('({ WelcomePage, App, UI, I18N, html })', ctx) as Omit<Loaded, 'ctx' | 'elements' | 'calls'>;
    return { ctx, elements, calls, ...out };
}

/** A value that crossed the vm boundary, as plain data (an array made inside the sandbox has the other realm's prototype). */
const plain = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

const PAYLOAD = '<img src=x onerror=alert(document.cookie)>';
const QUOTE_BREAK = '"><script>alert(1)</script><x y="';

/** No live tag, no live handler: the payload is text. */
function assertInert(markup: string, label: string): void {
    assert.ok(!markup.includes('<img src=x'), `${label}: no live img tag`);
    assert.ok(!markup.includes('<script'), `${label}: no live script tag`);
    // What is escaped is text, however much of it was cut short: take it out (up to the next real tag boundary) and nothing may be left.
    assert.ok(!/\son[a-z]+\s*=/i.test(markup.replace(/&lt;[^<>]*/g, '')), `${label}: no live handler`);
    assert.ok(!/"\s*>\s*<(script|img|x)\b/i.test(markup), `${label}: nothing broke out of an attribute`);
    assert.ok(!/javascript:/i.test(markup), `${label}: no javascript: address`);
    assert.ok(!/\sstyle="/.test(markup), `${label}: no inline style (colours are set from script, from validated hex only)`);
}

// ─── A profile and a state, with a payload in every field the page shows ─────────────────────────

const ORDER = WIZARD_STEPS.map((s) => ({ ...s }));

function onboarding(overrides: Record<string, unknown> = {}): Record<string, any> {
    const profile = defaultProfile({ lang: 'ar' }) as any;
    return {
        status: 'in_progress', step: 'about', order: ORDER, steps: {}, filledBy: null, profile, version: 1, stored: true, missing: [],
        hints: { name: 'Nour Shop', instagramUsername: 'nourshop', websiteUrl: 'https://nour.example' }, canEdit: true, draft: null,
        ...overrides,
    };
}

function hostile(): Record<string, any> {
    const profile = defaultProfile({ lang: 'ar' }) as any;
    profile.identity = { display_name: { ar: PAYLOAD, en: QUOTE_BREAK }, brand_name: PAYLOAD, kind: 'shop', role: PAYLOAD, niche: PAYLOAD, country: 'GB', timezone: 'Europe/London' };
    profile.offers = [{ id: 'main', kind: 'product', name: PAYLOAD, order_via: 'url', url: QUOTE_BREAK, price: PAYLOAD, facts: [PAYLOAD], bullets: [PAYLOAD], keyword: PAYLOAD, primary: true }];
    profile.voice = { ...profile.voice, tone: [PAYLOAD, QUOTE_BREAK] };
    profile.brand = { ...profile.brand, primary: PAYLOAD, accent: QUOTE_BREAK, theme: PAYLOAD, portrait_url: 'javascript:alert(1)', logo_url: PAYLOAD };
    profile.socials = { handle: PAYLOAD, site: QUOTE_BREAK, platforms: [], links: {} };
    profile.content = { ...profile.content, rules: [PAYLOAD, 'no_women_imagery'] };
    const everyField = {
        name: PAYLOAD, kind: PAYLOAD, niche: QUOTE_BREAK, offerName: PAYLOAD, orderVia: PAYLOAD, offerUrl: QUOTE_BREAK, price: PAYLOAD, country: PAYLOAD, timezone: PAYLOAD,
        register: PAYLOAD, tone: [PAYLOAD, QUOTE_BREAK, '<b>x</b>'], primary: PAYLOAD, accent: QUOTE_BREAK, theme: PAYLOAD, handle: PAYLOAD, site: QUOTE_BREAK,
        portraitUrl: 'javascript:alert(1)',
    };
    return onboarding({
        profile, version: 3, missing: [PAYLOAD],
        steps: { about: { values: everyField }, voice: { values: everyField }, brand: { values: everyField } },
        hints: { name: PAYLOAD, instagramUsername: QUOTE_BREAK, websiteUrl: PAYLOAD },
    });
}

function readyState(s: Loaded, step: string, onb: Record<string, any>): Record<string, any> {
    const { WelcomePage: P } = s;
    const state = P.freshState();
    state.phase = 'ready';
    state.onb = onb;
    state.step = step;
    state.values = P.STEPS[step].initial(onb, false);
    return state;
}

// ─── The sequence ────────────────────────────────────────────────────────────────────────────────

describe('the wizard\'s sequence follows the server and skips what is not built', () => {
    const s = load();
    const P = s.WelcomePage;

    it('shows the steps the server switched on that this page can draw, and nothing else', () => {
        assert.deepEqual(plain(P.stepOrder(onboarding())), ['about', 'voice', 'brand', 'done']);
        assert.deepEqual(plain(P.formSteps(onboarding())), ['about', 'voice', 'brand']);
        // The server is ahead of the page (a step enabled that has no renderer): it is left out, never drawn blank.
        const ahead = onboarding({ order: [...ORDER, { id: 'future', code: 'W9', required: false, enabled: true }].map((x) => (x.id === 'proof' ? { ...x, enabled: true } : x)) });
        assert.deepEqual(plain(P.stepOrder(ahead)), ['about', 'voice', 'brand', 'done'], 'proof has no renderer yet, and nor does an invented step');
        // W4 does have one (P28): switched on by the server, it is in the sequence, after W3.
        const connect = onboarding({ order: ORDER.map((x) => (x.id === 'connect' ? { ...x, enabled: true } : x)) });
        assert.deepEqual(plain(P.stepOrder(connect)), ['about', 'voice', 'brand', 'connect', 'done']);
    });

    it('is a seam: registering a step puts it in the sequence, in the server\'s place', () => {
        const t = load();
        t.WelcomePage.register('connect', { code: 'W4', required: false, skippable: true, title: () => 'c', lead: () => 'c', next: 'welcome.next', initial: () => ({}), read: () => ({}), problems: () => [], patch: () => ({}), fields: () => '' });
        const enabled = onboarding({ order: ORDER.map((x) => (x.id === 'connect' ? { ...x, enabled: true } : x)) });
        assert.deepEqual(plain(t.WelcomePage.stepOrder(enabled)), ['about', 'voice', 'brand', 'connect', 'done']);
        assert.deepEqual(plain(t.WelcomePage.progress(enabled, 'connect')), { index: 4, total: 4 }, 'and the count follows');
    });

    it('counts only the steps with something to fill in, and nothing on the last screen', () => {
        assert.deepEqual(plain(P.progress(onboarding(), 'about')), { index: 1, total: 3 });
        assert.deepEqual(plain(P.progress(onboarding(), 'brand')), { index: 3, total: 3 });
        assert.deepEqual(plain(P.progress(onboarding(), 'done')), { index: 0, total: 3 });
    });

    it('never lets a required step be passed over by the address', () => {
        const fresh = onboarding();
        assert.equal(P.firstOpen(fresh), 'about');
        assert.equal(P.reachable(fresh, 'about'), true);
        assert.equal(P.reachable(fresh, 'voice'), false);
        assert.equal(P.reachable(fresh, 'done'), false);
        assert.equal(P.reachable(fresh, 'nonsense'), false);
        const half = onboarding({ steps: { about: { status: 'done' } } });
        assert.equal(P.firstOpen(half), 'voice');
        assert.equal(P.reachable(half, 'about'), true, 'going back is allowed');
        assert.equal(P.reachable(half, 'voice'), true);
        assert.equal(P.reachable(half, 'brand'), false);
        const skipped = onboarding({ steps: { about: { status: 'done' }, voice: { status: 'done' }, brand: { status: 'skipped' } } });
        assert.equal(P.firstOpen(skipped), 'done');
        assert.equal(P.reachable(skipped, 'done'), true);
        assert.equal(P.reachable(onboarding({ status: 'completed' }), 'done'), true);
    });

    it('moves between steps by the order, with no Back from the first and no next after the last', () => {
        const o = onboarding();
        assert.equal(P.previousStep(o, 'about'), null);
        assert.equal(P.previousStep(o, 'voice'), 'about');
        assert.equal(P.nextStep(o, 'brand'), 'done');
        assert.equal(P.nextStep(o, 'done'), 'done');
    });

    it('agrees with the server about what follows each step', () => {
        for (const id of ['about', 'voice', 'brand'] as const) {
            assert.equal(P.nextStep(onboarding(), id), nextStepAfter(id), id);
        }
    });

    it('hides the bar while the keyboard is open: only a visual viewport that shrank counts', () => {
        assert.equal(P.keyboardOpen(800, 800), false);
        assert.equal(P.keyboardOpen(800, 790), false, 'a collapsing address bar is not a keyboard');
        assert.equal(P.keyboardOpen(800, 480), true);
        assert.equal(P.keyboardOpen(812, 500), true);
    });
});

// ─── The values ──────────────────────────────────────────────────────────────────────────────────

describe('what each step starts from, and what Continue sends', () => {
    const s = load();
    const P = s.WelcomePage;

    it('starts the first step from the operator\'s name, the device\'s zone and nothing invented', () => {
        const v = plain<Record<string, string>>(P.aboutInitial(onboarding(), false));
        assert.equal(v.name, 'Nour Shop');
        assert.equal(v.kind, '');
        assert.equal(v.niche, '');
        assert.equal(v.orderVia, 'url');
        assert.ok(P.isTimeZone(v.timezone), 'a real zone from the device (or UTC)');
    });

    it('prefers what was typed and not confirmed, then the profile, then the operator\'s hints', () => {
        const profile = defaultProfile({ lang: 'en' }) as any;
        profile.identity.display_name.en = 'From profile';
        profile.identity.niche = 'profile niche';
        const draft = { values: { name: 'From draft', niche: 'draft niche', kind: 'coach' } };
        const o = onboarding({ profile, steps: { about: draft } });
        const v = plain<Record<string, string>>(P.aboutInitial(o, false));
        assert.deepEqual([v.name, v.niche, v.kind], ['From draft', 'draft niche', 'coach']);
        const after409 = plain<Record<string, string>>(P.aboutInitial(o, true));
        assert.deepEqual([after409.name, after409.niche, after409.kind], ['From profile', 'profile niche', ''], 'after a conflict the profile wins');
        assert.equal(P.aboutInitial(onboarding({ profile }), false).name, 'From profile');
    });

    it('refuses a first step with a missing answer, naming each, and accepts a complete one', () => {
        const none = plain<Array<{ field: string; key: string }>>(P.aboutProblems({ orderVia: 'url' }));
        assert.deepEqual(none.map((p) => p.field), ['name', 'kind', 'niche', 'offerName', 'offerUrl', 'timezone']);
        const dm = plain<Array<{ field: string }>>(P.aboutProblems({ name: 'N', kind: 'shop', niche: 'x', offerName: 'y', orderVia: 'dm', timezone: 'Europe/London' }));
        assert.deepEqual(dm, [], 'people who message need no link');
        const bad = plain<Array<{ field: string }>>(P.aboutProblems({ name: 'N', kind: 'nonsense', niche: 'x', offerName: 'y', orderVia: 'url', offerUrl: 'javascript:alert(1)', timezone: 'Mars/Base' }));
        assert.deepEqual(bad.map((p) => p.field), ['kind', 'offerUrl', 'timezone']);
        const tooLong = plain<Array<{ field: string }>>(P.aboutProblems({ name: 'n'.repeat(41), kind: 'shop', niche: 'n'.repeat(121), offerName: 'o'.repeat(201), orderVia: 'dm', price: 'p'.repeat(61), timezone: 'UTC' }));
        assert.deepEqual(tooLong.map((p) => p.field), ['name', 'niche', 'offerName', 'price']);
    });

    it('completes an address the way people type it, and refuses anything that is not one', () => {
        assert.equal(P.normaliseUrl('shop.example/x'), 'https://shop.example/x');
        assert.equal(P.normaliseUrl('http://shop.example'), 'http://shop.example');
        assert.equal(P.normaliseUrl('  '), '');
        assert.equal(P.isUrl('https://shop.example/x'), true);
        for (const no of ['', 'javascript:alert(1)', 'ftp://x', 'https://', 'https://a b', 'data:text/html,x']) assert.equal(P.isUrl(no), false, no);
        assert.equal(P.cleanHandle('  @@Nour Shop '), 'NourShop');
        assert.equal(P.cleanHandle('x'.repeat(50)).length, 32);
        assert.equal(P.cleanSite('https://nour.example/'), 'nour.example');
        assert.equal(P.cleanSite('x'.repeat(80)).length, 40);
    });

    it('builds the first step\'s patch: a name in its own script, the kind\'s role, and a primary offer in place', () => {
        const patch = plain<any>(P.aboutPatch(
            { name: 'متجر نور', kind: 'shop', niche: 'Linen', offerName: 'Throw', orderVia: 'url', offerUrl: 'nour.example/t', price: '49 USD', country: 'GB', timezone: 'Europe/London' },
            defaultProfile({ lang: 'ar' })
        ));
        assert.deepEqual(patch.identity.display_name, { ar: 'متجر نور' }, 'only the script it is written in: the other is left alone');
        assert.equal(patch.identity.role, 'shop owner');
        assert.equal(patch.identity.brand_name, 'متجر نور');
        assert.equal(patch.identity.country, 'GB');
        assert.deepEqual(patch.offers.map((o: any) => [o.id, o.kind, o.name, o.order_via, o.url, o.primary]), [['main', 'product', 'Throw', 'url', 'https://nour.example/t', true]]);
    });

    it('keeps what an existing offer holds, and a role or brand name somebody wrote', () => {
        const profile = defaultProfile({ lang: 'en' }) as any;
        profile.identity.role = 'pastry chef';
        profile.identity.brand_name = 'Nour & Co';
        profile.offers = [
            { id: 'a', kind: 'service', name: 'Old', order_via: 'url', url: 'https://old.example', price: '', facts: ['fact'], bullets: ['b'], keyword: 'kw', primary: false },
            { id: 'b', kind: 'product', name: 'Main', order_via: 'url', url: 'https://main.example', price: '', facts: ['keep'], bullets: [], keyword: 'go', primary: true, campaign: { name_match: 'm', match: 'word', keywords: ['k'], dm_template: 'hi', public_replies: [] } },
        ];
        const patch = plain<any>(P.aboutPatch({ name: 'N', kind: 'coach', niche: 'n', offerName: 'Renamed', orderVia: 'dm', offerUrl: 'ignored.example', timezone: 'UTC' }, profile));
        assert.ok(!('role' in patch.identity), 'a role somebody wrote is not replaced');
        assert.ok(!('brand_name' in patch.identity), 'nor a brand name');
        assert.equal(patch.offers.length, 2);
        assert.equal(patch.offers[0].id, 'a');
        const main = patch.offers[1];
        assert.deepEqual([main.id, main.name, main.order_via, main.url, main.kind, main.keyword, main.facts, main.campaign.dm_template], ['b', 'Renamed', 'dm', '', 'product', 'go', ['keep'], 'hi']);
    });

    it('makes a role from the kind only while it is empty or one this page made', () => {
        const base = defaultProfile({ lang: 'en' }) as any;
        base.identity.role = 'coach';
        const patch = plain<any>(P.aboutPatch({ name: 'N', kind: 'agency', niche: 'n', offerName: 'o', orderVia: 'dm', timezone: 'UTC' }, base));
        assert.equal(patch.identity.role, 'agency', 'it follows the kind while it is one of ours');
    });

    it('starts the voice from the profile\'s register, or English, and sends language, register, digits and address together', () => {
        assert.equal(P.voiceInitial(onboarding(), false).register, 'msa');
        const en = defaultProfile({ lang: 'en' }) as any;
        assert.equal(P.voiceInitial(onboarding({ profile: en }), false).register, 'en');
        const toGulf = plain<any>(P.voicePatch({ register: 'gulf', tone: ['  Warm ', 'x'.repeat(40), '', 'a', 'b'] }, en));
        assert.deepEqual(toGulf.language, { primary: 'ar', register: 'gulf', digits: 'arabic-indic' });
        assert.equal(toGulf.voice.address, 'masc');
        assert.deepEqual(toGulf.voice.tone, ['Warm', 'x'.repeat(30), 'a'], 'at most three, trimmed, none empty');
        const stay = plain<any>(P.voicePatch({ register: 'egyptian', tone: [] }, defaultProfile({ lang: 'ar' })));
        assert.deepEqual(stay.language, { primary: 'ar', register: 'egyptian' }, 'staying Arabic changes no digits and no address');
        const toEn = plain<any>(P.voicePatch({ register: 'en', tone: [] }, defaultProfile({ lang: 'ar' })));
        assert.deepEqual(toEn.language, { primary: 'en', digits: 'latin' });
        assert.equal(toEn.voice.address, 'neutral');
        assert.deepEqual(plain(P.voiceProblems({})), [{ field: 'register', key: 'welcome.err.register' }]);
        assert.deepEqual(plain(P.voiceProblems({ register: 'gulf' })), []);
    });

    it('starts the brand from the profile, then the hints; refuses a colour that is not six digits; sends the portrait only when it is one of ours', () => {
        const b = plain<Record<string, string>>(P.brandInitial(onboarding(), false));
        assert.equal(b.handle, 'nourshop');
        assert.equal(b.site, 'nour.example');
        assert.equal(b.theme, 'dark');
        assert.deepEqual(plain(P.brandProblems({ primary: '#112233', accent: '#abcdef' })), []);
        assert.deepEqual(plain<any[]>(P.brandProblems({ primary: 'red', accent: '#12345', handle: 'h'.repeat(40), site: 's'.repeat(41) })).map((p) => p.field), ['primary', 'accent', 'handle', 'site']);
        const upload = 'https://app.example.test/api/uploads/11111111-1111-4111-8111-111111111111';
        const withPortrait = plain<any>(P.brandPatch({ primary: '#112233', accent: '#abcdef', theme: 'light', handle: '@nour', site: 'https://nour.example/', portraitUrl: upload }, defaultProfile({ lang: 'en' })));
        assert.deepEqual(withPortrait.brand, { primary: '#112233', accent: '#ABCDEF', theme: 'light', portrait_url: upload });
        assert.deepEqual(withPortrait.socials, { handle: 'nour', site: 'nour.example' });
        const refused = plain<any>(P.brandPatch({ primary: '#112233', accent: '#abcdef', theme: 'dark', portraitUrl: 'https://evil.example/x.png' }, defaultProfile({ lang: 'en' })));
        assert.ok(!('portrait_url' in refused.brand), 'an address that is not one of our uploads is never sent');
        const removed = defaultProfile({ lang: 'en' }) as any;
        removed.brand.portrait_url = upload;
        assert.equal(plain<any>(P.brandPatch({ primary: '#112233', accent: '#abcdef', theme: 'dark', portraitUrl: '' }, removed)).brand.portrait_url, null);
    });
});

describe('every patch the wizard builds is accepted by the real profile validator', () => {
    const P = load().WelcomePage;
    for (const lang of ['ar', 'en'] as const) {
        it(`a ${lang} tenant ends up with the six activation fields and a valid profile`, () => {
            let profile: any = defaultProfile({ lang });
            const apply = (patch: object): void => {
                const merged = mergePatch(profile, plain(patch));
                const checked = validateProfile(merged);
                assert.ok('profile' in checked, 'problems' in checked ? checked.problems.join('; ') : '');
                profile = checked.profile;
            };
            assert.ok(activationMissing(profile).length > 0);
            apply(P.aboutPatch({ name: lang === 'ar' ? 'متجر نور' : 'Nour Shop', kind: 'educator', niche: 'Baking for beginners', offerName: 'Beginner baking class', orderVia: 'url', offerUrl: 'nour.example/class', price: '49 USD', country: 'SA', timezone: 'Europe/London' }, profile));
            apply(P.voicePatch({ register: lang === 'ar' ? 'egyptian' : 'en', tone: ['Warm', 'Direct'] }, profile));
            apply(P.brandPatch({ primary: '#0E3B5C', accent: '#F2A33A', theme: 'dark', handle: 'nour', site: 'nour.example' }, profile));
            assert.deepEqual(activationMissing(profile), []);
            assert.equal(profile.offers.length, 1);
            assert.equal(profile.offers[0].primary, true);
        });
    }

    it('every kind makes a valid offer, and "they message me" needs no link', () => {
        for (const kind of ['educator', 'coach', 'shop', 'agency', 'creator']) {
            const profile: any = defaultProfile({ lang: 'ar' });
            const merged = mergePatch(profile, plain(P.aboutPatch({ name: 'N', kind, niche: 'n', offerName: 'o', orderVia: 'dm', timezone: 'UTC' }, profile)));
            const checked = validateProfile(merged);
            assert.ok('profile' in checked, kind);
            assert.equal(checked.profile.offers[0]!.order_via, 'dm');
            assert.equal(checked.profile.offers[0]!.url, '');
        }
    });

    it('every draft the page autosaves passes the server\'s own check, even from hostile text', () => {
        const values = { name: PAYLOAD, kind: 'shop', niche: QUOTE_BREAK, offerName: 'x'.repeat(5000), tone: [PAYLOAD, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'], nested: { a: 1 }, fn: () => 1, orderVia: 'dm', portraitUrl: '' };
        const payload = plain<Record<string, unknown>>(P.draftPayload(values));
        assert.equal(validateStepValues(payload), null);
        assert.ok(!('nested' in payload) && !('fn' in payload), 'only flat text, numbers, booleans and lists of text');
        assert.ok((payload.tone as string[]).length <= 10);
        assert.ok((payload.offerName as string).length <= 1000);
    });
});

// ─── Colour ──────────────────────────────────────────────────────────────────────────────────────

describe('the brand colours: only six hex digits reach the preview, and the contrast fix reads', () => {
    const P = load().WelcomePage;

    it('puts a colour in the page only when it is #RRGGBB', () => {
        assert.equal(P.safeHex('#0e3b5c', '#000000'), '#0E3B5C');
        for (const bad of ['red', '#12345', '#1234567', 'rgb(0,0,0)', 'url(javascript:alert(1))', 'red;background:url(x)', PAYLOAD, QUOTE_BREAK, '', null, undefined, 42]) {
            assert.equal(P.safeHex(bad, '#FALLBK'), '#FALLBK', String(bad));
        }
    });

    it('measures contrast like WCAG', () => {
        assert.ok(Math.abs(P.contrast('#000000', '#FFFFFF') - 21) < 0.01);
        assert.ok(Math.abs(P.contrast('#777777', '#777777') - 1) < 0.01);
        assert.equal(P.mix('#000000', '#FFFFFF', 0.5), '#808080');
    });

    it('draws the page the way the infographic template does: the primary mixed into black, or paper', () => {
        const dark = plain<any>(P.brandLook('#0E3B5C', '#F2A33A', 'dark'));
        assert.equal(dark.bg, P.mix('#0E3B5C', '#000000', 0.82));
        assert.equal(dark.accentInk, '#F2A33A');
        const light = plain<any>(P.brandLook('#0E3B5C', '#F2A33A', 'light'));
        assert.equal(light.bg, '#F7F6F2');
        assert.equal(light.accentInk, P.mix('#F2A33A', '#000000', 0.25));
        assert.deepEqual(plain(P.brandLook(PAYLOAD, QUOTE_BREAK, 'dark')), plain(P.brandLook('#0E3B5C', '#F2A33A', 'dark')), 'hostile colours fall back to the defaults');
    });

    it('flags a low-contrast highlight and fixes it to one that reads, on either page, and leaves a good one alone', () => {
        assert.ok(P.accentContrast('#0E3B5C', '#222222', 'dark') < 4.5);
        for (const theme of ['dark', 'light']) {
            for (const accent of ['#222222', '#F7F6F2', '#0E3B5C', '#808080', '#FFFF00']) {
                const fixed = P.fixContrast('#0E3B5C', accent, theme);
                assert.ok(P.accentContrast('#0E3B5C', fixed, theme) >= 4.5, `${accent} on ${theme} becomes ${fixed}`);
            }
        }
        assert.equal(P.fixContrast('#0E3B5C', '#F2A33A', 'dark'), '#F2A33A', 'the default already reads');
    });
});

// ─── Register samples ────────────────────────────────────────────────────────────────────────────

describe('the register cards say the same thing five ways', () => {
    const P = load().WelcomePage;

    it('names the offer in the middle of every sentence, and says "the link" until there is one', () => {
        for (const register of ['msa', 'gulf', 'egyptian', 'levantine', 'en']) {
            const named = plain<any>(P.registerSentence(register, 'Linen throw'));
            assert.equal(named.name, 'Linen throw', register);
            assert.ok(named.before.length > 0 && named.after.length > 0, register);
            const plainOne = plain<any>(P.registerSentence(register, ''));
            assert.equal(plainOne.name, '', register);
            assert.ok(plainOne.before.length > 0 && plainOne.after === '', register);
        }
        assert.ok(plain<any>(P.registerSentence('msa', '')).before.includes('الرابط'));
        assert.deepEqual(plain(P.registerSentence('klingon', 'x')), { before: '', name: '', after: '' });
    });

    it('keeps the offer\'s name in its own isolate, cut short, and in its own text', () => {
        const markup = String(P.registerSample('gulf', '<img src=x onerror=alert(1)>'));
        assertInert(markup, 'a sample');
        assert.match(markup, /<bdi dir="auto" class="welcome-sample-name">&lt;img src=x onerror=alert\(1\)&gt;<\/bdi>/);
        assertInert(String(P.registerSample('gulf', PAYLOAD)), 'a sample cut short');
        assert.match(markup, /lang="ar" dir="rtl"/, 'Arabic content carries its own language in either interface');
        assert.match(String(P.registerSample('en', 'x'.repeat(200))), /x{40}<\/bdi>/, 'cut at 40');
        assert.match(String(P.registerSample('en', 'x')), /lang="en" dir="ltr"/);
    });
});

// ─── Escaping ────────────────────────────────────────────────────────────────────────────────────

describe('the wizard escapes everything a person or the server supplied', () => {
    for (const lang of ['en', 'ar'] as const) {
        const s = load({ lang });
        const P = s.WelcomePage;
        const onb = hostile();

        for (const step of ['about', 'voice', 'brand', 'done']) {
            it(`${lang}: the ${step} step renders a payload in every field as text, with and without errors`, () => {
                const state = readyState(s, step, onb);
                const markup = String(P.view(state));
                assertInert(markup, step);
                // And in the states that add more of the server's words.
                const loud = readyState(s, step, onb);
                loud.problems = [PAYLOAD, QUOTE_BREAK];
                loud.notice = 'conflict';
                loud.errors = { name: 'welcome.err.name', kind: 'welcome.err.kind', niche: 'welcome.err.niche', register: 'welcome.err.register', primary: 'welcome.err.colour', accent: 'welcome.err.colour', offerUrl: 'welcome.err.url' };
                loud.tenants = [{ id: PAYLOAD, name: PAYLOAD }, { id: QUOTE_BREAK, name: QUOTE_BREAK }];
                loud.tenantId = PAYLOAD;
                loud.inApp = 'instagram';
                loud.rulesOpen = true;
                loud.save = 'error';
                assertInert(String(P.view(loud)), `${step} with errors`);
            });
        }

        it(`${lang}: the payload is visible as text where the person typed it`, () => {
            const state = readyState(s, 'about', onb);
            const markup = String(P.view(state));
            assert.match(markup, /value="&lt;img src=x onerror=alert\(document\.cookie\)&gt;"/, 'the name, in its attribute');
            const brand = String(P.view(readyState(s, 'brand', onb)));
            // The preview prints at most 40 characters of the name, so the payload may be cut: what is shown is still its escaped start.
            assert.ok(brand.includes('<span class="pv-name" dir="auto">&lt;img src=x onerror=alert('), 'the name on the preview, as text');
            const voice = String(P.view(readyState(s, 'voice', onb)));
            assert.ok(voice.includes('data-word="&lt;img src=x onerror=alert('), 'a tone word, in its attribute');
        });

        it(`${lang}: a hostile colour or portrait address never reaches the page`, () => {
            const state = readyState(s, 'brand', onb);
            state.values = { ...state.values, primary: PAYLOAD, accent: QUOTE_BREAK, portraitUrl: 'javascript:alert(1)' };
            const markup = String(P.view(state));
            assertInert(markup, 'brand');
            assert.ok(!markup.includes('<img src="javascript'), 'no portrait from a javascript: address');
            assert.match(markup, /type="color"[^>]*value="#0e3b5c"/, 'the picker falls back to a real colour');
        });

        it(`${lang}: the loading, failed and forbidden screens say only what they say`, () => {
            for (const phase of ['loading', 'failed', 'forbidden']) {
                const state = P.freshState();
                state.phase = phase;
                state.tenants = [{ id: PAYLOAD, name: PAYLOAD }];
                assertInert(String(P.view(state)), phase);
            }
        });
    }
});

// ─── The screen's structure ──────────────────────────────────────────────────────────────────────

describe('the screen is one column with one heading, a progress list, and a sticky bar with one primary action', () => {
    const s = load({ lang: 'en' });
    const P = s.WelcomePage;

    it('has exactly one h1, the step marked as current, and the bar\'s button bound to the form', () => {
        const markup = String(P.view(readyState(s, 'about', onboarding())));
        assert.equal((markup.match(/<h1\b/g) ?? []).length, 1, 'one h1');
        assert.match(markup, /<h1 class="welcome-title" id="welcome-title" tabindex="-1">Tell us about you<\/h1>/);
        assert.equal((markup.match(/aria-current="step"/g) ?? []).length, 1);
        assert.match(markup, /<ol class="welcome-steps">/);
        assert.match(markup, /Step 1 of 3/);
        assert.match(markup, /<button type="submit" form="welcome-form" class="btn btn-primary btn-full" id="welcome-next">/);
        assert.equal((markup.match(/btn-primary/g) ?? []).length, 1, 'one primary action');
        assert.match(markup, /id="welcome-save" role="status" aria-live="polite"/, 'the save state is a live region');
        assert.ok(!/data-action="welcome:back"/.test(markup), 'no Back on the first step');
    });

    it('offers Back after the first step, Skip only where a step can be skipped, and the last screen has a button that is not a submit', () => {
        const voice = String(P.view(readyState(s, 'voice', onboarding({ steps: { about: { status: 'done' } } }))));
        assert.match(voice, /data-action="welcome:back"/);
        assert.ok(!/welcome:skip/.test(voice), 'the voice cannot be skipped');
        const brand = String(P.view(readyState(s, 'brand', onboarding({ steps: { about: { status: 'done' }, voice: { status: 'done' } } }))));
        assert.match(brand, /data-action="welcome:skip"/);
        assert.match(brand, /Use these colours/);
        const done = String(P.view(readyState(s, 'done', onboarding({ status: 'completed' }))));
        assert.match(done, /data-action="welcome:goDashboard"/);
        assert.ok(!/form="welcome-form"/.test(done) && !/data-action="welcome:back"/.test(done));
        assert.match(done, /All set/);
    });

    it('says what is waiting on the last screen, without claiming it works', () => {
        const done = String(P.view(readyState(s, 'done', onboarding({ status: 'completed' }))));
        assert.match(done, /coming soon/);
        assert.ok((done.match(/is-waiting/g) ?? []).length === 2, 'connecting accounts and the sample replies');
        assert.match(done, /No images of women in generated content/, 'the content rule is shown plainly');
    });

    it('draws no step\'s form on the failed, loading or forbidden screens, and no bar', () => {
        for (const phase of ['loading', 'failed', 'forbidden']) {
            const state = P.freshState();
            state.phase = phase;
            const markup = String(P.view(state));
            assert.ok(!/welcome-bar/.test(markup) && !/<form/.test(markup), phase);
        }
    });

    it('is not offered to a tenant switcher with one workspace, and is with two', () => {
        const state = readyState(s, 'about', onboarding());
        state.tenants = [{ id: 'a', name: 'One' }];
        assert.ok(!/welcome-tenant-select/.test(String(P.view(state))));
        state.tenants = [{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }];
        state.tenantId = 'b';
        assert.match(String(P.view(state)), /<option value="b" selected>Two<\/option>/);
    });

    it('carries the language toggle and the in-app note only where they belong', () => {
        const state = readyState(s, 'about', onboarding());
        assert.match(String(P.view(state)), /data-lang-toggle/);
        assert.ok(!/inapp-hint/.test(String(P.view(state))));
        state.inApp = 'instagram';
        assert.match(String(P.view(state)), /You opened this inside Instagram\./);
    });
});

// ─── The in-app browser note ─────────────────────────────────────────────────────────────────────

describe('the in-app browser note', () => {
    const { UI } = load();

    it('tells Instagram, Facebook and WhatsApp\'s own browsers by what they say, and no other', () => {
        const cases: Array<[string, string]> = [
            ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Mobile/21F90 Instagram 340.0.1.20.89 (iPhone15,2)', 'instagram'],
            ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36 Instagram 340.0.0.0 Android', 'instagram'],
            ['Mozilla/5.0 (iPhone) Mobile/15E148 [FBAN/FBIOS;FBAV/455.0;FBBV/1]', 'facebook'],
            ['Mozilla/5.0 (Linux; Android 13) Chrome/124 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0]', 'facebook'],
            ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Mobile/15E148 WhatsApp/24.10', 'whatsapp'],
            ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1', ''],
            ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125 Mobile Safari/537.36', ''],
            ['', ''],
        ];
        for (const [ua, expected] of cases) assert.equal(UI.inAppBrowser(ua), expected, ua);
        assert.equal(UI.inAppBrowser(undefined), '', 'a page with no user agent says nothing');
    });

    it('is shown once per tab: closing it is remembered', () => {
        const s = load({ lang: 'ar' });
        assert.match(String(s.UI.inAppHint('whatsapp')), /فتحت هذا الرابط داخل واتساب\./);
        const note = element();
        note.remove = () => { note.classes.add('removed'); };
        s.UI._actions.ui.dismissInAppHint({ closest: () => note });
        assert.equal(s.ctx.sessionStorage.getItem('inapp_hint_dismissed'), '1');
        assert.ok(note.classes.has('removed'));
        assert.equal(String(s.UI.inAppHint('whatsapp')), '', 'and it stays closed on the next screen');
    });

    it('draws nothing for an app it does not know, and never puts what it was given into the page', () => {
        const s = load();
        for (const app of ['', 'tiktok', PAYLOAD, undefined, null]) assert.equal(String(s.UI.inAppHint(app)), '', String(app));
    });
});

// ─── The gate and the routes ─────────────────────────────────────────────────────────────────────

const OWNER_COMPLETED = { userId: 'u', role: 'user', tenantId: 't', tenantRole: 'owner', tenants: [{ id: 't', name: 'T', role: 'owner' }], onboarding: { status: 'completed', step: 'done', gated: false }, available: true };
const NEW_OWNER = { ...OWNER_COMPLETED, onboarding: { status: 'in_progress', step: 'about', gated: true } };

describe('the navigate gate', () => {
    it('sends an owner of an unfinished tenant to the wizard, and nobody else', () => {
        const { App } = load();
        const gated = (session: unknown): boolean => { App.session = session; return App.mustOnboard(); };
        assert.equal(gated(NEW_OWNER), true);
        assert.equal(gated({ ...NEW_OWNER, role: 'platform_admin' }), false, 'a platform admin is exempt');
        assert.equal(gated(OWNER_COMPLETED), false, 'the owner\'s tenant is completed');
        assert.equal(gated({ ...OWNER_COMPLETED, onboarding: { status: 'completed', step: 'done', gated: true } }), false, 'completed is never gated, whatever else is said');
        assert.equal(gated({ ...NEW_OWNER, tenantRole: 'operator', onboarding: { status: 'in_progress', step: 'about', gated: false } }), false, 'an operator is never held');
        assert.equal(gated({ ...NEW_OWNER, onboarding: null }), false, 'a server that could not say gates nothing');
        assert.equal(gated({ ...NEW_OWNER, available: false }), false, 'nor an older deployment');
        assert.equal(gated(null), false);
    });

    it('opens the wizard for a platform admin only with ?mode=behalf, and never for a completed tenant\'s owner by typing the address', () => {
        const { App, ctx } = load();
        const wants = (session: unknown, hash: string): boolean => { App.session = session; ctx.location.hash = hash; return App.wantsWelcome(); };
        assert.equal(wants({ ...NEW_OWNER, role: 'platform_admin' }, '#/welcome'), false);
        assert.equal(wants({ ...NEW_OWNER, role: 'platform_admin' }, '#/welcome?mode=behalf'), true);
        assert.equal(wants({ ...NEW_OWNER, role: 'platform_admin' }, '#/overview?mode=behalf'), false);
        assert.equal(wants(OWNER_COMPLETED, '#/welcome'), false, 'the owner types #/welcome and is not shown the wizard');
        assert.equal(wants(OWNER_COMPLETED, '#/welcome?mode=behalf'), false, 'and ?mode=behalf is for platform admins');
        assert.equal(wants(NEW_OWNER, '#/overview'), true);
    });

    it('navigate() sends a gated session to the wizard before it loads a page', async () => {
        const { App } = load();
        const shown: string[] = [];
        App.showWelcome = () => { shown.push('welcome'); return Promise.resolve(); };
        App.loadPageModule = () => { shown.push('page'); return Promise.resolve(null); };
        App.session = NEW_OWNER;
        await App.navigate('campaigns');
        assert.deepEqual(shown, ['welcome']);
        App.session = OWNER_COMPLETED;
        App.needsSetup = () => true;
        App.renderSetup = () => { shown.push('setup'); };
        App.markNavItem = () => {};
        App.moveNavIndicator = () => {};
        await App.navigate('campaigns');
        assert.ok(!shown.slice(1).includes('welcome'), 'a completed tenant is not sent anywhere');
    });

    it('showApp() reads the session first: a gated tenant never sees the dashboard, and the owner never sees the wizard', async () => {
        for (const [me, expectsWizard] of [[NEW_OWNER, true], [OWNER_COMPLETED, false]] as const) {
            const s = load({ api: { getMe: () => Promise.resolve({ userId: 'u', role: me.role, tenantId: 't', tenantRole: me.tenantRole, tenants: me.tenants, onboarding: me.onboarding }) } });
            const { App, elements } = s;
            const events: string[] = [];
            App.showWelcome = () => { events.push('welcome'); return Promise.resolve(); };
            App.applyChrome = () => {};
            App.navigate = () => { events.push(`navigate ${elements.app!.classes.has('hidden') ? 'hidden' : 'shown'}`); return Promise.resolve(); };
            await App.showApp();
            if (expectsWizard) {
                assert.deepEqual(events, ['welcome']);
                assert.ok(elements.app!.classes.has('hidden'), 'the app was never shown');
            } else {
                assert.deepEqual(events, ['navigate shown']);
            }
        }
    });

    it('an unfinished tenant\'s typed #/welcome opens the wizard, and a completed one\'s does not', async () => {
        const open = async (me: typeof NEW_OWNER): Promise<boolean> => {
            const s = load({ hash: '#/welcome', api: { getMe: () => Promise.resolve(me) } });
            let welcome = false;
            s.App.showWelcome = () => { welcome = true; return Promise.resolve(); };
            s.App.applyChrome = () => {};
            s.App.navigate = () => Promise.resolve();
            await s.App.showApp();
            return welcome;
        };
        assert.equal(await open(NEW_OWNER), true);
        assert.equal(await open(OWNER_COMPLETED), false);
    });

    it('showWelcome() leaves the other screens hidden, takes the address to #/welcome, and starts the page', async () => {
        const s = load({ hash: '#/campaigns' });
        let started = 0;
        s.App.loadPageModule = () => Promise.resolve({ start: () => { started += 1; } });
        s.App.session = NEW_OWNER;
        s.elements['login-screen']!.classes.delete('hidden');
        await s.App.showWelcome();
        assert.ok(s.elements['login-screen']!.classes.has('hidden') && s.elements.app!.classes.has('hidden') && s.elements['invite-screen']!.classes.has('hidden'));
        assert.ok(!s.elements['welcome-screen']!.classes.has('hidden'));
        assert.deepEqual(s.ctx.history.calls, ['replace #/welcome']);
        assert.equal(started, 1);
    });

    it('a hash change inside the wizard goes to the wizard; one that leaves it goes back through the gate', () => {
        const s = load({ hash: '#/welcome?step=voice' });
        s.elements['welcome-screen']!.classes.delete('hidden');
        s.App.session = NEW_OWNER;
        let handled = 0;
        s.App.pages.welcome.page = () => ({ onHashChange: () => { handled += 1; } });
        const events: string[] = [];
        s.App.showApp = () => { events.push('showApp'); };
        s.App.onHashChange();
        assert.equal(handled, 1);
        s.ctx.location.hash = '#/campaigns';
        s.App.onHashChange();
        assert.deepEqual(events, ['showApp'], 'left by the address bar: whatever the gate says');
    });

    it('is not a routable page, so an app page can never resolve to it', () => {
        const { App, ctx } = load();
        assert.equal(App.pages.welcome.routable, false);
        for (const hash of ['#/welcome', '#/welcome?step=voice']) {
            ctx.location.hash = hash;
            assert.equal(App.pageFromHash(), 'overview', hash);
        }
    });
});

describe('the invite link, in either spelling, and where a finished link lands', () => {
    const TOKEN = 'A'.repeat(43);

    it('accepts #/invite?t=… (P17) and #/welcome?invite=… (the spec), and a bare #/welcome is the wizard', () => {
        const { App, ctx } = load();
        const is = (hash: string): boolean => { ctx.location.hash = hash; return App.isInviteHash(); };
        for (const yes of ['#/invite', `#/invite?t=${TOKEN}`, `#/welcome?invite=${TOKEN}`, `#/welcome?lang=ar&invite=${TOKEN}`, `#/welcome?invite=${TOKEN}&lang=en`]) assert.equal(is(yes), true, yes);
        for (const no of ['#/welcome', '#/welcome?step=voice', '#/welcome?mode=behalf', '#/welcomed?invite=x', '#/overview?invite=x', '#welcome?invite=x']) assert.equal(is(no), false, no);
    });

    it('moves the token out of the address bar whichever way the link spells it', () => {
        for (const hash of [`#/invite?t=${TOKEN}&lang=ar`, `#/welcome?invite=${TOKEN}&lang=ar`]) {
            const { App, ctx } = load({ hash });
            App.captureInvite();
            assert.deepEqual(ctx.history.calls, ['replace #/invite'], hash);
            assert.equal(ctx.sessionStorage.getItem('invite_token'), TOKEN, hash);
            assert.equal(App.inviteToken(), TOKEN);
        }
    });

    it('takes a tenant that has not finished into the wizard, and anybody else to the dashboard', async () => {
        const landing = async (result: Record<string, unknown>): Promise<string> => {
            const s = load({ hash: '#/invite' });
            s.App.showApp = () => Promise.resolve();
            await s.App.completeInvite({ token: 't', email: 'a@b.co', purpose: 'join', ...result }, 'a@b.co');
            return s.ctx.history.calls.at(-1)!;
        };
        assert.equal(await landing({ onboarding: { status: 'in_progress' } }), 'replace #/welcome');
        assert.equal(await landing({ onboarding: { status: 'invited' } }), 'replace #/welcome');
        assert.equal(await landing({ onboarding: { status: 'completed' } }), 'replace #/overview', 'a second member of a finished tenant');
        assert.equal(await landing({ onboarding: { status: 'in_progress' }, purpose: 'reset' }), 'replace #/overview', 'a password reset is not onboarding');
        assert.equal(await landing({}), 'replace #/overview', 'an older server that says nothing');
    });

    it('the head script hides the login card for either spelling, and takes the language from the invite only', () => {
        const index = readFileSync('dashboard/index.html', 'utf8');
        const head = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).find((x) => x.includes('data-invite'))!;
        const run = (hash: string): { invite: boolean; lang: string | null } => {
            const attrs: Record<string, string> = {};
            const stored = new Map<string, string>();
            const ctx: Record<string, any> = {
                location: { hash },
                localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); } },
                navigator: { languages: [], language: '' },
                document: {
                    documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } },
                    createElement: () => ({ setAttribute: () => undefined }), head: { appendChild: () => undefined },
                },
            };
            vm.createContext(ctx);
            vm.runInContext(head, ctx);
            return { invite: 'data-invite' in attrs, lang: stored.get('dashboard_lang') ?? null };
        };
        assert.deepEqual(run(`#/welcome?invite=${TOKEN}&lang=en`), { invite: true, lang: 'en' });
        assert.deepEqual(run(`#/invite?t=${TOKEN}&lang=ar`), { invite: true, lang: 'ar' });
        assert.deepEqual(run('#/welcome'), { invite: false, lang: null });
        assert.deepEqual(run('#/welcome?step=voice&lang=en'), { invite: false, lang: null }, 'a language in a plain wizard address is not an invite\'s');
        assert.match(index, /'invite', 'welcome'\]/, 'the preloader knows the page');
        assert.match(index, /<div id="welcome-screen" class="login-screen welcome-screen hidden">/);
        assert.match(index, /<div id="welcome-root" class="welcome-root"><\/div>/);
    });
});

// ─── Running the steps (the page's own logic, with a stand-in for the screen and the server) ────

describe('Continue, the 409 path, Skip and Finish', () => {
    const STATE_STEPS = { about: {}, voice: {}, brand: {} };

    /** A page in the state of having its first step filled in, with every call to the server recorded. */
    function fixture(options: { api?: Record<string, (...a: any[]) => any>; step?: string; onb?: Record<string, any>; values?: Record<string, any> } = {}) {
        const s = load({ api: options.api });
        const P = s.WelcomePage;
        P.paint = () => undefined;
        const onb = options.onb ?? onboarding({ steps: { ...STATE_STEPS } });
        const step = options.step ?? 'about';
        P.state = P.freshState();
        P.state.phase = 'ready';
        P.state.onb = onb;
        P.state.step = step;
        P.state.values = options.values ?? { name: 'Nour', kind: 'shop', niche: 'Linen', offerName: 'Throw', orderVia: 'dm', offerUrl: '', price: '', country: '', timezone: 'Europe/London' };
        P.collect = () => P.state.values;
        P.flush = () => Promise.resolve();
        return { s, P, onb, names: () => s.calls.map((c) => c.fn) };
    }

    it('writes the profile, marks the step, and shows the next one, in that order', async () => {
        const fx = fixture({
            api: {
                patchProfile: (version: number, patch: any) => Promise.resolve({ profile: mergePatch(onboarding().profile, plain(patch)), version: version + 1, stored: true, activationMissing: [] }),
                saveOnboardingStep: (_step: string, body: any) => Promise.resolve({ status: 'in_progress', step: 'voice', steps: body.status ? { about: { status: 'done' } } : {} }),
            },
        });
        await fx.P.submit();
        assert.deepEqual(fx.names(), ['patchProfile', 'saveOnboardingStep', 'saveOnboardingStep']);
        assert.equal(fx.s.calls[0]!.args[0], 1, 'against the version the page last read');
        assert.deepEqual(plain(fx.s.calls[1]!.args), ['about', { status: 'done' }]);
        assert.deepEqual(plain(fx.s.calls[2]!.args), ['voice', { viewed: true }], 'the next step tells the server it is on screen');
        assert.equal(fx.P.state.step, 'voice');
        assert.equal(fx.P.state.onb.version, 2);
        assert.deepEqual(plain(fx.s.ctx.history.calls), ['push #/welcome?step=voice']);
    });

    it('sends nothing while an answer is missing, and says which', async () => {
        const fx = fixture({ values: { name: '', kind: '', niche: '', offerName: '', orderVia: 'url', offerUrl: '', price: '', country: '', timezone: 'UTC' } });
        await fx.P.submit();
        assert.deepEqual(fx.names(), []);
        assert.deepEqual(Object.keys(fx.P.state.errors).sort(), ['kind', 'name', 'niche', 'offerName', 'offerUrl']);
        assert.equal(fx.P.state.step, 'about');
    });

    it('on a 409: reloads the step, shows the newer values and a note, does not mark it done, and keeps the newer values as the draft', async () => {
        const newer = defaultProfile({ lang: 'en' }) as any;
        newer.identity.niche = 'the admin wrote this';
        newer.identity.display_name.en = 'Written by the admin';
        const fx = fixture({
            api: {
                patchProfile: () => Promise.reject(Object.assign(new Error('stale'), { status: 409, body: { code: 'PROFILE_VERSION_CONFLICT', currentVersion: 2 } })),
                getOnboarding: () => Promise.resolve(onboarding({ profile: newer, version: 2, steps: { about: { values: { name: 'old typing', niche: 'old niche' } } } })),
                saveOnboardingStep: () => Promise.resolve({ steps: {} }),
            },
        });
        await fx.P.submit();
        assert.deepEqual(fx.names(), ['patchProfile', 'getOnboarding', 'saveOnboardingStep', 'saveOnboardingStep']);
        assert.ok(!fx.s.calls.some((c) => c.fn === 'saveOnboardingStep' && (c.args[1] as any).status === 'done'), 'a stale Continue never marks the step done');
        assert.equal(fx.P.state.notice, 'conflict');
        assert.equal(fx.P.state.step, 'about');
        assert.equal(fx.P.state.onb.version, 2);
        assert.equal(fx.P.state.values.niche, 'the admin wrote this', 'the profile\'s newer values, not the stale draft');
        assert.equal(fx.P.state.values.name, 'Written by the admin');
        const view = String(fx.P.view(fx.P.state));
        assert.match(view, /Someone updated this while you were editing/);
        // The draft that is saved after the reload is the newer values, so the old typing does not come back.
        const resave = fx.s.calls.filter((c) => c.fn === 'saveOnboardingStep').at(-1)!.args[1] as any;
        assert.equal(resave.values.niche, 'the admin wrote this');
    });

    it('shows the server\'s own problems when it refuses the answers, and does not move on', async () => {
        const fx = fixture({
            api: { patchProfile: () => Promise.reject(Object.assign(new Error('bad'), { status: 400, body: { code: 'PROFILE_INVALID', problems: ['identity.niche is too long', PAYLOAD] } })) },
        });
        await fx.P.submit();
        assert.deepEqual(fx.names(), ['patchProfile']);
        assert.deepEqual(plain(fx.P.state.problems), ['identity.niche is too long', PAYLOAD]);
        assertInert(String(fx.P.view(fx.P.state)), 'problems');
        assert.equal(fx.P.state.step, 'about');
    });

    it('does not mark a step done when the profile write failed for any other reason', async () => {
        const fx = fixture({ api: { patchProfile: () => Promise.reject(Object.assign(new Error('boom'), { status: 500, body: {} })) } });
        await fx.P.submit();
        assert.deepEqual(fx.names(), ['patchProfile']);
        assert.equal(fx.P.state.step, 'about');
        assert.equal(fx.P.state.busy, false, 'and the page can be used again');
    });

    it('Skip marks the step skipped and moves on, and the last screen finishes the setup', async () => {
        const fx = fixture({
            step: 'brand',
            onb: onboarding({ steps: { about: { status: 'done' }, voice: { status: 'done' } } }),
            api: {
                saveOnboardingStep: (_s: string, body: any) => Promise.resolve({ status: 'in_progress', step: 'done', steps: body.status ? { brand: { status: 'skipped' } } : {} }),
                completeOnboarding: () => Promise.resolve({ status: 'completed', alreadyCompleted: false, step: 'done' }),
            },
        });
        await fx.P.skip(element());
        assert.deepEqual(fx.s.calls.map((c) => [c.fn, c.args[0], (c.args[1] as any)?.status]), [['saveOnboardingStep', 'brand', 'skipped'], ['completeOnboarding', undefined, undefined]]);
        assert.equal(fx.P.state.step, 'done');
        assert.equal(fx.P.state.onb.status, 'completed');
        assert.equal(fx.P.state.finishing, false);
    });

    it('Finish asks the server once per visit, and a finished tenant is not asked again', async () => {
        const done = fixture({ step: 'done', onb: onboarding({ status: 'completed' }) });
        await done.P.enterDone();
        assert.deepEqual(done.names(), []);
    });

    it('Finish refused for a missing answer takes the person back to the step that owns it, with a note', async () => {
        const fx = fixture({
            step: 'done',
            onb: onboarding({ steps: { about: { status: 'done' }, voice: { status: 'done' }, brand: { status: 'done' } } }),
            api: {
                completeOnboarding: () => Promise.reject(Object.assign(new Error('missing'), { status: 409, body: { code: 'ONBOARDING_INCOMPLETE', missing: ['identity.kind'], fixStep: 'about' } })),
                saveOnboardingStep: () => Promise.resolve({ steps: {} }),
            },
        });
        await fx.P.enterDone();
        assert.equal(fx.P.state.step, 'about');
        assert.equal(fx.P.state.notice, 'missing');
        assert.equal(fx.P.state.finishing, false);
    });

    it('Finish that fails for another reason says so and offers a retry', async () => {
        const fx = fixture({ step: 'done', onb: onboarding(), api: { completeOnboarding: () => Promise.reject(Object.assign(new Error('down'), { status: 503, body: {} })) } });
        await fx.P.enterDone();
        assert.equal(fx.P.state.finishFailed, true);
        assert.match(String(fx.P.view(fx.P.state)), /data-action="welcome:retryFinish"/);
    });

    it('a session that died mid-step says nothing of its own: the login is already up', async () => {
        const fx = fixture({ api: { patchProfile: () => Promise.reject(Object.assign(new Error('expired'), { status: 401 })) } });
        let toasts = 0;
        fx.s.UI.toast = () => { toasts += 1; };
        await fx.P.submit();
        assert.equal(toasts, 0);
    });

    it('autosave sends one flat draft per step, never the profile, in order', async () => {
        const fx = fixture({ api: { saveOnboardingStep: () => Promise.resolve({ steps: { about: { values: {} } } }) } });
        fx.P.state.values = { name: 'Nour', tone: ['Warm'], nested: { a: 1 } };
        fx.P.setSave = () => undefined;
        await fx.P.saveDraft();
        await fx.P.saveDraft();
        assert.deepEqual(fx.names(), ['saveOnboardingStep', 'saveOnboardingStep']);
        const body = fx.s.calls[0]!.args[1] as any;
        assert.deepEqual(Object.keys(body), ['values']);
        assert.equal(validateStepValues(plain(body.values)), null);
        assert.ok(!('nested' in body.values));
    });

    it('opens at the step the server says, or the one the address asks for if the person may see it', async () => {
        const open = async (onb: Record<string, any>, hash: string) => {
            const s = load({ hash, api: { getOnboarding: () => Promise.resolve(onb), saveOnboardingStep: () => Promise.resolve({}) } });
            s.WelcomePage.paint = () => undefined;
            s.WelcomePage.state = s.WelcomePage.freshState();
            await s.WelcomePage.load();
            return s.WelcomePage.state;
        };
        const half = onboarding({ step: 'voice', steps: { about: { status: 'done' } } });
        assert.equal((await open(half, '#/welcome')).step, 'voice');
        assert.equal((await open(half, '#/welcome?step=about')).step, 'about', 'going back is allowed');
        assert.equal((await open(half, '#/welcome?step=brand')).step, 'voice', 'but not past a step that is still open');
        assert.equal((await open(half, '#/welcome?step=<script>')).step, 'voice');
        assert.equal((await open(onboarding({ canEdit: false }), '#/welcome')).phase, 'forbidden', 'only an owner finishes the setup');
        assert.equal((await open(onboarding({ status: 'completed', step: 'done' }), '#/welcome')).step, 'done');
    });
});

// ─── The copy and the stylesheet ─────────────────────────────────────────────────────────────────

describe('the copy: every key exists in both languages with the same placeholders', () => {
    const source = readFileSync('dashboard/js/pages/welcome.js', 'utf8') + readFileSync('dashboard/js/components.js', 'utf8');
    const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const code = strip(source);

    function dictionary(lang: 'ar' | 'en'): Record<string, string> {
        const ctx: Record<string, any> = {};
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        vm.runInContext(readFileSync(`dashboard/js/i18n.${lang}.js`, 'utf8'), ctx);
        return ctx.I18N_DICT[lang];
    }
    const ar = dictionary('ar');
    const en = dictionary('en');

    const literal = [...new Set([...code.matchAll(/\bt\(\s*'((?:welcome|inapp)\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]!))];
    const tableKeys = [...new Set([...code.matchAll(/'((?:welcome|inapp)\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]!))];
    const families = [
        ...['educator', 'coach', 'shop', 'agency', 'creator'].flatMap((k) => [`welcome.kind.${k}`, `welcome.kind.${k}.hint`]),
        ...['msa', 'gulf', 'egyptian', 'levantine', 'en'].map((r) => `welcome.register.${r}`),
        ...['about', 'voice', 'brand', 'done'].map((x) => `welcome.step.${x}`),
        ...['instagram', 'facebook', 'whatsapp'].map((a) => `inapp.app.${a}`),
    ];

    it('finds the page\'s keys at all', () => {
        assert.ok(literal.length > 60, `${literal.length} literal keys`);
    });

    it('has every key the page names, in both dictionaries', () => {
        for (const key of [...new Set([...literal, ...tableKeys, ...families])]) {
            assert.ok(key in en, `${key} is missing in English`);
            assert.ok(key in ar, `${key} is missing in Arabic`);
        }
    });

    it('uses the same placeholders in both, and no Arabic-Indic digits in Arabic', () => {
        const names = (value: string): string => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
        for (const key of Object.keys(en).filter((k) => /^(welcome|inapp)\./.test(k))) {
            assert.equal(names(ar[key]!), names(en[key]!), key);
            assert.ok(!/[٠-٩۰-۹]/.test(ar[key]!), `${key} has Arabic-Indic digits`);
        }
    });

    it('never says "pro" "premium" "instant" or "guaranteed", and never invents a number', () => {
        for (const [key, value] of Object.entries(en).filter(([k]) => /^(welcome|inapp)\./.test(k))) {
            assert.ok(!/\b(premium|instant|instantly|guaranteed|supercharge)\b/i.test(value), `${key}: ${value}`);
            assert.ok(!/!/.test(value), `${key}: English has no exclamation marks`);
        }
    });

    it('writes the Arabic interface in the standard register, not a dialect', () => {
        for (const [key, value] of Object.entries(ar).filter(([k]) => /^(welcome|inapp)\./.test(k) && !/^welcome\.register\./.test(k))) {
            assert.ok(!/(?:^|\s)(?:عايز|ازاي|دلوقتي|هلا|شلونك|وين|ليش|شو)(?:\s|$)/.test(value), `${key}: ${value}`);
        }
    });
});

describe('the stylesheet: logical properties, the bar, and the keyboard', () => {
    const css = readFileSync('dashboard/css/styles.css', 'utf8');
    const start = css.indexOf('/* ─── The setup wizard');
    const end = css.indexOf('@media (min-width: 40rem) {', start);
    const block = css.slice(start, end);

    it('finds the wizard\'s block', () => {
        assert.ok(start > 0 && end > start);
        assert.match(block, /\.welcome-root \{/);
    });

    it('uses logical properties only: it reads the same in Arabic and English', () => {
        const physical = block.match(/(?<![\w-])(margin|padding|border)-(left|right)\b|(?<![\w-])(left|right|top|bottom)\s*:|text-align:\s*(left|right)\b|(?<![\w-])(width|height|min-width|min-height|max-width|max-height)\s*:/g);
        assert.deepEqual(physical, null, `physical properties: ${physical}`);
    });

    it('holds no colour of its own: tokens, and custom properties set from script', () => {
        assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block.replace(/\/\*[\s\S]*?\*\//g, '')), 'no hex literal');
        assert.ok(!/\brgba?\(|\bhsla?\(/.test(block.replace(/\/\*[\s\S]*?\*\//g, '')), 'no rgb() or hsl() literal');
    });

    it('sticks the bar to the bottom with the safe area, and hides it while the keyboard is open', () => {
        assert.match(block, /\.welcome-bar \{[^}]*position: sticky;[^}]*inset-block-end: 0;/);
        assert.match(block, /\.welcome-bar \{[^}]*env\(safe-area-inset-bottom\)/);
        assert.match(block, /\.welcome-screen\.kb-open \.welcome-bar \{ display: none; \}/);
        assert.match(block, /\.welcome-top \{[^}]*env\(safe-area-inset-top\)/);
    });

    it('keeps every control at 44px', () => {
        for (const selector of ['.welcome-link', '.welcome-choice-body', '.welcome-chip', '.welcome-swatch']) {
            const rule = new RegExp(`${selector.replace('.', '\\.')} \\{[^}]*var\\(--tap-target\\)`).exec(block);
            assert.ok(rule, `${selector} sets a 44px target`);
        }
    });

    it('shows selected and focused separately, and lets a focused selected card show both', () => {
        assert.match(block, /\.welcome-choice-input:checked \+ \.welcome-choice-body \{[^}]*inset 0 0 0 2px var\(--accent\)/);
        assert.match(block, /\.welcome-choice-input:focus-visible \+ \.welcome-choice-body \{[^}]*outline: 2px solid var\(--accent\)/);
        assert.match(block, /\.welcome-choice-input:checked:focus-visible \+ \.welcome-choice-body/);
    });

    it('extends the shared patterns instead of making one-offs', () => {
        assert.match(css, /\.help-callout, \.welcome-notice, \.inapp-hint \{/);
        assert.match(css, /\.help-qa-item, \.welcome-done-item \{/);
        assert.match(css, /\.studio-indeterminate, \.welcome-segment \{/);
    });
});

describe('the gate is the server\'s decision too', () => {
    it('agrees with the page about who is held (the same table, from the server\'s function)', () => {
        const { App } = load();
        for (const status of ['invited', 'in_progress', 'completed', null] as const) {
            for (const sessionRole of ['user', 'platform_admin']) {
                for (const tenantRole of ['owner', 'operator', 'viewer', null] as const) {
                    const server = onboardingGated({ status, sessionRole, tenantRole });
                    App.session = { available: true, role: sessionRole, tenantRole, onboarding: status === null ? null : { status, gated: server } };
                    assert.equal(App.mustOnboard(), server, `${status}/${sessionRole}/${tenantRole}`);
                }
            }
        }
    });
});
