/**
 * The sidebar, organised by the creator's job (UX overhaul US6: T112, T114, T117, T119, T120; audit SH-01, SH-03, SH-04, SH-06, SH-08,
 * SH-24, SH-27, SH-31, OV-33).
 *
 * What a screenshot cannot say, pinned against the REAL shipped files (`dashboard/index.html`, `app.js`, `components.js`, the catalogues,
 * `styles.css`) through `_harness.ts`:
 *   - the structure: four job groups, each a list named by its visible heading, then Administration, then Settings, Help and the
 *     account area; ten creator items, and no item for what moved inside another screen (SC-005);
 *   - the behaviour the markup cannot carry: which item reads as current for a page that has none of its own, the Administration group
 *     opening for an admin page and remembering the viewer, its status dot, the identity line, the modified click, the drawer's `inert`,
 *     the marker landing on the right item in both directions, the first frame of a stored session;
 *   - the Results strip on both Results pages, including when the page failed to load.
 *
 * `FakeEl` has no layout and no selectors (`querySelector` answers null): where a behaviour needs either, the test hands the app plain
 * objects with the few members it reads (`item`, `host`), and says what each stands for. Anything that needs real layout (the marker's
 * position in a real sidebar, the drawer sliding, the skeleton's look) is verified live (constitution VI).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { FakeEl, loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

const read = (path: string): string => readFileSync(path, 'utf8');
/** The app's objects come from another realm (`node:vm`), so a deep comparison goes through JSON. */
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const INDEX = read('dashboard/index.html');
const CSS = read('dashboard/css/styles.css');

// ─── Reading the shell's markup ───────────────────────────────────────────────────────────────

interface Group { cls: string; labelId: string; labelKey: string; listId: string; labelledBy: string; role: string; pages: string[]; markup: string }

/** The `.sidebar-nav` block of index.html: the groups between the marker and the foot. */
function navBlock(): string {
    const from = INDEX.indexOf('<div class="sidebar-nav" id="sidebar-nav">');
    const to = INDEX.indexOf('<div class="sidebar-footer">');
    assert.ok(from > 0 && to > from, 'the sidebar markup is where the test looks for it');
    return INDEX.slice(from, to);
}

/** Every `.nav-group` in the scrolling list, in order, with what a screen reader is told about it. */
function groups(): Group[] {
    return [...navBlock().matchAll(/<div class="(nav-group[^"]*)"[^>]*>([\s\S]*?)<\/ul>\s*<\/div>/g)].map((m) => {
        const markup = `${m[2]}</ul>`;
        const label = /<(?:span|button)[^>]*\bid="(nav-group-[a-z]+)"[^>]*data-i18n="(nav\.group\.[a-z]+)"/.exec(markup) ?? /\bid="(nav-group-[a-z]+)"[^>]*data-i18n="(nav\.group\.[a-z]+)"/.exec(markup);
        const list = /<ul class="nav-list"(?: id="([^"]+)")? role="(\w+)" aria-labelledby="([^"]+)"/.exec(markup);
        return {
            cls: m[1]!,
            labelId: label?.[1] ?? '',
            labelKey: label?.[2] ?? '',
            listId: list?.[1] ?? '',
            role: list?.[2] ?? '',
            labelledBy: list?.[3] ?? '',
            pages: [...markup.matchAll(/data-page="([a-z_]+)"/g)].map((p) => p[1]!),
            markup,
        };
    });
}

/** The pages named by the foot's two links, in order. */
function footPages(): string[] {
    const foot = INDEX.slice(INDEX.indexOf('<div class="sidebar-foot-nav"'), INDEX.indexOf('<div class="nav-account">'));
    return [...foot.matchAll(/data-page="([a-z_]+)"/g)].map((m) => m[1]!);
}

// ─── The structure ────────────────────────────────────────────────────────────────────────────
describe('sidebar: four job groups, Administration, then the foot (T114)', () => {
    it('is Today, Replies, Content, Results, in that order, and Administration after them', () => {
        const found = groups();
        assert.deepEqual(found.map((g) => g.labelKey), ['nav.group.today', 'nav.group.replies', 'nav.group.content', 'nav.group.results', 'nav.group.admin']);
        assert.deepEqual(found.slice(0, 4).map((g) => g.pages), [['overview', 'inbox'], ['campaigns', 'ai_settings'], ['studio', 'posts'], ['analytics', 'growth', 'ads']]);
        assert.deepEqual(found[4]!.pages, ['operations', 'tenants', 'users', 'jobs', 'audit', 'erasure']);
        assert.deepEqual(footPages(), ['settings', 'help']);
    });

    it('builds every group as a <ul role="list"> named (aria-labelledby) by a heading that is on screen', () => {
        for (const g of groups()) {
            assert.equal(g.role, 'list', `${g.labelKey}: role="list", so Safari keeps the list that list-style none removes`);
            assert.ok(g.labelId, `${g.labelKey}: has a heading with an id`);
            assert.equal(g.labelledBy, g.labelId, `${g.labelKey}: the list is named by its own heading`);
            assert.equal((INDEX.match(new RegExp(`id="${g.labelId}"`, 'g')) ?? []).length, 1, `${g.labelId} is unique`);
        }
        // A group's items are <li> children of that list: nothing else sits in it.
        for (const g of groups()) {
            const items = (g.markup.match(/<li(?:\s[^>]*)?>/g) ?? []).length;
            assert.equal(items, g.pages.length, `${g.labelKey}: one <li> per link`);
        }
    });

    it('has eleven creator items (9 job items, Settings, Help; Ads is the owner\'s alone): SC-005, down from thirteen', () => {
        const job = groups().slice(0, 4).flatMap((g) => g.pages);
        assert.equal(job.length, 9);
        assert.equal(job.length + footPages().length, 11);
        const all = [...INDEX.matchAll(/<a href="#\/[a-z_]+" class="nav-item(?: active)?" data-page="([a-z_]+)"/g)].map((m) => m[1]!);
        assert.equal(all.length, 11 + 6, 'every sidebar link: eleven for the creator, six for the platform admin');
        assert.equal(new Set(all).size, all.length, 'no page twice');
    });

    it('has no item for what lives inside another screen: Monteur and Infographics (Studio), the Activity Log (Results)', () => {
        for (const page of ['monteur', 'infographics', 'activity']) {
            assert.equal(INDEX.includes(`data-page="${page}"`), false, `${page}: no item of its own`);
            assert.equal(INDEX.includes(`href="#/${page}" class="nav-item`), false, `${page}: no nav link`);
        }
        assert.equal((INDEX.match(/data-page="studio"/g) ?? []).length, 1, 'Studio is ONE entry');
    });

    it('names the page of every link by the same key as that page’s title, and paints the Arabic of the dictionary before any script runs', () => {
        const ar = loadDashboard({ lang: 'ar' });
        const en = loadDashboard({ lang: 'en' });
        const links = [...INDEX.matchAll(/<a href="#\/([a-z_]+)" class="nav-item(?: active)?" data-page="([a-z_]+)">[\s\S]*?<span data-i18n="([^"]+)">([^<]*)<\/span>/g)];
        assert.equal(links.length, 17);
        for (const [, href, page, key, text] of links) {
            assert.equal(href, page, `${page}: the address is the page`);
            assert.equal(key, `nav.${page}`, `${page}: the label IS the page title, so the two cannot drift`);
            assert.equal(text, ar.t(key!), `${page}: the markup paints what the Arabic dictionary says`);
            assert.ok(en.t(key!) && en.t(key!) !== key, `${page}: it has an English label`);
        }
    });

    it('puts the brand mark on a link home, and leaves it out of the marker’s items', () => {
        assert.match(INDEX, /<a href="#\/overview" class="sidebar-logo" data-nav-home>\s*<div class="logo-mark">/);
        assert.equal(/data-nav-home[^>]*data-page/.test(INDEX), false, 'it is not a nav item: it has no marker of its own');
    });
});

describe('sidebar: Administration is one collapsible group (T114, SH-04)', () => {
    const admin = (): Group => groups().find((g) => g.cls.includes('nav-group--admin'))!;

    it('is a real button (aria-expanded, aria-controls) over a list that starts hidden', () => {
        const g = admin();
        assert.ok(g, 'one admin group');
        assert.match(g.markup, /<button type="button" class="nav-group-toggle" id="nav-admin-toggle" aria-expanded="false" aria-controls="nav-admin-list"\s+data-action="app:toggleAdminGroup">/);
        assert.equal(g.listId, 'nav-admin-list', 'the button controls THIS list');
        assert.match(g.markup, /<ul class="nav-list" id="nav-admin-list" role="list" aria-labelledby="nav-group-admin" hidden>/);
        assert.ok(g.cls.split(' ').includes('hidden') && /data-admin-only/.test(INDEX.slice(INDEX.indexOf('id="nav-admin"') - 80, INDEX.indexOf('id="nav-admin"') + 80)), 'for a platform admin only: App.applyChrome reveals it');
    });

    it('carries the problem dot hidden, with a word for a screen reader, and keeps Change password out', () => {
        const g = admin();
        assert.match(g.markup, /<span class="nav-dot" id="nav-admin-dot" hidden><span class="sr-only" data-i18n="nav\.adminAttention">/);
        assert.equal(g.markup.includes('password'), false, 'Change password is not in Administration (it is every account’s)');
    });
});

describe('sidebar: the foot is Settings, Help, then the account area (T114, SH-27)', () => {
    it('lists Settings and Help, then who is signed in, then Change password and Log out', () => {
        const at = (needle: string): number => INDEX.indexOf(needle);
        const order = ['data-page="settings"', 'data-page="help"', 'id="nav-identity"', 'id="password-btn"', 'id="logout-btn"'].map(at);
        assert.ok(order.every((n) => n > 0), 'all five are in the shell');
        assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order');
        assert.ok(at('data-i18n="nav.group.admin"') < order[0]!, 'after the group list');
        // The account area is one block, and the password button is still the one for real accounts only.
        const area = INDEX.slice(at('<div class="nav-account">'), at('</nav>'));
        assert.match(area, /<button id="password-btn" type="button" class="nav-item hidden" data-user-only/);
        assert.match(area, /<p class="nav-identity" id="nav-identity" hidden>/);
    });

    it('gives the foot its own marker, because it is not inside the list the first one lives in', () => {
        assert.match(INDEX, /<div class="sidebar-foot-nav" id="sidebar-foot-nav">\s*<span class="nav-indicator nav-indicator--foot" id="nav-indicator-foot" aria-hidden="true">/);
        assert.equal((INDEX.match(/class="nav-indicator\b/g) ?? []).length, 2);
    });
});

// ─── Which item is current ───────────────────────────────────────────────────────────────────

/** The shell's app.js, with `.nav-item[data-page]` answering for fake links and every page a fake that only records. */
function rig(options: { lang?: 'ar' | 'en'; admin?: boolean; globals?: Record<string, unknown> } = {}) {
    const log: string[] = [];
    const h = loadDashboard({ app: true, lang: options.lang ?? 'en', globals: { Admin: { confirm: () => {} }, ...(options.globals ?? {}) } });
    for (const id of ['page-title', 'page-subtitle', 'page-container', 'sidebar', 'main-content', 'mobile-menu-btn']) h.el(id);
    const items: Record<string, FakeEl> = {};
    for (const page of ['overview', 'inbox', 'campaigns', 'ai_settings', 'studio', 'posts', 'analytics', 'growth', 'ads', 'settings', 'help', 'operations', 'tenants', 'users', 'jobs', 'audit', 'erasure']) {
        items[page] = new FakeEl('', 'a');
        items[page]!.dataset = { page };
    }
    h.document.querySelectorAll = (selector: string): FakeEl[] => (selector === '.nav-item[data-page]' ? Object.values(items) : []);
    for (const name of Object.keys(h.App.pages)) {
        const entry = h.App.pages[name];
        if (entry.routable === false) continue;
        h.App.pages[name] = { ...entry, page: () => ({ render: () => { log.push(`render ${name}`); }, destroy: () => { log.push(`destroy ${name}`); } }) };
    }
    if (options.admin) h.App.session = { available: true, role: 'platform_admin', userId: null, email: '', tenantId: 't1', tenantRole: 'owner', tenants: [{ id: 't1' }], onboarding: null };
    return { h, App: h.App as Json, items, log, active: (): string[] => Object.entries(items).filter(([, el]) => el.classes.has('active')).map(([page]) => page) };
}

describe('sidebar: a page with no item of its own reads as the item it belongs to (T117, navAs)', () => {
    it('registers Monteur and Infographics under Studio and the Log under Results, and leaves every address alone', () => {
        const { App } = rig();
        assert.equal(App.pages.monteur.navAs, 'studio');
        assert.equal(App.pages.infographics.navAs, 'studio');
        assert.equal(App.pages.activity.navAs, 'analytics');
        for (const old of ['monteur', 'infographics', 'activity', 'analytics', 'operations', 'tenants', 'users', 'jobs', 'audit', 'erasure']) {
            assert.ok(App.entryOf(old) && !App.entryOf(old).aliasOf, `#/${old} is still a page`);
        }
    });

    for (const [page, reads] of [
        ['studio', 'studio'], ['monteur', 'studio'], ['infographics', 'studio'],
        ['analytics', 'analytics'], ['activity', 'analytics'],
        ['overview', 'overview'], ['posts', 'posts'], ['settings', 'settings'], ['help', 'help'],
    ] as const) {
        it(`#/${page} marks exactly one item current: ${reads}`, async () => {
            const r = rig({ admin: true });
            r.App.markNavItem(page);
            assert.deepEqual(r.active(), [reads]);
            assert.equal(r.items[reads]!.getAttribute('aria-current'), 'page', 'and says so to assistive technology');
            const others = Object.entries(r.items).filter(([name]) => name !== reads);
            assert.ok(others.every(([, el]) => el.getAttribute('aria-current') === null), 'nobody else does');
        });
    }

    it('keeps Tenants current on a tenant’s own page, as before', () => {
        const r = rig({ admin: true });
        r.App.markNavItem('tenant_detail');
        assert.deepEqual(r.active(), ['tenants']);
    });

    it('does it through a real navigation, and moves the marker with it', async () => {
        const r = rig();
        r.h.location.hash = '#/monteur';
        await r.App.navigate('monteur');
        assert.deepEqual(r.active(), ['studio']);
        await r.App.navigate('activity');
        assert.deepEqual(r.active(), ['analytics']);
        assert.equal(r.h.el('page-title').textContent, r.h.t('nav.activity'), 'the page keeps its own title: it is the Log');
        assert.equal(r.h.document.title, `${r.h.t('nav.activity')} · ${r.h.t('app.name')}`);
    });
});

// ─── Administration: open, closed, remembered ────────────────────────────────────────────────

function adminShell(globals: Record<string, unknown> = {}) {
    const r = rig({ admin: true, globals });
    const toggle = r.h.el('nav-admin-toggle');
    toggle.setAttribute('aria-expanded', 'false');
    const list = r.h.el('nav-admin-list');
    list.hidden = true;
    const group = r.h.el('nav-admin');
    const dot = r.h.el('nav-admin-dot');
    dot.hidden = true;
    const moves: boolean[] = [];
    r.App.moveNavIndicator = (animate: boolean): void => { moves.push(animate); };
    const stored = (): string | null => r.h.run<string | null>(`localStorage.getItem(${JSON.stringify('dashboard_admin_group')})`);
    return { ...r, toggle, list, group, dot, moves, stored, isOpen: (): boolean => toggle.getAttribute('aria-expanded') === 'true' && list.hidden === false };
}

describe('Administration group: closed by default, open for an admin page, remembered per viewer (SH-04)', () => {
    it('is closed until somebody opens it: the button says so, and its links are not rendered', () => {
        const s = adminShell();
        s.App.syncAdminGroup('overview');
        assert.equal(s.toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(s.list.hidden, true);
        assert.equal(s.isOpen(), false);
    });

    it('opens for every administration page, a tenant’s own page (which reads as Tenants) included', () => {
        const s = adminShell();
        for (const page of ['operations', 'tenants', 'tenant_detail', 'users', 'jobs', 'audit', 'erasure']) {
            s.App.syncAdminGroup('overview');
            assert.equal(s.isOpen(), false, `closed on Today before ${page}`);
            s.App.syncAdminGroup(page);
            assert.equal(s.isOpen(), true, `open on ${page}`);
            assert.ok(s.group.classes.has('is-open'));
        }
        assert.equal(s.stored(), null, 'opening it for a page is not a choice, so nothing is remembered');
    });

    it('does not open for the creator’s pages, nor for a dialog module that happens to be admin-only', () => {
        const s = adminShell();
        for (const page of ['overview', 'inbox', 'studio', 'monteur', 'activity', 'settings', 'help']) {
            s.App.syncAdminGroup(page);
            assert.equal(s.isOpen(), false, page);
        }
        assert.equal(s.App.isAdminPage('invite_card'), false, 'admin-only but not a screen');
        assert.equal(s.App.isAdminPage('ai_providers'), false);
        assert.equal(s.App.isAdminPage('operations'), true);
    });

    it('closes again on the way out of an admin page, to what the viewer chose', async () => {
        const s = adminShell();
        s.h.location.hash = '#/operations';
        await s.App.navigate('operations');
        assert.equal(s.isOpen(), true);
        await s.App.navigate('overview');
        assert.equal(s.isOpen(), false);
    });

    it('opens and closes with the button, and remembers each choice', () => {
        const s = adminShell();
        s.App.toggleAdminGroup();
        assert.equal(s.isOpen(), true);
        assert.equal(s.stored(), 'open');
        // A fresh page load for the same viewer: the choice is read back.
        s.App.syncAdminGroup('overview');
        assert.equal(s.isOpen(), true, 'still open on Today: it is how they left it');
        s.App.toggleAdminGroup();
        assert.equal(s.isOpen(), false);
        assert.equal(s.stored(), 'closed');
        s.App.syncAdminGroup('inbox');
        assert.equal(s.isOpen(), false);
    });

    it('measures the marker again after the button, without a slide: the active item may be in the group that just closed', () => {
        const s = adminShell();
        s.App.toggleAdminGroup();
        s.App.toggleAdminGroup();
        assert.deepEqual(s.moves, [false, false]);
    });

    it('works when the browser will not store anything (private mode): closed by default, and the button still works', () => {
        const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
        const s = adminShell({ localStorage: denied });
        assert.doesNotThrow(() => s.App.syncAdminGroup('overview'));
        assert.equal(s.isOpen(), false);
        assert.doesNotThrow(() => s.App.toggleAdminGroup());
        assert.equal(s.isOpen(), true, 'the choice holds for this page view');
    });
});

// ─── The status dot ─────────────────────────────────────────────────────────────────────────

describe('Administration dot: the platform has a problem (counts.platform), hidden at zero', () => {
    const answer = (platform: unknown) => ({ checkedAt: 'now', items: [], counts: { inbox: 0, studio: 0, scheduler: 0, ...(platform === undefined ? {} : { platform }) } });

    it('reads counts.platform as a whole number, and anything else as none', () => {
        const { App } = rig();
        assert.equal(App.platformProblemCount(answer(2)), 2);
        assert.equal(App.platformProblemCount(answer(1.9)), 1);
        for (const bad of [answer(0), answer(-3), answer(undefined), answer('x'), answer(null), {}, null, undefined, { counts: null }]) {
            assert.equal(App.platformProblemCount(bad), 0, JSON.stringify(bad));
        }
    });

    it('shows the dot for one problem or more, and removes it at zero', async () => {
        let platform: unknown = 2;
        const calls: string[] = [];
        const s = adminShell({ API: { token: 't', request: async (path: string) => { calls.push(path); return answer(platform); } } });
        await s.App.refreshAdminStatus();
        assert.deepEqual(calls, ['/attention']);
        assert.equal(s.dot.hidden, false);
        platform = 0;
        await s.App.refreshAdminStatus();
        assert.equal(s.dot.hidden, true);
    });

    it('keeps what the dot said when the read fails, and never asks for a session that is not an admin’s', async () => {
        let fail = false;
        const calls: string[] = [];
        const s = adminShell({ API: { token: 't', request: async (path: string) => { calls.push(path); if (fail) throw new Error('500'); return answer(1); } } });
        await s.App.refreshAdminStatus();
        assert.equal(s.dot.hidden, false);
        fail = true;
        await s.App.refreshAdminStatus();
        assert.equal(s.dot.hidden, false, 'a failed read is not "all clear"');
        s.App.session.role = 'user';
        const before = calls.length;
        await s.App.refreshAdminStatus();
        assert.equal(calls.length, before, 'no request: counts.platform is sent to nobody else');
        assert.equal(s.dot.hidden, true, 'and a session that is not an admin’s has no dot');
    });

    it('polls once however often the chrome is applied, and stops (and clears the dot) at sign-out', async () => {
        const calls: string[] = [];
        const s = adminShell({ API: { token: 't', request: async (path: string) => { calls.push(path); return answer(3); } } });
        s.App.startAdminStatusPoll();
        s.App.startAdminStatusPoll();
        await settle();
        assert.equal(calls.length, 1, 'the second start changed nothing');
        assert.ok(s.App._adminStatusTimer, 'a timer is running');
        assert.equal(s.dot.hidden, false);
        s.App.stopAdminStatusPoll();
        assert.equal(s.App._adminStatusTimer, null);
        assert.equal(s.dot.hidden, true);
        s.App.startAdminStatusPoll();
        await settle();
        assert.equal(calls.length, 2, 'and it can start again');
        s.App.stopAdminStatusPoll();
    });

    it('asks every two minutes, and only while the tab is visible', () => {
        const { App } = rig();
        assert.equal(App.ADMIN_STATUS_MS, 120000);
        const src = read('dashboard/js/app.js');
        assert.match(src, /setInterval\(\(\) => \{\s*if \(document\.visibilityState === 'visible'\) this\.refreshAdminStatus\(\);/);
    });

    it('is drawn in the danger tone, because it states what broke, and the waiting count is not', () => {
        const rule = (selector: string): string => (new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(CSS) ?? [])[1] ?? '';
        assert.match(rule('.nav-dot'), /background:\s*var\(--danger\)/);
        const count = rule('.nav-count');
        assert.ok(count.length > 40, 'the rule was found');
        assert.equal(/danger/.test(count), false, 'a count of people waiting is work, not a failure (SH-31)');
        assert.match(count, /background:\s*var\(--accent\)/);
        assert.match(count, /color:\s*var\(--text-on-accent\)/);
    });
});

// ─── Who is signed in ───────────────────────────────────────────────────────────────────────

describe('account area: who is signed in (SH-27)', () => {
    const session = (over: Json = {}): Json => ({ available: true, userId: null, email: '', role: 'user', tenantId: 't', tenantRole: 'owner', tenants: [{ id: 't' }], onboarding: null, ...over });
    const shell = (lang: 'ar' | 'en' = 'en') => {
        const r = rig({ lang });
        const line = r.h.el('nav-identity');
        line.hidden = true;
        const text = r.h.el('nav-identity-text');
        const remember = (email: string): void => { r.h.run(`localStorage.setItem('login_email', ${JSON.stringify(email)})`); };
        return { ...r, line, text, remember };
    };

    it('says "Shared dashboard login" for the shared password, which has no user', () => {
        const s = shell();
        s.App.session = session();
        assert.deepEqual(plain(s.App.identityLabel()), { kind: 'shared', text: 'Shared dashboard login' });
        s.App.renderIdentity();
        assert.equal(s.line.hidden, false);
        assert.equal(s.text.textContent, 'Shared dashboard login');
        assert.equal(s.line.getAttribute('title'), 'Shared dashboard login');
        assert.equal(s.text.getAttribute('dir'), 'auto', 'words are read in the interface’s direction');
    });

    it('says it in Arabic too', () => {
        const s = shell('ar');
        s.App.session = session();
        assert.equal(s.App.identityLabel().text, s.h.t('nav.account.shared'));
        assert.equal(s.h.t('nav.account.shared'), 'الدخول المشترك للوحة');
    });

    it('shows the email when the session has one, as its own left-to-right run', () => {
        const s = shell('ar');
        s.App.session = session({ userId: 'u1', email: '  owner@example.com ' });
        assert.deepEqual(plain(s.App.identityLabel()), { kind: 'email', text: 'owner@example.com' });
        s.App.renderIdentity();
        assert.equal(s.text.textContent, 'owner@example.com');
        assert.equal(s.text.getAttribute('dir'), 'ltr', 'an address is Latin text inside an Arabic line');
        assert.equal(s.line.getAttribute('title'), 'owner@example.com', 'the whole address, when the line is cut');
    });

    it('falls back to the address typed at this browser’s last account sign-in, and then to the fact (/auth/me carries no email today)', () => {
        const s = shell();
        s.App.session = session({ userId: 'u1' });
        assert.deepEqual(plain(s.App.identityLabel()), { kind: 'account', text: 'Signed in with an account' });
        s.remember('someone@example.com');
        assert.deepEqual(plain(s.App.identityLabel()), { kind: 'email', text: 'someone@example.com' });
    });

    it('never puts a remembered address on the shared password’s session', () => {
        const s = shell();
        s.remember('someone@example.com');
        s.App.session = session({ userId: null });
        assert.equal(s.App.identityLabel().kind, 'shared');
    });

    it('says nothing when the shell could not read the session, and shows nothing it could not say', () => {
        const s = shell();
        s.App.session = null;
        assert.equal(s.App.identityLabel(), null);
        s.App.session = { available: false, userId: null, email: '' };
        assert.equal(s.App.identityLabel(), null);
        s.App.renderIdentity();
        assert.equal(s.line.hidden, true);
        assert.equal(s.text.textContent, '');
    });

    it('reads the email from /auth/me when the server sends one, and is empty when it does not', async () => {
        const answers: Json[] = [{ userId: 'u1', email: 'a@b.co', role: 'user', tenants: [] }, { userId: null, role: 'platform_admin', tenants: [] }];
        const s = rig({ globals: { API: { token: 't', getMe: async () => answers.shift() } } });
        await s.App.loadSession();
        assert.equal(s.App.session.email, 'a@b.co');
        await s.App.loadSession();
        assert.equal(s.App.session.email, '');
    });
});

// ─── Clicks ─────────────────────────────────────────────────────────────────────────────────

/** A click event as the browser hands it to a listener: it records whether the page cancelled it. */
const click = (over: Json = {}): Json => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, prevented: 0, preventDefault() { this.prevented++; }, ...over });

describe('nav links: the browser keeps Cmd, Ctrl, Shift and middle clicks (SH-24)', () => {
    it('hands a modified click back to the browser, and takes a plain one', () => {
        const { App } = rig();
        for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }]) {
            assert.equal(App.isModifiedClick(click(mod)), true, JSON.stringify(mod));
        }
        for (const plain of [click(), click({ button: undefined }), {}]) assert.equal(App.isModifiedClick(plain), false);
        assert.equal(App.isModifiedClick(null), false);
    });

    it('routes a plain click (preventDefault, then the router), and never cancels a modified one', () => {
        const { App, h } = rig();
        const went: string[] = [];
        App.go = (page: string): void => { went.push(page); };
        const plain = click();
        assert.equal(App.handleNavClick(plain, 'inbox'), true);
        assert.equal(plain.prevented, 1);
        assert.deepEqual(went, ['inbox']);
        for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
            const event = click(mod);
            assert.equal(App.handleNavClick(event, 'posts'), false);
            assert.equal(event.prevented, 0, `${JSON.stringify(mod)}: left alone, so the link opens where the person asked`);
        }
        assert.deepEqual(went, ['inbox'], 'and the app did not navigate under it');
        void h;
    });

    it('binds every nav link and the brand mark, through the same rule', () => {
        const r = rig();
        const bound = new Map<FakeEl, Array<(e: Json) => void>>();
        const record = (el: FakeEl): FakeEl => {
            el.addEventListener = (type: string, fn: (e: Json) => void): void => { if (type === 'click') bound.set(el, [...(bound.get(el) ?? []), fn]); };
            return el;
        };
        Object.values(r.items).forEach(record);
        const home = record(new FakeEl('', 'a'));
        r.h.document.querySelector = (selector: string): FakeEl | null => (selector === '[data-nav-home]' ? home : null);
        const went: string[] = [];
        r.App.go = (page: string): void => { went.push(page); };
        r.App.prefetchPageModule = (): void => {};
        r.App.bindNavLinks();
        assert.equal(bound.size, 18, '17 links and the brand mark');
        bound.get(r.items.help!)![0]!(click());
        bound.get(home)![0]!(click());
        bound.get(r.items.studio!)![0]!(click({ ctrlKey: true }));
        assert.deepEqual(went, ['help', 'overview'], 'the brand goes to Today; the Ctrl-click went nowhere');
    });
});

// ─── The drawer ─────────────────────────────────────────────────────────────────────────────

describe('mobile drawer: nobody reaches what is not on screen (SH-06)', () => {
    /** `matchMedia` as the browser answers it, with a way to cross the breakpoint. */
    function drawerShell(narrow: boolean) {
        const r = rig();
        const state = { narrow };
        const listeners: Array<() => void> = [];
        r.h.window.matchMedia = (query: string) => ({
            get matches() { return query === '(max-width: 860px)' ? state.narrow : false; },
            addEventListener: (_t: string, fn: () => void): void => { listeners.push(fn); },
            removeEventListener: () => {},
        });
        const sidebar = r.h.el('sidebar');
        const main = r.h.el('main-content');
        const menu = r.h.el('mobile-menu-btn');
        return { ...r, state, listeners, sidebar, main, menu, cross: (to: boolean): void => { state.narrow = to; listeners.forEach((fn) => fn()); } };
    }

    it('makes the closed drawer inert at drawer width, and nothing inert at desktop width', () => {
        const narrow = drawerShell(true);
        narrow.App.syncDrawerInert();
        assert.equal(narrow.sidebar.hasAttribute('inert'), true, 'its links are skipped by Tab and by a screen reader’s cursor');
        assert.equal(narrow.main.hasAttribute('inert'), false);
        const wide = drawerShell(false);
        wide.App.syncDrawerInert();
        assert.equal(wide.sidebar.hasAttribute('inert'), false, 'at desktop width the sidebar is part of the page');
        assert.equal(wide.main.hasAttribute('inert'), false);
    });

    it('swaps them while the drawer is open: the drawer is live, the page behind the scrim is not', () => {
        const s = drawerShell(true);
        s.App.openMobileDrawer();
        assert.equal(s.sidebar.classes.has('open'), true);
        assert.equal(s.sidebar.hasAttribute('inert'), false);
        assert.equal(s.main.hasAttribute('inert'), true, 'Tab cannot leave the drawer for the page');
        s.App.closeMobileDrawer(false);
        assert.equal(s.sidebar.hasAttribute('inert'), true);
        assert.equal(s.main.hasAttribute('inert'), false);
    });

    it('lifts the drawer’s inert BEFORE it moves focus into it, and the page’s BEFORE it returns focus to the menu button', () => {
        const s = drawerShell(true);
        s.App.syncDrawerInert();
        const seen: string[] = [];
        s.sidebar.focus = (): void => { seen.push(`drawer focus, inert=${s.sidebar.hasAttribute('inert')}`); };
        s.menu.focus = (): void => { seen.push(`menu focus, page inert=${s.main.hasAttribute('inert')}`); };
        s.App.openMobileDrawer();
        s.App.closeMobileDrawer(true);
        assert.deepEqual(seen, ['drawer focus, inert=false', 'menu focus, page inert=false'], 'a focus() on an inert element does nothing');
    });

    it('closes an open drawer when the window is widened past the breakpoint, and follows the width both ways', () => {
        const s = drawerShell(true);
        s.App.watchDrawerLayout();
        s.App.openMobileDrawer();
        assert.equal(s.main.hasAttribute('inert'), true);
        s.cross(false);
        assert.equal(s.sidebar.classes.has('open'), false, 'there is no scrim at desktop width');
        assert.equal(s.main.hasAttribute('inert'), false, 'and the page is not left inert');
        assert.equal(s.sidebar.hasAttribute('inert'), false);
        s.cross(true);
        assert.equal(s.sidebar.hasAttribute('inert'), true, 'narrowed again: closed and inert');
    });

    it('opens in Arabic too: the open rule is as specific as the right-to-left closed one it undoes', () => {
        // `html[dir='rtl'] .sidebar { transform: translateX(100%) }` (0,2,1) beat `.sidebar.open { transform: none }` (0,2,0), so in Arabic
        // the hamburger set aria-expanded and the open class and the drawer never moved. Found by opening it in a browser, not by a test.
        const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
        const specificity = (selector: string): number[] => {
            const ids = (selector.match(/#[\w-]+/g) ?? []).length;
            const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
            const bare = selector.replace(/\[[^\]]*\]|\.[\w-]+|#[\w-]+|:[\w-]+/g, ' ');
            return [ids, classes, (bare.match(/\b[a-z][\w-]*\b/gi) ?? []).length];
        };
        const beats = (a: number[], b: number[]): boolean => (a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!) >= 0;
        const closedRtl = specificity("html[dir='rtl'] .sidebar");
        const openRule = /([^{}]*\.sidebar\.open[^{}]*)\{\s*transform:\s*none;\s*\}/.exec(css);
        assert.ok(openRule, 'the open rule is there');
        const selectors = openRule[1]!.split(',').map((x) => x.trim());
        const rtlOpen = selectors.find((x) => /^html\[dir='rtl'\] \.sidebar\.open$/.test(x));
        assert.ok(rtlOpen, 'it names the right-to-left case');
        assert.ok(beats(specificity(rtlOpen), closedRtl), 'and is at least as specific as the closed one, so in Arabic the open drawer wins');
    });

    it('keeps the 860px breakpoint the stylesheet uses', () => {
        const { App } = rig();
        assert.equal(App.DRAWER_QUERY, '(max-width: 860px)');
        assert.match(CSS, /@media \(max-width: 860px\) \{[\s\S]*?\.sidebar \{\s*transform: translateX\(-100%\);/);
    });
});

// ─── The marker ─────────────────────────────────────────────────────────────────────────────

/** A link as the marker reads it: whether it is hidden or in a closed group, and where it is. */
const link = (top: number, height = 44, visible: () => boolean = () => true): Json => ({
    classList: { contains: (name: string): boolean => name === 'active' ? true : false },
    get offsetParent(): unknown { return visible() ? {} : null; },
    getBoundingClientRect: () => ({ top, height }),
});
/** A scope the marker lives in (the list, or the foot): its own box, its scroll offset, and the active link inside it. */
const host = (top: number, scrollTop: number, active: Json | null): Json => ({ scrollTop, getBoundingClientRect: () => ({ top }), querySelector: (selector: string) => (selector === '.nav-item.active' ? active : null) });

describe('the marker lands on the active item, in both directions, with groups and a closed Administration (SH-01, SH-04)', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`${lang}: translateY from the scope’s own top, plus its scroll offset, and the item’s height: no horizontal component`, () => {
            const { App, h } = rig({ lang });
            const marker = new FakeEl('nav-indicator');
            App.placeIndicator(host(100, 30, link(240, 44)), marker, false);
            assert.equal(marker.style.transform, 'translateY(170px)', '240 - 100 + 30');
            assert.equal(marker.style.blockSize, '44px');
            assert.equal(marker.classes.has('is-visible'), true);
            assert.equal(/translateX|translate\(/.test(marker.style.transform), false, 'direction-agnostic: the inline edges come from logical CSS');
            assert.equal(h.document.documentElement.dir, lang === 'ar' ? 'rtl' : 'ltr');
        });
    }

    it('rounds to whole pixels, and re-measures without sliding (no-transition around the write)', () => {
        const { App } = rig();
        const marker = new FakeEl('nav-indicator');
        const seen: boolean[] = [];
        const add = marker.classList.add;
        marker.classList.add = (...names: string[]): void => { if (names.includes('no-transition')) seen.push(true); add(...names); };
        App.placeIndicator(host(10.4, 0, link(100.6, 43.6)), marker, false);
        assert.equal(marker.style.transform, 'translateY(90px)');
        assert.equal(marker.style.blockSize, '44px');
        assert.deepEqual(seen, [true], 'a re-measure does not travel');
        assert.equal(marker.classes.has('no-transition'), false, 'and transitions are back for the next move');
        seen.length = 0;
        App.placeIndicator(host(10, 0, link(100, 44)), marker, true);
        assert.deepEqual(seen, [], 'a navigation slides');
    });

    it('hides the marker when the active item is in a closed group (it has no box), and brings it back when the group opens', () => {
        const { App } = rig();
        const marker = new FakeEl('nav-indicator');
        let open = false;
        const inAdmin = link(500, 44, () => open);
        const scope = host(0, 0, inAdmin);
        App.placeIndicator(scope, marker, false);
        assert.equal(marker.classes.has('is-visible'), false, 'closed: nothing to point at');
        open = true;
        App.placeIndicator(scope, marker, false);
        assert.equal(marker.classes.has('is-visible'), true);
        assert.equal(marker.style.transform, 'translateY(500px)');
    });

    it('hides it for an item the session does not see, and for a scope with no active item', () => {
        const { App } = rig();
        const marker = new FakeEl('nav-indicator');
        marker.classes.add('is-visible');
        const hidden = link(40);
        hidden.classList.contains = (name: string): boolean => name === 'hidden';
        App.placeIndicator(host(0, 0, hidden), marker, false);
        assert.equal(marker.classes.has('is-visible'), false);
        marker.classes.add('is-visible');
        App.placeIndicator(host(0, 0, null), marker, false);
        assert.equal(marker.classes.has('is-visible'), false);
        assert.doesNotThrow(() => App.placeIndicator(null, marker, false), 'no scope, no marker: nothing to do');
    });

    it('parks a hidden marker at the top of its scope at once, so it never stretches the list with the position it last had', () => {
        const { App } = rig();
        const marker = new FakeEl('nav-indicator');
        App.placeIndicator(host(0, 0, link(756, 46)), marker, false);
        assert.equal(marker.style.transform, 'translateY(756px)');
        // The group closes: the item has no box. A transformed box still counts as scrollable overflow, so the marker goes home.
        App.placeIndicator(host(0, 0, link(756, 46, () => false)), marker, true);
        assert.equal(marker.classes.has('is-visible'), false);
        assert.equal(marker.style.transform, 'translateY(0)');
        assert.equal(marker.classes.has('no-transition'), false, 'transitions are back for the next time');
    });

    it('shows a marker that was hidden where it belongs, without sliding in from where it was', () => {
        const { App } = rig();
        const marker = new FakeEl('nav-indicator');
        const adopted: boolean[] = [];
        const add = marker.classList.add;
        marker.classList.add = (...names: string[]): void => { if (names.includes('no-transition')) adopted.push(true); add(...names); };
        App.placeIndicator(host(0, 0, link(300)), marker, true);
        assert.deepEqual(adopted, [true], 'a navigation asked for a slide, but there is nothing to slide from');
        adopted.length = 0;
        App.placeIndicator(host(0, 0, link(400)), marker, true);
        assert.deepEqual(adopted, [], 'and once it is showing, it slides');
    });

    it('keeps one marker per scope: the list’s for the groups, the foot’s for Settings and Help', () => {
        const r = rig();
        const listMarker = r.h.el('nav-indicator');
        const footMarker = r.h.el('nav-indicator-foot');
        const listHost = Object.assign(r.h.el('sidebar-nav'), host(0, 0, null));
        const footHost = Object.assign(r.h.el('sidebar-foot-nav'), host(600, 0, null));
        const setActive = (scope: Json, item: Json | null): void => { scope.querySelector = (selector: string) => (selector === '.nav-item.active' ? item : null); };
        // Studio is current: it is in the list.
        setActive(listHost, link(180));
        setActive(footHost, null);
        r.App.moveNavIndicator(false);
        assert.equal(listMarker.classes.has('is-visible'), true);
        assert.equal(footMarker.classes.has('is-visible'), false);
        assert.equal(listMarker.style.transform, 'translateY(180px)');
        // Settings is current: it is in the foot, and the list’s marker leaves.
        setActive(listHost, null);
        setActive(footHost, link(640));
        r.App.moveNavIndicator(true);
        assert.equal(listMarker.classes.has('is-visible'), false);
        assert.equal(footMarker.classes.has('is-visible'), true);
        assert.equal(footMarker.style.transform, 'translateY(40px)', '640 - 600');
    });

    it('lets only the VISIBLE marker carry the view-transition name, so two markers never void the page transition', () => {
        const rule = (selector: string): string => (new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(CSS) ?? [])[1] ?? '';
        assert.equal(/view-transition-name/.test(rule('.nav-indicator')), false);
        assert.match(rule('.nav-indicator.is-visible'), /view-transition-name:\s*nav-active/);
        assert.match(rule('.nav-indicator--foot'), /inset-inline:\s*0/);
    });
});

describe('the list is scrolled to show the current item (a window too short for the whole sidebar)', () => {
    /** The scrolling list, and an item at `top`..`bottom` in the viewport; the list is `navTop`..`navBottom`. */
    const scene = (navTop: number, navBottom: number, scrollTop: number, item: Json | null) => {
        const r = rig();
        const nav = Object.assign(r.h.el('sidebar-nav'), { scrollTop, getBoundingClientRect: () => ({ top: navTop, bottom: navBottom }), querySelector: (sel: string) => (sel === '.nav-item.active' ? item : null) });
        return { r, nav };
    };
    const at = (top: number, bottom: number, visible = true): Json => ({ classList: { contains: () => false }, offsetParent: visible ? {} : null, getBoundingClientRect: () => ({ top, bottom }) });

    it('scrolls down by what is hidden below, and up by what is hidden above', () => {
        const below = scene(80, 680, 0, at(650, 700));
        below.r.App.revealActiveNavItem();
        assert.equal(below.nav.scrollTop, 20, 'the item’s bottom was 20px under the list’s');
        const above = scene(80, 680, 200, at(50, 94));
        above.r.App.revealActiveNavItem();
        assert.equal(above.nav.scrollTop, 170, 'the item’s top was 30px over the list’s');
    });

    it('leaves the list alone when the item is already in view, is not drawn, or there is none', () => {
        for (const item of [at(100, 144), at(900, 944, false), null]) {
            const s = scene(80, 680, 40, item);
            s.r.App.revealActiveNavItem();
            assert.equal(s.nav.scrollTop, 40);
        }
    });

    it('runs before the marker is measured, on the first paint and on every navigation', () => {
        const src = read('dashboard/js/app.js');
        assert.ok(src.includes('this.syncAdminGroup(page);\n            this.revealActiveNavItem();\n            this.moveNavIndicator(true);'), 'navigate, in the transition');
        assert.ok(src.includes('this.revealActiveNavItem();\n        this.moveNavIndicator(false);'), 'applyChrome');
    });
});

// ─── The first frame ────────────────────────────────────────────────────────────────────────

/** Run index.html's inline head script against fake globals and report the attributes it set on <html>. */
function headScript(opts: { token?: string | null; gated?: boolean; hash?: string; lang?: string; throwing?: boolean; timers?: Array<{ fn: () => void; ms: number }> }): Record<string, string> {
    const open = INDEX.indexOf('<script>', INDEX.indexOf('<head>'));
    const code = INDEX.slice(open + '<script>'.length, INDEX.indexOf('</script>', open));
    const attrs: Record<string, string> = {};
    const store = new Map<string, string>();
    if (opts.token) store.set('auth_token', opts.token);
    if (opts.gated) store.set('onboarding_gated', '1');
    if (opts.lang) store.set('dashboard_lang', opts.lang);
    const root = { lang: 'ar', dir: 'rtl', setAttribute: (k: string, v: string): void => { attrs[k] = v; }, removeAttribute: (k: string): void => { delete attrs[k]; } };
    const noopEl = () => ({ setAttribute() {}, appendChild() {} });
    const ctx = {
        setTimeout: (fn: () => void, ms: number): number => { opts.timers?.push({ fn, ms }); return 0; },
        document: { documentElement: root, createElement: noopEl, head: { appendChild() {} } },
        location: { hash: opts.hash ?? '' },
        navigator: { languages: ['ar'], language: 'ar' },
        localStorage: opts.throwing
            ? { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } }
            : { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
    };
    vm.runInNewContext(code, ctx);
    return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.replace(/^data-/, ''), v]));
}

/** The same script, with its timers run: the attributes still on <html> afterwards. */
function headScriptLift(opts: { token?: string | null; gated?: boolean }): Record<string, string> {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const open = INDEX.indexOf('<script>', INDEX.indexOf('<head>'));
    const code = INDEX.slice(open + '<script>'.length, INDEX.indexOf('</script>', open));
    const attrs: Record<string, string> = {};
    const store = new Map<string, string>();
    if (opts.token) store.set('auth_token', opts.token);
    if (opts.gated) store.set('onboarding_gated', '1');
    const root = { lang: 'ar', dir: 'rtl', setAttribute: (k: string, v: string): void => { attrs[k] = v; }, removeAttribute: (k: string): void => { delete attrs[k]; } };
    const noopEl = () => ({ setAttribute() {}, appendChild() {} });
    vm.runInNewContext(code, {
        setTimeout: (fn: () => void, ms: number): number => { timers.push({ fn, ms }); return 0; },
        document: { documentElement: root, createElement: noopEl, head: { appendChild() {} } },
        location: { hash: '' },
        navigator: { languages: ['ar'], language: 'ar' },
        localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
    });
    timers.forEach((t) => t.fn());
    return attrs;
}

describe('first frame: a stored session opens on a skeleton, not on the login form (T119, SH-03)', () => {
    it('marks <html data-session> from the first frame when the browser holds a token', () => {
        assert.equal(headScript({ token: 'abc' }).session, '1');
        assert.equal(headScript({ token: null }).session, undefined, 'no token: the login form is the right first frame');
        assert.equal(headScript({ token: 'abc' }).gated, undefined);
    });

    it('also marks data-gated for a tenant the last /auth/me sent to the setup wizard, which has no sidebar to flash', () => {
        const attrs = headScript({ token: 'abc', gated: true });
        assert.equal(attrs.session, '1');
        assert.equal(attrs.gated, '1');
        assert.equal(headScript({ token: null, gated: true }).gated, undefined, 'without a token the flag means nothing');
    });

    it('leaves an invite link alone, in both spellings: the invite page is not a session', () => {
        for (const hash of ['#/invite?t=abc', '#/welcome?invite=abc', '#/invite']) {
            const attrs = headScript({ token: 'abc', hash });
            assert.equal(attrs.session, undefined, hash);
            assert.equal(attrs.invite, '1', `${hash}: the invite gate still works`);
        }
        assert.equal(headScript({ token: 'abc', hash: '#/welcome' }).session, '1', 'a bare #/welcome is the wizard, and a session');
    });

    it('gives the login form back after 15 seconds if nothing has settled the skeleton (scripts blocked or crashed)', () => {
        const timers: Array<{ fn: () => void; ms: number }> = [];
        assert.equal(headScript({ token: 'abc', gated: true, timers }).session, '1');
        assert.deepEqual(timers.map((t) => t.ms), [15000]);
        assert.deepEqual(headScriptLift({ token: 'abc', gated: true }), {}, 'when the timer fires, both attributes are gone');
        const none: Array<{ fn: () => void; ms: number }> = [];
        headScript({ token: null, timers: none });
        assert.equal(none.length, 0, 'no session, no timer');
    });

    it('survives a browser that will not let it read storage', () => {
        assert.doesNotThrow(() => headScript({ token: 'abc', throwing: true }));
        assert.equal(headScript({ token: 'abc', throwing: true }).session, undefined, 'unknown is the old first frame, not a guess');
    });

    it('has a static skeleton in the shell that nothing can focus or read', () => {
        const skeleton = /<div id="shell-skeleton" class="shell-skeleton" aria-hidden="true">([\s\S]*?)\n    <\/div>\n\n    <!-- ─── Login/.exec(INDEX);
        assert.ok(skeleton, 'the skeleton is in index.html, before the login screen');
        assert.equal(/<(?:a|button|input|select|textarea)\b|tabindex|data-i18n/.test(skeleton[1]!), false, 'no control, no text');
        assert.ok(INDEX.indexOf('id="shell-skeleton"') < INDEX.indexOf('id="login-screen"'));
    });

    it('hides the login form and shows the skeleton only while data-session is set, and the skeleton drops the sidebar for a gated tenant', () => {
        assert.match(CSS, /html\[data-session\] #login-screen \{ display: none; \}/);
        assert.match(CSS, /\.shell-skeleton \{ display: none; \}/);
        assert.match(CSS, /html\[data-session\] \.shell-skeleton \{ display: block;/);
        assert.match(CSS, /html\[data-gated\] \.shell-skeleton-side \{ display: none; \}/);
        assert.match(CSS, /html\[data-invite\] #login-screen \{ display: none; \}/, 'the invite gate is where it was');
    });

    it('lifts it when the dashboard, the wizard, the invite or the login takes over, and not before', async () => {
        const api: Json = { token: 't', getMe: async () => ({ userId: null, role: 'platform_admin', tenantId: 't', tenantRole: 'owner', tenants: [{ id: 't' }], onboarding: null }), request: async () => ({ counts: {} }) };
        const r = rig({ globals: { API: api } });
        for (const id of ['login-screen', 'app', 'invite-screen', 'welcome-screen', 'login-error', 'login-password', 'login-email', 'login-email-group', 'login-email-toggle', 'login-keep']) r.h.el(id);
        const root = r.h.document.documentElement as FakeEl;
        const set = (): void => { root.setAttribute('data-session', '1'); root.setAttribute('data-gated', '1'); };
        const lifted = (): boolean => !root.hasAttribute('data-session') && !root.hasAttribute('data-gated');
        set();
        r.App.settleFirstFrame();
        assert.equal(lifted(), true);
        set();
        r.App.showLogin();
        assert.equal(lifted(), true, 'the session is gone or was never there: the form is wanted');
        set();
        r.h.location.hash = '#/overview';
        const shown = r.App.showApp();
        assert.equal(root.hasAttribute('data-session'), true, 'still the skeleton while /auth/me is being answered');
        await shown;
        assert.equal(lifted(), true, 'the dashboard is on screen');
        r.App.stopAdminStatusPoll();
    });

    it('remembers whether the last answer sent the tenant to the wizard, from an answer and never from a failure', async () => {
        const api: Json = { token: 't' };
        const r = rig({ globals: { API: api } });
        const flag = (): string | null => r.h.run<string | null>(`localStorage.getItem('onboarding_gated')`);
        api.getMe = async () => ({ userId: 'u', role: 'user', tenantId: 't', tenantRole: 'owner', tenants: [{ id: 't' }], onboarding: { gated: true, status: 'in_progress' } });
        await r.App.loadSession();
        assert.equal(flag(), '1');
        api.getMe = async () => { throw new Error('offline'); };
        await r.App.loadSession();
        assert.equal(flag(), '1', 'a failed read does not forget it');
        api.getMe = async () => ({ userId: 'u', role: 'user', tenantId: 't', tenantRole: 'owner', tenants: [{ id: 't' }], onboarding: { gated: false, status: 'completed' } });
        await r.App.loadSession();
        assert.equal(flag(), null);
        api.getMe = async () => ({ userId: null, role: 'platform_admin', tenants: [], onboarding: { gated: true, status: 'in_progress' } });
        await r.App.loadSession();
        assert.equal(flag(), null, 'a platform admin is never sent to the wizard');
    });
});

// ─── Results: the Numbers · Log strip ───────────────────────────────────────────────────────

describe('Results: a Numbers · Log strip on both pages, with the Log one click away even when the numbers failed (T115, OV-33)', () => {
    const strip = (markup: string): { hrefs: string[]; current: string[] } => ({
        hrefs: [...markup.matchAll(/<a class="ui-tab" data-ui-tab href="([^"]+)"/g)].map((m) => m[1]!),
        current: [...markup.matchAll(/<a class="ui-tab" data-ui-tab href="([^"]+)" aria-current="page"/g)].map((m) => m[1]!),
    });

    for (const lang of ['ar', 'en'] as const) {
        it(`${lang}: is a link-mode tab strip, Numbers then Log, with the current one marked`, () => {
            const h = loadDashboard({ lang });
            const numbers = String(h.UI.resultsTabs('numbers'));
            const log = String(h.UI.resultsTabs('log'));
            assert.match(numbers, /<nav class="ui-tabs ui-tabs--link" aria-label="[^"]+"/, 'link mode: navigation, with a name');
            assert.deepEqual(strip(numbers).hrefs, ['#/analytics', '#/activity']);
            assert.deepEqual(strip(numbers).current, ['#/analytics']);
            assert.deepEqual(strip(log).current, ['#/activity']);
            const [first, second] = lang === 'ar' ? ['الأرقام', 'السجل'] : ['Numbers', 'Log'];
            assert.ok(numbers.indexOf(first!) > 0 && numbers.indexOf(first!) < numbers.indexOf(second!), `${first} then ${second}`);
            assert.equal(h.t('results.tabs.numbers'), first);
            assert.equal(h.t('results.tabs.log'), second);
        });
    }

    it('is at the top of Analytics, in its skeleton, its content and its error panel', async () => {
        const h = loadDashboard({ files: ['dashboard/js/charts.js', 'dashboard/js/pages/analytics.js'], globals: { Admin: { emptyState: () => '' }, API: new Proxy({}, { get: () => () => Promise.reject(new Error('stats are down')) }) } });
        const A = h.run('AnalyticsPage');
        assert.deepEqual(strip(String(A.skeleton())).current, ['#/analytics'], 'no jump when the page arrives');
        const container = h.el('page-container');
        await A.render();
        assert.match(container.innerHTML, /error-panel/, 'it failed');
        assert.deepEqual(strip(container.innerHTML).hrefs, ['#/analytics', '#/activity'], 'and the Log is still one click away');
        assert.ok(container.innerHTML.indexOf('ui-tabs') < container.innerHTML.indexOf('error-panel'), 'above the panel');
    });

    it('is at the top of the Activity Log, in its skeleton, its content and its error panels', async () => {
        const rows = { data: [], pagination: { total: 0, page: 1, totalPages: 0 } };
        let mode: 'ok' | 'down' | 'bad' = 'ok';
        const API = {
            getInteractions: async () => { if (mode === 'down') throw new Error('log is down'); return mode === 'bad' ? { data: [] } : rows; },
            getCampaigns: async () => [],
        };
        const h = loadDashboard({ files: ['dashboard/js/pages/activity.js'], globals: { Admin: { emptyState: () => '' }, API } });
        const P = h.run('ActivityPage');
        assert.deepEqual(strip(String(P.skeleton())).current, ['#/activity']);
        const container = h.el('page-container');
        for (const next of ['ok', 'down', 'bad'] as const) {
            mode = next;
            await P.loadData(container);
            assert.deepEqual(strip(container.innerHTML).current, ['#/activity'], next);
            assert.deepEqual(strip(container.innerHTML).hrefs, ['#/analytics', '#/activity'], next);
        }
    });

    it('lets an error panel keep markup above it, and shows a plain string as text, never as markup', () => {
        const h = loadDashboard();
        const container = h.el('c');
        h.UI.renderError(container, { title: 'T', message: 'M', before: h.UI.resultsTabs('log') });
        assert.ok(container.innerHTML.indexOf('ui-tabs--link') < container.innerHTML.indexOf('error-panel'));
        h.UI.renderError(container, { title: 'T', message: 'M', before: '<img src=x onerror=alert(1)>' });
        assert.equal(container.innerHTML.includes('<img'), false);
        h.UI.renderError(container, { title: 'T', message: 'M' });
        assert.equal(container.innerHTML.includes('ui-tabs'), false, 'no `before`, no strip: every other error panel is unchanged');
    });
});

void (undefined as unknown as Dashboard);
