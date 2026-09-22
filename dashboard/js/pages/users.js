/**
 * Users — platform-admin only.
 *
 * Still deliberately plain: this is an internal tool for the handful of people
 * who operate the platform. What changed is that it is now COMPLETE. The old
 * screen could list, create, revoke sessions and grant a membership; it could
 * not change a role, could not switch an account off, could not reset a
 * password, and could not take a membership away again. Each of those was a
 * trip to the SQL editor.
 *
 * It also stops lying. `users.passwordHint` told the admin "they can change it
 * later" while no password-change route existed. It does now, it is reachable
 * from the sidebar on every page, and the hint says where.
 *
 * ─── Rows are cards, not a table ────────────────────────────────────────────
 * Each row carries a role select, an active switch, a membership list with a
 * revoke control per membership, and three buttons. That is not a table row at
 * 375px, and rendering the same controls twice (a table for desktop, cards for
 * mobile) would mean two elements sharing one `id` — which breaks every
 * `for=`/`aria-describedby` on the screen. One card list, one data path.
 */
const UsersPage = {
    users: [],
    tenants: [],

    resetTenantState() {
        this.users = [];
        this.tenants = [];
    },

    id(u) {
        return Admin.pick(u, 'id', 'user_id');
    },

    skeleton() {
        return html`
            ${Motion.toolbar()}
            ${Motion.cardGrid(3, 4)}
            ${Motion.busy()}
        `;
    },

    async render() {
        const container = document.getElementById('page-container');
        const gate = Motion.beginLoad(container, () => this.skeleton());

        let result;
        try {
            result = await API.getAdminUsers();
        } catch (err) {
            gate.done();
            Admin.renderLoadFailure(container, err, {
                unavailableTitle: t('users.unavailableTitle'),
                failedTitle: t('users.loadFailed'),
                retry: () => this.render(),
            });
            return;
        }
        gate.done();

        this.users = Array.isArray(result) ? result : (result && result.users) || [];
        this.paint(container);
    },

    paint(container) {
        const users = this.users;
        const canChangeOwn = App.canChangeOwnPassword();

        container.innerHTML = esc(html`
            <div class="page-toolbar">
                <p class="page-toolbar-count">${t('users.count', { count: users.length })}</p>
                <div class="toolbar-actions">
                    ${canChangeOwn ? html`
                        <button type="button" class="btn btn-secondary btn-sm" data-action="app:showPasswordModal">
                            <i data-lucide="key-round" aria-hidden="true"></i> ${t('password.change')}
                        </button>
                    ` : ''}
                    <button type="button" class="btn btn-primary btn-sm" data-action="users:showCreateModal">
                        <i data-lucide="user-plus" aria-hidden="true"></i> ${t('users.new')}
                    </button>
                </div>
            </div>

            <section class="section">
                <h2 class="section-title">${t('users.listTitle')}</h2>
                ${users.length === 0
                    ? html`<div class="surface pad-5">${Admin.emptyState('users', t('users.emptyTitle'), t('users.empty'))}</div>`
                    : html`<div class="user-card-list">${users.map((u) => this.renderCard(u))}</div>`}
            </section>
        `);

        UI.icons(container);
    },

    renderCard(u) {
        const id = this.id(u);
        const email = Admin.pick(u, 'email') || '—';
        const role = String(Admin.pick(u, 'role') || 'user');
        const isAdmin = role === 'platform_admin';
        const isActive = Admin.pick(u, 'is_active', 'isActive') !== false;
        const isSelf = App.session && App.session.userId && String(App.session.userId) === String(id);
        const lastLogin = Admin.pick(u, 'last_login_at', 'lastLoginAt', 'last_login');
        const createdAt = Admin.pick(u, 'created_at', 'createdAt');
        const memberships = this.memberships(u);

        // Ids are per-row so every control keeps its own label.
        const roleId = `user-role-${id}`;
        const activeId = `user-active-${id}`;

        return html`
            <article class="user-card surface ${isActive ? '' : html.raw('user-card-off')}" data-user-id="${id}">
                <header class="user-card-head">
                    <h3 class="user-card-email">${UI.ltr(email)}</h3>
                    <div class="user-card-tags">
                        <span class="role-chip ${isAdmin ? html.raw('role-admin') : ''}">${
                            isAdmin ? t('users.admin') : t('users.member')
                        }</span>
                        ${isSelf ? html`<span class="chip chip-accent">${t('users.you')}</span>` : ''}
                        ${isActive ? '' : html`<span class="chip chip-danger">${t('users.disabledChip')}</span>`}
                    </div>
                </header>

                <dl class="ops-facts">
                    ${Admin.field(t('users.table.lastLogin'), lastLogin
                        ? html`<span title="${UI.formatDateTime(lastLogin)}">${UI.relativeAge(lastLogin, {
                            warnMs: Infinity, staleMs: Infinity, neverText: t('users.neverSignedIn'),
                        }).text}</span>`
                        : html`<span class="text-meta">${t('users.neverSignedIn')}</span>`)}
                    ${Admin.field(t('users.createdAt'), createdAt ? UI.formatDay(createdAt) : html`—`)}
                </dl>

                <div class="user-card-controls">
                    <div class="form-group">
                        <label class="form-label" for="${roleId}">${t('users.role')}</label>
                        <select class="select" id="${roleId}" data-change="users:changeRole" data-id="${id}">
                            <option value="user" ${isAdmin ? '' : html.raw('selected')}>${t('users.roleUser')}</option>
                            <option value="platform_admin" ${isAdmin ? html.raw('selected') : ''}>${t('users.roleAdmin')}</option>
                        </select>
                    </div>

                    <div class="switch-row user-active-row">
                        <span class="switch">
                            <input type="checkbox" id="${activeId}" data-change="users:toggleActive" data-id="${id}"
                                   ${isActive ? html.raw('checked') : ''}>
                            <span class="switch-track"></span>
                        </span>
                        <label class="switch-label" for="${activeId}">${
                            isActive ? t('users.activeOn') : t('users.activeOff')
                        }</label>
                    </div>
                </div>

                <div class="user-memberships">
                    <p class="form-label">${t('users.table.tenants')}</p>
                    ${memberships.length === 0
                        ? html`<p class="text-meta">${t('users.noMemberships')}</p>`
                        : html`<ul class="membership-list">
                            ${memberships.map((m) => this.renderMembership(id, email, m))}
                        </ul>`}
                    <button type="button" class="btn btn-secondary btn-sm mbs-4"
                            data-action="users:showMembershipModal" data-id="${id}"
                            aria-label="${t('users.grant', { email })}">
                        <i data-lucide="link" aria-hidden="true"></i> ${t('users.grantBtn')}
                    </button>
                </div>

                <div class="user-card-actions">
                    <button type="button" class="btn btn-secondary btn-sm"
                            data-action="users:showPasswordModal" data-id="${id}" data-email="${email}"
                            aria-label="${t('users.setPasswordFor', { email })}">
                        <i data-lucide="key-round" aria-hidden="true"></i> ${t('users.setPassword')}
                    </button>
                    <button type="button" class="btn btn-danger btn-sm"
                            data-action="users:confirmRevoke" data-id="${id}" data-email="${email}"
                            aria-label="${t('users.revoke', { email })}">
                        <i data-lucide="log-out" aria-hidden="true"></i> ${t('users.revokeBtn')}
                    </button>
                </div>
            </article>
        `;
    },

    /** Normalise the membership list: strings, ids, or full objects. */
    memberships(u) {
        const raw = Admin.pick(u, 'memberships', 'tenants');
        if (!Array.isArray(raw)) return [];
        return raw.map((m) => {
            if (typeof m === 'string') return { id: m, name: m, role: '' };
            return {
                id: Admin.pick(m, 'creator_id', 'creatorId', 'tenant_id', 'tenantId', 'id'),
                name: Admin.pick(m, 'name', 'tenant_name', 'creator_name')
                    || Admin.pick(m, 'creator_id', 'creatorId', 'tenant_id', 'tenantId', 'id')
                    || t('tenants.untitled'),
                role: Admin.pick(m, 'role') || '',
            };
        });
    },

    renderMembership(userId, email, m) {
        // The role is editable in place. It used to be a word inside a chip,
        // and the form that set it said outright that it was "a label only" —
        // which was true, and is the whole reason a viewer could delete
        // campaigns. Now that it decides something, changing it has to be
        // possible without revoking the membership and granting it again.
        //
        // The revoke control is deliberately NOT `UI.button`: that helper always
        // writes `.btn`, whose padding and min-height fight `.icon-btn`'s fixed
        // 44x44 box, and the two backgrounds would resolve by source order
        // rather than by intent. The primitive is for real buttons; an
        // icon-only control is its own component here and stays one.
        const roleId = `membership-role-${userId}-${m.id}`;
        return html`
            <li class="membership-item">
                <span class="chip membership-name" dir="auto">${m.name}</span>
                <label class="sr-only" for="${roleId}">${t('users.membershipRoleFor', { name: m.name })}</label>
                <select class="select select-sm membership-role" id="${roleId}"
                        data-change="users:changeMembershipRole"
                        data-id="${userId}" data-creator="${m.id}" data-name="${m.name}"
                        ${m.id ? '' : html.raw('disabled')}>
                    ${Admin.roleOptions(m.role)}
                </select>
                <button type="button" class="icon-btn icon-btn-danger"
                        data-action="users:confirmRevokeMembership"
                        data-id="${userId}" data-creator="${m.id}" data-email="${email}" data-name="${m.name}"
                        aria-label="${t('users.revokeMembership', { name: m.name, email })}"
                        title="${t('users.revokeMembership', { name: m.name, email })}"
                        ${m.id ? '' : html.raw('disabled')}>
                    <i data-lucide="unlink" aria-hidden="true"></i>
                </button>
            </li>
        `;
    },

    /**
     * Change one membership's role.
     *
     * The grant endpoint is an upsert (`ON CONFLICT … DO UPDATE SET role`), so
     * re-granting IS the edit — there is no separate PATCH to add and no second
     * server-side path that could disagree with the first about the vocabulary.
     *
     * Restricting somebody confirms; widening does not. That asymmetry is the
     * same one `changeRole` above already makes for platform_admin, and it
     * points the other way here for the same reason: the dangerous direction is
     * the one whose consequence is invisible until the person it happened to
     * tries to do their job.
     */
    changeMembershipRole(select) {
        const { id, creator, name } = select.dataset;
        const u = this.users.find((x) => String(this.id(x)) === String(id));
        if (!u || !creator) return Promise.resolve();

        const membership = this.memberships(u).find((m) => String(m.id) === String(creator));
        const previous = Admin.tenantRole(membership && membership.role);
        const next = Admin.tenantRole(select.value);
        if (next === previous) return Promise.resolve();

        const email = Admin.pick(u, 'email') || '';
        const restricting = Admin.TENANT_ROLES.indexOf(next) > Admin.TENANT_ROLES.indexOf(previous);
        if (!restricting) return this.applyMembershipRole(select, id, creator, next, previous);

        select.value = previous;
        Admin.confirm({
            title: t('users.membershipRoleTitle'),
            body: t('users.membershipRoleBody', {
                email, name: name || '—', role: t(`roles.${next}`),
            }),
            hint: t(`roles.${next}.what`),
            confirmLabel: t('users.membershipRoleCta'),
            confirmIcon: 'shield',
            onConfirm: () => this.applyMembershipRole(select, id, creator, next, previous),
        });
        return Promise.resolve();
    },

    applyMembershipRole(select, id, creator, next, previous) {
        select.disabled = true;
        select.value = next;
        return API.createUserMembership(id, { creator_id: creator, role: next })
            .then(async () => {
                UI.toast(t('users.membershipRoleSaved', { role: t(`roles.${next}`) }));
                await this.render();
                return true;
            })
            .catch((err) => {
                select.disabled = false;
                select.value = previous;
                UI.toast(this.describeUserError(err, 'users.membershipRoleFailed'), 'error');
                return null;
            });
    },

    // ─── Errors ──────────────────────────────────────────────────────────────
    /**
     * The server refuses to remove the platform's last administrator, and it
     * says so specifically. Surfacing that instead of "Request failed" is the
     * difference between "I understand, cancel" and "the page is broken".
     */
    describeUserError(err, fallbackKey) {
        const body = (err && err.body) || {};
        const code = String(body.code || body.error || '');
        if (/last[_\s-]?admin/i.test(code) || /last administrator/i.test(code)) {
            return t('users.lastAdmin');
        }
        return (err && err.message) || t(fallbackKey || 'common.error');
    },

    // ─── Role & active state ─────────────────────────────────────────────────

    changeRole(select) {
        const id = select.dataset.id;
        const u = this.users.find((x) => String(this.id(x)) === String(id));
        if (!u) return Promise.resolve();

        const previous = String(Admin.pick(u, 'role') || 'user');
        const next = select.value === 'platform_admin' ? 'platform_admin' : 'user';
        if (next === previous) return Promise.resolve();

        // Promoting to platform_admin hands over every tenant and this whole
        // administration screen from a single dropdown selection — strictly
        // more consequential than disabling an account, which already confirms
        // below. The select has already moved, so this is a confirmation, not
        // a gate: saying no puts it back where it was. Demoting away from
        // platform_admin is left ungated, same as switching an account back ON.
        if (next === 'platform_admin') {
            const email = Admin.pick(u, 'email') || '';
            select.value = previous;
            Admin.confirm({
                title: t('users.promoteTitle'),
                body: t('users.promoteBody', { email }),
                hint: t('users.promoteHint'),
                confirmLabel: t('users.promoteCta'),
                confirmIcon: 'shield',
                onConfirm: () => this.applyRoleChange(select, id, next, previous),
            });
            return Promise.resolve();
        }

        return this.applyRoleChange(select, id, next, previous);
    },

    applyRoleChange(select, id, next, previous) {
        const u = this.users.find((x) => String(this.id(x)) === String(id));
        if (!u) return Promise.resolve();

        select.disabled = true;
        return Motion.optimistic({
            apply: () => { u.role = next; },
            send: () => API.updateAdminUser(id, { role: next }),
            revert: () => {
                u.role = previous;
                select.value = previous;
            },
            onError: (err) => UI.toast(this.describeUserError(err, 'users.roleFailed'), 'error'),
        }).then(async (result) => {
            select.disabled = false;
            if (result !== null) {
                UI.toast(next === 'platform_admin' ? t('users.roleNowAdmin') : t('users.roleNowUser'));
                await this.render();
            } else {
                await this.render();
            }
            return result;
        });
    },

    toggleActive(input) {
        const id = input.dataset.id;
        const u = this.users.find((x) => String(this.id(x)) === String(id));
        if (!u) return Promise.resolve();

        const email = Admin.pick(u, 'email') || '';
        const wasActive = Admin.pick(u, 'is_active', 'isActive') !== false;
        const next = !!input.checked;
        if (next === wasActive) return Promise.resolve();

        // Switching an account OFF signs that person out of the product. The
        // control has already moved, so this is a confirmation, not a gate:
        // saying no puts the switch back.
        if (!next) {
            input.checked = true;
            Admin.confirm({
                title: t('users.disableTitle'),
                body: t('users.disableBody', { email }),
                hint: t('users.disableHint'),
                confirmLabel: t('users.disableCta'),
                confirmIcon: 'user-x',
                onConfirm: () => this.setActive(id, false),
            });
            return Promise.resolve();
        }
        return this.setActive(id, true);
    },

    async setActive(id, value) {
        const u = this.users.find((x) => String(this.id(x)) === String(id));
        if (!u) return;
        try {
            await API.updateAdminUser(id, { is_active: value });
            u.is_active = value;
            if ('isActive' in u) u.isActive = value;
            UI.toast(value ? t('users.enabledToast') : t('users.disabledToast'));
        } catch (err) {
            UI.toast(this.describeUserError(err, 'users.activeFailed'), 'error');
        }
        await this.render();
    },

    // ─── Create ──────────────────────────────────────────────────────────────

    /**
     * Tenant options for the two modals. Falls back to the session's own tenant
     * list so a modal still opens if /admin/tenants is momentarily unavailable.
     */
    async loadTenantOptions() {
        try {
            const result = await API.getAdminTenants();
            const list = Array.isArray(result) ? result : (result && result.tenants) || [];
            this.tenants = list;
            return list;
        } catch {
            return (App.session && App.session.tenants) || [];
        }
    },

    tenantOption(x) {
        const id = Admin.pick(x, 'id', 'creator_id');
        return html`<option value="${id}">${Admin.pick(x, 'name', 'display_name') || id}</option>`;
    },

    async showCreateModal() {
        const tenants = await this.loadTenantOptions();
        UI.showModal(html`
            ${Admin.modalHeader(t('users.createTitle'))}
            <form id="user-create-form" data-submit="users:handleCreate">
                <div class="form-group">
                    <label class="form-label" for="user-email">${t('users.email')}</label>
                    <input class="field" id="user-email" name="email" type="email" dir="ltr"
                           autocomplete="off" spellcheck="false" placeholder="name@example.com" required>
                </div>
                <div class="form-group">
                    <label class="form-label" for="user-password">${t('users.password')}</label>
                    <input class="field" id="user-password" name="password" type="password" dir="ltr"
                           autocomplete="new-password" minlength="12" required aria-describedby="user-password-hint">
                    <p class="form-hint" id="user-password-hint">${t('users.passwordHint')}</p>
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
                        ${tenants.map((x) => this.tenantOption(x))}
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
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // already in flight
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
            await this.render();
        } catch (err) {
            restore();
            UI.toast((err && err.message) || t('users.createFailed'), 'error');
        }
    },

    // ─── Memberships ─────────────────────────────────────────────────────────

    async showMembershipModal(id) {
        const u = this.users.find((x) => String(this.id(x)) === String(id));
        const email = (u && Admin.pick(u, 'email')) || '';
        const tenants = await this.loadTenantOptions();

        UI.showModal(html`
            ${Admin.modalHeader(t('users.membershipTitle'))}
            <form id="user-membership-form" data-submit="users:handleMembership" data-id="${id}">
                <p class="form-hint mbe-4">${UI.ltr(email)}</p>
                <div class="form-group">
                    <label class="form-label" for="membership-tenant">${t('users.membershipTenant')}</label>
                    <select class="select" id="membership-tenant" name="creator_id" required>
                        ${tenants.length === 0
                            ? html`<option value="">${t('users.noTenants')}</option>`
                            : tenants.map((x) => this.tenantOption(x))}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="membership-role">${t('users.membershipRole')}</label>
                    <select class="select" id="membership-role" name="role" aria-describedby="membership-role-hint">
                        ${Admin.roleOptions('owner')}
                    </select>
                    <p class="form-hint" id="membership-role-hint">${t('users.membershipHint')}</p>
                    ${Admin.roleLegend()}
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
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // already in flight
        try {
            await API.createUserMembership(id, {
                creator_id: creatorId,
                role: (data.get('role') || 'owner').toString(),
            });
            UI.closeModal();
            UI.toast(t('users.granted'));
            await this.render();
        } catch (err) {
            restore();
            UI.toast((err && err.message) || t('users.grantFailed'), 'error');
        }
    },

    confirmRevokeMembership(btn) {
        const { id, creator, email, name } = btn.dataset;
        if (!id || !creator) return;
        Admin.confirm({
            title: t('users.revokeMembershipTitle'),
            body: t('users.revokeMembershipBody', { name: name || '—', email: email || '—' }),
            hint: t('users.revokeMembershipHint'),
            confirmLabel: t('users.revokeMembershipCta'),
            confirmIcon: 'unlink',
            onConfirm: () => this.revokeMembership(id, creator),
        });
    },

    /**
     * The membership row's OWN button goes busy, not the confirm dialog's.
     *
     * `Admin.runConfirm` already guards the dialog, but the dialog is not the
     * only way back to this request: Escape closes a slow confirm, and the row
     * underneath is still sitting there with a live unlink button. Click it
     * again and the whole flow runs a second time against a membership the
     * first DELETE has not finished removing. Disabling the row's button for
     * the duration closes that path and is also the only feedback the page
     * itself gives — until now the row looked completely untouched while the
     * request was out.
     *
     * Both `data-id` (the user) and `data-creator` (the tenant) are needed to
     * find it: one user has one button per membership, all sharing a `data-id`.
     */
    async revokeMembership(id, creatorId) {
        const trigger = document.querySelector(
            `[data-action="users:confirmRevokeMembership"][data-id="${CSS.escape(String(id))}"]`
            + `[data-creator="${CSS.escape(String(creatorId))}"]`
        );
        const restore = UI.actionBusy(trigger);
        if (!restore) return; // this membership is already being revoked

        try {
            await API.deleteUserMembership(id, creatorId);
            UI.toast(t('users.membershipRevoked'));
        } catch (err) {
            restore();
            UI.toast(this.describeUserError(err, 'users.membershipRevokeFailed'), 'error');
        }
        await this.render();
    },

    // ─── Passwords ───────────────────────────────────────────────────────────

    showPasswordModal(btn) {
        const id = btn.dataset.id;
        const email = btn.dataset.email || '';
        UI.showModal(html`
            ${Admin.modalHeader(t('users.setPasswordTitle'))}
            <form id="user-password-form" data-submit="users:handlePassword" data-id="${id}">
                <p class="modal-body-text">${t('users.setPasswordBody', { email })}</p>
                <div class="form-group">
                    <label class="form-label" for="user-new-password">${t('users.newPassword')}</label>
                    <input class="field" id="user-new-password" name="password" type="password" dir="ltr"
                           autocomplete="new-password" minlength="12" required aria-describedby="user-new-password-hint">
                    <p class="form-hint" id="user-new-password-hint">${t('users.setPasswordHint')}</p>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary">
                        <i data-lucide="key-round" aria-hidden="true"></i> ${t('users.setPasswordCta')}
                    </button>
                </div>
            </form>
        `);
    },

    async handlePassword(form, event) {
        event.preventDefault();
        const id = form.dataset.id;
        const password = (new FormData(form).get('password') || '').toString();
        if (password.length < 12) {
            UI.toast(t('password.tooShort'), 'error');
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // already in flight
        try {
            await API.setAdminUserPassword(id, password);
            UI.closeModal();
            UI.toast(t('users.passwordSet'));
        } catch (err) {
            restore();
            UI.toast((err && err.message) || t('users.passwordSetFailed'), 'error');
        }
    },

    // ─── Sessions ────────────────────────────────────────────────────────────

    confirmRevoke(btn) {
        const email = btn.dataset.email || '';
        const id = btn.dataset.id;
        Admin.confirm({
            title: t('users.revokeTitle'),
            body: t('users.revokeConfirm', { email }),
            hint: t('users.revokeHint'),
            confirmLabel: t('users.revokeCta'),
            confirmIcon: 'log-out',
            onConfirm: () => this.revokeSessions(id),
        });
    },

    /**
     * Same guard as `revokeMembership`, same reason: the card's own button is
     * the second route to a duplicate request once the dialog has been
     * dismissed, and it was the only part of the page that could have shown
     * the operator that anything was happening at all.
     */
    async revokeSessions(id) {
        const trigger = document.querySelector(
            `[data-action="users:confirmRevoke"][data-id="${CSS.escape(String(id))}"]`
        );
        const restore = UI.actionBusy(trigger);
        if (!restore) return; // this user's sessions are already being revoked

        try {
            await API.revokeUserSessions(id);
            UI.toast(t('users.revoked'));
        } catch (err) {
            restore();
            UI.toast((err && err.message) || t('users.revokeFailed'), 'error');
        }
        await this.render();
    },
};

UI.registerActions('users', {
    render: () => Admin.report(UsersPage.render()),
    showCreateModal: () => Admin.report(UsersPage.showCreateModal()),
    handleCreate: (el, e) => Admin.report(UsersPage.handleCreate(el, e)),
    showMembershipModal: (el) => Admin.report(UsersPage.showMembershipModal(el.dataset.id)),
    handleMembership: (el, e) => Admin.report(UsersPage.handleMembership(el, e)),
    confirmRevokeMembership: (el) => UsersPage.confirmRevokeMembership(el),
    changeMembershipRole: (el) => Admin.report(UsersPage.changeMembershipRole(el)),
    showPasswordModal: (el) => UsersPage.showPasswordModal(el),
    handlePassword: (el, e) => Admin.report(UsersPage.handlePassword(el, e)),
    confirmRevoke: (el) => UsersPage.confirmRevoke(el),
    changeRole: (el) => Admin.report(UsersPage.changeRole(el)),
    toggleActive: (el) => Admin.report(UsersPage.toggleActive(el)),
});
