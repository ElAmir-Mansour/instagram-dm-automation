/**
 * Activity Log Page — paginated interaction history with search/filter.
 */
const ActivityPage = {
    currentPage: 1,
    currentStatus: '',
    currentSearch: '',

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

            const result = await API.getInteractions(params);

            container.innerHTML = `
                <div class="table-card glass-card">
                    <div class="table-header">
                        <div class="filter-bar">
                            <input class="filter-input" id="activity-search" type="text" placeholder="🔍 Search username..." value="${this.currentSearch}" onkeyup="ActivityPage.handleSearch(event)">
                            <select class="filter-select" id="activity-filter" onchange="ActivityPage.handleFilter(this.value)">
                                <option value="" ${!this.currentStatus ? 'selected' : ''}>All Status</option>
                                <option value="SENT" ${this.currentStatus === 'SENT' ? 'selected' : ''}>✅ Sent</option>
                                <option value="FAILED" ${this.currentStatus === 'FAILED' ? 'selected' : ''}>❌ Failed</option>
                                <option value="PENDING" ${this.currentStatus === 'PENDING' ? 'selected' : ''}>⏳ Pending</option>
                            </select>
                        </div>
                        <span style="font-size:12px;color:var(--text-muted);">${result.pagination.total} results</span>
                    </div>
                    <div class="table-wrapper">
                        <table class="data-table">
                            <thead><tr>
                                <th>Username</th><th>Keyword</th><th>Post ID</th><th>Status</th><th>Error</th><th>Time</th>
                            </tr></thead>
                            <tbody>
                                ${result.data.map(i => `
                                    <tr>
                                        <td><a href="https://instagram.com/${i.sender_username}" target="_blank" class="username-link">@${i.sender_username}</a></td>
                                        <td style="color:var(--accent);font-weight:500;">${i.trigger_keyword || '—'}</td>
                                        <td style="font-size:11px;color:var(--text-muted);max-width:120px;overflow:hidden;text-overflow:ellipsis;">${i.post_id || '—'}</td>
                                        <td><span class="status-pill ${i.status.toLowerCase()}">${i.status}</span></td>
                                        <td style="max-width:200px;font-size:11px;color:var(--danger);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${i.error_log || ''}">${i.error_log || '—'}</td>
                                        <td style="white-space:nowrap;">${UI.formatDate(i.timestamp)}</td>
                                    </tr>
                                `).join('')}
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

    goToPage(page) {
        this.currentPage = page;
        this.loadData();
    }
};
