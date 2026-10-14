/**
 * The dashboard's half of DM plan S11 and S12: the stage chip, the Hot filter, what the bot decided under each of its replies, the link clicks
 * in the thread's header, and the funnel card.
 *
 * Loaded like the other dashboard tests: the REAL shipped files in a `node:vm` context with a fake DOM, so these test what ships. What is pinned,
 * because a screenshot cannot check it: which threads are "hot" and which never are, that every word on the screen comes from a fixed table
 * (and that the tables are the server's), that a stage, an intent, an offer id or a funnel number from the server is text and never markup,
 * that the card asks the server only when it is opened and drops an answer that arrives late, and that every string exists in both languages.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { HANDOFF_REASONS, INTENTS, NEXT_ACTIONS, STAGES } from '../services/dmSales/types.js';

type Json = any;

interface FakeEl {
    id: string;
    innerHTML: string;
    attrs: Record<string, string>;
    hidden: boolean;
    open: boolean;
    setAttribute(name: string, value: string): void;
    classList: { toggle(name: string, force?: boolean): void; add(name: string): void; remove(name: string): void; contains(name: string): boolean };
}

function fakeEl(id: string): FakeEl {
    const el: FakeEl = {
        id, innerHTML: '', attrs: {}, hidden: true, open: false,
        setAttribute(name, value) { el.attrs[name] = value; },
        classList: {
            toggle(name, force) { if (name === 'hidden') el.hidden = force ?? !el.hidden; if (name === 'is-open') el.open = force ?? !el.open; },
            add(name) { if (name === 'hidden') el.hidden = true; },
            remove(name) { if (name === 'hidden') el.hidden = false; },
            contains(name) { return name === 'hidden' ? el.hidden : name === 'is-open' ? el.open : false; },
        },
    };
    return el;
}

interface Loaded {
    Inbox: Json;
    UI: Json;
    motion: Json;
    t: (key: string, params?: Record<string, unknown>) => string;
    hash: Record<string, string>;
    api: Record<string, (...args: Json[]) => unknown>;
    calls: Array<{ method: string; args: Json[] }>;
    dom: Map<string, FakeEl>;
    mount(): { toggle: FakeEl; panel: FakeEl };
    strings: Record<'ar' | 'en', Record<string, string>>;
}

function load(lang: 'ar' | 'en' = 'en'): Loaded {
    const noop = (): void => {};
    const dom = new Map<string, FakeEl>();
    const api: Record<string, (...args: Json[]) => unknown> = {};
    const calls: Array<{ method: string; args: Json[] }> = [];
    const hash: Record<string, string> = {};
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
            getElementById: (id: string) => dom.get(id) ?? null, activeElement: null, visibilityState: 'visible',
        },
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
        Intl, console: { ...console, error: noop, debug: noop }, clearTimeout, URLSearchParams,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        setTimeout: (fn: () => void, ms?: number) => { const h = setTimeout(fn, ms); (h as Json).unref?.(); return h; },
        setInterval: (fn: () => void, ms?: number) => { const h = setInterval(fn, ms); (h as Json).unref?.(); return h; },
        clearInterval, requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang }, CSS: { escape: (v: string) => String(v) },
        API: new Proxy(api, {
            get: (target, prop: string) => (prop === 'token' ? 'tok' : prop in target
                ? (...args: Json[]) => { calls.push({ method: prop, args }); return target[prop]!(...args); }
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        App: {
            currentTheme: () => 'auto', navigate: noop, session: { tenantId: 't1' }, hashParam: (name: string) => hash[name] || '',
            canOperate: () => true, setInboxWaiting: noop,
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js', 'dashboard/js/motion.js',
        'dashboard/js/pages/inbox.js',
    ]) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const got = vm.runInContext('({ Inbox: InboxPage, UI, t, strings: I18N.strings, motion: Motion })', ctx);
    got.UI.icons = noop;
    got.UI.captureFocus = () => null;
    got.UI.restoreFocus = () => true;
    const mount = () => {
        const toggle = fakeEl('dm-funnel-toggle');
        const panel = fakeEl('dm-funnel-panel');
        dom.set(toggle.id, toggle);
        dom.set(panel.id, panel);
        return { toggle, panel };
    };
    return { Inbox: got.Inbox, UI: got.UI, motion: got.motion, t: got.t, hash, api, calls, dom, mount, strings: got.strings };
}

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦⁩]/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').replace(/ ([.,:;])/g, '$1').trim();
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));
async function settle(rounds = 8): Promise<void> { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0)); }

/** The tags a piece of markup opens: nothing but these may appear, whatever a message or a field said. */
const tagsOf = (markup: unknown): string[] => [...String(markup).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]!.toLowerCase());
const SAFE_TAGS = new Set(['div', 'span', 'bdi', 'i', 'strong', 'p', 'dl', 'dt', 'dd', 'ol', 'ul', 'li', 'progress', 'button', 'section']);
const attrNames = (markup: unknown): string[] => [...String(markup).matchAll(/<[a-zA-Z][^>]*>/g)].flatMap((m) => [...m[0].matchAll(/\s([a-zA-Z-]+)=/g)].map((a) => a[1]!.toLowerCase()));

const XSS = [
    '<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', '</bdi><img src=x onerror=alert(1)>', "' onmouseover='alert(1)", 'javascript:alert(1)',
    '<svg onload=alert(1)>', '{{constructor}}', '${alert(1)}',
];

const NOW = Date.parse('2026-10-14T12:00:00Z');
const HOUR = 3600 * 1000;
const at = (msBefore: number): string => new Date(NOW - msBefore).toISOString();

// ─── The stage chip ─────────────────────────────────────────────────────────────────────────

describe('Inbox sales view: the stage chip', () => {
    const TONES: Record<string, string> = {
        new: 'neutral', qualify: 'info', recommend: 'info', objection: 'warning', link: 'success', follow_up: 'info', handoff: 'warning', closed: 'neutral',
    };

    it('is drawn for each of the flow\'s stages: its word, in its tone, with the stage on it', () => {
        for (const lang of ['en', 'ar'] as const) {
            const L = load(lang);
            for (const stage of STAGES) {
                const chip = String(L.Inbox.stageChip(stage));
                assert.match(chip, new RegExp(`class="badge badge-${TONES[stage]}"`), `${lang} ${stage}`);
                assert.match(chip, new RegExp(`data-stage="${stage}"`));
                assert.equal(text(chip), L.strings[lang][`inbox.stage.${stage}`], `${lang} ${stage}: the word`);
            }
        }
    });

    it('the chip\'s tones are the ones the stylesheet has, one per stage and no more', () => {
        const L = load();
        assert.deepEqual(plain(Object.fromEntries(STAGES.map((s) => [s, L.Inbox.STAGE_TONES[s]]))), TONES);
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        for (const tone of new Set(Object.values(TONES))) assert.match(css, new RegExp(`\\.badge-${tone}\\s*\\{`), `.badge-${tone} exists`);
        assert.equal(Object.keys(L.Inbox.STAGE_TONES).length, STAGES.length);
    });

    it('is no chip at all for anything that is not a stage: a thread from before v39, a stranger, a name on the prototype', () => {
        const L = load();
        for (const stage of [undefined, null, '', 'unknown', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 42, {}, ['link'], ...XSS]) {
            assert.equal(String(L.Inbox.stageChip(stage)), '', JSON.stringify(stage));
        }
    });

    it('is on each thread of the list, and a thread with no stage shows none', () => {
        const L = load();
        const row = (stage: unknown) => String(L.Inbox.threadRow({ id: 'a', username: 'sara_dev', is_bot_active: true, stage, last_message_at: at(HOUR) }));
        assert.match(row('link'), /data-stage="link"/);
        assert.equal(text(row('link')).includes(L.t('inbox.stage.link')), true);
        assert.match(row('new'), /data-stage="new"/, 'a new thread has its stage too');
        assert.doesNotMatch(row(undefined), /data-stage=/);
        assert.doesNotMatch(row('<img src=x onerror=alert(1)>'), /data-stage=|<img/);
    });

    it('is in the header with its name, beside the other chips', () => {
        const L = load();
        const header = text(L.Inbox.metaMarkup({ id: 'a', stage: 'recommend', created_at: at(HOUR), message_count: 3 }));
        assert.ok(header.includes(L.t('inbox.stage.chip', { stage: L.t('inbox.stage.recommend') })), header);
        assert.equal(text(L.Inbox.metaMarkup({ id: 'a', stage: 'nonsense', message_count: 3 })).includes(L.t('inbox.stage.chip', { stage: 'nonsense' })), false);
        const ar = load('ar');
        assert.ok(text(ar.Inbox.metaMarkup({ id: 'a', stage: 'link', message_count: 1 })).includes('المرحلة: أُرسل الرابط'));
    });

    it('repaints a row when its stage changes, or when it turns hot, and not otherwise', () => {
        const L = load();
        const container = { removeAttribute: () => {}, setAttribute: () => {}, querySelector: () => null, innerHTML: '' };
        L.dom.set('threads-container', container as unknown as FakeEl);
        let options: Json = null;
        L.motion.patchList = (_container: unknown, _rows: unknown, given: Json) => { options = given; };
        const base = { id: 'a', username: 'sara_dev', is_bot_active: true, last_message_direction: 'inbound', last_message_at: at(HOUR), stage: 'qualify' };
        L.Inbox.threads = [base];
        L.Inbox.renderThreads();
        assert.ok(options, 'the list was patched');
        const sig = (x: Json): string => options.signature(x);
        assert.notEqual(sig(base), sig({ ...base, stage: 'link' }), 'a new stage');
        assert.notEqual(sig(base), sig({ ...base, link_clicks: { links: 1, clicks: 1 } }), 'a person opened the link: now hot');
        assert.equal(sig(base), sig({ ...base, link_clicks: { links: 1, clicks: 0, prefetch: 5 } }), 'previews change nothing the row shows');
        assert.equal(sig(base), sig({ ...base }), 'and an idle poll changes nothing');
    });
});

// ─── The Hot filter ─────────────────────────────────────────────────────────────────────────

describe('Inbox sales view: Hot', () => {
    const L = load();
    const click = (clicks: number, over: Json = {}): Json => ({ links: 1, clicks, prefetch: 0, last_click_at: at(HOUR), ...over });

    it('is a person who opened the link we sent, or who said they are ready to buy, or a lead the bot flagged', () => {
        assert.equal(L.Inbox.isHot({ id: 'a', stage: 'link', link_clicks: click(1) }), true, 'a person opened the link');
        assert.equal(L.Inbox.isHot({ id: 'a', stage: 'recommend', last_intent: 'ready_to_buy' }), true, 'ready to buy');
        assert.equal(L.Inbox.isHot({ id: 'a', stage: 'handoff', handoff_reason: 'hot_lead' }), true, 'flagged by the bot');
    });

    it('is not a link that only crawlers opened, a link nobody opened, or any other intent', () => {
        assert.equal(L.Inbox.isHot({ id: 'a', stage: 'link', link_clicks: click(0, { prefetch: 6 }) }), false, 'previews are not people');
        assert.equal(L.Inbox.isHot({ id: 'a', stage: 'link', link_clicks: click(0) }), false);
        for (const intent of INTENTS.filter((i) => i !== 'ready_to_buy')) assert.equal(L.Inbox.isHot({ id: 'a', last_intent: intent }), false, intent);
        for (const reason of HANDOFF_REASONS.filter((r) => r !== 'hot_lead')) assert.equal(L.Inbox.isHot({ id: 'a', handoff_reason: reason }), false, reason);
    });

    it('is never someone who asked to be left alone, or whose conversation is closed: an old click is not a lead', () => {
        assert.equal(L.Inbox.isHot({ id: 'a', stage: 'closed', link_clicks: click(3), last_intent: 'ready_to_buy' }), false);
        assert.equal(L.Inbox.isHot({ id: 'a', stage: 'link', opted_out_at: at(HOUR), link_clicks: click(3) }), false);
        assert.equal(L.Inbox.isHot({ id: 'a', stage: 'closed', handoff_reason: 'hot_lead' }), false);
    });

    it('reads what the server sends as it comes: a database that is behind has no hot threads, and nonsense is not a click', () => {
        for (const thread of [null, undefined, {}, { id: 'a' }, { id: 'a', link_clicks: null }, { id: 'a', link_clicks: 'many' }, { id: 'a', link_clicks: { clicks: 'abc' } },
            { id: 'a', link_clicks: { clicks: -3 } }, { id: 'a', link_clicks: { clicks: NaN } }, { id: 'a', link_clicks: [] }]) {
            assert.equal(L.Inbox.isHot(thread), false, JSON.stringify(thread));
        }
        assert.equal(L.Inbox.isHot({ id: 'a', link_clicks: { clicks: '2' } }), true, 'a count that arrives as text is still a count');
    });

    it('is its own filter, between Needs you and AI paused, and keeps only these threads', () => {
        const I = load().Inbox;
        assert.deepEqual(plain(I.FILTERS), ['all', 'waiting', 'needs_you', 'hot', 'paused']);
        I.threads = [
            { id: 'a', link_clicks: click(2), stage: 'link' }, { id: 'b', stage: 'link', link_clicks: click(0) }, { id: 'c', last_intent: 'ready_to_buy' },
            { id: 'd', stage: 'closed', link_clicks: click(5) }, { id: 'e', is_bot_active: false },
        ];
        I.filter = 'hot';
        assert.deepEqual(plain(I.visibleThreads().map((x: Json) => x.id)), ['a', 'c']);
        I.filter = 'all';
        assert.equal(I.visibleThreads().length, 5, 'All still shows everything');
    });

    it('is seeded from the address like the other filters, and the address is data', () => {
        const s = load();
        s.hash['filter'] = 'hot';
        assert.equal(s.Inbox.filterFromHash(), 'hot');
        s.hash['filter'] = 'Hot ';
        assert.equal(s.Inbox.filterFromHash(), 'all');
        assert.ok(String(s.Inbox.layout()).includes('data-action="inbox:setFilter" data-filter="hot"'), 'a button for it');
    });

    it('says so when there is none, and is named in both languages', () => {
        for (const lang of ['en', 'ar'] as const) {
            const s = load(lang);
            assert.ok(String(s.Inbox.emptyMarkup('hot')).includes(s.t('inbox.noHot')));
            assert.notEqual(s.t('inbox.filter.hot'), 'inbox.filter.hot');
            assert.notEqual(s.t('inbox.hot'), 'inbox.hot');
        }
        const s = load();
        s.Inbox.threads = [{ id: 'a' }];
        s.Inbox.filter = 'hot';
        assert.equal(s.Inbox.emptyKind(), 'hot');
    });

    it('marks a hot thread in the list and in the header, and no other', () => {
        const s = load();
        const hot = { id: 'a', username: 'sara_dev', stage: 'link', link_clicks: click(2), last_message_at: at(HOUR) };
        assert.match(String(s.Inbox.threadRow(hot)), /data-hot/);
        assert.doesNotMatch(String(s.Inbox.threadRow({ ...hot, link_clicks: click(0) })), /data-hot/);
        assert.ok(text(s.Inbox.metaMarkup(hot)).includes(s.t('inbox.hot')));
    });
});

// ─── The link clicks in the header ───────────────────────────────────────────────────────────

describe('Inbox sales view: the link clicks of a thread', () => {
    const L = load();
    const chips = (thread: Json): string => text(L.Inbox.linkChips(thread).map(String).join(' '));

    it('say how many times a person opened the link and when last, and that previews are not counted', () => {
        const thread = { id: 'a', last_link_at: at(5 * HOUR), link_clicks: { links: 1, clicks: 3, prefetch: 9, last_click_at: at(2 * HOUR) } };
        const shown = chips(thread);
        assert.ok(shown.includes(L.t('inbox.links.clicked', { count: 3, n: '3' })), shown);
        assert.ok(shown.includes(L.t('inbox.links.last', { when: L.Inbox.threadTime(at(2 * HOUR)) })), shown);
        assert.ok(shown.includes(L.t('inbox.links.note')), 'the chip says what it does not count');
        assert.equal(shown.includes('9'), false, 'the nine previews are nowhere in the number');
        assert.ok(chips({ ...thread, link_clicks: { ...thread.link_clicks, clicks: 1 } }).includes('Link opened 1 time'), 'singular');
    });

    it('say that the link went out and nobody has opened it, when previews are all there are', () => {
        const shown = chips({ id: 'a', last_link_at: at(HOUR), link_clicks: { links: 1, clicks: 0, prefetch: 4, last_click_at: null } });
        assert.ok(shown.includes(L.t('inbox.links.notClicked')));
        assert.equal(/opened \d/.test(shown), false);
    });

    it('say only that the link went out when what people did with it is not known, and nothing for a thread with no link', () => {
        assert.ok(chips({ id: 'a', last_link_at: at(HOUR), link_clicks: null }).includes(L.t('inbox.links.sent')));
        assert.equal(chips({ id: 'a', last_link_at: at(HOUR), link_clicks: null }).includes(L.t('inbox.links.notClicked')), false, 'no claim the lookup could not make');
        assert.deepEqual(plain(L.Inbox.linkChips({ id: 'a', link_clicks: null })), []);
        assert.deepEqual(plain(L.Inbox.linkChips({ id: 'a', link_clicks: { links: 0, clicks: 0 } })), []);
        assert.deepEqual(plain(L.Inbox.linkChips(null)), []);
    });

    it('are in the header strip, escaped, in both languages', () => {
        for (const lang of ['en', 'ar'] as const) {
            const s = load(lang);
            const strip = text(s.Inbox.metaMarkup({ id: 'a', stage: 'link', last_link_at: at(HOUR), link_clicks: { links: 1, clicks: 2, prefetch: 0, last_click_at: at(HOUR) }, message_count: 4 }));
            assert.ok(strip.includes(s.t('inbox.links.clicked', { count: 2, n: '2' })), `${lang}: ${strip}`);
        }
        const hostile = String(L.Inbox.metaMarkup({ id: 'a', last_link_at: at(HOUR), link_clicks: { links: 1, clicks: 1, last_click_at: '<img src=x onerror=alert(1)>' } }));
        assert.doesNotMatch(hostile, /<img/);
    });
});

// ─── What the bot decided, under its reply ───────────────────────────────────────────────────

describe('Inbox sales view: ai_meta under an AI reply', () => {
    const L = load();
    const reply = (meta: unknown, over: Json = {}): Json => ({
        id: 'm1', direction: 'outbound', sender: 'ai', text: 'تفضّل الرابط', created_at: at(HOUR), ai_meta: meta, ...over,
    });
    const FULL = {
        intent: 'price', stage: 'link', next_action: 'send_link', offer_id: 'agentic-ai', engine: 'providers', handoff_reason: 'none',
        model: 'claude-sonnet-5-5', latency_ms: 4100, guard: { retried: null, violations: [], overrides: [] },
    };

    it('shows the intent, the stage, the next action, the offer and the engine, each by its word', () => {
        const markup = String(L.Inbox.messageBubble(reply(FULL)));
        assert.match(markup, /data-ai-meta/);
        const line = text(markup.slice(markup.indexOf('data-ai-meta')));
        for (const word of [
            `${L.t('inbox.aiMeta.intent')}: ${L.t('inbox.intent.price')}`, `${L.t('inbox.aiMeta.stage')}: ${L.t('inbox.stage.link')}`,
            `${L.t('inbox.aiMeta.next')}: ${L.t('inbox.nextAction.send_link')}`, `${L.t('inbox.aiMeta.offer')}: agentic-ai`,
            `${L.t('inbox.aiMeta.engine')}: ${L.t('inbox.engine.providers')}`,
        ]) assert.ok(line.includes(word), `${word} in «${line}»`);
        assert.match(markup, /data-stage="link"/, 'the stage is the same chip the list draws');
    });

    it('shows why a conversation was handed over, and not "none"', () => {
        const handoff = String(L.Inbox.aiMetaDetail(reply({ ...FULL, stage: 'handoff', next_action: 'handoff', handoff_reason: 'refund' })));
        assert.ok(text(handoff).includes(`${L.t('inbox.aiMeta.handoff')}: ${L.t('inbox.handoffReason.refund')}`));
        assert.match(handoff, /badge badge-warning/);
        assert.equal(text(L.Inbox.aiMetaDetail(reply(FULL))).includes(L.t('inbox.aiMeta.handoff')), false, 'none is no reason');
        assert.equal(text(L.Inbox.aiMetaDetail(reply({ ...FULL, offer_id: 'none' }))).includes(L.t('inbox.aiMeta.offer')), false, 'none is no offer');
    });

    it('draws what a row has: the follow-up nudge and the handoff line carry fewer fields, an old reply none', () => {
        const nudge = text(L.Inbox.aiMetaDetail(reply({ kind: 'followup', engine: 'kit', stage: 'follow_up', next_action: 'reply', offer_id: 'agentic-ai' })));
        assert.ok(nudge.includes(L.t('inbox.stage.follow_up')) && nudge.includes(L.t('inbox.engine.kit')));
        assert.equal(nudge.includes(L.t('inbox.aiMeta.intent')), false);
        for (const meta of [null, undefined, '', {}, [], 'not json', 42, true]) assert.equal(String(L.Inbox.aiMetaDetail(reply(meta))), '', JSON.stringify(meta));
        assert.equal(String(L.Inbox.messageBubble(reply(null))).includes('data-ai-meta'), false);
    });

    it('reads ai_meta as it arrives: an object (JSONB), or a JSON string', () => {
        const fromString = String(L.Inbox.aiMetaDetail(reply(JSON.stringify(FULL))));
        assert.equal(fromString, String(L.Inbox.aiMetaDetail(reply(FULL))));
        assert.match(fromString, /data-ai-meta/);
    });

    it('is under the AI\'s replies only: not the owner\'s, not a customer\'s, whatever the row carries', () => {
        assert.equal(String(L.Inbox.messageBubble(reply(FULL, { sender: 'operator' }))).includes('data-ai-meta'), false);
        assert.equal(String(L.Inbox.messageBubble(reply(FULL, { sender: 'automation' }))).includes('data-ai-meta'), false);
        assert.equal(String(L.Inbox.messageBubble(reply(FULL, { direction: 'inbound', sender: 'customer' }))).includes('data-ai-meta'), false);
        assert.equal(String(L.Inbox.messageBubble(reply(FULL, { sender: null }))).includes('data-ai-meta'), false);
    });

    it('sits beside the existing timing line, and the model, without replacing them', () => {
        const markup = String(L.Inbox.messageBubble({ ...reply(FULL), ai: { model: 'claude-sonnet-5-5', provider: 'anthropic', source: 'usage' } }, { ms: 4000, attempts: 1 }));
        assert.ok(text(markup).includes(L.t('inbox.detail.repliedIn', { time: L.Inbox.durationText(4000) })));
        assert.ok(markup.includes('claude-sonnet-5-5'));
        assert.match(markup, /data-ai-meta/);
        assert.match(markup, /message-row--tagged/, 'the row keeps its AI tag above the bubble');
    });

    it('turns every field of a hostile row into text: no tag, no attribute, no handler', () => {
        for (const evil of XSS) {
            const meta = { intent: evil, stage: evil, next_action: evil, offer_id: evil, engine: evil, handoff_reason: evil, kind: evil };
            const markup = String(L.Inbox.messageBubble(reply(meta, { text: evil })));
            const stray = tagsOf(markup).filter((tag) => !SAFE_TAGS.has(tag));
            assert.deepEqual(stray, [], `${evil}: only the page's own tags`);
            assert.equal(attrNames(markup).some((a) => a.startsWith('on')), false, `${evil}: no event handler attribute`);
            assert.doesNotMatch(markup, /<img|<script|<svg/i, evil);
            assert.ok(markup.includes('&lt;') || !evil.includes('<'), `${evil}: escaped`);
        }
        // The same through the per-field path, one field at a time, so one clean field cannot hide a dirty one.
        for (const field of ['intent', 'stage', 'next_action', 'offer_id', 'engine', 'handoff_reason']) {
            const markup = String(L.Inbox.aiMetaDetail(reply({ ...FULL, [field]: '<img src=x onerror=alert(1)>' })));
            assert.doesNotMatch(markup, /<img/, field);
            assert.match(text(markup), /<img src=x onerror=alert\(1\)>/, `${field}: shown as the text it is`);
        }
    });

    it('never looks a stranger up: a name on the prototype or a string made like a key is shown as itself', () => {
        for (const odd of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'inbox.intent.price', 'PRICE', 'Price']) {
            const shown = text(L.Inbox.aiMetaDetail(reply({ intent: odd })));
            assert.ok(shown.endsWith(odd), `${odd}: «${shown}»`);
            assert.equal(shown.includes(L.t('inbox.intent.price')), false, `${odd} is not "price"`);
        }
    });

    it('cuts a long offer id or unknown value short, so one string cannot stretch the line', () => {
        const long = 'x'.repeat(500);
        const shown = text(L.Inbox.aiMetaDetail(reply({ offer_id: long, intent: long })));
        assert.equal(shown.includes('x'.repeat(L.Inbox.AI_META_TEXT_MAX + 1)), false);
        assert.ok(shown.includes('…'));
    });

    it('draws a value of any other type as nothing, never "[object Object]"', () => {
        const shown = text(L.Inbox.aiMetaDetail(reply({ intent: { a: 1 }, stage: ['link'], next_action: 7, offer_id: null, engine: false, handoff_reason: {} })));
        assert.equal(shown.includes('[object'), false);
        assert.ok(!shown.includes('NaN') && !shown.includes('undefined') && !shown.includes('null'), shown);
    });

    it('is worded in Arabic in the Arabic interface', () => {
        const ar = load('ar');
        const shown = text(ar.Inbox.aiMetaDetail(reply({ ...FULL, handoff_reason: 'complaint' })));
        for (const key of ['inbox.intent.price', 'inbox.stage.link', 'inbox.nextAction.send_link', 'inbox.engine.providers', 'inbox.handoffReason.complaint']) {
            assert.ok(shown.includes(ar.strings.ar[key]!), key);
        }
    });
});

// ─── The tables the page draws from are the server's ──────────────────────────────────────────

describe('Inbox sales view: the vocabulary', () => {
    const L = load();

    it('is the server\'s: intents, stages, next actions and handoff reasons (minus the schema\'s "none"), and every engine ai_meta can carry', () => {
        assert.deepEqual(plain(L.Inbox.AI_INTENTS), [...INTENTS]);
        assert.deepEqual(plain(L.Inbox.STAGES), [...STAGES]);
        assert.deepEqual(plain(L.Inbox.NEXT_ACTIONS), [...NEXT_ACTIONS]);
        assert.deepEqual(plain(L.Inbox.HANDOFF_REASONS), HANDOFF_REASONS.filter((r) => r !== 'none'));
        const engines = new Set<string>();
        for (const file of ['src/services/dmSales/turn.ts', 'src/services/dmSales/followupJob.ts', 'src/services/dmSales/failureHandoff.ts', 'src/webhook/attachmentAck.ts']) {
            for (const m of readFileSync(file, 'utf8').matchAll(/\bengine: '([a-z_]+)'/g)) engines.add(m[1]!);
        }
        assert.deepEqual([...engines].sort(), [...L.Inbox.ENGINES].sort(), 'an engine the server can write has a word here, and no word is for an engine nothing writes');
    });

    it('has a word in both languages for every entry, and for every other string the sales view uses', () => {
        const keys = [
            ...INTENTS.map((k) => `inbox.intent.${k}`), ...STAGES.map((k) => `inbox.stage.${k}`), ...NEXT_ACTIONS.map((k) => `inbox.nextAction.${k}`),
            ...HANDOFF_REASONS.filter((r) => r !== 'none').map((k) => `inbox.handoffReason.${k}`), ...L.Inbox.ENGINES.map((k: string) => `inbox.engine.${k}`),
            'inbox.stage.chip', 'inbox.filter.hot', 'inbox.hot', 'inbox.noHot', 'inbox.links.last', 'inbox.links.sent', 'inbox.links.notClicked', 'inbox.links.note',
            ...['intent', 'stage', 'next', 'offer', 'engine', 'handoff'].map((k) => `inbox.aiMeta.${k}`),
            'inbox.funnel.title', 'inbox.funnel.windowLabel', 'inbox.funnel.failed', 'inbox.funnel.of', 'inbox.funnel.of.recommended', 'inbox.funnel.of.linked',
            'inbox.funnel.of.conversations', 'inbox.funnel.reply.median', 'inbox.funnel.reply.none', 'inbox.funnel.outcomes',
            ...L.Inbox.FUNNEL_STEPS.map((k: string) => `inbox.funnel.step.${k}`),
            ...['link', 'click', 'handoff', 'optOut'].map((k) => `inbox.funnel.rate.${k}`),
            ...['followUp', 'handoff', 'closed', 'optedOut', 'complaints'].map((k) => `inbox.funnel.outcome.${k}`),
        ];
        for (const lang of ['en', 'ar'] as const) {
            for (const key of keys) assert.ok(typeof L.strings[lang][key] === 'string' && L.strings[lang][key]!.length > 0, `${lang} ${key}`);
        }
        // The plural families the card asks for with a count: a form for each number it can be (7, 30, 90) in each language.
        for (const lang of ['en', 'ar'] as const) {
            const s = load(lang);
            for (const key of ['inbox.funnel.window', 'inbox.funnel.intro', 'inbox.funnel.empty']) {
                for (const days of [7, 30, 90]) {
                    const shown = s.t(key, { count: days, n: String(days) });
                    assert.notEqual(shown, key, `${lang} ${key} ${days}`);
                    assert.ok(shown.includes(String(days)), `${lang} ${key} ${days}: «${shown}»`);
                }
            }
            for (const key of ['inbox.funnel.reply.p90', 'inbox.funnel.previews', 'inbox.links.clicked']) {
                for (const n of [0, 1, 2, 3, 11, 100]) {
                    assert.notEqual(s.t(key, { count: n, n: String(n), time: '4 s' }), key, `${lang} ${key} ${n}`);
                }
            }
        }
    });
});

// ─── The funnel card ─────────────────────────────────────────────────────────────────────────

/** What `GET /api/dm/funnel` answers for the world of dmFunnelTestFixtures.ts over 30 days. */
const FUNNEL: Json = {
    days: 30, since: '2026-09-14T12:00:00.000Z', conversations: 10,
    steps: [
        { id: 'conversations', count: 10, pct: 100 }, { id: 'qualified', count: 7, pct: 70 }, { id: 'recommended', count: 6, pct: 60 },
        { id: 'link_sent', count: 4, pct: 40 }, { id: 'clicked', count: 2, pct: 20 },
    ],
    outcomes: { follow_up: 1, handoff: 2, closed: 1, opted_out: 1, complaints: 1 },
    rates: {
        link: { count: 4, of: 6, pct: 67 }, click: { count: 2, of: 4, pct: 50 }, handoff: { count: 2, of: 10, pct: 20 }, opt_out: { count: 1, of: 10, pct: 10 },
    },
    clicks: { people: 2, human: 4, preview: 3 },
    reply: { sample: 11, median_ms: 10000, p90_ms: 16000 },
};

describe('Inbox sales view: the funnel card', () => {
    it('is closed when the page opens, and asks the server nothing until it is opened', async () => {
        const L = load();
        L.api.getConversations = () => Promise.resolve({ data: [], pagination: { total: 0 } });
        L.api.getDmFunnel = () => Promise.resolve(FUNNEL);
        const { toggle, panel } = L.mount();
        L.Inbox.resetViewState();
        assert.equal(toggle.attrs['aria-expanded'], 'false');
        assert.equal(panel.hidden, true);
        assert.equal(panel.innerHTML, '');
        assert.equal(L.calls.filter((c) => c.method === 'getDmFunnel').length, 0);
        const shell = String(L.Inbox.layout());
        assert.match(shell, /id="dm-funnel-toggle"[^>]*data-action="inbox:toggleFunnel"[^>]*aria-expanded="false"[^>]*aria-controls="dm-funnel-panel"/);
        assert.match(shell, /id="dm-funnel-panel"/);
        assert.match(shell, /data-filter="hot"/);
        assert.ok(shell.indexOf('id="threads-stale"') < shell.indexOf('id="dm-funnel-toggle"') && shell.indexOf('id="dm-funnel-toggle"') < shell.indexOf('id="threads-container"'), 'between the search block and the list');
    });

    it('opens on a press, asks for 30 days once, and draws the steps, the rates, the reply time and the outcomes', async () => {
        const L = load();
        L.api.getDmFunnel = () => Promise.resolve(FUNNEL);
        const { toggle, panel } = L.mount();
        L.Inbox.toggleFunnel();
        assert.equal(toggle.attrs['aria-expanded'], 'true');
        assert.equal(panel.hidden, false);
        assert.match(panel.innerHTML, /role="status"/, 'while it loads');
        await settle();
        assert.deepEqual(plain(L.calls.filter((c) => c.method === 'getDmFunnel').map((c) => c.args)), [[30]]);

        const shown = text(panel.innerHTML);
        for (const [id, count, pct] of [['conversations', 10, 100], ['qualified', 7, 70], ['recommended', 6, 60], ['link_sent', 4, 40], ['clicked', 2, 20]] as const) {
            assert.ok(shown.includes(`${L.t(`inbox.funnel.step.${id}`)} ${count} · ${pct}%`), `${id}: ${shown}`);
        }
        assert.ok(shown.includes('67% 4 of 6 recommended'), shown);
        assert.ok(shown.includes('50% 2 of 4 with a link'), shown);
        assert.ok(shown.includes('20% 2 of 10 conversations'), shown);
        assert.ok(shown.includes('10% 1 of 10 conversations'), shown);
        assert.ok(shown.includes(`${L.t('inbox.funnel.reply.median')} 10 s 9 in 10 within 16 s · 11 replies`), shown);
        for (const [word, n] of [['Follow-ups sent', 1], ['Handed to you', 2], ['Closed', 1], ['Opted out', 1], ['Complaints', 1]] as const) assert.ok(shown.includes(`${word} ${n}`), word);
        assert.ok(shown.includes('3 link previews and prefetches were ignored'), shown);
        assert.match(panel.innerHTML, /<progress class="studio-meter" max="10" value="7"/);
    });

    it('offers 7, 30 and 90 days, marks the one shown, and asks again for another', async () => {
        const L = load();
        L.api.getDmFunnel = (days: number) => Promise.resolve({ ...FUNNEL, days });
        const { panel } = L.mount();
        L.Inbox.toggleFunnel();
        await settle();
        for (const days of [7, 30, 90]) assert.match(panel.innerHTML, new RegExp(`id="dm-funnel-window-${days}"[^>]*data-days="${days}"[^>]*aria-pressed="${days === 30 ? 'true' : 'false'}"`));
        await L.Inbox.setFunnelWindow('7');
        assert.deepEqual(plain(L.calls.filter((c) => c.method === 'getDmFunnel').map((c) => c.args)), [[30], [7]]);
        assert.match(panel.innerHTML, /id="dm-funnel-window-7"[^>]*aria-pressed="true"/);
        await L.Inbox.setFunnelWindow('7');
        await L.Inbox.setFunnelWindow('14');
        await L.Inbox.setFunnelWindow('<b>');
        assert.equal(L.calls.filter((c) => c.method === 'getDmFunnel').length, 2, 'the same period, or a period the server does not have, asks nothing');
    });

    it('keeps what it has when closed and reopened, and asks again only when that is old', async () => {
        const L = load();
        L.api.getDmFunnel = () => Promise.resolve(FUNNEL);
        const { panel } = L.mount();
        L.Inbox.toggleFunnel();
        await settle();
        L.Inbox.toggleFunnel();
        assert.equal(panel.innerHTML, '', 'closed: nothing in the page');
        L.Inbox.toggleFunnel();
        assert.ok(text(panel.innerHTML).includes('67%'), 'reopened with the last answer at once');
        assert.equal(L.calls.filter((c) => c.method === 'getDmFunnel').length, 1);
        L.Inbox.toggleFunnel();
        L.Inbox.funnel.at = Date.now() - L.Inbox.FUNNEL_STALE_MS - 1000;
        L.Inbox.toggleFunnel();
        await settle();
        assert.equal(L.calls.filter((c) => c.method === 'getDmFunnel').length, 2);
    });

    it('drops an answer that arrives after a newer question', async () => {
        const L = load();
        let release: (v: Json) => void = () => {};
        L.api.getDmFunnel = (days: number) => (days === 30 ? new Promise((r) => { release = r; }) : Promise.resolve({ ...FUNNEL, days, conversations: 4, steps: FUNNEL.steps.map((s: Json) => ({ ...s, count: 1 })) }));
        const { panel } = L.mount();
        L.Inbox.toggleFunnel();                         // 30 days: slow
        await L.Inbox.setFunnelWindow('7');             // 7 days: answers at once
        assert.equal(L.Inbox.funnel.days, 7);
        release({ ...FUNNEL, days: 30 });                // the old answer lands last
        await settle();
        assert.equal(L.Inbox.funnel.days, 7, 'the period on screen is the one asked for last');
        assert.equal(L.Inbox.funnel.data.conversations, 4);
        assert.ok(text(panel.innerHTML).includes('Conversations 1 · 25%'));
    });

    it('drops an answer that arrives after the page was left or the tenant changed, and is closed on the next', async () => {
        const L = load();
        let release: (v: Json) => void = () => {};
        L.api.getDmFunnel = () => new Promise((r) => { release = r; });
        const { toggle, panel } = L.mount();
        L.Inbox.toggleFunnel();
        L.Inbox.resetTenantState();
        release(FUNNEL);
        await settle();
        assert.equal(L.Inbox.funnel.open, false);
        assert.equal(L.Inbox.funnel.data, null, 'the previous tenant\'s numbers do not land on the next');
        assert.equal(toggle.attrs['aria-expanded'], 'false');
        assert.equal(panel.innerHTML, '');
    });

    it('says when it could not load, offers Retry, and asks again on it', async () => {
        const L = load();
        let fail = true;
        L.api.getDmFunnel = () => (fail ? Promise.reject(new Error('boom <img src=x onerror=alert(1)>')) : Promise.resolve(FUNNEL));
        const { panel } = L.mount();
        L.Inbox.toggleFunnel();
        await settle();
        assert.match(panel.innerHTML, /role="alert"/);
        assert.ok(text(panel.innerHTML).includes(L.t('inbox.funnel.failed')));
        assert.match(panel.innerHTML, /data-action="inbox:funnelRetry"/);
        assert.doesNotMatch(panel.innerHTML, /boom|<img/, 'the error text is not shown, so it cannot be markup');
        fail = false;
        await L.Inbox.loadFunnel(L.Inbox.funnel.days);
        assert.ok(text(panel.innerHTML).includes('67%'));
        assert.doesNotMatch(panel.innerHTML, /role="alert"/);
    });

    it('treats an answer that is not a funnel as a failure, not as an empty card', async () => {
        for (const bad of [null, 'ok', 42, {}, { steps: 'many' }]) {
            const L = load();
            L.api.getDmFunnel = () => Promise.resolve(bad);
            const { panel } = L.mount();
            L.Inbox.toggleFunnel();
            await settle();
            assert.match(panel.innerHTML, /role="alert"/, JSON.stringify(bad));
        }
    });

    it('says so when nobody wrote in the period, in the words of the period', async () => {
        const L = load();
        L.api.getDmFunnel = () => Promise.resolve({ ...FUNNEL, conversations: 0, steps: FUNNEL.steps.map((s: Json) => ({ ...s, count: 0, pct: 0 })) });
        const { panel } = L.mount();
        L.Inbox.toggleFunnel();
        await settle();
        assert.ok(text(panel.innerHTML).includes('Nobody wrote to you for the first time in the last 30 days.'));
        assert.doesNotMatch(panel.innerHTML, /<progress/);
    });

    it('shows a rate with nothing to divide by as a dash, and no reply time as such', async () => {
        const L = load();
        const none = { count: 0, of: 0, pct: null };
        L.api.getDmFunnel = () => Promise.resolve({ ...FUNNEL, rates: { link: none, click: none, handoff: { count: 0, of: 10, pct: 0 }, opt_out: none }, reply: { sample: 0, median_ms: null, p90_ms: null } });
        const { panel } = L.mount();
        L.Inbox.toggleFunnel();
        await settle();
        const shown = text(panel.innerHTML);
        assert.ok(shown.includes('— 0 of 0 recommended'), shown);
        assert.ok(shown.includes('0% 0 of 10 conversations'), shown);
        assert.ok(shown.includes(`${L.t('inbox.funnel.reply.median')} — ${L.t('inbox.funnel.reply.none')}`), shown);
        assert.equal(shown.includes('NaN'), false);
    });

    it('draws only what it knows from what the server says: an unknown step is not drawn, a number that is not one is zero, and nothing is markup', async () => {
        for (const evil of XSS) {
            const L = load();
            L.api.getDmFunnel = () => Promise.resolve({
                days: evil, since: evil, conversations: 5,
                steps: [{ id: evil, count: 5 }, { id: 'clicked', count: evil }, { id: 'link_sent', count: -9 }, { id: 'recommended', count: 9999 }, null, 'x'],
                outcomes: { follow_up: evil, handoff: { a: 1 }, closed: NaN, opted_out: -1, complaints: '3', extra: evil },
                rates: { link: { count: evil, of: evil, pct: evil }, click: 'x', handoff: null, opt_out: { count: 1, of: 2, pct: { b: 2 } } },
                clicks: { preview: evil }, reply: { sample: evil, median_ms: evil, p90_ms: evil },
            });
            const { panel } = L.mount();
            L.Inbox.toggleFunnel();
            await settle();
            const markup = panel.innerHTML;
            assert.deepEqual(tagsOf(markup).filter((tag) => !SAFE_TAGS.has(tag)), [], evil);
            assert.equal(attrNames(markup).some((a) => a.startsWith('on')), false, evil);
            assert.doesNotMatch(markup, /<img|<script|<svg/i, evil);
            assert.equal(text(markup).includes('NaN') || text(markup).includes('[object') || text(markup).includes('undefined'), false, `${evil}: ${text(markup)}`);
            // Step counts are capped at the cohort, so a bar can never overflow its track.
            for (const m of markup.matchAll(/<progress[^>]*max="(\d+)"[^>]*value="(\d+)"/g)) assert.ok(Number(m[2]) <= Number(m[1]));
        }
    });

    it('draws only its own five steps, in its own order, whatever order or extras the server sends', async () => {
        const L = load();
        L.api.getDmFunnel = () => Promise.resolve({ ...FUNNEL, steps: [...FUNNEL.steps].reverse().concat([{ id: 'surprise', count: 3, pct: 30 }]) });
        const { panel } = L.mount();
        L.Inbox.toggleFunnel();
        await settle();
        const order = [...panel.innerHTML.matchAll(/data-step="([a-z_]+)"/g)].map((m) => m[1]);
        assert.deepEqual(order, ['conversations', 'qualified', 'recommended', 'link_sent', 'clicked']);
    });

    it('is worded in Arabic in the Arabic interface, with the same Latin digits', async () => {
        const L = load('ar');
        L.api.getDmFunnel = () => Promise.resolve(FUNNEL);
        const { panel } = L.mount();
        L.Inbox.toggleFunnel();
        await settle();
        const shown = text(panel.innerHTML);
        assert.ok(shown.includes('المحادثات 10 · 100%'), shown);
        assert.ok(shown.includes('67% 4 من 6 محادثات اقتُرحت فيها دورة'), shown);
        assert.match(panel.innerHTML, /id="dm-funnel-window-7"[^>]*>7 أيام</);
        assert.match(panel.innerHTML, /id="dm-funnel-window-30"[^>]*>30 يومًا</);
        assert.doesNotMatch(shown, /[٠-٩]/);
    });

    it('is a real control: a 44px button that says whether it is open, and the periods are buttons with their own ids for focus', () => {
        const L = load();
        const shell = String(L.Inbox.layout());
        assert.match(shell, /<button type="button" class="dm-funnel-toggle"/);
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        assert.match(css, /\.dm-funnel-toggle \{[^}]*min-block-size: var\(--tap-target\)/);
        assert.match(css, /\.dm-funnel-toggle:focus-visible/);
        L.Inbox.funnel.open = true;
        assert.match(String(L.Inbox.renderFunnel()), /<button type="button" class="btn btn-sm btn-ghost" id="dm-funnel-window-7"/);
    });

    it('asks through API.getDmFunnel, which names the route the server mounts', () => {
        const source = readFileSync('dashboard/js/api.js', 'utf8');
        assert.match(source, /getDmFunnel: \(days\) => API\.request\(`\/dm\/funnel\?days=\$\{encodeURIComponent\(days\)\}`\)/);
        assert.match(readFileSync('src/routes/api.ts', 'utf8'), /router\.get\('\/dm\/funnel'/);
    });

    it('is not part of the poll: the thread list\'s tick never asks for it', () => {
        const source = readFileSync('dashboard/js/pages/inbox.js', 'utf8');
        const poll = source.slice(source.indexOf('async loadThreads('), source.indexOf('/** SH3: the count on the Inbox nav item'));
        assert.equal(poll.includes('loadFunnel'), false);
        assert.equal(poll.includes('getDmFunnel'), false);
    });
});
