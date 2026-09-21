/**
 * Activity Log Page — paginated interaction history with search/filter.
 */
const ActivityPage = {
    currentPage: 1,
    currentStatus: '',
    currentSearch: '',
    currentPlatform: '',
    currentCampaignId: '',

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader('Loading activity…');
        await this.loadData(container);
    },

    async loadData(container) {
        if (!container) container = document.getElementById('page-container');

        const params = { page: this.currentPage, limit: 15 };
        if (this.currentStatus) params.status = this.currentStatus;
        if (this.currentSearch) params.search = this.currentSearch;
        if (this.currentPlatform) params.platform = this.currentPlatform;
        if (this.currentCampaignId) params.campaign_id = this.currentCampaignId;

        let result;
        let campaigns;
        try {
            [result, campaigns] = await Promise.all([
                API.getInteractions(params),
                API.getCampaigns(),
            ]);
        } catch (err) {
            UI.renderError(
                container,
                { title: 'Could not load the activity log', message: err.message },
                () => this.loadData()
            );
            return;
        }

        const rows = result.data || [];

        container.innerHTML = esc(html`
            <div class="table-card glass-card">
                <div class="table-header" style="flex-wrap:wrap;gap:16px;">
                    <div class="filter-bar" style="width:100%;display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between;align-items:center;">
                        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                            <label class="sr-only" for="activity-search">Search by username</label>
                            <input class="filter-input" id="activity-search" type="search" placeholder="🔍 Search username..."
                                   value="${this.currentSearch}">

                            <label class="sr-only" for="activity-platform-filter">Filter by platform</label>
                            <select class="filter-select" id="activity-platform-filter" data-change="activity:handlePlatformFilter">
                                <option value="" ${!this.currentPlatform ? html.raw('selected') : ''}>All Platforms</option>
                                <option value="instagram" ${this.currentPlatform === 'instagram' ? html.raw('selected') : ''}>Instagram</option>
                                <option value="facebook" ${this.currentPlatform === 'facebook' ? html.raw('selected') : ''}>Facebook</option>
                            </select>

                            <label class="sr-only" for="activity-campaign-filter">Filter by campaign</label>
                            <select class="filter-select" id="activity-campaign-filter" data-change="activity:handleCampaignFilter">
                                <option value="" ${!this.currentCampaignId ? html.raw('selected') : ''}>All Campaigns</option>
                                ${(campaigns || []).map((c) => html`
                                    <option value="${c.id}" ${this.currentCampaignId === c.id ? html.raw('selected') : ''}>Keyword: ${String(c.trigger_keyword || '').split(',')[0]}</option>
                                `)}
                            </select>

                            <label class="sr-only" for="activity-filter">Filter by status</label>
                            <select class="filter-select" id="activity-filter" data-change="activity:handleFilter">
                                <option value="" ${!this.currentStatus ? html.raw('selected') : ''}>All Status</option>
                                <option value="SENT" ${this.currentStatus === 'SENT' ? html.raw('selected') : ''}>✅ Sent</option>
                                <option value="FAILED" ${this.currentStatus === 'FAILED' ? html.raw('selected') : ''}>❌ Failed</option>
                                <option value="PENDING" ${this.currentStatus === 'PENDING' ? html.raw('selected') : ''}>⏳ Pending</option>
                            </select>
                        </div>

                        <button type="button" class="btn btn-secondary btn-sm flex-center gap-2" data-action="activity:handleExport">
                            <i data-lucide="download" style="width:14px;height:14px;" aria-hidden="true"></i>
                            <span>Export CSV</span>
                        </button>
                    </div>
                    <span style="font-size:12px;color:var(--text-muted);">${result.pagination.total} results</span>
                </div>
                <div class="table-wrapper">
                    <table class="data-table">
                        <thead><tr>
                            <th scope="col">Username</th><th scope="col">Keyword</th><th scope="col">Post ID</th>
                            <th scope="col">Status</th><th scope="col">Error</th><th scope="col">Time</th>
                        </tr></thead>
                        <tbody>
                            ${rows.map((i) => html`
                                <tr>
                                    <td>${UI.userCell(i)}</td>
                                    <td style="color:var(--accent);font-weight:500;" dir="auto">${i.trigger_keyword || '—'}</td>
                                    <td class="cell-post-id">${i.post_id || '—'}</td>
                                    <td><span class="status-pill ${String(i.status || '').toLowerCase()}">${i.status}</span></td>
                                    <td class="cell-error" title="${i.error_log || ''}" dir="auto">${i.error_log || '—'}</td>
                                    <td style="white-space:nowrap;">${UI.formatDate(i.timestamp)}</td>
                                </tr>
                            `)}
                            ${rows.length === 0
                                ? html`<tr><td colspan="6" class="table-empty-cell">No interactions found.</td></tr>`
                                : ''}
                        </tbody>
                    </table>
                </div>
                ${result.pagination.totalPages > 1 ? html`
                    <nav class="pagination" aria-label="Activity log pages">
                        <button type="button" class="page-btn" ${this.currentPage <= 1 ? html.raw('disabled') : ''}
                                data-action="activity:goToPage" data-page="${this.currentPage - 1}">← Prev</button>
                        <span style="font-size:13px;color:var(--text-secondary);">Page ${result.pagination.page} of ${result.pagination.totalPages}</span>
                        <button type="button" class="page-btn" ${this.currentPage >= result.pagination.totalPages ? html.raw('disabled') : ''}
                                data-action="activity:goToPage" data-page="${this.currentPage + 1}">Next →</button>
                    </nav>
                ` : ''}
            </div>
        `);

        UI.icons(container);

        // Enter-to-search (keyup has no delegated hook, so bind it directly)
        const search = document.getElementById('activity-search');
        if (search) {
            search.addEventListener('keyup', (e) => {
                if (e.key !== 'Enter') return;
                this.currentSearch = e.target.value;
                this.currentPage = 1;
                this.loadData();
            });
        }
    },

    handleFilter(value) {
        this.currentStatus = value;
        this.currentPage = 1;
        this.loadData();
    },

    handlePlatformFilter(value) {
        this.currentPlatform = value;
        this.currentPage = 1;
        this.loadData();
    },

    handleCampaignFilter(value) {
        this.currentCampaignId = value;
        this.currentPage = 1;
        this.loadData();
    },

    async handleExport(btn) {
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;margin:0;"></div><span>Preparing…</span>';
        try {
            const params = {};
            if (this.currentStatus) params.status = this.currentStatus;
            if (this.currentSearch) params.search = this.currentSearch;
            if (this.currentPlatform) params.platform = this.currentPlatform;
            if (this.currentCampaignId) params.campaign_id = this.currentCampaignId;
            await API.exportInteractions(params);
        } catch (err) {
            UI.toast(err.message || 'Export failed.', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
            UI.icons(btn);
        }
    },

    goToPage(page) {
        this.currentPage = page;
        this.loadData();
    },
};

UI.registerActions('activity', {
    handleFilter: (el) => ActivityPage.handleFilter(el.value),
    handlePlatformFilter: (el) => ActivityPage.handlePlatformFilter(el.value),
    handleCampaignFilter: (el) => ActivityPage.handleCampaignFilter(el.value),
    handleExport: (el) => ActivityPage.handleExport(el),
    goToPage: (el) => ActivityPage.goToPage(parseInt(el.dataset.page, 10)),
});
