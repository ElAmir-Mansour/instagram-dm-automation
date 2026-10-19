/**
 * The dashboard's half of the WhatsApp agent's connection (docs/specs/001-whatsapp-agent, T025): the Settings card where the owner pastes a
 * WABA id, a phone number id and an access token, sees the number's health and the free-replies meter, chooses who the assistant answers, and
 * decides whether Meta may charge for replies beyond the free ones.
 *
 * Loaded like the other dashboard tests: the REAL shipped files in a `node:vm` context with a fake DOM, so these test what ships. What is
 * pinned, because a screenshot cannot check it:
 *
 *   - THE TOKEN: its input is a password field with no `name` and no `value`; it is emptied the moment Connect is pressed, BEFORE the request
 *     resolves; it is sent once, trimmed, in the body of `connectWhatsApp`; and afterwards it is in no state, markup, toast, console line or
 *     `localStorage` write, whether the connect succeeded, was refused by Meta, or never left because the form was wrong;
 *   - every refusal the routes can make has a sentence in both languages: the test reads `src/routes/whatsapp.ts` and fails when a code
 *     appears there that the card has no words for, and the machine words the server puts in `error` (not `code`) map the same way;
 *   - the three states (not connected, connected, Meta refused the token) and the read-only view of a member who is not the owner;
 *   - nothing is sent without a press: Disconnect asks first, turning paid messages ON asks first (and the switch goes back until the dialog
 *     says yes), Save is off while the editor matches what was saved, and a mode change sends nothing;
 *   - test senders are normalised and checked before they leave, and a bad line is named, never dropped;
 *   - everything Meta or a person supplied is escaped, and both languages draw every state with no raw key;
 *   - the API client sends exactly the contract, and the module is registered and loaded for every member.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = any;

interface Loaded {
    Card: Json;
    Settings: Json;
    UI: Json;
    t: (key: string, params?: Record<string, unknown>) => string;
    api: Record<string, (...args: Json[]) => unknown>;
    calls: Array<{ method: string; args: Json[] }>;
    confirms: Json[];
    toasts: Array<{ message: string; type: unknown }>;
    logs: string[];
    storage: Array<[string, string]>;
    dom: Map<string, Json>;
    host(id: string, over?: Json): Json;
}

function load(lang: 'ar' | 'en' = 'en', opts: { owner?: boolean; withCard?: boolean } = {}): Loaded {
    const owner = opts.owner !== false;
    const withCard = opts.withCard !== false;
    const noop = (): void => {};
    const dom = new Map<string, Json>();
    const api: Record<string, (...args: Json[]) => unknown> = {};
    const calls: Array<{ method: string; args: Json[] }> = [];
    const confirms: Json[] = [];
    const logs: string[] = [];
    const storage: Array<[string, string]> = [];
    const say = (...args: unknown[]): void => { logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
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
        Intl, console: { log: say, warn: say, error: say, info: say, debug: say }, clearTimeout, URLSearchParams,
        localStorage: { getItem: () => null, setItem: (k: string, v: string) => { storage.push([k, v]); }, removeItem: noop },
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
        Admin: { emptyState: (_i: string, title: string) => `<div>${title}</div>`, confirm: noop },
        App: {
            currentTheme: () => 'auto', navigate: noop, session: { tenantId: 't1' }, hashParam: () => '',
            canOperate: () => true, canAdminister: () => owner, isAdmin: () => true,
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    // `withCard: false` is a page whose module never arrived (the script failed to load): Settings must say so, not throw.
    for (const f of [
        'dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js', 'dashboard/js/motion.js',
        ...(withCard ? ['dashboard/js/pages/whatsapp_card.js'] : []), 'dashboard/js/pages/settings.js',
    ]) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const got = vm.runInContext(`({ Card: ${withCard ? 'WhatsAppCard' : 'null'}, Settings: SettingsPage, UI, t })`, ctx);
    const toasts: Array<{ message: string; type: unknown }> = [];
    got.UI.toast = (message: unknown, type: unknown) => { toasts.push({ message: String(message), type }); };
    // The real dialog draws into a modal the fake DOM has no room for; what matters is WHAT it was asked and WHEN the callback runs.
    got.UI.confirm = (o: Json) => { confirms.push(o); };
    const host = (id: string, over: Json = {}): Json => {
        const el: Json = { id, innerHTML: '', textContent: '', value: '', dataset: {}, disabled: false, classList: stub.classList, scrollIntoView: noop, focus: noop, setAttribute: noop, ...over };
        dom.set(id, el);
        return el;
    };
    return { Card: got.Card, Settings: got.Settings, UI: got.UI, t: got.t, api, calls, confirms, toasts, logs, storage, dom, host };
}

const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));
const markupOf = (s: Loaded): string => String(s.Card.body());

/** What `GET /api/whatsapp/connection` answers for a connected number (a Meta test number, as the owner's first connection is). */
const view = (over: Json = {}): Json => ({
    connected: true, status: 'active', phone_number_id: '106540352242922', display_phone_number: '+1 555 025 3483', verified_name: 'Test Number',
    quality_rating: 'GREEN', messaging_limit: 'TIER_250', name_status: 'APPROVED', number_status: 'CONNECTED', is_test_number: true,
    last_error: null, last_refreshed_at: '2026-10-19T09:00:00.000Z', token_expires_at: null,
    mode: 'off', test_senders: [],
    usage: { period: '2026-10', free_used: 0, free_limit: 1000, billable: 0, est_cost_usd: 0, projected_cost_usd: 0 },
    allow_billable: false, free_tier_alert_at: 900,
    go_live: { ready: false, missing: ['not_test_number', 'public_pages', 'provider_allow_list'] },
    ...over,
});

/** What it answers for a tenant that never connected one (or disconnected: `status` is then `revoked`). */
const none = (over: Json = {}): Json => ({
    connected: false, status: null, phone_number_id: null, display_phone_number: null, verified_name: null, quality_rating: null, messaging_limit: null,
    name_status: null, number_status: null, is_test_number: false, last_error: null, last_refreshed_at: null, token_expires_at: null,
    mode: 'off', test_senders: [],
    usage: { period: '2026-10', free_used: 0, free_limit: 1000, billable: 0, est_cost_usd: 0, projected_cost_usd: 0 },
    allow_billable: false, free_tier_alert_at: 900,
    go_live: { ready: false, missing: ['active_connection', 'public_pages', 'provider_allow_list'] },
    ...over,
});

/** Meta refused the stored token: the server answers `connected: false` with `status: 'invalid'` and the reason, and keeps the number's facts. */
const refused = (over: Json = {}): Json => view({ connected: false, status: 'invalid', last_error: 'Error validating access token: Session has expired', ...over });

/** What `API.request` throws for a refusal: the sentence as `message`, the whole body as `body`, and `code` when the body had one. */
function refusal(status: number, body: Json): Error {
    const sentence = typeof body.error === 'string' ? body.error : (typeof body.message === 'string' ? body.message : `HTTP ${status}`);
    const err: Json = new Error(sentence);
    err.status = status;
    err.body = body;
    if (typeof body.code === 'string') err.code = body.code;
    return err;
}

/** The opening tag of the `<button>` with this id, or '' when there is none. */
function buttonById(markup: string, id: string): string {
    for (const m of markup.matchAll(/<button\b[^>]*>/g)) if (m[0].includes(`id="${id}"`)) return m[0];
    return '';
}
/** The opening tag of the element with this id (an input, a textarea, a progress). */
function tagById(markup: string, id: string): string {
    for (const m of markup.matchAll(/<(?:input|textarea|progress|button|label)\b[^>]*>/g)) if (m[0].includes(`id="${id}"`)) return m[0];
    return '';
}
const isDisabled = (tag: string): boolean => /\sdisabled(\s|>|=)/.test(tag);
/** A sentence as the `html` tag writes it into markup: the five characters that could end a text node or an attribute, escaped. */
const escaped = (text: string): string => text.replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
const noRawKey = (markup: string, label: string): void => {
    const hit = markup.match(/\bwa\.[A-Za-z][\w.]*/);
    assert.ok(!hit, `${label}: a raw key is on the screen: ${hit?.[0]}`);
};

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

const TOKEN = 'EAAGm0PX4ZCpsBO0ZBq3SECRETtokenValue1234567890abcdefXYZ';
const WABA = '104576238290555';
const PHONE = '106540352242922';

/** Types the three connect fields into the fake page, the way the owner does, and returns the token's input. */
function typeConnect(s: Loaded, values: { waba?: string; phone?: string; token?: string } = {}): Json {
    s.host('wa-card');
    s.host('wa-waba', { value: values.waba ?? ` ${WABA} ` });
    s.host('wa-phone', { value: values.phone ?? PHONE });
    return s.host('wa-token', { value: values.token ?? ` ${TOKEN} ` });
}

/** Everything the page could hold of the token after a press: the card's own state, what it draws, the toasts, the console, localStorage. */
function assertTokenIsNowhere(s: Loaded, token: string, label: string): void {
    const held = JSON.stringify({ state: s.Card.state, form: s.Card.form, draft: s.Card.draft, errors: s.Card.errors, busy: s.Card.busy });
    assert.ok(!held.includes(token), `${label}: the card's state holds the token`);
    assert.ok(!markupOf(s).includes(token), `${label}: the card draws the token`);
    assert.ok(!s.toasts.some((x) => x.message.includes(token)), `${label}: a toast says the token`);
    assert.ok(!s.logs.some((x) => x.includes(token)), `${label}: the console says the token`);
    assert.ok(!s.storage.some(([k, v]) => k.includes(token) || v.includes(token)), `${label}: localStorage holds the token`);
}

// ─── What the card shows ─────────────────────────────────────────────────────────────────────────

describe('the WhatsApp card: not connected', () => {
    it('explains what to do on Meta\'s side, and gives the owner the three fields and Connect, drawing nothing about an agent yet', () => {
        const s = load();
        const markup = String(s.Card.section(none()));

        assert.ok(markup.includes('id="wa-card"') && markup.includes(s.t('wa.title')));
        assert.ok(markup.includes('The assistant stays off until you switch it on.'), 'the explanation says the agent stays off');
        for (const id of ['wa-waba', 'wa-phone', 'wa-token']) assert.ok(tagById(markup, id), `${id} is on the card`);
        assert.ok(markup.includes(s.t('wa.field.waba')) && markup.includes(s.t('wa.field.phone')) && markup.includes(s.t('wa.field.token')));
        assert.ok(markup.includes('whatsapp_business_messaging') && markup.includes('whatsapp_business_management'), 'the hint names the two permissions');
        assert.equal(isDisabled(buttonById(markup, 'wa-connect-submit')), false);
        assert.ok(markup.includes(s.t('wa.connect.submit')));
        assert.ok(!markup.includes('id="wa-agent"') && !markup.includes('id="wa-billing"'), 'no agent or billing controls without a number');
        assert.equal(s.calls.length, 0, 'drawing the card calls no API');
    });

    it('the token input is a password field with no name and no value; the two ids are numeric text fields, also nameless', () => {
        const s = load();
        const markup = String(s.Card.section(none()));
        const token = tagById(markup, 'wa-token');
        assert.match(token, /\btype="password"/);
        assert.doesNotMatch(token, /\sname=/, 'nothing can serialise it into an address or a native submit');
        assert.doesNotMatch(token, /\svalue=/, 'it is never drawn with a value');
        assert.match(token, /autocomplete="new-password"/);
        assert.match(token, /spellcheck="false"/);
        for (const id of ['wa-waba', 'wa-phone']) {
            const tag = tagById(markup, id);
            assert.match(tag, /\btype="text"/);
            assert.match(tag, /inputmode="numeric"/);
            assert.doesNotMatch(tag, /\sname=/, id);
        }
        // The form carries no method or action either: a script failure must not turn it into a GET to this address.
        const form = /<form id="wa-connect-form"[^>]*>/.exec(markup)?.[0] ?? '';
        assert.ok(form && !/\saction=|\smethod=/.test(form), form);
    });

    it('a member who is not the owner sees why there is no form, and no token field at all', () => {
        const s = load('en', { owner: false });
        const markup = String(s.Card.section(none()));
        assert.ok(markup.includes(s.t('wa.connect.ownerOnly')));
        assert.ok(!markup.includes('wa-token') && !markup.includes('type="password"') && !markup.includes('wa-connect-form'));
    });
});

describe('the WhatsApp card: connected', () => {
    it('shows the number, the verified name, the test-number badge, status / quality / limit and the free-replies meter', () => {
        const s = load();
        const markup = String(s.Card.section(view()));

        assert.ok(markup.includes('Test Number') && markup.includes('+1 555 025 3483'));
        assert.ok(markup.includes(s.t('wa.pill.active')));
        assert.ok(markup.includes(s.t('wa.badge.test')) && markup.includes(s.t('wa.testNumberHint')));
        assert.ok(markup.includes(s.t('wa.chip.status')) && markup.includes(s.t('wa.numberStatus.CONNECTED')));
        assert.ok(markup.includes(s.t('wa.chip.quality')) && markup.includes(s.t('wa.quality.GREEN')));
        assert.ok(markup.includes(s.t('wa.chip.limit')) && markup.includes(s.t('wa.limit.count', { n: '250' })));
        assert.ok(markup.includes('0 / 1,000'), 'the meter says "0 / 1,000"');
        const meter = /<progress\b[^>]*>/.exec(markup)?.[0] ?? '';
        assert.match(meter, /max="1000"/);
        assert.match(meter, /value="0"/);
        assert.ok(markup.includes('$0.00'), 'the estimated cost');
        assert.ok(!markup.includes('id="wa-connect-form"'), 'a working connection offers no token form');
        assert.ok(buttonById(markup, 'wa-refresh') && buttonById(markup, 'wa-disconnect'), 'Refresh and Disconnect');
        assert.equal(s.calls.length, 0);
    });

    it('draws the meter from the numbers the server sent, warns near the alert threshold, and names paid replies', () => {
        const s = load();
        const markup = String(s.Card.section(view({
            usage: { period: '2026-10', free_used: 950, free_limit: 1000, billable: 12, est_cost_usd: 0.0432, projected_cost_usd: 0.5 },
        })));
        assert.ok(markup.includes('950 / 1,000'));
        assert.match(/<progress\b[^>]*>/.exec(markup)?.[0] ?? '', /value="950"/);
        assert.ok(markup.includes(s.t('wa.usage.near')));
        assert.ok(markup.includes('$0.04') && markup.includes('$0.50'));
        assert.ok(markup.includes(s.t('wa.usage.billable')));
        // Over the limit the bar is full, not overflowing.
        const over = String(s.Card.section(view({ usage: { period: '2026-10', free_used: 1500, free_limit: 1000, billable: 500, est_cost_usd: 1, projected_cost_usd: 1 } })));
        assert.match(/<progress\b[^>]*>/.exec(over)?.[0] ?? '', /value="1000"/);
    });

    it('says the meter is unavailable instead of showing zeros, when the server says it is (or sends none)', () => {
        const s = load();
        for (const usage of [{ period: '2026-10', free_used: 0, free_limit: 1000, billable: 0, est_cost_usd: 0, projected_cost_usd: 0, unavailable: true }, undefined]) {
            const markup = String(s.Card.section(view({ usage })));
            assert.ok(markup.includes(s.t('wa.usage.unavailable')));
            assert.ok(!/<progress\b/.test(markup), 'no meter to mislead');
        }
    });

    it('draws a limit tier, a top tier and an unknown tier; the name review only when it is not fine; and words it does not know as written', () => {
        const s = load();
        assert.ok(String(s.Card.section(view({ messaging_limit: 'TIER_1K' }))).includes(s.t('wa.limit.count', { n: '1,000' })));
        assert.ok(String(s.Card.section(view({ messaging_limit: 'TIER_100K' }))).includes(s.t('wa.limit.count', { n: '100,000' })));
        assert.ok(String(s.Card.section(view({ messaging_limit: 'TIER_UNLIMITED' }))).includes(s.t('wa.limit.top')));
        assert.ok(String(s.Card.section(view({ messaging_limit: 'TIER_SOMETHING' }))).includes('TIER_SOMETHING'));
        assert.ok(!String(s.Card.section(view({ name_status: 'APPROVED' }))).includes(s.t('wa.chip.name')), 'an approved name needs no badge');
        const declined = String(s.Card.section(view({ name_status: 'DECLINED' })));
        assert.ok(declined.includes(s.t('wa.chip.name')) && declined.includes(s.t('wa.nameStatus.DECLINED')));
        const odd = String(s.Card.section(view({ quality_rating: 'PURPLE', number_status: 'ON_FIRE' })));
        assert.ok(odd.includes('PURPLE') && odd.includes('ON_FIRE'), 'a word Meta adds later is shown as written, not hidden');
        for (const word of ['PURPLE', 'ON_FIRE']) {
            const chip = odd.split('<span class="badge ').find((part) => part.includes(word)) ?? '';
            assert.ok(chip.startsWith('badge-neutral'), `${word} is drawn neutral, never as good news`);
        }
    });

    it('a tone is a shape as well as a colour: every badge carries a glyph', () => {
        const s = load();
        const markup = String(s.Card.section(view({ quality_rating: 'GREEN', number_status: 'FLAGGED', name_status: 'DECLINED' })));
        assert.match(markup, /badge badge-danger"><span aria-hidden="true">✕<\/span>/);
        assert.match(markup, /badge badge-warning"><span aria-hidden="true">▲<\/span>/);
        assert.match(markup, /badge badge-success"><span aria-hidden="true">●<\/span>/);
        assert.match(markup, /badge badge-neutral"><span aria-hidden="true">○<\/span>/);
    });

    it('Everyone is drawn disabled with the reason and what is missing; Test senders and Off are choosable; a ready gate enables it', () => {
        const s = load();
        const markup = String(s.Card.section(view()));
        assert.ok(isDisabled(tagById(markup, 'wa-mode-everyone')), 'Everyone is disabled');
        assert.ok(!isDisabled(tagById(markup, 'wa-mode-off')) && !isDisabled(tagById(markup, 'wa-mode-test')));
        assert.ok(markup.includes(s.t('wa.mode.everyoneHint')), 'the reason');
        assert.ok(markup.includes(s.t('wa.golive.public_pages')), 'and what the gate still needs');
        assert.match(tagById(markup, 'wa-mode-off'), /\schecked/);

        const open = String(s.Card.section(view({ go_live: { ready: true, missing: [] } })));
        assert.equal(isDisabled(tagById(open, 'wa-mode-everyone')), false);
        const live = String(s.Card.section(view({ mode: 'everyone', go_live: { ready: false, missing: ['public_pages'] } })));
        assert.equal(isDisabled(tagById(live, 'wa-mode-everyone')), false, 'a mode the server already holds is not disabled');
        assert.match(tagById(live, 'wa-mode-everyone'), /\schecked/);
    });

    it('shows the saved test senders one per line, and the paid-messages switch off by default and on when the server says so', () => {
        const s = load();
        const markup = String(s.Card.section(view({ mode: 'test', test_senders: ['201001234567', 'EG.13491208655302741918'] })));
        assert.ok(markup.includes('201001234567\nEG.13491208655302741918</textarea>'));
        assert.match(tagById(markup, 'wa-mode-test'), /\schecked/);
        assert.doesNotMatch(tagById(markup, 'wa-billing-toggle'), /\schecked/);
        assert.match(tagById(String(s.Card.section(view({ allow_billable: true }))), 'wa-billing-toggle'), /\schecked/);
        assert.ok(markup.includes('0.0036') && markup.includes('0.0107'), 'the one-line cost explanation names both rates');
    });

    it('test mode with no senders says the assistant will answer no one', () => {
        const s = load();
        assert.ok(String(s.Card.section(view({ mode: 'test', test_senders: [] }))).includes(s.t('wa.senders.none')));
        assert.ok(!String(s.Card.section(view({ mode: 'off', test_senders: [] }))).includes(s.t('wa.senders.none')));
    });
});

describe('the WhatsApp card: Meta refused the stored token', () => {
    it('says so with Meta\'s words, offers the connect form again as Reconnect, and shows no meter for a number that cannot send', () => {
        const s = load();
        const markup = String(s.Card.section(refused()));
        assert.ok(markup.includes(s.t('wa.pill.invalid')) && markup.includes(s.t('wa.invalidNote')));
        assert.ok(markup.includes('Session has expired'), 'the reason Meta gave');
        assert.ok(tagById(markup, 'wa-token') && markup.includes(s.t('wa.reconnect.submit')) && markup.includes(s.t('wa.reconnect.title')));
        assert.ok(!markup.includes('id="wa-usage"'));
        assert.equal(s.Card.live(), true);
        assert.equal(s.Card.needsReconnect(), true);
        assert.ok(buttonById(markup, 'wa-refresh') && buttonById(markup, 'wa-disconnect'), 'the owner can still refresh or disconnect');
    });

    it('a disconnected tenant (status revoked) is just "not connected"', () => {
        const s = load();
        const markup = String(s.Card.section(none({ status: 'revoked', mode: 'off' })));
        assert.equal(s.Card.live(), false);
        assert.ok(markup.includes(s.t('wa.connect.title')) && !markup.includes('id="wa-agent"'));
    });
});

describe('the WhatsApp card: a member who is not the owner reads, and cannot change anything', () => {
    it('draws the state with no Refresh, Disconnect or Save, and every control disabled or read only', () => {
        const s = load('en', { owner: false });
        const markup = String(s.Card.section(view({ mode: 'test', test_senders: ['201001234567'] })));

        assert.ok(markup.includes('Test Number') && markup.includes('0 / 1,000'));
        for (const id of ['wa-refresh', 'wa-disconnect', 'wa-agent-save']) assert.equal(buttonById(markup, id), '', id);
        for (const id of ['wa-mode-off', 'wa-mode-test', 'wa-mode-everyone', 'wa-billing-toggle']) assert.ok(isDisabled(tagById(markup, id)), id);
        assert.match(tagById(markup, 'wa-senders'), /\sreadonly/);
        assert.ok(markup.includes(s.t('wa.ownerOnly')));
    });

    it('and the handlers do nothing for them, even if called', async () => {
        const s = load('en', { owner: false });
        s.Card.section(view());
        // Even with a complete, valid form in the page, and an API that would take it.
        const tokenInput = typeConnect(s);
        // Every write is stubbed so a call that got through would be RECORDED (the harness only records calls to stubbed methods).
        for (const method of ['connectWhatsApp', 'refreshWhatsApp', 'saveWhatsAppAgent', 'saveWhatsAppBilling', 'disconnectWhatsApp']) s.api[method] = async () => view();
        await s.Card.refresh();
        await s.Card.saveAgent(null, { preventDefault() {} });
        await s.Card.connect(null, { preventDefault() {} });
        await s.Card.billing({ checked: true });
        s.Card.askDisconnect();
        assert.equal(s.calls.length, 0);
        assert.equal(s.confirms.length, 0);
        assert.equal(tokenInput.value.trim(), TOKEN, 'and a form they somehow filled is left alone');
    });
});

describe('the WhatsApp card: both languages, escaping', () => {
    it('both languages draw every state with no raw key in it, with Meta words it has no translation for', () => {
        for (const lang of ['ar', 'en'] as const) {
            const s = load(lang);
            const states: Array<[string, Json]> = [
                ['not connected', none()], ['connected', view({ mode: 'test', test_senders: ['201001234567'], allow_billable: true })],
                ['refused', refused()], ['odd words', view({ quality_rating: 'PURPLE', number_status: 'ON_FIRE', messaging_limit: 'TIER_X', name_status: 'DECLINED' })],
                ['unavailable', view({ usage: undefined })],
            ];
            for (const [label, state] of states) {
                s.Card.section(state);
                noRawKey(markupOf(s), `${lang} / ${label}`);
            }
            s.Card.section(view());
            s.Card.errors = { connect: null, agent: s.Card.describe({ code: 'go_live_not_ready', body: { error: 'go_live_not_ready', missing: ['public_pages', 'provider_allow_list'] } }), billing: null, header: null };
            noRawKey(markupOf(s), `${lang} / an agent error`);
            assert.ok(markupOf(s).includes(s.t('wa.agent.title')) && markupOf(s).includes(s.t('wa.billing.title')));
        }
    });

    it('the Arabic card is Arabic: the headings and the cost line are in the Arabic dictionary, not the English fallback', () => {
        const s = load('ar');
        const markup = String(s.Card.section(view()));
        for (const key of ['wa.title', 'wa.agent.title', 'wa.billing.title', 'wa.usage.title', 'wa.mode.off', 'wa.disconnect']) {
            assert.ok(/[؀-ۿ]/.test(s.t(key)), `${key} is Arabic`);
            assert.ok(markup.includes(s.t(key)), key);
        }
    });

    it('everything Meta or a person supplied is text: the name, the number, the words Meta reports, the reason, a sender', () => {
        const s = load();
        const HOSTILE = '"><img src=x onerror=alert(1)>';
        const ATTR = '" autofocus onfocus="alert(document.cookie)';
        const SCRIPT = '</textarea></div><script>alert(1)</script>';
        const cases: Json[] = [
            refused({ verified_name: HOSTILE, display_phone_number: ATTR, last_error: SCRIPT, quality_rating: HOSTILE, number_status: ATTR, messaging_limit: SCRIPT, name_status: HOSTILE }),
            view({ verified_name: SCRIPT, display_phone_number: HOSTILE, mode: 'test', test_senders: [HOSTILE, ATTR, SCRIPT], quality_rating: ATTR }),
        ];
        for (const state of cases) {
            s.Card.section(state);
            s.Card.form = { waba: HOSTILE, phone: ATTR };
            const markup = markupOf(s);
            assert.ok(!/<img\b/i.test(markup), 'a raw <img>');
            assert.ok(!/<script\b/i.test(markup), 'a raw <script>');
            for (const tag of tags(markup)) {
                for (const attr of tag.attrs) assert.ok(!/^on/i.test(attr) && attr !== 'autofocus', `<${tag.name}> grew an ${attr} attribute out of a value`);
            }
        }
        s.Card.errors.header = s.Card.describe(Object.assign(new Error('x'), { body: { code: 'meta_refused', error: HOSTILE } }));
        const strip = markupOf(s);
        assert.ok(strip.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'), 'Meta\'s own words are shown, as text');
        assert.ok(!/<img\b/i.test(strip));
    });
});

// ─── The token ───────────────────────────────────────────────────────────────────────────────────

describe('the WhatsApp card: Connect and the access token', () => {
    it('sends exactly { waba_id, phone_number_id, access_token }, trimmed; the token field is EMPTY before the request resolves', async () => {
        const s = load();
        s.Card.section(none());
        const tokenInput = typeConnect(s);
        let sent: Json = null;
        let release: (v: unknown) => void = () => {};
        s.api['connectWhatsApp'] = (body: Json) => { sent = body; return new Promise((r) => { release = r; }); };

        const pending = s.Card.connect(null, { preventDefault() {} });

        // The request is out and has not been answered.
        assert.deepEqual(plain(sent), { waba_id: WABA, phone_number_id: PHONE, access_token: TOKEN });
        assert.equal(tokenInput.value, '', 'the field was emptied before the answer, so the page does not hold the token while Meta is asked');
        assert.equal(s.Card.busy, 'connect');
        assertTokenIsNowhere(s, TOKEN, 'while in flight');
        assert.equal(isDisabled(buttonById(markupOf(s), 'wa-connect-submit')), true, 'a second press is not a second request');

        release(view());
        await pending;
        assert.equal(s.calls.filter((c) => c.method === 'connectWhatsApp').length, 1);
        assert.equal(tokenInput.value, '');
        assert.equal(s.Card.live(), true);
        assert.deepEqual(plain(s.Card.form), { waba: '', phone: '' }, 'the typed ids are gone too');
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.connected.toast') && x.type === 'success'));
        assert.ok(markupOf(s).includes('Test Number'), 'the card now shows the number');
        assertTokenIsNowhere(s, TOKEN, 'after a connect');
    });

    it('a refusal leaves the token field empty, the typed ids in place, the reason beside the field Meta refused, and the token nowhere', async () => {
        const s = load();
        s.Card.section(none());
        const tokenInput = typeConnect(s);
        const marks: Array<[string, string]> = [];
        tokenInput.setAttribute = (k: string, v: string) => { marks.push([k, v]); };
        s.api['connectWhatsApp'] = async () => { throw refusal(400, { error: `Error validating access token for ${TOKEN.slice(0, 3)}…`, code: 'token_refused' }); };

        await s.Card.connect(null, { preventDefault() {} });

        assert.equal(tokenInput.value, '');
        assert.equal(s.Card.errors.connect.message, s.t('wa.err.token_refused'));
        assert.equal(s.Card.errors.connect.field, 'wa-token');
        assert.deepEqual(marks.find(([k]) => k === 'aria-invalid'), ['aria-invalid', 'true'], 'the field is marked invalid');
        assert.equal(s.Card.busy, null);
        assert.deepEqual(plain(s.Card.form), { waba: WABA, phone: PHONE }, 'the ids survive a refusal');
        const markup = markupOf(s);
        assert.ok(markup.includes(s.t('wa.err.token_refused')), 'the sentence');
        assert.ok(markup.includes('Error validating access token'), 'Meta\'s words as the reason');
        assert.ok(markup.includes(`value="${WABA}"`) && markup.includes(`value="${PHONE}"`));
        assert.doesNotMatch(tagById(markup, 'wa-token'), /\svalue=/);
        assertTokenIsNowhere(s, TOKEN, 'after a refusal');
    });

    it('a form that is wrong never sends anything, and leaves the token in the field for the owner to keep editing', async () => {
        const wrong: Array<[Json, string, string]> = [
            [{ waba: 'abc' }, 'invalid_waba_id', 'wa-waba'],
            [{ waba: '1234' }, 'invalid_waba_id', 'wa-waba'],
            [{ phone: '12 34 56' }, 'invalid_phone_number_id', 'wa-phone'],
            [{ token: 'short' }, 'invalid_access_token', 'wa-token'],
            [{ token: 'has a space inside it xxxxxxxxxxxxxxxxxxxxxxx' }, 'invalid_access_token', 'wa-token'],
            [{ token: '' }, 'invalid_access_token', 'wa-token'],
        ];
        for (const [values, code, field] of wrong) {
            const s = load();
            s.Card.section(none());
            const tokenInput = typeConnect(s, values);
            const typed = tokenInput.value;
            await s.Card.connect(null, { preventDefault() {} });
            assert.equal(s.calls.length, 0, `${JSON.stringify(values)}: nothing was sent`);
            assert.equal(s.Card.errors.connect.message, s.t(`wa.err.${code}`));
            assert.equal(s.Card.errors.connect.field, field);
            assert.equal(tokenInput.value, typed.trim(), 'the token is still in its field: it never left');
            assert.ok(!markupOf(s).includes(TOKEN), 'and the card never draws it');
        }
    });

    it('every code the connect route can answer is shown as its own sentence, in both languages, and the token ends up nowhere', async () => {
        const answers: Array<[number, string]> = [
            [400, 'invalid_waba_id'], [400, 'invalid_phone_number_id'], [400, 'invalid_access_token'], [400, 'token_refused'], [400, 'missing_scopes'],
            [400, 'number_unreadable'], [400, 'subscribe_failed'], [409, 'number_in_use'], [502, 'meta_unreachable'],
        ];
        for (const lang of ['ar', 'en'] as const) {
            for (const [status, code] of answers) {
                const s = load(lang);
                s.Card.section(none());
                typeConnect(s);
                s.api['connectWhatsApp'] = async () => { throw refusal(status, { error: `Meta says no (${code})`, code }); };
                await s.Card.connect(null, { preventDefault() {} });
                assert.equal(s.Card.errors.connect.message, s.t(`wa.err.${code}`), `${lang}/${code}`);
                assert.notEqual(s.Card.errors.connect.message, `wa.err.${code}`, `${lang}/${code}: not a raw key`);
                assert.ok(markupOf(s).includes(escaped(s.Card.errors.connect.message)));
                assertTokenIsNowhere(s, TOKEN, `${lang}/${code}`);
            }
        }
    });

    it('a network failure shows its own message and holds nothing', async () => {
        const s = load();
        s.Card.section(none());
        typeConnect(s);
        s.api['connectWhatsApp'] = async () => { throw Object.assign(new Error('The network is down.'), { isNetworkError: true }); };
        await s.Card.connect(null, { preventDefault() {} });
        assert.equal(s.Card.errors.connect.message, 'The network is down.');
        assertTokenIsNowhere(s, TOKEN, 'a network failure');
    });
});

// ─── The words ───────────────────────────────────────────────────────────────────────────────────

describe('the WhatsApp card: every refusal the routes make has words', () => {
    const route = readFileSync('src/routes/whatsapp.ts', 'utf8');
    const literals = [...new Set([...route.matchAll(/'([a-z][a-z0-9]*(?:_[a-z0-9]+)+)'/g)].map((m) => m[1]!))];

    it('the route file still has the codes this test was written against (so it cannot pass by reading nothing)', () => {
        assert.ok(literals.length >= 20, `${literals.length} machine words in the route file`);
        for (const code of ['token_refused', 'missing_scopes', 'number_in_use', 'go_live_not_ready', 'agent_not_configured', 'active_connection']) {
            assert.ok(literals.includes(code), code);
        }
    });

    it('each is either a go-live item or a code with a sentence in both dictionaries and a place in the card\'s table', () => {
        for (const lang of ['ar', 'en'] as const) {
            const s = load(lang);
            for (const word of literals) {
                if (s.Card.GO_LIVE_ITEMS.includes(word)) {
                    assert.notEqual(s.t(`wa.golive.${word}`), `wa.golive.${word}`, `${lang}: go-live item ${word} has no phrase`);
                    continue;
                }
                assert.ok(Object.prototype.hasOwnProperty.call(s.Card.ERRORS, word), `the route sends "${word}" and the card does not know it`);
                const key = `wa.err.${word}`;
                assert.notEqual(s.t(key), key, `${lang}: ${word} has no sentence`);
                assert.equal(s.Card.describe({ code: word }).message, s.t(key));
            }
        }
    });

    it('the card knows no code the routes do not send, except the one it makes up for a pending migration', () => {
        const s = load();
        const known = Object.keys(s.Card.ERRORS).filter((k) => !literals.includes(k));
        assert.deepEqual(known, ['migration_pending']);
    });

    it('the machine words the server puts in `error` (not `code`) are read as codes: go_live_not_ready with its list, agent_not_configured, not_connected', () => {
        const s = load();
        const gate = s.Card.describe(refusal(409, { error: 'go_live_not_ready', missing: ['public_pages', 'provider_allow_list', 'something_new'] }));
        assert.equal(gate.code, 'go_live_not_ready');
        assert.equal(gate.message, s.t('wa.err.go_live_not_ready'));
        assert.ok(gate.hint.includes(s.t('wa.golive.public_pages')) && gate.hint.includes(s.t('wa.golive.provider_allow_list')));
        assert.ok(gate.hint.includes('something_new'), 'an item the dashboard has no phrase for is shown as the server named it');

        const agent = s.Card.describe(refusal(409, { error: 'agent_not_configured', message: 'This account has no AI agent yet.' }));
        assert.equal(agent.message, s.t('wa.err.agent_not_configured'));
        const billing = s.Card.describe(refusal(409, { error: 'not_connected', message: 'WhatsApp is not connected — connect a number first.' }));
        assert.equal(billing.message, s.t('wa.err.not_connected'));
    });

    it('Meta\'s own words are the reason beneath the sentence for the refusals that come from Meta, and for no other', () => {
        const s = load();
        const meta = s.Card.describe(refusal(400, { error: 'Error validating access token: Session has expired', code: 'token_refused' }));
        assert.equal(meta.hint, 'Error validating access token: Session has expired');
        assert.equal(s.Card.describe(refusal(400, { error: 'waba_id must be digits', code: 'invalid_waba_id' })).hint, '');
        assert.equal(s.Card.describe(refusal(502, { error: 'Meta could not be reached', code: 'meta_unreachable' })).hint, '');
        // A bare machine word is not a sentence to show.
        assert.equal(s.Card.describe(refusal(409, { error: 'go_live_not_ready' })).hint, '');
    });

    it('a pending migration (503) is told in the owner\'s language, not as the server\'s English paragraph', () => {
        const s = load();
        const err = refusal(503, { error: 'The database is missing migration v50 …', migrationPending: true });
        assert.equal(s.Card.describe(err).message, s.t('wa.err.migration_pending'));
    });

    it('anything else shows the error\'s own message or the generic one, never a raw key, "undefined", or a lookup that hits the prototype', () => {
        const s = load();
        assert.equal(s.Card.describe(new Error('plain')).message, 'plain');
        assert.equal(s.Card.describe(null).message, s.t('common.error'));
        assert.equal(s.Card.describe({}).message, s.t('common.error'));
        for (const code of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            const out = s.Card.describe(refusal(400, { error: 'odd', code }));
            assert.equal(out.message, 'odd', code);
            assert.equal(out.code, '', code);
        }
        assert.equal(s.Card.describe(refusal(400, { error: 'something_unheard_of' })).message, 'something_unheard_of', 'an unknown word falls back to what the server said');
    });
});

// ─── The agent ───────────────────────────────────────────────────────────────────────────────────

describe('the WhatsApp card: the agent\'s mode and test senders', () => {
    it('Save is off while the editor matches what was saved, on after a change, and a mode change sends nothing', () => {
        const s = load();
        s.Card.section(view());
        s.host('wa-card');
        s.host('wa-senders', { value: '' });
        assert.equal(isDisabled(buttonById(markupOf(s), 'wa-agent-save')), true);
        assert.equal(s.Card.agentDirty(), false);

        s.Card.mode({ value: 'test' });
        assert.equal(s.Card.draft.mode, 'test');
        assert.equal(s.Card.agentDirty(), true);
        assert.equal(isDisabled(buttonById(markupOf(s), 'wa-agent-save')), false);
        assert.equal(s.calls.length, 0, 'choosing sends nothing');

        s.Card.mode({ value: 'nonsense' });
        assert.equal(s.Card.draft.mode, 'test', 'a value that is not a mode is ignored');
    });

    it('saves { mode, test_senders } with the senders normalised: a written phone number to digits, ids kept, duplicates dropped, blank lines ignored', async () => {
        const s = load();
        s.Card.section(view());
        s.host('wa-card');
        s.host('wa-senders', { value: '+20 100 123 4567\n\nEG.13491208655302741918, 966501234567;\n(201) 001-234567\n201001234567' });
        s.Card.mode({ value: 'test' });
        s.api['saveWhatsAppAgent'] = async (body: Json) => view({ mode: body.mode, test_senders: body.test_senders });

        await s.Card.saveAgent(null, { preventDefault() {} });

        assert.deepEqual(plain(s.calls.find((c) => c.method === 'saveWhatsAppAgent')?.args[0]), {
            mode: 'test', test_senders: ['201001234567', 'EG.13491208655302741918', '966501234567'],
        });
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.agent.saved') && x.type === 'success'));
        assert.equal(s.Card.state.mode, 'test');
        assert.equal(s.Card.draft.senders, '201001234567\nEG.13491208655302741918\n966501234567', 'the editor shows what the server holds');
        assert.equal(s.Card.agentDirty(), false);
    });

    it('a line that is neither a phone number nor a WhatsApp id is named, nothing is sent, and the typo is not quietly dropped', async () => {
        for (const bad of ['0100 123 4567', '12345', 'eg.123', 'EG.', 'hello', '+', '20100123456789012345', 'EG.12-34']) {
            const s = load();
            s.Card.section(view());
            s.host('wa-card');
            s.host('wa-senders', { value: `201001234567\n${bad}` });
            s.Card.mode({ value: 'test' });
            await s.Card.saveAgent(null, { preventDefault() {} });
            assert.equal(s.calls.length, 0, `${JSON.stringify(bad)}: nothing was sent`);
            assert.equal(s.Card.errors.agent.message, s.t('wa.err.invalid_test_senders'));
            assert.equal(s.Card.errors.agent.hint, bad.slice(0, 40), 'the offending line is named');
            assert.equal(s.Card.errors.agent.field, 'wa-senders');
            assert.ok(markupOf(s).includes(escaped(s.t('wa.err.invalid_test_senders'))));
        }
    });

    it('more than 20 senders is refused before it is sent, with the limit', async () => {
        const s = load();
        s.Card.section(view());
        s.host('wa-card');
        s.host('wa-senders', { value: Array.from({ length: 21 }, (_, i) => `2010012345${String(i).padStart(2, '0')}`).join('\n') });
        s.Card.mode({ value: 'test' });
        await s.Card.saveAgent(null, { preventDefault() {} });
        assert.equal(s.calls.length, 0);
        assert.equal(s.Card.errors.agent.message, s.t('wa.val.tooMany', { max: 20 }));
    });

    it('an empty list clears the senders: it is sent as [], not left out', async () => {
        const s = load();
        s.Card.section(view({ mode: 'test', test_senders: ['201001234567'] }));
        s.host('wa-card');
        s.host('wa-senders', { value: '  \n ' });
        s.api['saveWhatsAppAgent'] = async (body: Json) => view({ mode: body.mode, test_senders: body.test_senders });
        await s.Card.saveAgent(null, { preventDefault() {} });
        assert.deepEqual(plain(s.calls[0]!.args[0]), { mode: 'test', test_senders: [] });
    });

    it('the server refusing Everyone, or an account with no agent yet, is said in words and keeps what was typed', async () => {
        const s = load();
        s.Card.section(view());
        s.host('wa-card');
        s.host('wa-senders', { value: '201001234567' });
        s.Card.mode({ value: 'test' });
        s.api['saveWhatsAppAgent'] = async () => { throw refusal(409, { error: 'agent_not_configured', message: 'This account has no AI agent yet' }); };
        await s.Card.saveAgent(null, { preventDefault() {} });
        assert.equal(s.Card.errors.agent.message, s.t('wa.err.agent_not_configured'));
        assert.equal(s.Card.draft.mode, 'test');
        assert.equal(s.Card.draft.senders, '201001234567', 'the editor keeps what was typed');
        assert.equal(s.Card.state.mode, 'off', 'and the card still shows what the server holds');

        s.api['saveWhatsAppAgent'] = async () => { throw refusal(409, { error: 'go_live_not_ready', missing: ['public_pages'] }); };
        await s.Card.saveAgent(null, { preventDefault() {} });
        assert.equal(s.Card.errors.agent.message, s.t('wa.err.go_live_not_ready'));
        assert.ok(s.Card.errors.agent.hint.includes(s.t('wa.golive.public_pages')));
    });

    it('a second press while the first save is out is not a second request', async () => {
        const s = load();
        s.Card.section(view());
        s.host('wa-card');
        s.host('wa-senders', { value: '201001234567' });
        s.Card.mode({ value: 'test' });
        let release: (v: unknown) => void = () => {};
        s.api['saveWhatsAppAgent'] = () => new Promise((r) => { release = r; });
        const pending = s.Card.saveAgent(null, { preventDefault() {} });
        await s.Card.saveAgent(null, { preventDefault() {} });
        assert.equal(s.calls.filter((c) => c.method === 'saveWhatsAppAgent').length, 1);
        release(view({ mode: 'test', test_senders: ['201001234567'] }));
        await pending;
        assert.equal(s.Card.busy, null);
    });
});

// ─── Billing ─────────────────────────────────────────────────────────────────────────────────────

describe('the WhatsApp card: paid messages', () => {
    it('turning it ON asks first, puts the switch back until the dialog says yes, and sends only { allow_billable: true } on confirm', async () => {
        const s = load();
        s.Card.section(view());
        s.host('wa-card');
        s.api['saveWhatsAppBilling'] = async (body: Json) => view({ allow_billable: body.allow_billable });
        const toggle: Json = { checked: true };

        await s.Card.billing(toggle);

        assert.equal(toggle.checked, false, 'the switch goes back to off while the owner is asked');
        assert.equal(s.confirms.length, 1);
        assert.equal(s.calls.length, 0, 'a press alone sends nothing');
        assert.equal(s.confirms[0].title, s.t('wa.billing.confirm.title'));
        assert.ok(String(s.confirms[0].body).includes('0.0036') && String(s.confirms[0].body).includes('0.0107'), 'the dialog says what it costs');
        assert.equal(s.confirms[0].tone, 'primary');

        await s.confirms[0].onConfirm();
        assert.deepEqual(s.calls.map((c) => [c.method, plain(c.args[0])]), [['saveWhatsAppBilling', { allow_billable: true }]]);
        assert.equal(s.Card.state.allow_billable, true);
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.billing.on')));
        assert.match(tagById(markupOf(s), 'wa-billing-toggle'), /\schecked/);
    });

    it('a refusal inside the dialog is said there, in the owner\'s language, and the state does not change', async () => {
        const s = load();
        s.Card.section(view());
        s.host('wa-card');
        s.api['saveWhatsAppBilling'] = async () => { throw refusal(409, { error: 'not_connected', message: 'WhatsApp is not connected — connect a number first.' }); };
        await s.Card.billing({ checked: true });
        await assert.rejects(Promise.resolve(s.confirms[0].onConfirm()), (e: Error) => e.message === s.t('wa.err.not_connected'));
        assert.equal(s.Card.state.allow_billable, false);
        assert.equal(s.Card.busy, null);
    });

    it('turning it OFF is applied at once, with no question, and a refusal is shown on the card', async () => {
        const s = load();
        s.Card.section(view({ allow_billable: true }));
        s.host('wa-card');
        s.api['saveWhatsAppBilling'] = async (body: Json) => view({ allow_billable: body.allow_billable });
        await s.Card.billing({ checked: false });
        assert.equal(s.confirms.length, 0);
        assert.deepEqual(plain(s.calls[0]!.args[0]), { allow_billable: false });
        assert.equal(s.Card.state.allow_billable, false);

        s.Card.section(view({ allow_billable: true }));
        s.api['saveWhatsAppBilling'] = async () => { throw refusal(502, { error: 'Meta could not be reached', code: 'meta_unreachable' }); };
        await s.Card.billing({ checked: false });
        assert.equal(s.Card.errors.billing.message, s.t('wa.err.meta_unreachable'));
        assert.equal(s.Card.state.allow_billable, true, 'the card still shows what the server holds');
    });

    it('does not claim the switch is on while the request to turn it off is out (it does not flicker back)', async () => {
        const s = load();
        s.Card.section(view({ allow_billable: true }));
        s.host('wa-card');
        let release: (v: unknown) => void = () => {};
        s.api['saveWhatsAppBilling'] = () => new Promise((r) => { release = r; });
        const pending = s.Card.billing({ checked: false });
        assert.equal(s.Card.busy, 'billing');
        assert.doesNotMatch(tagById(markupOf(s), 'wa-billing-toggle'), /\schecked/);
        assert.equal(isDisabled(tagById(markupOf(s), 'wa-billing-toggle')), true);
        release(view({ allow_billable: false }));
        await pending;
    });
});

// ─── Refresh and disconnect ──────────────────────────────────────────────────────────────────────

describe('the WhatsApp card: Refresh and Disconnect', () => {
    it('Refresh re-reads from Meta and shows the new health; a token Meta still refuses is a warning, not a success', async () => {
        const s = load();
        s.Card.section(view());
        s.host('wa-card');
        s.api['refreshWhatsApp'] = async () => view({ quality_rating: 'RED' });
        await s.Card.refresh();
        assert.deepEqual(s.calls.map((c) => c.method), ['refreshWhatsApp']);
        assert.ok(markupOf(s).includes(s.t('wa.quality.RED')));
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.refreshed') && x.type === 'success'));

        s.api['refreshWhatsApp'] = async () => refused();
        await s.Card.refresh();
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.refreshStillInvalid') && x.type === 'warning'));
        assert.equal(s.Card.needsReconnect(), true);
    });

    it('a Refresh that fails leaves the card as it was and says why, in words, with Meta\'s as the reason', async () => {
        const s = load();
        s.Card.section(view());
        s.host('wa-card');
        s.api['refreshWhatsApp'] = async () => { throw refusal(502, { error: '(#100) Tried accessing nonexisting field', code: 'meta_refused' }); };
        await s.Card.refresh();
        assert.equal(s.Card.errors.header.message, s.t('wa.err.meta_refused'));
        assert.equal(s.Card.errors.header.hint, '(#100) Tried accessing nonexisting field');
        assert.equal(s.Card.state.quality_rating, 'GREEN');
        assert.ok(markupOf(s).includes('Tried accessing nonexisting field'));
    });

    it('Disconnect asks first, says what it does, and calls the API only when the dialog\'s own confirm runs', async () => {
        const s = load();
        s.Card.section(view({ mode: 'test', test_senders: ['201001234567'], allow_billable: true }));
        s.host('wa-card');
        s.api['disconnectWhatsApp'] = async () => null;
        s.api['getWhatsAppConnection'] = async () => none({ status: 'revoked', mode: 'off', test_senders: ['201001234567'] });

        s.Card.askDisconnect();

        assert.equal(s.confirms.length, 1);
        assert.equal(s.calls.length, 0, 'a press alone sends nothing');
        assert.equal(s.confirms[0].title, s.t('wa.disconnect.title'));
        assert.equal(s.confirms[0].body, s.t('wa.disconnect.body'));
        assert.ok(String(s.confirms[0].hint).length > 0);
        assert.equal(s.confirms[0].tone, undefined, 'the default tone of the confirmation is danger');

        await s.confirms[0].onConfirm();
        assert.deepEqual(s.calls.map((c) => c.method), ['disconnectWhatsApp', 'getWhatsAppConnection']);
        assert.equal(s.Card.live(), false, 'the card is the not-connected card again');
        assert.equal(s.Card.state.mode, 'off', 'and the agent is off, as the server says');
        assert.ok(markupOf(s).includes(s.t('wa.connect.title')) && !markupOf(s).includes('id="wa-agent"'));
        assert.ok(s.toasts.some((x) => x.message === s.t('wa.disconnected')));
    });

    it('when the read after a disconnect fails, the card still says what is certain: disconnected, agent off', async () => {
        const s = load();
        s.Card.section(view({ mode: 'test', allow_billable: true }));
        s.host('wa-card');
        s.api['disconnectWhatsApp'] = async () => null;
        s.api['getWhatsAppConnection'] = async () => { throw new Error('boom'); };
        s.Card.askDisconnect();
        await s.confirms[0].onConfirm();
        assert.equal(s.Card.live(), false);
        assert.equal(s.Card.state.mode, 'off');
        assert.equal(s.Card.state.allow_billable, false);
        assert.equal(s.Card.state.display_phone_number, null);
    });

    it('a refused Disconnect stays inside the dialog, in the owner\'s language, and the connection is untouched', async () => {
        const s = load();
        s.Card.section(view());
        s.host('wa-card');
        s.api['disconnectWhatsApp'] = async () => { throw refusal(500, { error: 'Failed to disconnect WhatsApp.' }); };
        s.Card.askDisconnect();
        await assert.rejects(Promise.resolve(s.confirms[0].onConfirm()), (e: Error) => e.message === 'Failed to disconnect WhatsApp.');
        assert.equal(s.Card.live(), true);
        assert.equal(s.Card.busy, null);
    });

    it('Disconnect has nothing to do when there is no connection', () => {
        const s = load();
        s.Card.section(none());
        s.Card.askDisconnect();
        assert.equal(s.confirms.length, 0);
    });
});

// ─── The wiring ──────────────────────────────────────────────────────────────────────────────────

describe('the WhatsApp card: the client, the registration, Settings, and a tenant switch', () => {
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
        await API.getWhatsAppConnection();
        await API.connectWhatsApp({ waba_id: WABA, phone_number_id: PHONE, access_token: TOKEN });
        await API.refreshWhatsApp();
        await API.disconnectWhatsApp();
        await API.saveWhatsAppAgent({ mode: 'test', test_senders: ['201001234567'] });
        await API.saveWhatsAppBilling({ allow_billable: true });
        assert.deepEqual(sent, [
            { url: '/api/whatsapp/connection', method: 'GET', body: undefined },
            { url: '/api/whatsapp/connect', method: 'POST', body: { waba_id: WABA, phone_number_id: PHONE, access_token: TOKEN } },
            { url: '/api/whatsapp/refresh', method: 'POST', body: undefined },
            { url: '/api/whatsapp/connection', method: 'DELETE', body: undefined },
            { url: '/api/whatsapp/agent', method: 'PUT', body: { mode: 'test', test_senders: ['201001234567'] } },
            { url: '/api/whatsapp/billing', method: 'PUT', body: { allow_billable: true } },
        ]);
        // The token is in the URL of nothing.
        assert.ok(sent.every((x) => !x.url.includes(TOKEN)));
    });

    it('the module is a registered, non-routable page module whose file exists', () => {
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(app, /whatsapp_card: \{ src: 'whatsapp_card', page: \(\) => WhatsAppCard, routable: false \}/);
        assert.ok(existsSync('dashboard/js/pages/whatsapp_card.js'));
    });

    it('Settings asks for the connection and loads the module for EVERY member, and draws the card right after YouTube', () => {
        const settings = readFileSync('dashboard/js/pages/settings.js', 'utf8');
        assert.match(settings, /^\s+API\.getWhatsAppConnection\(\),$/m, 'not gated on the owner: a member reads');
        assert.match(settings, /^\s+App\.loadPageModule\('whatsapp_card'\),$/m);
        const at = (needle: string): number => settings.indexOf(needle);
        const youtube = at('${this.youtubeSection({');
        const whatsapp = at('${this.whatsappSection(whatsapp, whatsappError)}');
        const media = at("${App.isAdmin() ? this.mediaStorageSection(");
        assert.ok(youtube > 0 && whatsapp > youtube && media > whatsapp, 'YouTube, then WhatsApp, then the admin cards');
    });

    it('Settings draws the card, and when it could not be loaded says why with a Retry, even when the module never arrived', () => {
        const s = load();
        assert.ok(String(s.Settings.whatsappSection(view(), null)).includes('id="wa-card"'));
        const failed = String(s.Settings.whatsappSection(null, new Error('boom <b>')));
        assert.ok(failed.includes('boom &lt;b&gt;') && !failed.includes('<b>'), 'the reason is shown, escaped');
        assert.ok(failed.includes('data-action="settings:render"'), 'Retry');
        assert.ok(failed.includes(s.t('wa.title')));
        // A failure with a code is said in words, not as the server's English.
        const migration = String(s.Settings.whatsappSection(null, refusal(503, { error: 'The database is missing migration v50', migrationPending: true })));
        assert.ok(migration.includes(s.t('wa.err.migration_pending')));

        const bare = load('en', { withCard: false });
        assert.equal(bare.Card, null, 'the module is not in this page');
        const card = String(bare.Settings.whatsappSection(view(), null));
        assert.ok(card.includes(bare.t('wa.loadFailed', { message: bare.t('wa.moduleFailed') })));
        assert.ok(card.includes('data-action="settings:render"'));
    });

    it('a tenant switch leaves nothing of the previous account: number, senders, typed ids', () => {
        const s = load();
        s.Card.section(view({ mode: 'test', test_senders: ['201001234567'] }));
        s.Card.form = { waba: WABA, phone: PHONE };
        s.Card.errors.agent = { code: 'x', message: 'm', hint: '', field: null };
        s.Card.resetTenantState();
        assert.equal(s.Card.state, null);
        assert.deepEqual(plain(s.Card.form), { waba: '', phone: '' });
        assert.deepEqual(plain(s.Card.draft), { mode: 'off', senders: '' });
        assert.equal(s.Card.errors.agent, null);
        assert.equal(s.Card.live(), false);
    });

    it('nothing is scheduled and nothing is called at load: drawing every state calls no API at all', () => {
        const source = readFileSync('dashboard/js/pages/whatsapp_card.js', 'utf8');
        assert.ok(!/setTimeout|setInterval/.test(source), 'nothing is scheduled');
        assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), 'nothing is stored in the browser');
        const s = load();
        for (const state of [none(), view(), refused()]) s.Card.section(state);
        assert.equal(s.calls.length, 0);
    });

    it('the token is read from the page in exactly one place, and the card has no other way to learn it', () => {
        const source = readFileSync('dashboard/js/pages/whatsapp_card.js', 'utf8');
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.equal((code.match(/getElementById\('wa-token'\)/g) ?? []).length, 2, 'connect() reads it; the validation repaint puts it back');
        assert.ok(!/this\.token|state\.token|access_token\s*:\s*this/.test(code), 'it is never a property of the card');
        assert.ok(!/console\.\w+\([^)]*token/i.test(code), 'and never logged');
    });
});
