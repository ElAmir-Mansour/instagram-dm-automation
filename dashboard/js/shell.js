/**
 * The shell registry (U3, WA-1): ONE table that says which pages, area tabs and Help articles a session can see.
 *
 * Before it, the same facts were written in five places: the sidebar's `data-owner-only` / `data-operator-only` attributes, four copies of
 * the Studio's tab strip (studio.js, monteur.js, infographics.js, explainers.js), `AdsTabs.TABS`, Help's article list and `popular`, and
 * the pages that each called the API for something the workspace might not have. A workspace now has MODULES (inbox, scheduler, studio,
 * ads ...), and every one of those places asks this file instead.
 *
 * What decides visibility is a page's MODULE and the person's ROLE:
 *   - a module the workspace has not got is hidden and, on the server, refused (404 MODULE_OFF);
 *   - a page whose `minRole` the person does not hold is hidden (as `data-owner-only` / `data-operator-only` did);
 *   - a `scope: 'platform'` page is the platform admin's alone (App.pages' `adminOnly`).
 *
 * FAIL OPEN. `ctx.modules` is null when /auth/me named no modules (an older deployment, a session that has no workspace): that is
 * "everything on", because a dashboard that guessed "off" would take screens away from people who still have them. A workspace with
 * every module on sees exactly what it saw before this file existed (shell.test.ts holds that, byte for byte, for both tab strips).
 *
 * Pure functions: a `ctx` is `{ modules: string[] | null, role, admin }`, built by `Shell.context` (`App.shellContext()` is the live one).
 * `ctx === undefined` asks `App` for the live context when `App` exists, and means "everything on" when it does not (a test, a page
 * loaded alone). `ctx === null` is "everything on" for sure, the platform's pages included: it is only ever a test or a page loaded alone. Nothing here touches the network; `applyNav` writes to the document it is
 * handed.
 */
const Shell = {
    /** = MODULE_IDS in src/services/modules.ts (shell.test.ts compares them, when that file exists). */
    MODULES: Object.freeze(['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results', 'growth', 'studio', 'explainers', 'ads',
        'tiktok', 'youtube', 'whatsapp', 'muse', 'knowledge']),

    /** The in-workspace role axis (`App.tenantRole()`), lowest to highest. */
    ROLE_RANK: Object.freeze({ viewer: 0, operator: 1, owner: 2 }),

    /**
     * Every ROUTABLE page of `App.pages`, and nothing else (shell.test.ts holds the two together).
     *   group    the sidebar group in index.html ('today' | 'replies' | 'content' | 'results' | 'foot' | 'admin'), or null for a page with no
     *            item of its own (`App.pages`' `navAs`)
     *   module   a module id, or null (the shell's own pages)
     *   minRole  the lowest in-workspace role that sees it
     *   scope    'platform' = `App.pages[p].adminOnly`: the platform admin's alone, `minRole` ignored
     *   phone    the order in the phone bar (WA-8, U6); absent = never in the bar
     */
    PAGES: Object.freeze({
        overview: { group: 'today', module: null, minRole: 'viewer', phone: 1 },
        inbox: { group: 'today', module: 'inbox', minRole: 'viewer', phone: 2 },
        campaigns: { group: 'replies', module: 'keyword_replies', minRole: 'viewer' },
        ai_settings: { group: 'replies', module: 'dm_assistant', minRole: 'viewer' },
        studio: { group: 'content', module: 'studio', minRole: 'viewer', phone: 4 },
        monteur: { group: null, module: 'studio', minRole: 'viewer' },
        infographics: { group: null, module: 'studio', minRole: 'viewer' },
        explainers: { group: null, module: 'explainers', minRole: 'viewer' },
        brand: { group: 'content', module: 'studio', minRole: 'operator' },
        posts: { group: 'content', module: 'scheduler', minRole: 'viewer', phone: 3 },
        analytics: { group: 'results', module: 'results', minRole: 'viewer', phone: 6 },
        activity: { group: null, module: 'results', minRole: 'viewer' },
        growth: { group: 'results', module: 'growth', minRole: 'viewer' },
        ads: { group: 'results', module: 'ads', minRole: 'owner' },
        ads_campaigns: { group: null, module: 'ads', minRole: 'owner' },
        ads_results: { group: null, module: 'ads', minRole: 'owner' },
        ads_create: { group: null, module: 'ads', minRole: 'owner' },
        ads_proposals: { group: null, module: 'ads', minRole: 'owner' },
        ads_audiences: { group: null, module: 'ads', minRole: 'owner' },
        ads_rules: { group: null, module: 'ads', minRole: 'owner' },
        ads_leads: { group: null, module: 'ads', minRole: 'owner' },
        ads_tests: { group: null, module: 'ads', minRole: 'owner' },
        settings: { group: 'foot', module: null, minRole: 'viewer' },
        help: { group: 'foot', module: null, minRole: 'viewer' },
        operations: { group: 'admin', module: null, minRole: 'viewer', scope: 'platform' },
        tenants: { group: 'admin', module: null, minRole: 'viewer', scope: 'platform' },
        tenant_detail: { group: null, module: null, minRole: 'viewer', scope: 'platform' },
        admin_ads: { group: 'admin', module: null, minRole: 'viewer', scope: 'platform' },
        users: { group: 'admin', module: null, minRole: 'viewer', scope: 'platform' },
        jobs: { group: 'admin', module: null, minRole: 'viewer', scope: 'platform' },
        audit: { group: 'admin', module: null, minRole: 'viewer', scope: 'platform' },
        erasure: { group: 'admin', module: null, minRole: 'viewer', scope: 'platform' },
    }),

    /**
     * Area tab strips. `page` decides a tab's visibility (`canSee`); key, href, icon and label are what each strip always had.
     * `nav` is the strip's class list: `UI.watchTabStrips` keys on `nav.segmented`.
     */
    AREAS: Object.freeze({
        studio: Object.freeze({
            nav: 'segmented studio-seg studio-tabs',
            label: 'studio.tabs.label',
            tabs: Object.freeze([
                Object.freeze({ key: 'home', page: 'studio', href: '#/studio', icon: 'layers', label: 'studio.tabs.carousels' }),
                Object.freeze({ key: 'monteur', page: 'monteur', href: '#/monteur', icon: 'scissors', label: 'studio.tabs.monteur' }),
                Object.freeze({ key: 'infographics', page: 'infographics', href: '#/infographics', icon: 'images', label: 'studio.tabs.infographics' }),
                Object.freeze({ key: 'explainers', page: 'explainers', href: '#/explainers', icon: 'lightbulb', label: 'studio.tabs.explainers' }),
                Object.freeze({ key: 'settings', page: 'studio', href: '#/studio?tab=settings', icon: 'settings', label: 'studio.tabs.settings' }),
            ]),
        }),
        ads: Object.freeze({
            nav: 'segmented studio-seg ads-tabs-seg',
            label: 'ads.tabs.label',
            tabs: Object.freeze([
                Object.freeze({ key: 'overview', page: 'ads', href: '#/ads', icon: 'layout-dashboard', label: 'ads.tabs.overview' }),
                Object.freeze({ key: 'campaigns', page: 'ads_campaigns', href: '#/ads_campaigns', icon: 'megaphone', label: 'ads.tabs.campaigns' }),
                Object.freeze({ key: 'results', page: 'ads_results', href: '#/ads_results', icon: 'bar-chart-3', label: 'ads.tabs.results' }),
                Object.freeze({ key: 'proposals', page: 'ads_proposals', href: '#/ads_proposals', icon: 'sparkles', label: 'ads.tabs.proposals' }),
                Object.freeze({ key: 'audiences', page: 'ads_audiences', href: '#/ads_audiences', icon: 'users', label: 'ads.tabs.audiences' }),
                Object.freeze({ key: 'rules', page: 'ads_rules', href: '#/ads_rules', icon: 'list-checks', label: 'ads.tabs.rules' }),
                // A10: lead forms and leads, locked until a legal sign-off. The tab is always there; the page says when it is locked.
                Object.freeze({ key: 'leads', page: 'ads_leads', href: '#/ads_leads', icon: 'clipboard-list', label: 'ads.tabs.leads' }),
                // A12: split tests, two versions of an ad or two audiences.
                Object.freeze({ key: 'tests', page: 'ads_tests', href: '#/ads_tests', icon: 'split', label: 'ads.tabs.tests' }),
                // A5: the full builder. Owners only on the server; the tab is shown to whoever sees the Ads area, and Create explains a refusal.
                Object.freeze({ key: 'create', page: 'ads_create', href: '#/ads_create', icon: 'plus', label: 'ads.tabs.create' }),
            ]),
        }),
    }),

    /** Help article slug → module. A slug not listed belongs to none. */
    HELP_MODULES: Object.freeze({
        campaigns: 'keyword_replies', 'dm-assistant': 'dm_assistant', inbox: 'inbox', scheduling: 'scheduler',
        growth: 'growth', seo: 'growth', tiktok: 'tiktok', youtube: 'youtube', whatsapp: 'whatsapp', ads: 'ads',
        studio: 'studio', worker: 'studio', library: 'studio', create: 'studio', 'studio-schedule': 'studio',
        'studio-settings': 'studio', monteur: 'studio', infographics: 'studio', brand: 'studio', explainers: 'explainers',
    }),

    /** Articles for the platform admin only. */
    HELP_PLATFORM: Object.freeze(['workspaces', 'media-storage']),

    /** Filled into Help's front page when fewer than 4 of `HelpContent.popular` are visible. */
    POPULAR_FALLBACK: Object.freeze(['inbox', 'dm-assistant', 'scheduling', 'connect-meta']),

    /** How many cards Help's front page shows. */
    POPULAR_COUNT: 4,

    // ─── The context ─────────────────────────────────────────────────────────

    /**
     * What a session can see, from `App.session` and the two answers `App` already gives: `{ modules, role, admin }`.
     * `modules` is null (everything on) unless the session carries an array.
     */
    context(session, who) {
        const w = who || {};
        const modules = session && Array.isArray(session.modules) ? session.modules.slice() : null;
        return { modules, role: w.role === 'viewer' || w.role === 'operator' ? w.role : 'owner', admin: !!w.admin };
    },

    /** The live context: `App.shellContext()` when `App` exists, else everything on. */
    live() {
        if (typeof App !== 'undefined' && App && typeof App.shellContext === 'function') return App.shellContext();
        return null;
    },

    /** `undefined` → the live context; `null` or anything unreadable → everything on: every module, the owner's role, and the platform's pages. */
    resolve(ctx) {
        const c = ctx === undefined ? this.live() : ctx;
        if (!c || typeof c !== 'object') return { modules: null, role: 'owner', admin: true };
        return {
            modules: Array.isArray(c.modules) ? c.modules : null,
            role: c.role === 'viewer' || c.role === 'operator' ? c.role : 'owner',
            admin: !!c.admin,
        };
    },

    /** Is the module on? A missing `modules` list means everything is. A null module id (the shell's own pages) is always on. */
    hasModule(ctx, id) {
        const c = this.resolve(ctx);
        return !id || c.modules === null || c.modules.includes(id);
    },

    /** May this session open the page? Aliases are followed to their target. A page with no row is not visible. */
    canSee(page, ctx) {
        const c = this.resolve(ctx);
        let name = page;
        // An alias is its target's page; a name that is no page at all stays that (`resolveAlias` would answer Today for it).
        if (typeof App !== 'undefined' && App && typeof App.resolveAlias === 'function' && typeof App.entryOf === 'function' && App.entryOf(page)) name = App.resolveAlias(page).page;
        const row = Object.prototype.hasOwnProperty.call(this.PAGES, name) ? this.PAGES[name] : null;
        if (!row) return false;
        if (row.scope === 'platform') return c.admin;
        if (!this.hasModule(c, row.module)) return false;
        return this.ROLE_RANK[c.role] >= this.ROLE_RANK[row.minRole];
    },

    // ─── The menu ────────────────────────────────────────────────────────────

    /**
     * Show and hide the sidebar's items: for every `.nav-item[data-page]`, toggle `hidden` on its `<li>`, then hide a job group (not
     * `#nav-admin`, whose visibility is `data-admin-only`) whose items are all hidden. `doc` is the document, or anything with the same
     * `querySelectorAll`.
     */
    applyNav(doc, ctx) {
        if (!doc || typeof doc.querySelectorAll !== 'function') return;
        const c = this.resolve(ctx);
        const hold = (item) => (item.parentElement && String(item.parentElement.tagName || '').toUpperCase() === 'LI' ? item.parentElement : item);
        const hide = new Map();
        doc.querySelectorAll('.nav-item[data-page]').forEach((item) => {
            const page = (item.dataset && item.dataset.page) || (typeof item.getAttribute === 'function' ? item.getAttribute('data-page') : '');
            const hidden = !this.canSee(page, c);
            const box = hold(item);
            box.classList.toggle('hidden', hidden);
            hide.set(item, hidden);
        });
        doc.querySelectorAll('.sidebar-nav .nav-group').forEach((group) => {
            if (group.id === 'nav-admin') return;
            const items = typeof group.querySelectorAll === 'function' ? [...group.querySelectorAll('.nav-item[data-page]')] : [];
            if (!items.length) return;
            group.classList.toggle('hidden', items.every((item) => hide.get(item) === true));
        });
    },

    // ─── Area tab strips ─────────────────────────────────────────────────────

    /** The visible rows of an area's tab strip. */
    areaTabs(area, ctx) {
        const def = this.AREAS[area];
        if (!def) return [];
        const c = this.resolve(ctx);
        return def.tabs.filter((tab) => this.canSee(tab.page, c));
    },

    /**
     * An area's tab strip as markup, with `current` (a tab's `key`) marked. This is TODAY'S markup, byte for byte (`UI.watchTabStrips`
     * keys on `nav.segmented`): the pages used to write it themselves. Returns SafeHtml.
     */
    areaNav(area, current, ctx) {
        const def = this.AREAS[area];
        if (!def) return html``;
        const tab = (item) => html`
            <a class="btn btn-sm btn-ghost" href="${item.href}" ${current === item.key ? html.raw('aria-current="page"') : ''}>
                <i data-lucide="${item.icon}" aria-hidden="true"></i> ${t(item.label)}
            </a>
        `;
        return html`
            <nav class="${def.nav}" aria-label="${t(def.label)}">
                ${this.areaTabs(area, ctx).map(tab)}
            </nav>
        `;
    },

    // ─── Help ────────────────────────────────────────────────────────────────

    /** Does this session see the article? Platform articles are the admin's; a mapped article follows its module; any other is everyone's. */
    helpVisible(slug, ctx) {
        const c = this.resolve(ctx);
        if (this.HELP_PLATFORM.includes(slug)) return c.admin;
        const mapped = Object.prototype.hasOwnProperty.call(this.HELP_MODULES, slug) ? this.HELP_MODULES[slug] : null;
        return mapped ? this.hasModule(c, mapped) : true;
    },

    // ─── Data for the phone bar (WA-8) and search (WA-7): U6 draws them ──────

    /** Up to four visible pages in `phone` order, then 'more'. */
    phoneSlots(ctx) {
        const c = this.resolve(ctx);
        const slots = Object.keys(this.PAGES)
            .filter((page) => this.PAGES[page].phone !== undefined && this.canSee(page, c))
            .sort((a, b) => this.PAGES[a].phone - this.PAGES[b].phone)
            .slice(0, 4);
        return [...slots, 'more'];
    },

    /** Every visible page, then every visible tab of an area: `[{ kind: 'page' | 'tab', page, href, labelKey }]`. */
    searchEntries(ctx) {
        const c = this.resolve(ctx);
        const entries = Object.keys(this.PAGES)
            .filter((page) => this.canSee(page, c))
            .map((page) => ({ kind: 'page', page, href: `#/${page}`, labelKey: `nav.${page}` }));
        Object.keys(this.AREAS).forEach((area) => {
            this.areaTabs(area, c).forEach((tab) => {
                // A tab that is a page's own address (Carousels = #/studio, Overview = #/ads) is already an entry.
                if (!entries.some((e) => e.href === tab.href)) entries.push({ kind: 'tab', page: tab.page, href: tab.href, labelKey: tab.label });
            });
        });
        return entries;
    },
};
