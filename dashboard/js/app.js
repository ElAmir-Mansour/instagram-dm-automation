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

    pages: {
        overview: { src: 'overview', page: () => OverviewPage },
        campaigns: { src: 'campaigns', page: () => CampaignsPage },
        posts: { src: 'posts', page: () => PostsPage },
        studio: { src: 'studio', page: () => StudioPage },
        inbox: { src: 'inbox', page: () => InboxPage },
        ai_settings: { src: 'ai_settings', page: () => AiSettingsPage },
        analytics: { src: 'analytics', page: () => AnalyticsPage },
        activity: { src: 'activity', page: () => ActivityPage },
        settings: { src: 'settings', page: () => SettingsPage },
        // ─── Platform administration ─────────────────────────────────────────
        // `navAs` points a page with no nav item of its own at the item that
        // should read as current while it is open — otherwise the active
        // marker disappears the moment you open a tenant's detail view.
        operations: { src: 'operations', page: () => OperationsPage, adminOnly: true },
        tenants: { src: 'tenants', page: () => TenantsPage, adminOnly: true },
        tenant_detail: { src: 'tenant_detail', page: () => TenantDetailPage, adminOnly: true, navAs: 'tenants' },
        users: { src: 'users', page: () => UsersPage, adminOnly: true },
        jobs: { src: 'jobs', page: () => JobsPage, adminOnly: true },
        audit: { src: 'audit', page: () => AuditPage, adminOnly: true },
        erasure: { src: 'erasure', page: () => ErasurePage, adminOnly: true },
    },

    /** Must match the `?v=` the rest of the assets are served with. */
    ASSET_VERSION: '7.5',

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
        const entry = this.pages[name];
        if (!entry) return Promise.resolve(null);

        const resolve = () => {
            try { return entry.page() || null; } catch { return null; }
        };

        const already = resolve();
        if (already) return Promise.resolve(already);

        if (!this._modules[name]) {
            this._modules[name] = new Promise((done) => {
                const script = document.createElement('script');
                script.src = `/dashboard/js/pages/${entry.src}.js?v=${this.ASSET_VERSION}`;
                script.onload = () => done(resolve());
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

    /** Fire-and-forget warm-up, for hover and focus. */
    prefetchPageModule(name) {
        if (this.pages[name]) this.loadPageModule(name);
    },

    title(page) { return t(`nav.${page}`); },
    subtitle(page) { return t(`page.${page}.subtitle`); },

    init() {
        I18N.init();
        I18N.applyStatic();
        this.renderLanguageToggle();
        document.title = `${t('app.name')} — ${t('app.tagline')}`;

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
                const result = await API.login(password, email);
                API.setToken(result.token);
                errorEl.classList.add('hidden');
                await this.showApp();
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

        // Sidebar navigation — real links, so they also work with the hash router.
        // Hover and focus warm the page module so the click has nothing to wait
        // for; `pointerenter` rather than `mouseover` so it fires once per item
        // and not on touch, where there is no hover to warm from.
        document.querySelectorAll('.nav-item[data-page]').forEach((item) => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                this.go(item.dataset.page);
            });
            const warm = () => this.prefetchPageModule(item.dataset.page);
            item.addEventListener('pointerenter', warm, { once: true });
            item.addEventListener('focus', warm, { once: true });
        });

        // The indicator is positioned from measured geometry, so it has to be
        // re-measured whenever the nav's box can change.
        const reposition = Motion.coalesce(() => this.moveNavIndicator(false));
        window.addEventListener('resize', reposition);
        if (document.fonts && typeof document.fonts.ready === 'object') {
            // The webfont landing changes the nav items' height.
            document.fonts.ready.then(reposition, () => {});
        }

        // Logout — tears the current page down first, so no poller survives it
        document.getElementById('logout-btn').addEventListener('click', () => {
            this.teardownCurrentPage();
            this.currentPage = null;
            this.session = null;
            this.resetTenantState();
            API.clearToken();
            this.showLogin();
        });

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

        // Hash router — refresh lands on the same page, Back moves between pages
        window.addEventListener('hashchange', () => {
            if (!API.token) return;
            this.show(this.pageFromHash());
        });

        UI.icons();

        if (API.token) {
            this.showApp();
        } else {
            this.showLogin();
        }
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
        if (returnFocus && menuBtn) menuBtn.focus();
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
     *   - `lang` on the button so Plex Sans Arabic shapes العربية and Plex Sans sets English,
     *     instead of whichever face the surrounding UI happens to be using;
     *   - the visible label is a noun, so the accessible name is the verb:
     *     "التبديل إلى الإنجليزية" / "Switch to Arabic".
     */
    otherLang() {
        return I18N.lang === 'ar' ? 'en' : 'ar';
    },

    renderLanguageToggle() {
        const btn = document.getElementById('lang-toggle');
        if (!btn) return;
        const target = this.otherLang();
        const cfg = I18N.LANGS[target];
        btn.textContent = cfg.label;
        btn.setAttribute('lang', cfg.htmlLang);
        btn.setAttribute('dir', cfg.dir);
        btn.setAttribute('aria-label', t('app.switchTo', { name: t(`lang.name.${target}`) }));
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

    pageFromHash() {
        const raw = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
        return this.pages[raw] ? raw : this.DEFAULT_PAGE;
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

    /** Navigate by updating the hash; hashchange does the actual render. */
    go(page) {
        if (!this.pages[page]) return;
        const target = `#/${page}`;
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
        if (!this.pages[page]) return;
        const query = new URLSearchParams();
        Object.keys(params || {}).forEach((key) => {
            const value = params[key];
            if (value !== null && value !== undefined && value !== '') query.set(key, String(value));
        });
        const search = query.toString();
        const target = `#/${page}${search ? `?${search}` : ''}`;
        if (location.hash === target) {
            this.show(page);
        } else {
            location.hash = target;
        }
    },

    showLogin() {
        this.teardownCurrentPage();
        this.currentPage = null;
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('app').classList.add('hidden');
        const pw = document.getElementById('login-password');
        if (pw) pw.value = '';
        // Back to the one-field form: the email affordance is opt-in every time.
        const email = document.getElementById('login-email');
        if (email) email.value = '';
        const group = document.getElementById('login-email-group');
        if (group) group.classList.add('hidden');
        const toggle = document.getElementById('login-email-toggle');
        if (toggle) toggle.classList.remove('hidden');
    },

    async showApp() {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');

        const ok = await this.loadSession();
        if (!ok) return; // 401 — API.request already bounced us to the login screen

        this.applyChrome();

        const page = this.pageFromHash();
        // Normalise the PAGE part only. `#/tenant_detail?id=…` is a legitimate
        // deep link and rewriting it to `#/tenant_detail` would throw the id
        // away on every reload and every bookmarked link.
        const pagePart = String(location.hash || '').split('?')[0];
        if (pagePart !== `#/${page}`) {
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
                available: true,
            };
        } catch (err) {
            if (err && err.status === 401) return false;
            this.session = { userId: null, role: null, tenantId: null, tenantRole: null, tenants: [], available: false };
        }
        return true;
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

        // #app has just come out of `hidden`, so this is the first point at
        // which the nav has a measurable box. Placed, not animated.
        this.moveNavIndicator(false);
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
     * Put the active marker over the active item.
     *
     * `translateY` and `height` only — no horizontal component, so the same
     * code is correct in an RTL and an LTR document; the marker's inline edges
     * come from logical properties in CSS. `animate: false` is used for the
     * first placement and for re-measurements (resize, font load), where a
     * slide from the previous position would be motion with no meaning.
     */
    moveNavIndicator(animate) {
        const nav = document.getElementById('sidebar-nav');
        const indicator = document.getElementById('nav-indicator');
        if (!nav || !indicator) return;

        const item = nav.querySelector('.nav-item.active');
        if (!item || item.classList.contains('hidden') || !item.offsetParent) {
            indicator.classList.remove('is-visible');
            return;
        }

        const navRect = nav.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        const y = Math.round(itemRect.top - navRect.top + nav.scrollTop);

        if (!animate) indicator.classList.add('no-transition');
        indicator.style.transform = `translateY(${y}px)`;
        indicator.style.blockSize = `${Math.round(itemRect.height)}px`;
        indicator.classList.add('is-visible');
        if (!animate) {
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

    async navigate(page) {
        if (!this.pages[page]) return;

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
            this.moveNavIndicator(true);
            if (typeof HealthStrip !== 'undefined') HealthStrip.hide();
            this.renderSetup();
            return;
        }

        const instance = await this.loadPageModule(page);
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

        // One motion: the chrome moves, the outgoing page cross-fades into the
        // incoming page's shape, and the browser morphs the nav marker between
        // its old and new geometry. Everything in here is synchronous — a view
        // transition holds the frame while the callback runs.
        await Motion.transition(() => {
            this.markNavItem(page);
            this.moveNavIndicator(true);

            document.getElementById('page-title').textContent = this.title(page);
            document.getElementById('page-subtitle').textContent = this.subtitle(page);

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
});

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
