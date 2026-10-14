/**
 * The proof step of the wizard, W5 (P25): `dashboard/js/pages/welcome_proof.js`, plugged into the wizard through its own seam. The REAL
 * files (the wizard, the step, the dictionaries, the stylesheet) run in a `node:vm` context against a fake API, and the cards are made by
 * the server's own `describeCard` from rows shaped like `voice_examples`, so the page and the server cannot drift apart without this failing.
 *
 * What is pinned, because each is a way the step hurts somebody:
 *   - **It never stands in the way.** No AI key, a failed round, the day's limit, a module that did not load: each says what happened in
 *     plain words, and Continue and Skip are the shell's, still there, with nothing required of the step;
 *   - **A click is one write**: "Sounds like me" is an approval, "Not quite" is a rejection that opens the question, a chip writes the
 *     card again with that hint and replaces it on screen, and editing keeps the person's own words; an empty edit sends nothing;
 *   - **The samples are data**: a model's words and the person's own posts reach the page as text, whatever is in them, and what is typed
 *     in the edit box is kept as the escaped text of the box (`</textarea>` cannot close it);
 *   - **Both languages, one phone**: every string exists in both with the same placeholders, and the stylesheet makes every control a
 *     finger tall, in one column at 375 px, with logical properties only;
 *   - **A card an admin judged for the person says so** and is confirmed by the person's own tap.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { describeCard } from '../services/onboarding/proof.js';
import type { ProofRow } from '../services/onboarding/proofStore.js';
import { WIZARD_STEPS } from '../services/onboardingWizard.js';
import { defaultProfile } from '../services/profile/defaults.js';

// ─── Cards, made by the server ───────────────────────────────────────────────────────────────────

const row = (over: Partial<ProofRow> = {}): ProofRow => ({
    id: '00000000-0000-4000-8000-000000000001', profile_version: 1, kind: 'caption', input: { card: 'caption', attempt: 1, keyword: 'plan', source: { index: 0, text: 'My own earlier post 💪' } },
    model_output: 'A fresh caption in my voice 🔥', final_text: null, verdict: null, verdict_by: null, tenant_confirmed_at: null, model: 'm', created_at: new Date(1), ...over,
});
const commentRow = (over: Partial<ProofRow> = {}): ProofRow => row({
    id: '00000000-0000-4000-8000-000000000002', kind: 'comment_dm',
    input: { card: 'comment', attempt: 1, keyword: 'plan', public_replies: ['Check your messages, {username}! 📩', 'The link is in your DMs 🚀'], match_mode: 'substring' },
    model_output: 'Hi {username}! 👋\nHere is the link:\n🔗 https://samifit.example/plan', ...over,
});
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const cardsOf = (...rows: ProofRow[]) => rows.map((r) => wire(describeCard(r)));
const LIMITS = { roundsPerDay: 3, regenerations: 3 };
const ready = (cards = cardsOf(row(), commentRow())) => ({ state: 'ready', cards, failure: null, limits: LIMITS });

// ─── The sandbox ─────────────────────────────────────────────────────────────────────────────────

function element(): Record<string, any> {
    const classes = new Set<string>();
    return {
        classes, value: '', checked: false, textContent: '', innerHTML: '', disabled: false, style: {}, dataset: {}, offsetWidth: 120,
        classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), toggle: () => false, contains: (c: string) => classes.has(c) },
        setAttribute: () => undefined, getAttribute: () => null, removeAttribute: () => undefined, focus() { (this as any).focused = true; },
        addEventListener: () => undefined, removeEventListener: () => undefined, remove: () => undefined,
        querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false, appendChild: () => undefined,
    };
}

interface Loaded {
    WelcomePage: any;
    WelcomeProof: any;
    UI: any;
    html: any;
    t: (key: string, params?: Record<string, unknown>) => string;
    calls: Array<{ fn: string; args: any[] }>;
    focused: string[];
    announced: string[];
}

interface Options { lang?: 'ar' | 'en'; proof?: boolean; api?: Record<string, (...a: any[]) => any> }

function load(options: Options = {}): Loaded {
    const lang = options.lang ?? 'en';
    const noop = (): void => {};
    const calls: Array<{ fn: string; args: any[] }> = [];
    const focused: string[] = [];
    const announced: string[] = [];
    const found = new Map<string, Record<string, any>>();
    const getElementById = (id: string): Record<string, any> | null => {
        if (!/^(?:proof-|welcome-)/.test(id)) return null;
        if (!found.has(id)) {
            const el = element();
            el.focus = () => { focused.push(id); };
            found.set(id, el);
        }
        return found.get(id)!;
    };
    const api: Record<string, any> = { token: 'token', setToken: noop, clearToken: noop };
    for (const name of ['getProof', 'startProof', 'proofVerdict', 'proofRegenerate', 'saveOnboardingStep', 'completeOnboarding']) {
        const given = options.api?.[name];
        api[name] = (...args: any[]) => { calls.push({ fn: name, args }); return given ? given(...args) : Promise.resolve({}); };
    }
    const ctx: Record<string, any> = {
        document: {
            ...element(), createElement: () => element(), body: element(), head: element(), documentElement: { ...element(), lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById, activeElement: null, querySelector: () => null, querySelectorAll: () => [], contains: () => true, addEventListener: noop,
        },
        window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' }, scrollTo: noop, innerHeight: 800 },
        location: { hash: '', pathname: '/dashboard', search: '' }, history: { replaceState: noop, pushState: noop },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        Intl, console, setTimeout, clearTimeout, URL, URLSearchParams, requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' }, crypto: { getRandomValues: (a: Uint8Array) => a },
        CSS: { escape: (v: string) => String(v) }, API: api, Motion: { announce: (m: string) => { announced.push(m); }, transition: (f: () => void) => { f(); return Promise.resolve(); }, markSkeleton: noop },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    const files = ['dashboard/js/i18n.js', `dashboard/js/i18n.${lang}.js`, 'dashboard/js/components.js', 'dashboard/js/pages/welcome.js',
        ...(options.proof === false ? [] : ['dashboard/js/pages/welcome_proof.js']), 'dashboard/js/app.js'];
    for (const file of files) vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
    vm.runInContext(`I18N.lang = '${lang}'`, ctx);
    const out = vm.runInContext(`({ WelcomePage, WelcomeProof: typeof WelcomeProof === 'undefined' ? undefined : WelcomeProof, UI, html, t: (k, p) => I18N.t(k, p) })`, ctx) as Pick<Loaded, 'WelcomePage' | 'WelcomeProof' | 'UI' | 'html' | 't'>;
    return { ...out, calls, focused, announced };
}

const ORDER = WIZARD_STEPS.map((s) => ({ ...s }));
const onboarding = (over: Record<string, unknown> = {}): Record<string, any> => ({
    status: 'in_progress', step: 'proof', order: ORDER, steps: { about: { status: 'done' }, voice: { status: 'done' }, brand: { status: 'done' } }, filledBy: null,
    profile: defaultProfile({ lang: 'en' }), version: 1, stored: true, missing: [], hints: { name: 'Sami', instagramUsername: null, websiteUrl: null }, canEdit: true, draft: null, ...over,
});

/** The wizard on its proof step with the cards the server answered, and the page's own repaints counted. */
function fixture(options: Options & { answer?: unknown } = {}) {
    const s = load(options);
    const P = s.WelcomePage;
    let paints = 0;
    P.paint = () => { paints++; };
    P.state = P.freshState();
    P.state.phase = 'ready';
    P.state.onb = onboarding();
    P.state.step = 'proof';
    P.state.values = {};
    const W = s.WelcomeProof;
    if (W) {
        W.page = P;
        P.state.proof = W.fresh();
        if (options.answer !== undefined) W.take(P.state.proof, wire(options.answer));
    }
    const markup = (): string => String(P.stepCard(P.state));
    return { s, P, W, markup, paints: () => paints };
}

const text = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// ─── What the step shows ─────────────────────────────────────────────────────────────────────────

describe('W5: the step in the wizard', () => {
    it('is switched on by the server, optional, and has nothing to send to the profile', () => {
        const { P } = fixture();
        assert.deepEqual(WIZARD_STEPS.find((x) => x.id === 'proof'), { id: 'proof', code: 'W5', required: false, enabled: true });
        const def = P.STEPS.proof;
        assert.deepEqual({ code: def.code, required: def.required, skippable: def.skippable }, { code: 'W5', required: false, skippable: true });
        assert.deepEqual(wire(def.problems({})), [], 'nothing is required of it');
        assert.deepEqual(wire(def.patch({}, {})), {}, 'and it writes nothing to the profile');
        assert.deepEqual(wire(P.stepOrder(onboarding())), ['about', 'voice', 'brand', 'proof', 'done']);
    });

    it('is a registered page module, loaded by the wizard when it starts, and a page that cannot load it says so and lets the person carry on', () => {
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(app, /welcome_proof: \{ src: 'welcome_proof', page: \(\) => WelcomeProof, routable: false \}/);
        assert.match(readFileSync('dashboard/js/pages/welcome.js', 'utf8'), /loadPageModule\('welcome_proof'\)/);
        const missing = fixture({ proof: false });
        assert.equal(missing.W, undefined);
        const out = text(missing.markup());
        assert.ok(out.includes(missing.s.t('welcome.proof.unavailableTitle')) && out.includes(missing.s.t('welcome.proof.unavailable')));
        assert.match(String(missing.P.barView(missing.P.state)), /id="welcome-next"/, 'Continue is the shell\'s, and it is there');
        assert.match(String(missing.P.barView(missing.P.state)), /data-action="welcome:skip"/);
    });

    it('draws a loader while the samples are being written, with the honest wait', () => {
        const { s, markup } = fixture();
        const out = markup();
        assert.match(out, /class="loader"/);
        assert.ok(text(out).includes(s.t('welcome.proof.loadingHint')));
        assert.equal((out.match(/<h1\b/g) ?? []).length, 1);
        assert.ok(out.includes(`>${s.t('welcome.proof.title')}</h1>`));
    });

    it('shows two cards: a caption beside the person\'s own post, and the comment campaign\'s message and replies, with {username} said plainly', () => {
        const { s, markup } = fixture({ answer: ready() });
        const out = markup();
        assert.equal((out.match(/<li class="proof-card surface"/g) ?? []).length, 2);
        assert.equal((out.match(/<h2 class="proof-card-title">/g) ?? []).length, 2);
        const words = text(out);
        for (const key of ['welcome.proof.card.caption', 'welcome.proof.card.comment', 'welcome.proof.original', 'welcome.proof.written', 'welcome.proof.comment.dm', 'welcome.proof.comment.reply', 'welcome.proof.comment.replyMore']) {
            assert.ok(words.includes(s.t(key)), key);
        }
        assert.ok(words.includes('My own earlier post 💪') && words.includes('A fresh caption in my voice 🔥'));
        assert.match(out, /<bdi class="proof-keyword" dir="auto">plan<\/bdi>/);
        assert.ok(words.includes(`Check your messages, ${s.t('welcome.proof.username')}!`), '{username} is the follower\'s name, which the page cannot know');
        assert.ok(!out.includes('{username}'));
        assert.ok(words.includes('https://samifit.example/plan'));
        assert.ok(words.includes(s.t('welcome.proof.footnote')), 'and it says nothing is posted');
        assert.equal((out.match(/dir="auto"/g) ?? []).length >= 5, true, 'every sample is bidi-safe');
    });

    it('says a caption was written from the offer when there was no post to write beside', () => {
        const { s, markup } = fixture({ answer: ready(cardsOf(row({ input: { card: 'caption', attempt: 1, source: null } }), commentRow())) });
        assert.ok(text(markup()).includes(s.t('welcome.proof.noOriginal')));
    });

    it('has two answers on each card, as pressed-state buttons with visible words, and no question until "Not quite"', () => {
        const { s, markup } = fixture({ answer: ready() });
        const out = markup();
        for (const card of ['caption', 'comment']) {
            assert.match(out, new RegExp(`id="proof-yes-${card}" aria-pressed="false"[^>]*data-action="welcomeProof:approve" data-card="${card}"`));
            assert.match(out, new RegExp(`id="proof-no-${card}" aria-pressed="false"[^>]*data-action="welcomeProof:notQuite" data-card="${card}"`));
        }
        assert.ok(text(out).includes(s.t('welcome.proof.yes')) && text(out).includes(s.t('welcome.proof.no')));
        assert.ok(!out.includes('proof-chip'), 'no chips yet');
        assert.equal((out.match(/role="group" aria-label=/g) ?? []).length, 2, 'each pair is a labelled group');
        assert.equal((out.match(/role="status" aria-live="polite"/g) ?? []).length, 2, 'and each card has a live status line');
    });

    it('marks what is already decided: an approval presses the first button, a rejection the second and opens the question', () => {
        const approved = fixture({ answer: ready(cardsOf(row({ verdict: 'approved', verdict_by: 'tenant', tenant_confirmed_at: new Date(2) }), commentRow({ verdict: 'rejected', verdict_by: 'tenant', tenant_confirmed_at: new Date(2) }))) });
        const out = approved.markup();
        assert.match(out, /id="proof-yes-caption" aria-pressed="true"/);
        assert.match(out, /id="proof-no-comment" aria-pressed="true"/);
        assert.match(out, /id="proof-yes-comment" aria-pressed="false"/);
        assert.equal((out.match(/data-chip="/g) ?? []).length, 4, 'the rejected card asks what is off');
        assert.ok(text(out).includes(approved.s.t('welcome.proof.saved.approved')));
    });

    it('shows the person\'s own wording for an edit, and says "waiting for you" for what an admin judged', () => {
        const { s, markup } = fixture({ answer: ready(cardsOf(
            row({ verdict: 'edited', final_text: 'MY OWN WORDING', verdict_by: 'tenant', tenant_confirmed_at: new Date(2) }),
            commentRow({ verdict: 'approved', verdict_by: 'admin', tenant_confirmed_at: null }),
        )) });
        const out = text(markup());
        assert.ok(out.includes('MY OWN WORDING') && !out.includes('A fresh caption in my voice'));
        assert.ok(out.includes(s.t('welcome.proof.saved.edited')));
        assert.ok(out.includes(s.t('welcome.proof.waiting')), 'an operator\'s approval is the person\'s to confirm');
    });

    it('tells which try a card is on, and that the last one can still be edited', () => {
        const { s, markup } = fixture({ answer: ready(cardsOf(row({ input: { card: 'caption', attempt: 2 } }), commentRow({ input: { card: 'comment', attempt: 4, keyword: 'plan', public_replies: ['x'] } }))) });
        const out = text(markup());
        assert.ok(out.includes(s.t('welcome.proof.try', { n: 2, total: 4 })));
        assert.ok(out.includes(s.t('welcome.proof.tryLast', { n: 4, total: 4 })));
    });

    it('says there is no AI key, plainly, and shows no card', () => {
        const { s, markup } = fixture({ answer: { state: 'needs_ai_key', cards: [], failure: null, limits: LIMITS } });
        const out = markup();
        const words = text(out);
        assert.ok(words.includes(s.t('welcome.proof.noKeyTitle')) && words.includes(s.t('welcome.proof.noKey')));
        assert.ok(!out.includes('proof-card') && !out.includes('data-action="welcomeProof:'));
    });

    it('says what failed, offers to try again, and keeps the card that did come back', () => {
        const { s, markup } = fixture({ answer: { state: 'failed', cards: cardsOf(row()), failure: 'timeout', limits: LIMITS } });
        const out = markup();
        assert.ok(text(out).includes(s.t('welcome.proof.failedTitle')) && text(out).includes(s.t('welcome.proof.failed.body')));
        assert.match(out, /data-action="welcomeProof:retry"/);
        assert.equal((out.match(/class="proof-card surface"/g) ?? []).length, 1);
        const budget = fixture({ answer: { state: 'failed', cards: [], failure: 'budget', limits: LIMITS } });
        assert.ok(text(budget.markup()).includes(budget.s.t('welcome.proof.failed.budget')));
        const quota = fixture({ answer: { state: 'failed', cards: [], failure: 'quota', limits: LIMITS } });
        assert.ok(text(quota.markup()).includes(quota.s.t('welcome.proof.failed.budget')));
    });

    it('never puts a provider\'s words or a failure kind on the page', () => {
        const { markup } = fixture({ answer: { state: 'failed', cards: [], failure: 'auth', limits: LIMITS } });
        assert.doesNotMatch(markup(), />\s*auth\s*</);
    });
});

// ─── Running it ──────────────────────────────────────────────────────────────────────────────────

describe('W5: opening the step', () => {
    it('asks for the samples once, and paints them', async () => {
        const fx = fixture({ api: { startProof: () => Promise.resolve(ready()) } });
        fx.P.state.proof = null;
        await fx.W.enter(fx.P);
        assert.deepEqual(wire(fx.s.calls.map((c) => c.fn)), ['startProof']);
        assert.equal(fx.P.state.proof.phase, 'ready');
        assert.equal(fx.P.state.proof.cards.length, 2);
        assert.ok(fx.paints() >= 2, 'a loader first, then the cards');
    });

    it('reads "no key" as a state and not an error', async () => {
        const fx = fixture({ api: { startProof: () => Promise.resolve({ state: 'needs_ai_key', cards: [], failure: null, limits: LIMITS }) } });
        await fx.W.enter(fx.P);
        assert.equal(fx.P.state.proof.phase, 'needs_key');
    });

    it('shows the day\'s limit, with whatever cards exist, when the server says 429', async () => {
        const fx = fixture({ api: {
            startProof: () => Promise.reject(Object.assign(new Error('limit'), { status: 429, body: { code: 'PROOF_LIMIT' } })),
            getProof: () => Promise.resolve(ready(cardsOf(row()))),
        } });
        await fx.W.enter(fx.P);
        assert.equal(fx.P.state.proof.phase, 'limit');
        assert.equal(fx.P.state.proof.cards.length, 1);
        assert.deepEqual(wire(fx.s.calls.map((c) => c.fn)), ['startProof', 'getProof']);
        assert.ok(text(fx.markup()).includes(fx.s.t('welcome.proof.limitTitle')));
    });

    it('says the samples are not available when the server cannot be reached, and lets the person carry on', async () => {
        const fx = fixture({ api: { startProof: () => Promise.reject(Object.assign(new Error('down'), { status: 503 })) } });
        await fx.W.enter(fx.P);
        assert.equal(fx.P.state.proof.phase, 'unavailable');
        assert.ok(text(fx.markup()).includes(fx.s.t('welcome.proof.unavailable')));
    });

    it('does nothing for a session that expired: the login screen is the answer', async () => {
        const fx = fixture({ api: { startProof: () => Promise.reject(Object.assign(new Error('expired'), { status: 401 })) } });
        await fx.W.enter(fx.P);
        assert.equal(fx.P.state.proof.phase, 'loading', 'left as it was');
    });

    it('does not repaint a step the person has left while the samples were being written', async () => {
        let resolve: (v: unknown) => void = () => undefined;
        const fx = fixture({ api: { startProof: () => new Promise((r) => { resolve = r; }) } });
        const run = fx.W.enter(fx.P);
        fx.P.state.step = 'done';
        const before = fx.paints();
        resolve(ready());
        await run;
        assert.equal(fx.paints(), before);
    });

    it('is entered by the wizard when the step opens, and not typed into by the autosave', async () => {
        const fx = fixture({ api: { startProof: () => Promise.resolve(ready()), saveOnboardingStep: () => Promise.resolve({ steps: {} }) } });
        fx.P.state.step = 'brand';
        await fx.P.show('proof');
        await new Promise((r) => setTimeout(r, 0));
        assert.ok(fx.s.calls.some((c) => c.fn === 'startProof'));
        assert.deepEqual(wire(fx.s.calls.filter((c) => c.fn === 'saveOnboardingStep').map((c) => c.args)), [['proof', { viewed: true }]]);
        fx.P.onInput(null, { target: { name: 'whatever' } });
        assert.equal(fx.P._saveTimer, null, 'typing on this step schedules no autosave');
    });
});

describe('W5: the answers', () => {
    const card = (name: 'caption' | 'comment', over: Partial<ProofRow> = {}) => wire(describeCard(name === 'caption' ? row(over) : commentRow(over)));

    it('"Sounds like me" is one approval, and the card on screen becomes the server\'s', async () => {
        const approved = card('caption', { verdict: 'approved', verdict_by: 'tenant', tenant_confirmed_at: new Date(2) });
        const fx = fixture({ answer: ready(), api: { proofVerdict: () => Promise.resolve({ card: approved }) } });
        await fx.W.approve('caption');
        assert.deepEqual(wire(fx.s.calls.map((c) => [c.fn, c.args])), [['proofVerdict', ['00000000-0000-4000-8000-000000000001', { verdict: 'approved' }]]]);
        assert.equal(fx.P.state.proof.cards[0].verdict, 'approved');
        assert.match(fx.markup(), /id="proof-yes-caption" aria-pressed="true"/);
        assert.ok(fx.s.focused.includes('proof-yes-caption'), 'focus comes back to the button that was pressed');
        assert.equal(fx.P.state.proof.cards[1].verdict, null, 'the other card is untouched');
    });

    it('"Not quite" is a rejection and opens the question; pressed again it only closes and opens it', async () => {
        const rejected = card('comment', { verdict: 'rejected', verdict_by: 'tenant', tenant_confirmed_at: new Date(2) });
        const fx = fixture({ answer: ready(), api: { proofVerdict: () => Promise.resolve({ card: rejected }) } });
        await fx.W.notQuite('comment');
        assert.deepEqual(wire(fx.s.calls.map((c) => c.args[1])), [{ verdict: 'rejected' }]);
        assert.equal(fx.P.state.proof.ui.comment.why, true);
        assert.equal((fx.markup().match(/data-chip="/g) ?? []).length, 4);
        await fx.W.notQuite('comment');
        assert.equal(fx.s.calls.length, 1, 'already said: nothing more is sent');
        assert.equal(fx.P.state.proof.ui.comment.why, false);
    });

    it('a chip writes the card again with that hint, and replaces it, new id and all', async () => {
        const fresh = card('caption', { id: '00000000-0000-4000-8000-0000000000aa', input: { card: 'caption', attempt: 2 }, model_output: 'A lighter caption' });
        const fx = fixture({ answer: ready(cardsOf(row({ verdict: 'rejected', verdict_by: 'tenant', tenant_confirmed_at: new Date(2) }), commentRow())),
            api: { proofRegenerate: () => Promise.resolve({ state: 'ready', card: fresh, failure: null, limits: LIMITS }) } });
        await fx.W.chip('caption', 'too_formal');
        assert.deepEqual(wire(fx.s.calls.map((c) => [c.fn, c.args])), [['proofRegenerate', ['00000000-0000-4000-8000-000000000001', { hint: 'too_formal' }]]]);
        assert.equal(fx.P.state.proof.cards[0].id, '00000000-0000-4000-8000-0000000000aa');
        assert.ok(text(fx.markup()).includes('A lighter caption'));
        assert.ok(text(fx.markup()).includes(fx.s.t('welcome.proof.try', { n: 2, total: 4 })));
        assert.deepEqual(wire(fx.P.state.proof.ui.caption), {}, 'the question closes: it is a new sample to judge');
        assert.deepEqual(wire(fx.s.announced), [fx.s.t('welcome.proof.regenerated')]);
    });

    it('sends only the three hints a chip may write again with, and never twice at once', async () => {
        let release: (v: unknown) => void = () => undefined;
        const fx = fixture({ answer: ready(), api: { proofRegenerate: () => new Promise((r) => { release = r; }) } });
        const first = fx.W.chip('caption', 'too_long');
        await fx.W.chip('caption', 'too_long');
        await fx.W.chip('caption', 'bogus');
        assert.equal(fx.s.calls.filter((c) => c.fn === 'proofRegenerate').length, 1, 'a second tap while one is writing is ignored');
        assert.match(fx.markup(), /disabled/);
        assert.ok(text(fx.markup()).includes(fx.s.t('welcome.proof.regenerating')));
        release({ state: 'failed', failure: 'timeout', limits: LIMITS });
        await first;
        assert.equal(fx.P.state.proof.ui.caption.busy, '');
        assert.ok(text(fx.markup()).includes(fx.s.t('welcome.proof.err.generic')), 'a failed rewrite leaves the card and says so');
    });

    it('a card on its last try offers no chip that writes again, only the one that edits', () => {
        const fx = fixture({ answer: ready(cardsOf(row({ verdict: 'rejected', verdict_by: 'tenant', tenant_confirmed_at: new Date(2), input: { card: 'caption', attempt: 4 } }), commentRow())) });
        const out = fx.markup();
        const chips = [...out.matchAll(/<button type="button" class="btn btn-secondary proof-chip"([^>]*)>/g)].map((m) => m[1]!);
        assert.equal(chips.length, 4);
        assert.deepEqual(wire(chips.map((c) => /disabled/.test(c))), [true, true, true, false], 'the three rewrites are off and "I\'ll edit it myself" is on');
        assert.ok(text(out).includes(fx.s.t('welcome.proof.err.limit')));
    });

    it('"I\'ll edit it myself" opens a box with the sample, keeps what is typed, and saves it as the person\'s own wording', async () => {
        const edited = card('caption', { verdict: 'edited', final_text: 'my own words', verdict_by: 'tenant', tenant_confirmed_at: new Date(2) });
        const fx = fixture({ answer: ready(), api: { proofVerdict: () => Promise.resolve({ card: edited }) } });
        await fx.W.chip('caption', 'edit_myself');
        assert.equal(fx.s.calls.length, 0, 'opening the editor writes nothing');
        assert.match(fx.markup(), /<textarea class="field proof-edit-box" id="proof-edit-caption" rows="6" dir="auto" maxlength="2200"[^>]*>A fresh caption in my voice 🔥<\/textarea>/);
        assert.ok(fx.s.focused.includes('proof-edit-caption'));
        fx.W.draft('caption', 'my own words');
        assert.match(fx.markup(), />my own words<\/textarea>/, 'a repaint keeps what was typed');
        await fx.W.saveEdit('caption');
        assert.deepEqual(wire(fx.s.calls.map((c) => [c.fn, c.args[1]])), [['proofVerdict', { verdict: 'edited', edited_text: 'my own words', reasons: ['edit_myself'] }]]);
        assert.equal(fx.P.state.proof.cards[0].text, 'my own words');
        assert.deepEqual(wire(fx.P.state.proof.ui.caption), {}, 'the editor closes on a saved edit');
    });

    it('sends nothing for an empty edit, and says why; Cancel closes the box', async () => {
        const fx = fixture({ answer: ready() });
        await fx.W.chip('comment', 'edit_myself');
        fx.W.draft('comment', '   ');
        await fx.W.saveEdit('comment');
        assert.equal(fx.s.calls.length, 0);
        assert.ok(text(fx.markup()).includes(fx.s.t('welcome.proof.err.edit')));
        fx.W.cancelEdit('comment');
        assert.ok(!fx.markup().includes('proof-edit-comment'));
        assert.ok(fx.s.focused.includes('proof-no-comment'));
    });

    it('says what the server refused, in the person\'s language and not the server\'s', async () => {
        const refuse = (status: number, code: string) => () => Promise.reject(Object.assign(new Error('SERVER WORDS'), { status, body: { code } }));
        const stale = fixture({ answer: ready(), api: { proofVerdict: refuse(409, 'PROOF_NOT_CURRENT') } });
        await stale.W.approve('caption');
        assert.ok(text(stale.markup()).includes(stale.s.t('welcome.proof.err.stale')));
        const limit = fixture({ answer: ready(), api: { proofRegenerate: refuse(429, 'REGENERATE_LIMIT') } });
        await limit.W.chip('caption', 'too_long');
        assert.ok(text(limit.markup()).includes(limit.s.t('welcome.proof.err.limit')));
        const noKey = fixture({ answer: ready(), api: { proofRegenerate: () => Promise.resolve({ state: 'needs_ai_key', failure: null, limits: LIMITS }) } });
        await noKey.W.chip('caption', 'too_long');
        assert.ok(text(noKey.markup()).includes(noKey.s.t('welcome.proof.err.noKey')));
        const bad = fixture({ answer: ready(), api: { proofVerdict: refuse(400, 'BAD_REQUEST') } });
        await bad.W.chip('caption', 'edit_myself');
        bad.W.draft('caption', 'x');
        await bad.W.saveEdit('caption');
        assert.ok(text(bad.markup()).includes(bad.s.t('welcome.proof.err.edit')));
        for (const fx of [stale, limit, noKey, bad]) assert.ok(!fx.markup().includes('SERVER WORDS'));
        assert.equal(stale.P.state.proof.ui.caption.busy, '', 'the page can be used again');
    });

    it('leaves a session that expired to the login screen', async () => {
        const fx = fixture({ answer: ready(), api: { proofVerdict: () => Promise.reject(Object.assign(new Error('expired'), { status: 401 })) } });
        await fx.W.approve('caption');
        assert.equal(fx.P.state.proof.cards[0].verdict, null);
    });

    it('a card the person confirms after an admin judged it becomes theirs', async () => {
        const waiting = card('caption', { verdict: 'approved', verdict_by: 'admin', tenant_confirmed_at: null });
        const confirmed = card('caption', { verdict: 'approved', verdict_by: 'tenant', tenant_confirmed_at: new Date(3) });
        const fx = fixture({ answer: ready([waiting, card('comment')]), api: { proofVerdict: () => Promise.resolve({ card: confirmed }) } });
        assert.ok(text(fx.markup()).includes(fx.s.t('welcome.proof.waiting')));
        await fx.W.approve('caption');
        assert.equal(fx.P.state.proof.cards[0].waiting, false);
        assert.ok(!text(fx.markup()).includes(fx.s.t('welcome.proof.waiting')));
    });
});

// ─── The last screen ─────────────────────────────────────────────────────────────────────────────

describe('W6 after the samples', () => {
    const done = (steps: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
        const fx = fixture();
        fx.P.state.step = 'done';
        fx.P.state.onb = onboarding({ status: 'completed', steps, ...extra });
        return fx;
    };

    it('says the samples are ready when the person went through them, and that they guide what is written', () => {
        const fx = done({ about: { status: 'done' }, voice: { status: 'done' }, brand: { status: 'done' }, proof: { status: 'done' } });
        const out = text(String(fx.P.doneFields(fx.P.state)));
        assert.ok(out.includes(fx.s.t('welcome.done.proofDone')));
        assert.ok(!out.includes(fx.s.t('welcome.done.proofSkipped')));
    });

    it('says honestly that they were skipped, and that everything still starts from the profile', () => {
        const fx = done({ about: { status: 'done' }, voice: { status: 'done' }, brand: { status: 'done' }, proof: { status: 'skipped' } });
        assert.ok(text(String(fx.P.doneFields(fx.P.state))).includes(fx.s.t('welcome.done.proofSkipped')));
        const item = text(String(fx.P.doneProofItem(fx.P.state.onb)));
        assert.ok(item.includes(fx.s.t('welcome.done.proofSkipped')) && !item.includes('coming soon'), 'it does not claim a feature is on its way');
    });

    it('says the first comment campaign is written and off, when Finish made one, and says nothing when it did not', () => {
        const fx = done({ proof: { status: 'done' } });
        assert.ok(!text(String(fx.P.doneFields(fx.P.state))).includes(fx.s.t('welcome.done.campaignTitle')));
        fx.P.state.firstCampaign = { created: true, id: 'x', source: 'proof' };
        const out = text(String(fx.P.doneFields(fx.P.state)));
        assert.ok(out.includes(fx.s.t('welcome.done.campaignTitle')) && out.includes(fx.s.t('welcome.done.campaign')));
    });

    it('keeps what Finish made, for the last screen to say', async () => {
        const fx = fixture({ api: { completeOnboarding: () => Promise.resolve({ status: 'completed', alreadyCompleted: false, step: 'done', campaign: { created: true, id: 'c1', source: 'kit' } }) } });
        fx.P.state.step = 'done';
        await fx.P.enterDone();
        assert.deepEqual(wire(fx.P.state.firstCampaign), { created: true, id: 'c1', source: 'kit' });
        const none = fixture({ api: { completeOnboarding: () => Promise.resolve({ status: 'completed', alreadyCompleted: false, step: 'done', campaign: { created: false, reason: 'no_keyword' } }) } });
        none.P.state.step = 'done';
        await none.P.enterDone();
        assert.equal(none.P.state.firstCampaign, null);
    });
});

// ─── Escaping ────────────────────────────────────────────────────────────────────────────────────

describe('W5: the samples are data', () => {
    const PAYLOAD = '<img src=x onerror=alert(document.cookie)>';
    const BREAKOUT = '"><script>alert(1)</script><x y="';
    const hostile = (): unknown => ready(cardsOf(
        row({ model_output: PAYLOAD, final_text: BREAKOUT, verdict: 'edited', verdict_by: 'tenant', tenant_confirmed_at: new Date(2), input: { card: 'caption', attempt: 1, keyword: PAYLOAD, source: { index: 0, text: BREAKOUT } } }),
        commentRow({ model_output: BREAKOUT, input: { card: 'comment', attempt: 1, keyword: PAYLOAD, public_replies: [PAYLOAD, BREAKOUT], match_mode: PAYLOAD } }),
    ));

    for (const lang of ['en', 'ar'] as const) {
        it(`${lang}: nothing is a live tag, handler or address, and the text is there as text`, () => {
            const fx = fixture({ lang, answer: hostile() });
            fx.P.state.proof.ui.caption = { why: true, editing: true, draft: `${PAYLOAD}</textarea>${BREAKOUT}`, notice: '' };
            const out = fx.markup();
            assert.ok(!out.includes('<img src=x'), 'no live img tag');
            assert.ok(!out.includes('<script'), 'no live script tag');
            assert.ok(!/"\s*>\s*<(script|img|x)\b/i.test(out), 'nothing broke out of an attribute');
            assert.ok(!/\son[a-z]+\s*=/i.test(out.replace(/&lt;[^<>]*/g, '')), 'no live event handler');
            assert.ok(out.includes('&lt;img src=x onerror=alert('), 'the payload is there, escaped, as the text it is');
            assert.equal((out.match(/<\/textarea>/g) ?? []).length, 1, '</textarea> typed into the box is text, and the one close tag is ours');
        });
    }

    it('shows the person\'s edit and not the model\'s first words, escaped', () => {
        const fx = fixture({ answer: hostile() });
        const out = fx.markup();
        assert.ok(out.includes('&lt;/script&gt;') || out.includes('&quot;&gt;&lt;script&gt;'));
        assert.ok(!out.includes('<script>'));
    });
});

// ─── Both languages, and one phone ───────────────────────────────────────────────────────────────

describe('W5: the copy and the stylesheet', () => {
    function dictionary(lang: 'ar' | 'en'): Record<string, string> {
        const ctx: Record<string, any> = {};
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        vm.runInContext(readFileSync(`dashboard/js/i18n.${lang}.js`, 'utf8'), ctx);
        return ctx.I18N_DICT[lang];
    }
    const ar = dictionary('ar');
    const en = dictionary('en');
    const keys = Object.keys(en).filter((k) => /^welcome\.proof\./.test(k) || /^welcome\.(?:step\.proof|done\.(?:proofDone|proofSkipped|campaignTitle|campaign))$/.test(k));

    it('has every string in both languages with the same placeholders', () => {
        assert.ok(keys.length >= 50, `${keys.length} keys`);
        const names = (v: string): string => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
        for (const key of keys) {
            assert.ok(key in ar, `${key} is missing in Arabic`);
            assert.equal(names(ar[key]!), names(en[key]!), key);
        }
    });

    it('has the Arabic in Arabic, with no Arabic-Indic digits and no dialect, and the English with no exclamation mark', () => {
        for (const key of keys) {
            assert.match(ar[key]!, /[؀-ۿ]/, `${key} is not Arabic`);
            assert.ok(!/[٠-٩۰-۹]/.test(ar[key]!), `${key} has Arabic-Indic digits`);
            assert.ok(!/!/.test(en[key]!), `${key}: English has no exclamation marks`);
        }
        assert.equal(en['welcome.proof.yes'], 'Sounds like me');
        assert.equal(en['welcome.proof.no'], 'Not quite');
        assert.equal(ar['welcome.proof.title'], 'هل يبدو هذا كلامك؟');
        assert.equal(ar['welcome.proof.yes'], 'يشبهني');
        assert.equal(ar['welcome.proof.no'], 'ليس تمامًا');
        assert.deepEqual(['too_formal', 'too_long', 'wrong_info', 'edit_myself'].map((c) => ar[`welcome.proof.chip.${c}`]), ['رسمي أكثر من اللازم', 'طويل', 'معلومة خاطئة', 'سأعدّله بنفسي']);
    });

    const css = readFileSync('dashboard/css/styles.css', 'utf8');
    const start = css.indexOf('/* The proof step, W5');
    const end = css.indexOf('/* The bar sticks to the bottom', start);
    const block = css.slice(start, end);

    it('finds the proof block, inside the wizard\'s', () => {
        assert.ok(start > 0 && end > start);
        assert.ok(css.indexOf('/* ─── The setup wizard') < start);
    });

    it('makes every control a finger tall, and the whole step one column at 375 px', () => {
        for (const selector of ['.proof-btn', '.proof-chip', '.proof-edit-actions .btn']) {
            const rule = new RegExp(`${selector.replace(/[.\s]/g, (c) => `\\${c}`)}\\s*\\{[^}]*min-block-size:\\s*var\\(--tap-target\\)`);
            assert.match(block, rule, selector);
        }
        assert.match(css, /\.btn \{[^}]*min-height: var\(--tap-target\)/, 'and every .btn is a finger tall to begin with');
        assert.match(block, /\.proof-list \{[^}]*flex-direction: column/);
        assert.match(block, /\.proof-card \{[^}]*min-inline-size: 0[^}]*overflow-wrap: anywhere/);
        assert.match(block, /\.proof-text \{[^}]*white-space: pre-wrap[^}]*overflow-wrap: anywhere/, 'a long caption or word wraps and keeps its line breaks');
        assert.ok(!/@media/.test(block), 'one column at every width: nothing here depends on a breakpoint');
        assert.doesNotMatch(block, /\b(?:min-|max-)?(?:width|height)\s*:\s*\d/, 'no fixed width that could overflow a phone');
    });

    it('uses logical properties and tokens only: it reads the same in Arabic and English', () => {
        const physical = block.match(/(?<![\w-])(margin|padding|border)-(left|right)\b|(?<![\w-])(left|right|top|bottom)\s*:|text-align:\s*(left|right)\b|(?<![\w-])(width|height|min-width|min-height|max-width|max-height)\s*:/g);
        assert.deepEqual(physical, null, `physical properties: ${physical}`);
        assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no colour of its own: every one is a token');
    });
});
