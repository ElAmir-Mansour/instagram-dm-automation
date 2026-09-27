/**
 * Monteur — reels cut from the creator's own videos, waiting for approval.
 *
 * The contract is MONTEUR.md §5 (the operator API) and §1 (the settings). Three
 * parties, and only one of them is this page: a worker on the creator's computer
 * scans a folder, transcribes and renders; the app picks the moments and writes
 * the copy; the creator approves each reel into the existing scheduler, here.
 *
 * ─── What waits on what ─────────────────────────────────────────────────────
 * Everything slow happens on the worker, which is not always on. The worker pill
 * is a measurement (the server's `online`), and while it is off the page says the
 * jobs wait for it instead of looking stuck — the Studio's rule, DESIGN.md §6.
 *
 * ─── Polling ────────────────────────────────────────────────────────────────
 * GET /studio/monteur every 5 s while anything is in flight — a scan, a folder
 * pick, a video being transcribed, picked or rendered, a clip rendering, the
 * Analyst writing — only while the tab is visible, and not at all otherwise. A
 * folder pick polls every 3 s for up to 5 minutes, which is how long the worker
 * keeps its dialog open (§3).
 *
 * ─── Nothing typed is lost to a poll ────────────────────────────────────────
 * The clip and video lists are patched by key (`Motion.patchList`), and a row's
 * signature is its SERVER state only. A poll that changes nothing touches no row,
 * and one that finishes a render never touches the review card being edited next
 * to it. Typing writes into `edits[clipId]` and the settings' `work`; nothing
 * re-renders on a keystroke, so the caret and an Arabic IME survive.
 *
 * ─── Nothing lands after leaving ────────────────────────────────────────────
 * Every await is followed by `alive(seq)` before anything paints or polls, and
 * `schedulePoll(seq)` refuses a seq that is not the current one. A slow re-read
 * finishing after the operator moved to Posts must not start a poll there, and a
 * poll must never write this page over another one.
 *
 * ─── The caption check is «keyword» ─────────────────────────────────────────
 * MONTEUR.md §6.1: the Monteur's ask is a free-form question ending in «keyword»,
 * never `cta.instagramAsk`. So the Instagram/Facebook check is only that the caption
 * names the keyword — which is also what catches a caption still asking for the
 * keyword it had before an edit. TikTok's still carries `cta.tiktokLine`.
 *
 * ─── Times are the tenant's ─────────────────────────────────────────────────
 * run_at and post_at are wall times in the tenant's zone (`MonteurView.timezone`,
 * which is `schedule.timezone`). So every time on this page is shown in that zone,
 * and the Approve override is READ in it too: a reel set for 19:00 goes out at
 * 19:00 Riyadh time whichever laptop the dashboard was opened on.
 */
const MonteurPage = {
    // ─── State ───────────────────────────────────────────────────────────────
    /** The last MonteurView, normalised, or null before the first good read. */
    view: null,
    viewError: null,
    /** A refresh failed after a good read: the page keeps the last view and says so. */
    stale: false,
    /**
     * The tenant's StudioSettings, for two things the view does not carry: the CTA
     * lines a caption must include (`cta.instagramAsk`, `cta.tiktokLine`) and the
     * content language. Optional — without it the checks fall back to the keyword.
     */
    studio: null,
    /** The settings form's working copy of MonteurConfig, and the JSON it started from. */
    work: null,
    _baseline: '',
    _settingsDirty: false,
    /** Settings problems by field key (`run_at`, `post_at.1`), after a refused or locally checked save. */
    fieldProblems: null,
    /** Problems that name no field, and the save error they came with. */
    generalProblems: [],
    saveError: null,
    /** The settings card is open (outside the first-run setup, where it always is). */
    settingsOpen: false,
    /**
     * The first-run setup is on screen. Turned on by a load that finds nothing
     * configured and nothing ever run; turned off only by a successful save — a
     * folder landing from Choose folder half way through must not end the setup.
     */
    setup: false,
    /** clipId → the operator's unsaved values: { title, caption, tiktok_caption, keyword }. */
    edits: {},
    /** clipId → { message, problems }, shown under that card after a refused save or approve. */
    clipErrors: {},
    /** clipId → { open, value }: the Approve time override, and what is typed in it (tenant wall time). */
    overrides: {},
    /** The folder pick in flight: { startedAt, before }, or null. */
    pick: null,
    /** What the last pick came to: { kind: 'set' | 'none' | 'timeout', folder }, or null. */
    pickNote: null,
    /** The Analyst is being run from here: the card says so while the request is out. */
    lessonsBusy: false,

    // ─── Timers and sequencing ───────────────────────────────────────────────
    /** Bumped by every render() and destroy(); a late answer for an older one never paints. */
    _seq: 0,
    /** Bumped by a tenant switch: nothing started before it may land after it. */
    _tenantEpoch: 0,
    _timer: null,
    /** A tick found the tab hidden and stopped; becoming visible resumes it. */
    _parked: false,
    _onVisibility: null,
    _lastRefresh: 0,
    _refreshing: null,
    _refreshAgain: false,
    /** The markup last written into each small region, so a poll that changes nothing writes nothing. */
    _painted: {},
    _clipDirty: {},
    /** clipId → true while its Approve is out: a poll leaves that form alone. */
    _approving: {},
    /** Bumped by every read of the view, so an answer can be told apart from one asked before a pick. */
    _readTicket: 0,

    POLL_MS: 5000,
    PICK_POLL_MS: 3000,
    PICK_LIMIT_MS: 5 * 60 * 1000,
    /** Coming back to the tab re-reads the view when the last read is older than this. */
    STALE_MS: 30 * 1000,

    PLATFORMS: Object.freeze(['instagram', 'facebook', 'tiktok']),
    FIELDS: Object.freeze(['enabled', 'source', 'mode', 'folder', 'run_at', 'videos_per_run', 'reels_per_video', 'platforms', 'post_at', 'min_seconds', 'max_seconds']),
    /** MONTEUR.md §1: where a run takes its videos, and what happens to a reel once it is ready. */
    SOURCES: Object.freeze(['folder', 'course']),
    MODES: Object.freeze(['review', 'auto']),
    NUMBER_FIELDS: Object.freeze(['videos_per_run', 'reels_per_video', 'min_seconds', 'max_seconds']),
    /** MONTEUR.md §1: the ranges the server validates. The server stays the authority. */
    LIMITS: Object.freeze({
        videos_per_run: Object.freeze([1, 10]),
        reels_per_video: Object.freeze([1, 5]),
        min_seconds: Object.freeze([10, 60]),
        max_seconds: Object.freeze([15, 90]),
    }),
    POST_AT_MAX: 4,
    FOLDER_MAX: 1024,
    TITLE_MAX: 60,
    IG_CAPTION_MAX: 2200,
    /** A Monteur post is a video, and a TikTok video's caption goes out as `post_info.title`: 2200 (MAX_TITLE_UTF16). */
    TIKTOK_CAPTION_MAX: 2200,
    /** §6.1: a keyword is one word of at least this many letters. */
    KEYWORD_MIN: 4,
    SCHEDULED_SHOWN: 5,
    LOCAL_TIME: /^([01]\d|2[0-3]):[0-5]\d$/,
    /** The backend's own pattern: POSIX, a Windows drive, or a UNC share (`\\NAS\Videos`). */
    ABSOLUTE_PATH: /^(\/|[A-Za-z]:[\\/]|\\\\)/,
    HOOK_TYPES: Object.freeze(['promise', 'problem', 'intent', 'question']),
    SCORE_KEYS: Object.freeze(['hook', 'alone', 'payoff', 'send']),
    /** A source still on its way to reels — it keeps the page polling. */
    SOURCE_BUSY: Object.freeze(['transcribing', 'transcribed', 'picking', 'rendering']),
    SOURCE_STATES: Object.freeze(['transcribing', 'transcribed', 'picking', 'rendering', 'done', 'no_clips', 'failed']),
    SOURCE_PILLS: Object.freeze({
        transcribing: 'pending', transcribed: 'pending', picking: 'pending', rendering: 'pending',
        done: 'sent', no_clips: 'neutral', failed: 'failed',
    }),
    CLIP_STATES: Object.freeze(['rendering', 'review', 'scheduled', 'rejected', 'failed']),
    CLIP_PILLS: Object.freeze({ rendering: 'pending', review: 'sent', scheduled: 'scheduled', rejected: 'neutral', failed: 'failed' }),
    CLIP_FIELDS: Object.freeze(['title', 'caption', 'tiktok_caption', 'keyword']),

    /** MONTEUR.md §1's defaults: what a key missing from the server's answer reads as. */
    defaults() {
        return {
            enabled: false,
            source: 'folder',
            mode: 'review',
            folder: null,
            run_at: '07:00',
            videos_per_run: 1,
            reels_per_video: 1,
            platforms: ['instagram', 'facebook', 'tiktok'],
            post_at: ['19:00'],
            min_seconds: 20,
            max_seconds: 45,
        };
    },

    // ─── Lifecycle ───────────────────────────────────────────────────────────
    destroy() {
        this._seq++;
        this._destroyed = true;
        this.stopPoll();
        this.unbindVisibility();
    },
    _destroyed: false,

    /** The page is up under its CURRENT visit (not left, whatever visit started the work). */
    aliveNow() {
        return !this._destroyed && this.alive(this._seq);
    },

    /** Tenant switch: every view, edit and pick here belongs to the previous tenant. */
    resetTenantState() {
        this._tenantEpoch++;
        this.destroy();
        this.view = null;
        this.viewError = null;
        this.stale = false;
        this.studio = null;
        this.work = null;
        this._baseline = '';
        this._settingsDirty = false;
        this.fieldProblems = null;
        this.generalProblems = [];
        this.saveError = null;
        this.settingsOpen = false;
        this.setup = false;
        this.edits = {};
        this.clipErrors = {};
        this.overrides = {};
        this.pick = null;
        this.pickNote = null;
        this.lessonsBusy = false;
        this._lastRefresh = 0;
        this._painted = {};
        this._clipDirty = {};
        this._approving = {};
    },

    /** Viewers cannot call the operator routes (session + canOperate): say so once. */
    canUse() {
        return typeof App === 'undefined' || typeof App.canOperate !== 'function' || App.canOperate();
    },

    /**
     * Still this visit, and still this page. The second half is a backstop: the
     * router bumps nothing here when it paints another page, but it does set
     * `App.currentPage`, and a Monteur paint over Posts is the one outcome to rule out.
     */
    alive(seq) {
        if (seq !== this._seq || !document.getElementById('page-container')) return false;
        return typeof App === 'undefined' || !App.currentPage || App.currentPage === 'monteur';
    },

    skeleton() {
        return html`
            <div class="surface pad-4 skel-stack" aria-hidden="true">
                <span>${Motion.line('md')}</span>
                <span>${Motion.line('lg')}</span>
            </div>
            ${Motion.cardGrid(2, 4)}
            ${Motion.busy()}
        `;
    },

    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        this.stopPoll();
        this.unbindVisibility();
        const seq = ++this._seq;
        this._destroyed = false;
        if (!this.canUse()) {
            container.innerHTML = esc(html`
                ${this.toolbarMarkup()}
                <div class="surface pad-5">${Admin.emptyState('lock', t('monteur.viewer.title'), t('monteur.viewer.body'))}</div>
            `);
            UI.icons(container);
            return;
        }
        const gate = Motion.beginLoad(container, () => this.skeleton());
        const tenant = this._tenantEpoch;
        const ticket = ++this._readTicket;
        const [view, studio] = await Promise.allSettled([API.getMonteur(), API.getStudioSettings()]);
        if (!this.alive(seq) || tenant !== this._tenantEpoch) return;
        gate.done();
        if (studio.status === 'fulfilled') this.studio = (studio.value && studio.value.settings) || null;
        if (view.status === 'fulfilled' && view.value && typeof view.value === 'object') {
            this.acceptView(view.value, ticket);
            if (this.firstRun(this.view)) this.setup = true;
            if (this.setup) this.startSetupWork();
        } else {
            // A failed read must not leave another visit's answer standing in for this one.
            this.view = null;
            this.viewError = view.status === 'rejected' ? view.reason : new Error(t('error.unexpected'));
        }
        this.paintPage();
        this.bindVisibility(seq);
        this.schedulePoll(seq);
        const count = this.view ? this.clipGroups().review.length : 0;
        Motion.announce(`${t('nav.monteur')} — ${t('monteur.queue.count', { count, n: UI.formatNumber(count) })}`);
    },

    // ─── Reading the server's answer ─────────────────────────────────────────
    normalizeConfig(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const d = this.defaults();
        const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
        return {
            enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
            source: this.SOURCES.includes(s.source) ? s.source : d.source,
            mode: this.MODES.includes(s.mode) ? s.mode : d.mode,
            folder: typeof s.folder === 'string' && s.folder.trim() ? s.folder : null,
            run_at: typeof s.run_at === 'string' ? s.run_at : d.run_at,
            videos_per_run: num(s.videos_per_run, d.videos_per_run),
            reels_per_video: num(s.reels_per_video, d.reels_per_video),
            platforms: Array.isArray(s.platforms) ? this.PLATFORMS.filter((p) => s.platforms.includes(p)) : d.platforms,
            post_at: Array.isArray(s.post_at) ? s.post_at.map((x) => String(x === null || x === undefined ? '' : x)) : d.post_at,
            min_seconds: num(s.min_seconds, d.min_seconds),
            max_seconds: num(s.max_seconds, d.max_seconds),
        };
    },

    /** The view with every part present, so no paint has to ask whether a list exists. */
    normalizeView(raw) {
        const v = raw && typeof raw === 'object' ? raw : {};
        const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
        const rows = (x) => (Array.isArray(x) ? x.filter((r) => r && typeof r === 'object' && r.id !== undefined && r.id !== null) : []);
        const worker = obj(v.worker);
        const pending = obj(v.pending);
        const lastScan = obj(v.last_scan);
        return {
            settings: this.normalizeConfig(v.settings),
            timezone: typeof v.timezone === 'string' ? v.timezone : '',
            next_run: typeof v.next_run === 'string' && v.next_run ? v.next_run : null,
            last_scan: lastScan.at ? lastScan : null,
            worker: {
                online: worker.online === true,
                lastSeen: worker.lastSeen || null,
                name: typeof worker.name === 'string' && worker.name.trim() ? worker.name.trim() : null,
            },
            pending: { scan: pending.scan === true, folder_pick: pending.folder_pick === true },
            next_slot: typeof v.next_slot === 'string' && v.next_slot ? v.next_slot : null,
            // How a TikTok post would go out now: SELF_ONLY until TikTok audits the app, null with TikTok off.
            tiktok_privacy: typeof v.tiktok_privacy === 'string' && v.tiktok_privacy ? v.tiktok_privacy : null,
            sources: rows(v.sources),
            clips: rows(v.clips).map((c) => ({ ...c, copy: this.normalizeCopy(c.copy) })),
            lessons: v.lessons && typeof v.lessons === 'object' ? v.lessons : null,
        };
    },

    normalizeCopy(raw) {
        const c = raw && typeof raw === 'object' ? raw : {};
        const str = (v) => (typeof v === 'string' ? v : '');
        const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
        return {
            ...c,
            caption: str(c.caption),
            tiktok_caption: str(c.tiktok_caption),
            hashtags: list(c.hashtags),
            keyword: str(c.keyword),
            variants: list(c.variants),
            keyword_create: c.keyword_create === true,
            dm: str(c.dm),
            alt_text: str(c.alt_text),
        };
    },

    /**
     * Take a GET answer as the new truth, keeping what the operator has not saved.
     * `ticket` says when the read was ASKED: an answer asked before a folder pick
     * started cannot know about it, so it must not settle it.
     */
    acceptView(raw, ticket) {
        const prev = this.view;
        const view = this.normalizeView(raw);
        this.view = view;
        this.viewError = null;
        this.stale = false;
        this._lastRefresh = Date.now();
        if (!this.work || !this.settingsDirty()) this.loadWork();
        else this.followServerFolder(prev, view);
        this.pruneClipState();
        if (this.pick && ticket !== undefined && ticket <= this.pick.ticket) {
            // Asked before the pick: it cannot have seen it. Keep the pick open.
            this.view.pending.folder_pick = true;
        } else {
            this.settlePick();
        }
        return prev;
    },

    /**
     * Nothing configured and nothing ever run: the page opens as the 3-step setup.
     * A folder already chosen, the daily run on, or any run, video or reel at all
     * means the Monteur has been set up, and the settings collapse.
     */
    firstRun(view) {
        const v = view || this.view;
        if (!v) return false;
        const s = v.settings;
        return !s.folder && !s.enabled && !v.last_scan && v.sources.length === 0 && v.clips.length === 0;
    },

    /**
     * The setup exists to start the daily run, so its switch starts ON — visibly,
     * labelled, one tap to turn off — and nothing is saved until Save.
     */
    startSetupWork() {
        if (this.work && !this.settingsDirty() && !this.work.enabled) this.work.enabled = true;
        this._settingsDirty = this.settingsDirty();
    },

    loadWork() {
        const s = this.view ? this.view.settings : this.normalizeConfig(null);
        this.work = this.normalizeConfig(s);
        this._baseline = JSON.stringify(this.work);
        this._settingsDirty = false;
    },

    settingsDirty() {
        return !!this.work && JSON.stringify(this.work) !== this._baseline;
    },

    /**
     * The form has unsaved edits and the server's folder moved (Choose folder saved
     * one): the new folder goes into the form AND its baseline, because it IS saved.
     * Every other unsaved edit stays exactly as typed.
     */
    followServerFolder(prev, view) {
        const was = prev ? prev.settings.folder : null;
        const now = view.settings.folder;
        if (now === was || !this.work) return;
        this.work.folder = now;
        try {
            const base = JSON.parse(this._baseline);
            base.folder = now;
            this._baseline = JSON.stringify(base);
        } catch { /* no baseline yet: loadWork() will make one */ }
        this._folderMoved = true;
    },
    _folderMoved: false,

    /** Edits and overrides belong to clips still in review; errors to clips still listed. */
    pruneClipState() {
        const clips = this.view ? this.view.clips : [];
        const review = new Set(clips.filter((c) => c.status === 'review').map((c) => String(c.id)));
        const listed = new Set(clips.map((c) => String(c.id)));
        Object.keys(this.edits).forEach((id) => { if (!review.has(id)) delete this.edits[id]; });
        Object.keys(this.overrides).forEach((id) => { if (!review.has(id)) delete this.overrides[id]; });
        Object.keys(this.clipErrors).forEach((id) => { if (!listed.has(id)) delete this.clipErrors[id]; });
        Object.keys(this._clipDirty).forEach((id) => { if (!review.has(id)) delete this._clipDirty[id]; });
    },

    /**
     * A pick is over when the view stops listing it as pending. The folder it chose
     * is already saved (the app saves it on the job's result), so the only question
     * is whether it moved. Five minutes is the worker's own limit.
     */
    settlePick(now) {
        if (!this.pick || !this.view) return;
        const at = now === undefined ? Date.now() : now;
        if (this.view.pending.folder_pick) {
            if (at - this.pick.startedAt >= this.PICK_LIMIT_MS) {
                this.pick = null;
                this.pickNote = { kind: 'timeout' };
            }
            return;
        }
        const before = this.pick.before;
        const folder = this.view.settings.folder;
        this.pick = null;
        if (folder && folder !== before) {
            this.pickNote = { kind: 'set', folder };
            UI.toast(t('monteur.folder.setToast', { folder }));
        } else {
            this.pickNote = { kind: 'none' };
        }
    },

    // ─── Polling ─────────────────────────────────────────────────────────────
    /** Anything the server is still working on, which is what keeps the page asking. */
    isPending(view) {
        const v = view || this.view;
        if (!v) return false;
        if (v.pending.scan || v.pending.folder_pick) return true;
        if (v.sources.some((s) => this.SOURCE_BUSY.includes(s.status))) return true;
        if (v.clips.some((c) => c.status === 'rendering')) return true;
        return this.lessonsRunning(v.lessons);
    },

    /** `lessons` is the latest done row; `lessons.last_run` is the latest attempt, which may be running. */
    lessonsRunning(lessons) {
        const l = lessons && typeof lessons === 'object' ? lessons : null;
        if (!l) return false;
        if (l.last_run && typeof l.last_run === 'object') return l.last_run.status === 'running';
        return l.status === 'running';
    },

    /** 3 s during a folder pick (for its five minutes), 5 s while anything is pending, else never. */
    pollDelay(now) {
        if (!this.view) return null;
        const at = now === undefined ? Date.now() : now;
        if (this.pick && at - this.pick.startedAt < this.PICK_LIMIT_MS) return this.PICK_POLL_MS;
        return this.isPending() ? this.POLL_MS : null;
    },

    /**
     * The caller passes the seq it started under. One that is no longer current —
     * the operator left while its request was out — starts nothing.
     */
    schedulePoll(seq) {
        if (seq !== this._seq) return;
        this.stopPoll();
        const delay = this.pollDelay();
        if (delay === null) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            this.tick(seq);
        }, delay);
    },

    stopPoll() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        this._parked = false;
    },

    /** One poll. A hidden tab asks nothing and parks; becoming visible picks it up. */
    async tick(seq) {
        if (!this.alive(seq)) return;
        if (document.visibilityState === 'hidden') {
            this._parked = true;
            return;
        }
        await this.refresh(seq);
        if (this.alive(seq)) this.schedulePoll(seq);
    },

    bindVisibility(seq) {
        this.unbindVisibility();
        if (typeof document.addEventListener !== 'function') return;
        this._onVisibility = () => {
            if (seq !== this._seq || document.visibilityState === 'hidden') return;
            // Parked mid-poll, or back after a while with nothing pending (a daily run
            // may have happened since): one read now, and the poll goes on from there.
            const old = Date.now() - this._lastRefresh > this.STALE_MS;
            if (this._parked || (old && !this._timer)) {
                this._parked = false;
                this.tick(seq);
            }
        };
        document.addEventListener('visibilitychange', this._onVisibility);
    },

    unbindVisibility() {
        if (this._onVisibility && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }
        this._onVisibility = null;
    },

    /**
     * Re-read the view and repaint what changed. Two reads never overlap: a refresh
     * asked for while one is out runs once more after it, so an answer from before
     * an approval can never be the last one painted.
     */
    async refresh(seq) {
        if (this._refreshing) {
            this._refreshAgain = true;
            return this._refreshing;
        }
        const tenant = this._tenantEpoch;
        const ticket = ++this._readTicket;
        const run = (async () => {
            try {
                const res = await API.getMonteur();
                if (!this.alive(seq) || tenant !== this._tenantEpoch) return;
                const prev = this.acceptView(res, ticket);
                this.paintUpdates(prev);
            } catch (err) {
                if (!this.alive(seq) || tenant !== this._tenantEpoch) return;
                if (err && err.status === 401) return;
                this.stale = true;
                this.paintStatus();
            }
        })();
        this._refreshing = run;
        try {
            await run;
        } finally {
            this._refreshing = null;
        }
        if (this._refreshAgain && seq === this._seq) {
            this._refreshAgain = false;
            await this.refresh(seq);
        }
        return undefined;
    },

    // ─── Painting ────────────────────────────────────────────────────────────
    /** Repaint one region by id, keeping the operator's focus where it was. */
    paintRegion(id, markup) {
        const host = document.getElementById(id);
        if (!host) return null;
        const focus = UI.captureFocus(host);
        const text = esc(markup);
        host.innerHTML = text;
        this._painted[id] = text;
        UI.icons(host);
        UI.restoreFocus(focus);
        return host;
    },

    /** The same, but only when the markup differs from what is already there. */
    paintIfChanged(id, markup) {
        const text = esc(markup);
        if (this._painted[id] === text && document.getElementById(id)) return null;
        return this.paintRegion(id, html.raw(text));
    },

    /**
     * Markup written inline as part of a bigger paint, recorded under the region's
     * id, so the first poll after it recognises what is there and writes nothing.
     */
    seed(id, markup) {
        this._painted[id] = esc(markup);
        return html.raw(this._painted[id]);
    },

    toggleHidden(id, hidden) {
        const el = document.getElementById(id);
        if (el && el.classList) el.classList.toggle('hidden', !!hidden);
    },

    paintPage() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const focus = UI.captureFocus(container);
        this._painted = {};
        this._folderMoved = false;
        if (!this.view) {
            container.innerHTML = esc(html`
                ${this.toolbarMarkup()}
                <div id="mt-load-error"></div>
            `);
            UI.icons(container);
            const host = document.getElementById('mt-load-error');
            if (host) UI.renderError(host, this.loadErrorOptions(), () => MonteurPage.render());
            UI.restoreFocus(focus);
            return;
        }
        const settings = html`<section class="surface pad-5 monteur-section" id="mt-settings" aria-labelledby="mt-settings-title">${this.settingsMarkup()}</section>`;
        container.innerHTML = esc(html`
            ${this.toolbarMarkup()}
            <section class="studio-status surface" id="mt-status" aria-label="${t('monteur.status.label')}">${this.seed('mt-status', this.statusMarkup())}</section>
            ${this.setup ? settings : ''}
            ${this.queueSectionMarkup()}
            ${this.sourcesSectionMarkup()}
            ${this.setup ? '' : settings}
            <section class="surface pad-5 monteur-section" id="mt-lessons" aria-labelledby="mt-lessons-title">${this.seed('mt-lessons', this.lessonsMarkup())}</section>
        `);
        UI.icons(container);
        UI.restoreFocus(focus);
    },

    /** After a poll: each region repaints only when its own data moved. */
    paintUpdates(prev) {
        if (!document.getElementById('mt-status')) {
            this.paintPage();
            return;
        }
        this.paintStatus();
        this.refreshQueue();
        this.refreshSources();
        this.paintIfChanged('mt-lessons', this.lessonsMarkup());
        this.paintIfChanged('mt-pick-status', this.pickStatusMarkup());
        const pickBtn = document.getElementById('mt-pick-folder');
        if (pickBtn) pickBtn.disabled = !!this.view.pending.folder_pick;
        if (this._folderMoved) {
            this._folderMoved = false;
            this.paintFolderValue();
        } else if (prev && !this.settingsDirty() && JSON.stringify(prev.settings) !== JSON.stringify(this.view.settings)) {
            // Saved somewhere else (another tab, Choose folder): the form follows.
            this.paintSettings();
        }
    },

    paintStatus() {
        this.paintIfChanged('mt-status', this.statusMarkup());
    },

    paintSettings() {
        this.paintRegion('mt-settings', this.settingsMarkup());
    },

    /** The folder field's value only: the rest of the form may hold edits. */
    paintFolderValue() {
        const input = document.getElementById('mt-folder');
        if (input) input.value = (this.work && this.work.folder) || '';
        if (this.setup) this.refreshStepMarks();
    },

    // ─── Toolbar ─────────────────────────────────────────────────────────────
    /**
     * The Studio's own tab bar, with the Monteur current. StudioPage.tabsMarkup()
     * lists the same three links in the same order; monteur.test.ts holds them together.
     */
    toolbarMarkup() {
        const tab = (key, href, icon, label) => html`
            <a class="btn btn-sm btn-ghost" href="${href}"
               ${key === 'monteur' ? html.raw('aria-current="page"') : ''}>
                <i data-lucide="${icon}" aria-hidden="true"></i> ${label}
            </a>
        `;
        return html`
            <div class="page-toolbar studio-toolbar">
                <nav class="segmented studio-seg studio-tabs" aria-label="${t('studio.tabs.label')}">
                    ${tab('home', '#/studio', 'layers', t('studio.tabs.carousels'))}
                    ${tab('monteur', '#/monteur', 'scissors', t('studio.tabs.monteur'))}
                    ${tab('settings', '#/studio?tab=settings', 'settings', t('studio.tabs.settings'))}
                </nav>
            </div>
        `;
    },

    /**
     * A 404 whose body names no error is a server that does not have these routes
     * yet (the dashboard can deploy before the backend). Anything else is shown as
     * the server said it.
     */
    loadErrorOptions() {
        const err = this.viewError;
        const said = !!(err && err.body && (err.body.error || err.body.message));
        const missing = !!(err && err.status === 404 && !said);
        return {
            title: t('monteur.loadFailed'),
            message: missing ? t('monteur.notDeployed') : (err && err.message) || t('error.unexpected'),
            hint: err && err.status ? `HTTP ${err.status}` : '',
        };
    },

    // ─── Status strip ────────────────────────────────────────────────────────
    workerName() {
        return (this.view && this.view.worker.name) || t('monteur.worker.fallbackName');
    },

    statusMarkup() {
        return html`
            <div class="studio-status-grid">
                ${this.runMarkup()}
                ${this.workerMarkup()}
            </div>
            ${this.stale ? html`<p class="form-hint text-warning" role="status">${t('studio.status.stale')}</p>` : ''}
        `;
    },

    /** "On · next run Sun 28 Sep, 07:00 (Riyadh) · last run 3h ago: 2 new videos" and Run now. */
    runMarkup() {
        const v = this.view;
        const s = v.settings;
        const name = this.workerName();
        // The course library needs no folder: its videos are the lessons.
        const noFolder = s.source === 'folder' && !s.folder;
        let next;
        if (noFolder) next = t('monteur.run.noFolder');
        else if (!s.enabled) next = t('monteur.run.offNote');
        else if (v.next_run) next = t('monteur.run.next', { when: this.zoneLabel(v.next_run) });
        else next = t('monteur.run.nextUnknown');
        const last = v.last_scan ? UI.relativeAge(v.last_scan.at) : null;
        const scanning = v.pending.scan;
        let runTitle = '';
        if (noFolder) runTitle = t('monteur.run.nowNoFolder');
        else if (scanning) runTitle = t('monteur.run.queuedAlready');
        return html`
            <div class="studio-status-item">
                <p class="studio-status-head">
                    <span class="health-pill ${s.enabled ? html.raw('health-fresh') : html.raw('health-off')}" id="mt-run-pill">
                        <span class="health-dot" aria-hidden="true"></span>
                        ${s.enabled ? t('monteur.run.on') : t('monteur.run.off')}
                    </span>
                </p>
                <p class="text-meta" id="mt-next-run">${next}</p>
                <p class="text-meta${v.last_scan && v.last_scan.error ? html.raw(' text-warning') : ''}" id="mt-last-run" dir="auto"${last ? html` title="${last.title}"` : ''}>${this.lastRunText(last)}</p>
                ${scanning ? html`
                    <p class="draft-card-stage" id="mt-scan-state">
                        <span class="spinner spinner-sm" aria-hidden="true"></span>
                        ${v.worker.online ? t('monteur.run.scanning', { name }) : t('monteur.run.waiting', { name })}
                    </p>
                ` : ''}
                <div class="row row--wrap gap-2">
                    ${UI.button({
                        variant: 'secondary', size: 'sm', icon: 'play', label: t('monteur.run.now'),
                        action: 'monteur:runNow', id: 'mt-run-now', disabled: noFolder || scanning, title: runTitle,
                    })}
                </div>
            </div>
        `;
    },

    lastRunText(age) {
        const ls = this.view.last_scan;
        if (!ls || !age) return t('monteur.run.never');
        // A refused scan says why (e.g. a folder outside the worker's allowed roots).
        if (ls.error) return t('monteur.run.lastFailed', { when: age.text, error: String(ls.error) });
        if (ls.missing) return t('monteur.run.lastMissing', { when: age.text, name: this.workerName() });
        const added = Math.max(0, Number(ls.added) || 0);
        const skipped = Math.max(0, Number(ls.skipped) || 0);
        const parts = [added
            ? t('monteur.run.added', { count: added, n: UI.formatNumber(added) })
            : t('monteur.run.addedNone')];
        if (skipped) parts.push(t('monteur.run.skipped', { count: skipped, n: UI.formatNumber(skipped) }));
        return t('monteur.run.last', { when: age.text, what: parts.join(' · ') });
    },

    /** The worker pill, and — while it is off — what waits for it and how to bring it back. */
    workerMarkup() {
        const w = this.view.worker;
        const seen = w.lastSeen ? UI.relativeAge(w.lastSeen) : null;
        const name = this.workerName();
        return html`
            <div class="studio-status-item${w.online ? '' : html.raw(' is-wide')}">
                <p class="studio-status-head">
                    <span class="health-pill ${w.online ? html.raw('health-fresh') : html.raw('health-off')}" id="mt-worker-pill">
                        <span class="health-dot" aria-hidden="true"></span>
                        ${w.online ? t('studio.worker.online') : t('studio.worker.offline')}
                    </span>
                    ${UI.helpLink('worker', t('help.link.worker'), { iconOnly: true })}
                    ${w.name ? html`<span class="text-meta" dir="auto">${w.name}</span>` : ''}
                    <span class="text-meta"${seen ? html` title="${seen.title}"` : ''}>
                        ${seen ? t('studio.worker.lastSeen', { when: seen.text }) : t('studio.worker.neverSeen')}
                    </span>
                </p>
                ${w.online ? '' : html`
                    <div class="studio-callout is-warning" id="mt-worker-offline">
                        <i data-lucide="laptop" aria-hidden="true"></i>
                        <div class="studio-callout-body">
                            <p class="studio-callout-title">${w.lastSeen ? t('monteur.worker.offlineTitle') : t('monteur.worker.neverTitle')}</p>
                            <p>${t('monteur.worker.jobsWait', { name })}</p>
                            <div class="row row--wrap gap-2">
                                ${UI.button({
                                    variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('studio.worker.retry'),
                                    action: 'monteur:checkWorker', id: 'mt-worker-retry',
                                })}
                                ${UI.helpLink('worker#install', t('help.link.workerInstall'))}
                            </div>
                        </div>
                    </div>
                `}
            </div>
        `;
    },

    // ─── Review queue ────────────────────────────────────────────────────────
    /**
     * Review first (newest video first, the Monteur's best of each first), then
     * what is still being prepared or failed, then the next few scheduled.
     */
    clipGroups() {
        const clips = this.view ? this.view.clips : [];
        const newest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))
            || (Number(a.rank) || 0) - (Number(b.rank) || 0);
        const now = Date.now();
        const upcoming = clips
            .filter((c) => c.status === 'scheduled' && !(Date.parse(c.scheduled_time || '') < now))
            .sort((a, b) => String(a.scheduled_time || '').localeCompare(String(b.scheduled_time || '')));
        return {
            review: clips.filter((c) => c.status === 'review').sort(newest),
            working: clips.filter((c) => c.status === 'rendering' || c.status === 'failed').sort(newest),
            scheduled: upcoming.slice(0, this.SCHEDULED_SHOWN),
        };
    },

    clipById(id) {
        const key = String(id);
        return (this.view && this.view.clips.find((c) => String(c.id) === key)) || null;
    },

    queueSectionMarkup() {
        const g = this.clipGroups();
        const nothing = !g.review.length && !g.working.length && !g.scheduled.length;
        // The first-run setup has nothing to review yet; an empty section under it is noise.
        const hidden = this.setup && nothing;
        return html`
            <section class="monteur-section monteur-queue${hidden ? html.raw(' hidden') : ''}" id="mt-queue" aria-labelledby="mt-queue-title">
                <div class="studio-section-head">
                    <h2 class="section-title" id="mt-queue-title">${t('monteur.queue.title')}</h2>
                    <span class="text-meta" id="mt-queue-count">${this.seed('mt-queue-count', this.queueCountMarkup(g))}</span>
                </div>
                <div id="mt-queue-empty">${this.seed('mt-queue-empty', this.queueEmptyMarkup(g))}</div>
                <ul class="monteur-clips" id="mt-review-list">${g.review.map((c) => this.rowMarkup('review', c))}</ul>
                <div class="monteur-group${g.working.length ? '' : html.raw(' hidden')}" id="mt-working-group">
                    <h3 class="studio-subhead">${t('monteur.working.title')}</h3>
                    <ul class="monteur-clips" id="mt-working-list">${g.working.map((c) => this.rowMarkup('working', c))}</ul>
                </div>
                <div class="monteur-group${g.scheduled.length ? '' : html.raw(' hidden')}" id="mt-scheduled-group">
                    <div class="studio-section-head">
                        <h3 class="studio-subhead">${t('monteur.scheduled.title')}</h3>
                        <a class="btn btn-ghost btn-sm" href="#/posts"><i data-lucide="calendar-days" aria-hidden="true"></i> ${t('monteur.scheduled.open')}</a>
                    </div>
                    <ul class="monteur-clips" id="mt-scheduled-list">${g.scheduled.map((c) => this.rowMarkup('scheduled', c))}</ul>
                </div>
            </section>
        `;
    },

    queueCountMarkup(g) {
        const n = g.review.length;
        return n ? t('monteur.queue.count', { count: n, n: UI.formatNumber(n) }) : '';
    },

    /** Not a congratulation: what is true, and when the next reels come. */
    queueEmptyMarkup(g) {
        if (g.review.length) return '';
        const v = this.view;
        let body;
        if (g.working.some((c) => c.status === 'rendering')) body = t('monteur.queue.emptyRendering');
        else if (v.settings.enabled && v.next_run) body = t('monteur.queue.emptyNext', { when: this.zoneLabel(v.next_run) });
        else body = t('monteur.queue.emptyBody');
        return html`
            <div class="empty-state monteur-empty">
                <i data-lucide="film" aria-hidden="true"></i>
                <h3>${t('monteur.queue.empty')}</h3>
                <p>${body}</p>
            </div>
        `;
    },

    /** Patch the three lists by key, and show or hide what depends on them. */
    refreshQueue() {
        if (!document.getElementById('mt-queue')) return;
        const g = this.clipGroups();
        this.patchRows('mt-review-list', g.review, 'review');
        this.patchRows('mt-working-list', g.working, 'working');
        this.patchRows('mt-scheduled-list', g.scheduled, 'scheduled');
        this.toggleHidden('mt-working-group', !g.working.length);
        this.toggleHidden('mt-scheduled-group', !g.scheduled.length);
        this.toggleHidden('mt-queue', this.setup && !g.review.length && !g.working.length && !g.scheduled.length);
        this.paintIfChanged('mt-queue-count', this.queueCountMarkup(g));
        this.paintIfChanged('mt-queue-empty', this.queueEmptyMarkup(g));
        // The next free slot moves with every approval, and is on every Approve button.
        // Not while that Approve is out (a fresh, enabled button would invite a second
        // one), and not while the operator is inside the form (typing a time).
        g.review.forEach((c) => {
            const id = `mt-clip-${c.id}-approve`;
            if (this._approving[String(c.id)]) return;
            const host = document.getElementById(id);
            const active = document.activeElement;
            if (host && active && typeof host.contains === 'function' && host.contains(active)) return;
            this.paintIfChanged(id, this.approveMarkup(c));
        });
    },

    /**
     * `Motion.patchList` where the host is a real list; a plain repaint anywhere
     * else. Rows carry `data-row-key`/`data-row-sig` from their first paint, so the
     * first poll recognises them instead of rebuilding them.
     */
    patchRows(listId, items, kind) {
        const host = document.getElementById(listId);
        if (!host) return;
        const canPatch = !!host.children && typeof host.insertBefore === 'function' && typeof document.createElement === 'function';
        if (!canPatch) {
            host.innerHTML = esc(html`${items.map((item) => this.rowMarkup(kind, item))}`);
            UI.icons(host);
            return;
        }
        Motion.patchList(host, items, {
            key: (item) => String(item.id),
            signature: (item) => this.rowSignature(kind, item),
            create: () => document.createElement('li'),
            update: (el, item) => {
                el.className = this.rowClass(kind);
                el.id = this.rowId(kind, item);
                el.innerHTML = esc(this.rowInner(kind, item));
            },
        });
    },

    rowClass(kind) {
        if (kind === 'source') return 'monteur-source';
        if (kind === 'review') return 'monteur-clip surface';
        return 'monteur-clip monteur-clip--compact surface';
    },

    rowId(kind, item) {
        return kind === 'source' ? `mt-source-${item.id}` : `mt-clip-${item.id}`;
    },

    /**
     * What a row shows, from the server alone. Unsaved edits are deliberately NOT
     * in it: a card being typed into changes nothing the server said, so a poll
     * leaves it alone. The worker's state is in the rows that talk about it.
     */
    rowSignature(kind, item) {
        if (kind === 'source') {
            return JSON.stringify([item.status, item.name, item.path, item.duration, item.clips, item.error, item.created_at]);
        }
        const sig = [kind, item.status, item.title, item.hook, item.why, item.score, item.start, item.end, item.duration,
            item.video_url, item.cover_url, item.scheduled_time, item.error, item.source_name, item.copy,
            item.topic, item.hook_type, item.scores, this.tiktokCut(item)];
        if (kind === 'working') sig.push(this.view.worker.online, this.view.worker.name);
        if (kind === 'scheduled') sig.push(this.zone());
        if (kind === 'review') sig.push(this.contentLang(), this.studio && this.studio.cta ? this.studio.cta : null);
        return JSON.stringify(sig);
    },

    rowMarkup(kind, item) {
        return html`<li class="${this.rowClass(kind)}" id="${this.rowId(kind, item)}" data-row-key="${String(item.id)}" data-row-sig="${this.rowSignature(kind, item)}">${this.rowInner(kind, item)}</li>`;
    },

    rowInner(kind, item) {
        if (kind === 'source') return this.sourceInner(item);
        if (kind === 'review') return this.reviewInner(item);
        if (kind === 'scheduled') return this.scheduledInner(item);
        return this.workingInner(item);
    },

    // ─── A clip, as the queue shows it ───────────────────────────────────────
    /** Seconds as m:ss (h:mm:ss past an hour), for a moment's place in its video. */
    clock(sec) {
        const total = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    },

    clipDuration(clip) {
        const d = Number(clip.duration);
        if (Number.isFinite(d) && d > 0) return d;
        const span = Number(clip.end) - Number(clip.start);
        return Number.isFinite(span) && span > 0 ? span : 0;
    },

    /** "From lesson-4.mp4 · 1:23–1:58 · 35 s": which video, where in it, how long. */
    clipMetaMarkup(clip) {
        const seconds = Math.round(this.clipDuration(clip));
        return html`
            <i data-lucide="film" aria-hidden="true"></i>
            ${clip.source_name ? html`<span dir="auto">${t('monteur.clip.from', { name: clip.source_name })}</span>` : ''}
            <span>${UI.ltr(`${this.clock(clip.start)}–${this.clock(clip.end)}`)}</span>
            ${seconds ? html`<span>${t('monteur.seconds', { n: UI.formatNumber(seconds) })}</span>` : ''}
        `;
    },

    /** The TikTok cut (§3: the same video with TikTok's CTA), where the render made one. */
    tiktokCut(clip) {
        const direct = clip && clip.tiktok_video_url;
        const inRender = clip && clip.render && typeof clip.render === 'object' ? clip.render.tiktok_video_url : '';
        return safeUrl(direct || inRender || '');
    },

    /** "Hook 3 · Alone 3 · Payoff 2 · Send 2": §6.1's parts of the score, when the Monteur sent them. */
    scoresMarkup(clip) {
        const s = clip && clip.scores && typeof clip.scores === 'object' ? clip.scores : null;
        if (!s || !this.SCORE_KEYS.some((k) => Number.isFinite(Number(s[k])))) return '';
        const part = (k) => (Number.isFinite(Number(s[k])) ? UI.formatNumber(Number(s[k])) : '—');
        return html`<p class="text-meta monteur-scores" title="${t('monteur.clip.scoresHint')}">${t('monteur.clip.scores', {
            hook: part('hook'), alone: part('alone'), payoff: part('payoff'), send: part('send'),
        })}</p>`;
    },

    hookTypeMarkup(clip) {
        const type = clip && clip.hook_type;
        if (!this.HOOK_TYPES.includes(type)) return '';
        return html`<span class="chip">${t(`monteur.clip.hookType.${type}`)}</span>`;
    },

    scoreMarkup(score) {
        const n = Number(score);
        if (score === null || score === undefined || !Number.isFinite(n)) return '';
        const text = UI.formatNumber(Math.round(n * 10) / 10);
        return html`
            <span class="chip chip-accent monteur-score" title="${t('monteur.clip.scoreHint')}">
                <span aria-hidden="true">${UI.ltr(`${text}/10`)}</span><span class="sr-only">${t('monteur.clip.scoreSr', { score: text })}</span>
            </span>
        `;
    },

    statusPill(kind, status) {
        const table = kind === 'source' ? this.SOURCE_PILLS : this.CLIP_PILLS;
        const known = Object.prototype.hasOwnProperty.call(table, status);
        const cls = known ? table[status] : 'pending';
        const label = known ? t(`monteur.${kind === 'source' ? 'source' : 'clip'}.state.${status}`) : String(status || '—');
        const busy = kind === 'source' ? this.SOURCE_BUSY.includes(status) : status === 'rendering';
        return html`
            <span class="status-pill ${html.raw(cls)}">
                ${busy ? html`<span class="dot-blink" aria-hidden="true"></span>` : ''}
                ${label}
            </span>
        `;
    },

    /** The tenant's content language, for `lang` on the copy; '' when unknown. */
    contentLang() {
        const lang = this.studio && this.studio.voice && this.studio.voice.language;
        return lang === 'ar' || lang === 'en' ? lang : '';
    },

    langAttr() {
        const lang = this.contentLang();
        return lang ? html` lang="${lang}"` : '';
    },

    /** "12/60", isolated so it reads left to right inside Arabic, with a spoken form. */
    countMarkup(n, max) {
        return html`<span aria-hidden="true">${UI.ltr(`${n}/${max}`)}</span><span class="sr-only">${t('studio.countSr', { n, max })}</span>`;
    },

    /** A clip's values as the card shows them: the unsaved edit where there is one, else the server's. */
    clipValue(clip, field) {
        const edit = this.edits[String(clip.id)];
        if (edit && edit[field] !== undefined) return edit[field];
        if (field === 'title') return String(clip.title || '');
        return String(clip.copy[field] || '');
    },

    /**
     * What each caption must carry. Instagram/Facebook: the keyword, as §6.1's ask
     * writes it («keyword») — never `cta.instagramAsk`, which the Monteur does not use.
     * TikTok: `cta.tiktokLine`, which §6.1 still puts in its caption.
     */
    requiredLines(keyword) {
        const cta = this.studio && this.studio.cta;
        const word = String(keyword || '').trim();
        const tt = cta && typeof cta.tiktokLine === 'string' ? cta.tiktokLine.trim() : '';
        return { ig: word ? `«${word}»` : '', tt, keyword: word };
    },

    lineCheck(caption, line) {
        if (!line) return null;
        return { ok: String(caption || '').includes(line), line };
    },

    /** The caption must keep «keyword» exactly: the server refuses a save that drops it. */
    keywordCheck(caption, keyword) {
        const word = String(keyword || '').trim();
        if (!word) return null;
        return { ok: String(caption || '').includes(`«${word}»`), line: `«${word}»` };
    },

    /**
     * The caption as a save would store it. A new keyword with the caption left alone
     * carries «old» → «new» into it on the server (clips.ts patchClip), so that is
     * what is checked, not the stale text still in the field.
     */
    effectiveCaption(clip) {
        const edit = this.edits[String(clip.id)] || {};
        const caption = this.clipValue(clip, 'caption');
        const before = String(clip.copy.keyword || '').trim();
        const after = String(this.clipValue(clip, 'keyword') || '').trim();
        const captionEdited = edit.caption !== undefined && edit.caption !== clip.copy.caption;
        if (captionEdited || !before || !after || before === after) return caption;
        return caption.split(`«${before}»`).join(`«${after}»`);
    },

    /** "«old» in the caption becomes «new» when you save": said while that is what will happen. */
    keywordFollowsMarkup(clip) {
        const edit = this.edits[String(clip.id)] || {};
        const before = String(clip.copy.keyword || '').trim();
        const after = String(this.clipValue(clip, 'keyword') || '').trim();
        const captionEdited = edit.caption !== undefined && edit.caption !== clip.copy.caption;
        if (captionEdited || !before || !after || before === after || !clip.copy.caption.includes(`«${before}»`)) return '';
        return html`<p class="form-hint">${t('monteur.clip.keywordFollows', { from: `«${before}»`, to: `«${after}»` })}</p>`;
    },

    /** The other spellings; a new keyword clears them (the server drops them unless they are sent). */
    variantsMarkup(clip) {
        const before = String(clip.copy.keyword || '').trim();
        const after = String(this.clipValue(clip, 'keyword') || '').trim();
        if (before !== after) return clip.copy.variants.length ? html`<p class="form-hint">${t('monteur.clip.variantsCleared')}</p>` : '';
        if (!clip.copy.variants.length) return '';
        return html`
            <p class="draft-card-tags">
                <span class="text-meta">${t('studio.campaign.variants')}</span>
                ${clip.copy.variants.map((word) => html`<span class="chip" dir="auto">${word}</span>`)}
            </p>
        `;
    },

    lineCheckMarkup(check) {
        if (!check) return '';
        return html`
            <p class="form-hint ${check.ok ? html.raw('text-success') : html.raw('text-warning')}">
                <i data-lucide="${check.ok ? 'check-circle' : 'alert-triangle'}" aria-hidden="true"></i>
                ${check.ok ? t('studio.captions.has') : t('studio.captions.missing')}
                <span class="studio-line" dir="auto">${check.line}</span>
            </p>
        `;
    },

    checksFor(clip) {
        const lines = this.requiredLines(this.clipValue(clip, 'keyword'));
        return {
            ig: this.keywordCheck(this.effectiveCaption(clip), lines.keyword),
            tt: this.lineCheck(this.clipValue(clip, 'tiktok_caption'), lines.tt),
        };
    },

    /** One editable field of a clip, with its counter and whatever it checks. */
    clipFieldMarkup(clip, o) {
        const id = String(clip.id);
        const fid = `mt-clip-${id}-${o.field}`;
        const value = this.clipValue(clip, o.field);
        const described = [o.max ? `${fid}-count` : '', o.hint ? `${fid}-hint` : '', o.check !== undefined ? `${fid}-check` : '']
            .filter(Boolean).join(' ');
        const attrs = html` id="${fid}" dir="auto"${this.langAttr()} data-input="monteur:clipField" data-clip="${id}" data-field="${o.field}"${described ? html` aria-describedby="${described}"` : ''}`;
        return html`
            <div class="form-group">
                <div class="field-head">
                    <label class="form-label" for="${fid}">${o.label}</label>
                    ${o.max ? html`<span class="field-count${value.length > o.max ? html.raw(' is-warning') : ''}" id="${fid}-count" data-max="${o.max}">${this.countMarkup(value.length, o.max)}</span>` : ''}
                </div>
                ${o.rows
                    ? html`<textarea class="field-textarea user-content" rows="${o.rows}"${attrs}>${value}</textarea>`
                    : html`<input class="field user-content" type="text" autocomplete="off" value="${value}"${attrs}>`}
                ${o.hint ? html`<p class="form-hint" id="${fid}-hint">${o.hint}</p>` : ''}
                ${o.check !== undefined ? html`<div id="${fid}-check" aria-live="polite">${this.seed(`${fid}-check`, this.lineCheckMarkup(o.check))}</div>` : ''}
                ${o.after || ''}
            </div>
        `;
    },

    reviewInner(clip) {
        const id = String(clip.id);
        const video = safeUrl(clip.video_url);
        const cover = safeUrl(clip.cover_url);
        const checks = this.checksFor(clip);
        let media = html`<i data-lucide="film" aria-hidden="true"></i><span class="sr-only">${t('monteur.clip.noVideo')}</span>`;
        if (video) {
            media = html`<video src="${video}"${cover ? html` poster="${cover}"` : ''} controls playsinline preload="metadata"
                               aria-label="${t('monteur.clip.video', { title: clip.title || '' })}"></video>`;
        } else if (cover) {
            media = html`<img src="${cover}" alt="${t('monteur.clip.cover', { title: clip.title || '' })}" loading="lazy" decoding="async">`;
        }
        return html`
            <div class="monteur-media">${media}</div>
            <div class="monteur-clip-body">
                <div class="draft-card-head">
                    <h3 class="draft-title" dir="auto" id="mt-clip-${id}-heading">${clip.title || t('monteur.clip.untitled')}</h3>
                    ${this.scoreMarkup(clip.score)}
                </div>
                ${this.scoresMarkup(clip)}
                <p class="post-card-meta">${this.clipMetaMarkup(clip)}</p>
                ${clip.error ? html`<p class="form-hint text-warning" id="mt-clip-${id}-refused" dir="auto">${t('monteur.clip.autoRefused', { error: clip.error })}</p>` : ''}
                ${clip.topic ? html`<p class="text-meta monteur-topic"><span>${t('monteur.clip.topic')}</span> <span dir="auto">${clip.topic}</span></p>` : ''}
                ${this.tiktokCut(clip) ? html`
                    <p class="monteur-tt-line">
                        <a class="monteur-tt-link" href="${this.tiktokCut(clip)}" target="_blank" rel="noopener">
                            <i data-lucide="music-2" aria-hidden="true"></i><span>${t('monteur.clip.tiktokVersion')}</span><span class="sr-only"> ${t('help.link.newTab')}</span>
                        </a>
                    </p>
                ` : ''}
                ${clip.hook ? html`
                    <div>
                        <p class="monteur-label">${t('monteur.clip.hook')} ${this.hookTypeMarkup(clip)}</p>
                        <blockquote class="monteur-hook user-content" dir="auto"${this.langAttr()}>${clip.hook}</blockquote>
                    </div>
                ` : ''}
                ${clip.why ? html`
                    <div>
                        <p class="monteur-label">${t('monteur.clip.why')}</p>
                        <p class="monteur-why" dir="auto">${clip.why}</p>
                    </div>
                ` : ''}
                <form class="monteur-clip-form" id="mt-clip-${id}-form" data-submit="monteur:saveClip" data-clip="${id}" novalidate>
                    ${this.clipFieldMarkup(clip, { field: 'title', label: t('monteur.clip.title'), max: this.TITLE_MAX, hint: t('monteur.clip.titleHint') })}
                    ${this.clipFieldMarkup(clip, { field: 'caption', label: t('monteur.clip.caption'), max: this.IG_CAPTION_MAX, rows: 7, check: checks.ig })}
                    ${this.clipFieldMarkup(clip, { field: 'tiktok_caption', label: t('monteur.clip.tiktokCaption'), max: this.TIKTOK_CAPTION_MAX, rows: 5, check: checks.tt })}
                    ${this.clipFieldMarkup(clip, {
                        field: 'keyword', label: t('monteur.clip.keyword'), hint: t('monteur.clip.keywordHint'),
                        after: html`
                            <div id="mt-clip-${id}-follows" aria-live="polite">${this.seed(`mt-clip-${id}-follows`, this.keywordFollowsMarkup(clip))}</div>
                            <div id="mt-clip-${id}-variants">${this.seed(`mt-clip-${id}-variants`, this.variantsMarkup(clip))}</div>
                        `,
                    })}
                    <div id="mt-clip-${id}-warn" aria-live="polite">${this.seed(`mt-clip-${id}-warn`, this.rerenderMarkup(clip))}</div>
                    <div id="mt-clip-${id}-savebar">${this.clipSaveBarMarkup(clip)}</div>
                </form>
                ${clip.copy.dm || clip.copy.alt_text ? html`
                    <details class="monteur-extra">
                        <summary>${t('monteur.clip.more')}</summary>
                        ${clip.copy.dm ? html`
                            <p class="monteur-label">${t('monteur.clip.dm')}</p>
                            <div class="studio-preview-dm user-content" dir="auto"${this.langAttr()}>${clip.copy.dm}</div>
                        ` : ''}
                        ${clip.copy.alt_text ? html`
                            <p class="monteur-label">${t('monteur.clip.altText')}</p>
                            <p class="monteur-why" dir="auto"${this.langAttr()}>${clip.copy.alt_text}</p>
                        ` : ''}
                    </details>
                ` : ''}
                <div id="mt-clip-${id}-error">${this.clipErrorMarkup(id)}</div>
                <form class="monteur-approve" id="mt-clip-${id}-approve" data-submit="monteur:approve" data-clip="${id}" novalidate>${this.seed(`mt-clip-${id}-approve`, this.approveMarkup(clip))}</form>
            </div>
        `;
    },

    /** A new title or keyword is burned into the video, so saving it prepares the video again. */
    rerenderMarkup(clip) {
        if (!this.rerenders(this.clipPatch(clip, this.edits[String(clip.id)]))) return '';
        return html`
            <p class="form-hint text-warning monteur-rerender">
                <i data-lucide="alert-triangle" aria-hidden="true"></i>
                <span>${t('monteur.clip.rerender', { name: this.workerName() })}</span>
            </p>
        `;
    },

    clipSaveBarMarkup(clip) {
        const id = String(clip.id);
        if (!this.clipDirty(id)) return '';
        return html`
            <div class="row row--wrap gap-2 monteur-clip-savebar">
                ${UI.button({ variant: 'primary', type: 'submit', icon: 'save', label: t('monteur.clip.save'), id: `mt-clip-${id}-save` })}
                ${UI.button({
                    variant: 'ghost', size: 'sm', icon: 'rotate-ccw', label: t('studio.editor.discard'),
                    action: 'monteur:discardClip', data: { clip: id }, id: `mt-clip-${id}-discard`,
                })}
                <span class="text-meta">${t('studio.editor.unsaved')}</span>
            </div>
        `;
    },

    clipErrorMarkup(id) {
        const e = this.clipErrors[String(id)];
        if (!e) return '';
        return html`
            ${UI.errorStrip(e.message, '', `mt-clip-${id}-error-strip`)}
            ${e.problems && e.problems.length ? html`<ul class="problem-list">${e.problems.map((p) => html`<li dir="auto">${p}</li>`)}</ul>` : ''}
        `;
    },

    /** A DM campaign answers Instagram and Facebook comments only (clips.ts). */
    hasMeta() {
        const p = this.view ? this.view.settings.platforms : [];
        return p.includes('instagram') || p.includes('facebook');
    },

    /** "Instagram, Facebook and TikTok", in the interface language. */
    platformList(platforms) {
        const names = this.PLATFORMS.filter((p) => (platforms || []).includes(p)).map((p) => t(`monteur.platform.${p}`));
        if (!names.length) return '';
        try {
            if (typeof Intl.ListFormat === 'function') {
                return new Intl.ListFormat(I18N.locale(), { style: 'long', type: 'conjunction' }).format(names);
            }
        } catch { /* an older engine: commas */ }
        return names.join(', ');
    },

    /** A day in the tenant's zone, as YYYY-MM-DD, for comparing two instants' days. */
    zoneDayKey(value) {
        return this.toZoneInput(value, this.zone()).slice(0, 10);
    },

    /**
     * The slot this clip's Approve would take. `next_slot` is tenant-wide, but §6.1
     * never puts two clips from the same video on the same day: when a sibling is
     * already scheduled on next_slot's day, the server will use a later day, so the
     * button must not promise that time (`clash`).
     */
    slotFor(clip) {
        const slot = this.view && this.view.next_slot;
        if (!slot || !clip) return null;
        const day = this.zoneDayKey(slot);
        const clash = this.view.clips.some((c) => String(c.id) !== String(clip.id)
            && c.source_id !== undefined && String(c.source_id) === String(clip.source_id)
            && c.status === 'scheduled' && c.scheduled_time && this.zoneDayKey(c.scheduled_time) === day);
        return { iso: slot, clash };
    },

    /**
     * Approve, with the time it will take. `next_slot` is the server's own answer
     * to "what would Approve take now"; the override is a wall time in the tenant's
     * zone. Approving while the card has unsaved edits would schedule the LAST saved
     * copy, so it waits for Save or Discard.
     */
    approveMarkup(clip) {
        const id = String(clip.id);
        const v = this.view;
        const dirty = this.clipDirty(id);
        const o = this.overrides[id] || { open: false, value: '' };
        const zone = this.zone();
        const custom = o.open ? this.fromZoneInput(o.value, zone) : null;
        const slot = this.slotFor(clip);
        let label;
        if (o.open) label = custom ? t('monteur.clip.approveAt', { when: this.zoneTime(custom) }) : t('monteur.clip.approve');
        else if (slot && slot.clash) label = t('monteur.clip.approveNextDay');
        else label = slot ? t('monteur.clip.approveAt', { when: this.zoneTime(slot.iso) }) : t('monteur.clip.approve');
        const keyword = String(clip.copy.keyword || '').trim();
        const platforms = this.platformList(v.settings.platforms);
        // The clip's own (a review clip's mirrors the view's; a scheduled one's is how it went out),
        // else the view's. Both are null with TikTok off.
        const privacy = clip.tiktok_privacy !== undefined && clip.tiktok_privacy !== null ? clip.tiktok_privacy : v.tiktok_privacy;
        const selfOnly = privacy === 'SELF_ONLY';
        return html`
            ${o.open ? html`
                <div class="form-group">
                    <label class="form-label" for="mt-clip-${id}-time">${t('monteur.clip.customTime')}</label>
                    <input type="datetime-local" class="field studio-custom-time" id="mt-clip-${id}-time" dir="ltr"
                           value="${o.value}" data-input="monteur:overrideInput" data-clip="${id}" aria-describedby="mt-clip-${id}-time-hint">
                    <p class="form-hint" id="mt-clip-${id}-time-hint">${t('monteur.clip.zoneHint', { city: this.zoneCity(zone), zone })}</p>
                </div>
            ` : ''}
            <ul class="studio-summary-list monteur-approve-summary">
                ${platforms ? html`<li><i data-lucide="share-2" aria-hidden="true"></i><span>${t('monteur.clip.goesTo', { platforms })}</span></li>` : ''}
                ${keyword && this.hasMeta() ? html`
                    <li><i data-lucide="message-circle" aria-hidden="true"></i><span dir="auto">${t('monteur.clip.campaignDm', { keyword })}</span></li>
                ` : ''}
                ${selfOnly ? html`<li><i data-lucide="lock" aria-hidden="true"></i><span>${t('monteur.clip.tiktokSelfOnly')}</span></li>` : ''}
                ${slot && slot.clash && !o.open ? html`
                    <li><i data-lucide="calendar-clock" aria-hidden="true"></i><span>${t('monteur.clip.siblingDay', { day: this.zoneDay(slot.iso) })}</span></li>
                ` : ''}
            </ul>
            <div class="row row--wrap gap-2">
                <button type="submit" class="btn ${dirty ? html.raw('btn-secondary') : html.raw('btn-primary')}" id="mt-clip-${id}-approve-btn"
                        ${dirty ? html`disabled title="${t('monteur.clip.saveFirst')}"` : ''}>
                    <i data-lucide="calendar-check" aria-hidden="true"></i>
                    <span id="mt-clip-${id}-approve-label">${label}</span>
                </button>
                ${UI.button({
                    variant: 'ghost', size: 'sm', icon: o.open ? 'x' : 'calendar-clock',
                    label: o.open ? t('monteur.clip.useNextSlot') : t('monteur.clip.changeTime'),
                    action: 'monteur:toggleOverride', data: { clip: id }, id: `mt-clip-${id}-time-toggle`,
                })}
                ${UI.button({
                    variant: 'ghost', size: 'sm', icon: 'x', label: t('monteur.clip.reject'),
                    action: 'monteur:reject', data: { clip: id }, id: `mt-clip-${id}-reject`,
                })}
            </div>
            ${dirty ? html`<p class="form-hint">${t('monteur.clip.saveFirst')}</p>` : ''}
        `;
    },

    /** Rendering or failed: the state, and what it waits on. No editing: the copy is not final. */
    workingInner(clip) {
        const id = String(clip.id);
        const cover = safeUrl(clip.cover_url);
        const failed = clip.status === 'failed';
        const name = this.workerName();
        let media = html`<span class="skel skel-block"></span>`;
        if (cover) media = html`<img src="${cover}" alt="" loading="lazy" decoding="async">`;
        else if (failed) media = html`<i data-lucide="alert-triangle" aria-hidden="true"></i>`;
        return html`
            <div class="monteur-media" aria-hidden="true">${media}</div>
            <div class="monteur-clip-body">
                <div class="draft-card-head">
                    <h3 class="draft-title" dir="auto">${clip.title || t('monteur.clip.untitled')}</h3>
                    ${this.statusPill('clip', clip.status)}
                </div>
                <p class="post-card-meta">${this.clipMetaMarkup(clip)}</p>
                ${failed ? html`
                    ${clip.error ? html`<p class="post-card-error" dir="auto">${clip.error}</p>` : ''}
                    <div class="row row--wrap gap-2">
                        ${UI.button({
                            variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'),
                            ariaLabel: t('monteur.clip.retryName', { title: clip.title || t('monteur.clip.untitled') }),
                            title: t('monteur.clip.retryHint', { name: this.workerName() }),
                            action: 'monteur:rerender', data: { clip: id }, id: `mt-clip-${id}-rerender`,
                        })}
                        ${UI.button({
                            variant: 'ghost', size: 'sm', icon: 'x', label: t('monteur.clip.dismiss'),
                            action: 'monteur:reject', data: { clip: id }, id: `mt-clip-${id}-reject`,
                        })}
                    </div>
                ` : html`
                    <p class="draft-card-stage">
                        <span class="spinner spinner-sm" aria-hidden="true"></span>
                        ${this.view.worker.online ? t('monteur.clip.rendering', { name }) : t('monteur.clip.renderWaiting', { name })}
                    </p>
                `}
            </div>
        `;
    },

    scheduledInner(clip) {
        const cover = safeUrl(clip.cover_url);
        return html`
            <div class="monteur-media" aria-hidden="true">${cover
                ? html`<img src="${cover}" alt="" loading="lazy" decoding="async">`
                : html`<i data-lucide="film" aria-hidden="true"></i>`}</div>
            <div class="monteur-clip-body">
                <div class="draft-card-head">
                    <h3 class="draft-title" dir="auto">${clip.title || t('monteur.clip.untitled')}</h3>
                    ${this.statusPill('clip', 'scheduled')}
                </div>
                ${clip.scheduled_time ? html`
                    <p class="post-card-meta">
                        <i data-lucide="calendar-check" aria-hidden="true"></i>
                        <span>${t('monteur.scheduled.at', { when: this.zoneLabel(clip.scheduled_time) })}</span>
                    </p>
                ` : ''}
            </div>
        `;
    },

    // ─── Sources ─────────────────────────────────────────────────────────────
    sourcesSectionMarkup() {
        const sources = this.view.sources;
        const hidden = this.setup && !sources.length;
        return html`
            <section class="surface pad-5 monteur-section${hidden ? html.raw(' hidden') : ''}" id="mt-sources" aria-labelledby="mt-sources-title">
                <h2 class="section-title" id="mt-sources-title">${t('monteur.sources.title')}</h2>
                <p class="form-hint studio-section-lede">${t('monteur.sources.intro')}</p>
                <div id="mt-sources-empty">${this.seed('mt-sources-empty', this.sourcesEmptyMarkup())}</div>
                <ul class="monteur-sources" id="mt-sources-list">${sources.map((s) => this.rowMarkup('source', s))}</ul>
            </section>
        `;
    },

    sourcesEmptyMarkup() {
        if (this.view.sources.length) return '';
        return html`<p class="studio-empty-note">${t('monteur.sources.empty')}</p>`;
    },

    refreshSources() {
        if (!document.getElementById('mt-sources')) return;
        this.patchRows('mt-sources-list', this.view.sources, 'source');
        this.toggleHidden('mt-sources', this.setup && !this.view.sources.length);
        this.paintIfChanged('mt-sources-empty', this.sourcesEmptyMarkup());
    },

    sourceInner(source) {
        const id = String(source.id);
        const name = source.name || source.path || '—';
        const seconds = Number(source.duration);
        const reels = Math.max(0, Number(source.clips) || 0);
        const meta = [];
        if (Number.isFinite(seconds) && seconds > 0) meta.push(UI.ltr(this.clock(seconds)));
        if (reels || source.status === 'done') meta.push(t('monteur.source.reels', { count: reels, n: UI.formatNumber(reels) }));
        if (source.created_at) meta.push(t('monteur.source.added', { when: this.zoneTime(source.created_at) }));
        return html`
            <div class="monteur-source-main">
                <p class="monteur-source-name" dir="auto"${source.path ? html` title="${source.path}"` : ''}>${name}</p>
                ${meta.length ? html`<p class="text-meta">${meta.map((part, i) => html`${i ? ' · ' : ''}${part}`)}</p>` : ''}
                ${source.status === 'no_clips' ? html`<p class="form-hint">${t('monteur.source.noClipsNote')}</p>` : ''}
                ${source.status === 'no_clips' && source.error ? html`<p class="text-meta" dir="auto">${source.error}</p>` : ''}
                ${source.status === 'failed' && source.error ? html`<p class="post-card-error" dir="auto">${source.error}</p>` : ''}
            </div>
            ${this.statusPill('source', source.status)}
            ${source.status === 'failed' ? UI.button({
                variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'),
                ariaLabel: t('monteur.source.retryName', { name }), title: t('monteur.source.retryHint'),
                action: 'monteur:retrySource', data: { id }, id: `mt-source-${id}-retry`,
            }) : ''}
        `;
    },

    // ─── Settings ────────────────────────────────────────────────────────────
    /**
     * Collapsed once set up: what is saved, in one line, and Edit. The form is only
     * built while open; edits made in it live in `work`, so closing keeps them.
     */
    settingsMarkup() {
        if (this.setup) return this.setupMarkup();
        const open = !!this.settingsOpen;
        const dirty = this.settingsDirty();
        return html`
            <div class="studio-section-head">
                <h2 class="section-title" id="mt-settings-title">${t('monteur.settings.title')}</h2>
                <button type="button" class="btn btn-ghost btn-sm" id="mt-settings-toggle" data-action="monteur:toggleSettings"
                        aria-expanded="${open ? 'true' : 'false'}" aria-controls="mt-settings-body">
                    <i data-lucide="${open ? 'chevron-up' : 'chevron-down'}" aria-hidden="true"></i>
                    ${open ? t('monteur.settings.close') : t('monteur.settings.edit')}
                </button>
            </div>
            <p class="text-meta" id="mt-settings-summary">${this.summaryMarkup()}${dirty && !open ? html` · <span class="text-warning">${t('studio.editor.unsaved')}</span>` : ''}</p>
            ${this.view.settings.source === 'folder' && this.view.settings.folder ? html`<p class="monteur-folder-line"><code class="studio-path" dir="ltr">${this.view.settings.folder}</code></p>` : ''}
            <div id="mt-settings-body"${open ? '' : html.raw(' class="hidden"')}>${open ? this.formMarkup() : ''}</div>
        `;
    },

    /**
     * "Daily at 07:00 · 1 video a run · 1 reel each · 20–45 s · posts at 19:00 · …".
     * Ranges and times are isolated: "20–45" left to the Arabic bidi rules reads 45–20.
     */
    summaryMarkup() {
        const s = this.view.settings;
        const range = `${UI.formatNumber(s.min_seconds)}–${UI.formatNumber(s.max_seconds)}`;
        const platforms = this.platformList(s.platforms);
        const parts = [
            s.enabled ? html`${t('monteur.summary.daily')} ${UI.ltr(s.run_at)}` : html`${t('monteur.summary.off')}`,
            s.source === 'course' ? html`${t('monteur.summary.course')}` : '',
            html`${t('monteur.summary.videos', { count: s.videos_per_run, n: UI.formatNumber(s.videos_per_run) })}`,
            html`${t('monteur.summary.reels', { count: s.reels_per_video, n: UI.formatNumber(s.reels_per_video) })}`,
            html`${UI.ltr(range)} ${t('monteur.summary.seconds')}`,
            html`${t('monteur.summary.posts')} ${UI.ltr(s.post_at.join(', '))}`,
            platforms ? html`${platforms}` : '',
            s.mode === 'auto' ? html`${t('monteur.summary.auto')}` : '',
        ].filter(Boolean);
        return html`${parts.map((part, i) => html`${i ? ' · ' : ''}${part}`)}`;
    },

    setupMarkup() {
        const marks = this.stepStates();
        const step = (n, done, title, body) => html`
            <li class="setup-step${done ? html.raw(' is-done') : ''}" id="mt-step-${n}">
                <span class="setup-step-mark" id="mt-step-${n}-mark" aria-hidden="true">${this.stepMark(n, done)}</span>
                <div class="setup-step-body">
                    <p class="setup-step-title">${title}<span class="sr-only" id="mt-step-${n}-state"> (${done ? t('studio.setup.done') : t('studio.setup.todo')})</span></p>
                    ${body}
                </div>
            </li>
        `;
        return html`
            <h2 class="section-title" id="mt-settings-title">${t('monteur.setup.title')}</h2>
            <p class="form-hint studio-section-lede">${t('monteur.setup.intro')}</p>
            <form id="mt-settings-form" class="monteur-form" data-submit="monteur:saveSettings" novalidate>
                <ol class="setup-steps">
                    ${step(1, marks[0], t('monteur.setup.source'), html`${this.sourceMarkup()}${this.folderFieldMarkup()}`)}
                    ${step(2, marks[1], t('monteur.setup.times'), html`${this.runAtMarkup()}${this.postAtMarkup()}`)}
                    ${step(3, marks[2], t('monteur.setup.numbers'), html`
                        <div class="studio-settings-grid">
                            ${this.numberFieldMarkup('videos_per_run', t('monteur.settings.videosPerRun'), t('monteur.settings.videosPerRunHint'))}
                            ${this.numberFieldMarkup('reels_per_video', t('monteur.settings.reelsPerVideo'), t('monteur.settings.reelsPerVideoHint'))}
                        </div>
                        ${this.lengthMarkup()}
                        ${this.platformsMarkup()}
                        ${this.modeMarkup()}
                    `)}
                </ol>
                ${this.enabledMarkup()}
                <div id="mt-settings-savebar">${this.seed('mt-settings-savebar', this.saveBarMarkup())}</div>
            </form>
        `;
    },

    formMarkup() {
        return html`
            <form id="mt-settings-form" class="monteur-form" data-submit="monteur:saveSettings" novalidate>
                ${this.enabledMarkup()}
                ${this.sourceMarkup()}
                ${this.folderFieldMarkup()}
                <div class="studio-settings-grid">
                    ${this.runAtMarkup()}
                    ${this.numberFieldMarkup('videos_per_run', t('monteur.settings.videosPerRun'), t('monteur.settings.videosPerRunHint'))}
                    ${this.numberFieldMarkup('reels_per_video', t('monteur.settings.reelsPerVideo'), t('monteur.settings.reelsPerVideoHint'))}
                </div>
                ${this.postAtMarkup()}
                ${this.lengthMarkup()}
                ${this.platformsMarkup()}
                ${this.modeMarkup()}
                <div id="mt-settings-savebar">${this.seed('mt-settings-savebar', this.saveBarMarkup())}</div>
            </form>
        `;
    },

    /** [where the videos come from, times valid, numbers valid]: the setup's three marks. */
    stepStates() {
        if (!this.work) return [false, false, false];
        const body = this.settingsPayload();
        const problems = this.localProblems(body);
        const has = (keys) => problems.some((p) => keys.includes(p.key.split('.')[0]));
        return [
            (body.source === 'course' || !!body.folder) && !has(['folder']),
            !has(['run_at', 'post_at']),
            !has(['videos_per_run', 'reels_per_video', 'min_seconds', 'max_seconds', 'platforms']),
        ];
    },

    stepMark(n, done) {
        return done ? html`<i data-lucide="check" aria-hidden="true"></i>` : UI.formatNumber(n);
    },

    /** The marks follow the typing without touching any field. */
    refreshStepMarks() {
        this.stepStates().forEach((done, i) => {
            const n = i + 1;
            const li = document.getElementById(`mt-step-${n}`);
            if (li && li.classList) li.classList.toggle('is-done', done);
            this.paintIfChanged(`mt-step-${n}-mark`, this.stepMark(n, done));
            this.paintIfChanged(`mt-step-${n}-state`, html` (${done ? t('studio.setup.done') : t('studio.setup.todo')})`);
        });
    },

    problemsFor(key) {
        const map = this.fieldProblems;
        return map && map.has(key) ? map.get(key) : [];
    },

    problemListMarkup(id, problems) {
        return problems.length ? html`<ul class="problem-list" id="${id}-problems">${problems.map((p) => html`<li dir="auto">${p}</li>`)}</ul>` : '';
    },

    /** aria-describedby and aria-invalid for a field, from its hint and its problems. */
    fieldAttrs(id, key, hintId) {
        const problems = this.problemsFor(key);
        const described = [hintId || '', problems.length ? `${id}-problems` : ''].filter(Boolean).join(' ');
        return html`${described ? html` aria-describedby="${described}"` : ''}${problems.length ? html.raw(' aria-invalid="true"') : ''}`;
    },

    enabledMarkup() {
        const w = this.work;
        return html`
            <div class="form-group">
                <div class="switch-row">
                    <label class="switch" for="mt-enabled">
                        <span class="sr-only">${t('monteur.settings.enabled')}</span>
                        <input type="checkbox" id="mt-enabled" data-change="monteur:setting" data-key="enabled"
                               aria-describedby="mt-enabled-hint" ${w.enabled ? html.raw('checked') : ''}>
                        <span class="switch-track"></span>
                    </label>
                    <span class="switch-text">
                        <span class="switch-label">${t('monteur.settings.enabled')}</span>
                        <span class="form-hint" id="mt-enabled-hint">${t('monteur.settings.enabledHint')}</span>
                    </span>
                </div>
            </div>
        `;
    },

    /** One choice as a radio group: `key` names the setting, each option a label and a hint. */
    choiceMarkup(key, legend, options) {
        const chosen = this.work[key];
        return html`
            <fieldset class="fieldset-plain form-group" id="mt-${key}">
                <legend class="form-label">${legend}</legend>
                ${options.map(([value, label, hint]) => html`
                    <label class="check-row" for="mt-${key}-${value}">
                        <input type="radio" name="mt-${key}" id="mt-${key}-${value}" value="${value}"
                               data-change="monteur:setting" data-key="${key}"
                               aria-describedby="mt-${key}-${value}-hint" ${chosen === value ? html.raw('checked') : ''}>
                        <span class="check-text">
                            <span class="check-label">${label}</span>
                            <span class="form-hint" id="mt-${key}-${value}-hint">${hint}</span>
                        </span>
                    </label>
                `)}
            </fieldset>
        `;
    },

    /** "Take videos from: my folder / the course library". The course library needs no folder. */
    sourceMarkup() {
        return this.choiceMarkup('source', t('monteur.settings.source'), [
            ['folder', t('monteur.settings.sourceFolder'), t('monteur.settings.sourceFolderHint')],
            ['course', t('monteur.settings.sourceCourse'), t('monteur.settings.sourceCourseHint')],
        ]);
    },

    /** "When a reel is ready: I review it / schedule it automatically". */
    modeMarkup() {
        return this.choiceMarkup('mode', t('monteur.settings.mode'), [
            ['review', t('monteur.settings.modeReview'), t('monteur.settings.modeReviewHint')],
            ['auto', t('monteur.settings.modeAuto'), t('monteur.settings.modeAutoHint')],
        ]);
    },

    folderFieldMarkup() {
        const w = this.work;
        const pending = !!this.view.pending.folder_pick;
        const problems = this.problemsFor('folder');
        return html`
            <div class="form-group${w.source === 'course' ? html.raw(' hidden') : ''}" id="mt-folder-group">
                <label class="form-label" for="mt-folder">${t('monteur.settings.folder')}</label>
                <div class="field-row monteur-folder-row">
                    <input class="field field-mono" id="mt-folder" type="text" dir="ltr" autocomplete="off" spellcheck="false"
                           value="${w.folder || ''}" placeholder="${t('monteur.settings.folderPlaceholder')}"
                           data-input="monteur:setting" data-key="folder"${this.fieldAttrs('mt-folder', 'folder', 'mt-folder-hint')}>
                    ${UI.button({
                        variant: 'secondary', icon: 'folder-open', label: t('monteur.folder.choose'),
                        action: 'monteur:pickFolder', id: 'mt-pick-folder', disabled: pending,
                        title: pending ? t('monteur.folder.alreadyOpen') : '',
                    })}
                </div>
                <p class="form-hint" id="mt-folder-hint">${t('monteur.settings.folderHint', { name: this.workerName() })}</p>
                <div id="mt-pick-status" aria-live="polite">${this.seed('mt-pick-status', this.pickStatusMarkup())}</div>
                ${this.problemListMarkup('mt-folder', problems)}
            </div>
        `;
    },

    /** Where the folder pick stands: open on the worker, waiting for it, or what it came to. */
    pickStatusMarkup() {
        const v = this.view;
        if (!v) return '';
        const name = this.workerName();
        if (this.pick || v.pending.folder_pick) {
            let text;
            if (!v.worker.online) text = t('monteur.folder.openWhenBack', { name });
            else if (this.pick) text = t('monteur.folder.opened', { name });
            else text = t('monteur.folder.waiting', { name });
            return html`
                <p class="studio-hint" id="mt-pick-note">
                    <span class="spinner spinner-sm" aria-hidden="true"></span>
                    <span>${text}</span>
                </p>
            `;
        }
        const note = this.pickNote;
        if (!note) return '';
        if (note.kind === 'set') {
            return html`
                <p class="form-hint text-success" id="mt-pick-note">
                    <i data-lucide="check-circle" aria-hidden="true"></i>
                    ${t('monteur.folder.set')} ${UI.ltr(note.folder)}
                </p>
            `;
        }
        if (note.kind === 'timeout') return html`<p class="form-hint text-warning" id="mt-pick-note">${t('monteur.folder.timeout', { name })}</p>`;
        return html`<p class="form-hint" id="mt-pick-note">${t('monteur.folder.unchanged')}</p>`;
    },

    runAtMarkup() {
        const zone = this.zone();
        return html`
            <div class="form-group">
                <label class="form-label" for="mt-run_at">${t('monteur.settings.runAt')}</label>
                <input class="field studio-field-time" id="mt-run_at" type="time" dir="ltr" step="60" value="${this.work.run_at}"
                       data-input="monteur:setting" data-key="run_at"${this.fieldAttrs('mt-run_at', 'run_at', 'mt-run_at-hint')}>
                <p class="form-hint" id="mt-run_at-hint">${t('monteur.settings.runAtHint', { city: this.zoneCity(zone), name: this.workerName() })}</p>
                ${this.problemListMarkup('mt-run_at', this.problemsFor('run_at'))}
            </div>
        `;
    },

    numberFieldMarkup(key, label, hint) {
        const [min, max] = this.LIMITS[key];
        const id = `mt-${key}`;
        return html`
            <div class="form-group">
                <label class="form-label" for="${id}">${label}</label>
                <input class="field studio-field-time" id="${id}" type="number" inputmode="numeric" dir="ltr" min="${min}" max="${max}" step="1"
                       value="${String(this.work[key])}" data-input="monteur:setting" data-key="${key}"${this.fieldAttrs(id, key, hint ? `${id}-hint` : '')}>
                ${hint ? html`<p class="form-hint" id="${id}-hint">${hint}</p>` : ''}
                ${this.problemListMarkup(id, this.problemsFor(key))}
            </div>
        `;
    },

    lengthMarkup() {
        return html`
            <fieldset class="fieldset-plain form-group" id="mt-length" aria-describedby="mt-length-hint">
                <legend class="form-label">${t('monteur.settings.length')}</legend>
                <div class="studio-settings-grid monteur-length">
                    ${this.numberFieldMarkup('min_seconds', t('monteur.settings.minSeconds'), '')}
                    ${this.numberFieldMarkup('max_seconds', t('monteur.settings.maxSeconds'), '')}
                </div>
                <p class="form-hint" id="mt-length-hint">${t('monteur.settings.lengthHint')}</p>
            </fieldset>
        `;
    },

    platformsMarkup() {
        const chosen = this.work.platforms;
        const problems = this.problemsFor('platforms');
        return html`
            <fieldset class="fieldset-plain form-group" id="mt-platforms" aria-describedby="mt-platforms-hint${problems.length ? html.raw(' mt-platforms-problems') : ''}">
                <legend class="form-label">${t('monteur.settings.platforms')}</legend>
                <div class="monteur-platforms">
                    ${this.PLATFORMS.map((p) => html`
                        <label class="check-row" for="mt-platform-${p}">
                            <input type="checkbox" id="mt-platform-${p}" data-change="monteur:setting" data-key="platform" data-platform="${p}"
                                   ${chosen.includes(p) ? html.raw('checked') : ''}>
                            <span class="check-label">${t(`monteur.platform.${p}`)}</span>
                        </label>
                    `)}
                </div>
                <p class="form-hint" id="mt-platforms-hint">${t('monteur.settings.platformsHint')}</p>
                ${this.problemListMarkup('mt-platforms', problems)}
            </fieldset>
        `;
    },

    /** The posting times, in a host that add and remove repaint whole. */
    postAtMarkup() {
        return html`<div id="mt-post_at-host">${this.postAtFieldset()}</div>`;
    },

    /** 1–4 posting times, one row each, add at the end, remove any but the last one. */
    postAtFieldset() {
        const items = this.work.post_at;
        const zone = this.zone();
        const full = items.length >= this.POST_AT_MAX;
        return html`
            <fieldset class="fieldset-plain studio-items" id="mt-post_at" aria-describedby="mt-post_at-hint${this.problemsFor('post_at').length ? html.raw(' mt-post_at-problems') : ''}">
                <legend class="form-label">${t('monteur.settings.postAt')}</legend>
                <ol class="studio-item-list">
                    ${items.map((item, k) => {
                        const bad = this.problemsFor(`post_at.${k}`);
                        return html`
                            <li class="studio-item${bad.length ? html.raw(' has-problems') : ''}">
                                <input class="field studio-field-time" type="time" dir="ltr" step="60" id="mt-post_at-${k}" value="${item}"
                                       data-input="monteur:setting" data-key="post_at" data-item="${k}"
                                       aria-label="${t('monteur.settings.postAtItem', { n: k + 1 })}"
                                       ${bad.length ? html`aria-invalid="true" aria-describedby="mt-post_at-${k}-problems"` : ''}>
                                ${items.length > 1 ? html`
                                    <button type="button" class="icon-btn icon-btn-danger" data-action="monteur:removeTime" data-item="${k}"
                                            data-focus-key="mt-post_at-remove-${k}"
                                            aria-label="${t('monteur.settings.removeTime', { n: k + 1 })}" title="${t('monteur.settings.removeTime', { n: k + 1 })}">
                                        <i data-lucide="x" aria-hidden="true"></i>
                                    </button>
                                ` : ''}
                                ${this.problemListMarkup(`mt-post_at-${k}`, bad)}
                            </li>
                        `;
                    })}
                </ol>
                ${full ? '' : UI.button({ variant: 'ghost', size: 'sm', icon: 'plus', label: t('monteur.settings.addTime'), action: 'monteur:addTime', id: 'mt-post_at-add' })}
                <p class="form-hint" id="mt-post_at-hint">${t('monteur.settings.postAtHint', { city: this.zoneCity(zone), max: this.POST_AT_MAX })}</p>
                ${this.problemListMarkup('mt-post_at', this.problemsFor('post_at'))}
            </fieldset>
        `;
    },

    saveBarMarkup() {
        const dirty = this.settingsDirty();
        const problems = this.generalProblems || [];
        const label = this.setup && this.work && this.work.enabled ? t('monteur.setup.save') : t('monteur.settings.save');
        return html`
            ${this.saveError ? html`
                <div id="mt-settings-error" tabindex="-1">
                    ${UI.errorStrip(this.saveError, '', 'mt-settings-error-strip')}
                    ${problems.length ? html`<ul class="problem-list">${problems.map((p) => html`<li dir="auto">${p}</li>`)}</ul>` : ''}
                </div>
            ` : ''}
            <div class="studio-savebar-row">
                <p class="text-meta" role="status">${this.setup
                    ? t('monteur.setup.notSaved')
                    : dirty ? t('studio.editor.unsaved') : t('studio.editor.saved')}</p>
                <div class="row row--wrap gap-2">
                    ${dirty && !this.setup ? UI.button({ variant: 'ghost', size: 'sm', icon: 'rotate-ccw', label: t('studio.editor.discard'), action: 'monteur:discardSettings', id: 'mt-settings-discard' }) : ''}
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'save', label, id: 'mt-settings-save', disabled: !dirty && !this.setup })}
                </div>
            </div>
        `;
    },

    // ─── Settings: editing ───────────────────────────────────────────────────
    /** "3" → 3 and "" stays "", so an untouched number is not an edit and an empty one is visibly wrong. */
    readNumber(value) {
        const raw = String(value === null || value === undefined ? '' : value);
        const n = Number(raw);
        return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
    },

    /** One handler for every settings control; `data-key` says where the value goes. */
    setting(el) {
        if (!el || !el.dataset || !this.work) return;
        const key = String(el.dataset.key || '');
        const w = this.work;
        let problemKey = key;
        if (key === 'enabled') {
            w.enabled = !!el.checked;
        } else if (key === 'source' || key === 'mode') {
            const value = String(el.value || '');
            if (!(key === 'source' ? this.SOURCES : this.MODES).includes(value)) return;
            w[key] = value;
            // The folder is asked for only when the videos come from it.
            if (key === 'source') {
                this.toggleHidden('mt-folder-group', value === 'course');
                problemKey = 'folder';
            }
        } else if (key === 'folder') {
            const value = String(el.value || '');
            // An emptied folder is "not set", which is what the server stores for it.
            w.folder = value.trim() ? value : null;
        } else if (key === 'run_at') {
            w.run_at = String(el.value || '');
        } else if (this.NUMBER_FIELDS.includes(key)) {
            w[key] = this.readNumber(el.value);
        } else if (key === 'platform') {
            const p = String(el.dataset.platform || '');
            if (!this.PLATFORMS.includes(p)) return;
            const on = new Set(w.platforms);
            if (el.checked) on.add(p); else on.delete(p);
            w.platforms = this.PLATFORMS.filter((x) => on.has(x));
            problemKey = 'platforms';
        } else if (key === 'post_at') {
            const k = Number(el.dataset.item);
            if (!(k >= 0 && k < w.post_at.length)) return;
            w.post_at[k] = String(el.value || '');
            problemKey = `post_at.${k}`;
        } else {
            return;
        }
        // Being fixed: the field's own complaint goes the moment it is touched.
        const map = this.fieldProblems;
        if (map && map.has(problemKey)) {
            map.delete(problemKey);
            if (typeof el.removeAttribute === 'function' && key !== 'platform') el.removeAttribute('aria-invalid');
            const list = document.getElementById(`${key === 'platform' ? 'mt-platforms' : el.id}-problems`);
            if (list && typeof list.remove === 'function') list.remove();
        }
        if (this.setup) this.refreshStepMarks();
        this.markSettingsDirty();
    },

    /** The save bar says "unsaved" and names the button; it repaints only when either changes. */
    markSettingsDirty() {
        this._settingsDirty = this.settingsDirty();
        this.paintIfChanged('mt-settings-savebar', this.saveBarMarkup());
    },

    /** A new time starts on the hour rather than empty — a time input cannot show "no time". */
    freeTime() {
        const taken = new Set((this.work ? this.work.post_at : []).map((x) => String(x).trim()));
        for (const hour of [12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 9, 10, 11, 8]) {
            const value = `${String(hour).padStart(2, '0')}:00`;
            if (!taken.has(value)) return value;
        }
        return '12:30';
    },

    addTime() {
        if (!this.work || this.work.post_at.length >= this.POST_AT_MAX) return;
        this.work.post_at.push(this.freeTime());
        this.paintRegion('mt-post_at-host', this.postAtFieldset());
        const field = document.getElementById(`mt-post_at-${this.work.post_at.length - 1}`);
        if (field && typeof field.focus === 'function') field.focus();
        this.afterStructuralEdit();
    },

    removeTime(index) {
        if (!this.work) return;
        const items = this.work.post_at;
        const k = Number(index);
        if (items.length <= 1 || !(k >= 0 && k < items.length)) return;
        items.splice(k, 1);
        // Problems filed by index no longer point at the same rows.
        if (this.fieldProblems) [...this.fieldProblems.keys()].filter((key) => key.startsWith('post_at.')).forEach((key) => this.fieldProblems.delete(key));
        this.paintRegion('mt-post_at-host', this.postAtFieldset());
        const add = document.getElementById('mt-post_at-add') || document.getElementById('mt-post_at-0');
        if (add && typeof add.focus === 'function') add.focus();
        this.afterStructuralEdit();
    },

    afterStructuralEdit() {
        if (this.setup) this.refreshStepMarks();
        this.markSettingsDirty();
    },

    /** Open or close the card. Closing keeps unsaved edits (they live in `work`) and drops a refused save's problems. */
    toggleSettings() {
        this.settingsOpen = !this.settingsOpen;
        if (!this.settingsOpen) {
            this.saveError = null;
            this.fieldProblems = null;
            this.generalProblems = [];
        }
        this.paintSettings();
        const target = document.getElementById('mt-settings-toggle');
        if (target && typeof target.focus === 'function') target.focus();
    },

    discardSettings() {
        this.loadWork();
        this.fieldProblems = null;
        this.generalProblems = [];
        this.saveError = null;
        this.settingsOpen = false;
        this.paintSettings();
        const toggle = document.getElementById('mt-settings-toggle');
        if (toggle && typeof toggle.focus === 'function') toggle.focus();
        Motion.announce(t('studio.editor.discarded'));
    },

    /** The PUT body: the whole section, with numbers as numbers, trimmed times and a null for no folder. */
    settingsPayload() {
        const w = this.work || this.normalizeConfig(null);
        const num = (v) => (typeof v === 'number' ? v : (String(v).trim() === '' ? NaN : Number(v)));
        return {
            enabled: !!w.enabled,
            source: this.SOURCES.includes(w.source) ? w.source : 'folder',
            mode: this.MODES.includes(w.mode) ? w.mode : 'review',
            folder: typeof w.folder === 'string' && w.folder.trim() ? w.folder.trim() : null,
            run_at: String(w.run_at || '').trim(),
            videos_per_run: num(w.videos_per_run),
            reels_per_video: num(w.reels_per_video),
            platforms: this.PLATFORMS.filter((p) => w.platforms.includes(p)),
            post_at: w.post_at.map((x) => String(x || '').trim()).filter(Boolean),
            min_seconds: num(w.min_seconds),
            max_seconds: num(w.max_seconds),
        };
    },

    /**
     * MONTEUR.md §1's rules, checked before the round trip so the answer lands
     * beside the field at once. The server checks all of them again, and is the one
     * that decides.
     */
    localProblems(body) {
        const out = [];
        const add = (key, message) => out.push({ key, message });
        // A daily run from a folder with no folder can never happen, and would still show as on.
        if (body.enabled && body.source === 'folder' && body.folder === null) add('folder', t('monteur.err.folderRequired'));
        if (body.folder !== null) {
            if (body.folder.length > this.FOLDER_MAX) add('folder', t('monteur.err.folderLong', { max: this.FOLDER_MAX }));
            else if (!this.ABSOLUTE_PATH.test(body.folder)) add('folder', t('monteur.err.folder'));
        }
        if (!this.LOCAL_TIME.test(body.run_at)) add('run_at', t('monteur.err.time'));
        ['videos_per_run', 'reels_per_video'].forEach((key) => {
            const [min, max] = this.LIMITS[key];
            const v = body[key];
            if (!Number.isInteger(v) || v < min || v > max) add(key, t('monteur.err.range', { min, max }));
        });
        if (!body.platforms.length) add('platforms', t('monteur.err.platforms'));
        const seen = new Set();
        const items = this.work ? this.work.post_at : body.post_at;
        items.forEach((raw, k) => {
            const value = String(raw || '').trim();
            if (!value) return;
            if (!this.LOCAL_TIME.test(value)) add(`post_at.${k}`, t('monteur.err.time'));
            else if (seen.has(value)) add(`post_at.${k}`, t('monteur.err.timeTwice'));
            seen.add(value);
        });
        if (!body.post_at.length) add('post_at', t('monteur.err.noTime'));
        else if (body.post_at.length > this.POST_AT_MAX) add('post_at', t('monteur.err.tooManyTimes', { max: this.POST_AT_MAX }));
        const [minLo, minHi] = this.LIMITS.min_seconds;
        const [maxLo, maxHi] = this.LIMITS.max_seconds;
        const minOk = Number.isFinite(body.min_seconds) && body.min_seconds >= minLo && body.min_seconds <= minHi;
        if (!minOk) add('min_seconds', t('monteur.err.range', { min: minLo, max: minHi }));
        if (!Number.isFinite(body.max_seconds) || body.max_seconds < maxLo || body.max_seconds > maxHi) {
            add('max_seconds', t('monteur.err.range', { min: maxLo, max: maxHi }));
        } else if (minOk && body.max_seconds <= body.min_seconds) {
            add('max_seconds', t('monteur.err.maxAboveMin', { min: body.min_seconds }));
        }
        return out;
    },

    /**
     * The field a server problem names. Messages lead with their path, as every
     * Studio setting's do: `monteur.post_at[1] must be a time like 13:00` → `post_at.1`.
     * One that names no field of this form is shown in the list above Save.
     */
    problemKey(message) {
        const m = /^([a-zA-Z_]+(?:\.[a-zA-Z_]+|\[\d+\])*)/.exec(String(message || ''));
        if (!m) return '';
        let path = m[1].replace(/\[(\d+)\]/g, '.$1');
        if (path === 'monteur') return '';
        if (path.startsWith('monteur.')) path = path.slice('monteur.'.length);
        return this.FIELDS.includes(path.split('.')[0]) ? path : '';
    },

    problemListOf(err) {
        const list = err && err.body && Array.isArray(err.body.problems) ? err.body.problems : [];
        return list.map((p) => String(p));
    },

    /** Problems beside their fields, the rest above Save, and focus on the first field to fix. */
    showSettingsProblems(filed, message) {
        const map = new Map();
        const general = [];
        filed.forEach((p) => {
            if (!p.key) { general.push(p.message); return; }
            if (!map.has(p.key)) map.set(p.key, []);
            map.get(p.key).push(p.message);
        });
        this.fieldProblems = map;
        this.generalProblems = general;
        this.saveError = message;
        this.settingsOpen = true;
        this.paintSettings();
        const idFor = (key) => {
            if (key === 'platforms') return 'mt-platform-instagram';
            if (key === 'post_at') return 'mt-post_at-0';
            return `mt-${key.replace(/\./g, '-')}`;
        };
        const first = filed.find((p) => p.key && document.getElementById(idFor(p.key)));
        const el = first ? document.getElementById(idFor(first.key)) : document.getElementById('mt-settings-error');
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
        if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
        Motion.announce(message);
    },

    async saveSettings(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (!this.work) return;
        const body = this.settingsPayload();
        const local = this.localProblems(body);
        if (local.length) {
            this.showSettingsProblems(local, t('studio.settings.fixFirst'));
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        const seq = this._seq;
        const tenant = this._tenantEpoch;
        try {
            const res = await API.saveStudioSettings({ monteur: body });
            if (tenant !== this._tenantEpoch) return;
            if (res && res.settings) this.studio = res.settings;
            const saved = res && res.settings && res.settings.monteur ? res.settings.monteur : body;
            if (this.view) this.view.settings = this.normalizeConfig(saved);
            this.setup = false;
            this.settingsOpen = false;
            this.fieldProblems = null;
            this.generalProblems = [];
            this.saveError = null;
            this.loadWork();
            UI.toast(t('monteur.settings.saved'));
            if (!this.alive(seq)) return;
            // The setup's end moves the card below the queue, so the page is laid out again.
            this.paintPage();
            const toggle = document.getElementById('mt-settings-toggle');
            if (toggle && typeof toggle.focus === 'function') toggle.focus();
            // The next run and the next free slot are the server's to work out.
            await this.refresh(seq);
            if (!this.alive(seq)) return;
            this.schedulePoll(seq);
        } catch (err) {
            if (tenant !== this._tenantEpoch || !this.alive(seq)) return;
            const problems = this.problemListOf(err);
            this.showSettingsProblems(
                problems.map((m) => ({ key: this.problemKey(m), message: m })),
                (err && err.message) || t('error.unexpected'),
            );
        } finally {
            restore();
        }
    },

    // ─── Folder, run, worker ─────────────────────────────────────────────────
    async pickFolder(el) {
        const restore = UI.actionBusy(el);
        if (!restore) return;
        const seq = this._seq;
        const tenant = this._tenantEpoch;
        let ok = false;
        try {
            await API.pickMonteurFolder();
            ok = true;
        } catch (err) {
            UI.toast((err && err.message) || t('common.error'), 'error');
        } finally {
            restore();
        }
        if (!ok || !this.alive(seq) || tenant !== this._tenantEpoch || !this.view) return;
        this.pick = { startedAt: Date.now(), before: this.view.settings.folder, ticket: this._readTicket };
        this.pickNote = null;
        this.view.pending.folder_pick = true;
        const btn = document.getElementById('mt-pick-folder');
        if (btn) btn.disabled = true;
        this.paintRegion('mt-pick-status', this.pickStatusMarkup());
        Motion.announce(this.view.worker.online
            ? t('monteur.folder.opened', { name: this.workerName() })
            : t('monteur.folder.openWhenBack', { name: this.workerName() }));
        this.schedulePoll(seq);
    },

    async runNow(el) {
        const restore = UI.actionBusy(el);
        if (!restore) return;
        const seq = this._seq;
        const tenant = this._tenantEpoch;
        let ok = false;
        try {
            await API.runMonteur();
            ok = true;
        } catch (err) {
            // 409 is the contract's "no folder", or in course mode "no lesson left"; said in the operator's language.
            const course = this.view && this.view.settings.source === 'course';
            const said = course ? t('monteur.run.noLessonsToast') : t('monteur.run.noFolderToast');
            UI.toast(err && err.status === 409 ? said : ((err && err.message) || t('common.error')), 'error');
        } finally {
            restore();
        }
        if (!ok || !this.alive(seq) || tenant !== this._tenantEpoch || !this.view) return;
        const name = this.workerName();
        UI.toast(this.view.worker.online ? t('monteur.run.started') : t('monteur.run.startedOffline', { name }));
        this.view.pending.scan = true;
        this.paintStatus();
        await this.refresh(seq);
        if (!this.alive(seq)) return;
        this.schedulePoll(seq);
    },

    /** Re-read now and say whether the worker is back: the offline notice's way out. */
    async checkWorker(el) {
        const restore = UI.actionBusy(el, t('studio.worker.checking'));
        if (!restore) return;
        const seq = this._seq;
        try {
            await this.refresh(seq);
        } finally {
            restore();
        }
        if (!this.alive(seq) || !this.view) return;
        this.schedulePoll(seq);
        const online = this.view.worker.online;
        const message = online ? t('studio.worker.backOnline') : t('studio.worker.stillOffline');
        Motion.announce(message);
        UI.toast(message, online ? 'success' : 'error');
    },

    async retrySource(el) {
        const id = String((el && el.dataset && el.dataset.id) || '');
        const source = this.view && this.view.sources.find((s) => String(s.id) === id);
        if (!source) return;
        const restore = UI.actionBusy(el);
        if (!restore) return;
        const seq = this._seq;
        const tenant = this._tenantEpoch;
        try {
            const res = await API.retryMonteurSource(id);
            if (tenant !== this._tenantEpoch || !this.view) return;
            const next = res && typeof res === 'object' && res.id !== undefined ? res : { ...source, status: 'transcribing', error: null };
            this.view.sources = this.view.sources.map((s) => (String(s.id) === id ? { ...s, ...next } : s));
            UI.toast(t('monteur.source.retried', { name: source.name || '' }));
            if (!this.alive(seq)) return;
            this.refreshSources();
            this.schedulePoll(seq);
        } catch (err) {
            UI.toast((err && err.message) || t('common.error'), 'error');
        } finally {
            restore();
        }
    },

    // ─── A clip: editing ─────────────────────────────────────────────────────
    /** The edit record for a clip, started from what the server has. */
    editFor(clip) {
        const id = String(clip.id);
        if (!this.edits[id]) {
            this.edits[id] = {
                title: String(clip.title || ''),
                caption: clip.copy.caption,
                tiktok_caption: clip.copy.tiktok_caption,
                keyword: clip.copy.keyword,
            };
        }
        return this.edits[id];
    },

    /**
     * The PATCH body: only what changed, trimmed where a stray space is not an
     * edit. `{}` means there is nothing to save.
     */
    clipPatch(clip, edit) {
        const out = {};
        if (!clip || !edit) return out;
        const copy = clip.copy || {};
        if (edit.title !== undefined && String(edit.title).trim() !== String(clip.title || '').trim()) out.title = String(edit.title).trim();
        const next = {};
        if (edit.caption !== undefined && edit.caption !== copy.caption) next.caption = edit.caption;
        if (edit.tiktok_caption !== undefined && edit.tiktok_caption !== copy.tiktok_caption) next.tiktok_caption = edit.tiktok_caption;
        if (edit.keyword !== undefined && String(edit.keyword).trim() !== String(copy.keyword || '').trim()) next.keyword = String(edit.keyword).trim();
        if (Object.keys(next).length) out.copy = next;
        return out;
    },

    /** MONTEUR.md §5: a title or keyword is burned into the video; captions are not. */
    rerenders(patch) {
        return !!patch && ('title' in patch || !!(patch.copy && 'keyword' in patch.copy));
    },

    clipDirty(id) {
        const clip = this.clipById(id);
        return !!clip && Object.keys(this.clipPatch(clip, this.edits[String(id)])).length > 0;
    },

    /** Letters, as the keyword rule counts them: tatweel and diacritics are not letters. */
    letterCount(word) {
        return Array.from(UI.normalizeArabic(String(word || '')).replace(/[^\p{L}]/gu, '')).length;
    },

    clipProblems(patch, clip) {
        const out = [];
        if ('title' in patch) {
            if (!patch.title) out.push({ field: 'title', message: t('monteur.clip.titleRequired') });
            else if (patch.title.length > this.TITLE_MAX) out.push({ field: 'title', message: t('monteur.clip.titleLong', { n: patch.title.length, max: this.TITLE_MAX }) });
        }
        if (patch.copy && ('caption' in patch.copy || 'keyword' in patch.copy) && clip) {
            const word = String((patch.copy.keyword !== undefined ? patch.copy.keyword : clip.copy.keyword) || '').trim();
            if (word && !this.effectiveCaption(clip).includes(`«${word}»`)) {
                out.push({ field: 'caption', message: t('monteur.clip.captionAsk', { keyword: `«${word}»` }) });
            }
        }
        if (patch.copy && 'keyword' in patch.copy) {
            if (!patch.copy.keyword) out.push({ field: 'keyword', message: t('monteur.clip.keywordRequired') });
            else if (/\s/.test(patch.copy.keyword)) out.push({ field: 'keyword', message: t('studio.keywordOneWord') });
            else if (this.letterCount(patch.copy.keyword) < this.KEYWORD_MIN) out.push({ field: 'keyword', message: t('monteur.clip.keywordShort', { min: this.KEYWORD_MIN }) });
        }
        return out;
    },

    /** Typing in a clip's field: into the edit record, then the counters and checks. Nothing is rebuilt. */
    clipField(el) {
        if (!el || !el.dataset) return;
        const clip = this.clipById(el.dataset.clip);
        const field = String(el.dataset.field || '');
        if (!clip || clip.status !== 'review' || !this.CLIP_FIELDS.includes(field)) return;
        const id = String(clip.id);
        this.editFor(clip)[field] = String(el.value === undefined || el.value === null ? '' : el.value);
        const count = document.getElementById(`${el.id}-count`);
        if (count) {
            const max = Number(count.dataset && count.dataset.max) || 0;
            const n = String(el.value || '').length;
            count.innerHTML = esc(this.countMarkup(n, max));
            if (count.classList) count.classList.toggle('is-warning', n > max);
        }
        if (field === 'caption' || field === 'tiktok_caption' || field === 'keyword') {
            const checks = this.checksFor(clip);
            this.paintIfChanged(`mt-clip-${id}-caption-check`, this.lineCheckMarkup(checks.ig));
            this.paintIfChanged(`mt-clip-${id}-tiktok_caption-check`, this.lineCheckMarkup(checks.tt));
            this.paintIfChanged(`mt-clip-${id}-follows`, this.keywordFollowsMarkup(clip));
            this.paintIfChanged(`mt-clip-${id}-variants`, this.variantsMarkup(clip));
        }
        if (this.clipErrors[id]) {
            delete this.clipErrors[id];
            this.paintRegion(`mt-clip-${id}-error`, '');
            if (typeof el.removeAttribute === 'function') el.removeAttribute('aria-invalid');
        }
        this.markClipDirty(clip);
    },

    /** What depends on "this card has unsaved edits" repaints only when that flips. */
    markClipDirty(clip) {
        const id = String(clip.id);
        this.paintIfChanged(`mt-clip-${id}-warn`, this.rerenderMarkup(clip));
        const dirty = this.clipDirty(id);
        if (dirty === !!this._clipDirty[id]) return;
        this._clipDirty[id] = dirty;
        this.paintRegion(`mt-clip-${id}-savebar`, this.clipSaveBarMarkup(clip));
        this.paintIfChanged(`mt-clip-${id}-approve`, this.approveMarkup(clip));
    },

    /** The card rebuilt from the server's copy (or from its edits), in place. */
    repaintClip(id) {
        const clip = this.clipById(id);
        const el = document.getElementById(`mt-clip-${id}`);
        if (!clip || !el) {
            this.refreshQueue();
            return;
        }
        const kind = clip.status === 'review' ? 'review' : clip.status === 'scheduled' ? 'scheduled' : 'working';
        const focus = UI.captureFocus(el);
        el.innerHTML = esc(this.rowInner(kind, clip));
        if (el.dataset) el.dataset.rowSig = this.rowSignature(kind, clip);
        UI.icons(el);
        UI.restoreFocus(focus);
    },

    discardClip(id) {
        const key = String(id);
        delete this.edits[key];
        delete this.clipErrors[key];
        this._clipDirty[key] = false;
        this.repaintClip(key);
        const field = document.getElementById(`mt-clip-${key}-title`);
        if (field && typeof field.focus === 'function') field.focus();
        Motion.announce(t('studio.editor.discarded'));
    },

    showClipError(id, message, problems, fieldId) {
        const key = String(id);
        this.clipErrors[key] = { message, problems: problems || [] };
        this.paintRegion(`mt-clip-${key}-error`, this.clipErrorMarkup(key));
        const field = fieldId ? document.getElementById(fieldId) : null;
        if (field) UI.markInvalid(field, `mt-clip-${key}-error-strip`);
        Motion.announce(message);
    },

    /** Put a ClipView from the server into the view, replacing the old one. */
    replaceClip(clipView) {
        if (!this.view || !clipView || typeof clipView !== 'object' || clipView.id === undefined) return false;
        const next = { ...clipView, copy: this.normalizeCopy(clipView.copy) };
        const key = String(next.id);
        const at = this.view.clips.findIndex((c) => String(c.id) === key);
        if (at === -1) this.view.clips.unshift(next);
        else this.view.clips[at] = next;
        return true;
    },

    async saveClip(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const id = String((form && form.dataset && form.dataset.clip) || '');
        const clip = this.clipById(id);
        if (!clip || clip.status !== 'review') return;
        const patch = this.clipPatch(clip, this.edits[id]);
        if (!Object.keys(patch).length) return;
        const local = this.clipProblems(patch, clip);
        if (local.length) {
            this.showClipError(id, local[0].message, local.slice(1).map((p) => p.message), `mt-clip-${id}-${local[0].field}`);
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        const seq = this._seq;
        const tenant = this._tenantEpoch;
        try {
            const res = await API.updateMonteurClip(id, patch);
            if (tenant !== this._tenantEpoch) return;
            const rerender = this.rerenders(patch);
            if (!this.replaceClip(res)) {
                // An answer that is not a ClipView: the view is re-read instead of guessed.
                await this.refresh(seq);
            }
            delete this.edits[id];
            delete this.clipErrors[id];
            this._clipDirty[id] = false;
            UI.toast(rerender ? t('monteur.clip.savedRerender', { name: this.workerName() }) : t('monteur.clip.saved'));
            if (!this.alive(seq)) return;
            this.refreshQueue();
            this.repaintClip(id);
            this.schedulePoll(seq);
        } catch (err) {
            // A refused keyword (too short, or another campaign's) comes back as a 400 or 409 with its reason.
            if (tenant !== this._tenantEpoch || !this.alive(seq)) return;
            this.showClipError(id, this.plainMessage((err && err.message) || t('error.unexpected')),
                this.problemListOf(err).map((p) => this.plainMessage(p)));
        } finally {
            restore();
        }
    },

    /**
     * The server leads a message with the field it is about (`copy.keyword: «x» sits
     * inside…`). Beside that very field the path is noise, so it is dropped for display.
     */
    plainMessage(message) {
        return String(message || '').replace(/^[a-z_]+(?:[._][a-z_]+|\[\d+\])+:\s+/i, '');
    },

    // ─── A clip: approving and rejecting ─────────────────────────────────────
    toggleOverride(id) {
        const clip = this.clipById(id);
        if (!clip || clip.status !== 'review') return;
        const key = String(id);
        const o = this.overrides[key] || { open: false, value: '' };
        if (o.open) {
            o.open = false;
        } else {
            o.open = true;
            // Opens on the time Approve would have taken, in the tenant's zone — the next
            // day at that time when a sibling from the same video already has that day.
            const slot = this.slotFor(clip);
            let start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            if (slot) start = slot.clash ? new Date(Date.parse(slot.iso) + 24 * 60 * 60 * 1000).toISOString() : slot.iso;
            o.value = o.value || this.toZoneInput(start, this.zone());
        }
        this.overrides[key] = o;
        this.paintRegion(`mt-clip-${key}-approve`, this.approveMarkup(clip));
        const target = document.getElementById(o.open ? `mt-clip-${key}-time` : `mt-clip-${key}-time-toggle`);
        if (target && typeof target.focus === 'function') target.focus();
    },

    overrideInput(el) {
        if (!el || !el.dataset) return;
        const key = String(el.dataset.clip || '');
        const o = this.overrides[key];
        if (!o) return;
        o.value = String(el.value || '');
        // The button says what it will do, as the field stands.
        const label = document.getElementById(`mt-clip-${key}-approve-label`);
        const iso = this.fromZoneInput(o.value, this.zone());
        if (label) label.textContent = iso ? t('monteur.clip.approveAt', { when: this.zoneTime(iso) }) : t('monteur.clip.approve');
        // The region now shows what this markup would: recorded, so the next poll
        // finds nothing to repaint and the field being typed in is left alone.
        const clip = this.clipById(key);
        if (clip) this._painted[`mt-clip-${key}-approve`] = esc(this.approveMarkup(clip));
    },

    /** `{ ok, body }`: `{}` for the next free slot, or `{ scheduled_time }` read in the tenant's zone. */
    readApprove(id) {
        const key = String(id);
        const o = this.overrides[key];
        if (!o || !o.open) return { ok: true, body: {} };
        const field = `mt-clip-${key}-time`;
        const iso = this.fromZoneInput(o.value, this.zone());
        if (!iso) return { ok: false, message: t('studio.schedule.pickTime'), field };
        if (Date.parse(iso) <= Date.now()) return { ok: false, message: t('studio.schedule.inPast'), field };
        return { ok: true, body: { scheduled_time: iso } };
    },

    async approve(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const id = String((form && form.dataset && form.dataset.clip) || '');
        const clip = this.clipById(id);
        if (!clip || clip.status !== 'review') return;
        if (this.clipDirty(id)) {
            this.showClipError(id, t('monteur.clip.saveFirst'), []);
            return;
        }
        const read = this.readApprove(id);
        if (!read.ok) {
            this.showClipError(id, read.message, [], read.field);
            return;
        }
        const restore = UI.formBusy(form, t('monteur.clip.approving'));
        if (!restore) return;
        const seq = this._seq;
        const tenant = this._tenantEpoch;
        this._approving[id] = true;
        try {
            const res = await API.approveMonteurClip(id, read.body);
            delete this._approving[id];
            if (tenant !== this._tenantEpoch) return;
            const when = (res && res.scheduled_time) || (res && res.clip && res.clip.scheduled_time) || read.body.scheduled_time || null;
            if (!this.replaceClip(res && res.clip)) {
                const at = this.view.clips.findIndex((c) => String(c.id) === id);
                if (at !== -1) this.view.clips[at] = { ...this.view.clips[at], status: 'scheduled', scheduled_time: when };
            }
            delete this.overrides[id];
            delete this.clipErrors[id];
            delete this.edits[id];
            const campaign = res && res.campaign && typeof res.campaign === 'object' ? res.campaign : null;
            const keyword = String((campaign && campaign.trigger_keyword) || clip.copy.keyword || '');
            let message = when ? t('monteur.clip.approved', { when: this.zoneTime(when) }) : t('monteur.clip.approvedNoTime');
            if (campaign) message = `${message} ${campaign.created ? t('monteur.clip.campaignCreated', { keyword }) : t('monteur.clip.campaignReused', { keyword })}`;
            UI.toast(message);
            Motion.announce(message);
            if (!this.alive(seq)) return;
            this.refreshQueue();
            // The next free slot has moved, and it is on every other Approve button.
            await this.refresh(seq);
            if (!this.alive(seq)) return;
            this.schedulePoll(seq);
        } catch (err) {
            delete this._approving[id];
            restore();
            if (tenant !== this._tenantEpoch || !this.alive(seq)) return;
            const raw = String((err && err.message) || '');
            const message = this.plainMessage(raw || t('error.unexpected'));
            // §6.1: another reel from this video already has that day, or no day is free:
            // the reason, and the time picker open on it.
            if (err && err.status === 409 && /^scheduled_time:|posting slot/i.test(raw)) {
                const o = this.overrides[id];
                if (!o || !o.open) this.toggleOverride(id);
                this.showClipError(id, message, [t('monteur.clip.pickAnotherTime')], `mt-clip-${id}-time`);
                return;
            }
            this.showClipError(id, message, this.problemListOf(err).map((p) => this.plainMessage(p)));
            // Otherwise a 409 means the clip moved on (re-rendering, approved elsewhere): show where it is.
            if (err && err.status === 409) this.refresh(seq);
        }
    },

    /** A failed render, queued again: POST /clips/:id/rerender, and the clip goes back to rendering. */
    async rerenderClip(el) {
        const id = String((el && el.dataset && el.dataset.clip) || '');
        const clip = this.clipById(id);
        if (!clip || clip.status !== 'failed') return;
        const restore = UI.actionBusy(el);
        if (!restore) return;
        const seq = this._seq;
        const tenant = this._tenantEpoch;
        try {
            const res = await API.rerenderMonteurClip(id);
            if (tenant !== this._tenantEpoch || !this.view) return;
            if (!this.replaceClip(res)) {
                const at = this.view.clips.findIndex((c) => String(c.id) === id);
                if (at !== -1) this.view.clips[at] = { ...this.view.clips[at], status: 'rendering', error: null };
            }
            UI.toast(t('monteur.clip.retried', { title: clip.title || t('monteur.clip.untitled') }));
            if (!this.alive(seq)) return;
            this.refreshQueue();
            this.schedulePoll(seq);
        } catch (err) {
            UI.toast((err && err.message) || t('common.error'), 'error');
        } finally {
            restore();
        }
    },

    reject(id) {
        const clip = this.clipById(id);
        if (!clip) return;
        const failed = clip.status === 'failed';
        Admin.confirm({
            title: failed ? t('monteur.clip.dismissTitle') : t('monteur.clip.rejectTitle'),
            body: t('monteur.clip.rejectBody', { title: clip.title || t('monteur.clip.untitled') }),
            hint: failed ? '' : t('monteur.clip.rejectHint'),
            confirmLabel: failed ? t('monteur.clip.dismiss') : t('monteur.clip.reject'),
            confirmIcon: 'x',
            onConfirm: () => MonteurPage.rejectConfirmed(String(clip.id)),
        });
    },

    /** Returns the promise: a refusal stays in the dialog, next to the button that caused it. */
    async rejectConfirmed(id) {
        const tenant = this._tenantEpoch;
        await API.rejectMonteurClip(id);
        if (tenant !== this._tenantEpoch || !this.view) return;
        // Rejected clips are not in the view's list, so it simply leaves the queue.
        this.view.clips = this.view.clips.filter((c) => String(c.id) !== String(id));
        this.pruneClipState();
        UI.toast(t('monteur.clip.rejected'));
        this.refreshQueue();
    },

    // ─── Lessons ─────────────────────────────────────────────────────────────
    /**
     * `lessons` is the latest DONE row, so its rules are the ones in use, and they
     * stay on screen whatever the last attempt did. `lessons.last_run` is that attempt:
     * running, or failed with a reason the card says out loud.
     */
    lessonsFailure(l) {
        if (!l) return '';
        const lr = l.last_run && typeof l.last_run === 'object' ? l.last_run : null;
        if (lr) {
            if (lr.status !== 'failed') return '';
            const message = lr.error || t('error.unexpected');
            return lr.created_at
                ? t('monteur.lessons.lastFailed', { when: UI.relativeAge(lr.created_at).text, message })
                : t('monteur.lessons.failed', { message });
        }
        return l.status === 'failed' ? t('monteur.lessons.failed', { message: l.error || t('error.unexpected') }) : '';
    },

    lessonsMarkup() {
        const l = this.view.lessons;
        const running = this.lessonsBusy || this.lessonsRunning(l);
        const failure = this.lessonsFailure(l);
        const rules = l && Array.isArray(l.lessons) ? l.lessons.filter((r) => r && r.rule) : [];
        const basis = l && l.basis && typeof l.basis === 'object' ? l.basis : null;
        const made = l && l.created_at ? UI.relativeAge(l.created_at) : null;
        const posts = basis ? Math.max(0, Number(basis.posts) || 0) : 0;
        return html`
            <div class="studio-section-head">
                <h2 class="section-title" id="mt-lessons-title">${t('monteur.lessons.title')}</h2>
                ${UI.button({
                    variant: 'secondary', size: 'sm', icon: 'refresh-cw', label: t('monteur.lessons.refresh'),
                    action: 'monteur:refreshLessons', id: 'mt-lessons-refresh', disabled: running,
                    title: running ? t('monteur.lessons.running') : '',
                })}
            </div>
            <p class="form-hint studio-section-lede">${t('monteur.lessons.intro')}</p>
            ${running ? html`
                <p class="draft-card-stage" id="mt-lessons-running">
                    <span class="spinner spinner-sm" aria-hidden="true"></span> ${t('monteur.lessons.running')}
                </p>
            ` : ''}
            ${failure && !running ? html`<p class="post-card-error" dir="auto" id="mt-lessons-failed">${failure}</p>` : ''}
            ${!rules.length && !running ? html`
                <p class="studio-empty-note">${t('monteur.lessons.empty')}</p>
                <p class="form-hint">${t('monteur.lessons.emptyBody')}</p>
            ` : ''}
            ${l && l.summary ? html`<p class="monteur-lessons-summary user-content" dir="auto">${l.summary}</p>` : ''}
            ${rules.length ? html`
                <ol class="monteur-lessons" id="mt-lessons-list">
                    ${rules.map((r) => html`
                        <li>
                            <p class="monteur-rule" dir="auto">${r.rule}</p>
                            ${r.evidence ? html`<p class="text-meta" dir="auto">${r.evidence}</p>` : ''}
                        </li>
                    `)}
                </ol>
            ` : ''}
            ${made ? html`
                <p class="text-meta" id="mt-lessons-made" title="${made.title}">
                    ${t('monteur.lessons.made', { when: made.text })}${posts ? html` · ${t('monteur.lessons.basis', { count: posts, n: UI.formatNumber(posts) })}` : ''}${basis && basis.from && basis.to ? html` · ${t('monteur.lessons.range', { from: this.zoneDay(basis.from), to: this.zoneDay(basis.to) })}` : ''}
                </p>
            ` : ''}
        `;
    },

    /**
     * Runs the Analyst now: one Gemini call, most of a minute. The card says what it
     * is doing for the whole of it, and its button is disabled rather than busy,
     * because the repaint that says so replaces the button.
     */
    async refreshLessons() {
        if (this.lessonsBusy || !this.view) return;
        const seq = this._seq;
        const tenant = this._tenantEpoch;
        this.lessonsBusy = true;
        this.paintRegion('mt-lessons', this.lessonsMarkup());
        Motion.announce(t('monteur.lessons.running'));
        let res = null;
        let failure = null;
        try {
            res = await API.refreshMonteurLessons();
        } catch (err) {
            failure = err;
        } finally {
            this.lessonsBusy = false;
        }
        if (tenant !== this._tenantEpoch || !this.view) return;
        if (res && typeof res === 'object') this.view.lessons = res;
        const attempt = res && res.last_run && typeof res.last_run === 'object' ? res.last_run : res;
        if (failure) UI.toast((failure && failure.message) || t('common.error'), 'error');
        else if (attempt && attempt.status === 'failed') UI.toast(t('monteur.lessons.failed', { message: attempt.error || t('error.unexpected') }), 'error');
        else UI.toast(t('monteur.lessons.done'));
        // The card is painted from `lessonsBusy`, so it is repainted wherever this page
        // now is — including a re-render that happened while the Analyst was running,
        // which painted it as "running" — but never over another page.
        if (!this.aliveNow()) return;
        this.paintRegion('mt-lessons', this.lessonsMarkup());
        if (seq === this._seq) {
            const again = document.getElementById('mt-lessons-refresh');
            if (again && typeof again.focus === 'function') again.focus();
        }
        this.schedulePoll(this._seq);
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

    deviceZone() {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
    },

    /** The tenant's zone (Studio → Settings → Schedule), else this browser's. */
    zone() {
        const zone = this.view && this.view.timezone;
        return this.validZone(zone) ? zone : this.deviceZone();
    },

    /** "Riyadh" / «الرياض»: the Studio's own city names. */
    zoneCity(zone) {
        const city = String(zone || 'UTC').split('/').pop().replace(/_/g, ' ');
        const key = `studio.city.${city.replace(/\s+/g, '')}`;
        const named = t(key);
        return named && named !== key ? named : city;
    },

    _fmtCache: new Map(),

    zoneFormat(value, options) {
        const d = value instanceof Date ? value : new Date(value);
        if (value === null || value === undefined || value === '' || Number.isNaN(d.getTime())) return '';
        const zone = this.zone();
        const key = `${I18N.locale()}|${zone}|${JSON.stringify(options)}`;
        let fmt = this._fmtCache.get(key);
        if (fmt === undefined) {
            try {
                fmt = new Intl.DateTimeFormat(I18N.locale(), { ...options, timeZone: zone });
            } catch {
                fmt = null;
            }
            this._fmtCache.set(key, fmt);
        }
        if (fmt) {
            try { return fmt.format(d); } catch { /* fall through */ }
        }
        return UI.formatDateTime(d);
    },

    /** "Sun, 28 Sep, 19:00" in the tenant's zone, 24-hour like every setting it came from. */
    zoneTime(value) {
        return this.zoneFormat(value, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    },

    zoneDay(value) {
        return this.zoneFormat(value, { day: 'numeric', month: 'short' });
    },

    /** "Sun, 28 Sep, 19:00 (Riyadh)": a time with the zone it is in, for anything the settings drive. */
    zoneLabel(value) {
        const text = this.zoneTime(value);
        return text ? t('monteur.zoned', { time: text, city: this.zoneCity(this.zone()) }) : '';
    },

    /** Minutes `zone` is ahead of UTC at the instant `at` (ms). */
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

    /** An instant as `<input type="datetime-local">` shows it, in `zone`'s wall time. */
    toZoneInput(value, zone) {
        const d = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(d.getTime())) return '';
        const offset = this.zoneOffsetMin(zone, d.getTime());
        return new Date(d.getTime() + offset * 60000).toISOString().slice(0, 16);
    },

    /**
     * `YYYY-MM-DDTHH:MM` read as wall time in `zone`, back to an ISO instant. The
     * offset is looked up at the instant it produces, and corrected once, so a time
     * either side of a daylight-saving change lands on the right hour.
     */
    fromZoneInput(value, zone) {
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
        if (!m) return null;
        const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
        if (!Number.isFinite(wall)) return null;
        let utc = wall - this.zoneOffsetMin(zone, wall) * 60000;
        const corrected = wall - this.zoneOffsetMin(zone, utc) * 60000;
        if (corrected !== utc) utc = corrected;
        const d = new Date(utc);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    },
};

/**
 * The delegated dispatcher catches synchronous throws only. Every async handler
 * here settles its own failures, but a rejection that got past one should still
 * be said out loud rather than left in the console.
 */
const monteurReport = (value) => {
    Promise.resolve(value).catch((err) => UI.toast((err && err.message) || t('common.error'), 'error'));
};

UI.registerActions('monteur', {
    // Status strip
    runNow: (el) => monteurReport(MonteurPage.runNow(el)),
    checkWorker: (el) => monteurReport(MonteurPage.checkWorker(el)),
    // Settings
    pickFolder: (el) => monteurReport(MonteurPage.pickFolder(el)),
    setting: (el) => MonteurPage.setting(el),
    addTime: () => MonteurPage.addTime(),
    removeTime: (el) => MonteurPage.removeTime(el.dataset.item),
    toggleSettings: () => MonteurPage.toggleSettings(),
    saveSettings: (el, e) => monteurReport(MonteurPage.saveSettings(el, e)),
    discardSettings: () => MonteurPage.discardSettings(),
    // Sources
    retrySource: (el) => monteurReport(MonteurPage.retrySource(el)),
    // The review queue
    clipField: (el) => MonteurPage.clipField(el),
    saveClip: (el, e) => monteurReport(MonteurPage.saveClip(el, e)),
    discardClip: (el) => MonteurPage.discardClip(el.dataset.clip),
    toggleOverride: (el) => MonteurPage.toggleOverride(el.dataset.clip),
    overrideInput: (el) => MonteurPage.overrideInput(el),
    approve: (el, e) => monteurReport(MonteurPage.approve(el, e)),
    reject: (el) => MonteurPage.reject(el.dataset.clip),
    rerender: (el) => monteurReport(MonteurPage.rerenderClip(el)),
    // Lessons
    refreshLessons: () => monteurReport(MonteurPage.refreshLessons()),
});
