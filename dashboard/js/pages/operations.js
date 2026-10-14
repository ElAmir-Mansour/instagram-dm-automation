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
 *
 * The onboarding funnel (P31) sits right under the AI providers: invited, opened, password, each wizard step, finished, with counts and
 * median times for the last 30 or 90 days (`GET /api/admin/onboarding/funnel`, counts and durations only). It loads on its own after
 * the page is drawn, so the tenants above it never wait for it, and a failed load is a message with a Retry inside the card.
 *
 * The AI providers card sits right under the tenant cards (pages/ai_providers.js,
 * loaded on first use). It absorbed the Gemini key card: Gemini is one provider
 * row in it, and it is still one key for every tenant, so a missing one silences
 * every DM bot at once.
 */
const OperationsPage = {
    data: null,

    /** Whether ai_providers.js is in and the card has its data: otherwise the section says it could not load. */
    aiReady: false,

    /** The funnel card: the window shown (30 or 90 days), what came back, whether it failed, and which request is the live one. */
    funnel: { days: 30, data: null, failed: false, loading: false, seq: 0 },

    resetTenantState() {
        this.data = null;
        this.aiReady = false;
        this.funnel = { days: 30, data: null, failed: false, loading: false, seq: 0 };
        // The card's own state is reset with the rest by App.resetTenantState(): it is a registered module (`routable: false`).
    },

    /**
     * Fetch the card's module (App.loadPageModule: on demand, at the dashboard's asset version, a failed fetch not remembered so
     * Retry asks again), then what it shows. Resolves true when the card can paint; its own parts keep their own errors, because the
     * Gemini key must stay usable when the AI settings cannot be read.
     */
    async loadAiCard() {
        const card = await App.loadPageModule('ai_providers');
        if (!card) return false;
        await card.load();
        return true;
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
        let aiReady = false;
        try {
            // Side by side. The AI card never rejects (its parts keep their own
            // errors): the rest of the screen is still worth showing without it.
            [result, aiReady] = await Promise.all([
                API.getAdminOps(),
                this.loadAiCard().catch(() => false),
            ]);
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
        this.aiReady = aiReady;
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

            ${this.renderAiProviders()}
            <div data-region="funnel">${this.renderFunnel()}</div>
            ${this.renderQueue()}
            ${this.renderSchema()}
            ${this.renderStorage()}
            ${this.renderKeywordHazards()}
        `);

        UI.icons(container);
        Admin.applyMeters(container);
        Motion.announce(t('ops.count', { count: tenants.length }));
        // After the screen is up, and never awaited: the funnel is its own request with its own failure.
        this.loadFunnel(this.funnel.days);
    },

    // ─── The onboarding funnel (P31) ─────────────────────────────────────────

    FUNNEL_WINDOWS: [30, 90],

    /** The funnel's region, if the screen is still the one that is open. */
    funnelRegion() {
        const container = document.getElementById('page-container');
        return container ? container.querySelector('[data-region="funnel"]') : null;
    },

    /** Ask for `days` days, and redraw the card when the answer lands. An answer that comes after a newer question is dropped. */
    async loadFunnel(days) {
        const span = this.FUNNEL_WINDOWS.includes(days) ? days : 30;
        const seq = (this.funnel.seq || 0) + 1;
        this.funnel = { days: span, data: null, failed: false, loading: true, seq };
        this.paintFunnel();
        let data = null;
        let failed = false;
        try {
            data = await API.getOnboardingFunnel(span);
        } catch {
            failed = true;
        }
        if (this.funnel.seq !== seq) return;
        this.funnel = { days: span, data, failed: failed || !data || typeof data !== 'object', loading: false, seq };
        this.paintFunnel();
    },

    paintFunnel() {
        const host = this.funnelRegion();
        if (!host) return;
        const focus = UI.captureFocus(host);
        host.innerHTML = esc(this.renderFunnel());
        UI.icons(host);
        Admin.applyMeters(host);
        UI.restoreFocus(focus);
    },

    /** A duration as a person says it: "under a minute", "4m", "1h 20m", "2d". */
    duration(ms) {
        const n = Number(ms);
        if (ms === null || ms === undefined || !Number.isFinite(n) || n < 0) return '—';
        const minute = 60000;
        if (n < minute) return t('ops.funnel.lessThanMinute');
        const minutes = Math.round(n / minute);
        if (minutes < 60) return t('common.minutes', { n: UI.formatNumber(minutes) });
        const hours = Math.floor(minutes / 60);
        if (hours < 24) {
            const rest = minutes % 60;
            const h = t('common.hours', { n: UI.formatNumber(hours) });
            return rest ? `${h} ${t('common.minutes', { n: UI.formatNumber(rest) })}` : h;
        }
        return t('common.days', { n: UI.formatNumber(Math.round(hours / 24)) });
    },

    /** The stages and steps the server names are the wizard's own ids: a word from a fixed table, never one from the response. */
    STAGE_IDS: ['invited', 'opened', 'accepted', 'about', 'voice', 'brand', 'connect', 'proof', 'completed'],

    renderFunnel() {
        const f = this.funnel;
        return html`
            <section class="section" aria-labelledby="ops-funnel-title">
                <div class="row row--between row--wrap gap-3 mbe-4">
                    <h2 class="section-title mbe-2" id="ops-funnel-title">${t('ops.funnel.title')}</h2>
                    <div class="funnel-window" role="group" aria-label="${t('ops.funnel.windowLabel')}">
                        ${this.FUNNEL_WINDOWS.map((days) => html`
                            <button type="button" class="btn btn-secondary btn-sm" data-action="ops:funnelWindow" data-days="${days}"
                                    aria-pressed="${f.days === days ? 'true' : 'false'}">${t('ops.funnel.window', { days: UI.formatNumber(days) })}</button>
                        `)}
                    </div>
                </div>
                <div class="surface pad-5 stack gap-4">
                    <p class="form-hint">${t('ops.funnel.intro')}</p>
                    ${f.loading ? html`<p class="form-hint" role="status">${t('common.loading')}</p>` : ''}
                    ${!f.loading && f.failed ? html`
                        <p class="form-hint text-warning" role="alert">${t('ops.funnel.failed')}</p>
                        <div class="form-actions aip-actions-flush">
                            ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'ops:funnelRetry' })}
                        </div>
                    ` : ''}
                    ${!f.loading && !f.failed && f.data ? this.renderFunnelBody(f.data) : ''}
                </div>
            </section>
        `;
    },

    renderFunnelBody(data) {
        const cohort = Admin.num(data, 'cohort') || 0;
        if (cohort === 0) return html`<p class="form-hint">${t('ops.funnel.empty')}</p>`;
        const stages = (Array.isArray(data.stages) ? data.stages : []).filter((s) => s && this.STAGE_IDS.includes(s.id));
        const steps = (Array.isArray(data.steps) ? data.steps : []).filter((s) => s && this.STAGE_IDS.includes(s.step));
        const drafts = data.drafts && typeof data.drafts === 'object' ? data.drafts : {};
        const draftTotal = (Number(drafts.started) || 0) + (Number(drafts.ready) || 0) + (Number(drafts.failed) || 0);
        return html`
            <div class="stats-grid">
                ${Admin.statTile({ label: t('ops.funnel.finished'), value: UI.formatNumber(Admin.num(data, 'completed') || 0), icon: 'check-circle', tone: 'success' })}
                ${Admin.statTile({ label: t('ops.funnel.inProgress'), value: UI.formatNumber(Admin.num(data, 'in_progress') || 0), icon: 'clock', tone: 'accent' })}
                ${Admin.statTile({ label: t('ops.funnel.abandoned'), value: UI.formatNumber(Admin.num(data, 'abandoned') || 0), icon: 'hourglass', tone: (Admin.num(data, 'abandoned') || 0) > 0 ? 'warning' : 'accent' })}
            </div>

            <div>
                <h3 class="form-label">${t('ops.funnel.stages')}</h3>
                <ol class="funnel-stages">
                    ${stages.map((stage) => {
                        const label = t(`ops.funnel.stage.${stage.id}`);
                        const reached = Number(stage.reached) || 0;
                        const count = t('ops.funnel.reached', { count: UI.formatNumber(reached), total: UI.formatNumber(cohort) });
                        return html`
                            <li class="funnel-stage">
                                <span class="funnel-stage-label">${label}</span>
                                <progress class="studio-meter" max="${cohort}" value="${Math.min(reached, cohort)}" aria-label="${label}: ${count}"></progress>
                                <span class="funnel-stage-count">${count}</span>
                            </li>
                        `;
                    })}
                </ol>
            </div>

            ${this.renderFunnelMedians(data)}
            ${steps.length > 0 ? this.renderFunnelSteps(steps) : ''}
            ${draftTotal > 0 ? html`<p class="form-hint">${t('ops.funnel.drafts', {
                started: UI.formatNumber(Number(drafts.started) || 0), ready: UI.formatNumber(Number(drafts.ready) || 0), failed: UI.formatNumber(Number(drafts.failed) || 0),
            })}</p>` : ''}
        `;
    },

    renderFunnelMedians(data) {
        const m = data.medians && typeof data.medians === 'object' ? data.medians : {};
        const target = Number(data.target_open_to_complete_ms);
        const open = Number(m.open_to_complete_ms);
        const known = m.open_to_complete_ms !== null && m.open_to_complete_ms !== undefined && Number.isFinite(open);
        const within = known && Number.isFinite(target) && open <= target;
        return html`
            <div>
                <h3 class="form-label">${t('ops.funnel.medians')}</h3>
                <dl class="ops-facts">
                    ${Admin.field(t('ops.funnel.median.open_to_complete'), html`
                        <span>${this.duration(m.open_to_complete_ms)}</span>
                        ${known && Number.isFinite(target) ? html`<span class="badge ${within ? html.raw('badge-success') : html.raw('badge-warning')}">${within ? t('ops.funnel.onTarget') : t('ops.funnel.overTarget')}</span>` : ''}
                        ${Number.isFinite(target) ? html`<span class="form-hint">${t('ops.funnel.target', { time: this.duration(target) })}</span>` : ''}
                    `)}
                    ${Admin.field(t('ops.funnel.median.invite_to_open'), this.duration(m.invite_to_open_ms))}
                    ${Admin.field(t('ops.funnel.median.invite_to_accept'), this.duration(m.invite_to_accept_ms))}
                    ${Admin.field(t('ops.funnel.median.accept_to_complete'), this.duration(m.accept_to_complete_ms))}
                </dl>
            </div>
        `;
    },

    renderFunnelSteps(steps) {
        return html`
            <div>
                <h3 class="form-label">${t('ops.funnel.steps')}</h3>
                <div class="table-wrapper">
                    <table class="data-table">
                        <thead><tr>
                            <th scope="col">${t('ops.funnel.col.step')}</th>
                            <th scope="col">${t('ops.funnel.col.reached')}</th>
                            <th scope="col">${t('ops.funnel.col.done')}</th>
                            <th scope="col">${t('ops.funnel.col.skipped')}</th>
                            <th scope="col">${t('ops.funnel.col.median')}</th>
                        </tr></thead>
                        <tbody>
                            ${steps.map((row) => html`
                                <tr>
                                    <th scope="row">${t(`ops.funnel.stage.${row.step}`)}</th>
                                    <td>${UI.formatNumber(Number(row.reached) || 0)}</td>
                                    <td>${UI.formatNumber(Number(row.completed) || 0)}</td>
                                    <td>${UI.formatNumber(Number(row.skipped) || 0)}</td>
                                    <td class="nowrap">${this.duration(row.median_ms)}</td>
                                </tr>
                            `)}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
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

    /**
     * The AI providers card (pages/ai_providers.js): keys, routes, prices, budgets and spend, with the Gemini key, which every tenant's
     * DM replies and the Studio run on, as one provider row. When the module could not be fetched the section says so, with a retry
     * that reloads the screen: nothing here depends on it.
     */
    renderAiProviders() {
        const card = this.aiReady ? App.pages.ai_providers.page() : null;
        if (card) return card.renderSection();
        return html`
            <section class="section">
                <h2 class="section-title">${t('ops.ai.title')}</h2>
                <div class="surface pad-5 stack gap-4">
                    <p class="form-hint text-warning" dir="auto">${t('ops.ai.moduleFailed')}</p>
                    <div class="form-actions aip-actions-flush">
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'ops:render' })}
                    </div>
                </div>
            </section>
        `;
    },

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
    funnelWindow: (el) => OperationsPage.loadFunnel(Number(el.dataset.days)),
    funnelRetry: () => OperationsPage.loadFunnel(OperationsPage.funnel.days),
    openTenant: (el) => OperationsPage.openTenant(el.dataset.id),
    recheckToken: (el) => Admin.report(OperationsPage.recheckToken(el)),
});
