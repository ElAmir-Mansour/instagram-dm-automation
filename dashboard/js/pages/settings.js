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

            const requiredScopes = [
                { name: 'pages_manage_engagement', desc: 'Facebook comment replies and auto-likes' },
                { name: 'pages_messaging', desc: 'Facebook Messenger message replies' },
                { name: 'instagram_manage_comments', desc: 'Instagram comment parsing and public replies' },
                { name: 'instagram_manage_messages', desc: 'Instagram DM automation' },
                { name: 'instagram_content_publish', desc: 'Instagram post publishing and scheduling' }
            ];

            const missingScopes = isValid && Array.isArray(tokenStatus.scopes)
                ? requiredScopes.filter(scope => !tokenStatus.scopes.includes(scope.name))
                : [];

            container.innerHTML = `
                ${missingScopes.length > 0 ? `
                    <div class="settings-card glass-card" style="border-left: 4px solid var(--warning); margin-bottom: 24px; background: rgba(245,158,11,0.02);">
                        <div style="display:flex; gap:16px; align-items:flex-start;">
                            <div class="stat-icon warning" style="flex-shrink:0; background:var(--warning-bg); color:var(--warning); width:40px; height:40px; border-radius:10px; display:flex; align-items:center; justify-content:center;">
                                <i data-lucide="alert-triangle" style="width:20px; height:20px;"></i>
                            </div>
                            <div>
                                <h3 style="font-size:14px; font-weight:700; color:var(--warning); margin-bottom:6px;">Missing Recommended Meta Permissions</h3>
                                <p style="font-size:13px; color:var(--text-secondary); margin-bottom:12px; line-height: 1.5;">
                                    The following permissions are missing from your current access token. Some automated reply features may fail:
                                </p>
                                <ul style="font-size:12px; color:var(--text-muted); padding-left:20px; line-height:1.7; margin:0;">
                                    ${missingScopes.map(s => `<li><strong style="color:var(--text-secondary);">${s.name}</strong>: Required for ${s.desc}.</li>`).join('')}
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
                                <i data-lucide="${isValid ? 'check-circle' : 'alert-triangle'}" style="width:14px;height:14px;"></i>
                                ${isValid ? 'Valid' : 'Invalid / Expired'}
                            </span>
                            ${tokenStatus.type ? `<span style="font-size:12px;color:var(--text-muted);">Type: ${tokenStatus.type}</span>` : ''}
                        </div>
                        ${expiresAt ? `
                            <div class="token-info" style="margin-bottom:12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                                <div>
                                    Expires: <span>${expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                                    ${daysLeft !== null ? ` <span style="color: ${daysLeft < 7 ? 'var(--warning)' : 'inherit'}">(${daysLeft > 0 ? daysLeft + ' days left' : 'EXPIRED'})</span>` : ''}
                                </div>
                                <button type="button" class="btn btn-secondary btn-sm" onclick="SettingsPage.extendToken(event)" style="padding: 4px 10px; font-size: 11px; height: auto;">
                                    <i data-lucide="refresh-cw" style="width:12px;height:12px;margin-right:4px;"></i> Extend to Never-Expiring
                                </button>
                            </div>
                        ` : `
                            <div class="token-info" style="margin-bottom:12px;">
                                Expires: <span>Never (Long-Lived)</span>
                            </div>
                        `}
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
                        <div class="token-info" style="margin-bottom:8px;">Instagram Page ID: <span>${tokenStatus.instagramPageId || tokenStatus.pageId || '—'}</span></div>
                        <div class="token-info" style="margin-bottom:8px;">Facebook Page ID: <span>${tokenStatus.facebookPageId || '—'}</span></div>
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
    },

    async extendToken(e) {
        if (!confirm('Are you sure you want to request a never-expiring token from Meta?')) return;
        
        const btn = e.currentTarget;
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<span style="display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin 0.75s linear infinite;margin-right:4px;vertical-align:middle;"></span> Extending...';
        btn.disabled = true;

        try {
            const res = await fetch('/api/settings/token/extend', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            
            if (!res.ok) throw new Error(data.error || 'Failed to extend token');
            
            UI.toast('Token extended successfully to never expire!', 'success');
            await this.render();
        } catch (err) {
            console.error(err);
            UI.toast(err.message, 'error');
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    }
};
