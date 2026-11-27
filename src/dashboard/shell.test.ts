/**
 * The shell registry (U3 PR B, `dashboard/js/shell.js`): ONE table decides the sidebar, the Studio and Ads tab strips, Help's list and the
 * phone bar's slots from a workspace's modules and a person's role.
 *
 * Three promises, each held here:
 *   1. THE OWNER SEES NO CHANGE (I3). With every module on, or with no `modules` in /auth/me at all (fail open), the 19 links, both tab
 *      strips and Help are what they were before the registry.
 *   2. OFF MEANS HIDDEN. A workspace without a module has no menu item, no tab, no article, and a typed address lands on Today with a toast.
 *   3. IT STAYS TRUE. The registry agrees with `App.pages`, with index.html's groups and with Help's articles.
 *
 * The real shipped files through `_harness.ts`; no network.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { FakeEl, loadDashboard, settle, type Json } from './_harness.js';

const INDEX = readFileSync('dashboard/index.html', 'utf8');
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));

// ─── The sidebar, as index.html writes it ────────────────────────────────────────────────────────

interface FakeGroup { id: string; classes: Set<string>; items: Json[]; pages: string[] }

/** index.html's menu as a fake document: every `.nav-item[data-page]` with its `<li>`, and every `.nav-group` of the scrolling list. */
function sidebar(): { doc: Json; li: Record<string, FakeEl>; groups: FakeGroup[]; visible: () => string[]; shownGroups: () => string[] } {
    const from = INDEX.indexOf('<div class="sidebar-nav" id="sidebar-nav">');
    const to = INDEX.indexOf('<div class="sidebar-footer">');
    const block = INDEX.slice(from, to);
    const foot = INDEX.slice(INDEX.indexOf('<div class="sidebar-foot-nav"'), INDEX.indexOf('<div class="nav-account">'));
    const li: Record<string, FakeEl> = {};
    const items: Json[] = [];
    const makeItems = (markup: string): Json[] => [...markup.matchAll(/<li( class="hidden")?[^>]*><a href="#\/([a-z_]+)" class="nav-item[^"]*" data-page="([a-z_]+)"/g)].map((m) => {
        const box = new FakeEl('', 'li');
        if (m[1]) box.classes.add('hidden');
        li[m[3]!] = box;
        const link = {
            dataset: { page: m[3]! },
            getAttribute: (name: string): string | null => (name === 'data-page' ? m[3]! : null),
            parentElement: Object.assign(box, { tagName: 'LI' }),
        };
        items.push(link);
        return link;
    });
    const groups: FakeGroup[] = block.split('<div class="nav-group').slice(1).map((chunk) => {
        const head = /^[^>]*>/.exec(chunk)![0];
        const id = /\bid="([^"]+)"/.exec(head)?.[1] ?? '';
        const own = makeItems(chunk);
        return { id, classes: new Set<string>(), items: own, pages: own.map((i) => i.dataset.page as string) };
    });
    makeItems(foot);
    const doc = {
        querySelectorAll: (selector: string): Json[] => {
            if (selector === '.nav-item[data-page]') return items;
            if (selector === '.sidebar-nav .nav-group') {
                return groups.map((g) => ({
                    id: g.id,
                    classList: { toggle: (name: string, force: boolean) => { if (force) g.classes.add(name); else g.classes.delete(name); } },
                    querySelectorAll: () => g.items,
                }));
            }
            return [];
        },
    };
    return {
        doc, li, groups,
        visible: () => Object.keys(li).filter((page) => !li[page]!.classes.has('hidden')),
        // The job groups left on screen: not hidden by `applyNav`, and not the admin group (its own switch).
        shownGroups: () => groups.filter((g) => g.id !== 'nav-admin').map((g, i) => (g.classes.has('hidden') ? '' : ['today', 'replies', 'content', 'results'][i]!)).filter(Boolean),
    };
}

const COMPANY = ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results'];
const ALL = ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results', 'growth', 'studio', 'explainers', 'ads', 'tiktok', 'youtube', 'whatsapp', 'muse'];
const JOB_ITEMS = ['overview', 'inbox', 'campaigns', 'ai_settings', 'studio', 'brand', 'posts', 'analytics', 'growth', 'ads'];
const ADMIN_ITEMS = ['operations', 'tenants', 'admin_ads', 'users', 'jobs', 'audit', 'erasure'];

function shellOf(lang: 'ar' | 'en' = 'en') {
    const h = loadDashboard({ app: true, lang });
    return { h, Shell: h.run<Json>('Shell'), ctx: (modules: string[] | null, role: string, admin = false): Json => h.run<Json>('Shell').context({ modules }, { role, admin }) };
}

// ─── 1. The owner sees no change ──────────────────────────────────────────────────────────────────

describe('shell: with every module on, the menu is what it was (I3)', () => {
    const { Shell, ctx } = shellOf();
    const cases: Array<[string, string, boolean, string[]]> = [
        ['the platform admin', 'owner', true, [...JOB_ITEMS, 'settings', 'help', ...ADMIN_ITEMS]],
        ['a workspace owner', 'owner', false, [...JOB_ITEMS, 'settings', 'help']],
        ['an operator (no Ads)', 'operator', false, JOB_ITEMS.filter((p) => p !== 'ads').concat(['settings', 'help'])],
        ['a viewer (no Ads, no Brand)', 'viewer', false, JOB_ITEMS.filter((p) => p !== 'ads' && p !== 'brand').concat(['settings', 'help'])],
    ];
    for (const [who, role, admin, expected] of cases) {
        for (const modules of [ALL, null]) {
            it(`${who} sees ${expected.length} items${modules === null ? ' when /auth/me names no modules (fail open)' : ''}`, () => {
                const s = sidebar();
                Shell.applyNav(s.doc, ctx(modules, role, admin));
                assert.deepEqual(s.visible().sort(), [...expected].sort());
                assert.equal(s.shownGroups().length, 4, 'the four job groups stay');
            });
        }
    }

    it('counts as the contract says: 12 + 7 admin, 12, 11, 10', () => {
        const count = (role: string, admin: boolean): number => { const s = sidebar(); Shell.applyNav(s.doc, ctx(ALL, role, admin)); return s.visible().length; };
        assert.deepEqual([count('owner', true), count('owner', false), count('operator', false), count('viewer', false)], [19, 12, 11, 10]);
    });

    it('is still 19 links in index.html, each a page of the registry, in the group the registry names', () => {
        const s = sidebar();
        assert.equal(Object.keys(s.li).length, 19);
        for (const g of s.groups) {
            for (const page of g.pages) {
                const named = Shell.PAGES[page].group;
                const expected = g.id === 'nav-admin' ? 'admin' : (['today', 'replies', 'content', 'results'] as const)[s.groups.filter((x) => x.id !== 'nav-admin').indexOf(g)];
                assert.equal(named, expected, `${page} is in ${expected}`);
            }
        }
    });

    it('draws no tab the owner did not have: the Studio strip equals the old one, the Ads strip too, in both languages', () => {
        for (const lang of ['en', 'ar'] as const) {
            const h = loadDashboard({ lang, app: true, files: ['dashboard/js/pages/ads_campaigns.js'] });
            const S = h.run<Json>('Shell');
            const norm = (markup: unknown): string => String(markup).replace(/\s+/g, ' ').replace(/ >/g, '>').replace(/> </g, '><').replace(/ <\//g, '</').trim();
            const tab = (href: string, icon: string, label: string, current: boolean): string => `<a class="btn btn-sm btn-ghost" href="${href}"${current ? ' aria-current="page"' : ''}><i data-lucide="${icon}" aria-hidden="true"></i> ${label}</a>`;
            // What StudioPage.tabsMarkup and the three other copies wrote, before the registry.
            const oldStudio = (active: string): string => `<nav class="segmented studio-seg studio-tabs" aria-label="${h.t('studio.tabs.label')}">${[
                ['home', '#/studio', 'layers', 'studio.tabs.carousels'], ['monteur', '#/monteur', 'scissors', 'studio.tabs.monteur'],
                ['infographics', '#/infographics', 'images', 'studio.tabs.infographics'], ['explainers', '#/explainers', 'lightbulb', 'studio.tabs.explainers'],
                ['settings', '#/studio?tab=settings', 'settings', 'studio.tabs.settings'],
            ].map(([key, href, icon, label]) => tab(href!, icon!, h.t(label!), key === active)).join('')}</nav>`;
            for (const key of ['home', 'monteur', 'infographics', 'explainers', 'settings']) {
                assert.equal(norm(S.areaNav('studio', key, S.context({ modules: ALL }, { role: 'owner', admin: false }))), oldStudio(key), `studio ${key} (${lang})`);
                assert.equal(norm(S.areaNav('studio', key, S.context({ modules: null }, { role: 'owner', admin: false }))), oldStudio(key), `studio ${key} with no modules`);
                assert.equal(norm(S.areaNav('studio', key)), oldStudio(key), `studio ${key} with no context at all`);
            }
            // What AdsTabs.markup wrote.
            const rows = [
                ['overview', '#/ads', 'layout-dashboard'], ['campaigns', '#/ads_campaigns', 'megaphone'], ['results', '#/ads_results', 'bar-chart-3'],
                ['proposals', '#/ads_proposals', 'sparkles'], ['audiences', '#/ads_audiences', 'users'], ['rules', '#/ads_rules', 'list-checks'],
                ['leads', '#/ads_leads', 'clipboard-list'], ['tests', '#/ads_tests', 'split'], ['create', '#/ads_create', 'plus'],
            ];
            const oldAds = (active: string): string => `<div class="page-toolbar ads-tabs" id="ads-tabs"><nav class="segmented studio-seg ads-tabs-seg" aria-label="${h.t('ads.tabs.label')}">${
                rows.map(([key, href, icon]) => tab(href!, icon!, h.t(`ads.tabs.${key}`), key === active)).join('')}</nav></div>`;
            const AdsTabs = h.run<Json>('AdsTabs');
            for (const [key] of rows) assert.equal(norm(AdsTabs.markup(key)), oldAds(key!), `ads ${key} (${lang})`);
            assert.equal(AdsTabs.TABS.length, 9);
        }
    });

    it('is the same for the page that draws it: all four Studio toolbars are the one registry', () => {
        const strips = ['studio', 'monteur', 'infographics', 'explainers'].map((page) => {
            const h = loadDashboard({ app: true, files: [`dashboard/js/pages/${page}.js`] });
            const Page = h.run<Json>({ studio: 'StudioPage', monteur: 'MonteurPage', infographics: 'InfographicsPage', explainers: 'ExplainersPage' }[page]!);
            return String(page === 'studio' ? Page.tabsMarkup('home') : Page.toolbarMarkup('videos'));
        });
        assert.ok(strips.every((s) => s.includes('class="segmented studio-seg studio-tabs"')), 'each one is the segmented strip UI.watchTabStrips keys on');
        assert.ok(strips.every((s) => (s.match(/class="btn btn-sm btn-ghost"/g) ?? []).length === 5), 'five tabs each');
    });

    it('keeps the phone bar at overview, inbox, posts, studio, more', () => {
        assert.deepEqual(plain(Shell.phoneSlots(ctx(ALL, 'owner'))), ['overview', 'inbox', 'posts', 'studio', 'more']);
        assert.deepEqual(plain(Shell.phoneSlots(ctx(null, 'owner'))), ['overview', 'inbox', 'posts', 'studio', 'more']);
    });

    it('lists 28 Help articles and today’s popular ones, for the platform admin on an all-on workspace', () => {
        const h = loadDashboard({ app: true, files: ['dashboard/js/help-content.js', 'dashboard/js/pages/help.js'] });
        h.App.session = { available: true, role: 'platform_admin', userId: 'u', tenantId: 't', tenantRole: 'owner', tenants: [{ id: 't' }], onboarding: null, modules: ALL };
        const Help = h.run<Json>('HelpPage');
        assert.equal(Help.articles().length, 28);
        assert.equal(Help.allArticles().length, 28);
        const popular = [...String(Help.welcomeMarkup()).matchAll(/class="help-card" href="#\/help\/([a-z-]+)"/g)].map((m) => m[1]);
        assert.deepEqual(popular, plain(h.run<Json>('HelpContent').popular));
    });
});

// ─── 2. Off means hidden ─────────────────────────────────────────────────────────────────────────

describe('shell: a workspace without a module has no way to it', () => {
    const { Shell, ctx } = shellOf();

    for (const role of ['owner', 'operator', 'viewer']) {
        it(`a company workspace shows 8 items to ${role}, and the job groups it needs: Today, Replies, Content (Scheduler), Results (Results)`, () => {
            const s = sidebar();
            Shell.applyNav(s.doc, ctx(COMPANY, role));
            assert.deepEqual(s.visible().sort(), ['ai_settings', 'analytics', 'campaigns', 'help', 'inbox', 'overview', 'posts', 'settings'].sort());
            for (const gone of ['studio', 'brand', 'growth', 'ads']) assert.equal(s.li[gone]!.classes.has('hidden'), true, `${gone} is hidden`);
            assert.deepEqual(s.shownGroups(), ['today', 'replies', 'content', 'results']);
            const left = (group: string): string[] => s.groups.filter((g) => g.id !== 'nav-admin')[['today', 'replies', 'content', 'results'].indexOf(group)]!.pages.filter((p) => !s.li[p]!.classes.has('hidden'));
            assert.deepEqual([left('content'), left('results')], [['posts'], ['analytics']]);
        });
    }

    it('hides a whole group when every item in it is off, and shows it again when one comes back', () => {
        const s = sidebar();
        Shell.applyNav(s.doc, ctx(['inbox', 'keyword_replies', 'dm_assistant', 'results'], 'owner'));
        assert.deepEqual(s.shownGroups(), ['today', 'replies', 'results'], 'no Content group without Studio or the Scheduler');
        Shell.applyNav(s.doc, ctx(['inbox', 'keyword_replies', 'dm_assistant', 'results', 'scheduler'], 'owner'));
        assert.equal(s.shownGroups().length, 4);
    });

    it('treats an off module as hidden and its requirement-less neighbours as theirs: only the registry decides', () => {
        assert.equal(Shell.canSee('growth', ctx(COMPANY, 'owner')), false);
        assert.equal(Shell.canSee('growth', ctx([...COMPANY, 'growth'], 'owner')), true);
        assert.equal(Shell.canSee('monteur', ctx(['studio'], 'owner')), true);
        assert.equal(Shell.canSee('explainers', ctx(['studio'], 'owner')), false, 'Explainers is its own module');
        assert.equal(Shell.canSee('ads_results', ctx(COMPANY, 'owner')), false, 'every Ads page follows ads');
        assert.equal(Shell.canSee('overview', ctx([], 'viewer')), true, 'Today, Settings and Help belong to no module');
        assert.equal(Shell.canSee('settings', ctx([], 'viewer')), true);
        assert.equal(Shell.canSee('help', ctx([], 'viewer')), true);
        assert.equal(Shell.canSee('no_such_page', ctx(ALL, 'owner')), false);
    });

    it('keeps the platform pages the admin’s, whatever the modules say', () => {
        for (const page of [...ADMIN_ITEMS, 'tenant_detail']) {
            assert.equal(Shell.canSee(page, ctx(ALL, 'owner', false)), false, `${page} for a workspace owner`);
            assert.equal(Shell.canSee(page, ctx(COMPANY, 'owner', true)), true, `${page} for the admin on a company workspace`);
        }
    });

    it('keeps the roles it always had: Ads is the owner’s, Brand an operator’s', () => {
        assert.deepEqual(['owner', 'operator', 'viewer'].map((r) => Shell.canSee('ads', ctx(ALL, r))), [true, false, false]);
        assert.deepEqual(['owner', 'operator', 'viewer'].map((r) => Shell.canSee('brand', ctx(ALL, r))), [true, true, false]);
    });

    it('draws only the tabs of the modules it has', () => {
        const keys = (area: string, modules: string[]): string[] => plain(Shell.areaTabs(area, ctx(modules, 'owner')).map((t: Json) => t.key));
        assert.deepEqual(keys('studio', ALL), ['home', 'monteur', 'infographics', 'explainers', 'settings']);
        assert.deepEqual(keys('studio', ['studio']), ['home', 'monteur', 'infographics', 'settings']);
        assert.deepEqual(keys('studio', COMPANY), []);
        assert.equal(keys('ads', ALL).length, 9);
        assert.deepEqual(keys('ads', COMPANY), []);
        assert.equal(String(Shell.areaNav('studio', 'home', ctx(['studio'], 'owner'))).includes('href="#/explainers"'), false);
    });

    it('answers the phone bar and search from what is visible', () => {
        assert.deepEqual(plain(Shell.phoneSlots(ctx(COMPANY, 'owner'))), ['overview', 'inbox', 'posts', 'analytics', 'more']);
        assert.deepEqual(plain(Shell.phoneSlots(ctx(['inbox'], 'owner'))), ['overview', 'inbox', 'more']);
        const entries = plain(Shell.searchEntries(ctx(COMPANY, 'owner')));
        assert.ok(entries.every((e: Json) => ['page', 'tab'].includes(e.kind) && e.href && e.labelKey));
        assert.equal(entries.some((e: Json) => e.page === 'studio' || e.page === 'ads'), false);
        assert.equal(entries.some((e: Json) => e.page === 'posts'), true);
        const studio = plain(Shell.searchEntries(ctx(ALL, 'owner')));
        assert.ok(studio.some((e: Json) => e.kind === 'tab' && e.href === '#/studio?tab=settings'), 'a tab with an address of its own is an entry');
        assert.ok(studio.some((e: Json) => e.kind === 'page' && e.href === '#/monteur'), 'a tab that is a page is that page’s entry');
        assert.equal(new Set(studio.map((e: Json) => e.href)).size, studio.length, 'no address twice');
    });
});

describe('shell: Help follows the modules', () => {
    function help(modules: string[] | null, admin: boolean, hash = '') {
        const h = loadDashboard({ app: true, hash, files: ['dashboard/js/help-content.js', 'dashboard/js/pages/help.js'] });
        h.App.session = { available: true, role: admin ? 'platform_admin' : 'user', userId: 'u', tenantId: 't', tenantRole: 'owner', tenants: [{ id: 't' }], onboarding: null, modules };
        const Help = h.run<Json>('HelpPage');
        Help.route = Help.parseRoute(hash);
        return { h, Help };
    }
    const OFF_FOR_COMPANY = ['growth', 'seo', 'tiktok', 'youtube', 'whatsapp', 'ads', 'studio', 'worker', 'library', 'create', 'studio-schedule', 'studio-settings', 'monteur', 'infographics', 'brand', 'explainers'];

    it('hides the 16 articles of the modules a company workspace has not got, and the platform’s for a non-admin', () => {
        const { Help } = help(COMPANY, false);
        const shown = Help.articles().map((a: Json) => a.slug);
        const all = Help.allArticles().map((a: Json) => a.slug);
        assert.deepEqual(plain(all.filter((s: string) => !shown.includes(s)).sort()), [...OFF_FOR_COMPANY, 'media-storage'].sort());
        assert.equal(shown.length, 28 - 17);
    });

    it('shows the platform’s articles to the admin even on a company workspace', () => {
        const { Help } = help(COMPANY, true);
        assert.ok(Help.articles().some((a: Json) => a.slug === 'media-storage'));
        assert.equal(Help.articles().length, 28 - 16);
    });

    it('tops the front page up to four from the fallback when a company has fewer than four popular ones', () => {
        const { Help } = help(COMPANY, false);
        const cards = [...String(Help.welcomeMarkup()).matchAll(/class="help-card" href="#\/help\/([a-z-]+)"/g)].map((m) => m[1]);
        // popular is getting-started, worker, tiktok, campaigns, troubleshooting, faq: worker and tiktok are off, four remain.
        assert.deepEqual(cards, ['getting-started', 'campaigns', 'troubleshooting', 'faq']);
        const { Help: lean } = help(['inbox'], false);
        const topped = [...String(lean.welcomeMarkup()).matchAll(/class="help-card" href="#\/help\/([a-z-]+)"/g)].map((m) => m[1]);
        assert.equal(topped.length, 4);
        assert.ok(topped.includes('inbox') || topped.includes('connect-meta'), 'the fallback tops it up');
        assert.ok(!topped.includes('worker') && !topped.includes('tiktok'));
    });

    it('sends #/help/<an article about a module that is off> to the front page with a note, not "not found"', () => {
        const { h, Help } = help(COMPANY, false, '#/help/worker');
        assert.equal(Help.view(), 'index');
        const list = String(Help.listMarkup());
        assert.ok(list.includes(h.t('shell.helpNotInWorkspace')));
        assert.equal(list.includes(h.t('help.notFound')), false);
        const unknown = help(COMPANY, false, '#/help/no-such-article');
        assert.ok(String(unknown.Help.listMarkup()).includes(unknown.h.t('help.notFound')), 'a real typo is still "not found"');
    });

    it('draws a [[link]] to a hidden article as its words, not a link', () => {
        const { Help } = help(COMPANY, false);
        const hidden = String(Help.linkHtml('worker', '', ''));
        assert.equal(hidden.includes('<a '), false);
        assert.ok(hidden.length > 0);
        assert.match(String(Help.linkHtml('inbox', '', '')), /<a class="help-inline-link" href="#\/help\/inbox">/);
    });

    it('has every mapped article, and every note, in both languages', () => {
        const h = loadDashboard({ files: ['dashboard/js/help-content.js'] });
        const slugs: string[] = plain(h.run<Json>('HelpContent').articles.map((a: Json) => a.slug));
        const S = h.run<Json>('Shell');
        for (const slug of Object.keys(S.HELP_MODULES)) assert.ok(slugs.includes(slug), `${slug} is a real article`);
        assert.ok(slugs.includes('media-storage'));
        for (const slug of S.POPULAR_FALLBACK) assert.ok(slugs.includes(slug), `${slug} is a real article`);
        for (const lang of ['en', 'ar'] as const) {
            const d = loadDashboard({ lang });
            for (const key of ['shell.moduleOff', 'shell.moduleOffNow', 'shell.helpNotInWorkspace', 'shell.studioAlarmOpen']) assert.notEqual(d.t(key), key, `${key} in ${lang}`);
        }
        assert.notEqual(loadDashboard({ lang: 'ar' }).t('shell.moduleOff'), loadDashboard({ lang: 'en' }).t('shell.moduleOff'));
    });
});

// ─── The session and the address ─────────────────────────────────────────────────────────────────

/** The shell's app.js, with every page a fake that only records, and `.nav-item[data-page]` answering for fake links. */
function rig(session: Json | null, globals: Record<string, unknown> = {}) {
    const log: string[] = [];
    const toasts: string[] = [];
    const h = loadDashboard({ app: true, globals: { Admin: { confirm: () => {} }, ...globals } });
    for (const id of ['page-title', 'page-subtitle', 'page-container', 'sidebar', 'main-content', 'mobile-menu-btn']) h.el(id);
    h.document.querySelectorAll = (): FakeEl[] => [];
    for (const name of Object.keys(h.App.pages)) {
        const entry = h.App.pages[name];
        if (entry.routable === false) continue;
        h.App.pages[name] = { ...entry, page: () => ({ render: () => { log.push(`render ${name}`); }, destroy: () => { log.push(`destroy ${name}`); } }) };
    }
    h.UI.toast = (message: string): void => { toasts.push(String(message)); };
    if (session) h.App.session = session;
    return { h, App: h.App as Json, log, toasts };
}
const session = (modules: string[] | null, over: Json = {}): Json => ({ available: true, role: 'user', userId: 'u1', email: 'a@b.test', tenantId: 't1', tenantRole: 'owner', tenants: [{ id: 't1' }], onboarding: null, modules, ...over });

describe('shell: the session carries the modules, and fails open', () => {
    it('keeps the modules an array names, and the workspace', async () => {
        const r = rig(null, { API: { getMe: async () => ({ userId: 'u', role: 'user', tenantId: 't', tenantRole: 'owner', tenants: [{ id: 't' }], modules: COMPANY, workspace: { owner: false, metaConnect: 'self' } }) } });
        assert.equal(await r.App.loadSession(), true);
        assert.deepEqual(plain(r.App.session.modules), COMPANY);
        assert.deepEqual(plain(r.App.session.workspace), { owner: false, metaConnect: 'self' });
        assert.equal(r.App.hasModule('inbox'), true);
        assert.equal(r.App.hasModule('studio'), false);
        assert.deepEqual(plain(r.App.shellContext()), { modules: COMPANY, role: 'owner', admin: false });
    });

    it('reads a /auth/me with no modules as everything on (an older server)', async () => {
        const r = rig(null, { API: { getMe: async () => ({ userId: 'u', role: 'user', tenantId: 't', tenantRole: 'viewer', tenants: [{ id: 't' }] }) } });
        await r.App.loadSession();
        assert.equal(r.App.session.modules, null);
        assert.equal(r.App.session.workspace, null);
        for (const id of ['studio', 'ads', 'tiktok', 'growth']) assert.equal(r.App.hasModule(id), true, id);
        assert.equal(r.App.shellContext().role, 'viewer');
    });

    it('treats a modules value that is not an array as none, and a failed read as none too', async () => {
        const r = rig(null, { API: { getMe: async () => ({ userId: 'u', tenants: [], modules: 'inbox', workspace: 'x' }) } });
        await r.App.loadSession();
        assert.equal(r.App.session.modules, null);
        assert.equal(r.App.session.workspace, null);
        const failing = rig(null, { API: { getMe: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } } });
        assert.equal(await failing.App.loadSession(), true);
        assert.equal(failing.App.session.modules, null);
        assert.equal(failing.App.session.workspace, null);
        assert.equal(failing.App.hasModule('studio'), true);
    });

    it('hasModule is true before any session exists', () => {
        const r = rig(null);
        r.App.session = null;
        assert.equal(r.App.hasModule('studio'), true);
    });
});

describe('shell: a typed address for a page the workspace has not got lands on Today', () => {
    for (const page of ['studio', 'monteur', 'brand', 'growth', 'ads_results', 'explainers', 'infographics', 'ads']) {
        it(`#/${page} on a company workspace: the toast, Today, and the address rewritten`, async () => {
            const r = rig(session(COMPANY));
            r.h.location.hash = `#/${page}`;
            await r.App.navigate(page);
            assert.deepEqual(r.toasts, [r.h.t('shell.moduleOff')]);
            assert.equal(r.App.currentPage, 'overview');
            assert.ok(r.h.replaced.includes('#/overview'), 'replaceState to Today');
            assert.ok(r.log.includes('render overview') && !r.log.includes(`render ${page}`));
        });
    }

    it('lets a page of a module it has through, with no toast', async () => {
        const r = rig(session(COMPANY));
        r.h.location.hash = '#/posts';
        await r.App.navigate('posts');
        assert.deepEqual(r.toasts, []);
        assert.equal(r.App.currentPage, 'posts');
    });

    it('lets every page through when the session names no modules (fail open)', async () => {
        for (const page of ['studio', 'growth', 'brand', 'ads_results']) {
            const r = rig(session(null));
            r.h.location.hash = `#/${page}`;
            await r.App.navigate(page);
            assert.deepEqual(r.toasts, [], page);
            assert.equal(r.App.currentPage, page);
        }
    });

    it('sends a viewer away from Ads and Brand as the menu already hides them', async () => {
        for (const page of ['ads', 'brand']) {
            const r = rig(session(ALL, { tenantRole: 'viewer' }));
            await r.App.navigate(page);
            assert.equal(r.App.currentPage, 'overview', page);
        }
    });

    it('still sends a non-admin away from a platform page, quietly, as before', async () => {
        const r = rig(session(ALL));
        await r.App.navigate('tenants');
        assert.equal(r.App.currentPage, 'overview');
        assert.deepEqual(r.toasts, []);
    });
});

describe('shell: a module that goes off while a page is open', () => {
    function live(modulesAfter: string[]) {
        const sent: string[] = [];
        const fetchStub = async (url: string): Promise<Json> => {
            sent.push(url);
            return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'This is not part of this workspace.', code: 'MODULE_OFF', params: { module: 'growth' } }) };
        };
        const r = (() => {
            const base = loadDashboard({ app: true, files: ['dashboard/js/api.js'], globals: { fetch: fetchStub, Admin: { confirm: () => {} } } });
            return base;
        })();
        for (const id of ['page-title', 'page-subtitle', 'page-container']) r.el(id);
        const toasts: string[] = [];
        const went: string[] = [];
        r.UI.toast = (message: string): void => { toasts.push(String(message)); };
        r.App.session = session(ALL);
        r.App.currentPage = 'growth';
        let refreshed = 0;
        r.App.refreshSession = async (): Promise<boolean> => { refreshed++; r.App.session = session(modulesAfter); return true; };
        r.App.go = (page: string): void => { went.push(page); };
        const API = r.run<Json>('API');
        API.token = 'tok';
        return { r, API, toasts, went, sent, refreshed: () => refreshed };
    }

    it('re-reads the session once, says so, and goes Today when the page on screen is gone', async () => {
        const x = live(COMPANY);
        await assert.rejects(x.API.request('/growth/overview'), (err: Json) => err.status === 404 && err.code === 'MODULE_OFF' && err.params.module === 'growth');
        await settle();
        assert.equal(x.refreshed(), 1);
        assert.deepEqual(x.toasts, [x.r.t('shell.moduleOffNow')]);
        assert.deepEqual(x.went, ['overview']);
    });

    it('asks at most once every 10 seconds, however many calls fail', async () => {
        const x = live(COMPANY);
        for (let i = 0; i < 4; i++) await assert.rejects(x.API.request('/growth/overview'));
        await settle();
        assert.equal(x.refreshed(), 1);
        assert.equal(x.went.length, 1);
    });

    it('says nothing when the page on screen is still the workspace’s', async () => {
        const x = live([...COMPANY, 'growth']);
        await assert.rejects(x.API.request('/growth/overview'));
        await settle();
        assert.equal(x.refreshed(), 1);
        assert.deepEqual(x.toasts, []);
        assert.deepEqual(x.went, []);
    });

    it('reads the older switches’ own codes (ADS_DISABLED, EXPLAINERS_DISABLED) the same way', () => {
        const api = readFileSync('dashboard/js/api.js', 'utf8');
        assert.match(api, /read\.code === 'ADS_DISABLED' \? 'ads'/);
        assert.match(api, /read\.code === 'EXPLAINERS_DISABLED' \? 'explainers'/);
    });

    it('does not touch a 404 with any other code, and a 403 never', async () => {
        const x = live(COMPANY);
        x.r.ctx.fetch = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }) });
        await assert.rejects(x.API.request('/posts/scheduled/x'));
        await settle();
        assert.equal(x.refreshed(), 0);
    });
});

// ─── 3. The registry stays true ──────────────────────────────────────────────────────────────────

describe('shell: the registry agrees with the rest of the dashboard', () => {
    const { h, Shell } = shellOf();
    const pages = h.App.pages as Json;
    const routable = Object.keys(pages).filter((name) => pages[name].routable !== false && !pages[name].aliasOf);

    it('has a row for every routable page of App.pages, and for nothing else', () => {
        assert.deepEqual(Object.keys(Shell.PAGES).sort(), [...routable].sort());
        assert.equal(routable.length, 32);
    });

    it('marks a page platform-only exactly when App.pages says adminOnly', () => {
        for (const name of routable) assert.equal(Shell.PAGES[name].scope === 'platform', pages[name].adminOnly === true, name);
    });

    it('gives a page no group of its own exactly when App.pages points it at another item (navAs), tenant_detail aside', () => {
        for (const name of routable) {
            if (name === 'tenant_detail') continue;
            assert.equal(Shell.PAGES[name].group === null, pages[name].navAs !== undefined, name);
        }
        assert.equal(Shell.PAGES.tenant_detail.group, null);
    });

    it('names the group index.html puts the item in, and a known module and role', () => {
        const s = sidebar();
        const jobGroups = ['today', 'replies', 'content', 'results'];
        const names = s.groups.filter((g) => g.id !== 'nav-admin');
        names.forEach((g, i) => g.pages.forEach((page) => assert.equal(Shell.PAGES[page].group, jobGroups[i], page)));
        for (const page of ['settings', 'help']) assert.equal(Shell.PAGES[page].group, 'foot');
        for (const [name, row] of Object.entries<Json>(Shell.PAGES)) {
            assert.ok(row.module === null || Shell.MODULES.includes(row.module), `${name}: a real module`);
            assert.ok(row.minRole in Shell.ROLE_RANK, `${name}: a real role`);
        }
    });

    it('lists every Studio and Ads tab with a page of the registry, and the address of that page', () => {
        for (const area of Object.values<Json>(Shell.AREAS)) {
            for (const tab of area.tabs) {
                assert.ok(Shell.PAGES[tab.page], `${tab.key}: ${tab.page} is a page`);
                assert.ok(tab.href.startsWith(`#/${tab.page}`), `${tab.key}: ${tab.href}`);
            }
        }
        assert.equal(Shell.AREAS.studio.tabs.length, 5);
        assert.equal(Shell.AREAS.ads.tabs.length, 9);
    });

    it('holds the phone bar in order: overview, inbox, posts, studio, then results', () => {
        const order = Object.entries<Json>(Shell.PAGES).filter(([, r]) => r.phone !== undefined).sort((a, b) => a[1].phone - b[1].phone).map(([n]) => n);
        assert.deepEqual(order, ['overview', 'inbox', 'posts', 'studio', 'analytics']);
    });

    it('is the same module list the server keeps (src/services/modules.ts), once that file exists', () => {
        if (!existsSync('src/services/modules.ts')) return; // PR A is not on this branch yet; its merge makes this assert.
        const source = readFileSync('src/services/modules.ts', 'utf8');
        const found = /MODULE_IDS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source);
        assert.ok(found, 'MODULE_IDS is declared');
        const server = [...found![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        assert.deepEqual(plain(Shell.MODULES), server);
    });

    it('reads no data-owner-only or data-operator-only from the menu any more: roles are the registry’s', () => {
        assert.equal(INDEX.includes('data-owner-only'), false);
        assert.equal(INDEX.includes('data-operator-only'), false);
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.equal(app.includes("'[data-owner-only]'"), false);
        assert.equal(app.includes("'[data-operator-only]'"), false);
        assert.match(app, /Shell\.applyNav\(document, this\.shellContext\(\)\)/);
    });

    it('loads shell.js right before app.js, after admin_common.js and with the same version', () => {
        const tags = [...INDEX.matchAll(/<script defer src="\/dashboard\/js\/([a-z_/.]+)\?v=([\d.]+)"/g)].map((m) => m[1]);
        assert.equal(tags.indexOf('shell.js'), tags.indexOf('app.js') - 1);
        assert.equal(tags.indexOf('pages/admin_common.js'), tags.indexOf('shell.js') - 1);
        assert.equal(tags.indexOf('attention.js'), tags.indexOf('components.js') + 1, 'attention.js stays right after components.js');
    });
});
