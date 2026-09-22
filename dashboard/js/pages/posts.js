/**
 * Posts Scheduler — create, schedule and publish to Instagram & Facebook.
 *
 * ─── Two honesty problems this screen had ───────────────────────────────────
 *
 * 1. THE MINUTE IS A LIE. `vercel.json` runs the publish cron once a day at
 *    00:00 UTC (a Hobby-plan limit), so a `datetime-local` field that accepts
 *    14:35 is promising something the backend cannot deliver. The field stays
 *    — the API takes a full ISO timestamp and the date genuinely matters — but
 *    next to it the form now computes and shows the instant the post will
 *    ACTUALLY go out, live, as the operator picks a time.
 *
 * 2. THE THUMBNAIL WAS A FOOTNOTE. `cover_url` is supported end to end, and
 *    without it Instagram thumbnails a reel from frame 0 — a black tile for
 *    any video that fades up from black, which is the entire reason the field
 *    exists. It is now a titled step with a side-by-side preview of the two
 *    tiles: the frame the platform would pick, and the cover chosen instead.
 */
const PostsPage = {
    activeTab: 'scheduled', // 'scheduled' or 'live'
    posts: [],
    livePosts: [],
    scheduledError: null,
    liveError: null,
    publishError: null,

    /**
     * Guards the write against landing after the operator has navigated away.
     * This page settles two requests and then writes the whole container;
     * `#page-container` is refilled rather than replaced, so a late
     * `renderLayout()` painted the queue into whatever page had replaced this
     * one. Same `_seq`/`live()` shape as OverviewPage.
     */
    _seq: 0,

    destroy() {
        this._seq++;
    },

    /** Tenant switch: queue, live grid and error panels are all tenant-scoped. */
    resetTenantState() {
        this.posts = [];
        this.livePosts = [];
        this.scheduledError = null;
        this.liveError = null;
        this.publishError = null;
    },

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
        { value: 'image', labelKey: 'posts.type.image', platforms: ['instagram', 'facebook', 'both'] },
        { value: 'video', labelKey: 'posts.type.video', platforms: ['instagram', 'facebook', 'both'] },
        { value: 'story', labelKey: 'posts.type.story', platforms: ['instagram'] },
        { value: 'feed', labelKey: 'posts.type.feed', platforms: ['facebook'] },
    ],

    skeleton() {
        return html`
            ${Motion.toolbar()}
            ${Motion.cardGrid(3, 4)}
            ${Motion.busy()}
        `;
    },

    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;

        const seq = ++this._seq;
        const alive = () => seq === this._seq && !!document.getElementById('page-container');

        // Already up on a navigation; scheduled behind a 150ms gate on an
        // in-place refresh, so a fast response never flashes a skeleton.
        const gate = Motion.beginLoad(container, () => this.skeleton());

        const [scheduled, live] = await Promise.allSettled([
            API.getScheduledPosts(),
            API.getLivePosts(),
        ]);
        if (!alive()) return;
        gate.done();

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
        Motion.announce(this.activeTab === 'scheduled'
            ? `${t('posts.tabQueue')} — ${UI.formatNumber(this.posts.length)}`
            : `${t('posts.tabLive')} — ${UI.formatNumber(this.livePosts.length)}`);
    },

    renderLayout() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const focus = UI.captureFocus(container);

        container.innerHTML = esc(html`
            ${this.publishError ? this.renderPublishErrorPanel() : ''}
            <div class="page-toolbar">
                <!-- This declared role="tablist" + role="tab" + aria-selected
                     with no role="tabpanel", no aria-controls and no arrow-key
                     handling, so it promised a widget it did not implement: a
                     screen-reader user was told "tab, 1 of 2" and then arrow
                     keys did nothing. Two segmented BUTTONS with aria-pressed
                     is what this control actually is. -->
                <div class="segmented" role="group" aria-label="${t('nav.posts')}">
                    <button type="button" id="posts-tab-scheduled"
                            aria-pressed="${this.activeTab === 'scheduled' ? 'true' : 'false'}"
                            class="btn btn-sm ${this.activeTab === 'scheduled' ? 'btn-primary' : 'btn-ghost'}"
                            data-action="posts:switchTab" data-tab="scheduled">
                        <i data-lucide="calendar" aria-hidden="true"></i> ${t('posts.tabQueue')}
                    </button>
                    <button type="button" id="posts-tab-live"
                            aria-pressed="${this.activeTab === 'live' ? 'true' : 'false'}"
                            class="btn btn-sm ${this.activeTab === 'live' ? 'btn-primary' : 'btn-ghost'}"
                            data-action="posts:switchTab" data-tab="live">
                        <i data-lucide="instagram" aria-hidden="true"></i> ${t('posts.tabLive')}
                    </button>
                </div>
                <div class="toolbar-actions">
                    <button type="button" class="btn btn-primary btn-sm" id="posts-new"
                            data-action="posts:showCreateModal">
                        <i data-lucide="plus" aria-hidden="true"></i> ${t('posts.new')}
                    </button>
                </div>
            </div>

            <div id="posts-content-container">
                <!-- The only structure below the page <h1> on this screen. -->
                <h2 class="sr-only">${this.activeTab === 'scheduled' ? t('posts.tabQueue') : t('posts.tabLive')}</h2>
                ${this.activeTab === 'scheduled' ? this.renderScheduledQueue() : this.renderLiveFeed()}
            </div>
        `);

        UI.icons(container);
        UI.revealClipped(container);
        // Switching tabs used to throw the operator out of the control they
        // were using, because the whole toolbar is rebuilt with the content.
        UI.restoreFocus(focus);

        // Error panels own their Retry wiring (no inline handlers).
        const errorHost = container.querySelector('[data-error-host]');
        if (errorHost) {
            UI.renderError(errorHost, JSON.parse(errorHost.dataset.errorOptions), () => this.render());
        }
    },

    renderPublishErrorPanel() {
        return html`
            <div class="publish-error-panel" role="alert">
                <div class="publish-error-head">
                    <i data-lucide="alert-triangle" aria-hidden="true"></i>
                    <h3>${t('posts.publishFailedTitle')}</h3>
                    <button type="button" class="modal-close" data-action="posts:dismissPublishError"
                            aria-label="${t('posts.dismissError')}">
                        <i data-lucide="x" aria-hidden="true"></i>
                    </button>
                </div>
                <p class="publish-error-message" dir="auto">${this.publishError.message}</p>
                <p class="publish-error-hint">${t('posts.publishFailedHint')}</p>
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
            message: (error && error.message) || t('error.unexpected'),
            hint: error && error.status ? `HTTP ${error.status}` : '',
        });
        return html`<div data-error-host data-error-options="${options}"></div>`;
    },

    renderScheduledQueue() {
        if (this.scheduledError) {
            return this.errorHost(this.scheduledError, t('posts.queueErrorTitle'));
        }

        if (this.posts.length === 0) {
            return html`
                <div class="surface pad-5 stack gap-3">
                    ${Admin.emptyState('calendar-days', t('posts.emptyQueueTitle'), t('posts.emptyQueueBody'))}
                    <div class="row row--center">
                        <button type="button" class="btn btn-primary btn-sm" data-action="posts:showCreateModal">
                            <i data-lucide="plus" aria-hidden="true"></i> ${t('posts.new')}
                        </button>
                    </div>
                </div>
            `;
        }

        return html`<div class="card-grid">${this.posts.map((post) => this.renderScheduledCard(post))}</div>`;
    },

    platformBadge(platform) {
        const value = String(platform || '');
        if (value === 'instagram') return { cls: 'badge-instagram', icon: 'instagram', label: t('common.instagram') };
        if (value === 'facebook') return { cls: 'badge-facebook', icon: 'facebook', label: t('common.facebook') };
        return { cls: 'badge-neutral', icon: 'share-2', label: t('common.both') };
    },

    renderScheduledCard(post) {
        const isPending = post.status === 'PENDING';
        const isFailed = post.status === 'FAILED';
        const isPublishing = post.status === 'PUBLISHING';
        const isPublished = post.status === 'PUBLISHED';

        let statusClass = 'pending';
        if (isFailed) statusClass = 'failed';
        if (isPublished) statusClass = 'sent';

        const badge = this.platformBadge(post.platform);
        const mediaUrl = safeUrl(post.media_url);
        const coverUrl = safeUrl(post.cover_url);
        const isVideo = post.post_type === 'video' || post.post_type === 'reel';
        const typeLabel = this.typeLabel(post.post_type);

        return html`
            <!-- An <article> with no accessible name is announced as "article".
                 Named from the three facts that tell two queued posts apart:
                 where it goes, what it is, and when. All three are UI copy, so
                 the name is in whichever language the interface is in. -->
            <article class="post-card surface" data-id="${post.id}"
                     aria-label="${badge.label} · ${typeLabel} · ${t('posts.scheduledAt', { when: UI.formatDateTime(post.scheduled_time) })}">
                <div class="post-card-head">
                    <div class="post-card-badges">
                        <span class="badge ${html.raw(badge.cls)}">
                            <i data-lucide="${badge.icon}" aria-hidden="true"></i> ${badge.label}
                        </span>
                        <span class="badge badge-neutral">${typeLabel}</span>
                    </div>
                    <span class="status-pill ${html.raw(statusClass)}">
                        ${isPublishing
                            ? html`<span class="dot-blink" aria-hidden="true"></span> ${t('posts.statusPublishing')}`
                            : UI.statusLabel(post.status)}
                    </span>
                </div>

                ${mediaUrl ? html`
                    <div class="post-media-frame">
                        ${isVideo
                            ? html`<video src="${mediaUrl}" poster="${coverUrl}" muted controls
                                          aria-label="${t('posts.mediaPreview')}"></video>`
                            : html`<img src="${mediaUrl}" alt="${t('posts.mediaPreview')}">`}
                    </div>
                ` : ''}

                ${isVideo ? html`
                    <p class="post-card-meta">
                        <i data-lucide="${coverUrl ? 'image-plus' : 'alert-triangle'}" aria-hidden="true"></i>
                        <span class="${coverUrl ? html.raw('text-success') : html.raw('text-warning')}">
                            ${coverUrl ? t('posts.cover.set') : t('posts.cover.missingBadge')}
                        </span>
                    </p>
                ` : ''}

                <!-- The caption is clipped at 7.5em with no way to read the
                     rest. lang="ar" only when there IS a caption: the
                     "no caption" placeholder is UI copy. -->
                ${post.caption
                    ? UI.previewBlock(post.caption, { label: t('posts.caption'), arabic: true })
                    : html`<div class="template-preview user-content">${t('posts.noCaption')}</div>`}

                <p class="post-card-meta">
                    <i data-lucide="clock" aria-hidden="true"></i>
                    <span>${t('posts.scheduledAt', { when: UI.formatDateTime(post.scheduled_time) })}</span>
                </p>
                ${isPending ? html`
                    <p class="post-card-meta">
                        <i data-lucide="calendar-clock" aria-hidden="true"></i>
                        <span>${t('posts.schedule.actual', {
                            when: UI.formatDateTime(UI.nextCronRun(
                                new Date(post.scheduled_time) > new Date() ? post.scheduled_time : new Date()
                            )),
                        })}</span>
                    </p>
                ` : ''}

                ${isFailed ? html`
                    <p class="post-card-error" dir="auto">
                        <strong>${t('posts.errorLabel')}</strong> ${post.error_log || t('error.unexpected')}
                    </p>
                ` : ''}

                ${isPublished ? html`
                    <p class="post-card-id"><strong>${t('posts.publishedIdLabel')}</strong> ${UI.ltr(post.published_post_id)}</p>
                ` : ''}

                <div class="card-actions">
                    ${isPending || isFailed ? html`
                        <!-- Stable keys across the re-render, so closeModal()
                             can put focus back on this card's own button. -->
                        <button type="button" class="btn btn-primary btn-sm" data-action="posts:publishNow"
                                data-id="${post.id}" data-focus-key="post-publish-${post.id}">
                            <i data-lucide="send" aria-hidden="true"></i> ${t('posts.publishNow')}
                        </button>
                        <button type="button" class="btn btn-secondary btn-sm" data-action="posts:showEditModal"
                                data-id="${post.id}" data-focus-key="post-edit-${post.id}">
                            <i data-lucide="pencil" aria-hidden="true"></i> ${t('common.edit')}
                        </button>
                        <button type="button" class="btn btn-danger btn-sm" data-action="posts:deletePost"
                                data-id="${post.id}" data-focus-key="post-delete-${post.id}">
                            <i data-lucide="trash-2" aria-hidden="true"></i> ${t('common.delete')}
                        </button>
                    ` : html`
                        <button type="button" class="btn btn-secondary btn-sm btn-full" data-action="posts:deletePost" data-id="${post.id}">
                            <i data-lucide="trash-2" aria-hidden="true"></i> ${t('posts.deleteLog')}
                        </button>
                    `}
                </div>
            </article>
        `;
    },

    typeLabel(value) {
        const type = this.POST_TYPES.find((x) => x.value === (value === 'reel' ? 'video' : value));
        return type ? t(type.labelKey) : String(value || '');
    },

    renderLiveFeed() {
        if (this.liveError) {
            return this.errorHost(this.liveError, t('posts.liveErrorTitle'));
        }

        if (this.livePosts.length === 0) {
            /**
             * GET /posts/live swallows Meta's errors into `[]` server-side, so
             * an expired access token and an account with nothing published
             * arrive here as exactly the same response. The old copy ("No posts
             * detected on your Facebook Page or Instagram account") stated the
             * second as fact, which is the one reading the operator must not
             * act on — they would go looking for a publishing bug that is
             * really a credential.
             *
             * The server cannot be fixed from here, so this stops presenting an
             * empty array as certainty and points at the one screen that can
             * answer it.
             */
            return html`
                <div class="surface pad-5 stack gap-3">
                    ${Admin.emptyState('alert-circle', t('posts.emptyLiveTitle'), t('posts.liveEmptyCaveat'))}
                    <div class="row row--center">
                        <button type="button" class="btn btn-secondary btn-sm"
                                data-action="app:navigate" data-target="settings">
                            <i data-lucide="key-round" aria-hidden="true"></i> ${t('overview.openSettings')}
                        </button>
                    </div>
                </div>
            `;
        }

        return html`
            <div class="card-grid">
                ${this.livePosts.map((post) => {
                    const mediaUrl = safeUrl(post.media_url);
                    const permalink = safeUrl(post.permalink);
                    const badge = this.platformBadge(post.platform);
                    return html`
                        <article class="post-card surface"
                                 aria-label="${badge.label} · ${UI.formatDay(post.timestamp)}">
                            <div class="post-card-head">
                                <span class="badge ${html.raw(badge.cls)}">
                                    <i data-lucide="${badge.icon}" aria-hidden="true"></i> ${badge.label}
                                </span>
                                <span class="text-meta">${UI.formatDay(post.timestamp)}</span>
                            </div>

                            ${mediaUrl ? html`
                                <div class="post-media-frame">
                                    <img src="${mediaUrl}" alt="${t('posts.mediaPreview')}">
                                </div>
                            ` : ''}

                            ${post.caption
                                ? UI.previewBlock(post.caption, { label: t('posts.caption'), arabic: true })
                                : html`<div class="template-preview user-content">${t('posts.noCaption')}</div>`}
                            <p class="post-card-id">${UI.ltr(post.id)}</p>

                            ${permalink ? html`
                                <div class="card-actions">
                                    <a href="${permalink}" target="_blank" rel="noopener noreferrer"
                                       class="btn btn-secondary btn-sm btn-full">
                                        <i data-lucide="external-link" aria-hidden="true"></i> ${t('posts.viewLive')}
                                    </a>
                                </div>
                            ` : ''}
                        </article>
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
                    ${type.platforms.includes(platform) ? '' : html.raw('hidden disabled')}>${t(type.labelKey)}</option>
        `);
    },

    mediaFields(post) {
        const mediaUrl = safeUrl(post && post.media_url);
        const isVideo = post && (post.post_type === 'video' || post.post_type === 'reel');

        return html`
            <div class="form-group" id="media-url-group">
                <label class="form-label" for="post-media-file">${t('posts.media')}</label>
                <input type="file" id="post-media-file" class="field"
                       accept="image/*,video/*" data-change="posts:handleFileUpload" data-target="media">
                <label class="sr-only" for="post-media-url">${t('posts.mediaUrl')}</label>
                <input class="field mbs-4" id="post-media-url" name="media_url" value="${mediaUrl}" dir="ltr"
                       placeholder="${t('posts.mediaUrlPlaceholder')}" data-input="posts:handleUrlInput">
                <div id="media-upload-progress" class="upload-progress" role="status" aria-live="polite">
                    <span class="spinner spinner-sm"></span>
                    <span>${t('posts.uploading')}</span>
                </div>
                <div id="media-preview-container" class="media-preview ${mediaUrl ? html.raw('is-visible') : ''}">
                    ${mediaUrl
                        ? (isVideo
                            ? html`<video src="${mediaUrl}" muted controls aria-label="${t('posts.mediaPreview')}"></video>`
                            : html`<img src="${mediaUrl}" alt="${t('posts.mediaPreview')}">`)
                        : ''}
                </div>
                <p class="form-hint">${t('posts.uploadHint')}</p>
            </div>

            ${this.coverStep(post)}
        `;
    },

    /**
     * The thumbnail step. Two tiles side by side: what Instagram would pick on
     * its own (literally the video element at frame 0) and what the cover will
     * make it instead. The problem this field solves is visual, so the control
     * for it is visual too.
     */
    coverStep(post) {
        const coverUrl = safeUrl(post && post.cover_url);
        const mediaUrl = safeUrl(post && post.media_url);
        const isVideo = post && (post.post_type === 'video' || post.post_type === 'reel');

        return html`
            <div class="cover-step ${isVideo ? '' : html.raw('hidden')}" id="cover-url-group">
                <div class="cover-step-head">
                    <i data-lucide="image-plus" aria-hidden="true"></i>
                    <h4>${t('posts.cover.step')}</h4>
                </div>
                <p class="cover-step-why">${t('posts.cover.why')}</p>

                <label class="form-label" for="post-cover-file">
                    ${t('posts.cover.upload')} <span class="label-optional">${t('common.optional')}</span>
                </label>
                <input type="file" id="post-cover-file" class="field"
                       accept="image/*" data-change="posts:handleFileUpload" data-target="cover">
                <label class="sr-only" for="post-cover-url">${t('posts.cover.url')}</label>
                <input class="field mbs-4" id="post-cover-url" name="cover_url" value="${coverUrl}" dir="ltr"
                       placeholder="${t('posts.cover.urlPlaceholder')}" data-input="posts:refreshCoverPreview">
                <div id="cover-upload-progress" class="upload-progress" role="status" aria-live="polite">
                    <span class="spinner spinner-sm"></span>
                    <span>${t('posts.cover.uploading')}</span>
                </div>

                <div class="cover-compare" id="cover-compare">
                    ${this.coverTiles(mediaUrl, coverUrl)}
                </div>
            </div>
        `;
    },

    coverTiles(mediaUrl, coverUrl) {
        return html`
            <div class="cover-tile ${coverUrl ? '' : html.raw('is-chosen')}">
                <div class="cover-tile-frame">
                    ${mediaUrl
                        ? html`<video src="${mediaUrl}" muted preload="metadata" aria-hidden="true"></video>`
                        : html`<i data-lucide="video-off" aria-hidden="true"></i>`}
                </div>
                <p class="cover-tile-label">${t('posts.cover.frameZero')}</p>
            </div>
            <div class="cover-tile ${coverUrl ? html.raw('is-chosen') : ''}">
                <div class="cover-tile-frame">
                    ${coverUrl
                        ? html`<img src="${coverUrl}" alt="${t('posts.cover.gridPreview')}">`
                        : html`<i data-lucide="image-off" aria-hidden="true"></i>`}
                </div>
                <p class="cover-tile-label">${coverUrl ? t('posts.cover.set') : t('posts.cover.missing')}</p>
            </div>
            <p class="cover-note">${t('posts.cover.gridPreview')}</p>
        `;
    },

    refreshCoverPreview() {
        const host = document.getElementById('cover-compare');
        if (!host) return;
        const media = document.getElementById('post-media-url');
        const cover = document.getElementById('post-cover-url');
        host.innerHTML = esc(this.coverTiles(
            safeUrl(media && media.value),
            safeUrl(cover && cover.value)
        ));
        UI.icons(host);
    },

    /**
     * The scheduling block. `scheduleNote()` is recomputed on every change of
     * the time field, so the operator watches "actually publishes" stay on the
     * same 00:00 UTC run while they nudge the minutes.
     */
    scheduleFields(value) {
        return html`
            <div class="form-group" id="schedule-time-group">
                <label class="form-label" for="post-scheduled-time">${t('posts.schedule.label')}</label>
                <input type="datetime-local" class="field" id="post-scheduled-time" name="scheduled_time"
                       value="${value}" data-input="posts:refreshScheduleNote" required>
                <div class="schedule-truth">
                    <i data-lucide="info" aria-hidden="true"></i>
                    <div>
                        ${t('posts.schedule.truth')}
                        <span class="schedule-actual" id="schedule-actual">${this.scheduleNoteText(value)}</span>
                    </div>
                </div>
            </div>
        `;
    },

    scheduleNoteText(localValue) {
        const iso = UI.fromLocalInputValue(localValue);
        if (!iso) return '';
        const requested = new Date(iso);
        const isPast = requested.getTime() <= Date.now();
        const run = UI.nextCronRun(isPast ? new Date() : requested);
        return isPast
            ? `${t('posts.schedule.pastWarning')} ${t('posts.schedule.actual', { when: UI.formatDateTime(run) })}`
            : t('posts.schedule.actual', { when: UI.formatDateTime(run) });
    },

    refreshScheduleNote() {
        const input = document.getElementById('post-scheduled-time');
        const note = document.getElementById('schedule-actual');
        if (!input || !note) return;
        const iso = UI.fromLocalInputValue(input.value);
        const isPast = iso ? new Date(iso).getTime() <= Date.now() : false;
        note.textContent = this.scheduleNoteText(input.value);
        note.classList.toggle('is-warning', isPast);
    },

    modalHeader(title) {
        return html`
            <div class="modal-header">
                <h2 class="modal-title">${title}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
        `;
    },

    showCreateModal() {
        // datetime-local shows and submits LOCAL wall time. toISOString() is UTC,
        // so the old prefill was off by the whole UTC offset (UTC+3: two hours in
        // the past for a "1 hour from now" default).
        const defaultTime = UI.toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000));

        UI.showModal(html`
            ${this.modalHeader(t('posts.createTitle'))}
            <div id="post-form-error"></div>
            <form id="post-schedule-form" data-submit="posts:handleCreate">
                <div class="form-group">
                    <label class="form-label" for="post-platform-select">${t('posts.platform')}</label>
                    <select class="select" id="post-platform-select" name="platform" data-change="posts:handlePlatformChange" required>
                        <option value="instagram">${t('common.instagram')}</option>
                        <option value="facebook">${t('common.facebook')}</option>
                        <option value="both">${t('common.both')}</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="post-type-select">${t('posts.type')}</label>
                    <select class="select" name="post_type" id="post-type-select" data-change="posts:handleTypeChange" required>
                        ${this.typeOptions('instagram', 'image')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="post-caption">${t('posts.caption')}</label>
                    <textarea class="field-textarea user-content" id="post-caption" name="caption" dir="auto" lang="ar"
                              placeholder="${t('posts.captionPlaceholder')}" data-guard-dirty required></textarea>
                </div>
                ${this.mediaFields(null)}
                ${this.scheduleFields(defaultTime)}
                <div class="form-group switch-row">
                    <label class="switch" for="post-publish-now">
                        <span class="sr-only">${t('posts.publishNowToggle')}</span>
                        <input type="checkbox" name="publish_now" id="post-publish-now" data-change="posts:toggleScheduleTime">
                        <span class="switch-track"></span>
                    </label>
                    <span class="switch-label">${t('posts.publishNowToggle')}</span>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary" id="schedule-submit-btn">
                        <i data-lucide="plus" aria-hidden="true"></i> ${t('posts.scheduleBtn')}
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
            ${this.modalHeader(t('posts.editTitle'))}
            <div id="post-form-error"></div>
            <form id="post-schedule-form" data-submit="posts:handleEdit" data-id="${post.id}">
                <div class="form-group">
                    <label class="form-label" for="post-platform-select">${t('posts.platform')}</label>
                    <select class="select" id="post-platform-select" name="platform" data-change="posts:handlePlatformChange" required>
                        <option value="instagram" ${platform === 'instagram' ? html.raw('selected') : ''}>${t('common.instagram')}</option>
                        <option value="facebook" ${platform === 'facebook' ? html.raw('selected') : ''}>${t('common.facebook')}</option>
                        <option value="both" ${platform === 'both' ? html.raw('selected') : ''}>${t('common.both')}</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="post-type-select">${t('posts.type')}</label>
                    <select class="select" name="post_type" id="post-type-select" data-change="posts:handleTypeChange" required>
                        ${this.typeOptions(platform, postType)}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="post-caption">${t('posts.caption')}</label>
                    <textarea class="field-textarea user-content" id="post-caption" name="caption" dir="auto" lang="ar"
                              data-guard-dirty required>${post.caption || ''}</textarea>
                </div>
                ${this.mediaFields({ ...post, post_type: postType })}
                ${this.scheduleFields(defaultTime)}
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="check" aria-hidden="true"></i> ${t('common.saveChanges')}</button>
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
            this.POST_TYPES.filter((x) => x.platforms.includes(platform)).map((x) => x.value)
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

    /** The cover step only makes sense for video. */
    applyTypeMatrix() {
        const typeSelect = document.getElementById('post-type-select');
        const coverGroup = document.getElementById('cover-url-group');
        if (!typeSelect || !coverGroup) return;
        coverGroup.classList.toggle('hidden', typeSelect.value !== 'video');
        if (typeSelect.value === 'video') this.refreshCoverPreview();
    },

    toggleScheduleTime(publishNow) {
        const timeGroup = document.getElementById('schedule-time-group');
        const timeInput = document.getElementById('post-scheduled-time');
        const submitBtn = document.getElementById('schedule-submit-btn');
        if (!timeGroup || !timeInput || !submitBtn) return;

        timeGroup.classList.toggle('hidden', publishNow);
        timeInput.required = !publishNow;
        timeInput.disabled = publishNow;
        submitBtn.innerHTML = esc(publishNow
            ? html`<i data-lucide="send" aria-hidden="true"></i> ${t('posts.publishNow')}`
            : html`<i data-lucide="plus" aria-hidden="true"></i> ${t('posts.scheduleBtn')}`);
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
            return fromBody || err.message || t('error.unexpected');
        }
        if (result && result.status === 'FAILED') {
            return result.error || result.error_log || t('error.unexpected');
        }
        return null;
    },

    /**
     * A `role="alert"` strip at the top of the modal, and — when the failure
     * belongs to a specific field — that field marked invalid, described by
     * the strip, and focused.
     *
     * Before this, the strip was dropped in and focus stayed on the submit
     * button with no field marked: a screen-reader user heard the message once
     * and then had to hunt for which of six fields it was about, and a sighted
     * keyboard user had to scroll up to find out.
     */
    showFormError(message, fieldId) {
        const host = document.getElementById('post-form-error');
        if (!host) return;
        const stripId = 'post-form-error-strip';
        const form = document.getElementById('post-schedule-form');
        UI.clearInvalid(form);
        host.innerHTML = esc(UI.errorStrip(message, t('posts.publishFailedHint'), stripId));
        UI.icons(host);

        const field = fieldId ? document.getElementById(fieldId) : null;
        if (field) {
            UI.markInvalid(field, stripId);
            return; // focusing the field already scrolls it into view
        }
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
            this.showFormError(t('posts.schedule.unreadable'), 'post-scheduled-time');
            return;
        }

        const btn = form.querySelector('button[type="submit"]');
        if (btn.disabled) return; // already in flight
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = UI.buttonSpinner();

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
                UI.icons(btn);
                await this.render();
                return;
            }

            UI.toast(publishNow ? t('posts.publishedOk') : t('posts.scheduledOk'));
            // render() first, close after: closing first restored focus to the
            // "New post" button and the re-render then destroyed it, leaving
            // focus on a control inside the hidden overlay.
            await this.render();
            UI.closeModal();
        } catch (err) {
            const failure = this.publishFailure(null, err);
            if (publishNow) this.publishError = { message: failure };
            this.showFormError(failure);
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            UI.icons(btn);
            if (publishNow) await this.render();
        }
    },

    async handleEdit(form, event) {
        event.preventDefault();
        const id = form.dataset.id;
        const data = new FormData(form);
        const scheduledTime = UI.fromLocalInputValue(data.get('scheduled_time'));

        if (!scheduledTime) {
            this.showFormError(t('posts.schedule.unreadable'), 'post-scheduled-time');
            return;
        }

        const payload = { ...this.formPayload(form), scheduled_time: scheduledTime };

        // This was the one submit handler on the page with no guard at all:
        // two Enters on a cold start sent two PUTs for the same row.
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;

        try {
            await API.updateScheduledPost(id, payload);
            UI.toast(t('posts.updatedOk'));
            await this.render();
            UI.closeModal();
        } catch (err) {
            restore();
            this.showFormError(err.message);
        }
    },

    /**
     * Ask first. Until now this was the one truly irreversible, customer-facing action on
     * this screen with zero confirmation — it posts to a live account — while deleting a
     * queue row, strictly less consequential, already confirmed below. Same `Admin.confirm`
     * pattern as `deletePost`, two functions down.
     */
    publishNow(id) {
        Admin.confirm({
            title: t('posts.publishNow'),
            body: t('posts.publishNowToggle'),
            hint: t('posts.deleteHint'),
            confirmLabel: t('posts.publishNow'),
            confirmIcon: 'send',
            onConfirm: () => PostsPage.publishNowConfirmed(id),
        });
    },

    /**
     * The confirmation has already been given. `POST /posts/scheduled/:id/publish-now` claims
     * the row, runs it through the same `attemptPublish()` the cron sweep uses, and updates it
     * in place — so unlike the old create-a-new-row-then-delete-the-old-one dance, a platform
     * already recorded in `published_post_id` (e.g. Facebook, if Instagram was the one that
     * timed out last time) is skipped server-side. A second click cannot duplicate a post that
     * already went live.
     */
    async publishNowConfirmed(id) {
        const post = this.posts.find((p) => p.id === id);
        if (!post) return;

        const card = document.querySelector(`.post-card[data-id="${CSS.escape(id)}"]`);
        if (card) {
            const statusPill = card.querySelector('.status-pill');
            const actions = card.querySelector('.card-actions');
            if (statusPill) {
                statusPill.className = 'status-pill publishing';
                statusPill.textContent = t('posts.statusPublishing');
            }
            if (actions) {
                actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
            }
        }

        this.publishError = null;

        try {
            const result = await API.publishExistingNow(id);

            const failure = this.publishFailure(result, null);
            if (failure) {
                this.publishError = { message: failure };
                UI.toast(t('posts.publishFailedToast'), 'error');
                await this.render();
                return;
            }

            UI.toast(t('posts.publishedOk'));
            await this.render();
        } catch (err) {
            this.publishError = { message: this.publishFailure(null, err) };
            UI.toast(t('posts.publishFailedToast'), 'error');
            await this.render();
        }
    },

    /**
     * Ask first, in the product's own dialog.
     *
     * This used `window.confirm()`, which is browser chrome: it cannot be styled
     * as dangerous, cannot be translated, and drops the product's visual identity
     * at exactly the moment the operator is deciding whether to destroy something.
     * `Admin.confirm` is loaded eagerly for this reason.
     */
    deletePost(id) {
        Admin.confirm({
            title: t('posts.deleteTitle'),
            body: t('posts.deleteConfirm'),
            hint: t('posts.deleteHint'),
            confirmLabel: t('common.delete'),
            onConfirm: () => PostsPage.deletePostConfirmed(id),
        });
    },

    /**
     * The confirmation has already been given, so the card goes now and the
     * DELETE follows it. A failure puts the card back at its old index and says
     * why — it used to re-fetch the whole queue and both feeds to show a row it
     * had never actually removed.
     */
    deletePostConfirmed(id) {
        const index = this.posts.findIndex((p) => String(p.id) === String(id));
        if (index === -1) return Promise.resolve();
        const removed = this.posts[index];
        const card = document.querySelector(`.post-card[data-id="${CSS.escape(String(id))}"]`);

        // Removing the card removes the button that is holding focus, so focus
        // would fall to <body>. There is nothing to return to on a delete, so
        // it goes to the page region.
        const focus = UI.captureFocus(document.getElementById('page-container'));

        this.posts.splice(index, 1);
        if (card) card.remove();
        UI.restoreFocus(focus);

        return Motion.optimistic({
            send: () => API.deleteScheduledPost(id),
            revert: () => {
                this.posts.splice(index, 0, removed);
                this.renderLayout();
            },
            onError: (err) => UI.toast((err && err.message) || t('posts.deleteFailed'), 'error'),
        });
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
            UI.toast(t('posts.uploadTooBig', { size: (file.size / (1024 * 1024)).toFixed(1) }), 'error');
            input.value = '';
            return;
        }

        if (progress) progress.classList.add('is-active');
        if (target === 'media' && preview) preview.classList.remove('is-visible');

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const res = await API.uploadMedia({
                    filename: file.name,
                    mime_type: file.type,
                    base64_data: e.target.result,
                });

                if (urlInput) urlInput.value = res.url;
                if (progress) progress.classList.remove('is-active');

                if (target === 'media') this.showMediaPreview(res.url, file.type.startsWith('video/'));
                this.refreshCoverPreview();
                UI.toast(t('posts.uploadDone'));
            } catch (err) {
                UI.toast(t('posts.uploadFailed', { message: err.message }), 'error');
                if (progress) progress.classList.remove('is-active');
                input.value = '';
            }
        };
        reader.onerror = () => {
            UI.toast(t('posts.readFailed'), 'error');
            if (progress) progress.classList.remove('is-active');
        };
        reader.readAsDataURL(file);
    },

    showMediaPreview(url, isVideo) {
        const preview = document.getElementById('media-preview-container');
        if (!preview) return;
        const clean = safeUrl(url);
        if (!clean) {
            preview.classList.remove('is-visible');
            preview.innerHTML = '';
            return;
        }
        preview.classList.add('is-visible');
        preview.innerHTML = esc(isVideo
            ? html`<video src="${clean}" muted controls aria-label="${t('posts.mediaPreview')}"></video>`
            : html`<img src="${clean}" alt="${t('posts.mediaPreview')}">`);
    },

    handleUrlInput(input) {
        const value = input.value;
        if (!value) {
            const preview = document.getElementById('media-preview-container');
            if (preview) { preview.classList.remove('is-visible'); preview.innerHTML = ''; }
            this.refreshCoverPreview();
            return;
        }
        this.showMediaPreview(value, /\.(mp4|mov|avi|wmv|m4v|webm)(\?|$)/i.test(value));
        this.refreshCoverPreview();
    },
};

/**
 * The three `data-input` handlers on this screen all do work that must not sit
 * on the typing path, so they are debounced here rather than inside the
 * methods — the methods stay directly callable from the code that needs them
 * to run at once (form open, upload complete).
 *
 *   - refreshScheduleNote  formats a timestamp through Intl on every keystroke
 *     in the datetime field. 120ms, so the "actually publishes" line still
 *     updates while the operator is nudging the minutes.
 *   - handleUrlInput / refreshCoverPreview  rebuild an <img>/<video> from the
 *     field's current value, which STARTS A NETWORK REQUEST per keystroke: a
 *     40-character URL fired up to 40 image loads, 39 of them for prefixes
 *     that were never a real URL. 280ms, comfortably past a typing pause.
 */
const debouncedScheduleNote = Motion.debounce(() => PostsPage.refreshScheduleNote(), 120);
const debouncedUrlInput = Motion.debounce((el) => PostsPage.handleUrlInput(el), 280);
const debouncedCoverPreview = Motion.debounce(() => PostsPage.refreshCoverPreview(), 280);

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
    refreshScheduleNote: () => debouncedScheduleNote(),
    refreshCoverPreview: () => debouncedCoverPreview(),
    handleCreate: (el, e) => PostsPage.handleCreate(el, e),
    handleEdit: (el, e) => PostsPage.handleEdit(el, e),
    handleFileUpload: (el) => PostsPage.handleFileUpload(el),
    handleUrlInput: (el) => debouncedUrlInput(el),
});
