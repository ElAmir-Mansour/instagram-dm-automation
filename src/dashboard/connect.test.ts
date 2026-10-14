/**
 * Connecting Instagram and Facebook from the dashboard (P28), and the notice when it needs renewing (P29): the Settings card, the Page
 * picker, wizard step W4, the Overview alert, and the address the Meta callback sends a person with several Pages to.
 *
 * The real dashboard files run in a `node:vm` context (the real dictionaries too, so what is asserted is what a person reads), as in
 * welcome.test.ts and escaping.test.ts. What is pinned, because each is a way these screens hurt somebody:
 *
 *   - **Escaping.** A Page's name, an Instagram handle, the Facebook account's name, an id, a display name, a message from the server:
 *     each is text or a quoted attribute, on every state of every screen, and the one address the page navigates to is checked.
 *   - **What each state offers.** Not connected, connected, needs attention (and why), the operator's own token connection (never a
 *     Disconnect, a confirm before Reconnect), a member who is not the owner (no buttons), "not switched on" and "not set up" (no button
 *     at all). The operator's two fields appear for a platform admin and for nobody else.
 *   - **`return_to`.** A flow the wizard begins carries `welcome` (and `settings` for an admin filling the wizard in for somebody), the
 *     TikTok and YouTube buttons pass it too, and what a return trip said is read before the first paint rewrites the address.
 *   - **The Page picker.** One usable Page is preselected, a Page with no Instagram connects Facebook only (and says so), a replacement
 *     needs a tick, an expired pick is a way to start again, and what is sent is exactly what was chosen.
 *   - **W4 never blocks.** It is in the order only when the server says so, Continue and Skip send nothing to the profile, and the test
 *     comment's poll stops when the step is left, when the comment arrives, after ten minutes, and when the session dies.
 *   - **The Overview notice** is said once, only for a stored "reconnect due", and never for a connection that failed to load.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { defaultProfile } from '../services/profile/defaults.js';
import { WIZARD_STEPS } from '../services/onboardingWizard.js';

// ─── The sandbox ─────────────────────────────────────────────────────────────────────────────────

function element(initial: string[] = []): Record<string, any> {
    const classes = new Set(initial);
    const attrs: Record<string, string> = {};
    return {
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
}

interface Load {
    ctx: Record<string, any>;
    elements: Record<string, Record<string, any>>;
    MetaConnect: any;
    SettingsPage: any;
    WelcomePage: any;
    OverviewPage: any;
    App: any;
    UI: any;
    Admin: any;
    esc: (value: unknown) => string;
    html: (s: TemplateStringsArray, ...v: unknown[]) => { toString(): string };
    calls: Array<{ fn: string; args: any[] }>;
    toasts: Array<{ message: string; type: string }>;
    modals: string[];
    closed: { count: number; order: string[] };
    intervals: Array<{ fn: () => void; ms: number; cleared: boolean }>;
    location: { hash: string; pathname: string; search: string; href?: string };
    history: { calls: string[] };
    t: (key: string, params?: Record<string, unknown>) => string;
}

function load(options: {
    lang?: 'ar' | 'en'; hash?: string; role?: 'owner' | 'operator' | 'viewer' | 'platform_admin';
    api?: Record<string, (...a: any[]) => any>; hidden?: boolean;
} = {}): Load {
    const lang = options.lang ?? 'en';
    const noop = (): void => {};
    const elements: Record<string, Record<string, any>> = {
        'login-screen': element(), app: element(['hidden']), 'invite-screen': element(['hidden']), 'welcome-screen': element(['hidden']), 'welcome-root': element(),
        'login-error': element(['hidden']), 'page-container': element(), 'welcome-next': element(), 'welcome-save': element(), 'welcome-form': element(),
        'connect-check-state': element(), 'modal-overlay': element(['hidden']), 'modal-content': element(),
    };
    const stubEl = { ...element() };
    const location: Load['location'] = { hash: options.hash ?? '', pathname: '/dashboard', search: '' };
    const history = {
        calls: [] as string[],
        replaceState(_s: unknown, _t: string, url: string) { this.calls.push(`replace ${url}`); location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; },
        pushState(_s: unknown, _t: string, url: string) { this.calls.push(`push ${url}`); location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; },
    };
    const calls: Load['calls'] = [];
    const overrides = options.api ?? {};
    const target: Record<string, any> = { token: 'token', setToken: noop, clearToken: noop };
    const api = new Proxy(target, {
        get(obj, name: string) {
            if (name in obj) return obj[name];
            return (...args: any[]) => {
                calls.push({ fn: name, args });
                return overrides[name] ? overrides[name]!(...args) : Promise.resolve({});
            };
        },
    });
    const intervals: Load['intervals'] = [];
    const ctx: Record<string, any> = {
        document: {
            ...stubEl,
            createElement: () => ({ ...element() }),
            body: { ...element() }, head: { ...element() },
            documentElement: { ...element(), lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => elements[id] ?? null, activeElement: null, currentScript: null, hidden: options.hidden === true,
            querySelector: () => null, querySelectorAll: () => [], contains: () => true, addEventListener: noop,
        },
        window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location, scrollTo: noop, innerHeight: 800 },
        location, history, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        Intl, console, setTimeout, clearTimeout, URL, URLSearchParams, FormData: class { forEach(): void {} },
        setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms, cleared: false }); return intervals.length; },
        clearInterval: (id: number) => { if (intervals[id - 1]) intervals[id - 1]!.cleared = true; },
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' },
        crypto: { getRandomValues: (a: Uint8Array) => a },
        CSS: { escape: (v: string) => String(v) },
        API: api,
        Charts: new Proxy({}, { get: () => noop }),
        // Whatever the pages ask of the motion layer that this file does not care about is a no-op.
        Motion: new Proxy({ announce: noop, transition: (f: () => void) => { f(); return Promise.resolve(); }, beginLoad: () => ({ done: noop }), cardGrid: () => '', busy: () => '' } as Record<string, any>, {
            get: (obj, name: string) => (name in obj ? obj[name] : noop),
        }),
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const file of [
        'dashboard/js/i18n.js', `dashboard/js/i18n.${lang}.js`, 'dashboard/js/components.js', 'dashboard/js/pages/admin_common.js', 'dashboard/js/pages/meta_connect.js',
        'dashboard/js/pages/settings.js', 'dashboard/js/pages/welcome.js', 'dashboard/js/pages/overview.js', 'dashboard/js/app.js',
    ]) {
        vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
    }
    vm.runInContext(`I18N.lang = '${lang}'`, ctx);

    const toasts: Load['toasts'] = [];
    const modals: string[] = [];
    const closed = { count: 0, order: [] as string[] };
    const out = vm.runInContext('({ MetaConnect, SettingsPage, WelcomePage, OverviewPage, App, UI, Admin, esc, html, t })', ctx) as Omit<Load, 'ctx' | 'elements' | 'calls' | 'toasts' | 'modals' | 'closed' | 'intervals' | 'location' | 'history'>;
    out.UI.toast = (message: string, type = 'success') => { toasts.push({ message, type }); };
    out.UI.showModal = (markup: unknown) => { modals.push(String(markup)); closed.order.push('open'); };
    out.UI.closeModal = () => { closed.count++; closed.order.push('close'); };
    out.UI.actionBusy = () => () => undefined;
    out.UI.formBusy = () => () => undefined;
    out.UI.captureFocus = () => ({});
    out.UI.restoreFocus = () => undefined;
    out.UI.icons = () => undefined;
    // The role the session holds: what `App.canAdminister()` and `App.isAdmin()` read.
    const role = options.role ?? 'owner';
    out.App.session = {
        userId: 'u1', role: role === 'platform_admin' ? 'platform_admin' : 'user', tenantId: 't1',
        tenantRole: role === 'platform_admin' ? 'owner' : role, tenants: [], onboarding: null, available: true,
    };
    return { ctx, elements, calls, toasts, modals, closed, intervals, location, history, ...out };
}

const plain = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

const PAYLOAD = '<img src=x onerror=alert(document.cookie)>';
const QUOTE_BREAK = '"><script>alert(1)</script><x y="';

/** No live tag, no live handler: the payload is text. */
function assertInert(markup: string, label: string): void {
    assert.ok(!markup.includes('<img src=x'), `${label}: no live img tag`);
    assert.ok(!markup.includes('<script'), `${label}: no live script tag`);
    assert.ok(!/\son[a-z]+\s*=/i.test(markup.replace(/&lt;[^<>]*/g, '')), `${label}: no live handler`);
    assert.ok(!/"\s*>\s*<(script|img|x)\b/i.test(markup), `${label}: nothing broke out of an attribute`);
    assert.ok(!/javascript:/i.test(markup), `${label}: no javascript: address`);
}

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(Date.now() + ms).toISOString();
const PICK = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';

/** `GET /api/meta/connection`, for a tenant in each state. */
function resp(over: Record<string, any> = {}, connection: Record<string, any> | null = null): Record<string, any> {
    return {
        enabled: true, appConfigured: true, redirectUriConfigured: true, usesConfiguration: true,
        connection: {
            connected: false, via: null, pageId: null, pageName: null, instagramId: null, instagramUsername: null, connectedAt: null,
            webhookSubscribed: false, webhookSubscribedAt: null, tokenStatus: null, tokenError: null, tokenLastCheckedAt: null,
            tokenExpiresAt: null, dataAccessExpiresAt: null, reconnectDue: false, reconnectReason: null, ...(connection ?? {}),
        },
        ...over,
    };
}
const connectedLogin = (over: Record<string, any> = {}) => resp({}, {
    connected: true, via: 'login', pageId: '200000000000001', pageName: 'Nour Shop', instagramId: '17841400000000001', instagramUsername: 'nourshop',
    connectedAt: iso(-3 * DAY), webhookSubscribed: true, webhookSubscribedAt: iso(-3 * DAY), tokenStatus: 'valid', dataAccessExpiresAt: iso(80 * DAY), ...over,
});
const connectedToken = (over: Record<string, any> = {}) => resp({}, {
    connected: true, via: 'token', pageId: '100000000000001', pageName: null, instagramId: '17841499999999991', instagramUsername: null,
    connectedAt: null, webhookSubscribed: false, tokenStatus: 'valid', ...over,
});

const card = (s: Load, r: Record<string, any>, opts: Record<string, any> = {}): string => String(s.MetaConnect.settingsBody(r, opts));
const button = (markup: string, id: string): string => (new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(markup) ?? [''])[0]!;

// ─── What the server says ────────────────────────────────────────────────────────────────────────

describe('the words for what the server says', () => {
    const s = load();
    const M = s.MetaConnect;

    it('turns a reason code, in either spelling, into its own sentence, and an unknown one into the generic sentence (never the code)', () => {
        assert.equal(M.reasonText('not_tester'), s.t('meta.reason.not_tester'));
        assert.equal(M.reasonText('NOT_TESTER'), s.t('meta.reason.not_tester'), 'a JSON route answers upper case');
        assert.equal(M.reasonText('META_LOGIN_DISABLED'), s.t('meta.reason.disabled'));
        assert.equal(M.reasonText('something_new'), s.t('meta.reason.generic'));
        assert.equal(M.reasonText(undefined), s.t('meta.reason.generic'));
        assert.ok(!M.reasonText('<img src=x>').includes('<img'));
    });

    it('has a sentence in both languages for every reason and every warning it knows', () => {
        for (const lang of ['en', 'ar'] as const) {
            const l = load({ lang });
            for (const reason of l.MetaConnect.REASONS) assert.notEqual(l.t(`meta.reason.${reason}`), `meta.reason.${reason}`, `${lang}: ${reason}`);
            for (const warning of l.MetaConnect.WARNINGS) assert.notEqual(l.t(`meta.warning.${warning}`), `meta.warning.${warning}`, `${lang}: ${warning}`);
            assert.notEqual(l.t('meta.reason.generic'), 'meta.reason.generic');
        }
    });

    it('reads a failed request as the sentence for its code, else what the server said', () => {
        assert.equal(M.errorText({ body: { code: 'PAGE_IN_USE' }, message: 'x' }), s.t('meta.reason.page_in_use'));
        assert.equal(M.errorText({ body: { code: 'WHO_KNOWS' }, message: 'Nope.' }), 'Nope.');
        assert.equal(M.errorText(null), s.t('meta.reason.generic'));
    });

    it('reads a return from Meta from the address: connected (with only the warnings it knows), an error, or a pick it can trust', () => {
        const from = (params: Record<string, string>) => plain(M.readReturn((name: string) => params[name] ?? ''));
        assert.deepEqual(from({ meta: 'connected', warn: 'subscribe_failed,mystery,missing_scopes' }), { outcome: 'connected', warnings: ['subscribe_failed', 'missing_scopes'] });
        assert.deepEqual(from({ meta: 'connected' }), { outcome: 'connected', warnings: [] });
        assert.deepEqual(from({ meta: 'error', reason: 'not_tester' }), { outcome: 'error', reason: 'not_tester' });
        assert.deepEqual(from({ meta: 'error', reason: '<b>' }), { outcome: 'error', reason: '' });
        assert.deepEqual(from({ meta: 'pick', pick: PICK }), { outcome: 'pick', pick: PICK });
        assert.equal(from({ meta: 'pick', pick: 'short' }), null, 'a pick that does not look like ours never reaches a request');
        assert.equal(from({ meta: 'pick', pick: `${PICK}"><x` }), null);
        assert.equal(from({ meta: 'whatever' }), null);
        assert.equal(from({}), null);
    });
});

describe('what state a connection is in', () => {
    const s = load();
    const M = s.MetaConnect;

    it('is none, ok or attention, from what is stored', () => {
        assert.equal(M.connectionState(resp()), 'none');
        assert.equal(M.connectionState(null), 'none');
        assert.equal(M.connectionState(connectedLogin()), 'ok');
        assert.equal(M.connectionState(connectedLogin({ reconnectDue: true, reconnectReason: 'expiring' })), 'attention');
        assert.equal(M.connectionState(connectedLogin({ tokenStatus: 'invalid' })), 'attention', 'a token Meta rejected needs attention even before the flag');
        assert.equal(M.connectionState(connectedToken()), 'ok', 'the owner\'s token connection, valid');
    });

    it('says why: Meta no longer accepts it, or its access is about to lapse', () => {
        assert.equal(M.attentionReason({ tokenStatus: 'invalid' }), 'invalid');
        assert.equal(M.attentionReason({ reconnectReason: 'invalid' }), 'invalid');
        assert.equal(M.attentionReason({ reconnectReason: 'expiring', tokenStatus: 'valid' }), 'expiring');
    });

    it('asks Facebook to renew (`reauthorize`) only for a connection that is about to lapse, and for nothing special otherwise', () => {
        assert.equal(M.reconnectAuthType(connectedLogin({ reconnectDue: true, reconnectReason: 'expiring' }).connection), 'reauthorize');
        assert.equal(M.reconnectAuthType(connectedLogin({ reconnectDue: true, reconnectReason: 'invalid', tokenStatus: 'invalid' }).connection), '');
        assert.equal(M.reconnectAuthType(connectedLogin().connection), '');
        assert.equal(M.reconnectAuthType(resp().connection), '');
    });

    it('may start only when the switch is on, the app is set up and there is an address to come back to', () => {
        assert.equal(M.canStart(resp()), true);
        for (const off of [{ enabled: false }, { appConfigured: false }, { redirectUriConfigured: false }]) assert.equal(M.canStart(resp(off)), false, JSON.stringify(off));
        assert.equal(M.canStart(null), false);
    });
});

// ─── The Settings card ───────────────────────────────────────────────────────────────────────────

describe('the Settings card: what each state offers', () => {
    const s = load();

    it('not connected: a Connect button that returns to Settings and asks for no reconnect', () => {
        const markup = card(s, resp());
        const b = button(markup, 'meta-connect');
        assert.match(b, /data-action="metaconnect:connect"/);
        assert.match(b, /data-return-to="settings"/);
        assert.match(b, /data-reconnect="false"/);
        assert.doesNotMatch(b, /data-auth-type/);
        assert.ok(markup.includes(s.t('meta.intro')));
        assert.doesNotMatch(markup, /meta-disconnect/);
    });

    it('not switched on, or not set up: says so, and offers no button at all', () => {
        for (const [over, copy] of [[{ enabled: false }, 'meta.off'], [{ appConfigured: false }, 'meta.notSetUp'], [{ redirectUriConfigured: false }, 'meta.notSetUp']] as Array<[Record<string, any>, string]>) {
            const markup = card(s, resp(over));
            assert.ok(markup.includes(s.t(copy)), copy);
            assert.doesNotMatch(markup, /<button/);
        }
    });

    it('not the owner: says so, and offers nothing, connected or not', () => {
        for (const r of [resp(), connectedLogin(), connectedToken()]) {
            const markup = card(s, r, { canAdminister: false });
            assert.doesNotMatch(markup, /<button/);
            assert.ok(markup.includes(s.t('meta.ownerOnly')));
        }
    });

    it('connected with Login: the Page, the handle, the date, the webhook, Reconnect and Disconnect', () => {
        const markup = card(s, connectedLogin());
        assert.ok(markup.includes('Nour Shop'));
        assert.match(markup, /<bdi dir="ltr">@nourshop<\/bdi>/);
        assert.ok(markup.includes(s.UI.formatDay(connectedLogin().connection.connectedAt)));
        assert.ok(markup.includes(s.t('meta.webhook.on')));
        assert.ok(markup.includes(s.t('meta.via.login')));
        assert.ok(markup.includes(s.t('meta.status.ok')));
        assert.doesNotMatch(markup, /meta-notice/, 'nothing needs attention');
        assert.match(button(markup, 'meta-connect'), /data-action="metaconnect:connect"[^>]*data-reconnect="true"|data-reconnect="true"[^>]*data-action="metaconnect:connect"/);
        assert.match(button(markup, 'meta-connect'), /btn-secondary/);
        assert.match(button(markup, 'meta-disconnect'), /btn-danger/);
        assert.match(button(markup, 'meta-disconnect'), /data-action="metaconnect:askDisconnect"/);
    });

    it('connected with Login but the webhook not subscribed: a warning pill and what to do', () => {
        const markup = card(s, connectedLogin({ webhookSubscribed: false, webhookSubscribedAt: null }));
        assert.ok(markup.includes(s.t('meta.webhook.off')));
        assert.ok(markup.includes(s.t('meta.webhook.offHint')));
        assert.match(markup, /health-stale/);
    });

    it('needs attention because Meta no longer accepts it: a notice, and Reconnect is the primary action (no auth_type)', () => {
        const markup = card(s, connectedLogin({ tokenStatus: 'invalid', reconnectDue: true, reconnectReason: 'invalid' }));
        assert.match(markup, /meta-notice is-warning/);
        assert.ok(markup.includes(s.t('meta.attention.invalid')));
        assert.ok(markup.includes(s.t('meta.status.attention')));
        assert.match(button(markup, 'meta-connect'), /btn-primary/);
        assert.doesNotMatch(button(markup, 'meta-connect'), /data-auth-type/);
    });

    it('needs attention because its access is about to lapse: the date, and Reconnect asks Facebook to renew', () => {
        const due = connectedLogin({ reconnectDue: true, reconnectReason: 'expiring', dataAccessExpiresAt: iso(9 * DAY) });
        const markup = card(s, due);
        assert.ok(markup.includes(s.t('meta.attention.expiring', { date: s.UI.formatDay(due.connection.dataAccessExpiresAt) })));
        assert.match(button(markup, 'meta-connect'), /data-auth-type="reauthorize"/);
        assert.match(button(markup, 'meta-connect'), /btn-primary/);
    });

    it('the operator\'s own token connection: shown as that, never offered a Disconnect, and a confirm comes before Reconnect', () => {
        const markup = card(s, connectedToken());
        assert.doesNotMatch(markup, /meta-disconnect/);
        assert.ok(markup.includes(s.t('meta.tokenNote')));
        assert.ok(markup.includes(s.t('meta.via.token')));
        assert.ok(markup.includes(s.t('meta.webhook.byOperator')), 'its webhook is set up in Meta\'s dashboard: not "not subscribed"');
        assert.ok(!markup.includes(s.t('meta.webhook.off')));
        assert.match(button(markup, 'meta-connect'), /data-action="metaconnect:askReconnect"/);
    });

    it('the operator\'s token connection with Login switched off: no Connect, no Reconnect, no Disconnect', () => {
        for (const over of [{ enabled: false }, { appConfigured: false }, { redirectUriConfigured: false }]) {
            const off = card(s, { ...connectedToken(), ...over });
            assert.doesNotMatch(off, /<button/, JSON.stringify(over));
            assert.ok(off.includes(s.t('meta.tokenNote')), 'it is still shown for what it is');
            assert.ok(off.includes(s.t('meta.status.ok')));
        }
        // …and with something about to go wrong, it says why there is no button.
        const due = card(s, { ...connectedToken({ tokenStatus: 'invalid' }), enabled: false });
        assert.ok(due.includes(s.t('meta.reconnectOff')));
    });

    it('a load failure is a sentence and Retry, never a blank card', () => {
        const markup = String(s.MetaConnect.settingsSection({ meta: null, metaError: new Error('boom'), canAdminister: true, isAdmin: false }));
        assert.ok(markup.includes(s.t('meta.loadFailed', { message: 'boom' })));
        assert.match(markup, /data-action="settings:render"/);
        assert.match(markup, /id="settings-meta"/);
    });

    it('wraps the card in a section with the title, and adds the operator\'s block only for a platform admin', () => {
        const app = { enabled: false, configId: { set: false, source: null, value: null }, mode: 'scope', app: { idSet: true, secretSet: true }, publicBaseUrl: 'https://autoreply.example', register: { redirectUri: 'https://autoreply.example/api/meta/callback' } };
        const plainUser = String(s.MetaConnect.settingsSection({ meta: resp(), app, canAdminister: true, isAdmin: false }));
        const admin = String(s.MetaConnect.settingsSection({ meta: resp(), app, canAdminister: true, isAdmin: true }));
        assert.ok(plainUser.includes(s.esc(s.t('meta.title'))));
        assert.doesNotMatch(plainUser, /meta-app-form/);
        assert.match(admin, /id="meta-app-form"[^>]*data-submit="metaconnect:saveApp"/);
        assert.ok(admin.includes('https://autoreply.example/api/meta/callback'));
    });
});

describe('the operator\'s fields', () => {
    const s = load({ role: 'platform_admin' });
    const base = {
        enabled: true, configId: { set: true, source: 'database', value: '987654321098765' }, mode: 'configuration',
        app: { idSet: true, secretSet: true }, publicBaseUrl: 'https://autoreply.example',
        register: { redirectUri: 'https://autoreply.example/api/meta/callback' },
    };

    it('shows the switch as saved, the configuration id as typed, and what to register in Meta\'s dashboard', () => {
        const markup = String(s.MetaConnect.appBlock(base));
        assert.match(markup, /<input type="checkbox" id="meta-app-enabled" name="enabled" checked/);
        assert.match(markup, /name="configId"[^>]*value="987654321098765"/);
        assert.ok(markup.includes('https://autoreply.example/api/meta/callback'));
        assert.ok(markup.includes(s.t('meta.app.modeConfiguration')));
        assert.doesNotMatch(markup, /<details[^>]* open/, 'set up: collapsed');
    });

    it('is open and says what is missing until the app is set up', () => {
        const markup = String(s.MetaConnect.appBlock({ ...base, enabled: false, app: { idSet: false, secretSet: false }, publicBaseUrl: null, register: null, configId: { set: false, source: null, value: null }, mode: 'scope' }));
        assert.match(markup, /<details[^>]* open/);
        assert.ok(markup.includes(s.t('meta.app.noApp')));
        assert.ok(markup.includes(s.t('meta.app.noBaseUrl')));
        assert.ok(markup.includes(s.t('meta.app.modeScope')));
        assert.doesNotMatch(markup, /checked/);
    });

    it('does not put an id that comes from the environment in the field, and says where it comes from', () => {
        const markup = String(s.MetaConnect.appBlock({ ...base, configId: { set: true, source: 'env', value: '111222333444555' } }));
        assert.doesNotMatch(markup, /value="111222333444555"/);
        assert.ok(markup.includes(s.t('meta.app.configFromEnv')));
    });

    it('says when it could not be loaded, and draws nothing when there is nothing', () => {
        assert.ok(String(s.MetaConnect.appBlock(null, new Error('nope'))).includes(s.t('meta.app.loadFailed', { message: 'nope' })));
        assert.equal(String(s.MetaConnect.appBlock(null)), '');
    });

    it('refuses an id that is not digits before asking the server, and sends the switch and the id (both, always) when it is', async () => {
        const l = load({ role: 'platform_admin', api: { saveMetaAppSettings: () => Promise.resolve({ success: true }) } });
        const formOf = (data: Record<string, string>) => ({ _data: data, querySelectorAll: () => [] });
        let form = formOf({ configId: 'abc', enabled: 'on' });
        const host = l.elements['meta-app-error'] = element();
        l.ctx.FormData = class { constructor(f: { _data: Record<string, string> }) { this.f = f; } f: { _data: Record<string, string> }; get(k: string) { return this.f._data[k] ?? null; } };
        l.elements['meta-app-config'] = element();
        await l.MetaConnect.saveApp(form, { preventDefault: () => undefined });
        assert.equal(l.calls.filter((c) => c.fn === 'saveMetaAppSettings').length, 0, 'not asked');
        assert.ok(String(host.innerHTML).includes(l.t('meta.app.invalidConfigId')));

        form = formOf({ configId: '987654321098765', enabled: 'on' });
        l.MetaConnect.afterChange = () => undefined;
        await l.MetaConnect.saveApp(form, { preventDefault: () => undefined });
        assert.deepEqual(plain(l.calls.find((c) => c.fn === 'saveMetaAppSettings')!.args[0]), { enabled: true, configId: '987654321098765' });
        form = formOf({ configId: '' });
        await l.MetaConnect.saveApp(form, { preventDefault: () => undefined });
        assert.deepEqual(plain(l.calls.filter((c) => c.fn === 'saveMetaAppSettings')[1]!.args[0]), { enabled: false, configId: '' }, 'an unticked box is a real "off", an empty id a real "back to the default"');
    });
});

// ─── Escaping ────────────────────────────────────────────────────────────────────────────────────

describe('everything the server or Meta supplied is text', () => {
    const hostileConnection = connectedLogin({
        pageName: PAYLOAD, instagramUsername: QUOTE_BREAK, pageId: PAYLOAD, instagramId: QUOTE_BREAK, connectedAt: PAYLOAD,
        dataAccessExpiresAt: PAYLOAD, tokenError: PAYLOAD,
    });

    for (const lang of ['en', 'ar'] as const) {
        const s = load({ lang });

        it(`${lang}: the card, in every state, with a payload in every field`, () => {
            for (const conn of [
                hostileConnection,
                { ...hostileConnection, connection: { ...hostileConnection.connection, tokenStatus: 'invalid', reconnectDue: true, reconnectReason: 'invalid' } },
                { ...hostileConnection, connection: { ...hostileConnection.connection, reconnectDue: true, reconnectReason: 'expiring' } },
                { ...hostileConnection, connection: { ...hostileConnection.connection, via: 'token', pageName: PAYLOAD, instagramUsername: null } },
                { ...hostileConnection, connection: { ...hostileConnection.connection, webhookSubscribed: false } },
            ]) {
                assertInert(card(s, conn), `${lang} card`);
            }
            assertInert(String(s.MetaConnect.settingsSection({ meta: null, metaError: new Error(PAYLOAD), canAdminister: true, isAdmin: false })), `${lang} load failure`);
        });

        it(`${lang}: the operator's block`, () => {
            const markup = String(s.MetaConnect.appBlock({
                enabled: true, configId: { set: true, source: 'database', value: QUOTE_BREAK }, mode: 'configuration', app: { idSet: true, secretSet: true },
                publicBaseUrl: PAYLOAD, register: { redirectUri: PAYLOAD }, scopes: [PAYLOAD],
            }));
            assertInert(markup, `${lang} app block`);
            assertInert(String(s.MetaConnect.appBlock(null, new Error(PAYLOAD))), `${lang} app block failure`);
        });

        it(`${lang}: the picker`, () => {
            const data = {
                pick: PAYLOAD, expiresAt: PAYLOAD, returnTo: 'welcome', reconnect: false, connectedAs: { name: PAYLOAD }, current: null,
                candidates: [
                    { pageId: PAYLOAD, name: PAYLOAD, instagram: { id: QUOTE_BREAK, username: PAYLOAD }, usable: true, reason: null, replaces: true },
                    { pageId: QUOTE_BREAK, name: QUOTE_BREAK, instagram: null, usable: false, reason: 'no_role', replaces: false },
                    { pageId: '3', name: PAYLOAD, instagram: { id: '9', username: null }, usable: true, reason: null, replaces: false },
                ],
            };
            for (const selected of [null, PAYLOAD, '3']) {
                assertInert(String(s.MetaConnect.pickerMarkup({ data, selected, confirm: false, busy: false, expired: false, returnTo: 'welcome' })), `${lang} picker (${selected})`);
            }
        });
    }
});

// ─── Connect, Reconnect, Disconnect ──────────────────────────────────────────────────────────────

describe('Connect, Reconnect and Disconnect', () => {
    const FACEBOOK = 'https://www.facebook.com/v26.0/dialog/oauth?client_id=1&state=abc';
    const btn = (data: Record<string, string> = {}) => ({ dataset: data, disabled: false });

    it('asks the server for the dialog and goes there, with where to return to, whether it is a reconnect, and the auth type', async () => {
        const l = load({ api: { startMetaConnect: () => Promise.resolve({ url: FACEBOOK }) } });
        await l.MetaConnect.connect(btn({ returnTo: 'welcome', reconnect: 'true', authType: 'reauthorize' }));
        assert.deepEqual(plain(l.calls[0]!.args[0]), { returnTo: 'welcome', reconnect: true, authType: 'reauthorize' });
        assert.equal(l.location.href, FACEBOOK);
        await l.MetaConnect.connect(btn({}));
        assert.deepEqual(plain(l.calls[1]!.args[0]), { returnTo: 'settings', reconnect: false }, 'nothing it was not asked for');
    });

    it('never follows an address that is not Facebook\'s dialog, and says the connect failed', async () => {
        for (const url of ['https://evil.example/dialog', 'http://www.facebook.com/x', 'javascript:alert(1)', 'https://www.facebook.com.evil.example/x', undefined, 5]) {
            const l = load({ api: { startMetaConnect: () => Promise.resolve({ url }) } });
            await l.MetaConnect.connect(btn({ returnTo: 'settings' }));
            assert.equal(l.location.href, undefined, `${String(url)}: not followed`);
            assert.equal(l.toasts.at(-1)!.type, 'error');
        }
    });

    it('ignores an auth type it does not know, and a disabled button', async () => {
        const l = load({ api: { startMetaConnect: () => Promise.resolve({ url: FACEBOOK }) } });
        await l.MetaConnect.connect(btn({ authType: 'delete-everything' }));
        assert.equal('authType' in plain<Record<string, unknown>>(l.calls[0]!.args[0]), false);
        await l.MetaConnect.connect({ dataset: {}, disabled: true });
        assert.equal(l.calls.length, 1);
    });

    it('says why a refused connect was refused, in words', async () => {
        const l = load({ api: { startMetaConnect: () => Promise.reject(Object.assign(new Error('raw'), { body: { code: 'META_LOGIN_DISABLED' }, status: 409 })) } });
        await l.MetaConnect.connect(btn({}));
        assert.equal(l.toasts.at(-1)!.message, l.t('meta.reason.disabled'));
    });

    it('asks first before replacing a token an operator added, and goes on to connect when confirmed', async () => {
        const l = load({ api: { startMetaConnect: () => Promise.resolve({ url: FACEBOOK }) } });
        let asked: any = null;
        l.Admin.confirm = (options: any) => { asked = options; };
        l.MetaConnect.askReconnect(btn({ returnTo: 'settings', reconnect: 'true' }));
        assert.equal(asked.title, l.t('meta.reconnectTokenTitle'));
        assert.equal(asked.tone, 'primary');
        assert.equal(l.calls.length, 0, 'nothing is sent before the person confirms');
        await asked.onConfirm();
        assert.equal(l.location.href, FACEBOOK);
    });

    it('asks first before disconnecting (a danger confirm), and a confirmed disconnect repaints the host and says so', async () => {
        const l = load({ api: { disconnectMeta: () => Promise.resolve({ success: true }) } });
        let asked: any = null;
        l.Admin.confirm = (options: any) => { asked = options; };
        let repainted = 0;
        l.MetaConnect.afterChange = async () => { repainted++; };
        l.MetaConnect.askDisconnect(btn());
        assert.equal(asked.title, l.t('meta.disconnectTitle'));
        assert.equal(asked.confirmLabel, l.t('meta.disconnect'));
        assert.notEqual(asked.tone, 'primary', 'in red: it stops every reply');
        assert.equal(l.calls.length, 0, 'nothing is sent before the person confirms');
        await asked.onConfirm();
        assert.deepEqual(l.calls.map((c) => c.fn), ['disconnectMeta']);
        assert.equal(repainted, 1);
        assert.equal(l.toasts.at(-1)!.message, l.t('meta.disconnected'));
    });

    it('lets a refused disconnect show inside the confirm dialog, in words', async () => {
        const l = load({ api: { disconnectMeta: () => Promise.reject(Object.assign(new Error('raw'), { body: { code: 'NOT_CONNECTED' } })) } });
        await assert.rejects(l.MetaConnect.disconnectConfirmed(), new RegExp(l.t('meta.reason.not_connected')));
    });
});

// ─── The Page picker ─────────────────────────────────────────────────────────────────────────────

describe('the Page picker', () => {
    const candidates = (extra: Array<Record<string, any>> = []) => [
        { pageId: '200000000000001', name: 'Nour Shop', instagram: { id: '178', username: 'nourshop' }, usable: true, reason: null, replaces: false },
        { pageId: '200000000000002', name: 'Nour Blog', instagram: null, usable: true, reason: null, replaces: false },
        { pageId: '200000000000003', name: 'Not Mine', instagram: { id: '179', username: 'notmine' }, usable: false, reason: 'no_role', replaces: false },
        ...extra,
    ];
    const data = (over: Record<string, any> = {}) => ({
        pick: PICK, expiresAt: iso(10 * 60_000), returnTo: 'settings', reconnect: false, connectedAs: { name: 'Nour Mansour' }, current: null, candidates: candidates(), ...over,
    });
    const state = (s: Load, over: Record<string, any> = {}) => ({ data: data(), selected: null, confirm: false, busy: false, expired: false, returnTo: 'settings', ...over });

    it('lists every Page as a radio card, the ones the person cannot run disabled and saying why, and starts with nothing chosen', () => {
        const s = load();
        const markup = String(s.MetaConnect.pickerMarkup(state(s)));
        assert.equal((markup.match(/type="radio"/g) ?? []).length, 3);
        assert.equal((markup.match(/type="radio"[^>]*disabled/g) ?? []).length, 1);
        assert.ok(markup.includes(s.t('meta.pick.noRole')));
        assert.ok(markup.includes(s.t('meta.pick.noInstagram')));
        assert.match(markup, /<bdi dir="ltr">@nourshop<\/bdi>/);
        assert.ok(markup.includes('Nour Mansour'));
        assert.doesNotMatch(markup, /type="radio"[^>]*checked/);
        assert.match(markup, /id="meta-pick-go"[^>]*disabled/, 'nothing chosen: nothing to connect');
        assert.match(markup, /role="radiogroup"/);
    });

    it('connects Facebook only for a Page with no Instagram account, and says so before and on the button', () => {
        const s = load();
        const pick = state(s, { selected: '200000000000002' });
        assert.ok(String(s.MetaConnect.pickExtra(pick)).includes(s.t('meta.pick.noInstagramHelp')));
        assert.equal(s.MetaConnect.pickGoLabel(pick), s.t('meta.pick.goFacebookOnly'));
        assert.equal(s.MetaConnect.pickReady(pick), true);
        const withInstagram = state(s, { selected: '200000000000001' });
        assert.equal(s.MetaConnect.pickGoLabel(withInstagram), s.t('meta.pick.go'));
        assert.equal(String(s.MetaConnect.pickExtra(withInstagram)).trim(), '');
    });

    it('does not let a Page the person cannot run be chosen, even by an address typed into the form', () => {
        const s = load();
        assert.equal(s.MetaConnect.chosen(state(s, { selected: '200000000000003' })), null);
        assert.equal(s.MetaConnect.pickReady(state(s, { selected: '200000000000003' })), false);
        assert.equal(s.MetaConnect.pickReady(state(s, { selected: 'nope' })), false);
    });

    it('needs a tick before a replacement, and the tick is cleared by choosing another Page', () => {
        const s = load();
        const replacing = data({ candidates: candidates([{ pageId: '200000000000004', name: 'Replaces', instagram: { id: '1', username: 'r' }, usable: true, reason: null, replaces: true }]) });
        const pick: Record<string, any> = state(s, { data: replacing, selected: '200000000000004' });
        assert.ok(String(s.MetaConnect.pickExtra(pick)).includes(s.t('meta.pick.replaces')));
        assert.equal(s.MetaConnect.pickReady(pick), false, 'not until it is ticked');
        pick.confirm = true;
        assert.equal(s.MetaConnect.pickReady(pick), true);
        assert.equal(s.MetaConnect.pickReady({ ...pick, busy: true }), false, 'nor while a request is in flight');

        s.MetaConnect._pick = pick;
        s.MetaConnect.pickSelect({ value: '200000000000001' });
        assert.equal(s.MetaConnect._pick.confirm, false);
        assert.equal(s.MetaConnect._pick.selected, '200000000000001');
    });

    it('preselects the one usable Page, and nothing when there is a choice', async () => {
        const one = load({ api: { getMetaCandidates: () => Promise.resolve(data({ candidates: [candidates()[1]!, candidates()[2]!] })) } });
        await one.MetaConnect.openPicker(PICK, 'settings');
        assert.equal(one.MetaConnect._pick.selected, '200000000000002');
        const several = load({ api: { getMetaCandidates: () => Promise.resolve(data()) } });
        await several.MetaConnect.openPicker(PICK, 'settings');
        assert.equal(several.MetaConnect._pick.selected, null);
    });

    it('reads the Pages for the pick it was given, and refuses a pick that does not look like one of ours', async () => {
        const l = load({ api: { getMetaCandidates: () => Promise.resolve(data()) } });
        await l.MetaConnect.openPicker('not a pick', 'settings');
        await l.MetaConnect.openPicker(`${PICK}"><script>`, 'settings');
        assert.equal(l.calls.length, 0);
        assert.equal(l.modals.length, 0);
        await l.MetaConnect.openPicker(PICK, 'welcome');
        assert.deepEqual(l.calls.map((c) => c.fn), ['getMetaCandidates']);
        assert.equal(l.calls[0]!.args[0], PICK);
        assert.equal(l.modals.length, 1);
        assert.equal(l.MetaConnect._pick.returnTo, 'welcome');
    });

    it('shows a pick that is gone (expired, spent, somebody else\'s) as "expired", with a way to start again', async () => {
        const l = load({ api: { getMetaCandidates: () => Promise.reject(Object.assign(new Error('Not found.'), { status: 404 })) } });
        await l.MetaConnect.openPicker(PICK, 'settings');
        assert.equal(l.MetaConnect._pick.expired, true);
        assert.ok(l.modals[0]!.includes(l.t('meta.reason.pick_expired')));
        assert.match(l.modals[0]!, /id="meta-pick-again"/);
        assert.equal(l.toasts.length, 0, 'a 404 is the same answer for every kind of "gone": no alarm');
    });

    it('connects exactly what was chosen: the pick, the Page, Facebook only if it has no Instagram, a replacement only if it was ticked', async () => {
        const l = load({ api: { selectMetaPage: () => Promise.resolve({ success: true, result: { warnings: [] } }) } });
        const go = { disabled: false };
        const run = async (selected: string, extra: Record<string, any> = {}) => {
            l.MetaConnect._pick = state(l, { selected, ...extra });
            l.MetaConnect.afterChange = async () => undefined;
            await l.MetaConnect.pickGo(go);
        };
        await run('200000000000001');
        await run('200000000000002');
        const replacing = data({ candidates: candidates([{ pageId: '200000000000004', name: 'R', instagram: { id: '1', username: 'r' }, usable: true, reason: null, replaces: true }]) });
        await run('200000000000004', { data: replacing, confirm: true });
        const sent = l.calls.filter((c) => c.fn === 'selectMetaPage').map((c) => plain<Record<string, unknown>>(c.args[0]));
        assert.deepEqual(sent, [
            { pick: PICK, pageId: '200000000000001', facebookOnly: false, confirmPageChange: false },
            { pick: PICK, pageId: '200000000000002', facebookOnly: true, confirmPageChange: false },
            { pick: PICK, pageId: '200000000000004', facebookOnly: false, confirmPageChange: true },
        ]);
    });

    it('sends nothing when nothing usable is chosen, or a replacement is not ticked', async () => {
        const l = load({ api: { selectMetaPage: () => Promise.resolve({}) } });
        const replacing = data({ candidates: candidates([{ pageId: '200000000000004', name: 'R', instagram: { id: '1', username: 'r' }, usable: true, reason: null, replaces: true }]) });
        for (const pick of [state(l, { selected: null }), state(l, { selected: '200000000000003' }), state(l, { data: replacing, selected: '200000000000004', confirm: false })]) {
            l.MetaConnect._pick = pick;
            await l.MetaConnect.pickGo({ disabled: false });
        }
        assert.equal(l.calls.length, 0);
    });

    it('on success repaints the host FIRST and closes the dialog after, then says what is missing', async () => {
        const l = load({ api: { selectMetaPage: () => Promise.resolve({ success: true, result: { warnings: ['subscribe_failed', 'bogus'] } }) } });
        l.MetaConnect._pick = state(l, { selected: '200000000000001' });
        l.MetaConnect.afterChange = async () => { l.closed.order.push('repaint'); };
        await l.MetaConnect.pickGo({ disabled: false });
        assert.deepEqual(l.closed.order, ['repaint', 'close'], 'the order UI.closeModal\'s own docblock asks for');
        assert.equal(l.MetaConnect._pick, null);
        assert.equal(l.toasts[0]!.message, l.t('meta.connectedToast'));
        assert.equal(l.toasts[1]!.message, l.t('meta.warning.subscribe_failed'));
        assert.equal(l.toasts.length, 2, 'a warning it has no sentence for is not shown');
    });

    it('on a refusal keeps the dialog open and says why in it; a pick that expired meanwhile becomes the "start again" view', async () => {
        const refuse = (code: string) => Promise.reject(Object.assign(new Error('raw'), { body: { code }, status: 409 }));
        const l = load({ api: { selectMetaPage: () => refuse('PAGE_IN_USE') } });
        const host = l.elements['meta-pick-error'] = element();
        l.MetaConnect._pick = state(l, { selected: '200000000000001' });
        await l.MetaConnect.pickGo({ disabled: false });
        assert.ok(String(host.innerHTML).includes(l.t('meta.reason.page_in_use')));
        assert.equal(l.closed.count, 0, 'still open');
        assert.equal(l.MetaConnect._pick.busy, false, 'and usable again');

        const gone = load({ api: { selectMetaPage: () => refuse('PICK_EXPIRED') } });
        gone.MetaConnect._pick = state(gone, { selected: '200000000000001' });
        await gone.MetaConnect.pickGo({ disabled: false });
        assert.equal(gone.MetaConnect._pick.expired, true);
        assert.match(gone.modals.at(-1)!, /id="meta-pick-again"/);
    });

    it('"I don\'t see my Page" asks Facebook again for what was declined (auth_type=rerequest), keeping where to return to and the reconnect', async () => {
        const l = load({ api: { startMetaConnect: () => Promise.resolve({ url: 'https://www.facebook.com/v26.0/dialog/oauth?x=1' }) } });
        l.MetaConnect._pick = state(l, { data: data({ reconnect: true }), returnTo: 'welcome' });
        await l.MetaConnect.pickMissing({ disabled: false });
        assert.deepEqual(plain(l.calls[0]!.args[0]), { returnTo: 'welcome', reconnect: true, authType: 'rerequest' });
        assert.equal(l.location.href, 'https://www.facebook.com/v26.0/dialog/oauth?x=1');
        await l.MetaConnect.pickAgain({ disabled: false });
        assert.equal('authType' in plain<Record<string, unknown>>(l.calls[1]!.args[0]), false, 'starting again asks for nothing special');
    });

    it('does not follow an address that is not Facebook\'s from the picker either', async () => {
        const l = load({ api: { startMetaConnect: () => Promise.resolve({ url: 'https://evil.example/x' }) } });
        l.MetaConnect._pick = state(l, {});
        l.elements['meta-pick-error'] = element();
        await l.MetaConnect.pickMissing({ disabled: false });
        assert.equal(l.location.href, undefined);
    });

    it('forgets an open pick when the tenant changes', () => {
        const l = load();
        l.MetaConnect._pick = state(l, {});
        l.MetaConnect.afterChange = () => undefined;
        l.MetaConnect.resetTenantState();
        assert.equal(l.MetaConnect._pick, null);
        assert.equal(l.MetaConnect.afterChange, null);
    });
});

// ─── Where the callback sends a person with several Pages ────────────────────────────────────────

describe('the Page picker\'s address', () => {
    const { App } = load();

    it('becomes the screen that began the flow, with the pick still in it', () => {
        assert.equal(App.metaPickAddress(`#/connect-meta?meta=pick&pick=${PICK}&return_to=welcome`), `#/welcome?step=connect&meta=pick&pick=${PICK}`);
        assert.equal(App.metaPickAddress(`#/connect-meta?meta=pick&pick=${PICK}&return_to=settings`), `#/settings?meta=pick&pick=${PICK}`);
        assert.equal(App.metaPickAddress(`#/connect-meta?meta=pick&pick=${PICK}`), `#/settings?meta=pick&pick=${PICK}`, 'the default is Settings');
    });

    it('sends anything but `welcome` to Settings, and drops return_to', () => {
        assert.equal(App.metaPickAddress(`#/connect-meta?meta=pick&pick=${PICK}&return_to=evil`), `#/settings?meta=pick&pick=${PICK}`);
        assert.ok(!App.metaPickAddress(`#/connect-meta?return_to=welcome&meta=pick&pick=${PICK}`).includes('return_to'));
    });

    it('leaves every other address alone', () => {
        for (const hash of ['', '#/settings', '#/welcome?step=connect', '#/connect-meta', '#/connect-metax?a=1', `#/x/connect-meta?pick=${PICK}`, undefined]) {
            assert.equal(App.metaPickAddress(hash), null, String(hash));
        }
    });

    it('is rewritten in place (no history entry) before anything routes, on load and on a hash change', () => {
        const a = load({ hash: `#/connect-meta?meta=pick&pick=${PICK}&return_to=welcome` });
        a.App.settleMetaPickAddress();
        assert.deepEqual(a.history.calls, [`replace #/welcome?step=connect&meta=pick&pick=${PICK}`]);
        assert.equal(a.location.hash, `#/welcome?step=connect&meta=pick&pick=${PICK}`);
        const b = load({ hash: '#/settings' });
        b.App.settleMetaPickAddress();
        assert.deepEqual(b.history.calls, []);
    });

    it('is not a page: it never resolves to one', () => {
        const l = load({ hash: `#/connect-meta?meta=pick&pick=${PICK}` });
        assert.equal(l.App.pageFromHash(), 'overview');
        assert.equal(l.App.pages.meta_connect.routable, false);
    });
});

// ─── Settings: coming back ───────────────────────────────────────────────────────────────────────

describe('Settings, coming back from Facebook', () => {
    it('opens the picker for a pick, and drops the parameters from the address first', async () => {
        const l = load({ hash: `#/settings?meta=pick&pick=${PICK}`, api: { getMetaCandidates: () => Promise.resolve({ pick: PICK, candidates: [], connectedAs: null }) } });
        await l.SettingsPage.announceMetaReturn();
        assert.deepEqual(l.history.calls, ['replace /dashboard#/settings']);
        assert.deepEqual(l.calls.map((c) => c.fn), ['getMetaCandidates']);
        assert.equal(l.MetaConnect._pick.returnTo, 'settings');
    });

    it('says a connection once, with what is missing, and an error as its sentence', async () => {
        const ok = load({ hash: '#/settings?meta=connected&warn=missing_scopes' });
        await ok.SettingsPage.announceMetaReturn();
        assert.deepEqual(ok.toasts.map((x) => x.message), [ok.t('meta.connectedToast'), ok.t('meta.warning.missing_scopes')]);
        const bad = load({ hash: '#/settings?meta=error&reason=not_tester' });
        await bad.SettingsPage.announceMetaReturn();
        assert.deepEqual(bad.toasts, [{ message: bad.t('meta.reason.not_tester'), type: 'error' }]);
        const nothing = load({ hash: '#/settings' });
        await nothing.SettingsPage.announceMetaReturn();
        assert.equal(nothing.toasts.length, 0);
        assert.deepEqual(nothing.history.calls, []);
    });

    it('hands the card a repaint of this screen, and takes it back when the screen is left', () => {
        const l = load();
        const markup = String(l.SettingsPage.metaSection({ meta: resp(), metaError: null, metaApp: null, metaAppError: null }));
        assert.ok(markup.includes(l.esc(l.t('meta.title'))));
        assert.equal(typeof l.MetaConnect.afterChange, 'function');
        l.SettingsPage.destroy();
        assert.equal(l.MetaConnect.afterChange, null);
    });

    it('is a sentence and Retry, not a blank section, when the module could not be loaded', () => {
        const l = load();
        const markup = String(l.SettingsPage.metaFallback(new Error('module')));
        assert.ok(markup.includes(l.t('meta.loadFailed', { message: 'module' })));
        assert.match(markup, /data-action="settings:render"/);
    });
});

// ─── The wizard's step W4 ────────────────────────────────────────────────────────────────────────

const ORDER = WIZARD_STEPS.map((x) => ({ ...x }));
const withConnect = (steps: Record<string, unknown> = { about: { status: 'done' }, voice: { status: 'done' }, brand: { status: 'done' } }) => ({
    status: 'in_progress', step: 'connect', order: ORDER.map((x) => (x.id === 'connect' ? { ...x, enabled: true } : x)), steps,
    filledBy: null, profile: defaultProfile({ lang: 'ar' }), version: 1, stored: true, missing: [], hints: {}, canEdit: true, draft: null,
});

/** A wizard on its connect step, with the connections as given, nothing painted and every call recorded. */
function wizard(options: Parameters<typeof load>[0] = {}, connect: Record<string, any> = {}) {
    const s = load(options);
    const P = s.WelcomePage;
    P.paint = () => undefined;
    P.state = P.freshState();
    P.state.phase = 'ready';
    P.state.onb = withConnect();
    P.state.step = 'connect';
    P.state.values = {};
    P.state.connect = { ...P.blankConnect(), phase: 'ready', meta: resp(), ...connect };
    return { s, P };
}

const tiktok = (conn: Record<string, any> = {}, over: Record<string, any> = {}) => ({ appConfigured: true, connection: { connected: false, status: null, ...conn }, ...over });
const youtube = (conn: Record<string, any> = {}, over: Record<string, any> = {}) => ({ appConfigured: true, connection: { connected: false, status: null, ...conn }, ...over });
const view = (P: any): string => String(P.connectFields(P.state));

describe('W4: the three cards', () => {
    it('is in the sequence only when the server switched it on, after W3, and never required', () => {
        const s = load();
        const P = s.WelcomePage;
        const off = { ...withConnect(), order: ORDER };
        assert.deepEqual(plain(P.stepOrder(off)), ['about', 'voice', 'brand', 'done']);
        assert.deepEqual(plain(P.stepOrder(withConnect())), ['about', 'voice', 'brand', 'connect', 'done']);
        assert.deepEqual(plain(P.progress(withConnect(), 'connect')), { index: 4, total: 4 });
        assert.equal(P.STEPS.connect.required, false);
        assert.equal(P.STEPS.connect.skippable, true);
        assert.equal(P.STEPS.connect.code, 'W4');
    });

    it('draws a loader while it reads, and a retry when nothing could be read', () => {
        const { s, P } = wizard({}, { phase: 'loading' });
        assert.match(view(P), /class="loader"/);
        P.state.connect.phase = 'failed';
        const markup = view(P);
        assert.ok(markup.includes(s.t('welcome.connect.loadFailed')));
        assert.match(markup, /data-action="welcome:retryConnect"/);
    });

    it('Instagram & Facebook, not connected: a primary Connect that returns to the wizard, and the way to have it done for you', () => {
        const { s, P } = wizard();
        const markup = view(P);
        assert.match(markup, /id="connect-card-meta"[^>]*data-state="none"/);
        const b = button(markup, 'connect-meta-button');
        assert.match(b, /data-return-to="welcome"/);
        assert.match(b, /data-reconnect="false"/);
        assert.match(b, /btn-primary/);
        assert.match(b, /btn-full/);
        assert.ok(markup.includes(s.t('welcome.connect.manual')));
        assert.ok(markup.includes(s.t('welcome.connect.notConnected')));
        assert.doesNotMatch(markup, /connect-check/, 'no test comment until something is connected');
    });

    it('a platform admin filling the wizard in for somebody returns to Settings, not to a wizard they cannot reopen', () => {
        const { P } = wizard({ hash: '#/welcome?step=connect&mode=behalf', role: 'platform_admin' });
        assert.match(button(view(P), 'connect-meta-button'), /data-return-to="settings"/);
    });

    it('not switched on or not set up: says so, with no button', () => {
        for (const over of [{ enabled: false }, { appConfigured: false }, { redirectUriConfigured: false }]) {
            const { s, P } = wizard({}, { meta: resp(over) });
            const markup = view(P);
            assert.doesNotMatch(markup, /connect-meta-button/);
            assert.ok(markup.includes(s.t('welcome.connect.meta.unavailable')));
        }
    });

    it('connected: who it is connected as (the handle, else the Page), no button, and the test comment below', () => {
        const { s, P } = wizard({}, { meta: connectedLogin() });
        const markup = view(P);
        assert.match(markup, /data-state="ok"/);
        assert.match(markup, /<bdi dir="ltr">@nourshop<\/bdi>/);
        assert.doesNotMatch(markup, /connect-meta-button/);
        assert.match(markup, /id="connect-check"/);
        assert.ok(markup.includes(s.t('welcome.connect.check.ask')));
        const pageOnly = wizard({}, { meta: connectedLogin({ instagramUsername: null }) });
        assert.match(view(pageOnly.P), /<span dir="auto">Nour Shop<\/span>/);
    });

    it('needs attention: why, and a primary Reconnect that asks Facebook to renew when it is about to lapse', () => {
        const { s, P } = wizard({}, { meta: connectedLogin({ reconnectDue: true, reconnectReason: 'expiring' }) });
        const markup = view(P);
        assert.match(markup, /data-state="attention"/);
        assert.ok(markup.includes(s.t('meta.attention.expiringSoon')));
        assert.match(button(markup, 'connect-meta-button'), /data-auth-type="reauthorize"/);
        const invalid = wizard({}, { meta: connectedLogin({ tokenStatus: 'invalid', reconnectDue: true, reconnectReason: 'invalid' }) });
        assert.ok(view(invalid.P).includes(invalid.s.t('meta.attention.invalid')));
    });

    it('a Meta card that failed to load says so with a Retry, and the others still show', () => {
        const { s, P } = wizard({}, { meta: null, metaError: new Error('x'), tiktok: tiktok() });
        const markup = view(P);
        assert.ok(markup.includes(s.t('welcome.connect.failed')));
        assert.match(markup, /id="connect-meta-retry"/);
        assert.match(markup, /id="connect-card-tiktok"/);
    });

    it('TikTok and YouTube: an optional secondary Connect each, a Reconnect when needed, and nothing at all when the operator has not set them up', () => {
        const { s, P } = wizard({}, { tiktok: tiktok(), youtube: youtube() });
        const markup = view(P);
        for (const [id, action] of ([['connect-tiktok-button', 'welcome:connectTikTok'], ['connect-youtube-button', 'welcome:connectYouTube']] as Array<[string, string]>)) {
            assert.match(button(markup, id), new RegExp(`data-action="${action}"`));
            assert.match(button(markup, id), /btn-secondary/);
        }
        assert.ok(markup.includes(s.t('welcome.connect.tiktok.hint')));

        const none = wizard({}, { tiktok: tiktok({}, { appConfigured: false }), youtube: null });
        assert.doesNotMatch(view(none.P), /connect-card-tiktok|connect-card-youtube/);

        const needs = wizard({}, { tiktok: tiktok({ connected: true, status: 'invalid', displayName: 'x' }), youtube: youtube({ connected: true, status: 'active', channelTitle: 'My Channel' }) });
        const text = view(needs.P);
        assert.match(button(text, 'connect-tiktok-button'), /btn-primary/);
        assert.ok(text.includes(needs.s.t('welcome.connect.reconnect')));
        assert.match(text, /id="connect-card-youtube"[^>]*data-state="ok"/);
        assert.ok(text.includes('My Channel'));
        assert.doesNotMatch(text, /connect-youtube-button/, 'connected: no button');
    });

    it('says what a return trip said, as a note that stays: success, success with what is missing, and an error in words', () => {
        const { s, P } = wizard({}, { meta: connectedLogin() });
        P.state.connect.notice = { kind: 'success', text: s.t('welcome.connect.metaConnected') };
        assert.match(view(P), /class="meta-notice is-success" role="status"/);
        P.state.connect.notice = { kind: 'warning', text: 'a', extra: ['b', 'c'] };
        assert.match(view(P), /meta-notice-more">b<\/span>[\s\S]*meta-notice-more">c</);
        P.state.connect.notice = { kind: 'danger', text: 'bad' };
        assert.match(view(P), /class="meta-notice is-danger" role="alert"/);
    });

    it('escapes a payload in every field of every card, the notice and the test comment', () => {
        for (const lang of ['en', 'ar'] as const) {
            const { P } = wizard({ lang }, {
                meta: connectedLogin({ pageName: PAYLOAD, instagramUsername: QUOTE_BREAK, pageId: PAYLOAD }),
                tiktok: tiktok({ connected: true, status: 'active', displayName: PAYLOAD }), youtube: youtube({ connected: true, status: 'active', channelTitle: QUOTE_BREAK }),
                notice: { kind: 'warning', text: PAYLOAD, extra: [QUOTE_BREAK, PAYLOAD] },
                check: { phase: 'received', count: 1, latestAt: PAYLOAD, startedAt: 0 },
            });
            assertInert(view(P), `${lang} W4`);
            P.state.connect.meta = connectedLogin({ pageName: PAYLOAD, instagramUsername: null });
            P.state.connect.tiktok = tiktok({ connected: true, status: 'invalid', displayName: PAYLOAD });
            assertInert(view(P), `${lang} W4 (page only, attention)`);
        }
    });
});

describe('W4: the test comment', () => {
    const connected = () => wizard({}, { meta: connectedLogin() });

    it('is a waiting line until a comment arrives, then green, then given up on, each with its own words', () => {
        const { s, P } = connected();
        const state = (phase: string, latestAt = '') => { P.state.connect.check = { phase, count: 0, latestAt, startedAt: 0 }; return String(P.checkStateView(P.state.connect)); };
        assert.ok(state('waiting').includes(s.t('welcome.connect.check.waiting')));
        assert.match(state('waiting'), /is-waiting/);
        const got = state('received', new Date(Date.now() - 60_000).toISOString());
        assert.ok(got.includes(s.t('welcome.connect.check.received')));
        assert.match(got, /is-ready/);
        const gaveUp = state('timeout');
        assert.ok(gaveUp.includes(s.t('welcome.connect.check.timeout')));
        assert.match(gaveUp, /data-action="welcome:checkAgain"/);
    });

    it('starts watching when Meta is connected, asks at once and then on a timer, and not before it is connected', () => {
        const { s, P } = connected();
        s.calls.length = 0;
        P.startCheck();
        assert.equal(s.intervals.length, 1);
        assert.equal(s.intervals[0]!.ms, 5000);
        assert.equal(P.state.connect.check.phase, 'waiting');

        const not = wizard({}, { meta: resp() });
        not.P.startCheck();
        assert.equal(not.s.intervals.length, 0, 'nothing to watch until Meta is connected');
    });

    it('turns green and stops when a comment job has arrived, and says so to a screen reader', async () => {
        const { s, P } = wizard({ api: { getMetaCommentCheck: () => Promise.resolve({ connected: true, since: iso(-DAY), received: true, count: 2, latestAt: iso(-1000) }) } }, { meta: connectedLogin() });
        P.startCheck();
        await P.pollCheck();
        assert.equal(P.state.connect.check.phase, 'received');
        assert.equal(P.state.connect.check.count, 2);
        assert.equal(s.intervals[0]!.cleared, true, 'the poll stopped');
        P.startCheck();
        assert.equal(s.intervals.length, 1, 'and does not start again once it has arrived');
    });

    it('keeps asking while nothing has arrived, and gives up after ten minutes with a way to ask again', async () => {
        const { s, P } = wizard({ api: { getMetaCommentCheck: () => Promise.resolve({ connected: true, since: iso(-DAY), received: false, count: 0, latestAt: null }) } }, { meta: connectedLogin() });
        P.startCheck();
        await P.pollCheck();
        assert.equal(P.state.connect.check.phase, 'waiting');
        assert.equal(s.intervals[0]!.cleared, false);
        P.state.connect.check.startedAt = Date.now() - P.CHECK_GIVE_UP_MS - 1000;
        await P.pollCheck();
        assert.equal(P.state.connect.check.phase, 'timeout');
        assert.equal(s.intervals[0]!.cleared, true);
        P.restartCheck();
        assert.equal(P.state.connect.check.phase, 'waiting', 'ask again starts over');
        assert.equal(s.intervals.length, 2);
    });

    it('asks only the check route, with nothing from the page: the server decides which tenant', async () => {
        const { s, P } = wizard({ api: { getMetaCommentCheck: () => Promise.resolve({ received: false }) } }, { meta: connectedLogin() });
        await P.pollCheck();
        assert.deepEqual(s.calls.map((c) => [c.fn, c.args.length]), [['getMetaCommentCheck', 0]]);
    });

    it('does not ask while the tab is hidden, and a failed look is not an answer (the next tick asks again)', async () => {
        const hidden = wizard({ hidden: true, api: { getMetaCommentCheck: () => Promise.resolve({ received: true }) } }, { meta: connectedLogin() });
        await hidden.P.pollCheck();
        assert.equal(hidden.s.calls.length, 0);

        const failing = wizard({ api: { getMetaCommentCheck: () => Promise.reject(new Error('network')) } }, { meta: connectedLogin() });
        failing.P.startCheck();
        await failing.P.pollCheck();
        assert.equal(failing.P.state.connect.check.phase, 'waiting');
        assert.equal(failing.s.intervals[0]!.cleared, false);
    });

    it('a dead session stops the poll, and asks nothing more', async () => {
        const { s, P } = wizard({ api: { getMetaCommentCheck: () => Promise.reject(Object.assign(new Error('expired'), { status: 401 })) } }, { meta: connectedLogin() });
        P.startCheck();
        await P.pollCheck();
        assert.equal(s.intervals[0]!.cleared, true);
    });

    it('never has two requests in flight', async () => {
        let release: (v: unknown) => void = () => undefined;
        let asked = 0;
        const { s, P } = wizard({ api: { getMetaCommentCheck: () => (++asked === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ received: false })) } }, { meta: connectedLogin() });
        const first = P.pollCheck();
        await P.pollCheck();
        assert.equal(s.calls.length, 1, 'the second look finds the first still in flight, and does not ask');
        release({ received: false });
        await first;
        await P.pollCheck();
        assert.equal(s.calls.length, 2, 'once the first is answered, the next may ask');
    });

    it('stops when the step is left (any step change), and when the wizard is closed', async () => {
        const { s, P } = connected();
        P.startCheck();
        await P.show('done');
        assert.equal(s.intervals[0]!.cleared, true);

        const open = connected();
        open.P.startCheck();
        open.P.destroy();
        assert.equal(open.s.intervals[0]!.cleared, true);
    });

    it('repaints only its own region: a poll never touches the cards', async () => {
        const { s, P } = wizard({ api: { getMetaCommentCheck: () => Promise.resolve({ received: true, count: 1, latestAt: iso(-1000) }) } }, { meta: connectedLogin() });
        const host = s.elements['connect-check-state']!;
        let paints = 0;
        P.paint = () => { paints++; };
        P.startCheck();
        await P.pollCheck();
        assert.equal(paints, 0);
        assert.ok(String(host.innerHTML).includes(s.t('welcome.connect.check.received')));
    });
});

describe('W4: return_to, and what a return trip said', () => {
    it('sends TikTok and YouTube to their consent screens with returnTo "welcome" (or none for an admin filling in), and only to https addresses', async () => {
        const { s, P } = wizard({ api: {
            startTikTokConnect: () => Promise.resolve({ url: 'https://www.tiktok.com/v2/auth/authorize/?x=1' }),
            startYouTubeConnect: () => Promise.resolve({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }),
        } });
        await P.connectProvider({ disabled: false }, 'tiktok');
        assert.equal(s.location.href, 'https://www.tiktok.com/v2/auth/authorize/?x=1');
        await P.connectProvider({ disabled: false }, 'youtube');
        assert.equal(s.location.href, 'https://accounts.google.com/o/oauth2/v2/auth?x=1');
        assert.deepEqual(s.calls.map((c) => [c.fn, c.args[0]]), [['startTikTokConnect', 'welcome'], ['startYouTubeConnect', 'welcome']]);

        const admin = wizard({ hash: '#/welcome?step=connect&mode=behalf', role: 'platform_admin', api: { startTikTokConnect: () => Promise.resolve({ url: 'https://www.tiktok.com/x' }) } });
        await admin.P.connectProvider({ disabled: false }, 'tiktok');
        assert.equal(admin.s.calls[0]!.args[0], 'settings');

        const bad = wizard({ api: { startTikTokConnect: () => Promise.resolve({ url: 'javascript:alert(1)' }) } });
        await bad.P.connectProvider({ disabled: false }, 'tiktok');
        assert.equal(bad.s.location.href, undefined);
        assert.equal(bad.s.toasts.at(-1)!.type, 'error');
    });

    it('reads what the address says before the first paint rewrites it', () => {
        const l = load({ hash: `#/welcome?step=connect&meta=connected&warn=subscribe_failed&tiktok=error&reason=denied&junk=1` });
        assert.deepEqual(plain(l.WelcomePage.readConnectReturn()), { meta: 'connected', warn: 'subscribe_failed', tiktok: 'error', reason: 'denied' });
        assert.equal(load({ hash: '#/welcome?step=connect' }).WelcomePage.readConnectReturn(), null);
    });

    /** Open the step with a return trip, as `load()` does: the address read, then `enterConnect`. */
    async function enter(returned: Record<string, string> | null, api: Record<string, (...a: any[]) => any> = {}) {
        const s = load({ api: { getMetaConnection: () => Promise.resolve(resp()), getTikTokConnection: () => Promise.resolve(tiktok()), getYouTubeConnection: () => Promise.resolve(youtube()), ...api } });
        const P = s.WelcomePage;
        P.paint = () => undefined;
        P.state = P.freshState();
        P.state.phase = 'ready';
        P.state.onb = withConnect();
        P.state.step = 'connect';
        P.state.returned = returned;
        s.App.loadPageModule = () => Promise.resolve(s.MetaConnect);
        await P.enterConnect();
        return { s, P, c: P.state.connect };
    }

    it('says a Meta connection that came back, and what is missing from it', async () => {
        const ok = await enter({ meta: 'connected' }, { getMetaConnection: () => Promise.resolve(connectedLogin()) });
        assert.deepEqual(plain(ok.c.notice), { kind: 'success', text: ok.s.t('welcome.connect.metaConnected'), extra: [] });
        const warned = await enter({ meta: 'connected', warn: 'subscribe_failed' }, { getMetaConnection: () => Promise.resolve(connectedLogin()) });
        assert.equal(warned.c.notice.kind, 'warning');
        assert.deepEqual(plain(warned.c.notice.extra), [warned.s.t('meta.warning.subscribe_failed')]);
    });

    it('says a Meta error in its own words, and an unknown reason as the generic sentence', async () => {
        const known = await enter({ meta: 'error', reason: 'not_tester' });
        assert.deepEqual(plain(known.c.notice), { kind: 'danger', text: known.s.t('meta.reason.not_tester') });
        const unknown = await enter({ meta: 'error', reason: '<img src=x>' });
        assert.equal(unknown.c.notice.text, unknown.s.t('meta.reason.generic'));
    });

    it('opens the Page picker for a pick, returning to the wizard', async () => {
        const picked = await enter({ meta: 'pick', pick: PICK }, { getMetaCandidates: () => Promise.resolve({ pick: PICK, candidates: [], connectedAs: null }) });
        assert.deepEqual(picked.s.calls.filter((c) => c.fn === 'getMetaCandidates').map((c) => c.args[0]), [PICK]);
        assert.equal(picked.s.MetaConnect._pick.returnTo, 'welcome');
        assert.equal(picked.c.notice, null);
    });

    it('says a TikTok or YouTube return: connected, a reason a person can act on, and the generic sentence for an operator\'s reason', async () => {
        const ok = await enter({ tiktok: 'connected' });
        assert.deepEqual(plain(ok.c.notice), { kind: 'success', text: ok.s.t('welcome.connect.providerConnected', { name: ok.s.t('welcome.connect.tiktok.title') }) });
        const denied = await enter({ youtube: 'error', reason: 'no_channel' });
        assert.equal(denied.c.notice.text, denied.s.t('settings.youtube.return.no_channel'));
        const operatorOnly = await enter({ tiktok: 'error', reason: 'exchange_failed' });
        assert.equal(operatorOnly.c.notice.text, operatorOnly.s.t('welcome.connect.return.generic', { name: operatorOnly.s.t('welcome.connect.tiktok.title') }));
        assert.ok(!operatorOnly.c.notice.text.includes('client key'), 'a tenant is not told to check the operator\'s credentials');
        const crossed = await enter({ tiktok: 'error', reason: 'channel_in_use' });
        assert.equal(crossed.c.notice.text, crossed.s.t('welcome.connect.return.generic', { name: crossed.s.t('welcome.connect.tiktok.title') }), 'a YouTube reason on TikTok is not a sentence for it');
    });

    it('opens quietly with no return trip, reads all three connections, and starts watching if Meta is connected', async () => {
        const quiet = await enter(null, { getMetaConnection: () => Promise.resolve(connectedLogin()) });
        assert.equal(quiet.c.notice, null);
        assert.equal(quiet.c.phase, 'ready');
        assert.deepEqual(quiet.s.calls.map((c) => c.fn).sort(), ['getMetaCommentCheck', 'getMetaConnection', 'getTikTokConnection', 'getYouTubeConnection']);
        assert.equal(quiet.s.intervals.length, 1);
        const idle = await enter(null);
        assert.equal(idle.s.intervals.length, 0, 'not connected: nothing to watch');
    });

    it('is not fatal when one of the three cannot be read, and fails with a Retry when none can', async () => {
        const some = await enter(null, { getTikTokConnection: () => Promise.reject(new Error('x')) });
        assert.equal(some.c.phase, 'ready');
        assert.equal(some.c.tiktok, null);
        const none = await enter(null, {
            getMetaConnection: () => Promise.reject(new Error('x')), getTikTokConnection: () => Promise.reject(new Error('x')), getYouTubeConnection: () => Promise.reject(new Error('x')),
        });
        assert.equal(none.c.phase, 'failed');
    });

    it('draws a Meta card that could not load its module as a failure with Retry, never a Connect that cannot work', async () => {
        const s = load({ api: { getMetaConnection: () => Promise.resolve(resp()), getTikTokConnection: () => Promise.resolve(tiktok()), getYouTubeConnection: () => Promise.resolve(youtube()) } });
        const P = s.WelcomePage;
        P.paint = () => undefined;
        P.state = P.freshState();
        P.state.phase = 'ready';
        P.state.onb = withConnect();
        P.state.step = 'connect';
        s.App.loadPageModule = () => Promise.resolve(null);
        await P.enterConnect();
        assert.ok(view(P).includes(s.t('welcome.connect.failed')));
        assert.doesNotMatch(view(P), /connect-meta-button/);
    });

    it('does nothing with an answer that arrives after the person has gone to another step', async () => {
        let release: (v: unknown) => void = () => undefined;
        const s = load({ api: { getMetaConnection: () => new Promise((resolve) => { release = resolve; }), getTikTokConnection: () => Promise.resolve(tiktok()), getYouTubeConnection: () => Promise.resolve(youtube()) } });
        const P = s.WelcomePage;
        P.paint = () => undefined;
        P.state = P.freshState();
        P.state.phase = 'ready';
        P.state.onb = withConnect();
        P.state.step = 'connect';
        s.App.loadPageModule = () => Promise.resolve(s.MetaConnect);
        const pending = P.enterConnect();
        P.state.step = 'done';
        release(connectedLogin());
        await pending;
        assert.equal(s.intervals.length, 0);
        assert.equal(P.state.connect.phase, 'loading', 'left as it was: nothing painted into another step');
    });

    it('repaints and starts watching when a Page is chosen in the picker', async () => {
        const { s, P } = wizard({ api: { getMetaConnection: () => Promise.resolve(connectedLogin()) } });
        await P.reloadConnect();
        assert.equal(P.state.connect.meta.connection.connected, true);
        assert.equal(s.intervals.length, 1);
    });
});

describe('W4 never blocks the wizard', () => {
    function fixture() {
        const s = load({ api: { saveOnboardingStep: (_step: string, body: any) => Promise.resolve({ status: 'in_progress', step: 'done', steps: { connect: { status: body.status } } }) } });
        const P = s.WelcomePage;
        P.paint = () => undefined;
        P.state = P.freshState();
        P.state.phase = 'ready';
        P.state.onb = withConnect();
        P.state.step = 'connect';
        P.state.values = {};
        P.state.connect = { ...P.blankConnect(), phase: 'ready', meta: resp() };
        P.collect = () => P.state.values;
        P.flush = () => Promise.resolve();
        s.UI.actionBusy = () => () => undefined;
        return { s, P };
    }

    it('Continue with nothing connected sends nothing to the profile, marks the step done, and goes to the last screen', async () => {
        const { s, P } = fixture();
        await P.submit();
        assert.ok(!s.calls.some((c) => c.fn === 'patchProfile'), 'nothing to confirm: the profile is not written');
        assert.deepEqual(plain(s.calls[0]!.args), ['connect', { status: 'done' }]);
        assert.equal(P.state.step, 'done');
    });

    it('Skip marks the step skipped, whatever is or is not connected', async () => {
        const { s, P } = fixture();
        await P.skip({ disabled: false });
        assert.deepEqual(plain(s.calls[0]!.args), ['connect', { status: 'skipped' }]);
        assert.equal(P.state.step, 'done');
    });

    it('offers Skip on the bar, and Back to the step before it', () => {
        const { s, P } = fixture();
        const bar = String(P.barView(P.state));
        assert.match(bar, /data-action="welcome:skip"/);
        assert.match(bar, /data-action="welcome:back"/);
        assert.ok(bar.includes(s.t('welcome.connect.next')));
    });

    it('says on the last screen that it can be connected in Settings, when W4 is part of the wizard', () => {
        const { s, P } = fixture();
        P.state.step = 'done';
        const markup = String(P.doneFields(P.state));
        assert.ok(markup.includes(s.t('welcome.done.connectSettings')));
        P.state.onb = { ...P.state.onb, order: ORDER };
        assert.ok(String(P.doneFields(P.state)).includes(s.t('welcome.done.connect')), 'with W4 off, the words it always had');
    });

    it('names the step in the progress list', () => {
        const { s, P } = fixture();
        const markup = String(P.progressView(P.state));
        assert.ok(markup.includes(s.t('welcome.step.connect')));
        assert.ok(markup.includes(s.t('welcome.progress.count', { n: 4, total: 4 })));
    });
});

// ─── Overview ────────────────────────────────────────────────────────────────────────────────────

describe('the Overview notice', () => {
    const s = load();
    const O = s.OverviewPage;
    const ok = (value: unknown) => ({ status: 'fulfilled', value });
    const pending = { status: 'pending' };
    const alerts = (token: unknown, meta: unknown) => plain<Array<Record<string, any>>>(
        O.buildAlerts({ activeCampaigns: 1 }, ok({ data: [] }), token, ok([]), ok({ data: [] }), pending, meta)
    );
    const goodToken = ok({ status: 'valid' });

    it('says nothing when the connection is fine, or has not been read', () => {
        assert.deepEqual(alerts(goodToken, ok(connectedLogin())), []);
        assert.deepEqual(alerts(goodToken, undefined), []);
        assert.deepEqual(alerts(goodToken, { status: 'rejected', reason: new Error('x') }), [], 'a connection that failed to load says nothing here');
        assert.deepEqual(alerts(goodToken, ok(resp())), [], 'not connected is not a reconnect');
    });

    it('warns when Instagram\'s access is about to lapse, and is a danger when Meta no longer accepts the connection', () => {
        const expiring = alerts(goodToken, ok(connectedLogin({ reconnectDue: true, reconnectReason: 'expiring' })));
        assert.equal(expiring.length, 1);
        assert.deepEqual([expiring[0]!.level, expiring[0]!.title, expiring[0]!.target], ['warning', s.t('overview.alert.metaExpiring'), 'settings']);
        const invalid = alerts(goodToken, ok(connectedLogin({ reconnectDue: true, reconnectReason: 'invalid', tokenStatus: 'invalid' })));
        assert.deepEqual([invalid[0]!.level, invalid[0]!.title], ['danger', s.t('overview.alert.metaInvalid')]);
    });

    it('is said once: not again when the live token check already called the token bad or expiring', () => {
        const due = ok(connectedLogin({ reconnectDue: true, reconnectReason: 'invalid', tokenStatus: 'invalid' }));
        const live = alerts(ok({ status: 'invalid' }), due);
        assert.equal(live.length, 1);
        assert.equal(live[0]!.title, s.t('overview.alert.tokenInvalid'));
        const expiring = alerts(ok({ status: 'valid', expiresAt: iso(3 * DAY) }), ok(connectedLogin({ reconnectDue: true, reconnectReason: 'expiring' })));
        assert.equal(expiring.length, 1);
    });

    it('still says it when the live check could not be made', () => {
        const unknown = alerts({ status: 'rejected', reason: new Error('offline') }, ok(connectedLogin({ reconnectDue: true, reconnectReason: 'expiring' })));
        assert.deepEqual(unknown.map((a) => a.title).sort(), [s.t('overview.alert.metaExpiring'), s.t('overview.alert.tokenUnknown')].sort());
    });

    it('asks for the stored connection, once, with the rest of the page', async () => {
        const l = load({ api: {
            getStats: () => Promise.resolve({ activeCampaigns: 1 }), getInteractions: () => Promise.resolve({ data: [] }), getTokenStatus: () => Promise.resolve({ status: 'valid' }),
            getScheduledPosts: () => Promise.resolve([]), getConversations: () => Promise.resolve({ data: [] }), getDailyStats: () => Promise.resolve([]),
            getMetaConnection: () => Promise.resolve(connectedLogin({ reconnectDue: true, reconnectReason: 'expiring' })),
        } });
        for (const region of ['briefing', 'growth', 'stats', 'charts', 'recent', 'busy']) l.elements[`region:${region}`] = element();
        l.elements['page-container']!.querySelector = (sel: string) => l.elements[`region:${(/data-region="([a-z]+)"/.exec(sel) || [])[1]}`] ?? null;
        l.OverviewPage.canSeeGrowth = () => false;
        l.OverviewPage.render();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(l.calls.filter((c) => c.fn === 'getMetaConnection').length, 1);
        assert.ok(String(l.elements['region:briefing']!.innerHTML).includes(l.t('overview.alert.metaExpiring')));
        l.OverviewPage.destroy();
    });
});

// ─── The copy and the stylesheet ─────────────────────────────────────────────────────────────────

describe('the copy: every key exists in both languages with the same placeholders', () => {
    const sources = ['meta_connect', 'welcome', 'settings', 'overview'].map((f) => readFileSync(`dashboard/js/pages/${f}.js`, 'utf8')).join('\n');
    const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const code = strip(sources);

    function dictionary(lang: 'ar' | 'en'): Record<string, string> {
        const ctx: Record<string, any> = {};
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        vm.runInContext(readFileSync(`dashboard/js/i18n.${lang}.js`, 'utf8'), ctx);
        return ctx.I18N_DICT[lang];
    }
    const ar = dictionary('ar');
    const en = dictionary('en');
    const mine = (key: string): boolean => /^(meta\.|welcome\.connect\.|welcome\.step\.connect|welcome\.done\.connectSettings|overview\.alert\.meta)/.test(key);

    it('has every key this feature names, in both dictionaries', () => {
        const literal = [...new Set([...code.matchAll(/\bt\(\s*'((?:meta|welcome\.connect|overview\.alert\.meta)[a-zA-Z0-9_.]*)'/g)].map((m) => m[1]!))];
        assert.ok(literal.length > 60, `${literal.length} literal keys`);
        for (const key of [...literal, 'welcome.step.connect', 'welcome.done.connectSettings']) {
            assert.ok(key in en, `${key} is missing in English`);
            assert.ok(key in ar, `${key} is missing in Arabic`);
        }
    });

    it('uses the same placeholders in both, no Arabic-Indic digits, no exclamation marks, and no dialect in the Arabic', () => {
        const names = (value: string): string => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
        for (const key of Object.keys(en).filter(mine)) {
            assert.ok(key in ar, `${key} has no Arabic`);
            assert.equal(names(ar[key]!), names(en[key]!), key);
            assert.ok(!/[٠-٩۰-۹]/.test(ar[key]!), `${key} has Arabic-Indic digits`);
            assert.ok(!/!/.test(en[key]!), `${key}: English has no exclamation marks`);
            assert.ok(!/\b(premium|instant|instantly|guaranteed|supercharge)\b/i.test(en[key]!), key);
            assert.ok(!/(?:^|\s)(?:عايز|ازاي|دلوقتي|هلا|شلونك|وين|ليش|شو)(?:\s|$)/.test(ar[key]!), `${key}: ${ar[key]}`);
        }
        assert.ok(Object.keys(en).filter(mine).length > 100);
    });
});

describe('the stylesheet', () => {
    const css = readFileSync('dashboard/css/styles.css', 'utf8');
    const start = css.indexOf('/* ─── Instagram & Facebook, connected with clicks');
    const end = css.indexOf('.welcome-rules-head {', start);
    const block = css.slice(start, end);

    it('finds the block', () => {
        assert.ok(start > 0 && end > start);
        assert.match(block, /\.connect-card \{/);
    });

    it('uses logical properties and tokens only: it reads the same in Arabic and English, in both themes', () => {
        const code = block.replace(/\/\*[\s\S]*?\*\//g, '');
        const physical = code.match(/(?<![\w-])(margin|padding|border)-(left|right)\b|(?<![\w-])(left|right|top|bottom)\s*:|text-align:\s*(left|right)\b|(?<![\w-])(width|height|min-width|min-height|max-width|max-height)\s*:/g);
        assert.deepEqual(physical, null, `physical properties: ${physical}`);
        assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code), 'no hex literal');
        assert.ok(!/\brgba?\(|\bhsla?\(/.test(code), 'no rgb() or hsl() literal');
    });

    it('keeps the picker\'s and the operator\'s checkbox rows a finger tall (44px), and uses that class on both', () => {
        assert.match(block, /\.check-row-tap \{[^}]*min-block-size: var\(--tap-target\)/);
        const s = load({ role: 'platform_admin' });
        const pick = {
            data: { pick: PICK, reconnect: false, candidates: [{ pageId: '1', name: 'A', instagram: { id: '2', username: 'a' }, usable: true, reason: null, replaces: true }] },
            selected: '1', confirm: false, busy: false, expired: false, returnTo: 'settings',
        };
        assert.match(String(s.MetaConnect.pickExtra(pick)), /class="check-row check-row-tap/);
        assert.match(String(s.MetaConnect.appBlock({ enabled: true, configId: {}, mode: 'scope', app: { idSet: true, secretSet: true }, publicBaseUrl: 'https://x.example', register: null })), /class="check-row check-row-tap"/);
    });

    it('lists a Page the person cannot run as disabled, in the style the wizard\'s radio cards already have', () => {
        assert.match(block, /\.welcome-choice-input:disabled \+ \.welcome-choice-body \{[^}]*opacity: var\(--opacity-disabled\)/);
    });
});
