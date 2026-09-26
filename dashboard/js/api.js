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

    // ─── Administration UI (operations, jobs, audit, erasure) ────────────────
    // Every route below follows the same rule as the block above: a 403 or a
    // 404 means "this session cannot administer" or "this deployment does not
    // serve the route yet", and the caller hides the affordance instead of
    // showing an error the operator cannot act on.

    /** One tenant's full record, including the connection fields. */
    getAdminTenant: (id) => API.request(`/admin/tenants/${encodeURIComponent(id)}`),

    /** Platform-wide health: per-tenant rows, queue, schema, storage, hazards. */
    getAdminOps: () => API.request('/admin/ops'),
    // The platform's Gemini key. The key itself is only ever sent, never read back.
    getGeminiKey: () => API.request('/admin/gemini-key'),
    saveGeminiKey: (apiKey) => API.request('/admin/gemini-key', { method: 'PUT', body: JSON.stringify({ apiKey }) }),
    removeGeminiKey: () => API.request('/admin/gemini-key', { method: 'DELETE' }),
    // Where uploads are kept (Supabase Storage). The key is only ever sent, never read back.
    getMediaStorage: () => API.request('/admin/media-storage'),
    saveMediaStorage: (data) => API.request('/admin/media-storage', { method: 'PUT', body: JSON.stringify(data) }),
    removeMediaStorage: () => API.request('/admin/media-storage', { method: 'DELETE' }),

    /** Ask Meta about one tenant's token right now, rather than reading a
     *  status that can be weeks old. Returns the fresh token state. */
    recheckAdminTenantToken: (id) => API.request(
        `/admin/tenants/${encodeURIComponent(id)}/recheck-token`, { method: 'POST' }
    ),

    /**
     * The same re-check for the acting tenant, available to any authenticated
     * operator — this is the non-admin half of "is the token still good".
     */
    recheckToken: () => API.request('/settings/token/recheck', { method: 'POST' }),

    /**
     * Health for the ACTING tenant. Any authenticated user may call it, which
     * is what makes webhook freshness visible to an ordinary operator instead
     * of only on the admin tenants list.
     */
    getTenantHealth: () => API.request('/health/tenant'),

    // Users
    updateAdminUser: (id, data) => API.request(`/admin/users/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(data),
    }),
    setAdminUserPassword: (id, password) => API.request(
        `/admin/users/${encodeURIComponent(id)}/password`,
        { method: 'POST', body: JSON.stringify({ password }) }
    ),
    deleteUserMembership: (id, creatorId) => API.request(
        `/admin/users/${encodeURIComponent(id)}/memberships/${encodeURIComponent(creatorId)}`,
        { method: 'DELETE' }
    ),

    /**
     * Change your OWN password. The server answers with a fresh session token
     * because every other session is invalidated — store it like a login or
     * this tab logs itself out.
     */
    changeOwnPassword: (currentPassword, newPassword) => API.request('/auth/password', {
        method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
    }),

    // Job queue
    getAdminJobs: (params = {}) => {
        const query = new URLSearchParams(
            Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined)
        ).toString();
        return API.request(`/admin/jobs${query ? `?${query}` : ''}`);
    },
    retryAdminJob: (id) => API.request(`/admin/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
    cancelAdminJob: (id) => API.request(`/admin/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

    /**
     * Data-subject erasure, in two halves that cannot be collapsed into one.
     * The preview returns a short-lived `token`; the POST takes nothing but
     * that token, so there is no way to erase without having first been shown
     * what would be erased.
     */
    previewErasure: (handle) => API.request(
        `/admin/erasure/preview?handle=${encodeURIComponent(handle)}`
    ),
    executeErasure: (token) => API.request('/admin/erasure', {
        method: 'POST', body: JSON.stringify({ token }),
    }),

    getAdminAudit: (params = {}) => {
        const query = new URLSearchParams(
            Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined)
        ).toString();
        return API.request(`/admin/audit${query ? `?${query}` : ''}`);
    },

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

    // TikTok — the connection is per account; the app credentials are platform-admin only.
    getTikTokConnection: () => API.request('/tiktok/connection'),
    /**
     * Live from TikTok (Direct Post): who is posting, which privacy levels the
     * account offers, which interactions it has switched off, the longest video
     * it may post. Asked when TikTok becomes a composer target, never at page load.
     */
    getTikTokCreatorInfo: () => API.request('/tiktok/creator-info'),
    startTikTokConnect: () => API.request('/tiktok/connect', { method: 'POST' }),
    disconnectTikTok: () => API.request('/tiktok/disconnect', { method: 'POST' }),
    getTikTokAppSettings: () => API.request('/tiktok/app-settings'),
    saveTikTokAppSettings: (data) => API.request('/tiktok/app-settings', { method: 'POST', body: JSON.stringify(data) }),

    // Posts Scheduler
    getScheduledPosts: () => API.request('/posts/scheduled'),
    createScheduledPost: (data) => API.request('/posts/scheduled', { method: 'POST', body: JSON.stringify(data) }),
    updateScheduledPost: (id, data) => API.request(`/posts/scheduled/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteScheduledPost: (id) => API.request(`/posts/scheduled/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /**
     * Republish an existing queue row in place — claims it server-side (PENDING or FAILED
     * only) and skips whatever platform is already recorded in `published_post_id`, instead
     * of the old create-a-new-row-with-publish_now dance that had no memory of what the
     * ORIGINAL row had already published.
     */
    publishExistingNow: (id) => API.request(`/posts/scheduled/${encodeURIComponent(id)}/publish-now`, { method: 'POST' }),
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

    // ─── Carousel Studio (STUDIO.md §4) ─────────────────────────────────────
    // The worker on the Mac does the slow parts (indexing, rendering); these
    // only ever queue work for it or read what it has finished. A 400 carries
    // `problems: string[]` from validateCarousel on `err.body`.
    getStudioStatus: () => API.request('/studio/status'),
    getStudioLessons: () => API.request('/studio/lessons'),
    getStudioLesson: (id) => API.request(`/studio/lessons/${encodeURIComponent(id)}`),
    scanStudioLibrary: () => API.request('/studio/scan', { method: 'POST' }),
    indexStudioLesson: (id) => API.request(`/studio/lessons/${encodeURIComponent(id)}/index`, { method: 'POST' }),
    indexMissingStudioLessons: () => API.request('/studio/lessons/index-missing', { method: 'POST' }),
    getStudioDrafts: () => API.request('/studio/drafts'),
    getStudioDraft: (id) => API.request(`/studio/drafts/${encodeURIComponent(id)}`),
    /** Writes the carousel synchronously on the server: up to two minutes. */
    createStudioDraft: (input) => API.request('/studio/drafts', { method: 'POST', body: JSON.stringify(input) }),
    updateStudioDraft: (id, data) => API.request(`/studio/drafts/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(data),
    }),
    rewriteStudioSlide: (id, data) => API.request(`/studio/drafts/${encodeURIComponent(id)}/rewrite`, {
        method: 'POST', body: JSON.stringify(data),
    }),
    renderStudioDraft: (id) => API.request(`/studio/drafts/${encodeURIComponent(id)}/render`, { method: 'POST' }),
    scheduleStudioDraft: (id, data) => API.request(`/studio/drafts/${encodeURIComponent(id)}/schedule`, {
        method: 'POST', body: JSON.stringify(data),
    }),
    deleteStudioDraft: (id) => API.request(`/studio/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    postStudioTikTokBatch: () => API.request('/studio/tiktok/batch', { method: 'POST' }),
    setStudioTikTokPublic: (id, done) => API.request(`/studio/drafts/${encodeURIComponent(id)}/tiktok-public`, {
        method: 'POST', body: JSON.stringify({ done: !!done }),
    }),
    getStudioSlots: (count) => API.request(`/studio/slots?count=${encodeURIComponent(count)}`),
    planStudioWeek: (data) => API.request('/studio/plan', { method: 'POST', body: JSON.stringify(data) }),
    // Per-tenant settings (STUDIO.md §10): brand, voice, product, CTAs, schedule, library.
    getStudioSettings: () => API.request('/studio/settings'),
    /** Partial merge on the server; the dashboard sends whole sections. */
    saveStudioSettings: (data) => API.request('/studio/settings', { method: 'PUT', body: JSON.stringify(data) }),
    // ─── Growth & SEO hub (GROWTH.md §3) ────────────────────────────────────
    // Session + canOperate, tenant-scoped. Anything the API could not measure comes back
    // null, never 0, and the page shows it as missing rather than as a number.
    /** `{ instagram, facebook, tiktok, missing: string[], lastSync }` */
    getGrowthStatus: () => API.request('/growth/status'),
    /** Fetch fresh insights from Meta. Once per ten minutes per tenant; sooner is a 429. */
    syncGrowth: () => API.request('/growth/sync', { method: 'POST' }),
    getGrowthOverview: (days) => API.request(`/growth/overview?days=${encodeURIComponent(days)}`),
    getGrowthPosts: (days, sort) => API.request(
        `/growth/posts?days=${encodeURIComponent(days)}&sort=${encodeURIComponent(sort || 'views')}`
    ),
    /** Gemini reads the metrics, captions and settings: most of a minute, synchronously. */
    growthCoach: (data) => API.request('/growth/coach', { method: 'POST', body: JSON.stringify(data || {}) }),
    getGrowthSettings: () => API.request('/growth/settings'),
    /** The whole settings: keywords, hashtag_sets, competitors, audience. */
    saveGrowthSettings: (data) => API.request('/growth/settings', { method: 'PUT', body: JSON.stringify(data) }),
    /** `{ keywords: { term, why }[], hashtags: string[] }` — ideas to verify, not search-volume data. */
    suggestGrowthKeywords: (topic) => API.request('/growth/keywords/suggest', {
        method: 'POST', body: JSON.stringify({ topic }),
    }),
    /** Instagram Business Discovery for each saved competitor username. */
    getGrowthCompetitors: () => API.request('/growth/competitors'),

    getStudioWorkers: () => API.request('/studio/workers'),
    /** `{ worker, token }` — the token exists in this response and nowhere else, ever. */
    createStudioWorker: (name) => API.request('/studio/workers', { method: 'POST', body: JSON.stringify({ name }) }),
    revokeStudioWorker: (id) => API.request(`/studio/workers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
