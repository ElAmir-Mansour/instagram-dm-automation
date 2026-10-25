/**
 * App Controller — routing (hash-based), auth state, tenancy, page lifecycle.
 *
 * ─── Tenancy ────────────────────────────────────────────────────────────────
 * `GET /api/auth/me` is the source of truth for who the operator is, which
 * tenant the current token acts as, and which tenants they may switch to.
 * Switching mints a NEW token, so every page that caches tenant-scoped state
 * has to drop it — see resetTenantState(). Showing tenant A's conversation
 * under tenant B's name is the exact failure this feature exists to prevent.
 *
 * The whole tenancy layer degrades to nothing: if /auth/me is unavailable
 * (older deployment, route not shipped yet) `session.available` is false, the
 * switcher and the admin nav stay hidden, and the dashboard behaves exactly as
 * it did before — the shared-password operator keeps working.
 *
 * ─── Titles ─────────────────────────────────────────────────────────────────
 * Page titles and subtitles are i18n KEYS, not strings. They were the last
 * place English copy lived outside the catalog.
 *
 * ─── Page modules are loaded on demand ──────────────────────────────────────
 * All ten used to be <script> tags in index.html: 212KB of JavaScript on every
 * visit to render one screen. `loadPageModule()` injects the one the operator
 * asked for and memoises the promise. Two things keep that from being felt:
 * the inline snippet in index.html starts the fetch for the hash's page during
 * head parsing, and hovering or focusing a nav item starts the fetch for that
 * page before the click lands.
 *
 * ─── Navigation is one motion, not a teardown and a rebuild ─────────────────
 * `navigate()` paints the incoming page's SKELETON inside a view transition,
 * so the old content cross-fades into the new page's shape instead of blinking
 * through an empty container. The page then fills that shape in place.
 *
 * ─── What a page change does besides painting ───────────────────────────────
 * Each is the router's job, so no page has to remember it (UX audit SH-05, SH-07, SH-18):
 *   - the tab title names the page: "<Page> · <app name>", with the "(3) " unread count in front of it;
 *   - the change is announced to a screen reader (`Motion.announce`) and the new page opens at its top;
 *   - after a keyboard or drawer navigation focus moves to `#page-title`, because the element that held it is gone or hidden;
 *   - unsaved work is asked about BEFORE the page is torn down (the leave guard, below), and one shared `beforeunload`
 *     asks the same question of a reload, a closed tab and the language switch, which reloads.
 *
 * ─── The leave guard: what a page may define ────────────────────────────────
 *   canLeave()         false while the page holds work that leaving would lose. Anything else (true, nothing) means free to go.
 *                      Asked before the router switches to ANOTHER page, and by the shared `beforeunload`. A page does not bind its
 *                      own `beforeunload`. A dirty modal (`UI.isModalDirty()`) is covered with no help from the page.
 *   discardChanges()   optional. Called once, after the person agreed to lose that work and before `destroy()`, so a page that
 *                      keeps a copy of its edits (a parked draft, a local backup) drops it: the dialog said "discarded".
 * On Cancel the address is put back to the one the person left (`history.replaceState`), so Back and a nav click both leave the screen
 * and the address bar saying the same thing.
 *
 * ─── The sidebar (UX overhaul US6) ──────────────────────────────────────────
 * Organised by the creator's job (Today · Replies · Content · Results), each group a `<ul role="list">` named by its heading, with
 * Settings, Help and the account area at the foot and Administration as ONE collapsible group (`syncAdminGroup`: collapsed unless the
 * viewer opened it, remembered per browser, open while an admin page is). A page with no item of its own reads as the item it belongs
 * to (`navAs`: Monteur and Infographics as Studio, the Log as Results). The shell also owns what a nav item must not lose:
 *   - a modified click (Cmd, Ctrl, Shift, middle button) is the browser's, so "open in a new tab" works (`isModifiedClick`, SH-24);
 *   - at <= 860px the sidebar is a drawer, and a drawer nobody can see must not be reachable: closed it is `inert`, open the page behind
 *     it is (`syncDrawerInert`, SH-06);
 *   - a stored session opens on a static skeleton, not on the login form (`settleFirstFrame`, SH-03);
 *   - two markers slide, one over the scrolling list and one over the foot, each measured from geometry (`moveNavIndicator`).
 *
 * ─── Addresses ──────────────────────────────────────────────────────────────
 * `#/<page>?<query>`, built by `route()` and read by `hashParams()`. The query names the pages share are listed at `hashParams`.
 * An entry in `App.pages` that is `{ aliasOf, tab }` is an OLD address that now lives inside another page: `#/old` is rewritten
 * in place to `#/<aliasOf>?tab=<tab>` before anything renders, so old links, bookmarks and alert links keep working.
 */
const App = {
    currentPage: null,

    THEME_KEY: 'dashboard_theme',

    /** Populated by loadSession(). Never null once showApp() has run. */
    session: null,

    /** Bumped on every navigate() so a slow module load cannot land late. */
    _navSeq: 0,

    /** The scrim behind the mobile nav drawer — created once in init(). */
    _sidebarBackdrop: null,

    /**
     * The routes, and the modules behind them. An entry is one of:
     *   { src, page, adminOnly?, navAs?, routable?, css? }
     *       a page module, loaded on demand from /dashboard/js/pages/<src>.js. `css: true` also loads
     *       /dashboard/css/pages/<src>.css (same `?v=`) and holds the module back until it has arrived, so the page never paints
     *       unstyled. Declare it only for a page that HAS that file, or the request is a 404.
     *   { aliasOf, tab? }
     *       an old address that now opens another page, on that page's `tab`. It has no module and no CSS of its own.
     */
    pages: {
        overview: { src: 'overview', page: () => OverviewPage, css: true },
        campaigns: { src: 'campaigns', page: () => CampaignsPage },
        posts: { src: 'posts', page: () => PostsPage },
        studio: { src: 'studio', page: () => StudioPage },
        // The Studio's second tab (#/monteur): reels cut from the creator's own videos,
        // reviewed and approved into the scheduler. No sidebar entry of its own: while it is open the Studio item is current (`navAs`).
        monteur: { src: 'monteur', page: () => MonteurPage, navAs: 'studio' },
        // The Studio's third tab (#/infographics): animated comparisons in the creator's own
        // brand, written by Claude on the Mac, downloaded as a GIF or scheduled as an MP4. Studio's item is current here too.
        infographics: { src: 'infographics', page: () => InfographicsPage, navAs: 'studio' },
        // The Studio's fourth tab (#/explainers): researched, narrated, illustrated videos (v59). The owner's alone, behind the platform admin's switch.
        // It owns its own stylesheet (css/pages/explainers.css) and its own Settings view (`?tab=settings`); Studio's item is current here too.
        explainers: { src: 'explainers', page: () => ExplainersPage, navAs: 'studio', css: true },
        inbox: { src: 'inbox', page: () => InboxPage },
        ai_settings: { src: 'ai_settings', page: () => AiSettingsPage },
        analytics: { src: 'analytics', page: () => AnalyticsPage },
        // Right after Analytics: that screen is the automation's numbers, this one the
        // content's (Meta insights), plus the SEO tools and the coach. `?tab=seo` is its
        // second view and is handled in place through `onHashChange`.
        growth: { src: 'growth', page: () => GrowthPage },
        // Next to Growth: the content's numbers and the money spent promoting it. The workspace OWNER's (the page itself says so to anyone else, and the
        // nav item is hidden for them: `data-owner-only`).
        ads: { src: 'ads', page: () => AdsPage, css: true },
        // Ads' second tab (#/ads_campaigns): the campaign → ad set → ad tree. No sidebar entry of its own: the Ads item is current while it is open
        // (`navAs`). The Ads area shares ONE stylesheet, `css/pages/ads.css`, declared by the `ads` entry above; this module asks the shell for it
        // (`loadPageCss('ads', ...)`) before it paints, so it has no `css` of its own (that would look for an `ads_campaigns.css`).
        ads_campaigns: { src: 'ads_campaigns', page: () => AdsCampaignsPage, navAs: 'ads' },
        // Ads' third tab (#/ads_results): what the money did, day by day, from the stored copy (A6). Same stylesheet rule as Campaigns.
        ads_results: { src: 'ads_results', page: () => AdsResultsPage, navAs: 'ads' },
        // Ads' fourth tab (#/ads_create): the full ad builder (A5). Quick mode stays Posts' Boost dialog. Same stylesheet rule as Campaigns.
        ads_create: { src: 'ads_create', page: () => AdsCreatePage, navAs: 'ads' },
        // Ads' AI proposals (#/ads_proposals, A7): Claude drafts a campaign or a change, the owner approves, edits in the builder or rejects.
        ads_proposals: { src: 'ads_proposals', page: () => AdsProposalsPage, navAs: 'ads' },
        // Ads' audiences (#/ads_audiences, A8): engagement, video and lookalike audiences, and customer lists behind the legal lock.
        ads_audiences: { src: 'ads_audiences', page: () => AdsAudiencesPage, navAs: 'ads' },
        // Ads' rules (#/ads_rules, A9): the owner's standing conditions. Pause / lower / notify run alone once saved; raises and resumes ask.
        ads_rules: { src: 'ads_rules', page: () => AdsRulesPage, navAs: 'ads' },
        // Ads' leads (#/ads_leads, A10): instant forms and the leads they collect, locked until the platform admin records a legal sign-off.
        ads_leads: { src: 'ads_leads', page: () => AdsLeadsPage, navAs: 'ads' },
        // Ads' split tests (#/ads_tests, A12): two versions of an ad or two audiences; Meta names the winner, a proposal keeps it.
        ads_tests: { src: 'ads_tests', page: () => AdsTestsPage, navAs: 'ads' },
        // The log is Results' second view (a link strip at the top of both pages): no sidebar entry of its own, and the Results item
        // (`analytics`) is current while it is open.
        activity: { src: 'activity', page: () => ActivityPage, navAs: 'analytics' },
        settings: { src: 'settings', page: () => SettingsPage, css: true },
        // The Help Center owns sub-routes (`#/help/<slug>#<section>`) and
        // handles them itself through `onHashChange`, so opening an article
        // never tears the page down and rebuilds it.
        help: { src: 'help', page: () => HelpPage },
        // ─── Platform administration ─────────────────────────────────────────
        // `navAs` points a page with no nav item of its own at the item that
        // should read as current while it is open — otherwise the active
        // marker disappears the moment you open a tenant's detail view.
        operations: { src: 'operations', page: () => OperationsPage, adminOnly: true },
        tenants: { src: 'tenants', page: () => TenantsPage, adminOnly: true },
        tenant_detail: { src: 'tenant_detail', page: () => TenantDetailPage, adminOnly: true, navAs: 'tenants' },
        // Ads for clients (A11): per workspace, whether ads are on, the ceiling, health, cap use, alerts, shared spend and legal sign-offs.
        admin_ads: { src: 'admin_ads', page: () => AdminAdsPage, adminOnly: true, css: true },
        users: { src: 'users', page: () => UsersPage, adminOnly: true },
        jobs: { src: 'jobs', page: () => JobsPage, adminOnly: true },
        audit: { src: 'audit', page: () => AuditPage, adminOnly: true },
        erasure: { src: 'erasure', page: () => ErasurePage, adminOnly: true },
        // ─── Modules that are not routes (`routable: false`) ──────────────────
        // `pageFromHash` never lands on these. The invite page is the PUBLIC page a link opens: it renders into
        // #invite-screen, outside #app, and `init`/`onHashChange` route to it before they look for a session
        // (`showInvite`). The invite card is the platform admin's Copy / WhatsApp / Regenerate / Revoke dialog, loaded
        // on demand by Tenants and the tenant detail.
        invite: { src: 'invite', page: () => InvitePage, routable: false },
        invite_card: { src: 'invite_card', page: () => InviteCard, routable: false, adminOnly: true },
        // The AI providers card on Operations: keys, routes, prices, budgets and spend, with the Gemini key as one provider row. Loaded
        // by Operations on first use, and reset with every other module when the tenant changes.
        ai_providers: { src: 'ai_providers', page: () => AiProviders, routable: false, adminOnly: true },
        // The setup wizard a new tenant is sent to (#/welcome). Like the invite page it renders OUTSIDE #app, into
        // #welcome-screen: it has its own shell, and `navigate()` never reaches it. `showWelcome` is how it opens, and
        // the navigate gate (`mustOnboard`) is how a tenant that has not finished ends up there from every other route.
        welcome: { src: 'welcome', page: () => WelcomePage, routable: false },
        // The profile draft's client (P24): start it, watch it, carry on by hand while it is written, apply a field. No screen of its own; the
        // wizard and the tenant's page load it on demand: `const DraftClient = await App.loadPageModule('draft_client')`.
        draft_client: { src: 'draft_client', page: () => DraftClient, routable: false },
        // The draft assist on the wizard's first step ("Fill it for me"): loaded by the wizard when it starts, optional.
        welcome_draft: { src: 'welcome_draft', page: () => WelcomeDraft, routable: false },
        // The wizard's proof step, W5 (P25): two samples written in the person's voice for them to judge. Loaded by the wizard when it starts, optional: a
        // page that cannot fetch it shows the step as "samples not available" and lets the person carry on.
        welcome_proof: { src: 'welcome_proof', page: () => WelcomeProof, routable: false },
        // Connecting Instagram and Facebook (P28): the status words, the Page picker and the Connect / Disconnect actions that the Settings card and the
        // wizard's connect step share. Loaded on first use by whichever of the two needs it, and reset with the other modules when the tenant changes.
        meta_connect: { src: 'meta_connect', page: () => MetaConnect, routable: false },
        // The Instagram ice breakers and persistent menu editor (DM plan S13) on Settings: the owner's questions, Save, and the one Publish button. Loaded by Settings on
        // first use (for the tenant's owner only). It holds no state of its own across renders: Settings hands it the server's answer every time it draws the card.
        ice_breakers: { src: 'ice_breakers', page: () => IceBreakersCard, routable: false },
        // The ad builder's quick mode (A4): the dialog Posts' Boost button opens, with the post chosen. Loaded by Posts on first use; if it cannot be, Posts opens the older Boost form.
        ads_builder: { src: 'ads_builder', page: () => AdsBuilder, routable: false },
        // The WhatsApp card on Settings (T025): connect a number (the access token is read once and never kept), its health and free-replies meter, who the
        // assistant answers, and the paid-messages switch. Loaded by Settings on first use, for every member (the owner writes, the rest read), and reset
        // with the other modules when the tenant changes (`resetTenantState`).
        whatsapp_card: { src: 'whatsapp_card', page: () => WhatsAppCard, routable: false },
        // The client's own block at the end of the Settings → Meta ads card (A11): the ceiling its account manager set and the switch that shares its ad spend. Loaded by Settings
        // when the Ads card is shown, and it draws nothing when ads are off for the workspace.
        ads_client_card: { src: 'ads_client_card', page: () => AdsClientCard, routable: false },
    },

    /** Must match the `?v=` the rest of the assets are served with. */
    ASSET_VERSION: '12.75',

    _modules: Object.create(null),

    DEFAULT_PAGE: 'overview',

    /**
     * Fetch a page module if it is not already in. Resolves with the page
     * object, or null if the module could not be loaded — callers render an
     * error rather than a blank screen.
     *
     * `name` is only ever a key of `this.pages`, so nothing operator-supplied
     * reaches the URL.
     */
    loadPageModule(name) {
        // An alias has no module of its own: it is its target's.
        name = this.resolveAlias(name).page;
        const entry = this.entryOf(name);
        if (!entry) return Promise.resolve(null);

        const resolve = () => {
            try { return entry.page() || null; } catch { return null; }
        };

        const already = resolve();
        if (already) return Promise.resolve(already);

        if (!this._modules[name]) {
            this._modules[name] = new Promise((done) => {
                // The stylesheet is asked for first and awaited before the module is handed over: the module's render() paints
                // as soon as it gets the page, and a page that paints before its CSS arrives flashes unstyled.
                const styled = this.loadPageCss(name, entry);
                const script = document.createElement('script');
                script.src = `/dashboard/js/pages/${entry.src}.js?v=${this.ASSET_VERSION}`;
                script.onload = () => { styled.then(() => done(resolve())); };
                script.onerror = () => {
                    // Let a retry try again instead of caching the failure.
                    delete this._modules[name];
                    done(null);
                };
                document.head.appendChild(script);
            });
        }
        return this._modules[name];
    },

    /** The page stylesheets already requested, by page name: each `<link>` is added once, whoever asks first. */
    _pageCss: Object.create(null),

    /**
     * The page's own stylesheet, `/dashboard/css/pages/<src>.css?v=<ASSET_VERSION>`, for an entry that declares `css: true`.
     * Resolves when it has loaded OR failed: a missing page stylesheet must cost that page some styling, never the page. A failed
     * request is forgotten (and its `<link>` removed) so a retry asks again, as a failed module does.
     */
    loadPageCss(name, entry) {
        if (!entry || entry.css !== true) return Promise.resolve();
        if (this._pageCss[name]) return this._pageCss[name];
        this._pageCss[name] = new Promise((done) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = `/dashboard/css/pages/${entry.src}.css?v=${this.ASSET_VERSION}`;
            link.setAttribute('data-page-css', name);
            link.onload = () => done();
            link.onerror = () => {
                console.warn(`Page stylesheet for "${name}" did not load; the page opens without it.`);
                delete this._pageCss[name];
                if (typeof link.remove === 'function') link.remove();
                done();
            };
            document.head.appendChild(link);
        });
        return this._pageCss[name];
    },

    /** Fire-and-forget warm-up, for hover and focus. */
    prefetchPageModule(name) {
        if (this.entryOf(name)) this.loadPageModule(name);
    },

    title(page) { return t(`nav.${page}`); },
    subtitle(page) { return t(`page.${page}.subtitle`); },

    /** The entry named `name`, or null. Own keys only: an address is data, and `#/constructor` is not a page. */
    entryOf(name) {
        return typeof name === 'string' && Object.prototype.hasOwnProperty.call(this.pages, name) ? this.pages[name] : null;
    },

    /**
     * The page that answers for `name`, and the tab an alias names: `{ page, tab }` (`tab` is '' for an ordinary page, and for an alias
     * that names none). Aliases are followed to the page that has a module; the outermost alias's tab wins. A name that is not
     * an entry, or a chain that never ends, resolves to the default page: an address never leads nowhere.
     */
    resolveAlias(name) {
        let page = name;
        let tab = '';
        for (let hop = 0; hop < 4; hop++) {
            const entry = this.entryOf(page);
            if (!entry) return { page: this.DEFAULT_PAGE, tab: '' };
            if (!entry.aliasOf) return { page, tab };
            if (!tab && entry.tab) tab = String(entry.tab);
            page = entry.aliasOf;
        }
        return { page: this.DEFAULT_PAGE, tab: '' };
    },

    init() {
        I18N.init();
        I18N.applyStatic();
        this.renderLanguageToggle();
        this.setBaseTitle(this.appTitle());
        // The shell's static description is the Arabic one; a reload on a language switch is what lets this follow the language.
        document.querySelector('meta[name="description"]')?.setAttribute('content', t('app.description'));

        // Login form handler
        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('login-password').value;
            const emailField = document.getElementById('login-email');
            // Empty email = the shared-password path. It must send the body it
            // always sent, because it is still the operator's only way in.
            const email = emailField && !emailField.closest('.hidden')
                ? emailField.value.trim()
                : '';
            const errorEl = document.getElementById('login-error');
            const btn = document.getElementById('login-btn');
            const originalHtml = btn.innerHTML;

            btn.disabled = true;
            btn.innerHTML = UI.buttonSpinner();

            try {
                const keep = document.getElementById('login-keep');
                const result = await API.login(password, email, !!(email && keep && keep.checked));
                API.setToken(result.token);
                // The address is not a secret, and the next visit opens with the email field already showing it.
                if (email) this.rememberEmail(email);
                errorEl.classList.add('hidden');
                // Came here from an invite ("Sign in to add {tenant}"): back to that link, now with a session.
                if (this.consumeInviteReturn()) await this.showInvite();
                else await this.showApp();
            } catch (err) {
                errorEl.textContent = err && err.status === 401
                    ? (email ? t('login.invalidAccount') : t('login.invalidPassword'))
                    : (err && err.message) || t('login.failed');
                errorEl.classList.remove('hidden');
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
                UI.icons(btn);
            }
        });

        this.bindNavLinks();

        // The indicator is positioned from measured geometry, so it has to be
        // re-measured whenever the nav's box can change.
        const reposition = Motion.coalesce(() => this.moveNavIndicator(false));
        window.addEventListener('resize', reposition);
        if (document.fonts && typeof document.fonts.ready === 'object') {
            // A web font landing (the display face) can change the nav items' height.
            document.fonts.ready.then(reposition, () => {});
        }

        // Logout — tears the current page down first, so no poller survives it
        document.getElementById('logout-btn').addEventListener('click', () => this.logout());

        // Mobile menu — the sidebar becomes a fixed-position drawer at
        // ≤860px (see the `@media (max-width: 860px)` block in styles.css).
        // It gets the same dismiss contract UI.showModal already gives the
        // modal — a scrim, Escape-to-close, click-outside-to-close — plain
        // functions here rather than a class, to match this file's style.
        // The backdrop is created here, once, rather than added to
        // index.html: it exists only for this code to toggle.
        const menuBtn = document.getElementById('mobile-menu-btn');
        const sidebar = document.getElementById('sidebar');
        const backdrop = document.createElement('div');
        backdrop.className = 'sidebar-backdrop';
        document.body.appendChild(backdrop);
        this._sidebarBackdrop = backdrop;

        menuBtn.addEventListener('click', () => {
            if (sidebar.classList.contains('open')) this.closeMobileDrawer(false);
            else this.openMobileDrawer();
        });

        // Closed at drawer width the sidebar is `inert` (Tab and a screen reader's cursor skip its 15 off-screen links), and widening the
        // window past the breakpoint with the drawer open puts everything back (SH-06).
        this.syncDrawerInert();
        this.watchDrawerLayout();

        // Click-outside-to-close: the scrim is the only thing behind the
        // drawer at this width, so any click on it is the operator asking to
        // dismiss — same contract as the modal overlay's click handler.
        backdrop.addEventListener('click', () => this.closeMobileDrawer(true));

        // Escape closes the drawer — but only when it is actually open, and
        // only when a modal is not ALSO open. UI.showModal adds its own
        // Escape handler for the modal's lifetime (added in showModal,
        // removed in closeModal); rather than lean on registration order
        // between the two document-level listeners, this one simply steps
        // aside whenever the modal overlay is visible and lets the modal's
        // own handler own the key.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!sidebar.classList.contains('open')) return;
            const modalOverlay = document.getElementById('modal-overlay');
            if (modalOverlay && !modalOverlay.classList.contains('hidden')) return;
            e.preventDefault();
            this.closeMobileDrawer(true);
        });

        // Hash router — refresh lands on the same page, Back moves between pages. The event is passed on for `oldURL`: where the
        // person was, which is the address to put back when they decide not to leave.
        window.addEventListener('hashchange', (event) => this.onHashChange(event));

        this.bindShellGuards();

        UI.icons();

        // An invite link is opened by somebody who may have no session at all, and by somebody who has the wrong one
        // (the operator testing his own link): it is routed before a token is looked for, and the page decides.
        if (this.isInviteHash()) {
            this.showInvite();
        } else if (API.token) {
            this.showApp();
        } else {
            this.showLogin();
        }
    },

    /**
     * The shell's own listeners, apart from `init()` so a test can bind them without booting the app.
     *
     * The ONE "leave this page?" for a reload, a closed tab and the language switch (which reloads): the page on screen, or an open
     * dialog, holds work leaving would lose. Pages used to bind their own copy of this, so which screens were protected depended on
     * which screen you happened to be on (SH-18); they define `canLeave()` instead, and this asks the same question the router does.
     *
     * And how the person last operated the page: a keyboard navigation moves focus to the new page's title, a mouse click does not,
     * because the thing they clicked is still where they left it.
     */
    bindShellGuards() {
        window.addEventListener('beforeunload', (event) => {
            if (!this.unsavedKind()) return undefined;
            event.preventDefault();
            event.returnValue = '';
            return '';
        });
        document.addEventListener('keydown', () => { this._modality = 'keyboard'; }, true);
        document.addEventListener('pointerdown', () => { this._modality = 'pointer'; }, true);
    },

    /** Sign out: the page's timers stop first, so no poll survives into the login screen (the sidebar button and the wizard's link). */
    logout() {
        this.teardownCurrentPage();
        this.currentPage = null;
        this.session = null;
        this.resetTenantState();
        API.clearToken();
        this.showLogin();
    },

    // ─── Mobile nav drawer ───────────────────────────────────────────────────
    /**
     * Open the drawer and move focus inside it. Without this the hamburger
     * button keeps focus once the panel it controls is visible, and Tab from
     * there skips straight past the now-visible nav into page content.
     * Mirrors UI.showModal's initial-focus rule: prefer the first genuinely
     * usable item, falling back to the container itself.
     */
    openMobileDrawer() {
        const sidebar = document.getElementById('sidebar');
        const menuBtn = document.getElementById('mobile-menu-btn');
        if (!sidebar || !menuBtn) return;
        sidebar.classList.add('open');
        if (this._sidebarBackdrop) this._sidebarBackdrop.classList.add('open');
        menuBtn.setAttribute('aria-expanded', 'true');
        // Before the focus move: an `inert` drawer cannot take focus, and the page behind it must stop being reachable at once.
        this.syncDrawerInert();
        const nav = document.getElementById('sidebar-nav');
        const target = (nav && nav.querySelector('.nav-item[data-page]')) || sidebar;
        if (typeof target.focus === 'function') target.focus();
    },

    /**
     * Close the drawer. `returnFocus` is false for the close that happens as
     * a SIDE EFFECT of navigating — the operator's focus is headed to the
     * page they just picked, not back to the button that opened the drawer —
     * and true for every close the operator asks for directly: the backdrop
     * and Escape.
     */
    closeMobileDrawer(returnFocus) {
        const sidebar = document.getElementById('sidebar');
        const menuBtn = document.getElementById('mobile-menu-btn');
        if (!sidebar) return;
        sidebar.classList.remove('open');
        if (this._sidebarBackdrop) this._sidebarBackdrop.classList.remove('open');
        if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
        // Before the focus move: the page is `inert` while the drawer is open, and the menu button is on the page.
        this.syncDrawerInert();
        if (returnFocus && menuBtn) menuBtn.focus();
    },

    /** At this width and below the sidebar is an off-canvas drawer (the `@media (max-width: 860px)` block in styles.css). */
    DRAWER_QUERY: '(max-width: 860px)',

    isDrawerLayout() {
        try {
            return typeof window.matchMedia === 'function' && !!window.matchMedia(this.DRAWER_QUERY).matches;
        } catch {
            return false;
        }
    },

    /** `inert` on or off. The attribute, not the property, so it works wherever the attribute is understood and a test can read it. */
    setInert(el, on) {
        if (!el) return;
        if (on) el.setAttribute('inert', '');
        else el.removeAttribute('inert');
    },

    /**
     * Who can be reached while the sidebar is a drawer (SH-06). Closed, the drawer is only translated off-screen, so Tab walked 13 to 19
     * invisible links before it reached the page and focus left on a nav item after a tap sat in a panel nobody could see: it is `inert`.
     * Open, the page behind the scrim is `inert` instead, so Tab cannot escape the drawer into content the person cannot see. Wider than
     * the breakpoint the sidebar is a column of the layout and nothing is inert.
     */
    syncDrawerInert() {
        const sidebar = document.getElementById('sidebar');
        const main = document.getElementById('main-content');
        const drawer = this.isDrawerLayout();
        const open = !!(sidebar && sidebar.classList.contains('open'));
        this.setInert(sidebar, drawer && !open);
        this.setInert(main, drawer && open);
    },

    /** The window crossing the breakpoint: an open drawer is closed (the column layout has no scrim) and the inert state follows the width. */
    watchDrawerLayout() {
        let list = null;
        try { list = typeof window.matchMedia === 'function' ? window.matchMedia(this.DRAWER_QUERY) : null; } catch { list = null; }
        if (!list) return;
        const changed = () => {
            const sidebar = document.getElementById('sidebar');
            if (!this.isDrawerLayout() && sidebar && sidebar.classList.contains('open')) this.closeMobileDrawer(false);
            else this.syncDrawerInert();
        };
        if (typeof list.addEventListener === 'function') list.addEventListener('change', changed);
        else if (typeof list.addListener === 'function') list.addListener(changed);
    },

    /**
     * Sidebar navigation: real links, so they also work with the hash router. Hover and focus warm the page module so the click has
     * nothing to wait for; `pointerenter` rather than `mouseover` so it fires once per item and not on touch, where there is no hover to
     * warm from. The brand mark is the way home (SH-27): the same link rules as an item, without being one (it has no marker).
     * Apart from `init()` so a test can bind them to fake links.
     */
    bindNavLinks() {
        document.querySelectorAll('.nav-item[data-page]').forEach((item) => {
            item.addEventListener('click', (e) => { this.handleNavClick(e, item.dataset.page); });
            const warm = () => this.prefetchPageModule(item.dataset.page);
            item.addEventListener('pointerenter', warm, { once: true });
            item.addEventListener('focus', warm, { once: true });
        });
        const home = document.querySelector('[data-nav-home]');
        if (home) home.addEventListener('click', (e) => { this.handleNavClick(e, this.DEFAULT_PAGE); });
    },

    /** A click on a navigation link: the router's, unless it is a modified click, which is the browser's. True when the router took it. */
    handleNavClick(event, page) {
        if (this.isModifiedClick(event)) return false;
        event.preventDefault();
        this.go(page);
        return true;
    },

    /**
     * Is this click one the browser should handle itself? Cmd/Ctrl/Shift/Alt-click and the middle button open the link in a new tab,
     * a new window or a download, and `preventDefault()` on them used to swallow all four (SH-24). A plain click and a keyboard
     * activation (Enter on a link is a click with button 0 and no modifier) are the router's.
     */
    isModifiedClick(event) {
        if (!event) return false;
        if (event.defaultPrevented) return true;
        if (typeof event.button === 'number' && event.button !== 0) return true;
        return !!(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
    },

    // ─── Language & theme ────────────────────────────────────────────────────
    /**
     * A two-language switcher is a button, not a dropdown, and it is labelled
     * with the language you GET rather than the one you are in. The old control
     * read "English" while the interface was already English, which tells the
     * operator nothing about what clicking it does.
     *
     * Three rules:
     *   - the label is the target language's AUTONYM — العربية, never "Arabic",
     *     because a language name belongs in its own script;
     *   - `lang` on the button so the browser shapes العربية with an Arabic face and sets
     *     English in a Latin one, instead of whichever face the surrounding UI happens to be using;
     *   - the visible label is a noun, so the accessible name is the verb:
     *     "التبديل إلى الإنجليزية" / "Switch to Arabic".
     */
    otherLang() {
        return I18N.lang === 'ar' ? 'en' : 'ar';
    },

    renderLanguageToggle() {
        // Two instances: the header's and the login card's. The login one exists
        // because first-visit language comes from the browser, and an Arabic
        // operator on an English-locale device used to log in through an
        // English form with no way to switch until they were inside.
        const target = this.otherLang();
        const cfg = I18N.LANGS[target];
        document.querySelectorAll('#lang-toggle, [data-lang-toggle]').forEach((btn) => {
            btn.textContent = cfg.label;
            btn.setAttribute('lang', cfg.htmlLang);
            btn.setAttribute('dir', cfg.dir);
            btn.setAttribute('aria-label', t('app.switchTo', { name: t(`lang.name.${target}`) }));
        });
    },

    /** 'auto' | 'dark' | 'light'. 'auto' removes the attribute and lets
     *  prefers-color-scheme decide, which is the default. */
    currentTheme() {
        try {
            const stored = localStorage.getItem(App.THEME_KEY);
            return stored === 'dark' || stored === 'light' ? stored : 'auto';
        } catch {
            return 'auto';
        }
    },

    setTheme(value) {
        const theme = value === 'dark' || value === 'light' ? value : 'auto';
        try {
            if (theme === 'auto') localStorage.removeItem(App.THEME_KEY);
            else localStorage.setItem(App.THEME_KEY, theme);
        } catch { /* private mode */ }
        if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', theme);
        // Charts read their colours from the tokens at construction time.
        if (this.currentPage) this.show(this.currentPage);
    },

    /**
     * The page is the first path segment of the hash: `#/tenant_detail?id=…`,
     * `#/help/worker#security` and `#/help` all name their page before the
     * first `/`, `?` or `#`. What follows belongs to the page to read.
     */
    pageFromHash() {
        const raw = (location.hash || '').replace(/^#\/?/, '').split(/[/?#]/)[0];
        const entry = this.entryOf(raw);
        // An alias answers with the page it points at, so every caller sees a page that has a module.
        return entry && entry.routable !== false ? this.resolveAlias(raw).page : this.DEFAULT_PAGE;
    },

    /**
     * `hash` with its page replaced by the page an alias points at and its `tab` set, or null when `hash` does not start with an alias.
     * Pure. `#/analytics?x=1#top` with `analytics → results, tab: campaigns` becomes `#/results?tab=campaigns&x=1#top`; a `tab` the
     * address already carries beats the alias's, so a link that names its tab keeps it.
     */
    aliasAddress(hash) {
        const raw = String(hash || '').replace(/^#\/?/, '');
        const head = raw.split(/[/?#]/)[0];
        const entry = this.entryOf(head);
        if (!entry || !entry.aliasOf) return null;
        const { page, tab } = this.resolveAlias(head);
        const rest = raw.slice(head.length); // "/sub?x=1#frag"
        const fragAt = rest.indexOf('#');
        const fragment = fragAt === -1 ? '' : rest.slice(fragAt);
        const body = fragAt === -1 ? rest : rest.slice(0, fragAt);
        const queryAt = body.indexOf('?');
        const sub = queryAt === -1 ? body : body.slice(0, queryAt);
        let typed;
        try { typed = new URLSearchParams(queryAt === -1 ? '' : body.slice(queryAt + 1)); } catch { typed = new URLSearchParams(''); }
        const query = new URLSearchParams();
        const wanted = typed.get('tab') || tab;
        if (wanted) query.set('tab', wanted);
        typed.forEach((value, key) => { if (key !== 'tab') query.append(key, value); });
        const search = query.toString();
        return `#/${page}${sub}${search ? `?${search}` : ''}${fragment}`;
    },

    /**
     * An old address that is an alias becomes the page's own address, in place: no history entry (Back does not return to the alias) and
     * no `hashchange`. Done before routing, like `settleMetaPickAddress`, so the page reads `?tab=` as it would on any visit and a
     * reload or a bookmark keeps the new address.
     */
    settleAliasAddress() {
        const next = this.aliasAddress(location.hash);
        if (!next) return;
        try { history.replaceState(null, '', next); } catch { /* the address stays: pageFromHash still resolves it */ }
    },

    /**
     * A hash change inside the page that is already open goes to that page
     * when it asks for it (`onHashChange`), so an article link in the Help
     * Center moves the reader without a teardown, a skeleton and a rebuild.
     * Every other change is a navigation, exactly as before.
     */
    onHashChange(event) {
        this.settleMetaPickAddress();
        this.settleAliasAddress();
        // Where the person was: the address to put back if the leave guard is answered with Cancel. `oldURL` is accurate even when the
        // page moved its own hash with `history.replaceState` (the Inbox's filter does), which no copy the router keeps could be.
        this._hashBefore = this.hashOfUrl(event && event.oldURL);
        if (this.isInviteHash()) {
            this.showInvite();
            return;
        }
        // The wizard owns its own hash (`#/welcome?step=voice`, so the phone's Back button moves between its steps).
        if (this.isWelcomeScreenOpen()) {
            if (this.isWelcomeHash() && this.wantsWelcome()) {
                const page = this.pages.welcome.page();
                if (page && typeof page.onHashChange === 'function') page.onHashChange();
            } else if (API.token) {
                // Left it by the address bar, or finished: whatever the gate says this session should see (the wizard, again, if it is not done).
                this.showApp();
            } else {
                this.showLogin();
            }
            return;
        }
        // A #/welcome typed or followed from the dashboard: only a gated tenant (or the platform admin filling in for one) sees it.
        if (this.isWelcomeHash() && API.token) {
            this.showApp();
            return;
        }
        // Leaving the invite page by the address bar: back to whichever screen this browser would otherwise show.
        const invite = document.getElementById('invite-screen');
        if (invite && !invite.classList.contains('hidden')) {
            if (API.token) this.showApp(); else this.showLogin();
            return;
        }
        if (!API.token) return;
        const page = this.pageFromHash();
        if (page === this.currentPage) {
            let instance = null;
            try { instance = this.pages[page].page(); } catch { instance = null; }
            if (instance && typeof instance.onHashChange === 'function') {
                try {
                    instance.onHashChange();
                    this._shownHash = String(location.hash || '');
                    this._hashBefore = null;
                    return;
                } catch (err) {
                    console.warn('In-page route failed, re-rendering:', err);
                }
            }
        }
        this.show(page);
    },

    /**
     * The query half of the hash — `#/tenant_detail?id=…`.
     *
     * The hash is attacker-controllable, so a value read from here is data
     * like any other: it is escaped where it is rendered and percent-encoded
     * where it goes into a path. Nothing interpolates it into markup raw.
     */
    hashQuery() {
        const raw = String(location.hash || '');
        const at = raw.indexOf('?');
        try {
            return new URLSearchParams(at === -1 ? '' : raw.slice(at + 1));
        } catch {
            return new URLSearchParams('');
        }
    },

    hashParam(name) {
        const value = this.hashQuery().get(name);
        return value === null ? '' : value;
    },

    /**
     * Every query parameter of the current hash, as `{ name: value }` (the first of a repeated name; no prototype, so a hostile name
     * such as `__proto__` is an ordinary key). The values are DATA, escaped where drawn and encoded where they go into a path.
     *
     * The names the pages share, so the same word means the same thing everywhere:
     *   tab      which tab of a tabbed page is open (Studio, Results, Platform); an alias's `tab` arrives here
     *   filter   a list's quick filter: Inbox `todo|waiting|needs_you|hot|paused`, Scheduler `needs-you`
     *   status   a status to show, as the API spells it: `FAILED` on the Log, a job's or a post's status
     *   since    the earliest moment a log or list reaches back to, an ISO date or date-time
     *   s        the Settings card or section to open (`#/settings?s=meta`)
     *   post     a scheduled post's id, to open or highlight on the Scheduler
     *   c        a conversation's id on the Inbox: the link in the owner's alerts (`#/inbox?c=<uuid>`)
     * Any other name (`id`, `step`, `mode`, `focus` ...) belongs to the one page that reads it. `route()` writes the same shape.
     */
    hashParams() {
        const out = Object.create(null);
        this.hashQuery().forEach((value, key) => { if (!(key in out)) out[key] = value; });
        return out;
    },

    /**
     * The address of a page: `#/<page>` or `#/<page>?a=b`. Empty, null and undefined values are left out; the rest are encoded, so
     * nothing a person typed or a response held lands in the address unescaped. An alias is written as the page it points at, on its
     * tab (`route('analytics')` is `#/results?tab=campaigns`), and a `tab` in `params` beats the alias's. A name that is not a page
     * is the default page's address, not a dead link.
     */
    route(page, params) {
        const known = this.entryOf(page);
        const { page: target, tab } = known ? this.resolveAlias(page) : { page: this.DEFAULT_PAGE, tab: '' };
        const query = new URLSearchParams();
        if (tab) query.set('tab', tab);
        Object.keys(params || {}).forEach((key) => {
            const value = params[key];
            if (value !== null && value !== undefined && value !== '') query.set(key, String(value));
        });
        const search = query.toString();
        return `#/${target}${search ? `?${search}` : ''}`;
    },

    /** The `#…` part of a URL, or ''. (`hashchange`'s `oldURL` is a whole URL; the address to restore is only its hash.) */
    hashOfUrl(url) {
        const raw = String(url || '');
        const at = raw.indexOf('#');
        return at === -1 ? '' : raw.slice(at);
    },

    /** The tab title before any "(3) " prefix: the app's own name, or "<Page> · <app name>" while a page is open. */
    _baseTitle: null,

    /** How many conversations are waiting, as the tab title shows it. */
    _waiting: 0,

    /** What the tab says when no page is open: the login, the invite and the setup wizard. */
    appTitle() {
        return `${t('app.name')} — ${t('app.tagline')}`;
    },

    setBaseTitle(base) {
        this._baseTitle = base;
        this.applyDocumentTitle();
    },

    /** The base title with the "(n) " unread prefix: one place, so a page change and a count change cannot undo each other. */
    applyDocumentTitle() {
        if (this._baseTitle === null) this._baseTitle = document.title;
        const n = this._waiting;
        const title = n > 0 ? `(${n > 99 ? '99+' : n}) ${this._baseTitle}` : this._baseTitle;
        if (document.title !== title) document.title = title;
    },

    /**
     * How many conversations are waiting for a human, on the Inbox nav item and
     * in the tab title. Fed by the inbox poll and by the Overview's own
     * `/conversations` read, so the one thing the operator opens the app for
     * is visible from every screen and from another tab. Hidden at zero: this
     * is a count, not a badge — data, not decoration (DESIGN.md §6).
     */
    setInboxWaiting(count) {
        const n = Math.max(0, Math.floor(Number(count) || 0));
        this._waiting = n;
        const item = document.querySelector('.nav-item[data-page="inbox"]');
        if (item) {
            let badge = item.querySelector('.nav-count');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'nav-count';
                item.appendChild(badge);
            }
            badge.hidden = n === 0;
            badge.innerHTML = esc(html`<span aria-hidden="true">${n > 99 ? '99+' : UI.formatNumber(n)}</span><span class="sr-only">${t('nav.inboxWaiting', { count: n, n: UI.formatNumber(n) })}</span>`);
        }
        this.applyDocumentTitle();
    },

    /** Navigate by updating the hash; hashchange does the actual render. */
    go(page) {
        if (!this.entryOf(page)) return;
        const target = this.route(page);
        if (location.hash === target) {
            this.show(page); // same hash, force a re-render
        } else {
            location.hash = target;
        }
    },

    /**
     * Navigate to a page WITH parameters — the detail views. Same rule as
     * `go()`: the page name is only ever a key of `this.pages`, and the params
     * are encoded, so nothing operator-supplied lands in the hash unescaped.
     */
    goWithQuery(page, params) {
        if (!this.entryOf(page)) return;
        const target = this.route(page, params);
        if (location.hash === target) {
            this.show(page);
        } else {
            location.hash = target;
        }
    },

    /**
     * `reason` is shown in the form's alert slot: a session that expired
     * mid-task used to bounce here with no explanation, which reads as "my
     * password stopped working". Logout and first load pass nothing.
     */
    showLogin(reason) {
        this.teardownCurrentPage();
        this.currentPage = null;
        // A signed-out tab must not keep saying "(3)" in its title, nor the last page's name.
        this.setBaseTitle(this.appTitle());
        this.setInboxWaiting(0);
        this.stopAdminStatusPoll();
        this.rememberGated(false);
        // Lifted: the head script hid the login card from the first frame of an invite link (index.html), and this is where it is wanted.
        document.documentElement.removeAttribute('data-invite');
        // And the stored-session skeleton (SH-03) has nothing left to stand in for: the session is gone or was never there.
        this.settleFirstFrame();
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('app').classList.add('hidden');
        const inviteScreen = document.getElementById('invite-screen');
        if (inviteScreen) inviteScreen.classList.add('hidden');
        this.hideWelcome();
        const errorEl = document.getElementById('login-error');
        if (errorEl) {
            errorEl.textContent = reason ? String(reason) : '';
            errorEl.classList.toggle('hidden', !reason);
        }
        const pw = document.getElementById('login-password');
        if (pw) pw.value = '';
        // The one-field form (the shared password, the operator's only way in) unless an address was remembered: somebody
        // who set a password from an invite link, or signed in with an account, comes back to the email field already filled.
        const remembered = this.rememberedEmail();
        const email = document.getElementById('login-email');
        if (email) email.value = remembered;
        const group = document.getElementById('login-email-group');
        if (group) group.classList.toggle('hidden', !remembered);
        const toggle = document.getElementById('login-email-toggle');
        if (toggle) toggle.classList.toggle('hidden', !!remembered);
        const keep = document.getElementById('login-keep');
        if (keep) keep.checked = false;
    },

    // ─── Remembering who signed in last ──────────────────────────────────────

    EMAIL_KEY: 'login_email',

    rememberedEmail() {
        try {
            const value = localStorage.getItem(this.EMAIL_KEY) || '';
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : '';
        } catch {
            return '';
        }
    },

    rememberEmail(email) {
        try {
            if (email) localStorage.setItem(this.EMAIL_KEY, String(email).trim().toLowerCase());
        } catch { /* private mode: the form simply opens as it always did */ }
    },

    // ─── Invite links ────────────────────────────────────────────────────────
    //
    // The token lives in the URL hash, so no server, log or Referer ever sees it. It is moved into sessionStorage and the
    // hash is cut back to a bare `#/invite` before anything renders, so the address bar, the history entry and a screenshot
    // never hold it, and a reload (switching language reloads) still finds it.

    INVITE_KEY: 'invite_token',
    INVITE_RETURN_KEY: 'invite_return',
    _inviteToken: '',

    /**
     * `#/invite?t=…`, the links the invite card has made since P17, and `#/welcome?invite=…`, the spelling the onboarding spec
     * gives (02 §3, W0): the invite page IS the wizard's first screen, so a link may name either. A bare `#/welcome` is the
     * wizard itself and is not an invite.
     */
    isInviteHash() {
        const hash = String(location.hash || '');
        return /^#\/invite(?:[?/#]|$)/.test(hash) || /^#\/welcome\?(?:[^#]*&)?invite=/.test(hash);
    },

    /** Read the token out of the hash (once), keep it for this tab, and take it out of the address bar. */
    captureInvite() {
        const raw = String(location.hash || '');
        const at = raw.indexOf('?');
        let token = '';
        try {
            const query = new URLSearchParams(at === -1 ? '' : raw.slice(at + 1));
            token = query.get('t') || query.get('invite') || '';
        } catch { token = ''; }
        if (token) {
            this._inviteToken = token;
            try { sessionStorage.setItem(this.INVITE_KEY, token); } catch { /* the in-memory copy serves this page view */ }
        }
        if (at !== -1) history.replaceState(null, '', '#/invite');
    },

    /** The token this tab is holding, or '' (none, or one that cannot be a token). */
    inviteToken() {
        let token = this._inviteToken;
        if (!token) {
            try { token = sessionStorage.getItem(this.INVITE_KEY) || ''; } catch { token = ''; }
        }
        return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
    },

    forgetInvite() {
        this._inviteToken = '';
        try {
            sessionStorage.removeItem(this.INVITE_KEY);
            sessionStorage.removeItem(this.INVITE_RETURN_KEY);
        } catch { /* nothing to clear */ }
    },

    /** Did the person leave the invite page for the login, meaning to come back to it? One-shot. */
    consumeInviteReturn() {
        let pending = false;
        try {
            pending = sessionStorage.getItem(this.INVITE_RETURN_KEY) === '1' && !!this.inviteToken();
            sessionStorage.removeItem(this.INVITE_RETURN_KEY);
        } catch { pending = false; }
        if (pending) history.replaceState(null, '', '#/invite');
        return pending;
    },

    /** Show the invite page, outside the app: there may be no session, or the wrong one. */
    async showInvite() {
        this.captureInvite();
        this.teardownCurrentPage();
        this.currentPage = null;
        this.setBaseTitle(this.appTitle());
        this.setInboxWaiting(0);
        this.stopAdminStatusPoll();
        this.settleFirstFrame();
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.add('hidden');
        this.hideWelcome();
        const screen = document.getElementById('invite-screen');
        if (screen) screen.classList.remove('hidden');
        this.renderLanguageToggle();

        const page = await this.loadPageModule('invite');
        const card = document.getElementById('invite-card');
        if (!page) {
            if (card) card.textContent = t('invite.loadFailed');
            return;
        }
        await page.start();
    },

    /**
     * Leave the invite page for the login. `comeBack` keeps the link: the person has an account, signs in with it, and the
     * page then offers to add the tenant to it. Without it the link is dropped: it is dead, or not theirs to use.
     */
    leaveInviteForLogin(comeBack, email) {
        if (comeBack) {
            try { sessionStorage.setItem(this.INVITE_RETURN_KEY, '1'); } catch { /* the login then simply opens the dashboard */ }
            if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) this.rememberEmail(email);
        } else {
            this.forgetInvite();
        }
        history.replaceState(null, '', location.pathname + location.search);
        this.showLogin();
    },

    /**
     * The link worked: keep the session it answered with, remember the address for the login, forget the token, and go in. A
     * tenant that has not finished setting up lands in the wizard (`#/welcome`, which is where the navigate gate would send
     * them anyway); a link that adds somebody to a tenant that is set up already (a second member, a password reset) lands
     * on the dashboard like any other sign-in.
     */
    async completeInvite(result, email) {
        API.setToken(result.token);
        this.rememberEmail(email || result.email);
        this.forgetInvite();
        const screen = document.getElementById('invite-screen');
        if (screen) screen.classList.add('hidden');
        const status = result && result.onboarding && result.onboarding.status;
        const toWizard = !!status && status !== 'completed' && result.purpose !== 'reset';
        history.replaceState(null, '', toWizard ? '#/welcome' : `#/${this.DEFAULT_PAGE}`);
        await this.showApp();
    },

    /**
     * The Page picker's address. A person with several Pages is sent by the Meta callback to
     * `#/connect-meta?meta=pick&pick=…&return_to=…`, which is not a screen: the picker is a modal over the screen that began the
     * flow. So the address becomes that screen's (`#/settings?meta=pick&pick=…`, or the wizard's connect step), with the pick
     * still in it, and that screen opens the modal when it has painted. Rewritten in place (no history entry), and before any
     * routing, so a login in between (the session may have expired during the round trip) lands on the right screen too.
     */
    metaPickAddress(hash) {
        const found = /^#\/connect-meta\?(.*)$/.exec(String(hash || ''));
        if (!found) return null;
        let params;
        try { params = new URLSearchParams(found[1]); } catch { return null; }
        const to = params.get('return_to') === 'welcome' ? '#/welcome?step=connect' : '#/settings';
        params.delete('return_to');
        const rest = params.toString();
        return rest ? `${to}${to.includes('?') ? '&' : '?'}${rest}` : to;
    },

    settleMetaPickAddress() {
        const next = this.metaPickAddress(location.hash);
        if (!next) return;
        try { history.replaceState(null, '', next); } catch { /* the address stays: the page opens on its default screen */ }
    },

    async showApp() {
        this.settleMetaPickAddress();
        this.settleAliasAddress();
        document.getElementById('login-screen').classList.add('hidden');
        const inviteScreen = document.getElementById('invite-screen');
        if (inviteScreen) inviteScreen.classList.add('hidden');

        // The session first, the app second: whether this person sees the dashboard at all depends on what /auth/me says (a
        // tenant that has not finished setting up is sent to the wizard), and showing the sidebar for the length of that
        // answer would flash a dashboard they are about to be taken out of.
        const ok = await this.loadSession();
        if (!ok) return; // 401 — API.request already bounced us to the login screen

        if (this.wantsWelcome()) {
            await this.showWelcome();
            return;
        }
        this.hideWelcome();
        document.getElementById('app').classList.remove('hidden');
        this.settleFirstFrame();

        this.applyChrome();

        const page = this.pageFromHash();
        // Normalise the PAGE part only. `#/tenant_detail?id=…` and
        // `#/help/worker#security` are legitimate deep links, and rewriting
        // them to their bare page would throw the id, the article and the
        // section away on every reload and every bookmarked link.
        const hash = String(location.hash || '');
        const head = hash.replace(/^#\/?/, '').split(/[/?#]/)[0];
        if (!hash.startsWith(`#/${page}`) || head !== page) {
            // Normalise without adding a history entry AND without firing
            // hashchange (which would render the page a second time).
            const query = String(location.hash || '').split('?')[1];
            history.replaceState(null, '', `#/${page}${query ? `?${query}` : ''}`);
        }
        await this.navigate(page);
    },

    // ─── Session / tenancy ───────────────────────────────────────────────────

    /**
     * Load identity + tenant list. Returns false only when the session is dead.
     *
     * Any other failure (404 because the route is not deployed, a 500, the
     * network) leaves `available: false`, which hides every tenancy affordance
     * and lets the rest of the dashboard work exactly as it does today. It must
     * never guess `platform_admin`: that would show admin nav that 404s.
     */
    async loadSession() {
        try {
            const me = await API.getMe();
            this.session = {
                userId: (me && me.userId) || null,
                // The address, when the server says it (it does not today: the account area then falls back, see `identityLabel`).
                email: (me && typeof me.email === 'string') ? me.email : '',
                role: (me && me.role) || 'user',
                tenantId: (me && me.tenantId) || null,
                // The role INSIDE the current tenant, which is a different axis from
                // `role` above: that one is platform_admin vs user, this one is
                // owner/operator/viewer. Null means the server did not say, and the
                // dashboard then hides nothing — the API is what refuses, and a UI
                // that guesses "restricted" would take affordances away from people
                // who still have them.
                tenantRole: (me && me.tenantRole) || null,
                tenants: (me && Array.isArray(me.tenants)) ? me.tenants : [],
                // Where this tenant is in the setup wizard, and whether this session is sent to it. Null when the server could
                // not say (an older deployment): the dashboard then gates nothing.
                onboarding: (me && me.onboarding && typeof me.onboarding === 'object') ? me.onboarding : null,
                available: true,
            };
            this.rememberGated(this.mustOnboard());
        } catch (err) {
            if (err && err.status === 401) return false;
            this.session = { userId: null, email: '', role: null, tenantId: null, tenantRole: null, tenants: [], onboarding: null, available: false };
        }
        return true;
    },

    // ─── The first frame (SH-03) ─────────────────────────────────────────────

    GATED_KEY: 'onboarding_gated',

    /**
     * The last `/auth/me` said whether this session is sent to the setup wizard. index.html's head script reads it before anything else
     * runs, so a tenant that is about to be taken to the wizard is not shown a sidebar skeleton for the length of that answer. Written
     * only from an answer (never from a failure), and forgotten at sign-out.
     */
    rememberGated(gated) {
        try {
            if (gated) localStorage.setItem(this.GATED_KEY, '1');
            else localStorage.removeItem(this.GATED_KEY);
        } catch { /* private mode: the first frame shows the sidebar skeleton, which is only a skeleton */ }
    },

    /**
     * The stored-session skeleton has done its job (the dashboard, the wizard, the invite page or the login is on screen now): lift the
     * attributes the head script set. Safe to call at any time and any number of times.
     */
    settleFirstFrame() {
        const root = document.documentElement;
        if (!root) return;
        root.removeAttribute('data-session');
        root.removeAttribute('data-gated');
    },

    // ─── The setup wizard (#/welcome) ────────────────────────────────────────

    isWelcomeHash() {
        return /^#\/welcome(?:[?/#]|$)/.test(String(location.hash || ''));
    },

    isWelcomeScreenOpen() {
        const screen = document.getElementById('welcome-screen');
        return !!(screen && !screen.classList.contains('hidden'));
    },

    /**
     * The navigate gate: is this session sent to the wizard from every other route? The server decides (`onboarding.gated` in
     * /auth/me: an OWNER of a tenant whose setup is not completed) and this repeats the two conditions that must never be
     * wrong. A platform admin is exempt, and `completed` is never gated, so the owner (whose tenant is completed, and whose
     * operators are not owners) never sees the wizard, whatever else is stored or missing.
     */
    mustOnboard() {
        const s = this.session;
        if (!s || !s.available) return false;
        if (s.role === 'platform_admin') return false;
        const o = s.onboarding;
        return !!(o && o.gated === true && o.status !== 'completed');
    },

    /** The gate, plus the one way in for a platform admin: `#/welcome?mode=behalf`, filling the wizard in for the tenant they are acting as. */
    wantsWelcome() {
        if (this.mustOnboard()) return true;
        return this.isWelcomeHash() && this.isAdmin() && this.hashParam('mode') === 'behalf';
    },

    hideWelcome() {
        const screen = document.getElementById('welcome-screen');
        if (screen) screen.classList.add('hidden');
        try {
            const page = this.pages.welcome.page();
            if (page && typeof page.destroy === 'function') page.destroy();
        } catch { /* the module was never loaded: nothing to stop */ }
    },

    /** Show the wizard, outside the app: its own shell, no sidebar. The session is already known (`showApp` read it). */
    async showWelcome() {
        this.teardownCurrentPage();
        this.currentPage = null;
        this.setBaseTitle(this.appTitle());
        this.setInboxWaiting(0);
        this.stopAdminStatusPoll();
        document.documentElement.removeAttribute('data-invite');
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.add('hidden');
        const invite = document.getElementById('invite-screen');
        if (invite) invite.classList.add('hidden');
        const screen = document.getElementById('welcome-screen');
        if (screen) screen.classList.remove('hidden');
        this.settleFirstFrame();
        this.renderLanguageToggle();

        // Sent here from another route: the address says where they are.
        if (!this.isWelcomeHash()) history.replaceState(null, '', '#/welcome');

        const page = await this.loadPageModule('welcome');
        if (!page) {
            const root = document.getElementById('welcome-root');
            if (root) root.textContent = t('welcome.loadFailed');
            return;
        }
        await page.start();
    },

    /** The wizard is finished (or the platform admin is done): open the dashboard, with the gate asked again. */
    async leaveWelcome() {
        this.hideWelcome();
        history.replaceState(null, '', `#/${this.DEFAULT_PAGE}`);
        await this.showApp();
    },

    /** Re-read /auth/me after something changed the tenant list, then re-chrome. */
    async refreshSession() {
        const ok = await this.loadSession();
        if (ok) this.applyChrome();
        return ok;
    },

    isAdmin() {
        return !!(this.session && this.session.available && this.session.role === 'platform_admin');
    },

    /** No tenants exist yet — a fresh deployment with nothing but a password. */
    needsSetup() {
        return !!(this.session && this.session.available && this.session.tenants.length === 0);
    },

    /**
     * An admin route answered 403/404. Whatever /auth/me said, this session
     * cannot administer, so take the nav away instead of leaving links that
     * only ever fail.
     */
    dropAdminAccess() {
        if (!this.session || this.session.role !== 'platform_admin') return;
        this.session.role = 'user';
        this.applyChrome();
    },

    currentTenant() {
        if (!this.session) return null;
        return this.session.tenants.find((t2) => String(t2.id) === String(this.session.tenantId)) || null;
    },

    /** Nav gating, tenant switcher, setup mode — everything session-dependent. */
    applyChrome() {
        const admin = this.isAdmin();
        document.querySelectorAll('[data-admin-only]').forEach((el) => {
            el.classList.toggle('hidden', !admin);
        });

        // Items only the workspace owner can use (Ads): the link is not there rather than there and refused.
        const owner = this.canAdminister();
        document.querySelectorAll('[data-owner-only]').forEach((el) => {
            el.classList.toggle('hidden', !owner);
        });

        // Affordances that need a real user account rather than the shared
        // dashboard password — currently just "change my password".
        const identified = this.canChangeOwnPassword();
        document.querySelectorAll('[data-user-only]').forEach((el) => {
            el.classList.toggle('hidden', !identified);
        });

        const app = document.getElementById('app');
        if (app) app.classList.toggle('setup-mode', this.needsSetup());

        this.renderTenantSwitcher();
        this.renderRoleBadge();
        this.renderIdentity();

        // Administration: its open/closed state follows the page on screen (or the one the address names, on the first paint), and the
        // dot that says the platform has a problem is polled for as long as this session is an admin's.
        this.syncAdminGroup(this.currentPage || this.pageFromHash());
        if (admin) this.startAdminStatusPoll();
        else this.stopAdminStatusPoll();

        // #app has just come out of `hidden`, so this is the first point at
        // which the nav has a measurable box. Placed, not animated.
        this.revealActiveNavItem();
        this.moveNavIndicator(false);
    },

    // ─── Who is signed in (SH-27) ────────────────────────────────────────────

    /**
     * The identity line in the sidebar's account area, as `{ kind, text }`, or null when the shell cannot say (an older deployment whose
     * /auth/me did not answer: nothing is better than a guess). The shared dashboard password has no user: "Shared dashboard login". An
     * account is its email when the session has one; `/auth/me` carries none today, so it is the address typed at this browser's last
     * account sign-in (`rememberedEmail`, kept by both the login form and the invite), and without that, only the fact.
     */
    identityLabel() {
        const s = this.session;
        if (!s || !s.available) return null;
        const email = typeof s.email === 'string' ? s.email.trim() : '';
        if (email) return { kind: 'email', text: email };
        if (s.userId) {
            const remembered = this.rememberedEmail();
            return remembered ? { kind: 'email', text: remembered } : { kind: 'account', text: t('nav.account.signedIn') };
        }
        return { kind: 'shared', text: t('nav.account.shared') };
    },

    renderIdentity() {
        const line = document.getElementById('nav-identity');
        const text = document.getElementById('nav-identity-text');
        if (!line || !text) return;
        const who = this.identityLabel();
        line.hidden = !who;
        if (!who) {
            text.textContent = '';
            line.removeAttribute('title');
            return;
        }
        // An address is Latin text inside an Arabic sentence: its own left-to-right run (`dir`), so it never reorders against its neighbour
        // and, cut at the end of the line, it is cut at the end of the address. The words are read in the interface's direction. The
        // label before it ("Signed in as") is for a screen reader only, and the title carries the whole line when it is truncated.
        text.setAttribute('dir', who.kind === 'email' ? 'ltr' : 'auto');
        text.textContent = who.text;
        line.setAttribute('title', who.text);
    },

    // ─── Administration: one collapsible group (SH-04) ───────────────────────

    ADMIN_GROUP_KEY: 'dashboard_admin_group',

    /** The viewer's remembered choice: open only if they opened it. A browser that will not store it opens the group closed. */
    readAdminGroupPref() {
        try { return localStorage.getItem(this.ADMIN_GROUP_KEY) === 'open'; } catch { return false; }
    },

    writeAdminGroupPref(open) {
        try { localStorage.setItem(this.ADMIN_GROUP_KEY, open ? 'open' : 'closed'); } catch { /* private mode: it opens closed next time */ }
    },

    /** Is `page` an administration screen: one only a platform admin reaches, and a screen rather than a dialog module? */
    isAdminPage(page) {
        const entry = this.entryOf(page);
        return !!(entry && entry.adminOnly === true && entry.routable !== false);
    },

    /** Draw the group open or closed: the button says so (`aria-expanded`), the list is not rendered, so its links are not focusable either. */
    setAdminGroup(open) {
        const toggle = document.getElementById('nav-admin-toggle');
        const list = document.getElementById('nav-admin-list');
        const group = document.getElementById('nav-admin');
        if (!toggle || !list) return;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        list.hidden = !open;
        if (group) group.classList.toggle('is-open', !!open);
    },

    /**
     * The group for the page on screen: open while an admin page is (the item that reads as current is in it, and a hidden current item
     * is a marker pointing at nothing), otherwise as the viewer left it.
     */
    syncAdminGroup(page) {
        this.setAdminGroup(this.isAdminPage(page) || this.readAdminGroupPref());
    },

    /** The heading button: flip the group, remember the choice, and re-measure (the marker may be in the group that just closed). */
    toggleAdminGroup() {
        const toggle = document.getElementById('nav-admin-toggle');
        const open = !(toggle && toggle.getAttribute('aria-expanded') === 'true');
        this.setAdminGroup(open);
        this.writeAdminGroupPref(open);
        this.moveNavIndicator(false);
    },

    // ─── Administration: the status dot ──────────────────────────────────────

    /** How often the shell asks whether the platform has a problem, while the tab is visible. */
    ADMIN_STATUS_MS: 120000,
    _adminStatusTimer: null,

    /** `counts.platform` of a `GET /api/attention` answer, as a whole number: 0 when absent, which is every non-admin session. */
    platformProblemCount(summary) {
        const n = summary && summary.counts ? Math.floor(Number(summary.counts.platform)) : NaN;
        return Number.isFinite(n) && n > 0 ? n : 0;
    },

    /** The dot beside "Administration": there at one problem or more, gone at zero. It states a count of failures, so it is the danger tone. */
    renderAdminStatus(count) {
        const dot = document.getElementById('nav-admin-dot');
        if (!dot) return;
        dot.hidden = !(Number(count) > 0);
    },

    /**
     * Ask the server. Only an admin's session is asked (`counts.platform` is sent to nobody else). A failed read leaves the dot as it was:
     * the Operations screen is the place that says why, and a 401 has already sent the person to the login.
     */
    async refreshAdminStatus() {
        if (!this.isAdmin()) {
            this.renderAdminStatus(0);
            return;
        }
        try {
            const summary = await API.request('/attention');
            if (!this.isAdmin()) return;
            this.renderAdminStatus(this.platformProblemCount(summary));
        } catch { /* keep what the dot said */ }
    },

    /** Start asking, once: now, then every ADMIN_STATUS_MS while the tab is visible. A second call while it runs changes nothing. */
    startAdminStatusPoll() {
        if (this._adminStatusTimer) return;
        this.refreshAdminStatus();
        this._adminStatusTimer = setInterval(() => {
            if (document.visibilityState === 'visible') this.refreshAdminStatus();
        }, this.ADMIN_STATUS_MS);
    },

    /** Stop asking and clear the dot: a signed-out tab, the wizard and a session that is not an admin's have none to show. */
    stopAdminStatusPoll() {
        if (this._adminStatusTimer) {
            clearInterval(this._adminStatusTimer);
            this._adminStatusTimer = null;
        }
        this.renderAdminStatus(0);
    },

    /**
     * Hidden entirely below two tenants — a dropdown with one option is noise,
     * and for the single-tenant operator this whole feature should be invisible.
     */
    renderTenantSwitcher() {
        const wrap = document.getElementById('tenant-switcher');
        if (!wrap) return;

        const tenants = (this.session && this.session.tenants) || [];
        if (!this.session || !this.session.available || tenants.length < 2 || this.needsSetup()) {
            wrap.classList.add('hidden');
            wrap.innerHTML = '';
            return;
        }

        const currentId = this.session.tenantId;
        // A tenant switched off (or a membership revoked) mid-session leaves the
        // session naming a tenant the list no longer contains. Without a matching
        // option the browser selects the FIRST one, so the switcher would quietly
        // claim you are acting as a tenant you are not — and clicking it would be
        // a no-op, because switchTenant() returns early on an unchanged id.
        const orphaned = !tenants.some((tenant) => String(tenant.id) === String(currentId));

        wrap.innerHTML = esc(html`
            <i data-lucide="building-2" aria-hidden="true"></i>
            <label class="sr-only" for="tenant-select">${t('app.tenant')}</label>
            <select id="tenant-select" data-change="app:switchTenantFromSelect">
                ${orphaned ? html`
                    <option value="${currentId}" selected disabled>${t('tenants.unavailable')}</option>
                ` : ''}
                ${tenants.map((tenant) => html`
                    <option value="${tenant.id}" ${String(tenant.id) === String(currentId) ? html.raw('selected') : ''}>${tenant.name || tenant.id}</option>
                `)}
            </select>
        `);
        wrap.classList.remove('hidden');
        UI.icons(wrap);
    },

    /**
     * The role this session holds inside the current tenant.
     *
     * `owner` when the server did not say. Deliberately optimistic: the UI hides
     * affordances, the API refuses, and a dashboard that guessed "restricted"
     * would take buttons away from people who still have them — which is the
     * lockout this whole change is written to avoid, just wearing a different hat.
     */
    tenantRole() {
        const role = this.session && this.session.tenantRole;
        return role === 'operator' || role === 'viewer' ? role : 'owner';
    },

    /** May this session run the account — campaigns, posts, inbox, AI agent? */
    canOperate() {
        return this.tenantRole() !== 'viewer';
    },

    /** May this session change the Meta connection — the tokens? */
    canAdminister() {
        return this.tenantRole() === 'owner';
    },

    /**
     * Show the role, but only when it constrains you.
     *
     * An always-present "Owner" badge is exactly the decorative status indicator
     * DESIGN.md §6 rules out — it is true on every screen and therefore says
     * nothing. A badge that appears only for an operator or a viewer is the
     * opposite: it is the answer to "why did that button just refuse me", sitting
     * next to the buttons in question.
     */
    renderRoleBadge() {
        const wrap = document.getElementById('tenant-role');
        if (!wrap) return;

        const role = this.tenantRole();
        if (!this.session || !this.session.available || role === 'owner' || this.needsSetup()) {
            wrap.classList.add('hidden');
            wrap.innerHTML = '';
            return;
        }

        const icon = role === 'viewer' ? 'eye' : 'sliders-horizontal';
        wrap.innerHTML = esc(html`
            <span class="tenant-role-chip tenant-role-${html.raw(role)}"
                  title="${t(`roles.${role}.what`)}">
                <i data-lucide="${icon}" aria-hidden="true"></i>
                <span class="sr-only">${t('roles.yours')}: </span>${t(`roles.${role}`)}
            </span>
        `);
        wrap.classList.remove('hidden');
        UI.icons(wrap);
    },

    /**
     * Switch tenant: new token, then wipe every cached tenant-scoped thing
     * before a single byte of the new tenant is rendered.
     */
    async switchTenant(tenantId) {
        if (!tenantId || !this.session) return;
        if (String(tenantId) === String(this.session.tenantId)) return;

        const previousId = this.session.tenantId;
        const select = document.getElementById('tenant-select');
        if (select) select.disabled = true;

        try {
            const result = await API.switchTenant(tenantId);
            if (!result || !result.token) throw new Error(t('tenants.switchNoToken'));

            // Stop the outgoing page's timers BEFORE the token changes, so no
            // in-flight poll can write tenant A's data into tenant B's screen.
            this.teardownCurrentPage();
            API.setToken(result.token);
            this.resetTenantState();

            const ok = await this.refreshSession();
            if (!ok) return;

            const tenant = this.currentTenant();
            UI.toast(t('tenants.switched', { name: (tenant && tenant.name) || '—' }));

            // Switched from the wizard's own screen: the gate decides again for the tenant now acted as, the wizard for another
            // one that has not finished and the dashboard for one that has. (`show()` below only fills the dashboard's container.)
            if (this.isWelcomeScreenOpen()) {
                this.currentPage = null;
                history.replaceState(null, '', `#/${this.DEFAULT_PAGE}`);
                await this.showApp();
                return;
            }

            const page = this.pages[this.currentPage] ? this.currentPage : this.pageFromHash();
            this.currentPage = null; // teardown already ran; don't run it twice
            this.show(page);
        } catch (err) {
            if (select) {
                select.disabled = false;
                select.value = previousId == null ? '' : String(previousId);
            }
            UI.toast((err && err.message) || t('tenants.switchFailed'), 'error');
        }
    },

    /**
     * Drop every cached per-tenant thing a page holds across navigation.
     * Pages opt in with `resetTenantState()`; `destroy()` (timers, charts) is
     * handled separately by teardownCurrentPage.
     */
    resetTenantState() {
        // The waiting count is the previous tenant's; the next inbox or Overview read restates it.
        this.setInboxWaiting(0);
        Object.keys(this.pages).forEach((key) => {
            let instance;
            try {
                instance = this.pages[key].page();
            } catch {
                return; // module not loaded — nothing cached either
            }
            if (instance && typeof instance.resetTenantState === 'function') {
                try {
                    instance.resetTenantState();
                } catch (err) {
                    console.warn(`State reset failed for "${key}":`, err);
                }
            }
        });
    },

    /**
     * First run: /auth/me returned zero tenants. Every page would answer
     * "No active creator found" and Settings would show a red token badge, so
     * send the operator to the one form that fixes it instead.
     */
    renderSetup() {
        const container = document.getElementById('page-container');
        document.getElementById('page-title').textContent = t('setup.title');
        document.getElementById('page-subtitle').textContent = t('setup.subtitle');

        const admin = this.isAdmin();
        const webhookUrl = `${location.origin}/webhook`;

        // The only button on this screen belongs to the tenants module, which
        // is no longer loaded eagerly. Warm it now so the click finds a handler.
        if (admin) this.prefetchPageModule('tenants');

        container.innerHTML = esc(html`
            <div class="setup-screen surface">
                <div class="setup-icon"><i data-lucide="plug-zap" aria-hidden="true"></i></div>
                <h2>${t('setup.heading')}</h2>
                <p>${t('setup.body')}</p>
                ${admin ? html`
                    <div class="setup-stage">
                        <h3 class="setup-stage-title">
                            <i data-lucide="external-link" aria-hidden="true"></i>
                            ${t('setup.metaTitle')}
                        </h3>
                        <p class="setup-stage-note">${t('setup.metaWhy')}</p>
                        <ol class="setup-steps">
                            <li>
                                <strong>${t('setup.metaStep1')}</strong>
                                <span class="setup-detail">${t('setup.metaStep1Detail')}</span>
                            </li>
                            <li>
                                <strong>${t('setup.metaStep2')}</strong>
                                <span class="setup-detail">${t('setup.metaStep2Detail')}</span>
                                <span class="setup-value">
                                    <code dir="ltr">${UI.ltr(webhookUrl)}</code>
                                    ${UI.button({
                                        variant: 'ghost', size: 'sm', icon: 'copy',
                                        ariaLabel: t('setup.copyUrl'), title: t('setup.copyUrl'),
                                        action: 'app:copyValue', data: { copy: webhookUrl },
                                    })}
                                </span>
                            </li>
                            <li>
                                <strong>${t('setup.metaStep3')}</strong>
                                <span class="setup-detail">${t('setup.metaStep3Detail')}</span>
                            </li>
                        </ol>
                    </div>

                    <div class="setup-stage">
                        <h3 class="setup-stage-title">
                            <i data-lucide="app-window" aria-hidden="true"></i>
                            ${t('setup.hereTitle')}
                        </h3>
                        <ol class="setup-steps">
                            <li>
                                <strong>${t('setup.hereStep1')}</strong>
                                <span class="setup-detail">${t('setup.hereStep1Detail')}</span>
                            </li>
                            <li>
                                <strong>${t('setup.hereStep2')}</strong>
                                <span class="setup-detail">${t('setup.hereStep2Detail')}</span>
                            </li>
                        </ol>
                    </div>

                    ${UI.button({
                        variant: 'primary', icon: 'plus', label: t('setup.cta'),
                        action: 'tenants:showFirstRunCreateModal',
                    })}
                ` : html`
                    <p class="setup-note">${t('setup.noAccess')}</p>
                `}
            </div>
        `);
        UI.icons(container);
    },

    /**
     * Copy a value a person has to paste somewhere else entirely.
     *
     * Only used where the destination is outside this product — Meta's webhook
     * configuration — which is exactly where retyping is both most likely and
     * most expensive: one wrong character in a callback URL or a verify token
     * fails with `Callback verification failed: HTTP 403` and names nothing.
     */
    async copyValue(btn) {
        const value = btn && btn.dataset ? btn.dataset.copy : '';
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            UI.toast(t('setup.copied'));
        } catch {
            // Clipboard access is refused outside a secure context and in some
            // embedded browsers. Say so rather than appearing to have worked.
            UI.toast(t('setup.copyFailed'), 'error');
        }
    },

    /** Give the outgoing page a chance to stop timers and listeners. */
    teardownCurrentPage() {
        if (!this.currentPage) return;
        const entry = this.pages[this.currentPage];
        if (!entry) return;
        try {
            const instance = entry.page();
            if (instance && typeof instance.destroy === 'function') instance.destroy();
        } catch (err) {
            console.warn('Page teardown failed:', err);
        }
    },

    // ─── Navigation ──────────────────────────────────────────────────────────

    /**
     * Which nav item is current, plus its accessible state.
     *
     * A page with `navAs` has no nav item of its own (the tenant detail view
     * is reached from a row, not from the sidebar) and borrows the item it
     * belongs under, so the marker stays put instead of vanishing.
     */
    markNavItem(page) {
        const entry = this.pages[page];
        const target = (entry && entry.navAs) || page;
        document.querySelectorAll('.nav-item[data-page]').forEach((item) => {
            const active = item.dataset.page === target;
            item.classList.toggle('active', active);
            if (active) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });
    },

    /**
     * Scroll the sidebar's list just far enough to show the current item. A window too short for the whole sidebar scrolls the list, and
     * an admin page opens the Administration group below the fold: the item that says where you are must never be out of sight. Nothing
     * moves when it is already visible, and the marker is measured after this (its position is in the list's own coordinates, so it does
     * not depend on how far the list is scrolled).
     */
    revealActiveNavItem() {
        const nav = document.getElementById('sidebar-nav');
        const item = nav && nav.querySelector('.nav-item.active');
        if (!nav || !item || item.classList.contains('hidden') || !item.offsetParent) return;
        const navRect = nav.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        if (itemRect.top < navRect.top) nav.scrollTop -= navRect.top - itemRect.top;
        else if (itemRect.bottom > navRect.bottom) nav.scrollTop += itemRect.bottom - navRect.bottom;
    },

    /**
     * Put the active marker over the active item.
     *
     * `translateY` and `height` only — no horizontal component, so the same
     * code is correct in an RTL and an LTR document; the marker's inline edges
     * come from logical properties in CSS. `animate: false` is used for the
     * first placement and for re-measurements (resize, font load), where a
     * slide from the previous position would be motion with no meaning.
     */
    moveNavIndicator(animate) {
        // Two scopes, two markers: the scrolling list (job groups and Administration) and the foot (Settings and Help). A marker is
        // positioned inside the box that scrolls with its items, so one cannot reach across to the other.
        this.placeIndicator(document.getElementById('sidebar-nav'), document.getElementById('nav-indicator'), animate);
        this.placeIndicator(document.getElementById('sidebar-foot-nav'), document.getElementById('nav-indicator-foot'), animate);
    },

    /**
     * Put `indicator` over the active item inside `host`, or hide it when `host` has none that can be seen: the item is in another
     * scope, in a group that is closed, or its group is not shown to this session.
     */
    placeIndicator(host, indicator, animate) {
        if (!host || !indicator) return;

        const item = host.querySelector('.nav-item.active');
        if (!item || item.classList.contains('hidden') || !item.offsetParent) {
            // Gone at once, and parked at the top of its scope: a marker that is not shown must not keep stretching the list's
            // scrollable height with the position it last had (a transformed box still counts as overflow).
            indicator.classList.add('no-transition');
            indicator.classList.remove('is-visible');
            indicator.style.transform = 'translateY(0)';
            void indicator.offsetHeight;
            indicator.classList.remove('no-transition');
            return;
        }

        const hostRect = host.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        const y = Math.round(itemRect.top - hostRect.top + host.scrollTop);

        // A marker that was not showing has nowhere to slide from: it appears where it belongs, as it does on a re-measurement.
        const instant = !animate || !indicator.classList.contains('is-visible');
        if (instant) indicator.classList.add('no-transition');
        indicator.style.transform = `translateY(${y}px)`;
        indicator.style.blockSize = `${Math.round(itemRect.height)}px`;
        indicator.classList.add('is-visible');
        if (instant) {
            // Force the value to be adopted before transitions come back, or
            // the next move would animate from the old position.
            void indicator.offsetHeight;
            indicator.classList.remove('no-transition');
        }
    },

    /**
     * `navigate()` is async now (it may have to fetch the page module), so
     * every fire-and-forget caller goes through here rather than dropping an
     * unhandled rejection on the floor.
     */
    show(page) {
        return Promise.resolve(this.navigate(page)).catch((err) => {
            console.error('Navigation failed:', err);
        });
    },

    /** The page module on screen, or null. */
    currentInstance() {
        const entry = this.currentPage ? this.entryOf(this.currentPage) : null;
        if (!entry || typeof entry.page !== 'function') return null;
        try { return entry.page() || null; } catch { return null; }
    },

    // ─── Leaving with unsaved work ───────────────────────────────────────────

    /**
     * Would leaving lose something? 'modal' when an open dialog holds edits (`UI.isModalDirty()`), 'page' when the page on screen says
     * so (`canLeave() === false`), '' when nothing would be lost. A `canLeave()` that throws counts as clean: a broken guard must never
     * be the reason somebody cannot leave a screen.
     */
    unsavedKind() {
        if (typeof UI !== 'undefined' && typeof UI.isModalDirty === 'function' && UI.isModalDirty()) return 'modal';
        const instance = this.currentInstance();
        if (instance && typeof instance.canLeave === 'function') {
            try {
                if (instance.canLeave() === false) return 'page';
            } catch (err) {
                console.warn('canLeave() failed; treating the page as having nothing unsaved:', err);
            }
        }
        return '';
    },

    /**
     * "Discard changes?" Resolves true to leave and false to stay. Cancel, Escape and a click outside the dialog all mean stay.
     *
     * `UI.confirm` when there is one, else the administration confirm, which both draw a dialog. An open dialog that is itself dirty
     * ('modal') cannot be answered that way while only `Admin.confirm` exists: it draws INTO the one modal, which would destroy the
     * very fields being asked about. That case uses the browser's own confirm, the same single one `UI.requestCloseModal` uses.
     * With nothing to ask with, the answer is stay: no edit is lost for want of a dialog.
     */
    confirmLeave(kind) {
        return new Promise((resolve) => {
            let answered = false;
            const answer = (value) => {
                if (answered) return;
                answered = true;
                resolve(value);
            };
            const ask = typeof UI !== 'undefined' && typeof UI.confirm === 'function' ? UI.confirm.bind(UI)
                : (kind === 'page' && typeof Admin !== 'undefined' && typeof Admin.confirm === 'function' ? Admin.confirm.bind(Admin) : null);
            if (!ask) {
                answer(typeof confirm === 'function' ? !!confirm(t('common.leaveBody')) : false);
                return;
            }
            const question = {
                title: t('common.leaveTitle'),
                body: t('common.leaveBody'),
                confirmLabel: t('common.leaveConfirm'),
                onConfirm: () => answer(true),
            };
            // Unsaved work inside an open dialog: ask OVER it (`stack`), never in place of it, or Cancel would come back to a
            // dialog whose fields the question itself destroyed. The stacked layer reports "no" through `onCancel`.
            if (kind === 'modal' && typeof UI !== 'undefined' && typeof UI.confirm === 'function') {
                UI.confirm({ ...question, stack: true, onCancel: () => answer(false) });
                return;
            }
            ask(question);
            // The dialog closing without a confirm is a "stay". `showModal` runs the previous dialog's close hook before it draws
            // this one, so this one is set afterwards.
            UI._afterClose = () => answer(false);
        });
    },

    /** The person agreed to lose what the page holds: tell it, so a copy it kept (a parked draft, a local backup) goes too. */
    discardCurrent() {
        const instance = this.currentInstance();
        if (!instance || typeof instance.discardChanges !== 'function') return;
        try { instance.discardChanges(); } catch (err) { console.warn('discardChanges() failed:', err); }
    },

    /** They chose to stay: the address goes back to what is on screen, in place (no history entry, no `hashchange`). */
    restoreAddress() {
        const back = this._hashBefore || this._shownHash || (this.currentPage ? `#/${this.currentPage}` : '');
        this._hashBefore = null;
        if (!back || String(location.hash || '') === back) return;
        try { history.replaceState(null, '', back); } catch { /* the address stays; the page on screen is still the right one */ }
    },

    /** The key the person last used, for the focus decision in `navigate()`: 'keyboard' or 'pointer'. */
    _modality: 'pointer',

    /** Is focus on nothing a person can see? After a drawer closes or a page's controls are replaced it is on `<body>`. */
    focusIsLost() {
        const active = document.activeElement;
        if (!active || active === document.body || active === document.documentElement) return true;
        return typeof document.contains === 'function' && !document.contains(active);
    },

    /** Focus the page title, which is `tabindex="-1"` for exactly this. No scroll: the page has just been put at its top. */
    focusPageTitle() {
        const heading = document.getElementById('page-title');
        if (!heading || typeof heading.focus !== 'function') return;
        if (typeof heading.setAttribute === 'function') heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
    },

    async navigate(page) {
        if (!this.entryOf(page)) return;
        // An alias is its target's page. (`go` and `route` already write the target's own address; this is for a caller that names the alias.)
        page = this.resolveAlias(page).page;

        // The one place every route passes through: a tenant that has not finished setting up goes to the wizard instead.
        if (this.mustOnboard()) {
            await this.showWelcome();
            return;
        }

        // A platform-admin page reached by typing the hash, by an account that
        // is not one: send them home rather than to a guaranteed 403.
        if (this.pages[page].adminOnly && !this.isAdmin()) {
            page = this.DEFAULT_PAGE;
            if (location.hash !== `#/${page}`) history.replaceState(null, '', `#/${page}`);
        }

        const seq = ++this._navSeq;

        // No tenant exists yet: every page would dead-end on "No active creator
        // found", so show the one screen that can fix that instead.
        if (this.needsSetup()) {
            this.teardownCurrentPage();
            this.currentPage = null;
            this.markNavItem(page);
            this.syncAdminGroup(page);
            this.revealActiveNavItem();
            this.moveNavIndicator(true);
            if (typeof HealthStrip !== 'undefined') HealthStrip.hide();
            this.renderSetup();
            return;
        }

        // The page being left, and whether this is a different page: only a change of page scrolls, announces, moves focus and asks.
        // A re-render of the same page (a theme change, Retry) is none of those.
        const previous = this.currentPage;
        const changed = previous !== page;

        // The module loads while the person is being asked, so Cancel costs nothing and "leave" does not then wait for the network.
        const loading = this.loadPageModule(page);

        if (previous && changed) {
            const kind = this.unsavedKind();
            if (kind) {
                const leave = await this.confirmLeave(kind);
                if (seq !== this._navSeq) return; // something newer took over while the dialog was open
                if (!leave) {
                    this.restoreAddress();
                    return;
                }
                this.discardCurrent();
            }
        }

        const instance = await loading;
        if (seq !== this._navSeq) return; // a later navigation already won

        const container = document.getElementById('page-container');

        if (!instance) {
            UI.renderError(container, {
                icon: 'wifi-off',
                title: t('error.render'),
                message: t('error.moduleFailed'),
            }, () => this.show(page));
            return;
        }

        this.teardownCurrentPage();
        this.currentPage = page;
        // What is on screen now has this address. `_hashBefore` was for the guard above and is not an answer to the next change.
        this._shownHash = String(location.hash || '');
        this._hashBefore = null;
        const drawer = document.getElementById('sidebar');
        const drawerWasOpen = !!(drawer && drawer.classList.contains('open'));

        // One motion: the chrome moves, the outgoing page cross-fades into the
        // incoming page's shape, and the browser morphs the nav marker between
        // its old and new geometry. Everything in here is synchronous — a view
        // transition holds the frame while the callback runs.
        await Motion.transition(() => {
            this.markNavItem(page);
            // The admin group opens for an admin page BEFORE the marker is measured: it is placed over an item that has a box. And the
            // list is scrolled to show that item first, so a window too short for the whole sidebar never hides where you are.
            this.syncAdminGroup(page);
            this.revealActiveNavItem();
            this.moveNavIndicator(true);

            document.getElementById('page-title').textContent = this.title(page);
            document.getElementById('page-subtitle').textContent = this.subtitle(page);
            // The tab, the browser's history, a bookmark and a tab strip all read this: it names the page, then the app (SH-05).
            this.setBaseTitle(`${this.title(page)} · ${t('app.name')}`);
            // A new page opens at its top, not at the offset the last one was left at (SH-07). The window is the scroller.
            if (changed && typeof window.scrollTo === 'function') window.scrollTo({ top: 0 });

            // A nav-item click already reaches here through the router: same
            // dismissal the backdrop and Escape use, but the operator's focus
            // is headed to the page they picked, not back to the hamburger.
            this.closeMobileDrawer(false);

            // Inside the transition, so a modal left open does not survive a
            // frame of the new page. closeModal() restores focus to whatever
            // opened it and guards against that element having been replaced.
            UI.closeModal();

            if (container && typeof instance.skeleton === 'function') {
                container.innerHTML = esc(instance.skeleton());
                Motion.markSkeleton(container);
                UI.icons(container);
            }
        });

        if (seq !== this._navSeq) return;

        if (changed) {
            // The change is told to a screen reader (SH-05). Focus moves only after a keyboard navigation, from the drawer, or when it
            // has nowhere to be; and not on the first page of a session, where it would skip the skip link and the nav.
            Motion.announce(this.title(page));
            if (previous && (drawerWasOpen || this._modality === 'keyboard' || this.focusIsLost())) this.focusPageTitle();
        }

        const fail = (err) => {
            console.error('Page render failed:', err);
            UI.renderError(
                container,
                { title: t('error.render'), message: (err && err.message) || String(err) },
                () => this.show(page)
            );
        };

        // The health strip lives ABOVE the page container, so it is mounted by
        // the router rather than by the page module underneath it. That is what
        // lets webhook freshness and token health appear on a screen whose own
        // module knows nothing about them, and it keeps the two independent:
        // the strip's own failure cannot take the page down with it.
        if (typeof HealthStrip !== 'undefined') {
            Promise.resolve(HealthStrip.mountFor(page)).catch((err) => {
                console.warn('Health strip failed:', err);
            });
        }

        try {
            // Most pages' render() is async; a throw after its first await
            // rejects rather than raising, so both paths land on `fail`.
            const result = instance.render();
            if (result && typeof result.catch === 'function') result.catch(fail);
        } catch (err) {
            fail(err);
        }
    },

    // ─── Your own password ───────────────────────────────────────────────────
    /**
     * `POST /api/auth/password` needs a user identity. The shared dashboard
     * password has none — no row, no `userId` in the session token — so the
     * affordance is hidden for that path rather than offered and then refused.
     */
    canChangeOwnPassword() {
        return !!(this.session && this.session.available && this.session.userId);
    },

    /**
     * The control lives in the sidebar footer, next to Log out, because it has
     * to be reachable by an ORDINARY user: `users.passwordHint` has always told
     * admins "they can change it later", and the Users page is admin-only.
     */
    showPasswordModal() {
        if (!this.canChangeOwnPassword()) {
            UI.toast(t('password.unavailable'), 'error');
            return;
        }
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">${t('password.title')}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <form id="own-password-form" data-submit="app:handlePasswordChange">
                <p class="modal-body-text">${t('password.body')}</p>
                <div class="form-group">
                    <label class="form-label" for="own-current-password">${t('password.current')}</label>
                    <input class="field" id="own-current-password" name="currentPassword" type="password"
                           dir="ltr" autocomplete="current-password" required>
                </div>
                <div class="form-group">
                    <label class="form-label" for="own-new-password">${t('password.new')}</label>
                    <input class="field" id="own-new-password" name="newPassword" type="password"
                           dir="ltr" autocomplete="new-password" minlength="12" required
                           aria-describedby="own-new-password-hint">
                    <p class="form-hint" id="own-new-password-hint">${t('password.newHint')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="own-repeat-password">${t('password.repeat')}</label>
                    <input class="field" id="own-repeat-password" name="repeatPassword" type="password"
                           dir="ltr" autocomplete="new-password" minlength="12" required>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary">
                        <i data-lucide="key-round" aria-hidden="true"></i> ${t('password.submit')}
                    </button>
                </div>
            </form>
        `);
    },

    /**
     * Changing your password kills every other session. This one survives only
     * because the server hands back a fresh token and we store it — dropping
     * it would log the operator out of the tab they are standing in.
     */
    async handlePasswordChange(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const current = (data.get('currentPassword') || '').toString();
        const next = (data.get('newPassword') || '').toString();
        const repeat = (data.get('repeatPassword') || '').toString();

        if (next.length < 12) {
            UI.toast(t('password.tooShort'), 'error');
            return;
        }
        if (next !== repeat) {
            UI.toast(t('password.mismatch'), 'error');
            return;
        }
        if (next === current) {
            UI.toast(t('password.unchanged'), 'error');
            return;
        }

        const submit = form.querySelector('button[type="submit"]');
        const original = submit ? submit.innerHTML : '';
        if (submit) {
            submit.disabled = true;
            submit.innerHTML = UI.buttonSpinner(t('password.saving'));
        }

        try {
            const result = await API.changeOwnPassword(current, next);
            if (result && result.token) API.setToken(result.token);
            UI.closeModal();
            UI.toast(t('password.changed'));
        } catch (err) {
            if (submit) {
                submit.disabled = false;
                submit.innerHTML = original;
                UI.icons(submit);
            }
            // A 401 has already cleared the token and put the login screen up
            // (API.request does that for every route); a toast on top of it
            // would describe the wrong failure.
            if (err && err.status === 401) return;
            const wrong = err && (err.status === 400 || err.status === 403 || err.status === 422);
            UI.toast(wrong ? t('password.wrongCurrent') : ((err && err.message) || t('password.failed')), 'error');
        }
    },
};

UI.registerActions('app', {
    skipToContent() {
        const main = document.getElementById('page-container');
        if (main) main.focus();
    },
    /**
     * `data-target` is the page; `data-query` is an optional querystring for a
     * deep link (`focus=<id>`). It is parsed rather than concatenated, so a
     * malformed or hostile value produces no parameters instead of a crafted
     * hash.
     */
    navigate(el) {
        const query = el.dataset.query;
        if (!query) {
            App.go(el.dataset.target);
            return;
        }
        const params = {};
        new URLSearchParams(query).forEach((value, key) => { params[key] = value; });
        App.goWithQuery(el.dataset.target, params);
    },
    switchTenantFromSelect(el) {
        App.switchTenant(el.value);
    },
    copyValue(el) {
        App.copyValue(el);
    },
    showPasswordModal() {
        App.showPasswordModal();
    },
    /** The Administration heading: open or close the group (and remember it). */
    toggleAdminGroup() {
        App.toggleAdminGroup();
    },
    handlePasswordChange(el, e) {
        const result = App.handlePasswordChange(el, e);
        if (result && typeof result.catch === 'function') {
            result.catch((err) => UI.toast((err && err.message) || t('password.failed'), 'error'));
        }
    },
    /** The header affordance: two languages, so it is a toggle. */
    toggleLanguage() {
        I18N.setLang(App.otherLang());
    },
    /** The full control in Settings, where a list is the right shape. */
    setLanguage(el) {
        I18N.setLang(el.value);
    },
    setTheme(el) {
        App.setTheme(el.value);
    },
    /**
     * The email field is hidden behind an affordance so the shared-password
     * path — still the operator's only way in — stays a one-field form.
     */
    revealEmailField(el) {
        const group = document.getElementById('login-email-group');
        if (!group) return;
        group.classList.remove('hidden');
        el.classList.add('hidden');
        const input = document.getElementById('login-email');
        if (input) input.focus();
    },
    /**
     * Back to the one-field form: an address was remembered and the operator wants the shared password. An empty email
     * is what makes the login send the body it always sent.
     */
    useSharedPassword() {
        const group = document.getElementById('login-email-group');
        const toggle = document.getElementById('login-email-toggle');
        const email = document.getElementById('login-email');
        if (email) email.value = '';
        if (group) group.classList.add('hidden');
        if (toggle) toggle.classList.remove('hidden');
        const pw = document.getElementById('login-password');
        if (pw) pw.focus();
    },
});

// Boot
// The dictionary for the page's language is a separate file (i18n.ar.js / i18n.en.js) that
// the head script started fetching early; boot waits for it rather than render raw keys.
// A failure still boots (I18N.ready falls back to English), so the app never hangs here.
document.addEventListener('DOMContentLoaded', () => {
    I18N.ready().then(() => App.init(), () => App.init());
});
