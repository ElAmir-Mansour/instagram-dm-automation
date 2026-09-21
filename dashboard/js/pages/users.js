/**
 * Users Page — platform-admin only.
 *
 * Deliberately plain: this is an internal tool for the handful of people who
 * operate the platform, not a product surface. List, create, revoke, grant.
 * Field names are read tolerantly for the same reason as in tenants.js.
 */
const UsersPage = {
    users: [],

    resetTenantState() {
        this.users = [];
    },

    pick(row, ...keys) {
        for (const key of keys) {
            if (row && row[key] !== undefined && row[key] !== null) return row[key];
        }
        return undefined;
    },

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();

        try {
            const result = await API.getAdminUsers();
            this.users = Array.isArray(result) ? result : (result && result.users) || [];
        } catch (err) {
            if (err.status === 403 || err.status === 404) {
                App.dropAdminAccess();
                UI.renderError(container, {
                    title: t('users.unavailableTitle'),
                    message: t('tenants.unavailableBody'),
                    icon: 'shield-off',
                });
                return;
            }
            UI.renderError(container, { title: t('users.loadFailed'), message: err.message }, () => this.render());
            return;
        }

        const users = this.users;

        container.innerHTML = esc(html`
            <div class="page-toolbar">
                <p class="page-toolbar-count">${t('users.count', { count: users.length })}</p>
                <div class="toolbar-actions">
                    <button type="button" class="btn btn-primary btn-sm" data-action="users:showCreateModal">
                        <i data-lucide="user-plus" aria-hidden="true"></i> ${t('users.new')}
                    </button>
                </div>
            </div>

            <div class="table-card surface">
                <div class="table-wrapper">
                    <table class="data-table">
                        <thead><tr>
                            <th scope="col">${t('users.table.email')}</th>
                            <th scope="col">${t('users.table.role')}</th>
                            <th scope="col">${t('users.table.lastLogin')}</th>
                            <th scope="col">${t('users.table.tenants')}</th>
                            <th scope="col"><span class="sr-only">${t('tenants.table.actions')}</span></th>
                        </tr></thead>
                        <tbody>
                            ${users.map((u) => this.renderRow(u))}
                            ${users.length === 0 ? html`
                                <tr><td colspan="5" class="table-empty-cell">${t('users.empty')}</td></tr>
                            ` : ''}
                        </tbody>
                    </table>
                </div>
            </div>
        `);

        UI.icons(container);
    },

    renderRow(u) {
        const id = this.pick(u, 'id', 'user_id');
        const email = this.pick(u, 'email') || '—';
        const role = String(this.pick(u, 'role') || 'user');
        const isAdmin = role === 'platform_admin';
        const lastLogin = this.pick(u, 'last_login_at', 'lastLoginAt', 'last_login');
        const age = UI.relativeAge(lastLogin, {
            neverText: t('users.neverSignedIn'), warnMs: Infinity, staleMs: Infinity,
        });
        const memberships = this.pick(u, 'memberships', 'tenants');

        return html`
            <tr>
                <td>${UI.ltr(email)}</td>
                <td><span class="role-chip ${isAdmin ? html.raw('role-admin') : ''}">${isAdmin ? t('users.admin') : role}</span></td>
                <td class="nowrap" title="${lastLogin ? age.title : ''}">
                    ${lastLogin ? UI.formatDate(lastLogin) : t('common.never')}
                </td>
                <td class="user-tenants">
                    ${Array.isArray(memberships) && memberships.length > 0
                        ? memberships.map((m) => html`<span class="chip" dir="auto">${
                            (typeof m === 'string' ? m : (m.name || m.tenant_name || m.creator_id || m.tenant_id || '—'))
                          }</span>`)
                        : html`<span class="text-meta">${t('common.none')}</span>`}
                </td>
                <td>
                    <div class="row-actions">
                        <button type="button" class="icon-btn" data-action="users:showMembershipModal" data-id="${id}"
                                aria-label="${t('users.grant', { email })}" title="${t('users.grant', { email })}">
                            <i data-lucide="link" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="icon-btn icon-btn-danger" data-action="users:revoke" data-id="${id}"
                                data-email="${email}" aria-label="${t('users.revoke', { email })}" title="${t('users.revoke', { email })}">
                            <i data-lucide="log-out" aria-hidden="true"></i>
                        </button>
                    </div>
                </td>
            </tr>
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
     * Tenant options for the two modals. Falls back to the session's own tenant
     * list so a modal still opens if /admin/tenants is momentarily unavailable.
     */
    async loadTenantOptions() {
        try {
            const result = await API.getAdminTenants();
            return Array.isArray(result) ? result : (result && result.tenants) || [];
        } catch {
            return (App.session && App.session.tenants) || [];
        }
    },

    /**
     * The create call also takes an optional first membership. A user with no
     * membership can sign in and reach nothing, so granting one here is worth
     * the extra field.
     */
    async showCreateModal() {
        const tenants = await this.loadTenantOptions();
        UI.showModal(html`
            ${this.modalHeader(t('users.createTitle'))}
            <form id="user-create-form" data-submit="users:handleCreate">
                <div class="form-group">
                    <label class="form-label" for="user-email">${t('users.email')}</label>
                    <input class="field" id="user-email" name="email" type="email" dir="ltr"
                           autocomplete="off" spellcheck="false" placeholder="name@example.com" required>
                </div>
                <div class="form-group">
                    <label class="form-label" for="user-password">${t('users.password')}</label>
                    <input class="field" id="user-password" name="password" type="password" dir="ltr"
                           autocomplete="new-password" minlength="12" required>
                    <p class="form-hint">${t('users.passwordHint')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="user-role">${t('users.role')}</label>
                    <select class="select" id="user-role" name="role">
                        <option value="user" selected>${t('users.roleUser')}</option>
                        <option value="platform_admin">${t('users.roleAdmin')}</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="user-tenant">
                        ${t('users.firstTenant')} <span class="label-optional">${t('common.optional')}</span>
                    </label>
                    <select class="select" id="user-tenant" name="creator_id">
                        <option value="" selected>${t('users.noTenantYet')}</option>
                        ${tenants.map((x) => html`<option value="${this.pick(x, 'id', 'creator_id')}">${this.pick(x, 'name') || this.pick(x, 'id')}</option>`)}
                    </select>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="user-plus" aria-hidden="true"></i> ${t('common.create')}</button>
                </div>
            </form>
        `);
    },

    async handleCreate(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const submit = form.querySelector('button[type="submit"]');
        if (submit) submit.disabled = true;
        try {
            const payload = {
                email: (data.get('email') || '').toString().trim(),
                password: (data.get('password') || '').toString(),
                role: (data.get('role') || 'user').toString(),
            };
            const creatorId = (data.get('creator_id') || '').toString();
            if (creatorId) payload.creator_id = creatorId;
            await API.createAdminUser(payload);
            UI.closeModal();
            UI.toast(t('users.created'));
            this.render();
        } catch (err) {
            if (submit) submit.disabled = false;
            UI.toast(err.message || t('users.createFailed'), 'error');
        }
    },

    async showMembershipModal(id) {
        const u = this.users.find((x) => String(this.pick(x, 'id', 'user_id')) === String(id));
        const email = (u && this.pick(u, 'email')) || '';

        const tenants = await this.loadTenantOptions();

        UI.showModal(html`
            ${this.modalHeader(t('users.membershipTitle'))}
            <form id="user-membership-form" data-submit="users:handleMembership" data-id="${id}">
                <p class="form-hint mbe-4">${UI.ltr(email)}</p>
                <div class="form-group">
                    <label class="form-label" for="membership-tenant">${t('users.membershipTenant')}</label>
                    <select class="select" id="membership-tenant" name="creator_id" required>
                        ${tenants.length === 0
                            ? html`<option value="">${t('users.noTenants')}</option>`
                            : tenants.map((x) => html`<option value="${this.pick(x, 'id', 'creator_id')}">${this.pick(x, 'name') || this.pick(x, 'id')}</option>`)}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="membership-role">${t('users.membershipRole')}</label>
                    <select class="select" id="membership-role" name="role">
                        <option value="owner" selected>${t('users.roleOwner')}</option>
                        <option value="member">${t('users.roleMember')}</option>
                    </select>
                    <p class="form-hint">${t('users.membershipHint')}</p>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary" ${tenants.length === 0 ? html.raw('disabled') : ''}>
                        <i data-lucide="link" aria-hidden="true"></i> ${t('users.grantBtn')}
                    </button>
                </div>
            </form>
        `);
    },

    async handleMembership(form, event) {
        event.preventDefault();
        const id = form.dataset.id;
        const data = new FormData(form);
        const creatorId = (data.get('creator_id') || '').toString();
        if (!creatorId) return;
        try {
            await API.createUserMembership(id, { creator_id: creatorId, role: (data.get('role') || 'owner').toString() });
            UI.closeModal();
            UI.toast(t('users.granted'));
            this.render();
        } catch (err) {
            UI.toast(err.message || t('users.grantFailed'), 'error');
        }
    },

    async revoke(btn) {
        const email = btn.dataset.email || '';
        if (!confirm(t('users.revokeConfirm', { email }))) return;
        btn.disabled = true;
        try {
            await API.revokeUserSessions(btn.dataset.id);
            UI.toast(t('users.revoked'));
            this.render();
        } catch (err) {
            btn.disabled = false;
            UI.toast(err.message || t('users.revokeFailed'), 'error');
        }
    },
};

/** The delegated dispatcher only catches synchronous throws, so async handlers
 *  surface their own failures rather than dying in an unhandled rejection. */
const reportFailure = (promise) => {
    if (promise && typeof promise.catch === 'function') {
        promise.catch((err) => UI.toast((err && err.message) || t('common.error'), 'error'));
    }
};

UI.registerActions('users', {
    render: () => reportFailure(UsersPage.render()),
    showCreateModal: () => reportFailure(UsersPage.showCreateModal()),
    handleCreate: (el, e) => reportFailure(UsersPage.handleCreate(el, e)),
    showMembershipModal: (el) => reportFailure(UsersPage.showMembershipModal(el.dataset.id)),
    handleMembership: (el, e) => reportFailure(UsersPage.handleMembership(el, e)),
    revoke: (el) => reportFailure(UsersPage.revoke(el)),
});
