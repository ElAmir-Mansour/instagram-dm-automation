/**
 * Settings — access token, webhook verify token, account info, appearance.
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

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();

        // The access token status is the page — if it fails there is nothing to show.
        let tokenStatus;
        try {
            tokenStatus = await API.getTokenStatus();
        } catch (err) {
            UI.renderError(container, { title: t('settings.errorTitle'), message: err.message }, () => this.render());
            return;
        }

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

        const isValid = tokenStatus.status === 'valid';
        const expiresAt = tokenStatus.expiresAt ? new Date(tokenStatus.expiresAt) : null;
        const daysLeft = expiresAt ? Math.ceil((expiresAt - Date.now()) / 86400000) : null;

        const missingScopes = isValid && Array.isArray(tokenStatus.scopes)
            ? this.REQUIRED_SCOPES.filter((scope) => !tokenStatus.scopes.includes(scope))
            : [];

        const envNote = webhookError
            ? '.'
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
                            <button type="button" class="btn btn-secondary btn-sm" data-action="settings:extendToken">
                                <i data-lucide="refresh-cw" aria-hidden="true"></i> ${t('settings.extend')}
                            </button>
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
                            <textarea class="field-textarea field-mono" id="settings-token-input" name="token" dir="ltr"
                                      placeholder="${t('settings.tokenPlaceholder')}" required></textarea>
                            <div class="form-actions">
                                <button type="submit" class="btn btn-primary btn-sm">
                                    <i data-lucide="key" aria-hidden="true"></i> ${t('settings.validateSave')}
                                </button>
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
                        <button type="button" class="btn btn-secondary btn-sm mbe-4" data-action="settings:render">
                            <i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('common.retry')}
                        </button>
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
                    <p class="form-hint mbe-4">${t('settings.webhookBody2', { env: envNote })}</p>

                    <form id="webhook-token-form" data-submit="settings:handleWebhookTokenUpdate">
                        <label class="form-label" for="settings-webhook-input">${t('settings.webhookLabel')}</label>
                        <input class="field field-mono" id="settings-webhook-input" name="token" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false"
                               placeholder="${t('settings.webhookPlaceholder')}" required>
                        <div class="form-actions">
                            <button type="submit" class="btn btn-primary btn-sm">
                                <i data-lucide="shield-check" aria-hidden="true"></i> ${t('settings.webhookSave')}
                            </button>
                        </div>
                    </form>
                </div>
            </section>

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
                            <select class="select" id="settings-lang" data-change="app:setLanguage">
                                ${Object.keys(I18N.LANGS).map((code) => html`
                                    <option value="${code}" ${code === I18N.lang ? html.raw('selected') : ''}>${I18N.LANGS[code].label}</option>
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
    },

    async handleWebhookTokenUpdate(form, event) {
        event.preventDefault();
        const token = (new FormData(form).get('token') || '').toString().trim();
        if (!token) return;

        try {
            const result = await API.updateWebhookToken(token);
            UI.toast(result.message || t('settings.webhookSaved'), 'success');
            this.render();
        } catch (err) {
            UI.toast(err.message || t('settings.webhookSaveFailed'), 'error');
        }
    },

    async handleTokenUpdate(form, event) {
        event.preventDefault();
        const token = (new FormData(form).get('token') || '').toString().trim();
        if (!token) return;

        try {
            const result = await API.updateToken(token);
            UI.toast(t('settings.tokenUpdated', {
                date: result.expiresAt ? UI.formatDay(result.expiresAt) : t('common.never'),
            }));
            this.render();
        } catch (err) {
            UI.toast(err.message, 'error');
        }
    },

    async extendToken(btn) {
        if (!confirm(t('settings.extendConfirm'))) return;

        const originalHtml = btn.innerHTML;
        btn.innerHTML = UI.buttonSpinner();
        btn.disabled = true;

        try {
            await API.request('/settings/token/extend', { method: 'POST' });
            UI.toast(t('settings.extended'), 'success');
            await this.render();
        } catch (err) {
            console.error(err);
            UI.toast(err.message || t('settings.extendFailed'), 'error');
            btn.innerHTML = originalHtml;
            btn.disabled = false;
            UI.icons(btn);
        }
    },
};

UI.registerActions('settings', {
    render: () => SettingsPage.render(),
    extendToken: (el) => SettingsPage.extendToken(el),
    handleTokenUpdate: (el, e) => SettingsPage.handleTokenUpdate(el, e),
    handleWebhookTokenUpdate: (el, e) => SettingsPage.handleWebhookTokenUpdate(el, e),
});
