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
 */
const App = {
    currentPage: null,

    /** Populated by loadSession(). Never null once showApp() has run. */
    session: null,

    pages: {
        overview: { title: 'Overview', subtitle: 'Welcome back. Here\'s how your automation is performing.', page: () => OverviewPage },
        campaigns: { title: 'Campaigns', subtitle: 'Manage your keyword triggers and DM templates.', page: () => CampaignsPage },
        posts: { title: 'Posts Scheduler', subtitle: 'Create, schedule, and publish posts to Instagram and Facebook.', page: () => PostsPage },
        inbox: { title: 'Live DM Inbox', subtitle: 'Real-time customer conversations and AI agent controls.', page: () => InboxPage },
        ai_settings: { title: 'AI Agent Settings', subtitle: 'Configure instructions, knowledge bases, and test simulations.', page: () => AiSettingsPage },
        analytics: { title: 'Analytics', subtitle: 'Deep dive into your automation performance.', page: () => AnalyticsPage },
        activity: { title: 'Activity Log', subtitle: 'Every interaction logged in real-time.', page: () => ActivityPage },
        settings: { title: 'Settings', subtitle: 'Manage your account and access tokens.', page: () => SettingsPage },
        tenants: { title: 'Tenants', subtitle: 'Every connected account, and whether it is actually working.', page: () => TenantsPage, adminOnly: true },
        users: { title: 'Users', subtitle: 'Accounts, roles, and who can reach which tenant.', page: () => UsersPage, adminOnly: true },
    },

    DEFAULT_PAGE: 'overview',

    init() {
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

            btn.disabled = true;
            btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;"></div>';

            try {
                const result = await API.login(password, email);
                API.setToken(result.token);
                errorEl.classList.add('hidden');
                await this.showApp();
            } catch (err) {
                errorEl.textContent = err && err.status === 401
                    ? (email ? 'Invalid email or password. Try again.' : 'Invalid password. Try again.')
                    : (err && err.message) || 'Sign in failed. Try again.';
                errorEl.classList.remove('hidden');
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<span>Sign In</span><i data-lucide="arrow-right"></i>';
                UI.icons(btn);
            }
        });

        // Sidebar navigation — real links, so they also work with the hash router
        document.querySelectorAll('.nav-item[data-page]').forEach((item) => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                this.go(item.dataset.page);
            });
        });

        // Logout — tears the current page down first, so no poller survives it
        document.getElementById('logout-btn').addEventListener('click', () => {
            this.teardownCurrentPage();
            this.currentPage = null;
            this.session = null;
            this.resetTenantState();
            API.clearToken();
            this.showLogin();
        });

        // Mobile menu
        const menuBtn = document.getElementById('mobile-menu-btn');
        menuBtn.addEventListener('click', () => {
            const sidebar = document.getElementById('sidebar');
            const open = sidebar.classList.toggle('open');
            menuBtn.setAttribute('aria-expanded', String(open));
        });

        // Hash router — refresh lands on the same page, Back moves between pages
        window.addEventListener('hashchange', () => {
            if (!API.token) return;
            this.navigate(this.pageFromHash());
        });

        UI.icons();

        if (API.token) {
            this.showApp();
        } else {
            this.showLogin();
        }
    },

    pageFromHash() {
        const raw = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
        return this.pages[raw] ? raw : this.DEFAULT_PAGE;
    },

    /** Navigate by updating the hash; hashchange does the actual render. */
    go(page) {
        if (!this.pages[page]) return;
        const target = `#/${page}`;
        if (location.hash === target) {
            this.navigate(page); // same hash, force a re-render
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
        if (location.hash !== `#/${page}`) {
            // Normalise without adding a history entry AND without firing
            // hashchange (which would render the page a second time).
            history.replaceState(null, '', `#/${page}`);
        }
        this.navigate(page);
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
                tenants: (me && Array.isArray(me.tenants)) ? me.tenants : [],
                available: true,
            };
        } catch (err) {
            if (err && err.status === 401) return false;
            this.session = { userId: null, role: null, tenantId: null, tenants: [], available: false };
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
        return this.session.tenants.find((t) => String(t.id) === String(this.session.tenantId)) || null;
    },

    /** Nav gating, tenant switcher, setup mode — everything session-dependent. */
    applyChrome() {
        const admin = this.isAdmin();
        document.querySelectorAll('[data-admin-only]').forEach((el) => {
            el.classList.toggle('hidden', !admin);
        });

        const app = document.getElementById('app');
        if (app) app.classList.toggle('setup-mode', this.needsSetup());

        this.renderTenantSwitcher();
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
        wrap.innerHTML = esc(html`
            <i data-lucide="building-2" class="tenant-switcher-icon" aria-hidden="true"></i>
            <label class="sr-only" for="tenant-select">Active tenant</label>
            <select id="tenant-select" class="tenant-select" data-change="app:switchTenantFromSelect">
                ${tenants.map((t) => html`
                    <option value="${t.id}" ${String(t.id) === String(currentId) ? html.raw('selected') : ''}>${t.name || t.id}</option>
                `)}
            </select>
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
            if (!result || !result.token) throw new Error('The server did not return a session token for that tenant.');

            // Stop the outgoing page's timers BEFORE the token changes, so no
            // in-flight poll can write tenant A's data into tenant B's screen.
            this.teardownCurrentPage();
            API.setToken(result.token);
            this.resetTenantState();

            const ok = await this.refreshSession();
            if (!ok) return;

            const tenant = this.currentTenant();
            UI.toast(`Now viewing ${tenant && tenant.name ? tenant.name : 'the selected tenant'}.`);

            const page = this.pages[this.currentPage] ? this.currentPage : this.pageFromHash();
            this.currentPage = null; // teardown already ran; don't run it twice
            this.navigate(page);
        } catch (err) {
            if (select) {
                select.disabled = false;
                select.value = previousId == null ? '' : String(previousId);
            }
            UI.toast((err && err.message) || 'Could not switch tenant.', 'error');
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
        document.getElementById('page-title').textContent = 'Set up your first tenant';
        document.getElementById('page-subtitle').textContent = 'Nothing is connected yet — this takes one form.';

        const admin = this.isAdmin();
        container.innerHTML = esc(html`
            <div class="setup-screen glass-card">
                <div class="setup-icon"><i data-lucide="plug-zap" aria-hidden="true"></i></div>
                <h2>No tenant is connected yet</h2>
                <p>
                    A tenant is one Instagram/Facebook account pair: its page IDs and its page access
                    token. Until one exists, campaigns, the scheduler and the inbox have nothing to
                    read and every action answers <em>“No active creator found”</em>.
                </p>
                ${admin ? html`
                    <ol class="setup-steps">
                        <li>Create the tenant with its Instagram and Facebook page IDs.</li>
                        <li>Paste the page access token (Settings can do it later too).</li>
                        <li>Point the Meta webhook callback at <code>${location.origin}/webhook</code> and set the verify token in Settings.</li>
                    </ol>
                    <button type="button" class="btn btn-primary" data-action="tenants:showFirstRunCreateModal">
                        <i data-lucide="plus" aria-hidden="true"></i> Create the first tenant
                    </button>
                ` : html`
                    <p class="setup-note">
                        Your account has not been granted access to any tenant. Ask a platform
                        administrator to grant you one, then sign in again.
                    </p>
                `}
            </div>
        `);
        UI.icons(container);
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

    navigate(page) {
        if (!this.pages[page]) return;

        // A platform-admin page reached by typing the hash, by an account that
        // is not one: send them home rather than to a guaranteed 403.
        if (this.pages[page].adminOnly && !this.isAdmin()) {
            page = this.DEFAULT_PAGE;
            if (location.hash !== `#/${page}`) history.replaceState(null, '', `#/${page}`);
        }

        this.teardownCurrentPage();
        this.currentPage = page;

        document.querySelectorAll('.nav-item[data-page]').forEach((item) => {
            const active = item.dataset.page === page;
            item.classList.toggle('active', active);
            if (active) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });

        document.getElementById('page-title').textContent = this.pages[page].title;
        document.getElementById('page-subtitle').textContent = this.pages[page].subtitle;

        const sidebar = document.getElementById('sidebar');
        sidebar.classList.remove('open');
        const menuBtn = document.getElementById('mobile-menu-btn');
        if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');

        UI.closeModal();

        // No tenant exists yet: every page would dead-end on "No active creator
        // found", so show the one screen that can fix that instead.
        if (this.needsSetup()) {
            this.currentPage = null;
            this.renderSetup();
            return;
        }

        try {
            this.pages[page].page().render();
        } catch (err) {
            console.error('Page render failed:', err);
            UI.renderError(
                document.getElementById('page-container'),
                { title: 'This page failed to render', message: (err && err.message) || String(err) },
                () => this.navigate(page)
            );
        }
    },
};

UI.registerActions('app', {
    skipToContent() {
        const main = document.getElementById('page-container');
        if (main) main.focus();
    },
    navigate(el) {
        App.go(el.dataset.target);
    },
    switchTenantFromSelect(el) {
        App.switchTenant(el.value);
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
