/**
 * Growth & SEO hub — `#/growth`, the contract is GROWTH.md §3 and §5.
 *
 * "We don't have enough views or interactions" is the question this page answers, in three
 * moves: MEASURE what each post does (KPIs, trend, the posts table, best times, by type),
 * EXPLAIN it (the AI Growth Coach), and give the levers the platforms actually offer (the SEO
 * tools: keywords, hashtag sets, competitors).
 *
 * ─── Why a page of its own, after Analytics, rather than inside it ──────────
 * Analytics answers "is the AUTOMATION working" — comments matched, DMs sent, from this app's
 * own logs, and it needs no extra permission. This page answers "is the CONTENT growing" — reach,
 * views, saves — from Meta's insights, which need `instagram_manage_insights` / `read_insights`
 * and are missing on most tokens today. Merged, a permission banner would sit on top of numbers
 * that are fine, and the SEO tools and the coach are not analytics at all. Next to each other in
 * the nav, so the two "how am I doing" screens are one step apart.
 *
 * ─── Two views, one route ───────────────────────────────────────────────────
 * `#/growth` is Performance and `#/growth?tab=seo` is SEO & reach. Both are links, so the tab
 * survives a reload, and switching repaints from what is already loaded (`onHashChange`)
 * instead of fetching everything again.
 *
 * ─── Nothing is faked ───────────────────────────────────────────────────────
 * The API returns null for anything it could not measure (no permission, not synced, not
 * offered for this account). Every null renders as "—" with the reason beside it, never as 0:
 * a zero is a claim that the post was seen by nobody. DESIGN.md §6 rules out invented metrics.
 *
 * ─── Units the contract leaves open, pinned here ────────────────────────────
 *   - `engagement_rate` (KPI, PostInsight) and `by_type[].avg_engagement` are read as a RATIO
 *     (0.042 = 4.2%), always: the server computes interactions / reach. On a tiny reach a ratio can
 *     pass 1 (6 interactions on 5 accounts is 120%), so nothing above 1 is reinterpreted.
 *   - Best times are built HERE from our own posts, in the tenant's time zone
 *     (`postsHeatGrid`, then `daypartCells`): Instagram's online_followers is empty for small
 *     accounts, and a grid whose zone is not in the contract cannot be labelled with local hours
 *     honestly. The server's `best_times` is the fallback when the posts list fails, read as
 *     `[weekday 0 = Sunday][hour]` averages in `best_times_meta.timezone` (UTC when it names
 *     none), weighted by `best_times_meta.counts`.
 *   - A KPI's direction ("↑ 12% vs the previous 28 days") is `overview.previous`, the server's
 *     total for the window before — only views, reach, saves and shares, and only where the
 *     server could compare exactly. Nothing here derives one.
 *   - Under 100 followers Instagram withholds the daily follower series and its change. That is
 *     a calm note ("after 100 followers"), never an error or an empty chart.
 *   - Watch time is `metrics.avg_watch_time_ms` (or Meta's `ig_reels_avg_watch_time`), in ms.
 *   - Reach by follow_type is `overview.audience_split.reach` ({ followers, non_followers }),
 *     Instagram's FOLLOWER / NON_FOLLOWER split over the window — see `followSplit`.
 *   - The coach's `post_notes` ({ media_id, note }) are the Posts table's "why it worked" line.
 *
 * ─── The coach keeps going when you leave ───────────────────────────────────
 * POST /coach is one request that can take most of a minute. It belongs to this object, not to
 * the DOM, exactly like the Studio's generation: leave the page and come back, and the stages
 * are still moving; the answer lands wherever the operator is, and is kept for this tenant in
 * this browser so tomorrow's visit still shows it.
 */
const GrowthPage = {
    RANGES: Object.freeze([7, 28, 90]),
    DEFAULT_DAYS: 28,
    PREFS_KEY: 'growth:prefs',
    COACH_KEY_PREFIX: 'growth:coach:',
    /** A stored coach answer older than this is not shown as current. */
    COACH_KEEP_MS: 7 * 24 * 60 * 60 * 1000,
    /** POST /growth/sync is rate-limited to once per ten minutes per tenant (GROWTH.md §2). */
    SYNC_COOLDOWN_MS: 10 * 60 * 1000,
    POSTS_PAGE: 25,
    KEYWORDS_MAX: 30,
    KEYWORD_MAX_LEN: 60,
    SETS_MAX: 12,
    SET_NAME_MAX: 40,
    SET_TAGS_MAX: 30,
    /** What the Help article and the set editor advise: 3–5 specific hashtags. */
    SET_TAGS_ADVISED: 5,
    COMPETITORS_MAX: 10,
    USERNAME_RE: /^[a-z0-9._]{1,30}$/,
    TREND_METRICS: Object.freeze(['views', 'reach', 'followers']),
    SORT_KEYS: Object.freeze(['published_at', 'views', 'reach', 'likes', 'comments', 'saved', 'shares', 'avg_watch', 'skip_rate', 'engagement_rate']),
    /**
     * Instagram shares follower_count (the daily followers line), follows_and_unfollows (the
     * change) and the audience breakdowns only once an account has 100 followers. Below that
     * they are null by design, not an error, and are said to be so calmly.
     */
    SMALL_ACCOUNT_FOLLOWERS: 100,
    /**
     * The skip rate's bands (% of views gone in the first 3 s — the hook's own number): above
     * 70 most viewers are lost before the hook lands, from 50 half of them. Overview restates
     * them, because this module is lazily loaded.
     */
    SKIP_DANGER_ABOVE: 70,
    SKIP_WARNING_FROM: 50,
    /** "Last synced" turns amber past one missed daily sync, red past two (GROWTH.md §2). */
    SYNC_WARN_MS: 26 * 60 * 60 * 1000,
    SYNC_STALE_MS: 50 * 60 * 60 * 1000,
    /** A goal is a whole number of followers or views; the server refuses anything above this. */
    GOAL_MAX: 1000000000,
    GOAL_KEYS: Object.freeze(['followers', 'views']),
    TYPE_KEYS: Object.freeze(['reel', 'carousel', 'image', 'video', 'other']),
    PLATFORM_KEYS: Object.freeze(['instagram', 'facebook', 'tiktok']),
    /** Sunday first: the Saudi week and the US one agree, and so do both of this page's locales. */
    DAY_ORDER: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
    /**
     * What the coach is doing, told by the clock: POST /coach is one synchronous request, so
     * the server cannot report stages. The copy says "usually", like the Studio's.
     */
    COACH_STAGES: Object.freeze(['read', 'compare', 'write']),
    COACH_STAGE_AT: Object.freeze([0, 5, 15]),
    COACH_SLOW_S: 75,

    // ─── State ───────────────────────────────────────────────────────────────
    status: null,
    statusError: null,
    overview: null,
    overviewError: null,
    posts: [],
    postsLoaded: false,
    postsError: null,
    /**
     * G7: the reads still out, by source. A region paints the moment the reads it needs have
     * landed — never waiting for the slowest of the four — and until then shows its skeleton, or
     * keeps the previous answer on screen, dimmed and aria-busy (G6).
     */
    pending: { status: false, overview: false, posts: false, settings: false },
    settings: null,
    settingsError: null,
    /** 'idle' | 'loading' | 'ready' | 'error' | 'missing' (Business Discovery refused). */
    competitorsState: 'idle',
    competitors: [],
    competitorsError: null,
    /** 'idle' | 'loading' | 'ready' | 'error' */
    coachState: 'idle',
    coach: null,
    coachAt: null,
    coachDays: null,
    coachError: null,
    coachStartedAt: 0,
    coachStage: 0,
    days: null,
    trendMetric: 'views',
    sort: { key: 'views', dir: 'desc' },
    filter: { type: 'all', platform: 'all' },
    /** Best times: the slot `{ day, part }` whose numbers the line under the grid spells out. */
    slotPick: null,
    postsLimit: 25,
    syncing: false,
    /** `{ kind: 'error'|'cooldown', message }` under the Sync button, or null. */
    syncNote: null,
    /** Keyword ideas: `{ status: 'loading'|'ready'|'error', topic, keywords, hashtags, error }`. */
    suggest: null,
    /** The hashtag-set form: `{ index: -1 (new) | n, name, tags }`, or null when closed. */
    setEditor: null,
    /** Inline messages under the three SEO forms, by form. */
    formErrors: {},
    /**
     * What is typed in the SEO forms, so a repaint of their region never eats it. A goal draft
     * is null until the field is touched, so the field shows the saved goal until then.
     */
    drafts: { keyword: '', topic: '', competitor: '', goal_followers: null, goal_views: null },
    /** A KPI card's "Change goal" names the field to focus once the SEO view is painted. */
    _focusGoal: null,

    _seq: 0,
    /** The newest ask per source: an older answer that lands after it is dropped, never painted. */
    _srcSeq: { status: 0, overview: 0, posts: 0, settings: 0 },
    _competitorsSeq: 0,
    _tenantEpoch: 0,
    _coachTimer: null,
    _saveChain: null,

    destroy() {
        this._seq++;
        // The coach request itself keeps running: it belongs to this object. Only the
        // clock that paints its stages stops, and render() restarts it on the way back.
        this.stopCoachTicker();
    },

    /** Tenant switch: every number, post, keyword and plan here belongs to the old tenant. */
    resetTenantState() {
        this._tenantEpoch++;
        Object.keys(this._srcSeq).forEach((k) => { this._srcSeq[k]++; });
        this._competitorsSeq++;
        this.destroy();
        this.status = null;
        this.statusError = null;
        this.overview = null;
        this.overviewError = null;
        this.posts = [];
        this.postsLoaded = false;
        this.postsError = null;
        this.pending = { status: false, overview: false, posts: false, settings: false };
        this.settings = null;
        this.settingsError = null;
        this.competitorsState = 'idle';
        this.competitors = [];
        this.competitorsError = null;
        this.coachState = 'idle';
        this.coach = null;
        this.coachAt = null;
        this.coachDays = null;
        this.coachError = null;
        this.filter = { type: 'all', platform: 'all' };
        this.slotPick = null;
        this.postsLimit = this.POSTS_PAGE;
        this.syncing = false;
        this.syncNote = null;
        this.suggest = null;
        this.setEditor = null;
        this.formErrors = {};
        this.drafts = { keyword: '', topic: '', competitor: '', goal_followers: null, goal_views: null };
        this._focusGoal = null;
        this._saveChain = null;
    },

    // ─── Browser memory (every use guarded: private mode, full, refused) ─────
    storeGet(key) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    },

    storeSet(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* optional */ }
    },

    /** The range and the trend's metric, re-checked so a hand-edited entry cannot send junk. */
    prefs() {
        const p = this.storeGet(this.PREFS_KEY) || {};
        const days = Number(p.days);
        return {
            days: this.RANGES.includes(days) ? days : this.DEFAULT_DAYS,
            metric: this.TREND_METRICS.includes(p.metric) ? p.metric : 'views',
        };
    },

    savePrefs() {
        this.storeSet(this.PREFS_KEY, { days: this.days, metric: this.trendMetric });
    },

    tenantKey() {
        const id = typeof App !== 'undefined' && App.session && App.session.tenantId;
        return `${this.COACH_KEY_PREFIX}${id || 'default'}`;
    },

    // ─── Routing ─────────────────────────────────────────────────────────────
    hashValue(name) {
        if (typeof App === 'undefined' || typeof App.hashParam !== 'function') return '';
        return String(App.hashParam(name) || '');
    },

    /** 'performance' | 'seo' — the tab is the hash, so it is a link like any other. */
    view() {
        return this.hashValue('tab') === 'seo' ? 'seo' : 'performance';
    },

    alive(seq) {
        return seq === this._seq && !!document.getElementById('page-container');
    },

    /** Viewers cannot call the growth routes (session + canOperate); say so once, not six times. */
    canUse() {
        return typeof App === 'undefined' || typeof App.canOperate !== 'function' || App.canOperate();
    },

    skeleton() {
        if (this.view() === 'seo') {
            return html`
                ${Motion.toolbar()}
                ${Motion.cardGrid(3, 3)}
                ${Motion.busy()}
            `;
        }
        return html`
            ${Motion.toolbar()}
            ${Motion.statsGrid(6)}
            ${Motion.chartGrid(2)}
            ${Motion.tableCard(6, [t('growth.posts.post'), t('growth.metric.views'), t('growth.metric.reach'), t('growth.metric.engagement_rate')])}
            ${Motion.busy()}
        `;
    },

    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const seq = ++this._seq;
        this.stopCoachTicker();
        if (this.days === null) {
            const p = this.prefs();
            this.days = p.days;
            this.trendMetric = p.metric;
        }
        if (!this.canUse()) {
            container.innerHTML = esc(html`
                <div class="surface pad-5">
                    ${Admin.emptyState('lock', t('growth.viewer.title'), t('growth.viewer.body'))}
                </div>
            `);
            UI.icons(container);
            return;
        }

        // G7: the frame at once — the toolbar, and each region as its skeleton (or, on a return
        // visit, its last answer, dimmed) — then every region fills as the reads IT needs land.
        // It used to await all four, so the slowest request held back the three that had answered.
        const tenant = this._tenantEpoch;
        if (!this.coach && this.coachState === 'idle') this.restoreCoach();
        Motion.clearSkeleton(container);
        const loading = this.loadSources(['status', 'overview', 'posts', 'settings'], seq);
        this.paintPage();
        if (this.coachState === 'loading') this.startCoachTicker();
        await loading;
        if (!this.alive(seq) || tenant !== this._tenantEpoch) return;
        this.focusPendingGoal();
        Motion.announce(`${t('nav.growth')} — ${t('common.loaded')}`);
    },

    /** A tab switch inside the page: repaint from what is loaded, keep focus on the tab. */
    onHashChange() {
        const container = document.getElementById('page-container');
        // Reads still out are not "nothing": the new view's regions fill as they land (G7).
        const inFlight = Object.values(this.pending).some(Boolean);
        const nothingYet = !inFlight && !this.postsLoaded && !this.postsError && !this.settings && !this.settingsError;
        if (!container || nothingYet) {
            this.render();
            return;
        }
        this.paintPage();
        // A coach still writing keeps its clock: the card was just rebuilt on this view.
        if (this.coachState === 'loading') this.startCoachTicker();
        this.maybeLoadCompetitors();
        this.focusPendingGoal();
    },

    /** After "Change goal" on a KPI card: the field it named, once the SEO view is on screen. */
    focusPendingGoal() {
        const key = this._focusGoal;
        if (!key || this.view() !== 'seo') return;
        this._focusGoal = null;
        const input = document.getElementById(`growth-goal-${key}-input`);
        if (!input) return;
        if (typeof input.scrollIntoView === 'function') input.scrollIntoView({ block: 'center' });
        if (typeof input.focus === 'function') input.focus();
    },

    // ─── Settling responses onto state ───────────────────────────────────────
    applyStatus(result) {
        if (result.status === 'fulfilled') {
            this.status = this.normalizeStatus(result.value);
            this.statusError = null;
        } else {
            this.statusError = result.reason;
        }
    },

    applyOverview(result) {
        if (result.status === 'fulfilled') {
            this.overview = result.value && typeof result.value === 'object' ? result.value : {};
            this.overviewError = null;
        } else {
            this.overview = null;
            this.overviewError = result.reason;
        }
    },

    applyPosts(result) {
        if (result.status === 'fulfilled') {
            const v = result.value;
            const list = Array.isArray(v) ? v : v && Array.isArray(v.posts) ? v.posts : [];
            this.posts = list.filter((p) => p && typeof p === 'object');
            this.postsLoaded = true;
            this.postsError = null;
        } else {
            this.posts = [];
            this.postsLoaded = false;
            this.postsError = result.reason;
        }
        this.postsLimit = this.POSTS_PAGE;
    },

    applySettings(result) {
        if (result.status === 'fulfilled') {
            this.settings = this.normalizeSettings(result.value && result.value.settings);
            this.settingsError = null;
        } else {
            this.settingsError = result.reason;
        }
    },

    normalizeStatus(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const missing = Array.isArray(s.missing) ? s.missing.map((x) => String(x || '').trim()).filter(Boolean) : [];
        return {
            instagram: typeof s.instagram === 'string' ? s.instagram : null,
            facebook: typeof s.facebook === 'string' ? s.facebook : null,
            tiktok: typeof s.tiktok === 'string' ? s.tiktok : null,
            missing: [...new Set(missing)],
            lastSync: s.lastSync || null,
        };
    },

    /** Is Instagram (or Facebook) locked behind a permission right now? */
    locked(platform) {
        const s = this.status;
        if (!s) return false;
        if (s[platform] === 'missing_permission') return true;
        const scope = platform === 'facebook' ? 'read_insights' : 'instagram_manage_insights';
        return s.missing.includes(scope);
    },

    // ─── Loading, region by region (G7) ──────────────────────────────────────
    /** The four reads the page is made of. Overview and posts follow the range on screen. */
    request(source) {
        if (source === 'status') return API.getGrowthStatus();
        if (source === 'overview') return API.getGrowthOverview(this.days);
        if (source === 'posts') return API.getGrowthPosts(this.days, 'views');
        return API.getGrowthSettings();
    },

    apply(source, result) {
        if (source === 'status') this.applyStatus(result);
        else if (source === 'overview') this.applyOverview(result);
        else if (source === 'posts') this.applyPosts(result);
        else this.applySettings(result);
    },

    /**
     * Ask for `sources` at once and settle each onto the page the moment it lands. An answer is
     * dropped — never painted — when the page it was asked for is gone (`seq`), the tenant has
     * changed, or a newer ask for the same source is out: a range switched mid-load, a Retry, a
     * sync. The promise settles when every answer has.
     */
    loadSources(sources, seq) {
        const tenant = this._tenantEpoch;
        return Promise.all(sources.map((source) => {
            const ask = ++this._srcSeq[source];
            this.pending[source] = true;
            let call;
            try { call = Promise.resolve(this.request(source)); } catch (err) { call = Promise.reject(err); }
            return call.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }))
                .then((result) => {
                    if (seq !== this._seq || tenant !== this._tenantEpoch || ask !== this._srcSeq[source]) return;
                    this.pending[source] = false;
                    this.apply(source, result);
                    if (this.alive(seq)) this.landed(source);
                });
        }));
    },

    /** What each region needs before it can say anything true. The rest it reads if present. */
    NEEDS: Object.freeze({
        summary: Object.freeze(['overview']),
        types: Object.freeze(['overview']),
        best: Object.freeze(['posts', 'settings']),
        posts: Object.freeze(['posts']),
        seo: Object.freeze(['settings']),
    }),

    /** Every region that shows something from a source, so its landing repaints exactly those. */
    READS: Object.freeze({
        status: Object.freeze(['toolbar', 'banner', 'summary', 'types', 'posts', 'coach']),
        overview: Object.freeze(['summary', 'types', 'best', 'competitors']),
        posts: Object.freeze(['summary', 'best', 'posts', 'competitors']),
        settings: Object.freeze(['summary', 'best', 'seo']),
    }),

    /** Is a read this region needs still out? */
    waiting(region) {
        return (this.NEEDS[region] || []).some((source) => this.pending[source]);
    },

    /** Is there an earlier answer for this region to keep on screen while it waits (G6)? An error is not one. */
    keeps(region) {
        if (region === 'summary' || region === 'types') return !!this.overview;
        if (region === 'best' || region === 'posts') return this.postsLoaded;
        if (region === 'seo') return !!this.settings;
        return false;
    },

    /** Waiting with nothing to keep: the region's skeleton. */
    showsSkeleton(region) {
        return this.waiting(region) && !this.keeps(region);
    },

    REGION_VIEWS: Object.freeze({ summary: 'performance', types: 'performance', best: 'performance', posts: 'performance', coach: 'performance', seo: 'seo', competitors: 'seo' }),

    paintNamed(region) {
        const view = this.REGION_VIEWS[region];
        if (view && view !== this.view()) return;
        if (region === 'toolbar') this.paintRegion('growth-toolbar', this.toolbarMarkup());
        else if (region === 'banner') this.paintRegion('growth-banner', this.bannerMarkup());
        else if (region === 'summary') this.paintRegion('growth-summary', this.summaryMarkup());
        else if (region === 'types') this.paintRegion('growth-types', this.typesSectionMarkup());
        else if (region === 'best') this.paintRegion('growth-best', this.bestSectionMarkup());
        else if (region === 'posts') this.paintRegion('growth-posts', this.postsMarkup());
        else if (region === 'coach' && this.coachState !== 'loading') this.paintRegion('growth-coach', this.coachMarkup());
        else if (region === 'seo') this.paintRegion('growth-seo', this.seoMarkup());
        else if (region === 'competitors') this.paintRegion('growth-competitors', this.competitorsMarkup());
    },

    /** Is this page's frame on screen? Until it is (another page's skeleton, a bare host), there is no region to fill. */
    framed() {
        return !!document.getElementById(this.view() === 'seo' ? 'growth-seo' : 'growth-summary');
    },

    /**
     * One read landed: repaint the regions that show it and are no longer waiting on anything
     * they need. A region still waiting keeps its skeleton or its dimmed previous answer.
     */
    landed(source) {
        if (!this.framed()) {
            this.paintPage();
        } else {
            (this.READS[source] || []).forEach((region) => {
                if (!this.waiting(region)) this.paintNamed(region);
            });
            this.setBusy();
        }
        if (source === 'settings') {
            this.maybeLoadCompetitors();
            this.focusPendingGoal();
        }
    },

    /** At the start of a re-read: a skeleton where there is nothing to keep, a dimmed answer where there is. */
    paintWaiting() {
        if (!this.framed()) return;
        ['summary', 'types', 'best', 'posts', 'seo'].forEach((region) => {
            if (this.showsSkeleton(region)) this.paintNamed(region);
        });
        this.setBusy();
    },

    /** Re-read overview and posts for the current range (and the status, after a sync). */
    async reloadData(opts) {
        const o = opts || {};
        const sources = o.withStatus ? ['overview', 'posts', 'status'] : ['overview', 'posts'];
        const loading = this.loadSources(sources, this._seq);
        this.paintRegion('growth-toolbar', this.toolbarMarkup());
        this.paintWaiting();
        const tenant = this._tenantEpoch;
        const seq = this._seq;
        await loading;
        if (seq !== this._seq || tenant !== this._tenantEpoch) return;
        if (typeof Motion !== 'undefined') Motion.announce(t('growth.range.loaded', { days: this.daysText(this.days) }));
    },

    /** A region's Retry: that region's own read again, alone — the others are not asked twice. */
    retry(sources) {
        const loading = this.loadSources(sources, this._seq);
        this.paintWaiting();
        return loading;
    },

    // ─── Painting ────────────────────────────────────────────────────────────
    /**
     * An empty host that `wireErrors` fills with `UI.renderError`, so the Retry button gets a
     * real listener rather than an inline handler. Same shape as the Studio's.
     */
    errorHost(error, title, retry) {
        const options = JSON.stringify({
            title,
            message: (error && error.message) || t('error.unexpected'),
            hint: error && error.isNetworkError ? t('error.network') : error && error.status ? `HTTP ${error.status}` : '',
        });
        return html`<div data-error-host data-error-retry="${retry}" data-error-options="${options}"></div>`;
    },

    /** A region's error panel retries its own read: one of these. */
    RETRY_SOURCES: Object.freeze(['status', 'overview', 'posts', 'settings']),

    wireErrors(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        root.querySelectorAll('[data-error-host]').forEach((host) => {
            const retry = host.dataset.errorRetry;
            let options = {};
            try { options = JSON.parse(host.dataset.errorOptions || '{}'); } catch { /* the defaults */ }
            UI.renderError(host, options, () => {
                if (GrowthPage.RETRY_SOURCES.includes(retry)) GrowthPage.retry([retry]);
                else if (retry === 'competitors') GrowthPage.loadCompetitors();
                else GrowthPage.render();
            });
        });
    },

    /** Repaint one region by id, keeping the operator's focus (and caret) where it was. */
    paintRegion(id, markup) {
        const host = document.getElementById(id);
        if (!host) return null;
        const focus = UI.captureFocus(host);
        host.innerHTML = esc(markup);
        UI.icons(host);
        this.wireErrors(host);
        UI.restoreFocus(focus);
        return host;
    },

    paintPage() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const focus = UI.captureFocus(container);
        container.innerHTML = esc(this.pageMarkup());
        UI.icons(container);
        this.wireErrors(container);
        UI.restoreFocus(focus);
    },

    /**
     * G6: a range switch used to blank everything to skeletons, so the page jumped twice and the
     * operator lost the numbers they were comparing against. The old numbers stay, dimmed and
     * marked `aria-busy`, until the new ones replace them — per region since G7: the summary is
     * busy while its overview is out, the details while any of their reads are.
     */
    busyNow(host) {
        const kept = (region) => this.waiting(region) && this.keeps(region);
        if (host === 'growth-summary') return kept('summary');
        if (host === 'growth-details') return kept('best') || kept('types') || kept('posts');
        return false;
    },

    setBusy() {
        ['growth-summary', 'growth-details'].forEach((id) => {
            const host = document.getElementById(id);
            if (!host) return;
            if (this.busyNow(id)) host.setAttribute('aria-busy', 'true');
            else host.removeAttribute('aria-busy');
        });
    },

    pageMarkup() {
        const seo = this.view() === 'seo';
        return html`
            <div class="growth-page" data-view="${seo ? 'seo' : 'performance'}">
                <div class="growth-toolbar" id="growth-toolbar">${this.toolbarMarkup()}</div>
                <div id="growth-banner">${this.bannerMarkup()}</div>
                ${seo ? html`<div class="growth-seo-body" id="growth-seo">${this.seoMarkup()}</div>` : this.performanceMarkup()}
            </div>
        `;
    },

    performanceMarkup() {
        const busy = (id) => (this.busyNow(id) ? html.raw(' aria-busy="true"') : '');
        return html`
            <div id="growth-do-first">${this.doFirstMarkup()}</div>
            <div id="growth-summary"${busy('growth-summary')}>${this.summaryMarkup()}</div>
            <section class="surface pad-5 growth-coach" id="growth-coach" aria-labelledby="growth-coach-title">
                ${this.coachMarkup()}
            </section>
            <div id="growth-details"${busy('growth-details')}>${this.detailsMarkup()}</div>
        `;
    },

    /**
     * G1: the coach's first action, under the toolbar. "What should I do" used to be two screens
     * down and behind a button; the answer is already in this browser once a plan exists.
     */
    doFirstMarkup() {
        if (this.coachState !== 'ready' || !this.coach) return '';
        const first = this.prioritize(this.coach.actions)[0];
        if (!first) return '';
        return html`
            <div class="do-first" id="growth-do-first-line">
                <i data-lucide="lightbulb" aria-hidden="true"></i>
                <strong>${t('growth.doFirst')}</strong>
                <span class="do-first-text user-content" dir="auto">${first.title}</span>
                <button type="button" class="alert-link" data-action="growth:showPlan">
                    ${t('growth.doFirst.open')}
                    <i data-lucide="arrow-down" aria-hidden="true"></i>
                </button>
            </div>
        `;
    },

    /** "See the plan": to the coach card, with focus on its heading so a reader lands there too. */
    showPlan() {
        const card = document.getElementById('growth-coach');
        if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'start' });
        const title = document.getElementById('growth-coach-title');
        if (title) {
            title.setAttribute('tabindex', '-1');
            if (typeof title.focus === 'function') title.focus();
        }
    },

    // ─── Reading values ──────────────────────────────────────────────────────
    /** A number, or null for anything the API could not measure. Never 0 by default. */
    num(value) {
        if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    },

    /** A post's value for a sortable column. */
    metric(post, key) {
        if (!post) return null;
        if (key === 'published_at') {
            const at = Date.parse(post.published_at || '');
            return Number.isFinite(at) ? at : null;
        }
        if (key === 'engagement_rate') return this.num(post.engagement_rate);
        if (key === 'avg_watch') return this.watchMs(post);
        const m = post.metrics && typeof post.metrics === 'object' ? post.metrics : {};
        return this.num(m[key]);
    },

    /** A reel's average watch time in ms: the contract's name, or Meta's own. Null for anything else. */
    watchMs(post) {
        const m = post && post.metrics && typeof post.metrics === 'object' ? post.metrics : {};
        const v = [m.avg_watch_time_ms, m.ig_reels_avg_watch_time, m.avg_watch_time].map((x) => this.num(x)).find((x) => x !== null);
        return v === undefined ? null : v;
    },

    /** Instagram's skip rate arrives as a percentage (74.1), not a ratio. */
    formatSkip(value) {
        const n = this.num(value);
        return n === null ? '—' : this.formatRate(n / 100);
    },

    /** "3.2 ث" / "3.2s" — watch time reads in seconds, with one decimal under a minute. */
    formatSeconds(ms) {
        const n = this.num(ms);
        if (n === null) return '—';
        const s = n / 1000;
        let text;
        try {
            text = new Intl.NumberFormat(I18N.locale(), { maximumFractionDigits: s < 60 ? 1 : 0 }).format(s);
        } catch {
            text = String(Math.round(s * 10) / 10);
        }
        return t('growth.seconds', { n: text });
    },

    /** The median of the reels' averages in this range, and how many reels it is over. */
    medianWatch(posts) {
        const values = (Array.isArray(posts) ? posts : []).map((p) => this.watchMs(p)).filter((v) => v !== null && v > 0).sort((a, b) => a - b);
        if (!values.length) return { ms: null, n: 0 };
        const mid = Math.floor(values.length / 2);
        const ms = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
        return { ms, n: values.length };
    },

    /** Likes + comments + saves + shares, when any of them was measured. */
    interactions(post) {
        const parts = ['likes', 'comments', 'saved', 'shares'].map((k) => this.metric(post, k));
        if (parts.every((v) => v === null)) return null;
        return parts.reduce((sum, v) => sum + (v || 0), 0);
    },

    /** Under 100 followers, Instagram withholds the follower series by design. */
    smallAccount() {
        const followers = this.num(this.kpis().followers);
        return followers !== null && followers < this.SMALL_ACCOUNT_FOLLOWERS;
    },

    /** A rate as a percentage. The API sends a ratio (0.042 = 4.2%), which can pass 1 on a tiny reach. */
    ratePercent(value) {
        const n = this.num(value);
        if (n === null) return null;
        return n * 100;
    },

    _decimal: null,

    /** "4.2%" — Latin digits and the sign attached, like UI.formatPercent, with one decimal. */
    formatRate(value) {
        const p = this.ratePercent(value);
        if (p === null) return '—';
        let text;
        try {
            if (!this._decimal || this._decimal.locale !== I18N.locale()) {
                this._decimal = { locale: I18N.locale(), fmt: new Intl.NumberFormat(I18N.locale(), { maximumFractionDigits: 1 }) };
            }
            text = this._decimal.fmt.format(p);
        } catch {
            text = String(Math.round(p * 10) / 10);
        }
        return `${text}%`;
    },

    formatCount(value) {
        const n = this.num(value);
        return n === null ? '—' : UI.formatNumber(n);
    },

    /** "7 أيام" / "28 يوماً" / "28 days": Arabic counts days in three grammatical forms. */
    daysText(n) {
        const count = Number(n) || 0;
        return t('growth.days', { count, n: UI.formatNumber(count) });
    },

    /** "12 منشوراً" / "12 posts". */
    postsText(n) {
        const count = Number(n) || 0;
        return t('growth.posts.count', { count, n: UI.formatNumber(count) });
    },

    /** "+3" / "-2" / "0", isolated so the sign stays on the number inside Arabic. */
    formatDelta(value) {
        const n = this.num(value);
        if (n === null) return '—';
        let text;
        try {
            text = new Intl.NumberFormat(I18N.locale(), { signDisplay: 'exceptZero', maximumFractionDigits: 0 }).format(n);
        } catch {
            text = n > 0 ? `+${n}` : String(n);
        }
        return text;
    },

    /** REELS, CAROUSEL_ALBUM, IMAGE, VIDEO … → one of TYPE_KEYS. */
    typeKey(mediaType) {
        const v = String(mediaType || '').toUpperCase();
        if (v === 'REELS' || v === 'REEL') return 'reel';
        if (v === 'CAROUSEL_ALBUM' || v === 'CAROUSEL') return 'carousel';
        if (v === 'IMAGE' || v === 'PHOTO') return 'image';
        if (v === 'VIDEO') return 'video';
        return 'other';
    },

    typeLabel(key) {
        return t(`growth.type.${this.TYPE_KEYS.includes(key) ? key : 'other'}`);
    },

    platformKey(value) {
        const v = String(value || '').toLowerCase();
        return this.PLATFORM_KEYS.includes(v) ? v : 'other';
    },

    platformTag(value) {
        const key = this.platformKey(value);
        if (key === 'instagram') return html`<span class="platform-tag ig">IG</span>`;
        if (key === 'facebook') return html`<span class="platform-tag fb">FB</span>`;
        if (key === 'tiktok') return html`<span class="platform-tag">TT</span>`;
        return '';
    },

    /** The caption's first line, which is what a feed shows before "more". */
    captionLine(caption, max = 90) {
        const line = String(caption || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
        const chars = Array.from(line);
        return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line;
    },

    // ─── Time zones ──────────────────────────────────────────────────────────
    validZone(zone) {
        if (!zone || typeof zone !== 'string') return false;
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: zone });
            return true;
        } catch {
            return false;
        }
    },

    browserZone() {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
    },

    /** The tenant's time zone (growth settings → audience), else this browser's, and which. */
    tenantZone() {
        const zone = this.settings && this.settings.audience && this.settings.audience.timezone;
        if (this.validZone(zone)) return { zone, own: true };
        return { zone: this.browserZone(), own: false };
    },

    /** Minutes `zone` is ahead of UTC at `at`. */
    zoneOffsetMin(zone, at) {
        const when = new Date(Math.floor(Number(at) / 60000) * 60000);
        try {
            const f = new Intl.DateTimeFormat('en-US', {
                timeZone: zone, hourCycle: 'h23',
                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
            });
            const p = {};
            f.formatToParts(when).forEach((part) => { p[part.type] = part.value; });
            const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
            return Math.round((wall - when.getTime()) / 60000);
        } catch {
            return 0;
        }
    },

    /** "Riyadh (GMT+3)" — the city, and the offset where the browser can name it. */
    zoneLabel(zone) {
        const city = String(zone || 'UTC').split('/').pop().replace(/_/g, ' ');
        let offset = '';
        try {
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date());
            const name = parts.find((p) => p.type === 'timeZoneName');
            offset = name ? name.value : '';
        } catch { /* older browsers: the city alone */ }
        return offset && offset !== city ? `${city} (${offset})` : city;
    },

    // ─── Toolbar: the two views, the range, Sync ─────────────────────────────
    tabsMarkup() {
        const active = this.view();
        const tab = (key, href, icon, label) => html`
            <a class="btn btn-sm btn-ghost" id="growth-tab-${key}" href="${href}"
               ${active === key ? html.raw('aria-current="page"') : ''}>
                <i data-lucide="${icon}" aria-hidden="true"></i> ${label}
            </a>
        `;
        return html`
            <nav class="segmented studio-seg growth-tabs" aria-label="${t('growth.tabs.label')}">
                ${tab('performance', '#/growth', 'trending-up', t('growth.tabs.performance'))}
                ${tab('seo', '#/growth?tab=seo', 'search', t('growth.tabs.seo'))}
            </nav>
        `;
    },

    rangeMarkup() {
        return html`
            <div class="segmented studio-seg growth-range" role="group" aria-label="${t('growth.range.label')}">
                ${this.RANGES.map((n) => html`
                    <button type="button" class="btn btn-sm btn-ghost" id="growth-range-${n}"
                            data-action="growth:setDays" data-days="${n}"
                            aria-pressed="${n === this.days ? 'true' : 'false'}">${this.daysText(n)}</button>
                `)}
            </div>
        `;
    },

    /**
     * G5: the sync runs daily, so past 26 hours one was missed (amber) and past 50 two were
     * (red). The age's level used to be computed and thrown away, on 36h/72h thresholds that
     * hid a missed day entirely.
     */
    lastSyncMarkup() {
        // Not "never synced" while the status is still out, or when it could not be read: unknown.
        if (!this.status && this.pending.status) return html`<span class="text-meta" id="growth-last-sync" aria-hidden="true">${Motion.line('sm')}</span>`;
        if (!this.status && this.statusError) return '';
        const last = this.status && this.status.lastSync;
        if (!last) return html`<span class="text-meta" id="growth-last-sync">${t('growth.sync.never')}</span>`;
        const age = UI.relativeAge(last, { warnMs: this.SYNC_WARN_MS, staleMs: this.SYNC_STALE_MS });
        const cls = age.level === 'stale' ? ' text-danger' : age.level === 'warn' ? ' text-warning' : '';
        return html`<span class="text-meta${html.raw(cls)}" id="growth-last-sync" title="${age.title}">${t('growth.sync.last', { when: age.text })}</span>`;
    },

    toolbarMarkup() {
        const perf = this.view() === 'performance';
        const note = this.syncNote;
        return html`
            ${this.tabsMarkup()}
            ${perf ? html`
                <div class="growth-toolbar-end">
                    ${this.rangeMarkup()}
                    <div class="growth-sync">
                        ${this.lastSyncMarkup()}
                        ${UI.button({
                            variant: 'secondary', size: 'sm', icon: 'refresh-cw', id: 'growth-sync-btn',
                            label: this.syncing ? t('growth.sync.running') : t('growth.sync.button'),
                            action: 'growth:sync', busy: this.syncing,
                        })}
                    </div>
                </div>
                ${note ? html`
                    <p class="form-hint growth-sync-note ${note.kind === 'error' ? html.raw('text-warning') : ''}" id="growth-sync-note" role="status" dir="auto">${note.message}</p>
                ` : ''}
            ` : ''}
        `;
    },

    // ─── The permission banner ───────────────────────────────────────────────
    /** What each scope unlocks, in the operator's words. Unknown scopes still get named. */
    SCOPE_KEYS: Object.freeze({
        instagram_manage_insights: 'igInsights',
        read_insights: 'fbInsights',
        instagram_basic: 'igBasic',
        pages_read_engagement: 'fbEngagement',
        business_management: 'business',
    }),

    scopeText(scope) {
        const key = this.SCOPE_KEYS[scope];
        return key ? t(`growth.scope.${key}`) : t('growth.scope.other');
    },

    bannerMarkup() {
        const s = this.status;
        if (!s) {
            // A failed status read is not a missing permission: say nothing false, offer Retry —
            // of the status alone (G7). While it is still out, nothing: no banner is a claim too.
            return this.statusError && !this.pending.status
                ? html`<div class="growth-status-failed">${this.errorHost(this.statusError, t('growth.status.failed'), 'status')}</div>`
                : '';
        }
        const parts = [];
        if (s.instagram === 'not_connected') {
            parts.push(html`
                <div class="studio-callout is-warning growth-banner" id="growth-not-connected" role="note">
                    <i data-lucide="plug-zap" aria-hidden="true"></i>
                    <div class="studio-callout-body">
                        <p class="studio-callout-title">${t('growth.banner.notConnectedTitle')}</p>
                        <p>${t('growth.banner.notConnectedBody')}</p>
                        <div class="row row--wrap gap-2">${UI.helpLink('connect-meta', t('help.link.connectMeta'))}</div>
                    </div>
                </div>
            `);
        }
        if (s.missing.length) {
            const owner = typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
            parts.push(html`
                <section class="studio-callout is-warning growth-banner" id="growth-permission-banner" aria-labelledby="growth-banner-title">
                    <i data-lucide="shield-alert" aria-hidden="true"></i>
                    <div class="studio-callout-body">
                        <h2 class="studio-callout-title" id="growth-banner-title">${t('growth.banner.title')}</h2>
                        <p>${t('growth.banner.body')}</p>
                        <ul class="growth-scopes">
                            ${s.missing.map((scope) => html`
                                <li><code dir="ltr">${scope}</code><span>${this.scopeText(scope)}</span></li>
                            `)}
                        </ul>
                        <p class="growth-fix-lead">${owner ? t('growth.banner.fixLead') : t('growth.banner.fixLeadViewer')}</p>
                        <ol class="growth-fix">
                            <li>${t('growth.banner.step1')}</li>
                            <li>${t('growth.banner.step2')}</li>
                            <li>${t('growth.banner.step3')}</li>
                            <li>${t('growth.banner.step4')}</li>
                        </ol>
                        <div class="row row--wrap gap-2">
                            ${owner ? html`<a class="btn btn-secondary btn-sm" href="#/settings"><i data-lucide="key-round" aria-hidden="true"></i> ${t('growth.banner.openSettings')}</a>` : ''}
                            ${UI.helpLink('growth#permissions', t('help.link.growthPermissions'))}
                        </div>
                    </div>
                </section>
            `);
        }
        if (s.tiktok === 'unavailable' || s.tiktok === 'missing_permission') {
            parts.push(html`<p class="text-meta growth-tiktok-note" id="growth-tiktok-note">${t('growth.banner.tiktok')}</p>`);
        }
        return parts;
    },

    // ─── KPI cards ───────────────────────────────────────────────────────────
    KPI_DEFS: Object.freeze([
        Object.freeze({ key: 'followers', icon: 'users' }),
        Object.freeze({ key: 'reach', icon: 'target' }),
        Object.freeze({ key: 'views', icon: 'eye' }),
        Object.freeze({ key: 'engagement_rate', icon: 'heart' }),
        Object.freeze({ key: 'saves', icon: 'bookmark' }),
        Object.freeze({ key: 'shares', icon: 'share-2' }),
        Object.freeze({ key: 'avg_watch', icon: 'timer' }),
        // Instagram's reels_skip_rate: the hook's own number, the lower the better.
        Object.freeze({ key: 'skip_rate', icon: 'skip-forward' }),
    ]),

    /**
     * The reels' watch time: the server's own figure when it sends one, else the median of the
     * reels in this range (one viral reel should not set the number a creator plans around).
     */
    watchKpi() {
        const k = this.kpis();
        const own = [k.avg_watch_time_ms, k.ig_reels_avg_watch_time, k.avg_watch_time].map((x) => this.num(x)).find((x) => x !== null);
        if (own !== undefined) return { ms: own, n: null };
        return this.medianWatch(this.posts);
    },

    kpis() {
        const k = this.overview && this.overview.kpis;
        return k && typeof k === 'object' ? k : {};
    },

    /** Why a number is missing — the permission, no sync yet, or simply not offered. */
    missingReason() {
        // Which of the three it is comes from the status; until that lands, say none of them.
        if (!this.status && this.pending.status) return '';
        if (this.locked('instagram')) return t('growth.kpi.locked');
        if (this.status && !this.status.lastSync) return t('growth.kpi.notSynced');
        return t('growth.kpi.notMeasured');
    },

    kpiCard(def) {
        const k = this.kpis();
        const watch = def.key === 'avg_watch' ? this.watchKpi() : null;
        const raw = watch ? watch.ms : k[def.key];
        const isRate = def.key === 'engagement_rate';
        const isSkip = def.key === 'skip_rate';
        let value;
        if (watch) value = this.formatSeconds(raw);
        else if (isSkip) value = this.formatSkip(raw);
        else value = isRate ? this.formatRate(raw) : this.formatCount(raw);
        const missing = this.num(raw) === null;
        const label = t(`growth.kpi.${def.key}`);
        const band = isSkip && !missing ? this.skipBand(raw) : null;
        let sub;
        if (missing) {
            sub = html`<p class="stat-sub">${(watch || isSkip) && !this.locked('instagram') && this.postsLoaded ? t('growth.kpi.noReels') : this.missingReason()}</p>`;
        } else if (watch) {
            sub = html`<p class="stat-sub">${watch.n ? t('growth.kpi.watchMedian', { count: watch.n, n: UI.formatNumber(watch.n) }) : t('growth.kpi.inRange', { days: this.daysText(this.days) })}</p>`;
        } else if (def.key === 'followers') {
            const d = this.num(k.followers_delta);
            sub = d === null
                ? html`<p class="stat-sub">${this.smallAccount() ? t('growth.small.delta') : t('growth.kpi.deltaMissing')}</p>`
                : html`<p class="stat-sub growth-delta ${html.raw(d > 0 ? 'text-success' : d < 0 ? 'text-danger' : '')}">
                        ${UI.ltr(this.formatDelta(d))} <span>${t('growth.kpi.deltaIn', { days: this.daysText(this.days) })}</span>
                    </p>`;
        } else if (band) {
            sub = html`<p class="stat-sub">${t(`growth.kpi.skipBand.${band}`)}</p>`;
        } else if (this.direction(def.key)) {
            sub = this.directionMarkup(def.key);
        } else {
            sub = html`<p class="stat-sub">${t('growth.kpi.inRange', { days: this.daysText(this.days) })}</p>`;
        }
        return html`
            <div class="stat-card surface growth-kpi${missing ? html.raw(' is-missing') : ''}" id="growth-kpi-${def.key}">
                <div class="stat-header">
                    <span class="stat-label">${label}</span>
                    <span class="stat-icon"><i data-lucide="${def.icon}" aria-hidden="true"></i></span>
                </div>
                <p class="stat-value${band ? html.raw(` text-${band}`) : ''}">${value}</p>
                ${sub}
                ${this.goalMarkup(def.key, raw)}
                <details class="growth-tip">
                    <summary title="${t(`growth.kpi.${def.key}.tip`)}">
                        <i data-lucide="circle-help" aria-hidden="true"></i>
                        <span>${t('growth.kpi.whatIs')}</span><span class="sr-only"> ${label}</span>
                    </summary>
                    <p>${t(`growth.kpi.${def.key}.tip`)}</p>
                </details>
            </div>
        `;
    },

    /**
     * G3: the KPIs whose direction the server can state — account-day totals, compared with the
     * same span one window earlier (`overview.previous`). Engagement rate is not among them: the
     * server does not send one, because a rate of lifetime post totals does not compare across
     * windows, and a change in a rate would be ambiguous besides (points or percent?).
     */
    DIRECTION_KEYS: Object.freeze(['reach', 'views', 'saves', 'shares']),

    /** `{ pct, dir: 'up'|'down'|'flat' }` against the previous window, or null when there is no exact one. */
    direction(key) {
        if (!this.DIRECTION_KEYS.includes(key)) return null;
        const prev = this.overview && this.overview.previous;
        if (!prev || typeof prev !== 'object') return null;
        const before = this.num(prev[key]);
        const now = this.num(this.kpis()[key]);
        // Nothing before is no baseline: "up from 0" has no percentage, and inventing one would be worse.
        if (before === null || now === null || !(before > 0)) return null;
        const pct = Math.round(((now - before) / before) * 100);
        return { pct: Math.abs(pct), dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
    },

    /** "↑ 12% vs the previous 28 days", in the band colours, with a sentence for a screen reader. */
    directionMarkup(key) {
        const d = this.direction(key);
        if (!d) return '';
        const days = this.daysText(this.days);
        if (d.dir === 'flat') {
            return html`<p class="stat-sub growth-dir" id="growth-dir-${key}">${t('growth.kpi.dirFlat', { days })}</p>`;
        }
        const pct = UI.formatNumber(d.pct);
        const up = d.dir === 'up';
        return html`
            <p class="stat-sub growth-dir ${html.raw(up ? 'text-success' : 'text-danger')}" id="growth-dir-${key}">
                <span aria-hidden="true">${t(up ? 'growth.kpi.dirUp' : 'growth.kpi.dirDown', { pct, days })}</span>
                <span class="sr-only">${t(up ? 'growth.kpi.dirUpSr' : 'growth.kpi.dirDownSr', { pct, days })}</span>
            </p>
        `;
    },

    /** 'danger' | 'warning' | 'success' for a skip rate (0–100), or null when not measured. */
    skipBand(value) {
        const n = this.num(value);
        if (n === null) return null;
        if (n > this.SKIP_DANGER_ABOVE) return 'danger';
        if (n >= this.SKIP_WARNING_FROM) return 'warning';
        return 'success';
    },

    /** The goal for a KPI, from the settings (never a constant), or null. */
    goalFor(key) {
        const s = this.settings;
        if (!s) return null;
        const goal = key === 'followers' ? s.goal_followers : key === 'views' ? s.goal_views : null;
        return this.num(goal) !== null && goal > 0 ? goal : null;
    },

    /**
     * G4: the distance to goal under followers and views — "154 of 10,000". Views are over the
     * range on screen: the account-level series is what the API has, and the label beside it
     * says which range. An unmeasured count is "—", not 0; no goal (settings unread), no line.
     */
    goalMarkup(key, value) {
        if (!this.GOAL_KEYS.includes(key)) return '';
        const goal = this.goalFor(key);
        if (goal === null) return '';
        const n = this.num(value);
        return html`
            <div class="growth-goal" id="growth-goal-${key}">
                ${n !== null ? this.barSvg(n / goal) : ''}
                <p class="growth-goal-line">
                    <span>${t('growth.kpi.goal', { n: n === null ? '—' : UI.formatNumber(n), goal: UI.formatNumber(goal) })}</span>
                    <button type="button" class="stat-link" data-action="growth:editGoal" data-goal="${key}">${t('growth.kpi.editGoal')}</button>
                </p>
            </div>
        `;
    },

    /** "Change goal": to the SEO view's goals form, with that field focused. */
    editGoal(key) {
        if (!this.GOAL_KEYS.includes(key)) return;
        this._focusGoal = key;
        if (this.view() === 'seo') { this.focusPendingGoal(); return; }
        if (typeof App !== 'undefined' && typeof App.goWithQuery === 'function') App.goWithQuery('growth', { tab: 'seo' });
    },

    kpisMarkup() {
        return html`<div class="stats-grid growth-kpis" id="growth-kpis">${this.KPI_DEFS.map((d) => this.kpiCard(d))}</div>`;
    },

    // ─── Trend ───────────────────────────────────────────────────────────────
    /** `{ day, value }` for one metric, oldest first; a day without the metric is null. */
    trendSeries(metric) {
        const rows = this.overview && Array.isArray(this.overview.trend) ? this.overview.trend : [];
        return rows
            .filter((r) => r && r.day)
            .map((r) => ({ day: r.day, value: this.num(r[metric]) }))
            .sort((a, b) => String(a.day).localeCompare(String(b.day)));
    },

    trendEmptyText(measured, metric) {
        // Not an error, and not a permission: Instagram keeps this series back until 100 followers.
        if (metric === 'followers' && this.smallAccount()) return t('growth.small.series');
        if (this.locked('instagram')) return t('growth.trend.locked');
        if (this.status && !this.status.lastSync) return t('growth.trend.notSynced');
        return measured === 1 ? t('growth.trend.oneDay') : t('growth.trend.empty');
    },

    /** One line of plain words above the chart: totals for reach/views, the change for followers. */
    trendSummary(metric, series) {
        const present = series.filter((p) => p.value !== null);
        if (present.length < 2) return '';
        if (metric === 'followers') {
            const first = present[0].value;
            const last = present[present.length - 1].value;
            return t('growth.trend.followersChange', {
                from: UI.formatNumber(first), to: UI.formatNumber(last), days: this.daysText(this.days),
            });
        }
        const total = present.reduce((sum, p) => sum + p.value, 0);
        const best = present.reduce((b, p) => (p.value > b.value ? p : b), present[0]);
        return t('growth.trend.totalBest', {
            total: UI.formatNumber(total), day: UI.formatDayShort(best.day), value: UI.formatNumber(best.value),
        });
    },

    trendMarkup() {
        const metric = this.TREND_METRICS.includes(this.trendMetric) ? this.trendMetric : 'views';
        const series = this.trendSeries(metric);
        const measured = series.filter((p) => p.value !== null).length;
        const metricName = t(`growth.metric.${metric}`);
        const label = t('growth.trend.label', { metric: metricName, days: this.daysText(this.days) });
        const summary = this.trendSummary(metric, series);
        return html`
            <div class="chart-card-header growth-trend-head">
                <h2 class="chart-card-title" id="growth-trend-title">${t('growth.trend.title')}</h2>
                <div class="segmented studio-seg growth-metric" role="group" aria-label="${t('growth.trend.metricLabel')}">
                    ${this.TREND_METRICS.map((m) => html`
                        <button type="button" class="btn btn-sm btn-ghost" id="growth-metric-${m}"
                                data-action="growth:setMetric" data-metric="${m}"
                                aria-pressed="${m === metric ? 'true' : 'false'}">${t(`growth.metric.${m}`)}</button>
                    `)}
                </div>
            </div>
            ${summary ? html`<p class="text-meta growth-trend-summary">${summary}</p>` : ''}
            ${measured < 2
                ? html`<p class="chart-empty growth-empty-line" id="growth-trend-empty">${this.trendEmptyText(measured, metric)}</p>`
                : Charts.lineChart(series, {
                    label, token: '--accent',
                    dayHeader: t('common.day'), valueHeader: metricName,
                    emptyMessage: this.trendEmptyText(measured, metric),
                })}
        `;
    },

    // ─── Who sees you: followers vs new people (reach by follow_type) ────────
    /**
     * Instagram's reach broken down by follow_type. Read from whichever of the shapes a
     * `{ FOLLOWER, NON_FOLLOWER }` split can arrive in; null when it did not arrive at all.
     */
    followSplit() {
        const o = this.overview || {};
        const k = this.kpis();
        const pick = (src) => {
            if (!src) return null;
            if (Array.isArray(src)) {
                const by = {};
                src.forEach((row) => {
                    if (!row || typeof row !== 'object') return;
                    const key = String(row.follow_type || row.type || row.key || '').toUpperCase();
                    by[key] = this.num(row.value !== undefined ? row.value : row.reach);
                });
                return { followers: by.FOLLOWER, nonFollowers: by.NON_FOLLOWER };
            }
            if (typeof src === 'object') {
                return {
                    followers: this.num(src.FOLLOWER !== undefined ? src.FOLLOWER : src.follower !== undefined ? src.follower : src.followers),
                    nonFollowers: this.num(src.NON_FOLLOWER !== undefined ? src.NON_FOLLOWER : src.non_follower !== undefined ? src.non_follower : src.non_followers),
                };
            }
            return null;
        };
        const candidates = [pick(o.audience_split && o.audience_split.reach)];
        const found = candidates.find((c) => c && this.num(c.followers) !== null && this.num(c.nonFollowers) !== null);
        if (!found) return null;
        const followers = Math.max(0, found.followers);
        const nonFollowers = Math.max(0, found.nonFollowers);
        if (followers + nonFollowers <= 0) return null;
        return { followers, nonFollowers, newShare: nonFollowers / (followers + nonFollowers) };
    },

    audienceMarkup(split) {
        const pct = Math.round(split.newShare * 100);
        const lead = split.newShare >= 0.5 ? t('growth.audience.mostlyNew', { pct }) : t('growth.audience.mostlyFollowers', { pct: 100 - pct });
        return html`
            <div class="chart-card-header">
                <h2 class="chart-card-title" id="growth-audience-title">${t('growth.audience.title')}</h2>
            </div>
            ${Charts.splitBar([
                { label: t('growth.audience.new'), value: split.nonFollowers, token: '--accent', fallback: '#0071e3' },
                { label: t('growth.audience.followers'), value: split.followers, token: '--info', fallback: '#5e5ce6' },
            ], {
                label: t('growth.audience.title'),
                nameHeader: t('growth.audience.who'),
                valueHeader: t('growth.metric.reach'),
                emptyMessage: t('growth.trend.empty'),
            })}
            <p class="growth-audience-lead">${lead}</p>
            <p class="form-hint">${split.newShare >= 0.5 ? t('growth.audience.leverNew') : t('growth.audience.leverFollowers')}</p>
        `;
    },

    /**
     * Loading shapes for a region, sized like what replaces them. The details' cards keep their
     * real heading, so the page reads in order and `aria-labelledby` names something from the start.
     */
    regionSkeleton(kind) {
        if (kind === 'summary') {
            return html`
                ${Motion.statsGrid(this.KPI_DEFS.length)}
                <div class="chart-card surface" aria-hidden="true"><div class="chart-skel"><span class="skel skel-block"></span></div></div>
                ${Motion.busy()}
            `;
        }
        if (kind === 'posts') {
            const cols = [t('growth.posts.post'), t('growth.metric.views'), t('growth.metric.reach'), t('growth.metric.engagement_rate')];
            return html`
                <div class="table-header"><h2 class="table-title" id="growth-posts-title">${t('growth.posts.title')}</h2></div>
                <div class="table-wrapper" aria-hidden="true">
                    <table class="data-table">
                        <thead><tr>${cols.map((label) => html`<th scope="col">${label}</th>`)}</tr></thead>
                        ${Motion.tableRows(5, cols.length)}
                    </table>
                </div>
            `;
        }
        const title = kind === 'best'
            ? html`<h2 class="chart-card-title" id="growth-best-title">${t('growth.best.title')}</h2>`
            : html`<h2 class="chart-card-title" id="growth-types-title">${t('growth.types.title')}</h2>`;
        return html`
            <div class="chart-card-header">${title}</div>
            <div class="chart-skel" aria-hidden="true"><span class="skel skel-block"></span></div>
        `;
    },

    summaryMarkup() {
        if (this.showsSkeleton('summary')) return this.regionSkeleton('summary');
        if (this.overviewError && !this.pending.overview) return this.errorHost(this.overviewError, t('growth.overview.failed'), 'overview');
        const split = this.followSplit();
        const trend = html`
            <section class="chart-card surface growth-trend" id="growth-trend" aria-labelledby="growth-trend-title">
                ${this.trendMarkup()}
            </section>
        `;
        return html`
            ${this.kpisMarkup()}
            ${split ? html`
                <div class="chart-grid growth-summary-pair">
                    ${trend}
                    <section class="chart-card surface growth-audience" id="growth-audience" aria-labelledby="growth-audience-title">
                        ${this.audienceMarkup(split)}
                    </section>
                </div>
            ` : trend}
        `;
    },

    /**
     * Best times, by type and the posts: three regions in one frame. Best times and the posts come
     * from the posts list (and best times from the settings' zone too), by type from the overview,
     * so each fills — or fails, with its own Retry — on its own.
     */
    detailsMarkup() {
        return html`
            <div class="chart-grid chart-grid--even growth-pair">
                <section class="chart-card surface growth-best" id="growth-best" aria-labelledby="growth-best-title">
                    ${this.bestSectionMarkup()}
                </section>
                <section class="chart-card surface growth-types" id="growth-types" aria-labelledby="growth-types-title">
                    ${this.typesSectionMarkup()}
                </section>
            </div>
            <section class="table-card surface growth-posts" id="growth-posts" aria-labelledby="growth-posts-title">
                ${this.postsMarkup()}
            </section>
        `;
    },

    bestSectionMarkup() {
        if (this.showsSkeleton('best')) return this.regionSkeleton('best');
        return this.bestTimesMarkup();
    },

    typesSectionMarkup() {
        if (this.showsSkeleton('types')) return this.regionSkeleton('types');
        if (this.overviewError && !this.pending.overview) {
            return html`
                <div class="chart-card-header"><h2 class="chart-card-title" id="growth-types-title">${t('growth.types.title')}</h2></div>
                ${this.errorHost(this.overviewError, t('growth.overview.failed'), 'overview')}
            `;
        }
        return this.byTypeMarkup();
    },

    // ─── Posts: filter and sort (pure) ───────────────────────────────────────
    filterPosts(posts, filter) {
        const f = filter || {};
        const type = f.type || 'all';
        const platform = f.platform || 'all';
        return (Array.isArray(posts) ? posts : []).filter((p) => (type === 'all' || this.typeKey(p.media_type) === type)
            && (platform === 'all' || this.platformKey(p.platform) === platform));
    },

    /**
     * Sorted by one column. A post with no value for it goes LAST in both directions: "not
     * measured" is not the smallest number, and floating it to the top of an ascending sort
     * would bury every real answer under dashes. Ties go newest first.
     */
    sortPosts(posts, sort) {
        const s = sort || {};
        const key = this.SORT_KEYS.includes(s.key) ? s.key : 'views';
        const dir = s.dir === 'asc' ? 1 : -1;
        return (Array.isArray(posts) ? posts : [])
            .map((p, i) => ({ p, i, v: this.metric(p, key), at: this.metric(p, 'published_at') }))
            .sort((a, b) => {
                if (a.v === null && b.v !== null) return 1;
                if (b.v === null && a.v !== null) return -1;
                if (a.v !== null && b.v !== null && a.v !== b.v) return (a.v - b.v) * dir;
                if ((a.at || 0) !== (b.at || 0)) return (b.at || 0) - (a.at || 0);
                return a.i - b.i;
            })
            .map((x) => x.p);
    },

    /** The types and platforms actually present, so a filter never offers an empty choice. */
    presentKeys(posts, of) {
        const seen = new Set((Array.isArray(posts) ? posts : []).map((p) => (of === 'platform' ? this.platformKey(p.platform) : this.typeKey(p.media_type))));
        const order = of === 'platform' ? this.PLATFORM_KEYS : this.TYPE_KEYS;
        return order.filter((k) => seen.has(k));
    },

    visiblePosts() {
        return this.sortPosts(this.filterPosts(this.posts, this.filter), this.sort);
    },

    // ─── Posts: markup ───────────────────────────────────────────────────────
    /** A proportion bar as SVG attributes — data, never an interpolated style. Fills from the reading start. */
    barSvg(fraction, cls) {
        const f = Math.max(0, Math.min(1, Number(fraction) || 0));
        const w = Number((f * 100).toFixed(2));
        const x = I18N.isRtl() ? Number((100 - w).toFixed(2)) : 0;
        return html`<svg class="growth-bar ${html.raw(cls || '')}" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="growth-bar-track" x="0" y="0" width="100" height="6" rx="3"></rect>${w > 0 ? html`<rect class="growth-bar-fill" x="${x}" y="0" width="${w}" height="6" rx="3"></rect>` : ''}</svg>`;
    },

    erMarkup(post, maxRate) {
        const p = this.ratePercent(post.engagement_rate);
        if (p === null) return html`<span class="growth-er is-missing">—</span>`;
        return html`<span class="growth-er">${this.barSvg(maxRate > 0 ? p / maxRate : 0)}<span class="growth-er-value">${this.formatRate(post.engagement_rate)}</span></span>`;
    },

    thumbMarkup(post) {
        const src = safeUrl(post.thumbnail_url);
        const key = this.typeKey(post.media_type);
        const icon = key === 'reel' || key === 'video' ? 'film' : key === 'carousel' ? 'images' : 'image';
        return html`<span class="growth-thumb">${src
            ? html`<img src="${src}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
            : html`<i data-lucide="${icon}" aria-hidden="true"></i>`}</span>`;
    },

    postIdentity(post) {
        const line = this.captionLine(post.caption);
        const note = this.coachNote(post);
        const link = safeUrl(post.permalink);
        const where = this.platformKey(post.platform) === 'facebook' ? t('common.facebook') : t('common.instagram');
        return html`
            <div class="growth-post">
                ${this.thumbMarkup(post)}
                <span class="growth-post-text">
                    <span class="growth-post-caption user-content" dir="auto">${line || t('growth.posts.noCaption')}</span>
                    ${note ? html`<span class="growth-post-note" dir="auto" title="${t('growth.posts.coachNote')}"><i data-lucide="lightbulb" aria-hidden="true"></i><span>${note}</span></span>` : ''}
                    <span class="growth-post-meta">
                        <span class="chip">${this.typeLabel(this.typeKey(post.media_type))}</span>${this.platformTag(post.platform)}
                        ${link ? html`<a class="growth-permalink" href="${link}" target="_blank" rel="noopener noreferrer">
                            <i data-lucide="external-link" aria-hidden="true"></i><span>${t('growth.posts.open', { where })}</span>
                        </a>` : ''}
                    </span>
                </span>
            </div>
        `;
    },

    COLUMNS: Object.freeze(['published_at', 'views', 'reach', 'likes', 'comments', 'saved', 'shares', 'avg_watch', 'skip_rate', 'engagement_rate']),

    sortHeader(key) {
        const active = this.sort.key === key;
        const dir = active ? this.sort.dir : null;
        const ariaSort = !active ? 'none' : dir === 'asc' ? 'ascending' : 'descending';
        const icon = !active ? 'chevrons-up-down' : dir === 'asc' ? 'arrow-up' : 'arrow-down';
        const label = t(`growth.metric.${key}`);
        const num = key !== 'published_at';
        return html`
            <th scope="col" class="${num ? html.raw('cell-num') : ''}" aria-sort="${ariaSort}">
                <button type="button" class="th-sort${active ? html.raw(' is-active') : ''}" id="growth-sort-${key}"
                        data-action="growth:sortBy" data-key="${key}">
                    <span>${label}</span><i data-lucide="${icon}" aria-hidden="true"></i>
                    <span class="sr-only">${t('growth.posts.sortBy', { column: label })}</span>
                </button>
            </th>
        `;
    },

    cellValue(post, key) {
        if (key === 'published_at') return post.published_at ? UI.formatDayShort(post.published_at) : '—';
        if (key === 'avg_watch') return this.formatSeconds(this.watchMs(post));
        if (key === 'skip_rate') return this.formatSkip(this.metric(post, key));
        return this.formatCount(this.metric(post, key));
    },

    /**
     * "Views from these posts: Facebook 3,960 · Instagram 1,200" — only when two platforms are
     * both measured, because that is when the platform filter changes the answer. From the
     * posts in the list, and said so: it is not the account-level total above.
     */
    platformViews(list) {
        const sums = new Map();
        (Array.isArray(list) ? list : []).forEach((p) => {
            const v = this.metric(p, 'views');
            if (v === null) return;
            const key = this.platformKey(p.platform);
            sums.set(key, (sums.get(key) || 0) + v);
        });
        return [...sums.entries()].filter(([key]) => key !== 'other').sort((a, b) => b[1] - a[1]);
    },

    platformViewsMarkup(list) {
        const rows = this.platformViews(list);
        if (rows.length < 2) return '';
        return html`<p class="text-meta growth-platform-views" id="growth-platform-views">${t('growth.posts.viewsBy')} ${rows.map(([key, sum], i) => html`${i ? ' · ' : ''}<span class="growth-best-slot">${t(`growth.platform.${key}`)} ${UI.formatNumber(sum)}</span>`)}</p>`;
    },

    postRow(post, maxRate) {
        return html`
            <tr>
                <td class="growth-post-cell">${this.postIdentity(post)}</td>
                ${this.COLUMNS.map((key) => (key === 'engagement_rate'
                    ? html`<td class="cell-num">${this.erMarkup(post, maxRate)}</td>`
                    : html`<td class="${key === 'published_at' ? html.raw('nowrap') : html.raw('cell-num')}">${this.cellValue(post, key)}</td>`))}
            </tr>
        `;
    },

    /**
     * G8: a phone card leads with the four numbers that answer "did the hook work" — views, the
     * skip rate, the average watch and engagement — and folds the rest into «More». Watch time
     * and the skip rate exist for reels only: a card for an image carries no empty row for them.
     */
    CARD_KEY_METRICS: Object.freeze(['views', 'skip_rate', 'avg_watch', 'engagement_rate']),
    CARD_MORE_METRICS: Object.freeze(['reach', 'likes', 'comments', 'saved', 'shares']),

    /** "reach, likes, comments, saves and shares": what «More» opens, for a screen reader. */
    listText(items) {
        try {
            return new Intl.ListFormat(I18N.locale(), { style: 'long', type: 'conjunction' }).format(items);
        } catch {
            return items.join(', ');
        }
    },

    postCard(post, maxRate) {
        const keys = this.CARD_KEY_METRICS.filter((key) => (key !== 'avg_watch' || this.watchMs(post) !== null)
            && (key !== 'skip_rate' || this.metric(post, 'skip_rate') !== null));
        const more = this.CARD_MORE_METRICS;
        return html`
            <li class="log-card growth-post-card">
                ${this.postIdentity(post)}
                <dl class="growth-card-metrics growth-card-key">
                    ${keys.map((key) => html`
                        <div><dt>${t(`growth.metric.${key}`)}</dt><dd>${key === 'engagement_rate' ? this.erMarkup(post, maxRate) : this.cellValue(post, key)}</dd></div>
                    `)}
                </dl>
                <details class="growth-card-more">
                    <summary>${t('growth.posts.moreMetrics')}<span class="sr-only">: ${this.listText(more.map((key) => t(`growth.metric.${key}`)))}</span></summary>
                    <dl class="growth-card-metrics">
                        ${more.map((key) => html`
                            <div><dt>${t(`growth.metric.${key}`)}</dt><dd>${this.cellValue(post, key)}</dd></div>
                        `)}
                    </dl>
                </details>
                <div class="growth-card-foot">
                    <span class="text-meta">${this.cellValue(post, 'published_at')}</span>
                </div>
            </li>
        `;
    },

    filterSelect(of, id, action, current) {
        const keys = this.presentKeys(this.posts, of);
        const label = of === 'platform' ? t('growth.posts.platform') : t('growth.posts.type');
        return html`
            <label class="growth-filter">
                <span class="form-label">${label}</span>
                <select class="select" id="${id}" data-change="growth:${action}">
                    <option value="all" ${current === 'all' ? html.raw('selected') : ''}>${of === 'platform' ? t('growth.posts.allPlatforms') : t('growth.posts.allTypes')}</option>
                    ${keys.map((k) => html`<option value="${k}" ${current === k ? html.raw('selected') : ''}>${of === 'platform' ? t(`growth.platform.${k}`) : this.typeLabel(k)}</option>`)}
                </select>
            </label>
        `;
    },

    postsMarkup() {
        if (this.showsSkeleton('posts')) return this.regionSkeleton('posts');
        const head = html`<h2 class="table-title" id="growth-posts-title">${t('growth.posts.title')}</h2>`;
        if (this.postsError && !this.pending.posts) return html`${head}${this.errorHost(this.postsError, t('growth.posts.failed'), 'posts')}`;
        if (!this.posts.length) {
            // "Nothing synced yet" is the status's to say; unknown, the plain "none in this range" is what is true.
            const synced = this.status ? this.status.lastSync : true;
            return html`
                <div class="table-header">${head}</div>
                ${Admin.emptyState('image', synced ? t('growth.posts.emptyTitle') : t('growth.posts.notSyncedTitle'),
                    synced ? t('growth.posts.empty', { days: this.daysText(this.days) }) : t('growth.posts.notSynced'))}
            `;
        }
        const list = this.visiblePosts();
        const shown = list.slice(0, this.postsLimit);
        const rates = list.map((p) => this.ratePercent(p.engagement_rate)).filter((v) => v !== null);
        const maxRate = rates.length ? Math.max(...rates) : 0;
        const sortLabel = t(`growth.metric.${this.sort.key}`);
        return html`
            <div class="table-header">
                ${head}
                <div class="filter-bar growth-filters">
                    ${this.filterSelect('type', 'growth-filter-type', 'filterType', this.filter.type)}
                    ${this.filterSelect('platform', 'growth-filter-platform', 'filterPlatform', this.filter.platform)}
                    <label class="growth-filter growth-sort-select">
                        <span class="form-label">${t('growth.posts.sortLabel')}</span>
                        <select class="select" id="growth-sort-mobile" data-change="growth:sortSelect">
                            ${this.COLUMNS.map((k) => html`<option value="${k}" ${this.sort.key === k ? html.raw('selected') : ''}>${t(`growth.metric.${k}`)}</option>`)}
                        </select>
                    </label>
                </div>
            </div>
            <p class="text-meta growth-posts-count" id="growth-posts-count">
                ${this.postsText(list.length)} · ${t('growth.posts.sortedBy', { column: sortLabel })} · ${this.sort.dir === 'asc' ? t('growth.posts.asc') : t('growth.posts.desc')}
            </p>
            ${this.platformViewsMarkup(list)}
            ${list.length === 0 ? html`
                <div class="empty-state growth-filter-empty">
                    <i data-lucide="search-x" aria-hidden="true"></i>
                    <h3>${t('growth.posts.noMatchTitle')}</h3>
                    <p>${t('growth.posts.noMatch')}</p>
                    ${UI.button({ variant: 'secondary', size: 'sm', icon: 'x', label: t('growth.posts.clearFilters'), action: 'growth:clearFilters', id: 'growth-clear-filters' })}
                </div>
            ` : html`
                <div class="table-wrapper log-table growth-posts-table">
                    <table class="data-table">
                        <caption class="sr-only">${t('growth.posts.caption', { days: this.daysText(this.days) })}</caption>
                        <thead><tr>
                            <th scope="col" class="growth-post-head">${t('growth.posts.post')}</th>
                            ${this.COLUMNS.map((k) => this.sortHeader(k))}
                        </tr></thead>
                        <tbody>${shown.map((p) => this.postRow(p, maxRate))}</tbody>
                    </table>
                </div>
                <ul class="log-cards growth-post-cards" aria-label="${t('growth.posts.title')}">${shown.map((p) => this.postCard(p, maxRate))}</ul>
                ${list.length > shown.length ? html`
                    <div class="row row--center mbs-4">
                        ${UI.button({
                            variant: 'secondary', size: 'sm', icon: 'chevron-down', id: 'growth-more-posts',
                            label: t('growth.posts.more', { n: UI.formatNumber(Math.min(this.POSTS_PAGE, list.length - shown.length)), total: UI.formatNumber(list.length) }),
                            action: 'growth:morePosts',
                        })}
                    </div>
                ` : ''}
            `}
        `;
    },

    // ─── Best times (7 days × 4 parts of the day) ────────────────────────────
    /**
     * G9/G10: the day in four parts, in the tenant's zone — night 00–06, morning 06–12,
     * afternoon 12–18, evening 18–24. The 7×24 grid this replaced put one post in most of its
     * cells and then named them "your best hours", in 168 cells too small to read or touch on a
     * phone. Four parts gather each cell's posts, every cell says how many posts its average is
     * of, and no time is called "best" before there are enough posts to mean it.
     */
    DAYPARTS: Object.freeze(['night', 'morning', 'afternoon', 'evening']),
    DAYPART_HOURS: 6,
    /** Under this many posts no time is named "best": a pattern needs more than a handful. */
    BEST_MIN_POSTS: 10,

    /**
     * Move a UTC-indexed grid into `to`, keyed by the middle of each source hour, so a zone
     * half an hour off (Asia/Kolkata) still lands each hour in exactly one local cell.
     *
     * @param grid  number[7][24], [weekday 0 = Sunday][hour], in `from`
     * @param opts  { from = 'UTC', to = from, now = Date.now() } — `now` fixes the offset (DST)
     * @returns {{ cells: Array<Array<number|null>>, max: number, top: Array<{day, hour, value}>, empty: boolean }}
     */
    buildHeatmap(grid, opts) {
        const o = opts || {};
        const cells = Array.from({ length: 7 }, () => Array(24).fill(null));
        const from = this.validZone(o.from) ? o.from : 'UTC';
        const to = this.validZone(o.to) ? o.to : from;
        const at = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
        const shift = from === to ? 0 : this.zoneOffsetMin(to, at) - this.zoneOffsetMin(from, at);
        const WEEK = 7 * 1440;
        if (Array.isArray(grid)) {
            for (let d = 0; d < 7; d++) {
                const row = Array.isArray(grid[d]) ? grid[d] : [];
                for (let h = 0; h < 24; h++) {
                    const v = this.num(row[h]);
                    if (v === null) continue;
                    const m = (((d * 1440 + h * 60 + 30 + shift) % WEEK) + WEEK) % WEEK;
                    const ld = Math.floor(m / 1440);
                    const lh = Math.floor((m % 1440) / 60);
                    cells[ld][lh] = (cells[ld][lh] || 0) + v;
                }
            }
        }
        let max = 0;
        const all = [];
        cells.forEach((row, day) => row.forEach((value, hour) => {
            if (value !== null && value > 0) {
                all.push({ day, hour, value });
                if (value > max) max = value;
            }
        }));
        all.sort((a, b) => b.value - a.value || a.day - b.day || a.hour - b.hour);
        return { cells, max, top: all.slice(0, 3), empty: max <= 0 };
    },

    _slotFmt: null,

    /** The weekday (0 = Sunday) and hour an instant falls on in `zone`. */
    localSlot(iso, zone) {
        const at = Date.parse(iso || '');
        if (!Number.isFinite(at)) return null;
        try {
            if (!this._slotFmt || this._slotFmt.zone !== zone) {
                this._slotFmt = {
                    zone,
                    fmt: new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }),
                };
            }
            const p = {};
            this._slotFmt.fmt.formatToParts(new Date(at)).forEach((part) => { p[part.type] = part.value; });
            const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
            const hour = Number(p.hour) % 24;
            return day < 0 || !Number.isFinite(hour) ? null : { day, hour };
        } catch {
            return null;
        }
    },

    /**
     * Best times from OUR OWN POSTS — Instagram's online_followers is empty for small accounts,
     * so this is the only honest source. Each post lands on its weekday and hour in the tenant's
     * zone and a cell is the average score of the posts published then. The score is views where
     * most posts have them, and interactions (likes + comments + saves + shares) otherwise, so a
     * token without insights still gets a map, from what it can read.
     *
     * @returns {{ grid: Array<Array<number|null>>, sums: number[][], counts: number[][], basis: 'views'|'interactions', posts: number }}
     */
    postsHeatGrid(posts, zone) {
        const list = (Array.isArray(posts) ? posts : []).filter((p) => p && Number.isFinite(Date.parse(p.published_at || '')));
        const withViews = list.filter((p) => this.metric(p, 'views') !== null).length;
        const basis = withViews > 0 && withViews * 2 >= list.length ? 'views' : 'interactions';
        const sums = Array.from({ length: 7 }, () => Array(24).fill(0));
        const counts = Array.from({ length: 7 }, () => Array(24).fill(0));
        let counted = 0;
        list.forEach((p) => {
            const score = basis === 'views' ? this.metric(p, 'views') : this.interactions(p);
            if (score === null) return;
            const slot = this.localSlot(p.published_at, zone);
            if (!slot) return;
            sums[slot.day][slot.hour] += score;
            counts[slot.day][slot.hour] += 1;
            counted += 1;
        });
        const grid = sums.map((row, d) => row.map((sum, h) => (counts[d][h] ? sum / counts[d][h] : null)));
        return { grid, sums, counts, basis, posts: counted };
    },

    /**
     * Hour sums and post counts, `[weekday][hour]`, into `[weekday][part]` cells: `{ avg, n }` —
     * the average over every post published in that part of that day, and how many posts that
     * is — or null where nothing was posted. An average of the hours' averages would weigh one
     * lonely post like five.
     */
    daypartCells(sums, counts) {
        return Array.from({ length: 7 }, (_, d) => this.DAYPARTS.map((_part, p) => {
            let sum = 0;
            let n = 0;
            for (let h = p * this.DAYPART_HOURS; h < (p + 1) * this.DAYPART_HOURS; h++) {
                const c = this.num(counts && counts[d] && counts[d][h]);
                const v = this.num(sums && sums[d] && sums[d][h]);
                if (c !== null && c > 0 && v !== null) { sum += v; n += c; }
            }
            return n ? { avg: sum / n, n } : null;
        }));
    },

    /**
     * The best-times cells on screen: our own posts, in the tenant's zone; the server's grid when
     * the posts list could not be read — its averages weighted back into sums by its own counts,
     * and moved from the zone it names (UTC when none) into the tenant's.
     */
    bestMap() {
        const tz = this.tenantZone();
        const own = this.postsHeatGrid(this.posts, tz.zone);
        let cells = this.daypartCells(own.sums, own.counts);
        let basis = own.basis;
        let metric = own.basis;
        let posts = own.posts;
        const o = this.overview;
        const meta = o && o.best_times_meta && typeof o.best_times_meta === 'object' ? o.best_times_meta : null;
        if (!posts && this.postsError && o && Array.isArray(o.best_times) && meta && Array.isArray(meta.counts)) {
            const from = this.validZone(meta.timezone) ? meta.timezone : this.validZone(o.best_times_tz) ? o.best_times_tz : 'UTC';
            const sums = o.best_times.map((row, d) => (Array.isArray(row) ? row : []).map((v, h) => {
                const avg = this.num(v);
                const n = this.num(meta.counts[d] && meta.counts[d][h]);
                return avg !== null && n ? avg * n : null;
            }));
            const moved = this.buildHeatmap(sums, { from, to: tz.zone }).cells;
            const movedCounts = this.buildHeatmap(meta.counts, { from, to: tz.zone }).cells;
            cells = this.daypartCells(moved, movedCounts);
            posts = cells.flat().reduce((sum, c) => sum + (c ? c.n : 0), 0);
            basis = 'server';
            metric = meta.metric === 'interactions' ? 'interactions' : 'views';
        }
        let max = 0;
        const ranked = [];
        cells.forEach((row, day) => row.forEach((c, part) => {
            if (!c || !(c.avg > 0)) return;
            ranked.push({ day, part, avg: c.avg, n: c.n });
            if (c.avg > max) max = c.avg;
        }));
        ranked.sort((a, b) => b.avg - a.avg || b.n - a.n || a.day - b.day || a.part - b.part);
        return { cells, max, top: ranked.slice(0, 3), posts, basis, metric, zone: tz, empty: posts === 0 };
    },

    /** 0 = nothing posted then; 1–4 = quartiles of the best hour. */
    heatLevel(value, max) {
        if (value === null || value === undefined || !(value > 0) || !(max > 0)) return 0;
        const r = value / max;
        if (r > 0.75) return 4;
        if (r > 0.5) return 3;
        if (r > 0.25) return 2;
        return 1;
    },

    _weekday: null,

    dayName(day, style) {
        const width = style === 'long' ? 'long' : 'short';
        try {
            const key = `${I18N.locale()}|${width}`;
            if (!this._weekday || this._weekday.key !== key) {
                this._weekday = { key, fmt: new Intl.DateTimeFormat(I18N.locale(), { weekday: width, timeZone: 'UTC' }) };
            }
            // 2026-01-04 is a Sunday.
            return this._weekday.fmt.format(new Date(Date.UTC(2026, 0, 4 + day)));
        } catch {
            return String(day);
        }
    },

    /** "18–24", or "18:00–24:00" in full: a part's hours, in the tenant's zone. */
    partHours(part, full) {
        const from = part * this.DAYPART_HOURS;
        const pad = (h) => (full ? `${String(h).padStart(2, '0')}:00` : String(h).padStart(2, '0'));
        return `${pad(from)}–${pad(from + this.DAYPART_HOURS)}`;
    },

    /** "Tue evening" / «مساء الثلاثاء». */
    slotName(day, part, style) {
        const key = this.DAYPARTS[part] || this.DAYPARTS[0];
        return t(`growth.best.slot.${key}`, { day: this.dayName(day, style) });
    },

    /** "320 views on average, from 3 posts" — the numbers behind one cell. */
    slotNumbers(cell, metric) {
        const params = { avg: UI.formatNumber(Math.round(cell.avg)), posts: this.postsText(cell.n) };
        return t(metric === 'interactions' ? 'growth.best.slotInteractions' : 'growth.best.slotViews', params);
    },

    /** A cell's name for a screen reader: the day, the part, its hours, and the same numbers it shows. */
    slotSentence(day, part, cell, metric) {
        return t('growth.best.slotLabel', {
            slot: this.slotName(day, part, 'long'), hours: this.partHours(part, true), numbers: this.slotNumbers(cell, metric),
        });
    },

    /**
     * A cell: a button when posts went out then, so a tap or Enter spells its numbers out under
     * the grid (touch has no hover, and a title tooltip never reached a phone); a dash when not.
     */
    slotCell(day, part, cell, map) {
        if (!cell) {
            return html`<td class="growth-slot is-empty"><span aria-hidden="true">—</span><span class="sr-only">${t('growth.best.slotNone', { slot: this.slotName(day, part, 'long') })}</span></td>`;
        }
        const picked = !!this.slotPick && this.slotPick.day === day && this.slotPick.part === part;
        return html`
            <td class="growth-slot">
                <button type="button" class="growth-slot-btn" id="growth-slot-${day}-${part}"
                        data-action="growth:pickSlot" data-day="${day}" data-part="${part}"
                        aria-pressed="${picked ? 'true' : 'false'}" aria-label="${this.slotSentence(day, part, cell, map.metric)}">
                    <span class="heat heat-${this.heatLevel(cell.avg, map.max)}" aria-hidden="true"></span>
                    <span class="growth-slot-avg">${UI.formatNumber(Math.round(cell.avg))}</span>
                    <span class="growth-slot-n">${this.postsText(cell.n)}</span>
                </button>
            </td>
        `;
    },

    /** The line under the grid: the picked cell's numbers, or how to get them. */
    slotCaption(map) {
        const pick = this.slotPick;
        if (!pick) return t('growth.best.tapHint');
        const cell = map.cells[pick.day] && map.cells[pick.day][pick.part];
        const name = html`<strong>${this.slotName(pick.day, pick.part, 'long')}</strong> ${UI.ltr(this.partHours(pick.part, true))}`;
        if (!cell) return html`${name} · ${t('growth.best.nothingThen')}`;
        return html`${name} · ${this.slotNumbers(cell, map.metric)}`;
    },

    /** A tap or Enter on a cell: its numbers under the grid, and said aloud. A second press puts it back. */
    pickSlot(el) {
        const day = Number(el && el.dataset ? el.dataset.day : NaN);
        const part = Number(el && el.dataset ? el.dataset.part : NaN);
        if (!Number.isInteger(day) || day < 0 || day > 6 || !Number.isInteger(part) || part < 0 || part >= this.DAYPARTS.length) return;
        const same = !!this.slotPick && this.slotPick.day === day && this.slotPick.part === part;
        this.slotPick = same ? null : { day, part };
        this.paintRegion('growth-best', this.bestSectionMarkup());
        if (this.slotPick) {
            const map = this.bestMap();
            const cell = map.cells[day] && map.cells[day][part];
            if (cell) Motion.announce(this.slotSentence(day, part, cell, map.metric));
        }
    },

    bestTimesMarkup() {
        const head = html`
            <div class="chart-card-header">
                <h2 class="chart-card-title" id="growth-best-title">${t('growth.best.title')}</h2>
                ${UI.helpLink('growth#best-times', t('help.link.bestTimes'), { iconOnly: true })}
            </div>
        `;
        const map = this.bestMap();
        const tz = map.zone;
        const zoneNote = html`<p class="text-meta growth-zone">${tz.own
            ? t('growth.best.zone', { zone: this.zoneLabel(tz.zone) })
            : t('growth.best.zoneBrowser', { zone: this.zoneLabel(tz.zone) })}</p>`;
        if (map.empty && this.postsError && !this.pending.posts) {
            // Not "not enough posts": the posts could not be read, and the server's grid did not stand in.
            return html`${head}${this.errorHost(this.postsError, t('growth.posts.failed'), 'posts')}`;
        }
        if (map.empty) {
            return html`${head}<p class="chart-empty growth-empty-line">${t('growth.best.empty')}</p>${zoneNote}`;
        }
        // G9: "your best times" only from BEST_MIN_POSTS posts, and each named with the posts behind it.
        const enough = map.posts >= this.BEST_MIN_POSTS && map.top.length > 0;
        return html`
            ${head}
            <p class="text-meta growth-best-basis" id="growth-best-basis">${map.basis === 'views'
                ? t('growth.best.basisViews', { posts: this.postsText(map.posts) })
                : map.basis === 'interactions'
                    ? t('growth.best.basisInteractions', { posts: this.postsText(map.posts) })
                    : t('growth.best.basis')}</p>
            ${enough ? html`
                <p class="growth-best-top" id="growth-best-top">
                    <strong>${t('growth.best.topLead')}</strong>
                    ${map.top.map((c, i) => html`${i ? ' · ' : ''}<span class="growth-best-slot">${t('growth.best.topSlot', { slot: this.slotName(c.day, c.part), posts: this.postsText(c.n) })}</span>`)}
                </p>
            ` : html`
                <p class="text-meta growth-best-few" id="growth-best-few">${t('growth.best.fewPosts', { min: UI.formatNumber(this.BEST_MIN_POSTS), posts: this.postsText(map.posts) })}</p>
            `}
            <div class="growth-heat-wrap">
                <table class="growth-heat growth-dayparts" id="growth-heat">
                    <caption class="sr-only">${t('growth.best.caption', { zone: this.zoneLabel(tz.zone) })}</caption>
                    <thead><tr>
                        <td></td>
                        ${this.DAYPARTS.map((key, p) => html`<th scope="col"><span class="growth-part-name">${t(`growth.best.part.${key}`)}</span><span class="growth-part-hours">${UI.ltr(this.partHours(p))}</span></th>`)}
                    </tr></thead>
                    <tbody>
                        ${this.DAY_ORDER.map((d) => html`
                            <tr>
                                <th scope="row">${this.dayName(d)}</th>
                                ${map.cells[d].map((cell, p) => this.slotCell(d, p, cell, map))}
                            </tr>
                        `)}
                    </tbody>
                </table>
            </div>
            <p class="text-meta growth-slot-caption" id="growth-slot-caption">${this.slotCaption(map)}</p>
            <div class="growth-heat-legend" aria-hidden="true">
                <span>${t('growth.best.less')}</span>
                ${[1, 2, 3, 4].map((l) => html`<span class="heat heat-${l}"></span>`)}
                <span>${t('growth.best.more')}</span>
            </div>
            ${zoneNote}
            <p class="form-hint">${t('growth.best.hint')}</p>
        `;
    },

    // ─── By type ─────────────────────────────────────────────────────────────
    typeRows() {
        const rows = this.overview && Array.isArray(this.overview.by_type) ? this.overview.by_type : [];
        const merged = new Map();
        rows.filter((r) => r && typeof r === 'object').forEach((r) => {
            const key = this.typeKey(r.type);
            if (!merged.has(key)) merged.set(key, { key, posts: this.num(r.posts) || 0, avg_views: this.num(r.avg_views), avg_engagement: this.num(r.avg_engagement) });
        });
        return [...merged.values()].filter((r) => r.posts > 0)
            .sort((a, b) => (b.avg_views === null ? -1 : b.avg_views) - (a.avg_views === null ? -1 : a.avg_views) || b.posts - a.posts);
    },

    /** "Reels average 3.2× the views of images" — only when both ends are measured. */
    typeVerdict(rows) {
        const measured = rows.filter((r) => r.avg_views !== null && r.avg_views > 0);
        if (measured.length < 2) return '';
        const best = measured[0];
        const worst = measured[measured.length - 1];
        const ratio = best.avg_views / worst.avg_views;
        if (!(ratio >= 1.2)) return t('growth.types.even');
        return t('growth.types.verdict', {
            best: this.typeLabel(best.key), worst: this.typeLabel(worst.key),
            ratio: (Math.round(ratio * 10) / 10).toLocaleString(I18N.locale()),
        });
    },

    byTypeMarkup() {
        const head = html`
            <div class="chart-card-header">
                <h2 class="chart-card-title" id="growth-types-title">${t('growth.types.title')}</h2>
            </div>
        `;
        const rows = this.typeRows();
        if (!rows.length) return html`${head}<p class="chart-empty growth-empty-line">${t('growth.types.empty')}</p>`;
        const maxViews = Math.max(0, ...rows.map((r) => r.avg_views || 0));
        const rates = rows.map((r) => this.ratePercent(r.avg_engagement)).filter((v) => v !== null);
        const maxRate = rates.length ? Math.max(...rates) : 0;
        const verdict = this.typeVerdict(rows);
        return html`
            ${head}
            ${verdict ? html`<p class="growth-verdict">${verdict}</p>` : ''}
            <ul class="growth-type-list">
                ${rows.map((r) => {
                    const rate = this.ratePercent(r.avg_engagement);
                    return html`
                        <li class="growth-type">
                            <p class="growth-type-head">
                                <strong>${this.typeLabel(r.key)}</strong>
                                <span class="text-meta">${this.postsText(r.posts)}</span>
                            </p>
                            <div class="growth-type-metric">
                                <span class="growth-type-label">${t('growth.types.avgViews')}</span>
                                ${r.avg_views === null ? html`<span class="text-meta">${this.missingReason()}</span>` : html`
                                    ${this.barSvg(maxViews > 0 ? r.avg_views / maxViews : 0)}
                                    <span class="growth-type-value">${UI.formatNumber(Math.round(r.avg_views))}</span>
                                `}
                            </div>
                            <div class="growth-type-metric">
                                <span class="growth-type-label">${t('growth.types.avgEngagement')}</span>
                                ${rate === null ? html`<span class="text-meta">${this.missingReason()}</span>` : html`
                                    ${this.barSvg(maxRate > 0 ? rate / maxRate : 0, 'is-alt')}
                                    <span class="growth-type-value">${this.formatRate(r.avg_engagement)}</span>
                                `}
                            </div>
                        </li>
                    `;
                })}
            </ul>
        `;
    },

    // ─── AI Growth Coach ─────────────────────────────────────────────────────
    LEVELS: Object.freeze(['low', 'med', 'high']),

    level(value) {
        const v = String(value || '').toLowerCase();
        if (v === 'medium') return 'med';
        return this.LEVELS.includes(v) ? v : null;
    },

    /** Whatever Gemini sent, as the shape the markup reads. Empty entries are dropped. */
    normalizeCoach(raw) {
        const r = raw && typeof raw === 'object' ? raw : {};
        const text = (v) => (typeof v === 'string' ? v.trim() : '');
        const list = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);
        return {
            summary: text(r.summary),
            wins: list(r.wins),
            problems: list(r.problems),
            actions: (Array.isArray(r.actions) ? r.actions : [])
                .filter((a) => a && typeof a === 'object' && (text(a.title) || text(a.how)))
                .map((a, i) => ({
                    title: text(a.title) || text(a.how), why: text(a.why), how: text(a.how),
                    effort: this.level(a.effort), impact: this.level(a.impact), order: i,
                })),
            experiments: (Array.isArray(r.experiments) ? r.experiments : [])
                .filter((e) => e && typeof e === 'object' && (text(e.hypothesis) || text(e.how)))
                .map((e) => ({ hypothesis: text(e.hypothesis), how: text(e.how), measure: text(e.measure) })),
            // "Why it worked", one line per post, keyed by the platform's media id.
            notes: (Array.isArray(r.post_notes) ? r.post_notes : [])
                .filter((n) => n && typeof n === 'object' && text(String(n.media_id || '')) && text(n.note))
                .map((n) => ({ media_id: String(n.media_id).trim(), note: text(n.note) })),
        };
    },

    /** The coach's note for one post, or ''. */
    coachNote(post) {
        const notes = this.coach && Array.isArray(this.coach.notes) ? this.coach.notes : [];
        const id = post && post.media_id !== undefined && post.media_id !== null ? String(post.media_id) : '';
        const hit = id ? notes.find((n) => n.media_id === id) : null;
        return hit ? hit.note : '';
    },

    /**
     * Biggest impact first; among equals, the least effort first; then the coach's own order.
     * The coach is asked for priorities, but the chips on screen are the promise, so the order
     * has to agree with them.
     */
    prioritize(actions) {
        const impact = { high: 3, med: 2, low: 1 };
        const ease = { low: 3, med: 2, high: 1 };
        return [...(Array.isArray(actions) ? actions : [])].sort((a, b) => {
            const ia = impact[a.impact] || 1.5;
            const ib = impact[b.impact] || 1.5;
            if (ia !== ib) return ib - ia;
            const ea = ease[a.effort] || 2;
            const eb = ease[b.effort] || 2;
            if (ea !== eb) return eb - ea;
            return (a.order || 0) - (b.order || 0);
        });
    },

    /** The last answer for THIS tenant in this browser, if it is recent enough to be current. */
    restoreCoach() {
        const saved = this.storeGet(this.tenantKey());
        if (!saved || !saved.result || !saved.at) return;
        const at = Date.parse(saved.at);
        if (!Number.isFinite(at) || Date.now() - at > this.COACH_KEEP_MS) return;
        this.coach = this.normalizeCoach(saved.result);
        this.coachAt = saved.at;
        this.coachDays = Number(saved.days) || null;
        this.coachState = 'ready';
    },

    coachStageAt(elapsed) {
        let stage = 0;
        this.COACH_STAGE_AT.forEach((at, i) => { if (elapsed >= at) stage = i; });
        return stage;
    },

    clock(sec) {
        const s = Math.max(0, Math.floor(sec));
        return UI.ltr(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    },

    startCoachTicker() {
        this.stopCoachTicker();
        const tick = () => {
            if (this.coachState !== 'loading') { this.stopCoachTicker(); return; }
            const elapsed = (Date.now() - this.coachStartedAt) / 1000;
            const clock = document.getElementById('growth-coach-clock');
            if (clock) clock.innerHTML = esc(this.clock(elapsed));
            const stage = this.coachStageAt(elapsed);
            if (stage !== this.coachStage) {
                this.coachStage = stage;
                this.paintRegion('growth-coach-stages', this.coachStagesMarkup());
                Motion.announce(t(`growth.coach.stage.${this.COACH_STAGES[stage]}`));
            }
            const slow = document.getElementById('growth-coach-slow');
            if (slow) slow.classList.toggle('hidden', elapsed < this.COACH_SLOW_S);
        };
        tick();
        this._coachTimer = setInterval(tick, 1000);
    },

    stopCoachTicker() {
        if (this._coachTimer) clearInterval(this._coachTimer);
        this._coachTimer = null;
    },

    /**
     * POST /coach. The page stays free while it runs, and leaving does not cancel it: the
     * answer is kept on this object (and in this browser, per tenant) and painted wherever the
     * coach card is when it lands. A tenant switch retires it.
     */
    async generateCoach() {
        if (this.coachState === 'loading') return;
        const tenant = this._tenantEpoch;
        const days = this.days;
        this.coachState = 'loading';
        this.coachError = null;
        this.coachStartedAt = Date.now();
        this.coachStage = 0;
        this.paintRegion('growth-coach', this.coachMarkup());
        this.startCoachTicker();
        Motion.announce(t('growth.coach.started'));
        try {
            const res = await API.growthCoach({ days });
            if (tenant !== this._tenantEpoch) return;
            const result = this.normalizeCoach(res);
            if (!result.summary && !result.actions.length && !result.wins.length && !result.problems.length) {
                throw new Error(t('growth.coach.emptyAnswer'));
            }
            this.coach = result;
            this.coachAt = new Date().toISOString();
            this.coachDays = days;
            this.coachState = 'ready';
            this.storeSet(this.tenantKey(), { at: this.coachAt, days, result: res });
            Motion.announce(t('growth.coach.ready'));
            if (typeof App !== 'undefined' && App.currentPage && App.currentPage !== 'growth') UI.toast(t('growth.coach.readyElsewhere'));
        } catch (err) {
            if (tenant !== this._tenantEpoch) return;
            this.coachState = 'error';
            this.coachError = err;
            Motion.announce((err && err.message) || t('error.unexpected'));
        } finally {
            if (tenant === this._tenantEpoch) {
                this.stopCoachTicker();
                this.paintRegion('growth-coach', this.coachMarkup());
                this.paintRegion('growth-do-first', this.doFirstMarkup());
                if (this.coachState === 'ready') this.paintRegion('growth-posts', this.postsMarkup());
            }
        }
    },

    /** G12: the numbers moved after this plan was written, so Regenerate would read newer ones. */
    syncedSincePlan() {
        const last = Date.parse((this.status && this.status.lastSync) || '');
        const at = Date.parse(this.coachAt || '');
        return Number.isFinite(last) && Number.isFinite(at) && last > at;
    },

    coachStagesMarkup() {
        return this.COACH_STAGES.map((key, i) => {
            const state = i < this.coachStage ? 'done' : i === this.coachStage ? 'current' : 'todo';
            let mark = '';
            if (state === 'done') mark = html`<i data-lucide="check" aria-hidden="true"></i>`;
            else if (state === 'current') mark = html`<span class="spinner spinner-sm" aria-hidden="true"></span>`;
            return html`
                <li class="studio-stage is-${html.raw(state)}"${state === 'current' ? html.raw(' aria-current="step"') : ''}>
                    <span class="studio-stage-mark" aria-hidden="true">${mark}</span>
                    <span class="studio-stage-label">${t(`growth.coach.stage.${key}`)}</span>
                    <span class="sr-only"> (${t(`growth.coach.state.${state}`)})</span>
                </li>
            `;
        });
    },

    levelChip(kind, value) {
        if (!value) return '';
        const strong = (kind === 'impact' && value === 'high') || (kind === 'effort' && value === 'low');
        return html`<span class="chip${strong ? html.raw(' chip-accent') : ''}">${t(`growth.coach.${kind}`)}: ${t(`growth.coach.level.${value}`)}</span>`;
    },

    coachHead(extra) {
        return html`
            <div class="growth-section-head">
                <div class="growth-section-heading">
                    <h2 class="section-title" id="growth-coach-title"><i data-lucide="sparkles" aria-hidden="true"></i> ${t('growth.coach.title')}</h2>
                    ${extra || ''}
                </div>
                ${UI.helpLink('growth#coach', t('help.link.coach'), { iconOnly: true })}
            </div>
        `;
    },

    coachMarkup() {
        const state = this.coachState;
        const lockedNote = this.locked('instagram') ? html`
            <div class="studio-callout" role="note">
                <i data-lucide="info" aria-hidden="true"></i>
                <div class="studio-callout-body"><p>${t('growth.coach.lockedNote')}</p></div>
            </div>
        ` : '';

        if (state === 'loading') {
            const elapsed = (Date.now() - this.coachStartedAt) / 1000;
            return html`
                ${this.coachHead(html`<p class="text-meta">${t('growth.coach.working', { days: this.daysText(this.days) })}</p>`)}
                <div class="studio-progress-card growth-coach-progress" aria-busy="true">
                    <ol class="studio-stages" id="growth-coach-stages">${this.coachStagesMarkup()}</ol>
                    <div class="studio-indeterminate" aria-hidden="true"><span></span></div>
                    <p class="studio-gen-time">
                        <span class="studio-gen-clock" id="growth-coach-clock">${this.clock(elapsed)}</span>
                        <span>· ${t('growth.coach.usually')}</span>
                    </p>
                    <p class="form-hint text-warning${elapsed < this.COACH_SLOW_S ? html.raw(' hidden') : ''}" id="growth-coach-slow">${t('growth.coach.slow')}</p>
                    <div class="studio-callout" role="note">
                        <i data-lucide="info" aria-hidden="true"></i>
                        <div class="studio-callout-body"><p>${t('growth.coach.leave')}</p></div>
                    </div>
                </div>
            `;
        }

        if (state === 'ready' && this.coach) {
            const c = this.coach;
            const age = this.coachAt ? UI.relativeAge(this.coachAt) : null;
            const meta = html`<p class="text-meta" title="${age ? age.title : ''}">${t('growth.coach.generated', {
                when: age ? age.text : '—', days: this.daysText(this.coachDays || this.days),
            })}</p>`;
            const actions = this.prioritize(c.actions);
            return html`
                ${this.coachHead(meta)}
                ${c.summary ? html`<p class="growth-coach-summary user-content" dir="auto">${c.summary}</p>` : ''}
                ${c.wins.length || c.problems.length ? html`
                    <div class="growth-coach-grid">
                        <div class="growth-coach-col is-wins">
                            <h3 class="growth-coach-sub"><i data-lucide="check-circle" aria-hidden="true"></i> ${t('growth.coach.wins')}</h3>
                            ${c.wins.length ? html`<ul class="growth-coach-list">${c.wins.map((w) => html`<li class="user-content" dir="auto">${w}</li>`)}</ul>`
                                : html`<p class="text-meta">${t('growth.coach.noWins')}</p>`}
                        </div>
                        <div class="growth-coach-col is-problems">
                            <h3 class="growth-coach-sub"><i data-lucide="alert-triangle" aria-hidden="true"></i> ${t('growth.coach.problems')}</h3>
                            ${c.problems.length ? html`<ul class="growth-coach-list">${c.problems.map((p) => html`<li class="user-content" dir="auto">${p}</li>`)}</ul>`
                                : html`<p class="text-meta">${t('growth.coach.noProblems')}</p>`}
                        </div>
                    </div>
                ` : ''}
                ${actions.length ? html`
                    <h3 class="growth-coach-sub">${t('growth.coach.actions')}</h3>
                    <ol class="growth-actions" id="growth-coach-actions">
                        ${actions.map((a, i) => html`
                            <li class="growth-action">
                                <div class="growth-action-head">
                                    <span class="growth-action-num" aria-hidden="true">${UI.formatNumber(i + 1)}</span>
                                    <h4 class="growth-action-title user-content" dir="auto">${a.title}</h4>
                                </div>
                                <p class="growth-action-chips">${this.levelChip('impact', a.impact)} ${this.levelChip('effort', a.effort)}</p>
                                ${a.why ? html`<p class="growth-action-line"><strong>${t('growth.coach.why')}</strong> <span class="user-content" dir="auto">${a.why}</span></p>` : ''}
                                ${a.how ? html`<p class="growth-action-line"><strong>${t('growth.coach.how')}</strong> <span class="user-content" dir="auto">${a.how}</span></p>` : ''}
                            </li>
                        `)}
                    </ol>
                ` : ''}
                ${c.experiments.length ? html`
                    <h3 class="growth-coach-sub">${t('growth.coach.experiments')}</h3>
                    <ul class="growth-experiments">
                        ${c.experiments.map((e) => html`
                            <li class="growth-experiment">
                                <dl>
                                    ${e.hypothesis ? html`<div><dt>${t('growth.coach.hypothesis')}</dt><dd class="user-content" dir="auto">${e.hypothesis}</dd></div>` : ''}
                                    ${e.how ? html`<div><dt>${t('growth.coach.test')}</dt><dd class="user-content" dir="auto">${e.how}</dd></div>` : ''}
                                    ${e.measure ? html`<div><dt>${t('growth.coach.measure')}</dt><dd class="user-content" dir="auto">${e.measure}</dd></div>` : ''}
                                </dl>
                            </li>
                        `)}
                    </ul>
                ` : ''}
                <div class="growth-coach-foot">
                    <p class="form-hint">${t('growth.coach.disclaimer')}</p>
                    ${this.syncedSincePlan() ? html`<span class="text-meta text-warning" id="growth-plan-older">${t('growth.sync.sincePlan')}</span>` : ''}
                    ${UI.button({ variant: 'secondary', size: 'sm', icon: 'sparkles', label: t('growth.coach.regenerate'), action: 'growth:generateCoach', id: 'growth-coach-btn' })}
                </div>
            `;
        }

        return html`
            ${this.coachHead('')}
            <p class="growth-coach-lede">${t('growth.coach.lede')}</p>
            ${lockedNote}
            ${state === 'error' ? UI.errorStrip(
                t('growth.coach.failed', { message: (this.coachError && this.coachError.message) || t('error.unexpected') }),
                t('growth.coach.failedHint'), 'growth-coach-error'
            ) : ''}
            <div class="row row--wrap gap-3 growth-coach-cta">
                ${UI.button({
                    variant: 'primary', icon: 'sparkles', id: 'growth-coach-btn', action: 'growth:generateCoach',
                    label: state === 'error' ? t('growth.coach.retry') : t('growth.coach.generate'),
                })}
                <span class="text-meta">${t('growth.coach.time')}</span>
            </div>
        `;
    },

    // ─── Settings: keywords, hashtag sets, competitors, audience ─────────────
    /** "#ذكاء_اصطناعي, prompt ،AI" → ['ذكاء_اصطناعي', 'prompt', 'AI']: letters, digits and _ only, deduped. */
    normTags(raw) {
        const parts = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,،؛;]+/);
        const out = [];
        const seen = new Set();
        parts.forEach((part) => {
            const tag = String(part || '').trim().replace(/^#+/, '');
            if (!tag || !/^[\p{L}\p{M}\p{N}_]+$/u.test(tag)) return;
            const key = UI.normalizeArabic(tag);
            if (seen.has(key)) return;
            seen.add(key);
            out.push(tag);
        });
        return out.slice(0, this.SET_TAGS_MAX);
    },

    normalizeKeyword(raw) {
        return String(raw || '').replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim();
    },

    normalizeUsername(raw) {
        return String(raw || '').trim().replace(/^@+/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, '').toLowerCase();
    },

    normalizeSettings(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const strings = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : []);
        return {
            keywords: strings(s.keywords).map((k) => this.normalizeKeyword(k)).filter(Boolean),
            hashtag_sets: (Array.isArray(s.hashtag_sets) ? s.hashtag_sets : [])
                .filter((x) => x && typeof x === 'object')
                .map((x) => ({ name: String(x.name || '').trim(), tags: this.normTags(x.tags) })),
            competitors: strings(s.competitors).map((u) => this.normalizeUsername(u)).filter(Boolean),
            audience: s.audience && typeof s.audience === 'object' && !Array.isArray(s.audience) ? { ...s.audience } : {},
            // The goals (v24). Null when the server did not send one, so nothing invents a target.
            goal_followers: this.parseGoal(s.goal_followers),
            goal_views: this.parseGoal(s.goal_views),
        };
    },

    /**
     * A goal as typed or as stored: a whole number from 1 to GOAL_MAX, with thousands
     * separators and Arabic-Indic digits accepted. Null for anything else.
     */
    parseGoal(raw) {
        if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
        const text = String(raw).trim()
            .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
            .replace(/[\s,\u066C\u060C]/g, '');
        if (!/^\d+$/.test(text)) return null;
        const n = Number(text);
        return Number.isSafeInteger(n) && n >= 1 && n <= this.GOAL_MAX ? n : null;
    },

    /**
     * The PUT body: the whole settings, so replace and merge semantics both come out right. The
     * goals are left out on purpose — the route keeps a key it is not sent — so a keyword add
     * cannot overwrite a goal saved from another tab. They are sent by `saveGoals` alone.
     */
    settingsPayload(settings) {
        const s = this.normalizeSettings(settings);
        return {
            keywords: s.keywords,
            hashtag_sets: s.hashtag_sets.map((x) => ({ name: x.name, tags: x.tags })),
            competitors: s.competitors,
            audience: s.audience,
        };
    },

    currentSettings() {
        return this.settings || this.normalizeSettings(null);
    },

    /**
     * Save, optimistically, one at a time: the region shows the change at once, and a failure
     * puts back what the server last agreed to, and says so. Serialised so two quick adds
     * cannot race each other's PUT.
     */
    saveSettings(next, region, body) {
        const run = async () => {
            const tenant = this._tenantEpoch;
            const prev = this.settings;
            this.settings = this.normalizeSettings(next);
            this.paintSeoRegion(region);
            try {
                const res = await API.saveGrowthSettings(body || this.settingsPayload(this.settings));
                if (tenant !== this._tenantEpoch) return false;
                if (res && res.settings) this.settings = this.normalizeSettings(res.settings);
                this.paintSeoRegion(region);
                return true;
            } catch (err) {
                if (tenant !== this._tenantEpoch) return false;
                this.settings = prev;
                this.paintSeoRegion(region);
                UI.toast(t('growth.settings.saveFailed', { message: (err && err.message) || t('error.unexpected') }), 'error');
                return false;
            }
        };
        const chain = (this._saveChain || Promise.resolve()).then(run, run);
        this._saveChain = chain.catch(() => false);
        return chain;
    },

    paintSeoRegion(region) {
        if (region === 'keywords') this.paintRegion('growth-keywords', this.keywordsMarkup());
        else if (region === 'hashtags') this.paintRegion('growth-hashtags', this.hashtagsMarkup());
        else if (region === 'competitors') this.paintRegion('growth-competitors', this.competitorsMarkup());
        else if (region === 'goals') this.paintRegion('growth-goals', this.goalsMarkup());
    },

    formError(form) {
        const message = this.formErrors[form];
        return message ? html`<p class="form-hint text-warning growth-form-error" id="growth-${form}-error" role="alert" dir="auto">${message}</p>` : '';
    },

    setFormError(form, message, region) {
        if (message) this.formErrors[form] = message;
        else delete this.formErrors[form];
        this.paintSeoRegion(region);
        const input = document.getElementById(`growth-${form}-input`);
        if (message && input) UI.markInvalid(input, `growth-${form}-error`);
    },

    seoMarkup() {
        if (this.showsSkeleton('seo')) return html`${Motion.cardGrid(3, 3)}${Motion.busy()}`;
        if (this.settingsError && !this.settings) {
            return html`<div class="surface pad-5">${this.errorHost(this.settingsError, t('growth.settings.failed'), 'settings')}</div>`;
        }
        return html`
            <section class="surface pad-5 growth-seo-card" id="growth-goals" aria-labelledby="growth-goals-title">${this.goalsMarkup()}</section>
            <section class="surface pad-5 growth-seo-card" id="growth-keywords" aria-labelledby="growth-keywords-title">${this.keywordsMarkup()}</section>
            <section class="surface pad-5 growth-seo-card" id="growth-hashtags" aria-labelledby="growth-hashtags-title">${this.hashtagsMarkup()}</section>
            <section class="surface pad-5 growth-seo-card" id="growth-competitors" aria-labelledby="growth-competitors-title">${this.competitorsMarkup()}</section>
        `;
    },

    // ─── Goals (v24) ─────────────────────────────────────────────────────────
    /** A goal field's value: what was typed, else the saved goal, else empty. */
    goalFieldValue(key) {
        const draft = this.drafts[`goal_${key}`];
        if (draft !== null && draft !== undefined) return draft;
        const saved = this.currentSettings()[`goal_${key}`];
        return saved === null || saved === undefined ? '' : String(saved);
    },

    goalsMarkup() {
        const field = (key) => html`
            <div class="form-group">
                <label class="form-label" for="growth-goal-${key}-input">${t(`growth.goals.${key}`)}</label>
                <input class="field" type="text" inputmode="numeric" autocomplete="off" dir="ltr"
                       id="growth-goal-${key}-input" name="goal_${key}" maxlength="13"
                       value="${this.goalFieldValue(key)}" data-input="growth:draftInput" data-draft="goal_${key}">
                ${this.formError(`goal-${key}`)}
            </div>
        `;
        return html`
            <div class="growth-section-head">
                <div class="growth-section-heading">
                    <h2 class="section-title" id="growth-goals-title"><i data-lucide="flag" aria-hidden="true"></i> ${t('growth.goals.title')}</h2>
                    <p class="text-meta">${t('growth.goals.lede')}</p>
                </div>
            </div>
            <form class="growth-goals-form" data-submit="growth:saveGoals" novalidate>
                ${field('followers')}
                ${field('views')}
                <div class="form-group">
                    ${UI.button({ variant: 'secondary', type: 'submit', icon: 'check', label: t('growth.goals.save'), id: 'growth-goals-save' })}
                </div>
            </form>
        `;
    },

    /**
     * PUT just the two goals. Each field is checked here first and says what is wrong under
     * itself; the server checks again (a whole number above zero, at most a billion).
     */
    async saveGoals(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const read = (key) => {
            const el = document.getElementById(`growth-goal-${key}-input`);
            if (el) return el.value;
            return form && form.fields ? form.fields[`goal_${key}`] : this.goalFieldValue(key);
        };
        const typed = { followers: String(read('followers') ?? ''), views: String(read('views') ?? '') };
        const parsed = { followers: this.parseGoal(typed.followers), views: this.parseGoal(typed.views) };
        const bad = this.GOAL_KEYS.filter((key) => parsed[key] === null);
        this.GOAL_KEYS.forEach((key) => { delete this.formErrors[`goal-${key}`]; });
        if (bad.length) {
            bad.forEach((key) => { this.formErrors[`goal-${key}`] = t('growth.goals.invalid'); });
            this.drafts.goal_followers = typed.followers;
            this.drafts.goal_views = typed.views;
            this.paintSeoRegion('goals');
            bad.slice().reverse().forEach((key) => {
                const input = document.getElementById(`growth-goal-${key}-input`);
                if (input) UI.markInvalid(input, `growth-goal-${key}-error`);
            });
            return false;
        }
        this.drafts.goal_followers = null;
        this.drafts.goal_views = null;
        const s = this.currentSettings();
        const body = { goal_followers: parsed.followers, goal_views: parsed.views };
        const ok = await this.saveSettings({ ...s, ...body }, 'goals', body);
        if (ok) UI.toast(t('growth.goals.saved'));
        else {
            this.drafts.goal_followers = typed.followers;
            this.drafts.goal_views = typed.views;
            this.paintSeoRegion('goals');
        }
        return ok;
    },

    // ─── Keywords ────────────────────────────────────────────────────────────
    hasKeyword(list, keyword) {
        const key = UI.normalizeArabic(keyword);
        return list.some((k) => UI.normalizeArabic(k) === key);
    },

    /** Is `raw` addable to `list`? `{ ok, keyword }` or `{ ok: false, message }`. Pure. */
    checkKeyword(list, raw) {
        const keyword = this.normalizeKeyword(raw);
        if (!keyword) return { ok: false, message: t('growth.keywords.required') };
        if (Array.from(keyword).length > this.KEYWORD_MAX_LEN) return { ok: false, message: t('growth.keywords.tooLong', { max: this.KEYWORD_MAX_LEN }) };
        if (this.hasKeyword(list, keyword)) return { ok: false, message: t('growth.keywords.duplicate', { keyword }) };
        if (list.length >= this.KEYWORDS_MAX) return { ok: false, message: t('growth.keywords.full', { max: this.KEYWORDS_MAX }) };
        return { ok: true, keyword };
    },

    async addKeyword(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const input = document.getElementById('growth-keyword-input');
        const raw = input ? input.value : (form && form.fields ? form.fields.keyword : '');
        const s = this.currentSettings();
        const check = this.checkKeyword(s.keywords, raw);
        if (!check.ok) { this.setFormError('keyword', check.message, 'keywords'); return; }
        delete this.formErrors.keyword;
        this.drafts.keyword = '';
        const ok = await this.saveSettings({ ...s, keywords: [...s.keywords, check.keyword] }, 'keywords');
        const fresh = document.getElementById('growth-keyword-input');
        if (!ok) {
            this.drafts.keyword = String(raw || '');
            if (fresh) fresh.value = this.drafts.keyword;
        }
        if (fresh) fresh.focus();
    },

    async removeKeyword(el) {
        const s = this.currentSettings();
        const i = Number(el && el.dataset ? el.dataset.index : NaN);
        if (!Number.isInteger(i) || i < 0 || i >= s.keywords.length) return;
        const keyword = s.keywords[i];
        const ok = await this.saveSettings({ ...s, keywords: s.keywords.filter((_, k) => k !== i) }, 'keywords');
        if (ok) Motion.announce(t('growth.keywords.removed', { keyword }));
        const next = document.getElementById('growth-keyword-input');
        if (next) next.focus();
    },

    async addSuggested(el) {
        const i = Number(el && el.dataset ? el.dataset.index : NaN);
        const idea = this.suggest && this.suggest.keywords && this.suggest.keywords[i];
        if (!idea) return;
        const s = this.currentSettings();
        const check = this.checkKeyword(s.keywords, idea.term);
        if (!check.ok) { UI.toast(check.message, 'error'); return; }
        const ok = await this.saveSettings({ ...s, keywords: [...s.keywords, check.keyword] }, 'keywords');
        if (ok) UI.toast(t('growth.keywords.added', { keyword: check.keyword }));
    },

    /** POST /keywords/suggest with `{ topic }`. The answers are ideas, and are labelled as such. */
    async suggestKeywords(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (this.suggest && this.suggest.status === 'loading') return;
        const input = document.getElementById('growth-topic-input');
        const topic = String(input ? input.value : (form && form.fields ? form.fields.topic : '') || '').replace(/\s+/g, ' ').trim();
        if (!topic) { this.setFormError('topic', t('growth.suggest.required'), 'keywords'); return; }
        delete this.formErrors.topic;
        this.drafts.topic = topic;
        const tenant = this._tenantEpoch;
        this.suggest = { status: 'loading', topic, keywords: [], hashtags: [], error: null };
        this.paintSeoRegion('keywords');
        try {
            const res = await API.suggestGrowthKeywords(topic);
            if (tenant !== this._tenantEpoch) return;
            const r = res && typeof res === 'object' ? res : {};
            const keywords = (Array.isArray(r.keywords) ? r.keywords : [])
                .map((k) => (typeof k === 'string' ? { term: k, why: '' } : k))
                .filter((k) => k && typeof k === 'object' && this.normalizeKeyword(k.term))
                .map((k) => ({ term: this.normalizeKeyword(k.term), why: String(k.why || '').trim() }));
            this.suggest = { status: 'ready', topic, keywords, hashtags: this.normTags(r.hashtags), error: null };
            Motion.announce(t('growth.suggest.ready', { n: UI.formatNumber(keywords.length) }));
        } catch (err) {
            if (tenant !== this._tenantEpoch) return;
            this.suggest = { status: 'error', topic, keywords: [], hashtags: [], error: err };
        }
        this.paintSeoRegion('keywords');
    },

    suggestMarkup() {
        const sg = this.suggest;
        if (!sg) return '';
        if (sg.status === 'loading') {
            return html`<p class="growth-suggest-busy" role="status"><span class="spinner spinner-sm" aria-hidden="true"></span> ${t('growth.suggest.loading', { topic: sg.topic })}</p>`;
        }
        if (sg.status === 'error') {
            return UI.errorStrip(t('growth.suggest.failed', { message: (sg.error && sg.error.message) || t('error.unexpected') }), '', 'growth-suggest-error');
        }
        const list = this.currentSettings().keywords;
        return html`
            <div class="growth-suggest" id="growth-suggest">
                <p class="growth-ai-label"><i data-lucide="sparkles" aria-hidden="true"></i> ${t('growth.suggest.aiLabel')}</p>
                ${sg.keywords.length ? html`
                    <ul class="growth-suggest-list">
                        ${sg.keywords.map((k, i) => html`
                            <li class="growth-idea">
                                <span class="growth-idea-text">
                                    <span class="growth-idea-term user-content" dir="auto">${k.term}</span>
                                    ${k.why ? html`<span class="text-meta user-content" dir="auto">${k.why}</span>` : ''}
                                </span>
                                ${this.hasKeyword(list, k.term)
                                    ? html`<span class="chip"><i data-lucide="check" aria-hidden="true"></i> ${t('growth.suggest.inList')}</span>`
                                    : UI.button({ variant: 'ghost', size: 'sm', icon: 'plus', label: t('growth.suggest.add'), action: 'growth:addSuggested', data: { index: i }, ariaLabel: t('growth.suggest.addNamed', { keyword: k.term }) })}
                            </li>
                        `)}
                    </ul>
                ` : html`<p class="text-meta">${t('growth.suggest.none')}</p>`}
                ${sg.hashtags.length ? html`
                    <p class="growth-suggest-tags">
                        <span class="form-label">${t('growth.suggest.hashtags')}</span>
                        ${sg.hashtags.map((tag) => html`<span class="chip" dir="auto">#${tag}</span>`)}
                    </p>
                    ${UI.button({ variant: 'secondary', size: 'sm', icon: 'hash', label: t('growth.suggest.saveSet'), action: 'growth:setFromSuggestion', id: 'growth-suggest-set' })}
                ` : ''}
            </div>
        `;
    },

    keywordsMarkup() {
        const s = this.currentSettings();
        const n = s.keywords.length;
        return html`
            <div class="growth-section-head">
                <div class="growth-section-heading">
                    <h2 class="section-title" id="growth-keywords-title"><i data-lucide="search" aria-hidden="true"></i> ${t('growth.keywords.title')}</h2>
                    <p class="text-meta">${t('growth.keywords.lede')}</p>
                </div>
                <span class="field-count${n >= this.KEYWORDS_MAX ? html.raw(' is-warning') : ''}">${UI.ltr(`${n}/${this.KEYWORDS_MAX}`)}</span>
            </div>
            ${n ? html`
                <ul class="growth-chips" aria-label="${t('growth.keywords.title')}">
                    ${s.keywords.map((k, i) => html`
                        <li class="chip growth-chip">
                            <span class="user-content" dir="auto">${k}</span>
                            <button type="button" class="growth-chip-x" data-action="growth:removeKeyword" data-index="${i}"
                                    data-focus-key="growth-kw-${i}" aria-label="${t('growth.keywords.remove', { keyword: k })}" title="${t('growth.keywords.remove', { keyword: k })}">
                                <i data-lucide="x" aria-hidden="true"></i>
                            </button>
                        </li>
                    `)}
                </ul>
            ` : html`<p class="text-meta growth-empty-line">${t('growth.keywords.empty')}</p>`}
            <form class="growth-inline-form" data-submit="growth:addKeyword" novalidate>
                <label class="form-label" for="growth-keyword-input">${t('growth.keywords.add')}</label>
                <div class="growth-inline-row">
                    <input class="field user-content" id="growth-keyword-input" name="keyword" dir="auto" autocomplete="off"
                           maxlength="${this.KEYWORD_MAX_LEN}" placeholder="${t('growth.keywords.placeholder')}"
                           value="${this.drafts.keyword}" data-input="growth:draftInput" data-draft="keyword">
                    ${UI.button({ variant: 'secondary', type: 'submit', icon: 'plus', label: t('growth.keywords.addButton') })}
                </div>
                ${this.formError('keyword')}
            </form>
            <form class="growth-inline-form growth-suggest-form" data-submit="growth:suggestKeywords" novalidate>
                <label class="form-label" for="growth-topic-input">${t('growth.suggest.topic')}</label>
                <div class="growth-inline-row">
                    <input class="field user-content" id="growth-topic-input" name="topic" dir="auto" autocomplete="off" maxlength="120"
                           placeholder="${t('growth.suggest.placeholder')}" value="${this.drafts.topic}"
                           data-input="growth:draftInput" data-draft="topic">
                    ${UI.button({
                        variant: 'secondary', type: 'submit', icon: 'sparkles', id: 'growth-suggest-btn',
                        label: t('growth.suggest.button'), busy: !!(this.suggest && this.suggest.status === 'loading'),
                    })}
                </div>
                ${this.formError('topic')}
            </form>
            ${this.suggestMarkup()}
            <p class="form-hint">${t('growth.keywords.how')} ${UI.helpLink('seo#keywords', t('help.link.seoKeywords'))}</p>
        `;
    },

    // ─── Hashtag sets ────────────────────────────────────────────────────────
    tagsText(tags) {
        return (tags || []).map((tag) => `#${tag}`).join(' ');
    },

    async copySet(el) {
        const s = this.currentSettings();
        const set = s.hashtag_sets[Number(el && el.dataset ? el.dataset.index : NaN)];
        if (!set) return;
        try {
            await navigator.clipboard.writeText(this.tagsText(set.tags));
            UI.toast(t('growth.sets.copied', { count: set.tags.length, n: UI.formatNumber(set.tags.length) }));
        } catch {
            UI.toast(t('setup.copyFailed'), 'error');
        }
    },

    openSetEditor(el) {
        const s = this.currentSettings();
        const raw = el && el.dataset ? el.dataset.index : undefined;
        const index = raw === undefined || raw === '' ? -1 : Number(raw);
        const set = index >= 0 ? s.hashtag_sets[index] : null;
        if (index >= 0 && !set) return;
        if (index < 0 && s.hashtag_sets.length >= this.SETS_MAX) { UI.toast(t('growth.sets.full', { max: this.SETS_MAX }), 'error'); return; }
        this.setEditor = { index, name: set ? set.name : '', tags: set ? this.tagsText(set.tags) : '' };
        delete this.formErrors.set;
        this.paintSeoRegion('hashtags');
        const name = document.getElementById('growth-set-name');
        if (name) name.focus();
    },

    setFromSuggestion() {
        const sg = this.suggest;
        if (!sg || !sg.hashtags.length) return;
        if (typeof App !== 'undefined' && typeof App.goWithQuery === 'function' && this.view() !== 'seo') App.goWithQuery('growth', { tab: 'seo' });
        this.setEditor = { index: -1, name: String(sg.topic || '').slice(0, this.SET_NAME_MAX), tags: this.tagsText(sg.hashtags.slice(0, this.SET_TAGS_ADVISED)) };
        delete this.formErrors.set;
        this.paintSeoRegion('hashtags');
        const name = document.getElementById('growth-set-name');
        if (name && typeof name.scrollIntoView === 'function') name.scrollIntoView({ block: 'center' });
        if (name) name.focus();
    },

    closeSetEditor() {
        this.setEditor = null;
        delete this.formErrors.set;
        this.paintSeoRegion('hashtags');
        const add = document.getElementById('growth-set-new');
        if (add) add.focus();
    },

    /** Typing in the set form updates state and the live count, never the whole region. */
    setEditorInput(el) {
        if (!this.setEditor || !el) return;
        if (el.id === 'growth-set-name') this.setEditor.name = el.value;
        if (el.id === 'growth-set-tags') {
            this.setEditor.tags = el.value;
            const count = document.getElementById('growth-set-count');
            if (count) count.innerHTML = esc(this.setCountMarkup(this.normTags(el.value).length));
        }
    },

    setCountMarkup(n) {
        const over = n > this.SET_TAGS_ADVISED;
        return html`<span class="${over ? html.raw('text-warning') : ''}">${t('growth.sets.count', { count: n, n: UI.formatNumber(n) })}${over ? html` · ${t('growth.sets.tooMany', { max: this.SET_TAGS_ADVISED })}` : ''}</span>`;
    },

    /** Can this set be saved into `sets`? `{ ok, set }` or `{ ok: false, message }`. Pure. */
    checkSet(sets, index, name, tagsRaw) {
        const clean = String(name || '').replace(/\s+/g, ' ').trim();
        if (!clean) return { ok: false, message: t('growth.sets.nameRequired') };
        if (Array.from(clean).length > this.SET_NAME_MAX) return { ok: false, message: t('growth.sets.nameTooLong', { max: this.SET_NAME_MAX }) };
        const clash = sets.some((s, i) => i !== index && UI.normalizeArabic(s.name) === UI.normalizeArabic(clean));
        if (clash) return { ok: false, message: t('growth.sets.nameTaken', { name: clean }) };
        const tags = this.normTags(tagsRaw);
        if (!tags.length) return { ok: false, message: t('growth.sets.tagsRequired') };
        return { ok: true, set: { name: clean, tags } };
    },

    async saveSet(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const ed = this.setEditor;
        if (!ed) return;
        const nameEl = document.getElementById('growth-set-name');
        const tagsEl = document.getElementById('growth-set-tags');
        const s = this.currentSettings();
        const check = this.checkSet(s.hashtag_sets, ed.index, nameEl ? nameEl.value : ed.name, tagsEl ? tagsEl.value : ed.tags);
        if (!check.ok) {
            this.formErrors.set = check.message;
            this.paintSeoRegion('hashtags');
            const field = document.getElementById(check.message === t('growth.sets.tagsRequired') ? 'growth-set-tags' : 'growth-set-name');
            if (field) UI.markInvalid(field, 'growth-set-error');
            return;
        }
        const sets = [...s.hashtag_sets];
        if (ed.index >= 0) sets[ed.index] = check.set;
        else sets.push(check.set);
        this.setEditor = null;
        delete this.formErrors.set;
        const ok = await this.saveSettings({ ...s, hashtag_sets: sets }, 'hashtags');
        if (ok) UI.toast(t('growth.sets.saved', { name: check.set.name }));
    },

    deleteSet(el) {
        const s = this.currentSettings();
        const index = Number(el && el.dataset ? el.dataset.index : NaN);
        const set = s.hashtag_sets[index];
        if (!set) return;
        Admin.confirm({
            title: t('growth.sets.deleteTitle'),
            body: t('growth.sets.deleteBody', { name: set.name }),
            confirmLabel: t('common.delete'),
            onConfirm: () => this.saveSettings({ ...s, hashtag_sets: s.hashtag_sets.filter((_, i) => i !== index) }, 'hashtags'),
        });
    },

    setEditorMarkup() {
        const ed = this.setEditor;
        const n = this.normTags(ed.tags).length;
        return html`
            <form class="growth-set-form" data-submit="growth:saveSet" novalidate>
                <div class="form-group">
                    <label class="form-label" for="growth-set-name">${t('growth.sets.name')}</label>
                    <input class="field user-content" id="growth-set-name" dir="auto" maxlength="${this.SET_NAME_MAX}" autocomplete="off"
                           value="${ed.name}" placeholder="${t('growth.sets.namePlaceholder')}" data-input="growth:setEditorInput">
                </div>
                <div class="form-group">
                    <div class="field-head">
                        <label class="form-label" for="growth-set-tags">${t('growth.sets.tags')}</label>
                        <span class="field-count" id="growth-set-count">${this.setCountMarkup(n)}</span>
                    </div>
                    <textarea class="field-textarea user-content" id="growth-set-tags" dir="auto" rows="3"
                              placeholder="${t('growth.sets.tagsPlaceholder')}" data-input="growth:setEditorInput"
                              aria-describedby="growth-set-hint">${ed.tags}</textarea>
                    <p class="form-hint" id="growth-set-hint">${t('growth.sets.tagsHint', { max: this.SET_TAGS_ADVISED })}</p>
                </div>
                ${this.formErrors.set ? html`<p class="form-hint text-warning" id="growth-set-error" role="alert" dir="auto">${this.formErrors.set}</p>` : ''}
                <div class="row row--wrap gap-2">
                    ${UI.button({ variant: 'secondary', type: 'submit', icon: 'check', label: t('growth.sets.save') })}
                    ${UI.button({ variant: 'ghost', label: t('common.cancel'), action: 'growth:closeSetEditor' })}
                </div>
            </form>
        `;
    },

    hashtagsMarkup() {
        const s = this.currentSettings();
        const ed = this.setEditor;
        return html`
            <div class="growth-section-head">
                <div class="growth-section-heading">
                    <h2 class="section-title" id="growth-hashtags-title"><i data-lucide="hash" aria-hidden="true"></i> ${t('growth.sets.title')}</h2>
                    <p class="text-meta">${t('growth.sets.lede', { max: this.SET_TAGS_ADVISED })}</p>
                </div>
                ${ed ? '' : UI.button({ variant: 'secondary', size: 'sm', icon: 'plus', label: t('growth.sets.new'), action: 'growth:openSetEditor', id: 'growth-set-new' })}
            </div>
            ${ed && ed.index < 0 ? this.setEditorMarkup() : ''}
            ${s.hashtag_sets.length ? html`
                <ul class="growth-sets">
                    ${s.hashtag_sets.map((set, i) => (ed && ed.index === i ? html`<li class="growth-set is-editing">${this.setEditorMarkup()}</li>` : html`
                        <li class="growth-set">
                            <div class="growth-set-head">
                                <h3 class="growth-set-name user-content" dir="auto">${set.name}</h3>
                                <span class="text-meta">${t('growth.sets.count', { count: set.tags.length, n: UI.formatNumber(set.tags.length) })}</span>
                                ${set.tags.length > this.SET_TAGS_ADVISED ? html`<span class="chip">${t('growth.sets.tooMany', { max: this.SET_TAGS_ADVISED })}</span>` : ''}
                            </div>
                            <p class="growth-set-tags">${set.tags.map((tag) => html`<span class="chip" dir="auto">#${tag}</span>`)}</p>
                            <div class="growth-set-actions">
                                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'copy', label: t('growth.sets.copy'), action: 'growth:copySet', data: { index: i }, ariaLabel: t('growth.sets.copyNamed', { name: set.name }), focusKey: `growth-set-copy-${i}` })}
                                ${UI.button({ variant: 'ghost', size: 'sm', icon: 'pencil', label: t('common.edit'), action: 'growth:openSetEditor', data: { index: i }, ariaLabel: t('growth.sets.editNamed', { name: set.name }) })}
                                <button type="button" class="icon-btn icon-btn-danger" data-action="growth:deleteSet" data-index="${i}"
                                        aria-label="${t('growth.sets.deleteNamed', { name: set.name })}" title="${t('growth.sets.deleteNamed', { name: set.name })}">
                                    <i data-lucide="trash-2" aria-hidden="true"></i>
                                </button>
                            </div>
                        </li>
                    `))}
                </ul>
            ` : ed ? '' : html`<p class="text-meta growth-empty-line">${t('growth.sets.empty')}</p>`}
            <p class="form-hint">${UI.helpLink('seo#hashtags', t('help.link.seoHashtags'))}</p>
        `;
    },

    // ─── Competitors (Business Discovery) ────────────────────────────────────
    maybeLoadCompetitors() {
        if (this.view() !== 'seo') return;
        const s = this.settings;
        if (!s || !s.competitors.length) return;
        if (this.competitorsState === 'idle') this.loadCompetitors();
    },

    /** The response is an array, `{ competitors }`, or a missing-permission answer in any of its shapes. */
    readCompetitors(res) {
        const missing = (v) => !!v && typeof v === 'object' && (v.status === 'missing_permission' || v.error === 'missing_permission'
            || v.code === 'missing_permission' || v.missing_permission === true);
        if (missing(res)) return { missing: true, list: [] };
        const list = Array.isArray(res) ? res : res && Array.isArray(res.competitors) ? res.competitors : [];
        return { missing: false, list: list.filter((c) => c && typeof c === 'object' && c.username) };
    },

    async loadCompetitors() {
        const seq = ++this._competitorsSeq;
        const tenant = this._tenantEpoch;
        this.competitorsState = 'loading';
        this.competitorsError = null;
        this.paintSeoRegion('competitors');
        try {
            const res = await API.getGrowthCompetitors();
            if (seq !== this._competitorsSeq || tenant !== this._tenantEpoch) return;
            const read = this.readCompetitors(res);
            this.competitors = read.list;
            this.competitorsState = read.missing ? 'missing' : 'ready';
        } catch (err) {
            if (seq !== this._competitorsSeq || tenant !== this._tenantEpoch) return;
            const read = this.readCompetitors(err && err.body);
            if (read.missing) this.competitorsState = 'missing';
            else { this.competitorsState = 'error'; this.competitorsError = err; }
        }
        this.paintSeoRegion('competitors');
    },

    async addCompetitor(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const input = document.getElementById('growth-competitor-input');
        const username = this.normalizeUsername(input ? input.value : (form && form.fields ? form.fields.username : ''));
        const s = this.currentSettings();
        let message = '';
        if (!username) message = t('growth.competitors.required');
        else if (!this.USERNAME_RE.test(username)) message = t('growth.competitors.invalid');
        else if (s.competitors.includes(username)) message = t('growth.competitors.duplicate', { username });
        else if (s.competitors.length >= this.COMPETITORS_MAX) message = t('growth.competitors.full', { max: this.COMPETITORS_MAX });
        if (message) { this.setFormError('competitor', message, 'competitors'); return; }
        delete this.formErrors.competitor;
        this.drafts.competitor = '';
        const ok = await this.saveSettings({ ...s, competitors: [...s.competitors, username] }, 'competitors');
        if (ok) this.loadCompetitors();
        else this.drafts.competitor = username;
        const fresh = document.getElementById('growth-competitor-input');
        if (fresh) {
            if (!ok) fresh.value = username;
            fresh.focus();
        }
    },

    async removeCompetitor(el) {
        const s = this.currentSettings();
        const username = String(el && el.dataset ? el.dataset.username || '' : '');
        if (!s.competitors.includes(username)) return;
        const ok = await this.saveSettings({ ...s, competitors: s.competitors.filter((u) => u !== username) }, 'competitors');
        if (ok) {
            this.competitors = this.competitors.filter((c) => this.normalizeUsername(c.username) !== username);
            this.paintSeoRegion('competitors');
            Motion.announce(t('growth.competitors.removed', { username }));
        }
    },

    /** Average likes + comments over the recent posts, and that as a share of followers. */
    competitorStats(c) {
        const recent = Array.isArray(c.recent) ? c.recent : [];
        const counted = recent.map((p) => {
            const likes = this.num(p && p.like_count);
            const comments = this.num(p && p.comments_count);
            return likes === null && comments === null ? null : (likes || 0) + (comments || 0);
        }).filter((v) => v !== null);
        const avg = counted.length ? counted.reduce((a, b) => a + b, 0) / counted.length : this.num(c.avg_engagement);
        const followers = this.num(c.followers);
        const rate = avg !== null && followers ? avg / followers : null;
        return { avg, rate, followers, posts: this.num(c.media_count) };
    },

    /** As many recent posts as Business Discovery returns for a competitor (`BD_MEDIA_LIMIT`). */
    OWN_RATE_POSTS: 12,

    /**
     * G11: the operator's own rate, measured exactly as a competitor's is — likes + comments per
     * post over the latest Instagram posts, as a share of Instagram followers — so the two sit
     * side by side as the same number. It is not the engagement-rate KPI (per REACH), which a
     * competitor's account never shares. Only from what this page has already read; null otherwise.
     */
    ownRate() {
        const recent = (Array.isArray(this.posts) ? this.posts : [])
            .filter((p) => p && this.platformKey(p.platform) === 'instagram' && Number.isFinite(Date.parse(p.published_at || '')))
            .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
            .slice(0, this.OWN_RATE_POSTS);
        const counted = recent.map((p) => {
            const likes = this.metric(p, 'likes');
            const comments = this.metric(p, 'comments');
            return likes === null && comments === null ? null : (likes || 0) + (comments || 0);
        }).filter((v) => v !== null);
        const rows = this.overview && Array.isArray(this.overview.by_platform) ? this.overview.by_platform : [];
        const ig = rows.find((r) => r && this.platformKey(r.platform) === 'instagram');
        const followers = ig ? this.num(ig.followers) : null;
        const avg = counted.length ? counted.reduce((a, b) => a + b, 0) / counted.length : null;
        const rate = avg !== null && followers ? avg / followers : null;
        return { rate, avg, followers, posts: counted.length };
    },

    ownRateMarkup() {
        const own = this.ownRate();
        return html`
            <p class="growth-own-rate" id="growth-own-rate">
                <span>${t('growth.competitors.ownRate')}</span>
                <strong>${own.rate === null ? '—' : this.formatRate(own.rate)}</strong>
                <span class="text-meta">${own.rate === null ? t('growth.competitors.ownRateMissing') : t('growth.competitors.ownRateHow', { posts: this.postsText(own.posts) })}</span>
            </p>
        `;
    },

    competitorCard(c) {
        const username = this.normalizeUsername(c.username);
        const stats = this.competitorStats(c);
        const recent = (Array.isArray(c.recent) ? c.recent : []).slice(0, 3);
        const profile = `https://www.instagram.com/${encodeURIComponent(username)}/`;
        if (c.error) {
            return html`
                <li class="growth-competitor is-failed">
                    <p class="growth-competitor-head"><a class="username-link" href="${profile}" target="_blank" rel="noopener noreferrer">${UI.ltr(`@${username}`)}</a></p>
                    <p class="text-meta" dir="auto">${t('growth.competitors.lookupFailed')}</p>
                </li>
            `;
        }
        return html`
            <li class="growth-competitor">
                <p class="growth-competitor-head">
                    <a class="username-link" href="${profile}" target="_blank" rel="noopener noreferrer">${UI.ltr(`@${username}`)}</a>
                </p>
                <dl class="growth-competitor-stats">
                    <div><dt>${t('growth.competitors.followers')}</dt><dd>${this.formatCount(stats.followers)}</dd></div>
                    <div><dt>${t('growth.competitors.posts')}</dt><dd>${this.formatCount(stats.posts)}</dd></div>
                    <div><dt>${t('growth.competitors.avg')}</dt><dd>${stats.avg === null ? '—' : UI.formatNumber(Math.round(stats.avg))}</dd></div>
                    <div><dt>${t('growth.competitors.rate')}</dt><dd>${stats.rate === null ? '—' : this.formatRate(stats.rate)}</dd></div>
                </dl>
                ${recent.length ? html`
                    <ol class="growth-competitor-recent" aria-label="${t('growth.competitors.recent', { username })}">
                        ${recent.map((p) => {
                            const link = safeUrl(p && p.permalink);
                            return html`
                                <li>
                                    <span class="chip">${this.typeLabel(this.typeKey(p && p.media_type))}</span>
                                    <span class="growth-competitor-numbers">${t('growth.competitors.likes', { n: this.formatCount(p && p.like_count) })} · ${t('growth.competitors.comments', { n: this.formatCount(p && p.comments_count) })}</span>
                                    <span class="text-meta">${p && p.timestamp ? UI.formatDayShort(p.timestamp) : ''}</span>
                                    ${link ? html`<a class="growth-permalink" href="${link}" target="_blank" rel="noopener noreferrer"><i data-lucide="external-link" aria-hidden="true"></i><span class="sr-only">${t('growth.posts.open', { where: t('common.instagram') })}</span></a>` : ''}
                                </li>
                            `;
                        })}
                    </ol>
                ` : ''}
            </li>
        `;
    },

    competitorsBody() {
        const s = this.currentSettings();
        if (!s.competitors.length) return html`<p class="text-meta growth-empty-line">${t('growth.competitors.empty')}</p>`;
        const state = this.competitorsState;
        const names = html`
            <ul class="growth-chips" aria-label="${t('growth.competitors.watching')}">
                ${s.competitors.map((u) => html`
                    <li class="chip growth-chip">
                        ${UI.ltr(`@${u}`)}
                        <button type="button" class="growth-chip-x" data-action="growth:removeCompetitor" data-username="${u}"
                                aria-label="${t('growth.competitors.remove', { username: u })}" title="${t('growth.competitors.remove', { username: u })}">
                            <i data-lucide="x" aria-hidden="true"></i>
                        </button>
                    </li>
                `)}
            </ul>
        `;
        if (state === 'loading' || state === 'idle') {
            return html`${names}<p class="growth-suggest-busy" role="status"><span class="spinner spinner-sm" aria-hidden="true"></span> ${t('growth.competitors.loading')}</p>`;
        }
        if (state === 'missing') {
            return html`
                ${names}
                <div class="studio-callout is-warning" id="growth-competitors-missing" role="note">
                    <i data-lucide="shield-alert" aria-hidden="true"></i>
                    <div class="studio-callout-body">
                        <p class="studio-callout-title">${t('growth.competitors.missingTitle')}</p>
                        <p>${t('growth.competitors.missingBody')}</p>
                        <div class="row row--wrap gap-2">${UI.helpLink('growth#permissions', t('help.link.growthPermissions'))}</div>
                    </div>
                </div>
            `;
        }
        if (state === 'error') return html`${names}${this.errorHost(this.competitorsError, t('growth.competitors.failed'), 'competitors')}`;
        const byName = new Map(this.competitors.map((c) => [this.normalizeUsername(c.username), c]));
        const cards = s.competitors.map((u) => byName.get(u)).filter(Boolean);
        return html`
            ${names}
            ${cards.length ? html`<ul class="growth-competitor-grid">${cards.map((c) => this.competitorCard(c))}</ul>`
                : html`<p class="text-meta">${t('growth.competitors.none')}</p>`}
        `;
    },

    competitorsMarkup() {
        const s = this.currentSettings();
        return html`
            <div class="growth-section-head">
                <div class="growth-section-heading">
                    <h2 class="section-title" id="growth-competitors-title"><i data-lucide="users" aria-hidden="true"></i> ${t('growth.competitors.title')}</h2>
                    <p class="text-meta">${t('growth.competitors.lede')}</p>
                    ${s.competitors.length ? this.ownRateMarkup() : ''}
                </div>
                ${s.competitors.length && this.competitorsState !== 'loading' ? UI.button({
                    variant: 'ghost', size: 'sm', icon: 'refresh-cw', label: t('growth.competitors.refresh'), action: 'growth:loadCompetitors', id: 'growth-competitors-refresh',
                }) : ''}
            </div>
            ${this.competitorsBody()}
            <form class="growth-inline-form" data-submit="growth:addCompetitor" novalidate>
                <label class="form-label" for="growth-competitor-input">${t('growth.competitors.add')}</label>
                <div class="growth-inline-row">
                    <input class="field" id="growth-competitor-input" name="username" dir="ltr" autocomplete="off" spellcheck="false"
                           maxlength="64" placeholder="@username" value="${this.drafts.competitor}"
                           data-input="growth:draftInput" data-draft="competitor">
                    ${UI.button({ variant: 'secondary', type: 'submit', icon: 'user-plus', label: t('growth.competitors.addButton') })}
                </div>
                ${this.formError('competitor')}
                <p class="form-hint">${t('growth.competitors.hint')}</p>
            </form>
        `;
    },

    // ─── Sync, range, sort, filter ───────────────────────────────────────────
    /** "Synced at 14:05 — the next sync opens at 14:15." The server's limit, said before it bites. */
    cooldownText() {
        const last = Date.parse((this.status && this.status.lastSync) || '');
        if (!Number.isFinite(last)) return t('growth.sync.cooldownUnknown');
        return t('growth.sync.cooldown', {
            last: UI.formatTime(new Date(last)),
            next: UI.formatTime(new Date(last + this.SYNC_COOLDOWN_MS)),
        });
    },

    /** "Synced 30 Instagram and 12 Facebook posts", or plainly "Synced" when the counts are not numbers. */
    syncDoneText(synced) {
        const s = synced && typeof synced === 'object' ? synced : {};
        const ig = this.num(s.instagram);
        const fb = this.num(s.facebook);
        if (ig !== null && fb !== null) return t('growth.sync.doneBoth', { ig: UI.formatNumber(ig), fb: UI.formatNumber(fb) });
        if (ig !== null) return t('growth.sync.doneOne', { n: UI.formatNumber(ig), platform: t('common.instagram') });
        if (fb !== null) return t('growth.sync.doneOne', { n: UI.formatNumber(fb), platform: t('common.facebook') });
        return t('growth.sync.done');
    },

    async sync() {
        if (this.syncing) return;
        const tenant = this._tenantEpoch;
        this.syncing = true;
        this.syncNote = null;
        this.paintRegion('growth-toolbar', this.toolbarMarkup());
        try {
            const res = await API.syncGrowth();
            if (tenant !== this._tenantEpoch) return;
            const lastSync = (res && res.lastSync) || new Date().toISOString();
            this.status = { ...(this.status || this.normalizeStatus(null)), lastSync };
            this.syncing = false;
            UI.toast(this.syncDoneText(res && res.synced));
            await this.reloadData({ withStatus: true });
            if (tenant === this._tenantEpoch && this.coachState === 'ready') this.paintRegion('growth-coach', this.coachMarkup());
        } catch (err) {
            if (tenant !== this._tenantEpoch) return;
            this.syncNote = err && err.status === 429
                ? { kind: 'cooldown', message: this.cooldownText() }
                : { kind: 'error', message: t('growth.sync.failed', { message: (err && err.message) || t('error.unexpected') }) };
            Motion.announce(this.syncNote.message);
        } finally {
            if (tenant === this._tenantEpoch) {
                this.syncing = false;
                this.paintRegion('growth-toolbar', this.toolbarMarkup());
            }
        }
    },

    setDays(el) {
        const n = Number(el && el.dataset ? el.dataset.days : NaN);
        if (!this.RANGES.includes(n) || n === this.days) return;
        this.days = n;
        this.savePrefs();
        this.reloadData();
    },

    setMetric(el) {
        const m = el && el.dataset ? el.dataset.metric : '';
        if (!this.TREND_METRICS.includes(m) || m === this.trendMetric) return;
        this.trendMetric = m;
        this.savePrefs();
        this.paintRegion('growth-trend', this.trendMarkup());
    },

    /** A new column sorts high-to-low first (the question is "what did best"); the same column flips. */
    sortBy(key) {
        if (!this.SORT_KEYS.includes(key)) return;
        this.sort = this.sort.key === key
            ? { key, dir: this.sort.dir === 'asc' ? 'desc' : 'asc' }
            : { key, dir: 'desc' };
        this.paintRegion('growth-posts', this.postsMarkup());
        Motion.announce(t('growth.posts.sortedAnnounce', {
            column: t(`growth.metric.${key}`),
            dir: this.sort.dir === 'asc' ? t('growth.posts.asc') : t('growth.posts.desc'),
        }));
    },

    /**
     * G14: the phone's select. It names a column; choosing one sorts best first, like a new
     * header click, and a column already sorted keeps the direction its header set — so the
     * select, the headers' aria-sort and the count line never disagree. It used to repaint
     * silently; it now says what it did, like the headers do.
     */
    sortFromSelect(key) {
        if (!this.SORT_KEYS.includes(key)) return;
        this.sort = key === this.sort.key ? { key, dir: this.sort.dir } : { key, dir: 'desc' };
        this.paintRegion('growth-posts', this.postsMarkup());
        Motion.announce(t('growth.posts.sortedAnnounce', {
            column: t(`growth.metric.${key}`),
            dir: this.sort.dir === 'asc' ? t('growth.posts.asc') : t('growth.posts.desc'),
        }));
    },

    setFilter(which, value) {
        const keys = which === 'platform' ? this.PLATFORM_KEYS : this.TYPE_KEYS;
        this.filter = { ...this.filter, [which]: value === 'all' || keys.includes(value) ? value : 'all' };
        this.postsLimit = this.POSTS_PAGE;
        this.paintRegion('growth-posts', this.postsMarkup());
        Motion.announce(this.postsText(this.visiblePosts().length));
    },

    clearFilters() {
        this.filter = { type: 'all', platform: 'all' };
        this.postsLimit = this.POSTS_PAGE;
        this.paintRegion('growth-posts', this.postsMarkup());
        const type = document.getElementById('growth-filter-type');
        if (type) type.focus();
    },

    morePosts() {
        this.postsLimit += this.POSTS_PAGE;
        this.paintRegion('growth-posts', this.postsMarkup());
    },
};

UI.registerActions('growth', {
    sync: () => GrowthPage.sync(),
    setDays: (el) => GrowthPage.setDays(el),
    setMetric: (el) => GrowthPage.setMetric(el),
    sortBy: (el) => GrowthPage.sortBy(el && el.dataset ? el.dataset.key : ''),
    sortSelect: (el) => GrowthPage.sortFromSelect(el ? el.value : ''),
    filterType: (el) => GrowthPage.setFilter('type', el ? el.value : 'all'),
    filterPlatform: (el) => GrowthPage.setFilter('platform', el ? el.value : 'all'),
    clearFilters: () => GrowthPage.clearFilters(),
    morePosts: () => GrowthPage.morePosts(),
    generateCoach: () => GrowthPage.generateCoach(),
    showPlan: () => GrowthPage.showPlan(),
    editGoal: (el) => GrowthPage.editGoal(el && el.dataset ? el.dataset.goal : ''),
    saveGoals: (form, event) => GrowthPage.saveGoals(form, event),
    draftInput: (el) => {
        const key = el && el.dataset ? el.dataset.draft : '';
        if (key && Object.prototype.hasOwnProperty.call(GrowthPage.drafts, key)) GrowthPage.drafts[key] = String(el.value || '');
    },
    addKeyword: (form, event) => GrowthPage.addKeyword(form, event),
    removeKeyword: (el) => GrowthPage.removeKeyword(el),
    suggestKeywords: (form, event) => GrowthPage.suggestKeywords(form, event),
    addSuggested: (el) => GrowthPage.addSuggested(el),
    setFromSuggestion: () => GrowthPage.setFromSuggestion(),
    openSetEditor: (el) => GrowthPage.openSetEditor(el),
    closeSetEditor: () => GrowthPage.closeSetEditor(),
    setEditorInput: (el) => GrowthPage.setEditorInput(el),
    saveSet: (form, event) => GrowthPage.saveSet(form, event),
    copySet: (el) => GrowthPage.copySet(el),
    deleteSet: (el) => GrowthPage.deleteSet(el),
    addCompetitor: (form, event) => GrowthPage.addCompetitor(form, event),
    removeCompetitor: (el) => GrowthPage.removeCompetitor(el),
    loadCompetitors: () => GrowthPage.loadCompetitors(),
    pickSlot: (el) => GrowthPage.pickSlot(el),
});
