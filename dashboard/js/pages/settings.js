/**
 * Settings Page — Token management and account info.
 */
const SettingsPage = {
    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();

        try {
            const tokenStatus = await API.getTokenStatus();

            const isValid = tokenStatus.status === 'valid';
            const expiresAt = tokenStatus.expiresAt ? new Date(tokenStatus.expiresAt) : null;
            const daysLeft = expiresAt ? Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)) : null;

            container.innerHTML = `
                <div class="settings-section">
                    <h2 class="settings-title">Access Token</h2>
                    <div class="settings-card glass-card">
                        <div class="token-status">
                            <span class="token-badge ${isValid ? 'valid' : 'invalid'}">
                                <i data-lucide="${isValid ? 'check-circle' : 'alert-triangle'}" style="width:14px;height:14px;"></i>
                                ${isValid ? 'Valid' : 'Invalid / Expired'}
                            </span>
                            ${tokenStatus.type ? `<span style="font-size:12px;color:var(--text-muted);">Type: ${tokenStatus.type}</span>` : ''}
                        </div>
                        ${expiresAt ? `
                            <div class="token-info" style="margin-bottom:12px;">
                                Expires: <span>${expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                                ${daysLeft !== null ? ` (${daysLeft > 0 ? daysLeft + ' days left' : 'EXPIRED'})` : ''}
                            </div>
                        ` : ''}
                        ${tokenStatus.scopes ? `
                            <div style="margin-bottom:16px;">
                                <p class="form-label" style="margin-bottom:8px;">Permissions</p>
                                <div style="display:flex;flex-wrap:wrap;gap:6px;">
                                    ${tokenStatus.scopes.map(s => `<span style="padding:4px 10px;border-radius:6px;background:var(--bg-secondary);font-size:11px;color:var(--text-secondary);">${s}</span>`).join('')}
                                </div>
                            </div>
                        ` : ''}
                        <div style="margin-top:20px;padding-top:20px;border-top:1px solid var(--border-glass);">
                            <p class="form-label">Update Access Token</p>
                            <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Paste a new Page Access Token from the Meta Graph API Explorer. The token will be validated before saving.</p>
                            <form id="token-form" onsubmit="SettingsPage.handleTokenUpdate(event)">
                                <textarea class="form-textarea" name="token" placeholder="Paste your new Page Access Token here..." style="min-height:70px;font-size:12px;word-break:break-all;" required></textarea>
                                <button type="submit" class="btn btn-primary btn-sm" style="margin-top:12px;">
                                    <i data-lucide="key"></i> Validate & Save Token
                                </button>
                            </form>
                        </div>
                    </div>
                </div>

                <div class="settings-section">
                    <h2 class="settings-title">Account Info</h2>
                    <div class="settings-card glass-card">
                        <div class="token-info" style="margin-bottom:8px;">Page ID: <span>${tokenStatus.pageId || '—'}</span></div>
                        <div class="token-info" style="margin-bottom:8px;">Status: <span>${tokenStatus.isActive ? '🟢 Active' : '🔴 Inactive'}</span></div>
                        <div class="token-info">Webhook URL: <span>https://msg-response-auto.vercel.app/webhook</span></div>
                    </div>
                </div>
            `;
            lucide.createIcons({ nodes: [container] });

        } catch (err) {
            container.innerHTML = `<div class="empty-state"><i data-lucide="alert-circle"></i><h3>Error</h3><p>${err.message}</p></div>`;
            lucide.createIcons({ nodes: [container] });
        }
    },

    async handleTokenUpdate(e) {
        e.preventDefault();
        const form = new FormData(e.target);
        const token = form.get('token')?.toString().trim();
        if (!token) return;

        try {
            const result = await API.updateToken(token);
            UI.toast(`Token updated! Expires: ${result.expiresAt ? new Date(result.expiresAt).toLocaleDateString() : 'N/A'}`);
            this.render();
        } catch (err) {
            UI.toast(err.message, 'error');
        }
    }
};
