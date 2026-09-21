/**
 * App Controller — routing (hash-based), auth state, and page lifecycle.
 */
const App = {
    currentPage: null,

    pages: {
        overview: { title: 'Overview', subtitle: 'Welcome back. Here\'s how your automation is performing.', page: () => OverviewPage },
        campaigns: { title: 'Campaigns', subtitle: 'Manage your keyword triggers and DM templates.', page: () => CampaignsPage },
        posts: { title: 'Posts Scheduler', subtitle: 'Create, schedule, and publish posts to Instagram and Facebook.', page: () => PostsPage },
        inbox: { title: 'Live DM Inbox', subtitle: 'Real-time customer conversations and AI agent controls.', page: () => InboxPage },
        ai_settings: { title: 'AI Agent Settings', subtitle: 'Configure instructions, knowledge bases, and test simulations.', page: () => AiSettingsPage },
        analytics: { title: 'Analytics', subtitle: 'Deep dive into your automation performance.', page: () => AnalyticsPage },
        activity: { title: 'Activity Log', subtitle: 'Every interaction logged in real-time.', page: () => ActivityPage },
        settings: { title: 'Settings', subtitle: 'Manage your account and access tokens.', page: () => SettingsPage },
    },

    DEFAULT_PAGE: 'overview',

    init() {
        // Login form handler
        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('login-password').value;
            const errorEl = document.getElementById('login-error');
            const btn = document.getElementById('login-btn');

            btn.disabled = true;
            btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;"></div>';

            try {
                const result = await API.login(password);
                API.setToken(result.token);
                errorEl.classList.add('hidden');
                this.showApp();
            } catch (err) {
                errorEl.textContent = err && err.status === 401
                    ? 'Invalid password. Try again.'
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
    },

    showApp() {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        const page = this.pageFromHash();
        if (location.hash !== `#/${page}`) {
            // Normalise without adding a history entry AND without firing
            // hashchange (which would render the page a second time).
            history.replaceState(null, '', `#/${page}`);
        }
        this.navigate(page);
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
});

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
