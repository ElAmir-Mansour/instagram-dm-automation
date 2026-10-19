/**
 * The inbox's detail view (`dashboard/js/pages/inbox.js`): "I want to see everything in here in detail".
 *
 * Loaded like wave3.test.ts: the REAL shipped files in a `node:vm` context with a fake DOM, so these cannot drift from the page.
 * In both languages where the words are the claim.
 *
 * The first bug, and why it lived: `structuredContent` returned '' unless `raw_payload` was a STRING, and the column is JSONB, so the
 * API hands back an OBJECT. Every carousel the AI ever sent showed as the literal text "[Structured Template]". The fixtures
 * (scripts/css-fixtures.mjs, reading.test.ts) wrote `raw_payload: JSON.stringify(...)`, so nothing disagreed with the code. These tests
 * feed the shape the server actually sends, and `PAYLOAD_OBJECT` is that shape.
 *
 * Everything here is attacker-reachable (a customer's message, a payload, a username), so the XSS section is the part that must not
 * go quiet: it asserts on the markup the page writes, not on what a browser would make of it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = any;
type Translate = (key: string, params?: Record<string, unknown>) => string;

function fakeEl(id: string, props: Record<string, unknown> = {}): Json {
    const attrs = new Map<string, string>();
    const el: Json = {
        id, value: '', innerHTML: '', textContent: '', dataset: {}, children: [],
        scrollHeight: 0, scrollTop: 0, clientHeight: 0,
        classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
        setAttribute: (n: string, v: string) => { attrs.set(n, String(v)); },
        removeAttribute: (n: string) => { attrs.delete(n); },
        getAttribute: (n: string) => (attrs.has(n) ? attrs.get(n)! : null),
        insertAdjacentHTML: (_w: string, markup: string) => { el.innerHTML += markup; },
        focus: () => {}, closest: () => null, contains: () => false,
        querySelector: () => null, querySelectorAll: () => [],
    };
    return Object.assign(el, props);
}

interface Loaded {
    I: Json;
    UI: Json;
    t: Translate;
    dom: Map<string, Json>;
    selectors: Map<string, Json>;
    api: Record<string, (...args: Json[]) => unknown>;
    calls: Array<{ method: string; args: Json[] }>;
    app: { canOperate: () => boolean };
    host(id: string, props?: Record<string, unknown>): Json;
}

function load(lang: 'ar' | 'en' = 'en'): Loaded {
    const noop = (): void => {};
    const dom = new Map<string, Json>();
    const selectors = new Map<string, Json>();
    const api: Record<string, (...args: Json[]) => unknown> = {};
    const calls: Array<{ method: string; args: Json[] }> = [];
    const app = { canOperate: () => true };
    const stub = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '', textContent: '',
    };
    const ctx: Json = {
        document: {
            ...stub,
            createElement: () => ({ ...stub }),
            body: { ...stub }, head: { ...stub },
            documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => dom.get(id) ?? null,
            querySelector: (sel: string) => selectors.get(sel) ?? null,
            activeElement: null,
            visibilityState: 'visible',
        },
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
        location: { hash: '#/inbox', pathname: '/dashboard' },
        history: { replaceState: noop },
        Intl, console, clearTimeout, clearInterval, URLSearchParams,
        setTimeout: (fn: () => void, ms?: number) => { const h = setTimeout(fn, ms); (h as Json).unref?.(); return h; },
        setInterval: (fn: () => void, ms?: number) => { const h = setInterval(fn, ms); (h as Json).unref?.(); return h; },
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang },
        CSS: { escape: (v: string) => String(v) },
        API: new Proxy(api, {
            get: (target, prop: string) => (prop === 'token' ? 'tok' : prop in target
                ? (...args: Json[]) => { calls.push({ method: prop, args }); return target[prop]!(...args); }
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        Admin: { emptyState: () => '', confirm: noop },
        App: new Proxy(app, {
            get: (target, prop: string) => (prop in target
                ? (target as Json)[prop]
                : prop === 'hashParam' ? () => '' : prop === 'setInboxWaiting' ? noop : prop === 'navigate' ? noop : undefined),
        }),
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js', 'dashboard/js/attention.js', 'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js',
        'dashboard/js/motion.js', 'dashboard/js/pages/inbox.js',
    ]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const got = vm.runInContext('({ I: InboxPage, UI, t })', ctx);
    got.UI.toast = noop;
    const host = (id: string, props: Record<string, unknown> = {}) => {
        const el = fakeEl(id, props);
        dom.set(id, el);
        return el;
    };
    return { I: got.I, UI: got.UI, t: got.t, dom, selectors, api, calls, app, host };
}

const LANGS = ['en', 'ar'] as const;
const NOW = () => new Date().toISOString();
const at = (iso: string) => `2026-10-14T${iso}.000Z`;

/**
 * What `messages.raw_payload` is when the AI sent a carousel and quick replies: the JSONB value as `pg` hands it back, an OBJECT.
 * (The pipeline stores `JSON.stringify(metaMessagePayload)`; Postgres parses it into the column.)
 */
const CAROUSEL_OBJECT = {
    attachment: {
        type: 'template',
        payload: {
            template_type: 'generic',
            elements: [
                {
                    title: 'Prompt engineering',
                    subtitle: 'Write prompts that work',
                    image_url: 'https://cdn.example.test/prompt.jpg',
                    buttons: [
                        { type: 'web_url', title: 'Open the page', url: 'https://example.test/r/abc123?utm=x#top' },
                        { type: 'postback', title: 'Tell me more', payload: 'MORE_PROMPTS' },
                    ],
                },
                { title: 'Agents guide', subtitle: 'Build one', buttons: [{ type: 'postback', title: 'Price', payload: 'PRICE' }] },
            ],
        },
    },
};
const QUICK_OBJECT = {
    text: 'Pick one',
    quick_replies: [
        { content_type: 'text', title: 'Plans', payload: 'PLANS' },
        { content_type: 'text', title: 'Other plans', payload: 'OTHER_PLANS' },
    ],
};

const out = (msg: Json): Json => ({ id: 'm1', direction: 'outbound', sender: 'ai', message_type: 'carousel', text: '[Structured Template]', created_at: NOW(), ...msg });

/** An element's opening tag with its quoted values blanked, so an attribute that "appears" inside a value is not mistaken for one. */
const bareTags = (markup: string): string => (markup.match(/<[a-z][^>]*>/gi) || []).map((tag) => tag.replace(/"[^"]*"/g, '""')).join('\n');

// ─── The bug: a carousel that arrives as an object ───────────────────────────────────────────
describe('structuredContent — an object or a string, the JSONB the server really sends', () => {
    for (const lang of LANGS) {
        it(`draws the cards of a carousel whose raw_payload is an OBJECT (${lang})`, () => {
            const { I } = load(lang);
            const markup = String(I.structuredContent(out({ raw_payload: CAROUSEL_OBJECT })));
            assert.ok(markup.includes('class="msg-carousel"'));
            assert.equal((markup.match(/class="carousel-card"/g) || []).length, 2);
            for (const text of ['Prompt engineering', 'Write prompts that work', 'Open the page', 'Tell me more', 'Agents guide', 'Price']) {
                assert.ok(markup.includes(text), text);
            }
            assert.ok(markup.includes('src="https://cdn.example.test/prompt.jpg"'), 'the card image');
        });
    }

    it('draws the same thing from the same payload as a JSON string', () => {
        const { I } = load();
        const asObject = String(I.structuredContent(out({ raw_payload: CAROUSEL_OBJECT })));
        const asString = String(I.structuredContent(out({ raw_payload: JSON.stringify(CAROUSEL_OBJECT) })));
        assert.ok(asObject.length > 0);
        assert.equal(asString, asObject);
    });

    it('draws quick-reply pills from an object and from a string', () => {
        const { I } = load();
        for (const raw of [QUICK_OBJECT, JSON.stringify(QUICK_OBJECT)]) {
            const markup = String(I.structuredContent(out({ message_type: 'quick_reply', text: 'Pick one', raw_payload: raw })));
            assert.equal((markup.match(/class="qr-pill"/g) || []).length, 2);
            assert.ok(markup.includes('Plans') && markup.includes('Other plans'));
        }
    });

    it('draws nothing for a plain reply, a pruned body, an array, a number, or text that is not JSON', () => {
        const { I } = load();
        for (const raw of [{ text: 'hello' }, null, undefined, '', [], [1, 2], 42, true, 'not json {', '"just a string"', '[1]', {}]) {
            assert.equal(String(I.structuredContent(out({ raw_payload: raw }))), '', JSON.stringify(raw));
        }
        assert.equal(String(I.structuredContent(null)), '');
        assert.equal(String(I.structuredContent({})), '');
    });

    it('caps what one message can draw: Meta allows 10 cards and 3 buttons, and the page is not a place for ten thousand', () => {
        const { I } = load();
        const card = { title: 'c', buttons: Array.from({ length: 9 }, (_, i) => ({ title: `b${i}`, payload: `P${i}` })) };
        const payload = { attachment: { payload: { elements: Array.from({ length: 50 }, () => card) } } };
        const markup = String(I.structuredContent(out({ raw_payload: payload })));
        assert.equal((markup.match(/class="carousel-card"/g) || []).length, 10);
        assert.equal((markup.match(/class="carousel-btn"/g) || []).length, 30);
    });

    it('shows a button’s link as a small real link, and a postback’s payload as text', () => {
        const { I } = load();
        const markup = String(I.structuredContent(out({ raw_payload: CAROUSEL_OBJECT })));
        assert.match(markup, /<a class="carousel-btn-url" href="https:\/\/example\.test\/r\/abc123\?utm=x#top" target="_blank" rel="noopener noreferrer" dir="ltr">example\.test\/r\/abc123</);
        assert.match(markup, /class="carousel-btn-payload" dir="ltr">MORE_PROMPTS</);
        // A link's button does not also show a payload.
        assert.ok(!markup.includes('carousel-btn-payload" dir="ltr">undefined'));
    });
});

describe('messageBubble — the placeholder is never shown as words', () => {
    for (const lang of LANGS) {
        it(`hides "[Structured Template]" when the cards render, and shows them (${lang})`, () => {
            const { I } = load(lang);
            const markup = String(I.messageBubble(out({ raw_payload: CAROUSEL_OBJECT })));
            assert.ok(!markup.includes('[Structured Template]'));
            assert.ok(markup.includes('Prompt engineering'));
            assert.ok(markup.includes('class="msg-carousel"'));
        });

        it(`says what it was, in words, when the body is pruned and there are no cards to draw (${lang})`, () => {
            const { I, t } = load(lang);
            const carousel = String(I.messageBubble(out({ raw_payload: null })));
            assert.ok(!carousel.includes('[Structured Template]'));
            assert.ok(carousel.includes(t('inbox.carouselGone')));
            const other = String(I.messageBubble(out({ raw_payload: null, message_type: 'quick_reply' })));
            assert.ok(!other.includes('[Structured Template]') && other.includes(t('inbox.structuredGone')));
        });
    }

    it('still shows a quick reply’s own text above its pills', () => {
        const { I } = load();
        const markup = String(I.messageBubble(out({ message_type: 'quick_reply', text: 'Pick one', raw_payload: QUICK_OBJECT })));
        assert.ok(markup.includes('>Pick one<') && markup.includes('class="qr-pill"'));
    });

    it('labels a story mention in words and not with the stored English placeholder', () => {
        const { I, t } = load('ar');
        const markup = String(I.messageBubble({ id: 's', direction: 'inbound', message_type: 'story_mention', text: '[Story Mention]', created_at: NOW() }));
        assert.ok(!markup.includes('[Story Mention]'));
        assert.ok(markup.includes(t('inbox.storyMention')));
    });

    it('draws a bubble with the text it had before, for any message with no payload at all', () => {
        const { I } = load();
        const markup = String(I.messageBubble({ id: 'x', direction: 'inbound', text: 'hello there', created_at: NOW() }));
        assert.ok(markup.includes('<p dir="auto" >hello there</p>') || markup.includes('<p dir="auto">hello there</p>'));
        assert.ok(!markup.includes('msg-detail') && !markup.includes('message-row--stacked'));
    });
});

// ─── XSS ─────────────────────────────────────────────────────────────────────────────────────
describe('everything the detail view draws is escaped (the payloads are attacker-reachable)', () => {
    const IMG = '<img src=x onerror=alert(1)>';
    const SCRIPT = '"><script>alert(1)</script>';

    it('titles, subtitles, button titles and payloads become text, never elements', () => {
        const { I } = load();
        const payload = {
            quick_replies: [{ title: IMG }, { title: SCRIPT }],
            attachment: { payload: { elements: [{
                title: IMG, subtitle: SCRIPT, image_url: 'https://cdn.example.test/a.jpg',
                buttons: [{ type: 'postback', title: SCRIPT, payload: IMG }],
            }] } },
        };
        const markup = String(I.structuredContent(out({ raw_payload: payload })));
        assert.ok(!/<img src=x/i.test(markup), 'an <img> injected through a title');
        assert.ok(!/<script/i.test(markup), 'a <script> injected through a subtitle');
        assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(markup.includes('&quot;&gt;&lt;script&gt;'));
        // The one real <img> is the card's picture, and its alt text (the title) is escaped inside the quotes.
        assert.equal((markup.match(/<img /g) || []).length, 1);
        assert.ok(!bareTags(markup).includes('onerror'));
    });

    it('a URL that is not http(s) never becomes a link, and one that tries to leave its attribute cannot', () => {
        const { I } = load();
        const make = (url: string, image = 'https://cdn.example.test/a.jpg') => String(I.structuredContent(out({ raw_payload: {
            attachment: { payload: { elements: [{ title: 't', image_url: image, buttons: [{ type: 'web_url', title: 'go', url }] }] } },
        } })));
        for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:x', '//evil.test/x', '/relative/path', 'ftp://x.test/a', '']) {
            assert.ok(!make(bad).includes('carousel-btn-url'), `link for ${JSON.stringify(bad)}`);
        }
        assert.ok(!make('x', 'javascript:alert(1)').includes('<img'), 'a card image that is not a safe URL is not drawn');
        const tricky = make('https://x.test/" onmouseover="alert(1)');
        assert.ok(tricky.includes('carousel-btn-url'), 'it is a URL, so it is a link');
        assert.ok(tricky.includes('&quot; onmouseover=&quot;alert(1)'), 'the quote is escaped inside the value');
        assert.ok(!bareTags(tricky).includes('onmouseover'), 'and no attribute was created');
        assert.ok(!/href="https:\/\/x\.test\/"/.test(tricky), 'the href did not end early');
    });

    it('a link’s visible label is escaped text of the URL', () => {
        const { I } = load();
        const markup = String(I.structuredContent(out({ raw_payload: { attachment: { payload: { elements: [{ title: 't', buttons: [
            { type: 'web_url', title: 'go', url: 'https://x.test/<b>bold</b>' },
        ] }] } } } })));
        assert.ok(!markup.includes('<b>bold</b>'));
        assert.ok(markup.includes('x.test/&lt;b&gt;bold&lt;/b&gt;'));
    });

    it('a tapped payload, an attachment URL and a delivery code are escaped or refused', () => {
        const { I } = load();
        const tapped = String(I.messageBubble({
            id: 'i', direction: 'inbound', text: 'x', payload: IMG, created_at: NOW(),
            raw_payload: { message: { attachments: [
                { type: 'image', payload: { url: 'https://cdn.example.test/p.jpg" onerror="alert(1)' } },
                { type: 'video', payload: { url: 'javascript:alert(1)' } },
                { type: IMG, payload: { url: 'https://cdn.example.test/z' } },
            ] } },
        }));
        assert.ok(!/<img src=x/i.test(tapped));
        assert.ok(tapped.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(!bareTags(tapped).includes('onerror'), 'no attribute named onerror was created');
        assert.ok(!tapped.includes('href="javascript'), 'a javascript: attachment URL is not linked');
        assert.equal((tapped.match(/class="msg-attachment"/g) || []).length, 3, 'each is still drawn: as a chip');
        assert.ok(tapped.includes('Attachment'), 'an unknown type is a plain attachment, with no markup from its name');
    });

    it('a sender’s name, handle, picture link and the AI’s model name are escaped in the header, the row and the detail line', () => {
        const { I } = load();
        const thread = {
            id: 'c1', platform: 'instagram', instagram_user_id: '99', is_bot_active: true,
            profile_name: IMG, username: SCRIPT, profile_pic_url: 'https://cdn.example.test/p.jpg" onerror="alert(1)',
            last_message_text: IMG, last_message_card_title: IMG, last_message_cards: 1,
        };
        const row = String(I.threadRow(thread));
        assert.ok(!/<img src=x/i.test(row) && !/<script/i.test(row));
        const avatar = String(I.avatarMarkup(thread));
        assert.ok(!bareTags(avatar).includes('onerror'));
        assert.ok(avatar.includes('src="https://cdn.example.test/p.jpg&quot; onerror=&quot;alert(1)"'));
        const detail = String(I.outboundDetail({ direction: 'outbound', sender: 'ai', ai: { model: IMG, source: 'usage' } }, { ms: 1000, attempts: 1 }));
        assert.ok(!/<img src=x/i.test(detail) && detail.includes('&lt;img src=x'));
        const meta = String(I.metaMarkup({ ...thread, created_at: 'not a date <b>' }));
        assert.ok(!meta.includes('<b>'));
    });

    it('a picture link that is not http(s) is not drawn at all, and the initials stay', () => {
        const { I } = load();
        for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.test/a.png', '']) {
            const avatar = String(I.avatarMarkup({ profile_name: 'Sam Dev', profile_pic_url: bad }));
            assert.ok(!avatar.includes('<img'), JSON.stringify(bad));
            assert.ok(avatar.includes('SD'));
        }
    });
});

// ─── The list ────────────────────────────────────────────────────────────────────────────────
describe('the thread list — the right preview and the sender’s real name', () => {
    for (const lang of LANGS) {
        it(`a carousel reads as its cards, never as the placeholder (${lang})`, () => {
            const { I, t } = load(lang);
            const base = { id: 'c', last_message_direction: 'outbound', last_message_text: '[Structured Template]', last_message_type: 'carousel' };
            assert.equal(I.threadPreview({ ...base, last_message_cards: 2, last_message_card_title: 'Prompt engineering' }),
                t('inbox.preview.withTitle', { label: t('inbox.preview.cards', { count: 2 }), title: 'Prompt engineering' }));
            assert.equal(I.threadPreview({ ...base, last_message_cards: 1, last_message_card_title: 'Only one' }),
                t('inbox.preview.withTitle', { label: t('inbox.preview.cards', { count: 1 }), title: 'Only one' }));
            assert.equal(I.threadPreview({ ...base, last_message_cards: 3 }), t('inbox.preview.cards', { count: 3 }), 'no title: just the count');
            const row = String(I.threadRow({ ...base, last_message_cards: 2, last_message_card_title: 'Prompt engineering', platform: 'instagram' }));
            assert.ok(!row.includes('[Structured Template]'));
            assert.ok(row.includes('Prompt engineering'));
        });
    }

    it('says "2 cards: …" in English and the dual in Arabic', () => {
        const en = load('en');
        assert.equal(en.I.threadPreview({ last_message_cards: 2, last_message_card_title: 'Pricing' }), '2 cards: Pricing');
        assert.equal(en.I.threadPreview({ last_message_cards: 1, last_message_card_title: 'Pricing' }), '1 card: Pricing');
        const ar = load('ar');
        assert.equal(ar.I.threadPreview({ last_message_cards: 2, last_message_card_title: 'الأسعار' }), 'بطاقتان: الأسعار');
        assert.equal(ar.I.threadPreview({ last_message_cards: 4 }), '4 بطاقات');
    });

    it('a placeholder with no cards behind it says what kind of message it was', () => {
        const { I, t } = load();
        assert.equal(I.threadPreview({ last_message_text: '[Structured Template]', last_message_type: 'carousel' }), t('inbox.preview.carousel'));
        assert.equal(I.threadPreview({ last_message_text: '[Structured Template]', last_message_type: 'quick_reply' }), t('inbox.preview.structured'));
        assert.equal(I.threadPreview({ last_message_text: '[Structured Template]' }), t('inbox.preview.structured'));
    });

    it('a story mention reads as one, but words the customer typed are kept', () => {
        const { I, t } = load();
        assert.equal(I.threadPreview({ last_message_text: '[Story Mention]', last_message_type: 'story_mention' }), t('inbox.storyMention'));
        assert.equal(I.threadPreview({ last_message_text: '', last_message_type: 'story_mention' }), t('inbox.storyMention'));
        assert.equal(I.threadPreview({ last_message_text: 'love this', last_message_type: 'story_mention' }), 'love this');
    });

    it('plain text is untouched, and an empty thread says so', () => {
        const { I, t } = load();
        assert.equal(I.threadPreview({ last_message_text: 'كم السعر؟' }), 'كم السعر؟');
        assert.equal(I.threadPreview({}), t('inbox.noMessages'));
        assert.equal(I.threadPreview(null), t('inbox.noMessages'));
        assert.equal(I.threadPreview({ last_message_cards: 0, last_message_text: 'hi' }), 'hi', 'zero cards is not a carousel');
    });

    it('names a sender by their profile name, then their @handle, then "User 3051" — the "@" only on a handle', () => {
        const { I, t } = load();
        assert.equal(I.threadTitle({ profile_name: 'Sam Dev', username: 'sam_dev', instagram_user_id: '17841400003051' }), 'Sam Dev');
        assert.equal(I.threadTitle({ profile_name: '  ', username: 'sam_dev', instagram_user_id: '1' }), '@sam_dev');
        const anon = I.threadTitle({ username: null, instagram_user_id: '17841400003051' });
        assert.equal(anon, t('inbox.anonUser', { id: '3051' }));
        assert.ok(!anon.startsWith('@'), 'the "@User 3051" of the screenshot');
        const row = String(I.threadRow({ id: 'a', username: null, instagram_user_id: '17841400003051', platform: 'instagram', is_bot_active: true }));
        assert.ok(row.includes('User 3051') && !row.includes('@User'));
        const named = String(I.threadRow({ id: 'b', profile_name: 'Sam Dev', username: 'sam_dev', platform: 'instagram', is_bot_active: true }));
        assert.ok(named.includes('<bdi dir="auto">Sam Dev</bdi>'));
    });

    it('finds a thread by the name on its profile, as well as its handle and its words', () => {
        const { I } = load();
        I.threads = [
            { id: '1', profile_name: 'Sam Dev', username: 'sd_1', last_message_text: 'hello' },
            { id: '2', username: 'omar', last_message_text: 'price' },
        ];
        I.searchTerm = 'sam dev';
        assert.deepEqual(I.visibleThreads().map((x: Json) => x.id), ['1']);
        I.searchTerm = 'omar';
        assert.deepEqual(I.visibleThreads().map((x: Json) => x.id), ['2']);
    });

    it('the filters are what they were: "Needs reply" is a paused AI and the customer last', () => {
        const { I } = load();
        const waiting = { id: 'w', is_bot_active: false, last_message_direction: 'inbound' };
        const answered = { id: 'a', is_bot_active: false, last_message_direction: 'outbound' };
        const live = { id: 'l', is_bot_active: true, last_message_direction: 'inbound' };
        I.threads = [waiting, answered, live];
        I.filter = 'waiting';
        assert.deepEqual(I.visibleThreads().map((x: Json) => x.id), ['w']);
        I.filter = 'paused';
        assert.deepEqual(I.visibleThreads().map((x: Json) => x.id), ['w', 'a']);
    });

    it('a row’s signature moves when the preview or the name does, so the list repaints exactly then', () => {
        const { I } = load();
        const calls: string[] = [];
        I.threads = [{ id: 'a', username: 'u', platform: 'instagram', last_message_text: '[Structured Template]', last_message_type: 'carousel', last_message_cards: 2, last_message_card_title: 'One', is_bot_active: true, last_message_direction: 'outbound' }];
        // The signature is built inside renderThreads; read it through the same helpers it uses.
        const sig = (x: Json) => [I.threadTitle(x), I.threadPreview(x)].join('|');
        calls.push(sig(I.threads[0]));
        calls.push(sig({ ...I.threads[0], last_message_card_title: 'Two' }));
        calls.push(sig({ ...I.threads[0], profile_name: 'Sam' }));
        assert.equal(new Set(calls).size, 3);
    });
});

// ─── The detail line's arithmetic ────────────────────────────────────────────────────────────
describe('pairReplies — how long the AI took, and whether the message needed more than one attempt', () => {
    const inbound = (id: string, created: string, extra: Json = {}) => ({ id, direction: 'inbound', sender: 'customer', text: id, created_at: at(created), ...extra });
    const reply = (id: string, created: string, extra: Json = {}) => ({ id, direction: 'outbound', sender: 'ai', text: id, created_at: at(created), ...extra });

    it('is the reply’s row minus the inbound’s', () => {
        const { I } = load();
        const got = I.pairReplies([inbound('q', '10:00:00'), reply('a', '10:00:04')]);
        assert.deepEqual({ ...got.get('a') }, { ms: 4000, attempts: 0 });
    });

    it('carries the inbound’s attempt count, so a retried reply says so', () => {
        const { I } = load();
        const got = I.pairReplies([inbound('q', '10:00:00', { reply_attempts: 3 }), reply('a', '10:02:10')]);
        assert.deepEqual({ ...got.get('a') }, { ms: 130000, attempts: 3 });
    });

    it('pairs by handled_at when two messages came together, so each reply gets its own wait', () => {
        const { I } = load();
        // A at :00, B at :01; A is answered at :04 and B at :08. The newest inbound before A's reply is B, which would make A's wait 3 s.
        const got = I.pairReplies([
            inbound('A', '10:00:00', { handled_at: at('10:00:04') }),
            inbound('B', '10:00:01', { handled_at: at('10:00:08') }),
            reply('ra', '10:00:04'),
            reply('rb', '10:00:08'),
        ]);
        assert.equal(got.get('ra').ms, 4000);
        assert.equal(got.get('rb').ms, 7000);
    });

    it('falls back to the newest inbound before the reply that no earlier reply took, when handled_at is absent', () => {
        const { I } = load();
        const got = I.pairReplies([
            inbound('A', '10:00:00'),
            reply('ra', '10:00:05'),
            inbound('B', '10:01:00'),
            reply('rb', '10:01:02'),
        ]);
        assert.equal(got.get('ra').ms, 5000);
        assert.equal(got.get('rb').ms, 2000);
    });

    it('takes each inbound once: a second reply to the same message has no wait of its own', () => {
        const { I } = load();
        const got = I.pairReplies([inbound('A', '10:00:00'), reply('r1', '10:00:03'), reply('r2', '10:00:09')]);
        assert.equal(got.get('r1').ms, 3000);
        assert.equal(got.has('r2'), false);
    });

    it('says nothing for a reply whose inbound is not in the batch, for the operator’s replies, and for a time it cannot read', () => {
        const { I } = load();
        const got = I.pairReplies([
            reply('orphan', '10:00:04'),
            inbound('q', '10:01:00'),
            { id: 'op', direction: 'outbound', sender: 'operator', created_at: at('10:01:05') },
            { id: 'bad', direction: 'outbound', sender: 'ai', created_at: 'not a date' },
        ]);
        assert.equal(got.size, 0);
        assert.equal(I.pairReplies(null).size, 0);
    });

    it('is never negative, whatever the clocks say', () => {
        const { I } = load();
        const got = I.pairReplies([inbound('q', '10:00:10'), reply('a', '10:00:08')]);
        assert.equal(got.get('a').ms, 0);
    });
});

describe('durationText', () => {
    for (const lang of LANGS) {
        it(`speaks in the unit a person would (${lang})`, () => {
            const { I, t } = load(lang);
            assert.equal(I.durationText(400), t('inbox.detail.underSecond'));
            assert.equal(I.durationText(4000), t('inbox.detail.seconds', { n: '4' }));
            assert.equal(I.durationText(4400), t('inbox.detail.seconds', { n: '4' }));
            assert.equal(I.durationText(119000), t('inbox.detail.seconds', { n: '119' }));
            assert.equal(I.durationText(125000), t('inbox.detail.minutes', { n: '2' }));
            assert.equal(I.durationText(90 * 60000), t('inbox.detail.minutes', { n: '90' }));
            assert.equal(I.durationText(3.5 * 3600000), t('inbox.detail.hours', { n: '3.5' }));
            assert.equal(I.durationText(NaN), '');
            assert.equal(I.durationText(-5), '');
        });
    }
});

describe('the line under an AI reply', () => {
    for (const lang of LANGS) {
        it(`shows the wait, the model and "retried" when it took more than one attempt (${lang})`, () => {
            const { I, t } = load(lang);
            const msg = { direction: 'outbound', sender: 'ai', ai: { model: 'gemini-2.5-flash', provider: null, source: 'agent' } };
            const line = String(I.outboundDetail(msg, { ms: 4000, attempts: 2 }));
            assert.ok(line.includes(t('inbox.detail.repliedIn', { time: t('inbox.detail.seconds', { n: '4' }) })));
            assert.ok(line.includes('gemini-2.5-flash'));
            assert.ok(line.includes(t('inbox.detail.retried', { count: 2, n: '2' })));
            assert.ok(line.includes('badge-warning'));
        });
    }

    it('says "retried" only past one attempt', () => {
        const { I, t } = load();
        const msg = { direction: 'outbound', sender: 'ai' };
        for (const attempts of [0, 1]) {
            assert.ok(!String(I.outboundDetail(msg, { ms: 1000, attempts })).includes('badge-warning'), String(attempts));
        }
        assert.ok(String(I.outboundDetail(msg, { ms: 1000, attempts: 2 })).includes(t('inbox.detail.retried', { count: 2, n: '2' })));
    });

    it('is only on the AI’s replies, and only with something to say', () => {
        const { I } = load();
        assert.equal(String(I.outboundDetail({ direction: 'outbound', sender: 'operator', ai: { model: 'x' } }, { ms: 1, attempts: 1 })), '');
        assert.equal(String(I.outboundDetail({ direction: 'outbound', sender: null }, { ms: 1, attempts: 1 })), '');
        assert.equal(String(I.outboundDetail({ direction: 'inbound', sender: 'ai' }, { ms: 1, attempts: 1 })), '');
        assert.equal(String(I.outboundDetail({ direction: 'outbound', sender: 'ai' }, undefined)), '');
    });

    it('lands in the bubble: the reply row is stacked under its detail, the operator’s is not', () => {
        const { I } = load();
        const ai = String(I.messageBubble({ id: 'a', direction: 'outbound', sender: 'ai', text: 'hi', created_at: NOW(), ai: { model: 'm1' } }, { ms: 2000, attempts: 1 }));
        assert.ok(ai.includes('class="msg-detail"') && ai.includes('message-row--tagged'));
        const operator = String(I.messageBubble({ id: 'o', direction: 'outbound', sender: 'operator', text: 'hi', created_at: NOW() }));
        assert.ok(!operator.includes('msg-detail'));
    });

    it('pairs through renderMessages, so the live paint carries the numbers', () => {
        const { I, host } = load();
        const list = host('chat-messages-container');
        host('chat-messages-loading');
        I.renderMessages([
            { id: 'q', direction: 'inbound', sender: 'customer', text: 'price?', created_at: at('10:00:00'), handled_at: at('10:00:06'), reply_attempts: 2 },
            { id: 'a', direction: 'outbound', sender: 'ai', text: 'ten', created_at: at('10:00:06'), ai: { model: 'gemini-2.5-flash', source: 'agent' } },
        ], true);
        assert.ok(list.innerHTML.includes('6 s'), 'the wait');
        assert.ok(list.innerHTML.includes('gemini-2.5-flash'));
        assert.ok(list.innerHTML.includes('Retried'));
    });
});

describe('what the customer did: a tap, an attachment, a failing reply', () => {
    for (const lang of LANGS) {
        it(`marks a quick-reply tap and a button tap, with what was tapped (${lang})`, () => {
            const { I, t } = load(lang);
            const quick = String(I.inboundDetail({ direction: 'inbound', payload: 'OTHER_PLANS', raw_payload: { message: { text: 'Other plans', quick_reply: { payload: 'OTHER_PLANS' } } } }));
            assert.ok(quick.includes(t('inbox.detail.tappedQuickReply')) && quick.includes('OTHER_PLANS'));
            const button = String(I.inboundDetail({ direction: 'inbound', payload: 'PRICE', raw_payload: { postback: { title: 'Price', payload: 'PRICE' } } }));
            assert.ok(button.includes(t('inbox.detail.tappedButton')) && button.includes('PRICE'));
            const pruned = String(I.inboundDetail({ direction: 'inbound', payload: 'PRICE', raw_payload: null }));
            assert.ok(pruned.includes(t('inbox.detail.tapped')) && !pruned.includes(t('inbox.detail.tappedButton')));
            assert.ok(pruned.includes('PRICE'));
        });
    }

    it('shows nothing for a message that was typed', () => {
        const { I } = load();
        assert.equal(String(I.inboundDetail({ direction: 'inbound', payload: null, text: 'hi' })), '');
        assert.equal(String(I.inboundDetail({ direction: 'inbound', payload: '   ', text: 'hi' })), '');
    });

    it('draws an image as a picture AND a chip, and every other kind as a chip, with an Open link when there is a URL', () => {
        const { I, t } = load();
        const markup = String(I.attachmentsMarkup({ direction: 'inbound', raw_payload: { message: { attachments: [
            { type: 'image', payload: { url: 'https://cdn.example.test/i.jpg' } },
            { type: 'video', payload: { url: 'https://cdn.example.test/v.mp4' } },
            { type: 'audio', payload: { url: 'https://cdn.example.test/a.m4a' } },
            { type: 'share', payload: { url: 'https://www.instagram.com/p/x/' } },
            { type: 'ig_reel', payload: { url: 'https://www.instagram.com/reel/x/' } },
            { type: 'something_new' },
        ] } } }));
        assert.equal((markup.match(/<img class="msg-attachment-img"/g) || []).length, 1, 'only an image is previewed');
        for (const key of ['image', 'video', 'audio', 'share', 'reel', 'other']) assert.ok(markup.includes(t(`inbox.attach.${key}`)), key);
        assert.equal((markup.match(/class="msg-attachment-link"/g) || []).length, 5, 'an Open link for each URL, none for the one without');
        assert.ok(markup.includes('rel="noopener noreferrer"'));
    });

    it('draws a story reply and a story mention, also when the stored body is gone', () => {
        const { I, t } = load();
        const reply = String(I.attachmentsMarkup({ direction: 'inbound', raw_payload: { message: { text: 'nice', reply_to: { story: { url: 'https://cdn.example.test/s', id: '1' } } } } }));
        assert.ok(reply.includes(t('inbox.attach.storyReply')) && reply.includes('https://cdn.example.test/s'));
        const mention = String(I.attachmentsMarkup({ direction: 'inbound', message_type: 'story_mention', raw_payload: null }));
        assert.ok(mention.includes(t('inbox.attach.storyMention')));
        const both = String(I.attachmentsMarkup({ direction: 'inbound', message_type: 'story_mention', raw_payload: { message: { attachments: [{ type: 'story_mention', payload: { url: 'https://cdn.example.test/m' } }] } } }));
        assert.equal((both.match(/class="msg-attachment"/g) || []).length, 1, 'a mention is not listed twice');
    });

    it('is nothing for a message with nothing attached, and capped for one with a flood', () => {
        const { I } = load();
        assert.equal(String(I.attachmentsMarkup({ direction: 'inbound', raw_payload: { message: { text: 'x' } } })), '');
        assert.equal(String(I.attachmentsMarkup({ direction: 'inbound', raw_payload: null })), '');
        const flood = { message: { attachments: Array.from({ length: 40 }, () => ({ type: 'file', payload: { url: 'https://cdn.example.test/f' } })) } };
        assert.equal((String(I.attachmentsMarkup({ direction: 'inbound', raw_payload: flood })).match(/class="msg-attachment"/g) || []).length, 6);
    });

    it('a customer’s bubble carries its attachments and no placeholder text', () => {
        const { I } = load();
        const markup = String(I.messageBubble({
            id: 'i', direction: 'inbound', text: 'look', created_at: NOW(),
            raw_payload: { message: { attachments: [{ type: 'image', payload: { url: 'https://cdn.example.test/i.jpg' } }] } },
        }));
        assert.ok(markup.includes('msg-attachment-img') && markup.includes('>look<'));
    });

    for (const lang of LANGS) {
        it(`a failed reply is a red chip with Meta’s code; a retrying one is amber (${lang})`, () => {
            const { I, t } = load(lang);
            const failed = String(I.inboundDetail({ direction: 'inbound', delivery: { state: 'failed', code: 10903, attempts: 3, max_attempts: 3 } }));
            assert.ok(failed.includes('badge-danger') && failed.includes(t('inbox.detail.failed')) && failed.includes(t('inbox.detail.code', { code: 10903 })));
            const noCode = String(I.inboundDetail({ direction: 'inbound', delivery: { state: 'failed', code: null } }));
            assert.ok(noCode.includes('badge-danger') && !noCode.includes(t('inbox.detail.code', { code: 'null' })));
            const retrying = String(I.inboundDetail({ direction: 'inbound', delivery: { state: 'retrying', code: 1, attempts: 2, max_attempts: 3 } }));
            assert.ok(retrying.includes('badge-warning') && retrying.includes(t('inbox.detail.retryingAttempt', { n: 2, max: 3 })));
            assert.ok(String(I.inboundDetail({ direction: 'inbound', delivery: { state: 'retrying', code: null } })).includes(t('inbox.detail.retrying')));
        });
    }

    it('shows no chip for a delivery that is fine, or one the server never described', () => {
        const { I } = load();
        for (const delivery of [null, undefined, {}, { state: 'done' }, { state: 'failed-ish' }]) {
            assert.equal(String(I.inboundDetail({ direction: 'inbound', delivery })), '', JSON.stringify(delivery));
        }
    });
});

// ─── The header ──────────────────────────────────────────────────────────────────────────────
// ─── A message with no words: the chip is the message ────────────────────────────────────────
/**
 * The pipeline stores a message with no words (a photo, a voice note, a shared reel, a sticker) as its kind in `message_type` and a
 * placeholder (`[photo]`) in `text` (src/webhook/attachments.ts). The placeholder is never what the customer said: the inbox draws the
 * chip that names the kind and prints no text. Fixtures are Meta's shapes, as `raw_payload` holds them (the whole event).
 */
describe('a message with no words — the chip is the message, and the placeholder is never printed', () => {
    const URL_ = 'https://cdn.example.test/x';
    const raw = (message: Json): Json => ({ sender: { id: 'u' }, recipient: { id: 'p' }, message: { mid: 'm', ...message } });
    const inbound = (message_type: string, text: string, rawPayload: Json): Json => ({ id: 'i', direction: 'inbound', message_type, text, created_at: NOW(), raw_payload: rawPayload });

    /** type, placeholder, the attachment as Meta lists it, and the label key of the chip. */
    const CASES: Array<[string, string, Json, string]> = [
        ['image', '[photo]', { attachments: [{ type: 'image', payload: { url: URL_ } }] }, 'inbox.attach.image'],
        ['video', '[video]', { attachments: [{ type: 'video', payload: { url: URL_ } }] }, 'inbox.attach.video'],
        ['audio', '[voice note]', { attachments: [{ type: 'audio', payload: { url: URL_ } }] }, 'inbox.attach.audio'],
        ['file', '[file]', { attachments: [{ type: 'file', payload: { url: URL_ } }] }, 'inbox.attach.file'],
        ['sticker', '[sticker]', { attachments: [{ type: 'sticker', payload: { url: URL_, sticker_id: 369239263222822 } }] }, 'inbox.attach.sticker'],
        ['share', '[shared post]', { attachments: [{ type: 'ig_post', payload: { url: URL_, title: 'A post', id: '1' } }] }, 'inbox.attach.share'],
        ['reel', '[shared reel]', { attachments: [{ type: 'ig_reel', payload: { url: URL_, title: 'A reel', reel_video_id: '1' } }] }, 'inbox.attach.reel'],
        ['story_share', '[shared story]', { attachments: [{ type: 'ig_story', payload: { url: URL_ } }] }, 'inbox.attach.storyShare'],
        ['story_reply', '[story reply]', { reply_to: { story: { url: URL_, id: '1' } } }, 'inbox.attach.storyReply'],
        ['attachment', '[attachment]', { attachments: [{ type: 'ephemeral' }] }, 'inbox.attach.other'],
    ];

    for (const lang of LANGS) {
        it(`draws each kind as its chip, from the stored event, and prints no text (${lang})`, () => {
            const { I, t } = load(lang);
            for (const [type, placeholder, message, label] of CASES) {
                const markup = String(I.messageBubble(inbound(type, placeholder, raw(message))));
                assert.ok(markup.includes(t(label)), `${type}: the chip`);
                assert.ok(!markup.includes(placeholder), `${type}: the placeholder is never printed`);
                assert.ok(!markup.includes('<p dir="auto"'), `${type}: no text line at all`);
                assert.equal((markup.match(/class="msg-attachment"/g) || []).length, 1, `${type}: one chip`);
            }
        });

        it(`draws the chip from the row's type alone when the stored event is pruned (${lang})`, () => {
            const { I, t } = load(lang);
            for (const [type, placeholder, , label] of CASES) {
                const markup = String(I.messageBubble(inbound(type, placeholder, null)));
                assert.ok(markup.includes(t(label)), `${type}: the chip`);
                assert.ok(!markup.includes(placeholder), `${type}: no placeholder`);
                assert.equal((markup.match(/class="msg-attachment"/g) || []).length, 1, `${type}: one chip`);
                assert.ok(!markup.includes('msg-attachment-link'), `${type}: nothing to open`);
            }
        });

        it(`names the kind in the thread list instead of printing its placeholder (${lang})`, () => {
            const { I, t } = load(lang);
            for (const [type, placeholder, , label] of CASES) {
                assert.equal(I.threadPreview({ last_message_text: placeholder, last_message_type: type }), t(label), type);
            }
            // A story mention keeps its own words, and the bot's own line (an outbound `attachment_ack`) previews as what it said.
            assert.equal(I.threadPreview({ last_message_text: '[Story Mention]', last_message_type: 'story_mention' }), t('inbox.storyMention'));
            assert.equal(I.threadPreview({ last_message_text: 'Got your attachment', last_message_type: 'attachment_ack' }), 'Got your attachment');
        });
    }

    it('a view-once message and a message Instagram could not show have no attachment in the event, and are still a chip', () => {
        const { I, t } = load();
        const unsupported = String(I.messageBubble(inbound('attachment', '[attachment]', raw({ is_unsupported: true }))));
        assert.ok(unsupported.includes(t('inbox.attach.other')) && !unsupported.includes('[attachment]'));
        assert.equal((unsupported.match(/class="msg-attachment"/g) || []).length, 1);
        const ephemeral = String(I.messageBubble(inbound('attachment', '[attachment]', raw({ attachments: [{ type: 'ephemeral' }] }))));
        assert.equal((ephemeral.match(/class="msg-attachment"/g) || []).length, 1, 'one chip from the event, and none added for the type');
    });

    it('Messenger\'s sticker, an image that carries a sticker_id, is ONE sticker chip, not a sticker and an image', () => {
        const { I, t } = load();
        const message = { attachments: [{ type: 'image', payload: { url: URL_, sticker_id: 369239263222822 } }] };
        const markup = String(I.messageBubble(inbound('sticker', '[sticker]', raw(message))));
        assert.equal((markup.match(/class="msg-attachment"/g) || []).length, 1);
        assert.ok(markup.includes(t('inbox.attach.sticker')) && !markup.includes(`>${t('inbox.attach.image')}<`) && !markup.includes('msg-attachment-img'));
        // The same event read without the row's type: still a sticker, still one.
        const list = I.attachmentsOf({ direction: 'inbound', raw_payload: raw(message) });
        assert.deepEqual([...list].map((a: Json) => a.kind), ['sticker'], 'a list from the page\'s own realm, copied before it is compared');
        // And an image with no sticker_id is a photo, previewed.
        const photo = String(I.messageBubble(inbound('image', '[photo]', raw({ attachments: [{ type: 'image', payload: { url: URL_ } }] }))));
        assert.ok(photo.includes('msg-attachment-img'));
    });

    it('two attachments are two chips, and the row\'s own type adds none that is already there', () => {
        const { I } = load();
        const message = { attachments: [{ type: 'image', payload: { url: URL_ } }, { type: 'video', payload: { url: URL_ } }] };
        const markup = String(I.messageBubble(inbound('image', '[photo] [video]', raw(message))));
        assert.equal((markup.match(/class="msg-attachment"/g) || []).length, 2);
        assert.ok(!markup.includes('[photo]'));
    });

    it('maps every attachment type Meta documents to a kind this screen words, and the new kinds to icons the subset has', () => {
        const { I } = load();
        const kinds: Record<string, string> = {
            image: 'image', video: 'video', audio: 'audio', file: 'file', sticker: 'sticker',
            share: 'share', ig_post: 'share', post: 'share', fallback: 'share', template: 'share',
            reel: 'reel', ig_reel: 'reel', story: 'storyShare', ig_story: 'storyShare', story_mention: 'storyMention',
            media: 'other', ephemeral: 'other', appointment_booking: 'other', brand_new: 'other',
        };
        for (const [type, kind] of Object.entries(kinds)) assert.equal(I.attachmentKind(type), kind, type);
        assert.deepEqual({ ...I.attachmentStyle('sticker') }, { icon: 'heart', label: 'inbox.attach.sticker' });
        assert.deepEqual({ ...I.attachmentStyle('storyShare') }, { icon: 'history', label: 'inbox.attach.storyShare' });
    });

    it('a story mention is drawn exactly as before: its own words in the bubble, and its chip', () => {
        const { I, t } = load();
        const markup = String(I.messageBubble(inbound('story_mention', '[Story Mention]', raw({ attachments: [{ type: 'story_mention', payload: { url: URL_ } }] }))));
        assert.ok(markup.includes(`<p dir="auto" >${t('inbox.storyMention')}</p>`) || markup.includes(`<p dir="auto">${t('inbox.storyMention')}</p>`));
        assert.ok(!markup.includes('[Story Mention]'));
        assert.ok(markup.includes(t('inbox.attach.storyMention')));
        assert.equal((markup.match(/class="msg-attachment"/g) || []).length, 1);
    });

    it('the bot\'s own line for such a message is an ordinary outbound bubble, with its words', () => {
        const { I } = load();
        const markup = String(I.messageBubble({ id: 'o', direction: 'outbound', sender: 'ai', message_type: 'attachment_ack', text: 'Got your attachment', created_at: NOW() }));
        assert.ok(markup.includes('>Got your attachment<'));
        assert.ok(!markup.includes('msg-attachment'));
    });

    it('a row\'s type is a lookup, not a property: a type named like one of the language\'s own (constructor, __proto__) is just text', () => {
        const { I } = load();
        for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', null, undefined, 7]) {
            assert.equal(I.wordlessKind(type), '', String(type));
        }
        const markup = String(I.messageBubble({ id: 'x', direction: 'inbound', message_type: 'constructor', text: 'hello', created_at: NOW() }));
        assert.ok(markup.includes('>hello<') && !markup.includes('msg-attachment'));
        // A customer's typed message that happens to be stored as a text row keeps its words whatever it says.
        const typed = String(I.messageBubble(inbound('text', '[photo]', null)));
        assert.ok(typed.includes('>[photo]<'), 'typing "[photo]" is words');
    });
});

describe('the conversation header', () => {
    const SAM = {
        id: 'c1', platform: 'instagram', instagram_user_id: '17841400003051', is_bot_active: true,
        profile_name: 'Sam Dev', username: 'sam_dev', profile_pic_url: 'https://cdn.example.test/sam.jpg',
        follower_count: 12345, is_user_follow_business: true, is_business_follow_user: false, is_verified_user: true,
        created_at: '2026-03-04T09:30:00.000Z', message_count: 27,
    };

    for (const lang of LANGS) {
        it(`shows the picture over the initials, the name, the platform and the handle, and the AI switch (${lang})`, () => {
            const { I, t, host } = load(lang);
            const pane = host('chat-pane-container');
            I.renderChatShell(SAM);
            const markup = pane.innerHTML;
            assert.ok(markup.includes('class="avatar-img" src="https://cdn.example.test/sam.jpg"'));
            assert.ok(markup.includes('>SD<'), 'the initials sit under the picture');
            assert.ok(markup.includes('<bdi dir="auto">Sam Dev</bdi>'));
            assert.ok(markup.includes('<span class="platform-tag ig">IG</span>'));
            assert.ok(markup.includes('data-chat-handle>@sam_dev<'));
            assert.ok(markup.includes(t('inbox.userId', { id: '' }).trim()));
            assert.ok(markup.includes('id="bot-toggle-input"') && markup.includes('checked'));
        });

        it(`lists what is known about them as chips: follows you, you follow, verified, followers, first message, count (${lang})`, () => {
            const { I, t, UI } = load(lang);
            const chips = String(I.metaMarkup(SAM));
            // A whole chip, between its tags: in Arabic «لا تتابعه» contains «تتابعه», and a substring test cannot tell them apart.
            const chip = (text: string) => chips.includes(`</i>${text}</span>`) || chips.includes(`">${text}</span>`);
            assert.ok(chip(t('inbox.meta.followsYou')));
            assert.ok(chip(t('inbox.meta.youDontFollow')), 'false is said, not skipped');
            assert.ok(!chip(t('inbox.meta.youFollow')));
            assert.ok(!chip(t('inbox.meta.notFollowsYou')));
            assert.ok(chip(t('inbox.meta.verified')));
            assert.ok(chips.includes(t('inbox.meta.followers', { count: 12345, n: UI.formatNumber(12345) })));
            assert.ok(chips.includes(t('inbox.meta.since', { date: UI.formatDay(SAM.created_at) })), 'first message');
            assert.ok(chips.includes(t('inbox.meta.messages', { count: 27, n: '27' })));
        });
    }

    it('shows only what is known: a Messenger thread has a date and a count and nothing it was never told', () => {
        const { I, t } = load();
        const chips = String(I.metaMarkup({ id: 'm', platform: 'facebook', created_at: '2026-03-04T09:30:00.000Z', message_count: 1 }));
        assert.ok(chips.includes(t('inbox.meta.messages', { count: 1, n: '1' })));
        assert.ok(!chips.includes('followers') && !chips.includes(t('inbox.meta.followsYou')) && !chips.includes(t('inbox.meta.notFollowsYou')));
        assert.equal(String(I.metaMarkup({ id: 'n' })), '', 'nothing known: nothing drawn');
        assert.equal(String(I.metaMarkup({ id: 'z', follower_count: null, message_count: null })), '', 'null is not zero');
        assert.ok(String(I.metaMarkup({ id: 'z', follower_count: 0 })).includes('0'), 'a real zero is a count');
    });

    it('a sender with no name has a person glyph, not an empty circle, and a name’s initials are the right letters', () => {
        const { I } = load();
        assert.ok(String(I.avatarMarkup({ instagram_user_id: '1' })).includes('data-lucide="user"'));
        assert.equal(I.initialsOf({ profile_name: 'Sam Dev' }), 'SD');
        assert.equal(I.initialsOf({ username: 'sam_dev' }), 'SD');
        assert.equal(I.initialsOf({ username: 'samdev' }), 'SA');
        assert.equal(I.initialsOf({ profile_name: 'محمد علي' }), 'مع');
        assert.equal(I.initialsOf({ profile_name: '  ' }), '');
        assert.equal(I.initialsOf({ profile_name: '🙂🙂' }), '');
        assert.equal(I.initialsOf(null), '');
    });

    it('a repaint writes the avatar and the chips only when they changed, so an idle poll touches nothing', () => {
        const { I, host } = load();
        host('chat-pane-container');
        I.renderChatShell(SAM);
        // The two elements the shell has, counting what is written to them.
        let avatarWrites = 0;
        let metaWrites = 0;
        const avatar = host('chat-avatar');
        const meta = host('chat-meta');
        Object.defineProperty(avatar, 'innerHTML', { get: () => '', set: () => { avatarWrites++; }, configurable: true });
        Object.defineProperty(meta, 'innerHTML', { get: () => '', set: () => { metaWrites++; }, configurable: true });
        I.paintAvatar({ ...SAM });
        I.paintMeta({ ...SAM });
        assert.equal(avatarWrites, 0, 'the avatar markup is what the shell wrote');
        assert.equal(metaWrites, 0, 'and so are the chips');
        I.paintMeta({ ...SAM, message_count: 28 });
        assert.equal(metaWrites, 1, 'a new message: the count moved');
        I.paintMeta({ ...SAM, message_count: 28 });
        assert.equal(metaWrites, 1, 'and an idle poll after it writes nothing');
        I.paintAvatar({ ...SAM, profile_pic_url: 'https://cdn.example.test/new.jpg' });
        assert.equal(avatarWrites, 1, 'a refreshed picture link repaints the avatar');
    });

    it('a picture that will not load is removed, remembered, and not drawn again — the initials are what is left', () => {
        const { I } = load();
        const src = 'https://cdn.example.test/expired.jpg';
        let removed = 0;
        const img = { classList: { contains: (c: string) => c === 'avatar-img' }, getAttribute: () => src, remove: () => { removed++; } };
        I.handleImageError({ target: img });
        assert.equal(removed, 1);
        const avatar = String(I.avatarMarkup({ profile_name: 'Sam Dev', profile_pic_url: src }));
        assert.ok(!avatar.includes('<img') && avatar.includes('SD'));
        // An attachment preview that fails is removed too, and anything else is left alone.
        let attachmentRemoved = 0;
        I.handleImageError({ target: { classList: { contains: (c: string) => c === 'msg-attachment-img' }, remove: () => { attachmentRemoved++; } } });
        assert.equal(attachmentRemoved, 1);
        let other = 0;
        I.handleImageError({ target: { classList: { contains: () => false }, remove: () => { other++; } } });
        I.handleImageError(null);
        I.handleImageError({ target: {} });
        assert.equal(other, 0);
    });
});

// ─── Looking the sender up ───────────────────────────────────────────────────────────────────
describe('the sender’s profile is asked for lazily, once, and never gets in the way', () => {
    const IG = (over: Json = {}) => ({ id: 'c1', platform: 'instagram', instagram_user_id: '1', profile_fetched_at: null, profile_checked_at: null, ...over });
    const HOUR = 3600000;
    const DAY = 24 * HOUR;
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

    it('needs a profile when it is an Instagram thread that was never looked up, or last looked up over a day ago', () => {
        const { I } = load();
        assert.equal(I.needsProfile(IG()), true);
        assert.equal(I.needsProfile(IG({ profile_fetched_at: ago(DAY + HOUR) })), true, 'stale, and the picture link has probably expired');
        assert.equal(I.needsProfile(IG({ profile_fetched_at: ago(2 * HOUR) })), false, 'fresh');
    });

    it('does not ask for a Messenger thread, an unattributed one, or when the server would refuse', () => {
        const { I } = load();
        assert.equal(I.needsProfile({ id: 'f', platform: 'facebook' }), false);
        assert.equal(I.needsProfile({ id: 'n', platform: null }), false);
        assert.equal(I.needsProfile(null), false);
        assert.equal(I.needsProfile(IG({ profile_checked_at: ago(10 * 60000) })), false, 'tried ten minutes ago and nothing has worked: an hour');
        assert.equal(I.needsProfile(IG({ profile_checked_at: ago(2 * HOUR) })), true, 'an hour later it may be tried again');
        assert.equal(I.needsProfile(IG({ profile_fetched_at: ago(DAY + HOUR), profile_checked_at: ago(2 * HOUR) })), false, 'a stale profile is refreshed once a day, tried or not');
    });

    it('picks the newest few that need one, and none it has already asked about this visit', () => {
        const { I } = load();
        const rows = [IG({ id: 'a' }), IG({ id: 'b', platform: 'facebook' }), IG({ id: 'c' }), IG({ id: 'd', profile_fetched_at: ago(HOUR) }), IG({ id: 'e' }), IG({ id: 'f' })];
        assert.deepEqual(I.profileCandidates(rows, 2).map((x: Json) => x.id), ['a', 'c']);
        I._profileAsked.add('a');
        assert.deepEqual(I.profileCandidates(rows, 5).map((x: Json) => x.id), ['c', 'e', 'f']);
        assert.equal(I.profileCandidates(null, 3).length, 0);
    });

    it('asks once per thread per visit, and copies the answer onto the thread and its header', async () => {
        const { I, api, calls, host } = load();
        host('chat-pane-container');
        const thread = { ...IG({ id: 'c1' }), username: null };
        I.threads = [thread];
        I.renderChatShell(thread);
        api.refreshConversationProfile = () => Promise.resolve({ refreshed: true, reason: 'refreshed', profile: {
            username: 'sam_dev', profile_name: 'Sam Dev', profile_pic_url: 'https://cdn.example.test/s.jpg', follower_count: 10,
            is_user_follow_business: true, is_business_follow_user: null, is_verified_user: false,
            profile_fetched_at: NOW(), profile_checked_at: NOW(),
        } });
        await I.refreshProfile('c1');
        await I.refreshProfile('c1');
        assert.equal(calls.filter((c) => c.method === 'refreshConversationProfile').length, 1);
        assert.equal(thread.username, 'sam_dev');
        assert.equal((thread as Json).profile_name, 'Sam Dev');
        assert.equal(I.threadTitle(thread), 'Sam Dev');
    });

    it('says nothing, and keeps what it had, when the lookup fails', async () => {
        const { I, api, calls } = load();
        const thread = IG({ id: 'c1' });
        I.threads = [thread];
        api.refreshConversationProfile = () => Promise.reject(new Error('502'));
        await assert.doesNotReject(() => I.refreshProfile('c1'));
        assert.equal(thread.profile_fetched_at, null);
        assert.equal(calls.length, 1);
        api.refreshConversationProfile = () => Promise.resolve({ refreshed: false, reason: 'throttled' });
        await assert.doesNotReject(() => I.refreshProfile('c2'));
        assert.equal(I.threadTitle({ instagram_user_id: '1234' }), 'User 1234');
    });

    it('a viewer does not ask: the server would send to Meta on their behalf, so it refuses', async () => {
        const { I, calls, app } = load();
        app.canOperate = () => false;
        await I.refreshProfile('c1');
        assert.equal(calls.length, 0);
    });

    it('opening a thread asks for it; the first list of a visit asks for at most five, and only once', async () => {
        const { I, api, calls, host } = load();
        host('chat-pane-container');
        api.refreshConversationProfile = () => Promise.resolve({ refreshed: false, reason: 'throttled' });
        const rows = Array.from({ length: 9 }, (_, i) => IG({ id: `c${i}` }));
        await I.backfillProfiles(rows);
        assert.equal(calls.filter((c) => c.method === 'refreshConversationProfile').length, 5);
        await I.backfillProfiles(rows);
        assert.equal(calls.length, 5, 'the batch is once a visit');
        // Opening a sixth thread asks for that one.
        await I.maybeRefreshProfile(rows[5]);
        assert.equal(calls.length, 6);
        assert.deepEqual(calls[5]!.args, ['c5']);
        await I.maybeRefreshProfile(IG({ id: 'fresh', profile_fetched_at: NOW() }));
        assert.equal(calls.length, 6, 'a fresh profile is not asked for');
    });
});
