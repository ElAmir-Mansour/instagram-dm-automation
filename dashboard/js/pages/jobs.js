/**
 * Jobs — platform-admin only. The first visibility the queue has ever had.
 *
 * `jobs` is core infrastructure: scheduled publishing, token refreshes and
 * everything else that must survive a serverless invocation ending goes
 * through it. Until this screen the only way to see a stuck job was to query
 * the table by hand, which means in practice nobody ever did — a job that
 * exhausted its attempts and parked with a `last_error` was invisible.
 *
 * `last_error` is therefore rendered, not truncated away: it is the entire
 * reason the row is interesting. It is a raw provider string, so it is escaped
 * as text and carries `dir="auto"` — it can be English from Meta or Arabic
 * from our own code, in the same column.
 *
 * Retry is cheap and reversible, so it happens on click. Cancel throws work
 * away, so it goes through the styled confirmation.
 *
 * The buttons offer only what the server will do (JB-01, FR-009): it re-queues a
 * job that has STOPPED (failed or cancelled) and cancels one that has not STARTED
 * (pending), and refuses everything else with a 409. A button the server would
 * refuse is disabled and SAYS WHY: in its `title`, in a description the button
 * points at with `aria-describedby`, and, on a phone where a `title` never shows,
 * as a line of text on the card. A refusal that still gets through (the page was
 * stale) is told in the interface language through `UI.errorText` (JB-05).
 */
const JobsPage = {
    jobs: [],
    status: '',
    tenant: '',
    limit: 50,
    tenants: [],

    STATUSES: ['pending', 'running', 'failed', 'done', 'cancelled'],

    resetTenantState() {
        this.jobs = [];
        this.status = '';
        this.tenant = '';
        this.tenants = [];
    },

    skeleton() {
        return html`
            ${Motion.tableCard(8, [
                t('jobs.table.kind'), t('jobs.table.status'), t('jobs.table.attempts'),
                t('jobs.table.runAfter'), t('jobs.table.error'), '',
            ])}
            ${Motion.busy()}
        `;
    },

    render() {
        return this.load();
    },

    async load() {
        const container = document.getElementById('page-container');
        const gate = Motion.beginLoad(container, () => this.skeleton());

        let result;
        try {
            result = await API.getAdminJobs({
                status: this.status, limit: this.limit, tenant: this.tenant,
            });
        } catch (err) {
            gate.done();
            Admin.renderLoadFailure(container, err, {
                unavailableTitle: t('jobs.unavailableTitle'),
                failedTitle: t('jobs.loadFailed'),
                retry: () => this.load(),
            });
            return;
        }
        gate.done();

        this.jobs = Array.isArray(result) ? result : (result && (result.jobs || result.data)) || [];
        // The tenant filter's options: whatever the session can see, which for
        // a platform admin is every tenant.
        this.tenants = (App.session && App.session.tenants) || [];
        this.paint(container);
    },

    paint(container) {
        const rows = this.jobs;

        container.innerHTML = esc(html`
            <section class="section">
            <h2 class="section-title">${t('jobs.listTitle')}</h2>
            <div class="table-card surface">
                <div class="table-header">
                    <div class="filter-bar grow">
                        <label class="sr-only" for="jobs-status">${t('jobs.statusFilter')}</label>
                        <select class="select" id="jobs-status" data-change="jobs:setStatus">
                            <option value="" ${this.status ? '' : html.raw('selected')}>${t('jobs.allStatuses')}</option>
                            ${this.STATUSES.map((s) => html`
                                <option value="${s}" ${this.status === s ? html.raw('selected') : ''}>${t(`jobs.status.${s}`)}</option>
                            `)}
                        </select>

                        ${this.tenants.length > 1 ? html`
                            <label class="sr-only" for="jobs-tenant">${t('jobs.tenantFilter')}</label>
                            <select class="select" id="jobs-tenant" data-change="jobs:setTenant">
                                <option value="" ${this.tenant ? '' : html.raw('selected')}>${t('jobs.allTenants')}</option>
                                ${this.tenants.map((x) => html`
                                    <option value="${x.id}" ${String(this.tenant) === String(x.id) ? html.raw('selected') : ''}>${x.name || x.id}</option>
                                `)}
                            </select>
                        ` : ''}

                        <label class="sr-only" for="jobs-limit">${t('jobs.limitFilter')}</label>
                        <select class="select" id="jobs-limit" data-change="jobs:setLimit">
                            ${[25, 50, 100, 200].map((n) => html`
                                <option value="${n}" ${this.limit === n ? html.raw('selected') : ''}>${t('jobs.limitOption', { count: n })}</option>
                            `)}
                        </select>
                    </div>

                    <div class="row gap-3 row--wrap">
                        <span class="text-meta">${t('jobs.count', { count: rows.length })}</span>
                        <button type="button" class="btn btn-secondary btn-sm" data-action="jobs:load">
                            <i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('ops.refresh')}
                        </button>
                    </div>
                </div>

                ${rows.length === 0
                    ? Admin.emptyState('inbox',
                        this.status ? t('jobs.emptyFilteredTitle') : t('jobs.emptyTitle'),
                        this.status ? t('jobs.emptyFilteredBody') : t('jobs.emptyBody'))
                    : html`
                        <!-- Table on a desktop, cards on a phone. CSS picks one;
                             both are built from the same row renderer's data. -->
                        <div class="table-wrapper jobs-table">
                            <table class="data-table">
                                <thead><tr>
                                    <th scope="col">${t('jobs.table.kind')}</th>
                                    <th scope="col">${t('jobs.table.status')}</th>
                                    <th scope="col">${t('jobs.table.attempts')}</th>
                                    <th scope="col">${t('jobs.table.runAfter')}</th>
                                    <th scope="col">${t('jobs.table.error')}</th>
                                    <th scope="col"><span class="sr-only">${t('tenants.table.actions')}</span></th>
                                </tr></thead>
                                <tbody>${rows.map((j) => this.renderRow(j))}</tbody>
                            </table>
                        </div>
                        <div class="jobs-cards">${rows.map((j) => this.renderCard(j))}</div>
                    `}
            </div>
            </section>
        `);

        UI.icons(container);
        Motion.announce(t('jobs.count', { count: rows.length }));
    },

    // ─── One job, read tolerantly ────────────────────────────────────────────
    read(j) {
        return {
            id: Admin.pick(j, 'id', 'job_id'),
            kind: Admin.pick(j, 'kind', 'type', 'name') || '—',
            status: String(Admin.pick(j, 'status') || '').toLowerCase(),
            attempts: Admin.num(j, 'attempts'),
            maxAttempts: Admin.num(j, 'max_attempts', 'maxAttempts'),
            runAfter: Admin.pick(j, 'run_after', 'runAfter'),
            claimedAt: Admin.pick(j, 'claimed_at', 'claimedAt'),
            lastError: Admin.pick(j, 'last_error', 'lastError'),
            tenantKey: Admin.pick(j, 'tenant_key', 'tenantKey'),
        };
    },

    statusPill(status) {
        const known = { pending: 'pending', running: 'publishing', failed: 'failed', done: 'sent', cancelled: 'pending' };
        const cls = known[status] || 'pending';
        const key = `jobs.status.${status}`;
        const label = t(key);
        return html`<span class="status-pill ${html.raw(cls)}">${label === key ? (status || '—') : label}</span>`;
    },

    attemptsCell(job) {
        if (job.attempts === null && job.maxAttempts === null) return html`—`;
        const exhausted = job.attempts !== null && job.maxAttempts !== null && job.attempts >= job.maxAttempts;
        return html`<span class="${exhausted ? html.raw('text-danger') : ''}">${
            UI.ltr(`${job.attempts === null ? '—' : UI.formatNumber(job.attempts)} / ${job.maxAttempts === null ? '—' : UI.formatNumber(job.maxAttempts)}`)
        }</span>`;
    },

    /**
     * What the server will do (src/routes/admin.ts: retry `status IN ('failed', 'cancelled')`, cancel `status = 'pending'`).
     * A job whose status is blank or unknown is neither: a button that might be refused is not offered as available.
     */
    canRetry(job) {
        return job.status === 'failed' || job.status === 'cancelled';
    },

    canCancel(job) {
        return job.status === 'pending';
    },

    /** Why a button is off, as a sentence the person can act on: `jobs.retryWhy.<status>`, else the general rule. */
    whyOff(verb, job) {
        const specific = `jobs.${verb}Why.${job.status}`;
        const said = t(specific);
        return said === specific ? t(`jobs.${verb}Why.other`) : said;
    },

    /**
     * The two row buttons and, for a button that is off, the sentence that says why. `scope` ('row' | 'card') keeps the description
     * ids unique, because the table and the cards are both in the page and CSS shows one: the table's descriptions are for
     * assistive technology, the card's are visible (a phone has no hover for a `title`).
     */
    actions(job, scope) {
        const retryOk = this.canRetry(job);
        const cancelOk = this.canCancel(job);
        const retryWhy = retryOk ? '' : this.whyOff('retry', job);
        const cancelWhy = cancelOk ? '' : this.whyOff('cancel', job);
        const retryId = `jobs-retry-why-${scope}-${job.id}`;
        const cancelId = `jobs-cancel-why-${scope}-${job.id}`;
        const whyClass = scope === 'card' ? 'text-meta' : 'sr-only';
        return html`
            <div class="row-actions">
                <button type="button" class="icon-btn" data-action="jobs:retry" data-id="${job.id}"
                        aria-label="${t('jobs.retryFor', { kind: job.kind })}" title="${retryOk ? t('jobs.retry') : retryWhy}"
                        ${retryOk ? '' : html` disabled aria-describedby="${retryId}"`}>
                    <i data-lucide="rotate-cw" aria-hidden="true"></i>
                </button>
                <button type="button" class="icon-btn icon-btn-danger" data-action="jobs:confirmCancel"
                        data-id="${job.id}" data-kind="${job.kind}"
                        aria-label="${t('jobs.cancelFor', { kind: job.kind })}" title="${cancelOk ? t('jobs.cancel') : cancelWhy}"
                        ${cancelOk ? '' : html` disabled aria-describedby="${cancelId}"`}>
                    <i data-lucide="ban" aria-hidden="true"></i>
                </button>
            </div>
            ${retryOk ? '' : html`<p class="${whyClass}" id="${retryId}" dir="auto">${retryWhy}</p>`}
            ${cancelOk ? '' : html`<p class="${whyClass}" id="${cancelId}" dir="auto">${cancelWhy}</p>`}
        `;
    },

    renderRow(j) {
        const job = this.read(j);
        const runAge = UI.relativeAge(job.runAfter, { warnMs: 30 * 60 * 1000, staleMs: 6 * 60 * 60 * 1000 });
        return html`
            <tr data-job-id="${job.id}">
                <td>
                    <span class="job-kind" dir="auto">${job.kind}</span>
                    ${job.tenantKey ? html`<span class="job-tenant">${UI.ltr(job.tenantKey)}</span>` : ''}
                </td>
                <td>${this.statusPill(job.status)}</td>
                <td class="nowrap">${this.attemptsCell(job)}</td>
                <td class="nowrap" title="${job.runAfter ? runAge.title : ''}">
                    ${job.runAfter ? runAge.text : html`—`}
                    ${job.claimedAt ? html`<span class="job-claimed">${t('jobs.claimed', {
                        age: UI.relativeAge(job.claimedAt, { warnMs: 10 * 60 * 1000, staleMs: 60 * 60 * 1000 }).text,
                    })}</span>` : ''}
                </td>
                <td class="cell-error" dir="auto">${job.lastError || html`<span class="text-meta">—</span>`}</td>
                <td>${this.actions(job, 'row')}</td>
            </tr>
        `;
    },

    renderCard(j) {
        const job = this.read(j);
        const runAge = UI.relativeAge(job.runAfter, { warnMs: 30 * 60 * 1000, staleMs: 6 * 60 * 60 * 1000 });
        return html`
            <article class="log-card" data-job-id="${job.id}">
                <div class="log-card-head">
                    <span class="job-kind" dir="auto">${job.kind}</span>
                    ${this.statusPill(job.status)}
                </div>
                <dl class="ops-facts">
                    ${Admin.field(t('jobs.table.attempts'), this.attemptsCell(job))}
                    ${Admin.field(t('jobs.table.runAfter'), job.runAfter ? runAge.text : html`—`)}
                    ${job.claimedAt ? Admin.field(t('jobs.table.claimed'), UI.relativeAge(job.claimedAt, {
                        warnMs: 10 * 60 * 1000, staleMs: 60 * 60 * 1000,
                    }).text) : ''}
                    ${job.tenantKey ? Admin.field(t('jobs.table.tenant'), UI.ltr(job.tenantKey)) : ''}
                </dl>
                ${job.lastError ? html`<p class="job-error" dir="auto">${job.lastError}</p>` : ''}
                ${this.actions(job, 'card')}
            </article>
        `;
    },

    // ─── Filters ─────────────────────────────────────────────────────────────
    setStatus(select) {
        this.status = select.value;
        return this.load();
    },

    setTenant(select) {
        this.tenant = select.value;
        return this.load();
    },

    setLimit(select) {
        this.limit = Number(select.value) || 50;
        return this.load();
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    /**
     * A refusal or failure as one sentence for a toast: the translated sentence and its next step when the server sent a code the
     * catalogue knows (JOB_NOT_RETRYABLE, JOB_NOT_CANCELLABLE), the already-translated network message when there was no answer, and
     * otherwise this screen's own line. The server's English is never shown as the sentence (FR-007, JB-05).
     */
    failureText(err, fallbackKey) {
        if (err && (err.isNetworkError || (typeof err.code === 'string' && err.code))) {
            const { sentence, next } = UI.errorText(err);
            return next ? `${sentence} ${next}` : sentence;
        }
        return t(fallbackKey);
    },

    async retry(btn) {
        btn.disabled = true;
        try {
            await API.retryAdminJob(btn.dataset.id);
            UI.toast(t('jobs.retried'));
        } catch (err) {
            btn.disabled = false;
            UI.toast(this.failureText(err, 'jobs.retryFailed'), 'error');
            // A 409 means the page was stale: the job is in another state than the row said. Show the state it is in now.
            if (err && err.status === 409) await this.load();
            return;
        }
        await this.load();
    },

    confirmCancel(btn) {
        const id = btn.dataset.id;
        const kind = btn.dataset.kind || '—';
        Admin.confirm({
            title: t('jobs.cancelTitle'),
            body: t('jobs.cancelBody', { kind }),
            hint: t('jobs.cancelHint'),
            confirmLabel: t('jobs.cancelCta'),
            confirmIcon: 'ban',
            onConfirm: () => this.cancel(id),
        });
    },

    async cancel(id) {
        try {
            await API.cancelAdminJob(id);
            UI.toast(t('jobs.cancelled'));
        } catch (err) {
            UI.toast(this.failureText(err, 'jobs.cancelFailed'), 'error');
        }
        await this.load();
    },
};

UI.registerActions('jobs', {
    load: () => Admin.report(JobsPage.load()),
    setStatus: (el) => Admin.report(JobsPage.setStatus(el)),
    setTenant: (el) => Admin.report(JobsPage.setTenant(el)),
    setLimit: (el) => Admin.report(JobsPage.setLimit(el)),
    retry: (el) => Admin.report(JobsPage.retry(el)),
    confirmCancel: (el) => JobsPage.confirmCancel(el),
});
