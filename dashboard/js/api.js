/**
 * API Client — handles all communication with the backend.
 */
const API = {
    baseUrl: '/api',
    token: localStorage.getItem('auth_token') || null,

    setToken(token) {
        this.token = token;
        localStorage.setItem('auth_token', token);
    },

    clearToken() {
        this.token = null;
        localStorage.removeItem('auth_token');
    },

    async request(path, options = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

        const res = await fetch(`${this.baseUrl}${path}`, {
            ...options,
            headers: { ...headers, ...options.headers },
        });

        if (res.status === 401) {
            this.clearToken();
            App.showLogin();
            throw new Error('Session expired');
        }

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
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
    updateCampaign: (id, data) => API.request(`/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteCampaign: (id) => API.request(`/campaigns/${id}`, { method: 'DELETE' }),

    // Interactions
    getInteractions: (params = {}) => {
        const query = new URLSearchParams(params).toString();
        return API.request(`/interactions?${query}`);
    },
    exportInteractions: (params = {}) => {
        const exportParams = { ...params };
        if (API.token) exportParams.token = API.token;
        const query = new URLSearchParams(exportParams).toString();
        window.location.href = `${API.baseUrl}/interactions/export?${query}`;
    },

    // Settings
    getTokenStatus: () => API.request('/settings/token/status'),
    updateToken: (token) => API.request('/settings/token', { method: 'POST', body: JSON.stringify({ token }) }),
    getCreators: () => API.request('/creators'),

    // Posts Scheduler
    getScheduledPosts: () => API.request('/posts/scheduled'),
    createScheduledPost: (data) => API.request('/posts/scheduled', { method: 'POST', body: JSON.stringify(data) }),
    updateScheduledPost: (id, data) => API.request(`/posts/scheduled/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteScheduledPost: (id) => API.request(`/posts/scheduled/${id}`, { method: 'DELETE' }),
    getLivePosts: () => API.request('/posts/live'),
    uploadMedia: (data) => API.request('/upload', { method: 'POST', body: JSON.stringify(data) }),
};
