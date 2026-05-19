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
                        <div class="campaign-card glass-card" data-id="${c.id}">
                            <div class="campaign-keyword">
                                <i data-lucide="hash" style="width:14px;height:14px;"></i>
                                ${this.escapeHtml(c.trigger_keyword)}
                            </div>
                            <div class="campaign-template">${this.escapeHtml(c.dm_template)}</div>
                            ${c.public_reply_template ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">💬 Public: "${this.escapeHtml(c.public_reply_template)}"</div>` : ''}
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
                    <label class="form-label">Trigger Keyword</label>
                    <input class="form-input" name="trigger_keyword" placeholder="e.g. تم" required>
                    <p class="form-hint">When a user comments this word, the bot triggers.</p>
                </div>
                <div class="form-group">
                    <label class="form-label">DM Template</label>
                    <textarea class="form-textarea" name="dm_template" placeholder="The message sent to the user's DMs..." required></textarea>
                </div>
                <div class="form-group">
                    <label class="form-label">Public Reply (optional)</label>
                    <input class="form-input" name="public_reply_template" placeholder="e.g. تم الإرسال في الخاص! 📩">
                    <p class="form-hint">This reply is posted publicly under their comment.</p>
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
                    <label class="form-label">Trigger Keyword</label>
                    <input class="form-input" name="trigger_keyword" value="${this.escapeHtml(c.trigger_keyword)}" required>
                </div>
                <div class="form-group">
                    <label class="form-label">DM Template</label>
                    <textarea class="form-textarea" name="dm_template" required>${this.escapeHtml(c.dm_template)}</textarea>
                </div>
                <div class="form-group">
                    <label class="form-label">Public Reply (optional)</label>
                    <input class="form-input" name="public_reply_template" value="${this.escapeHtml(c.public_reply_template || '')}">
                </div>
                <div class="modal-actions">
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
            });
            UI.closeModal();
            UI.toast('Campaign updated!');
            this.render();
        } catch (err) { UI.toast(err.message, 'error'); }
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
    }
};
