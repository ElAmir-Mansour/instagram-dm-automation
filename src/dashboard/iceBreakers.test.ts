/**
 * The dashboard's half of DM plan S13: the Settings card where the owner edits his Instagram ice breakers and persistent menu, saves a draft,
 * and presses the one button that publishes it.
 *
 * Loaded like the other dashboard tests: the REAL shipped files in a `node:vm` context with a fake DOM, so these test what ships. What is pinned,
 * because a screenshot cannot check it:
 *
 *   - nothing is sent to Instagram without the owner confirming: Publish and Remove ask first and call the API only when the dialog's own
 *     confirm runs; editing and Save never call them; Publish is off while the editor differs from what was saved, and while Instagram is
 *     not connected;
 *   - suggestions are shown as suggestions and are not saved until Save: they ARE the payload Save sends, and Use suggestions never touches the menu;
 *   - what is sent is what the server takes: blank rows dropped, a row carries only what its type uses, and a refusal that names row N of
 *     what was sent marks the right field of the editor even after blank rows were dropped;
 *   - everything a person typed, Instagram reported back, or the server said is escaped: in the editor's attributes, in the read-back, in the
 *     error strip, in a select's value, and a link is shown as text and never becomes an href;
 *   - both languages render the whole card with no raw key, and it uses the limits the server sends;
 *   - the API client sends exactly the contract, and the module is registered and loaded for the owner only.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import {
    ICE_BREAKER_MAX, ICE_BREAKER_QUESTION_MAX, MENU_ITEMS_MAX, MENU_TITLE_MAX, suggestIceBreakers, TAP_CODES, TAP_INTENT,
} from '../services/dmSales/iceBreakers.js';

type Json = any;

class FakeFormData {
    private readonly fields: Record<string, unknown>;
    constructor(form: { fields?: Record<string, unknown> } | null) { this.fields = (form && form.fields) || {}; }
    get(name: string): unknown { return Object.prototype.hasOwnProperty.call(this.fields, name) ? this.fields[name] : null; }
}

interface Loaded {
    Card: Json;
    Settings: Json;
    UI: Json;
    t: (key: string, params?: Record<string, unknown>) => string;
    api: Record<string, (...args: Json[]) => unknown>;
    calls: Array<{ method: string; args: Json[] }>;
    confirms: Json[];
    toasts: string[];
    dom: Map<string, Json>;
    host(id: string, over?: Json): Json;
}

function load(lang: 'ar' | 'en' = 'en', withCard = true): Loaded {
    const owner = true;
    const noop = (): void => {};
    const dom = new Map<string, Json>();
    const api: Record<string, (...args: Json[]) => unknown> = {};
    const calls: Array<{ method: string; args: Json[] }> = [];
    const confirms: Json[] = [];
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
        Intl, console, clearTimeout, URLSearchParams,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        setTimeout: (fn: () => void, ms?: number) => { const h = setTimeout(fn, ms); (h as Json).unref?.(); return h; },
        setInterval: (fn: () => void, ms?: number) => { const h = setInterval(fn, ms); (h as Json).unref?.(); return h; },
        clearInterval, requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang }, CSS: { escape: (v: string) => String(v) }, FormData: FakeFormData,
        API: new Proxy(api, {
            get: (target, prop: string) => (prop === 'token' ? 'tok' : prop in target
                ? (...args: Json[]) => { calls.push({ method: prop, args }); return target[prop]!(...args); }
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        Admin: { emptyState: (_i: string, title: string) => `<div>${title}</div>`, confirm: (o: Json) => { confirms.push(o); } },
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
        ...(withCard ? ['dashboard/js/pages/ice_breakers.js'] : []), 'dashboard/js/pages/settings.js',
    ]) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const got = vm.runInContext(`({ Card: ${withCard ? 'IceBreakersCard' : 'null'}, Settings: SettingsPage, UI, t })`, ctx);
    const toasts: string[] = [];
    got.UI.toast = (m: unknown) => { toasts.push(String(m)); };
    const host = (id: string, over: Json = {}): Json => {
        const el: Json = { id, innerHTML: '', textContent: '', value: '', dataset: {}, disabled: false, classList: stub.classList, scrollIntoView: noop, focus: noop, setAttribute: noop, ...over };
        dom.set(id, el);
        return el;
    };
    return { Card: got.Card, Settings: got.Settings, UI: got.UI, t: got.t, api, calls, confirms, toasts, dom, host };
}

const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));
const markupOf = (s: Loaded): string => String(s.Card.body());

const TAPS = TAP_CODES.map((code) => ({ code, intent: TAP_INTENT[code] }));
const LIMITS = { iceBreakers: ICE_BREAKER_MAX, question: ICE_BREAKER_QUESTION_MAX, menuItems: MENU_ITEMS_MAX, menuTitle: MENU_TITLE_MAX };

/** What `GET /api/dm/ice-breakers` answers. Nothing saved by default, so the editor starts from the suggestions. */
const answer = (over: Json = {}): Json => ({
    config: { iceBreakers: [], menu: [] }, saved: false, published: null, inSync: false, connected: { instagram: true },
    suggestions: { kit: 'gulf', items: suggestIceBreakers('gulf', 'Plan A') }, limits: LIMITS, taps: TAPS, ...over,
});

const SAVED = {
    iceBreakers: [{ question: 'وش السعر؟', payload: 'TAP_PRICE' }, { question: 'أبي الرابط', payload: 'TAP_LINK' }],
    menu: [{ type: 'postback', title: 'كلّم شخصاً', payload: 'TAP_HUMAN' }, { type: 'web_url', title: 'الموقع', url: 'https://x.test/a' }],
};
const PUBLISHED = { at: '2026-10-14T10:00:00.000Z', by: 'u-owner', iceBreakers: 2, menu: 2, hash: 'abc123' };
/** A tenant that saved a draft and published it, with the screen's own state in sync. */
const synced = (over: Json = {}): Json => answer({ config: SAVED, saved: true, published: PUBLISHED, inSync: true, ...over });

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

/** The opening tag of the `<button>` that dispatches `action` (and carries `data-list="…"` when `list` is given), or '' when there is none. */
function buttonTag(markup: string, action: string, list?: string): string {
    for (const m of markup.matchAll(/<button\b[^>]*>/g)) {
        if (m[0].includes(`data-action="${action}"`) && (list === undefined || m[0].includes(`data-list="${list}"`))) return m[0];
    }
    return '';
}
const isDisabled = (tag: string): boolean => /\sdisabled(\s|>)/.test(tag);

// ─── The card ────────────────────────────────────────────────────────────────────────────────

describe('the ice breakers card: what it shows', () => {
    it('starts an account that never saved from the suggestions, says they are suggestions, and has not saved them', () => {
        const s = load();
        const markup = String(s.Card.section(answer()));

        assert.equal(s.Card.suggested, true);
        assert.ok(markup.includes(s.t('iceb.suggested')), 'labelled as suggestions');
        for (const item of suggestIceBreakers('gulf', 'Plan A')) assert.ok(markup.includes(item.question), item.question);
        assert.equal(s.calls.length, 0, 'rendering saves nothing and calls nobody');
        assert.deepEqual(plain(s.Card.draft.iceBreakers), plain(suggestIceBreakers('gulf', 'Plan A')));
        // Four rows, so the add button is off at Meta's limit; the menu has room.
        assert.equal(isDisabled(buttonTag(markup, 'iceb:add', 'iceBreakers')), true);
        assert.equal(isDisabled(buttonTag(markup, 'iceb:add', 'menu')), false);
    });

    it('starts an account that saved a draft from the draft, not the suggestions, and says it matches what was published', () => {
        const s = load();
        const markup = String(s.Card.section(synced()));
        assert.equal(s.Card.suggested, false);
        assert.ok(!markup.includes(s.t('iceb.suggested')));
        assert.ok(markup.includes('وش السعر؟') && markup.includes('كلّم شخصاً') && markup.includes('https://x.test/a'));
        assert.ok(markup.includes(s.t('iceb.status.inSync')));
        assert.ok(markup.includes(s.t('iceb.status.last', { when: s.UI.formatDateTime(PUBLISHED.at), ice: 2, menu: 2 })));
    });

    it('opens the menu block only when there is a menu, and offers every payload as what it asks (never the code)', () => {
        const s = load();
        assert.ok(!/<details[^>]*id="iceb-menu-block"[^>]* open/.test(String(s.Card.section(answer()))));
        const markup = String(s.Card.section(synced()));
        assert.ok(/<details[^>]*id="iceb-menu-block"[^>]* open/.test(markup));
        for (const code of TAP_CODES) assert.ok(markup.includes(`<option value="${code}"`), code);
        assert.ok(markup.includes(s.t('iceb.tap.TAP_PRICE')));
        assert.ok(!/>TAP_[A-Z]+</.test(markup), 'no code is shown to the owner as text');
    });

    it('draws a link item with a url field and no payload, and a reply item with a payload and no url', () => {
        const s = load();
        const markup = String(s.Card.section(synced()));
        assert.ok(markup.includes('id="iceb-menu-1-url"') && !markup.includes('id="iceb-menu-1-payload"'));
        assert.ok(markup.includes('id="iceb-menu-0-payload"') && !markup.includes('id="iceb-menu-0-url"'));
        assert.match(markup, /id="iceb-menu-1-url" type="url" dir="ltr"/);
    });

    it('uses the limits the SERVER sends: the field lengths, the counters and the add buttons', () => {
        const s = load();
        const markup = String(s.Card.section(answer({
            limits: { iceBreakers: 2, question: 33, menuItems: 1, menuTitle: 12 },
            config: { iceBreakers: [{ question: 'Q1', payload: 'TAP_INFO' }, { question: 'Q2', payload: 'TAP_INFO' }], menu: [{ type: 'postback', title: 'T', payload: 'TAP_HUMAN' }] },
            saved: true,
        })));
        assert.match(markup, /id="iceb-ice-0-question"[^>]*maxlength="33"/);
        assert.match(markup, /id="iceb-menu-0-title"[^>]*maxlength="12"/);
        assert.ok(markup.includes(s.t('iceb.counter', { n: 1, max: 12 })));
        assert.ok(markup.includes(s.t('iceb.ice.hint', { max: 2, chars: 33 })));
        assert.equal(isDisabled(buttonTag(markup, 'iceb:add', 'iceBreakers')), true, 'two rows at a limit of two');
        assert.equal(isDisabled(buttonTag(markup, 'iceb:add', 'menu')), true, 'one item at a limit of one');
    });

    it('says Instagram is not connected, and turns every button that would reach it off', () => {
        const s = load();
        const markup = String(s.Card.section(synced({ connected: { instagram: false } })));
        assert.ok(markup.includes(s.t('iceb.notConnected')));
        assert.equal(s.Card.canPublish(), false);
        for (const action of ['iceb:publish', 'iceb:readLive', 'iceb:askRemove']) {
            assert.ok(buttonTag(markup, action), `${action} is on the card`);
            assert.equal(isDisabled(buttonTag(markup, action)), true, action);
        }
        assert.equal(isDisabled(buttonTag(String(s.Card.section(synced())), 'iceb:publish')), false, 'and with Instagram connected, Publish is on');
    });

    it('both languages draw the whole card with no raw key in it', () => {
        for (const lang of ['ar', 'en'] as const) {
            const s = load(lang);
            s.Card.section(synced());
            s.Card.live = { iceBreakers: [{ locale: 'default', items: [{ question: 'Q', payload: 'TAP_PRICE' }, { question: 'R', payload: 'OLD_CODE' }] }], menu: [{ locale: 'default', items: [{ type: 'web_url', title: 'Site', url: 'https://x.test' }] }] };
            s.Card.error = { message: s.t('iceb.err.TOO_MANY', { max: 4 }), hint: '', field: null };
            const markup = markupOf(s);
            assert.ok(!/\biceb\.[a-zA-Z]/.test(markup), `${lang}: a raw key is on the screen: ${markup.match(/\biceb\.[\w.]+/)?.[0]}`);
            assert.ok(markup.includes(s.t('iceb.title')) && markup.includes(s.t('iceb.save')) && markup.includes(s.t('iceb.publish')));
        }
    });

    it('the Settings card is drawn for the owner and carries a Retry when it could not be loaded, even when its module never arrived', () => {
        const s = load();
        assert.ok(String(s.Settings.iceBreakersSection(answer(), null)).includes('id="iceb-card"'));
        const failed = String(s.Settings.iceBreakersSection(null, new Error('boom <b>')));
        assert.ok(failed.includes('boom &lt;b&gt;') && !failed.includes('<b>'), 'the reason is shown, escaped');
        assert.ok(failed.includes('data-action="settings:render"'), 'Retry');
        assert.ok(failed.includes(s.t('iceb.title')));
    });

    it('a page whose module never arrived gets the same card with its reason, and no exception', () => {
        const bare = load('en', false);
        assert.equal(bare.Card, null, 'the module is not in this page');
        const card = String(bare.Settings.iceBreakersSection(answer(), null));
        assert.ok(card.includes(bare.t('iceb.loadFailed', { message: bare.t('iceb.moduleFailed') })));
        assert.ok(card.includes('data-action="settings:render"'));
    });
});

// ─── Nothing goes to Instagram without a press and a yes ─────────────────────────────────────────────

describe('the ice breakers card: Publish and Remove', () => {
    it('Publish asks first, says what it will change, and calls the API only when the dialog\'s own confirm runs', async () => {
        const s = load();
        s.Card.section(synced());
        s.api['publishIceBreakers'] = async () => synced({ result: { set: ['ice_breakers', 'persistent_menu'], removed: [] }, live: { iceBreakers: [], menu: [] }, liveError: null });
        s.host('iceb-card');

        s.Card.publish();

        assert.equal(s.confirms.length, 1);
        assert.equal(s.calls.length, 0, 'a press alone sends nothing');
        assert.equal(s.confirms[0].title, s.t('iceb.publish.title'));
        assert.equal(s.confirms[0].body, s.t('iceb.publish.body', { ice: 2, menu: 2 }));
        assert.equal(s.confirms[0].tone, 'primary');

        await s.confirms[0].onConfirm();
        assert.deepEqual(s.calls.map((c) => c.method), ['publishIceBreakers']);
        assert.ok(s.toasts.includes(s.t('iceb.published')));
    });

    it('Remove asks first, in the danger tone, and calls the API only on confirm', async () => {
        const s = load();
        s.Card.section(synced());
        s.api['removeIceBreakers'] = async () => answer({ config: SAVED, saved: true, published: null, result: { set: [], removed: ['ice_breakers', 'persistent_menu'] }, live: { iceBreakers: [], menu: [] } });
        s.host('iceb-card');

        s.Card.askRemove();

        assert.equal(s.confirms.length, 1);
        assert.equal(s.calls.length, 0);
        assert.equal(s.confirms[0].tone, undefined, 'the default tone of Admin.confirm is danger');
        await s.confirms[0].onConfirm();
        assert.deepEqual(s.calls.map((c) => c.method), ['removeIceBreakers']);
        assert.ok(s.toasts.includes(s.t('iceb.removed')));
        assert.equal(s.Card.state.published, null, 'the record of a publish is gone');
        assert.deepEqual(plain(s.Card.state.config), plain(SAVED), 'the draft stays');
        assert.ok(markupOf(s).includes(s.t('iceb.live.empty')), 'what Instagram holds afterwards is shown');
    });

    it('Publish is off, and does nothing when pressed, while the editor differs from what was saved', () => {
        const s = load();
        s.Card.section(synced());
        s.host('iceb-card');
        assert.equal(s.Card.canPublish(), true);

        s.Card.draft.iceBreakers[0].question = 'a different question';
        assert.equal(s.Card.dirty(), true);
        assert.equal(s.Card.canPublish(), false);
        s.Card.publish();
        assert.equal(s.confirms.length, 0, 'not even a dialog');
        assert.equal(s.calls.length, 0);
    });

    it('is off while suggestions are shown and unsaved, and when the saved draft is empty and nothing was ever published', () => {
        const s = load();
        s.Card.section(answer());
        assert.equal(s.Card.canPublish(), false, 'suggestions are not a draft');
        s.Card.section(answer({ saved: true }));
        assert.equal(s.Card.canPublish(), false, 'an empty saved draft has nothing to publish');
        s.Card.section(answer({ saved: true, published: { ...PUBLISHED, iceBreakers: 2, menu: 0 } }));
        assert.equal(s.Card.canPublish(), true, 'but buttons this app put on Instagram can be taken off by publishing an empty draft');
    });

    it('every button is off while a request is in flight, so a double press is not two writes', async () => {
        const s = load();
        s.Card.section(synced());
        s.host('iceb-card');
        let release: (v: unknown) => void = () => {};
        s.api['publishIceBreakers'] = () => new Promise((r) => { release = r; });

        const pending = s.Card.publishConfirmed();
        assert.equal(s.Card.busy, 'publish');
        assert.equal(s.Card.canPublish(), false);
        await s.Card.publishConfirmed();
        assert.equal(s.calls.filter((c) => c.method === 'publishIceBreakers').length, 1, 'the second press did nothing');
        release(synced());
        await pending;
        assert.equal(s.Card.busy, null);
    });

    it('a refusal from Instagram is shown in Instagram\'s own words, escaped, and leaves the state as it was', async () => {
        const s = load();
        s.Card.section(synced());
        s.host('iceb-card');
        s.api['publishIceBreakers'] = async () => { throw Object.assign(new Error('(#10) No permission <img src=x onerror=alert(1)>'), { status: 502, body: { code: 'META_ERROR', metaCode: 10 } }); };

        await s.Card.publishConfirmed();

        assert.equal(s.Card.busy, null);
        const markup = markupOf(s);
        assert.ok(markup.includes('No permission &lt;img src=x onerror=alert(1)&gt;'), 'quoted, escaped');
        assert.ok(!/<img\b/i.test(markup));
        assert.deepEqual(plain(s.Card.state.published), PUBLISHED);
    });

    it('a read-back that failed says so, and does not claim the publish did', async () => {
        const s = load();
        s.Card.section(synced());
        s.host('iceb-card');
        s.api['publishIceBreakers'] = async () => synced({ result: { set: ['ice_breakers'], removed: [] }, live: null, liveError: 'Instagram profile read failed: nope' });
        await s.Card.publishConfirmed();
        assert.ok(markupOf(s).includes('Instagram profile read failed: nope'));
        assert.equal(s.Card.live, null);
    });

    it('Read from Instagram changes nothing: it shows what the read said, and an empty profile in words', async () => {
        const s = load();
        s.Card.section(synced());
        s.host('iceb-card');
        s.api['readIceBreakersLive'] = async () => ({ live: { iceBreakers: [], menu: [] } });
        const before = JSON.stringify(plain(s.Card.draft));

        await s.Card.readLive();

        assert.deepEqual(s.calls.map((c) => c.method), ['readIceBreakersLive']);
        assert.ok(markupOf(s).includes(s.t('iceb.live.empty')));
        assert.equal(JSON.stringify(plain(s.Card.draft)), before);
    });
});

// ─── Edit and Save ───────────────────────────────────────────────────────────────────────────────────

describe('the ice breakers card: editing and saving', () => {
    it('editing and adding rows call nobody: typing is a copy in the browser', () => {
        const s = load();
        s.Card.section(synced());
        s.host('iceb-card');
        s.host('iceb-ice-0-question', { value: 'typed' });
        s.host('iceb-publish');
        s.host('iceb-status');

        s.Card.edit();

        assert.equal(s.Card.draft.iceBreakers[0].question, 'typed');
        assert.equal(s.dom.get('iceb-publish')!.disabled, true, 'Publish went off the moment the editor differed');
        assert.equal(s.calls.length, 0);
        assert.ok(String(s.dom.get('iceb-status')!.innerHTML).includes(s.t('iceb.status.unsaved')));
    });

    it('Save sends the draft the server takes: blank rows dropped, a row only what its type uses, trimmed', async () => {
        const s = load();
        s.Card.section(answer({ saved: true }));
        s.host('iceb-card');
        s.Card.draft = {
            iceBreakers: [{ question: '  وش السعر؟  ', payload: 'TAP_PRICE' }, { question: '   ', payload: 'TAP_INFO' }, { question: 'أبي الرابط', payload: 'TAP_LINK' }],
            menu: [
                { type: 'postback', title: 'كلّم شخصاً', payload: 'TAP_HUMAN', url: 'https://ignored.test' },
                { type: 'postback', title: '', payload: 'TAP_INFO', url: '' },
                { type: 'web_url', title: 'الموقع', url: ' https://x.test/a ', payload: 'TAP_INFO' },
            ],
        };
        s.api['saveIceBreakers'] = async (body: Json) => answer({ config: body, saved: true });

        await s.Card.save(null, { preventDefault() {} });

        assert.deepEqual(plain(s.calls[0]!.args[0]), {
            iceBreakers: [{ question: 'وش السعر؟', payload: 'TAP_PRICE' }, { question: 'أبي الرابط', payload: 'TAP_LINK' }],
            menu: [{ type: 'postback', title: 'كلّم شخصاً', payload: 'TAP_HUMAN' }, { type: 'web_url', title: 'الموقع', url: 'https://x.test/a' }],
        });
        assert.deepEqual(s.calls.map((c) => c.method), ['saveIceBreakers'], 'only Save: nothing was published');
        assert.ok(s.toasts.includes(s.t('iceb.saved')));
        assert.equal(s.Card.suggested, false);
    });

    it('Save sends the suggestions as they are, and only then are they saved', async () => {
        const s = load();
        s.Card.section(answer());
        s.host('iceb-card');
        s.api['saveIceBreakers'] = async (body: Json) => answer({ config: body, saved: true });

        await s.Card.save(null, { preventDefault() {} });

        assert.deepEqual(plain(s.calls[0]!.args[0].iceBreakers), plain(suggestIceBreakers('gulf', 'Plan A')));
        assert.equal(s.Card.state.saved, true);
        assert.equal(s.Card.suggested, false);
    });

    it('Use suggestions replaces the questions and never the menu, and still saves nothing', () => {
        const s = load();
        s.Card.section(synced());
        s.host('iceb-card');
        s.Card.useSuggestions();
        assert.deepEqual(plain(s.Card.draft.iceBreakers), plain(suggestIceBreakers('gulf', 'Plan A')));
        assert.deepEqual(plain(s.Card.draft.menu.map((m: Json) => m.title)), ['كلّم شخصاً', 'الموقع']);
        assert.equal(s.calls.length, 0);
        assert.equal(s.Card.dirty(), true);
    });

    it('Add stops at the limits, and Remove takes the row out', () => {
        const s = load();
        s.Card.section(answer({ saved: true }));
        s.host('iceb-card');
        for (let i = 0; i < 6; i++) s.Card.add({ dataset: { list: 'iceBreakers' } });
        assert.equal(s.Card.draft.iceBreakers.length, ICE_BREAKER_MAX);
        for (let i = 0; i < 8; i++) s.Card.add({ dataset: { list: 'menu' } });
        assert.equal(s.Card.draft.menu.length, MENU_ITEMS_MAX);
        s.Card.removeRow({ dataset: { list: 'iceBreakers', index: '0' } });
        assert.equal(s.Card.draft.iceBreakers.length, ICE_BREAKER_MAX - 1);
        s.Card.removeRow({ dataset: { list: 'iceBreakers', index: '99' } });
        s.Card.removeRow({ dataset: { list: 'nonsense', index: '0' } });
        assert.equal(s.Card.draft.iceBreakers.length, ICE_BREAKER_MAX - 1, 'a bad index or list is ignored');
        assert.equal(s.calls.length, 0);
    });

    it('a refusal naming row 1 of what was sent marks the editor row it came from, though a blank row was dropped before it', async () => {
        const s = load();
        s.Card.section(answer({ saved: true }));
        s.host('iceb-card');
        s.Card.draft = { iceBreakers: [{ question: 'Fine?', payload: 'TAP_INFO' }, { question: '', payload: 'TAP_INFO' }, { question: 'x'.repeat(81), payload: 'TAP_INFO' }], menu: [] };
        s.api['saveIceBreakers'] = async () => {
            throw Object.assign(new Error('A question is at most 80 characters.'), {
                status: 400, body: { code: 'ICE_BREAKERS_INVALID', problems: [{ field: 'iceBreakers[1].question', code: 'QUESTION_TOO_LONG', message: 'x' }] },
            });
        };
        const invalid: string[] = [];
        s.UI.markInvalid = (el: Json) => { invalid.push(el.id); };
        // The inputs as they are on the page, holding what was typed (the draft is re-read from them when Save is pressed).
        s.host('iceb-ice-0-question', { value: 'Fine?' });
        s.host('iceb-ice-1-question', { value: '' });
        s.host('iceb-ice-2-question', { value: 'x'.repeat(81) });

        await s.Card.save(null, { preventDefault() {} });

        assert.deepEqual(invalid, ['iceb-ice-2-question'], 'row 1 of what was sent is editor row 2');
        assert.ok(markupOf(s).includes(s.t('iceb.err.QUESTION_TOO_LONG', { max: 80 })), 'the sentence is the dashboard\'s, in its language');
        assert.equal(s.Card.busy, null);
    });

    it('says what a refusal means in words: nothing to publish, not connected, too many', () => {
        const s = load();
        s.Card.section(answer());
        for (const code of ['NOTHING_TO_PUBLISH', 'META_NOT_CONNECTED', 'INSTAGRAM_NOT_CONNECTED']) {
            assert.equal(s.Card.describe({ message: 'x', body: { code } }, null).message, s.t(`iceb.err.${code}`));
        }
        const many = s.Card.describe({ message: 'x', body: { code: 'ICE_BREAKERS_INVALID', problems: [{ field: 'iceBreakers', code: 'TOO_MANY', message: 'm' }, { field: 'menu', code: 'TOO_MANY', message: 'm' }] } }, null);
        assert.equal(many.message, s.t('iceb.err.TOO_MANY', { max: 4 }));
        assert.equal(many.hint, s.t('iceb.err.TOO_MANY', { max: 5 }), 'the menu\'s limit is the menu\'s');
        assert.equal(s.Card.describe(new Error('plain'), null).message, 'plain');
    });
});

// ─── Escaping ────────────────────────────────────────────────────────────────────────────────────────

describe('the ice breakers card: everything typed, reported or refused is escaped', () => {
    const HOSTILE = '"><img src=x onerror=alert(1)>';
    const HOSTILE_ATTR = `" autofocus onfocus="alert(document.cookie)`;
    const HOSTILE_SCRIPT = '</textarea></div></details><script>alert(1)</script>';

    const noExecutableMarkup = (markup: string, label: string): void => {
        assert.ok(!/<img\b/i.test(markup), `${label}: a raw <img>`);
        assert.ok(!/<script\b/i.test(markup), `${label}: a raw <script>`);
        for (const tag of tags(markup)) {
            for (const attr of tag.attrs) assert.ok(!/^on/i.test(attr) && attr !== 'autofocus', `${label}: <${tag.name}> grew an ${attr} attribute`);
        }
    };

    it('the editor: questions, titles, links and payloads typed into it cannot leave their attribute or their element', () => {
        const s = load();
        s.Card.section(answer({ saved: true }));
        s.Card.draft = {
            iceBreakers: [{ question: HOSTILE, payload: HOSTILE }, { question: HOSTILE_ATTR, payload: 'TAP_INFO' }, { question: HOSTILE_SCRIPT, payload: 'TAP_INFO' }],
            menu: [
                { type: 'postback', title: HOSTILE, payload: HOSTILE_ATTR, url: '' },
                { type: 'web_url', title: HOSTILE_ATTR, payload: 'TAP_INFO', url: `javascript:alert(1)${HOSTILE_ATTR}` },
            ],
        };
        const markup = markupOf(s);

        noExecutableMarkup(markup, 'editor');
        assert.ok(markup.includes('value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'), 'the hostile question is the value of its input, as text');
        assert.ok(markup.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
        assert.ok(!/href=/.test(markup), 'the editor has no link at all: a menu url is an input value');
    });

    it('what Instagram reports back: questions, titles, payloads, urls and locales are text, a url is never an href, and nothing grows an attribute', () => {
        const s = load();
        s.Card.section(synced());
        s.Card.live = {
            iceBreakers: [{ locale: HOSTILE, items: [{ question: HOSTILE, payload: HOSTILE_ATTR }, { question: HOSTILE_SCRIPT, payload: 'TAP_PRICE' }] }],
            menu: [{ locale: HOSTILE_ATTR, items: [
                { type: 'web_url', title: HOSTILE, url: 'javascript:alert(document.cookie)' },
                { type: 'web_url', title: HOSTILE_ATTR, url: `https://x.test/"><script>alert(1)</script>` },
                { type: 'postback', title: HOSTILE_SCRIPT, payload: HOSTILE },
            ] }],
        };
        s.Card.liveNote = HOSTILE;
        const markup = markupOf(s);

        noExecutableMarkup(markup, 'read-back');
        assert.ok(!/href=/.test(markup), 'a url Instagram reported is shown as text, never as a link');
        assert.ok(markup.includes('javascript:alert(document.cookie)'), 'it is shown as the text it is');
        assert.ok(markup.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    });

    it('the error strip: a refusal\'s message and hint, Instagram\'s own words, and a problem\'s fallback message', () => {
        const s = load();
        s.Card.section(answer({ saved: true }));
        const meta = s.Card.describe(Object.assign(new Error(`(#100) ${HOSTILE}`), { body: { code: 'META_ERROR' } }), null);
        s.Card.error = meta;
        let markup = markupOf(s);
        noExecutableMarkup(markup, 'meta error');
        assert.ok(markup.includes('(#100) &quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));

        const unknown = s.Card.describe({ message: 'x', body: { code: 'ICE_BREAKERS_INVALID', problems: [{ field: 'iceBreakers[0].question', code: 'SOMETHING_NEW', message: HOSTILE_SCRIPT }] } }, null);
        s.Card.error = unknown;
        markup = markupOf(s);
        noExecutableMarkup(markup, 'unknown problem');
        assert.ok(markup.includes('&lt;script&gt;'), 'a code the dashboard has no words for falls back to the server\'s sentence, escaped');
    });

    it('what the server sends as data for the editor: a hostile tap code, a hostile suggestion and a hostile published record', () => {
        const s = load();
        const markup = String(s.Card.section(answer({
            taps: [{ code: HOSTILE, intent: 'info' }, { code: 'TAP_INFO', intent: 'info' }],
            suggestions: { kit: 'gulf', items: [{ question: HOSTILE_ATTR, payload: HOSTILE }] },
            published: { at: HOSTILE, by: HOSTILE, iceBreakers: HOSTILE, menu: HOSTILE_ATTR, hash: HOSTILE },
            saved: true, config: { iceBreakers: [{ question: 'q', payload: HOSTILE }], menu: [] },
        })));
        noExecutableMarkup(markup, 'server data');
        assert.ok(markup.includes('<option value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'), 'the hostile code is an option value, as text');
    });
});

// ─── The wiring ──────────────────────────────────────────────────────────────────────────────────────

describe('the ice breakers card: the client, the registration and who loads it', () => {
    it('the API client sends exactly the contract: GET, PUT with the draft, POST /publish, DELETE /publish, GET /live', async () => {
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
        await API.getIceBreakers();
        await API.saveIceBreakers({ iceBreakers: [{ question: 'q', payload: 'TAP_INFO' }], menu: [] });
        await API.publishIceBreakers();
        await API.removeIceBreakers();
        await API.readIceBreakersLive();
        assert.deepEqual(sent, [
            { url: '/api/dm/ice-breakers', method: 'GET', body: undefined },
            { url: '/api/dm/ice-breakers', method: 'PUT', body: { iceBreakers: [{ question: 'q', payload: 'TAP_INFO' }], menu: [] } },
            { url: '/api/dm/ice-breakers/publish', method: 'POST', body: undefined },
            { url: '/api/dm/ice-breakers/publish', method: 'DELETE', body: undefined },
            { url: '/api/dm/ice-breakers/live', method: 'GET', body: undefined },
        ]);
    });

    it('the module is a registered, non-routable page module whose file exists', () => {
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(app, /ice_breakers: \{ src: 'ice_breakers', page: \(\) => IceBreakersCard, routable: false \}/);
        assert.ok(existsSync('dashboard/js/pages/ice_breakers.js'));
    });

    it('Settings asks for the card, and loads its module, for the tenant\'s owner only', () => {
        const settings = readFileSync('dashboard/js/pages/settings.js', 'utf8');
        assert.match(settings, /App\.canAdminister\(\) \? API\.getIceBreakers\(\) : Promise\.resolve\(null\)/);
        assert.match(settings, /App\.canAdminister\(\) \? App\.loadPageModule\('ice_breakers'\) : Promise\.resolve\(null\)/);
        // Who sees the card is the card map's (UX US10): the tenant's owner only, in Messages & alerts.
        assert.match(settings, /case 'iceb': return this\.iceBreakersSection\(ctx\.iceBreakers, ctx\.iceBreakersError\);/);
        const card = Array.from(load().Settings.CARDS as Array<{ id: string; group: string; who: string }>).find((c) => c.id === 'iceb')!;
        assert.deepEqual({ group: card.group, who: card.who }, { group: 'messages', who: 'owner' });
    });

    it('the card never calls Publish, Remove or Read except from a handler a person triggers: no timer, no load-time call', () => {
        const source = readFileSync('dashboard/js/pages/ice_breakers.js', 'utf8');
        assert.ok(!/setTimeout|setInterval/.test(source), 'nothing is scheduled');
        const s = load();
        s.Card.section(synced());
        assert.equal(s.calls.length, 0, 'drawing the card calls no API at all');
    });
});
