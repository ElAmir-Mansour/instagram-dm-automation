/**
 * Posts Scheduler Page — Create, schedule, and publish posts to Instagram & Facebook.
 */
const PostsPage = {
    activeTab: 'scheduled', // 'scheduled' or 'live'
    posts: [],
    livePosts: [],

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();

        try {
            // Load both in parallel (best effort)
            const [scheduled, live] = await Promise.all([
                API.getScheduledPosts().catch(() => []),
                API.getLivePosts().catch(() => [])
            ]);

            this.posts = scheduled;
            this.livePosts = live;

            this.renderLayout();
        } catch (err) {
            container.innerHTML = `<div class="empty-state"><i data-lucide="alert-circle"></i><h3>Error</h3><p>${err.message}</p></div>`;
            lucide.createIcons({ nodes: [container] });
        }
    },

    renderLayout() {
        const container = document.getElementById('page-container');
        
        container.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; flex-wrap:wrap; gap:16px;">
                <div style="display:flex; gap:4px; background:var(--bg-secondary); padding:4px; border-radius:var(--radius-md); border:1px solid var(--border-glass);">
                    <button class="btn btn-sm ${this.activeTab === 'scheduled' ? 'btn-primary' : 'btn-secondary'}" onclick="PostsPage.switchTab('scheduled')" style="box-shadow:none; border:none; border-radius:var(--radius-sm);">
                        <i data-lucide="calendar"></i> Scheduled Queue
                    </button>
                    <button class="btn btn-sm ${this.activeTab === 'live' ? 'btn-primary' : 'btn-secondary'}" onclick="PostsPage.switchTab('live')" style="box-shadow:none; border:none; border-radius:var(--radius-sm);">
                        <i data-lucide="instagram"></i> Live Published Feed
                    </button>
                </div>
                <div>
                    <button class="btn btn-primary btn-sm" onclick="PostsPage.showCreateModal()">
                        <i data-lucide="plus"></i> Schedule New Post
                    </button>
                </div>
            </div>

            <div id="posts-content-container">
                ${this.activeTab === 'scheduled' ? this.renderScheduledQueue() : this.renderLiveFeed()}
            </div>
        `;

        lucide.createIcons({ nodes: [container] });
    },

    switchTab(tab) {
        this.activeTab = tab;
        this.renderLayout();
    },

    renderScheduledQueue() {
        if (this.posts.length === 0) {
            return `
                <div class="empty-state glass-card" style="padding:48px 24px;">
                    <i data-lucide="calendar-days" style="width:48px;height:48px;color:var(--text-muted);margin-bottom:16px;"></i>
                    <h3>No Scheduled Posts</h3>
                    <p>Schedule your first post to run automatically on Instagram or Facebook.</p>
                    <button class="btn btn-primary btn-sm" style="margin-top:16px;" onclick="PostsPage.showCreateModal()">
                        <i data-lucide="plus"></i> Schedule New Post
                    </button>
                </div>
            `;
        }

        return `
            <div class="campaigns-grid">
                ${this.posts.map(post => {
                    const scheduledDate = new Date(post.scheduled_time);
                    const isPending = post.status === 'PENDING';
                    const isFailed = post.status === 'FAILED';
                    const isPublishing = post.status === 'PUBLISHING';
                    const isPublished = post.status === 'PUBLISHED';

                    let statusClass = 'pending';
                    if (isFailed) statusClass = 'failed';
                    if (isPublished) statusClass = 'sent';
                    if (isPublishing) statusClass = 'pending'; // amber style or pulsing

                    return `
                        <div class="campaign-card glass-card" data-id="${post.id}">
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
                                <div style="display:flex; gap:6px; align-items:center;">
                                    <span class="badge ${post.platform === 'instagram' ? 'badge-info-glow' : post.platform === 'facebook' ? 'badge-success-glow' : 'badge-warning-glow'}">
                                        <i data-lucide="${post.platform === 'instagram' ? 'instagram' : post.platform === 'facebook' ? 'facebook' : 'share-2'}" style="width:12px;height:12px;margin-right:4px;"></i>
                                        ${post.platform.toUpperCase()}
                                    </span>
                                    <span class="badge badge-info-glow" style="text-transform: capitalize;">
                                        ${post.post_type}
                                    </span>
                                </div>
                                <span class="status-pill ${statusClass}">
                                    ${isPublishing ? '<span class="dot-blink" style="background:var(--warning);"></span> PUBLISHING' : post.status}
                                </span>
                            </div>

                            ${post.media_url ? `
                                <div style="width:100%; height:160px; overflow:hidden; border-radius:var(--radius-md); background:var(--bg-secondary); margin-bottom:12px; display:flex; align-items:center; justify-content:center; border:1px solid var(--border-glass);">
                                    ${post.post_type === 'video' || post.post_type === 'reel' ? `
                                        <video src="${post.media_url}" style="width:100%; height:100%; object-fit:cover;" muted loop></video>
                                    ` : `
                                        <img src="${post.media_url}" style="width:100%; height:100%; object-fit:cover;">
                                    `}
                                </div>
                            ` : ''}

                            <div class="campaign-template" style="max-height:80px; margin-bottom:12px;">${this.escapeHtml(post.caption || '(No caption)')}</div>

                            <div style="font-size:12px; color:var(--text-secondary); margin-bottom:16px; display:flex; align-items:center; gap:6px;">
                                <i data-lucide="clock" style="width:12px;height:12px;"></i>
                                <span>Scheduled: ${scheduledDate.toLocaleString()}</span>
                            </div>

                            ${isFailed ? `
                                <div style="background:var(--danger-bg); border:1px solid rgba(239,68,68,0.2); border-radius:6px; padding:8px 12px; font-size:11px; color:var(--danger); margin-bottom:16px; word-break:break-word;">
                                    <strong>Error:</strong> ${this.escapeHtml(post.error_log || 'Unknown failure')}
                                </div>
                            ` : ''}

                            ${isPublished ? `
                                <div style="font-size:11px; color:var(--text-muted); margin-bottom:16px; word-break:break-all;">
                                    <strong>Post ID:</strong> ${post.published_post_id}
                                </div>
                            ` : ''}

                            <div class="campaign-actions">
                                ${isPending || isFailed ? `
                                    <button class="btn btn-primary btn-sm" onclick="PostsPage.publishNow('${post.id}')" ${isPublishing ? 'disabled' : ''}>
                                        <i data-lucide="send"></i> Publish Now
                                    </button>
                                    <button class="btn btn-secondary btn-sm" onclick="PostsPage.showEditModal('${post.id}')">
                                        <i data-lucide="pencil"></i> Edit
                                    </button>
                                    <button class="btn btn-danger btn-sm" onclick="PostsPage.deletePost('${post.id}')">
                                        <i data-lucide="trash-2"></i> Delete
                                    </button>
                                ` : `
                                    <button class="btn btn-secondary btn-sm btn-full" onclick="PostsPage.deletePost('${post.id}')" style="justify-content:center;">
                                        <i data-lucide="trash-2"></i> Delete Log
                                    </button>
                                `}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    },

    renderLiveFeed() {
        if (this.livePosts.length === 0) {
            return `
                <div class="empty-state glass-card" style="padding:48px 24px;">
                    <i data-lucide="alert-circle" style="width:48px;height:48px;color:var(--text-muted);margin-bottom:16px;"></i>
                    <h3>No Live Posts Found</h3>
                    <p>No active posts detected on your Facebook Page or Instagram Account.</p>
                </div>
            `;
        }

        return `
            <div class="campaigns-grid">
                ${this.livePosts.map(post => {
                    const postDate = new Date(post.timestamp);

                    return `
                        <div class="campaign-card glass-card">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                                <span class="badge ${post.platform === 'instagram' ? 'badge-info-glow' : 'badge-success-glow'}">
                                    <i data-lucide="${post.platform === 'instagram' ? 'instagram' : 'facebook'}" style="width:12px;height:12px;margin-right:4px;"></i>
                                    ${post.platform.toUpperCase()}
                                </span>
                                <span style="font-size:11px; color:var(--text-muted);">${postDate.toLocaleDateString()}</span>
                            </div>

                            ${post.media_url ? `
                                <div style="width:100%; height:160px; overflow:hidden; border-radius:var(--radius-md); background:var(--bg-secondary); margin-bottom:12px; display:flex; align-items:center; justify-content:center; border:1px solid var(--border-glass);">
                                    <img src="${post.media_url}" style="width:100%; height:100%; object-fit:cover;">
                                </div>
                            ` : ''}

                            <div class="campaign-template" style="max-height:80px; margin-bottom:12px;">${this.escapeHtml(post.caption || '(No text/caption)')}</div>

                            <div style="font-size:11px; color:var(--text-muted); margin-bottom:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                <strong>ID:</strong> ${post.id}
                            </div>

                            <div style="display:flex; gap:8px;">
                                ${post.permalink ? `
                                    <a href="${post.permalink}" target="_blank" class="btn btn-secondary btn-sm btn-full" style="justify-content:center;">
                                        <i data-lucide="external-link"></i> View on Live
                                    </a>
                                ` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    },

    showCreateModal() {
        const defaultTime = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16); // 1 hour from now

        UI.showModal(`
            <div class="modal-header">
                <h2 class="modal-title">Schedule New Post</h2>
                <button class="modal-close" onclick="UI.closeModal()"><i data-lucide="x"></i></button>
            </div>
            <form id="post-schedule-form" onsubmit="PostsPage.handleCreate(event)">
                <div class="form-group">
                    <label class="form-label">Platform</label>
                    <select class="form-input" name="platform" onchange="PostsPage.handlePlatformChange(this.value)" required>
                        <option value="instagram">Instagram Account</option>
                        <option value="facebook">Facebook Page</option>
                        <option value="both">Both (Facebook & Instagram)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Post Type</label>
                    <select class="form-input" name="post_type" id="post-type-select" required>
                        <option value="image">Single Image</option>
                        <option value="video">Standard Video</option>
                        <option value="reel">Instagram Reel</option>
                        <option value="story">Story</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Caption / Message</label>
                    <textarea class="form-textarea" name="caption" placeholder="Write your post caption..." required></textarea>
                </div>
                <div class="form-group" id="media-url-group">
                    <label class="form-label">Media URL</label>
                    <input class="form-input" name="media_url" placeholder="https://domain.com/path/to/media.jpg" required>
                    <p class="form-hint">Must be a direct, publicly accessible link to your image or video (e.g. S3, Imgur, Vercel Blob) so Meta servers can fetch it.</p>
                </div>
                <div class="form-group" id="schedule-time-group">
                    <label class="form-label">Scheduled Publish Time</label>
                    <input type="datetime-local" class="form-input" name="scheduled_time" value="${defaultTime}" required>
                </div>
                <div class="form-group" style="display:flex; align-items:center; gap:12px; margin-top:16px;">
                    <label class="toggle-switch" style="margin:0;">
                        <input type="checkbox" name="publish_now" onchange="PostsPage.toggleScheduleTime(this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="toggle-label" style="font-size:13px; color:var(--text-secondary);">Publish Immediately</span>
                </div>
                <div class="modal-actions" style="margin-top:24px;">
                    <button type="button" class="btn btn-secondary" onclick="UI.closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary" id="schedule-submit-btn"><i data-lucide="plus"></i> Schedule</button>
                </div>
            </form>
        `);

        lucide.createIcons({ nodes: [document.getElementById('modal-content')] });
    },

    async showEditModal(id) {
        const post = this.posts.find(p => p.id === id);
        if (!post) return;

        const defaultTime = new Date(post.scheduled_time).toISOString().slice(0, 16);

        UI.showModal(`
            <div class="modal-header">
                <h2 class="modal-title">Edit Scheduled Post</h2>
                <button class="modal-close" onclick="UI.closeModal()"><i data-lucide="x"></i></button>
            </div>
            <form id="post-schedule-form" onsubmit="PostsPage.handleEdit(event, '${id}')">
                <div class="form-group">
                    <label class="form-label">Platform</label>
                    <select class="form-input" name="platform" onchange="PostsPage.handlePlatformChange(this.value)" required>
                        <option value="instagram" ${post.platform === 'instagram' ? 'selected' : ''}>Instagram Account</option>
                        <option value="facebook" ${post.platform === 'facebook' ? 'selected' : ''}>Facebook Page</option>
                        <option value="both" ${post.platform === 'both' ? 'selected' : ''}>Both (Facebook & Instagram)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Post Type</label>
                    <select class="form-input" name="post_type" id="post-type-select" required>
                        <option value="image" ${post.post_type === 'image' ? 'selected' : ''}>Single Image</option>
                        <option value="video" ${post.post_type === 'video' ? 'selected' : ''}>Standard Video</option>
                        <option value="reel" ${post.post_type === 'reel' ? 'selected' : ''}>Instagram Reel</option>
                        <option value="story" ${post.post_type === 'story' ? 'selected' : ''}>Story</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Caption / Message</label>
                    <textarea class="form-textarea" name="caption" required>${this.escapeHtml(post.caption || '')}</textarea>
                </div>
                <div class="form-group" id="media-url-group">
                    <label class="form-label">Media URL</label>
                    <input class="form-input" name="media_url" value="${this.escapeHtml(post.media_url || '')}" placeholder="https://domain.com/path/to/media.jpg" ${post.platform !== 'facebook' ? 'required' : ''}>
                </div>
                <div class="form-group">
                    <label class="form-label">Scheduled Publish Time</label>
                    <input type="datetime-local" class="form-input" name="scheduled_time" value="${defaultTime}" required>
                </div>
                <div class="modal-actions" style="margin-top:24px;">
                    <button type="button" class="btn btn-secondary" onclick="UI.closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="check"></i> Save Changes</button>
                </div>
            </form>
        `);

        lucide.createIcons({ nodes: [document.getElementById('modal-content')] });
    },

    handlePlatformChange(val) {
        const typeSelect = document.getElementById('post-type-select');
        const mediaInput = document.getElementsByName('media_url')[0];

        // Adjust options
        if (val === 'facebook') {
            mediaInput.required = false; // Facebook supports text-only posts
            typeSelect.innerHTML = `
                <option value="image">Single Image</option>
                <option value="video">Standard Video</option>
                <option value="feed">Text/Link Post</option>
            `;
        } else {
            mediaInput.required = true;
            typeSelect.innerHTML = `
                <option value="image">Single Image</option>
                <option value="video">Standard Video</option>
                <option value="reel">Instagram Reel</option>
                <option value="story">Story</option>
            `;
        }
    },

    toggleScheduleTime(publishNow) {
        const timeGroup = document.getElementById('schedule-time-group');
        const timeInput = timeGroup.querySelector('input');
        const submitBtn = document.getElementById('schedule-submit-btn');

        if (publishNow) {
            timeGroup.style.opacity = '0.3';
            timeInput.required = false;
            timeInput.disabled = true;
            submitBtn.innerHTML = '<i data-lucide="send"></i> Publish Now';
        } else {
            timeGroup.style.opacity = '1';
            timeInput.required = true;
            timeInput.disabled = false;
            submitBtn.innerHTML = '<i data-lucide="plus"></i> Schedule';
        }
        lucide.createIcons({ nodes: [submitBtn] });
    },

    async handleCreate(e) {
        e.preventDefault();
        const form = new FormData(e.target);
        
        const publishNow = form.get('publish_now') === 'on';
        const data = {
            platform: form.get('platform'),
            post_type: form.get('post_type'),
            caption: form.get('caption'),
            media_url: form.get('media_url'),
            scheduled_time: publishNow ? new Date().toISOString() : new Date(form.get('scheduled_time')).toISOString(),
            publish_now: publishNow
        };

        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;margin:0;"></div>';

        try {
            await API.createScheduledPost(data);
            UI.toast(publishNow ? 'Post published successfully!' : 'Post scheduled successfully!');
            UI.closeModal();
            this.render();
        } catch (err) {
            UI.toast(err.message, 'error');
            btn.disabled = false;
            btn.innerHTML = publishNow ? 'Publish Now' : 'Schedule';
        }
    },

    async handleEdit(e, id) {
        e.preventDefault();
        const form = new FormData(e.target);
        const data = {
            platform: form.get('platform'),
            post_type: form.get('post_type'),
            caption: form.get('caption'),
            media_url: form.get('media_url') || null,
            scheduled_time: new Date(form.get('scheduled_time')).toISOString()
        };

        try {
            await API.updateScheduledPost(id, data);
            UI.toast('Scheduled post updated!');
            UI.closeModal();
            this.render();
        } catch (err) {
            UI.toast(err.message, 'error');
        }
    },

    async publishNow(id) {
        const card = document.querySelector(`.campaign-card[data-id="${id}"]`);
        const statusPill = card.querySelector('.status-pill');
        const actions = card.querySelector('.campaign-actions');

        statusPill.className = 'status-pill pending';
        statusPill.innerHTML = '<span class="dot-blink" style="background:var(--warning);"></span> PUBLISHING';
        actions.style.opacity = '0.3';
        actions.querySelectorAll('button').forEach(b => b.disabled = true);

        try {
            // Re-trigger via update target schedule to "now" and telling backend to publish_now
            const post = this.posts.find(p => p.id === id);
            await API.createScheduledPost({
                platform: post.platform,
                post_type: post.post_type,
                caption: post.caption,
                media_url: post.media_url,
                scheduled_time: new Date().toISOString(),
                publish_now: true
            });
            
            // Delete the old scheduled item
            await API.deleteScheduledPost(id);

            UI.toast('Post published successfully!');
            this.render();
        } catch (err) {
            UI.toast(err.message, 'error');
            this.render();
        }
    },

    async deletePost(id) {
        if (!confirm('Are you sure you want to delete this scheduled post?')) return;

        try {
            await API.deleteScheduledPost(id);
            UI.toast('Scheduled post deleted.');
            this.render();
        } catch (err) {
            UI.toast(err.message, 'error');
        }
    },

    escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
};
