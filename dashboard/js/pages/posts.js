/**
 * Posts Scheduler — create, schedule and publish to Instagram & Facebook.
 *
 * ─── Two honesty problems this screen had ───────────────────────────────────
 *
 * 1. THE MINUTE IS A LIE. `vercel.json` runs one cron a day at 00:00 UTC (a
 *    Hobby-plan limit) and it is the only thing that publishes anything today,
 *    so a `datetime-local` accepting 14:35 promises what the backend cannot
 *    deliver. The field stays — the API takes a full ISO timestamp and the date
 *    genuinely matters — but underneath it the form computes and shows the run
 *    the post will ACTUALLY go out on, live, as the operator picks a time.
 *    `publishWindow()` below carries that, and the evidence for it; a frequent
 *    sweep has been claimed by two documents and has never once run.
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
     * The tenant's TikTok connection summary (GET /tiktok/connection), or null
     * when it could not be read. Only ever decides what the composer OFFERS —
     * the server refuses a TikTok post without a connection regardless.
     */
    tiktok: null,

    /**
     * Direct Post composer state, per open modal. `tiktokCreator` is the live
     * GET /tiktok/creator-info answer — `{ status: 'loading'|'ready'|'error',
     * data?, error? }` — fetched when TikTok becomes a target, never at page
     * load, because TikTok's guidelines want the account's CURRENT limits.
     * `_ttChoices` is what the operator has picked so far, kept outside the DOM
     * so the panel can be re-rendered from it; `_ttDurationSec` is read off the
     * preview `<video>`'s metadata.
     */
    tiktokCreator: null,
    /**
     * This post's delivery when the account can do both (until TikTok approves the app):
     * 'direct' | 'inbox', or '' before the operator has chosen. There is no default — a
     * private direct post and an inbox draft are different outcomes, so the operator picks.
     */
    _ttDelivery: '',
    _ttChoices: null,
    _ttDurationSec: null,
    _ttSeq: 0,

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
        this.tiktok = null;
        this._ttSeq++;
        this.tiktokCreator = null;
        this._ttChoices = null;
        this._ttDurationSec = null;
    },

    /**
     * Platform → allowed post types.
     *  - `reel` is deliberately absent: `video` maps to /videos on Facebook and
     *    to a REELS container on Instagram, so it covers both. See CLAUDE.md.
     *  - `story` is Instagram-only — Facebook page stories need the two-step
     *    /photo_stories + /video_stories upload the backend does not implement,
     *    so platform="both" cannot offer it either.
     *  - `feed` (text/link) is Facebook-only.
     *  - TikTok takes video only: photo posts need TikTok to pull the images
     *    from a verified URL, which is not wired up. `both` still means
     *    Instagram + Facebook; TikTok is its own row (see "Also send to TikTok").
     */
    POST_TYPES: [
        { value: 'image', labelKey: 'posts.type.image', platforms: ['instagram', 'facebook', 'both'] },
        { value: 'video', labelKey: 'posts.type.video', platforms: ['instagram', 'facebook', 'both', 'tiktok'] },
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

        const [scheduled, live, tiktok] = await Promise.allSettled([
            API.getScheduledPosts(),
            API.getLivePosts(),
            API.getTikTokConnection(),
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

        // Not an error panel of its own: without it the composer simply does
        // not offer TikTok, and Settings is where a broken connection is shown.
        this.tiktok = tiktok.status === 'fulfilled' ? tiktok.value : null;

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
                    ${this.tabButton('scheduled', 'calendar', t('posts.tabQueue'))}
                    ${this.tabButton('live', 'instagram', t('posts.tabLive'))}
                </div>
                <div class="toolbar-actions">
                    ${UI.button({
                        variant: 'primary', size: 'sm', icon: 'plus', label: t('posts.new'),
                        action: 'posts:showCreateModal', id: 'posts-new',
                    })}
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

    /**
     * One half of the segmented control.
     *
     * Written once rather than twice because the two halves have to stay in
     * step: the selected one is primary and the other is ghost, and `aria-pressed`
     * has to agree with that on BOTH — a segmented control where only the active
     * half carries the state is announced as one pressed toggle beside one
     * ordinary button, which is not what it is.
     *
     * Deliberately NOT `UI.button`. The factory has no `aria-pressed` option,
     * and routing one through its `data` map emits `data-aria-pressed` — a
     * silently inert attribute that would have undone the fix this control
     * already carries. A primitive that does not cover a case is a reason to
     * write the markup, not a reason to launder the attribute through the
     * nearest option that compiles.
     */
    tabButton(tab, icon, label) {
        const active = this.activeTab === tab;
        return html`
            <button type="button" id="posts-tab-${tab}"
                    aria-pressed="${active ? 'true' : 'false'}"
                    class="btn btn-sm ${active ? html.raw('btn-primary') : html.raw('btn-ghost')}"
                    data-action="posts:switchTab" data-tab="${tab}">
                <i data-lucide="${icon}" aria-hidden="true"></i> ${label}
            </button>
        `;
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
                        ${UI.button({
                            variant: 'primary', size: 'sm', icon: 'plus', label: t('posts.new'),
                            action: 'posts:showCreateModal',
                        })}
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
        if (value === 'tiktok') return { cls: 'badge-tiktok', icon: 'music-2', label: t('common.tiktok') };
        if (value === 'both') return { cls: 'badge-neutral', icon: 'share-2', label: t('common.both') };
        // Anything else used to fall through to "Both platforms" — a label that
        // was a claim about where the post would go. Say what the row says.
        return { cls: 'badge-neutral', icon: 'help-circle', label: value || '—' };
    },

    /** Is this account's TikTok connection usable for a new post right now? */
    tiktokReady() {
        const c = this.tiktok && this.tiktok.connection;
        // Either permission can deliver a post: `video.upload` to the inbox, `video.publish`
        // straight to the profile. Direct Post connections hold only the second.
        return !!(c && c.connected && (c.canUpload || c.canDirectPost));
    },

    /** What the connection summary says: 'direct' only when the server says so. */
    tiktokConnectionMode() {
        const c = this.tiktok && this.tiktok.connection;
        return c && c.postMode === 'direct' ? 'direct' : 'inbox';
    },

    /**
     * The mode a NEW post from this composer will use. The live creator-info
     * answer wins once it is in, since it is fresher than the page-load summary.
     */
    tiktokPostMode() {
        const info = this.tiktokCreator;
        if (info && info.status === 'ready' && info.data && info.data.postMode) {
            return info.data.postMode === 'direct' ? 'direct' : 'inbox';
        }
        return this.tiktokConnectionMode();
    },

    /** A scheduled row's own mode. Rows from before v19 carry no options: inbox. */
    tiktokRowMode(row) {
        const o = row && row.platform_options;
        return o && o.mode === 'direct' ? 'direct' : 'inbox';
    },

    /**
     * Until TikTok approves the app, a direct post is private (Only me) and needs a private
     * account — so a connection holding BOTH permissions lets each post choose between that and
     * an inbox draft. Once audited, direct posts go out public and there is nothing to choose.
     */
    tiktokOffersChoice() {
        const c = this.tiktok && this.tiktok.connection;
        return !!(c && c.connected && c.canUpload && c.canDirectPost
            && this.tiktokConnectionMode() === 'direct' && c.audited !== true);
    },

    /** The mode THIS post will use: the per-post choice when one is offered ('' = not chosen). */
    tiktokEffectiveMode() {
        if (this.tiktokOffersChoice()) return this._ttDelivery || '';
        return this.tiktokPostMode();
    },

    tiktokDeliveryChoice() {
        const chosen = this._ttDelivery;
        const option = (value, label, hint) => html`
            <label class="tiktok-delivery-option" for="tiktok-delivery-${value}">
                <input type="radio" name="tiktok_delivery" id="tiktok-delivery-${value}" value="${value}"
                       data-change="posts:tiktokDelivery" ${chosen === value ? html.raw('checked') : ''}>
                <span class="stack gap-1">
                    <strong>${label}</strong>
                    <span class="form-hint">${hint}</span>
                </span>
            </label>
        `;
        return html`
            <fieldset class="tiktok-delivery" id="tiktok-delivery">
                <legend class="form-label">${t('posts.tiktok.delivery.legend')}</legend>
                ${option('direct', t('posts.tiktok.delivery.direct'), t('posts.tiktok.delivery.directHint'))}
                ${option('inbox', t('posts.tiktok.delivery.inbox'), t('posts.tiktok.delivery.inboxHint'))}
            </fieldset>
        `;
    },

    onTikTokDelivery(el) {
        const value = el && el.value;
        this._ttDelivery = value === 'direct' || value === 'inbox' ? value : '';
        const inboxBody = document.getElementById('tiktok-inbox-body');
        if (inboxBody) inboxBody.classList.toggle('hidden', this._ttDelivery !== 'inbox');
        const wrap = document.getElementById('tiktok-direct-wrap');
        if (wrap) wrap.classList.toggle('hidden', this.tiktokEffectiveMode() !== 'direct');
        this.refreshTikTokDirect();
    },

    /**
     * The fallback that never depends on TikTok's API: take the file and the caption and post
     * them from the TikTok app. Shown on every TikTok card that is not live yet.
     */
    renderTikTokManual(post, withHint = true) {
        const href = safeUrl(post && post.media_url);
        if (!href && !(post && post.caption)) return '';
        return html`
            <div class="tiktok-manual">
                ${withHint ? html`<p class="form-hint">${t('posts.tiktok.manualHint')}</p>` : ''}
                <div class="row row--wrap gap-2">
                    ${href ? html`
                        <a class="btn btn-secondary btn-sm" href="${href}" download>
                            <i data-lucide="download" aria-hidden="true"></i> ${t('posts.tiktok.download')}
                        </a>
                    ` : ''}
                    ${post.caption ? UI.button({
                        variant: 'secondary', size: 'sm', icon: 'copy', label: t('posts.tiktok.copyCaption'),
                        action: 'app:copyValue', data: { copy: post.caption },
                    }) : ''}
                </div>
            </div>
        `;
    },

    /** TikTok's privacy levels, each with a translated label. Unknown values show as themselves. */
    privacyLabel(level) {
        switch (level) {
            case 'PUBLIC_TO_EVERYONE': return t('posts.tiktok.privacy.public');
            case 'MUTUAL_FOLLOW_FRIENDS': return t('posts.tiktok.privacy.friends');
            case 'FOLLOWER_OF_CREATOR': return t('posts.tiktok.privacy.followers');
            case 'SELF_ONLY': return t('posts.tiktok.privacy.selfOnly');
            default: return String(level || '—');
        }
    },

    privacyIcon(level) {
        if (level === 'PUBLIC_TO_EVERYONE') return 'globe';
        if (level === 'SELF_ONLY') return 'lock';
        return 'users';
    },

    /** Seconds as m:ss (h:mm:ss past an hour). Rounded UP, so 60.4s never reads as 1:00. */
    formatDuration(sec) {
        const total = Math.max(0, Math.ceil(Number(sec) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    },

    renderScheduledCard(post) {
        const isPending = post.status === 'PENDING';
        const isFailed = post.status === 'FAILED';
        const isPublishing = post.status === 'PUBLISHING';
        const isPublished = post.status === 'PUBLISHED';
        // TikTok is asynchronous: PROCESSING while TikTok ingests the upload,
        // IN_INBOX once it waits in the creator's TikTok inbox to be posted.
        const isProcessing = post.status === 'PROCESSING';
        const isInInbox = post.status === 'IN_INBOX';
        const isTikTok = post.platform === 'tiktok';
        // Direct Post goes straight to the profile, so there is no inbox step
        // and the privacy the operator chose is worth showing on the card.
        const isDirect = isTikTok && this.tiktokRowMode(post) === 'direct';
        const privacyLevel = isDirect ? String(post.platform_options.privacy_level || '') : '';

        let statusClass = 'pending';
        if (isFailed) statusClass = 'failed';
        if (isPublished) statusClass = 'sent';

        const badge = this.platformBadge(post.platform);
        const mediaUrl = safeUrl(post.media_url);
        const coverUrl = safeUrl(post.cover_url);
        const isVideo = post.post_type === 'video' || post.post_type === 'reel';
        const typeLabel = this.typeLabel(post.post_type);
        // Only a PENDING row has a publish still ahead of it. An overdue one
        // reads `isPast`, which is the state the operator has to act on.
        const pendingWindow = isPending ? this.publishWindow(post.scheduled_time) : null;

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
                        ${privacyLevel ? this.tiktokPrivacyChip(privacyLevel) : ''}
                    </div>
                    <span class="status-pill ${html.raw(statusClass)}">
                        ${isPublishing || isProcessing
                            ? html`<span class="dot-blink" aria-hidden="true"></span> ${isProcessing ? t('state.processing') : t('posts.statusPublishing')}`
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

                ${isVideo && !isTikTok ? html`
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
                ${isPending && pendingWindow ? html`
                    <p class="post-card-meta">
                        <i data-lucide="calendar-clock" aria-hidden="true"></i>
                        <span class="${pendingWindow.isPast ? html.raw('text-warning') : ''}">
                            ${this.publishWindowText(pendingWindow)}
                        </span>
                    </p>
                ` : ''}

                ${isFailed ? html`
                    <p class="post-card-error" dir="auto">
                        <strong>${t('posts.errorLabel')}</strong> ${post.error_log || t('error.unexpected')}
                    </p>
                ` : ''}

                ${isPending && post.error_log ? html`
                    <!-- A PENDING row with a note is one being held, not one that
                         failed — today only TikTok's five-drafts-a-day limit does
                         this — so it reads as a warning, not an error. -->
                    <p class="post-card-meta post-card-meta--note">
                        <i data-lucide="alert-triangle" aria-hidden="true"></i>
                        <span class="text-warning" dir="auto">${post.error_log}</span>
                    </p>
                ` : ''}

                ${isTikTok && isProcessing ? html`
                    <p class="post-card-meta post-card-meta--note">
                        <i data-lucide="loader" aria-hidden="true"></i>
                        <span>${isDirect ? t('posts.tiktok.direct.processingNote') : t('posts.tiktok.processingNote')}</span>
                    </p>
                ` : ''}

                ${isTikTok && isInInbox ? this.renderTikTokInboxNote(post) : ''}
                ${isTikTok && !isInInbox && !isPublished ? this.renderTikTokManual(post) : ''}

                ${isPublished && post.published_post_id ? html`
                    <p class="post-card-id"><strong>${t('posts.publishedIdLabel')}</strong> ${UI.ltr(post.published_post_id)}</p>
                ` : ''}
                ${isPublished && isTikTok && (isDirect || !post.published_post_id) ? html`
                    <!-- TikTok returns a post id only for public posts that have
                         passed moderation; a private or friends-only post never
                         gets one. A direct post always says where it went, since
                         there was no inbox step the operator saw it through. -->
                    <p class="post-card-meta post-card-meta--note">
                        <i data-lucide="check-circle" aria-hidden="true"></i>
                        <span class="text-success">${t('posts.tiktok.postedNoId')}</span>
                    </p>
                ` : ''}

                <div class="card-actions">
                    ${isPending || isFailed ? html`
                        <!-- Stable keys across the re-render, so closeModal()
                             can put focus back on this card's own button. -->
                        ${UI.button({
                            variant: 'primary', size: 'sm', icon: 'send', label: t('posts.publishNow'),
                            action: 'posts:publishNow', data: { id: post.id },
                            focusKey: `post-publish-${post.id}`,
                        })}
                        ${UI.button({
                            variant: 'secondary', size: 'sm', icon: 'pencil', label: t('common.edit'),
                            action: 'posts:showEditModal', data: { id: post.id },
                            focusKey: `post-edit-${post.id}`,
                        })}
                        ${UI.button({
                            variant: 'danger', size: 'sm', icon: 'trash-2', label: t('common.delete'),
                            action: 'posts:deletePost', data: { id: post.id },
                            focusKey: `post-delete-${post.id}`,
                        })}
                    ` : html`
                        ${UI.button({
                            variant: 'secondary', size: 'sm', full: true,
                            icon: 'trash-2', label: t('posts.deleteLog'),
                            action: 'posts:deletePost', data: { id: post.id },
                        })}
                    `}
                </div>
            </article>
        `;
    },

    /**
     * The one step inbox mode leaves to a person: the video is in the TikTok
     * inbox and has to be posted from the TikTok app. The caption is sent with
     * the upload, but TikTok does not document that it is kept, so it is also
     * one tap from the clipboard — the dashboard is mostly used from a phone,
     * where "copy, open TikTok, paste" is the whole flow.
     */
    renderTikTokInboxNote(post) {
        return html`
            <div class="tiktok-next" role="note">
                <p class="tiktok-next-title">
                    <i data-lucide="inbox" aria-hidden="true"></i>
                    <strong>${t('posts.tiktok.inboxTitle')}</strong>
                </p>
                <p class="tiktok-next-body">${t('posts.tiktok.inboxBody')}</p>
                <div class="row row--wrap gap-2">
                    ${post.caption ? UI.button({
                        variant: 'secondary', size: 'sm', icon: 'copy', label: t('posts.tiktok.copyCaption'),
                        action: 'app:copyValue', data: { copy: post.caption },
                    }) : ''}
                    ${safeUrl(post.media_url) ? html`
                        <a class="btn btn-secondary btn-sm" href="${safeUrl(post.media_url)}" download>
                            <i data-lucide="download" aria-hidden="true"></i> ${t('posts.tiktok.download')}
                        </a>
                    ` : ''}
                    <a class="btn btn-secondary btn-sm" href="https://www.tiktok.com/" target="_blank" rel="noopener noreferrer">
                        <i data-lucide="external-link" aria-hidden="true"></i> ${t('posts.tiktok.openTikTok')}
                    </a>
                </div>
            </div>
        `;
    },

    /** Who can see a direct post, as a chip. A badge, not a status: it is the operator's choice. */
    tiktokPrivacyChip(level) {
        return html`
            <span class="badge badge-neutral" title="${t('posts.tiktok.direct.privacy')}">
                <i data-lucide="${this.privacyIcon(level)}" aria-hidden="true"></i>
                <span class="sr-only">${t('posts.tiktok.direct.privacy')}:</span>
                ${this.privacyLabel(level)}
            </span>
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
                        ${UI.button({
                            variant: 'secondary', size: 'sm', icon: 'key-round',
                            label: t('overview.openSettings'),
                            action: 'app:navigate', data: { target: 'settings' },
                        })}
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

    /**
     * The TikTok part of the composer. `offerAlso` is the create form's
     * "Also send to TikTok" switch, which schedules a second, TikTok-only row
     * alongside an Instagram/Facebook post.
     *
     * Inbox mode: the info panel says, before the operator commits, that TikTok
     * will not post by itself. Direct mode: the panel is a host that
     * `refreshTikTokDirect()` fills once the live creator info is in — TikTok's
     * Content Sharing Guidelines move every choice its own editor would ask
     * (privacy, interactions, disclosure, consent) into this composer.
     */
    tiktokFields(offerAlso) {
        const ready = this.tiktokReady();
        const direct = ready && this.tiktokConnectionMode() === 'direct';
        return html`
            ${offerAlso ? html`
                <div class="form-group switch-row hidden" id="tiktok-also-group">
                    <label class="switch" for="post-also-tiktok">
                        <span class="sr-only">${t('posts.tiktok.also')}</span>
                        <input type="checkbox" name="also_tiktok" id="post-also-tiktok"
                               data-change="posts:handleTypeChange" ${ready ? '' : html.raw('disabled')}>
                        <span class="switch-track"></span>
                    </label>
                    <span class="switch-label">${t('posts.tiktok.also')}</span>
                </div>
            ` : ''}
            ${direct ? html`
                <!-- A group, not a note: this panel holds the post's controls. -->
                <div class="tiktok-panel hidden" id="tiktok-info" role="group" aria-labelledby="tiktok-direct-title">
                    ${this.tiktokOffersChoice() ? html`
                        ${this.tiktokDeliveryChoice()}
                        <div id="tiktok-inbox-body" class="stack gap-2 ${this._ttDelivery === 'inbox' ? '' : html.raw('hidden')}">
                            ${this.tiktokInboxBody()}
                        </div>
                    ` : ''}
                    <div id="tiktok-direct-wrap" class="${this.tiktokOffersChoice() && this._ttDelivery !== 'direct' ? html.raw('hidden') : ''}">
                        <h3 class="tiktok-direct-title" id="tiktok-direct-title">${t('posts.tiktok.direct.title')}</h3>
                        <div class="tiktok-direct" id="tiktok-direct"></div>
                    </div>
                </div>
            ` : html`
                <div class="tiktok-panel hidden" id="tiktok-info" role="note">
                    ${ready ? this.tiktokInboxBody() : html`
                        <p class="form-hint text-warning">
                            <i data-lucide="alert-triangle" aria-hidden="true"></i>
                            ${t('posts.tiktok.notConnected')}
                        </p>
                    `}
                </div>
            `}
        `;
    },

    /** Inbox mode's panel body, unchanged: whose inbox, what happens, how full it is. */
    tiktokInboxBody() {
        const c = this.tiktok && this.tiktok.connection;
        const inbox = this.tiktok && this.tiktok.inbox;
        const avatar = c ? safeUrl(c.avatarUrl) : '';
        return html`
            <p class="tiktok-account">
                ${avatar ? html`<img class="tiktok-avatar" src="${avatar}" alt="" width="24" height="24">` : html`<i data-lucide="music-2" aria-hidden="true"></i>`}
                <span>${t('posts.tiktok.postingAs')}</span>
                <strong dir="auto">${(c && c.displayName) || t('settings.tiktok.unnamed')}</strong>
            </p>
            <p class="form-hint">${t('posts.tiktok.inboxExplainer')}</p>
            ${inbox ? html`
                <p class="form-hint ${inbox.pending >= inbox.limit ? html.raw('text-warning') : ''}">
                    ${t('posts.tiktok.inboxUsage', { pending: inbox.pending, limit: inbox.limit })}
                </p>
            ` : ''}
        `;
    },

    // ─── TikTok Direct Post ──────────────────────────────────────────────────
    /**
     * Every choice starts OFF / empty. TikTok's guidelines are explicit that the
     * privacy level has no default and that no interaction is pre-ticked, so
     * "the operator did not touch it" and "the operator chose no" are the same
     * thing here, on purpose.
     */
    TIKTOK_DEFAULT_CHOICES: Object.freeze({
        privacy_level: '',
        allow_comment: false,
        allow_duet: false,
        allow_stitch: false,
        disclose: false,
        brand_organic: false,
        brand_content: false,
        is_aigc: false,
        consent: false,
    }),

    TIKTOK_LEGAL_LINKS: Object.freeze({
        music: 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en',
        policy: 'https://www.tiktok.com/legal/page/global/bc-policy/en',
    }),

    /**
     * An edit modal starts from what the row saved. Consent is NOT carried
     * over: it is asked again for every submission, because TikTok wants it
     * given for the upload that actually happens.
     */
    tiktokChoicesFrom(options) {
        const o = options && typeof options === 'object' && options.mode === 'direct' ? options : null;
        if (!o) return { ...this.TIKTOK_DEFAULT_CHOICES };
        const organic = o.brand_organic === true;
        const content = o.brand_content === true;
        return {
            ...this.TIKTOK_DEFAULT_CHOICES,
            privacy_level: typeof o.privacy_level === 'string' ? o.privacy_level : '',
            allow_comment: o.allow_comment === true,
            allow_duet: o.allow_duet === true,
            allow_stitch: o.allow_stitch === true,
            disclose: organic || content,
            brand_organic: organic,
            brand_content: content,
            is_aigc: o.is_aigc === true,
        };
    },

    /**
     * Everything the Direct Post panel shows, decided in one pure function so
     * the rules — which TikTok's app audit checks one by one — are pinned by
     * tests rather than read out of a template.
     *
     * The two rules that interlock:
     *   - branded content cannot be private: while "Branded content" is ticked,
     *     SELF_ONLY is disabled; while SELF_ONLY is selected, "Branded content"
     *     is disabled;
     *   - an unaudited app can only post SELF_ONLY, so every other level is
     *     disabled — and, by the rule above, branded content always is.
     *
     * A saved choice that is no longer allowed (an edit whose level the account
     * no longer offers) resolves to "nothing selected" rather than a default.
     *
     * @param {object|null} creator  `creator` from GET /tiktok/creator-info
     * @param {object} choices       what the operator has picked (TIKTOK_DEFAULT_CHOICES shape)
     * @param {{ audited?: boolean, durationSec?: number|null }} [opts]
     */
    tiktokDirectState(creator, choices, opts) {
        const o = opts || {};
        const cr = creator || {};
        const c = { ...this.TIKTOK_DEFAULT_CHOICES, ...(choices || {}) };
        // Anything other than an explicit `true` is treated as unaudited: the
        // restrictive reading is the one TikTok will enforce anyway.
        const audited = o.audited === true;
        const levels = Array.isArray(cr.privacyLevelOptions) ? cr.privacyLevelOptions.map(String) : [];

        const disclose = !!c.disclose;
        const brandOrganic = disclose && !!c.brand_organic;
        const brandContent = disclose && !!c.brand_content && audited;

        const levelDisabled = (level) => (!audited && level !== 'SELF_ONLY')
            || (brandContent && level === 'SELF_ONLY');
        const wanted = String(c.privacy_level || '');
        const privacy = levels.includes(wanted) && !levelDisabled(wanted) ? wanted : '';

        let brandContentReason = null;
        if (!audited) brandContentReason = 'unaudited';
        else if (privacy === 'SELF_ONLY') brandContentReason = 'private';

        const interaction = (flag, off) => ({ checked: !cr[off] && !!c[flag], disabled: !!cr[off] });

        const max = Number(cr.maxVideoPostDurationSec) > 0 ? Number(cr.maxVideoPostDurationSec) : null;
        const duration = Number.isFinite(o.durationSec) && o.durationSec > 0 ? o.durationSec : null;

        return {
            nickname: cr.nickname || '',
            username: cr.username || '',
            avatarUrl: cr.avatarUrl || '',
            audited,
            levels,
            privacy,
            privacyOptions: levels.map((level) => ({ value: level, disabled: levelDisabled(level) })),
            selfOnlyBlocked: brandContent && levels.includes('SELF_ONLY'),
            comment: interaction('allow_comment', 'commentDisabled'),
            duet: interaction('allow_duet', 'duetDisabled'),
            stitch: interaction('allow_stitch', 'stitchDisabled'),
            disclose,
            brandOrganic,
            brandContent,
            brandContentDisabled: brandContentReason !== null,
            brandContentReason,
            needsDisclosureChoice: disclose && !brandOrganic && !brandContent,
            // TikTok: branded content (alone or with "your brand") is labelled
            // Paid partnership; "your brand" alone is Promotional content.
            label: brandContent ? 'paid' : (brandOrganic ? 'promotional' : null),
            declaration: brandContent ? 'branded' : 'music',
            isAigc: !!c.is_aigc,
            consent: !!c.consent,
            maxDurationSec: max,
            durationSec: duration,
            tooLong: max !== null && duration !== null && duration > max,
        };
    },

    /**
     * Can this be submitted, and if so with exactly which `tiktok_options`?
     * Checks the operator's RAW choices, so a combination the panel would have
     * quietly resolved (branded + Only me from an old row) is named, not hidden.
     *
     * @returns {{ ok: true, options: object } | { ok: false, code: string, field: string|null, message: string }}
     */
    validateTikTokOptions(creator, choices, opts) {
        const fail = (code, field, params) => ({ ok: false, code, field, message: this.tiktokErrorText(code, params) });
        if (!creator) return fail('notReady', null);

        const c = { ...this.TIKTOK_DEFAULT_CHOICES, ...(choices || {}) };
        const s = this.tiktokDirectState(creator, c, opts);
        const level = String(c.privacy_level || '');

        if (s.tooLong) {
            return fail('tooLong', 'post-media-url', {
                duration: this.formatDuration(s.durationSec), max: this.formatDuration(s.maxDurationSec),
            });
        }
        if (!level) return fail('privacyRequired', 'tiktok-privacy');
        if (!s.levels.includes(level)) return fail('privacyUnavailable', 'tiktok-privacy');
        if (!s.audited && level !== 'SELF_ONLY') return fail('unauditedPrivate', 'tiktok-privacy');
        if (c.disclose && !c.brand_organic && !c.brand_content) return fail('discloseChoose', 'tiktok-brand-organic');
        if (c.disclose && c.brand_content && level === 'SELF_ONLY') return fail('brandedPrivate', 'tiktok-privacy');
        if (!c.consent) return fail('consentRequired', 'tiktok-consent-check');

        return {
            ok: true,
            options: {
                privacy_level: level,
                // An interaction the account has switched off is sent as off,
                // whatever the saved choice said.
                allow_comment: s.comment.checked,
                allow_duet: s.duet.checked,
                allow_stitch: s.stitch.checked,
                brand_organic: s.brandOrganic,
                brand_content: s.brandContent,
                is_aigc: s.isAigc,
                consent: true,
            },
        };
    },

    tiktokErrorText(code, params) {
        switch (code) {
            case 'tooLong': return t('posts.tiktok.direct.tooLong', params);
            case 'privacyRequired': return t('posts.tiktok.direct.privacyRequired');
            case 'privacyUnavailable': return t('posts.tiktok.direct.privacyUnavailable');
            case 'unauditedPrivate': return t('posts.tiktok.direct.unauditedPrivate');
            case 'discloseChoose': return t('posts.tiktok.direct.discloseChoose');
            case 'brandedPrivate': return t('posts.tiktok.direct.brandedPrivate');
            case 'consentRequired': return t('posts.tiktok.direct.consentRequired');
            default: return t('posts.tiktok.direct.notReady');
        }
    },

    /** The panel's view model, from whatever the open modal currently holds. */
    tiktokView() {
        const info = this.tiktokCreator;
        const data = info && info.status === 'ready' && info.data ? info.data : {};
        const c = this.tiktok && this.tiktok.connection;
        return this.tiktokDirectState(data.creator || null, this._ttChoices, {
            audited: typeof data.audited === 'boolean' ? data.audited : !!(c && c.audited === true),
            durationSec: this._ttDurationSec,
        });
    },

    /** Is the live creator info in, in direct mode, with a creator to post as? */
    tiktokCreatorUsable() {
        const info = this.tiktokCreator;
        return !!(info && info.status === 'ready' && info.data
            && info.data.postMode === 'direct' && info.data.creator);
    },

    /** The panel body for whichever state the creator-info request is in. */
    renderTikTokDirect() {
        const info = this.tiktokCreator;
        if (!info || info.status === 'loading') {
            return html`
                <p class="tiktok-loading" role="status">
                    <span class="spinner spinner-sm" aria-hidden="true"></span>
                    <span>${t('posts.tiktok.direct.loading')}</span>
                </p>
            `;
        }
        if (info.status === 'error') {
            return this.tiktokCreatorError((info.error && info.error.message) || t('error.unexpected'));
        }
        const data = info.data || {};
        // The live answer can disagree with the page-load summary (the mode was
        // switched in Settings since). Inbox it is, then: no options, the old panel.
        if (data.postMode !== 'direct') return this.tiktokInboxBody();
        if (!data.creator) return this.tiktokCreatorError(t('posts.tiktok.direct.noCreator'));
        return this.tiktokDirectForm(this.tiktokView());
    },

    /** A 409 (not connected) or 502 (TikTok refused), with a way to ask again. */
    tiktokCreatorError(message) {
        return html`
            <div class="inline-error" role="alert">
                <i data-lucide="alert-circle" aria-hidden="true"></i>
                <div>
                    <strong dir="auto">${t('posts.tiktok.direct.loadFailed', { message })}</strong>
                    <span class="inline-error-hint">${t('posts.tiktok.direct.loadFailedHint')}</span>
                </div>
            </div>
            <div>
                ${UI.button({
                    variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'),
                    action: 'posts:retryTikTokCreator', id: 'tiktok-creator-retry',
                })}
            </div>
        `;
    },

    /**
     * A switch with its label, and — when TikTok has it switched off for this
     * account — greyed out with the reason beside it rather than hidden.
     */
    tiktokSwitch(id, label, state) {
        const s = state || {};
        const note = s.disabled ? (s.note || t('posts.tiktok.direct.interactionOff')) : (s.hint || '');
        const noteId = `${id}-note`;
        return html`
            <div class="switch-row tiktok-switch ${s.disabled ? html.raw('is-disabled') : ''}">
                <label class="switch" for="${id}">
                    <span class="sr-only">${label}</span>
                    <input type="checkbox" id="${id}" data-change="posts:tiktokChange"
                           ${s.checked ? html.raw('checked') : ''}
                           ${s.disabled ? html.raw('disabled') : ''}
                           ${note ? html`aria-describedby="${noteId}"` : ''}>
                    <span class="switch-track"></span>
                </label>
                <span class="switch-text">
                    <span class="switch-label">${label}</span>
                    ${note ? html`<span class="form-hint" id="${noteId}">${note}</span>` : ''}
                </span>
            </div>
        `;
    },

    /** A checkbox with a visible label, an always-on hint and an optional reason it is disabled. */
    tiktokCheck(id, label, state) {
        const s = state || {};
        const described = [s.hint ? `${id}-hint` : '', s.note ? `${id}-note` : ''].filter(Boolean).join(' ');
        return html`
            <div class="check-row ${s.disabled ? html.raw('is-disabled') : ''}">
                <input type="checkbox" id="${id}" data-change="posts:tiktokChange"
                       ${s.checked ? html.raw('checked') : ''}
                       ${s.disabled ? html.raw('disabled') : ''}
                       ${s.required ? html.raw('required') : ''}
                       ${described ? html`aria-describedby="${described}"` : ''}>
                <span class="check-text">
                    <label class="check-label" for="${id}">${label}</label>
                    ${s.hint ? html`<span class="form-hint" id="${id}-hint">${s.hint}</span>` : ''}
                    ${s.note ? html`<span class="form-hint text-warning" id="${id}-note">${s.note}</span>` : ''}
                </span>
            </div>
        `;
    },

    /**
     * The Direct Post controls, in the order TikTok's guidelines list them:
     * the account, the length limit, privacy, interactions, commercial
     * disclosure, the AI label. Consent and the declaration sit by the submit
     * button instead — see `tiktokConsentBlock`.
     */
    tiktokDirectForm(v) {
        const avatar = safeUrl(v.avatarUrl);
        let brandedNote = '';
        if (v.brandContentReason === 'unaudited') brandedNote = t('posts.tiktok.direct.brandedUnaudited');
        else if (v.brandContentReason === 'private') brandedNote = t('posts.tiktok.direct.brandedPrivate');

        return html`
            <p class="tiktok-account">
                ${avatar
                    ? html`<img class="tiktok-avatar" src="${avatar}" alt="" width="24" height="24">`
                    : html`<i data-lucide="music-2" aria-hidden="true"></i>`}
                <span>${t('posts.tiktok.direct.postingTo')}</span>
                <strong dir="auto">${v.nickname || t('settings.tiktok.unnamed')}</strong>
                ${v.username ? html`<span class="text-meta">${UI.ltr(`@${v.username}`)}</span>` : ''}
            </p>
            <p class="form-hint">${t('posts.tiktok.direct.explainer')}</p>

            ${v.audited ? '' : html`
                <p class="tiktok-note">
                    <i data-lucide="info" aria-hidden="true"></i>
                    <span>${t('posts.tiktok.direct.unaudited')}</span>
                </p>
            `}

            ${v.maxDurationSec ? html`
                <p class="form-hint ${v.tooLong ? html.raw('text-warning') : ''}" id="tiktok-duration-note">
                    ${v.tooLong
                        ? t('posts.tiktok.direct.tooLong', {
                            duration: this.formatDuration(v.durationSec), max: this.formatDuration(v.maxDurationSec),
                        })
                        : t('posts.tiktok.direct.maxDuration', { max: this.formatDuration(v.maxDurationSec) })}
                </p>
            ` : ''}

            <div class="tiktok-field">
                <label class="form-label" for="tiktok-privacy">${t('posts.tiktok.direct.privacy')}</label>
                <!-- No default, by TikTok's rule: the empty option is the
                     starting state and "required" refuses it. -->
                <select class="select" id="tiktok-privacy" data-change="posts:tiktokChange" required
                        ${v.selfOnlyBlocked ? html.raw('aria-describedby="tiktok-privacy-hint"') : ''}>
                    <option value="" ${v.privacy ? '' : html.raw('selected')}>${t('posts.tiktok.direct.privacyPlaceholder')}</option>
                    ${v.privacyOptions.map((o) => html`
                        <option value="${o.value}"
                                ${o.value === v.privacy ? html.raw('selected') : ''}
                                ${o.disabled ? html.raw('disabled') : ''}>${this.privacyLabel(o.value)}</option>
                    `)}
                </select>
                ${v.selfOnlyBlocked ? html`
                    <p class="form-hint" id="tiktok-privacy-hint">${t('posts.tiktok.direct.privateBlockedByBranded')}</p>
                ` : ''}
            </div>

            <p class="tiktok-subhead">${t('posts.tiktok.direct.interactions')}</p>
            ${this.tiktokSwitch('tiktok-allow-comment', t('posts.tiktok.direct.allowComment'), v.comment)}
            ${this.tiktokSwitch('tiktok-allow-duet', t('posts.tiktok.direct.allowDuet'), v.duet)}
            ${this.tiktokSwitch('tiktok-allow-stitch', t('posts.tiktok.direct.allowStitch'), v.stitch)}

            <p class="tiktok-subhead">${t('posts.tiktok.direct.disclosureTitle')}</p>
            ${this.tiktokSwitch('tiktok-disclose', t('posts.tiktok.direct.disclose'), {
                checked: v.disclose, hint: t('posts.tiktok.direct.discloseHint'),
            })}
            ${v.disclose ? html`
                <div class="tiktok-disclosure" role="group" aria-label="${t('posts.tiktok.direct.disclose')}">
                    ${this.tiktokCheck('tiktok-brand-organic', t('posts.tiktok.direct.yourBrand'), {
                        checked: v.brandOrganic, hint: t('posts.tiktok.direct.yourBrandHint'),
                    })}
                    ${this.tiktokCheck('tiktok-brand-content', t('posts.tiktok.direct.brandedContent'), {
                        checked: v.brandContent, disabled: v.brandContentDisabled,
                        hint: t('posts.tiktok.direct.brandedContentHint'), note: brandedNote,
                    })}
                    ${v.needsDisclosureChoice ? html`
                        <p class="form-hint text-warning" id="tiktok-disclose-choose">
                            <i data-lucide="alert-triangle" aria-hidden="true"></i>
                            ${t('posts.tiktok.direct.discloseChoose')}
                        </p>
                    ` : ''}
                    ${v.label ? html`
                        <p class="tiktok-label-preview">
                            ${v.label === 'paid' ? t('posts.tiktok.direct.labelPaid') : t('posts.tiktok.direct.labelPromotional')}
                        </p>
                    ` : ''}
                </div>
            ` : ''}

            ${this.tiktokSwitch('tiktok-aigc', t('posts.tiktok.direct.aigc'), { checked: v.isAigc })}
        `;
    },

    /**
     * "By posting, you agree to …", with the policy names as links. `t()` never
     * returns markup, so the sentence carries `{music}` / `{policy}` tokens and
     * the anchors are built here, around the translated link text.
     */
    tiktokDeclaration(kind) {
        const sentence = kind === 'branded'
            ? t('posts.tiktok.declaration.branded')
            : t('posts.tiktok.declaration.music');
        const text = {
            music: t('posts.tiktok.declaration.musicLink'),
            policy: t('posts.tiktok.declaration.policyLink'),
        };
        const parts = String(sentence).split(/(\{\w+\})/).map((part) => {
            const m = part.match(/^\{(\w+)\}$/);
            if (m && Object.prototype.hasOwnProperty.call(this.TIKTOK_LEGAL_LINKS, m[1])) {
                return html`<a href="${this.TIKTOK_LEGAL_LINKS[m[1]]}" target="_blank" rel="noopener noreferrer">${text[m[1]]}</a>`;
            }
            return part;
        });
        return html`${parts}`;
    },

    /** Express consent, then the declaration — the last thing above the submit button. */
    tiktokConsentBlock(v) {
        return html`
            ${this.tiktokCheck('tiktok-consent-check', t('posts.tiktok.direct.consent'), {
                checked: v.consent, required: true,
            })}
            <p class="tiktok-declaration" id="tiktok-declaration">${this.tiktokDeclaration(v.declaration)}</p>
        `;
    },

    /** '' unless the Direct Post form is actually on screen. */
    renderTikTokConsent() {
        return this.tiktokCreatorUsable() ? this.tiktokConsentBlock(this.tiktokView()) : '';
    },

    /** Does the open composer currently send anything to TikTok? */
    composerTargetsTikTok() {
        const platformSelect = document.getElementById('post-platform-select');
        const also = document.getElementById('post-also-tiktok');
        return (platformSelect && platformSelect.value === 'tiktok')
            || !!(also && also.checked && !also.disabled);
    },

    /** Fresh per modal: nothing chosen, nothing fetched, no duration measured. */
    resetTikTokComposer(post) {
        this._ttSeq++;
        this.tiktokCreator = null;
        this._ttDurationSec = null;
        this._ttDelivery = post && post.platform === 'tiktok' ? this.tiktokRowMode(post) : '';
        this._ttChoices = post && post.platform === 'tiktok'
            ? this.tiktokChoicesFrom(post.platform_options)
            : { ...this.TIKTOK_DEFAULT_CHOICES };
    },

    /**
     * GET /tiktok/creator-info, once per modal (Retry forces another). Only in
     * direct mode — inbox mode needs nothing from it, and a failure there would
     * put an error in front of a panel that has no use for the answer.
     */
    async loadTikTokCreator(force) {
        const current = this.tiktokCreator;
        if (!force && current && (current.status === 'loading' || current.status === 'ready')) return;
        const seq = ++this._ttSeq;
        this.tiktokCreator = { status: 'loading' };
        this.refreshTikTokDirect();

        let next;
        try {
            const data = await API.getTikTokCreatorInfo();
            next = { status: 'ready', data: data || {} };
        } catch (err) {
            next = { status: 'error', error: err };
        }
        // A modal closed or reopened meanwhile has its own request.
        if (seq !== this._ttSeq) return;
        this.tiktokCreator = next;
        this.refreshTikTokDirect();
    },

    /** Read the panel's controls. A control not on screen keeps its last value. */
    readTikTokChoices(prev) {
        const p = { ...this.TIKTOK_DEFAULT_CHOICES, ...(prev || {}) };
        const checked = (id, key) => {
            const el = document.getElementById(id);
            return el ? !!el.checked : !!p[key];
        };
        const privacy = document.getElementById('tiktok-privacy');
        const next = {
            privacy_level: privacy ? String(privacy.value || '') : p.privacy_level,
            allow_comment: checked('tiktok-allow-comment', 'allow_comment'),
            allow_duet: checked('tiktok-allow-duet', 'allow_duet'),
            allow_stitch: checked('tiktok-allow-stitch', 'allow_stitch'),
            disclose: checked('tiktok-disclose', 'disclose'),
            brand_organic: checked('tiktok-brand-organic', 'brand_organic'),
            brand_content: checked('tiktok-brand-content', 'brand_content'),
            is_aigc: checked('tiktok-aigc', 'is_aigc'),
            consent: checked('tiktok-consent-check', 'consent'),
        };
        // Switching disclosure off clears both ticks. Otherwise a stale
        // "Branded content" would come back with the switch and silently
        // un-select an "Only me" chosen in between.
        if (!next.disclose) {
            next.brand_organic = false;
            next.brand_content = false;
        }
        return next;
    },

    onTikTokChange() {
        this._ttChoices = this.readTikTokChoices(this._ttChoices);
        this.refreshTikTokDirect();
    },

    /**
     * Repaint the Direct Post panel and the consent block from state. Neither
     * holds a control while TikTok is not a target: a `required` field inside a
     * hidden panel would block an Instagram-only submit with an error pointing
     * at nothing.
     */
    refreshTikTokDirect() {
        const host = document.getElementById('tiktok-direct');
        const consent = document.getElementById('tiktok-consent');
        if (!host && !consent) return;
        // Only a DIRECT post has controls here; a draft is finished in TikTok's own editor.
        const on = this.composerTargetsTikTok() && this.tiktokEffectiveMode() === 'direct';

        // Every control here has an id, so focus is put back by id.
        const active = document.activeElement;
        const inside = active && ((host && host.contains(active)) || (consent && consent.contains(active)));
        const focusId = inside ? active.id : '';

        if (host) {
            host.innerHTML = esc(on ? this.renderTikTokDirect() : '');
            UI.icons(host);
        }
        if (consent) {
            const markup = esc(on ? this.renderTikTokConsent() : '');
            consent.innerHTML = markup;
            consent.classList.toggle('hidden', !markup.trim());
            UI.icons(consent);
        }

        if (focusId) {
            const el = document.getElementById(focusId);
            if (el && !el.disabled && typeof el.focus === 'function') el.focus({ preventScroll: true });
        }
    },

    /**
     * The video's length comes from the preview `<video>` the composer already
     * shows. `loadedmetadata` does not bubble, so it is caught in the capture
     * phase on the container, which outlives every preview swapped into it.
     */
    watchPreviewDuration() {
        const preview = document.getElementById('media-preview-container');
        if (!preview) return;
        preview.addEventListener('loadedmetadata', (e) => this.onPreviewMetadata(e.target), true);
        preview.addEventListener('error', (e) => {
            if (e.target && e.target.tagName === 'VIDEO') this.setPreviewDuration(null);
        }, true);
        const video = preview.querySelector('video');
        if (video && video.readyState >= 1) this.onPreviewMetadata(video);
    },

    onPreviewMetadata(video) {
        if (!video || video.tagName !== 'VIDEO' || !video.isConnected) return;
        this.setPreviewDuration(video.duration);
    },

    setPreviewDuration(seconds) {
        const d = Number(seconds);
        const next = Number.isFinite(d) && d > 0 ? d : null;
        // Repaint only on a real change: this runs on every debounced URL
        // keystroke, and a repaint closes a privacy dropdown the operator has open.
        if (next === this._ttDurationSec) return;
        this._ttDurationSec = next;
        this.refreshTikTokDirect();
    },

    /**
     * Adds `tiktok_options` when the post goes to TikTok in direct mode, or
     * says why it cannot go yet. Inbox mode sends nothing extra, as before.
     *
     * @returns {{ message: string, field: string|null }|null} null when the payload is good to send
     */
    attachTikTokOptions(payload) {
        const toTikTok = payload.platform === 'tiktok' || payload.also_tiktok === true;
        if (!toTikTok) return null;
        if (this.tiktokOffersChoice()) {
            if (!this._ttDelivery) return { message: t('posts.tiktok.delivery.required'), field: 'tiktok-delivery-direct' };
            if (this._ttDelivery === 'inbox') {
                payload.tiktok_options = { mode: 'inbox' };
                return null;
            }
        } else if (this.tiktokPostMode() !== 'direct') {
            return null;
        }

        const info = this.tiktokCreator;
        if (!info || info.status !== 'ready') return { message: t('posts.tiktok.direct.notReady'), field: null };
        this._ttChoices = this.readTikTokChoices(this._ttChoices);
        const view = this.tiktokView();
        const result = this.validateTikTokOptions(info.data.creator || null, this._ttChoices, {
            audited: view.audited, durationSec: this._ttDurationSec,
        });
        if (!result.ok) return { message: result.message, field: result.field };
        payload.tiktok_options = { ...result.options, mode: 'direct' };
        return null;
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
                            ? html`<video src="${mediaUrl}" muted controls preload="metadata" aria-label="${t('posts.mediaPreview')}"></video>`
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
     * The scheduling block. `scheduleNoteText()` is recomputed on every change
     * of the time field, so the operator watches the answer stay on the same
     * 00:00 UTC run while they nudge the minutes — which is the point: seeing
     * it NOT move is what teaches that the minute is not what counts.
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

    /**
     * ── IS THERE A FREQUENT PUBLISH SWEEP? MEASURE, DO NOT READ. ──
     *
     * `publishDuePosts()` has exactly two callers (`src/routes/api.ts:352` and
     * `:714`). The first is inside `GET /api/jobs/drain`, which only the GitHub
     * Actions schedule calls; the second is inside `GET /api/cron/publish`,
     * which is the Vercel cron — once a day at 00:00 UTC, a Hobby-plan limit.
     * `drainInline()` runs after every webhook but drains the JOB QUEUE only; it
     * does not publish posts. So if the GitHub schedule is not running, the
     * daily cron is the only thing that publishes anything.
     *
     * It is not running. Measured 2026-09-22:
     *
     *     $ gh run list --workflow=drain.yml
     *     11:32:21Z  workflow_dispatch  success   <- the only green run, ever
     *     09:51:08Z  schedule           failure
     *     05:05:12Z  schedule           failure
     *     00:18:36Z  schedule           failure
     *     21:49:25Z  schedule           failure   (2026-09-21)
     *
     * Five runs in the workflow's whole history. Every `schedule` run has
     * failed, they landed 2.5-5 hours apart rather than every five minutes, and
     * in the 117 minutes after `CRON_SECRET` was finally set — which fixed the
     * failures — not one scheduled run fired, against ~23 expected at a
     * five-minute cron. The single success is a manual `workflow_dispatch`.
     * That proves the endpoint and the secret; it does not prove the schedule.
     *
     * This constant was briefly `true`, on the strength of FLOWS.md §3.2 and
     * `drain.yml`'s own header saying "every ~5-15 minutes". Both describe the
     * INTENT. Reading intent as behaviour put "publishes within ~15 minutes" in
     * front of an operator whose post would not go out until the next midnight
     * — wrong by up to 24 hours in the direction where someone schedules an
     * evening post, watches the window lapse, and concludes the product is
     * broken. The conservative answer being wrong costs an early publish; the
     * optimistic one costs trust.
     *
     * ── TO FLIP THIS, CHECK ONE OF THESE FIRST ──
     *
     *   1. `gh run list --workflow=drain.yml` shows a green row whose trigger is
     *      literally `schedule` (not `workflow_dispatch` — a manual run proves
     *      only that someone pressed the button).
     *   2. `heroku ps:scale worker=1 -a autoreply-pro-worker` has been run; the
     *      dyno polls the same endpoint every 60s. It is at 0 today. Confirm
     *      with `heroku ps -a autoreply-pro-worker`.
     *
     * Either one makes the frequent figure correct. Then this is a one-line
     * change: set it to `true`. `publishWindow()` and the copy already carry
     * both regimes, so nothing else moves.
     */
    FREQUENT_SWEEP: true,

    /**
     * The tail on a frequent sweep, used only when `FREQUENT_SWEEP` is true.
     *
     * 5 minutes, and the figure is measured rather than quoted. The sweep that
     * actually runs is the Heroku worker (`heroku-worker/worker.mjs`), which
     * polls `GET /api/jobs/drain` — the endpoint that calls `publishDuePosts()`
     * — on a fixed 60s interval. Three probe jobs inserted straight into the
     * queue on 2026-09-22 were claimed after 15s, 26s and 61s: exactly the 0-60s
     * spread a 60s poll produces depending on where the insert lands in the
     * cycle.
     *
     * So the poll costs at most ~60s, and publishing itself costs up to ~75s
     * more when Instagram has to process a video container
     * (`instagram.ts` polls the container). ~2.5 minutes is the realistic worst
     * case; 5 minutes is double that, which is the right side to be wrong on.
     *
     * NOT 15 minutes any more. That number was the slow end of GitHub Actions'
     * "every ~5-15 minutes", and GitHub is not what runs this — its scheduled
     * runs have never once succeeded. If the worker is ever scaled back to zero
     * (`heroku ps:scale worker=0`), `FREQUENT_SWEEP` goes back to false; the
     * daily cron is the only other caller.
     */
    FREQUENT_SWEEP_LAG_MS: 5 * 60 * 1000,

    /** The tail as whole minutes, for the copy. Single source of truth with the constant above. */
    sweepLagMinutes() {
        return Math.round(this.FREQUENT_SWEEP_LAG_MS / 60000);
    },

    /**
     * When a post requested at `iso` will actually publish.
     *
     * Pure, and separated from the copy for exactly that reason: this is the
     * claim the screen makes to the operator about their own posting schedule,
     * and `src/dashboard/screens.test.ts` pins it rather than trusting a reading
     * of the template it is interpolated into.
     *
     * Two regimes, chosen by `FREQUENT_SWEEP` above:
     *
     *   - daily (today) — the Vercel cron fires at a known INSTANT, so there is
     *     no spread to express and the window collapses to a point: `until`
     *     equals `from`. `UI.nextCronRun()` computes that instant and is reused
     *     rather than reimplemented here.
     *   - frequent — the post goes out at about the requested time, with a tail.
     *
     * @param {string|Date|null} iso   the requested time
     * @param {number} [now]           epoch ms, injectable so the test has a clock
     * @returns {{ isPast: boolean, from: Date, until: Date, frequent: boolean }|null}
     */
    publishWindow(iso, now) {
        if (!iso) return null;
        const requested = iso instanceof Date ? iso : new Date(iso);
        if (Number.isNaN(requested.getTime())) return null;
        const at = typeof now === 'number' ? now : Date.now();

        // A time already past does not publish in the past: it publishes on the
        // next run, counted from NOW rather than from the requested instant.
        // Without this an overdue post claimed a moment that had already gone.
        const isPast = requested.getTime() <= at;
        const after = isPast ? new Date(at) : requested;

        if (!this.FREQUENT_SWEEP) {
            const run = UI.nextCronRun(after);
            return { isPast, from: run, until: run, frequent: false };
        }
        return {
            isPast,
            from: after,
            until: new Date(after.getTime() + this.FREQUENT_SWEEP_LAG_MS),
            frequent: true,
        };
    },

    /**
     * The window as a sentence. The ONE place a window becomes copy.
     *
     * Two callers — the note under the form field and the line on each queued
     * card — and they used to each pick their own key. They promptly diverged:
     * the note was corrected to the daily reality while the card went on
     * promising "within about 15 minutes" for the same post. That is the same
     * failure as the three hand-copied reset lists in inbox.js, so it gets the
     * same treatment.
     *
     * Four keys, not two: the regime decides which pair is used, so flipping
     * `FREQUENT_SWEEP` needs no edit here. The `isPast` split survives both —
     * "that time has already passed" is the line that stops the operator
     * waiting for something queued behind a run they have already missed.
     */
    publishWindowText(win) {
        if (!win) return '';
        const when = UI.formatDateTime(win.from);
        if (win.frequent) {
            return win.isPast
                // The number in the copy comes FROM the constant. It used to be
                // written into the translation string, so changing the tail left
                // the screen quoting the old figure.
                ? t('posts.schedule.pastExpected', { minutes: this.sweepLagMinutes() })
                : t('posts.schedule.expected', { when, minutes: this.sweepLagMinutes() });
        }
        return win.isPast
            ? t('posts.schedule.pastExpectedDaily', { when })
            : t('posts.schedule.expectedDaily', { when });
    },

    scheduleNoteText(localValue) {
        return this.publishWindowText(this.publishWindow(UI.fromLocalInputValue(localValue)));
    },

    refreshScheduleNote() {
        const input = document.getElementById('post-scheduled-time');
        const note = document.getElementById('schedule-actual');
        if (!input || !note) return;
        const window = this.publishWindow(UI.fromLocalInputValue(input.value));
        note.textContent = this.scheduleNoteText(input.value);
        note.classList.toggle('is-warning', !!(window && window.isPast));
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
        this.resetTikTokComposer(null);

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
                        <option value="tiktok">${t('common.tiktokOnly')}</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="post-type-select">${t('posts.type')}</label>
                    <select class="select" name="post_type" id="post-type-select" data-change="posts:handleTypeChange" required>
                        ${this.typeOptions('instagram', 'image')}
                    </select>
                </div>
                ${this.tiktokFields(true)}
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
                ${this.tiktokConsentHost()}
                <div class="modal-actions">
                    ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                    ${UI.button({
                        variant: 'primary', type: 'submit', icon: 'plus',
                        label: t('posts.scheduleBtn'), id: 'schedule-submit-btn',
                    })}
                </div>
            </form>
        `);

        // Apply the platform/type matrix on open — it used to run only on change,
        // so a Facebook post could show Instagram-only types until you touched it.
        this._uploadsInFlight = 0;
        this.watchPreviewDuration();
        this.applyPlatformMatrix();
    },

    /**
     * Where Direct Post's consent box and "By posting, you agree to …" go:
     * immediately above the submit button, which is where TikTok wants the
     * declaration read. Empty (and hidden) unless the Direct Post form is up.
     */
    tiktokConsentHost() {
        return html`<div class="tiktok-consent hidden" id="tiktok-consent"></div>`;
    },

    showEditModal(id) {
        const post = this.posts.find((p) => p.id === id);
        if (!post) return;

        const defaultTime = UI.toLocalInputValue(post.scheduled_time);
        // 'reel' is no longer offered; map legacy rows onto 'video', which
        // publishes identically to both platforms.
        const postType = post.post_type === 'reel' ? 'video' : post.post_type;
        const platform = post.platform;
        // A TikTok row starts from the options it was saved with.
        this.resetTikTokComposer(post);

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
                        <option value="tiktok" ${platform === 'tiktok' ? html.raw('selected') : ''}>${t('common.tiktokOnly')}</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="post-type-select">${t('posts.type')}</label>
                    <select class="select" name="post_type" id="post-type-select" data-change="posts:handleTypeChange" required>
                        ${this.typeOptions(platform, postType)}
                    </select>
                </div>
                ${this.tiktokFields(false)}
                <div class="form-group">
                    <label class="form-label" for="post-caption">${t('posts.caption')}</label>
                    <textarea class="field-textarea user-content" id="post-caption" name="caption" dir="auto" lang="ar"
                              data-guard-dirty required>${post.caption || ''}</textarea>
                </div>
                ${this.mediaFields({ ...post, post_type: postType })}
                ${this.scheduleFields(defaultTime)}
                ${this.tiktokConsentHost()}
                <div class="modal-actions">
                    ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                    ${UI.button({
                        variant: 'primary', type: 'submit', icon: 'check', label: t('common.saveChanges'),
                    })}
                </div>
            </form>
        `);

        // A count left over from a modal closed mid-upload would hold this
        // form's submit button disabled with nothing on screen explaining it.
        this._uploadsInFlight = 0;
        this.watchPreviewDuration();
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

    /**
     * The cover step only makes sense for video on Instagram/Facebook — TikTok
     * picks its own cover in its editor. The TikTok switch only makes sense for
     * a video headed to Meta; the TikTok panel shows whenever TikTok is a target.
     */
    applyTypeMatrix() {
        const typeSelect = document.getElementById('post-type-select');
        const coverGroup = document.getElementById('cover-url-group');
        if (!typeSelect || !coverGroup) return;
        const platformSelect = document.getElementById('post-platform-select');
        const platform = platformSelect ? platformSelect.value : '';
        const isVideo = typeSelect.value === 'video';

        const alsoGroup = document.getElementById('tiktok-also-group');
        const also = document.getElementById('post-also-tiktok');
        const offerAlso = isVideo && platform !== 'tiktok';
        if (alsoGroup) alsoGroup.classList.toggle('hidden', !offerAlso);
        if (also && !offerAlso) also.checked = false;

        const info = document.getElementById('tiktok-info');
        const toTikTok = this.composerTargetsTikTok();
        if (info) info.classList.toggle('hidden', !toTikTok);

        // Direct Post: the creator info is fetched the moment TikTok becomes a
        // target (not at page load — it is live), and the panel follows the
        // target on and off.
        if (toTikTok && this.tiktokReady() && this.tiktokConnectionMode() === 'direct') {
            this.loadTikTokCreator();
        }
        this.refreshTikTokDirect();

        const showCover = isVideo && platform !== 'tiktok';
        coverGroup.classList.toggle('hidden', !showCover);
        if (showCover) this.refreshCoverPreview();
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
        const platform = data.get('platform');
        const payload = {
            platform,
            post_type: postType,
            caption: data.get('caption'),
            media_url: (data.get('media_url') || '').toString().trim() || null,
            cover_url: postType === 'video' && platform !== 'tiktok' && coverUrl ? coverUrl : null,
        };
        // Only the create form has the switch; FormData omits an unchecked box.
        if (data.get('also_tiktok') === 'on' && postType === 'video' && platform !== 'tiktok') {
            payload.also_tiktok = true;
        }
        return payload;
    },

    /** The TikTok row of a create response: the row itself, or its sibling in `group`. */
    tiktokRowOf(result) {
        if (!result) return null;
        if (result.platform === 'tiktok') return result;
        const group = Array.isArray(result.group) ? result.group : [];
        return group.find((row) => row && row.platform === 'tiktok') || null;
    },

    /**
     * What "published" means for TikTok, which answers asynchronously. A direct
     * post has no inbox step, and TikTok's guidelines require saying that the
     * video can take a few minutes to process before it shows on the profile.
     */
    tiktokOutcomeText(status, mode) {
        if (mode === 'direct') {
            return status === 'PUBLISHED' ? t('posts.tiktok.postedNoId') : t('posts.tiktok.direct.processingToast');
        }
        if (status === 'IN_INBOX') return t('posts.tiktok.sentToInbox');
        if (status === 'PUBLISHED') return t('posts.publishedOk');
        return t('posts.tiktok.processingToast');
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
    showFormError(message, fieldId, hint) {
        const host = document.getElementById('post-form-error');
        if (!host) return;
        const stripId = 'post-form-error-strip';
        const form = document.getElementById('post-schedule-form');
        UI.clearInvalid(form);
        // `hint` overrides the default, which describes a failed publish — not
        // true of a check that stopped the post before anything was sent.
        const note = hint === undefined ? t('posts.publishFailedHint') : hint;
        host.innerHTML = esc(UI.errorStrip(message, note, stripId));
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

        // Direct Post: nothing leaves until TikTok's rules are met.
        const blocked = this.attachTikTokOptions(payload);
        if (blocked) {
            this.showFormError(blocked.message, blocked.field, '');
            return;
        }

        // Was the one hand-rolled busy state left on this screen: no `aria-busy`,
        // and `buttonSpinner()` with no argument relabels the button "Loading",
        // so "Schedule" and "Publish now" — which `toggleScheduleTime` has just
        // been keeping accurate — both became the same meaningless word at the
        // moment the operator most needs to know which of the two they pressed.
        // `formBusy` keeps whichever label is on it and restores it exactly.
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // already in flight

        try {
            const result = await API.createScheduledPost(payload);
            const failure = publishNow ? this.publishFailure(result, null) : null;

            if (failure) {
                // "Published successfully!" on a failed publish was the single most
                // misleading message in this UI. Keep the modal open, show the real error.
                this.publishError = { message: failure };
                this.showFormError(failure);
                restore();
                await this.render();
                return;
            }

            const tiktokRow = this.tiktokRowOf(result);
            const tiktokMode = payload.tiktok_options || this.tiktokRowMode(tiktokRow) === 'direct' ? 'direct' : 'inbox';
            if (publishNow && tiktokRow && tiktokRow.status === 'FAILED') {
                // The Instagram/Facebook half went out; say plainly that TikTok did not.
                UI.toast(t('posts.tiktok.failedToast', { message: tiktokRow.error_log || t('error.unexpected') }), 'error');
            } else if (publishNow && tiktokRow) {
                UI.toast(this.tiktokOutcomeText(tiktokRow.status, tiktokMode));
            } else if (!publishNow && payload.tiktok_options) {
                UI.toast(t('posts.tiktok.direct.scheduledToast'));
            } else {
                UI.toast(publishNow ? t('posts.publishedOk') : t('posts.scheduledOk'));
            }
            // render() first, close after: closing first restored focus to the
            // "New post" button and the re-render then destroyed it, leaving
            // focus on a control inside the hidden overlay.
            await this.render();
            UI.closeModal();
        } catch (err) {
            const failure = this.publishFailure(null, err);
            if (publishNow) this.publishError = { message: failure };
            this.showFormError(failure);
            restore();
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
        const blocked = this.attachTikTokOptions(payload);
        if (blocked) {
            this.showFormError(blocked.message, blocked.field, '');
            return;
        }

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

            const direct = this.tiktokRowMode(result) === 'direct' || this.tiktokRowMode(post) === 'direct';
            UI.toast(result && result.platform === 'tiktok'
                ? this.tiktokOutcomeText(result.status, direct ? 'direct' : 'inbox')
                : t('posts.publishedOk'));
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
    /**
     * How many uploads are in flight for the open modal.
     *
     * An upload is a `FileReader` pass plus a base64 POST of up to 3.2MB, which
     * on a phone connection is not instant — and nothing stopped the operator
     * submitting the form in the middle of it. The best case was the browser's
     * own "please fill out this field" bubble on a media URL that was seconds
     * from arriving; the worse case, on a Facebook text post where media is not
     * required, was a post scheduled with no media at all while the progress
     * spinner was still turning.
     *
     * A count rather than a flag because the media file and the cover file are
     * two independent inputs that can both be uploading at once, and the first
     * to finish must not unlock the form while the second is still going.
     */
    _uploadsInFlight: 0,

    /**
     * Hold the submit button while media is uploading, and say why.
     *
     * Not `UI.formBusy`: this is not a submission in flight, the button must
     * come back to its own label rather than a spinner, and `formBusy`'s
     * already-in-flight contract would fight the counter.
     */
    setUploadBusy(delta) {
        this._uploadsInFlight = Math.max(0, this._uploadsInFlight + delta);
        const form = document.getElementById('post-schedule-form');
        const btn = form && form.querySelector('button[type="submit"]');
        if (!btn) return;
        const busy = this._uploadsInFlight > 0;
        btn.disabled = busy;
        if (busy) btn.setAttribute('title', t('posts.uploadWaitHint'));
        else btn.removeAttribute('title');
    },

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
        this.setUploadBusy(1);

        const done = () => {
            if (progress) progress.classList.remove('is-active');
            this.setUploadBusy(-1);
        };

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const res = await API.uploadMedia({
                    filename: file.name,
                    mime_type: file.type,
                    base64_data: e.target.result,
                });

                // The modal can be closed mid-upload, which detaches this input
                // — writing the URL into it then loses the upload silently and
                // the toast claims success for a field nobody will ever see.
                if (!urlInput || !urlInput.isConnected) {
                    done();
                    return;
                }
                urlInput.value = res.url;
                done();

                if (target === 'media') this.showMediaPreview(res.url, file.type.startsWith('video/'));
                this.refreshCoverPreview();
                UI.toast(t('posts.uploadDone'));
            } catch (err) {
                UI.toast(t('posts.uploadFailed', { message: err.message }), 'error');
                done();
                input.value = '';
            }
        };
        reader.onerror = () => {
            UI.toast(t('posts.readFailed'), 'error');
            done();
            input.value = '';
        };
        reader.readAsDataURL(file);
    },

    showMediaPreview(url, isVideo) {
        const preview = document.getElementById('media-preview-container');
        if (!preview) return;
        // A different file: the old length no longer applies. The new
        // <video>'s `loadedmetadata` (see watchPreviewDuration) sets it again.
        this.setPreviewDuration(null);
        const clean = safeUrl(url);
        if (!clean) {
            preview.classList.remove('is-visible');
            preview.innerHTML = '';
            return;
        }
        preview.classList.add('is-visible');
        preview.innerHTML = esc(isVideo
            ? html`<video src="${clean}" muted controls preload="metadata" aria-label="${t('posts.mediaPreview')}"></video>`
            : html`<img src="${clean}" alt="${t('posts.mediaPreview')}">`);
    },

    handleUrlInput(input) {
        const value = input.value;
        if (!value) {
            const preview = document.getElementById('media-preview-container');
            if (preview) { preview.classList.remove('is-visible'); preview.innerHTML = ''; }
            this.setPreviewDuration(null);
            this.refreshCoverPreview();
            return;
        }
        // A typed URL with no extension (our own /api/uploads/<id>) used to
        // preview as an <img>. When the post IS a video, preview it as one, so
        // its length can be read for TikTok's duration limit.
        const typeSelect = document.getElementById('post-type-select');
        const asVideo = (typeSelect && typeSelect.value === 'video')
            || /\.(mp4|mov|avi|wmv|m4v|webm)(\?|$)/i.test(value);
        this.showMediaPreview(value, asVideo);
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
    tiktokChange: () => PostsPage.onTikTokChange(),
    tiktokDelivery: (el) => PostsPage.onTikTokDelivery(el),
    retryTikTokCreator: () => PostsPage.loadTikTokCreator(true),
});
