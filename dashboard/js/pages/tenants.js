/**
 * Tenants Page — platform-admin only.
 *
 * This is the operations screen: one row per tenant, and the two columns that
 * say "something is broken" — access-token status and last webhook received —
 * are the ones that read first. A tenant whose last webhook is days old is a
 * red pill saying "3d ago", not a date the reader has to subtract from today.
 *
 * Field names are read tolerantly (`pick()` below): the admin API is being
 * built in parallel, so a count that arrives under a different key renders as
 * "—" instead of "undefined", and the page still loads.
 */
const TenantsPage = {
    tenants: [],

    /** Cleared on tenant switch (see App.resetTenantState). */
    resetTenantState() {
        this.tenants = [];
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

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader('Loading tenants…');

        try {
            const result = await API.getAdminTenants();
            this.tenants = Array.isArray(result) ? result : (result && result.tenants) || [];
        } catch (err) {
            // 403/404 is "not a platform admin", or the route is not deployed yet.
            // Either way this is not an error the operator can act on by retrying.
            if (err.status === 403 || err.status === 404) {
                App.dropAdminAccess();
                UI.renderError(container, {
                    title: 'Tenant administration is not available',
                    message: 'This account is not a platform administrator, or this deployment does not serve the admin API yet.',
                    icon: 'shield-off',
                });
                return;
            }
            UI.renderError(
                container,
                { title: 'Could not load tenants', message: err.message },
                () => this.render()
            );
            return;
        }

        const tenants = this.tenants;
        const currentId = App.session && App.session.tenantId;

        container.innerHTML = esc(html`
            <div class="page-toolbar">
                <p class="page-toolbar-count">${tenants.length} tenant${tenants.length !== 1 ? 's' : ''}</p>
                <button type="button" class="btn btn-primary btn-sm" data-action="tenants:showCreateModal">
                    <i data-lucide="plus" aria-hidden="true"></i> New Tenant
                </button>
            </div>

            <div class="table-card glass-card">
                <div class="table-wrapper">
                    <table class="data-table tenants-table">
                        <thead><tr>
                            <th scope="col">Tenant</th>
                            <th scope="col" class="col-health">Access token</th>
                            <th scope="col" class="col-health">Last webhook</th>
                            <th scope="col">DMs this hour</th>
                            <th scope="col">Posts (7d)</th>
                            <th scope="col">Campaigns</th>
                            <th scope="col">Scheduled</th>
                            <th scope="col">Conversations</th>
                            <th scope="col"><span class="sr-only">Actions</span></th>
                        </tr></thead>
                        <tbody>
                            ${tenants.map((t) => this.renderRow(t, currentId))}
                            ${tenants.length === 0 ? html`
                                <tr><td colspan="9" class="table-empty-cell">No tenants yet. Create the first one to start receiving webhooks.</td></tr>
                            ` : ''}
                        </tbody>
                    </table>
                </div>
            </div>
        `);

        UI.icons(container);
    },

    renderRow(t, currentId) {
        const id = this.pick(t, 'id', 'tenant_id', 'creator_id');
        const name = this.pick(t, 'name', 'display_name') || 'Untitled tenant';
        const isActive = this.pick(t, 'is_active', 'isActive') !== false;
        const isCurrent = id && currentId && String(id) === String(currentId);

        const igId = this.pick(t, 'instagram_page_id', 'instagramPageId');
        const fbId = this.pick(t, 'facebook_page_id', 'facebookPageId');

        const webhook = UI.relativeAge(
            this.pick(t, 'last_webhook_at', 'lastWebhookAt', 'last_webhook_received_at', 'lastWebhookReceivedAt', 'last_webhook'),
            { warnMs: 6 * 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000, neverText: 'Never' }
        );

        const published = this.num(t, 'posts_published_7d', 'postsPublished7d', 'published_last_7d');
        const failed = this.num(t, 'posts_failed_7d', 'postsFailed7d', 'failed_last_7d');
        const campaigns = this.num(t, 'campaign_count', 'campaignCount', 'campaigns');
        const scheduled = this.num(t, 'scheduled_post_count', 'scheduledPostCount', 'scheduled_posts');
        const conversations = this.num(t, 'conversation_count', 'conversationCount', 'conversations');

        const dmUsed = this.num(t, 'dm_volume_hour', 'dmVolumeHour', 'dms_this_hour', 'dmsThisHour', 'dm_count_hour');
        const dmCeiling = this.num(t, 'dm_hourly_limit', 'dmHourlyLimit', 'dm_ceiling', 'dmCeiling', 'dm_limit');

        return html`
            <tr class="${isActive ? '' : html.raw('tenant-row-inactive')}">
                <td>
                    <div class="tenant-name-cell">
                        <span class="tenant-name" dir="auto">${name}</span>
                        ${isCurrent ? html`<span class="tenant-current-chip">Current</span>` : ''}
                        ${isActive ? '' : html`<span class="tenant-paused-chip">Inactive</span>`}
                    </div>
                    <div class="tenant-page-ids">
                        <span title="Instagram page ID">IG ${igId || '—'}</span>
                        <span title="Facebook page ID">FB ${fbId || '—'}</span>
                    </div>
                </td>
                <td class="col-health">${this.tokenBadge(this.pick(t, 'token_status', 'tokenStatus'))}</td>
                <td class="col-health">
                    <span class="health-pill health-${html.raw(webhook.level)}" title="${webhook.title}">
                        <span class="health-dot" aria-hidden="true"></span>${webhook.text}
                    </span>
                </td>
                <td>${this.dmMeter(dmUsed, dmCeiling)}</td>
                <td class="cell-tight">
                    ${published === null && failed === null ? '—' : html`
                        <span class="count-ok">${published === null ? '—' : published} sent</span>
                        <span class="count-bad ${failed ? '' : html.raw('count-zero')}">${failed === null ? '—' : failed} failed</span>
                    `}
                </td>
                <td>${campaigns === null ? '—' : campaigns}</td>
                <td>${scheduled === null ? '—' : scheduled}</td>
                <td>${conversations === null ? '—' : conversations}</td>
                <td>
                    <div class="row-actions">
                        <button type="button" class="icon-btn" data-action="tenants:switchInto" data-id="${id}"
                                aria-label="Switch into ${name}" title="Switch into this tenant"
                                ${isCurrent ? html.raw('disabled') : ''}>
                            <i data-lucide="log-in" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="icon-btn" data-action="tenants:showRenameModal" data-id="${id}"
                                aria-label="Rename ${name}" title="Rename">
                            <i data-lucide="pencil" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="icon-btn ${isActive ? html.raw('icon-btn-danger') : ''}"
                                data-action="tenants:toggleActive" data-id="${id}"
                                aria-label="${isActive ? `Deactivate ${name}` : `Activate ${name}`}"
                                title="${isActive ? 'Deactivate' : 'Activate'}">
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
        const label = unknown ? 'Unknown' : (valid ? 'Valid' : (value === 'expired' ? 'Expired' : 'Invalid'));
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
        if (ceiling === null || ceiling <= 0) return html`<span class="dm-meter-text">${used === null ? '—' : used}</span>`;
        const value = used === null ? 0 : used;
        const ratio = Math.max(0, Math.min(1, value / ceiling));
        const level = ratio >= 0.9 ? 'stale' : ratio >= 0.6 ? 'warn' : 'fresh';
        return html`
            <div class="dm-meter">
                <span class="dm-meter-text">${value} / ${ceiling}</span>
                <span class="dm-meter-track" role="img"
                      aria-label="${value} of ${ceiling} DMs used this hour">
                    <span class="dm-meter-fill dm-meter-${html.raw(level)}" style="width:${html.raw(String(Math.round(ratio * 100)))}%;"></span>
                </span>
            </div>
        `;
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    /**
     * `firstRun` is the setup screen's entry point: there is no session tenant
     * yet, so on success we reload /auth/me and land on the dashboard proper
     * instead of re-rendering a page the user cannot reach.
     */
    showCreateModal(firstRun) {
        const isFirstRun = firstRun === true;
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">${isFirstRun ? 'Create your first tenant' : 'New Tenant'}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="Close dialog">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <form id="tenant-create-form" data-submit="tenants:handleCreate" data-first-run="${isFirstRun ? 'true' : ''}">
                <div class="form-group">
                    <label class="form-label" for="tenant-name">Tenant name</label>
                    <input class="form-input" id="tenant-name" name="name" dir="auto"
                           placeholder="e.g. Elharef Store" required>
                    <p class="form-hint">Only a label for this dashboard — Meta never sees it.</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="tenant-ig">Instagram page ID</label>
                    <input class="form-input" id="tenant-ig" name="instagram_page_id" inputmode="numeric"
                           autocomplete="off" spellcheck="false" placeholder="e.g. 17841459652725922">
                </div>
                <div class="form-group">
                    <label class="form-label" for="tenant-fb">Facebook page ID</label>
                    <input class="form-input" id="tenant-fb" name="facebook_page_id" inputmode="numeric"
                           autocomplete="off" spellcheck="false" placeholder="e.g. 102938475610293">
                </div>
                <div class="form-group">
                    <label class="form-label" for="tenant-token">Page access token</label>
                    <textarea class="form-textarea" id="tenant-token" name="page_access_token"
                              autocomplete="off" spellcheck="false"
                              style="min-height:70px;font-size:12px;word-break:break-all;"
                              placeholder="Paste the Page Access Token from the Meta Graph API Explorer…"></textarea>
                    <p class="form-hint">Needed before anything can send. You can add it later from Settings.</p>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">Cancel</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="plus" aria-hidden="true"></i> Create</button>
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
            instagram_page_id: (data.get('instagram_page_id') || '').toString().trim() || null,
            facebook_page_id: (data.get('facebook_page_id') || '').toString().trim() || null,
            page_access_token: (data.get('page_access_token') || '').toString().trim() || null,
        };
        if (!payload.name) return;

        const submit = form.querySelector('button[type="submit"]');
        if (submit) submit.disabled = true;

        try {
            await API.createAdminTenant(payload);
            UI.closeModal();
            UI.toast('Tenant created.');
            await App.refreshSession();
            if (firstRun) {
                App.go(App.DEFAULT_PAGE);
            } else {
                this.render();
            }
        } catch (err) {
            if (submit) submit.disabled = false;
            UI.toast(err.message || 'Could not create the tenant.', 'error');
        }
    },

    showRenameModal(id) {
        const t = this.tenants.find((x) => String(this.pick(x, 'id', 'tenant_id', 'creator_id')) === String(id));
        if (!t) return;
        const name = this.pick(t, 'name', 'display_name') || '';

        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">Rename Tenant</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="Close dialog">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <form id="tenant-rename-form" data-submit="tenants:handleRename" data-id="${id}">
                <div class="form-group">
                    <label class="form-label" for="tenant-rename-input">Tenant name</label>
                    <input class="form-input" id="tenant-rename-input" name="name" dir="auto"
                           value="${name}" required>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">Cancel</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="check" aria-hidden="true"></i> Save</button>
                </div>
            </form>
        `);
    },

    async handleRename(form, event) {
        event.preventDefault();
        const id = form.dataset.id;
        const name = (new FormData(form).get('name') || '').toString().trim();
        if (!name) return;
        try {
            await API.updateAdminTenant(id, { name });
            UI.closeModal();
            UI.toast('Tenant renamed.');
            await App.refreshSession();
            this.render();
        } catch (err) {
            UI.toast(err.message || 'Could not rename the tenant.', 'error');
        }
    },

    async toggleActive(btn) {
        const id = btn.dataset.id;
        const t = this.tenants.find((x) => String(this.pick(x, 'id', 'tenant_id', 'creator_id')) === String(id));
        if (!t) return;
        const isActive = this.pick(t, 'is_active', 'isActive') !== false;
        const name = this.pick(t, 'name', 'display_name') || 'this tenant';

        if (isActive && !confirm(
            `Deactivate "${name}"? Its webhooks stop being processed and its scheduled posts stop publishing.`
        )) return;

        btn.disabled = true;
        try {
            await API.updateAdminTenant(id, { is_active: !isActive });
            UI.toast(isActive ? 'Tenant deactivated.' : 'Tenant activated.');
            await App.refreshSession();
            this.render();
        } catch (err) {
            btn.disabled = false;
            UI.toast(err.message || 'Could not update the tenant.', 'error');
        }
    },

    async switchInto(btn) {
        await App.switchTenant(btn.dataset.id);
    },
};

UI.registerActions('tenants', {
    render: () => TenantsPage.render(),
    showCreateModal: () => TenantsPage.showCreateModal(false),
    showFirstRunCreateModal: () => TenantsPage.showCreateModal(true),
    handleCreate: (el, e) => TenantsPage.handleCreate(el, e),
    showRenameModal: (el) => TenantsPage.showRenameModal(el.dataset.id),
    handleRename: (el, e) => TenantsPage.handleRename(el, e),
    toggleActive: (el) => TenantsPage.toggleActive(el),
    switchInto: (el) => TenantsPage.switchInto(el),
});
