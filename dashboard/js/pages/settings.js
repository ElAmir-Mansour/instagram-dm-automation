/**
 * Settings Page — Token management and account info.
 */
const SettingsPage = {
    REQUIRED_SCOPES: [
        { name: 'pages_manage_engagement', desc: 'Facebook comment replies and auto-likes' },
        { name: 'pages_messaging', desc: 'Facebook Messenger message replies' },
        { name: 'instagram_manage_comments', desc: 'Instagram comment parsing and public replies' },
        { name: 'instagram_manage_messages', desc: 'Instagram DM automation' },
        { name: 'instagram_content_publish', desc: 'Instagram post publishing and scheduling' },
    ],

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader('Loading settings…');

        // The access token status is the page — if it fails there is nothing to show.
        let tokenStatus;
        try {
            tokenStatus = await API.getTokenStatus();
        } catch (err) {
            UI.renderError(
                container,
                { title: 'Could not load settings', message: err.message },
                () => this.render()
            );
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
        const daysLeft = expiresAt ? Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)) : null;

        const missingScopes = isValid && Array.isArray(tokenStatus.scopes)
            ? this.REQUIRED_SCOPES.filter((scope) => !tokenStatus.scopes.includes(scope.name))
            : [];

        container.innerHTML = esc(html`
            ${missingScopes.length > 0 ? html`
                <div class="settings-card glass-card warning-card">
                    <div style="display:flex; gap:16px; align-items:flex-start;">
                        <div class="stat-icon warning" style="flex-shrink:0;">
                            <i data-lucide="alert-triangle" style="width:20px; height:20px;" aria-hidden="true"></i>
                        </div>
                        <div>
                            <h3 class="warning-card-title">Missing Recommended Meta Permissions</h3>
                            <p style="font-size:13px; color:var(--text-secondary); margin-bottom:12px; line-height:1.5;">
                                The following permissions are missing from your current access token. Some automated reply features may fail:
                            </p>
                            <ul class="warning-card-list">
                                ${missingScopes.map((s) => html`<li><strong>${s.name}</strong>: Required for ${s.desc}.</li>`)}
                            </ul>
                        </div>
                    </div>
                </div>
            ` : ''}

            <div class="settings-section">
                <h2 class="settings-title">Access Token</h2>
                <div class="settings-card glass-card">
                    <div class="token-status">
                        <span class="token-badge ${isValid ? 'valid' : 'invalid'}">
                            <i data-lucide="${isValid ? 'check-circle' : 'alert-triangle'}" style="width:14px;height:14px;" aria-hidden="true"></i>
                            ${isValid ? 'Valid' : 'Invalid / Expired'}
                        </span>
                        ${tokenStatus.type ? html`<span style="font-size:12px;color:var(--text-muted);">Type: ${tokenStatus.type}</span>` : ''}
                    </div>
                    ${expiresAt ? html`
                        <div class="token-info" style="margin-bottom:12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                            <div>
                                Expires: <span>${UI.formatDay(expiresAt)}</span>
                                ${daysLeft !== null ? html`
                                    <span style="color:${daysLeft < 7 ? html.raw('var(--warning)') : html.raw('inherit')}">
                                        (${daysLeft > 0 ? `${daysLeft} days left` : 'EXPIRED'})
                                    </span>
                                ` : ''}
                            </div>
                            <button type="button" class="btn btn-secondary btn-sm" data-action="settings:extendToken"
                                    style="padding:6px 10px; font-size:11px;">
                                <i data-lucide="refresh-cw" style="width:12px;height:12px;margin-right:4px;" aria-hidden="true"></i> Extend to Never-Expiring
                            </button>
                        </div>
                    ` : html`
                        <div class="token-info" style="margin-bottom:12px;">
                            Expires: <span>Never (Long-Lived)</span>
                        </div>
                    `}
                    ${tokenStatus.scopes ? html`
                        <div style="margin-bottom:16px;">
                            <p class="form-label" style="margin-bottom:8px;">Permissions</p>
                            <div style="display:flex;flex-wrap:wrap;gap:6px;">
                                ${tokenStatus.scopes.map((s) => html`<span class="scope-chip">${s}</span>`)}
                            </div>
                        </div>
                    ` : ''}
                    <div style="margin-top:20px;padding-top:20px;border-top:1px solid var(--border-glass);">
                        <label class="form-label" for="settings-token-input">Update Access Token</label>
                        <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Paste a new Page Access Token from the Meta Graph API Explorer. The token will be validated before saving.</p>
                        <form id="token-form" data-submit="settings:handleTokenUpdate">
                            <textarea class="form-textarea" id="settings-token-input" name="token"
                                      placeholder="Paste your new Page Access Token here..."
                                      style="min-height:70px;font-size:12px;word-break:break-all;" required></textarea>
                            <button type="submit" class="btn btn-primary btn-sm" style="margin-top:12px;">
                                <i data-lucide="key" aria-hidden="true"></i> Validate &amp; Save Token
                            </button>
                        </form>
                    </div>
                </div>
            </div>

            <div class="settings-section">
                <h2 class="settings-title">Webhook Verify Token</h2>
                <div class="settings-card glass-card">
                    ${webhookError ? html`
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div>
                                <strong>Could not read the current verify token: ${webhookError.message}</strong>
                                <span class="inline-error-hint">
                                    This does NOT mean the token is unset — the status is simply unknown.
                                    Do not re-enter it based on this screen; retry first.
                                </span>
                            </div>
                        </div>
                        <button type="button" class="btn btn-secondary btn-sm" style="margin-bottom:16px;" data-action="settings:render">
                            <i data-lucide="rotate-cw" aria-hidden="true"></i> Retry
                        </button>
                    ` : html`
                        <div class="token-status" style="margin-bottom:16px;">
                            <span class="status-pill ${webhookToken.configuredInDatabase ? 'sent' : 'failed'}">
                                ${webhookToken.configuredInDatabase ? 'Configured' : 'Not set'}
                            </span>
                            ${webhookToken.configuredInDatabase ? html`
                                <span style="font-size:12px;color:var(--text-muted);margin-left:10px;font-family:monospace;">
                                    ${webhookToken.preview} (${webhookToken.length} chars)
                                </span>
                            ` : ''}
                        </div>
                    `}
                    <p style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:4px;">
                        Meta checks this value every time you create a webhook subscription or change its callback URL.
                        It is a secret you invent — it just has to match on both sides.
                    </p>
                    <p style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:16px;">
                        Saving here takes effect immediately. No redeploy, and it does not depend on the
                        <code style="font-size:11px;">META_VERIFY_TOKEN</code> environment variable${
                            webhookError ? '.' : (webhookToken.configuredInEnv
                                ? ' (currently also set in the environment).'
                                : ' (currently not set in the environment).')
                        }
                    </p>
                    <form id="webhook-token-form" data-submit="settings:handleWebhookTokenUpdate">
                        <label class="sr-only" for="settings-webhook-input">Webhook verify token</label>
                        <input class="form-input" id="settings-webhook-input" name="token" type="text"
                               autocomplete="off" spellcheck="false"
                               placeholder="e.g. my_webhook_secret_2026" style="font-family:monospace;font-size:12px;" required>
                        <button type="submit" class="btn btn-primary btn-sm" style="margin-top:12px;">
                            <i data-lucide="shield-check" aria-hidden="true"></i> Save Verify Token
                        </button>
                    </form>
                </div>
            </div>

            <div class="settings-section">
                <h2 class="settings-title">Account Info</h2>
                <div class="settings-card glass-card">
                    <div class="token-info" style="margin-bottom:8px;">Instagram Page ID: <span>${tokenStatus.instagramPageId || tokenStatus.pageId || '—'}</span></div>
                    <div class="token-info" style="margin-bottom:8px;">Facebook Page ID: <span>${tokenStatus.facebookPageId || '—'}</span></div>
                    <div class="token-info" style="margin-bottom:8px;">Status: <span>${tokenStatus.isActive ? '🟢 Active' : '🔴 Inactive'}</span></div>
                    <div class="token-info">Webhook URL: <span>${(webhookToken && webhookToken.webhookUrl) || `${location.origin}/webhook`}</span></div>
                </div>
            </div>
        `);

        UI.icons(container);
    },

    async handleWebhookTokenUpdate(form, event) {
        event.preventDefault();
        const token = (new FormData(form).get('token') || '').toString().trim();
        if (!token) return;

        try {
            const result = await API.updateWebhookToken(token);
            UI.toast(result.message || 'Verify token saved.', 'success');
            this.render();
        } catch (err) {
            UI.toast(err.message || 'Failed to save verify token.', 'error');
        }
    },

    async handleTokenUpdate(form, event) {
        event.preventDefault();
        const token = (new FormData(form).get('token') || '').toString().trim();
        if (!token) return;

        try {
            const result = await API.updateToken(token);
            UI.toast(`Token updated. Expires: ${result.expiresAt ? UI.formatDay(result.expiresAt) : 'never'}`);
            this.render();
        } catch (err) {
            UI.toast(err.message, 'error');
        }
    },

    async extendToken(btn) {
        if (!confirm('Are you sure you want to request a never-expiring token from Meta?')) return;

        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px;margin:0 6px 0 0;display:inline-block;vertical-align:middle;"></div> Extending...';
        btn.disabled = true;

        try {
            await API.request('/settings/token/extend', { method: 'POST' });
            UI.toast('Token extended successfully to never expire.', 'success');
            await this.render();
        } catch (err) {
            console.error(err);
            UI.toast(err.message || 'Failed to extend token', 'error');
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
