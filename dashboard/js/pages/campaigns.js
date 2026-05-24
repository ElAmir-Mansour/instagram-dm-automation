/**
 * Campaigns Page — CRUD campaign management with glassmorphic cards.
 */
const CampaignsPage = {
    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();

        try {
            const campaigns = await API.getCampaigns();
            container.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
                    <div>
                        <p style="font-size:13px;color:var(--text-secondary);">${campaigns.length} campaign${campaigns.length !== 1 ? 's' : ''}</p>
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="CampaignsPage.showCreateModal()">
                        <i data-lucide="plus"></i> New Campaign
                    </button>
                </div>
                <div class="campaigns-grid" id="campaigns-list">
                    ${campaigns.length === 0 ? `
                        <div class="empty-state glass-card" style="grid-column:1/-1;">
                            <i data-lucide="megaphone"></i>
                            <h3>No Campaigns Yet</h3>
                            <p>Create your first campaign to start automating DM replies.</p>
                            <button class="btn btn-primary btn-sm" style="margin-top:16px;" onclick="CampaignsPage.showCreateModal()">
                                <i data-lucide="plus"></i> Create Campaign
                            </button>
                        </div>
                    ` : campaigns.map(c => `
                        <div class="campaign-card glass-card" data-id="${c.id}" style="${c.is_active !== false ? '' : 'opacity:0.65;'}">
                            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                                <div style="display:flex;flex-wrap:wrap;gap:6px;max-width:70%;">
                                    ${c.trigger_keyword.split(',').map(k => k.trim()).filter(Boolean).map(k => `
                                        <span class="campaign-keyword" style="margin:0;padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:12px;display:inline-flex;align-items:center;gap:4px;">
                                            <i data-lucide="hash" style="width:10px;height:10px;"></i>
                                            ${this.escapeHtml(k)}
                                        </span>
                                    `).join('')}
                                </div>
                                <div style="display:flex;align-items:center;gap:8px;">
                                    <span style="font-size:11px;color:${c.is_active !== false ? 'var(--success)' : 'var(--text-muted)'};">${c.is_active !== false ? 'Active' : 'Paused'}</span>
                                    <label class="toggle-switch" style="transform:scale(0.8);margin:0;">
                                        <input type="checkbox" ${c.is_active !== false ? 'checked' : ''} onchange="CampaignsPage.toggleActive('${c.id}', this.checked)">
                                        <span class="toggle-slider"></span>
                                    </label>
                                </div>
                            </div>
                            <div class="campaign-template">${this.escapeHtml(c.dm_template)}</div>
                            ${c.public_reply_template ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">💬 Public: "${this.escapeHtml(c.public_reply_template)}"</div>` : ''}
                            ${c.post_id ? `<div style="font-size:11px;color:var(--accent);margin-bottom:12px;display:flex;align-items:center;gap:4px;"><i data-lucide="instagram" style="width:12px;height:12px;"></i> Post ID: ${this.escapeHtml(c.post_id)}</div>` : ''}
                            <div class="campaign-stats">
                                <div class="campaign-stat"><span class="dot green"></span> ${c.sent_count} sent</div>
                                <div class="campaign-stat"><span class="dot red"></span> ${c.failed_count} failed</div>
                                <div class="campaign-stat" style="color:var(--text-muted);">${c.total_interactions} total</div>
                            </div>
                            <div class="campaign-actions">
                                <button class="btn btn-secondary btn-sm" onclick="CampaignsPage.showEditModal('${c.id}')">
                                    <i data-lucide="pencil"></i> Edit
                                </button>
                                <button class="btn btn-danger btn-sm" onclick="CampaignsPage.confirmDelete('${c.id}', '${this.escapeHtml(c.trigger_keyword)}')">
                                    <i data-lucide="trash-2"></i> Delete
                                </button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
            lucide.createIcons({ nodes: [container] });
        } catch (err) {
            container.innerHTML = `<div class="empty-state"><i data-lucide="alert-circle"></i><h3>Error</h3><p>${err.message}</p></div>`;
            lucide.createIcons({ nodes: [container] });
        }
    },

    showCreateModal() {
        UI.showModal(`
            <div class="modal-header">
                <h2 class="modal-title">Create Campaign</h2>
                <button class="modal-close" onclick="UI.closeModal()"><i data-lucide="x"></i></button>
            </div>
            <form id="campaign-form" onsubmit="CampaignsPage.handleCreate(event)">
                <div class="form-group">
                    <label class="form-label">Trigger Keyword(s)</label>
                    <input class="form-input" name="trigger_keyword" placeholder="e.g. تم, كورس, كوبون" required>
                    <p class="form-hint">Separate multiple keywords with commas (e.g. "كورس, كوبون"). The bot triggers on any match.</p>
                </div>
                <div class="form-group">
                    <label class="form-label">DM Template</label>
                    <textarea class="form-textarea" name="dm_template" placeholder="The message sent to the user's DMs..." required></textarea>
                </div>
                <div class="form-group">
                    <label class="form-label">Public Reply (optional)</label>
                    <input class="form-input" name="public_reply_template" placeholder="e.g. تم الإرسال! 📩 | شوف الخاص! 🚀">
                    <p class="form-hint">Separate variations with "|" to rotate replies randomly and bypass spam filters.</p>
                </div>
                <div class="form-group">
                    <label class="form-label">Target Post ID (optional)</label>
                    <div style="display:flex; gap:8px;">
                        <input class="form-input" id="campaign-post-id" name="post_id" placeholder="e.g. 17841459652725922" style="flex:1;">
                        <button type="button" class="btn btn-secondary btn-sm" onclick="CampaignsPage.openPostPicker()" style="padding:0 12px; height: 45px;"><i data-lucide="image"></i> Pick Post</button>
                    </div>
                    <div id="post-picker-container" class="glass-card" style="display:none; margin-top:8px; max-height:200px; overflow-y:auto; padding:8px; border-color:var(--border-glass-hover);"></div>
                    <p class="form-hint">If specified, this campaign will only trigger on comments under this specific post.</p>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" onclick="UI.closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="plus"></i> Create</button>
                </div>
            </form>
        `);
    },

    async showEditModal(id) {
        const campaigns = await API.getCampaigns();
        const c = campaigns.find(x => x.id === id);
        if (!c) return;

        UI.showModal(`
            <div class="modal-header">
                <h2 class="modal-title">Edit Campaign</h2>
                <button class="modal-close" onclick="UI.closeModal()"><i data-lucide="x"></i></button>
            </div>
            <form id="campaign-form" onsubmit="CampaignsPage.handleEdit(event, '${id}')">
                <div class="form-group">
                    <label class="form-label">Trigger Keyword(s)</label>
                    <input class="form-input" name="trigger_keyword" value="${this.escapeHtml(c.trigger_keyword)}" placeholder="e.g. تم, كورس" required>
                    <p class="form-hint">Separate multiple keywords with commas.</p>
                </div>
                <div class="form-group">
                    <label class="form-label">DM Template</label>
                    <textarea class="form-textarea" name="dm_template" required>${this.escapeHtml(c.dm_template)}</textarea>
                </div>
                <div class="form-group">
                    <label class="form-label">Public Reply (optional)</label>
                    <input class="form-input" name="public_reply_template" value="${this.escapeHtml(c.public_reply_template || '')}" placeholder="e.g. Reply A | Reply B">
                    <p class="form-hint">Separate variations with "|" to rotate replies randomly.</p>
                </div>
                <div class="form-group">
                    <label class="form-label">Target Post ID (optional)</label>
                    <div style="display:flex; gap:8px;">
                        <input class="form-input" id="campaign-post-id" name="post_id" value="${this.escapeHtml(c.post_id || '')}" placeholder="e.g. 17841459652725922" style="flex:1;">
                        <button type="button" class="btn btn-secondary btn-sm" onclick="CampaignsPage.openPostPicker()" style="padding:0 12px; height: 45px;"><i data-lucide="image"></i> Pick Post</button>
                    </div>
                    <div id="post-picker-container" class="glass-card" style="display:none; margin-top:8px; max-height:200px; overflow-y:auto; padding:8px; border-color:var(--border-glass-hover);"></div>
                </div>
                <div class="form-group" style="display:flex;align-items:center;gap:12px;margin-top:16px;margin-bottom:8px;">
                    <label class="toggle-switch" style="margin:0;">
                        <input type="checkbox" name="is_active" ${c.is_active !== false ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="toggle-label" style="font-size:13px;color:var(--text-secondary);">Campaign Active</span>
                </div>
                <div class="modal-actions" style="margin-top:24px;">
                    <button type="button" class="btn btn-secondary" onclick="UI.closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="check"></i> Save</button>
                </div>
            </form>
        `);
    },

    async handleCreate(e) {
        e.preventDefault();
        const form = new FormData(e.target);
        try {
            await API.createCampaign({
                trigger_keyword: form.get('trigger_keyword'),
                dm_template: form.get('dm_template'),
                public_reply_template: form.get('public_reply_template') || null,
                post_id: form.get('post_id') || null,
            });
            UI.closeModal();
            UI.toast('Campaign created successfully!');
            this.render();
        } catch (err) { UI.toast(err.message, 'error'); }
    },

    async handleEdit(e, id) {
        e.preventDefault();
        const form = new FormData(e.target);
        try {
            await API.updateCampaign(id, {
                trigger_keyword: form.get('trigger_keyword'),
                dm_template: form.get('dm_template'),
                public_reply_template: form.get('public_reply_template') || null,
                post_id: form.get('post_id') || null,
                is_active: form.get('is_active') === 'on',
            });
            UI.closeModal();
            UI.toast('Campaign updated!');
            this.render();
        } catch (err) { UI.toast(err.message, 'error'); }
    },

    async toggleActive(id, isChecked) {
        try {
            await API.updateCampaign(id, { is_active: isChecked });
            UI.toast(isChecked ? 'Campaign activated.' : 'Campaign paused.');
            this.render();
        } catch (err) {
            UI.toast(err.message, 'error');
            this.render();
        }
    },

    confirmDelete(id, keyword) {
        UI.showModal(`
            <div class="modal-header">
                <h2 class="modal-title">Delete Campaign</h2>
                <button class="modal-close" onclick="UI.closeModal()"><i data-lucide="x"></i></button>
            </div>
            <p style="color:var(--text-secondary);font-size:14px;line-height:1.6;margin-bottom:8px;">
                Are you sure you want to delete the campaign with keyword <strong style="color:var(--accent);">"${keyword}"</strong>?
            </p>
            <p style="color:var(--text-muted);font-size:13px;margin-bottom:24px;">This will also delete all interaction history for this campaign.</p>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="UI.closeModal()">Cancel</button>
                <button class="btn btn-danger" onclick="CampaignsPage.handleDelete('${id}')"><i data-lucide="trash-2"></i> Delete</button>
            </div>
        `);
    },

    async handleDelete(id) {
        try {
            await API.deleteCampaign(id);
            UI.closeModal();
            UI.toast('Campaign deleted.');
            this.render();
        } catch (err) { UI.toast(err.message, 'error'); }
    },

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    },

    async openPostPicker() {
        const picker = document.getElementById('post-picker-container');
        const btn = document.querySelector('button[onclick="CampaignsPage.openPostPicker()"]');

        if (picker.style.display === 'block') {
            picker.style.display = 'none';
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px;margin:0;"></div> Loading...';

        try {
            const livePosts = await API.getLivePosts();
            picker.style.display = 'block';

            if (livePosts.length === 0) {
                picker.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:12px;">No published posts found.</div>`;
            } else {
                picker.innerHTML = livePosts.map(p => `
                    <div class="post-picker-item" onclick="CampaignsPage.selectPickedPost('${p.id}')" style="display:flex; gap:8px; padding:6px; border-radius:6px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.03); transition:background 0.2s;">
                        ${p.media_url ? `<img src="${p.media_url}" style="width:40px; height:40px; object-fit:cover; border-radius:4px; flex-shrink:0;">` : `<div style="width:40px;height:40px;border-radius:4px;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i data-lucide="${p.platform === 'facebook' ? 'facebook' : 'instagram'}" style="width:16px;height:16px;"></i></div>`}
                        <div style="overflow:hidden;">
                            <div style="font-size:11px; color:var(--accent); font-weight:600;">ID: ${p.id}</div>
                            <div style="font-size:11px; color:var(--text-secondary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${this.escapeHtml(p.caption || '(No caption)')}</div>
                        </div>
                    </div>
                `).join('');
                
                const items = picker.querySelectorAll('.post-picker-item');
                items.forEach(el => {
                    el.addEventListener('mouseenter', () => el.style.background = 'var(--bg-glass-hover)');
                    el.addEventListener('mouseleave', () => el.style.background = 'transparent');
                });
                lucide.createIcons({ nodes: [picker] });
            }
        } catch (err) {
            picker.style.display = 'block';
            picker.innerHTML = `<div style="font-size:12px; color:var(--danger); text-align:center; padding:12px;">Failed to load: ${err.message}</div>`;
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="image"></i> Pick Post';
            lucide.createIcons({ nodes: [btn] });
        }
    },

    selectPickedPost(id) {
        document.getElementById('campaign-post-id').value = id;
        document.getElementById('post-picker-container').style.display = 'none';
    }
};
