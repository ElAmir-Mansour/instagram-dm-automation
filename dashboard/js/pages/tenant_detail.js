/**
 * Tenant detail — platform-admin only.
 *
 * Everything about one tenant WITHOUT switching into it. Investigating a red
 * row used to mean minting a new session token for that tenant, which reset
 * every page's cached state and lost your place; you then had to switch back.
 *
 * It is also the only screen where the connection fields can be corrected. A
 * mistyped `instagram_page_id` is the highest-consequence typo in this product
 * — it is the field every inbound webhook is matched against, so one wrong
 * digit means comments stop arriving with no error anywhere — and until now
 * fixing it required SQL against production.
 *
 * Two page ids cannot point at the same tenant, so the server answers 409.
 * "Request failed (409)" is useless; that case gets its own message naming
 * what collided and what to do about it.
 */
const TenantDetailPage = {
    tenant: null,
    tenantId: null,

    resetTenantState() {
        this.tenant = null;
        this.tenantId = null;
    },

    skeleton() {
        return html`
            ${Motion.toolbar()}
            ${Motion.cardGrid(2, 5)}
            ${Motion.busy()}
        `;
    },

    async render() {
        const container = document.getElementById('page-container');
        const id = App.hashParam('id');

        if (!id) {
            container.innerHTML = esc(html`
                <div class="surface pad-5">
                    ${Admin.emptyState('help-circle', t('tenantDetail.noIdTitle'), t('tenantDetail.noIdBody'))}
                    <div class="row row--center">
                        <button type="button" class="btn btn-secondary" data-action="app:navigate" data-target="tenants">
                            <i data-lucide="arrow-left" aria-hidden="true"></i> ${t('tenantDetail.backToTenants')}
                        </button>
                    </div>
                </div>
            `);
            UI.icons(container);
            return;
        }

        this.tenantId = id;
        const gate = Motion.beginLoad(container, () => this.skeleton());

        let detail;
        try {
            detail = await API.getAdminTenant(id);
        } catch (err) {
            gate.done();
            // A 404 on an ID-SCOPED route means "no such tenant", not "you are
            // not an admin" — so it must NOT go through the shared handler,
            // which drops the admin nav. Following a link to a tenant that has
            // since been removed would otherwise take the admin's sidebar away.
            if (err && err.status === 404) {
                container.innerHTML = esc(html`
                    <div class="surface pad-5">
                        ${Admin.emptyState('search-x', t('tenantDetail.goneTitle'), t('tenantDetail.goneBody'))}
                        <div class="row row--center">
                            <button type="button" class="btn btn-secondary" data-action="app:navigate" data-target="tenants">
                                <i data-lucide="arrow-left" aria-hidden="true"></i> ${t('tenantDetail.backToTenants')}
                            </button>
                        </div>
                    </div>
                `);
                UI.icons(container);
                return;
            }
            Admin.renderLoadFailure(container, err, {
                unavailableTitle: t('tenants.unavailableTitle'),
                failedTitle: t('tenantDetail.loadFailed'),
                retry: () => this.render(),
            });
            return;
        }
        gate.done();

        this.tenant = (detail && (detail.tenant || detail.creator || detail)) || {};
        this.paint(container);
    },

    paint(container) {
        const row = this.tenant;
        const id = this.tenantId;
        const name = Admin.pick(row, 'name', 'display_name') || t('tenants.untitled');
        const isActive = Admin.pick(row, 'is_active', 'isActive') !== false;
        const currentId = App.session && App.session.tenantId;
        const isCurrent = id && currentId && String(id) === String(currentId);

        container.innerHTML = esc(html`
            <div class="page-toolbar">
                <button type="button" class="btn btn-ghost btn-sm" data-action="app:navigate" data-target="tenants">
                    <i data-lucide="arrow-left" aria-hidden="true"></i> ${t('tenantDetail.backToTenants')}
                </button>
                <div class="toolbar-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="tenantDetail:render">
                        <i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('ops.refresh')}
                    </button>
                    <button type="button" class="btn btn-secondary btn-sm" data-action="tenantDetail:switchInto"
                            ${isCurrent ? html.raw('disabled') : ''}
                            aria-label="${t('tenants.switchInto', { name })}">
                        <i data-lucide="log-in" aria-hidden="true"></i> ${t('tenantDetail.switchInto')}
                    </button>
                </div>
            </div>

            <section class="section">
                <h2 class="section-title">${t('tenantDetail.identity')}</h2>
                <div class="surface pad-5">
                    <div class="row row--between row--wrap gap-4 mbe-4">
                        <h3 class="detail-name" dir="auto">
                            ${name}
                            ${isCurrent ? html`<span class="chip chip-accent">${t('tenants.current')}</span>` : ''}
                            ${isActive ? '' : html`<span class="chip">${t('tenants.inactive')}</span>`}
                        </h3>
                        <div class="row gap-2 row--wrap">
                            <button type="button" class="btn btn-secondary btn-sm" data-action="tenantDetail:showRenameModal">
                                <i data-lucide="pencil" aria-hidden="true"></i> ${t('tenantDetail.rename')}
                            </button>
                            <button type="button" class="btn ${isActive ? html.raw('btn-danger') : html.raw('btn-secondary')} btn-sm"
                                    data-action="tenantDetail:toggleActive">
                                <i data-lucide="${isActive ? 'power-off' : 'power'}" aria-hidden="true"></i>
                                ${isActive ? t('tenantDetail.deactivate') : t('tenantDetail.activate')}
                            </button>
                        </div>
                    </div>
                    <dl class="ops-facts">
                        ${Admin.field(t('tenantDetail.tenantId'), UI.ltr(id))}
                        ${Admin.field(t('tenantDetail.created'), this.dayOrDash(Admin.pick(row, 'created_at', 'createdAt')))}
                        ${Admin.field(t('tenantDetail.campaigns'), Admin.count(Admin.num(row, 'campaignCount', 'campaign_count', 'campaigns')))}
                        ${Admin.field(t('tenantDetail.scheduled'), Admin.count(Admin.num(row, 'scheduledPostCount', 'scheduled_post_count', 'scheduled_posts')))}
                        ${Admin.field(t('tenantDetail.conversations'), Admin.count(Admin.num(row, 'conversationCount', 'conversation_count', 'conversations')))}
                    </dl>
                </div>
            </section>

            ${this.renderHealth(row)}
            ${this.renderConnection(row)}
        `);

        UI.icons(container);
        Admin.applyMeters(container);
        // Nothing said the page's own data had landed — see CLAUDE.md's WCAG
        // 4.1.3 note on the other admin list pages. No natural count here
        // (this is one tenant, not a list), so this mirrors settings.js's
        // no-count announcement instead.
        Motion.announce(`${t('nav.tenant_detail')} — ${t('common.loaded')}`);
    },

    dayOrDash(value) {
        return value ? UI.formatDay(value) : html`—`;
    },

    renderHealth(row) {
        const tokenStatus = Admin.pick(row, 'tokenStatus', 'token_status');
        const tokenCheckedAt = Admin.pick(row, 'tokenLastCheckedAt', 'token_last_checked_at');
        const tokenErr = Admin.pick(row, 'tokenError', 'token_error');
        const expiresAt = Admin.pick(row, 'tokenExpiresAt', 'token_expires_at');
        const dataAccessAt = Admin.pick(row, 'dataAccessExpiresAt', 'data_access_expires_at');
        const webhookAt = Admin.pick(row, 'lastWebhookAt', 'last_webhook_at');
        const commentAt = Admin.pick(row, 'lastCommentAt', 'last_comment_at');
        const dmAt = Admin.pick(row, 'lastInboundDmAt', 'last_inbound_dm_at');
        const dmUsed = Admin.num(row, 'dmThisHour', 'dm_this_hour');
        const dmCeiling = Admin.num(row, 'dmCeiling', 'dm_ceiling');
        const queue = Admin.pick(row, 'queue') || {};
        const postsPending = Admin.num(row, 'postsPending', 'posts_pending');
        const postsFailed = Admin.num(row, 'postsFailed7d', 'posts_failed_7d');

        return html`
            <section class="section">
                <div class="row row--between row--wrap gap-3 mbe-4">
                    <h2 class="section-title mbe-2">${t('tenantDetail.health')}</h2>
                    <button type="button" class="btn btn-secondary btn-sm" data-action="tenantDetail:recheckToken">
                        <i data-lucide="refresh-cw" aria-hidden="true"></i> ${t('ops.recheck')}
                    </button>
                </div>
                <div class="surface pad-5">
                    <div class="ops-lead mbe-4">
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
                        ${Admin.field(t('ops.queue'), Admin.queueTriple(queue))}
                        ${Admin.field(t('ops.posts'), html`
                            <span>${t('health.postsValue', { pending: postsPending === null ? '—' : UI.formatNumber(postsPending) })}</span>
                            <span class="count-bad ${postsFailed ? '' : html.raw('count-zero')}">${
                                t('tenants.postsFailed', { count: postsFailed === null ? '—' : UI.formatNumber(postsFailed) })
                            }</span>
                        `)}
                        ${Admin.field(t('ops.expires'), expiresAt ? UI.formatDay(expiresAt) : t('settings.expiresNever'))}
                        ${dataAccessAt ? Admin.field(t('ops.dataAccess'), UI.formatDay(dataAccessAt)) : ''}
                    </dl>
                </div>
            </section>
        `;
    },

    /**
     * The editable connection fields.
     *
     * The verify token is a secret: if the server returns only a preview, the
     * input starts empty and an empty input means "leave it alone". Sending an
     * empty string here would clear the one credential whose absence breaks
     * every future subscription change while existing webhooks keep working —
     * the exact failure that already cost this project hours.
     */
    renderConnection(row) {
        const igId = Admin.pick(row, 'instagram_page_id', 'instagramPageId') || '';
        const fbId = Admin.pick(row, 'facebook_page_id', 'facebookPageId') || '';
        const verify = Admin.pick(row, 'webhook_verify_token', 'webhookVerifyToken');
        const verifyPreview = Admin.pick(row, 'webhookVerifyTokenPreview', 'webhook_verify_token_preview');
        const hasVerify = !!(verify || verifyPreview
            || Admin.pick(row, 'webhookVerifyTokenSet', 'webhook_verify_token_set'));

        return html`
            <section class="section">
                <h2 class="section-title">${t('tenantDetail.connection')}</h2>

                <div class="warning-card" role="note">
                    <div class="row row--start gap-4">
                        <span class="stat-icon warning shrink-0"><i data-lucide="alert-triangle" aria-hidden="true"></i></span>
                        <div>
                            <h3 class="warning-card-title">${t('tenantDetail.routingTitle')}</h3>
                            <p>${t('tenantDetail.routingBody')}</p>
                        </div>
                    </div>
                </div>

                <div class="surface pad-5">
                    <form id="tenant-connection-form" data-submit="tenantDetail:handleConnection">
                        <div class="form-group">
                            <label class="form-label" for="detail-ig">${t('tenants.igId')}</label>
                            <input class="field field-mono" id="detail-ig" name="instagram_page_id" type="text"
                                   inputmode="numeric" dir="ltr" autocomplete="off" spellcheck="false"
                                   value="${igId}" aria-describedby="detail-ig-hint" required>
                            <p class="form-hint" id="detail-ig-hint">${t('tenantDetail.igHint')}</p>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="detail-fb">
                                ${t('tenants.fbId')} <span class="label-optional">${t('common.optional')}</span>
                            </label>
                            <input class="field field-mono" id="detail-fb" name="facebook_page_id" type="text"
                                   inputmode="numeric" dir="ltr" autocomplete="off" spellcheck="false"
                                   value="${fbId}" aria-describedby="detail-fb-hint">
                            <p class="form-hint" id="detail-fb-hint">${t('tenantDetail.fbHint')}</p>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="detail-verify">${t('tenants.verifyToken')}</label>
                            <input class="field field-mono" id="detail-verify" name="webhook_verify_token" type="text"
                                   dir="ltr" autocomplete="off" spellcheck="false"
                                   value="${verify || ''}"
                                   placeholder="${hasVerify && !verify ? t('tenantDetail.verifyKeep') : t('settings.webhookPlaceholder')}"
                                   aria-describedby="detail-verify-hint">
                            <p class="form-hint" id="detail-verify-hint">
                                ${hasVerify
                                    ? (verifyPreview
                                        ? t('tenantDetail.verifySetPreview', { preview: verifyPreview })
                                        : t('tenantDetail.verifySet'))
                                    : t('tenantDetail.verifyUnset')}
                                ${' '}${t('tenantDetail.verifyHint')}
                            </p>
                        </div>

                        <div class="form-actions">
                            <button type="submit" class="btn btn-primary btn-sm">
                                <i data-lucide="check" aria-hidden="true"></i> ${t('tenantDetail.saveConnection')}
                            </button>
                            <button type="button" class="btn btn-ghost btn-sm" data-action="tenantDetail:render">
                                ${t('tenantDetail.discard')}
                            </button>
                        </div>
                    </form>
                </div>
            </section>
        `;
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    handleConnection(form, event) {
        event.preventDefault();
        const row = this.tenant || {};
        const data = new FormData(form);

        const igId = (data.get('instagram_page_id') || '').toString().trim();
        const fbId = (data.get('facebook_page_id') || '').toString().trim();
        const verify = (data.get('webhook_verify_token') || '').toString().trim();

        const currentIg = String(Admin.pick(row, 'instagram_page_id', 'instagramPageId') || '');
        const currentFb = String(Admin.pick(row, 'facebook_page_id', 'facebookPageId') || '');
        const currentVerify = Admin.pick(row, 'webhook_verify_token', 'webhookVerifyToken');

        if (!igId) {
            UI.toast(t('tenantDetail.igRequired'), 'error');
            return Promise.resolve();
        }

        const payload = {};
        if (igId !== currentIg) payload.instagram_page_id = igId;
        if (fbId !== currentFb) payload.facebook_page_id = fbId;
        // Empty means "keep it" whenever we never had the value to show.
        if (verify && verify !== String(currentVerify || '')) payload.webhook_verify_token = verify;

        if (Object.keys(payload).length === 0) {
            UI.toast(t('tenantDetail.noChanges'));
            return Promise.resolve();
        }

        // Changing the routing field gets a second look — this is the one edit
        // on the screen that can silently stop every webhook for this tenant.
        if (payload.instagram_page_id) {
            Admin.confirm({
                title: t('tenantDetail.confirmRoutingTitle'),
                body: t('tenantDetail.confirmRoutingBody', {
                    from: currentIg || t('common.none'), to: payload.instagram_page_id,
                }),
                hint: t('tenantDetail.confirmRoutingHint'),
                confirmLabel: t('tenantDetail.confirmRoutingCta'),
                confirmIcon: 'alert-triangle',
                onConfirm: () => this.saveConnection(payload),
            });
            return Promise.resolve();
        }

        return this.saveConnection(payload);
    },

    async saveConnection(payload) {
        const form = document.getElementById('tenant-connection-form');
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // already in flight

        try {
            const result = await API.updateAdminTenant(this.tenantId, payload);
            Object.assign(this.tenant, payload, (result && (result.tenant || result.creator)) || {});
            UI.toast(t('tenantDetail.connectionSaved'));
            await App.refreshSession();
            await this.render();
        } catch (err) {
            restore();
            // 409 = another tenant already claims this page id. Naming that is
            // the difference between a fixable mistake and a dead end.
            const message = Admin.describeWriteError(err, 'tenantDetail.connectionFailed');
            UI.toast(message, 'error');
            if (err && err.status === 409) {
                const field = document.getElementById(
                    payload.instagram_page_id ? 'detail-ig' : 'detail-fb'
                );
                if (field && typeof field.focus === 'function') field.focus();
            }
        }
    },

    showRenameModal() {
        const name = Admin.pick(this.tenant, 'name', 'display_name') || '';
        UI.showModal(html`
            ${Admin.modalHeader(t('tenants.renameTitle'))}
            <form id="detail-rename-form" data-submit="tenantDetail:handleRename">
                <div class="form-group">
                    <label class="form-label" for="detail-rename-input">${t('tenants.name')}</label>
                    <input class="field" id="detail-rename-input" name="name" dir="auto" value="${name}" required>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="check" aria-hidden="true"></i> ${t('common.save')}</button>
                </div>
            </form>
        `);
    },

    async handleRename(form, event) {
        event.preventDefault();
        const name = (new FormData(form).get('name') || '').toString().trim();
        if (!name) return;
        UI.closeModal();
        try {
            await API.updateAdminTenant(this.tenantId, { name });
            this.tenant.name = name;
            UI.toast(t('tenantDetail.renamed'));
            await App.refreshSession();
            await this.render();
        } catch (err) {
            UI.toast((err && err.message) || t('tenants.renameFailed'), 'error');
        }
    },

    toggleActive() {
        const isActive = Admin.pick(this.tenant, 'is_active', 'isActive') !== false;
        const name = Admin.pick(this.tenant, 'name', 'display_name') || t('tenants.untitled');

        if (!isActive) return this.setActive(true);

        Admin.confirm({
            title: t('tenantDetail.deactivateTitle'),
            body: t('tenants.deactivateConfirm', { name }),
            hint: t('tenantDetail.deactivateHint'),
            confirmLabel: t('tenantDetail.deactivate'),
            confirmIcon: 'power-off',
            onConfirm: () => this.setActive(false),
        });
        return Promise.resolve();
    },

    async setActive(value) {
        try {
            await API.updateAdminTenant(this.tenantId, { is_active: value });
            this.tenant.is_active = value;
            if ('isActive' in this.tenant) this.tenant.isActive = value;
            UI.toast(value ? t('tenantDetail.activated') : t('tenantDetail.deactivated'));
            await App.refreshSession();
            await this.render();
        } catch (err) {
            UI.toast((err && err.message) || t('tenants.updateFailed'), 'error');
        }
    },

    async recheckToken(btn) {
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = UI.buttonSpinner(t('ops.rechecking'));
        try {
            await API.recheckAdminTenantToken(this.tenantId);
            UI.toast(t('ops.rechecked'));
            await this.render();
        } catch (err) {
            btn.disabled = false;
            btn.innerHTML = original;
            UI.icons(btn);
            UI.toast((err && err.message) || t('ops.recheckFailed'), 'error');
        }
    },

    async switchInto() {
        await App.switchTenant(this.tenantId);
    },
};

UI.registerActions('tenantDetail', {
    render: () => Admin.report(TenantDetailPage.render()),
    handleConnection: (el, e) => Admin.report(TenantDetailPage.handleConnection(el, e)),
    showRenameModal: () => TenantDetailPage.showRenameModal(),
    handleRename: (el, e) => Admin.report(TenantDetailPage.handleRename(el, e)),
    toggleActive: () => Admin.report(TenantDetailPage.toggleActive()),
    recheckToken: (el) => Admin.report(TenantDetailPage.recheckToken(el)),
    switchInto: () => Admin.report(TenantDetailPage.switchInto()),
});
