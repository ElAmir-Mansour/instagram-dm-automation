/**
 * The invite card (platform admin): the dialog that hands a tenant its link, and the list of a tenant's links (P17).
 *
 * Not a page and not a route (`routable: false` in `App.pages`): Tenants shows it the moment a tenant is created, and the
 * tenant detail shows the list and opens it again after "New invite link", "Regenerate" or a member's "Reset link".
 *
 * ─── The link is shown once ─────────────────────────────────────────────────
 * The server stores only the hash of the token, so it can never show a link again. The card therefore holds the link in
 * memory for as long as the dialog is open, and says so. A tenant's list shows each link's state ("Opened 2h ago", "Expires
 * 21 Oct") with Regenerate and Revoke, never a link. Regenerate makes a new one and kills the old one in the same step.
 *
 * ─── Sharing ────────────────────────────────────────────────────────────────
 * Copy link, and Send on WhatsApp: `https://wa.me/?text=…` with the message the server wrote (the operator's own template
 * from Settings → Onboarding, or the built-in one in the link's language). There is no email: this product sends none.
 *
 * ─── Escaping ───────────────────────────────────────────────────────────────
 * The tenant's name, an invite's address and the link itself come from the server or from the operator, and go through
 * `html` like everything else; the WhatsApp URL goes through `safeUrl`. The markup functions are pure, so a test can feed
 * a payload into each.
 */
const InviteCard = {
    /** What the open dialog shows: `{ invite, tenantId, tenantName, lang, title, onChange }`. */
    current: null,

    // ─── Markup (pure) ───────────────────────────────────────────────────────

    /** A link's state as a chip, with the words and an icon, never colour alone. */
    statusChip(status) {
        const known = ['pending', 'opened', 'used', 'expired', 'revoked'];
        const value = known.includes(status) ? status : 'pending';
        const icon = { pending: 'clock', opened: 'eye', used: 'check-circle', expired: 'hourglass', revoked: 'ban' }[value];
        const tone = value === 'used' ? 'chip-accent' : (value === 'expired' || value === 'revoked') ? 'chip-danger' : '';
        return html`<span class="chip ${html.raw(tone)}"><i data-lucide="${icon}" aria-hidden="true"></i>${t(`invites.status.${value}`)}</span>`;
    },

    /** What an address says: the person it is for, or "anyone who has the link"; for a used link, who actually used it. */
    forWhom(invite) {
        if (invite.status === 'used' && invite.used_by_email) return html`${t('invites.usedByLabel')} ${UI.ltr(invite.used_by_email)}`;
        return invite.email ? UI.ltr(invite.email) : html`${t('invites.anyone')}`;
    },

    /** The one-line state under a listed invite: when it opened, when it ends. */
    meta(invite) {
        const bits = [];
        if (invite.status === 'used') {
            bits.push(t('invites.usedOn', { when: UI.formatDay(invite.used_at) }));
        } else if (invite.status === 'revoked') {
            bits.push(t('invites.revokedOn', { when: UI.formatDay(invite.revoked_at) }));
        } else {
            bits.push(invite.status === 'expired'
                ? t('invites.expiredOn', { when: UI.formatDay(invite.expires_at) })
                : t('invites.expiresOn', { when: UI.formatDay(invite.expires_at) }));
            bits.push(invite.first_opened_at
                ? t('invites.openedAgo', { age: UI.relativeAge(invite.first_opened_at).text })
                : t('invites.notOpened'));
        }
        return bits.join(' · ');
    },

    /** The dialog for a link that exists right now: the link, how to send it, and what it is. */
    linkView(state) {
        const { invite, tenantName, title } = state;
        const isReset = invite.purpose === 'reset';
        const whatsapp = `https://wa.me/?text=${encodeURIComponent(invite.whatsapp_text || invite.url)}`;
        return html`
            ${Admin.modalHeader(title || (isReset ? t('invites.resetTitle') : t('invites.title')))}
            <p class="modal-body-text" dir="auto">
                ${isReset
                    ? t('invites.resetLead', { email: invite.email || '' })
                    : html`${t('invites.lead')} <bdi dir="auto">${tenantName || ''}</bdi>`}
            </p>
            <div class="form-group">
                <label class="form-label" for="invite-link-field">${t('invites.link')}</label>
                <input class="field field-mono" id="invite-link-field" readonly dir="ltr" spellcheck="false" autocomplete="off"
                       value="${invite.url}" data-action="inviteCard:selectLink">
            </div>
            <div class="invite-card-actions">
                ${UI.button({
                    variant: 'primary', icon: 'copy', label: t('invites.copy'), action: 'app:copyValue', data: { copy: invite.url }, className: 'invite-card-action',
                })}
                <a class="btn btn-secondary invite-card-action" href="${safeUrl(whatsapp)}" target="_blank" rel="noopener noreferrer">
                    <i data-lucide="message-circle" aria-hidden="true"></i> ${t('invites.whatsapp')}
                    <span class="sr-only">${t('help.link.newTab')}</span>
                </a>
            </div>
            <dl class="ops-facts invite-card-facts">
                ${Admin.field(t('invites.for'), this.forWhom(invite))}
                ${isReset ? '' : Admin.field(t('invites.joinsAs'), Admin.roleChip(invite.role))}
                ${Admin.field(t('invites.expires'), UI.formatDay(invite.expires_at))}
            </dl>
            <p class="form-hint">${t('invites.shownOnce')} ${UI.helpLink('onboarding#invite', t('help.link.onboardingInvite'), { newTab: true })}</p>
            <div class="modal-actions invite-card-footer">
                ${UI.button({ variant: 'danger', icon: 'ban', label: t('invites.revoke'), action: 'inviteCard:revoke', data: { id: invite.id } })}
                ${UI.button({ variant: 'secondary', icon: 'refresh-cw', label: t('invites.regenerate'), action: 'inviteCard:regenerate', data: { id: invite.id } })}
                ${UI.button({ variant: 'primary', label: t('invites.done'), action: 'inviteCard:done' })}
            </div>
        `;
    },

    /** The form that makes a link: who it is for (optional), the role, and the language the page and message use. */
    createView(state) {
        return html`
            ${Admin.modalHeader(t('invites.newTitle'))}
            <form id="invite-create-form" data-submit="inviteCard:create">
                <p class="modal-body-text" dir="auto">${t('invites.newLead')} <bdi dir="auto">${(state && state.tenantName) || ''}</bdi></p>
                <div class="form-group">
                    <label class="form-label" for="invite-create-email">
                        ${t('invites.email')} <span class="label-optional">${t('common.optional')}</span>
                    </label>
                    <input class="field" id="invite-create-email" name="email" type="email" dir="ltr" autocomplete="off"
                           spellcheck="false" placeholder="name@example.com" aria-describedby="invite-create-email-hint">
                    <p class="form-hint" id="invite-create-email-hint">${t('invites.emailHint')}</p>
                </div>
                <div class="form-grid">
                    <div class="form-group">
                        <label class="form-label" for="invite-create-role">${t('invites.role')}</label>
                        <select class="select" id="invite-create-role" name="role">
                            <option value="" selected>${t('invites.roleDefault')}</option>
                            ${Admin.TENANT_ROLES.map((role) => html`<option value="${role}">${t(`roles.${role}`)}</option>`)}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="invite-create-lang">${t('invites.lang')}</label>
                        <select class="select" id="invite-create-lang" name="lang">
                            <option value="" selected>${t('invites.langDefault')}</option>
                            <option value="ar" lang="ar">${t('tenants.lang.ar')}</option>
                            <option value="en" lang="en">${t('tenants.lang.en')}</option>
                        </select>
                    </div>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="link" aria-hidden="true"></i> ${t('invites.create')}</button>
                </div>
            </form>
        `;
    },

    /** One listed invite: its state, who it is for, and what can still be done to it. */
    itemView(invite) {
        const live = invite.status === 'pending' || invite.status === 'opened';
        const canRegenerate = invite.status !== 'used';
        return html`
            <li class="invite-item">
                <div class="invite-item-main">
                    ${this.statusChip(invite.status)}
                    ${invite.purpose === 'reset'
                        ? html`<span class="chip"><i data-lucide="key-round" aria-hidden="true"></i>${t('invites.resetChip')}</span>`
                        : Admin.roleChip(invite.role)}
                    <span class="invite-item-for">${this.forWhom(invite)}</span>
                </div>
                <p class="invite-item-meta">${this.meta(invite)}</p>
                ${canRegenerate ? html`
                    <div class="invite-item-actions">
                        ${UI.button({
                            variant: 'secondary', size: 'sm', icon: 'refresh-cw', label: t('invites.regenerate'),
                            action: 'inviteCard:regenerate', data: { id: invite.id },
                        })}
                        ${live ? UI.button({
                            variant: 'danger', size: 'sm', icon: 'ban', label: t('invites.revoke'),
                            action: 'inviteCard:revokeFromList', data: { id: invite.id },
                        }) : ''}
                    </div>
                ` : ''}
            </li>
        `;
    },

    /** A tenant's invites, newest first, under the members. */
    listView(invites, error) {
        return html`
            <div class="row row--between row--wrap gap-3 mbs-5 mbe-3">
                <h3 class="subsection-title">${t('invites.listTitle')}</h3>
                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'user-plus', label: t('invites.new'), action: 'inviteCard:openCreate' })}
            </div>
            ${error ? html`<p class="form-hint" role="alert">${t('invites.loadFailed')}</p>` : !invites ? html`<p class="form-hint">${t('common.loading')}</p>` : invites.length === 0
                ? html`<p class="form-hint">${t('invites.none')}</p>`
                : html`<ul class="invite-list">${invites.map((invite) => this.itemView(invite))}</ul>`}
            <p class="form-hint mbs-3">${t('invites.listHint')}</p>
        `;
    },

    // ─── Opening ─────────────────────────────────────────────────────────────

    /**
     * Show a link that was just made. `context`: `{ tenantId, tenantName, lang, title, onChange }`, where `onChange` runs when
     * the dialog closes after anything happened (so the opener can refresh its list).
     */
    showCreated(invite, context) {
        this.current = Object.assign({}, context, { invite, changed: Boolean(context && context.changed) });
        UI.showModal(this.linkView(this.current));
    },

    openCreate(context) {
        this.current = Object.assign({}, context, { invite: null, changed: false });
        UI.showModal(this.createView(this.current));
    },

    /** A reset link for one member: nothing changes until they use it, so it is made at once. */
    async openReset(context, member) {
        try {
            const result = await API.createTenantInvite(context.tenantId, Object.assign({ purpose: 'reset', user_id: member.userId }, context.lang ? { lang: context.lang } : {}));
            this.showCreated(result.invite, Object.assign({}, context, { changed: true }));
        } catch (err) {
            UI.toast(this.describe(err), 'error');
        }
    },

    /** A refusal from the invite routes, in the dashboard's language by its code; the server's English only as a last resort. */
    describe(err) {
        const code = err && err.body && err.body.code;
        const known = ['TENANT_INACTIVE', 'USER_IS_ADMIN', 'NOT_A_MEMBER', 'USER_DISABLED', 'BAD_EMAIL', 'INVITE_USED', 'PUBLIC_URL_UNKNOWN'];
        if (known.includes(code)) return t(`invites.err.${code}`);
        return (err && err.message) || t('invites.err.generic');
    },

    async create(form, event) {
        event.preventDefault();
        if (!this.current) return;
        const data = new FormData(form);
        const email = (data.get('email') || '').toString().trim();
        const role = (data.get('role') || '').toString();
        // Left on the default, the server uses the language the tenant writes in.
        const lang = data.get('lang') === 'en' ? 'en' : data.get('lang') === 'ar' ? 'ar' : null;
        const body = {};
        if (lang) body.lang = lang;
        if (email) body.email = email;
        if (role) body.role = role;
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            const result = await API.createTenantInvite(this.current.tenantId, body);
            this.showCreated(result.invite, Object.assign({}, this.current, { lang, changed: true }));
        } catch (err) {
            restore();
            UI.toast(this.describe(err), 'error');
        }
    },

    async regenerate(button) {
        const id = button.dataset.id;
        const lang = (this.current && this.current.lang) || null;
        const restore = UI.actionBusy(button);
        if (!restore) return;
        try {
            const result = await API.regenerateInvite(id, lang ? { lang } : {});
            // From a list the dialog has no context of its own: the tenant is the page that is open.
            const context = this.current || this.listContext || {};
            this.showCreated(result.invite, Object.assign({}, context, { lang, changed: true, title: t('invites.regeneratedTitle') }));
        } catch (err) {
            restore();
            UI.toast(this.describe(err), 'error');
        }
    },

    /** Revoke asks first: the person may be about to open it. */
    revoke(button) {
        const id = button.dataset.id;
        const invite = this.current && this.current.invite;
        Admin.confirm({
            title: t('invites.revokeTitle'),
            body: t('invites.revokeBody'),
            hint: t('invites.revokeHint'),
            confirmLabel: t('invites.revoke'),
            confirmIcon: 'ban',
            onConfirm: async () => {
                await API.revokeInvite(id || (invite && invite.id));
                UI.toast(t('invites.revoked'), 'success');
                // The confirm dialog closes itself when this resolves; what is left is telling the opener.
                this.settle(true, false);
            },
        });
    },

    /** The list's own Revoke: the same question, the same answer. */
    revokeFromList(button) {
        this.revoke(button);
    },

    selectLink(input) {
        if (input && typeof input.select === 'function') input.select();
    },

    done() {
        this.settle(this.current && this.current.changed);
    },

    /** Close the dialog (unless something else is already closing it), and tell whoever opened it that something changed. */
    settle(changed, close = true) {
        const context = this.current || this.listContext;
        this.current = null;
        if (close) UI.closeModal();
        if (changed && context && typeof context.onChange === 'function') context.onChange();
    },

    // ─── The tenant's list ───────────────────────────────────────────────────

    /** Where the list is mounted and what it belongs to, so a Regenerate from the list knows its tenant. */
    listContext: null,

    /** Fill the list into `host` and keep it in step with what the dialog does. */
    async mountList(host, context) {
        this.listContext = Object.assign({}, context, { onChange: () => this.mountList(host, context) });
        const paint = (invites, error) => {
            if (!document.body.contains(host)) return;
            host.innerHTML = esc(this.listView(invites, error));
            UI.icons(host);
        };
        paint(null, false);
        try {
            const result = await API.getTenantInvites(context.tenantId);
            paint((result && result.invites) || [], false);
        } catch (err) {
            paint(null, true);
        }
    },
};

UI.registerActions('inviteCard', {
    selectLink: (el) => InviteCard.selectLink(el),
    create: (el, e) => Admin.report(InviteCard.create(el, e)),
    regenerate: (el) => Admin.report(InviteCard.regenerate(el)),
    revoke: (el) => InviteCard.revoke(el),
    revokeFromList: (el) => InviteCard.revokeFromList(el),
    done: () => InviteCard.done(),
    openCreate: () => InviteCard.openCreate(InviteCard.listContext || {}),
});
