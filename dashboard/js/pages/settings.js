/**
 * Settings — access token, webhook verify token, TikTok, account info, appearance.
 *
 * Every credential shown here is a Latin string sitting inside Arabic prose,
 * which is exactly where bidi goes wrong: an unisolated token preview drags
 * the sentence's punctuation to the wrong end. They all go through UI.ltr().
 */
const SettingsPage = {
    REQUIRED_SCOPES: [
        'pages_manage_engagement',
        'pages_messaging',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'instagram_content_publish',
    ],

    /**
     * Guards the write against landing after the operator has navigated away.
     * This page awaits TWO requests in series, so it owns the container for
     * longer than any other — and `#page-container` is refilled, never
     * replaced, so a late write lands on whatever page is there now. Same
     * `_seq`/`live()` shape as OverviewPage.
     */
    _seq: 0,

    destroy() {
        this._seq++;
    },

    skeleton() {
        return html`
            ${Motion.cardGrid(2, 5)}
            ${Motion.busy()}
        `;
    },

    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const focus = UI.captureFocus(container);
        const gate = Motion.beginLoad(container, () => this.skeleton());
        const seq = ++this._seq;
        const live = () => seq === this._seq && !!document.getElementById('page-container');

        // The access token status is the page — if it fails there is nothing to show.
        let tokenStatus;
        try {
            tokenStatus = await API.getTokenStatus();
        } catch (err) {
            if (!live()) return;
            gate.done();
            UI.renderError(container, { title: t('settings.errorTitle'), message: err.message }, () => this.render());
            return;
        }
        if (!live()) return;

        // The webhook verify token is loaded separately: a failure here used to
        // render "Not set" for a token that IS set, inviting the creator to
        // re-enter the one credential this project's docs say has already cost
        // hours of debugging.
        let webhookToken = null;
        let webhookError = null;
        try {
            webhookToken = await API.getWebhookToken();
        } catch (err) {
            webhookError = err;
        }

        // TikTok, loaded the same way and for the same reason: its failure
        // must not take the Meta settings down with it.
        let tiktok = null;
        let tiktokError = null;
        let tiktokApp = null;
        let tiktokAppError = null;
        const [tt, ttApp] = await Promise.allSettled([
            API.getTikTokConnection(),
            App.isAdmin() ? API.getTikTokAppSettings() : Promise.resolve(null),
        ]);
        if (tt.status === 'fulfilled') tiktok = tt.value; else tiktokError = tt.reason;
        if (ttApp.status === 'fulfilled') tiktokApp = ttApp.value; else tiktokAppError = ttApp.reason;

        if (!live()) return;
        gate.done();

        const isValid = tokenStatus.status === 'valid';
        const expiresAt = tokenStatus.expiresAt ? new Date(tokenStatus.expiresAt) : null;
        const daysLeft = expiresAt ? Math.ceil((expiresAt - Date.now()) / 86400000) : null;

        const missingScopes = isValid && Array.isArray(tokenStatus.scopes)
            ? this.REQUIRED_SCOPES.filter((scope) => !tokenStatus.scopes.includes(scope))
            : [];

        // When the fetch failed we do not know whether the token is set in the
        // environment, and the sentence that says so was being rendered with a
        // bare "." interpolated where the answer should be. There is no copy
        // for "unknown", so the sentence is simply not claimed.
        const envNote = webhookError
            ? null
            : (webhookToken.configuredInEnv ? t('settings.webhookEnvSet') : t('settings.webhookEnvUnset'));

        container.innerHTML = esc(html`
            ${missingScopes.length > 0 ? html`
                <div class="warning-card" role="alert">
                    <div class="row row--start gap-4">
                        <span class="stat-icon warning shrink-0"><i data-lucide="alert-triangle" aria-hidden="true"></i></span>
                        <div>
                            <h3 class="warning-card-title">${t('settings.missingScopesTitle')}</h3>
                            <p class="mbe-3">${t('settings.missingScopesBody')}</p>
                            <ul class="warning-card-list">
                                ${missingScopes.map((s) => html`<li>${t('settings.scopeRequired', {
                                    name: s, desc: t(`settings.scope.${s}`),
                                })}</li>`)}
                            </ul>
                        </div>
                    </div>
                </div>
            ` : ''}

            <section class="section">
                <h2 class="section-title">${t('settings.accessToken')}</h2>
                <div class="settings-card surface">
                    <div class="token-status">
                        <span class="health-pill ${isValid ? html.raw('health-fresh') : html.raw('health-stale')}">
                            <i data-lucide="${isValid ? 'check-circle' : 'alert-triangle'}" aria-hidden="true"></i>
                            ${isValid ? t('settings.valid') : t('settings.invalid')}
                        </span>
                        ${tokenStatus.type ? html`<span class="text-meta">${t('settings.tokenType', { type: tokenStatus.type })}</span>` : ''}
                    </div>

                    ${expiresAt ? html`
                        <div class="row row--wrap gap-3 mbe-4">
                            <p class="token-info">
                                ${t('settings.expires', { date: UI.formatDay(expiresAt) })}
                                ${daysLeft !== null ? html`
                                    <span class="${daysLeft < 7 ? html.raw('text-warning') : ''}">
                                        ${daysLeft > 0
                                            ? t('settings.daysLeft', { count: daysLeft })
                                            : t('settings.expired')}
                                    </span>
                                ` : ''}
                            </p>
                            ${UI.button({
                                variant: 'secondary', size: 'sm', icon: 'refresh-cw',
                                label: t('settings.extend'),
                                action: 'settings:extendToken', id: 'settings-extend',
                            })}
                        </div>
                    ` : html`
                        <p class="token-info mbe-4">${t('settings.expiresNever')}</p>
                    `}

                    ${tokenStatus.scopes ? html`
                        <div class="mbe-4">
                            <p class="form-label">${t('settings.permissions')}</p>
                            <div class="scope-list">
                                ${tokenStatus.scopes.map((s) => html`<span class="chip">${UI.ltr(s)}</span>`)}
                            </div>
                        </div>
                    ` : ''}

                    <div class="settings-block">
                        <label class="form-label" for="settings-token-input">${t('settings.updateToken')}</label>
                        <p class="form-hint mbe-3">${t('settings.updateTokenHint')}</p>
                        <form id="token-form" data-submit="settings:handleTokenUpdate">
                            <!-- autocomplete/spellcheck off, matching the webhook
                                 field below and the confirm dialog's echo input.
                                 This one carried a live, never-expiring Meta Page
                                 Access Token in a plain spellchecked textarea:
                                 browsers with enhanced spell check send field
                                 contents to a remote service, and autofill will
                                 happily remember and re-offer a 200-character
                                 credential. The value is the one thing on this
                                 screen that must not leave the page by any route
                                 but the submit. -->
                            <textarea class="field-textarea field-mono" id="settings-token-input" name="token" dir="ltr"
                                      autocomplete="off" spellcheck="false" autocapitalize="off"
                                      placeholder="${t('settings.tokenPlaceholder')}" required></textarea>
                            <div class="form-actions">
                                ${UI.button({
                                    variant: 'primary', size: 'sm', type: 'submit', icon: 'key',
                                    label: t('settings.validateSave'), id: 'settings-token-submit',
                                })}
                            </div>
                        </form>
                    </div>
                </div>
            </section>

            <section class="section">
                <h2 class="section-title">${t('settings.webhookTitle')}</h2>
                <div class="settings-card surface">
                    ${webhookError ? html`
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div>
                                <strong dir="auto">${t('settings.webhookUnknown', { message: webhookError.message })}</strong>
                                <span class="inline-error-hint">${t('settings.webhookUnknownHint')}</span>
                            </div>
                        </div>
                        ${UI.button({
                            variant: 'secondary', size: 'sm', className: 'mbe-4',
                            icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render',
                        })}
                    ` : html`
                        <div class="token-status">
                            <span class="status-pill ${webhookToken.configuredInDatabase ? html.raw('sent') : html.raw('failed')}">
                                ${webhookToken.configuredInDatabase ? t('settings.webhookConfigured') : t('settings.webhookNotSet')}
                            </span>
                            ${webhookToken.configuredInDatabase ? html`
                                <span class="text-meta">${UI.ltr(t('settings.webhookPreview', {
                                    preview: webhookToken.preview, length: webhookToken.length,
                                }))}</span>
                            ` : ''}
                        </div>
                    `}

                    <p class="form-hint">${t('settings.webhookBody')}</p>
                    ${envNote ? html`<p class="form-hint mbe-4">${t('settings.webhookBody2', { env: envNote })}</p>` : ''}

                    <form id="webhook-token-form" data-submit="settings:handleWebhookTokenUpdate">
                        <label class="form-label" for="settings-webhook-input">${t('settings.webhookLabel')}</label>
                        <input class="field field-mono" id="settings-webhook-input" name="token" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false"
                               placeholder="${t('settings.webhookPlaceholder')}" required>
                        <div class="form-actions">
                            <!-- Stable id: after a successful save the page
                                 re-renders and this button is destroyed, so it
                                 is what restoreFocus() re-finds. -->
                            ${UI.button({
                                variant: 'primary', size: 'sm', type: 'submit', icon: 'shield-check',
                                label: t('settings.webhookSave'), id: 'settings-webhook-submit',
                            })}
                        </div>
                    </form>
                </div>
            </section>

            ${this.tiktokSection({ tiktok, tiktokError, tiktokApp, tiktokAppError })}

            <section class="section">
                <h2 class="section-title">${t('settings.accountInfo')}</h2>
                <div class="settings-card surface stack gap-2">
                    <p class="token-info">${t('settings.igPageId')}: <strong>${UI.ltr(tokenStatus.instagramPageId || tokenStatus.pageId || '—')}</strong></p>
                    <p class="token-info">${t('settings.fbPageId')}: <strong>${UI.ltr(tokenStatus.facebookPageId || '—')}</strong></p>
                    <p class="token-info">${t('settings.accountStatus')}:
                        <strong class="${tokenStatus.isActive ? html.raw('text-success') : html.raw('text-danger')}">
                            ${tokenStatus.isActive ? t('settings.statusActive') : t('settings.statusInactive')}
                        </strong>
                    </p>
                    <p class="token-info">${t('settings.webhookUrl')}: <strong>${UI.ltr((webhookToken && webhookToken.webhookUrl) || `${location.origin}/webhook`)}</strong></p>
                </div>
            </section>

            <section class="section">
                <h2 class="section-title">${t('settings.appearance')}</h2>
                <div class="settings-card surface">
                    <div class="form-grid">
                        <div class="form-group">
                            <label class="form-label" for="settings-lang">${t('app.language')}</label>
                            <!-- Each option carries its own lang attribute so
                                 العربية is shaped by the Arabic face and "English" set in
                                 Inter, whichever language the interface is in. -->
                            <select class="select" id="settings-lang" data-change="app:setLanguage">
                                ${Object.keys(I18N.LANGS).map((code) => html`
                                    <option value="${code}" lang="${I18N.LANGS[code].htmlLang}"
                                            ${code === I18N.lang ? html.raw('selected') : ''}>${I18N.LANGS[code].label}</option>
                                `)}
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="settings-theme">${t('app.theme')}</label>
                            <select class="select" id="settings-theme" data-change="app:setTheme">
                                ${['auto', 'dark', 'light'].map((value) => html`
                                    <option value="${value}" ${value === App.currentTheme() ? html.raw('selected') : ''}>${t(`app.theme.${value}`)}</option>
                                `)}
                            </select>
                        </div>
                    </div>
                    <p class="form-hint">${t('settings.appearanceHint')}</p>
                </div>
            </section>
        `);

        UI.icons(container);
        UI.restoreFocus(focus);
        Motion.announce(`${t('nav.settings')} — ${t('common.loaded')}`);
        this.announceTikTokReturn();
    },

    /** Reasons the OAuth callback can send back, each with its own sentence. */
    TIKTOK_RETURN_REASONS: ['denied', 'state_mismatch', 'state_expired', 'account_in_use', 'exchange_failed', 'no_base_url'],

    /**
     * Coming back from TikTok's consent screen: the callback redirects to
     * `#/settings?tiktok=connected|error&reason=…`. Say what happened once,
     * then drop the parameters so a reload does not say it again.
     */
    announceTikTokReturn() {
        const outcome = App.hashParam('tiktok');
        if (!outcome) return;
        if (outcome === 'connected') {
            UI.toast(t('settings.tiktok.connectedToast'), 'success');
        } else {
            const reason = App.hashParam('reason');
            const known = this.TIKTOK_RETURN_REASONS.includes(reason);
            UI.toast(known ? t(`settings.tiktok.return.${reason}`) : t('settings.tiktok.return.generic'), 'error');
        }
        try {
            history.replaceState(null, '', `${location.pathname}#/settings`);
        } catch {
            // Only the repeat-on-reload is lost.
        }
    },

    tiktokSection({ tiktok, tiktokError, tiktokApp, tiktokAppError }) {
        const isAdmin = App.isAdmin();
        const canAdminister = App.canAdminister();
        const c = tiktok && tiktok.connection;
        const connected = !!(c && c.connected);
        const needsReconnect = !!(c && c.status === 'invalid');
        const refreshExpires = c && c.refreshExpiresAt ? new Date(c.refreshExpiresAt) : null;
        const daysToReconnect = refreshExpires ? Math.ceil((refreshExpires - Date.now()) / 86400000) : null;
        const avatar = c ? safeUrl(c.avatarUrl) : '';
        // Direct Post is switched on for the app but this connection predates
        // it, so it lacks `video.publish` — posts stay inbox drafts until reconnect.
        const needsDirectScope = !!(c && c.directPostEnabled && !c.canDirectPost);

        let body;
        if (tiktokError) {
            body = html`
                <div class="inline-error" role="alert">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    <div><strong dir="auto">${t('settings.tiktok.loadFailed', { message: tiktokError.message })}</strong></div>
                </div>
                ${UI.button({
                    variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render',
                })}
            `;
        } else if (!tiktok.appConfigured) {
            body = html`
                <p class="form-hint">${isAdmin ? t('settings.tiktok.notConfiguredAdmin') : t('settings.tiktok.notConfiguredMember')}</p>
            `;
        } else if (connected || needsReconnect) {
            body = html`
                <div class="row row--start gap-3 mbe-4">
                    ${avatar
                        ? html`<img class="tiktok-avatar-lg" src="${avatar}" alt="" width="44" height="44">`
                        : html`<span class="stat-icon shrink-0"><i data-lucide="music-2" aria-hidden="true"></i></span>`}
                    <div class="stack gap-1">
                        <strong dir="auto">${c.displayName || t('settings.tiktok.unnamed')}</strong>
                        <span class="health-pill ${needsReconnect ? html.raw('health-stale') : html.raw('health-fresh')}">
                            <i data-lucide="${needsReconnect ? 'alert-triangle' : 'check-circle'}" aria-hidden="true"></i>
                            ${needsReconnect ? t('settings.tiktok.statusInvalid') : t('settings.tiktok.statusActive')}
                        </span>
                    </div>
                </div>
                ${needsReconnect && c.lastError ? html`
                    <p class="form-hint text-warning mbe-3" dir="auto">${t('settings.tiktok.lastError', { message: c.lastError })}</p>
                ` : ''}
                <p class="token-info mbe-2">${t('settings.tiktok.modeLine', { mode: this.tiktokModeLabel(c) })}</p>
                ${needsDirectScope ? html`
                    <p class="form-hint text-warning mbe-3">
                        <i data-lucide="alert-triangle" aria-hidden="true"></i>
                        ${t('settings.tiktok.reconnectForDirect')}
                    </p>
                ` : ''}
                ${connected && c.directPostEnabled && !c.audited && c.canDirectPost && !c.canUpload ? html`
                    <p class="form-hint mbe-3">${t('settings.tiktok.reconnectForDrafts')}</p>
                ` : ''}
                ${connected && !c.canUpload && !c.canDirectPost ? html`
                    <p class="form-hint text-warning mbe-3">${t('settings.tiktok.cannotUpload')}</p>
                ` : ''}
                ${refreshExpires ? html`
                    <p class="token-info mbe-2">
                        ${t('settings.tiktok.reconnectBy', { date: UI.formatDay(refreshExpires) })}
                        ${daysToReconnect !== null && daysToReconnect < 30 ? html`
                            <span class="text-warning">${t('settings.daysLeft', { count: Math.max(daysToReconnect, 0) })}</span>
                        ` : ''}
                    </p>
                ` : ''}
                ${tiktok.inbox ? html`
                    <p class="token-info mbe-4 ${tiktok.inbox.pending >= tiktok.inbox.limit ? html.raw('text-warning') : ''}">
                        ${t('posts.tiktok.inboxUsage', { pending: tiktok.inbox.pending, limit: tiktok.inbox.limit })}
                    </p>
                ` : ''}
                ${c.scopes && c.scopes.length ? html`
                    <div class="mbe-4">
                        <p class="form-label">${t('settings.permissions')}</p>
                        <div class="scope-list">${c.scopes.map((sc) => html`<span class="chip">${UI.ltr(sc)}</span>`)}</div>
                    </div>
                ` : ''}
                ${canAdminister ? html`
                    <div class="row row--wrap gap-2">
                        ${UI.button({
                            variant: needsReconnect ? 'primary' : 'secondary', size: 'sm', icon: 'refresh-cw',
                            label: t('settings.tiktok.reconnect'), action: 'settings:connectTikTok', id: 'settings-tiktok-connect',
                        })}
                        ${UI.button({
                            variant: 'danger', size: 'sm', icon: 'unlink',
                            label: t('settings.tiktok.disconnect'), action: 'settings:disconnectTikTok', id: 'settings-tiktok-disconnect',
                        })}
                    </div>
                ` : html`<p class="form-hint">${t('settings.tiktok.ownerOnly')}</p>`}
            `;
        } else {
            body = html`
                ${canAdminister ? UI.button({
                    variant: 'primary', size: 'sm', icon: 'link',
                    label: t('settings.tiktok.connect'), action: 'settings:connectTikTok', id: 'settings-tiktok-connect',
                }) : html`<p class="form-hint">${t('settings.tiktok.ownerOnly')}</p>`}
            `;
        }

        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.tiktok.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${this.tiktokIntro(c)} ${UI.helpLink('tiktok', t('help.link.tiktok'), { className: 'settings-tiktok-help' })}</p>
                    ${body}
                    ${isAdmin ? this.tiktokAppBlock(tiktokApp, tiktokAppError, !!(tiktok && tiktok.appConfigured)) : ''}
                </div>
            </section>
        `;
    },

    /**
     * The mode posts go out in right now. Only the server decides it
     * (`postMode` is 'direct' iff the connection has `video.publish` AND the
     * admin has switched Direct Post on); this only names it.
     */
    tiktokModeLabel(c) {
        if (!c || c.postMode !== 'direct') return t('settings.tiktok.mode.inbox');
        if (c.audited) return t('settings.tiktok.mode.direct');
        return c.canUpload && c.canDirectPost ? t('settings.tiktok.mode.choose') : t('settings.tiktok.mode.directUnaudited');
    },

    /**
     * The section's opening sentence, true for the mode in force. Not connected
     * yet with Direct Post switched on: connecting will ask for `video.publish`,
     * so the direct sentence is the one that will be true.
     */
    tiktokIntro(c) {
        const direct = !!(c && (c.postMode === 'direct' || (c.directPostEnabled && !c.connected)));
        return direct ? t('settings.tiktok.introDirect') : t('settings.tiktok.introInbox');
    },

    /**
     * The TikTok app's own credentials — one set for the whole deployment, so
     * platform admins only. Open by default until the app is configured, since
     * until then it is the only thing in the section that does anything.
     */
    tiktokAppBlock(app, error, configured) {
        if (error) {
            return html`<p class="form-hint text-warning" dir="auto">${t('settings.tiktok.app.loadFailed', { message: error.message })}</p>`;
        }
        if (!app) return '';
        const reg = app.register;
        const secretNote = app.clientSecret.source === 'env'
            ? t('settings.tiktok.app.secretFromEnv')
            : (app.clientSecret.preview ? t('settings.tiktok.app.secretSet', { preview: app.clientSecret.preview }) : '');
        const row = (label, value) => html`
            <li>
                <span class="form-label">${label}</span>
                <code dir="ltr">${UI.ltr(value)}</code>
                ${UI.button({
                    variant: 'ghost', size: 'sm', icon: 'copy',
                    ariaLabel: t('setup.copyUrl'), title: t('setup.copyUrl'),
                    action: 'app:copyValue', data: { copy: value },
                })}
            </li>
        `;

        return html`
            <details class="settings-block" ${configured ? '' : html.raw('open')}>
                <summary class="form-label tiktok-app-summary">
                    <i data-lucide="chevron-down" aria-hidden="true"></i>
                    ${t('settings.tiktok.app.title')}
                </summary>
                <p class="form-hint mbe-3">${t('settings.tiktok.app.hint')}</p>

                ${reg ? html`
                    <p class="form-label">${t('settings.tiktok.app.register')}</p>
                    <ul class="tiktok-register mbe-4">
                        ${row(t('settings.tiktok.app.websiteUrl'), reg.websiteUrl)}
                        ${row(t('settings.tiktok.app.termsUrl'), reg.termsUrl)}
                        ${row(t('settings.tiktok.app.privacyUrl'), reg.privacyUrl)}
                        ${row(t('settings.tiktok.app.redirectUri'), reg.redirectUri)}
                        ${row(t('settings.tiktok.app.webhookUrl'), reg.webhookUrl)}
                        ${row(t('settings.tiktok.app.scopes'), (app.scopes || []).join(','))}
                    </ul>
                ` : ''}

                <form id="tiktok-app-form" data-submit="settings:saveTikTokApp">
                    <div class="form-group">
                        <label class="form-label" for="tiktok-client-key">${t('settings.tiktok.app.clientKey')}</label>
                        <input class="field field-mono" id="tiktok-client-key" name="clientKey" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false" autocapitalize="off"
                               value="${app.clientKey.value || ''}">
                    </div>
                    <div class="form-group">
                        <!-- Never prefilled: the secret is never sent back. Blank
                             means "keep what is saved". -->
                        <label class="form-label" for="tiktok-client-secret">${t('settings.tiktok.app.clientSecret')}</label>
                        <input class="field field-mono" id="tiktok-client-secret" name="clientSecret" type="password" dir="ltr"
                               autocomplete="new-password" spellcheck="false" autocapitalize="off">
                        ${secretNote ? html`<p class="form-hint">${UI.ltr(secretNote)}</p>` : ''}
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="tiktok-base-url">${t('settings.tiktok.app.baseUrl')}</label>
                        <input class="field field-mono" id="tiktok-base-url" name="publicBaseUrl" type="url" dir="ltr"
                               autocomplete="off" spellcheck="false"
                               placeholder="${app.publicBaseUrl.effective || 'https://'}"
                               value="${app.publicBaseUrl.saved || ''}">
                        <p class="form-hint">${t('settings.tiktok.app.baseUrlHint')}</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="tiktok-verify-name">
                            ${t('settings.tiktok.app.verifyName')} <span class="label-optional">${t('common.optional')}</span>
                        </label>
                        <input class="field field-mono" id="tiktok-verify-name" name="verificationFilename" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false" placeholder="tiktokXXXXXXXX.txt"
                               value="${app.verification.filename || ''}">
                        <label class="form-label mbs-3" for="tiktok-verify-content">${t('settings.tiktok.app.verifyContent')}</label>
                        <input class="field field-mono" id="tiktok-verify-content" name="verificationContent" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false" placeholder="tiktok-developers-site-verification=…">
                        <p class="form-hint">${t('settings.tiktok.app.verifyHint')}</p>
                        ${app.verification.url ? html`<p class="form-hint">${UI.ltr(app.verification.url)}</p>` : ''}
                    </div>
                    <!-- Two facts only the admin can know, because they live in
                         TikTok's portal: whether Direct Post is on for the app,
                         and whether TikTok's audit has passed. -->
                    <fieldset class="form-group fieldset-plain">
                        <legend class="form-label">${t('settings.tiktok.app.directPostTitle')}</legend>
                        <div class="stack gap-3">
                            <div class="check-row">
                                <input type="checkbox" id="tiktok-direct-enabled" name="directPostEnabled"
                                       ${app.directPostEnabled === true ? html.raw('checked') : ''}>
                                <span class="check-text">
                                    <label class="check-label" for="tiktok-direct-enabled">${t('settings.tiktok.app.directPostEnabled')}</label>
                                </span>
                            </div>
                            <div class="check-row">
                                <input type="checkbox" id="tiktok-audited" name="audited"
                                       ${app.audited === true ? html.raw('checked') : ''}>
                                <span class="check-text">
                                    <label class="check-label" for="tiktok-audited">${t('settings.tiktok.app.audited')}</label>
                                </span>
                            </div>
                        </div>
                        <p class="form-hint">${t('settings.tiktok.app.directPostHint')}</p>
                    </fieldset>
                    <div class="form-actions">
                        ${UI.button({
                            variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                            label: t('settings.tiktok.app.save'), id: 'tiktok-app-submit',
                        })}
                    </div>
                </form>
            </details>
        `;
    },

    /**
     * The session lives in localStorage, so the connect flow cannot be a plain
     * link: this asks the server (authenticated) for TikTok's authorise URL,
     * which also sets the single-use state cookie, and only then navigates.
     */
    async connectTikTok(btn) {
        if (!btn || btn.disabled) return;
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        try {
            const { url } = await API.startTikTokConnect();
            window.location.href = url;
        } catch (err) {
            restore();
            UI.toast(err.message || t('settings.tiktok.return.generic'), 'error');
        }
    },

    disconnectTikTok(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.tiktok.disconnectTitle'),
            body: t('settings.tiktok.disconnectBody'),
            hint: t('settings.tiktok.disconnectHint'),
            confirmLabel: t('settings.tiktok.disconnect'),
            confirmIcon: 'unlink',
            onConfirm: () => SettingsPage.disconnectTikTokConfirmed(),
        });
    },

    /**
     * A rejection here is shown inside the confirm dialog, which stays open
     * (Admin.runConfirm) — so no toast of its own on failure.
     */
    async disconnectTikTokConfirmed() {
        await API.disconnectTikTok();
        UI.toast(t('settings.tiktok.disconnected'), 'success');
        await this.render();
    },

    async saveTikTokApp(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const payload = {
            clientKey: (data.get('clientKey') || '').toString().trim(),
            publicBaseUrl: (data.get('publicBaseUrl') || '').toString().trim(),
            // Always sent, as booleans: an unticked box is a real "no", and
            // FormData would otherwise omit it.
            directPostEnabled: data.get('directPostEnabled') === 'on',
            audited: data.get('audited') === 'on',
        };
        // A blank secret means "leave it", not "clear it" — it is never sent
        // back to the page, so the field is always blank on load.
        const secret = (data.get('clientSecret') || '').toString().trim();
        if (secret) payload.clientSecret = secret;
        const verifyName = (data.get('verificationFilename') || '').toString().trim();
        const verifyContent = (data.get('verificationContent') || '').toString().trim();
        if (verifyContent) {
            payload.verificationFilename = verifyName;
            payload.verificationContent = verifyContent;
        }

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveTikTokAppSettings(payload);
            UI.toast(t('settings.tiktok.app.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message, 'error');
        }
    },

    /**
     * Both token forms were unguarded: submit twice on a cold serverless start
     * and the second POST overwrote the first with the same credential — or,
     * worse, raced the extend endpoint. `UI.formBusy` disables the button and
     * returns null if it was ALREADY disabled, which is the double-submit.
     */
    async handleWebhookTokenUpdate(form, event) {
        event.preventDefault();
        const token = (new FormData(form).get('token') || '').toString().trim();
        if (!token) return;

        // Captured BEFORE the button is disabled: disabling the focused element
        // blurs it, so by the time render() runs there is nothing to remember.
        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // a submit is already in flight

        try {
            const result = await API.updateWebhookToken(token);
            UI.toast(result.message || t('settings.webhookSaved'), 'success');
            // render() replaces the form, so the restore would be writing to a
            // detached button — and it must not run before the re-render puts
            // a fresh, enabled one on screen.
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message || t('settings.webhookSaveFailed'), 'error');
        }
    },

    async handleTokenUpdate(form, event) {
        event.preventDefault();
        const token = (new FormData(form).get('token') || '').toString().trim();
        if (!token) return;

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // a submit is already in flight

        try {
            const result = await API.updateToken(token);
            UI.toast(t('settings.tokenUpdated', {
                date: result.expiresAt ? UI.formatDay(result.expiresAt) : t('common.never'),
            }));
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message, 'error');
        }
    },

    /**
     * Ask first, in the product's own dialog — and NOT in red.
     *
     * Extending the token is consequential enough to confirm but destroys
     * nothing, so it passes tone: 'primary'. The hint carries the part that is
     * genuinely not obvious: Meta does not revoke the existing token when it
     * issues a new one.
     */
    extendToken(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.extendTitle'),
            body: t('settings.extendConfirm'),
            hint: t('settings.extendHint'),
            confirmLabel: t('settings.extend'),
            confirmIcon: 'key-round',
            tone: 'primary',
            onConfirm: () => SettingsPage.extendTokenConfirmed(btn),
        });
    },

    async extendTokenConfirmed(btn) {
        // Same reason as the two forms: disabling it blurs it, so the token is
        // taken first. `UI.actionBusy` replaces the hand-rolled version, which
        // set no `aria-busy` and called `buttonSpinner()` with no argument —
        // that falls back to "Loading", so the button both changed its label to
        // something meaningless and grew wide enough to shove the expiry line
        // beside it sideways. actionBusy keeps the button's own name for
        // assistive technology and pins the width it already had.
        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.actionBusy(btn);
        if (!restore) return; // already in flight

        try {
            await API.request('/settings/token/extend', { method: 'POST' });
            UI.toast(t('settings.extended'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            console.error(err);
            UI.toast(err.message || t('settings.extendFailed'), 'error');
            restore();
        }
    },
};

UI.registerActions('settings', {
    render: () => SettingsPage.render(),
    extendToken: (el) => SettingsPage.extendToken(el),
    handleTokenUpdate: (el, e) => SettingsPage.handleTokenUpdate(el, e),
    handleWebhookTokenUpdate: (el, e) => SettingsPage.handleWebhookTokenUpdate(el, e),
    connectTikTok: (el) => SettingsPage.connectTikTok(el),
    disconnectTikTok: (el) => SettingsPage.disconnectTikTok(el),
    saveTikTokApp: (el, e) => SettingsPage.saveTikTokApp(el, e),
});
