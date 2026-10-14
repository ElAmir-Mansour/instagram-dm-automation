/**
 * Connecting Instagram and Facebook with clicks: what Settings and the setup wizard share (plan P28; docs/onboarding/04).
 *
 * It is not a page. `App.loadPageModule('meta_connect')` brings it in when the Settings card or the wizard's connect step needs it,
 * and each host paints its own screen: Settings the Connections card (`settingsSection`), the wizard its three cards (welcome.js).
 * What lives here is what they would otherwise both have to get right:
 *
 *   - **What the server's words mean.** The callback comes back with `#/…?meta=connected|error|pick` and a `reason`, the JSON routes
 *     answer `{ error, code }`: both turn into one sentence each (`meta.reason.*`, `meta.warning.*`), and a code this file does not
 *     know is a generic sentence, never the raw code.
 *   - **The Page picker** (a modal), for a person who manages several Pages: pick one, confirm a replacement, or ask Facebook again.
 *   - **Connect, Reconnect, Disconnect**, each with the confirmation that its consequence deserves.
 *   - **The operator's two fields** (the switch and the configuration id), for a platform admin, inside the card.
 *
 * ─── What the card never does ───────────────────────────────────────────────
 * Nothing here ever sees a token: `GET /api/meta/connection` has none to give, the picker lists names and ids, and the one address the
 * page navigates to is the Login dialog's (`https://www.facebook.com/…`), checked before it is followed. The operator's own connection,
 * made by pasting a token, is shown as that and is never offered a Disconnect from here: removing it would delete a token that cannot be
 * re-created from this screen.
 *
 * ─── Escaping ───────────────────────────────────────────────────────────────
 * Every value that came from Meta or the server (a Page's name, an Instagram handle, the Facebook account's name, an id) reaches the
 * page through `html`, as text or in a quoted attribute, in its own element, never inside a translated sentence: a name that is Arabic or
 * Latin keeps its own direction (`dir="auto"`, `<bdi>`). The views are pure, so a test can feed each of them a payload in every field.
 */
const MetaConnect = {
    // ─── What the server can say ─────────────────────────────────────────────

    /**
     * Why a connect can end in an error: the callback's `reason` and the JSON routes' `code` (lower-cased), each with its own sentence
     * (`meta.reason.<reason>`). Anything else is `meta.reason.generic`.
     */
    REASONS: [
        'denied', 'meta_error', 'missing_code', 'state_mismatch', 'state_expired', 'disabled', 'no_base_url', 'exchange_failed',
        'not_configured', 'code_exchange_failed', 'token_exchange_failed', 'graph_failed', 'not_tester', 'permissions_missing',
        'no_pages', 'page_unusable', 'instagram_not_linked', 'token_invalid', 'page_in_use', 'already_connected',
        'page_change_unconfirmed', 'encryption_unavailable', 'pick_expired', 'tenant_not_found', 'not_connected',
        'insufficient_tenant_role',
    ],
    /** What a connection can come back with when it was saved but something is missing: `warn=` in the address. */
    WARNINGS: ['subscribe_failed', 'subscribe_unconfirmed', 'missing_scopes'],
    /** What `state` and `pick` look like when we made them: anything else never reaches a request. */
    PICK_PATTERN: /^[A-Za-z0-9_-]{20,100}$/,
    /** The one place Connect may send the browser. */
    DIALOG_URL: /^https:\/\/www\.facebook\.com\//,

    /** Called after the connection changed (a Page was chosen, Meta was disconnected): the screen that hosts the card repaints itself. */
    afterChange: null,

    /** The tenant changed (`App.resetTenantState`): the previous one's open pick, and the screen waiting on a change, are not this one's. */
    resetTenantState() {
        this._pick = null;
        this.afterChange = null;
    },

    // ─── Pure: words and states ──────────────────────────────────────────────

    /** The code a route answered or a callback sent, as one of `REASONS`, or ''. */
    knownReason(reason) {
        let r = String(reason === null || reason === undefined ? '' : reason).toLowerCase();
        if (r === 'meta_login_disabled') r = 'disabled';
        return this.REASONS.includes(r) ? r : '';
    },

    /** One sentence for why it failed. A code this file does not know is the generic sentence, never the code. */
    reasonText(reason) {
        const known = this.knownReason(reason);
        return t(known ? `meta.reason.${known}` : 'meta.reason.generic');
    },

    /** The words for a failed request: the code's sentence when it is one we know, else what the server said. */
    errorText(err) {
        const code = err && err.body && err.body.code;
        if (code && this.knownReason(code)) return this.reasonText(code);
        return (err && err.message) || t('meta.reason.generic');
    },

    /** `warn=a,b` as the list of warnings this file has a sentence for. */
    warningList(raw) {
        return String(raw || '').split(',').map((w) => w.trim()).filter((w) => this.WARNINGS.includes(w));
    },

    /**
     * What a return from Meta says, from the address: `{ outcome: 'connected', warnings }`, `{ outcome: 'error', reason }`,
     * `{ outcome: 'pick', pick }`, or null when this is not a return from Meta at all. `read(name)` is `App.hashParam`.
     */
    readReturn(read) {
        const outcome = read('meta');
        if (outcome === 'connected') return { outcome, warnings: this.warningList(read('warn')) };
        if (outcome === 'error') return { outcome, reason: this.knownReason(read('reason')) };
        if (outcome === 'pick') {
            const pick = read('pick');
            return this.PICK_PATTERN.test(pick) ? { outcome, pick } : null;
        }
        return null;
    },

    /** 'none', 'ok' or 'attention', from `GET /api/meta/connection`. Attention is "Meta says no" or "about to lapse": the card's Reconnect is the fix. */
    connectionState(resp) {
        const c = resp && resp.connection;
        if (!c || !c.connected) return 'none';
        return c.reconnectDue === true || c.tokenStatus === 'invalid' ? 'attention' : 'ok';
    },

    /** Why a connection needs attention: Meta no longer accepts it (`invalid`), or its access is about to lapse (`expiring`). */
    attentionReason(c) {
        return c && (c.tokenStatus === 'invalid' || c.reconnectReason === 'invalid') ? 'invalid' : 'expiring';
    },

    /** The `auth_type` a Reconnect asks Facebook for: renewing Instagram's 90-day access, or nothing special for a token Meta rejected. */
    reconnectAuthType(c) {
        return c && c.connected && this.attentionReason(c) === 'expiring' && c.reconnectDue ? 'reauthorize' : '';
    },

    /** May Connect be pressed? The operator has switched it on, the Meta app is set up, and there is an address to come back to. */
    canStart(resp) {
        return !!(resp && resp.enabled === true && resp.appConfigured === true && resp.redirectUriConfigured === true);
    },

    /** The handle as the card prints it: `@name`, in its own left-to-right element. */
    handle(username) {
        return username ? html`<bdi dir="ltr">@${username}</bdi>` : '';
    },

    // ─── Pure: the Settings card ─────────────────────────────────────────────

    /** The pill that says what state the webhook is in. A connection the operator made by token has its webhook set up in Meta's dashboard, not here. */
    webhookPill(c) {
        if (c.webhookSubscribed) {
            return html`<span class="health-pill health-fresh"><i data-lucide="check-circle" aria-hidden="true"></i> ${t('meta.webhook.on')}</span>`;
        }
        if (c.via === 'login') {
            return html`<span class="health-pill health-stale"><i data-lucide="alert-triangle" aria-hidden="true"></i> ${t('meta.webhook.off')}</span>`;
        }
        return html`<span class="text-meta">${t('meta.webhook.byOperator')}</span>`;
    },

    /** What is connected, as the definition list of the card. */
    facts(c) {
        const instagram = c.instagramUsername
            ? this.handle(c.instagramUsername)
            : (c.instagramId ? UI.ltr(c.instagramId) : t('meta.fact.noInstagram'));
        const page = c.pageName ? html`<span dir="auto">${c.pageName}</span>` : (c.pageId ? UI.ltr(c.pageId) : '—');
        return html`
            <dl class="ops-facts mbe-4">
                ${Admin.field(t('meta.fact.page'), page)}
                ${Admin.field(t('meta.fact.instagram'), instagram)}
                ${Admin.field(t('meta.fact.connectedAt'), c.connectedAt ? UI.formatDay(c.connectedAt) : t('meta.fact.connectedAtUnknown'))}
                ${Admin.field(t('meta.fact.webhook'), this.webhookPill(c))}
                ${Admin.field(t('meta.fact.via'), c.via === 'login' ? t('meta.via.login') : t('meta.via.token'))}
            </dl>
            ${c.via === 'login' && !c.webhookSubscribed ? html`<p class="form-hint text-warning mbe-4">${t('meta.webhook.offHint')}</p>` : ''}
        `;
    },

    /** The "reconnect due" notice: what is wrong, in one sentence, with the date when there is one. */
    attentionNote(c) {
        if (this.attentionReason(c) === 'invalid') {
            return html`<p class="meta-notice is-warning" role="status"><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('meta.attention.invalid')}</span></p>`;
        }
        const date = c.dataAccessExpiresAt || c.tokenExpiresAt;
        return html`<p class="meta-notice is-warning" role="status"><i data-lucide="clock-alert" aria-hidden="true"></i><span>${date
            ? t('meta.attention.expiring', { date: UI.formatDay(date) })
            : t('meta.attention.expiringSoon')}</span></p>`;
    },

    /** A button that starts Connect / Reconnect: the host says where the flow returns to. */
    connectButton(resp, opts) {
        const o = opts || {};
        const c = resp.connection;
        const reconnect = !!(c && c.connected);
        const authType = reconnect ? this.reconnectAuthType(c) : '';
        return UI.button({
            variant: o.variant || 'primary', size: o.size, icon: reconnect ? 'refresh-cw' : 'link', full: !!o.full,
            label: reconnect ? t('meta.reconnect') : t('meta.connect'),
            action: reconnect && c.via === 'token' ? 'metaconnect:askReconnect' : 'metaconnect:connect',
            id: o.id || 'meta-connect',
            data: { 'return-to': o.returnTo === 'welcome' ? 'welcome' : 'settings', reconnect: reconnect ? 'true' : 'false', 'auth-type': authType || undefined },
        });
    },

    /** The body of the Settings card, for a connection read without error. */
    settingsBody(resp, opts) {
        const o = opts || {};
        const c = resp.connection;
        const state = this.connectionState(resp);
        const start = this.canStart(resp);
        const owner = o.canAdminister !== false;

        if (state === 'none') {
            return html`
                <p class="form-hint mbe-4">${t('meta.intro')}</p>
                ${!start
                    ? html`<p class="form-hint">${resp.enabled === true ? t('meta.notSetUp') : t('meta.off')}</p>`
                    : owner ? this.connectButton(resp, { returnTo: 'settings' }) : html`<p class="form-hint">${t('meta.ownerOnly')}</p>`}
            `;
        }

        const needs = state === 'attention';
        const name = c.pageName
            ? html`<strong dir="auto">${c.pageName}</strong>`
            : html`<strong>${t('meta.connectedTitle')}</strong>`;
        return html`
            <div class="row row--start gap-3 mbe-4">
                <span class="stat-icon shrink-0"><i data-lucide="instagram" aria-hidden="true"></i></span>
                <div class="stack gap-1">
                    ${name}
                    <span class="health-pill ${needs ? html.raw('health-stale') : html.raw('health-fresh')}">
                        <i data-lucide="${needs ? 'alert-triangle' : 'check-circle'}" aria-hidden="true"></i>
                        ${needs ? t('meta.status.attention') : t('meta.status.ok')}
                    </span>
                </div>
            </div>
            ${needs ? this.attentionNote(c) : ''}
            ${this.facts(c)}
            ${owner ? html`
                <div class="row row--wrap gap-2">
                    ${start ? this.connectButton(resp, { returnTo: 'settings', variant: needs ? 'primary' : 'secondary', size: 'sm' }) : ''}
                    ${c.via === 'login' ? UI.button({
                        variant: 'danger', size: 'sm', icon: 'unlink', label: t('meta.disconnect'),
                        action: 'metaconnect:askDisconnect', id: 'meta-disconnect',
                    }) : ''}
                </div>
                ${c.via === 'token' ? html`<p class="form-hint mbs-3">${t('meta.tokenNote')}</p>` : ''}
                ${!start && needs ? html`<p class="form-hint mbs-3">${t('meta.reconnectOff')}</p>` : ''}
            ` : html`<p class="form-hint">${t('meta.ownerOnly')}</p>`}
        `;
    },

    /** The operator's two fields: the switch, and the configuration id, with what to register in Meta's dashboard. Platform admins only. */
    appBlock(app, error) {
        if (error) {
            return html`<p class="form-hint text-warning" dir="auto">${t('meta.app.loadFailed', { message: error.message || '' })}</p>`;
        }
        if (!app) return '';
        const row = (label, value) => html`
            <li>
                <span class="form-label">${label}</span>
                <code dir="ltr">${UI.ltr(value)}</code>
                ${UI.button({
                    variant: 'ghost', size: 'sm', icon: 'copy', ariaLabel: t('setup.copyUrl'), title: t('setup.copyUrl'),
                    action: 'app:copyValue', data: { copy: value },
                })}
            </li>
        `;
        const cfg = app.configId || {};
        const ready = app.enabled === true && app.app && app.app.idSet && app.app.secretSet && !!app.publicBaseUrl;
        return html`
            <details class="settings-block" ${ready ? '' : html.raw('open')}>
                <summary class="form-label tiktok-app-summary">
                    <i data-lucide="chevron-down" aria-hidden="true"></i>
                    ${t('meta.app.title')}
                </summary>
                <p class="form-hint mbe-3">${t('meta.app.hint')}</p>
                ${app.register ? html`
                    <p class="form-label">${t('meta.app.register')}</p>
                    <ul class="tiktok-register mbe-2">
                        ${row(t('meta.app.redirectUri'), app.register.redirectUri)}
                        ${app.register.deauthorizeUrl ? row(t('meta.app.deauthorizeUrl'), app.register.deauthorizeUrl) : ''}
                    </ul>
                    ${app.register.deauthorizeUrl ? html`<p class="form-hint mbe-4">${t('meta.app.deauthorizeHint')}</p>` : ''}
                ` : html`<p class="form-hint text-warning mbe-4">${t('meta.app.noBaseUrl')}</p>`}
                ${app.app && app.app.idSet && app.app.secretSet ? '' : html`<p class="form-hint text-warning mbe-4">${t('meta.app.noApp')}</p>`}
                <form id="meta-app-form" data-submit="metaconnect:saveApp" novalidate>
                    <div class="form-group">
                        <label class="check-row check-row-tap" for="meta-app-enabled">
                            <input type="checkbox" id="meta-app-enabled" name="enabled" ${app.enabled ? html.raw('checked') : ''}
                                   aria-describedby="meta-app-enabled-hint">
                            <span class="check-label">${t('meta.app.enabled')}</span>
                        </label>
                        <p class="form-hint" id="meta-app-enabled-hint">${t('meta.app.enabledHint')}</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="meta-app-config">
                            ${t('meta.app.configId')} <span class="label-optional">${t('common.optional')}</span>
                        </label>
                        <input class="field field-mono" id="meta-app-config" name="configId" type="text" dir="ltr" inputmode="numeric"
                               autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="123456789012345"
                               value="${cfg.source === 'database' && cfg.value ? cfg.value : ''}" aria-describedby="meta-app-config-hint">
                        <p class="form-hint" id="meta-app-config-hint">
                            ${app.mode === 'configuration' ? t('meta.app.modeConfiguration') : t('meta.app.modeScope')}
                            ${cfg.source === 'env' ? t('meta.app.configFromEnv') : ''}
                        </p>
                        <div id="meta-app-error"></div>
                    </div>
                    <div class="form-actions">
                        ${UI.button({ variant: 'primary', size: 'sm', type: 'submit', icon: 'save', label: t('meta.app.save'), id: 'meta-app-submit' })}
                    </div>
                </form>
            </details>
        `;
    },

    /** The whole Settings section, loaded or failed. `ctx`: `{ meta, metaError, app, appError, canAdminister, isAdmin }`. */
    settingsSection(ctx) {
        let body;
        if (ctx.metaError || !ctx.meta) {
            body = html`
                <div class="inline-error" role="alert">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    <div><strong dir="auto">${t('meta.loadFailed', { message: (ctx.metaError && ctx.metaError.message) || '' })}</strong></div>
                </div>
                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
            `;
        } else {
            body = this.settingsBody(ctx.meta, { canAdminister: ctx.canAdminister });
        }
        return html`
            <section class="section" id="settings-meta">
                <h2 class="section-title">${t('meta.title')}</h2>
                <div class="settings-card surface">
                    ${body}
                    ${ctx.isAdmin ? this.appBlock(ctx.app, ctx.appError) : ''}
                </div>
            </section>
        `;
    },

    // ─── Pure: the Page picker ───────────────────────────────────────────────

    /** The Page the person has chosen in the picker, or null. */
    chosen(pick) {
        const list = pick && pick.data && Array.isArray(pick.data.candidates) ? pick.data.candidates : [];
        return list.find((c) => c.pageId === pick.selected && c.usable) || null;
    },

    /** May the picker's primary button be pressed? A usable Page is chosen, a replacement is confirmed, and nothing is in flight. */
    pickReady(pick) {
        const c = this.chosen(pick);
        return !!c && !(c.replaces && !pick.confirm) && !pick.busy;
    },

    /** The words on the picker's primary button: a Page with no Instagram account connects Facebook only, and says so. */
    pickGoLabel(pick) {
        const c = this.chosen(pick);
        return c && !c.instagram ? t('meta.pick.goFacebookOnly') : t('meta.pick.go');
    },

    /** One Page, as a radio card (the wizard's own, so it is as tall as a finger and the same in both directions). */
    pickOption(c, selected) {
        const usable = c.usable === true;
        const hint = !usable
            ? t('meta.pick.noRole')
            : c.instagram
                ? html`${t('meta.pick.withInstagram')} ${c.instagram.username ? this.handle(c.instagram.username) : UI.ltr(c.instagram.id)}`
                : t('meta.pick.noInstagram');
        return html`
            <label class="welcome-choice">
                <input class="welcome-choice-input" type="radio" name="metapage" value="${c.pageId}"
                       data-change="metaconnect:pickSelect" ${selected ? html.raw('checked') : ''} ${usable ? '' : html.raw('disabled')}>
                <span class="welcome-choice-body">
                    <span class="welcome-choice-title" dir="auto">${c.name}</span>
                    <span class="welcome-choice-hint">${hint}</span>
                </span>
            </label>
        `;
    },

    /** What changes with the choice: why a Page has no Instagram, and the replacement that needs a tick. Repainted in place, never the radios. */
    pickExtra(pick) {
        const c = this.chosen(pick);
        if (!c) return '';
        return html`
            ${!c.instagram ? html`<p class="form-hint mbe-3">${t('meta.pick.noInstagramHelp')}</p>` : ''}
            ${c.replaces ? html`
                <div class="check-row check-row-tap mbe-3">
                    <input type="checkbox" id="meta-pick-confirm" data-change="metaconnect:pickConfirm" ${pick.confirm ? html.raw('checked') : ''}>
                    <div class="check-text">
                        <label class="check-label" for="meta-pick-confirm">${t('meta.pick.replaces')}</label>
                    </div>
                </div>
            ` : ''}
        `;
    },

    /** The whole modal. A pick that expired is a sentence and a way to start again; anything else is the list. */
    pickerMarkup(pick) {
        const d = pick.data || { candidates: [] };
        if (pick.expired) {
            return html`
                ${Admin.modalHeader(t('meta.pick.title'))}
                <p class="modal-body-text">${t('meta.reason.pick_expired')}</p>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.close')}</button>
                    ${UI.button({ variant: 'primary', icon: 'refresh-cw', label: t('meta.pick.startAgain'), action: 'metaconnect:pickAgain', id: 'meta-pick-again' })}
                </div>
            `;
        }
        const name = d.connectedAs && d.connectedAs.name ? d.connectedAs.name : '';
        return html`
            ${Admin.modalHeader(t('meta.pick.title'))}
            <p class="modal-body-text">${t('meta.pick.lead')}</p>
            ${name ? html`<p class="form-hint mbe-3">${t('meta.pick.account')} <strong dir="auto">${name}</strong></p>` : ''}
            <fieldset class="fieldset-plain form-group" role="radiogroup" aria-labelledby="meta-pick-legend">
                <legend class="sr-only" id="meta-pick-legend">${t('meta.pick.title')}</legend>
                <div class="welcome-choices">
                    ${(d.candidates || []).map((c) => this.pickOption(c, c.pageId === pick.selected))}
                </div>
            </fieldset>
            <div id="meta-pick-extra" aria-live="polite">${this.pickExtra(pick)}</div>
            <p class="form-hint">
                ${t('meta.pick.missing')}
                <button type="button" class="welcome-link" data-action="metaconnect:pickMissing">${t('meta.pick.missingAction')}</button>
            </p>
            <div id="meta-pick-error"></div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                <button type="button" class="btn btn-primary" id="meta-pick-go" data-action="metaconnect:pickGo" ${this.pickReady(pick) ? '' : html.raw('disabled')}>
                    <i data-lucide="link" aria-hidden="true"></i> ${this.pickGoLabel(pick)}
                </button>
            </div>
        `;
    },

    // ─── Running: connect, reconnect, disconnect ────────────────────────────

    /**
     * Ask the server for the Login dialog's address (it also sets the state cookie that binds the round trip to this browser) and go
     * there. The address is checked first: this page only ever navigates to Facebook's own dialog.
     */
    async connect(btn) {
        if (!btn || btn.disabled) return;
        const ds = btn.dataset || {};
        const authType = ds.authType === 'rerequest' || ds.authType === 'reauthorize' ? ds.authType : undefined;
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        try {
            const body = { returnTo: ds.returnTo === 'welcome' ? 'welcome' : 'settings', reconnect: ds.reconnect === 'true' };
            if (authType) body.authType = authType;
            const { url } = await API.startMetaConnect(body);
            if (typeof url !== 'string' || !this.DIALOG_URL.test(url)) throw new Error(t('meta.reason.generic'));
            window.location.href = url;
        } catch (err) {
            restore();
            UI.toast(this.errorText(err), 'error');
        }
    },

    /** Reconnecting a connection an operator made by token replaces that token: ask first, and say what it does. */
    askReconnect(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('meta.reconnectTokenTitle'),
            body: t('meta.reconnectTokenBody'),
            hint: t('meta.reconnectTokenHint'),
            confirmLabel: t('meta.reconnect'),
            confirmIcon: 'refresh-cw',
            tone: 'primary',
            onConfirm: () => this.connect(btn),
        });
    },

    askDisconnect(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('meta.disconnectTitle'),
            body: t('meta.disconnectBody'),
            hint: t('meta.disconnectHint'),
            confirmLabel: t('meta.disconnect'),
            confirmIcon: 'unlink',
            onConfirm: () => this.disconnectConfirmed(),
        });
    },

    /** A refusal is shown inside the confirm dialog, which stays open (Admin.runConfirm): this lets it through. */
    async disconnectConfirmed() {
        try {
            await API.disconnectMeta();
        } catch (err) {
            throw new Error(this.errorText(err));
        }
        UI.toast(t('meta.disconnected'), 'success');
        await this.changed();
    },

    async changed() {
        if (typeof this.afterChange === 'function') await this.afterChange();
    },

    // ─── Running: coming back from Facebook ──────────────────────────────────

    /** The toast for an outcome that is not the picker: connected (with what is missing, if anything), or why not. */
    announce(ret) {
        if (!ret) return;
        if (ret.outcome === 'connected') {
            UI.toast(t('meta.connectedToast'), 'success');
            ret.warnings.forEach((w) => UI.toast(t(`meta.warning.${w}`), 'error'));
        } else if (ret.outcome === 'error') {
            UI.toast(this.reasonText(ret.reason), 'error');
        }
    },

    // ─── Running: the Page picker ────────────────────────────────────────────

    _pick: null,

    /**
     * Open the picker for a pick the callback made: read the Pages (names and ids, never a token) and show them. A pick that cannot be
     * read (expired, spent, somebody else's) is the same 404 for every one of those, and the modal says it expired.
     */
    async openPicker(pickId, returnTo) {
        if (!this.PICK_PATTERN.test(String(pickId || ''))) return;
        this._pick = { data: null, selected: null, confirm: false, busy: false, expired: false, returnTo: returnTo === 'welcome' ? 'welcome' : 'settings' };
        try {
            this._pick.data = await API.getMetaCandidates(pickId);
        } catch (err) {
            if (err && err.status === 401) return;
            this._pick.expired = true;
            this._pick.data = { candidates: [] };
            if (!(err && err.status === 404)) UI.toast(this.errorText(err), 'error');
        }
        // Several Pages and one of them the obvious choice: nothing is chosen for the person, but a single usable Page is the only one.
        const usable = (this._pick.data.candidates || []).filter((c) => c.usable);
        if (usable.length === 1) this._pick.selected = usable[0].pageId;
        UI.showModal(this.pickerMarkup(this._pick));
    },

    /** Repaint only what the choice changes: the extra notes and the primary button. The radios keep focus. */
    paintPick() {
        const pick = this._pick;
        if (!pick) return;
        const extra = document.getElementById('meta-pick-extra');
        if (extra) {
            extra.innerHTML = esc(this.pickExtra(pick));
            UI.icons(extra);
        }
        this.paintPickButton();
    },

    paintPickButton() {
        const pick = this._pick;
        const go = document.getElementById('meta-pick-go');
        if (!pick || !go) return;
        go.disabled = !this.pickReady(pick);
        go.innerHTML = esc(html`<i data-lucide="link" aria-hidden="true"></i> ${this.pickGoLabel(pick)}`);
        UI.icons(go);
    },

    pickSelect(input) {
        const pick = this._pick;
        if (!pick || !input) return;
        pick.selected = input.value;
        pick.confirm = false;
        this.paintPick();
    },

    pickConfirm(box) {
        const pick = this._pick;
        if (!pick || !box) return;
        pick.confirm = !!box.checked;
        this.paintPickButton();
    },

    showPickError(message) {
        const host = document.getElementById('meta-pick-error');
        if (!host) { UI.toast(message, 'error'); return; }
        host.innerHTML = esc(UI.errorStrip(message, '', 'meta-pick-error-strip'));
        UI.icons(host);
    },

    /** Connect the chosen Page. Meta is asked again here, so a failure from Meta spends the pick: the person starts over, and the modal says so. */
    async pickGo(btn) {
        const pick = this._pick;
        const chosen = this.chosen(pick);
        if (!pick || !chosen || !this.pickReady(pick)) return;
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        pick.busy = true;
        const host = document.getElementById('meta-pick-error');
        if (host) host.innerHTML = '';
        let res;
        try {
            res = await API.selectMetaPage({
                pick: pick.data.pick, pageId: chosen.pageId, facebookOnly: !chosen.instagram, confirmPageChange: !!chosen.replaces && pick.confirm,
            });
        } catch (err) {
            pick.busy = false;
            restore();
            const code = err && err.body && err.body.code;
            if (code === 'PICK_EXPIRED') {
                pick.expired = true;
                UI.showModal(this.pickerMarkup(pick));
                return;
            }
            this.showPickError(this.errorText(err));
            this.paintPickButton();
            return;
        }
        // Connected. The host repaints first and the dialog closes after (what `UI.closeModal` asks of every caller), and a host that
        // fails to repaint must not leave a finished choice on screen.
        this._pick = null;
        const warnings = res && res.result && Array.isArray(res.result.warnings) ? this.warningList(res.result.warnings.join(',')) : [];
        try {
            await this.changed();
        } catch (err) {
            console.warn('The screen could not repaint after the connection:', err);
        }
        UI.closeModal();
        this.announce({ outcome: 'connected', warnings });
    },

    /** "I don't see my Page": ask Facebook again, this time asking for the permissions that were declined (`auth_type=rerequest`). */
    async pickMissing(btn) {
        const pick = this._pick;
        if (!pick || !btn || btn.disabled) return;
        return this.restartFrom(btn, pick, 'rerequest');
    },

    /** The pick expired: start the whole thing again. */
    async pickAgain(btn) {
        const pick = this._pick;
        if (!pick || !btn || btn.disabled) return;
        return this.restartFrom(btn, pick, '');
    },

    async restartFrom(btn, pick, authType) {
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        try {
            const body = { returnTo: pick.returnTo, reconnect: !!(pick.data && pick.data.reconnect) };
            if (authType) body.authType = authType;
            const { url } = await API.startMetaConnect(body);
            if (typeof url !== 'string' || !this.DIALOG_URL.test(url)) throw new Error(t('meta.reason.generic'));
            window.location.href = url;
        } catch (err) {
            restore();
            this.showPickError(this.errorText(err));
        }
    },

    // ─── Running: the operator's fields ──────────────────────────────────────

    async saveApp(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const configId = (data.get('configId') || '').toString().trim();
        const host = document.getElementById('meta-app-error');
        if (host) host.innerHTML = '';
        UI.clearInvalid(form);
        // Checked here first so the answer is on the field; the server checks again and has the last word.
        if (configId && !/^[0-9]{6,30}$/.test(configId)) {
            const field = document.getElementById('meta-app-config');
            if (host) { host.innerHTML = esc(UI.errorStrip(t('meta.app.invalidConfigId'), '', 'meta-app-error-strip')); UI.icons(host); }
            if (field) UI.markInvalid(field, 'meta-app-error-strip');
            return;
        }
        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            // Both are always sent: an emptied id is a real "back to the default", an unticked box a real "off".
            await API.saveMetaAppSettings({ enabled: data.get('enabled') === 'on', configId });
            UI.toast(t('meta.app.saved'), 'success');
            await this.changed();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            if (host) { host.innerHTML = esc(UI.errorStrip((err && err.message) || t('error.unexpected'), '', 'meta-app-error-strip')); UI.icons(host); }
            else UI.toast((err && err.message) || t('error.unexpected'), 'error');
        }
    },
};

UI.registerActions('metaconnect', {
    connect: (el) => MetaConnect.connect(el),
    askReconnect: (el) => MetaConnect.askReconnect(el),
    askDisconnect: (el) => MetaConnect.askDisconnect(el),
    pickSelect: (el) => MetaConnect.pickSelect(el),
    pickConfirm: (el) => MetaConnect.pickConfirm(el),
    pickGo: (el) => MetaConnect.pickGo(el),
    pickMissing: (el) => MetaConnect.pickMissing(el),
    pickAgain: (el) => MetaConnect.pickAgain(el),
    saveApp: (el, e) => MetaConnect.saveApp(el, e),
});
