/**
 * The invite screens (P17): the page a link opens, the platform admin's invite card, and how the app routes between them.
 *
 * The real dashboard files run in a `node:vm` context, as in escaping.test.ts and roles.test.ts, so this tests what ships.
 * What is pinned, because each is a way a link or a name becomes a hole:
 *
 *   - the tenant's name, the inviter's, an address, a link: any of them may hold markup, and none of it may reach the page
 *     as anything but text, in every state of the page (ready, signed in, reset, and the card the operator sees);
 *   - the token leaves the address bar before anything renders, and only something shaped like a token is believed;
 *   - an invite hash is routed to the invite page and never to an app page, so a signed-in user cannot be dropped into the
 *     dashboard by a link, and the operator who opens his own link is told rather than silently signed in;
 *   - the head script takes the language the link names, once, and ignores one that is not a language.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const TEMPLATES: Record<string, string> = {
    'invite.inviter': '{inviter} invited you',
    'invite.reset.for': 'For {email}.',
    'invite.viewer.signedInAs': 'Signed in as {email}.',
    'invite.viewer.mismatch': 'For {invited} but you are {email}.',
    'invite.viewer.add': 'Add {tenant}',
    'invite.signInToAdd': 'Sign in to add {tenant}',
};

/** `t()` with the placeholders of the few sentences that have one, and the key for everything else. */
const t = (key: string, params?: Record<string, unknown>): string => {
    const template = TEMPLATES[key];
    if (!template) return key;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (params && params[name] !== undefined ? String(params[name]) : match));
};

interface Store { map: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function store(): Store {
    const map = new Map<string, string>();
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}

interface Loaded {
    ctx: Record<string, any>;
    elements: Record<string, Record<string, any>>;
    InvitePage: any;
    InviteCard: any;
    TenantDetailPage: any;
    App: any;
    html: (s: TemplateStringsArray, ...v: unknown[]) => { toString(): string };
}

/** An element that remembers its classes and value: enough for the login screen's show/hide logic to be checked. */
function element(initial: string[] = []): Record<string, any> {
    const classes = new Set(initial);
    return {
        classes, value: '', checked: false, textContent: '',
        classList: {
            add: (c: string) => classes.add(c),
            remove: (c: string) => classes.delete(c),
            toggle: (c: string, force?: boolean) => { const on = force === undefined ? !classes.has(c) : force; if (on) classes.add(c); else classes.delete(c); return on; },
            contains: (c: string) => classes.has(c),
        },
        focus: () => undefined, setAttribute: () => undefined, addEventListener: () => undefined,
    };
}

function load(options: { hash?: string } = {}): Loaded {
    const noop = (): void => {};
    const elements: Record<string, Record<string, any>> = {
        'login-screen': element(['hidden']), app: element(['hidden']), 'invite-screen': element(['hidden']),
        'login-error': element(['hidden']), 'login-password': element(), 'login-email': element(), 'login-email-group': element(['hidden']),
        'login-email-toggle': element(), 'login-keep': element(),
    };
    const stubEl = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [],
    };
    const location = { hash: options.hash ?? '', pathname: '/dashboard', search: '' };
    const history = {
        calls: [] as string[],
        replaceState(_state: unknown, _title: string, url: string) {
            this.calls.push(url);
            location.hash = url.startsWith('#') ? url : '';
        },
    };
    const ctx: Record<string, any> = {
        document: {
            ...stubEl,
            createElement: () => ({ ...stubEl }),
            body: { ...stubEl }, head: { ...stubEl },
            documentElement: { ...stubEl, lang: 'ar', dir: 'rtl' },
            getElementById: (id: string) => elements[id] ?? null, activeElement: null,
        },
        window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location },
        location, history,
        localStorage: store(), sessionStorage: store(),
        Intl, console, setTimeout, clearTimeout, URL, URLSearchParams,
        requestAnimationFrame: (f: () => void) => f(),
        I18N: { lang: 'ar', locale: () => 'ar-u-nu-latn-ca-gregory', t, strings: { ar: {}, en: {} } },
        t,
        navigator: { language: 'ar' },
        crypto: { getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i += 1) a[i] = (i * 37 + 11) % 256; return a; } },
        CSS: { escape: (v: string) => String(v) },
        API: {}, Motion: { announce: noop },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const file of [
        'dashboard/js/components.js',
        'dashboard/js/pages/admin_common.js',
        'dashboard/js/pages/invite.js',
        'dashboard/js/pages/invite_card.js',
        'dashboard/js/pages/tenant_detail.js',
        'dashboard/js/app.js',
    ]) {
        vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
    }
    const out = vm.runInContext('({ InvitePage, InviteCard, TenantDetailPage, App, html })', ctx) as Omit<Loaded, 'ctx' | 'elements'>;
    return { ctx, elements, ...out };
}

const PAYLOAD = '<img src=x onerror=alert(document.cookie)>';
const QUOTE_BREAK = '"><script>alert(1)</script><x y="';

/** No live tag, no live handler: the payload is text. */
function assertInert(markup: string, label: string): void {
    assert.ok(!markup.includes('<img'), `${label}: no live img tag`);
    assert.ok(!markup.includes('<script'), `${label}: no live script tag`);
    assert.ok(!/\sonerror=/.test(markup.replace(/&lt;[^&]*&gt;/g, '')), `${label}: no live handler`);
    assert.ok(!/"\s*>\s*<(script|img|x)\b/i.test(markup), `${label}: nothing broke out of an attribute`);
}

// ─── The page a link opens ───────────────────────────────────────────────────────────────────────

describe('the invite page escapes everything a person or the server supplied', () => {
    const base = { tenantName: PAYLOAD, inviter: PAYLOAD, email: null, expiresAt: '2026-10-21T00:00:00Z', purpose: 'join', role: 'owner', sessionDays: 30, viewer: null };

    it('the tenant\'s name, in the heading and in the sentences around it', () => {
        const { InvitePage } = load();
        const markup = String(InvitePage.view({ phase: 'ready', peek: base }));
        assertInert(markup, 'ready');
        assert.ok(markup.includes('&lt;img src=x onerror=alert(document.cookie)&gt;'), 'shown as text');
        assert.ok(markup.includes('<bdi dir="auto">&lt;img'), 'isolated, so a name in the other script cannot reorder the sentence');
    });

    it('the inviter\'s name', () => {
        const { InvitePage } = load();
        const markup = String(InvitePage.view({ phase: 'ready', peek: { ...base, tenantName: 'Nour', inviter: PAYLOAD } }));
        assertInert(markup, 'inviter');
        assert.ok(markup.includes('&lt;img'), 'shown');
    });

    it('an address that tries to leave its attribute, in the form and in the reset sentence', () => {
        const { InvitePage } = load();
        const form = String(InvitePage.view({ phase: 'ready', peek: { ...base, tenantName: 'Nour', inviter: null, email: QUOTE_BREAK } }));
        assertInert(form, 'locked address');
        assert.ok(form.includes('value="&quot;&gt;&lt;script&gt;'), 'inside value="…", quoted');
        const reset = String(InvitePage.view({ phase: 'ready', peek: { ...base, purpose: 'reset', tenantName: 'Nour', inviter: null, email: PAYLOAD } }));
        assertInert(reset, 'reset');
    });

    it('what was typed into the address field, kept across a repaint', () => {
        const { InvitePage } = load();
        const markup = String(InvitePage.view({ phase: 'ready', email: QUOTE_BREAK, peek: { ...base, tenantName: 'Nour', inviter: null } }));
        assertInert(markup, 'typed');
    });

    it('the signed-in account\'s address and the tenant, in all three signed-in states', () => {
        const { InvitePage } = load();
        const viewers = [
            { signedIn: true, platformAdmin: false, email: PAYLOAD, emailMatches: true },
            { signedIn: true, platformAdmin: false, email: PAYLOAD, emailMatches: false },
            { signedIn: true, platformAdmin: true, email: null, emailMatches: null },
        ];
        for (const viewer of viewers) {
            const markup = String(InvitePage.view({ phase: 'ready', peek: { ...base, inviter: null, email: PAYLOAD, viewer } }));
            assertInert(markup, JSON.stringify(viewer));
        }
    });

    it('the sign-in button\'s label carries the tenant\'s name as text', () => {
        const { InvitePage } = load();
        const markup = String(InvitePage.view({ phase: 'ready', peek: { ...base, inviter: null } }));
        assert.ok(markup.includes('id="invite-signin-add"'));
        assertInert(markup, 'sign-in button');
    });
});

describe('the invite page, state by state', () => {
    const peek = { tenantName: 'Nour Shop', inviter: null, email: null, expiresAt: '2026-10-21T00:00:00Z', purpose: 'join', role: 'viewer', sessionDays: 7, viewer: null };

    it('shows a password form made for a password manager: the address as username, a new password, at least 12', () => {
        const { InvitePage } = load();
        const markup = String(InvitePage.view({ phase: 'ready', peek }));
        assert.match(markup, /id="invite-email"[^>]*autocomplete="username"/);
        assert.match(markup, /id="invite-password"[^>]*autocomplete="new-password"[^>]*minlength="12"/);
        assert.match(markup, /type="password"/);
        assert.match(markup, /data-action="invite:toggleReveal"[^>]*aria-pressed="false"/);
        assert.match(markup, /data-action="invite:suggest"/);
        assert.match(markup, /<h1 class="login-title" id="invite-title" tabindex="-1">/, 'one h1, which the page moves focus to');
    });

    it('offers "keep me signed in" with the operator\'s number of days, ticked', () => {
        const { InvitePage, ctx } = load();
        const seen: Array<[string, unknown]> = [];
        ctx.t = (key: string, params?: Record<string, unknown>) => { seen.push([key, params]); return t(key, params); };
        vm.runInContext('t = globalThis.t', ctx);
        const markup = String(InvitePage.view({ phase: 'ready', peek: { ...peek, sessionDays: 7 } }));
        assert.match(markup, /<input type="checkbox" id="invite-keep" name="keepSignedIn" checked>/);
        assert.equal(JSON.stringify(seen.find(([k]) => k === 'invite.keep')?.[1]), '{"count":7}');
    });

    it('locks the address when the link is for one, and leaves it open when it is not', () => {
        const { InvitePage } = load();
        const locked = String(InvitePage.view({ phase: 'ready', peek: { ...peek, email: 'person@example.com' } }));
        assert.match(locked, /id="invite-email"[^>]*value="person@example.com"[^>]*readonly/);
        const open = String(InvitePage.view({ phase: 'ready', peek }));
        assert.match(open, /id="invite-email"[^>]*required/);
        assert.doesNotMatch(open, /id="invite-email"[^>]*readonly/);
    });

    it('says what the person joins as, with the role\'s own words, and nothing of the sort for a reset', () => {
        const { InvitePage } = load();
        const join = String(InvitePage.view({ phase: 'ready', peek }));
        assert.match(join, /class="role-chip"[^>]*>roles\.viewer</);
        const reset = String(InvitePage.view({ phase: 'ready', peek: { ...peek, purpose: 'reset', email: 'person@example.com' } }));
        assert.doesNotMatch(reset, /role-chip/);
        assert.match(reset, /invite\.reset\.submit/);
        assert.match(reset, /invite\.reset\.title/);
    });

    it('offers the sign-in route only where it can help: the account exists, or the link is no longer valid', () => {
        const { InvitePage } = load();
        const invalid = String(InvitePage.view({ phase: 'invalid' }));
        assert.match(invalid, /data-action="invite:goSignIn"/);
        assert.match(invalid, /invite\.invalid\.title/);
        const ready = String(InvitePage.view({ phase: 'ready', peek }));
        assert.match(ready, /id="invite-signin-add" class="btn btn-secondary btn-full hidden"/, 'present but hidden until the server says the address has an account');
        assert.match(ready, /data-action="invite:goSignIn"/, '"I already have an account"');
    });

    it('is the same page for every way a link can be unusable: it never says which', () => {
        const { InvitePage } = load();
        const invalid = String(InvitePage.view({ phase: 'invalid', peek: { tenantName: 'Secret Co', email: 'x@y.z' } }));
        assert.ok(!invalid.includes('Secret Co') && !invalid.includes('x@y.z'), 'nothing of the link is shown once it is dead');
        for (const word of ['expired', 'revoked', 'used']) assert.ok(!invalid.toLowerCase().includes(`>${word}`), word);
    });

    it('has a loading, a throttled and a failed state, each with the way forward', () => {
        const { InvitePage } = load();
        assert.match(String(InvitePage.view({ phase: 'loading' })), /invite\.loading/);
        const throttled = String(InvitePage.view({ phase: 'throttled', wait: 12 }));
        assert.match(throttled, /invite\.throttled\.title/);
        assert.match(throttled, /data-action="invite:retry"/);
        assert.match(String(InvitePage.view({ phase: 'failed' })), /data-action="invite:retry"/);
    });

    it('has no inline handler and no inline style: the CSP allows neither on a page nobody has signed in to', () => {
        const { InvitePage } = load();
        const states = [{ phase: 'ready', peek }, { phase: 'ready', peek: { ...peek, purpose: 'reset', email: 'a@b.co' } }, { phase: 'invalid' }, { phase: 'throttled', wait: 3 }, { phase: 'failed' }, { phase: 'loading' }];
        for (const state of states) {
            const markup = String(InvitePage.view(state));
            assert.doesNotMatch(markup, /\son[a-z]+=/i, JSON.stringify(state.phase));
            assert.doesNotMatch(markup, /\sstyle=/i, JSON.stringify(state.phase));
        }
    });

    it('turns a refusal\'s code into the interface\'s own words, never the server\'s English', () => {
        const { InvitePage } = load();
        InvitePage.peek = { tenantName: 'Nour' };
        assert.equal(InvitePage.errorText({ code: 'EMAIL_EXISTS' }), 'invite.err.EMAIL_EXISTS');
        assert.equal(InvitePage.errorText({ code: 'WEAK_PASSWORD' }), 'invite.err.WEAK_PASSWORD');
        assert.equal(InvitePage.errorText({ code: 'SOMETHING_NEW', message: 'English from the server' }), 'invite.err.generic');
        assert.equal(InvitePage.errorText(null), 'invite.err.generic');
    });
});

describe('a suggested password', () => {
    it('is four groups of four, from an alphabet with nothing easy to misread, and long enough', () => {
        const { InvitePage } = load();
        const password = InvitePage.suggestPassword() as string;
        assert.match(password, /^[a-km-zA-HJ-NP-Z2-9]{4}(-[a-km-zA-HJ-NP-Z2-9]{4}){3}$/);
        assert.ok(password.length >= 12);
        assert.doesNotMatch(password, /[01OlI]/);
    });

    it('draws only from bytes that divide evenly: a byte past the last full run of the alphabet is thrown away, not folded', () => {
        const { InvitePage, ctx } = load();
        // 256 % 54 = 40, so bytes 216..255 are rejected. A source that only ever offers them would loop forever if it were folded
        // in with `%`, and cannot produce a password at all with rejection sampling; one that mixes in a good byte still can.
        let calls = 0;
        ctx.crypto.getRandomValues = (a: Uint8Array) => { calls += 1; for (let i = 0; i < a.length; i += 1) a[i] = i % 2 === 0 ? 255 : 3; return a; };
        const password = InvitePage.suggestPassword() as string;
        assert.equal(password.replace(/-/g, '').length, 16);
        assert.ok(calls >= 1);
        assert.equal(new Set(password.replace(/-/g, '')).size, 1, 'only the accepted byte (3) was used');
    });
});

describe('the password field\'s two helpers', () => {
    /** The field, the toggle (with its icon) and the status line, registered where the page looks for them. */
    function fixture() {
        const loaded = load();
        const icon = { attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
        const reveal = {
            ...element(), attrs: { 'aria-label': 'invite.show', title: 'invite.show' } as Record<string, string>,
            setAttribute(k: string, v: string) { this.attrs[k] = v; },
            getAttribute(k: string) { return this.attrs[k] ?? null; },
            querySelector: () => icon,
        };
        const field = { ...element(), type: 'password', value: '', selected: false, select() { this.selected = true; } };
        const note = element();
        loaded.elements['invite-password'] = field;
        loaded.elements['invite-suggested'] = note;
        loaded.ctx.document.querySelector = (selector: string) => (selector === '.invite-reveal' ? reveal : null);
        return { ...loaded, field, reveal, icon, note };
    }

    it('toggling shows and hides the password, keeping one name and carrying the state in aria-pressed', () => {
        const { InvitePage, field, reveal, icon } = fixture();
        InvitePage.toggleReveal(reveal);
        assert.equal(field.type, 'text');
        assert.equal(reveal.attrs['aria-pressed'], 'true');
        assert.equal(icon.attrs['data-lucide'], 'eye-off');
        InvitePage.toggleReveal(reveal);
        assert.equal(field.type, 'password');
        assert.equal(reveal.attrs['aria-pressed'], 'false');
        assert.equal(icon.attrs['data-lucide'], 'eye');
        assert.equal(reveal.attrs['aria-label'], 'invite.show', 'the accessible name never changes: it would be read twice beside the pressed state');
    });

    it('suggesting fills a strong password, shows it, selects it, and says so in a region that was already on the page', () => {
        const { InvitePage, field, reveal, note } = fixture();
        InvitePage.suggest();
        assert.match(field.value, /^[a-km-zA-HJ-NP-Z2-9]{4}(-[a-km-zA-HJ-NP-Z2-9]{4}){3}$/);
        assert.equal(field.type, 'text', 'a password the person cannot read is one they cannot save');
        assert.equal(field.selected, true);
        assert.equal(reveal.attrs['aria-pressed'], 'true');
        assert.equal(note.textContent, 'invite.suggested');
        assert.equal(note.classes.has('hidden'), false, 'never hidden: a live region has to exist before it speaks');
    });

    it('the markup ships that region empty and visible, not hidden', () => {
        const { InvitePage } = load();
        const markup = String(InvitePage.view({ phase: 'ready', peek: { tenantName: 'Nour', purpose: 'join', role: 'owner', sessionDays: 30, viewer: null } }));
        assert.match(markup, /<p class="form-hint invite-suggested" id="invite-suggested" role="status"><\/p>/);
    });
});

// ─── Routing: the token and the hash ─────────────────────────────────────────────────────────────

const TOKEN = 'A'.repeat(43);

describe('the app routes an invite hash to the invite page, before it looks for a session', () => {
    it('recognises #/invite with or without a query, and nothing that merely starts with those letters', () => {
        const { App, ctx } = load();
        const is = (hash: string): boolean => { ctx.location.hash = hash; return App.isInviteHash(); };
        for (const yes of ['#/invite', '#/invite?t=abc', '#/invite/', '#/invite#x', '#/invite?lang=en&t=abc']) assert.equal(is(yes), true, yes);
        for (const no of ['', '#/overview', '#/inviter', '#/invite_card', '#/invites', '#/tenants?x=#/invite', '#invite', '/invite']) assert.equal(is(no), false, no);
    });

    it('never lets an app page resolve to the invite page or its card, whatever the hash says', () => {
        const { App, ctx } = load();
        for (const hash of ['#/invite', '#/invite?t=x', '#/invite_card', '#/invite_card?id=1']) {
            ctx.location.hash = hash;
            assert.equal(App.pageFromHash(), 'overview', hash);
        }
        ctx.location.hash = '#/tenants';
        assert.equal(App.pageFromHash(), 'tenants', 'and a real page still resolves');
        assert.equal(App.pages.invite.routable, false);
        assert.equal(App.pages.invite_card.routable, false);
    });

    it('moves the token out of the address bar before anything renders, and keeps it for this tab', () => {
        const { App, ctx } = load({ hash: `#/invite?t=${TOKEN}&lang=ar` });
        App.captureInvite();
        assert.deepEqual(ctx.history.calls, ['#/invite'], 'the hash is cut back to a bare #/invite: no token, no language');
        assert.equal(ctx.location.hash, '#/invite');
        assert.equal(ctx.sessionStorage.getItem('invite_token'), TOKEN);
        assert.equal(App.inviteToken(), TOKEN);
        assert.equal(ctx.localStorage.getItem('invite_token'), null, 'never in localStorage, which outlives the tab');
    });

    it('still has the token after a reload, which is what a language switch does', () => {
        const first = load({ hash: `#/invite?t=${TOKEN}` });
        first.App.captureInvite();
        const second = load({ hash: '#/invite' });
        second.ctx.sessionStorage.setItem('invite_token', first.ctx.sessionStorage.getItem('invite_token'));
        second.App.captureInvite();
        assert.equal(second.ctx.history.calls.length, 0, 'nothing to cut: the hash is already bare');
        assert.equal(second.App.inviteToken(), TOKEN);
    });

    it('believes only what is shaped like a token: 43 base64url characters', () => {
        const { App, ctx } = load();
        for (const bad of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, `${'A'.repeat(42)} `, '<script>']) {
            ctx.sessionStorage.setItem('invite_token', bad);
            App._inviteToken = '';
            assert.equal(App.inviteToken(), '', JSON.stringify(bad));
        }
        ctx.sessionStorage.setItem('invite_token', TOKEN);
        assert.equal(App.inviteToken(), TOKEN);
    });

    it('forgets the token and the return flag together', () => {
        const { App, ctx } = load({ hash: `#/invite?t=${TOKEN}` });
        App.captureInvite();
        ctx.sessionStorage.setItem('invite_return', '1');
        App.forgetInvite();
        assert.equal(App.inviteToken(), '');
        assert.equal(ctx.sessionStorage.getItem('invite_return'), null);
    });

    it('takes the way back to a pending link exactly once, and only if one was asked for', () => {
        const { App, ctx } = load({ hash: `#/invite?t=${TOKEN}` });
        App.captureInvite();
        assert.equal(App.consumeInviteReturn(), false, 'nobody asked to come back');
        App.leaveInviteForLogin(true, 'person@example.com');
        assert.equal(ctx.sessionStorage.getItem('invite_return'), '1');
        assert.equal(App.consumeInviteReturn(), true);
        assert.equal(App.consumeInviteReturn(), false, 'one-shot');
        assert.equal(ctx.location.hash, '#/invite');
    });

    it('drops the link when the way on is not the link: a dead one, or one that is not theirs', () => {
        const { App, ctx } = load({ hash: `#/invite?t=${TOKEN}` });
        App.captureInvite();
        App.leaveInviteForLogin(false);
        assert.equal(App.inviteToken(), '');
        assert.equal(ctx.sessionStorage.getItem('invite_return'), null);
        assert.equal(ctx.location.hash, '', 'and the address bar is clean');
    });
});

describe('the login screen opens as the person last used it', () => {
    it('with the email field showing and filled when an address was remembered', () => {
        const { App, elements } = load();
        App.rememberEmail('Nour@Example.com');
        App.showLogin();
        assert.equal(elements['login-email']!.value, 'nour@example.com');
        assert.equal(elements['login-email-group']!.classes.has('hidden'), false);
        assert.equal(elements['login-email-toggle']!.classes.has('hidden'), true, 'the "use an account" link has nothing left to do');
        assert.equal(elements['login-keep']!.checked, false, 'never ticked for them');
        assert.equal(elements['login-screen']!.classes.has('hidden'), false);
        assert.equal(elements['invite-screen']!.classes.has('hidden'), true);
    });

    it('as the one-field shared-password form, exactly as it always was, when nothing was remembered', () => {
        const { App, elements } = load();
        App.showLogin();
        assert.equal(elements['login-email']!.value, '');
        assert.equal(elements['login-email-group']!.classes.has('hidden'), true);
        assert.equal(elements['login-email-toggle']!.classes.has('hidden'), false);
    });

    it('and "use the dashboard password instead" puts it back to the one-field form, address cleared', () => {
        const { App, ctx, elements } = load();
        App.rememberEmail('nour@example.com');
        App.showLogin();
        assert.equal(elements['login-email-group']!.classes.has('hidden'), false);
        const action = vm.runInContext('UI._actions.app.useSharedPassword', ctx) as () => void;
        action();
        assert.equal(elements['login-email']!.value, '', 'an empty address is what makes the login send the body it always sent');
        assert.equal(elements['login-email-group']!.classes.has('hidden'), true);
        assert.equal(elements['login-email-toggle']!.classes.has('hidden'), false);
    });
});

describe('the login remembers who signed in last', () => {
    it('keeps an address, lower-cased, and offers it back only if it still looks like one', () => {
        const { App, ctx } = load();
        assert.equal(App.rememberedEmail(), '');
        App.rememberEmail('  Nour@Example.COM ');
        assert.equal(ctx.localStorage.getItem('login_email'), 'nour@example.com');
        assert.equal(App.rememberedEmail(), 'nour@example.com');
        for (const bad of ['<script>alert(1)</script>', 'not an email', 'a@b', '']) {
            ctx.localStorage.setItem('login_email', bad);
            assert.equal(App.rememberedEmail(), '', JSON.stringify(bad));
        }
    });

    it('remembers nothing for the shared-password login, which has no address', () => {
        const { App, ctx } = load();
        App.rememberEmail('');
        assert.equal(ctx.localStorage.getItem('login_email'), null);
    });

    it('never stores a password or a token there', () => {
        const source = readFileSync('dashboard/js/app.js', 'utf8');
        for (const [, key] of source.matchAll(/localStorage\.setItem\(([^,]+),/g)) {
            assert.doesNotMatch(key!, /pass|token|secret/i, key);
        }
    });
});

// ─── The head script and the shell ───────────────────────────────────────────────────────────────

describe('index.html', () => {
    const index = readFileSync('dashboard/index.html', 'utf8');

    /** Run the head script against a hash and a stored language, and report what it decided. */
    function head(hash: string, stored: string | null): { stored: string | null; lang: string; attrs: Record<string, string> } {
        const script = /<script>\s*\/\* Applied before first paint[\s\S]*?<\/script>/.exec(index)![0].replace(/^<script>/, '').replace(/<\/script>$/, '');
        const local = store();
        if (stored !== null) local.setItem('dashboard_lang', stored);
        const attrs: Record<string, string> = {};
        const documentElement = { lang: 'ar', dir: 'rtl', setAttribute: (name: string, value: string) => { attrs[name] = value; } };
        const ctx = {
            location: { hash }, localStorage: local, navigator: { languages: ['ar'] }, document: {
                documentElement, head: { appendChild: () => undefined }, createElement: () => ({ setAttribute: () => undefined }),
            },
        };
        vm.runInNewContext(script, ctx);
        return { stored: local.getItem('dashboard_lang'), lang: documentElement.lang, attrs };
    }

    const decided = (r: ReturnType<typeof head>) => ({ stored: r.stored, lang: r.lang });

    it('takes the language a link names, once: it beats the stored choice, and sticks', () => {
        assert.deepEqual(decided(head('#/invite?t=abc&lang=en', 'ar')), { stored: 'en', lang: 'en' });
        assert.deepEqual(decided(head('#/invite?lang=ar&t=abc', 'en')), { stored: 'ar', lang: 'ar' });
        assert.deepEqual(decided(head('#/invite?t=abc&lang=en', null)), { stored: 'en', lang: 'en' });
    });

    it('leaves the language alone for anything that is not an invite link naming one', () => {
        assert.deepEqual(decided(head('#/overview?lang=en', 'ar')), { stored: 'ar', lang: 'ar' });
        assert.deepEqual(decided(head('#/invite?t=abc&lang=fr', 'ar')), { stored: 'ar', lang: 'ar' });
        assert.deepEqual(decided(head('#/invite?t=abc', 'en')), { stored: 'en', lang: 'en' });
        assert.deepEqual(decided(head('#/tenants?id=1#/invite?lang=en', 'ar')), { stored: 'ar', lang: 'ar' });
    });

    it('marks an invite link from the first frame, so the login card never flashes at somebody who has no password yet', () => {
        for (const hash of ['#/invite', '#/invite?t=abc', '#/invite?t=abc&lang=en']) assert.equal(head(hash, null).attrs['data-invite'], '1', hash);
        for (const hash of ['', '#/overview', '#/inviter', '#/tenants?x=#/invite']) assert.equal('data-invite' in head(hash, null).attrs, false, hash);
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        assert.match(css, /html\[data-invite\] #login-screen \{ display: none; \}/);
        assert.match(readFileSync('dashboard/js/app.js', 'utf8'), /document\.documentElement\.removeAttribute\('data-invite'\)/, 'and showLogin lifts it');
    });

    it('has the invite screen outside #app, hidden, with a card for the page to fill', () => {
        const appAt = index.indexOf('<div id="app"');
        const screenAt = index.indexOf('<div id="invite-screen"');
        assert.ok(screenAt > 0 && screenAt < appAt, 'before #app, a sibling of the login screen, not inside the app');
        assert.match(index, /<div id="invite-screen" class="login-screen hidden">/);
        assert.match(index, /<div id="invite-card" class="login-card surface invite-card"><\/div>/);
    });

    it('preloads the invite module for an invite hash, and keeps the two cache versions together', () => {
        assert.match(index, /'erasure', 'invite', 'welcome'\]/);
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        const version = /ASSET_VERSION: '([\w.]+)'/.exec(app)![1];
        assert.deepEqual([...new Set([...index.matchAll(/\?v=([\w.]+)/g)].map((m) => m[1]))], [version]);
    });

    it('shows "keep me signed in" and the way back to the shared password only with the email field', () => {
        assert.match(index, /<input type="checkbox" id="login-keep" name="keepSignedIn">/);
        assert.match(index, /data-i18n="login\.keep"/);
        assert.match(index, /data-action="app:useSharedPassword"/);
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        assert.match(css, /#login-email-group\.hidden ~ \.login-keep,\s*#login-email-group\.hidden ~ \.login-use-password \{ display: none; \}/);
    });
});

// ─── The platform admin's card ───────────────────────────────────────────────────────────────────

describe('the invite card escapes the tenant, the address and the link', () => {
    const invite = {
        id: 'i-1', creator_id: 't-1', purpose: 'join', role: 'owner', email: PAYLOAD, status: 'pending',
        created_at: '2026-10-14T10:00:00Z', expires_at: '2026-10-21T10:00:00Z', first_opened_at: null, open_count: 0, used_at: null,
        used_by_email: null, revoked_at: null, user_id: null,
        url: `https://app.example.test/dashboard#/invite?t=${TOKEN}&lang=ar`,
        whatsapp_text: `Hi ${PAYLOAD} ${QUOTE_BREAK}: https://app.example.test/dashboard#/invite?t=${TOKEN}&lang=ar`,
        lang: 'ar',
    };

    it('shows the link and its message as text and as attributes, quoted', () => {
        const { InviteCard } = load();
        const markup = String(InviteCard.linkView({ invite, tenantName: PAYLOAD }));
        assertInert(markup, 'link card');
        const attribute = invite.url.replace(/&/g, '&amp;');
        assert.ok(markup.includes(`value="${attribute}"`), 'the link is in a read-only field');
        assert.match(markup, /id="invite-link-field" readonly/);
        assert.ok(markup.includes(`data-copy="${attribute}"`), 'and on the Copy button');
    });

    it('builds the WhatsApp link from the message, encoded, so nothing in it can end the URL or the attribute', () => {
        const { InviteCard } = load();
        const markup = String(InviteCard.linkView({ invite, tenantName: 'Nour' }));
        const href = /href="(https:\/\/wa\.me\/\?text=[^"]*)"/.exec(markup);
        assert.ok(href, 'a wa.me link');
        const url = new URL(href![1]!.replace(/&amp;/g, '&'));
        assert.equal(url.origin, 'https://wa.me');
        assert.equal(url.searchParams.get('text'), invite.whatsapp_text, 'the whole message round-trips through the encoding');
        assert.match(markup, /target="_blank" rel="noopener noreferrer"/);
    });

    it('falls back to the link itself when the server sent no message, and refuses a link that is not http(s)', () => {
        const { InviteCard } = load();
        const bare = String(InviteCard.linkView({ invite: { ...invite, whatsapp_text: '', email: null }, tenantName: 'Nour' }));
        assert.ok(bare.includes(encodeURIComponent(invite.url)));
        const markup = String(InviteCard.linkView({ invite: { ...invite, whatsapp_text: 'x' }, tenantName: 'Nour' }));
        assert.doesNotMatch(markup, /href="javascript:/i);
    });

    it('a reset card names the address it is for, and says nothing about a role', () => {
        const { InviteCard } = load();
        const markup = String(InviteCard.linkView({ invite: { ...invite, purpose: 'reset', email: 'person@example.com' }, tenantName: 'Nour' }));
        assert.match(markup, /invites\.resetTitle/);
        assert.doesNotMatch(markup, /invites\.joinsAs/);
    });

    it('has Copy, WhatsApp, Regenerate and Revoke, and nothing inline', () => {
        const { InviteCard } = load();
        const markup = String(InviteCard.linkView({ invite: { ...invite, email: null }, tenantName: 'Nour' }));
        for (const needle of ['app:copyValue', 'wa.me', 'inviteCard:regenerate', 'inviteCard:revoke', 'inviteCard:done']) assert.ok(markup.includes(needle), needle);
        const handler = /\son[a-z]+=/i.exec(markup);
        assert.equal(handler, null, handler ? JSON.stringify(markup.slice(handler.index - 40, handler.index + 40)) : '');
    });

    it('a listed invite shows what can still be done to it, never a link', () => {
        const { InviteCard } = load();
        const item = (status: string, extra: Record<string, unknown> = {}) => String(InviteCard.itemView({ ...invite, email: 'p@example.com', status, ...extra }));
        for (const status of ['pending', 'opened']) {
            const markup = item(status);
            assert.ok(markup.includes('inviteCard:regenerate') && markup.includes('inviteCard:revokeFromList'), status);
        }
        for (const status of ['expired', 'revoked']) {
            const markup = item(status);
            assert.ok(markup.includes('inviteCard:regenerate'), status);
            assert.ok(!markup.includes('inviteCard:revokeFromList'), `${status}: nothing left to revoke`);
        }
        const used = item('used', { used_at: '2026-10-15T10:00:00Z', used_by_email: PAYLOAD });
        assert.ok(!used.includes('inviteCard:regenerate') && !used.includes('inviteCard:revokeFromList'), 'a used link is done');
        assertInert(used, 'used by');
        for (const status of ['pending', 'opened', 'used', 'expired', 'revoked']) {
            assert.ok(!item(status, { url: invite.url }).includes(TOKEN), `${status}: no token`);
        }
    });

    it('a status it has never heard of is shown as waiting, not as a class name', () => {
        const { InviteCard } = load();
        const markup = String(InviteCard.statusChip('"><script>'));
        assertInert(markup, 'status');
        assert.match(markup, /invites\.status\.pending/);
    });

    it('the list says what is loading, what failed and what is empty', () => {
        const { InviteCard } = load();
        assert.match(String(InviteCard.listView(null, false)), /common\.loading/);
        assert.match(String(InviteCard.listView(null, true)), /invites\.loadFailed/);
        assert.match(String(InviteCard.listView([], false)), /invites\.none/);
        assert.match(String(InviteCard.listView([invite], false)), /class="invite-list"/);
    });

    it('the create form escapes the tenant and offers the tenant\'s own language first', () => {
        const { InviteCard } = load();
        const markup = String(InviteCard.createView({ tenantName: PAYLOAD }));
        assertInert(markup, 'create');
        assert.match(markup, /<option value="" selected>invites\.langDefault<\/option>/);
        assert.match(markup, /data-submit="inviteCard:create"/);
    });
});

describe('the tenant detail\'s member row', () => {
    const { TenantDetailPage } = load();
    const member = (extra: Record<string, unknown> = {}) => String(TenantDetailPage.renderMember({
        userId: 'u-1', email: 'p@example.com', role: 'user', membershipRole: 'owner', isActive: true, ...extra,
    }));

    it('offers a reset link for an ordinary active member', () => {
        const markup = member();
        assert.match(markup, /data-action="tenantDetail:resetLink"/);
        assert.match(markup, /data-user-id="u-1"/);
    });

    it('offers none for a platform admin (their password is set from Users), a disabled account, or a row with no user id', () => {
        assert.doesNotMatch(member({ role: 'platform_admin' }), /resetLink/);
        assert.doesNotMatch(member({ isActive: false }), /resetLink/);
        assert.doesNotMatch(member({ userId: undefined }), /resetLink/);
    });

    it('escapes an address that is markup', () => {
        assertInert(member({ email: PAYLOAD }), 'member');
    });
});
