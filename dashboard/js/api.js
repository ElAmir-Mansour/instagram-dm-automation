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

    /**
     * The server's refusal, whichever of the two shapes it came in (contracts/api.md, "Error envelope"):
     *
     *   today      { error: 'sentence', code?: 'CODE', params?: {…}, …extra fields }
     *   envelope   { error: { code, params, message } }
     *
     * Returns `{ message, code, params, flat }`. `message` is the sentence the server wrote ('' when it wrote none, so the
     * caller falls back to `describeHttpError`); `code` is '' and `params` null when it sent none. `flat` is the body as
     * every reader written before the envelope expects it: `error` is the sentence and `code` sits at the top. For today's
     * shape it is the body itself; for the envelope it is a copy with those two lifted out, so `err.body.error` never
     * becomes an object that a toast prints as "[object Object]".
     */
    readError(body) {
        const out = { message: '', code: '', params: null, flat: body };
        if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
        const nested = body.error && typeof body.error === 'object' && !Array.isArray(body.error) ? body.error : null;
        const source = nested || body;
        if (nested) {
            out.message = typeof nested.message === 'string' ? nested.message : '';
        } else {
            out.message = typeof body.error === 'string' && body.error
                ? body.error
                : (typeof body.message === 'string' ? body.message : '');
        }
        out.code = typeof source.code === 'string' && source.code ? source.code : (nested && typeof body.code === 'string' ? body.code : '');
        out.params = source.params && typeof source.params === 'object' && !Array.isArray(source.params) ? source.params : null;
        if (nested) out.flat = { ...body, error: out.message, ...(out.code ? { code: out.code } : {}), ...(out.params ? { params: out.params } : {}) };
        return out;
    },

    async request(path, options = {}) {
        // `profileAsked` is ours, not fetch's: it marks the one retry made after the person answered a profile question.
        const { profileAsked, ...fetchOptions } = options;
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

        let res;
        try {
            res = await fetch(`${this.baseUrl}${path}`, {
                ...fetchOptions,
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
            const hadSession = !!this.token;
            this.clearToken();
            // A 401 with a token is an expired session and the login screen says
            // so; a 401 without one is the login attempt itself, which the form
            // reports on its own.
            if (typeof App !== 'undefined') App.showLogin(hadSession ? t('http.sessionExpired') : '');
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
            const read = this.readError(body);
            const message = read.message || this.describeHttpError(res.status, rawText);
            const err = new Error(message);
            err.status = res.status;
            err.body = read.flat;
            err.rawText = rawText;
            // A stable identifier and its values, when the server sent them: `UI.errorText(err)` turns them into a sentence in the
            // interface language. Absent when it did not, so `err.code === undefined` still means "an uncoded refusal".
            if (read.code) err.code = read.code;
            if (read.params) err.params = read.params;
            // An agent was switched on before it had what it writes from (P30). Ask for it, in a sheet, ONCE, and send the very same
            // request again if it was answered; when it cannot be answered here (the wizard's own fields, or a cancelled sheet), the
            // person is told in their own language and not in the server's.
            const flat = read.flat;
            if (res.status === 409 && flat && flat.code === 'PROFILE_INCOMPLETE') {
                if (!profileAsked && typeof ProfileAsk !== 'undefined') {
                    const answered = await ProfileAsk.require(flat.missing, { agent: flat.agent });
                    if (answered) return this.request(path, { ...options, profileAsked: true });
                }
                err.message = t('profileAsk.refused');
            }
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
    login: (password, email, keepSignedIn) => API.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify(email ? { email, password, ...(keepSignedIn ? { keepSignedIn: true } : {}) } : { password }),
    }),

    // Invite links (P17). Public: a person opening a link has no session. The token travels in the BODY, never in a URL.
    // `peek` carries the Bearer token when there is one, so the page can say who is signed in; the server ignores a dead one.
    peekInvite: (token) => API.request('/invites/peek', { method: 'POST', body: JSON.stringify({ token }) }),
    acceptInvite: (data) => API.request('/invites/accept', { method: 'POST', body: JSON.stringify(data) }),

    /** Who am I, what may I do, and which tenants can I act as. `onboarding` says whether this session is sent to the wizard. */
    getMe: () => API.request('/auth/me'),

    // The setup wizard (P18). `saveOnboardingStep` autosaves what was typed (`{ values }`) and marks Continue / Skip
    // (`{ status }`); it never writes the profile. Continue is `patchProfile`, whose `version` is the one the last read
    // returned: a 409 means somebody else wrote in between, and the page reloads that step.
    getOnboarding: () => API.request('/onboarding'),
    saveOnboardingStep: (step, body) => API.request(`/onboarding/steps/${encodeURIComponent(step)}`, {
        method: 'PUT', body: JSON.stringify(body),
    }),
    completeOnboarding: () => API.request('/onboarding/complete', { method: 'POST', body: '{}' }),
    // The proof samples, W5 (P25). `startProof` makes the cards that are missing (once; a reload is free) and can take half a minute; `getProof` only
    // reads. A verdict is `{ verdict: 'approved' | 'edited' | 'rejected', edited_text?, reasons? }`; `proofRegenerate` writes a card again with a hint
    // (a chip's code or the person's own words). The answers are `{ state, cards, failure, limits }`, `{ card }` and `{ state, card?, failure, limits }`.
    getProof: () => API.request('/onboarding/proof'),
    startProof: () => API.request('/onboarding/proof', { method: 'POST', body: '{}' }),
    proofVerdict: (id, body) => API.request(`/onboarding/proof/${encodeURIComponent(id)}/verdict`, { method: 'POST', body: JSON.stringify(body) }),
    proofRegenerate: (id, body) => API.request(`/onboarding/proof/${encodeURIComponent(id)}/regenerate`, { method: 'POST', body: JSON.stringify(body) }),
    patchProfile: (version, patch) => API.request('/profile', { method: 'PATCH', body: JSON.stringify({ version, patch }) }),
    /** The profile and the version a patch must send back (the one-field sheet, `ProfileAsk`). */
    getProfile: () => API.request('/profile'),
    /** How complete the profile is and the next three things to do (the Overview card). */
    getProfileProgress: () => API.request('/profile/progress'),
    /** The invite-to-finished funnel for the last 30 or 90 days (Operations, platform admin). */
    getOnboardingFunnel: (days) => API.request(`/admin/onboarding/funnel?days=${encodeURIComponent(days)}`),

    /** Returns a NEW session token scoped to `tenantId`. Store it like a login. */
    switchTenant: (tenantId) => API.request('/auth/switch-tenant', {
        method: 'POST', body: JSON.stringify({ tenantId }),
    }),

    // Platform administration
    // A 403/404 from any of these means "not a platform admin" (or the route is
    // not deployed yet) — callers hide the UI rather than surfacing an error.
    getAdminTenants: () => API.request('/admin/tenants'),
    createAdminTenant: (data) => API.request('/admin/tenants', { method: 'POST', body: JSON.stringify(data) }),
    /** Ads A8: a tenant's legal sign-offs (revoked ones too) → `{ signoffs }`. */
    getAdminLegalSignoffs: (tenantId) => API.request(`/admin/ads/tenants/${encodeURIComponent(tenantId)}/legal-signoff`),
    /** `{ scope: 'customer_lists' | 'lead_ads', countries: ['EG', ...], note }` → `{ signoff }`. */
    recordAdminLegalSignoff: (tenantId, body) => API.request(`/admin/ads/tenants/${encodeURIComponent(tenantId)}/legal-signoff`, { method: 'POST', body: JSON.stringify(body) }),
    revokeAdminLegalSignoff: (tenantId, id) => API.request(`/admin/ads/tenants/${encodeURIComponent(tenantId)}/legal-signoff/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    updateAdminTenant: (id, data) => API.request(`/admin/tenants/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(data),
    }),
    getAdminUsers: () => API.request('/admin/users'),
    createAdminUser: (data) => API.request('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
    revokeUserSessions: (id) => API.request(`/admin/users/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
    createUserMembership: (id, data) => API.request(`/admin/users/${encodeURIComponent(id)}/memberships`, {
        method: 'POST', body: JSON.stringify(data),
    }),

    // Invite links, from the tenant's page (platform admin). The link comes back ONCE, in `invite.url`.
    getTenantInvites: (tenantId) => API.request(`/admin/tenants/${encodeURIComponent(tenantId)}/invites`),
    createTenantInvite: (tenantId, data) => API.request(`/admin/tenants/${encodeURIComponent(tenantId)}/invites`, {
        method: 'POST', body: JSON.stringify(data || {}),
    }),
    regenerateInvite: (id, data) => API.request(`/admin/invites/${encodeURIComponent(id)}/regenerate`, {
        method: 'POST', body: JSON.stringify(data || {}),
    }),
    revokeInvite: (id) => API.request(`/admin/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getOnboardingSettings: () => API.request('/admin/onboarding-settings'),
    saveOnboardingSettings: (data) => API.request('/admin/onboarding-settings', { method: 'PUT', body: JSON.stringify(data) }),

    // ─── Administration UI (operations, jobs, audit, erasure) ────────────────
    // Every route below follows the same rule as the block above: a 403 or a
    // 404 means "this session cannot administer" or "this deployment does not
    // serve the route yet", and the caller hides the affordance instead of
    // showing an error the operator cannot act on.

    /** One tenant's full record, including the connection fields. */
    getAdminTenant: (id) => API.request(`/admin/tenants/${encodeURIComponent(id)}`),

    /** A tenant's Creator Profile and the version a save must send back (the admin fills it in on their behalf). */
    getAdminTenantProfile: (id) => API.request(`/admin/tenants/${encodeURIComponent(id)}/profile`),
    /** `{ version, patch, confirm_remove_owner_rule? }`: only the changed paths. A 409 carries `body.code` and, for a stale version, `body.currentVersion`. */
    updateAdminTenantProfile: (id, data) => API.request(`/admin/tenants/${encodeURIComponent(id)}/profile`, {
        method: 'PATCH', body: JSON.stringify(data),
    }),

    /** Platform-wide health: per-tenant rows, queue, schema, storage, hazards. */
    getAdminOps: () => API.request('/admin/ops'),
    // The platform's Gemini key. The key itself is only ever sent, never read back.
    getGeminiKey: () => API.request('/admin/gemini-key'),
    saveGeminiKey: (apiKey) => API.request('/admin/gemini-key', { method: 'PUT', body: JSON.stringify({ apiKey }) }),
    removeGeminiKey: () => API.request('/admin/gemini-key', { method: 'DELETE' }),
    // The AI providers card (Operations; src/routes/adminAi.ts). Keys are only ever sent, never read back: every
    // answer carries `{set, source, last4}`. Gemini's key is saved through the route above, which checks the DM bot's models.
    getAdminAi: () => API.request('/admin/ai'),
    saveAdminAi: (patch) => API.request('/admin/ai', { method: 'PUT', body: JSON.stringify(patch) }),
    saveAiKey: (provider, apiKey) => API.request(`/admin/ai/keys/${encodeURIComponent(provider)}`, { method: 'PUT', body: JSON.stringify({ apiKey }) }),
    removeAiKey: (provider) => API.request(`/admin/ai/keys/${encodeURIComponent(provider)}`, { method: 'DELETE' }),
    /** `{provider}` checks that key now (free); `{purpose}` sends one tiny structured call down that route. */
    testAi: (body) => API.request('/admin/ai/test', { method: 'POST', body: JSON.stringify(body) }),
    getAiModels: (provider) => API.request(`/admin/ai/models/${encodeURIComponent(provider)}`),
    getAiUsage: (period) => API.request(`/admin/ai/usage${period === 'month' ? '?period=month' : ''}`),
    // Where uploads are kept (Supabase Storage). The key is only ever sent, never read back.
    getMediaStorage: () => API.request('/admin/media-storage'),
    getMediaCleanup: () => API.request('/admin/media-storage/cleanup'),
    setMediaCleanup: (on) => API.request('/admin/media-storage/cleanup', { method: 'PUT', body: JSON.stringify({ on }) }),
    runMediaCleanup: () => API.request('/admin/media-storage/cleanup', { method: 'POST' }),
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

    // Ads for clients (A11), the platform admin's. `getAdminAdsTenants()` answers `{ tenants: [...] }`, one row per workspace (Postgres only, no Meta call);
    // `spend` is in a row only when that client shares it. Sign-offs use A8's `recordAdminLegalSignoff` / `revokeAdminLegalSignoff` above.
    getAdminAdsTenants: () => API.request('/admin/ads/tenants'),
    setAdminAdsEnabled: (id, enabled) => API.request(`/admin/ads/tenants/${encodeURIComponent(id)}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
    setAdminAdsCeiling: (id, maxDailyBudget, monthlyCap) => API.request(`/admin/ads/tenants/${encodeURIComponent(id)}/ceiling`, {
        method: 'POST', body: JSON.stringify({ maxDailyBudget, monthlyCap }),
    }),
    // The client's side (any member reads, the owner writes): `{ shareSpend, ceiling: { maxDailyBudget, monthlyCap } | null, managed }`. 404 = ads are off for this workspace.
    getAdsShareSpend: () => API.request('/ads/settings/share-spend'),
    setAdsShareSpend: (on) => API.request('/ads/settings/share-spend', { method: 'POST', body: JSON.stringify({ on }) }),

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

    // Stats. `days` windows /stats and /stats/campaigns (A1); left out, both answer
    // all-time, which is what Overview asks for.
    getStats: (days) => API.request(days ? `/stats?days=${encodeURIComponent(days)}` : '/stats'),
    getHourlyStats: (days = 7) => API.request(`/stats/hourly?days=${days}`),
    getDailyStats: (days = 30) => API.request(`/stats/daily?days=${days}`),
    getCampaignStats: (days) => API.request(days ? `/stats/campaigns?days=${encodeURIComponent(days)}` : '/stats/campaigns'),
    /** A5: the FAILED interactions of the last `days`, grouped by reason (top 6). */
    getFailureReasons: (days = 30) => API.request(`/stats/failures?days=${encodeURIComponent(days)}`),

    // Campaigns
    getCampaigns: () => API.request('/campaigns'),
    createCampaign: (data) => API.request('/campaigns', { method: 'POST', body: JSON.stringify(data) }),
    /** What the CSV import seeds each imported row from: `{ seeds, source, fallback }`, the tenant's own offers' campaigns and the wording of a row none names. */
    getCampaignSeeds: () => API.request('/profile/campaign-seeds'),
    // A dry run (writes nothing): which campaign answers `comment`, with the editor's unsaved `draft` among them. `body` is
    // `{ comment, postId?, platform?, draft? }` (contracts/api.md, POST /campaigns/try).
    tryCampaign: (body) => API.request('/campaigns/try', { method: 'POST', body: JSON.stringify(body) }),
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
    /** `returnTo`: 'welcome' when the setup wizard began it (the callback then returns there), else Settings. */
    startTikTokConnect: (returnTo) => API.request('/tiktok/connect', {
        method: 'POST', body: JSON.stringify(returnTo === 'welcome' ? { returnTo } : {}),
    }),
    disconnectTikTok: () => API.request('/tiktok/disconnect', { method: 'POST' }),
    getTikTokAppSettings: () => API.request('/tiktok/app-settings'),
    saveTikTokAppSettings: (data) => API.request('/tiktok/app-settings', { method: 'POST', body: JSON.stringify(data) }),

    // YouTube — the channel is per account; the Google OAuth client is platform-admin only.
    getYouTubeConnection: () => API.request('/youtube/connection'),
    startYouTubeConnect: (returnTo) => API.request('/youtube/connect', {
        method: 'POST', body: JSON.stringify(returnTo === 'welcome' ? { returnTo } : {}),
    }),
    disconnectYouTube: () => API.request('/youtube/disconnect', { method: 'POST' }),
    getYouTubeAppSettings: () => API.request('/youtube/app-settings'),
    saveYouTubeAppSettings: (data) => API.request('/youtube/app-settings', { method: 'POST', body: JSON.stringify(data) }),

    // WhatsApp (T025) — per tenant; any member reads, the owner writes. Every write but the disconnect answers the connection view.
    // `connectWhatsApp({ waba_id, phone_number_id, access_token })` is the one place the access token travels: in the BODY, once. It is never
    // sent back, so nothing here can hand it to the page again.
    getWhatsAppConnection: () => API.request('/whatsapp/connection'),
    connectWhatsApp: (data) => API.request('/whatsapp/connect', { method: 'POST', body: JSON.stringify(data) }),
    refreshWhatsApp: () => API.request('/whatsapp/refresh', { method: 'POST' }),
    disconnectWhatsApp: () => API.request('/whatsapp/connection', { method: 'DELETE' }),
    saveWhatsAppAgent: (data) => API.request('/whatsapp/agent', { method: 'PUT', body: JSON.stringify(data) }),
    saveWhatsAppBilling: (data) => API.request('/whatsapp/billing', { method: 'PUT', body: JSON.stringify(data) }),
    // Entry points (T052 / T053): the number's QR codes and short links, and its ice breakers. Meta holds them, so every answer is read from
    // Meta. `getWhatsAppEntryLinks()` answers a list; `createWhatsAppEntryLink({ label, prefill })` answers the new link (201); deleting answers
    // nothing (204). `saveWhatsAppIceBreakers({ prompts })` answers what Meta holds after the write. Everything but the reads is the owner's.
    getWhatsAppEntryLinks: () => API.request('/whatsapp/entry-links'),
    createWhatsAppEntryLink: (data) => API.request('/whatsapp/entry-links', { method: 'POST', body: JSON.stringify(data) }),
    deleteWhatsAppEntryLink: (code) => API.request(`/whatsapp/entry-links/${encodeURIComponent(code)}`, { method: 'DELETE' }),
    getWhatsAppIceBreakers: () => API.request('/whatsapp/ice-breakers'),
    saveWhatsAppIceBreakers: (data) => API.request('/whatsapp/ice-breakers', { method: 'PUT', body: JSON.stringify(data) }),

    // Instagram & Facebook (P27, P28) — the connection is per tenant; the switch and the configuration id are platform-admin only.
    // `startMetaConnect({ returnTo, reconnect, authType })` answers `{ url }`: Facebook's Login dialog, with the state cookie set.
    getMetaConnection: () => API.request('/meta/connection'),
    startMetaConnect: (body) => API.request('/meta/connect', { method: 'POST', body: JSON.stringify(body || {}) }),
    getMetaCandidates: (pick) => API.request(`/meta/candidates?pick=${encodeURIComponent(pick)}`),
    selectMetaPage: (body) => API.request('/meta/select', { method: 'POST', body: JSON.stringify(body) }),
    disconnectMeta: () => API.request('/meta/disconnect', { method: 'POST', body: JSON.stringify({ confirm: true }) }),
    /** `{ connected, since, received, count, latestAt }`: has a comment reached this tenant since it connected? (the wizard's test) */
    getMetaCommentCheck: () => API.request('/meta/comment-check'),
    getMetaAppSettings: () => API.request('/meta/app-settings'),
    saveMetaAppSettings: (data) => API.request('/meta/app-settings', { method: 'POST', body: JSON.stringify(data) }),

    // Posts Scheduler
    getScheduledPosts: () => API.request('/posts/scheduled'),
    createScheduledPost: (data) => API.request('/posts/scheduled', { method: 'POST', body: JSON.stringify(data) }),
    updateScheduledPost: (id, data) => API.request(`/posts/scheduled/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteScheduledPost: (id) => API.request(`/posts/scheduled/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /**
     * Archive a scheduled post and its undo (UX US1): the owner's way to put away a post that needs nothing. Both answer the row as the list
     * has it (`archived_at` set, or null). An archived post is not published by the sweep and is not counted as needing attention.
     */
    archiveScheduledPost: (id) => API.request(`/posts/scheduled/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
    unarchiveScheduledPost: (id) => API.request(`/posts/scheduled/${encodeURIComponent(id)}/archive`, { method: 'DELETE' }),
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
    /**
     * `{ limit, search, page }`. The route defaults to 20 rows, which is why the inbox used to
     * show only the newest 20 and search only those; the inbox asks for 100 and sends `search`
     * so the server looks through every thread. `pagination.total` says how many there really are.
     */
    getConversations: (params = {}) => {
        const query = new URLSearchParams(
            Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined)
        ).toString();
        return API.request(`/conversations${query ? `?${query}` : ''}`);
    },
    getConversationMessages: (id) => API.request(`/conversations/${encodeURIComponent(id)}/messages`),
    sendConversationMessage: (id, text) => API.request(`/conversations/${encodeURIComponent(id)}/messages`, {
        method: 'POST', body: JSON.stringify({ text }),
    }),
    toggleConversationBot: (id, isActive) => API.request(`/conversations/${encodeURIComponent(id)}/toggle-bot`, {
        method: 'PUT', body: JSON.stringify({ is_bot_active: isActive }),
    }),
    /**
     * "Mark handled" and its undo (UX US1): the owner's way out of "needs you" for a thread he answered from the Instagram app. Both answer the
     * thread as a list item (`handled_at` set, or null). A new message from the customer clears it on the server by itself.
     */
    markConversationHandled: (id) => API.request(`/conversations/${encodeURIComponent(id)}/handled`, { method: 'POST' }),
    unmarkConversationHandled: (id) => API.request(`/conversations/${encodeURIComponent(id)}/handled`, { method: 'DELETE' }),
    /**
     * Look the sender up again (Instagram User Profile API). Throttled on the server, so asking is cheap and
     * answers `{ refreshed: false, reason: 'throttled' }` rather than an error when it is too soon.
     */
    refreshConversationProfile: (id) => API.request(`/conversations/${encodeURIComponent(id)}/refresh-profile`, { method: 'POST' }),
    /**
     * The DM sales funnel for the last 7, 30 or 90 days: conversations by the step they reached, the plan's rates and the bot's reply time.
     * Counts only. Asked when the card on the inbox page is opened and when its period changes, never from the poll.
     */
    getDmFunnel: (days) => API.request(`/dm/funnel?days=${encodeURIComponent(days)}`),

    // AI settings
    getAiSettings: () => API.request('/settings/ai'),
    saveAiSettings: (data) => API.request('/settings/ai', { method: 'POST', body: JSON.stringify(data) }),
    testAiSettings: (data) => API.request('/settings/ai/test', { method: 'POST', body: JSON.stringify(data) }),
    // The follow-up delay after a sales DM's link (S9): a platform-wide setting, so a platform admin's alone.
    getSalesFollowup: () => API.request('/settings/sales-followup'),
    saveSalesFollowup: (data) => API.request('/settings/sales-followup', { method: 'POST', body: JSON.stringify(data) }),
    // The owner's A/B wording experiment for the sales assistant (DM plan S14): the tenant's own, readable by every role, written by an operator.
    getSalesVariants: () => API.request('/settings/sales-variants'),
    saveSalesVariants: (data) => API.request('/settings/sales-variants', { method: 'POST', body: JSON.stringify(data) }),

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
    // ─── Monteur (MONTEUR.md §5) ────────────────────────────────────────────
    // Session + canOperate, tenant-scoped. The worker on the creator's computer
    // scans, transcribes and renders; these only queue that work or read it back.
    // Its settings are the `monteur` section of PUT /studio/settings, above.
    /** `MonteurView`: settings, timezone, runs, worker, sources, clips, lessons. */
    getMonteur: () => API.request('/studio/monteur'),
    /** `{ job }`: a monteur_scan now, or the one already open. 409 with no folder. */
    runMonteur: () => API.request('/studio/monteur/run', { method: 'POST' }),
    /** `{ job }`: a pick_folder, which opens the folder dialog on the worker's computer. */
    pickMonteurFolder: () => API.request('/studio/monteur/pick-folder', { method: 'POST' }),
    retryMonteurSource: (id) => API.request(`/studio/monteur/sources/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
    /** `{ title?, copy? }`. A new title or keyword re-renders the video. */
    updateMonteurClip: (id, data) => API.request(`/studio/monteur/clips/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(data),
    }),
    /** `{ scheduled_time? }` → `{ clip, scheduled_time }`. 409 unless the clip is in review. */
    approveMonteurClip: (id, data) => API.request(`/studio/monteur/clips/${encodeURIComponent(id)}/approve`, {
        method: 'POST', body: JSON.stringify(data || {}),
    }),
    rejectMonteurClip: (id) => API.request(`/studio/monteur/clips/${encodeURIComponent(id)}/reject`, { method: 'POST' }),
    /** A failed clip, rendered again: `ClipView`, back in `rendering`. */
    rerenderMonteurClip: (id) => API.request(`/studio/monteur/clips/${encodeURIComponent(id)}/rerender`, { method: 'POST' }),
    /** Runs the Analyst now: `LessonsView`. */
    refreshMonteurLessons: () => API.request('/studio/monteur/lessons/refresh', { method: 'POST' }),
    // ─── Infographics (v31, src/services/studio/infographics.ts) ────────────
    /** `{ infographics: InfographicView[] }`, newest first. */
    getInfographics: () => API.request('/studio/infographics'),
    /** `{ topic, notes?, language?, theme? }` (theme dark, light or both) → `InfographicView`, `writing`. */
    createInfographic: (data) => API.request('/studio/infographics', { method: 'POST', body: JSON.stringify(data) }),
    /** `{ spec?, caption? }`: a new spec renders again; a caption alone is only saved. */
    updateInfographic: (id, data) => API.request(`/studio/infographics/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(data),
    }),
    /** `{ theme?, rewrite? }`: the same spec again, in a theme, or written again by Claude. */
    renderInfographic: (id, data) => API.request(`/studio/infographics/${encodeURIComponent(id)}/render`, {
        method: 'POST', body: JSON.stringify(data || {}),
    }),
    /** `{ theme }` → a new `InfographicView`: the same infographic in another theme. */
    copyInfographic: (id, data) => API.request(`/studio/infographics/${encodeURIComponent(id)}/copy`, {
        method: 'POST', body: JSON.stringify(data || {}),
    }),
    /** `{ next_slot, timezone }`: when "the next free slot" would post (ISO, or null when there is none) and the tenant's zone. Read-only. */
    getInfographicNextSlot: () => API.request('/studio/infographics/next-slot'),
    /** `{ scheduled_time? | now? }` → `{ infographic, scheduled_time }`. */
    scheduleInfographic: (id, data) => API.request(`/studio/infographics/${encodeURIComponent(id)}/schedule`, {
        method: 'POST', body: JSON.stringify(data || {}),
    }),
    deleteInfographic: (id) => API.request(`/studio/infographics/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    // ─── Illustrated explainers (v59, src/routes/studio.ts and src/services/explainers/) ───
    // Owner only, behind the platform admin's switch: while it is off every route here answers 404 EXPLAINERS_DISABLED. Their settings are the
    // `explainer` section of PUT /studio/settings, above; the provider and the switch are the /admin/explainers routes, further down.
    // A refusal is the flat envelope `{ error, message, code, params }`: `readError` (above) lifts `code` and `params` onto the Error, and a 429 also carries
    // `retryAt` beside them. A refused script (422 EXPLAINER_DRAFT_REFUSED) adds `findings` and `problems`; a missing picture (409) adds `positions` (0-based).
    /** `{ items: ExplainerSummary[] }`, newest first (60): `{ id, status, title, topic, language, length_tier, est_seconds, progress: { done, total } | null, updated_at, thumb_url }`. No reason, no job, no worker: those are in the explainer. */
    getExplainers: () => API.request('/studio/explainers'),
    /** `{ topic, language?, length_tier?, sound_mode?, music_track_id?, subtitles?, notes?, source_links?: string[] }` -> 201 `Explainer`, `writing`. */
    createExplainer: (data) => API.request('/studio/explainers', { method: 'POST', body: JSON.stringify(data) }),
    /**
     * The explainer: the list's fields and `failed_step`, `error`, `sound_mode`, `music_track_id`, `subtitles`, `notes`, `source_links: [{ url }]`, `draft`, `draft_version`,
     * `audio`, `audio_stale`, `render`, `render_stale`, `schedule: { scheduled_time, group_id, row_ids }`, `draw_paused_until`, `scenes` (0-based `position`),
     * `problems` (what the saved script breaks), `job: { status, progress, not_before } | null`, `worker: { online, lastSeen, name } | null` and `allowance`.
     */
    getExplainer: (id) => API.request(`/studio/explainers/${encodeURIComponent(id)}`),
    /** Any of `{ title, draft: { captions, first_comment, replies, sources }, scenes: SceneEdit[], sound_mode, music_track_id, subtitles }` -> `Explainer`. `scenes` is the whole ordered list. */
    updateExplainer: (id, data) => API.request(`/studio/explainers/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(data),
    }),
    /** `{ note }` (up to 2,000 characters) -> `Explainer`, `writing` again (the previous draft stays visible until the new one lands). Only a `draft` can be rewritten. */
    rewriteExplainer: (id, data) => API.request(`/studio/explainers/${encodeURIComponent(id)}/rewrite`, {
        method: 'POST', body: JSON.stringify(data || {}),
    }),
    /** Gate 1. `{ version }` is the `draft_version` that was read: another number is a 409 `CHANGED_MEANWHILE`; a script that breaks a rule is a 422 `EXPLAINER_DRAFT_REFUSED` with `findings`. -> `Explainer`, `voicing`. */
    approveExplainer: (id, version) => API.request(`/studio/explainers/${encodeURIComponent(id)}/approve`, {
        method: 'POST', body: JSON.stringify({ version }),
    }),
    /** Voices the narration again, once it was edited after the voice was made. -> `Explainer`, `voicing`. */
    revoiceExplainer: (id) => API.request(`/studio/explainers/${encodeURIComponent(id)}/revoice`, { method: 'POST' }),
    /** `{ note? }` -> `{ scene, allowance }`: draws now, in one request (up to 30 s), from the voice until the post and not while it renders. 429 `EXPLAINER_ALLOWANCE_PAUSED` (`retryAt`), 422 `EXPLAINER_PROMPT_REFUSED`, 409 `EXPLAINER_NEEDS_REFERENCE`. */
    drawExplainerScene: (id, position, data) => API.request(`/studio/explainers/${encodeURIComponent(id)}/scenes/${encodeURIComponent(position)}/draw`, {
        method: 'POST', body: JSON.stringify(data || {}),
    }),
    /** `{ index }` (into the scene's `pictures`, the EARLIER ones, newest first) -> `{ scene }`: that picture becomes `picture`, and the one in use takes its place in `pictures`. Nothing is spent. */
    pickExplainerPicture: (id, position, data) => API.request(`/studio/explainers/${encodeURIComponent(id)}/scenes/${encodeURIComponent(position)}/pick`, {
        method: 'POST', body: JSON.stringify(data || {}),
    }),
    /** Queues unattended drawing of every scene still to draw (a loop on the Mac) -> `Explainer`. Only a `drawing` explainer; a drawing already on its way is left alone. */
    drawExplainer: (id) => API.request(`/studio/explainers/${encodeURIComponent(id)}/draw`, { method: 'POST' }),
    /** Gate 2 -> `Explainer`, `rendering`. 409 while a scene has no picture or the audio is out of date. */
    approveExplainerPictures: (id) => API.request(`/studio/explainers/${encodeURIComponent(id)}/approve-pictures`, { method: 'POST' }),
    /** A new render (the previous files stay until it succeeds) -> `Explainer`, `rendering`. */
    renderExplainer: (id) => API.request(`/studio/explainers/${encodeURIComponent(id)}/render`, { method: 'POST' }),
    /** `{ when: 'next' | 'now' | ISO-8601 }` -> `Explainer`, `scheduled`, with `schedule`. 409 `EXPLAINER_RENDER_STALE` for a video made before the latest edits, `NO_FREE_SLOT`, 400 `INVALID_SCHEDULE_TIME`. */
    scheduleExplainer: (id, data) => API.request(`/studio/explainers/${encodeURIComponent(id)}/schedule`, {
        method: 'POST', body: JSON.stringify(data || {}),
    }),
    /** Runs the step that failed again -> `Explainer`. */
    retryExplainer: (id) => API.request(`/studio/explainers/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
    /** 204, no body. */
    deleteExplainer: (id) => API.request(`/studio/explainers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** `{ provider, day, used_units, pictures, cap, est_left, paused_until }`: what today's free allowance has paid for; a JSON `null` when no image provider is set up. */
    getExplainerAllowance: () => API.request('/studio/explainers/allowance'),
    /** `{ description }` -> `{ candidates: [{ media_id, url }] }`: four 448 px pictures of a character (they count against the allowance). */
    createExplainerCandidates: (data) => API.request('/studio/explainers/characters/candidates', {
        method: 'POST', body: JSON.stringify(data || {}),
    }),
    /**
     * `{ purpose: 'music' | 'reference', mime, size }` -> 201 `{ upload_url, media_id, url }`: the browser PUTs the file to `upload_url` itself (never through this app:
     * Vercel takes 4.5 MB). Music is `audio/mpeg`, `audio/mp4` or `audio/wav`, a reference `image/png` or `image/jpeg`, up to 25 MB. The owner's, not an operator's.
     */
    signExplainerUpload: (data) => API.request('/studio/explainers/uploads/sign', { method: 'POST', body: JSON.stringify(data) }),
    // Platform admin only (Settings -> Platform -> Explainers).
    /** `{ enabled: { <tenantId>: boolean }, provider: { provider, account_id, token_last4, model, daily_cap, units_per_picture } }`. The token is never sent back, only its last four. */
    getAdminExplainers: () => API.request('/admin/explainers'),
    /** `{ account_id, token?, daily_cap?, units_per_picture? }` -> the same as the read. A token left out stays as it is. */
    saveAdminExplainersProvider: (data) => API.request('/admin/explainers/provider', { method: 'PUT', body: JSON.stringify(data) }),
    /** `{ tenant_id, enabled }` -> the same as the read. Switching a workspace other than the owner's on is a 409 `EXPLAINERS_OWNER_ONLY`. */
    setAdminExplainersEnabled: (data) => API.request('/admin/explainers/enabled', { method: 'PUT', body: JSON.stringify(data) }),
    /** Draws one 256 px test picture (it counts against the allowance) -> `{ ok, ms, error? }`. */
    testAdminExplainersProvider: () => API.request('/admin/explainers/provider/test', { method: 'POST' }),
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
    /** The whole settings: keywords, hashtag_sets, competitors, audience, goal_followers, goal_views. */
    saveGrowthSettings: (data) => API.request('/growth/settings', { method: 'PUT', body: JSON.stringify(data) }),
    /** `{ keywords: { term, why }[], hashtags: string[] }` — ideas to verify, not search-volume data. */
    suggestGrowthKeywords: (topic) => API.request('/growth/keywords/suggest', {
        method: 'POST', body: JSON.stringify({ topic }),
    }),
    /** Instagram Business Discovery for each saved competitor username. */
    getGrowthCompetitors: () => API.request('/growth/competitors'),

    // ─── Boost: Meta ads for a published post (the tenant OWNER's; a 403 means "hide Boost", never an error) ───
    // Budgets are in MAJOR units of the ad account's currency. Everything is created PAUSED: only `activateBoost` spends money.
    // Every /ads route answers 404 `ADS_DISABLED` while Ads is off for the tenant: callers treat it like a 403 (nothing is offered). Errors are
    // `{ error, code, field?, retryAt? }` (`retryAt`: an ISO time, on RATE_LIMITED and EDIT_LIMIT). The reads are any member's, the writes the owner's.
    /**
     * The SettingsView: `{ enabled, configured, steps: [{ id: 'token'|'account'|'payment'|'limits', done, hint }], adAccountId,
     * token: { set, last4, source, expiresAt, health }, account (the copy stored by the last check: { name, currency, status, hasPaymentMethod,
     * isPrepay, amountSpent, minDailyBudget, syncedAt, ... }) | null, accountError, limits: { maxDailyBudget, monthlyCap },
     * ceiling: { maxDailyBudget, monthlyCap } | null, alerts: { telegramChatId, email, lang, kinds, required }, spendCap: { amount, changesLeftToday },
     * switches, helpUrl }`.
     */
    getAdsSettings: () => API.request('/ads/settings'),
    /**
     * Any subset of `{ adAccountId, token, maxDailyBudget, monthlyCap }` ('' clears the id and the token). Answers the settings shape, plus
     * `warnings: ['will_pause_all']` when the new cap is at or below this month's spend (the guard then pauses every active campaign at once).
     * A 400 carries `field`: `INVALID`, or `OVER_CEILING` (the platform admin's limit for this tenant).
     */
    saveAdsSettings: (data) => API.request('/ads/settings', { method: 'POST', body: JSON.stringify(data) }),
    /** LIVE (one or two Meta calls): `{ ok, scopes, missingScopes, assets: { adAccounts, pages, igAccounts }, tier, servedVersion, settings }`. 409 `TOKEN_INVALID` (never 401) or `ADS_NOT_CONFIGURED`, 429 `RATE_LIMITED`. */
    testAdsSettings: () => API.request('/ads/settings/test', { method: 'POST' }),
    /** `{ telegramChatId?, email?, lang?, kinds?: { [kind]: boolean }, test? }` → `{ alerts, test?: { telegram, email } }`, each 'sent' | 'failed' | 'off'. A 400 carries `field`. */
    saveAdsAlerts: (data) => API.request('/ads/settings/alerts', { method: 'POST', body: JSON.stringify(data) }),
    /** A3's two switches: `{ botContext?, extendedWindow?: { instagram?, messenger? } }` → `{ switches }`. Owner only; 400 `INVALID` names the field. */
    saveAdsSwitches: (data) => API.request('/ads/settings/switches', { method: 'POST', body: JSON.stringify(data) }),
    /** Meta's own spending limit on the ad account: `{ amount: number|null (null clears), confirm: true }` → `{ op, spendCap: { amount, changesLeftToday }, verified }`. 429 `EDIT_LIMIT`. */
    setAdsSpendCap: (data) => API.request('/ads/spend-cap', { method: 'POST', body: JSON.stringify(data) }),
    /**
     * What the month's cap has left, from Meta's own numbers: `{ currency, fits, remaining, worstCase, spentThisMonth, monthlyCap, maxDailyBudget,
     * reason: 'OVER_MONTHLY_CAP'|'OVER_DAILY_MAX'|'NOT_CONFIGURED'|'UNREADABLE'|null, monthBoundaryTz, excludesTax }`. `candidate` is
     * `daily:<amount>:<days>` or `lifetime:<amount>:<days>`; without it `fits` only says whether anything can be added. Cached ~60 s on the server.
     */
    getAdsMoney: (candidate) => API.request(`/ads/money${candidate ? `?candidate=${encodeURIComponent(candidate)}` : ''}`),
    /** `{ accounts: [{ id, name, currency, status }] }` (status 1 = active): the list STORED by the last Test connection, no Meta call. */
    getAdsAccounts: () => API.request('/ads/accounts'),
    /** `{ boosts }`, newest first. */
    getAdsBoosts: () => API.request('/ads/boosts'),
    /** `{ eligible: boolean|null, reason }` for one published post on one platform (`instagram` | `facebook`). */
    getAdsEligibility: (postId, platform) => API.request(
        `/ads/eligibility?postId=${encodeURIComponent(postId)}&platform=${encodeURIComponent(platform)}`
    ),
    /** `{ postId, platform, dailyBudget, days, objective, country, link? }` → 201 `{ boost }`, PAUSED (spends nothing). */
    createBoost: (data) => API.request('/ads/boosts', { method: 'POST', body: JSON.stringify(data) }),
    /** THIS STARTS SPENDING MONEY: the caller has asked first. */
    activateBoost: (id) => API.request(`/ads/boosts/${encodeURIComponent(id)}/activate`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
    pauseBoost: (id) => API.request(`/ads/boosts/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
    deleteBoost: (id) => API.request(`/ads/boosts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** Re-reads the spend and insights from Meta. */
    refreshBoost: (id) => API.request(`/ads/boosts/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),

    // ─── Ads screen (#/ads): every campaign on the ad account, not only the boosts. The tenant OWNER's. ───
    /**
     * Not configured: `{ configured: false, steps, money: null }` (200, not an error). Configured: `{ configured, account, accountError, spend, limits,
     * campaigns, steps, money: { currency, spentToday, spentThisMonth, worstCaseThisMonth, monthlyCap, remaining, maxDailyBudget, monthBoundaryTz },
     * tokenHealth: 'ok'|'expiring'|'dead'|'unknown', guard: { lastCheckedAt, blind } }`.
     */
    getAdsOverview: () => API.request('/ads/overview'),

    // ─── Ads → Campaigns (#/ads_campaigns): the stored copy of the ad account, and the queue every change goes through ───
    /** `{ level?, status?, parentId? }` (a list is joined with commas) → `{ items: ObjectView[], syncedAt }`. Read from Postgres: no call to Meta. */
    getAdsObjects: (params) => {
        const query = new URLSearchParams();
        Object.keys(params || {}).forEach((key) => {
            const value = params[key];
            if (value === undefined || value === null || value === '') return;
            query.set(key, Array.isArray(value) ? value.join(',') : String(value));
        });
        const search = query.toString();
        return API.request(`/ads/objects${search ? `?${search}` : ''}`);
    },
    /** `{ object, children, results: { daily, totals } }`: one object and what is inside it (a campaign's ad sets, an ad set's ads). */
    getAdsObject: (id) => API.request(`/ads/objects/${encodeURIComponent(id)}`),
    /** `{ status: 'ACTIVE' | 'PAUSED', confirm? }` → `{ op }`. ACTIVE starts spending money: `confirm: true` only after the owner said yes. */
    setAdsObjectStatus: (id, body) => API.request(`/ads/objects/${encodeURIComponent(id)}/status`, { method: 'POST', body: JSON.stringify(body || {}) }),
    /** `{ kind: 'daily' | 'lifetime', amount, endTime?, confirm? }` → `{ op }`. A raise on a running object needs `confirm: true`; EDIT_LIMIT and RATE_LIMITED carry `retryAt`. */
    setAdsObjectBudget: (id, body) => API.request(`/ads/objects/${encodeURIComponent(id)}/budget`, { method: 'POST', body: JSON.stringify(body || {}) }),
    /** → `{ op }`. */
    archiveAdsObject: (id) => API.request(`/ads/objects/${encodeURIComponent(id)}/archive`, { method: 'POST' }),
    /** `{ confirm: true }` → `{ op }`. The server refuses an object that is ACTIVE (409). */
    deleteAdsObject: (id, body) => API.request(`/ads/objects/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify(body || {}) }),
    /** `{ op }`: `{ id, kind, state, objectKey, notBefore, attempts, result, createdAt, finishedAt, actorVia }`. */
    getAdsOp: (id) => API.request(`/ads/ops/${encodeURIComponent(id)}`),
    /** `{ ops }` in the given states (`['pending', 'running', 'verify']`). */
    getAdsOps: (states) => API.request(`/ads/ops${Array.isArray(states) && states.length ? `?state=${states.map(encodeURIComponent).join(',')}` : ''}`),
    /** Asks for a results refresh from Meta (the owner's). 429 `RATE_LIMITED` with `retryAt` when one ran in the last 15 minutes. */
    requestAdsSync: () => API.request('/ads/sync', { method: 'POST' }),
    /**
     * Ads → Results (#/ads_results, A6): `{ level?, ids?, from?, to?, breakdown? }` (ids an array or a comma list) → per-day results from the stored
     * copy, never Meta: `{ currency, currencies, rows, appDaily, perObject, totals: { byCurrency }, appJoins, objects, syncedAt, provisionalFrom }`.
     */
    getAdsResults: (params) => {
        const query = new URLSearchParams();
        Object.keys(params || {}).forEach((key) => {
            const value = params[key];
            if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) return;
            query.set(key, Array.isArray(value) ? value.join(',') : String(value));
        });
        const search = query.toString();
        return API.request(`/ads/results${search ? `?${search}` : ''}`);
    },

    // ─── Ad builder (A4): the policy check, Meta's validation and the draft. A `CampaignSpec` is in MAJOR units of the account's currency. ───
    /** `{ fields: { caption?, greeting?, 'iceBreakers.0.title'?, ... } }` -> `{ version, blocked, findings }`. No Meta call: safe to ask as the owner types (the page waits 400 ms). */
    checkAdsPolicy: (fields) => API.request('/ads/policy', { method: 'POST', body: JSON.stringify({ fields }) }),
    /** A `CampaignSpec` -> `{ policy: { blocked, findings }, money: { fits, remaining, reason, currency }, meta: { ok, error?, minimumBudget }, problems: [{ field, code, message }], warnings: [{ code, field, message }], bots: [{ destination, state: 'on'|'test'|'off'|'not_connected' }] }`. Creates nothing. */
    validateAdsDraft: (spec) => API.request('/ads/drafts/validate', { method: 'POST', body: JSON.stringify({ spec }) }),
    /** Creates the draft PAUSED (spends nothing) -> 201 `{ campaignId, ops }`. Refusals carry a `code`: `POLICY_BLOCKED` (`err.body.findings`), `OVER_MONTHLY_CAP`, `OVER_DAILY_MAX`, `BELOW_META_MINIMUM`, `INVALID` (`err.body.field`), `UNSUPPORTED`, `META_ERROR`, `RATE_LIMITED`. `confirmPolicyWarnings` is true only after the owner ticked "I have read the warnings". */
    createAdsDraft: (spec, confirmPolicyWarnings) => API.request('/ads/drafts', { method: 'POST', body: JSON.stringify({ spec, confirmPolicyWarnings: !!confirmPolicyWarnings }) }),

    // ─── The full builder (A5, #/ads_create) ───
    /** `{ filename, mime, size }` → 201 `{ mediaId, url, upload: { method: 'PUT', url, headers }, expiresAt }`: the browser PUTs the file to `upload.url` itself (never through this app: Vercel takes 4.5 MB). 400 names `field` (mime | size). */
    signAdsUpload: (data) => API.request('/ads/uploads/sign', { method: 'POST', body: JSON.stringify(data) }),
    /** `{ mediaId, kind: 'image'|'video', coverMediaId? }` → `{ media: { mediaId, kind, imageHash?, videoId?, videoStatus?, coverUrl? } }`: the upload handed to Meta. A video needs its cover. */
    prepareAdsMedia: (data) => API.request('/ads/creatives/from-media', { method: 'POST', body: JSON.stringify(data) }),
    /** `type`: adinterest | adgeolocation (cities) | adlocale → `{ items: [{ id, name, type, sizeLower?, sizeUpper?, countryCode?, region? }] }`. Cached a day on the server. */
    searchAdsTargeting: (type, q) => API.request(`/ads/targeting/search?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}`),
    /** `{ currency, byGoal: { messages, engagement, reach, traffic }, syncedAt }`: Meta's minimum daily budget, in major units. */
    getAdsMinimumBudgets: () => API.request('/ads/minimum-budgets'),
    /** `{ deep? }` → `{ op }`: a PAUSED copy of a campaign, ad set or ad, named as a copy. */
    duplicateAdsObject: (id, body) => API.request(`/ads/objects/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: JSON.stringify(body || {}) }),

    // ─── AI proposals (A7): Claude drafts, a person approves. Nothing is created or changed before approve; a new campaign is created PAUSED. ───
    /** `{ request }` (the owner's words) or `{ postId, platform }` → 202 `{ proposal }` (state `drafting`). 409 `AI_NOT_CONFIGURED` when no AI is set up for the tenant. */
    requestAdsProposal: (body) => API.request('/ads/proposals', { method: 'POST', body: JSON.stringify(body || {}) }),
    /** `states` (an array) → `{ proposals: ProposalView[] }`, newest first. */
    getAdsProposals: (states) => API.request(`/ads/proposals${Array.isArray(states) && states.length ? `?state=${states.map(encodeURIComponent).join(',')}` : ''}`),
    getAdsProposal: (id) => API.request(`/ads/proposals/${encodeURIComponent(id)}`),
    /** `{ confirm: true }` is sent only after the owner said yes. → `{ proposal, ops }`. Refusals: POLICY_BLOCKED (`findings`), OVER_MONTHLY_CAP, OVER_DAILY_MAX, BELOW_META_MINIMUM, META_ERROR, NOT_WIRED. */
    approveAdsProposal: (id, edits) => API.request(`/ads/proposals/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify(edits ? { confirm: true, edits } : { confirm: true }) }),
    rejectAdsProposal: (id, reason) => API.request(`/ads/proposals/${encodeURIComponent(id)}/reject`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }),
    /** A8 → `{ audiences, tosAccepted, tosUrl, customerList, retentionMaxDays }`. */
    getAdsAudiences: () => API.request('/ads/audiences'),
    getAdsAudienceSources: () => API.request('/ads/audiences/sources'),
    /** `{ kind, name, spec }` → 202 `{ audience, op }`. Refusals: INVALID (`field`, `reason`), TERMS_NOT_ACCEPTED (`tosUrl`), SEED_TOO_SMALL, AUDIENCE_NOT_USABLE. */
    createAdsAudience: (body) => API.request('/ads/audiences', { method: 'POST', body: JSON.stringify(body || {}) }),
    /** The list text goes in the body of this one request and nowhere else. LOCKED_LEGAL without a recorded sign-off. */
    uploadAdsCustomerList: (body) => API.request('/ads/audiences/customer-list', { method: 'POST', body: JSON.stringify(body || {}) }),
    deleteAdsAudience: (id) => API.request(`/ads/audiences/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }),
    recordAdsAudienceOptOut: (contact) => API.request('/ads/audiences/opt-outs', { method: 'POST', body: JSON.stringify({ contact }) }),
    /** A9 → `{ rules, templates, limits, currency }`. */
    getAdsRules: () => API.request('/ads/rules'),
    /** Saving is approving. Refusals: INVALID (`field`). */
    createAdsRule: (rule) => API.request('/ads/rules', { method: 'POST', body: JSON.stringify(rule || {}) }),
    updateAdsRule: (id, patch) => API.request(`/ads/rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch || {}) }),
    deleteAdsRule: (id) => API.request(`/ads/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** `{ runs }`: the last 50 checks, newest first. */
    getAdsRuleRuns: (id) => API.request(`/ads/rules/${encodeURIComponent(id)}/runs`),
    /** Lead ads (A10): `{ locked, signoff, retentionDays, forms }`. */
    getAdsLeadForms: () => API.request('/ads/lead-forms'),
    /** FormInput → 201 `{ form }`. LOCKED_LEGAL, RESTRICTED_QUESTION (`field`), NOT_CONNECTED, META_ERROR. */
    createAdsLeadForm: (body) => API.request('/ads/lead-forms', { method: 'POST', body: JSON.stringify(body || {}) }),
    /** Owner only. `{ formId?, from?, to? }` → `{ leads, retentionDays }`: the answers, never stored in the browser. */
    getAdsLeads: (query) => {
        const qs = new URLSearchParams(query || {}).toString();
        return API.request(`/ads/leads${qs ? `?${qs}` : ''}`);
    },
    // ─── Split tests (the Ads screen's Tests tab): Meta A/B tests of two ads or two audiences. The tenant OWNER's. ───
    /** `{ studies: StudyView[], businessId: string|null }`. */
    getAdsStudies: () => API.request('/ads/studies'),
    /** `{ type, name?, cells, dailyBudget, start, end, confirm: true }` → 201 `{ study, ops }`. Creates the test with every arm PAUSED: nothing is spent. */
    createAdsStudy: (data) => API.request('/ads/studies', { method: 'POST', body: JSON.stringify(data) }),
    /** THIS STARTS SPENDING MONEY: the caller has asked first, which is why `confirm: true` is sent here and nowhere else. Answers `{ study, ops }`. */
    startAdsStudy: (id) => API.request(`/ads/studies/${encodeURIComponent(id)}/start`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
    /** Pauses the arms. Answers `{ study, ops }`. */
    stopAdsStudy: (id) => API.request(`/ads/studies/${encodeURIComponent(id)}/stop`, { method: 'POST' }),

    getStudioWorkers: () => API.request('/studio/workers'),
    /** `{ worker, token }` — the token exists in this response and nowhere else, ever. */
    createStudioWorker: (name) => API.request('/studio/workers', { method: 'POST', body: JSON.stringify({ name }) }),
    revokeStudioWorker: (id) => API.request(`/studio/workers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // ─── Settings → Public site (platform admin) ────────────────────────────
    /** `{ whatsappNumber, contactEmail, eidCouponsExpire, whatsappUrl, source: {…} }` */
    getSiteSettings: () => API.request('/settings/site'),
    /** Each field optional; '' clears it. A 400 carries `field` on `err.body`. */
    saveSiteSettings: (data) => API.request('/settings/site', { method: 'POST', body: JSON.stringify(data) }),
    /**
     * Handoff alerts and echo takeover (DM plan S8), a platform admin's alone: `{ telegram: { botToken: { set, last4 }, chatId, enabled,
     * hotLeads, ready }, email: { apiKey: { set, last4 }, to, toIsDefault, from, defaultFrom, enabled, hotLeads, ready }, echo: { takeover,
     * ownerAppIds, documentedAppIds } }`. The token and the key are never sent back.
     */
    getNotifySettings: () => API.request('/settings/notify'),
    /**
     * `{ telegram?: { botToken?, chatId?, enabled?, hotLeads? }, email?: { apiKey?, to?, from?, enabled?, hotLeads? }, echo?: { takeover?, ownerAppIds? } }`.
     * A 400 carries `field` on `err.body`. A save that carries a new `email.apiKey` also switches email on and answers `emailTest`, the result of
     * the one test email the server sent with it (same shape as `testNotifyEmail`).
     */
    saveNotifySettings: (data) => API.request('/settings/notify', { method: 'POST', body: JSON.stringify(data) }),
    /** Sends the test message with what is saved. `{ ok: true }`, or `{ ok: false, reason: 'not_configured' | 'rejected' | 'unreachable', status, description }`. */
    testNotify: (lang) => API.request('/settings/notify/test', { method: 'POST', body: JSON.stringify({ lang }) }),
    /** The same for the email address (Resend), with what is saved. `{ ok: true }`, or `{ ok: false, reason: 'not_configured' | 'rejected' | 'unreachable', status, description }`. */
    testNotifyEmail: (lang) => API.request('/settings/notify/test-email', { method: 'POST', body: JSON.stringify({ lang }) }),
    /** Meta's verify handshake, run by the server against the public webhook URL. `{ ok, reason, status, detail, url }` */
    checkWebhookHandshake: () => API.request('/settings/webhook-token/check', { method: 'POST' }),

    // ─── Settings → Instagram ice breakers and persistent menu (DM plan S13; the tenant's owner only) ───
    /**
     * `{ config: { iceBreakers, menu }, saved, published, inSync, connected: { instagram }, suggestions: { kit, items }, limits, taps }`.
     * Reading sends nothing to Instagram.
     */
    getIceBreakers: () => API.request('/dm/ice-breakers'),
    /** Saves the DRAFT: `{ iceBreakers: [{ question, payload }], menu: [{ type, title, payload | url }] }`. A 400 carries `problems` on `err.body`. Sends nothing to Instagram. */
    saveIceBreakers: (data) => API.request('/dm/ice-breakers', { method: 'PUT', body: JSON.stringify(data) }),
    /** THE publish: the saved draft goes to Instagram. The answer holds `result` and what Instagram holds afterwards (`live`). A refusal from Meta is a 502 with `err.body.metaCode`. */
    publishIceBreakers: () => API.request('/dm/ice-breakers/publish', { method: 'POST' }),
    /** Deletes the ice breakers and the persistent menu from the account's Instagram profile. The draft stays. */
    removeIceBreakers: () => API.request('/dm/ice-breakers/publish', { method: 'DELETE' }),
    /** What Instagram holds right now, read from Meta: `{ live: { iceBreakers, menu } }`. */
    readIceBreakersLive: () => API.request('/dm/ice-breakers/live'),
};
