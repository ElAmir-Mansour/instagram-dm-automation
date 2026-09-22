/**
 * Audit log — platform-admin only. Who did what, newest first.
 *
 * Every administrative action in this UI is destructive or privilege-granting:
 * roles change, memberships are revoked, page ids that route webhooks are
 * edited, and one screen hard-deletes a person from every table. With a single
 * shared dashboard password and no user identity in the session token, the
 * audit trail is the only record that a thing happened at all.
 *
 * The action filter's options are accumulated rather than hardcoded: the
 * server decides what an action is called, and filtering to one action would
 * otherwise shrink the option list to that one action and trap the operator.
 */
const AuditPage = {
    entries: [],
    action: '',
    limit: 100,

    /** Every action name seen so far, so the filter never loses its options. */
    seen: [],

    resetTenantState() {
        this.entries = [];
        this.action = '';
        this.seen = [];
    },

    skeleton() {
        return html`
            ${Motion.tableCard(12, [
                t('audit.table.when'), t('audit.table.actor'),
                t('audit.table.action'), t('audit.table.target'), t('audit.table.detail'),
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
            result = await API.getAdminAudit({ limit: this.limit, action: this.action });
        } catch (err) {
            gate.done();
            Admin.renderLoadFailure(container, err, {
                unavailableTitle: t('audit.unavailableTitle'),
                failedTitle: t('audit.loadFailed'),
                retry: () => this.load(),
            });
            return;
        }
        gate.done();

        this.entries = Array.isArray(result) ? result : (result && (result.entries || result.data || result.audit)) || [];

        const offered = result && Array.isArray(result.actions) ? result.actions : [];
        const found = this.entries.map((e) => Admin.pick(e, 'action', 'event', 'kind')).filter(Boolean);
        this.seen = Array.from(new Set(this.seen.concat(offered, found).map(String))).sort();

        this.paint(container);
    },

    paint(container) {
        const rows = this.entries;

        container.innerHTML = esc(html`
            <section class="section">
            <h2 class="section-title">${t('audit.listTitle')}</h2>
            <div class="table-card surface">
                <div class="table-header">
                    <div class="filter-bar grow">
                        <label class="sr-only" for="audit-action">${t('audit.actionFilter')}</label>
                        <select class="select" id="audit-action" data-change="audit:setAction">
                            <option value="" ${this.action ? '' : html.raw('selected')}>${t('audit.allActions')}</option>
                            ${this.seen.map((a) => html`
                                <option value="${a}" ${this.action === a ? html.raw('selected') : ''}>${this.actionLabel(a)}</option>
                            `)}
                        </select>

                        <label class="sr-only" for="audit-limit">${t('audit.limitFilter')}</label>
                        <select class="select" id="audit-limit" data-change="audit:setLimit">
                            ${[50, 100, 200, 500].map((n) => html`
                                <option value="${n}" ${this.limit === n ? html.raw('selected') : ''}>${t('audit.limitOption', { count: n })}</option>
                            `)}
                        </select>
                    </div>

                    <div class="row gap-3 row--wrap">
                        <span class="text-meta">${t('audit.count', { count: rows.length })}</span>
                        <button type="button" class="btn btn-secondary btn-sm" data-action="audit:load">
                            <i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('ops.refresh')}
                        </button>
                    </div>
                </div>

                ${rows.length === 0
                    ? Admin.emptyState('scroll-text',
                        this.action ? t('audit.emptyFilteredTitle') : t('audit.emptyTitle'),
                        this.action ? t('audit.emptyFilteredBody') : t('audit.emptyBody'))
                    : html`
                        <div class="table-wrapper audit-table">
                            <table class="data-table">
                                <thead><tr>
                                    <th scope="col">${t('audit.table.when')}</th>
                                    <th scope="col">${t('audit.table.actor')}</th>
                                    <th scope="col">${t('audit.table.action')}</th>
                                    <th scope="col">${t('audit.table.target')}</th>
                                    <th scope="col">${t('audit.table.detail')}</th>
                                </tr></thead>
                                <tbody>${rows.map((e) => this.renderRow(e))}</tbody>
                            </table>
                        </div>
                        <div class="audit-cards">${rows.map((e) => this.renderCard(e))}</div>
                    `}
            </div>
            </section>
        `);

        UI.icons(container);
        UI.revealClipped(container);
        Motion.announce(t('audit.count', { count: rows.length }));
    },

    read(e) {
        return {
            at: Admin.pick(e, 'at', 'created_at', 'createdAt', 'timestamp', 'occurred_at'),
            actor: Admin.pick(e, 'actor', 'actor_email', 'actorEmail', 'user_email', 'email', 'actor_id'),
            action: String(Admin.pick(e, 'action', 'event', 'kind') || '—'),
            target: Admin.pick(e, 'target', 'target_id', 'targetId', 'entity', 'subject'),
            targetType: Admin.pick(e, 'target_type', 'targetType', 'entity_type'),
            detail: Admin.pick(e, 'detail', 'details', 'meta', 'metadata', 'note'),
            ip: Admin.pick(e, 'ip', 'ip_address', 'remote_addr'),
            tenant: Admin.pick(e, 'tenant_key', 'tenantKey', 'creator_id', 'tenant_id'),
        };
    },

    /** A machine action name, humanised only if we have a translation for it. */
    actionLabel(action) {
        const key = `audit.action.${action}`;
        const label = t(key);
        return label === key ? action : label;
    },

    /**
     * `details` is often an object. Stringify it rather than rendering
     * "[object Object]", and keep it short — the column is a summary, and the
     * whole value is available on hover.
     */
    detailText(detail) {
        if (detail === null || detail === undefined || detail === '') return '';
        if (typeof detail === 'string') return detail;
        try {
            return JSON.stringify(detail);
        } catch {
            return String(detail);
        }
    },

    actionBadge(action) {
        const destructive = /delete|erase|revoke|remove|deactivate|disable|cancel/i.test(action);
        const grant = /create|grant|enable|activate|promote/i.test(action);
        const tone = destructive ? 'badge-danger' : grant ? 'badge-success' : 'badge-neutral';
        return html`<span class="badge ${html.raw(tone)}" dir="auto">${this.actionLabel(action)}</span>`;
    },

    targetCell(entry) {
        if (!entry.target && !entry.targetType) return html`<span class="text-meta">—</span>`;
        return html`
            ${entry.targetType ? html`<span class="audit-target-type">${entry.targetType}</span>` : ''}
            ${entry.target ? UI.ltr(entry.target) : ''}
        `;
    },

    renderRow(e) {
        const entry = this.read(e);
        const detail = this.detailText(entry.detail);
        return html`
            <tr>
                <td class="nowrap" title="${entry.at ? UI.formatDateTime(entry.at) : ''}">
                    ${entry.at ? UI.formatDate(entry.at) : html`—`}
                </td>
                <td>${entry.actor ? UI.ltr(entry.actor) : html`<span class="text-meta">${t('audit.actorUnknown')}</span>`}</td>
                <td>${this.actionBadge(entry.action)}</td>
                <td class="cell-id">${this.targetCell(entry)}</td>
                <!-- .audit-detail clips with overflow:hidden/ellipsis and the
                     title tooltip that carries the rest is mouse-only. The full
                     string is already in the DOM, so the cell is also made
                     focusable when genuinely clipped — measured after paint by
                     revealClipped() — mirroring activity.js's error column. -->
                <td class="audit-detail" dir="auto" title="${detail}" data-clip-focus>${detail || html`<span class="text-meta">—</span>`}</td>
            </tr>
        `;
    },

    renderCard(e) {
        const entry = this.read(e);
        const detail = this.detailText(entry.detail);
        return html`
            <article class="log-card">
                <div class="log-card-head">
                    ${this.actionBadge(entry.action)}
                    <span class="text-meta nowrap" title="${entry.at ? UI.formatDateTime(entry.at) : ''}">
                        ${entry.at ? UI.formatDate(entry.at) : '—'}
                    </span>
                </div>
                <dl class="ops-facts">
                    ${Admin.field(t('audit.table.actor'), entry.actor ? UI.ltr(entry.actor) : t('audit.actorUnknown'))}
                    ${Admin.field(t('audit.table.target'), this.targetCell(entry))}
                    ${entry.tenant ? Admin.field(t('jobs.table.tenant'), UI.ltr(entry.tenant)) : ''}
                    ${entry.ip ? Admin.field(t('audit.table.ip'), UI.ltr(entry.ip)) : ''}
                </dl>
                ${detail ? html`<p class="audit-detail-block" dir="auto">${detail}</p>` : ''}
            </article>
        `;
    },

    setAction(select) {
        this.action = select.value;
        return this.load();
    },

    setLimit(select) {
        this.limit = Number(select.value) || 100;
        return this.load();
    },
};

UI.registerActions('audit', {
    load: () => Admin.report(AuditPage.load()),
    setAction: (el) => Admin.report(AuditPage.setAction(el)),
    setLimit: (el) => Admin.report(AuditPage.setLimit(el)),
});
