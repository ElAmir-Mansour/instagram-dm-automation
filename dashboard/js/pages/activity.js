/**
 * Activity Log — paginated interaction history with search and filters.
 *
 * The six-column table is the right shape on a desktop and the wrong one on a
 * phone: at 375px it was a horizontally scrolling strip where the status —
 * the only column anyone scans for — sat off-screen. Below 768px the same
 * rows render as cards instead (CSS decides which of the two is displayed, so
 * there is one data path and no resize listener).
 */
const ActivityPage = {
    currentPage: 1,
    currentStatus: '',
    currentSearch: '',
    currentPlatform: '',
    currentCampaignId: '',

    /**
     * Tenant switch: page number and search are stale, and currentCampaignId is
     * a row id that does not exist in the new tenant — leaving it filters the
     * log down to nothing with no visible reason.
     */
    resetTenantState() {
        this.currentPage = 1;
        this.currentStatus = '';
        this.currentSearch = '';
        this.currentPlatform = '';
        this.currentCampaignId = '';
    },

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();
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
            UI.renderError(container, { title: t('activity.errorTitle'), message: err.message }, () => this.loadData());
            return;
        }

        const rows = result.data || [];

        container.innerHTML = esc(html`
            <div class="table-card surface">
                <div class="table-header">
                    <div class="filter-bar grow">
                        <label class="sr-only" for="activity-search">${t('activity.searchLabel')}</label>
                        <input class="field" id="activity-search" type="search"
                               placeholder="${t('activity.searchPlaceholder')}" value="${this.currentSearch}" dir="auto">

                        <label class="sr-only" for="activity-platform-filter">${t('activity.platformFilter')}</label>
                        <select class="select" id="activity-platform-filter" data-change="activity:handlePlatformFilter">
                            <option value="" ${!this.currentPlatform ? html.raw('selected') : ''}>${t('activity.allPlatforms')}</option>
                            <option value="instagram" ${this.currentPlatform === 'instagram' ? html.raw('selected') : ''}>${t('common.instagram')}</option>
                            <option value="facebook" ${this.currentPlatform === 'facebook' ? html.raw('selected') : ''}>${t('common.facebook')}</option>
                        </select>

                        <label class="sr-only" for="activity-campaign-filter">${t('activity.campaignFilter')}</label>
                        <select class="select" id="activity-campaign-filter" data-change="activity:handleCampaignFilter">
                            <option value="" ${!this.currentCampaignId ? html.raw('selected') : ''}>${t('activity.allCampaigns')}</option>
                            ${(campaigns || []).map((c) => html`
                                <option value="${c.id}" ${this.currentCampaignId === c.id ? html.raw('selected') : ''}>${
                                    t('activity.campaignOption', { keyword: String(c.trigger_keyword || '').split(',')[0] })
                                }</option>
                            `)}
                        </select>

                        <label class="sr-only" for="activity-filter">${t('activity.statusFilter')}</label>
                        <select class="select" id="activity-filter" data-change="activity:handleFilter">
                            <option value="" ${!this.currentStatus ? html.raw('selected') : ''}>${t('activity.allStatuses')}</option>
                            <option value="SENT" ${this.currentStatus === 'SENT' ? html.raw('selected') : ''}>${t('common.sent')}</option>
                            <option value="FAILED" ${this.currentStatus === 'FAILED' ? html.raw('selected') : ''}>${t('common.failed')}</option>
                            <option value="PENDING" ${this.currentStatus === 'PENDING' ? html.raw('selected') : ''}>${t('common.pending')}</option>
                        </select>
                    </div>

                    <div class="row gap-3 row--wrap">
                        <span class="text-meta">${t('activity.results', { count: UI.formatNumber(result.pagination.total) })}</span>
                        <button type="button" class="btn btn-secondary btn-sm" data-action="activity:handleExport">
                            <i data-lucide="download" aria-hidden="true"></i>
                            <span>${t('activity.export')}</span>
                        </button>
                    </div>
                </div>

                <div class="table-wrapper log-table">
                    <table class="data-table">
                        <thead><tr>
                            <th scope="col">${t('table.user')}</th>
                            <th scope="col">${t('table.keyword')}</th>
                            <th scope="col">${t('table.postId')}</th>
                            <th scope="col">${t('table.status')}</th>
                            <th scope="col">${t('table.error')}</th>
                            <th scope="col">${t('table.time')}</th>
                        </tr></thead>
                        <tbody>
                            ${rows.map((i) => html`
                                <tr>
                                    <td>${UI.userCell(i)}</td>
                                    <td dir="auto">${i.trigger_keyword || '—'}</td>
                                    <td class="cell-id truncate">${i.post_id ? UI.ltr(i.post_id) : '—'}</td>
                                    <td><span class="status-pill ${String(i.status || '').toLowerCase()}">${UI.statusLabel(i.status)}</span></td>
                                    <td class="cell-error truncate" title="${i.error_log || ''}" dir="auto">${i.error_log || '—'}</td>
                                    <td class="nowrap">${UI.formatDate(i.timestamp)}</td>
                                </tr>
                            `)}
                            ${rows.length === 0
                                ? html`<tr><td colspan="6" class="table-empty-cell">${t('activity.none')}</td></tr>`
                                : ''}
                        </tbody>
                    </table>
                </div>

                <!-- Same rows, phone shape. CSS shows exactly one of the two. -->
                <div class="log-cards">
                    ${rows.map((i) => html`
                        <article class="log-card">
                            <div class="log-card-head">
                                <span>${UI.userCell(i)}</span>
                                <span class="status-pill ${String(i.status || '').toLowerCase()}">${UI.statusLabel(i.status)}</span>
                            </div>
                            <p class="text-meta" dir="auto">${t('table.keyword')}: ${i.trigger_keyword || '—'}</p>
                            ${i.error_log ? html`<p class="text-meta text-danger" dir="auto">${i.error_log}</p>` : ''}
                            <p class="text-meta">${UI.formatDate(i.timestamp)}</p>
                        </article>
                    `)}
                    ${rows.length === 0 ? html`<p class="table-empty-cell">${t('activity.none')}</p>` : ''}
                </div>

                ${result.pagination.totalPages > 1 ? html`
                    <nav class="pagination" aria-label="${t('activity.pagesLabel')}">
                        <button type="button" class="page-btn" ${this.currentPage <= 1 ? html.raw('disabled') : ''}
                                data-action="activity:goToPage" data-page="${this.currentPage - 1}">
                            <i data-lucide="chevron-left" aria-hidden="true"></i> ${t('activity.prev')}
                        </button>
                        <span class="page-position">${t('activity.pages', {
                            page: UI.formatNumber(result.pagination.page),
                            total: UI.formatNumber(result.pagination.totalPages),
                        })}</span>
                        <button type="button" class="page-btn" ${this.currentPage >= result.pagination.totalPages ? html.raw('disabled') : ''}
                                data-action="activity:goToPage" data-page="${this.currentPage + 1}">
                            ${t('activity.next')} <i data-lucide="chevron-right" aria-hidden="true"></i>
                        </button>
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
        btn.innerHTML = UI.buttonSpinner(t('activity.exporting'));
        try {
            const params = {};
            if (this.currentStatus) params.status = this.currentStatus;
            if (this.currentSearch) params.search = this.currentSearch;
            if (this.currentPlatform) params.platform = this.currentPlatform;
            if (this.currentCampaignId) params.campaign_id = this.currentCampaignId;
            await API.exportInteractions(params);
        } catch (err) {
            UI.toast(err.message || t('activity.exportFailed'), 'error');
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
