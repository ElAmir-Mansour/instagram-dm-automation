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
     * Guards a write against landing after the operator has navigated away, or
     * after a later filter change has superseded this one.
     *
     * `App.navigate` guards its own steps with `_navSeq`, but it calls
     * `render()` fire-and-forget and `#page-container` is only ever refilled,
     * never replaced — so a request that was in flight when the operator left
     * writes this page's markup into whatever page now owns the container.
     * Same shape as OverviewPage.
     */
    _seq: 0,

    destroy() {
        this._seq++;
    },

    /**
     * Is anything narrowing the log right now?
     *
     * Four filters sit above this table and all four persist across a page
     * step, a navigation away and back, and a browser refresh of the same hash.
     * When they combined to zero rows the table said "No interactions found." —
     * the same sentence a genuinely quiet account gets — so the operator's own
     * campaign filter from ten minutes ago read as "the automation has stopped
     * working". The inbox already tells its two empties apart (`noMatch` vs
     * `noThreads`); this is the same distinction, plus the way out.
     *
     * Kept as a predicate rather than inlined four times because the empty
     * message, the Clear button and the test all have to agree on what
     * "filtered" means.
     */
    hasFilters() {
        return !!(this.currentStatus || this.currentSearch || this.currentPlatform || this.currentCampaignId);
    },

    /** Drop every filter and go back to page one. */
    clearFilters() {
        if (!this.hasFilters()) return;
        this.currentStatus = '';
        this.currentSearch = '';
        this.currentPlatform = '';
        this.currentCampaignId = '';
        this.currentPage = 1;
        this.loadData();
    },

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

    /** 15 rows, which is exactly this page's limit, so the table's height is
     *  final before a single row of data has arrived. */
    skeleton() {
        return html`
            ${Motion.tableCard(15, [
                t('table.user'), t('table.keyword'), t('table.postId'),
                t('table.status'), t('table.error'), t('table.time'),
            ])}
            ${Motion.busy()}
        `;
    },

    async render() {
        await this.loadData(document.getElementById('page-container'));
    },

    async loadData(container) {
        if (!container) container = document.getElementById('page-container');

        // Every filter change, every Enter in the search box and every page
        // step re-enters here and rebuilds the card — which is why the focus
        // token is taken BEFORE the request and spent after the write. Without
        // it the control the operator just used ceases to exist and they
        // restart from the skip link; two filters in a row was ~15 tabs.
        const focus = UI.captureFocus(container);
        const seq = ++this._seq;
        const live = () => seq === this._seq && !!document.getElementById('page-container');

        // A filter change or a page step re-enters here. The skeleton is only
        // painted if the request outlasts a blink, so paging through a warm
        // endpoint does not strobe.
        const gate = Motion.beginLoad(container, () => this.skeleton());

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
            if (!live()) return;
            gate.done();
            UI.renderError(container, { title: t('activity.errorTitle'), message: err.message }, () => this.loadData());
            return;
        }
        if (!live()) return;
        gate.done();

        const rows = Array.isArray(result && result.data) ? result.data : [];

        // `result.pagination.total` was read straight into the template, so a
        // response without a pagination object threw INSIDE the template
        // literal — past the try/catch, so the operator got a blank page
        // instead of the error panel that exists for exactly this.
        const pagination = result && typeof result.pagination === 'object' && result.pagination
            ? result.pagination
            : null;
        if (!pagination) {
            UI.renderError(container, {
                title: t('activity.errorTitle'),
                message: t('error.unexpected'),
            }, () => this.loadData());
            return;
        }
        const total = Number(pagination.total) || 0;
        const page = Number(pagination.page) || this.currentPage;
        const totalPages = Number(pagination.totalPages) || 0;
        const filtered = this.hasFilters();
        // Zero rows because of the filter bar is a different fact from zero rows
        // because nothing has happened, and only one of them is the operator's
        // to fix. See hasFilters().
        const emptyMessage = filtered ? t('activity.noneFiltered') : t('activity.none');

        container.innerHTML = esc(html`
            <div class="table-card surface">
                <!-- This screen had no heading at all below the page <h1>, so
                     there was nothing to navigate it by. The filter bar is not
                     a title, so the heading is a real one and hidden. -->
                <h2 class="sr-only">${t('nav.activity')}</h2>
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

                    <!-- Two children, not three. Below 768px the stylesheet gives
                         a direct .row child of .table-header space-between, so a
                         bare count + Clear + Export wraps with the count pinned
                         left, Export pinned right and Clear dropped onto a line of
                         its own between them. Grouping the buttons makes the row
                         [count][actions], which wraps as a unit at 375px. -->
                    <div class="row gap-3 row--wrap">
                        <span class="text-meta">${filtered
                            ? t('activity.resultsFiltered', { count: UI.formatNumber(total) })
                            : t('activity.results', { count: UI.formatNumber(total) })}</span>
                        <span class="row gap-2 row--wrap">
                            <!-- Only rendered while something is actually narrowing
                                 the log. A permanently-present "Clear filters" on an
                                 unfiltered table is a control that does nothing, and
                                 its absence is itself the signal that the list in
                                 front of you is complete. -->
                            ${filtered ? UI.button({
                                variant: 'ghost', size: 'sm', icon: 'filter-x',
                                label: t('activity.clearFilters'),
                                action: 'activity:clearFilters', id: 'activity-clear-filters',
                            }) : ''}
                            ${UI.button({
                                variant: 'secondary', size: 'sm', icon: 'download',
                                label: t('activity.export'),
                                action: 'activity:handleExport', id: 'activity-export',
                            })}
                        </span>
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
                                    <!-- The error is clipped by .truncate and the title
                                         tooltip that carried the rest of it is reachable
                                         only with a pointer. The full string is already in
                                         the DOM, so the cell is also made focusable and a
                                         screen reader can read it — but only when it is
                                         genuinely cut off, which revealClipped() measures
                                         after paint, so a clean page gains no tab stops.
                                         The tooltip stays for mouse users. -->
                                    <td class="cell-error truncate" title="${i.error_log || ''}"
                                        dir="auto" data-clip-focus>${i.error_log || '—'}</td>
                                    <td class="nowrap">${UI.formatDate(i.timestamp)}</td>
                                </tr>
                            `)}
                            ${rows.length === 0
                                ? html`<tr><td colspan="6" class="table-empty-cell">${emptyMessage}</td></tr>`
                                : ''}
                        </tbody>
                    </table>
                </div>

                <!-- Same rows, phone shape. CSS shows exactly one of the two. -->
                <div class="log-cards">
                    ${rows.map((i, idx) => html`
                        <!-- An <article> with no accessible name is announced as
                             "article" and nothing else. Named by its own head
                             line, so the name carries the handle's isolation
                             and needs no duplicated copy. -->
                        <article class="log-card" aria-labelledby="log-card-head-${idx}">
                            <div class="log-card-head" id="log-card-head-${idx}">
                                <span>${UI.userCell(i)}</span>
                                <span class="status-pill ${String(i.status || '').toLowerCase()}">${UI.statusLabel(i.status)}</span>
                            </div>
                            <p class="text-meta" dir="auto">${t('table.keyword')}: ${i.trigger_keyword || '—'}</p>
                            ${i.error_log ? html`<p class="text-meta text-danger" dir="auto">${i.error_log}</p>` : ''}
                            <p class="text-meta">${UI.formatDate(i.timestamp)}</p>
                        </article>
                    `)}
                    ${rows.length === 0 ? html`<p class="table-empty-cell">${emptyMessage}</p>` : ''}
                </div>

                ${totalPages > 1 ? html`
                    <nav class="pagination" aria-label="${t('activity.pagesLabel')}">
                        <!-- Stable ids: these two buttons are the ones a keyboard
                             user is holding when the page is rebuilt underneath
                             them, so they are what captureFocus/restoreFocus
                             re-find. -->
                        <button type="button" class="page-btn" id="activity-prev" ${this.currentPage <= 1 ? html.raw('disabled') : ''}
                                data-action="activity:goToPage" data-page="${this.currentPage - 1}">
                            <i data-lucide="chevron-left" aria-hidden="true"></i> ${t('activity.prev')}
                        </button>
                        <span class="page-position">${t('activity.pages', {
                            page: UI.formatNumber(page),
                            total: UI.formatNumber(totalPages),
                        })}</span>
                        <button type="button" class="page-btn" id="activity-next" ${this.currentPage >= totalPages ? html.raw('disabled') : ''}
                                data-action="activity:goToPage" data-page="${this.currentPage + 1}">
                            ${t('activity.next')} <i data-lucide="chevron-right" aria-hidden="true"></i>
                        </button>
                    </nav>
                ` : ''}
            </div>
        `);

        UI.icons(container);
        UI.revealClipped(container);

        // Enter-to-search (keyup has no delegated hook, so bind it directly)
        const search = document.getElementById('activity-search');
        if (search) {
            search.addEventListener('keyup', (e) => {
                if (e.key !== 'Enter') return;
                this.currentSearch = e.target.value;
                this.currentPage = 1;
                this.loadData();
            });
            // `type="search"` draws a native clear (×) in every engine that
            // supports it, and pressing it fires `search`, not Enter — so the
            // control that looks exactly like "cancel this filter" silently
            // did nothing and the operator was left with a box that had
            // visibly been emptied and a table that was still filtered.
            search.addEventListener('search', (e) => {
                if (e.target.value === this.currentSearch) return;
                this.currentSearch = e.target.value;
                this.currentPage = 1;
                this.loadData();
            });
        }

        // Back onto whatever was in use before the rebuild. Stepping to the
        // last page disables Next, so the fallback is the other page button
        // rather than <body> — and clearing the filters removes the Clear
        // button itself, so that one falls back to the search box, which is
        // both always present and where the operator is going next anyway.
        const key = focus && focus.key;
        const fallback = key === 'activity-next' ? 'activity-prev'
            : key === 'activity-prev' ? 'activity-next'
            : key === 'activity-clear-filters' ? 'activity-search' : null;
        UI.restoreFocus(focus, fallback);

        // Motion.busy() said "loading"; nothing said the rows had landed.
        Motion.announce(t('activity.results', { count: UI.formatNumber(total) }));
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
        // Was hand-rolled, and the hand-rolled version set no `aria-busy`, so
        // the spinner was visible and nothing else. `UI.actionBusy` returns null
        // on a second click, which is the double-export guard: this endpoint
        // streams the whole filtered log and a cold start makes the button look
        // completely idle for seconds.
        const restore = UI.actionBusy(btn, t('activity.exporting'));
        if (!restore) return;
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
            restore();
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
    clearFilters: () => ActivityPage.clearFilters(),
    handleExport: (el) => ActivityPage.handleExport(el),
    goToPage: (el) => ActivityPage.goToPage(parseInt(el.dataset.page, 10)),
});
