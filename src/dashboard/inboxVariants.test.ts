/**
 * The funnel card's A/B wording comparison (DM plan S14): `renderFunnelVariants` in the REAL `inbox.js`, in a `node:vm` context, in both languages.
 *
 * What is pinned, because a screenshot cannot check it: each arm shows its counts and its rates with the numbers they are made of; an arm under the
 * minimum sample shows a dash and the reason and never a percentage (the server's gate, and this page does not argue with it); nothing marks an arm as
 * the better one; the owner's names are text and never markup; a slot or a section the server should not send is not drawn; and every string exists in
 * both languages, with the plural families Arabic needs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = any;
type Lang = 'ar' | 'en';

function load(lang: Lang) {
    const noop = (): void => {};
    const stub = {
        addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null, contains: () => false, children: [], innerHTML: '', textContent: '',
    };
    const ctx: Json = {
        document: {
            ...stub, createElement: () => ({ ...stub }), body: { ...stub }, head: { ...stub },
            documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: () => null, activeElement: null, visibilityState: 'visible',
        },
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
        Intl, console: { ...console, error: noop, debug: noop }, clearTimeout, URLSearchParams,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        setTimeout: (fn: () => void, ms?: number) => { const h = setTimeout(fn, ms); (h as Json).unref?.(); return h; },
        setInterval: (fn: () => void, ms?: number) => { const h = setInterval(fn, ms); (h as Json).unref?.(); return h; },
        clearInterval, requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang }, CSS: { escape: (v: string) => String(v) },
        API: { token: 'tok' },
        App: { currentTheme: () => 'auto', navigate: noop, session: { tenantId: 't1' }, hashParam: () => '', canOperate: () => true, setInboxWaiting: noop },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js', 'dashboard/js/attention.js', 'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js', 'dashboard/js/motion.js',
        'dashboard/js/pages/inbox.js',
    ]) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const got = vm.runInContext('({ Inbox: InboxPage, UI, t, strings: I18N.strings })', ctx);
    got.UI.icons = noop;
    return { Inbox: got.Inbox as Json, t: got.t as (key: string, params?: Json) => string, strings: got.strings as Record<Lang, Record<string, string>> };
}

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦⁩]/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').replace(/ ([.,:;])/g, '$1').trim();
const tagsOf = (markup: unknown): string[] => [...String(markup).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]!.toLowerCase());
const SAFE_TAGS = new Set(['div', 'span', 'bdi', 'i', 'strong', 'p', 'dl', 'dt', 'dd', 'ul', 'li', 'section', 'h4']);
const LANGS = ['en', 'ar'] as const;

const rate = (count: number, of: number, pct: number | null) => ({ count, of, pct });

/** `GET /api/dm/funnel`'s `variants` for the fixture world of `dmVariantFunnel.test.ts`, as the server answers it. */
const VARIANTS: Json = {
    min_sample: 30, running: true, comparable: true,
    arms: [
        { id: 'A', label: 'Warm', weight: 50, conversations: 40, recommended: 20, link_sent: 10, clicked: 4, link: rate(10, 20, 50), click: rate(4, 10, 40), enough: true },
        { id: 'B', label: 'Direct', weight: 50, conversations: 35, recommended: 14, link_sent: 7, clicked: 1, link: rate(7, 14, 50), click: rate(1, 7, 14), enough: true },
        { id: 'C', label: 'Old', weight: 0, conversations: 12, recommended: 6, link_sent: 4, clicked: 2, link: rate(4, 6, null), click: rate(2, 4, null), enough: false },
    ],
};
const FUNNEL: Json = {
    days: 30, since: '2026-09-14T12:00:00.000Z', conversations: 87,
    steps: [{ id: 'conversations', count: 87, pct: 100 }, { id: 'qualified', count: 60, pct: 69 }, { id: 'recommended', count: 40, pct: 46 }, { id: 'link_sent', count: 21, pct: 24 }, { id: 'clicked', count: 12, pct: 14 }],
    outcomes: { follow_up: 0, handoff: 0, closed: 0, opted_out: 0, complaints: 0 },
    rates: { link: rate(21, 40, 53), click: rate(12, 21, 57), handoff: rate(0, 87, 0), opt_out: rate(0, 87, 0) },
    clicks: { people: 12, human: 14, preview: 0 },
    reply: { sample: 0, median_ms: null, p90_ms: null },
    variants: VARIANTS,
};

/** The markup of one arm of the card, by its letter. */
const armOf = (markup: string, slot: string): string => {
    const m = markup.match(new RegExp(`<li class="dm-funnel-arm" data-arm="${slot}">[\\s\\S]*?</li>`));
    assert.ok(m, `arm ${slot} is drawn`);
    return m![0];
};

describe('the funnel card: the A/B wording comparison', () => {
    it('draws each arm with its letter, its name, its conversations and its two rates with the numbers they are made of (counted by hand: 10 of 20, 4 of 10, 7 of 14, 1 of 7)', () => {
        const { Inbox, t } = load('en');
        const shown = text(Inbox.renderFunnelVariants(VARIANTS));
        assert.ok(shown.includes(t('inbox.funnel.variants.title')), shown);
        assert.ok(shown.includes('A Warm 40 conversations Link rate 50% 10 of 20 recommended Click rate 40% 4 of 10 with a link'), shown);
        assert.ok(shown.includes('B Direct 35 conversations Link rate 50% 7 of 14 recommended Click rate 14% 1 of 7 with a link'), shown);
        assert.ok(shown.includes(t('inbox.funnel.variants.running')));
    });

    it('shows a dash and the reason, and NO percentage, for an arm under the minimum sample: its counts stand alone, and it says how far it has to go', () => {
        const { Inbox } = load('en');
        const c = text(armOf(String(Inbox.renderFunnelVariants(VARIANTS)), 'C'));
        assert.ok(c.includes('C Old 12 conversations · no new conversations'), c);
        assert.ok(c.includes('Link rate — 4 of 6 recommended'), c);
        assert.ok(c.includes('Click rate — 2 of 4 with a link'), c);
        assert.ok(c.includes('Not enough data yet: 12 of 30 conversations.'), c);
        assert.equal(/\d+%/.test(c), false, 'no percentage anywhere in the arm');
    });

    it('does not argue with the server\'s gate: a percentage sent for an arm that is not `enough` is not shown, and `enough` with no percentage is a dash', () => {
        const { Inbox } = load('en');
        const odd = { ...VARIANTS, arms: [
            { ...VARIANTS.arms[2], link: rate(4, 6, 67), click: rate(2, 4, 50), enough: false },
            { ...VARIANTS.arms[0], link: rate(0, 0, null), click: rate(0, 0, null), enough: true },
        ] };
        const markup = String(Inbox.renderFunnelVariants(odd));
        assert.equal(/\d+%/.test(text(armOf(markup, 'C'))), false);
        const a = text(armOf(markup, 'A'));
        assert.ok(a.includes('Link rate — 0 of 0 recommended'), a);
        assert.equal(a.includes('Not enough data yet'), false, 'it has enough: only its rates have nothing to divide by');
    });

    it('marks no arm as the better one: each arm carries its letter and nothing else, and the card says in words that no test is run', () => {
        const { Inbox, t } = load('en');
        const markup = String(Inbox.renderFunnelVariants(VARIANTS));
        for (const slot of ['A', 'B', 'C']) assert.equal((armOf(markup, slot).match(/class="badge/g) ?? []).length, 1, `${slot}: the letter, no other badge`);
        assert.equal(/winner|leader|leading|best|data-best|badge-success[^>]*data-arm/i.test(markup.replace(t('inbox.funnel.variants.note'), '')), false);
        assert.ok(text(markup).includes('No significance test is run, so a gap between two variants is not proof that one works better.'));
    });

    it('says the variants cannot be set side by side yet, until two of them have enough, and not after', () => {
        const { Inbox, t } = load('en');
        const waiting = text(Inbox.renderFunnelVariants({ ...VARIANTS, comparable: false }));
        assert.ok(waiting.includes(t('inbox.funnel.variants.waiting', { need: '30' })), waiting);
        assert.ok(waiting.includes('Rates can be set side by side once at least two variants have 30 conversations.'));
        assert.equal(text(Inbox.renderFunnelVariants(VARIANTS)).includes('side by side'), false);
    });

    it('says when the experiment is switched off, and still shows what it counted', () => {
        const { Inbox, t } = load('en');
        const off = String(Inbox.renderFunnelVariants({ ...VARIANTS, running: false }));
        assert.ok(text(off).includes(t('inbox.funnel.variants.stopped')));
        assert.ok(text(off).includes('A Warm 40 conversations'));
        assert.match(off, /class="badge badge-neutral"/);
        assert.match(String(Inbox.renderFunnelVariants(VARIANTS)), /class="badge badge-success"/);
    });

    it('names an arm that is no longer in the editor by its letter, as removed', () => {
        const { Inbox } = load('en');
        const gone = { ...VARIANTS, arms: [{ ...VARIANTS.arms[2], label: null, weight: null }] };
        const c = text(armOf(String(Inbox.renderFunnelVariants(gone)), 'C'));
        assert.ok(c.startsWith('C Variant C (removed)'), c);
        assert.equal(c.includes('no new conversations'), false, 'unknown is not retired');
    });

    it('is drawn under the funnel\'s own numbers, and also when nobody wrote in the period (an experiment that has just started)', () => {
        const { Inbox } = load('en');
        Inbox.funnel = { ...Inbox.funnel, days: 30 };
        const full = String(Inbox.renderFunnelBody(FUNNEL));
        assert.ok(full.indexOf('class="dm-funnel-outcomes"') < full.indexOf('id="dm-funnel-variants"'), 'under the outcomes');
        const empty = String(Inbox.renderFunnelBody({ ...FUNNEL, conversations: 0, variants: { ...VARIANTS, comparable: false, arms: VARIANTS.arms.map((a: Json) => ({ ...a, conversations: 0, recommended: 0, link_sent: 0, clicked: 0, enough: false, link: rate(0, 0, null), click: rate(0, 0, null) })) } }));
        assert.ok(text(empty).includes('Nobody wrote to you for the first time in the last 30 days.'));
        assert.match(empty, /id="dm-funnel-variants"/);
    });

    it('draws nothing for a funnel with no experiment: no section, whatever shape the field has', () => {
        const { Inbox } = load('en');
        Inbox.funnel = { ...Inbox.funnel, days: 30 };
        const without = String(Inbox.renderFunnelBody({ ...FUNNEL, variants: undefined }));
        assert.doesNotMatch(without, /dm-funnel-variants/);
        for (const variants of [null, 'x', 7, [], {}, { arms: 'A' }, { arms: [] }, { arms: [null, 1, 'A', { id: 'Z' }, { id: '__proto__' }] }]) {
            assert.equal(String(Inbox.renderFunnelVariants(variants)), '', JSON.stringify(variants));
        }
    });

    it('draws an arm from a fixed table of slots only: a letter the server should not send is not drawn, and the rest are', () => {
        const { Inbox } = load('en');
        const evil = { ...VARIANTS, arms: [...VARIANTS.arms, { ...VARIANTS.arms[0], id: '"><img src=x onerror=alert(1)>' }, { ...VARIANTS.arms[0], id: 'D' }] };
        const markup = String(Inbox.renderFunnelVariants(evil));
        assert.equal((markup.match(/class="dm-funnel-arm"/g) ?? []).length, 3);
        assert.equal(/<img|data-arm="D"/.test(markup), false);
    });

    it('draws the owner\'s names as text and never as markup, in the page\'s direction', () => {
        const { Inbox } = load('en');
        for (const label of ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', '</bdi><img src=x onerror=alert(1)>', "' onmouseover='alert(1)", '{{constructor}}', '${alert(1)}']) {
            const markup = String(Inbox.renderFunnelVariants({ ...VARIANTS, arms: [{ ...VARIANTS.arms[0], label }] }));
            for (const tag of tagsOf(markup)) assert.ok(SAFE_TAGS.has(tag), `${JSON.stringify(label)}: <${tag}>`);
            const openTags = [...markup.matchAll(/<[a-zA-Z][^>]*>/g)].map((m) => m[0]);
            assert.equal(openTags.some((tag) => /\son\w+\s*=|javascript:/i.test(tag)), false, `no tag carries a handler: ${JSON.stringify(label)}`);
            assert.ok(text(markup).includes(label.replace(/\s+/g, ' ')), `the words are there, as words: ${JSON.stringify(label)}`);
            assert.match(markup, /<bdi dir="auto">/, 'isolated, so an Arabic name in an English page keeps its place');
        }
    });

    it('draws a number the server should not send as a count or nothing: a string, a negative, a fraction, a name on the prototype', () => {
        const { Inbox } = load('en');
        const messy = { ...VARIANTS, arms: [{ ...VARIANTS.arms[0], conversations: '12abc', link: { count: -3, of: 'x', pct: 'lots' }, click: null, enough: 'yes' }] };
        const a = text(armOf(String(Inbox.renderFunnelVariants(messy)), 'A'));
        assert.ok(a.includes('A Warm 0 conversations'), a);
        assert.equal(/NaN|undefined|null|lots|-3/.test(a), false, a);
        assert.equal(/\d+%/.test(a), false, '`enough` that is not exactly true is not enough');
    });
});

describe('the funnel card: the A/B wording comparison, in Arabic', () => {
    it('is drawn in Arabic with Latin digits, the arms\' counts in the right plural, and the name isolated', () => {
        const { Inbox, t } = load('ar');
        const markup = String(Inbox.renderFunnelVariants({ ...VARIANTS, arms: [{ ...VARIANTS.arms[0], label: 'دافئ' }, { ...VARIANTS.arms[1], conversations: 2 }, { ...VARIANTS.arms[2], conversations: 1 }, ] }));
        const shown = text(markup);
        assert.ok(shown.includes(t('inbox.funnel.variants.title')));
        assert.ok(shown.includes('A دافئ 40 محادثة'), shown);
        assert.ok(shown.includes('محادثتان'), 'two');
        assert.ok(shown.includes('محادثة واحدة'), 'one');
        assert.equal(/[٠-٩۰-۹]/.test(shown), false, 'Latin digits');
        assert.ok(shown.includes('لا توجد بيانات كافية بعد'), 'the gate, in Arabic');
        assert.match(markup, /<bdi dir="auto">دافئ<\/bdi>/);
    });

    it('draws the retired and removed words in Arabic too', () => {
        const { Inbox, t } = load('ar');
        const shown = text(Inbox.renderFunnelVariants({ ...VARIANTS, arms: [VARIANTS.arms[2], { ...VARIANTS.arms[1], id: 'B', label: null, weight: null }] }));
        assert.ok(shown.includes(t('inbox.funnel.variants.retired')));
        assert.ok(shown.includes(`${t('inbox.funnel.variants.arm', { slot: 'B' })} (${t('inbox.funnel.variants.removed')})`), shown);
    });
});

describe('the funnel card: the A/B wording comparison, wiring', () => {
    it('has every string it uses in both languages, with no placeholder left unfilled and the plural families Arabic needs', () => {
        for (const lang of LANGS) {
            const { t, strings } = load(lang);
            for (const key of ['title', 'running', 'stopped', 'intro', 'arm', 'removed', 'retired', 'notEnough', 'waiting', 'note']) {
                const value = t(`inbox.funnel.variants.${key}`, { slot: 'A', have: '12', need: '30' });
                assert.notEqual(value, `inbox.funnel.variants.${key}`, `${lang} ${key} is translated`);
                assert.equal(/\{\w+\}/.test(value), false, `${lang} ${key}: no unfilled placeholder`);
            }
            for (const count of [0, 1, 2, 3, 11, 100]) {
                const value = t('inbox.funnel.variants.conversations', { count, n: String(count) });
                assert.notEqual(value, 'inbox.funnel.variants.conversations', `${lang} ${count}`);
                assert.equal(/\{\w+\}/.test(value), false, `${lang} ${count}`);
            }
            const families = Object.keys(strings[lang]).filter((k) => k.startsWith('inbox.funnel.variants.conversations_')).map((k) => k.split('_')[1]).sort();
            assert.deepEqual(families, lang === 'ar' ? ['few', 'many', 'one', 'other', 'two'] : ['one', 'other']);
        }
    });

    it('has a stylesheet that holds at a phone\'s width: the box shrinks, the name wraps anywhere, and nothing has a fixed width', () => {
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        assert.match(css, /\.dm-funnel-arm \{[^}]*min-inline-size: 0/);
        assert.match(css, /\.dm-funnel-arm-name \{[^}]*overflow-wrap: anywhere/);
        assert.match(css, /\.dm-funnel-arm-head \{[^}]*flex-wrap: wrap/);
        for (const rule of ['dm-funnel-variants', 'dm-funnel-arms', 'dm-funnel-arm', 'dm-funnel-arm-head', 'dm-funnel-arm-name']) {
            const body = css.match(new RegExp(`\\.${rule} \\{([^}]*)\\}`))?.[1] ?? '';
            assert.ok(body.length > 0, `${rule} has a rule`);
            assert.doesNotMatch(body, /(?<![-\w])(width|inline-size|min-width): \d+px/, `${rule}: no fixed width`);
        }
    });
});
