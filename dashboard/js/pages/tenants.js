/**
 * Tenants Page — platform-admin only.
 *
 * This is the operations screen: one row per tenant, and the two columns that
 * say "something is broken" — access-token status and last webhook received —
 * are the ones that read first. A tenant whose last webhook is days old is a
 * red pill saying "قبل ٣ ي", not a date the reader has to subtract from today.
 *
 * Field names are read tolerantly (`pick()` below): the admin API is being
 * built in parallel, so a count that arrives under a different key renders as
 * "—" instead of "undefined", and the page still loads.
 */
const TenantsPage = {
    tenants: [],
    dmCeiling: null,

    /** Cleared on tenant switch (see App.resetTenantState). */
    resetTenantState() {
        this.tenants = [];
        this.dmCeiling = null;
    },

    /** First value present under any of these keys. */
    pick(row, ...keys) {
        for (const key of keys) {
            if (row && row[key] !== undefined && row[key] !== null) return row[key];
        }
        return undefined;
    },

    num(row, ...keys) {
        const value = this.pick(row, ...keys);
        return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)))
            ? Number(value)
            : null;
    },

    skeleton() {
        return html`
            ${Motion.toolbar()}
            ${Motion.tableCard(6, [
                t('tenants.table.tenant'), t('tenants.table.token'), t('tenants.table.webhook'),
                t('tenants.table.dms'), t('tenants.table.posts7d'), t('tenants.table.campaigns'),
                t('tenants.table.scheduled'), t('tenants.table.conversations'), '',
            ])}
            ${Motion.busy()}
        `;
    },

    async render() {
        const container = document.getElementById('page-container');
        const gate = Motion.beginLoad(container, () => this.skeleton());

        try {
            const result = await API.getAdminTenants();
            this.tenants = Array.isArray(result) ? result : (result && result.tenants) || [];
            // The DM ceiling is one platform-wide number, so it rides on the
            // envelope rather than being repeated on every row.
            this.dmCeiling = (result && (result.dmHourlyCeiling ?? result.dm_hourly_ceiling)) ?? null;
        } catch (err) {
            // 403/404 is "not a platform admin", or the route is not deployed yet.
            // Either way this is not an error the operator can act on by retrying.
            gate.done();
            if (err.status === 403 || err.status === 404) {
                App.dropAdminAccess();
                UI.renderError(container, {
                    title: t('tenants.unavailableTitle'),
                    message: t('tenants.unavailableBody'),
                    icon: 'shield-off',
                });
                return;
            }
            UI.renderError(container, { title: t('tenants.loadFailed'), message: err.message }, () => this.render());
            return;
        }
        gate.done();

        const tenants = this.tenants;
        const currentId = App.session && App.session.tenantId;

        container.innerHTML = esc(html`
            <div class="page-toolbar">
                <p class="page-toolbar-count">${t('tenants.count', { count: tenants.length })}</p>
                <div class="toolbar-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="app:navigate" data-target="operations">
                        <i data-lucide="activity" aria-hidden="true"></i> ${t('tenants.openOps')}
                    </button>
                    <button type="button" class="btn btn-primary btn-sm" data-action="tenants:showCreateModal">
                        <i data-lucide="plus" aria-hidden="true"></i> ${t('tenants.new')}
                    </button>
                </div>
            </div>

            <div class="table-card surface">
                <div class="table-wrapper">
                    <table class="data-table tenants-table">
                        <thead><tr>
                            <th scope="col">${t('tenants.table.tenant')}</th>
                            <th scope="col" class="col-health">${t('tenants.table.token')}</th>
                            <th scope="col" class="col-health">${t('tenants.table.webhook')}</th>
                            <th scope="col">${t('tenants.table.dms')}</th>
                            <th scope="col">${t('tenants.table.posts7d')}</th>
                            <th scope="col">${t('tenants.table.campaigns')}</th>
                            <th scope="col">${t('tenants.table.scheduled')}</th>
                            <th scope="col">${t('tenants.table.conversations')}</th>
                            <th scope="col"><span class="sr-only">${t('tenants.table.actions')}</span></th>
                        </tr></thead>
                        <tbody>
                            ${tenants.map((x) => this.renderRow(x, currentId))}
                            ${tenants.length === 0 ? html`
                                <tr><td colspan="9" class="table-empty-cell">${t('tenants.empty')}</td></tr>
                            ` : ''}
                        </tbody>
                    </table>
                </div>
            </div>
        `);

        UI.icons(container);

        // Meter widths are data, not style: applied from data-share after the
        // markup is escaped, so no percentage is ever interpolated into HTML.
        container.querySelectorAll('.dm-meter-fill[data-share]').forEach((el) => {
            el.style.inlineSize = `${Number(el.dataset.share) || 0}%`;
        });
    },

    renderRow(row, currentId) {
        const id = this.pick(row, 'id', 'tenant_id', 'creator_id');
        const name = this.pick(row, 'name', 'display_name') || t('tenants.untitled');
        const isActive = this.pick(row, 'is_active', 'isActive') !== false;
        const isCurrent = id && currentId && String(id) === String(currentId);

        const igId = this.pick(row, 'instagram_page_id', 'instagramPageId');
        const fbId = this.pick(row, 'facebook_page_id', 'facebookPageId');

        const webhook = UI.relativeAge(
            this.pick(row, 'last_webhook_at', 'lastWebhookAt', 'last_webhook_received_at', 'lastWebhookReceivedAt', 'last_webhook'),
            { warnMs: 6 * 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 }
        );

        const published = this.num(row, 'published_7d', 'posts_published_7d', 'postsPublished7d');
        const failed = this.num(row, 'failed_7d', 'posts_failed_7d', 'postsFailed7d');
        const campaigns = this.num(row, 'campaign_count', 'campaignCount', 'campaigns');
        const scheduled = this.num(row, 'scheduled_post_count', 'scheduledPostCount', 'scheduled_posts');
        const conversations = this.num(row, 'conversation_count', 'conversationCount', 'conversations');

        const dmUsed = this.num(row, 'dm_this_hour', 'dmThisHour', 'dm_volume_hour', 'dms_this_hour');
        const dmCeiling = this.num(row, 'dm_hourly_limit', 'dmHourlyLimit', 'dm_ceiling')
            ?? (typeof this.dmCeiling === 'number' ? this.dmCeiling : null);

        return html`
            <tr class="${isActive ? '' : html.raw('tenant-row-inactive')}" data-tenant-id="${id}">
                <td>
                    <div class="tenant-name-cell">
                        <span class="tenant-name" dir="auto">${name}</span>
                        ${isCurrent ? html`<span class="chip chip-accent">${t('tenants.current')}</span>` : ''}
                        ${isActive ? '' : html`<span class="chip">${t('tenants.inactive')}</span>`}
                    </div>
                    <div class="tenant-page-ids">
                        <span>IG ${UI.ltr(igId || '—')}</span>
                        <span>FB ${UI.ltr(fbId || '—')}</span>
                    </div>
                </td>
                <td class="col-health">${this.tokenBadge(this.pick(row, 'token_status', 'tokenStatus'))}</td>
                <td class="col-health">
                    <span class="health-pill health-${html.raw(webhook.level)}" title="${webhook.title}">
                        <span class="health-dot" aria-hidden="true"></span>${webhook.text}
                    </span>
                </td>
                <td>${this.dmMeter(dmUsed, dmCeiling)}</td>
                <td class="nowrap">
                    ${published === null && failed === null ? '—' : html`
                        <span class="count-ok">${t('tenants.postsSent', { count: published === null ? '—' : UI.formatNumber(published) })}</span>
                        <span class="count-bad ${failed ? '' : html.raw('count-zero')}">${t('tenants.postsFailed', { count: failed === null ? '—' : UI.formatNumber(failed) })}</span>
                    `}
                </td>
                <td>${campaigns === null ? '—' : UI.formatNumber(campaigns)}</td>
                <td>${scheduled === null ? '—' : UI.formatNumber(scheduled)}</td>
                <td>${conversations === null ? '—' : UI.formatNumber(conversations)}</td>
                <td>
                    <div class="row-actions">
                        <!-- Inspect FIRST: investigating a red row should not
                             require switching into the tenant and losing your
                             place, which is what every other route here does. -->
                        <button type="button" class="icon-btn" data-action="tenants:openDetail" data-id="${id}"
                                aria-label="${t('ops.inspectFor', { name })}" title="${t('ops.inspect')}">
                            <i data-lucide="search" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="icon-btn" data-action="tenants:recheckToken" data-id="${id}"
                                aria-label="${t('ops.recheckFor', { name })}" title="${t('ops.recheck')}">
                            <i data-lucide="refresh-cw" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="icon-btn" data-action="tenants:switchInto" data-id="${id}"
                                aria-label="${t('tenants.switchInto', { name })}" title="${t('tenants.switchInto', { name })}"
                                ${isCurrent ? html.raw('disabled') : ''}>
                            <i data-lucide="log-in" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="icon-btn" data-action="tenants:showRenameModal" data-id="${id}"
                                aria-label="${t('tenants.rename', { name })}" title="${t('tenants.rename', { name })}">
                            <i data-lucide="pencil" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="icon-btn ${isActive ? html.raw('icon-btn-danger') : ''}"
                                data-action="tenants:toggleActive" data-id="${id}"
                                aria-label="${isActive ? t('tenants.deactivate', { name }) : t('tenants.activate', { name })}"
                                title="${isActive ? t('tenants.deactivate', { name }) : t('tenants.activate', { name })}">
                            <i data-lucide="${isActive ? 'power-off' : 'power'}" aria-hidden="true"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    },

    tokenBadge(status) {
        const value = String(status || '').toLowerCase();
        const valid = value === 'valid' || value === 'ok' || value === 'active';
        const unknown = !value || value === 'unknown';
        const label = unknown ? t('common.unknown') : (valid ? t('settings.valid') : t('settings.invalid'));
        const level = unknown ? 'warn' : (valid ? 'fresh' : 'stale');
        return html`
            <span class="health-pill health-${html.raw(level)}">
                <i data-lucide="${valid ? 'check-circle' : (unknown ? 'help-circle' : 'alert-triangle')}"
                   aria-hidden="true"></i>${label}
            </span>
        `;
    },

    dmMeter(used, ceiling) {
        if (used === null && ceiling === null) return html`—`;
        if (ceiling === null || ceiling <= 0) {
            return html`<span class="dm-meter-text">${used === null ? '—' : UI.formatNumber(used)}</span>`;
        }
        const value = used === null ? 0 : used;
        const ratio = Math.max(0, Math.min(1, value / ceiling));
        const level = ratio >= 0.9 ? 'stale' : ratio >= 0.6 ? 'warn' : 'fresh';
        return html`
            <div class="dm-meter">
                <span class="dm-meter-text">${UI.ltr(`${UI.formatNumber(value)} / ${UI.formatNumber(ceiling)}`)}</span>
                <span class="dm-meter-track" role="img"
                      aria-label="${t('tenants.dmMeter', { used: UI.formatNumber(value), ceiling: UI.formatNumber(ceiling) })}">
                    <span class="dm-meter-fill dm-meter-${html.raw(level)}" data-share="${Math.round(ratio * 100)}"></span>
                </span>
            </div>
        `;
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    modalHeader(title) {
        return html`
            <div class="modal-header">
                <h2 class="modal-title">${title}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
        `;
    },

    /**
     * `firstRun` is the setup screen's entry point: there is no session tenant
     * yet, so on success we reload /auth/me and land on the dashboard proper
     * instead of re-rendering a page the user cannot reach.
     */
    showCreateModal(firstRun) {
        const isFirstRun = firstRun === true;
        UI.showModal(html`
            ${this.modalHeader(isFirstRun ? t('tenants.firstRunTitle') : t('tenants.createTitle'))}
            <form id="tenant-create-form" data-submit="tenants:handleCreate" data-first-run="${isFirstRun ? 'true' : ''}">
                <div class="form-group">
                    <label class="form-label" for="tenant-name">${t('tenants.name')}</label>
                    <input class="field" id="tenant-name" name="name" dir="auto"
                           placeholder="${t('tenants.namePlaceholder')}" required>
                    <p class="form-hint">${t('tenants.nameHint')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="tenant-ig">${t('tenants.igId')}</label>
                    <input class="field" id="tenant-ig" name="instagram_page_id" inputmode="numeric" dir="ltr"
                           autocomplete="off" spellcheck="false" placeholder="17841459652725922" required>
                    <p class="form-hint">${t('tenants.igHint')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="tenant-fb">
                        ${t('tenants.fbId')} <span class="label-optional">${t('common.optional')}</span>
                    </label>
                    <input class="field" id="tenant-fb" name="facebook_page_id" inputmode="numeric" dir="ltr"
                           autocomplete="off" spellcheck="false" placeholder="102938475610293">
                </div>
                <div class="form-group">
                    <label class="form-label" for="tenant-token">${t('tenants.pageToken')}</label>
                    <textarea class="field-textarea field-mono" id="tenant-token" name="page_access_token" dir="ltr"
                              autocomplete="off" spellcheck="false" data-guard-dirty
                              placeholder="${t('settings.tokenPlaceholder')}" required></textarea>
                    <p class="form-hint">${t('tenants.pageTokenHint')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="tenant-verify">
                        ${t('tenants.verifyToken')} <span class="label-optional">${t('common.optional')}</span>
                    </label>
                    <input class="field field-mono" id="tenant-verify" name="webhook_verify_token" type="text" dir="ltr"
                           autocomplete="off" spellcheck="false" placeholder="${t('settings.webhookPlaceholder')}">
                    <p class="form-hint">${t('tenants.verifyTokenHint')}</p>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="plus" aria-hidden="true"></i> ${t('common.create')}</button>
                </div>
            </form>
        `);
    },

    async handleCreate(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const firstRun = form.dataset.firstRun === 'true';
        const payload = {
            name: (data.get('name') || '').toString().trim(),
            instagram_page_id: (data.get('instagram_page_id') || '').toString().trim(),
            page_access_token: (data.get('page_access_token') || '').toString().trim(),
        };
        const facebookPageId = (data.get('facebook_page_id') || '').toString().trim();
        if (facebookPageId) payload.facebook_page_id = facebookPageId;
        const verifyToken = (data.get('webhook_verify_token') || '').toString().trim();
        if (verifyToken) payload.webhook_verify_token = verifyToken;
        if (!payload.name || !payload.instagram_page_id || !payload.page_access_token) return;

        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // already in flight

        try {
            await API.createAdminTenant(payload);
            UI.closeModal();
            UI.toast(t('tenants.created'));
            await App.refreshSession();
            if (firstRun) {
                App.go(App.DEFAULT_PAGE);
            } else {
                this.render();
            }
        } catch (err) {
            restore();
            UI.toast(err.message || t('tenants.createFailed'), 'error');
        }
    },

    showRenameModal(id) {
        const row = this.tenants.find((x) => String(this.pick(x, 'id', 'tenant_id', 'creator_id')) === String(id));
        if (!row) return;
        const name = this.pick(row, 'name', 'display_name') || '';

        UI.showModal(html`
            ${this.modalHeader(t('tenants.renameTitle'))}
            <form id="tenant-rename-form" data-submit="tenants:handleRename" data-id="${id}">
                <div class="form-group">
                    <label class="form-label" for="tenant-rename-input">${t('tenants.name')}</label>
                    <input class="field" id="tenant-rename-input" name="name" dir="auto" value="${name}" required>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="check" aria-hidden="true"></i> ${t('common.save')}</button>
                </div>
            </form>
        `);
    },

    /** Repaint one row from the local model — no fetch, no full table rebuild. */
    patchRow(id) {
        const row = this.tenants.find((x) => String(this.pick(x, 'id', 'tenant_id', 'creator_id')) === String(id));
        const tr = document.querySelector(`tr[data-tenant-id="${CSS.escape(String(id))}"]`);
        if (!row || !tr) { this.render(); return; }
        const wrapper = document.createElement('tbody');
        wrapper.innerHTML = esc(this.renderRow(row, App.session && App.session.tenantId));
        const next = wrapper.firstElementChild;
        if (!next) return;
        tr.replaceWith(next);
        UI.icons(next);
    },

    /**
     * A rename is one string the operator just typed, so the modal closes and
     * the name changes on the spot. The session refresh (which repopulates the
     * tenant switcher in the header) happens behind it rather than in front of
     * it, and a rejection puts the old name back.
     */
    handleRename(form, event) {
        event.preventDefault();
        const id = form.dataset.id;
        const name = (new FormData(form).get('name') || '').toString().trim();
        if (!name) return Promise.resolve();

        const row = this.tenants.find((x) => String(this.pick(x, 'id', 'tenant_id', 'creator_id')) === String(id));
        if (!row) return Promise.resolve();
        const previous = row.name;

        UI.closeModal();
        row.name = name;
        this.patchRow(id);

        return Motion.optimistic({
            send: () => API.updateAdminTenant(id, { name }),
            revert: () => { row.name = previous; this.patchRow(id); },
            onError: (err) => UI.toast((err && err.message) || t('tenants.renameFailed'), 'error'),
        }).then(async (result) => {
            if (result !== null) await App.refreshSession();
            return result;
        });
    },

    /**
     * Deactivating stops this tenant's webhooks being processed and its
     * scheduled posts publishing, so it asks first — through the product's own
     * modal. `window.confirm()` used to sit here: unstyleable, untranslatable,
     * and dropping the interface's identity at exactly the moment the operator
     * is deciding whether to break something.
     */
    toggleActive(btn) {
        const id = btn.dataset.id;
        const row = this.tenants.find((x) => String(this.pick(x, 'id', 'tenant_id', 'creator_id')) === String(id));
        if (!row) return Promise.resolve();
        const isActive = this.pick(row, 'is_active', 'isActive') !== false;
        const name = this.pick(row, 'name', 'display_name') || t('tenants.untitled');

        if (isActive) {
            Admin.confirm({
                title: t('tenantDetail.deactivateTitle'),
                body: t('tenants.deactivateConfirm', { name }),
                hint: t('tenantDetail.deactivateHint'),
                confirmLabel: t('tenantDetail.deactivate'),
                confirmIcon: 'power-off',
                onConfirm: () => this.setActive(id, false),
            });
            return Promise.resolve();
        }
        return this.setActive(id, true);
    },

    setActive(id, value) {
        const row = this.tenants.find((x) => String(this.pick(x, 'id', 'tenant_id', 'creator_id')) === String(id));
        if (!row) return Promise.resolve();
        const isActive = this.pick(row, 'is_active', 'isActive') !== false;
        if (isActive === value) return Promise.resolve();

        const paint = (next) => {
            row.is_active = next;
            if ('isActive' in row) row.isActive = next;
            this.patchRow(id);
        };

        paint(value);

        return Motion.optimistic({
            send: () => API.updateAdminTenant(id, { is_active: value }),
            revert: () => paint(isActive),
            onError: (err) => UI.toast((err && err.message) || t('tenants.updateFailed'), 'error'),
        }).then(async (result) => {
            if (result !== null) await App.refreshSession();
            return result;
        });
    },

    async switchInto(btn) {
        await App.switchTenant(btn.dataset.id);
    },

    /** The detail view, which does NOT mint a token for the tenant. */
    openDetail(id) {
        if (!id) return;
        App.goWithQuery('tenant_detail', { id });
    },

    /**
     * Ask Meta about this token right now. A `token_status` column can be
     * weeks stale, and a green pill last checked eleven days ago is not
     * evidence that anything still works.
     */
    async recheckToken(btn) {
        const id = btn.dataset.id;
        btn.disabled = true;
        try {
            await API.recheckAdminTenantToken(id);
            UI.toast(t('ops.rechecked'));
            await this.render();
        } catch (err) {
            btn.disabled = false;
            UI.toast((err && err.message) || t('ops.recheckFailed'), 'error');
        }
    },
};

/** Async handlers report their own failures; the dispatcher only catches sync throws. */
const reportTenantFailure = (promise) => {
    if (promise && typeof promise.catch === 'function') {
        promise.catch((err) => UI.toast((err && err.message) || t('common.error'), 'error'));
    }
};

UI.registerActions('tenants', {
    render: () => reportTenantFailure(TenantsPage.render()),
    showCreateModal: () => TenantsPage.showCreateModal(false),
    showFirstRunCreateModal: () => TenantsPage.showCreateModal(true),
    handleCreate: (el, e) => reportTenantFailure(TenantsPage.handleCreate(el, e)),
    showRenameModal: (el) => TenantsPage.showRenameModal(el.dataset.id),
    handleRename: (el, e) => reportTenantFailure(TenantsPage.handleRename(el, e)),
    toggleActive: (el) => reportTenantFailure(TenantsPage.toggleActive(el)),
    switchInto: (el) => reportTenantFailure(TenantsPage.switchInto(el)),
    openDetail: (el) => TenantsPage.openDetail(el.dataset.id),
    recheckToken: (el) => reportTenantFailure(TenantsPage.recheckToken(el)),
});
