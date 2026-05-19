/**
 * App Controller — handles routing, auth state, and page navigation.
 */
const App = {
    currentPage: 'overview',

    pages: {
        overview: { title: 'Overview', subtitle: 'Welcome back. Here\'s how your automation is performing.', render: () => OverviewPage.render() },
        campaigns: { title: 'Campaigns', subtitle: 'Manage your keyword triggers and DM templates.', render: () => CampaignsPage.render() },
        analytics: { title: 'Analytics', subtitle: 'Deep dive into your automation performance.', render: () => AnalyticsPage.render() },
        activity: { title: 'Activity Log', subtitle: 'Every interaction logged in real-time.', render: () => ActivityPage.render() },
        settings: { title: 'Settings', subtitle: 'Manage your account and access tokens.', render: () => SettingsPage.render() },
    },

    init() {
        // Check if already logged in
        if (API.token) {
            this.showApp();
        } else {
            this.showLogin();
        }

        // Login form handler
        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('login-password').value;
            const errorEl = document.getElementById('login-error');
            const btn = document.getElementById('login-btn');

            btn.disabled = true;
            btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;"></div>';

            try {
                const result = await API.request('/auth/login', {
                    method: 'POST',
                    body: JSON.stringify({ password }),
                });
                API.setToken(result.token);
                errorEl.classList.add('hidden');
                this.showApp();
            } catch (err) {
                errorEl.textContent = 'Invalid password. Try again.';
                errorEl.classList.remove('hidden');
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<span>Sign In</span><i data-lucide="arrow-right"></i>';
                lucide.createIcons({ nodes: [btn] });
            }
        });

        // Sidebar navigation
        document.querySelectorAll('.nav-item[data-page]').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigate(item.dataset.page);
            });
        });

        // Logout
        document.getElementById('logout-btn').addEventListener('click', () => {
            API.clearToken();
            this.showLogin();
        });

        // Mobile menu
        document.getElementById('mobile-menu-btn').addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('open');
        });

        // Init icons
        lucide.createIcons();
    },

    showLogin() {
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('app').classList.add('hidden');
    },

    showApp() {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        this.navigate(this.currentPage);
    },

    navigate(page) {
        if (!this.pages[page]) return;
        this.currentPage = page;

        // Update sidebar
        document.querySelectorAll('.nav-item[data-page]').forEach(item => {
            item.classList.toggle('active', item.dataset.page === page);
        });

        // Update header
        document.getElementById('page-title').textContent = this.pages[page].title;
        document.getElementById('page-subtitle').textContent = this.pages[page].subtitle;

        // Close mobile menu
        document.getElementById('sidebar').classList.remove('open');

        // Render page
        this.pages[page].render();
    }
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
