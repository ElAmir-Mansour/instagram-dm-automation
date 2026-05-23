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
        container.innerHTML = UI.loader();
        await this.loadData(container);
    },

    async loadData(container) {
        if (!container) container = document.getElementById('page-container');
        try {
            const params = { page: this.currentPage, limit: 15 };
            if (this.currentStatus) params.status = this.currentStatus;
            if (this.currentSearch) params.search = this.currentSearch;
            if (this.currentPlatform) params.platform = this.currentPlatform;
            if (this.currentCampaignId) params.campaign_id = this.currentCampaignId;

            const [result, campaigns] = await Promise.all([
                API.getInteractions(params),
                API.getCampaigns()
            ]);

            container.innerHTML = `
                <div class="table-card glass-card">
                    <div class="table-header" style="flex-wrap:wrap;gap:16px;">
                        <div class="filter-bar" style="width:100%;display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between;align-items:center;">
                            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                                <input class="filter-input" id="activity-search" type="text" placeholder="🔍 Search username..." value="${this.currentSearch}" onkeyup="ActivityPage.handleSearch(event)">
                                
                                <select class="filter-select" id="activity-platform-filter" onchange="ActivityPage.handlePlatformFilter(this.value)">
                                    <option value="" ${!this.currentPlatform ? 'selected' : ''}>All Platforms</option>
                                    <option value="instagram" ${this.currentPlatform === 'instagram' ? 'selected' : ''}>Instagram</option>
                                    <option value="facebook" ${this.currentPlatform === 'facebook' ? 'selected' : ''}>Facebook</option>
                                </select>

                                <select class="filter-select" id="activity-campaign-filter" onchange="ActivityPage.handleCampaignFilter(this.value)">
                                    <option value="" ${!this.currentCampaignId ? 'selected' : ''}>All Campaigns</option>
                                    ${campaigns.map(c => `
                                        <option value="${c.id}" ${this.currentCampaignId === c.id ? 'selected' : ''}>Keyword: ${this.escapeHtml(c.trigger_keyword.split(',')[0])}</option>
                                    `).join('')}
                                </select>

                                <select class="filter-select" id="activity-filter" onchange="ActivityPage.handleFilter(this.value)">
                                    <option value="" ${!this.currentStatus ? 'selected' : ''}>All Status</option>
                                    <option value="SENT" ${this.currentStatus === 'SENT' ? 'selected' : ''}>✅ Sent</option>
                                    <option value="FAILED" ${this.currentStatus === 'FAILED' ? 'selected' : ''}>❌ Failed</option>
                                    <option value="PENDING" ${this.currentStatus === 'PENDING' ? 'selected' : ''}>⏳ Pending</option>
                                </select>
                            </div>
                            
                            <button class="btn btn-secondary btn-sm flex-center gap-2" onclick="ActivityPage.handleExport()">
                                <i data-lucide="download" style="width:14px;height:14px;"></i>
                                <span>Export CSV</span>
                            </button>
                        </div>
                        <span style="font-size:12px;color:var(--text-muted);">${result.pagination.total} results</span>
                    </div>
                    <div class="table-wrapper">
                        <table class="data-table">
                            <thead><tr>
                                <th>Username</th><th>Keyword</th><th>Post ID</th><th>Status</th><th>Error</th><th>Time</th>
                            </tr></thead>
                            <tbody>
                                ${result.data.map(i => {
                                    const isFb = i.platform === 'facebook';
                                    const platformBadge = isFb
                                        ? `<span style="font-size:10px;background:#1877F2;color:#fff;padding:2px 6px;border-radius:4px;margin-left:6px;">FB</span>`
                                        : `<span style="font-size:10px;background:#E1306C;color:#fff;padding:2px 6px;border-radius:4px;margin-left:6px;">IG</span>`;
                                    const userCell = isFb
                                        ? `<span class="username-link">@${i.sender_username}</span>${platformBadge}`
                                        : `<a href="https://instagram.com/${i.sender_username}" target="_blank" class="username-link">@${i.sender_username}</a>${platformBadge}`;
                                    return `
                                     <tr>
                                         <td>${userCell}</td>
                                         <td style="color:var(--accent);font-weight:500;">${this.escapeHtml(i.trigger_keyword) || '—'}</td>
                                         <td style="font-size:11px;color:var(--text-muted);max-width:120px;overflow:hidden;text-overflow:ellipsis;">${i.post_id || '—'}</td>
                                         <td><span class="status-pill ${i.status.toLowerCase()}">${i.status}</span></td>
                                         <td style="max-width:200px;font-size:11px;color:var(--danger);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${this.escapeHtml(i.error_log) || ''}">${this.escapeHtml(i.error_log) || '—'}</td>
                                         <td style="white-space:nowrap;">${UI.formatDate(i.timestamp)}</td>
                                     </tr>
                                 `;
                                }).join('')}
                                ${result.data.length === 0 ? '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted);">No interactions found.</td></tr>' : ''}
                            </tbody>
                        </table>
                    </div>
                    ${result.pagination.totalPages > 1 ? `
                        <div class="pagination">
                            <button class="page-btn" ${this.currentPage <= 1 ? 'disabled' : ''} onclick="ActivityPage.goToPage(${this.currentPage - 1})">← Prev</button>
                            <span style="font-size:13px;color:var(--text-secondary);">Page ${result.pagination.page} of ${result.pagination.totalPages}</span>
                            <button class="page-btn" ${this.currentPage >= result.pagination.totalPages ? 'disabled' : ''} onclick="ActivityPage.goToPage(${this.currentPage + 1})">Next →</button>
                        </div>
                    ` : ''}
                </div>
            `;
            lucide.createIcons({ nodes: [container] });
        } catch (err) {
            container.innerHTML = `<div class="empty-state"><i data-lucide="alert-circle"></i><h3>Error</h3><p>${err.message}</p></div>`;
            lucide.createIcons({ nodes: [container] });
        }
    },

    handleSearch(e) {
        if (e.key === 'Enter') {
            this.currentSearch = e.target.value;
            this.currentPage = 1;
            this.loadData();
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

    handleExport() {
        const params = {};
        if (this.currentStatus) params.status = this.currentStatus;
        if (this.currentSearch) params.search = this.currentSearch;
        if (this.currentPlatform) params.platform = this.currentPlatform;
        if (this.currentCampaignId) params.campaign_id = this.currentCampaignId;
        API.exportInteractions(params);
    },

    goToPage(page) {
        this.currentPage = page;
        this.loadData();
    },

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
};
