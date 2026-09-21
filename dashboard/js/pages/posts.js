/**
 * Posts Scheduler Page — Create, schedule, and publish posts to Instagram & Facebook.
 */
const PostsPage = {
    activeTab: 'scheduled', // 'scheduled' or 'live'
    posts: [],
    livePosts: [],
    scheduledError: null,
    liveError: null,
    publishError: null,

    /**
     * Platform → allowed post types.
     *  - `reel` is deliberately absent: `video` maps to /videos on Facebook and
     *    to a REELS container on Instagram, so it covers both. See CLAUDE.md.
     *  - `story` is Instagram-only — Facebook page stories need the two-step
     *    /photo_stories + /video_stories upload the backend does not implement,
     *    so platform="both" cannot offer it either.
     *  - `feed` (text/link) is Facebook-only.
     */
    POST_TYPES: [
        { value: 'image', label: 'Single Image', platforms: ['instagram', 'facebook', 'both'] },
        { value: 'video', label: 'Video / Reel', platforms: ['instagram', 'facebook', 'both'] },
        { value: 'story', label: 'Story (Instagram only)', platforms: ['instagram'] },
        { value: 'feed', label: 'Text / Link Post (Facebook only)', platforms: ['facebook'] },
    ],

    SCHEDULE_HINT_AR: 'ملاحظة: النشر يتم عند تشغيل المُجدوِل التالي — مرة واحدة يومياً الساعة 00:00 بتوقيت UTC. الوقت المحدد هنا يحدد اليوم، وليس الدقيقة بالضبط.',
    UPLOAD_HINT_AR: 'الرفع ينشئ رابطاً عاماً تلقائياً. الحد الأقصى لحجم الملف 3.2 ميجابايت (حد Vercel للطلب 4.5 ميجابايت بعد ترميز base64).',

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader('Loading posts…');

        const [scheduled, live] = await Promise.allSettled([
            API.getScheduledPosts(),
            API.getLivePosts(),
        ]);

        // A failed fetch is an error, not an empty queue. Rendering the cheerful
        // "No Scheduled Posts" state for a 500 invited the creator to recreate
        // posts that already exist.
        if (scheduled.status === 'fulfilled') {
            this.posts = Array.isArray(scheduled.value) ? scheduled.value : [];
            this.scheduledError = null;
        } else {
            this.posts = [];
            this.scheduledError = scheduled.reason;
        }

        if (live.status === 'fulfilled') {
            this.livePosts = Array.isArray(live.value) ? live.value : [];
            this.liveError = null;
        } else {
            this.livePosts = [];
            this.liveError = live.reason;
        }

        this.renderLayout();
    },

    renderLayout() {
        const container = document.getElementById('page-container');

        container.innerHTML = esc(html`
            ${this.publishError ? this.renderPublishErrorPanel() : ''}
            <div class="posts-toolbar">
                <div class="tab-switch" role="tablist" aria-label="Posts view">
                    <button type="button" role="tab" aria-selected="${this.activeTab === 'scheduled' ? 'true' : 'false'}"
                            class="btn btn-sm ${this.activeTab === 'scheduled' ? 'btn-primary' : 'btn-secondary'} tab-switch-btn"
                            data-action="posts:switchTab" data-tab="scheduled">
                        <i data-lucide="calendar" aria-hidden="true"></i> Scheduled Queue
                    </button>
                    <button type="button" role="tab" aria-selected="${this.activeTab === 'live' ? 'true' : 'false'}"
                            class="btn btn-sm ${this.activeTab === 'live' ? 'btn-primary' : 'btn-secondary'} tab-switch-btn"
                            data-action="posts:switchTab" data-tab="live">
                        <i data-lucide="instagram" aria-hidden="true"></i> Live Published Feed
                    </button>
                </div>
                <div>
                    <button type="button" class="btn btn-primary btn-sm" data-action="posts:showCreateModal">
                        <i data-lucide="plus" aria-hidden="true"></i> Schedule New Post
                    </button>
                </div>
            </div>

            <div id="posts-content-container">
                ${this.activeTab === 'scheduled' ? this.renderScheduledQueue() : this.renderLiveFeed()}
            </div>
        `);

        UI.icons(container);

        // Error panels own their Retry wiring (no inline handlers).
        const errorHost = container.querySelector('[data-error-host]');
        if (errorHost) {
            UI.renderError(errorHost, JSON.parse(errorHost.dataset.errorOptions), () => this.render());
        }
    },

    renderPublishErrorPanel() {
        return html`
            <div class="publish-error-panel glass-card" role="alert">
                <div class="publish-error-head">
                    <i data-lucide="alert-triangle" aria-hidden="true"></i>
                    <h3>Publishing failed</h3>
                    <button type="button" class="modal-close" data-action="posts:dismissPublishError" aria-label="Dismiss publishing error">
                        <i data-lucide="x" aria-hidden="true"></i>
                    </button>
                </div>
                <p class="publish-error-message" dir="auto">${this.publishError.message}</p>
                <p class="publish-error-hint">
                    Nothing was deleted — the post is still in the queue with status FAILED. Fix the
                    media or caption and publish again.
                </p>
            </div>
        `;
    },

    switchTab(tab) {
        this.activeTab = tab;
        this.renderLayout();
    },

    errorHost(error, title) {
        // Rendered as an empty host div; renderLayout() fills it via UI.renderError
        // so the Retry button gets a real listener instead of an inline onclick.
        const options = JSON.stringify({
            title,
            message: (error && error.message) || 'Unknown error.',
            hint: error && error.status ? `HTTP ${error.status}` : '',
        });
        return html`<div data-error-host data-error-options="${options}"></div>`;
    },

    renderScheduledQueue() {
        if (this.scheduledError) {
            return this.errorHost(this.scheduledError, 'Could not load the scheduled queue');
        }

        if (this.posts.length === 0) {
            return html`
                <div class="empty-state glass-card" style="padding:48px 24px;">
                    <i data-lucide="calendar-days" aria-hidden="true"></i>
                    <h3>No Scheduled Posts</h3>
                    <p>Schedule your first post to run automatically on Instagram or Facebook.</p>
                    <button type="button" class="btn btn-primary btn-sm" style="margin-top:16px;" data-action="posts:showCreateModal">
                        <i data-lucide="plus" aria-hidden="true"></i> Schedule New Post
                    </button>
                </div>
            `;
        }

        return html`
            <div class="campaigns-grid">
                ${this.posts.map((post) => this.renderScheduledCard(post))}
            </div>
        `;
    },

    renderScheduledCard(post) {
        const isPending = post.status === 'PENDING';
        const isFailed = post.status === 'FAILED';
        const isPublishing = post.status === 'PUBLISHING';
        const isPublished = post.status === 'PUBLISHED';

        let statusClass = 'pending';
        if (isFailed) statusClass = 'failed';
        if (isPublished) statusClass = 'sent';

        const platform = String(post.platform || '');
        const platformBadge = platform === 'instagram'
            ? 'badge-info-glow'
            : platform === 'facebook' ? 'badge-success-glow' : 'badge-warning-glow';
        const platformIcon = platform === 'instagram'
            ? 'instagram'
            : platform === 'facebook' ? 'facebook' : 'share-2';

        const mediaUrl = safeUrl(post.media_url);
        const coverUrl = safeUrl(post.cover_url);
        const isVideo = post.post_type === 'video' || post.post_type === 'reel';

        return html`
            <div class="campaign-card glass-card" data-id="${post.id}">
                <div class="post-card-head">
                    <div class="post-card-badges">
                        <span class="badge ${platformBadge}">
                            <i data-lucide="${platformIcon}" style="width:12px;height:12px;margin-right:4px;" aria-hidden="true"></i>
                            ${platform.toUpperCase()}
                        </span>
                        <span class="badge badge-info-glow" style="text-transform: capitalize;">${post.post_type}</span>
                    </div>
                    <span class="status-pill ${statusClass}">
                        ${isPublishing ? html`<span class="dot-blink" style="background:var(--warning);" aria-hidden="true"></span> PUBLISHING` : post.status}
                    </span>
                </div>

                ${mediaUrl ? html`
                    <div class="post-media-frame">
                        ${isVideo
                            ? html`<video src="${mediaUrl}" poster="${coverUrl}" muted loop
                                          aria-label="Video attached to this scheduled post"></video>`
                            : html`<img src="${mediaUrl}" alt="Media attached to this scheduled post">`}
                    </div>
                ` : ''}

                ${coverUrl && isVideo ? html`
                    <div class="post-cover-row">
                        <img src="${coverUrl}" alt="Reel cover thumbnail">
                        <span>Cover image set</span>
                    </div>
                ` : ''}

                <div class="campaign-template" dir="auto">${post.caption || '(No caption)'}</div>

                <div class="post-card-meta">
                    <i data-lucide="clock" style="width:12px;height:12px;" aria-hidden="true"></i>
                    <span>Scheduled: ${UI.formatDateTime(post.scheduled_time)}</span>
                </div>

                ${isFailed ? html`
                    <div class="post-card-error" dir="auto">
                        <strong>Error:</strong> ${post.error_log || 'Unknown failure'}
                    </div>
                ` : ''}

                ${isPublished ? html`
                    <div class="post-card-published-id">
                        <strong>Post ID:</strong> ${post.published_post_id}
                    </div>
                ` : ''}

                <div class="campaign-actions">
                    ${isPending || isFailed ? html`
                        <button type="button" class="btn btn-primary btn-sm" data-action="posts:publishNow" data-id="${post.id}">
                            <i data-lucide="send" aria-hidden="true"></i> Publish Now
                        </button>
                        <button type="button" class="btn btn-secondary btn-sm" data-action="posts:showEditModal" data-id="${post.id}">
                            <i data-lucide="pencil" aria-hidden="true"></i> Edit
                        </button>
                        <button type="button" class="btn btn-danger btn-sm" data-action="posts:deletePost" data-id="${post.id}">
                            <i data-lucide="trash-2" aria-hidden="true"></i> Delete
                        </button>
                    ` : html`
                        <button type="button" class="btn btn-secondary btn-sm btn-full" data-action="posts:deletePost" data-id="${post.id}" style="justify-content:center;">
                            <i data-lucide="trash-2" aria-hidden="true"></i> Delete Log
                        </button>
                    `}
                </div>
            </div>
        `;
    },

    renderLiveFeed() {
        if (this.liveError) {
            return this.errorHost(this.liveError, 'Could not load the live feed');
        }

        if (this.livePosts.length === 0) {
            return html`
                <div class="empty-state glass-card" style="padding:48px 24px;">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    <h3>No Live Posts Found</h3>
                    <p>No active posts detected on your Facebook Page or Instagram Account.</p>
                </div>
            `;
        }

        return html`
            <div class="campaigns-grid">
                ${this.livePosts.map((post) => {
                    const mediaUrl = safeUrl(post.media_url);
                    const permalink = safeUrl(post.permalink);
                    return html`
                        <div class="campaign-card glass-card">
                            <div class="post-card-head">
                                <span class="badge ${post.platform === 'instagram' ? 'badge-info-glow' : 'badge-success-glow'}">
                                    <i data-lucide="${post.platform === 'instagram' ? 'instagram' : 'facebook'}" style="width:12px;height:12px;margin-right:4px;" aria-hidden="true"></i>
                                    ${String(post.platform || '').toUpperCase()}
                                </span>
                                <span class="post-card-date">${UI.formatDay(post.timestamp)}</span>
                            </div>

                            ${mediaUrl ? html`
                                <div class="post-media-frame">
                                    <img src="${mediaUrl}" alt="Thumbnail of the published post">
                                </div>
                            ` : ''}

                            <div class="campaign-template" dir="auto">${post.caption || '(No text/caption)'}</div>

                            <div class="post-card-published-id">
                                <strong>ID:</strong> ${post.id}
                            </div>

                            <div style="display:flex; gap:8px;">
                                ${permalink ? html`
                                    <a href="${permalink}" target="_blank" rel="noopener noreferrer"
                                       class="btn btn-secondary btn-sm btn-full" style="justify-content:center;">
                                        <i data-lucide="external-link" aria-hidden="true"></i> View on Live
                                    </a>
                                ` : ''}
                            </div>
                        </div>
                    `;
                })}
            </div>
        `;
    },

    // ─── Modal ───────────────────────────────────────────────────────────────
    typeOptions(platform, selected) {
        return this.POST_TYPES.map((type) => html`
            <option value="${type.value}"
                    ${selected === type.value ? html.raw('selected') : ''}
                    ${type.platforms.includes(platform) ? '' : html.raw('hidden disabled')}>${type.label}</option>
        `);
    },

    mediaFields(post) {
        const mediaUrl = safeUrl(post && post.media_url);
        const coverUrl = safeUrl(post && post.cover_url);
        const isVideo = post && (post.post_type === 'video' || post.post_type === 'reel');

        return html`
            <div class="form-group" id="media-url-group">
                <label class="form-label" for="post-media-file">Media File</label>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; gap:8px; align-items:center;">
                        <input type="file" id="post-media-file" class="form-input" style="flex:1;"
                               accept="image/*,video/*" data-change="posts:handleFileUpload" data-target="media">
                        <span style="font-size:12px; color:var(--text-muted);">or</span>
                    </div>
                    <label class="sr-only" for="post-media-url">Direct media URL</label>
                    <input class="form-input" id="post-media-url" name="media_url" value="${mediaUrl}"
                           placeholder="Paste direct image or video URL (https://...)" data-input="posts:handleUrlInput">
                </div>
                <div id="media-upload-progress" class="upload-progress" role="status" aria-live="polite">
                    <div class="spinner" style="width:12px;height:12px;border-width:2px;margin:0;"></div>
                    <span>Uploading and converting to public link...</span>
                </div>
                <div id="media-preview-container" class="media-preview" style="${mediaUrl ? html.raw('display:flex;') : html.raw('display:none;')}">
                    ${mediaUrl
                        ? (isVideo
                            ? html`<video src="${mediaUrl}" muted controls aria-label="Media preview"></video>`
                            : html`<img src="${mediaUrl}" alt="Media preview">`)
                        : ''}
                </div>
                <p class="form-hint" dir="auto">${this.UPLOAD_HINT_AR}</p>
            </div>

            <!-- Reel/video cover. Instagram otherwise thumbnails frame 0, which is a
                 black tile for any video that fades up from black. -->
            <div class="form-group" id="cover-url-group" style="${isVideo ? html.raw('') : html.raw('display:none;')}">
                <label class="form-label" for="post-cover-file">
                    Cover Image <span class="label-optional">(optional, recommended for video)</span>
                </label>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    <div style="display:flex; gap:8px; align-items:center;">
                        <input type="file" id="post-cover-file" class="form-input" style="flex:1;"
                               accept="image/*" data-change="posts:handleFileUpload" data-target="cover">
                        <span style="font-size:12px; color:var(--text-muted);">or</span>
                    </div>
                    <label class="sr-only" for="post-cover-url">Direct cover image URL</label>
                    <input class="form-input" id="post-cover-url" name="cover_url" value="${coverUrl}"
                           placeholder="Paste a cover image URL (https://...)">
                </div>
                <div id="cover-upload-progress" class="upload-progress" role="status" aria-live="polite">
                    <div class="spinner" style="width:12px;height:12px;border-width:2px;margin:0;"></div>
                    <span>Uploading cover image...</span>
                </div>
                <p class="form-hint" dir="auto">بدون صورة غلاف، إنستجرام يستخدم أول لقطة من الفيديو (غالباً سوداء) كصورة مصغّرة في البروفايل.</p>
            </div>
        `;
    },

    showCreateModal() {
        // datetime-local shows and submits LOCAL wall time. toISOString() is UTC,
        // so the old prefill was off by the whole UTC offset (UTC+3: two hours in
        // the past for a "1 hour from now" default).
        const defaultTime = UI.toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000));

        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">Schedule New Post</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="Close dialog">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <div id="post-form-error"></div>
            <form id="post-schedule-form" data-submit="posts:handleCreate">
                <div class="form-group">
                    <label class="form-label" for="post-platform-select">Platform</label>
                    <select class="form-input" id="post-platform-select" name="platform" data-change="posts:handlePlatformChange" required>
                        <option value="instagram">Instagram Account</option>
                        <option value="facebook">Facebook Page</option>
                        <option value="both">Both (Facebook &amp; Instagram)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="post-type-select">Post Type</label>
                    <select class="form-input" name="post_type" id="post-type-select" data-change="posts:handleTypeChange" required>
                        ${this.typeOptions('instagram', 'image')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="post-caption">Caption / Message</label>
                    <textarea class="form-textarea arabic-text" id="post-caption" name="caption" dir="auto"
                              placeholder="Write your post caption..." required></textarea>
                </div>
                ${this.mediaFields(null)}
                <div class="form-group" id="schedule-time-group">
                    <label class="form-label" for="post-scheduled-time">Scheduled Publish Time</label>
                    <input type="datetime-local" class="form-input" id="post-scheduled-time" name="scheduled_time" value="${defaultTime}" required>
                    <p class="form-hint" dir="auto">${this.SCHEDULE_HINT_AR}</p>
                </div>
                <div class="form-group form-toggle-inline">
                    <label class="toggle-switch" style="margin:0;">
                        <input type="checkbox" name="publish_now" id="post-publish-now" data-change="posts:toggleScheduleTime">
                        <span class="toggle-slider"></span>
                    </label>
                    <label class="toggle-label" for="post-publish-now" style="font-size:13px; color:var(--text-secondary);">Publish Immediately</label>
                </div>
                <div class="modal-actions" style="margin-top:24px;">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">Cancel</button>
                    <button type="submit" class="btn btn-primary" id="schedule-submit-btn">
                        <i data-lucide="plus" aria-hidden="true"></i> Schedule
                    </button>
                </div>
            </form>
        `);

        // Apply the platform/type matrix on open — it used to run only on change,
        // so a Facebook post could show Instagram-only types until you touched it.
        this.applyPlatformMatrix();
    },

    showEditModal(id) {
        const post = this.posts.find((p) => p.id === id);
        if (!post) return;

        const defaultTime = UI.toLocalInputValue(post.scheduled_time);
        // 'reel' is no longer offered; map legacy rows onto 'video', which
        // publishes identically to both platforms.
        const postType = post.post_type === 'reel' ? 'video' : post.post_type;
        const platform = post.platform;

        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">Edit Scheduled Post</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="Close dialog">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <div id="post-form-error"></div>
            <form id="post-schedule-form" data-submit="posts:handleEdit" data-id="${post.id}">
                <div class="form-group">
                    <label class="form-label" for="post-platform-select">Platform</label>
                    <select class="form-input" id="post-platform-select" name="platform" data-change="posts:handlePlatformChange" required>
                        <option value="instagram" ${platform === 'instagram' ? html.raw('selected') : ''}>Instagram Account</option>
                        <option value="facebook" ${platform === 'facebook' ? html.raw('selected') : ''}>Facebook Page</option>
                        <option value="both" ${platform === 'both' ? html.raw('selected') : ''}>Both (Facebook &amp; Instagram)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="post-type-select">Post Type</label>
                    <select class="form-input" name="post_type" id="post-type-select" data-change="posts:handleTypeChange" required>
                        ${this.typeOptions(platform, postType)}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="post-caption">Caption / Message</label>
                    <textarea class="form-textarea arabic-text" id="post-caption" name="caption" dir="auto" required>${post.caption || ''}</textarea>
                </div>
                ${this.mediaFields({ ...post, post_type: postType })}
                <div class="form-group">
                    <label class="form-label" for="post-scheduled-time">Scheduled Publish Time</label>
                    <input type="datetime-local" class="form-input" id="post-scheduled-time" name="scheduled_time" value="${defaultTime}" required>
                    <p class="form-hint" dir="auto">${this.SCHEDULE_HINT_AR}</p>
                </div>
                <div class="modal-actions" style="margin-top:24px;">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">Cancel</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="check" aria-hidden="true"></i> Save Changes</button>
                </div>
            </form>
        `);

        this.applyPlatformMatrix();
    },

    /**
     * Show/hide post types for the selected platform WITHOUT rebuilding the
     * select. Rebuilding innerHTML reset the chosen type to "Single Image" on
     * every platform change — including in the Edit modal, where it silently
     * discarded the saved value.
     */
    applyPlatformMatrix() {
        const platformSelect = document.getElementById('post-platform-select');
        const typeSelect = document.getElementById('post-type-select');
        if (!platformSelect || !typeSelect) return;

        const platform = platformSelect.value;
        const allowed = new Set(
            this.POST_TYPES.filter((t) => t.platforms.includes(platform)).map((t) => t.value)
        );

        Array.from(typeSelect.options).forEach((option) => {
            const ok = allowed.has(option.value);
            option.hidden = !ok;
            option.disabled = !ok;
        });

        // Only fall back when the current selection is genuinely unavailable.
        if (!allowed.has(typeSelect.value)) {
            typeSelect.value = allowed.has('image') ? 'image' : Array.from(allowed)[0];
        }

        // Facebook alone supports text-only feed posts.
        const mediaInput = document.getElementById('post-media-url');
        if (mediaInput) mediaInput.required = !(platform === 'facebook' && typeSelect.value === 'feed');

        this.applyTypeMatrix();
    },

    /** The cover field only makes sense for video. */
    applyTypeMatrix() {
        const typeSelect = document.getElementById('post-type-select');
        const coverGroup = document.getElementById('cover-url-group');
        if (!typeSelect || !coverGroup) return;
        coverGroup.style.display = typeSelect.value === 'video' ? '' : 'none';
    },

    toggleScheduleTime(publishNow) {
        const timeGroup = document.getElementById('schedule-time-group');
        const timeInput = document.getElementById('post-scheduled-time');
        const submitBtn = document.getElementById('schedule-submit-btn');
        if (!timeGroup || !timeInput || !submitBtn) return;

        timeGroup.style.opacity = publishNow ? '0.35' : '1';
        timeInput.required = !publishNow;
        timeInput.disabled = publishNow;
        submitBtn.innerHTML = publishNow
            ? '<i data-lucide="send"></i> Publish Now'
            : '<i data-lucide="plus"></i> Schedule';
        UI.icons(submitBtn);
    },

    // ─── Submit handlers ─────────────────────────────────────────────────────
    formPayload(form) {
        const data = new FormData(form);
        const coverUrl = (data.get('cover_url') || '').toString().trim();
        const postType = data.get('post_type');
        return {
            platform: data.get('platform'),
            post_type: postType,
            caption: data.get('caption'),
            media_url: (data.get('media_url') || '').toString().trim() || null,
            cover_url: postType === 'video' && coverUrl ? coverUrl : null,
        };
    },

    /**
     * The publish endpoint answers 201 on success and 502 with
     * `{ status: 'FAILED', error }` when Meta rejected the post. Older
     * deployments answered 201 with `status: 'FAILED'` in the body, so both
     * shapes are treated as a failure here.
     */
    publishFailure(result, err) {
        if (err) {
            const fromBody = err.body && (err.body.error || err.body.error_log);
            return fromBody || err.message || 'Unknown publishing error.';
        }
        if (result && result.status === 'FAILED') {
            return result.error || result.error_log || 'Meta rejected the post.';
        }
        return null;
    },

    showFormError(message) {
        const host = document.getElementById('post-form-error');
        if (!host) return;
        host.innerHTML = esc(UI.errorStrip(message, 'The post stays in the queue with status FAILED — nothing was deleted.'));
        UI.icons(host);
        host.scrollIntoView({ block: 'nearest' });
    },

    async handleCreate(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const publishNow = data.get('publish_now') === 'on';
        const scheduledRaw = data.get('scheduled_time');

        const payload = {
            ...this.formPayload(form),
            scheduled_time: publishNow
                ? new Date().toISOString()
                : UI.fromLocalInputValue(scheduledRaw),
            publish_now: publishNow,
        };

        if (!payload.scheduled_time) {
            this.showFormError('That scheduled time could not be read. Pick a date and time again.');
            return;
        }

        const btn = form.querySelector('button[type="submit"]');
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;margin:0;"></div>';

        try {
            const result = await API.createScheduledPost(payload);
            const failure = publishNow ? this.publishFailure(result, null) : null;

            if (failure) {
                // "Published successfully!" on a failed publish was the single most
                // misleading message in this UI. Keep the modal open, show the real error.
                this.publishError = { message: failure };
                this.showFormError(failure);
                btn.disabled = false;
                btn.innerHTML = originalHtml;
                await this.render();
                return;
            }

            UI.toast(publishNow ? 'Post published successfully.' : 'Post scheduled successfully.');
            UI.closeModal();
            await this.render();
        } catch (err) {
            const failure = this.publishFailure(null, err);
            if (publishNow) this.publishError = { message: failure };
            this.showFormError(failure);
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            if (publishNow) await this.render();
        }
    },

    async handleEdit(form, event) {
        event.preventDefault();
        const id = form.dataset.id;
        const data = new FormData(form);
        const scheduledTime = UI.fromLocalInputValue(data.get('scheduled_time'));

        if (!scheduledTime) {
            this.showFormError('That scheduled time could not be read. Pick a date and time again.');
            return;
        }

        const payload = { ...this.formPayload(form), scheduled_time: scheduledTime };

        try {
            await API.updateScheduledPost(id, payload);
            UI.toast('Scheduled post updated.');
            UI.closeModal();
            await this.render();
        } catch (err) {
            this.showFormError(err.message);
        }
    },

    /**
     * Republish an existing row immediately. The original is deleted ONLY after
     * the new one actually published — deleting unconditionally used to destroy
     * the creator's schedule row on every failed publish.
     */
    async publishNow(id) {
        const post = this.posts.find((p) => p.id === id);
        if (!post) return;

        const card = document.querySelector(`.campaign-card[data-id="${CSS.escape(id)}"]`);
        if (card) {
            const statusPill = card.querySelector('.status-pill');
            const actions = card.querySelector('.campaign-actions');
            if (statusPill) {
                statusPill.className = 'status-pill pending';
                statusPill.innerHTML = '<span class="dot-blink" style="background:var(--warning);"></span> PUBLISHING';
            }
            if (actions) {
                actions.style.opacity = '0.3';
                actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
            }
        }

        this.publishError = null;

        try {
            const result = await API.createScheduledPost({
                platform: post.platform,
                // Legacy 'reel' rows publish as 'video' — identical on both platforms.
                post_type: post.post_type === 'reel' ? 'video' : post.post_type,
                caption: post.caption,
                media_url: post.media_url,
                cover_url: post.cover_url || null, // was dropped on republish
                scheduled_time: new Date().toISOString(),
                publish_now: true,
            });

            const failure = this.publishFailure(result, null);
            if (failure) {
                this.publishError = { message: failure };
                UI.toast('Publishing failed — see the details at the top of the page.', 'error');
                await this.render();
                return;
            }

            // Only now is it safe to remove the original queue entry.
            try {
                await API.deleteScheduledPost(id);
            } catch (cleanupErr) {
                console.warn('Published, but the original queue row could not be removed:', cleanupErr);
                UI.toast('Published. The original queue entry could not be removed — delete it manually.', 'error');
                await this.render();
                return;
            }

            UI.toast('Post published successfully.');
            await this.render();
        } catch (err) {
            this.publishError = { message: this.publishFailure(null, err) };
            UI.toast('Publishing failed — see the details at the top of the page.', 'error');
            await this.render();
        }
    },

    async deletePost(id) {
        if (!confirm('Are you sure you want to delete this scheduled post?')) return;

        try {
            await API.deleteScheduledPost(id);
            UI.toast('Scheduled post deleted.');
            await this.render();
        } catch (err) {
            UI.toast(err.message, 'error');
        }
    },

    // ─── Uploads ─────────────────────────────────────────────────────────────
    async handleFileUpload(input) {
        const target = input.dataset.target === 'cover' ? 'cover' : 'media';
        const file = input.files && input.files[0];
        if (!file) return;

        const progress = document.getElementById(target === 'cover' ? 'cover-upload-progress' : 'media-upload-progress');
        const preview = document.getElementById('media-preview-container');
        const urlInput = document.getElementById(target === 'cover' ? 'post-cover-url' : 'post-media-url');

        // Vercel caps the request body at 4.5MB and /api/upload takes base64 JSON,
        // so the real ceiling is ~3.2MB of file — not the 10MB this used to claim.
        if (file.size > API.MAX_UPLOAD_BYTES) {
            const mb = (file.size / (1024 * 1024)).toFixed(1);
            UI.toast(`حجم الملف ${mb} ميجابايت — الحد الأقصى 3.2 ميجابايت. اضغط الملف أو ارفعه مباشرة إلى قاعدة البيانات.`, 'error');
            input.value = '';
            return;
        }

        if (progress) progress.style.display = 'flex';
        if (target === 'media' && preview) preview.style.display = 'none';

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const res = await API.uploadMedia({
                    filename: file.name,
                    mime_type: file.type,
                    base64_data: e.target.result,
                });

                if (urlInput) urlInput.value = res.url;
                if (progress) progress.style.display = 'none';

                if (target === 'media') this.showMediaPreview(res.url, file.type.startsWith('video/'));
                UI.toast('Media uploaded and ready.');
            } catch (err) {
                UI.toast(`Upload failed: ${err.message}`, 'error');
                if (progress) progress.style.display = 'none';
                input.value = '';
            }
        };
        reader.onerror = () => {
            UI.toast('Failed to read that file.', 'error');
            if (progress) progress.style.display = 'none';
        };
        reader.readAsDataURL(file);
    },

    showMediaPreview(url, isVideo) {
        const preview = document.getElementById('media-preview-container');
        if (!preview) return;
        const clean = safeUrl(url);
        if (!clean) {
            preview.style.display = 'none';
            preview.innerHTML = '';
            return;
        }
        preview.style.display = 'flex';
        preview.innerHTML = esc(isVideo
            ? html`<video src="${clean}" muted controls aria-label="Media preview"></video>`
            : html`<img src="${clean}" alt="Media preview">`);
    },

    handleUrlInput(input) {
        const value = input.value;
        if (!value) {
            const preview = document.getElementById('media-preview-container');
            if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
            return;
        }
        this.showMediaPreview(value, /\.(mp4|mov|avi|wmv|m4v|webm)(\?|$)/i.test(value));
    },
};

UI.registerActions('posts', {
    switchTab: (el) => PostsPage.switchTab(el.dataset.tab),
    showCreateModal: () => PostsPage.showCreateModal(),
    showEditModal: (el) => PostsPage.showEditModal(el.dataset.id),
    publishNow: (el) => PostsPage.publishNow(el.dataset.id),
    deletePost: (el) => PostsPage.deletePost(el.dataset.id),
    dismissPublishError: () => { PostsPage.publishError = null; PostsPage.renderLayout(); },
    handlePlatformChange: () => PostsPage.applyPlatformMatrix(),
    handleTypeChange: () => PostsPage.applyTypeMatrix(),
    toggleScheduleTime: (el) => PostsPage.toggleScheduleTime(el.checked),
    handleCreate: (el, e) => PostsPage.handleCreate(el, e),
    handleEdit: (el, e) => PostsPage.handleEdit(el, e),
    handleFileUpload: (el) => PostsPage.handleFileUpload(el),
    handleUrlInput: (el) => PostsPage.handleUrlInput(el),
});
