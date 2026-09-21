/**
 * API Client — handles all communication with the backend.
 */
const API = {
    baseUrl: '/api',
    token: localStorage.getItem('auth_token') || null,

    /** Vercel caps request bodies at 4.5MB; /api/upload wraps files in base64
     *  JSON (~1.37x overhead), so the real ceiling is ~3.2MB of file. */
    MAX_UPLOAD_BYTES: 3.2 * 1024 * 1024,

    setToken(token) {
        this.token = token;
        localStorage.setItem('auth_token', token);
    },

    clearToken() {
        this.token = null;
        localStorage.removeItem('auth_token');
    },

    /**
     * Turn a non-JSON / non-2xx response into something a human can act on.
     * Vercel serves HTML error pages for 413/500/502/504, so parsing JSON
     * first (as this used to) surfaced every one of them as
     * "SyntaxError: Unexpected token '<'".
     */
    describeHttpError(status, rawText) {
        switch (status) {
            case 400: return t('http.400');
            case 403: return t('http.403');
            case 404: return t('http.404');
            case 413: return t('http.413');
            case 429: return t('http.429');
            case 500: return t('http.500');
            case 502:
            case 503:
            case 504: return t('http.5xx', { status });
            default: break;
        }
        const snippet = String(rawText || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160);
        return snippet
            ? t('http.genericSnippet', { status, snippet })
            : t('http.generic', { status });
    },

    async request(path, options = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

        let res;
        try {
            res = await fetch(`${this.baseUrl}${path}`, {
                ...options,
                headers: { ...headers, ...options.headers },
            });
        } catch (networkErr) {
            // No global health badge any more: a failure is reported by the
            // thing that failed — an error panel with Retry, or a toast — and
            // an indicator that is only ever green tells the operator nothing
            // the page having loaded did not already tell them.
            const err = new Error(t('http.network'));
            err.isNetworkError = true;
            err.cause = networkErr;
            throw err;
        }

        if (res.status === 401) {
            this.clearToken();
            if (typeof App !== 'undefined') App.showLogin();
            const err = new Error(t('http.sessionExpired'));
            err.status = 401;
            throw err;
        }

        // Read as text FIRST — the body may be HTML, empty, or truncated.
        const rawText = await res.text();
        let body = null;
        let parseFailed = false;
        if (rawText) {
            try { body = JSON.parse(rawText); } catch { parseFailed = true; }
        }

        if (!res.ok) {
            const message = (body && (body.error || body.message)) || this.describeHttpError(res.status, rawText);
            const err = new Error(message);
            err.status = res.status;
            err.body = body;
            err.rawText = rawText;
            throw err;
        }

        if (parseFailed) {
            const err = new Error(t('http.nonJson', {
                status: res.status,
                detail: this.describeHttpError(res.status, rawText),
            }));
            err.status = res.status;
            err.rawText = rawText;
            throw err;
        }

        return body;
    },

    // Auth
    /**
     * `email` is optional. An empty email is the shared-password path that has
     * always existed and is still the operator's only way in, so it must send
     * exactly the body it used to — no `email: null`, no `email: ''`.
     */
    login: (password, email) => API.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify(email ? { email, password } : { password }),
    }),

    /** Who am I, what may I do, and which tenants can I act as. */
    getMe: () => API.request('/auth/me'),

    /** Returns a NEW session token scoped to `tenantId`. Store it like a login. */
    switchTenant: (tenantId) => API.request('/auth/switch-tenant', {
        method: 'POST', body: JSON.stringify({ tenantId }),
    }),

    // Platform administration
    // A 403/404 from any of these means "not a platform admin" (or the route is
    // not deployed yet) — callers hide the UI rather than surfacing an error.
    getAdminTenants: () => API.request('/admin/tenants'),
    createAdminTenant: (data) => API.request('/admin/tenants', { method: 'POST', body: JSON.stringify(data) }),
    updateAdminTenant: (id, data) => API.request(`/admin/tenants/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(data),
    }),
    getAdminUsers: () => API.request('/admin/users'),
    createAdminUser: (data) => API.request('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
    revokeUserSessions: (id) => API.request(`/admin/users/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
    createUserMembership: (id, data) => API.request(`/admin/users/${encodeURIComponent(id)}/memberships`, {
        method: 'POST', body: JSON.stringify(data),
    }),

    // Stats
    getStats: () => API.request('/stats'),
    getHourlyStats: (days = 7) => API.request(`/stats/hourly?days=${days}`),
    getDailyStats: (days = 30) => API.request(`/stats/daily?days=${days}`),
    getCampaignStats: () => API.request('/stats/campaigns'),

    // Campaigns
    getCampaigns: () => API.request('/campaigns'),
    createCampaign: (data) => API.request('/campaigns', { method: 'POST', body: JSON.stringify(data) }),
    updateCampaign: (id, data) => API.request(`/campaigns/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteCampaign: (id) => API.request(`/campaigns/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // Interactions
    getInteractions: (params = {}) => {
        const query = new URLSearchParams(params).toString();
        return API.request(`/interactions?${query}`);
    },

    /**
     * CSV export — two steps, so the session token never lands in a URL,
     * browser history, or a referrer header:
     *   1. POST /api/interactions/export/token  → { token }
     *   2. GET  /api/interactions/export?dl=<token>
     * Filters are sent in the POST body (so the server can bake them into the
     * token) and repeated on the GET for servers that read them from the query.
     */
    async exportInteractions(params = {}) {
        const result = await API.request('/interactions/export/token', {
            method: 'POST',
            body: JSON.stringify(params),
        });
        const dl = result && result.token;
        if (!dl) throw new Error(t('http.noExportToken'));
        const query = new URLSearchParams({ ...params, dl }).toString();
        window.location.href = `${API.baseUrl}/interactions/export?${query}`;
    },

    // Settings
    getTokenStatus: () => API.request('/settings/token/status'),
    updateToken: (token) => API.request('/settings/token', { method: 'POST', body: JSON.stringify({ token }) }),
    getWebhookToken: () => API.request('/settings/webhook-token'),
    updateWebhookToken: (token) => API.request('/settings/webhook-token', { method: 'POST', body: JSON.stringify({ token }) }),
    getCreators: () => API.request('/creators'),

    // Posts Scheduler
    getScheduledPosts: () => API.request('/posts/scheduled'),
    createScheduledPost: (data) => API.request('/posts/scheduled', { method: 'POST', body: JSON.stringify(data) }),
    updateScheduledPost: (id, data) => API.request(`/posts/scheduled/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteScheduledPost: (id) => API.request(`/posts/scheduled/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getLivePosts: () => API.request('/posts/live'),
    uploadMedia: (data) => API.request('/upload', { method: 'POST', body: JSON.stringify(data) }),

    // Conversations (DM inbox)
    getConversations: () => API.request('/conversations'),
    getConversationMessages: (id) => API.request(`/conversations/${encodeURIComponent(id)}/messages`),
    sendConversationMessage: (id, text) => API.request(`/conversations/${encodeURIComponent(id)}/messages`, {
        method: 'POST', body: JSON.stringify({ text }),
    }),
    toggleConversationBot: (id, isActive) => API.request(`/conversations/${encodeURIComponent(id)}/toggle-bot`, {
        method: 'PUT', body: JSON.stringify({ is_bot_active: isActive }),
    }),

    // AI settings
    getAiSettings: () => API.request('/settings/ai'),
    saveAiSettings: (data) => API.request('/settings/ai', { method: 'POST', body: JSON.stringify(data) }),
    testAiSettings: (data) => API.request('/settings/ai/test', { method: 'POST', body: JSON.stringify(data) }),
};
