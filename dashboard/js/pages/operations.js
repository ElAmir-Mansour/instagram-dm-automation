/**
 * Operations — platform-admin only. The morning screen.
 *
 * One question: is the platform healthy. The answer has to be readable in a
 * glance, so the two facts that mean "something is broken" lead every tenant
 * card — access-token status and how long ago the last webhook arrived — as
 * RELATIVE ages with severity colour. "3 days ago" in red needs no arithmetic;
 * a timestamp does, and an operator scanning ten tenants will not do it.
 *
 * Tenants are sorted worst-first for the same reason. The silent tenant is the
 * one you came here to find, and it is at the top whether you have two tenants
 * or twenty.
 *
 * `tokenError` is rendered. Meta already tells us WHY a token is bad and the
 * dashboard used to drop it on the floor, leaving a red pill and no diagnosis.
 *
 * Everything below the tenant cards is platform-wide and secondary: queue
 * depth with the age of the oldest pending job, pending migrations (there is
 * no migration ledger, so "pending" is the only warning that exists), storage
 * against the 500MB tier `media_uploads` is growing into, and the
 * short-keyword hazard list — `تم` matches inside اهتمام, and substring
 * matching means a two-letter keyword fires on half the comments on a post.
 */
const OperationsPage = {
    data: null,

    resetTenantState() {
        this.data = null;
    },

    skeleton() {
        return html`
            ${Motion.toolbar()}
            ${Motion.cardGrid(3, 4)}
            ${Motion.statsGrid(4)}
            ${Motion.busy()}
        `;
    },

    async render() {
        const container = document.getElementById('page-container');
        const gate = Motion.beginLoad(container, () => this.skeleton());

        let result;
        try {
            result = await API.getAdminOps();
        } catch (err) {
            gate.done();
            Admin.renderLoadFailure(container, err, {
                unavailableTitle: t('ops.unavailableTitle'),
                failedTitle: t('ops.loadFailed'),
                retry: () => this.render(),
            });
            return;
        }
        gate.done();

        this.data = result || {};
        const tenants = this.tenantRows();

        container.innerHTML = esc(html`
            <div class="page-toolbar">
                <p class="page-toolbar-count">${t('ops.count', { count: tenants.length })}</p>
                <div class="toolbar-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="ops:render">
                        <i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('ops.refresh')}
                    </button>
                </div>
            </div>

            <section class="section">
                <h2 class="section-title">${t('ops.tenantsTitle')}</h2>
                ${tenants.length === 0
                    ? html`<div class="surface pad-5">${Admin.emptyState('building-2', t('ops.noTenants'), t('ops.noTenantsBody'))}</div>`
                    : html`<div class="ops-grid">${tenants.map((row) => this.renderTenantCard(row))}</div>`}
            </section>

            ${this.renderQueue()}
            ${this.renderSchema()}
            ${this.renderStorage()}
            ${this.renderKeywordHazards()}
        `);

        UI.icons(container);
        Admin.applyMeters(container);
        Motion.announce(t('ops.count', { count: tenants.length }));
    },

    // ─── Tenants ─────────────────────────────────────────────────────────────

    /** The per-tenant rows, worst first. */
    tenantRows() {
        const raw = Admin.pick(this.data, 'tenants', 'rows', 'creators');
        const rows = Array.isArray(raw) ? raw.slice() : [];
        rows.sort((a, b) => this.severity(b) - this.severity(a));
        return rows;
    },

    /**
     * How loudly this tenant is asking for attention. Deliberately coarse —
     * it only has to get the broken ones above the working ones.
     */
    severity(row) {
        let score = 0;
        const tokenState = Admin.tokenState(Admin.pick(row, 'tokenStatus', 'token_status'));
        if (tokenState === 'invalid') score += 100;
        else if (tokenState === 'unknown') score += 20;

        const webhook = UI.relativeAge(
            Admin.pick(row, 'lastWebhookAt', 'last_webhook_at'), Admin.WEBHOOK_AGE
        );
        if (webhook.level === 'stale') score += 80;
        else if (webhook.level === 'warn') score += 15;

        const queue = Admin.pick(row, 'queue') || {};
        if (Admin.num(queue, 'failed')) score += 40;
        if (Admin.num(row, 'postsFailed7d', 'posts_failed_7d')) score += 30;

        // An inactive tenant is not broken, it is switched off. Sink it.
        if (Admin.pick(row, 'is_active', 'isActive') === false) score -= 500;
        return score;
    },

    renderTenantCard(row) {
        const id = Admin.pick(row, 'id', 'tenantId', 'tenant_id', 'creatorId', 'creator_id');
        const name = Admin.pick(row, 'name', 'display_name') || t('tenants.untitled');
        const isActive = Admin.pick(row, 'is_active', 'isActive') !== false;
        const currentId = App.session && App.session.tenantId;
        const isCurrent = id && currentId && String(id) === String(currentId);

        const tokenStatus = Admin.pick(row, 'tokenStatus', 'token_status');
        const tokenCheckedAt = Admin.pick(row, 'tokenLastCheckedAt', 'token_last_checked_at');
        const tokenErr = Admin.pick(row, 'tokenError', 'token_error');
        const expiresAt = Admin.pick(row, 'tokenExpiresAt', 'token_expires_at');
        const dataAccessAt = Admin.pick(row, 'dataAccessExpiresAt', 'data_access_expires_at');

        const webhookAt = Admin.pick(row, 'lastWebhookAt', 'last_webhook_at');
        const commentAt = Admin.pick(row, 'lastCommentAt', 'last_comment_at');
        const dmAt = Admin.pick(row, 'lastInboundDmAt', 'last_inbound_dm_at');

        const dmUsed = Admin.num(row, 'dmThisHour', 'dm_this_hour');
        const dmCeiling = Admin.num(row, 'dmCeiling', 'dm_ceiling')
            ?? Admin.num(this.data, 'dmCeiling', 'dm_hourly_ceiling');

        const queue = Admin.pick(row, 'queue') || {};
        const postsPending = Admin.num(row, 'postsPending', 'posts_pending');
        const postsFailed = Admin.num(row, 'postsFailed7d', 'posts_failed_7d');

        const webhookAge = UI.relativeAge(webhookAt, Admin.WEBHOOK_AGE);
        const alarm = webhookAge.level === 'stale' || Admin.tokenState(tokenStatus) === 'invalid';

        return html`
            <article class="ops-card surface ${alarm ? html.raw('ops-card-alarm') : ''} ${isActive ? '' : html.raw('ops-card-off')}"
                     data-tenant-id="${id}">
                <header class="ops-card-head">
                    <h3 class="ops-card-title" dir="auto">
                        ${name}
                        ${isCurrent ? html`<span class="chip chip-accent">${t('tenants.current')}</span>` : ''}
                        ${isActive ? '' : html`<span class="chip">${t('tenants.inactive')}</span>`}
                    </h3>
                    <div class="ops-card-actions">
                        <button type="button" class="btn btn-secondary btn-sm"
                                data-action="ops:recheckToken" data-id="${id}"
                                aria-label="${t('ops.recheckFor', { name })}">
                            <i data-lucide="refresh-cw" aria-hidden="true"></i>
                            <span>${t('ops.recheck')}</span>
                        </button>
                        <button type="button" class="btn btn-secondary btn-sm"
                                data-action="ops:openTenant" data-id="${id}"
                                aria-label="${t('ops.inspectFor', { name })}">
                            <i data-lucide="search" aria-hidden="true"></i>
                            <span>${t('ops.inspect')}</span>
                        </button>
                    </div>
                </header>

                <!-- The lead. These two lines are the whole reason for the page. -->
                <div class="ops-lead">
                    <div class="ops-lead-item">
                        <span class="ops-lead-label">${t('ops.lastWebhook')}</span>
                        ${Admin.agePill(webhookAt, Admin.WEBHOOK_AGE)}
                    </div>
                    <div class="ops-lead-item">
                        <span class="ops-lead-label">${t('ops.token')}</span>
                        ${Admin.tokenPill(tokenStatus)}
                        <span class="ops-lead-note">${
                            tokenCheckedAt
                                ? t('health.checked', { age: UI.relativeAge(tokenCheckedAt, Admin.CHECK_AGE).text })
                                : t('health.neverChecked')
                        }</span>
                    </div>
                </div>

                ${tokenErr ? Admin.tokenError(t('health.tokenReason', { message: tokenErr })) : ''}

                <dl class="ops-facts">
                    ${Admin.field(t('ops.lastComment'), Admin.agePill(commentAt, Admin.WEBHOOK_AGE))}
                    ${Admin.field(t('ops.lastDm'), Admin.agePill(dmAt, Admin.WEBHOOK_AGE))}
                    ${Admin.field(t('ops.dmHeadroom'), Admin.meter(dmUsed, dmCeiling, t('tenants.dmMeter', {
                        used: UI.formatNumber(dmUsed || 0),
                        ceiling: dmCeiling === null ? '—' : UI.formatNumber(dmCeiling),
                    })))}
                    ${Admin.field(t('ops.queue'), this.queueTriple(queue))}
                    ${Admin.field(t('ops.posts'), html`
                        <span>${t('health.postsValue', { pending: postsPending === null ? '—' : UI.formatNumber(postsPending) })}</span>
                        <span class="count-bad ${postsFailed ? '' : html.raw('count-zero')}">${
                            t('tenants.postsFailed', { count: postsFailed === null ? '—' : UI.formatNumber(postsFailed) })
                        }</span>
                    `)}
                    ${Admin.field(t('ops.expires'), expiresAt ? UI.formatDay(expiresAt) : t('settings.expiresNever'))}
                    ${dataAccessAt ? Admin.field(t('ops.dataAccess'), UI.formatDay(dataAccessAt)) : ''}
                </dl>
            </article>
        `;
    },

    /** pending / running / failed on one line, with failed always visible. */
    queueTriple(queue) {
        const pending = Admin.num(queue, 'pending');
        const running = Admin.num(queue, 'running');
        const failed = Admin.num(queue, 'failed');
        if (pending === null && running === null && failed === null) {
            return html`<span class="text-meta">—</span>`;
        }
        return html`
            <span class="queue-triple">
                <span>${t('ops.queuePending', { count: pending === null ? '—' : UI.formatNumber(pending) })}</span>
                <span>${t('ops.queueRunning', { count: running === null ? '—' : UI.formatNumber(running) })}</span>
                <span class="count-bad ${failed ? '' : html.raw('count-zero')}">${
                    t('ops.queueFailed', { count: failed === null ? '—' : UI.formatNumber(failed) })
                }</span>
            </span>
        `;
    },

    // ─── Platform-wide ───────────────────────────────────────────────────────

    renderQueue() {
        const queue = Admin.pick(this.data, 'queue');
        if (!queue) return html``;

        const pending = Admin.num(queue, 'pending');
        const running = Admin.num(queue, 'running');
        const failed = Admin.num(queue, 'failed');
        const oldest = Admin.pick(queue, 'oldestPendingAt', 'oldest_pending_at', 'oldestPending');
        const oldestAge = UI.relativeAge(oldest, { warnMs: 30 * 60 * 1000, staleMs: 6 * 60 * 60 * 1000 });

        return html`
            <section class="section">
                <div class="row row--between row--wrap gap-3 mbe-4">
                    <h2 class="section-title mbe-2">${t('ops.queueTitle')}</h2>
                    <button type="button" class="btn btn-secondary btn-sm" data-action="app:navigate" data-target="jobs">
                        <i data-lucide="list-checks" aria-hidden="true"></i> ${t('ops.openJobs')}
                    </button>
                </div>
                <div class="stats-grid">
                    ${Admin.statTile({
                        label: t('ops.queuePendingLabel'), value: Admin.count(pending),
                        icon: 'clock', tone: 'accent',
                        sub: oldest ? t('ops.oldestPending', { age: oldestAge.text }) : t('ops.oldestPendingUnknown'),
                    })}
                    ${Admin.statTile({
                        label: t('ops.queueRunningLabel'), value: Admin.count(running),
                        icon: 'play', tone: 'success', sub: t('ops.queueRunningSub'),
                    })}
                    ${Admin.statTile({
                        label: t('ops.queueFailedLabel'), value: Admin.count(failed),
                        icon: 'alert-triangle', tone: failed ? 'danger' : 'accent',
                        sub: failed ? t('ops.queueFailedSub') : t('ops.queueFailedNone'),
                    })}
                </div>
            </section>
        `;
    },

    renderSchema() {
        const schema = Admin.pick(this.data, 'schema');
        if (!schema) return html``;

        const applied = Admin.num(schema, 'applied');
        const pendingList = Admin.pick(schema, 'pending');
        const pending = Array.isArray(pendingList) ? pendingList : [];

        return html`
            <section class="section">
                <h2 class="section-title">${t('ops.schemaTitle')}</h2>
                ${pending.length > 0 ? html`
                    <div class="warning-card" role="alert">
                        <div class="row row--start gap-4">
                            <span class="stat-icon warning shrink-0"><i data-lucide="database" aria-hidden="true"></i></span>
                            <div>
                                <h3 class="warning-card-title">${t('ops.schemaPendingTitle', { count: pending.length })}</h3>
                                <p class="mbe-3">${t('ops.schemaPendingBody')}</p>
                                <ul class="warning-card-list">
                                    ${pending.map((name) => html`<li><code>${UI.ltr(typeof name === 'string' ? name : (Admin.pick(name, 'name', 'file', 'id') || '—'))}</code></li>`)}
                                </ul>
                            </div>
                        </div>
                    </div>
                ` : html`
                    <div class="surface pad-5">
                        <p class="token-info">
                            <i data-lucide="check-circle" class="icon-success" aria-hidden="true"></i>
                            ${t('ops.schemaClean', { count: applied === null ? '—' : UI.formatNumber(applied) })}
                        </p>
                    </div>
                `}
            </section>
        `;
    },

    renderStorage() {
        const storage = Admin.pick(this.data, 'storage');
        if (!storage) return html``;

        const media = Admin.num(storage, 'mediaBytes', 'media_bytes');
        const db = Admin.num(storage, 'dbBytes', 'db_bytes');
        const tier = Admin.num(storage, 'tierBytes', 'tier_bytes');

        return html`
            <section class="section">
                <h2 class="section-title">${t('ops.storageTitle')}</h2>
                <div class="surface pad-5 stack gap-4">
                    <div>
                        <p class="form-label">${t('ops.storageDb')}</p>
                        ${Admin.meter(db, tier, t('ops.storageMeter', {
                            used: Admin.bytes(db), total: Admin.bytes(tier),
                        }))}
                        <p class="form-hint">${t('ops.storageDbHint', {
                            used: Admin.bytes(db), total: Admin.bytes(tier),
                        })}</p>
                    </div>
                    <dl class="ops-facts">
                        ${Admin.field(t('ops.storageMedia'), UI.ltr(Admin.bytes(media)))}
                        ${Admin.field(t('ops.storageTier'), UI.ltr(Admin.bytes(tier)))}
                    </dl>
                    <p class="form-hint">${t('ops.storageNote')}</p>
                </div>
            </section>
        `;
    },

    /**
     * `normalizedCommentText.includes(normalizedKeyword)` — so a keyword short
     * enough to sit inside ordinary words fires on comments that were never
     * about the campaign. The server flags them; this is the first place the
     * operator can see the list and go fix one.
     */
    renderKeywordHazards() {
        const raw = Admin.pick(this.data, 'shortKeywords', 'short_keywords');
        const rows = Array.isArray(raw) ? raw : [];

        return html`
            <section class="section">
                <h2 class="section-title">${t('ops.keywordsTitle')}</h2>
                <div class="surface pad-5">
                    ${rows.length === 0
                        ? Admin.emptyState('shield-check', t('ops.keywordsNone'), t('ops.keywordsNoneBody'))
                        : html`
                            <p class="form-hint mbe-4">${t('ops.keywordsBody')}</p>
                            <ul class="hazard-list">
                                ${rows.map((row) => this.renderHazard(row))}
                            </ul>
                        `}
                </div>
            </section>
        `;
    },

    renderHazard(row) {
        const keyword = Admin.pick(row, 'keyword', 'trigger_keyword') || '—';
        const campaignId = Admin.pick(row, 'campaignId', 'campaign_id', 'id');
        const length = Admin.num(row, 'length') ?? String(keyword).length;
        const mode = Admin.pick(row, 'matchMode', 'match_mode');

        return html`
            <li class="hazard-item">
                <div class="hazard-main">
                    <code class="hazard-keyword" dir="auto">${keyword}</code>
                    <span class="badge badge-warning">${t('ops.keywordChars', { count: length })}</span>
                    ${mode ? html`<span class="chip">${t('ops.keywordMode', { mode })}</span>` : ''}
                </div>
                <button type="button" class="btn btn-secondary btn-sm"
                        data-action="app:navigate" data-target="campaigns"
                        data-query="${campaignId ? `focus=${encodeURIComponent(String(campaignId))}` : ''}"
                        aria-label="${t('ops.fixKeyword', { keyword })}">
                    <i data-lucide="pencil" aria-hidden="true"></i> ${t('ops.fix')}
                </button>
            </li>
        `;
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    openTenant(id) {
        if (!id) return;
        App.goWithQuery('tenant_detail', { id });
    },

    /**
     * Ask Meta about this tenant's token right now and repaint the card from
     * the answer. A status that was last checked eleven days ago is not
     * evidence, and re-checking used to mean opening /debug_token by hand.
     */
    async recheckToken(btn) {
        const id = btn.dataset.id;
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = UI.buttonSpinner(t('ops.rechecking'));

        try {
            await API.recheckAdminTenantToken(id);
            UI.toast(t('ops.rechecked'));
            // Re-fetch rather than patching the row from the response: the
            // re-check also moves `tokenLastCheckedAt`, and the card's sort
            // position depends on the new status.
            await this.render();
        } catch (err) {
            btn.disabled = false;
            btn.innerHTML = original;
            UI.icons(btn);
            UI.toast((err && err.message) || t('ops.recheckFailed'), 'error');
        }
    },
};

UI.registerActions('ops', {
    render: () => Admin.report(OperationsPage.render()),
    openTenant: (el) => OperationsPage.openTenant(el.dataset.id),
    recheckToken: (el) => Admin.report(OperationsPage.recheckToken(el)),
});
