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
        container.innerHTML = UI.loader('Loading users…');

        try {
            const result = await API.getAdminUsers();
            this.users = Array.isArray(result) ? result : (result && result.users) || [];
        } catch (err) {
            if (err.status === 403 || err.status === 404) {
                App.dropAdminAccess();
                UI.renderError(container, {
                    title: 'User administration is not available',
                    message: 'This account is not a platform administrator, or this deployment does not serve the admin API yet.',
                    icon: 'shield-off',
                });
                return;
            }
            UI.renderError(
                container,
                { title: 'Could not load users', message: err.message },
                () => this.render()
            );
            return;
        }

        const users = this.users;

        container.innerHTML = esc(html`
            <div class="page-toolbar">
                <p class="page-toolbar-count">${users.length} user${users.length !== 1 ? 's' : ''}</p>
                <button type="button" class="btn btn-primary btn-sm" data-action="users:showCreateModal">
                    <i data-lucide="user-plus" aria-hidden="true"></i> New User
                </button>
            </div>

            <div class="table-card glass-card">
                <div class="table-wrapper">
                    <table class="data-table">
                        <thead><tr>
                            <th scope="col">Email</th>
                            <th scope="col">Role</th>
                            <th scope="col">Last login</th>
                            <th scope="col">Tenants</th>
                            <th scope="col"><span class="sr-only">Actions</span></th>
                        </tr></thead>
                        <tbody>
                            ${users.map((u) => this.renderRow(u))}
                            ${users.length === 0 ? html`
                                <tr><td colspan="5" class="table-empty-cell">
                                    No user accounts yet — the shared dashboard password is still the only way in.
                                </td></tr>
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
        const age = UI.relativeAge(lastLogin, { neverText: 'Never signed in', warnMs: Infinity, staleMs: Infinity });
        const memberships = this.pick(u, 'memberships', 'tenants');

        return html`
            <tr>
                <td><span class="user-email" dir="auto">${email}</span></td>
                <td><span class="role-chip ${isAdmin ? html.raw('role-admin') : ''}">${isAdmin ? 'Platform admin' : role}</span></td>
                <td style="white-space:nowrap;" title="${lastLogin ? age.title : ''}">
                    ${lastLogin ? UI.formatDate(lastLogin) : 'Never'}
                </td>
                <td class="user-tenants">
                    ${Array.isArray(memberships) && memberships.length > 0
                        ? memberships.map((m) => html`<span class="scope-chip" dir="auto">${
                            (typeof m === 'string' ? m : (m.tenant_name || m.name || m.tenant_id || m.tenantId || '—'))
                          }</span>`)
                        : html`<span class="text-muted-sm">None</span>`}
                </td>
                <td>
                    <div class="row-actions">
                        <button type="button" class="icon-btn" data-action="users:showMembershipModal" data-id="${id}"
                                aria-label="Grant ${email} access to a tenant" title="Grant tenant access">
                            <i data-lucide="link" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="icon-btn icon-btn-danger" data-action="users:revoke" data-id="${id}"
                                data-email="${email}" aria-label="Revoke all sessions for ${email}" title="Revoke sessions">
                            <i data-lucide="log-out" aria-hidden="true"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    showCreateModal() {
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">New User</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="Close dialog">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <form id="user-create-form" data-submit="users:handleCreate">
                <div class="form-group">
                    <label class="form-label" for="user-email">Email</label>
                    <input class="form-input" id="user-email" name="email" type="email"
                           autocomplete="off" spellcheck="false" placeholder="name@example.com" required>
                </div>
                <div class="form-group">
                    <label class="form-label" for="user-password">Password</label>
                    <input class="form-input" id="user-password" name="password" type="password"
                           autocomplete="new-password" minlength="12" required>
                    <p class="form-hint">At least 12 characters. Send it to them over a channel you trust; they can change it later.</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="user-role">Role</label>
                    <select class="form-input" id="user-role" name="role">
                        <option value="user" selected>User — only the tenants you grant</option>
                        <option value="platform_admin">Platform admin — every tenant, plus this page</option>
                    </select>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">Cancel</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="user-plus" aria-hidden="true"></i> Create</button>
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
            await API.createAdminUser({
                email: (data.get('email') || '').toString().trim(),
                password: (data.get('password') || '').toString(),
                role: (data.get('role') || 'user').toString(),
            });
            UI.closeModal();
            UI.toast('User created.');
            this.render();
        } catch (err) {
            if (submit) submit.disabled = false;
            UI.toast(err.message || 'Could not create the user.', 'error');
        }
    },

    async showMembershipModal(id) {
        const u = this.users.find((x) => String(this.pick(x, 'id', 'user_id')) === String(id));
        const email = (u && this.pick(u, 'email')) || '';

        // Prefer the full tenant list; fall back to the session's own tenants so
        // the modal still works if /admin/tenants is unavailable.
        let tenants = [];
        try {
            const result = await API.getAdminTenants();
            tenants = Array.isArray(result) ? result : (result && result.tenants) || [];
        } catch {
            tenants = (App.session && App.session.tenants) || [];
        }

        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">Grant Tenant Access</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="Close dialog">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <form id="user-membership-form" data-submit="users:handleMembership" data-id="${id}">
                <p class="form-hint" style="margin-bottom:16px;" dir="auto">${email}</p>
                <div class="form-group">
                    <label class="form-label" for="membership-tenant">Tenant</label>
                    <select class="form-input" id="membership-tenant" name="tenantId" required>
                        ${tenants.length === 0
                            ? html`<option value="">No tenants available</option>`
                            : tenants.map((t) => html`<option value="${this.pick(t, 'id', 'tenant_id', 'creator_id')}">${this.pick(t, 'name', 'display_name') || this.pick(t, 'id')}</option>`)}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="membership-role">Role in this tenant</label>
                    <select class="form-input" id="membership-role" name="role">
                        <option value="member" selected>Member</option>
                        <option value="admin">Admin</option>
                    </select>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">Cancel</button>
                    <button type="submit" class="btn btn-primary" ${tenants.length === 0 ? html.raw('disabled') : ''}>
                        <i data-lucide="link" aria-hidden="true"></i> Grant
                    </button>
                </div>
            </form>
        `);
    },

    async handleMembership(form, event) {
        event.preventDefault();
        const id = form.dataset.id;
        const data = new FormData(form);
        const tenantId = (data.get('tenantId') || '').toString();
        if (!tenantId) return;
        try {
            await API.createUserMembership(id, { tenantId, role: (data.get('role') || 'member').toString() });
            UI.closeModal();
            UI.toast('Access granted.');
            this.render();
        } catch (err) {
            UI.toast(err.message || 'Could not grant access.', 'error');
        }
    },

    async revoke(btn) {
        const email = btn.dataset.email || 'this user';
        if (!confirm(`Revoke every session for ${email}? They will be signed out everywhere immediately.`)) return;
        btn.disabled = true;
        try {
            await API.revokeUserSessions(btn.dataset.id);
            UI.toast('Sessions revoked.');
            this.render();
        } catch (err) {
            btn.disabled = false;
            UI.toast(err.message || 'Could not revoke sessions.', 'error');
        }
    },
};

UI.registerActions('users', {
    render: () => UsersPage.render(),
    showCreateModal: () => UsersPage.showCreateModal(),
    handleCreate: (el, e) => UsersPage.handleCreate(el, e),
    showMembershipModal: (el) => UsersPage.showMembershipModal(el.dataset.id),
    handleMembership: (el, e) => UsersPage.handleMembership(el, e),
    revoke: (el) => UsersPage.revoke(el),
});
