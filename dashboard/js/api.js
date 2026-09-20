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
            case 400: return 'The server rejected the request (400). Check the values you entered.';
            case 403: return 'Not allowed (403).';
            case 404: return 'That endpoint was not found (404).';
            case 413: return 'The request body was too large (413). Vercel caps uploads at 4.5MB — keep files under 3.2MB.';
            case 429: return 'Too many requests (429). Wait a moment and try again.';
            case 500: return 'The server hit an internal error (500). Check the deployment logs.';
            case 502:
            case 503:
            case 504: return `The server was unavailable or timed out (${status}). Publishing and uploads can exceed the serverless time limit.`;
            default: break;
        }
        const snippet = String(rawText || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160);
        return snippet
            ? `Request failed (${status}): ${snippet}`
            : `Request failed (${status}).`;
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
            if (typeof UI !== 'undefined') UI.setSystemStatus('offline');
            const err = new Error('Could not reach the server. Check your connection and try again.');
            err.isNetworkError = true;
            err.cause = networkErr;
            throw err;
        }

        if (res.status === 401) {
            this.clearToken();
            if (typeof App !== 'undefined') App.showLogin();
            const err = new Error('Session expired. Please sign in again.');
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

        if (typeof UI !== 'undefined') {
            UI.setSystemStatus(res.status >= 500 ? 'degraded' : 'online');
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
            const err = new Error(
                `The server returned a non-JSON response (${res.status}). ${this.describeHttpError(res.status, rawText)}`
            );
            err.status = res.status;
            err.rawText = rawText;
            throw err;
        }

        return body;
    },

    // Auth
    login: (password) => API.request('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),

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
        if (!dl) throw new Error('The server did not return a download token for this export.');
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
