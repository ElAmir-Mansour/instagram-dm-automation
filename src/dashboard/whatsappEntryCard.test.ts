/**
 * The WhatsApp card's two entry-point sections (docs/specs/001-whatsapp-agent, T052 / T053): campaign links with their QR codes, and the
 * ice breakers. The backend is `GET/POST /entry-links`, `DELETE /entry-links/:code` and `GET/PUT /ice-breakers` (`src/routes/whatsapp.ts`).
 *
 * Loaded like `whatsappCard.test.ts`: the REAL shipped files in a `node:vm` context with a fake DOM, so these test what ships. What is pinned,
 * because a screenshot cannot check it:
 *
 *   - every code the entry-point routes can answer with (`ENTRY_POINT_ERROR_CODES`, imported from the service, not copied) has a sentence in
 *     both languages and a place in the card's table, and the card knows no code that list does not;
 *   - the limits checked in the browser ARE the server's: the label (60), the first message (120), the ice breakers (4 x 80, no emoji) are
 *     compared with `parseEntryLinkInput` / `parseConversationalAutomation` on the same inputs, so a change on either side fails here;
 *   - the sections draw in every state (reading, refused with Retry, empty, listed), for the owner and read only for a member, with
 *     everything Meta or a person supplied escaped and no address that is not https ever made an `href` or a `src`;
 *   - nothing is sent without a press, only the owner can press, a press while a request is out is not a second request, Delete asks first, and
 *     what is drawn after a save is what Meta answered it holds, never what was typed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import {
    COMMAND_DESCRIPTION_MAX_CHARS, COMMAND_NAME_MAX_CHARS, COMMANDS_MAX, hasEmoji, ICE_BREAKER_MAX_CHARS, ICE_BREAKERS_MAX,
    parseConversationalAutomation,
} from '../services/whatsapp.js';
import { ENTRY_LABEL_MAX_CHARS, ENTRY_POINT_ERROR_CODES, ENTRY_PREFILL_MAX_CHARS, parseEntryLinkInput } from '../services/whatsappEntryLinks.js';

type Json = any;

interface Loaded {
    Card: Json;
    UI: Json;
    t: (key: string, params?: Record<string, unknown>) => string;
    api: Record<string, (...args: Json[]) => unknown>;
    calls: Array<{ method: string; args: Json[] }>;
    confirms: Json[];
    toasts: Array<{ message: string; type: unknown }>;
    copied: string[];
    dom: Map<string, Json>;
    host(id: string, over?: Json): Json;
}

function load(lang: 'ar' | 'en' = 'en', opts: { owner?: boolean; clipboard?: 'ok' | 'refused' | 'absent' } = {}): Loaded {
    const owner = opts.owner !== false;
    const noop = (): void => {};
    const dom = new Map<string, Json>();
    const api: Record<string, (...args: Json[]) => unknown> = {};
    const calls: Array<{ method: string; args: Json[] }> = [];
    const confirms: Json[] = [];
    const copied: string[] = [];
    const stub = {
        addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null, contains: () => false, children: [], innerHTML: '', textContent: '',
    };
    const clipboard = opts.clipboard === 'absent' ? undefined : {
        writeText: async (value: string) => {
            if (opts.clipboard === 'refused') throw new Error('NotAllowedError');
            copied.push(value);
        },
    };
    const ctx: Json = {
        document: {
            ...stub, createElement: () => ({ ...stub }), body: { ...stub }, head: { ...stub },
            documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => dom.get(id) ?? null, activeElement: null, visibilityState: 'visible',
        },
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
        Intl, console: { log: noop, warn: noop, error: noop, info: noop, debug: noop }, clearTimeout, URLSearchParams,
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        setTimeout: (fn: () => void, ms?: number) => { const h = setTimeout(fn, ms); (h as Json).unref?.(); return h; },
        setInterval: (fn: () => void, ms?: number) => { const h = setInterval(fn, ms); (h as Json).unref?.(); return h; },
        clearInterval, requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang, ...(clipboard ? { clipboard } : {}) }, CSS: { escape: (v: string) => String(v) },
        API: new Proxy(api, {
            get: (target, prop: string) => (prop === 'token' ? 'tok' : prop in target
                ? (...args: Json[]) => { calls.push({ method: prop, args }); return target[prop]!(...args); }
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        Admin: { emptyState: (_i: string, title: string) => `<div>${title}</div>`, confirm: noop },
        App: {
            currentTheme: () => 'auto', navigate: noop, session: { tenantId: 't1' }, hashParam: () => '',
            canOperate: () => true, canAdminister: () => owner, isAdmin: () => true,
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js', 'dashboard/js/motion.js',
        'dashboard/js/pages/whatsapp_card.js',
    ]) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const got = vm.runInContext('({ Card: WhatsAppCard, UI, t })', ctx);
    const toasts: Array<{ message: string; type: unknown }> = [];
    got.UI.toast = (message: unknown, type: unknown) => { toasts.push({ message: String(message), type }); };
    got.UI.confirm = (o: Json) => { confirms.push(o); };
    const host = (id: string, over: Json = {}): Json => {
        const el: Json = { id, innerHTML: '', textContent: '', value: '', dataset: {}, disabled: false, classList: stub.classList, scrollIntoView: noop, focus: noop, setAttribute: noop, ...over };
        dom.set(id, el);
        return el;
    };
    return { Card: got.Card, UI: got.UI, t: got.t, api, calls, confirms, toasts, copied, dom, host };
}

const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));
const markupOf = (s: Loaded): string => String(s.Card.body());
const escaped = (text: string): string => text.replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);

/** A connected number, as `GET /api/whatsapp/connection` answers it. */
const view = (over: Json = {}): Json => ({
    connected: true, status: 'active', phone_number_id: '106540352242922', display_phone_number: '+1 555 025 3483', verified_name: 'Test Number',
    quality_rating: 'GREEN', messaging_limit: 'TIER_250', name_status: 'APPROVED', number_status: 'CONNECTED', is_test_number: true,
    last_error: null, last_refreshed_at: '2026-10-19T09:00:00.000Z', token_expires_at: null, mode: 'off', test_senders: [],
    usage: { period: '2026-10', free_used: 0, free_limit: 1000, billable: 0, est_cost_usd: 0, projected_cost_usd: 0 },
    allow_billable: false, free_tier_alert_at: 900, go_live: { ready: false, missing: ['not_test_number'] },
    ...over,
});
const none = (over: Json = {}): Json => view({ connected: false, status: null, phone_number_id: null, display_phone_number: null, verified_name: null, ...over });
const refused = (): Json => view({ connected: false, status: 'invalid', last_error: 'Session has expired' });

/** One row of `GET /entry-links` (`EntryLinkView`). */
const link = (over: Json = {}): Json => ({
    id: 'ABC123', code: 'ABC123', label: 'Instagram bio', ref: 'K7M3QA', prefill: 'Hi, I saw your bio', prefilled_message: 'Hi, I saw your bio #K7M3QA',
    url: 'https://wa.me/message/ABC123', qr_image_url: 'https://scontent.example/qr/ABC123.png', created_at: '2026-10-19T09:00:00.000Z', managed: true,
    conversations: null, ...over,
});

/** What `GET/PUT /ice-breakers` answers. */
const iceAnswer = (prompts: string[], over: Json = {}): Json => ({
    prompts, commands: [], verified: true,
    limits: { prompts: 4, prompt_chars: 80, commands: 30, command_name_chars: 32, command_description_chars: 256 }, ...over,
});

function refusal(status: number, body: Json): Error {
    const sentence = typeof body.error === 'string' ? body.error : `HTTP ${status}`;
    const err: Json = new Error(sentence);
    err.status = status;
    err.body = body;
    if (typeof body.code === 'string') err.code = body.code;
    return err;
}

/** A connected card whose two reads have answered, on a page that has the two regions and the form fields in it. */
async function ready(s: Loaded, links: Json[] = [link()], prompts: string[] = ['How much is it?']): Promise<void> {
    s.api['getWhatsAppEntryLinks'] = async () => links;
    s.api['getWhatsAppIceBreakers'] = async () => iceAnswer(prompts);
    s.Card.section(view());
    await s.Card.loadEntry();
}

/** The page's controls, with the values the owner typed into them. */
function typeInto(s: Loaded, fields: Record<string, string>): void {
    s.host('wa-card');
    for (const [id, value] of Object.entries(fields)) s.host(id, { value });
}

const HOSTILE = '"><img src=x onerror=alert(1)>';

/** The opening tag of the input, textarea or button with this id, or '' when there is none. */
function tagById(markup: string, id: string): string {
    for (const m of markup.matchAll(/<(?:input|textarea|button|label)\b[^>]*>/g)) if (m[0].includes(`id="${id}"`)) return m[0];
    return '';
}
const valueOf = (tag: string): string | null => /\svalue="([^"]*)"/.exec(tag)?.[1] ?? null;
const isDisabled = (tag: string): boolean => /\sdisabled(\s|>|=)/.test(tag);

/** Every opening tag in the markup, read the way a browser reads one: quoted values are skipped, so an escaped quote does not end one. */
function tags(markup: string): Array<{ name: string; attrs: string[] }> {
    const out: Array<{ name: string; attrs: string[] }> = [];
    const open = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`]+))?)*)\s*\/?>/g;
    for (const m of markup.matchAll(open)) {
        const names = [...(m[2] ?? '').replace(/"[^"]*"|'[^']*'/g, '""').matchAll(/\s+([^\s"'<>/=]+)/g)].map((a) => a[1]!);
        out.push({ name: m[1]!, attrs: names });
    }
    return out;
}

// ─── The words ───────────────────────────────────────────────────────────────────────────────────

describe('entry points: every code the routes can answer has words', () => {
    it('the service lists codes (so this cannot pass by reading nothing), and the card\'s table is exactly that list', () => {
        assert.ok(ENTRY_POINT_ERROR_CODES.length >= 20, `${ENTRY_POINT_ERROR_CODES.length} codes`);
        for (const code of ['qr_refused', 'not_confirmed', 'prompt_has_emoji', 'label_too_long', 'duplicate_command']) assert.ok(ENTRY_POINT_ERROR_CODES.includes(code), code);
        const s = load();
        assert.deepEqual(Object.keys(s.Card.ENTRY_ERRORS).sort(), [...ENTRY_POINT_ERROR_CODES].sort());
    });

    it('each has a sentence in Arabic and in English, with its limit filled in and no raw placeholder, and `describe` returns it', () => {
        for (const lang of ['ar', 'en'] as const) {
            const s = load(lang);
            for (const code of ENTRY_POINT_ERROR_CODES) {
                const key = `wa.err.${code}`;
                const sentence = s.t(key, { max: 7 });
                assert.notEqual(sentence, key, `${lang}: ${code} has no sentence`);
                const said = s.Card.describe({ code }).message;
                assert.ok(said.length > 0 && !/[{}]/.test(said), `${lang}: ${code} says "${said}"`);
                assert.notEqual(said, key);
            }
            // The Arabic ones are Arabic, not the English fallback.
            if (lang === 'ar') for (const code of ENTRY_POINT_ERROR_CODES) assert.ok(/[؀-ۿ]/.test(s.t(`wa.err.${code}`, { max: 7 })), `${code} is Arabic`);
        }
    });

    it('a sentence that names a limit names the real one: the server\'s own, which the card reads', () => {
        const s = load();
        const named: Array<[string, number]> = [
            ['label_too_long', ENTRY_LABEL_MAX_CHARS], ['prefill_too_long', ENTRY_PREFILL_MAX_CHARS], ['too_many_prompts', ICE_BREAKERS_MAX],
            ['prompt_too_long', ICE_BREAKER_MAX_CHARS], ['too_many_commands', COMMANDS_MAX], ['command_name_too_long', COMMAND_NAME_MAX_CHARS],
            ['command_description_too_long', COMMAND_DESCRIPTION_MAX_CHARS],
        ];
        for (const [code, limit] of named) assert.ok(s.Card.describe({ code }).message.includes(String(limit)), `${code} says ${limit}`);
        // And when Meta's limits arrive with the ice breakers, those are the ones said.
        s.Card.resetEntry();
        s.Card.takeIce(iceAnswer([], { limits: { prompts: 3, prompt_chars: 60, commands: 10, command_name_chars: 20, command_description_chars: 100 } }));
        assert.ok(s.Card.describe({ code: 'prompt_too_long' }).message.includes('60'));
        assert.ok(s.Card.describe({ code: 'too_many_prompts' }).message.includes('3'));
    });

    it('each is tied to the field it is about, and Meta\'s own words are shown beneath only the refusals that are Meta\'s', () => {
        const s = load();
        const field = (code: string): string | null => s.Card.describe({ code }).field;
        assert.equal(field('invalid_label'), 'wa-link-label');
        assert.equal(field('label_too_long'), 'wa-link-label');
        assert.equal(field('invalid_prefill'), 'wa-link-prefill');
        assert.equal(field('prefill_too_long'), 'wa-link-prefill');
        assert.equal(field('qr_refused'), null);
        for (const code of ['qr_refused', 'ice_breakers_refused', 'entry_links_unreadable', 'ice_breakers_unreadable']) {
            assert.equal(s.Card.describe(refusal(400, { error: '(#100) Meta says no', code })).hint, '(#100) Meta says no', code);
        }
        for (const code of ['not_confirmed', 'not_found', 'label_too_long', 'prompt_has_emoji', 'meta_unreachable']) {
            assert.equal(s.Card.describe(refusal(400, { error: 'The server\'s English sentence', code })).hint, '', code);
        }
    });

    it('a code it does not know is never a raw key: the server\'s sentence, or the generic one', () => {
        const s = load();
        assert.equal(s.Card.describe(refusal(400, { error: 'something unheard of', code: 'brand_new_code' })).message, 'something unheard of');
        assert.equal(s.Card.describe({}).message, s.t('common.error'));
        for (const code of ['constructor', '__proto__', 'toString']) assert.equal(s.Card.describe(refusal(400, { error: 'odd', code })).code, '', code);
    });
});

// ─── The limits are the server's ─────────────────────────────────────────────────────────────────

describe('entry points: what is checked in the browser is what the server checks', () => {
    it('the limits written in the card are the service\'s', () => {
        const s = load();
        const l = s.Card.limits();
        assert.deepEqual(plain(l), {
            label: ENTRY_LABEL_MAX_CHARS, prefill: ENTRY_PREFILL_MAX_CHARS, prompts: ICE_BREAKERS_MAX, promptChars: ICE_BREAKER_MAX_CHARS,
            commands: COMMANDS_MAX, commandName: COMMAND_NAME_MAX_CHARS, commandDescription: COMMAND_DESCRIPTION_MAX_CHARS,
        });
    });

    it('a link is refused here for exactly what the server refuses, with the same code', () => {
        const s = load();
        const cases: Array<[string, string]> = [
            ['Instagram bio', 'Hello'], ['', 'Hello'], ['   ', 'Hello'], ['x', ''], ['x', '   '],
            ['a'.repeat(60), 'Hello'], ['a'.repeat(61), 'Hello'], ['  ' + 'a'.repeat(60) + '  ', 'Hello'],
            ['x', 'b'.repeat(120)], ['x', 'b'.repeat(121)], ['x', ' ' + 'b'.repeat(120) + ' '], ['', ''], ['سيرة إنستجرام', 'مرحبا، شفت حسابك'],
        ];
        for (const [label, prefill] of cases) {
            const server = parseEntryLinkInput({ label, prefill });
            const client = s.Card.validateLink({ label, prefill });
            if ('error' in server) assert.equal(client.code, server.code, JSON.stringify([label.length, prefill.length]));
            else assert.deepEqual(plain(client.value), server.value, JSON.stringify([label.length, prefill.length]));
        }
        // Never shortened: a value over the limit is an error, not a cut.
        assert.equal(s.Card.validateLink({ label: 'a'.repeat(61), prefill: 'x' }).value, undefined);
    });

    it('ice breakers are refused here for exactly what the server refuses: empty ones dropped, 80 characters, no emoji, at most four', () => {
        const s = load();
        const lists: string[][] = [
            [], ['How much?'], ['How much?', '', '  ', 'What do you sell?'], ['a'.repeat(80)], ['a'.repeat(81)], ['  ' + 'a'.repeat(80) + '  '],
            ['كم السعر؟', 'وش المنتجات؟'], ['Hello 😀'], ['Love it ❤️'], ['👍'], ['1️⃣ first'], ['Price ©'], ['Brand™'], ['Brand®'], ['100% sure #1'],
            ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', '', ''],
        ];
        for (const prompts of lists) {
            const nonBlank = prompts.map((p) => p.trim()).filter(Boolean);
            // The server is sent what the card would send: blanks dropped. (It refuses an empty one, which the card never sends.)
            const server = parseConversationalAutomation({ prompts: nonBlank });
            const client = s.Card.checkPrompts(prompts);
            if ('error' in server) assert.equal(client.problem?.code, server.code, JSON.stringify(prompts));
            else {
                assert.equal(client.problem, undefined, JSON.stringify(prompts));
                assert.deepEqual(plain(client.prompts), server.value.prompts, JSON.stringify(prompts));
            }
        }
        // The emoji test is the server's own, on everything the two disagree about.
        for (const text of ['😀', '❤️', '1️⃣', '©', '™', '®', '#', '5', '©️', 'abc', 'عربي']) assert.equal(s.Card.EMOJI.test(text), hasEmoji(text), JSON.stringify(text));
    });

    it('a problem names the field it is in (1-based), so the owner is shown which one', () => {
        const s = load();
        assert.deepEqual(plain(s.Card.checkPrompts(['ok', '', 'a'.repeat(81)]).problem), { code: 'prompt_too_long', n: 3 });
        assert.deepEqual(plain(s.Card.checkPrompts(['ok', '😀']).problem), { code: 'prompt_has_emoji', n: 2 });
    });

    it('the inputs carry the same limits as `maxlength`, drawn from the same numbers', () => {
        const s = load();
        s.Card.section(view());
        s.Card.takeIce(iceAnswer(['One']));
        s.Card.entry.links.status = 'ready';
        s.Card.entry.ice.status = 'ready';
        const markup = markupOf(s);
        const tag = (id: string): string => new RegExp(`<(?:input|textarea)\\b[^>]*\\bid="${id}"[^>]*>`).exec(markup)?.[0] ?? '';
        assert.match(tag('wa-link-label'), new RegExp(`maxlength="${ENTRY_LABEL_MAX_CHARS}"`));
        assert.match(tag('wa-link-prefill'), new RegExp(`maxlength="${ENTRY_PREFILL_MAX_CHARS}"`));
        for (let i = 0; i < ICE_BREAKERS_MAX; i++) assert.match(tag(`wa-ice-${i}`), new RegExp(`maxlength="${ICE_BREAKER_MAX_CHARS}"`), `field ${i}`);
        assert.equal(tag(`wa-ice-${ICE_BREAKERS_MAX}`), '', 'no fifth field');
    });
});

// ─── What is drawn ───────────────────────────────────────────────────────────────────────────────

describe('entry points: what is drawn, by state', () => {
    it('a number that is not connected, or whose token Meta refused, has neither section and reads nothing', async () => {
        for (const state of [none(), refused(), none({ status: 'revoked' })]) {
            const s = load();
            const markup = String(s.Card.section(state));
            assert.ok(!markup.includes('id="wa-links"') && !markup.includes('id="wa-ice"'));
            await Promise.resolve();
            await s.Card.loadEntry();
            assert.equal(s.calls.length, 0);
        }
    });

    it('a connected number draws both sections reading, asks Meta for each exactly once after the card is drawn, and calls nothing while drawing', async () => {
        const s = load();
        s.api['getWhatsAppEntryLinks'] = async () => [link()];
        s.api['getWhatsAppIceBreakers'] = async () => iceAnswer([]);
        const markup = String(s.Card.section(view()));
        assert.ok(markup.includes('id="wa-links"') && markup.includes('id="wa-ice"'));
        assert.ok(markup.includes(s.t('wa.link.loading')) && markup.includes(s.t('wa.ice.loading')));
        assert.equal(s.calls.length, 0, 'drawing calls no API');
        await Promise.resolve();
        await s.Card.loadEntry();
        await s.Card.loadEntry();
        assert.deepEqual(s.calls.map((c) => c.method).sort(), ['getWhatsAppEntryLinks', 'getWhatsAppIceBreakers']);
        assert.ok(s.calls.every((c) => c.args.length === 0));
    });

    it('lists each link with its name, first message, tracking code, short link, QR image and Download, and the owner\'s Delete and Copy', async () => {
        const s = load();
        await ready(s, [link({ conversations: 12 }), link({ code: 'ZZZ999', id: 'ZZZ999', label: null, ref: null, conversations: null, url: 'https://wa.me/message/ZZZ999', qr_image_url: null })]);
        const markup = markupOf(s);
        assert.ok(markup.includes('Instagram bio') && markup.includes('Hi, I saw your bio'));
        assert.ok(markup.includes('#K7M3QA'), 'the tracking code');
        assert.ok(markup.includes('https://wa.me/message/ABC123'));
        assert.match(markup, /<img src="https:\/\/scontent\.example\/qr\/ABC123\.png" width="132" height="132"/);
        const download = /<a class="btn btn-secondary btn-sm"[^>]*>/.exec(markup)?.[0] ?? '';
        assert.match(download, /href="https:\/\/scontent\.example\/qr\/ABC123\.png"/);
        assert.match(download, /download="whatsapp-ABC123\.png"/);
        assert.match(download, /rel="noopener noreferrer"/);
        assert.ok(markup.includes(s.t('wa.link.download')));
        assert.ok(markup.includes(s.t('wa.link.conversations', { n: '12' })), 'a count the API gives');
        // The link made elsewhere: no name, no tracking code, no QR (Meta sent none): said, not blank.
        assert.ok(markup.includes(s.t('wa.link.unnamed')) && markup.includes(s.t('wa.link.qr.missing')));
        assert.equal((markup.match(/data-action="wa:copyLink"/g) ?? []).length, 2);
        assert.equal((markup.match(/data-action="wa:askDeleteLink"/g) ?? []).length, 2);
        // A null count is never a guess: nothing is drawn for it.
        const second = markup.slice(markup.indexOf('ZZZ999'));
        assert.ok(!second.includes(s.t('wa.link.conversations', { n: '0' })) && !second.includes(s.t('wa.link.conversations', { n: '' })));
    });

    it('says there are no links yet (and invites the owner, or tells a member), and when Meta could not be read says so with Retry', async () => {
        const s = load();
        await ready(s, []);
        assert.ok(markupOf(s).includes(s.t('wa.link.empty.title')) && markupOf(s).includes(s.t('wa.link.empty.body')));
        const member = load('en', { owner: false });
        await ready(member, []);
        assert.ok(markupOf(member).includes(member.t('wa.link.empty.bodyReadOnly')));

        const failing = load();
        failing.api['getWhatsAppEntryLinks'] = async () => { throw refusal(400, { error: '(#100) nope', code: 'entry_links_unreadable' }); };
        failing.api['getWhatsAppIceBreakers'] = async () => iceAnswer(['Kept']);
        failing.Card.section(view());
        await failing.Card.loadEntry();
        const markup = markupOf(failing);
        assert.ok(markup.includes(escaped(failing.t('wa.err.entry_links_unreadable'))) && markup.includes('(#100) nope'), 'the sentence, and Meta\'s words beneath it');
        assert.ok(markup.includes('data-action="wa:reloadLinks"'), 'Retry');
        // The other section is unaffected by it.
        assert.equal(valueOf(tagById(markup, 'wa-ice-0')), 'Kept');
    });

    it('Retry asks again and shows the links when Meta answers this time', async () => {
        const s = load();
        let answer: () => Promise<unknown> = async () => { throw refusal(502, { error: 'Meta could not be reached', code: 'meta_unreachable' }); };
        s.api['getWhatsAppEntryLinks'] = () => answer();
        s.api['getWhatsAppIceBreakers'] = async () => iceAnswer([]);
        s.Card.section(view());
        await s.Card.loadEntry();
        assert.equal(s.Card.entry.links.status, 'error');
        assert.equal(s.Card.entry.links.error.message, s.t('wa.err.meta_unreachable'));
        answer = async () => [link()];
        const list = s.host('wa-links-list');
        await s.Card.reloadLinks();
        assert.equal(s.Card.entry.links.status, 'ready');
        assert.ok(list.innerHTML.includes('Instagram bio'), 'only the list was redrawn, and it shows the link');
        assert.equal(s.calls.filter((c) => c.method === 'getWhatsAppEntryLinks').length, 2);
    });

    it('a member reads: the links and the questions, with no form, no Delete, no Save and no field to type in', async () => {
        const s = load('en', { owner: false });
        await ready(s, [link()], ['How much is it?', 'What do you sell?']);
        const markup = markupOf(s);
        assert.ok(markup.includes('Instagram bio') && markup.includes('How much is it?') && markup.includes('What do you sell?'));
        for (const absent of ['wa-link-form', 'wa-link-create', 'wa:askDeleteLink', 'wa-ice-form', 'wa-ice-save', 'id="wa-ice-0"', 'wa-link-label']) assert.ok(!markup.includes(absent), absent);
        assert.ok(markup.includes('data-action="wa:copyLink"'), 'copying a link is reading');
        assert.ok(markup.includes(s.t('wa.ownerOnly')));
        const empty = load('en', { owner: false });
        await ready(empty, [], []);
        assert.ok(markupOf(empty).includes(empty.t('wa.ice.none')));
    });

    it('both languages draw every state with no raw key and no raw placeholder in it', async () => {
        for (const lang of ['ar', 'en'] as const) {
            for (const owner of [true, false]) {
                const s = load(lang, { owner });
                const states: Array<() => Promise<void>> = [
                    async () => { s.Card.section(view()); },
                    async () => { await ready(s, [link({ conversations: 3 }), link({ code: 'ZZZ999', id: 'ZZZ999', label: null, qr_image_url: null })], ['One', 'Two']); },
                    async () => { await ready(s, [], []); },
                    async () => {
                        s.api['getWhatsAppEntryLinks'] = async () => { throw refusal(400, { error: 'x', code: 'entry_links_unreadable' }); };
                        s.api['getWhatsAppIceBreakers'] = async () => { throw refusal(502, { error: 'x', code: 'meta_unreachable' }); };
                        s.Card.section(view());
                        await s.Card.loadEntry();
                    },
                ];
                for (const [i, draw] of states.entries()) {
                    await draw();
                    const markup = markupOf(s);
                    const hit = markup.match(/\bwa\.(?!me\b)[A-Za-z][\w.]*|\{\w+\}/);
                    assert.ok(!hit, `${lang}/${owner ? 'owner' : 'member'}/state ${i}: ${hit?.[0]}`);
                }
            }
        }
    });

    it('everything Meta or a person supplied is text: the name, the message, the code, the address, the questions', async () => {
        const s = load();
        await ready(s, [link({ label: HOSTILE, prefill: HOSTILE, ref: HOSTILE, url: `https://wa.me/${HOSTILE}`, qr_image_url: `https://x.example/${HOSTILE}` })], [HOSTILE]);
        s.Card.errors.linkForm = s.Card.describe(refusal(400, { error: HOSTILE, code: 'qr_refused' }));
        s.Card.linkForm = { label: HOSTILE, prefill: HOSTILE };
        const markup = markupOf(s);
        assert.equal((markup.match(/<img\b/gi) ?? []).length, 1, 'the QR image is the only <img>');
        assert.ok(!/<script\b/i.test(markup));
        assert.ok(markup.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
        for (const tag of tags(markup)) {
            for (const attr of tag.attrs) assert.ok(!/^on/i.test(attr) && attr !== 'autofocus', `<${tag.name}> grew an ${attr} attribute out of a value`);
        }
    });

    it('an address that is not https is never made an href or a src: it is dropped, and the QR is said to be missing', async () => {
        const s = load();
        const evil = ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://insecure.example/qr.png', '//cdn.example/qr.png', '/api/uploads/x', 'ftp://x/y', '', null, 42];
        await ready(s, evil.map((u, i) => link({ code: `CODE${i}0`, id: `CODE${i}0`, url: u, qr_image_url: u })));
        const markup = markupOf(s);
        assert.ok(!/(?:href|src)="(?!https:\/\/)[^"]*"/.test(markup.replace(/href="#[^"]*"/g, '')), 'no non-https href or src');
        assert.ok(!markup.includes('javascript:') && !markup.includes('data:image'));
        assert.equal((markup.match(/<img\b/g) ?? []).length, 0);
        assert.equal((markup.match(new RegExp(escaped(s.t('wa.link.qr.missing')), 'g')) ?? []).length, evil.length);
        assert.equal((markup.match(/data-action="wa:copyLink"/g) ?? []).length, 0, 'nothing to copy without an address');
    });

    it('a row with no code, or not an object, is not drawn', async () => {
        const s = load();
        await ready(s, [null, 'x', {}, { code: '' }, { code: 5 }, link()] as Json[]);
        assert.equal(s.Card.entry.links.items.length, 1);
    });
});

// ─── Campaign links: actions ─────────────────────────────────────────────────────────────────────

describe('entry points: creating a link', () => {
    it('sends exactly { label, prefill }, trimmed, once; shows the new link first; empties the form; says so', async () => {
        const s = load();
        await ready(s, [link()]);
        typeInto(s, { 'wa-link-label': '  Poster  ', 'wa-link-prefill': '  Hello from the poster  ' });
        let release: (v: unknown) => void = () => {};
        s.api['createWhatsAppEntryLink'] = () => new Promise((r) => { release = r; });

        const pending = s.Card.createLink(null, { preventDefault() {} });
        assert.deepEqual(plain(s.calls.find((c) => c.method === 'createWhatsAppEntryLink')?.args[0]), { label: 'Poster', prefill: 'Hello from the poster' });
        assert.equal(s.Card.busy, 'linkCreate');
        await s.Card.createLink(null, { preventDefault() {} });
        assert.equal(s.calls.filter((c) => c.method === 'createWhatsAppEntryLink').length, 1, 'a second press is not a second request');
        assert.equal(isDisabled(tagById(markupOf(s), 'wa-link-create')), true);

        release(link({ code: 'NEW111', id: 'NEW111', label: 'Poster', prefill: 'Hello from the poster', label_saved: true }));
        await pending;
        assert.equal(s.Card.busy, null);
        assert.deepEqual(plain(s.Card.entry.links.items.map((x: Json) => x.code)), ['NEW111', 'ABC123'], 'newest first, the others kept');
        assert.deepEqual(plain(s.Card.linkForm), { label: '', prefill: '' });
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.link.created') && x.type === 'success'));
    });

    it('a link made whose name could not be kept is shown, with a warning that says so (never an error that invites a second one)', async () => {
        const s = load();
        await ready(s, []);
        typeInto(s, { 'wa-link-label': 'A', 'wa-link-prefill': 'B' });
        s.api['createWhatsAppEntryLink'] = async () => link({ code: 'NEW111', id: 'NEW111', label: null, label_saved: false });
        await s.Card.createLink(null, { preventDefault() {} });
        assert.equal(s.Card.entry.links.items.length, 1);
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.link.createdUnnamed') && x.type === 'warning'));
        assert.equal(s.Card.errors.linkForm, null);
    });

    it('a form that is wrong sends nothing, names the field, and keeps what was typed', async () => {
        const wrong: Array<[Record<string, string>, string, string]> = [
            [{ 'wa-link-label': '', 'wa-link-prefill': 'Hi' }, 'invalid_label', 'wa-link-label'],
            [{ 'wa-link-label': 'a'.repeat(61), 'wa-link-prefill': 'Hi' }, 'label_too_long', 'wa-link-label'],
            [{ 'wa-link-label': 'A', 'wa-link-prefill': '  ' }, 'invalid_prefill', 'wa-link-prefill'],
            [{ 'wa-link-label': 'A', 'wa-link-prefill': 'b'.repeat(121) }, 'prefill_too_long', 'wa-link-prefill'],
        ];
        for (const [fields, code, field] of wrong) {
            const s = load();
            await ready(s);
            typeInto(s, fields);
            s.api['createWhatsAppEntryLink'] = async () => link();
            await s.Card.createLink(null, { preventDefault() {} });
            assert.equal(s.calls.filter((c) => c.method === 'createWhatsAppEntryLink').length, 0, code);
            assert.equal(s.Card.errors.linkForm.code, code);
            assert.equal(s.Card.errors.linkForm.field, field);
            assert.equal(s.Card.linkForm.label, fields['wa-link-label'], 'what was typed is kept');
            assert.ok(markupOf(s).includes(escaped(s.Card.errors.linkForm.message)), 'and the card says it');
        }
    });

    it('Meta refusing is said in words with Meta\'s own beneath, and what was typed is kept', async () => {
        const s = load();
        await ready(s);
        typeInto(s, { 'wa-link-label': 'A', 'wa-link-prefill': 'B' });
        s.api['createWhatsAppEntryLink'] = async () => { throw refusal(400, { error: '(#2) The limit of 2,000 codes is reached', code: 'qr_refused' }); };
        await s.Card.createLink(null, { preventDefault() {} });
        assert.equal(s.Card.errors.linkForm.message, s.t('wa.err.qr_refused'));
        assert.equal(s.Card.errors.linkForm.hint, '(#2) The limit of 2,000 codes is reached');
        assert.deepEqual(plain(s.Card.linkForm), { label: 'A', prefill: 'B' });
        assert.equal(s.Card.busy, null);
        assert.equal(s.Card.entry.links.items.length, 1, 'nothing was added');
    });

    it('a create whose answer never came is NOT "nothing was saved": it says the link may exist, and asks Meta for the list again', async () => {
        const s = load();
        await ready(s);
        typeInto(s, { 'wa-link-label': 'A', 'wa-link-prefill': 'B' });
        s.api['createWhatsAppEntryLink'] = async () => { throw refusal(502, { error: 'Meta did not answer', code: 'meta_unreachable' }); };
        let reads = 0;
        s.api['getWhatsAppEntryLinks'] = async () => { reads += 1; return [link(), link({ code: 'MAYBE1', id: 'MAYBE1' })]; };
        await s.Card.createLink(null, { preventDefault() {} });
        assert.equal(s.Card.errors.linkForm.message, s.t('wa.link.createUnknown'));
        assert.notEqual(s.Card.errors.linkForm.message, s.t('wa.err.meta_unreachable'));
        await s.Card.entryLoading;
        await Promise.resolve();
        assert.equal(reads, 1, 'the list was asked for again');
        assert.equal(s.Card.entry.links.items.length, 2, 'and shows what Meta holds');
    });

    it('a member cannot create, even if the handler is called with a full form', async () => {
        const s = load('en', { owner: false });
        await ready(s);
        typeInto(s, { 'wa-link-label': 'A', 'wa-link-prefill': 'B' });
        s.api['createWhatsAppEntryLink'] = async () => link();
        await s.Card.createLink(null, { preventDefault() {} });
        assert.equal(s.calls.filter((c) => c.method === 'createWhatsAppEntryLink').length, 0);
    });
});

describe('entry points: deleting a link', () => {
    it('asks first, says what it does and names the link, and calls the API only when the dialog\'s own confirm runs', async () => {
        const s = load();
        await ready(s, [link(), link({ code: 'ZZZ999', id: 'ZZZ999', label: 'Poster' })]);
        s.api['deleteWhatsAppEntryLink'] = async () => null;
        s.Card.askDeleteLink({ dataset: { code: 'ZZZ999' } });

        assert.equal(s.confirms.length, 1);
        assert.equal(s.calls.filter((c) => c.method === 'deleteWhatsAppEntryLink').length, 0, 'a press alone sends nothing');
        assert.equal(s.confirms[0].title, s.t('wa.link.delete.title', { name: 'Poster' }));
        assert.equal(s.confirms[0].body, s.t('wa.link.delete.body'));
        assert.ok(String(s.confirms[0].hint).length > 0);
        assert.equal(s.confirms[0].tone, undefined, 'the default tone of the confirmation is danger');

        await s.confirms[0].onConfirm();
        assert.deepEqual(s.calls.filter((c) => c.method === 'deleteWhatsAppEntryLink').map((c) => c.args), [['ZZZ999']], 'only the code of that link');
        assert.deepEqual(plain(s.Card.entry.links.items.map((x: Json) => x.code)), ['ABC123']);
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.link.deleted') && x.type === 'success'));
        assert.equal(s.Card.busy, null);
    });

    it('a refusal stays inside the dialog, in the owner\'s language with Meta\'s words after it, and the link stays', async () => {
        const s = load();
        await ready(s);
        s.api['deleteWhatsAppEntryLink'] = async () => { throw refusal(400, { error: '(#10) Permission denied', code: 'qr_refused' }); };
        s.Card.askDeleteLink({ dataset: { code: 'ABC123' } });
        await assert.rejects(Promise.resolve(s.confirms[0].onConfirm()), (e: Error) => e.message === `${s.t('wa.err.qr_refused')} (#10) Permission denied`);
        assert.equal(s.Card.entry.links.items.length, 1);
        assert.equal(s.Card.busy, null);

        s.api['deleteWhatsAppEntryLink'] = async () => { throw refusal(502, { error: 'Meta did not confirm the deletion', code: 'not_confirmed' }); };
        await assert.rejects(Promise.resolve(s.confirms[0].onConfirm()), (e: Error) => e.message === s.t('wa.err.not_confirmed'));
        assert.equal(s.Card.entry.links.items.length, 1, 'not confirmed is not deleted');
    });

    it('a link that is already gone at Meta (404) leaves the list and closes the dialog: it is what was wanted', async () => {
        const s = load();
        await ready(s);
        s.api['deleteWhatsAppEntryLink'] = async () => { throw refusal(404, { error: 'That entry link does not exist on this number.', code: 'not_found' }); };
        s.Card.askDeleteLink({ dataset: { code: 'ABC123' } });
        await s.confirms[0].onConfirm();
        assert.equal(s.Card.entry.links.items.length, 0);
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.link.alreadyGone')));
    });

    it('nothing happens for a link that is not on the list, for a member, or while another request is out', async () => {
        const member = load('en', { owner: false });
        await ready(member);
        member.Card.askDeleteLink({ dataset: { code: 'ABC123' } });
        assert.equal(member.confirms.length, 0);

        const s = load();
        await ready(s);
        s.Card.askDeleteLink({ dataset: { code: 'NOPE00' } });
        s.Card.askDeleteLink(null);
        s.Card.busy = 'linkCreate';
        s.Card.askDeleteLink({ dataset: { code: 'ABC123' } });
        assert.equal(s.confirms.length, 0);
    });
});

describe('entry points: copying a link', () => {
    it('puts the short link on the clipboard, looked up by the link\'s code, and says so', async () => {
        const s = load();
        await ready(s, [link(), link({ code: 'ZZZ999', id: 'ZZZ999', url: 'https://wa.me/message/ZZZ999' })]);
        await s.Card.copyLink({ dataset: { code: 'ZZZ999' } });
        assert.deepEqual(s.copied, ['https://wa.me/message/ZZZ999']);
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.link.copied')));
        assert.ok(!markupOf(s).includes('data-copy='), 'the address is not carried in an attribute of the button');
    });

    it('when the browser refuses (or has no clipboard) it says so instead of appearing to have worked, and a member may copy', async () => {
        for (const clipboard of ['refused', 'absent'] as const) {
            const s = load('en', { owner: false, clipboard });
            await ready(s);
            await s.Card.copyLink({ dataset: { code: 'ABC123' } });
            assert.deepEqual(s.copied, []);
            assert.ok(s.toasts.some((x) => x.message === s.t('setup.copyFailed') && x.type === 'error'), clipboard);
        }
        const s = load();
        await ready(s);
        await s.Card.copyLink({ dataset: { code: 'NOPE00' } });
        await s.Card.copyLink(null);
        assert.deepEqual(s.copied, []);
    });
});

// ─── Ice breakers: actions ───────────────────────────────────────────────────────────────────────

describe('entry points: the ice breakers', () => {
    it('shows what Meta holds in four fields, with a counter each, and Save is off until something differs', async () => {
        const s = load();
        await ready(s, [], ['How much is it?', 'What do you sell?']);
        const markup = markupOf(s);
        assert.equal(valueOf(tagById(markup, 'wa-ice-0')), 'How much is it?');
        assert.equal(valueOf(tagById(markup, 'wa-ice-1')), 'What do you sell?');
        assert.equal(valueOf(tagById(markup, 'wa-ice-2')), '');
        assert.ok(markup.includes(s.t('wa.counter', { n: 'How much is it?'.length, max: 80 })));
        assert.ok(markup.includes(s.t('wa.ice.prefillNote')), 'a prefilled link hides them: said');
        assert.equal(isDisabled(tagById(markup, 'wa-ice-save')), true);

        typeInto(s, { 'wa-ice-0': 'How much is it?', 'wa-ice-1': 'What do you sell?', 'wa-ice-2': '', 'wa-ice-3': '' });
        s.host('wa-ice-save');
        s.Card.edit();
        assert.equal(s.Card.iceDirty(), false);
        s.dom.get('wa-ice-2')!.value = 'Where are you?';
        s.Card.edit();
        assert.equal(s.Card.iceDirty(), true);
        assert.equal(s.dom.get('wa-ice-save')!.disabled, false);
        assert.equal(s.calls.filter((c) => c.method === 'saveWhatsAppIceBreakers').length, 0, 'typing sends nothing');
    });

    it('saves { prompts } only: trimmed, blanks dropped, no commands; and shows what Meta answers it holds', async () => {
        const s = load();
        await ready(s, [], ['Old']);
        typeInto(s, { 'wa-ice-0': '  How much?  ', 'wa-ice-1': '', 'wa-ice-2': 'Where are you?', 'wa-ice-3': '   ' });
        s.api['saveWhatsAppIceBreakers'] = async (body: Json) => iceAnswer(body.prompts);

        await s.Card.saveIce(null, { preventDefault() {} });

        assert.deepEqual(plain(s.calls.find((c) => c.method === 'saveWhatsAppIceBreakers')?.args[0]), { prompts: ['How much?', 'Where are you?'] });
        assert.deepEqual(plain(s.Card.entry.ice.held), ['How much?', 'Where are you?']);
        assert.deepEqual(plain(s.Card.iceDraft), ['How much?', 'Where are you?', '', ''], 'the fields show what is held');
        assert.equal(s.Card.entry.ice.notice, '');
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.ice.saved') && x.type === 'success'));
        assert.equal(s.Card.busy, null);
    });

    it('clearing every field sends an empty list, not nothing', async () => {
        const s = load();
        await ready(s, [], ['Old']);
        typeInto(s, { 'wa-ice-0': '', 'wa-ice-1': '', 'wa-ice-2': '', 'wa-ice-3': '' });
        s.api['saveWhatsAppIceBreakers'] = async (body: Json) => iceAnswer(body.prompts);
        await s.Card.saveIce(null, { preventDefault() {} });
        assert.deepEqual(plain(s.calls.find((c) => c.method === 'saveWhatsAppIceBreakers')?.args[0]), { prompts: [] });
    });

    it('what is shown after a save is what Meta holds: a different answer is shown, and a warning says it differs', async () => {
        const s = load();
        await ready(s, [], ['Old']);
        typeInto(s, { 'wa-ice-0': 'New one', 'wa-ice-1': '', 'wa-ice-2': '', 'wa-ice-3': '' });
        s.api['saveWhatsAppIceBreakers'] = async () => iceAnswer(['Old', 'New one']);
        await s.Card.saveIce(null, { preventDefault() {} });
        assert.deepEqual(plain(s.Card.entry.ice.held), ['Old', 'New one']);
        assert.deepEqual(plain(s.Card.iceDraft.slice(0, 2)), ['Old', 'New one']);
        assert.equal(s.Card.entry.ice.notice, 'mismatch');
        assert.ok(markupOf(s).includes(s.t('wa.ice.mismatch')));
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.ice.savedDifferent') && x.type === 'warning'));
        assert.ok(!s.toasts.some((x) => x.message === s.t('wa.ice.saved')), 'not claimed as saved as typed');
    });

    it('a write Meta could not be read back is not claimed as confirmed: it says so and offers the read', async () => {
        const s = load();
        await ready(s, [], []);
        typeInto(s, { 'wa-ice-0': 'Hello', 'wa-ice-1': '', 'wa-ice-2': '', 'wa-ice-3': '' });
        s.api['saveWhatsAppIceBreakers'] = async () => iceAnswer(['Hello'], { verified: false, commands: null });
        await s.Card.saveIce(null, { preventDefault() {} });
        assert.equal(s.Card.entry.ice.notice, 'unverified');
        const markup = markupOf(s);
        assert.ok(markup.includes(s.t('wa.ice.unverified')) && markup.includes('data-action="wa:reloadIce"'));
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.ice.savedUnverified') && x.type === 'warning'));
    });

    it('a question that is too long, or has an emoji, is refused before it leaves, names its field, and is not dropped', async () => {
        const cases: Array<[string, string, number]> = [
            ['a'.repeat(81), 'prompt_too_long', 1], ['Love it ❤️', 'prompt_has_emoji', 1], ['😀 hi', 'prompt_has_emoji', 1],
        ];
        for (const [text, code, n] of cases) {
            const s = load();
            await ready(s, [], []);
            typeInto(s, { 'wa-ice-0': text, 'wa-ice-1': '', 'wa-ice-2': '', 'wa-ice-3': '' });
            s.api['saveWhatsAppIceBreakers'] = async () => iceAnswer([]);
            await s.Card.saveIce(null, { preventDefault() {} });
            assert.equal(s.calls.filter((c) => c.method === 'saveWhatsAppIceBreakers').length, 0, code);
            assert.equal(s.Card.errors.ice.code, code);
            assert.equal(s.Card.errors.ice.field, `wa-ice-${n - 1}`);
            assert.equal(s.Card.errors.ice.hint, s.t('wa.ice.row', { n }), 'the hint says which one');
            assert.equal(s.Card.iceDraft[0], text, 'what was typed is kept');
        }
    });

    it('Meta refusing is said in words with Meta\'s own beneath; an unreachable Meta says nothing was changed; the fields keep what was typed', async () => {
        const s = load();
        await ready(s, [], ['Old']);
        typeInto(s, { 'wa-ice-0': 'New', 'wa-ice-1': '', 'wa-ice-2': '', 'wa-ice-3': '' });
        s.api['saveWhatsAppIceBreakers'] = async () => { throw refusal(400, { error: '(#100) Invalid parameter', code: 'ice_breakers_refused' }); };
        await s.Card.saveIce(null, { preventDefault() {} });
        assert.equal(s.Card.errors.ice.message, s.t('wa.err.ice_breakers_refused'));
        assert.equal(s.Card.errors.ice.hint, '(#100) Invalid parameter');
        assert.equal(s.Card.iceDraft[0], 'New');
        assert.deepEqual(plain(s.Card.entry.ice.held), ['Old'], 'what Meta holds is unchanged');

        s.api['saveWhatsAppIceBreakers'] = async () => { throw refusal(502, { error: 'Meta could not be reached — nothing was changed', code: 'meta_unreachable' }); };
        await s.Card.saveIce(null, { preventDefault() {} });
        assert.equal(s.Card.errors.ice.message, s.t('wa.err.meta_unreachable'));
        s.api['saveWhatsAppIceBreakers'] = async () => { throw refusal(502, { error: 'Meta did not confirm', code: 'not_confirmed' }); };
        await s.Card.saveIce(null, { preventDefault() {} });
        assert.equal(s.Card.errors.ice.message, s.t('wa.err.not_confirmed'));
    });

    it('a second press while the first save is out is not a second request, and a member cannot save', async () => {
        const s = load();
        await ready(s, [], []);
        typeInto(s, { 'wa-ice-0': 'Hello', 'wa-ice-1': '', 'wa-ice-2': '', 'wa-ice-3': '' });
        let release: (v: unknown) => void = () => {};
        s.api['saveWhatsAppIceBreakers'] = () => new Promise((r) => { release = r; });
        const pending = s.Card.saveIce(null, { preventDefault() {} });
        await s.Card.saveIce(null, { preventDefault() {} });
        assert.equal(s.calls.filter((c) => c.method === 'saveWhatsAppIceBreakers').length, 1);
        release(iceAnswer(['Hello']));
        await pending;

        const member = load('en', { owner: false });
        await ready(member, [], []);
        typeInto(member, { 'wa-ice-0': 'Hello' });
        member.api['saveWhatsAppIceBreakers'] = async () => iceAnswer(['Hello']);
        await member.Card.saveIce(null, { preventDefault() {} });
        assert.equal(member.calls.filter((c) => c.method === 'saveWhatsAppIceBreakers').length, 0);
    });

    it('when Meta cannot be read the editor is not drawn (an empty one would say "nothing is set"), and Retry takes what Meta holds', async () => {
        const s = load();
        let answer: () => Promise<unknown> = async () => { throw refusal(400, { error: '(#100) no', code: 'ice_breakers_unreadable' }); };
        s.api['getWhatsAppEntryLinks'] = async () => [];
        s.api['getWhatsAppIceBreakers'] = () => answer();
        s.Card.section(view());
        await s.Card.loadEntry();
        const markup = markupOf(s);
        assert.ok(markup.includes(escaped(s.t('wa.err.ice_breakers_unreadable'))) && markup.includes('data-action="wa:reloadIce"'));
        assert.ok(!markup.includes('id="wa-ice-0"') && !markup.includes('wa-ice-save'));

        answer = async () => iceAnswer(['Held at Meta']);
        s.host('wa-ice');
        await s.Card.reloadIce();
        assert.deepEqual(plain(s.Card.iceDraft.slice(0, 1)), ['Held at Meta']);
        assert.equal(s.Card.entry.ice.status, 'ready');
    });
});

// ─── A tenant switch, and the client ─────────────────────────────────────────────────────────────

describe('entry points: a tenant switch, the API client, and the wiring', () => {
    it('an answer to a read begun before a tenant switch is dropped, and nothing of the previous account stays', async () => {
        const s = load();
        let release: (v: unknown) => void = () => {};
        s.api['getWhatsAppEntryLinks'] = () => new Promise((r) => { release = r; });
        s.api['getWhatsAppIceBreakers'] = async () => iceAnswer(['Previous account']);
        s.Card.section(view());
        const pending = s.Card.loadEntry();
        s.Card.resetTenantState();
        release([link({ label: 'Previous account link' })]);
        await pending;
        assert.equal(s.Card.state, null);
        assert.deepEqual(plain(s.Card.entry.links), { status: 'idle', items: [], error: null });
        assert.equal(s.Card.entry.ice.status, 'idle');
        assert.deepEqual(plain(s.Card.iceDraft), []);
        assert.deepEqual(plain(s.Card.linkForm), { label: '', prefill: '' });
        assert.equal(s.Card.errors.linkForm, null);
        assert.equal(s.Card.errors.ice, null);
    });

    it('a number that stops working takes its entry points with it, and asks again when it works again', async () => {
        const s = load();
        await ready(s);
        s.Card.apply(refused(), false);
        assert.equal(s.Card.entry.links.status, 'idle');
        assert.ok(!markupOf(s).includes('id="wa-links"'));
        let reads = 0;
        s.api['getWhatsAppEntryLinks'] = async () => { reads += 1; return []; };
        s.api['getWhatsAppIceBreakers'] = async () => iceAnswer([]);
        s.Card.apply(view(), false);
        await s.Card.loadEntry();
        assert.equal(reads, 1);
    });

    it('the API client sends exactly the contract', async () => {
        const sent: Array<{ url: string; method: string; body: unknown }> = [];
        const ctx: Json = {
            console, t: (k: string) => k,
            localStorage: { getItem: () => 'token', setItem: () => {}, removeItem: () => {} },
            fetch: (url: string, opts: Json) => {
                sent.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
                return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve('{}') });
            },
        };
        vm.createContext(ctx);
        vm.runInContext(readFileSync('dashboard/js/api.js', 'utf8'), ctx, { filename: 'api.js' });
        const API = vm.runInContext('API', ctx) as Json;
        await API.getWhatsAppEntryLinks();
        await API.createWhatsAppEntryLink({ label: 'Poster', prefill: 'Hello' });
        await API.deleteWhatsAppEntryLink('ABC123');
        await API.deleteWhatsAppEntryLink('a/b?c');
        await API.getWhatsAppIceBreakers();
        await API.saveWhatsAppIceBreakers({ prompts: ['One', 'Two'] });
        assert.deepEqual(sent, [
            { url: '/api/whatsapp/entry-links', method: 'GET', body: undefined },
            { url: '/api/whatsapp/entry-links', method: 'POST', body: { label: 'Poster', prefill: 'Hello' } },
            { url: '/api/whatsapp/entry-links/ABC123', method: 'DELETE', body: undefined },
            { url: '/api/whatsapp/entry-links/a%2Fb%3Fc', method: 'DELETE', body: undefined },
            { url: '/api/whatsapp/ice-breakers', method: 'GET', body: undefined },
            { url: '/api/whatsapp/ice-breakers', method: 'PUT', body: { prompts: ['One', 'Two'] } },
        ]);
    });

    it('the client calls routes the server has, with the verbs it has them with', () => {
        const routes = readFileSync('src/routes/whatsapp.ts', 'utf8');
        for (const route of ['get', 'post'] as const) assert.match(routes, new RegExp(`whatsappRouter\\.${route}\\('/entry-links'`));
        assert.match(routes, /whatsappRouter\.delete\('\/entry-links\/:code'/);
        assert.match(routes, /whatsappRouter\.get\('\/ice-breakers'/);
        assert.match(routes, /whatsappRouter\.put\('\/ice-breakers', canAdminister/);
        assert.match(routes, /whatsappRouter\.post\('\/entry-links', canAdminister/);
        assert.match(routes, /whatsappRouter\.delete\('\/entry-links\/:code', canAdminister/);
    });

    it('the card still schedules nothing and stores nothing in the browser, and the Help article names the new labels', () => {
        const source = readFileSync('dashboard/js/pages/whatsapp_card.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!/setTimeout|setInterval|localStorage|sessionStorage|document\.cookie/.test(source));
        const s = load();
        for (const key of ['wa.link.title', 'wa.link.create', 'wa.link.copy', 'wa.link.download', 'wa.ice.title', 'wa.ice.save']) {
            const help = readFileSync('dashboard/js/help-content.js', 'utf8');
            for (const lang of ['ar', 'en'] as const) {
                const l = load(lang);
                assert.ok(help.includes(`**${l.t(key)}**`), `${lang}: the article names «${l.t(key)}»`);
            }
            assert.notEqual(s.t(key), key);
        }
    });
});
