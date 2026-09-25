/**
 * Carousel Studio — turn course lessons into carousels, edit them, schedule them.
 *
 * The contract is STUDIO.md §4. Three parties are involved and only one of them
 * is this page: the app API writes the copy (Gemini, up to two minutes), and a
 * worker on the operator's Mac indexes lessons and renders the slides. The Mac
 * is not always on, so every screen here has to be honest about which of the
 * two is waiting on which:
 *
 *   - The worker pill is a MEASUREMENT, not a decoration: `online` means the
 *     worker was seen within 90s, and "last seen" says when. DESIGN.md §6 rules
 *     out a status badge that is green whenever the page rendered; this one goes
 *     grey the moment the Mac does, and says what to do about it.
 *   - A render waits in the queue while the Mac is off. The editor polls every
 *     4s while a draft is `rendering`, and says so, instead of looking finished.
 *
 * ─── Two views, one route ───────────────────────────────────────────────────
 * `#/studio` is the home view (status, a new carousel, the drafts) and
 * `#/studio?draft=<id>` is the editor. Both go through the hash router, so a
 * draft is a real link: it survives a reload, and Back leaves the editor.
 *
 * ─── The working copy ───────────────────────────────────────────────────────
 * The editor never edits `draft` in place. `work` is a deep copy of the
 * draft's `{ carousel, shots, campaign }`; typing writes into it and nothing
 * is re-rendered on a keystroke (a repaint would drop the caret and break an
 * Arabic IME mid-composition). Save sends `work` as the PATCH body; the render
 * poll updates `draft` and leaves `work` alone, so a poll landing mid-edit
 * cannot throw the operator's typing away.
 *
 * ─── Problems ───────────────────────────────────────────────────────────────
 * The server's `validateCarousel` is the authority. Its messages follow
 * check-carousels.mts — `Id[3:point].title: 45 > 40 «…»` — so a 400's
 * `problems` are sorted onto the slide and field they name (`problemTarget`),
 * and anything that names neither stays in the problems panel above the forms.
 *
 * ─── One path, three steps ──────────────────────────────────────────────────
 * Choose a topic → Generate → Review & schedule, with a stepper saying where
 * the operator is and exactly one primary button per step: Generate on the
 * home view, then Save (while there are edits) or Schedule in the editor.
 * Everything else is progressive: angle, slide count, keyword and accent sit
 * under "More options" and remember their last value in this browser; the
 * setup checklist appears only while the lesson path is actually blocked.
 *
 * ─── Nothing typed is lost ──────────────────────────────────────────────────
 * The editor keeps a copy of unsaved edits in localStorage, keyed by draft and
 * by the server copy they were made against, and offers it back on the next
 * visit. Generation (a minute, synchronous on the server) never freezes the
 * page: the operator can leave, and the progress card is still there when they
 * come back, because the request belongs to this object, not to the DOM.
 */
const StudioPage = {
    // ─── Home state ──────────────────────────────────────────────────────────
    status: null,
    statusError: null,
    lessons: [],
    lessonsLoaded: false,
    lessonsError: null,
    drafts: [],
    draftsError: null,
    /** Lesson ids picked for the next carousel, in the order they were picked. */
    selected: [],
    /** `{ message, problems }` under the New carousel form, or null. */
    newError: null,
    generating: false,
    /**
     * "Plan my week": `{ status: 'loading'|'ready'|'error', proposals, error }`.
     * Each proposal carries `keep` and a per-item run state for "Generate all":
     * idle | writing | done | failed.
     */
    plan: null,
    planRunning: false,
    /**
     * draftId → the slot a plan proposed for it. DraftInput has no slot field,
     * so the server never learns it: this is only known in the session that ran
     * the plan. It defaults the schedule picker while that slot is still free.
     */
    plannedSlots: {},
    /** 'lesson' | 'idea': where the next carousel comes from. Null until chosen, then remembered. */
    mode: null,
    /** The lesson picker's search text. */
    lessonQuery: '',
    /** What the create form holds across repaints and visits, so a repaint never eats typing. */
    newText: { idea: '', keyword: '' },
    /** The generation in flight: `{ startedAt, lessonMode, summary, stage }`, or null. */
    gen: null,

    // ─── Settings state (STUDIO.md §10) ──────────────────────────────────────
    /** The tenant's StudioSettings, as the server last returned them. */
    settings: null,
    settingsError: null,
    /** The operator's copy of the six editable sections. */
    settingsWork: null,
    _settingsBaseline: '',
    settingsProblems: null,
    settingsSaveError: null,
    workers: [],
    workersLoaded: false,
    workersError: null,
    /**
     * `{ worker, token }` straight off POST /workers. The token is shown from
     * here and from nowhere else: it is not in any list the server returns, and
     * this is cleared on Done, on leaving the tab and on a tenant switch.
     */
    newWorker: null,

    // ─── Editor state ────────────────────────────────────────────────────────
    draftId: '',
    draft: null,
    draftLessons: [],
    draftError: null,
    /** The operator's copy: `{ carousel, shots, campaign }`. */
    work: null,
    /** JSON of the server's copy, to tell whether `work` has unsaved edits. */
    _baseline: '',
    previewTab: 'ig',
    /** `{ all, bySlide: Map<index, []>, byField: Map<path, []> }` after a 400. */
    problems: null,
    saveError: null,
    saving: false,
    slots: null,
    slotsError: null,
    /** lessonId → `{ lesson, moments }` from GET /lessons/:id, for shots. */
    lessonDetails: {},
    /** The slide shown in the preview, and whose form is open beside it. */
    selectedSlide: 0,
    /** A deleted slide that Undo can still put back: `{ slide, index, shots }`. */
    undo: null,
    _undoTimer: null,
    /** Unsaved edits found in this browser on open: `{ state: 'restored'|'stale', work }`, or null. */
    restored: null,
    /** The screenshot picker's "clean frames only" filter. On: clean frames make the best slides. */
    cleanOnly: true,
    /** Settings problems filed by path (`product.url`), after a refused or locally checked save. */
    settingsFieldProblems: null,

    // ─── Timers and sequencing ───────────────────────────────────────────────
    /**
     * Bumped by every render() and destroy(). Anything that awaited checks it
     * before painting, so a late response never lands on the page that
     * replaced this one — the same `_seq` shape PostsPage uses.
     */
    _seq: 0,
    _statusTimer: null,
    _statusInFlight: false,
    /** Status-bar actions in flight. The 15s repaint waits while one runs. */
    _statusBusy: 0,
    _pollTimer: null,
    _genTimer: null,
    _modalToken: 0,

    MAX_LESSONS: 3,
    SLIDES_MIN: 6,
    SLIDES_MAX: 10,
    SLIDES_DEFAULT: 8,
    PLAN_COUNTS: Object.freeze([3, 4, 5, 6, 7]),
    PLAN_DEFAULT: 5,
    SLOT_COUNT: 6,
    STATUS_REFRESH_MS: 15000,
    RENDER_POLL_MS: 4000,
    ANGLES: Object.freeze(['auto', 'tips', 'steps', 'mistakes', 'compare', 'prompt', 'overview']),
    TIKTOK_TITLE_MAX: 90,
    IG_CAPTION_MAX: 2200,
    TIKTOK_CAPTION_MAX: 4000,
    ACCENT_RE: /^#[0-9A-Fa-f]{6}$/,
    /** Per-browser memory: the last generation options, and unsaved edits per draft. Colons, not dots: these are not i18n keys. */
    PREFS_KEY: 'studio:prefs',
    EDITS_PREFIX: 'studio:edits:',
    UNDO_MS: 12000,
    /**
     * What generation is doing, told by the clock. POST /drafts is one synchronous
     * request, so the server cannot report its stages; these are where a typical run
     * is at that point, and the copy says "usually". The fourth stage, drawing, is
     * real: it starts when the draft comes back `rendering`.
     */
    GEN_STAGES: Object.freeze(['read', 'write', 'check', 'render']),
    GEN_STAGE_AT: Object.freeze([0, 8, 45]),
    GEN_SLOW_S: 80,
    _renderTimer: null,
    _onKeydown: null,
    _onBeforeUnload: null,

    destroy() {
        this._seq++;
        this.stopStatusTimer();
        this.stopPoll();
        this.stopGenTicker();
        this.stopRenderTicker();
        this.unbindKeys();
        this.clearUndo();
        // A worker token is shown once. Leaving the page is the end of "once".
        this.newWorker = null;
    },

    // ─── Browser memory ──────────────────────────────────────────────────────
    /** localStorage can be missing, full or refused (private mode): every use is guarded, and optional. */
    storeGet(key) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    },

    storeSet(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    },

    storeRemove(key) {
        try { localStorage.removeItem(key); } catch { /* private mode: nothing was stored */ }
    },

    /**
     * The last generation options, each re-checked so a stale or hand-edited entry
     * cannot send junk. The keyword is deliberately NOT remembered: a keyword reused
     * by accident answers the next post's commenters with the previous post's DM.
     */
    prefs() {
        const p = this.storeGet(this.PREFS_KEY) || {};
        const slides = Math.round(Number(p.slides));
        return {
            mode: p.mode === 'idea' || p.mode === 'lesson' ? p.mode : null,
            angle: this.ANGLES.includes(p.angle) ? p.angle : 'auto',
            slides: slides >= this.SLIDES_MIN && slides <= this.SLIDES_MAX ? slides : this.SLIDES_DEFAULT,
            accent: typeof p.accent === 'string' && this.ACCENT_RE.test(p.accent) ? p.accent.toUpperCase() : '',
        };
    },

    savePrefs(patch) {
        this.storeSet(this.PREFS_KEY, { ...this.prefs(), ...patch });
    },

    // ─── The stepper ─────────────────────────────────────────────────────────
    /**
     * Choose a topic → Generate → Review & schedule. `current` is 1–3, or 4 once
     * the draft is scheduled and every step is done. It is a list, not tabs: the
     * steps are where the operator IS, and the page's own buttons move them on.
     */
    stepperMarkup(current) {
        const steps = ['topic', 'generate', 'review'];
        return html`
            <ol class="studio-stepper" aria-label="${t('studio.step.label')}">
                ${steps.map((key, i) => {
                    const n = i + 1;
                    const state = n < current ? 'done' : n === current ? 'current' : 'todo';
                    return html`
                        <li class="studio-step is-${html.raw(state)}"${state === 'current' ? html.raw(' aria-current="step"') : ''}>
                            <span class="studio-step-num" aria-hidden="true">${state === 'done'
                                ? html`<i data-lucide="check" aria-hidden="true"></i>` : UI.formatNumber(n)}</span>
                            <span class="studio-step-label">${t(`studio.step.${key}`)}</span>
                            <span class="sr-only">${t(`studio.step.state.${state}`)}</span>
                        </li>
                    `;
                })}
            </ol>
        `;
    },

    paintStepper(current) {
        this.paintRegion('studio-stepper', this.stepperMarkup(current));
    },

    /** Where a draft stands on the three steps. */
    editorStep() {
        const status = this.draft && this.draft.status;
        if (status === 'scheduled') return 4;
        if (status === 'generating') return 2;
        return 3;
    },

    /** Bumped by a tenant switch: a generation started before it must not open, paint or toast after it. */
    _tenantEpoch: 0,

    /** Tenant switch: every list, draft and plan here belongs to the old tenant. */
    resetTenantState() {
        this._tenantEpoch++;
        this.destroy();
        this.status = null;
        this.statusError = null;
        this.lessons = [];
        this.lessonsLoaded = false;
        this.lessonsError = null;
        this.drafts = [];
        this.draftsError = null;
        this.selected = [];
        this.newError = null;
        this.generating = false;
        this.gen = null;
        this.mode = null;
        this.lessonQuery = '';
        this.newText = { idea: '', keyword: '' };
        this.plan = null;
        this._planSeq++;
        this.planRunning = false;
        this.plannedSlots = {};
        this.settings = null;
        this.settingsError = null;
        this.settingsWork = null;
        this._settingsBaseline = '';
        this.settingsProblems = null;
        this.settingsSaveError = null;
        this.workers = [];
        this.workersLoaded = false;
        this.workersError = null;
        this.newWorker = null;
        this.clearEditor();
    },

    clearEditor() {
        this.draftId = '';
        this.draft = null;
        this.draftLessons = [];
        this.draftError = null;
        this.work = null;
        this._baseline = '';
        this.problems = null;
        this.saveError = null;
        this.saving = false;
        this.slots = null;
        this.slotsError = null;
        this.lessonDetails = {};
        this.selectedSlide = 0;
        this.restored = null;
        this.clearUndo();
        this.stopRenderTicker();
        this.unbindKeys();
    },

    skeleton() {
        return html`
            <div class="surface pad-4 skel-stack" aria-hidden="true">
                <span>${Motion.line('md')}</span>
                <span>${Motion.line('lg')}</span>
            </div>
            ${Motion.cardGrid(3, 3)}
            ${Motion.busy()}
        `;
    },

    /** A query value of `#/studio?…`, or ''. */
    hashValue(name) {
        if (typeof App === 'undefined' || typeof App.hashParam !== 'function') return '';
        return String(App.hashParam(name) || '');
    },

    /** The draft id in `#/studio?draft=…`, or '' off the editor. */
    hashDraftId() {
        return this.hashValue('draft');
    },

    alive(seq) {
        return seq === this._seq && !!document.getElementById('page-container');
    },

    /**
     * Three views: the editor (`?draft=`), Settings (`?tab=settings`) and home.
     * The tab is the hash, not page state, so Settings is a link like any other.
     */
    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        // A second render (Retry, a tenant switch) must not leave the first one's timers running.
        this.stopStatusTimer();
        this.stopPoll();
        this.stopRenderTicker();
        this.unbindKeys();
        const seq = ++this._seq;
        const id = this.hashDraftId();
        if (id) {
            this.newWorker = null;
            await this.renderEditorPage(container, seq, id);
        } else if (this.hashValue('tab') === 'settings') {
            this.clearEditor();
            await this.renderSettingsPage(container, seq);
        } else {
            this.clearEditor();
            this.newWorker = null;
            await this.renderHome(container, seq);
        }
    },

    /** Carousels | Settings — navigation between two views, so links with aria-current. */
    tabsMarkup(active) {
        // Quiet segments, not blue buttons: the page's one primary is the step's own.
        const tab = (key, href, icon, label) => html`
            <a class="btn btn-sm btn-ghost" href="${href}"
               ${active === key ? html.raw('aria-current="page"') : ''}>
                <i data-lucide="${icon}" aria-hidden="true"></i> ${label}
            </a>
        `;
        return html`
            <nav class="segmented studio-seg studio-tabs" aria-label="${t('studio.tabs.label')}">
                ${tab('home', '#/studio', 'layers', t('studio.tabs.carousels'))}
                ${tab('settings', '#/studio?tab=settings', 'settings', t('studio.tabs.settings'))}
            </nav>
        `;
    },

    /** Settle one of the three home fetches onto state. */
    applyStatus(result) {
        if (result.status === 'fulfilled') {
            this.status = result.value || null;
            this.statusError = null;
        } else {
            this.statusError = result.reason;
        }
    },

    applyLessons(result) {
        if (result.status === 'fulfilled') {
            const list = result.value && Array.isArray(result.value.lessons) ? result.value.lessons : [];
            this.lessons = list;
            this.lessonsLoaded = true;
            this.lessonsError = null;
            // A lesson that disappeared (or stopped being indexed) cannot stay picked.
            this.selected = this.selected.filter((id) => this.isPickable(this.lessonById(id)));
        } else {
            this.lessonsError = result.reason;
        }
    },

    applyDrafts(result) {
        if (result.status === 'fulfilled') {
            this.drafts = result.value && Array.isArray(result.value.drafts) ? result.value.drafts : [];
            this.draftsError = null;
        } else {
            this.draftsError = result.reason;
        }
    },

    /**
     * Settings decide things on every view — whether a library folder is set,
     * which palette an accent comes from, which CTA lines a caption must carry —
     * so they are read everywhere. A failure is not fatal: each use has a
     * fallback that defers to the server, which checks the same things.
     */
    applySettings(result) {
        if (result.status === 'fulfilled') {
            this.settings = (result.value && result.value.settings) || null;
            this.settingsError = null;
        } else {
            this.settingsError = result.reason;
        }
    },

    /** The library folder the worker scans, or null when the tenant has not set one. */
    libraryRoot() {
        const lib = this.settings && this.settings.library;
        const root = lib && typeof lib.root === 'string' ? lib.root.trim() : '';
        return root || null;
    },

    async renderHome(container, seq) {
        const gate = Motion.beginLoad(container, () => this.skeleton());
        const [status, lessons, drafts, settings] = await Promise.allSettled([
            API.getStudioStatus(),
            API.getStudioLessons(),
            API.getStudioDrafts(),
            API.getStudioSettings(),
        ]);
        if (!this.alive(seq)) return;
        gate.done();
        this.applyStatus(status);
        this.applyLessons(lessons);
        this.applyDrafts(drafts);
        this.applySettings(settings);
        this.paintHome();
        this.startStatusTimer(seq);
        // A carousel being written when the operator left is still being written.
        if (this.generating) this.startGenTicker();
        Motion.announce(`${t('nav.studio')} — ${t('studio.drafts.count', { count: this.drafts.length })}`);
    },

    // ─── Timers ──────────────────────────────────────────────────────────────
    startStatusTimer(seq) {
        this.stopStatusTimer();
        this._statusTimer = setInterval(() => {
            if (seq !== this._seq) { this.stopStatusTimer(); return; }
            // A hidden tab asks nothing; the next visible tick catches up.
            if (document.visibilityState === 'hidden') return;
            this.refreshStatus(seq);
        }, this.STATUS_REFRESH_MS);
    },

    stopStatusTimer() {
        if (this._statusTimer) clearInterval(this._statusTimer);
        this._statusTimer = null;
    },

    stopPoll() {
        if (this._pollTimer) clearTimeout(this._pollTimer);
        this._pollTimer = null;
    },

    stopGenTicker() {
        if (this._genTimer) clearInterval(this._genTimer);
        this._genTimer = null;
    },

    stopRenderTicker() {
        if (this._renderTimer) clearInterval(this._renderTimer);
        this._renderTimer = null;
    },

    // ─── Keyboard ────────────────────────────────────────────────────────────
    /**
     * One document listener per view, removed with the view. Cmd/Ctrl+S saves the
     * editor or the settings; arrow keys move through slides when the preview or
     * the slide rail has focus. Nothing here fires while a modal is open.
     */
    bindKeys(view) {
        this.unbindKeys();
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
        this._onKeydown = (event) => StudioPage.onKeydown(event, view);
        document.addEventListener('keydown', this._onKeydown);
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            this._onBeforeUnload = (event) => {
                const dirty = view === 'settings' ? StudioPage.settingsDirty() : StudioPage.isDirty();
                if (!dirty) return;
                event.preventDefault();
                event.returnValue = '';
            };
            window.addEventListener('beforeunload', this._onBeforeUnload);
        }
    },

    unbindKeys() {
        if (this._onKeydown && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('keydown', this._onKeydown);
        }
        if (this._onBeforeUnload && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('beforeunload', this._onBeforeUnload);
        }
        this._onKeydown = null;
        this._onBeforeUnload = null;
    },

    modalOpen() {
        const overlay = document.getElementById('modal-overlay');
        return !!overlay && !overlay.classList.contains('hidden');
    },

    /** The document is right-to-left: "next" is then to the left, for arrows and for swipes. */
    isRtl() {
        const root = document.documentElement;
        return !!root && String(root.dir || (root.getAttribute && root.getAttribute('dir')) || '').toLowerCase() === 'rtl';
    },

    onKeydown(event, view) {
        if (!event || this.modalOpen()) return;
        const key = String(event.key || '');
        if ((event.metaKey || event.ctrlKey) && !event.altKey && key.toLowerCase() === 's') {
            // The browser's "Save page" is never what the operator means here.
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (view === 'settings') {
                const form = document.getElementById('studio-settings-form');
                if (form && this.settingsDirty()) studioReport(this.saveSettings(form, null));
            } else if (view === 'editor' && this.isDirty()) {
                studioReport(this.save(null));
            }
            return;
        }
        if (view !== 'editor') return;
        const target = event.target && typeof event.target.closest === 'function' ? event.target : null;
        const inStage = target && target.closest('.phone-stage');
        const inRail = target && target.closest('.slide-rail');
        if (!inStage && !inRail) return;
        // The preview is a focusable group, not a button: Enter and Space open its form here.
        if (inStage && (key === 'Enter' || key === ' ')) {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            this.editSlide(inStage);
            return;
        }
        const forward = this.isRtl() ? 'ArrowLeft' : 'ArrowRight';
        const back = this.isRtl() ? 'ArrowRight' : 'ArrowLeft';
        let to = null;
        if (key === forward) to = this.selectedSlide + 1;
        else if (key === back) to = this.selectedSlide - 1;
        else if (key === 'Home') to = 0;
        else if (key === 'End') to = this.slideCount() - 1;
        if (to === null) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        this.selectSlide(to, { focus: inRail ? 'tab' : 'stage' });
    },

    /**
     * Re-read the status and repaint the bar. On the home view a draft still
     * being written or rendered is refreshed on the same tick, so its card turns
     * ready without a reload.
     */
    async refreshStatus(seq = this._seq) {
        if (this._statusInFlight) return;
        this._statusInFlight = true;
        const home = !this.draftId;
        const busyDraft = home && this.drafts.some((d) => this.isBusyStatus(d && d.status));
        const before = this.libraryCounts();
        try {
            const [status, drafts] = await Promise.allSettled([
                API.getStudioStatus(),
                busyDraft ? API.getStudioDrafts() : Promise.resolve(null),
            ]);
            if (seq !== this._seq) return;
            this.applyStatus(status);
            if (this._statusBusy === 0) this.paintStatus();
            if (busyDraft && drafts.status === 'fulfilled' && drafts.value) {
                this.applyDrafts(drafts);
                this.paintDrafts();
            }
            // A scan or an index finished on the Mac: the picker (and the setup list)
            // show the new lessons without a reload.
            const after = this.libraryCounts();
            if (home && this.lessonsLoaded && after !== before && document.getElementById('studio-source-body')) {
                await this.reloadLessons();
            }
            if (!home && this.draft && this.isBusyStatus(this.draft.status)) this.paintRenderState();
        } finally {
            this._statusInFlight = false;
        }
    },

    /** "34/34/0" — what changes when the worker scans or indexes. */
    libraryCounts() {
        const l = (this.status && this.status.lessons) || {};
        return `${Number(l.total) || 0}/${Number(l.indexed) || 0}/${Number(l.indexing) || 0}`;
    },

    /** Retry on the offline notice: re-read the status now and say what came back. */
    async retryWorker(el) {
        const restore = UI.actionBusy(el, t('studio.worker.checking'));
        if (!restore) return;
        this._statusBusy++;
        try {
            await this.refreshStatus(this._seq);
        } finally {
            this._statusBusy = Math.max(0, this._statusBusy - 1);
            restore();
        }
        this.paintStatus();
        const online = this.workerOnline();
        const message = online ? t('studio.worker.backOnline') : t('studio.worker.stillOffline');
        Motion.announce(message);
        UI.toast(message, online ? 'success' : 'error');
    },

    // ─── Small readings of the data ──────────────────────────────────────────
    lessonById(id) {
        const key = String(id);
        return this.lessons.find((l) => l && String(l.id) === key)
            || this.draftLessons.find((l) => l && String(l.id) === key)
            || null;
    },

    /** Only an indexed lesson has the notes and moments a carousel is grounded in. */
    isPickable(lesson) {
        return !!(lesson && lesson.status === 'indexed');
    },

    isBusyStatus(status) {
        return status === 'generating' || status === 'rendering';
    },

    /** Seconds as m:ss, for a moment's place in its video. */
    clock(sec) {
        const total = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    },

    /** "Friday 4 March · 13:00" — a publishing slot, in the operator's own time zone. */
    slotLabel(iso) {
        return `${UI.formatWeekday(iso)} · ${UI.formatTime(iso)}`;
    },

    /** A lesson's number and title, as the chips and lists show it. */
    lessonName(lesson) {
        if (!lesson) return '';
        return `${lesson.lesson_no || ''} · ${lesson.title || ''}`;
    },

    /**
     * An empty host that `wireErrors` fills with `UI.renderError`, so the Retry
     * button gets a real listener rather than an inline handler.
     */
    errorHost(error, title, retry) {
        const options = JSON.stringify({
            title,
            message: (error && error.message) || t('error.unexpected'),
            hint: error && error.status ? `HTTP ${error.status}` : '',
        });
        return html`<div data-error-host data-error-retry="${retry}" data-error-options="${options}"></div>`;
    },

    wireErrors(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        root.querySelectorAll('[data-error-host]').forEach((host) => {
            const retry = host.dataset.errorRetry;
            let options = {};
            try { options = JSON.parse(host.dataset.errorOptions || '{}'); } catch { /* the defaults */ }
            UI.renderError(host, options, () => {
                if (retry === 'drafts') StudioPage.reloadDrafts();
                else if (retry === 'lessons') StudioPage.reloadLessons();
                else StudioPage.render();
            });
        });
    },

    /** Repaint one region by id, keeping the operator's focus where it was. */
    paintRegion(id, markup) {
        const host = document.getElementById(id);
        if (!host) return null;
        const focus = UI.captureFocus(host);
        host.innerHTML = esc(markup);
        UI.icons(host);
        this.wireErrors(host);
        this.applySwatches(host);
        UI.restoreFocus(focus);
        return host;
    },

    // ─── Status bar ──────────────────────────────────────────────────────────
    statusSection() {
        return html`
            <section class="studio-status surface" id="studio-status" aria-label="${t('studio.status.label')}">
                ${this.statusMarkup()}
            </section>
        `;
    },

    paintStatus() {
        this.paintRegion('studio-status', this.statusMarkup());
    },

    statusMarkup() {
        const s = this.status;
        if (!s) {
            if (!this.statusError) return html`<p class="text-meta">${t('common.loading')}</p>`;
            return html`
                <div class="studio-status-failed" role="alert">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    <span dir="auto">${t('studio.status.failed', { message: this.statusError.message || t('error.unexpected') })}</span>
                    ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'studio:refreshStatus' })}
                </div>
            `;
        }
        // The TikTok item earns its space only when there is something to say:
        // carousels waiting for the batch, or the audit that retired the batch.
        const tiktok = s.tiktok || {};
        const showTikTok = tiktok.audited === true || (Number(tiktok.queued) || 0) > 0;
        return html`
            <div class="studio-status-grid">
                ${this.workerMarkup(s.worker || {}, s.jobs || {})}
                ${this.libraryMarkup(s.lessons || {})}
                ${showTikTok ? this.tiktokQueueMarkup(tiktok) : ''}
            </div>
            ${this.statusError ? html`
                <p class="form-hint text-warning" role="status">${t('studio.status.stale')}</p>
            ` : ''}
        `;
    },

    workerMarkup(worker, jobs) {
        const online = worker.online === true;
        const seen = worker.lastSeen ? UI.relativeAge(worker.lastSeen) : null;
        const pending = Number(jobs.pending) || 0;
        const claimed = Number(jobs.claimed) || 0;
        return html`
            <div class="studio-status-item${online ? '' : html.raw(' is-wide')}">
                <p class="studio-status-head">
                    <span class="health-pill ${online ? html.raw('health-fresh') : html.raw('health-off')}" id="studio-worker-pill">
                        <span class="health-dot" aria-hidden="true"></span>
                        ${online ? t('studio.worker.online') : t('studio.worker.offline')}
                    </span>
                    ${UI.helpLink('worker', t('help.link.worker'), { iconOnly: true, className: 'studio-worker-help' })}
                    ${worker.name ? html`<span class="text-meta" dir="auto">${worker.name}</span>` : ''}
                    <span class="text-meta" title="${seen ? seen.title : ''}">
                        ${seen ? t('studio.worker.lastSeen', { when: seen.text }) : t('studio.worker.neverSeen')}
                    </span>
                </p>
                ${pending || claimed ? html`
                    <p class="text-meta">
                        ${t('studio.jobs.summary', { pending: UI.formatNumber(pending), claimed: UI.formatNumber(claimed) })}
                        ${!online && pending ? html`<span class="text-warning"> · ${t('studio.jobs.waitingForMac')}</span>` : ''}
                    </p>
                ` : ''}
                ${online ? '' : this.workerHelpMarkup(worker)}
            </div>
        `;
    },

    /**
     * Offline is a state with a way out, so it says what the worker IS, how to
     * start it, and offers a real re-check. Writing still works without it: only
     * indexing and drawing the slides wait, and the copy says so.
     */
    workerHelpMarkup(worker) {
        const never = !worker.lastSeen;
        return html`
            <div class="studio-callout is-warning" id="studio-worker-hint">
                <i data-lucide="laptop" aria-hidden="true"></i>
                <div class="studio-callout-body">
                    <p class="studio-callout-title">${never ? t('studio.worker.neverTitle') : t('studio.worker.offlineTitle')}</p>
                    <p>${t('studio.worker.what')}</p>
                    <p>${t('studio.worker.startHint')}</p>
                    <details class="studio-howto">
                        <summary>${t('studio.worker.howTo')}</summary>
                        <ol>
                            <li>${t('studio.worker.howTo1')}</li>
                            <li>${t('studio.worker.howTo2')}</li>
                            <li>${t('studio.worker.howTo3')}</li>
                        </ol>
                    </details>
                    <div class="row row--wrap gap-2">
                        ${UI.button({
                            variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('studio.worker.retry'),
                            action: 'studio:retryWorker', id: 'studio-worker-retry',
                        })}
                        <a class="btn btn-ghost btn-sm" href="#/studio?tab=settings&amp;focus=workers">${t('studio.worker.manage')}</a>
                        ${UI.helpLink('worker#install', t('help.link.workerInstall'))}
                    </div>
                </div>
            </div>
        `;
    },

    /** A native progress bar: announced as "12 of 34", and it fills from the reading start. */
    meterMarkup(value, max, label, id) {
        const n = Math.max(0, Number(value) || 0);
        const m = Math.max(1, Number(max) || 0);
        return html`<progress class="studio-meter"${id ? html` id="${id}"` : ''} value="${Math.min(n, m)}" max="${m}"
                              aria-label="${label}" aria-valuetext="${t('studio.countSr', { n: UI.formatNumber(n), max: UI.formatNumber(m) })}"></progress>`;
    },

    libraryMarkup(lessons) {
        const total = Number(lessons.total) || 0;
        const indexed = Number(lessons.indexed) || 0;
        const indexing = Number(lessons.indexing) || 0;
        const failed = Number(lessons.failed) || 0;
        const missing = Math.max(0, total - indexed - indexing);
        // Only a settings answer that SAYS there is no folder turns Scan off; a failed
        // read leaves it on, and the server's "set your library folder first" says why.
        const noFolder = !!this.settings && !this.libraryRoot();
        return html`
            <div class="studio-status-item">
                <p class="studio-status-head">
                    <strong class="studio-status-count">${UI.ltr(`${UI.formatNumber(indexed)}/${UI.formatNumber(total)}`)}</strong>
                    <span>${t('studio.library.indexedLabel')}</span>
                    ${UI.helpLink('library', t('help.link.library'), { iconOnly: true, className: 'studio-library-help' })}
                </p>
                ${total && indexed < total ? this.meterMarkup(indexed, total, t('studio.library.meterLabel'), 'studio-library-meter') : ''}
                ${indexing || failed ? html`
                    <p class="text-meta">
                        ${indexing ? t('studio.library.indexing', { n: UI.formatNumber(indexing) }) : ''}
                        ${indexing && failed ? ' · ' : ''}
                        ${failed ? html`<span class="text-danger">${t('studio.library.failed', { n: UI.formatNumber(failed) })}</span>` : ''}
                    </p>
                ` : ''}
                ${noFolder ? html`
                    <p class="studio-hint" id="studio-no-folder">
                        <i data-lucide="folder-x" aria-hidden="true"></i>
                        <span>${t('studio.library.noFolder')}
                            <a href="#/studio?tab=settings">${t('studio.library.setFolder')}</a></span>
                    </p>
                ` : ''}
                <div class="row row--wrap gap-2">
                    ${UI.button({
                        variant: 'secondary', size: 'sm', icon: 'folder-search', label: t('studio.library.scan'),
                        action: 'studio:scanLibrary', id: 'studio-scan', disabled: noFolder,
                        title: noFolder ? t('studio.library.noFolder') : '',
                    })}
                    ${UI.button({
                        variant: 'secondary', size: 'sm', icon: 'scan-text', label: t('studio.library.indexMissing'),
                        action: 'studio:indexMissing', id: 'studio-index-missing',
                        disabled: total > 0 && missing === 0,
                        title: total > 0 && missing === 0 ? t('studio.library.allIndexed') : '',
                    })}
                </div>
            </div>
        `;
    },

    tiktokQueueMarkup(tiktok) {
        const queued = Number(tiktok.queued) || 0;
        const audited = tiktok.audited === true;
        return html`
            <div class="studio-status-item">
                <p class="studio-status-head">
                    <i data-lucide="music-2" aria-hidden="true"></i>
                    <span>${t('studio.tiktok.queued')}</span>
                    <strong class="studio-status-count" id="studio-tiktok-queued">${UI.num(queued)}</strong>
                </p>
                ${audited ? html`
                    <p class="text-meta">${t('studio.tiktok.auditedNote')}</p>
                ` : html`
                    <p class="text-meta">${t('studio.tiktok.queueNote')}</p>
                    <div class="row row--wrap gap-2">
                        ${UI.button({
                            // Secondary: the page's one primary button is the step's (Generate).
                            variant: 'secondary', size: 'sm', icon: 'send', label: t('studio.tiktok.batch'),
                            action: 'studio:confirmTikTokBatch', id: 'studio-tiktok-batch',
                            disabled: queued === 0,
                            title: queued === 0 ? t('studio.tiktok.batchEmpty') : '',
                        })}
                    </div>
                `}
            </div>
        `;
    },

    /** Run a status-bar action with its button held, then re-read the status. */
    async statusAction(el, run) {
        const restore = UI.actionBusy(el);
        if (!restore) return;
        this._statusBusy++;
        try {
            await run();
        } catch (err) {
            UI.toast((err && err.message) || t('common.error'), 'error');
        } finally {
            this._statusBusy = Math.max(0, this._statusBusy - 1);
            restore();
        }
        await this.refreshStatus();
    },

    scanLibrary(el) {
        return this.statusAction(el, async () => {
            await API.scanStudioLibrary();
            const online = !!(this.status && this.status.worker && this.status.worker.online);
            UI.toast(online ? t('studio.library.scanQueued') : t('studio.library.scanQueuedOffline'));
        });
    },

    indexMissing(el) {
        return this.statusAction(el, async () => {
            const res = await API.indexMissingStudioLessons();
            const count = Number(res && res.count) || 0;
            UI.toast(count ? t('studio.library.indexQueued', { n: UI.formatNumber(count) }) : t('studio.library.nothingToIndex'));
            if (count && !this.draftId) await this.reloadLessons();
        });
    },

    /**
     * Ask first, and say the one thing that is easy to get wrong: until TikTok
     * approves the app every post goes up as "Only me", and TikTok refuses them
     * unless the ACCOUNT itself is private while they post.
     */
    confirmTikTokBatch() {
        const queued = Number(this.status && this.status.tiktok && this.status.tiktok.queued) || 0;
        Admin.confirm({
            title: t('studio.tiktok.batchTitle'),
            body: t('studio.tiktok.batchBody', { n: UI.formatNumber(queued) }),
            hint: t('studio.tiktok.batchPrivate'),
            confirmLabel: t('studio.tiktok.batchConfirm'),
            confirmIcon: 'send',
            tone: 'primary',
            onConfirm: () => StudioPage.runTikTokBatch(),
        });
    },

    /** Returns the promise, so the confirm dialog stays up (and busy) until it lands. */
    async runTikTokBatch() {
        const res = await API.postStudioTikTokBatch();
        const queued = Number(res && res.queued) || 0;
        const message = queued ? t('studio.tiktok.batchDone', { n: UI.formatNumber(queued) }) : t('studio.tiktok.batchNone');
        UI.toast(message);
        Motion.announce(message);
        this.refreshStatus();
        if (this.draftId) this.reloadDraft();
        else this.reloadDrafts();
    },

    // ─── Home view ───────────────────────────────────────────────────────────
    paintHome() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const focus = UI.captureFocus(container);
        container.innerHTML = esc(html`
            <div class="page-toolbar studio-toolbar">
                ${this.tabsMarkup('home')}
                <div id="studio-stepper">${this.stepperMarkup(this.generating ? 2 : 1)}</div>
            </div>
            ${this.statusSection()}
            <section class="surface pad-5 studio-new" id="studio-new" aria-labelledby="studio-new-title">
                ${this.newCardMarkup()}
            </section>
            <div id="studio-plan">${this.planMarkup()}</div>
            <section class="studio-drafts" aria-labelledby="studio-drafts-title">
                <div class="studio-section-head">
                    <h2 class="section-title" id="studio-drafts-title">${t('studio.drafts.title')}</h2>
                </div>
                <div id="studio-drafts">${this.draftsMarkup()}</div>
            </section>
        `);
        UI.icons(container);
        this.wireErrors(container);
        this.applySwatches(container);
        UI.restoreFocus(focus);
    },

    /** The step-1 form, or — while a carousel is being written — the step-2 progress card. */
    newCardMarkup() {
        return this.generating ? this.genProgressMarkup() : this.newFormMarkup();
    },

    paintNewCard() {
        // "More options" stays as the operator left it: a repaint is not a reason to fold it up.
        const more = document.getElementById('studio-more');
        const open = !!(more && more.open);
        this.paintRegion('studio-new', this.newCardMarkup());
        const again = document.getElementById('studio-more');
        if (again && open) again.open = true;
        this.paintStepper(this.generating ? 2 : 1);
    },

    /** Colour dots carry their hex in `data-color`; it is set as a style here, checked, never interpolated. */
    applySwatches(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return;
        root.querySelectorAll('[data-color], [data-bg]').forEach((el) => {
            const hex = String(el.dataset.color || el.dataset.bg || '');
            if (this.ACCENT_RE.test(hex) && el.style) el.style.backgroundColor = hex;
        });
        root.querySelectorAll('[data-fg]').forEach((el) => {
            const hex = String(el.dataset.fg || '');
            if (this.ACCENT_RE.test(hex) && el.style) el.style.color = hex;
        });
    },

    /** "2/3", isolated so it reads left to right inside Arabic, with a spoken form. */
    countMarkup(n, max) {
        return html`<span aria-hidden="true">${UI.ltr(`${n}/${max}`)}</span><span class="sr-only">${t('studio.countSr', { n, max })}</span>`;
    },

    angleLabel(angle) {
        return this.ANGLES.includes(angle) ? t(`studio.angle.${angle}`) : String(angle || '');
    },

    /** The first colour of the tenant's palette, for the picker to open on. */
    paletteStart() {
        const palette = this.settings && this.settings.brand && Array.isArray(this.settings.brand.palette)
            ? this.settings.brand.palette : [];
        const first = palette.find((c) => this.ACCENT_RE.test(String(c || '')));
        return first ? String(first).toLowerCase() : '#888888';
    },

    /**
     * Where the next carousel comes from: what the operator chose (this visit, or
     * last time in this browser), else a lesson. Lessons first even while none can
     * be picked: that is where the setup checklist lives, and the way out to
     * "From an idea" is one button on it.
     */
    sourceMode() {
        if (this.mode === 'lesson' || this.mode === 'idea') return this.mode;
        if (this.selected.length) return 'lesson';
        return this.prefs().mode || 'lesson';
    },

    /** The tenant's accent palette, valid entries only. */
    palette() {
        const list = this.settings && this.settings.brand && Array.isArray(this.settings.brand.palette) ? this.settings.brand.palette : [];
        return list.map((c) => String(c || '').toUpperCase()).filter((c) => this.ACCENT_RE.test(c));
    },

    /** A segmented control's segment: a toggle button, one of which is pressed. */
    segButton(o) {
        const on = !!o.pressed;
        return html`
            <button type="button" class="btn btn-sm btn-ghost" id="${o.id}" aria-pressed="${on ? 'true' : 'false'}"
                    data-action="${o.action}" ${o.data ? html.raw(o.data) : ''}>
                <i data-lucide="${o.icon}" aria-hidden="true"></i> ${o.label}
            </button>
        `;
    },

    newFormMarkup() {
        const mode = this.sourceMode();
        const prefs = this.prefs();
        const blocked = mode === 'lesson' && !this.lessons.some((l) => this.isPickable(l));
        return html`
            <form id="studio-new-form" class="studio-new-form" data-submit="studio:generate" novalidate>
                <div class="studio-section-head studio-new-head">
                    <div class="studio-new-heading">
                        <h2 class="section-title" id="studio-new-title">${t('studio.new.title')}</h2>
                        <p class="form-hint studio-lede">${t('studio.new.lede')}</p>
                    </div>
                    ${this.planLaunchMarkup()}
                </div>
                <div class="segmented studio-seg studio-source" role="group" aria-label="${t('studio.new.source')}">
                    ${this.segButton({ id: 'studio-mode-lesson', action: 'studio:setMode', data: 'data-mode="lesson"', icon: 'book-open', label: t('studio.new.fromLesson'), pressed: mode === 'lesson' })}
                    ${this.segButton({ id: 'studio-mode-idea', action: 'studio:setMode', data: 'data-mode="idea"', icon: 'lightbulb', label: t('studio.new.fromIdea'), pressed: mode === 'idea' })}
                </div>
                <div id="studio-source-body" class="studio-source-body">${mode === 'lesson' ? this.lessonSourceMarkup() : this.ideaSourceMarkup()}</div>
                ${this.moreOptionsMarkup(mode, prefs)}
                <div id="studio-new-error">${this.newErrorMarkup()}</div>
                <div class="studio-new-actions">
                    ${UI.button({
                        variant: 'primary', type: 'submit', icon: 'sparkles', label: t('studio.new.generate'),
                        id: 'studio-generate', className: 'studio-generate', disabled: blocked,
                    })}
                    <p class="form-hint" id="studio-generate-hint">${blocked ? t('studio.new.blockedHint') : t('studio.new.generateHint')}</p>
                </div>
            </form>
        `;
    },

    planLaunchMarkup() {
        return html`
            <div class="studio-plan-launch">
                <label class="sr-only" for="studio-plan-count">${t('studio.plan.count')}</label>
                <select class="select studio-plan-count" id="studio-plan-count" title="${t('studio.plan.count')}">
                    ${this.PLAN_COUNTS.map((n) => html`<option value="${n}" ${n === this.PLAN_DEFAULT ? html.raw('selected') : ''}>${t('studio.plan.countOption', { n: UI.formatNumber(n) })}</option>`)}
                </select>
                ${UI.button({
                    variant: 'ghost', icon: 'calendar-range', label: t('studio.plan.button'),
                    action: 'studio:planWeek', id: 'studio-plan-btn',
                })}
            </div>
        `;
    },

    ideaSourceMarkup() {
        return html`
            <div class="form-group">
                <label class="form-label" for="studio-idea">${t('studio.new.ideaLabel')}</label>
                <textarea class="field-textarea user-content" id="studio-idea" name="idea" dir="auto" lang="${this.contentLang()}" rows="4"
                          placeholder="${t('studio.new.ideaPlaceholder')}" aria-describedby="studio-idea-hint"
                          data-input="studio:newText" data-key="idea">${this.newText.idea}</textarea>
                <p class="form-hint" id="studio-idea-hint">${t('studio.new.ideaOnlyHint')}</p>
            </div>
        `;
    },

    lessonSourceMarkup() {
        const setup = this.setupMarkup();
        if (setup) return setup;
        const total = this.lessons.length;
        return html`
            <div class="field-head">
                <span class="form-label" id="studio-lessons-label">
                    ${t('studio.new.lessons')}
                    <span class="label-optional">${t('studio.new.lessonsHint', { max: this.MAX_LESSONS })}</span>
                </span>
                <span class="field-count" id="studio-lessons-count">${this.countMarkup(this.selected.length, this.MAX_LESSONS)}</span>
            </div>
            <div id="studio-picked" class="studio-picked">${this.pickedMarkup()}</div>
            ${this.indexNoteMarkup()}
            <div class="studio-lesson-search">
                <i data-lucide="search" aria-hidden="true"></i>
                <label class="sr-only" for="studio-lesson-q">${t('studio.lessons.search')}</label>
                <input class="field" type="search" id="studio-lesson-q" value="${this.lessonQuery}" autocomplete="off" spellcheck="false"
                       placeholder="${t('studio.lessons.searchPlaceholder', { n: UI.formatNumber(total) })}"
                       data-input="studio:lessonSearch" aria-controls="studio-lessons">
            </div>
            <div id="studio-lessons" class="studio-lessons" role="group" aria-labelledby="studio-lessons-label">
                ${this.lessonPickerMarkup()}
            </div>
        `;
    },

    /** The picked lessons, each a button that un-picks it, and what the first one covers. */
    pickedMarkup() {
        const picked = this.selected.map((id) => this.lessonById(id)).filter(Boolean);
        // Nothing picked: the label ("up to 3") and the count already say it; the hint is for a screen reader.
        if (!picked.length) return html`<p class="sr-only">${t('studio.lessons.pickHint')}</p>`;
        const summary = picked[0].summary;
        return html`
            <ul class="studio-picked-list">
                ${picked.map((l) => html`
                    <li>
                        <button type="button" class="picked-chip" data-action="studio:toggleLesson" data-id="${l.id}"
                                data-focus-key="picked-${l.id}" aria-label="${t('studio.lessons.unpick', { name: this.lessonName(l) })}">
                            <bdi class="lesson-chip-no" dir="ltr">${l.lesson_no || ''}</bdi>
                            <span class="lesson-chip-title" dir="auto">${l.title || ''}</span>
                            <i data-lucide="x" aria-hidden="true"></i>
                        </button>
                    </li>
                `)}
            </ul>
            ${summary ? html`<p class="studio-picked-summary user-content" dir="auto">${summary}</p>` : ''}
        `;
    },

    /** Counts from the lesson list itself, so the note agrees with the chips beside it. */
    lessonCounts() {
        const total = this.lessons.length;
        const by = (st) => this.lessons.filter((l) => l && l.status === st).length;
        const indexed = by('indexed');
        const indexing = by('indexing');
        return { total, indexed, indexing, missing: Math.max(0, total - indexed - indexing) };
    },

    /** Part of the library is indexed: say how much, show it, and offer the rest. */
    indexNoteMarkup() {
        const c = this.lessonCounts();
        if (!c.total || c.indexed >= c.total) return '';
        return html`
            <div class="studio-index-note" id="studio-index-note">
                <p class="studio-index-note-text">
                    <span>${t('studio.lessons.indexedOf')}</span>
                    ${UI.ltr(`${UI.formatNumber(c.indexed)}/${UI.formatNumber(c.total)}`)}
                    ${c.indexing ? html`<span class="text-meta">· ${t('studio.lessons.indexingNow', { n: UI.formatNumber(c.indexing) })}</span>` : ''}
                </p>
                ${this.meterMarkup(c.indexed, c.total, t('studio.library.meterLabel'), 'studio-index-meter')}
                ${c.missing ? UI.button({
                    variant: 'ghost', size: 'sm', icon: 'scan-text', label: t('studio.lessons.indexRest', { n: UI.formatNumber(c.missing) }),
                    action: 'studio:indexMissing', id: 'studio-index-rest',
                }) : ''}
            </div>
        `;
    },

    /**
     * While not one lesson can be picked, the lesson path is blocked, and this
     * says exactly why: three steps that tick themselves off as the status
     * changes. Writing from an idea needs none of it, and the card says so.
     */
    setupMarkup() {
        if (this.lessons.some((l) => this.isPickable(l))) return '';
        if (this.lessonsError && !this.lessons.length) {
            return this.errorHost(this.lessonsError, t('studio.lessons.errorTitle'), 'lessons');
        }
        if (!this.lessonsLoaded) return html`<p class="studio-empty-note">${t('common.loading')}</p>`;
        const s = this.status || {};
        const worker = s.worker || {};
        const c = this.lessonCounts();
        const root = this.libraryRoot();
        const folderKnown = !!this.settings;
        const step = (n, done, title, body, action) => html`
            <li class="setup-step${done ? html.raw(' is-done') : ''}">
                <span class="setup-step-mark" aria-hidden="true">${done ? html`<i data-lucide="check" aria-hidden="true"></i>` : UI.formatNumber(n)}</span>
                <div class="setup-step-body">
                    <p class="setup-step-title">${title}<span class="sr-only"> (${done ? t('studio.setup.done') : t('studio.setup.todo')})</span></p>
                    ${body ? html`<div class="form-hint">${body}</div>` : ''}
                    ${action || ''}
                </div>
            </li>
        `;

        const folderDone = !!root;
        const folder = step(1, folderDone, t('studio.setup.folderTitle'),
            folderDone ? html`<code class="studio-path" dir="ltr">${root}</code>` : t('studio.setup.folderBody'),
            folderDone ? '' : html`<a class="btn btn-secondary btn-sm" href="#/studio?tab=settings&amp;focus=library">${t('studio.setup.folderAction')}</a>`);

        const seen = !!worker.lastSeen;
        let workerBody = t('studio.setup.workerBody');
        if (seen && worker.online) workerBody = t('studio.setup.workerOnline', { name: worker.name || '' });
        else if (seen) workerBody = t('studio.setup.workerOffline', { when: UI.relativeAge(worker.lastSeen).text });
        const workerStep = step(2, seen, t('studio.setup.workerTitle'), workerBody,
            seen ? '' : html`<a class="btn btn-secondary btn-sm" href="#/studio?tab=settings&amp;focus=workers">${t('studio.setup.workerAction')}</a>`);

        let libraryBody;
        let libraryAction = '';
        if (!c.total) {
            libraryBody = t('studio.setup.scanBody');
            const noFolder = folderKnown && !folderDone;
            libraryAction = UI.button({
                variant: 'secondary', size: 'sm', icon: 'folder-search', label: t('studio.library.scan'),
                action: 'studio:scanLibrary', id: 'studio-setup-scan', disabled: noFolder,
                title: noFolder ? t('studio.library.noFolder') : '',
            });
        } else if (c.indexing) {
            libraryBody = html`
                <span>${t('studio.setup.indexingBody', { n: UI.formatNumber(c.indexing) })}</span>
                ${this.meterMarkup(c.indexed, c.total, t('studio.library.meterLabel'), 'studio-setup-meter')}
            `;
        } else {
            libraryBody = t('studio.setup.indexBody', { n: UI.formatNumber(c.total) });
            libraryAction = UI.button({
                variant: 'secondary', size: 'sm', icon: 'scan-text', label: t('studio.setup.indexAction', { n: UI.formatNumber(c.missing) }),
                action: 'studio:indexMissing', id: 'studio-setup-index',
            });
        }
        const libraryStep = step(3, false, t('studio.setup.libraryTitle'), libraryBody, libraryAction);

        return html`
            <div class="studio-setup" id="studio-setup">
                <p class="studio-setup-title">${t('studio.setup.title')}</p>
                <p class="form-hint">${t('studio.setup.intro')}</p>
                <ol class="setup-steps">${folder}${workerStep}${libraryStep}</ol>
                <p class="studio-setup-alt">
                    <span>${t('studio.setup.orIdea')}</span>
                    ${UI.button({ variant: 'ghost', size: 'sm', icon: 'lightbulb', label: t('studio.new.fromIdea'), action: 'studio:setMode', data: { mode: 'idea' }, id: 'studio-setup-idea' })}
                </p>
            </div>
        `;
    },

    /** "AI picks the angle · 8 slides · accent from your palette": the closed state says what will be sent. */
    moreSummary() {
        const read = (id) => {
            const el = document.getElementById(id);
            return el && typeof el.value === 'string' ? el.value : null;
        };
        const prefs = this.prefs();
        const angle = read('studio-angle') || prefs.angle;
        const slides = Number(read('studio-slides')) || prefs.slides;
        const accent = (read('studio-accent') !== null ? read('studio-accent') : prefs.accent).trim();
        const keyword = (read('studio-keyword') !== null ? read('studio-keyword') : this.newText.keyword).trim();
        const parts = [
            angle === 'auto' ? t('studio.new.summaryAngleAuto') : this.angleLabel(angle),
            t('studio.new.summarySlides', { n: UI.formatNumber(slides) }),
            keyword ? t('studio.new.summaryKeyword', { keyword }) : t('studio.new.summaryKeywordAuto'),
            this.ACCENT_RE.test(accent) ? t('studio.new.summaryAccent', { hex: accent.toUpperCase() }) : t('studio.new.summaryAccentAuto'),
        ];
        return parts.join(' · ');
    },

    moreOptionsMarkup(mode, prefs) {
        const slideOptions = [];
        for (let n = this.SLIDES_MIN; n <= this.SLIDES_MAX; n++) slideOptions.push(n);
        const palette = this.palette();
        const accent = prefs.accent;
        const swatch = (hex, label) => {
            const on = (hex || '') === (accent || '');
            return html`
                <li>
                    <button type="button" class="swatch-btn${hex ? '' : html.raw(' swatch-btn--auto')}" data-action="studio:pickAccent" data-hex="${hex}"
                            aria-pressed="${on ? 'true' : 'false'}" aria-label="${label}" title="${label}">
                        ${hex ? html`<span class="swatch-dot" data-color="${hex}"></span>` : html`<i data-lucide="wand-sparkles" aria-hidden="true"></i>`}
                    </button>
                </li>
            `;
        };
        return html`
            <details class="studio-more" id="studio-more">
                <summary class="studio-more-toggle">
                    <span class="studio-more-label"><i data-lucide="sliders-horizontal" aria-hidden="true"></i> ${t('studio.new.more')}</span>
                    <span class="studio-more-summary" id="studio-more-summary">${this.moreSummaryFrom(prefs)}</span>
                </summary>
                <div class="studio-more-body">
                    ${mode === 'lesson' ? html`
                        <div class="form-group">
                            <label class="form-label" for="studio-idea">
                                ${t('studio.new.focus')} <span class="label-optional">${t('common.optional')}</span>
                            </label>
                            <textarea class="field-textarea user-content" id="studio-idea" name="idea" dir="auto" lang="${this.contentLang()}" rows="2"
                                      placeholder="${t('studio.new.focusPlaceholder')}" aria-describedby="studio-idea-hint"
                                      data-input="studio:newText" data-key="idea">${this.newText.idea}</textarea>
                            <p class="form-hint" id="studio-idea-hint">${t('studio.new.ideaHint')}</p>
                        </div>
                    ` : ''}
                    <div class="studio-new-grid">
                        <div class="form-group">
                            <label class="form-label" for="studio-angle">${t('studio.new.angle')}</label>
                            <select class="select" id="studio-angle" name="angle" data-change="studio:rememberOption" aria-describedby="studio-angle-hint">
                                ${this.ANGLES.map((a) => html`<option value="${a}" ${a === prefs.angle ? html.raw('selected') : ''}>${this.angleLabel(a)}</option>`)}
                            </select>
                            <p class="form-hint" id="studio-angle-hint">${t('studio.new.angleHint')}</p>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="studio-slides">${t('studio.new.slides')}</label>
                            <select class="select" id="studio-slides" name="slides" data-change="studio:rememberOption">
                                ${slideOptions.map((n) => html`<option value="${n}" ${n === prefs.slides ? html.raw('selected') : ''}>${UI.formatNumber(n)}</option>`)}
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="studio-keyword">
                                ${t('studio.new.keyword')} <span class="label-optional">${t('common.optional')}</span>
                            </label>
                            <input class="field" id="studio-keyword" name="keyword" dir="auto" lang="${this.contentLang()}" autocomplete="off"
                                   value="${this.newText.keyword}" data-input="studio:newText" data-key="keyword" aria-describedby="studio-keyword-hint">
                            <p class="form-hint" id="studio-keyword-hint">${t('studio.new.keywordHint')}</p>
                        </div>
                    </div>
                    <fieldset class="fieldset-plain form-group studio-accent-choice">
                        <legend class="form-label">${t('studio.new.accent')} <span class="label-optional">${t('common.optional')}</span></legend>
                        <ul class="swatch-row">
                            ${swatch('', t('studio.new.accentAuto'))}
                            ${palette.map((hex) => swatch(hex, t('studio.new.accentUse', { hex })))}
                        </ul>
                        <div class="field-row studio-accent-custom">
                            <label class="sr-only" for="studio-accent">${t('studio.new.accentCustom')}</label>
                            <input class="field field-mono" id="studio-accent" name="accent" dir="ltr" autocomplete="off"
                                   placeholder="#RRGGBB" maxlength="7" spellcheck="false" value="${accent}"
                                   data-input="studio:accentTyped" data-picker="studio-accent-picker"
                                   aria-describedby="studio-accent-hint">
                            <input type="color" class="studio-color" id="studio-accent-picker" value="${accent ? accent.toLowerCase() : this.paletteStart()}"
                                   data-input="studio:accentPicked" data-target="studio-accent"
                                   aria-label="${t('studio.new.accentPick')}" title="${t('studio.new.accentPick')}">
                        </div>
                        <p class="form-hint" id="studio-accent-hint">${t('studio.new.accentHint')}</p>
                    </fieldset>
                    <p class="form-hint">${t('studio.new.remembered')}</p>
                    <!-- A new tab: the form keeps what was typed, and so does this one. -->
                    <p>${UI.helpLink('create#options', t('help.link.options'), { newTab: true, className: 'studio-options-help' })}</p>
                </div>
            </details>
        `;
    },

    /** The summary line before the fields exist (first paint), from the remembered choices. */
    moreSummaryFrom(prefs) {
        const keyword = String(this.newText.keyword || '').trim();
        return [
            prefs.angle === 'auto' ? t('studio.new.summaryAngleAuto') : this.angleLabel(prefs.angle),
            t('studio.new.summarySlides', { n: UI.formatNumber(prefs.slides) }),
            keyword ? t('studio.new.summaryKeyword', { keyword }) : t('studio.new.summaryKeywordAuto'),
            prefs.accent ? t('studio.new.summaryAccent', { hex: prefs.accent }) : t('studio.new.summaryAccentAuto'),
        ].join(' · ');
    },

    refreshMoreSummary() {
        const el = document.getElementById('studio-more-summary');
        if (el) el.textContent = this.moreSummary();
    },

    // ─── Lesson picker ───────────────────────────────────────────────────────
    /** Sections in the order the server listed their first lesson; intro and extras last-seen as they come. */
    /** Every word of the search, in any order, against number, title and section; Arabic normalised. */
    lessonMatches(lesson, query) {
        const words = UI.normalizeArabic(query || '').split(' ').filter(Boolean);
        if (!words.length) return true;
        const hay = UI.normalizeArabic(`${lesson.lesson_no || ''} ${lesson.title || ''} ${lesson.section_title || ''}`);
        return words.every((word) => hay.includes(word));
    },

    lessonGroups() {
        const groups = [];
        const byKey = new Map();
        for (const lesson of this.lessons) {
            if (!lesson || !this.lessonMatches(lesson, this.lessonQuery)) continue;
            const hasSection = lesson.section_no !== null && lesson.section_no !== undefined;
            const key = hasSection ? `s:${lesson.section_no}` : `x:${lesson.section_title || ''}`;
            let group = byKey.get(key);
            if (!group) {
                let title = lesson.section_title || '';
                if (!title) title = hasSection ? t('studio.lessons.section', { n: lesson.section_no }) : t('studio.lessons.extras');
                group = { key, title, lessons: [] };
                byKey.set(key, group);
                groups.push(group);
            }
            group.lessons.push(lesson);
        }
        return groups;
    },

    lessonState(status) {
        switch (status) {
            case 'indexed': return { icon: 'plus', label: t('studio.lesson.indexed') };
            case 'indexing': return { icon: 'loader', label: t('studio.lesson.indexing') };
            case 'failed': return { icon: 'alert-circle', label: t('studio.lesson.failed') };
            default: return { icon: 'circle-dashed', label: t('studio.lesson.new') };
        }
    },

    lessonPickerMarkup() {
        if (this.lessonsError && !this.lessons.length) {
            return this.errorHost(this.lessonsError, t('studio.lessons.errorTitle'), 'lessons');
        }
        if (!this.lessons.length) {
            return html`<p class="studio-empty-note">${this.lessonsLoaded ? t('studio.lessons.empty') : t('common.loading')}</p>`;
        }
        const full = this.selected.length >= this.MAX_LESSONS;
        const groups = this.lessonGroups();
        if (!groups.length) {
            return html`
                <div class="studio-no-match">
                    <p class="studio-empty-note" dir="auto">${t('studio.lessons.noMatch', { query: this.lessonQuery })}</p>
                    ${UI.button({ variant: 'ghost', size: 'sm', icon: 'x', label: t('studio.lessons.clearSearch'), action: 'studio:clearLessonSearch' })}
                </div>
            `;
        }
        const someNotIndexed = this.lessons.some((l) => l && !this.isPickable(l));
        return html`
            ${groups.map((group) => html`
                <div class="lesson-group">
                    <h3 class="lesson-group-title" dir="auto">${group.title}</h3>
                    <ul class="lesson-chips">
                        ${group.lessons.map((lesson) => this.lessonChip(lesson, full))}
                    </ul>
                </div>
            `)}
            ${someNotIndexed ? html`<p class="form-hint">${t('studio.lessons.onlyIndexed')}</p>` : ''}
        `;
    },

    lessonChip(lesson, full) {
        const id = String(lesson.id);
        const picked = this.selected.includes(id);
        const pickable = this.isPickable(lesson);
        const blocked = !picked && (!pickable || full);
        const state = this.lessonState(lesson.status);
        const name = this.lessonName(lesson);
        let why = '';
        if (!pickable) why = state.label;
        else if (blocked) why = t('studio.lessons.full', { max: this.MAX_LESSONS });
        const about = t('studio.lessons.about', { name });
        return html`
            <li class="lesson-chip-item">
                <button type="button" class="lesson-chip${picked ? html.raw(' is-picked') : ''}${pickable ? '' : html.raw(' is-unindexed')}"
                        aria-pressed="${picked ? 'true' : 'false'}" data-action="studio:toggleLesson" data-id="${id}"
                        data-focus-key="lesson-${id}" title="${why}" ${blocked ? html.raw('disabled') : ''}>
                    <i data-lucide="${picked ? 'check' : state.icon}" aria-hidden="true"></i>
                    <bdi class="lesson-chip-no" dir="ltr">${lesson.lesson_no || ''}</bdi>
                    <span class="lesson-chip-title" dir="auto">${lesson.title || ''}</span>
                    ${pickable ? '' : html`<span class="sr-only">(${state.label})</span>`}
                </button>
                <button type="button" class="icon-btn lesson-chip-info" data-action="studio:showLesson" data-id="${id}"
                        data-focus-key="lesson-info-${id}" aria-label="${about}" title="${about}">
                    <i data-lucide="info" aria-hidden="true"></i>
                </button>
            </li>
        `;
    },

    paintLessons() {
        // From "nothing to pick" to a list (a scan or an index landed), or back: the
        // source changes shape, and so does whether Generate can run.
        const pickable = this.lessons.some((l) => this.isPickable(l));
        const showingSetup = !!document.getElementById('studio-setup');
        if (this.sourceMode() === 'lesson' && document.getElementById('studio-source-body') && showingSetup === pickable) {
            this.paintNewCard();
            return;
        }
        const list = document.getElementById('studio-lessons');
        const top = list ? list.scrollTop : 0;
        this.paintRegion('studio-lessons', this.lessonPickerMarkup());
        // Picking from the middle of a long list must not throw the list back to the top.
        if (list) list.scrollTop = top;
        this.paintRegion('studio-picked', this.pickedMarkup());
        const note = document.getElementById('studio-index-note');
        if (note) note.outerHTML = esc(this.indexNoteMarkup());
        const count = document.getElementById('studio-lessons-count');
        if (count) count.innerHTML = esc(this.countMarkup(this.selected.length, this.MAX_LESSONS));
    },

    lessonSearch(el) {
        this.lessonQuery = String((el && el.value) || '');
        this.paintRegion('studio-lessons', this.lessonPickerMarkup());
    },

    clearLessonSearch() {
        this.lessonQuery = '';
        const field = document.getElementById('studio-lesson-q');
        if (field) {
            field.value = '';
            if (typeof field.focus === 'function') field.focus();
        }
        this.paintRegion('studio-lessons', this.lessonPickerMarkup());
    },

    /** Lesson or idea. The choice is remembered; typed text in either survives the switch. */
    setMode(mode) {
        const next = mode === 'idea' ? 'idea' : 'lesson';
        this.mode = next;
        this.savePrefs({ mode: next });
        this.newError = null;
        this.paintNewCard();
        const target = document.getElementById(next === 'idea' ? 'studio-idea' : 'studio-lesson-q')
            || document.getElementById(`studio-mode-${next}`);
        if (target && typeof target.focus === 'function') target.focus();
    },

    /** Idea and keyword live on the page object, so a repaint (or a visit elsewhere) keeps them. */
    newTextInput(el) {
        const key = el && el.dataset ? el.dataset.key : '';
        if (key !== 'idea' && key !== 'keyword') return;
        this.newText[key] = String(el.value || '');
        if (key === 'keyword') this.refreshMoreSummary();
    },

    rememberOption(el) {
        if (!el) return;
        if (el.id === 'studio-angle' && this.ANGLES.includes(el.value)) this.savePrefs({ angle: el.value });
        if (el.id === 'studio-slides') this.savePrefs({ slides: Number(el.value) });
        this.refreshMoreSummary();
    },

    /** An accent swatch: '' is "from my palette". */
    pickAccent(el) {
        const hex = String((el && el.dataset && el.dataset.hex) || '').toUpperCase();
        if (hex && !this.ACCENT_RE.test(hex)) return;
        const field = document.getElementById('studio-accent');
        if (field) field.value = hex;
        const picker = document.getElementById('studio-accent-picker');
        if (picker && hex) picker.value = hex.toLowerCase();
        this.markSwatches(hex);
        this.savePrefs({ accent: hex });
        this.refreshMoreSummary();
    },

    markSwatches(hex) {
        const form = document.getElementById('studio-new-form');
        if (!form || typeof form.querySelectorAll !== 'function') return;
        form.querySelectorAll('.swatch-btn').forEach((b) => {
            b.setAttribute('aria-pressed', String((b.dataset.hex || '').toUpperCase() === hex ? 'true' : 'false'));
        });
    },

    toggleLesson(id) {
        const key = String(id);
        const at = this.selected.indexOf(key);
        if (at !== -1) {
            this.selected.splice(at, 1);
        } else {
            if (!this.isPickable(this.lessonById(key))) return;
            if (this.selected.length >= this.MAX_LESSONS) {
                UI.toast(t('studio.lessons.full', { max: this.MAX_LESSONS }), 'error');
                return;
            }
            this.selected.push(key);
        }
        this.paintLessons();
        Motion.announce(t('studio.countSr', { n: this.selected.length, max: this.MAX_LESSONS }));
    },

    async reloadLessons() {
        const [res] = await Promise.allSettled([API.getStudioLessons()]);
        this.applyLessons(res);
        this.paintLessons();
    },

    // ─── Lesson details (the chip's info button) ─────────────────────────────
    modalHeader(title) {
        return html`
            <div class="modal-header">
                <h2 class="modal-title" dir="auto">${title}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
        `;
    },

    spinnerMarkup(label) {
        return html`<p class="studio-progress" role="status"><span class="spinner spinner-sm" aria-hidden="true"></span> ${label || t('common.loading')}</p>`;
    },

    /** Is the modal this call opened still the one on screen? */
    modalLive(token) {
        const overlay = document.getElementById('modal-overlay');
        return token === this._modalToken && !!overlay && !overlay.classList.contains('hidden');
    },

    /** GET /lessons/:id, cached per page visit: moments do not change under an open editor. */
    fetchLesson(id, force) {
        const key = String(id);
        if (!force && this.lessonDetails[key]) return Promise.resolve(this.lessonDetails[key]);
        return API.getStudioLesson(key).then((res) => {
            const detail = {
                lesson: (res && res.lesson) || null,
                moments: res && Array.isArray(res.moments) ? res.moments : [],
            };
            this.lessonDetails[key] = detail;
            return detail;
        });
    },

    async showLesson(id) {
        const lesson = this.lessonById(id);
        const token = ++this._modalToken;
        UI.showModal(html`
            ${this.modalHeader(lesson ? this.lessonName(lesson) : t('studio.lessons.aboutTitle'))}
            <div id="studio-lesson-body">${this.spinnerMarkup()}</div>
            <div class="modal-actions">
                ${UI.button({ variant: 'secondary', label: t('common.close'), action: 'ui:closeModal' })}
            </div>
        `);
        let markup;
        try {
            markup = this.lessonDetailMarkup(await this.fetchLesson(id, true));
        } catch (err) {
            markup = UI.errorStrip((err && err.message) || t('error.unexpected'), '');
        }
        if (this.modalLive(token)) this.paintRegion('studio-lesson-body', markup);
    },

    momentKind(kind) {
        const known = ['slide', 'ui', 'result', 'code', 'prompt', 'other'];
        return t(`studio.moment.kind.${known.includes(kind) ? kind : 'other'}`);
    },

    lessonDetailMarkup(detail) {
        const lesson = (detail && detail.lesson) || {};
        const moments = (detail && detail.moments) || [];
        const notes = lesson.notes && typeof lesson.notes === 'object' ? lesson.notes : {};
        const points = Array.isArray(notes.points) ? notes.points : [];
        const tools = Array.isArray(notes.tools) ? notes.tools : [];
        const state = this.lessonState(lesson.status);
        const indexed = lesson.status === 'indexed';
        return html`
            <div class="studio-lesson stack gap-3">
                <p class="text-meta">
                    ${lesson.section_title ? html`<span dir="auto">${lesson.section_title}</span> · ` : ''}
                    ${lesson.duration_s ? html`${UI.ltr(this.clock(lesson.duration_s))} · ` : ''}
                    ${state.label}
                </p>
                ${!indexed ? html`
                    <div class="tiktok-note" role="note">
                        <i data-lucide="info" aria-hidden="true"></i>
                        <div class="stack gap-2">
                            <span>${lesson.status === 'indexing' ? t('studio.lessons.indexingNote') : t('studio.lessons.notIndexedNote')}</span>
                            ${lesson.error ? html`<span class="text-danger" dir="auto">${lesson.error}</span>` : ''}
                            ${lesson.status !== 'indexing' && lesson.id ? html`<div>${UI.button({
                                variant: 'secondary', size: 'sm', icon: 'scan-text', label: t('studio.lessons.indexOne'),
                                action: 'studio:indexLesson', data: { id: lesson.id },
                            })}</div>` : ''}
                        </div>
                    </div>
                ` : ''}
                ${notes.summary ? html`<p class="user-content" dir="auto" lang="ar">${notes.summary}</p>` : ''}
                ${points.length ? html`
                    <h3 class="studio-subhead">${t('studio.lessons.points')}</h3>
                    <ul class="studio-points">
                        ${points.map((p) => html`<li><strong dir="auto">${p && p.title}</strong> <span dir="auto">${p && p.detail}</span></li>`)}
                    </ul>
                ` : ''}
                ${tools.length ? html`
                    <p class="row row--wrap gap-2">${tools.map((tool) => html`<span class="chip" dir="auto">${tool}</span>`)}</p>
                ` : ''}
                ${moments.length ? html`
                    <h3 class="studio-subhead">${t('studio.lessons.moments', { n: UI.formatNumber(moments.length) })}</h3>
                    <ul class="moment-grid">${moments.map((m) => this.momentTile(m, null))}</ul>
                ` : ''}
            </div>
        `;
    },

    /**
     * One moment: its thumbnail, where it is in the video, what is on screen.
     * `pick` turns the tile into the button the screenshot picker uses.
     */
    momentTile(moment, pick) {
        const thumb = safeUrl(moment && moment.thumb_url);
        const body = html`
            <span class="moment-thumb">
                ${thumb ? html`<img src="${thumb}" alt="" loading="lazy" decoding="async">` : html`<i data-lucide="image-off" aria-hidden="true"></i>`}
            </span>
            <span class="moment-meta">${UI.ltr(this.clock(moment.t))} · ${this.momentKind(moment.kind)}</span>
            <span class="moment-desc" dir="auto">${moment.description || ''}</span>
            ${moment.clean === false ? html`<span class="badge badge-warning">${t('studio.moment.notClean')}</span>` : ''}
        `;
        if (!pick) return html`<li class="moment-tile">${body}</li>`;
        const current = pick.current === `m-${moment.id}`;
        return html`
            <li class="moment-tile">
                <button type="button" class="moment-pick${current ? html.raw(' is-current') : ''}" data-action="studio:pickShot"
                        data-moment="${moment.id}" data-lesson="${moment.lesson_id}" data-slide="${pick.slide}"
                        aria-pressed="${current ? 'true' : 'false'}">
                    ${body}
                    ${current ? html`<span class="badge badge-info">${t('studio.shot.current')}</span>` : ''}
                </button>
            </li>
        `;
    },

    async indexLesson(el, id) {
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            await API.indexStudioLesson(id);
            const lesson = this.lessonById(id);
            if (lesson) lesson.status = 'indexing';
            const detail = this.lessonDetails[String(id)];
            if (detail && detail.lesson) detail.lesson.status = 'indexing';
            UI.toast(t('studio.lessons.indexQueued'));
            this.paintLessons();
            this.refreshStatus();
            if (detail) this.paintRegion('studio-lesson-body', this.lessonDetailMarkup(detail));
        } catch (err) {
            UI.toast((err && err.message) || t('common.error'), 'error');
        } finally {
            restore();
        }
    },

    // ─── Generate ────────────────────────────────────────────────────────────
    /**
     * The form as a DraftInput (STUDIO.md §3). Optional fields are left out
     * rather than sent empty, so "no keyword" means "suggest one", not "".
     *
     * @returns {{ ok: true, input: object } | { ok: false, message: string, field: string }}
     */
    readNewInput(form) {
        const data = new FormData(form);
        const text = (name) => String(data.get(name) || '').trim();
        const idea = text('idea');
        const keyword = text('keyword');
        const accent = text('accent');
        let angle = text('angle') || 'auto';
        if (!this.ANGLES.includes(angle)) angle = 'auto';
        let slides = Math.round(Number(text('slides')) || this.SLIDES_DEFAULT);
        slides = Math.min(this.SLIDES_MAX, Math.max(this.SLIDES_MIN, slides));
        // "From an idea" means the idea alone, even if lessons were picked before the switch.
        const lessonMode = this.sourceMode() === 'lesson';
        const lessonIds = lessonMode ? this.selected.slice(0, this.MAX_LESSONS) : [];

        if (!lessonIds.length && !idea) {
            return lessonMode
                ? { ok: false, message: t('studio.new.needLesson'), field: 'studio-lesson-q' }
                : { ok: false, message: t('studio.new.needSource'), field: 'studio-idea' };
        }
        if (keyword && /\s/.test(keyword)) return { ok: false, message: t('studio.keywordOneWord'), field: 'studio-keyword' };
        if (accent && !this.ACCENT_RE.test(accent)) return { ok: false, message: t('studio.accentFormat'), field: 'studio-accent' };

        const input = { lessonIds };
        if (idea) input.idea = idea;
        input.angle = angle;
        input.slides = slides;
        if (keyword) input.keyword = keyword;
        if (accent) input.accent = accent.toUpperCase();
        return { ok: true, input };
    },

    /** `problems` off a 4xx, as plain strings. */
    problemList(err) {
        const list = err && err.body && Array.isArray(err.body.problems) ? err.body.problems : [];
        return list.map((p) => String(p));
    },

    newErrorMarkup() {
        const e = this.newError;
        if (!e) return '';
        return html`
            ${UI.errorStrip(e.message, '', 'studio-new-error-strip')}
            ${e.problems && e.problems.length ? html`
                <ul class="problem-list">${e.problems.map((p) => html`<li dir="auto">${p}</li>`)}</ul>
            ` : ''}
        `;
    },

    paintNewError() {
        this.paintRegion('studio-new-error', this.newErrorMarkup());
    },

    showNewError(error, fieldId) {
        this.newError = error;
        this.paintNewError();
        const form = document.getElementById('studio-new-form');
        if (form) UI.clearInvalid(form);
        const field = fieldId ? document.getElementById(fieldId) : null;
        // A field under "More options" cannot take focus while the section is folded.
        const more = document.getElementById('studio-more');
        if (field && more && typeof more.contains === 'function' && more.contains(field)) more.open = true;
        if (field) UI.markInvalid(field, 'studio-new-error-strip');
        if (error && error.message) Motion.announce(error.message);
    },

    /** Is the operator looking at the Studio's home right now (not a draft, not Settings)? */
    onStudioHome() {
        return typeof App !== 'undefined' && App.currentPage === 'studio'
            && !this.hashDraftId() && this.hashValue('tab') !== 'settings'
            && !!document.getElementById('studio-new');
    },

    /** "1.1 · Why chat is dead · Tips · 8 slides": what is being written, said on the progress card. */
    genSummary(input) {
        const lessons = (input.lessonIds || []).map((id) => this.lessonById(id)).filter(Boolean);
        const bits = [lessons.length
            ? lessons.map((l) => this.lessonName(l)).join(' + ')
            : t('studio.gen.fromIdea', { idea: String(input.idea || '').slice(0, 90) })];
        if (input.angle && input.angle !== 'auto') bits.push(this.angleLabel(input.angle));
        bits.push(t('studio.new.summarySlides', { n: UI.formatNumber(input.slides || this.SLIDES_DEFAULT) }));
        return bits.join(' · ');
    },

    genStage(elapsed) {
        let stage = 0;
        this.GEN_STAGE_AT.forEach((at, i) => { if (elapsed >= at) stage = i; });
        return stage;
    },

    genStageLabel(key, lessonMode) {
        if (key === 'read' && !lessonMode) return t('studio.gen.stage.readIdea');
        return t(`studio.gen.stage.${key}`);
    },

    genStagesMarkup() {
        const g = this.gen || { stage: 0, lessonMode: true };
        return this.GEN_STAGES.map((key, i) => {
            const state = i < g.stage ? 'done' : i === g.stage ? 'current' : 'todo';
            let mark = '';
            if (state === 'done') mark = html`<i data-lucide="check" aria-hidden="true"></i>`;
            else if (state === 'current') mark = html`<span class="spinner spinner-sm" aria-hidden="true"></span>`;
            return html`
                <li class="studio-stage is-${html.raw(state)}"${state === 'current' ? html.raw(' aria-current="step"') : ''}>
                    <span class="studio-stage-mark" aria-hidden="true">${mark}</span>
                    <span class="studio-stage-label">${this.genStageLabel(key, g.lessonMode)}</span>
                    <span class="sr-only"> (${t(`studio.step.state.${state}`)})</span>
                </li>
            `;
        });
    },

    /** Step 2: what is happening, how long it has taken, and that leaving is fine. */
    genProgressMarkup() {
        const g = this.gen || { startedAt: Date.now(), stage: 0, summary: '', lessonMode: true };
        const elapsed = (Date.now() - g.startedAt) / 1000;
        return html`
            <div class="studio-progress-card" aria-busy="true">
                <h2 class="section-title" id="studio-new-title">${t('studio.gen.title')}</h2>
                ${g.summary ? html`<p class="text-meta studio-gen-summary" dir="auto">${g.summary}</p>` : ''}
                <ol class="studio-stages" id="studio-gen-stages">${this.genStagesMarkup()}</ol>
                <div class="studio-indeterminate" aria-hidden="true"><span></span></div>
                <p class="studio-gen-time">
                    <span class="studio-gen-clock" id="studio-gen-elapsed">${this.clock(elapsed)}</span>
                    <span>· ${t('studio.gen.usually')}</span>
                </p>
                <p class="form-hint text-warning${elapsed < this.GEN_SLOW_S ? html.raw(' hidden') : ''}" id="studio-gen-slow">${t('studio.gen.slow')}</p>
                <div class="studio-callout" role="note">
                    <i data-lucide="info" aria-hidden="true"></i>
                    <div class="studio-callout-body"><p>${t('studio.gen.leave')}</p></div>
                </div>
            </div>
        `;
    },

    /**
     * The clock moves the stages, once a second; only a CHANGE of stage is
     * announced, so a screen reader hears four sentences, not sixty numbers.
     */
    startGenTicker() {
        this.stopGenTicker();
        const tick = () => {
            const g = this.gen;
            if (!g) return;
            const elapsed = (Date.now() - g.startedAt) / 1000;
            const clock = document.getElementById('studio-gen-elapsed');
            if (clock) clock.textContent = this.clock(elapsed);
            const stage = this.genStage(elapsed);
            if (stage !== g.stage) {
                g.stage = stage;
                this.paintRegion('studio-gen-stages', this.genStagesMarkup());
                Motion.announce(this.genStageLabel(this.GEN_STAGES[stage], g.lessonMode));
            }
            const slow = document.getElementById('studio-gen-slow');
            if (slow) slow.classList.toggle('hidden', elapsed < this.GEN_SLOW_S);
        };
        tick();
        this._genTimer = setInterval(tick, 1000);
    },

    async generate(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (this.generating || this.planRunning) return;
        const read = this.readNewInput(form);
        if (!read.ok) {
            this.showNewError({ message: read.message }, read.field);
            return;
        }
        const restore = UI.formBusy(form, t('studio.new.writing'));
        if (!restore) return;
        this.savePrefs({ mode: this.sourceMode(), angle: read.input.angle, slides: read.input.slides, accent: read.input.accent || '' });
        try {
            await this.runGeneration(read.input);
        } finally {
            restore();
        }
    },

    /**
     * POST /drafts, with the page free while it runs (up to two minutes). The
     * request belongs to this object, so leaving the page does not cancel it and
     * coming back finds the progress card where it was. The answer opens the
     * editor only if the operator is still on the Studio's home; anywhere else a
     * toast says it is ready, and the draft is in the grid.
     */
    async runGeneration(input) {
        const seq = this._seq;
        const tenant = this._tenantEpoch;
        this.generating = true;
        this.newError = null;
        this.gen = {
            startedAt: Date.now(),
            lessonMode: Array.isArray(input.lessonIds) && input.lessonIds.length > 0,
            summary: this.genSummary(input),
            stage: 0,
        };
        this.paintNewCard();
        this.startGenTicker();
        Motion.announce(t('studio.gen.started'));
        // The server saved a `generating` row before it started writing: show it.
        setTimeout(() => {
            if (this.generating && document.getElementById('studio-drafts')) this.reloadDrafts();
        }, 1500);
        let opened = false;
        try {
            const res = await API.createStudioDraft(input);
            // Written for the tenant the operator has since switched away from: nothing here is theirs now.
            if (tenant !== this._tenantEpoch) return;
            const draft = res && res.draft;
            if (!draft || !draft.id) throw new Error(t('error.unexpected'));
            if (draft.status === 'failed') {
                // Saved, but with nothing to edit: say why here, and let the grid show the row.
                this.newError = { message: t('studio.new.failed', { message: draft.error || t('error.unexpected') }) };
                return;
            }
            this.selected = [];
            this.newText = { idea: '', keyword: '' };
            if ((seq === this._seq || this.onStudioHome()) && typeof App !== 'undefined' && typeof App.goWithQuery === 'function') {
                UI.toast(t('studio.new.done'));
                opened = true;
                App.goWithQuery('studio', { draft: draft.id });
            } else {
                UI.toast(t('studio.new.doneElsewhere', { title: this.draftTitle(draft) }));
            }
        } catch (err) {
            if (tenant === this._tenantEpoch) {
                this.newError = { message: (err && err.message) || t('error.unexpected'), problems: this.problemList(err) };
            }
        } finally {
            const stale = tenant !== this._tenantEpoch;
            if (!stale) {
                this.generating = false;
                this.gen = null;
                this.stopGenTicker();
            }
            if (!opened && !stale) {
                // Back to step 1, with the reason (if any) where it was asked for.
                if (document.getElementById('studio-new')) this.paintNewCard();
                this.paintNewError();
                if (this.newError) Motion.announce(this.newError.message);
                if (document.getElementById('studio-drafts')) this.reloadDrafts();
            }
        }
    },

    /** The colour picker writes the hex into the text field, which is what is sent. */
    accentPicked(el) {
        const target = el && el.dataset ? document.getElementById(el.dataset.target || '') : null;
        const value = String((el && el.value) || '').toUpperCase();
        if (target) target.value = value;
        if (this.ACCENT_RE.test(value)) {
            this.markSwatches(value);
            this.savePrefs({ accent: value });
        }
        this.refreshMoreSummary();
    },

    /** …and a valid typed hex moves the picker, so the two never disagree. */
    accentTyped(el) {
        const picker = el && el.dataset ? document.getElementById(el.dataset.picker || '') : null;
        const value = String((el && el.value) || '').trim();
        if (picker && this.ACCENT_RE.test(value)) picker.value = value.toLowerCase();
        if (!value || this.ACCENT_RE.test(value)) {
            this.markSwatches(value.toUpperCase());
            this.savePrefs({ accent: value.toUpperCase() });
        }
        this.refreshMoreSummary();
    },

    // ─── Plan my week ────────────────────────────────────────────────────────
    /** Bumped by a tenant switch and by closing the plan: a run from before either stops. */
    _planSeq: 0,

    async planWeek(el) {
        if (this.generating || this.planRunning) return;
        const select = document.getElementById('studio-plan-count');
        let count = Math.round(Number(select && select.value) || this.PLAN_DEFAULT);
        count = Math.min(Math.max(...this.PLAN_COUNTS), Math.max(Math.min(...this.PLAN_COUNTS), count));
        const body = { count };
        if (this.selected.length) body.lessonIds = this.selected.slice(0, this.MAX_LESSONS);

        const restore = UI.actionBusy(el);
        if (!restore) return;
        const planSeq = ++this._planSeq;
        this.plan = { status: 'loading', proposals: [], error: null };
        this.paintPlan();
        try {
            const res = await API.planStudioWeek(body);
            if (planSeq !== this._planSeq) return;
            const proposals = res && Array.isArray(res.proposals) ? res.proposals : [];
            this.plan = {
                status: 'ready',
                error: null,
                proposals: proposals.map((p, i) => ({ ...p, key: `p${i + 1}`, keep: true, run: 'idle', error: '', draftId: '' })),
            };
        } catch (err) {
            if (planSeq !== this._planSeq) return;
            this.plan = { status: 'error', proposals: [], error: err };
        } finally {
            restore();
        }
        this.paintPlan();
        const heading = document.getElementById('studio-plan-title');
        if (heading && typeof heading.focus === 'function') heading.focus();
    },

    closePlan() {
        if (this.planRunning) return;
        this._planSeq++;
        this.plan = null;
        this.paintPlan();
        const btn = document.getElementById('studio-plan-btn');
        if (btn && typeof btn.focus === 'function') btn.focus();
    },

    toggleProposal(key) {
        if (!this.plan || this.planRunning) return;
        const p = this.plan.proposals.find((x) => x.key === key);
        if (!p || p.run === 'done' || p.run === 'writing') return;
        p.keep = !p.keep;
        this.paintPlan();
    },

    paintPlan() {
        this.paintRegion('studio-plan', this.planMarkup());
    },

    /** A proposal minus what only the plan needs (title, rationale, slot): the body POST /drafts takes. */
    draftInputFrom(p) {
        const input = { lessonIds: Array.isArray(p.lessonIds) ? p.lessonIds.map(String).slice(0, this.MAX_LESSONS) : [] };
        if (p.idea) input.idea = String(p.idea);
        // A proposal with neither would be refused; its own title is the topic it proposed.
        if (!input.lessonIds.length && !input.idea && p.title) input.idea = String(p.title);
        if (p.angle && this.ANGLES.includes(p.angle)) input.angle = p.angle;
        if (p.slides) input.slides = Math.min(this.SLIDES_MAX, Math.max(this.SLIDES_MIN, Math.round(Number(p.slides)) || this.SLIDES_DEFAULT));
        if (p.keyword) input.keyword = String(p.keyword);
        if (p.accent && this.ACCENT_RE.test(String(p.accent))) input.accent = String(p.accent);
        return input;
    },

    planMarkup() {
        const plan = this.plan;
        if (!plan) return '';
        const head = html`
            <div class="studio-section-head">
                <h2 class="section-title" id="studio-plan-title" tabindex="-1">${t('studio.plan.title')}</h2>
                ${UI.button({
                    variant: 'ghost', size: 'sm', icon: 'x', label: t('studio.plan.close'),
                    action: 'studio:closePlan', disabled: this.planRunning,
                })}
            </div>
        `;
        if (plan.status === 'loading') {
            return html`<section class="surface pad-5 studio-plan" aria-busy="true">${head}${this.spinnerMarkup(t('studio.plan.loading'))}</section>`;
        }
        if (plan.status === 'error') {
            return html`
                <section class="surface pad-5 studio-plan">
                    ${head}
                    ${UI.errorStrip((plan.error && plan.error.message) || t('error.unexpected'), '')}
                    ${this.problemList(plan.error).length ? html`<ul class="problem-list">${this.problemList(plan.error).map((p) => html`<li dir="auto">${p}</li>`)}</ul>` : ''}
                </section>
            `;
        }
        const todo = plan.proposals.filter((p) => p.keep && p.run !== 'done');
        return html`
            <section class="surface pad-5 studio-plan" aria-labelledby="studio-plan-title">
                ${head}
                ${plan.proposals.length
                    ? html`<ol class="plan-list">${plan.proposals.map((p, i) => this.proposalMarkup(p, i))}</ol>`
                    : html`<p class="studio-empty-note">${t('studio.plan.empty')}</p>`}
                <div class="form-actions">
                    ${UI.button({
                        variant: 'primary', icon: 'sparkles', id: 'studio-plan-run',
                        label: t('studio.plan.generateAll', { n: UI.formatNumber(todo.length) }),
                        action: 'studio:generateAll', busy: this.planRunning,
                        disabled: !todo.length || this.generating,
                    })}
                </div>
                <p class="form-hint">${t('studio.plan.sequential')}</p>
            </section>
        `;
    },

    proposalMarkup(p, index) {
        const lessons = (Array.isArray(p.lessonIds) ? p.lessonIds : []).map((id) => this.lessonById(id)).filter(Boolean);
        const locked = this.planRunning || p.run === 'done' || p.run === 'writing';
        return html`
            <li class="plan-item${p.keep ? '' : html.raw(' is-dropped')}">
                <div class="plan-item-head">
                    <span class="plan-item-num" aria-hidden="true">${UI.formatNumber(index + 1)}</span>
                    <strong class="plan-item-title" dir="auto">${p.title || t('studio.drafts.untitled')}</strong>
                </div>
                <p class="plan-item-meta">
                    <span class="chip"><i data-lucide="calendar-clock" aria-hidden="true"></i> ${p.slot ? this.slotLabel(p.slot) : t('studio.plan.noSlot')}</span>
                    <span class="chip">${this.angleLabel(p.angle || 'auto')}</span>
                    ${lessons.map((l) => html`<span class="chip" title="${l.title || ''}">${UI.ltr(l.lesson_no || '')}</span>`)}
                </p>
                ${p.rationale ? html`<p class="plan-item-why" dir="auto">${p.rationale}</p>` : ''}
                ${p.idea ? html`<p class="text-meta" dir="auto">${t('studio.plan.idea', { idea: p.idea })}</p>` : ''}
                <div class="plan-item-foot">
                    ${this.proposalRunMarkup(p)}
                    ${!locked ? UI.button({
                        variant: p.keep ? 'ghost' : 'secondary', size: 'sm',
                        icon: p.keep ? 'x' : 'plus',
                        label: p.keep ? t('studio.plan.remove') : t('studio.plan.keep'),
                        action: 'studio:toggleProposal', data: { key: p.key }, focusKey: `plan-${p.key}`,
                    }) : ''}
                </div>
            </li>
        `;
    },

    proposalRunMarkup(p) {
        switch (p.run) {
            case 'writing':
                return html`<span class="plan-run" role="status"><span class="spinner spinner-sm" aria-hidden="true"></span> ${t('studio.plan.writing')}</span>`;
            case 'done':
                return html`
                    <span class="plan-run text-success">
                        <i data-lucide="check-circle" aria-hidden="true"></i> ${t('studio.plan.done')}
                        <a href="#/studio?draft=${encodeURIComponent(p.draftId)}">${t('studio.plan.open')}</a>
                    </span>
                `;
            case 'failed':
                return html`<span class="plan-run text-danger" dir="auto"><i data-lucide="alert-circle" aria-hidden="true"></i> ${p.error || t('error.unexpected')}</span>`;
            default:
                return html`<span class="plan-run text-meta">${p.keep ? t('studio.plan.willWrite') : t('studio.plan.dropped')}</span>`;
        }
    },

    /**
     * POST /drafts once per kept proposal, one after another — each is a two-minute
     * Gemini call, and the per-item line says where the run is. It keeps going if the
     * operator leaves the page (they asked for all of them), and stops only on a
     * tenant switch or a closed plan, which would otherwise write into the wrong place.
     */
    async generateAll() {
        const plan = this.plan;
        if (!plan || this.planRunning || this.generating) return;
        const queue = plan.proposals.filter((p) => p.keep && p.run !== 'done');
        if (!queue.length) return;
        const planSeq = this._planSeq;
        this.planRunning = true;
        this.paintPlan();
        let done = 0;
        let failed = 0;
        try {
            for (const p of queue) {
                if (planSeq !== this._planSeq) break;
                p.run = 'writing';
                p.error = '';
                this.paintPlan();
                Motion.announce(t('studio.plan.writingItem', { title: p.title || '' }));
                try {
                    const res = await API.createStudioDraft(this.draftInputFrom(p));
                    const draft = res && res.draft;
                    if (!draft || !draft.id) throw new Error(t('error.unexpected'));
                    p.draftId = String(draft.id);
                    if (draft.status === 'failed') {
                        p.run = 'failed';
                        p.error = draft.error || t('error.unexpected');
                        failed++;
                    } else {
                        p.run = 'done';
                        if (p.slot) this.plannedSlots[p.draftId] = p.slot;
                        done++;
                    }
                } catch (err) {
                    p.run = 'failed';
                    p.error = (err && err.message) || t('error.unexpected');
                    failed++;
                }
            }
        } finally {
            this.planRunning = false;
        }
        if (planSeq !== this._planSeq) return;
        this.paintPlan();
        const message = failed
            ? t('studio.plan.finishedWithFailures', { done: UI.formatNumber(done), failed: UI.formatNumber(failed) })
            : t('studio.plan.finished', { n: UI.formatNumber(done) });
        UI.toast(message, failed ? 'error' : 'success');
        Motion.announce(message);
        if (document.getElementById('studio-drafts')) this.reloadDrafts();
    },

    // ─── Drafts grid ─────────────────────────────────────────────────────────
    draftTitle(draft) {
        const slides = draft && draft.carousel && Array.isArray(draft.carousel.slides) ? draft.carousel.slides : [];
        const cover = slides.find((s) => s && s.kind === 'cover');
        if (cover && cover.title) return cover.title;
        if (draft && draft.input && draft.input.idea) return draft.input.idea;
        return t('studio.drafts.untitled');
    },

    /** Where a draft is headed: its scheduled time, or the slot a plan proposed for it. */
    draftSlot(draft) {
        const scheduled = draft && draft.schedule && draft.schedule.scheduled_time;
        if (scheduled) return { iso: scheduled, planned: false };
        const planned = draft && this.plannedSlots[String(draft.id)];
        return planned ? { iso: planned, planned: true } : null;
    },

    STATUS_PILLS: Object.freeze({
        generating: 'pending', rendering: 'pending', ready: 'sent', scheduled: 'scheduled', failed: 'failed',
    }),

    statusPill(status) {
        const known = Object.prototype.hasOwnProperty.call(this.STATUS_PILLS, status);
        const cls = known ? this.STATUS_PILLS[status] : 'pending';
        const label = known ? t(`studio.state.${status}`) : String(status || '—');
        return html`
            <span class="status-pill ${html.raw(cls)}">
                ${this.isBusyStatus(status) ? html`<span class="dot-blink" aria-hidden="true"></span>` : ''}
                ${label}
            </span>
        `;
    },

    draftsMarkup() {
        if (this.draftsError && !this.drafts.length) {
            return this.errorHost(this.draftsError, t('studio.drafts.errorTitle'), 'drafts');
        }
        if (!this.drafts.length) {
            // Not a congratulation and not a blank: what a draft will look like, and how to get one.
            return html`
                <div class="surface pad-5 studio-drafts-empty" id="studio-drafts-empty">
                    <div class="studio-empty-copy">
                        <p class="studio-empty-title">${t('studio.drafts.emptyTitle')}</p>
                        <p class="form-hint">${t('studio.drafts.emptyBody')}</p>
                    </div>
                    <figure class="draft-example" id="studio-drafts-example">
                        <div class="draft-card surface draft-card--example" aria-hidden="true">
                            <span class="draft-cover draft-cover--example"><span class="draft-example-title">${t('studio.drafts.exampleCover')}</span></span>
                            <span class="draft-card-body">
                                <span class="draft-card-head">
                                    <span class="draft-title">${t('studio.drafts.exampleTitle')}</span>
                                    <span class="status-pill sent">${t('studio.state.ready')}</span>
                                </span>
                                <span class="draft-card-tags">
                                    <span class="chip">${t('studio.drafts.slides', { n: UI.formatNumber(this.SLIDES_DEFAULT) })}</span>
                                    <span class="chip">${t('studio.drafts.exampleWhere')}</span>
                                </span>
                            </span>
                        </div>
                        <figcaption class="form-hint">${t('studio.drafts.exampleCaption')}</figcaption>
                    </figure>
                </div>
            `;
        }
        return html`<ul class="card-grid studio-draft-grid">${this.drafts.map((d) => this.draftCard(d))}</ul>`;
    },

    /** What a busy draft is waiting on, in words: writing, drawing, or the Mac. */
    draftStageText(draft) {
        if (!draft || draft.status === 'generating') return t('studio.drafts.stageWriting');
        return this.workerOnline() ? t('studio.drafts.stageDrawing') : t('studio.drafts.stageWaiting');
    },

    draftCard(draft) {
        const id = String(draft.id);
        const href = `#/studio?draft=${encodeURIComponent(id)}`;
        const cover = draft.render && Array.isArray(draft.render.ig) ? safeUrl(draft.render.ig[0]) : '';
        const busy = this.isBusyStatus(draft.status);
        const slot = this.draftSlot(draft);
        const slides = draft.carousel && Array.isArray(draft.carousel.slides) ? draft.carousel.slides.length : 0;
        const keyword = (draft.campaign && draft.campaign.keyword) || (draft.carousel && draft.carousel.keyword) || '';
        let cell = html`<i data-lucide="image" aria-hidden="true"></i>`;
        if (cover) cell = html`<img src="${cover}" alt="" loading="lazy" decoding="async">`;
        else if (busy) cell = html`<span class="skel skel-block"></span>`;
        return html`
            <li class="draft-card surface" data-id="${id}">
                <!-- The title is the link; the picture repeats it for a pointer, not a second tab stop. -->
                <a class="draft-cover" href="${href}" tabindex="-1" aria-hidden="true">${cell}</a>
                <div class="draft-card-body">
                    <div class="draft-card-head">
                        <h3 class="draft-title"><a href="${href}" dir="auto">${this.draftTitle(draft)}</a></h3>
                        ${this.statusPill(draft.status)}
                    </div>
                    <p class="post-card-meta">
                        <i data-lucide="clock" aria-hidden="true"></i>
                        <span>${t('studio.drafts.created', { when: UI.formatDateTime(draft.created_at) })}</span>
                    </p>
                    ${slot ? html`
                        <p class="post-card-meta">
                            <i data-lucide="calendar-clock" aria-hidden="true"></i>
                            <span>${slot.planned
                                ? t('studio.drafts.plannedFor', { when: this.slotLabel(slot.iso) })
                                : t('studio.drafts.scheduledFor', { when: this.slotLabel(slot.iso) })}</span>
                        </p>
                    ` : ''}
                    ${slides || keyword ? html`
                        <p class="draft-card-tags">
                            ${slides ? html`<span class="chip">${t('studio.drafts.slides', { n: UI.formatNumber(slides) })}</span>` : ''}
                            ${keyword ? html`<span class="chip chip-accent" dir="auto">${keyword}</span>` : ''}
                        </p>
                    ` : ''}
                    ${busy ? html`<p class="draft-card-stage"><span class="spinner spinner-sm" aria-hidden="true"></span> ${this.draftStageText(draft)}</p>` : ''}
                    ${draft.status === 'failed' && draft.error ? html`<p class="post-card-error" dir="auto">${draft.error}</p>` : ''}
                </div>
            </li>
        `;
    },

    paintDrafts() {
        this.paintRegion('studio-drafts', this.draftsMarkup());
    },

    async reloadDrafts() {
        const [res] = await Promise.allSettled([API.getStudioDrafts()]);
        this.applyDrafts(res);
        this.paintDrafts();
    },

    // ─── Editor: loading ─────────────────────────────────────────────────────
    clone(value) {
        return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
    },

    /**
     * Take a GET/PATCH answer as the new server truth, and start the working copy
     * over from it. Missing parts are filled in the same way on both sides of the
     * baseline, so a draft does not open "dirty" because the server left one out.
     */
    loadDraft(res, opts) {
        const draft = (res && res.draft) || null;
        this.draft = draft;
        if (res && Array.isArray(res.lessons)) this.draftLessons = res.lessons;
        const carousel = draft && draft.carousel ? this.clone(draft.carousel) : null;
        if (carousel) {
            if (!Array.isArray(carousel.slides)) carousel.slides = [];
            carousel.captions = { instagram: '', tiktokTitle: '', tiktok: '', ...(carousel.captions || {}) };
        }
        const campaign = { keyword: '', variants: [], dm: '', create: false, ...((draft && draft.campaign) || {}) };
        this.work = {
            carousel,
            shots: draft && draft.shots && typeof draft.shots === 'object' ? this.clone(draft.shots) : {},
            campaign: this.clone(campaign),
        };
        this._baseline = JSON.stringify(this.work);
        this._lastDirty = false;
        this.problems = null;
        this.saveError = null;
        if (opts && opts.restore) this.restoreEdits();
        this.selectedSlide = this.clampSlide(this.selectedSlide);
    },

    editsKey() {
        return this.draft && this.draft.id ? `${this.EDITS_PREFIX}${this.draft.id}` : '';
    },

    /**
     * On opening a draft: edits this browser kept and never saved come back. Made
     * against the same server copy, they are simply restored (and say so); made
     * against an older one, they are offered, because applying them blind could
     * undo a change made since — a rewrite, a save from another tab.
     */
    restoreEdits() {
        this.restored = null;
        const key = this.editsKey();
        if (!key || !this.work || !this.work.carousel || this.draft.status === 'scheduled') return;
        const stored = this.storeGet(key);
        if (!stored || !stored.work || !stored.work.carousel || !Array.isArray(stored.work.carousel.slides)) return;
        if (JSON.stringify(stored.work) === this._baseline) {
            this.storeRemove(key);
            return;
        }
        if (stored.baseline === this._baseline) {
            this.work = this.clone(stored.work);
            this.restored = { state: 'restored' };
        } else {
            this.restored = { state: 'stale', work: stored.work };
        }
    },

    /** A copy of the working edits after every change; none once they are saved or thrown away. */
    persistEdits() {
        const key = this.editsKey();
        if (!key || !this.work) return;
        if (this.isDirty()) this.storeSet(key, { baseline: this._baseline, work: this.work, at: new Date().toISOString() });
        else this.storeRemove(key);
    },

    forgetEdits() {
        const key = this.editsKey();
        if (key) this.storeRemove(key);
        this.restored = null;
    },

    applyRestored() {
        if (!this.restored || !this.restored.work || this.readOnly()) return;
        this.work = this.clone(this.restored.work);
        this.restored = { state: 'restored' };
        this.selectedSlide = this.clampSlide(this.selectedSlide);
        this.persistEdits();
        this.paintEditor();
        Motion.announce(t('studio.restore.applied'));
    },

    dropRestored() {
        this.forgetEdits();
        this.paintNotices();
        Motion.announce(t('studio.restore.dropped'));
    },

    isDirty() {
        return !!this.work && JSON.stringify(this.work) !== this._baseline;
    },

    /** Scheduled drafts are closed to edits (PATCH is refused); a draft still being written has nothing to edit. */
    readOnly() {
        return !this.draft || this.draft.status === 'scheduled' || !this.work || !this.work.carousel;
    },

    tiktokAudited() {
        return !!(this.status && this.status.tiktok && this.status.tiktok.audited === true);
    },

    workerOnline() {
        return !!(this.status && this.status.worker && this.status.worker.online === true);
    },

    /** The language the tenant writes carousels in (settings.voice.language). */
    contentLang() {
        return this.settings && this.settings.voice && this.settings.voice.language === 'en' ? 'en' : 'ar';
    },

    async renderEditorPage(container, seq, id) {
        if (this.draftId !== id) this.clearEditor();
        this.draftId = id;
        const gate = Motion.beginLoad(container, () => this.skeleton());
        const [draft, status, settings] = await Promise.allSettled([
            API.getStudioDraft(id),
            API.getStudioStatus(),
            API.getStudioSettings(),
        ]);
        if (!this.alive(seq)) return;
        gate.done();
        this.applyStatus(status);
        this.applySettings(settings);

        if (draft.status === 'rejected' || !draft.value || !draft.value.draft) {
            this.draft = null;
            this.draftError = draft.status === 'rejected' ? draft.reason : new Error(t('error.unexpected'));
            container.innerHTML = esc(html`
                <div class="page-toolbar">${this.backLink()}</div>
                ${this.errorHost(this.draftError, t('studio.editor.loadFailed'), 'page')}
            `);
            UI.icons(container);
            this.wireErrors(container);
            return;
        }

        this.loadDraft(draft.value, { restore: true });
        this.paintEditor();
        this.bindKeys('editor');
        this.startStatusTimer(seq);
        this.startPoll(seq);
        if (this.draft.status !== 'scheduled') this.loadSlots(seq);
        this.loadShotSources(seq);
        Motion.announce(`${this.draftTitle(this.draft)} — ${t(`studio.state.${this.draft.status}`)}`);
    },

    async loadSlots(seq) {
        this.slots = null;
        this.slotsError = null;
        const [res] = await Promise.allSettled([API.getStudioSlots(this.SLOT_COUNT)]);
        if (seq !== this._seq) return;
        if (res.status === 'fulfilled') {
            this.slots = res.value && Array.isArray(res.value.slots) ? res.value.slots.map(String) : [];
        } else {
            this.slots = [];
            this.slotsError = res.reason;
        }
        this.paintSchedule();
    },

    /** Every lesson the draft stands on: the ones the server listed, and the ones it was asked for. */
    draftLessonIds() {
        const listed = this.draftLessons.map((l) => String(l && l.id));
        const asked = this.draft && this.draft.input && Array.isArray(this.draft.input.lessonIds)
            ? this.draft.input.lessonIds.map(String) : [];
        return [...new Set([...listed, ...asked])].filter((id) => id && id !== 'undefined');
    },

    /** Moments are what a shot's thumbnail comes from; fetched after the editor paints. */
    async loadShotSources(seq) {
        const ids = this.draftLessonIds();
        if (!ids.length) return;
        await Promise.allSettled(ids.map((id) => this.fetchLesson(id)));
        if (seq !== this._seq) return;
        this.paintShotThumbs();
    },

    momentById(momentId) {
        const key = String(momentId);
        for (const lessonId of Object.keys(this.lessonDetails)) {
            const found = this.lessonDetails[lessonId].moments.find((m) => m && String(m.id) === key);
            if (found) return found;
        }
        return null;
    },

    /** `m-<momentId>` → that moment's thumbnail, once its lesson is in. */
    shotThumb(name) {
        const value = String(name || '');
        const moment = value.startsWith('m-') ? this.momentById(value.slice(2)) : null;
        return moment ? safeUrl(moment.thumb_url) : '';
    },

    paintShotThumbs() {
        if (!this.work || !this.work.carousel) return;
        this.work.carousel.slides.forEach((slide, i) => {
            if (!slide || !slide.shot) return;
            const host = document.getElementById(`st-${i}-shot-thumb`);
            if (host) host.innerHTML = esc(this.shotThumbMarkup(slide.shot.name));
        });
    },

    shotThumbMarkup(name) {
        const src = this.shotThumb(name);
        return src
            ? html`<img src="${src}" alt="" loading="lazy" decoding="async">`
            : html`<i data-lucide="image" aria-hidden="true"></i>`;
    },

    // ─── Editor: markup ──────────────────────────────────────────────────────
    backLink() {
        return html`
            <a class="btn btn-ghost btn-sm" href="#/studio">
                <i data-lucide="arrow-left" aria-hidden="true"></i> ${t('studio.editor.back')}
            </a>
        `;
    },

    paintEditor() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const focus = UI.captureFocus(container);
        container.innerHTML = esc(this.editorMarkup());
        UI.icons(container);
        this.wireErrors(container);
        this.applySwatches(container);
        UI.restoreFocus(focus);
        this.wirePreview();
        this.syncRenderTicker();
    },

    /**
     * Preview first: the phone and the slide rail on one side (on top, on a
     * phone), the chosen slide's form on the other, then the caption, the
     * comment automation and the schedule — the order a post is checked in.
     */
    editorMarkup() {
        const editable = !!(this.work && this.work.carousel);
        const ro = this.readOnly();
        return html`
            <div class="page-toolbar studio-toolbar">
                ${this.backLink()}
                <div id="studio-stepper">${this.stepperMarkup(this.editorStep())}</div>
            </div>
            <section class="surface pad-5 studio-editor-head" id="studio-editor-head" aria-labelledby="studio-editor-title">
                ${this.editorHeadMarkup()}
            </section>
            <div id="studio-notices" class="studio-notices">${this.noticesMarkup()}</div>
            <div class="studio-editor">
                <div class="studio-area-previews">
                    <section class="surface pad-4 studio-preview-panel" id="studio-previews" aria-labelledby="studio-previews-title">
                        ${this.previewsMarkup()}
                    </section>
                    ${editable ? html`<section class="surface pad-4 studio-look" id="studio-look" aria-label="${t('studio.look.label')}">${this.lookMarkup()}</section>` : ''}
                </div>
                <div class="studio-area-main">
                    ${editable ? html`
                        <div id="studio-problems">${this.problemsMarkup()}</div>
                        <section class="surface pad-4 studio-slide-editor" id="studio-slides" aria-labelledby="studio-slides-title">
                            ${this.slidesMarkup()}
                        </section>
                        <section class="surface pad-4" id="studio-captions" aria-labelledby="studio-captions-title">
                            ${this.captionsMarkup()}
                        </section>
                        <section class="surface pad-4" id="studio-campaign" aria-labelledby="studio-campaign-title">
                            ${this.campaignMarkup()}
                        </section>
                    ` : html`
                        <section class="surface pad-5">
                            <p class="studio-empty-note">${this.draft && this.draft.status === 'generating'
                                ? t('studio.editor.stillWriting') : t('studio.editor.noCarousel')}</p>
                        </section>
                    `}
                    <section class="surface pad-4 studio-area-schedule" id="studio-schedule" aria-labelledby="studio-schedule-title">
                        ${this.scheduleMarkup()}
                    </section>
                </div>
            </div>
            ${editable && !ro ? html`<div class="studio-savebar surface" id="studio-savebar">${this.saveBarMarkup()}</div>` : ''}
            ${this.draft && this.draft.status !== 'scheduled' ? html`
                <div class="studio-danger">
                    ${UI.button({
                        variant: 'danger', size: 'sm', icon: 'trash-2', label: t('studio.editor.delete'),
                        action: 'studio:deleteDraft', id: 'studio-delete',
                    })}
                </div>
            ` : ''}
        `;
    },

    paintHead() {
        this.paintRegion('studio-editor-head', this.editorHeadMarkup());
        this.paintStepper(this.editorStep());
    },
    paintPreviews() {
        this.paintRegion('studio-previews', this.previewsMarkup());
        this.wirePreview();
        this.syncRenderTicker();
    },
    paintSlides(focusKey) {
        const host = this.paintRegion('studio-slides', this.slidesMarkup());
        if (host && focusKey) {
            const el = UI.elementByFocusKey(focusKey);
            if (el && !el.disabled && typeof el.focus === 'function') el.focus({ preventScroll: false });
        }
    },
    paintCaptions() { this.paintRegion('studio-captions', this.captionsMarkup()); },
    paintCampaign() { this.paintRegion('studio-campaign', this.campaignMarkup()); },
    paintSaveBar() { this.paintRegion('studio-savebar', this.saveBarMarkup()); },
    paintSchedule() { this.paintRegion('studio-schedule', this.scheduleMarkup()); },
    paintNotices() { this.paintRegion('studio-notices', this.noticesMarkup()); },
    paintLook() { this.paintRegion('studio-look', this.lookMarkup()); },
    paintRenderState() { this.paintRegion('studio-render-state', this.renderStateMarkup()); },
    paintProblemsPanel() { this.paintRegion('studio-problems', this.problemsMarkup()); },

    editorHeadMarkup() {
        const d = this.draft || {};
        const lessons = this.draftLessons || [];
        const canRender = !!(d.carousel && d.status === 'failed');
        const canRegenerate = !!d.input && d.status !== 'scheduled' && d.status !== 'generating';
        return html`
            <div class="studio-editor-titlebar">
                <h2 class="studio-editor-title" id="studio-editor-title" dir="auto">${this.draftTitle(d)}</h2>
                <div class="row row--wrap gap-2">
                    ${this.statusPill(d.status)}
                    ${canRegenerate ? UI.button({
                        variant: 'ghost', size: 'sm', icon: 'wand-sparkles', label: t('studio.regen.button'),
                        action: 'studio:openRegenerate', id: 'studio-regen',
                    }) : ''}
                </div>
            </div>
            <p class="post-card-meta studio-head-meta">
                <i data-lucide="clock" aria-hidden="true"></i>
                <span>${t('studio.drafts.created', { when: UI.formatDateTime(d.created_at) })}</span>
                ${lessons.map((l) => html`<span class="chip">${UI.ltr(l.lesson_no || '')} <span dir="auto">${l.title || ''}</span></span>`)}
                ${d.input && d.input.idea ? html`<span class="text-meta" dir="auto">${t('studio.plan.idea', { idea: d.input.idea })}</span>` : ''}
            </p>
            ${d.status === 'failed' ? html`
                ${UI.errorStrip(d.error || t('error.unexpected'), canRender ? t('studio.editor.failedHint') : '', 'studio-draft-error')}
                ${canRender ? html`<div class="row row--wrap gap-2 mbs-4">${UI.button({
                    variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('studio.editor.renderAgain'),
                    action: 'studio:renderAgain', id: 'studio-render-again',
                })}</div>` : ''}
            ` : ''}
            ${d.status === 'scheduled' ? html`<p class="studio-hint"><i data-lucide="lock" aria-hidden="true"></i><span>${t('studio.editor.readOnly')}</span></p>` : ''}
        `;
    },

    /** Restored edits, and the Undo for a deleted slide: things to know now, with a way back. */
    noticesMarkup() {
        const out = [];
        const r = this.restored;
        if (r && r.state === 'restored') {
            out.push(html`
                <div class="studio-callout" role="status">
                    <i data-lucide="history" aria-hidden="true"></i>
                    <div class="studio-callout-body studio-callout-row">
                        <p>${t('studio.restore.restored')}</p>
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'rotate-ccw', label: t('studio.restore.discard'), action: 'studio:discard', id: 'studio-restore-discard' })}
                    </div>
                </div>
            `);
        } else if (r && r.state === 'stale') {
            out.push(html`
                <div class="studio-callout is-warning" role="status">
                    <i data-lucide="history" aria-hidden="true"></i>
                    <div class="studio-callout-body studio-callout-row">
                        <p>${t('studio.restore.stale')}</p>
                        <span class="row row--wrap gap-2">
                            ${UI.button({ variant: 'secondary', size: 'sm', label: t('studio.restore.apply'), action: 'studio:applyRestored', id: 'studio-restore-apply' })}
                            ${UI.button({ variant: 'ghost', size: 'sm', label: t('studio.restore.drop'), action: 'studio:dropRestored', id: 'studio-restore-drop' })}
                        </span>
                    </div>
                </div>
            `);
        }
        if (this.undo) {
            out.push(html`
                <div class="studio-callout studio-undo" role="status">
                    <i data-lucide="undo-2" aria-hidden="true"></i>
                    <div class="studio-callout-body studio-callout-row">
                        <p>${this.undo.message}</p>
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'undo-2', label: t('studio.undo.button'), action: 'studio:undo', id: 'studio-undo' })}
                    </div>
                </div>
            `);
        }
        return out;
    },

    previewTabButton(tab, icon, label) {
        return this.segButton({
            id: `studio-preview-${tab}`, action: 'studio:previewTab', data: `data-tab="${tab}"`,
            icon, label, pressed: this.previewTab === tab,
        });
    },

    slideCount() {
        const slides = this.work && this.work.carousel && Array.isArray(this.work.carousel.slides) ? this.work.carousel.slides : null;
        if (slides) return slides.length;
        const render = this.draft && this.draft.render;
        return render && Array.isArray(render.ig) && render.ig.length ? render.ig.length : this.SLIDES_DEFAULT;
    },

    clampSlide(i) {
        const n = this.slideCount();
        return Math.min(Math.max(0, Math.round(Number(i)) || 0), Math.max(0, n - 1));
    },

    renderedUrls(tab) {
        const render = (this.draft && this.draft.render) || {};
        return (Array.isArray(render[tab]) ? render[tab] : []).map((u) => safeUrl(u));
    },

    previewsMarkup() {
        const tab = this.previewTab === 'tt' ? 'tt' : 'ig';
        const urls = this.renderedUrls(tab);
        const count = this.slideCount();
        const i = this.clampSlide(this.selectedSlide);
        return html`
            <div class="studio-section-head">
                <h2 class="studio-panel-title" id="studio-previews-title">${t('studio.preview.title')}</h2>
                <div class="segmented studio-seg" role="group" aria-label="${t('studio.preview.format')}">
                    ${this.previewTabButton('ig', 'instagram', t('studio.preview.ig'))}
                    ${this.previewTabButton('tt', 'music-2', t('studio.preview.tt'))}
                </div>
            </div>
            ${this.phoneMarkup(tab, urls, i, count)}
            <p class="sr-only" id="studio-slide-live" aria-live="polite">${t('studio.preview.slide', { n: i + 1, total: count })}</p>
            ${this.railMarkup(tab, urls, i, count)}
            <div id="studio-render-state" class="studio-render-state">${this.renderStateMarkup()}</div>
            ${this.readOnly() || !this.work || !this.work.carousel ? '' : this.addSlideMarkup()}
        `;
    },

    /** The slide as a follower will see it: the platform's frame, the render, and the caption's start. */
    phoneMarkup(tab, urls, i, count) {
        const d = this.draft || {};
        const busy = this.isBusyStatus(d.status);
        const url = urls[i] || '';
        const slide = this.work && this.work.carousel ? this.work.carousel.slides[i] : null;
        const stale = !!url && (busy || this.isDirty());
        const platform = tab === 'tt' ? t('studio.preview.tt') : t('studio.preview.ig');
        const brand = (this.settings && this.settings.brand && this.settings.brand.name) || '';
        const caps = (this.work && this.work.carousel && this.work.carousel.captions) || {};
        const lang = this.contentLang();
        const line = String((tab === 'tt' ? caps.tiktokTitle : caps.instagram) || '').split('\n')[0];
        const stage = url
            ? html`<img src="${url}" alt="${t('studio.preview.slideAlt', { n: i + 1, total: count, kind: this.kindLabel(slide && slide.kind) })}" decoding="async">`
            : this.wireframeMarkup(slide, busy);
        return html`
            <div class="phone phone--${tab}" id="studio-phone">
                ${tab === 'ig' ? html`
                    <div class="phone-bar" aria-hidden="true">
                        <span class="phone-avatar"></span>
                        <span class="phone-handle" dir="auto">${brand}</span>
                    </div>
                ` : ''}
                <div class="phone-stage${stale ? html.raw(' is-stale') : ''}" tabindex="0" role="group"
                     aria-roledescription="${t('studio.preview.carousel')}"
                     aria-label="${t('studio.preview.stageLabel', { platform, n: i + 1, total: count })}"
                     aria-describedby="studio-stage-hint" data-action="studio:editSlide" data-slide="${i}">
                    ${stage}
                    ${stale ? html`<span class="phone-badge">${busy ? t('studio.preview.drawing') : t('studio.preview.lastRender')}</span>` : ''}
                </div>
                <p class="sr-only" id="studio-stage-hint">${t('studio.preview.stageHint')}</p>
                <div class="phone-nav">
                    <button type="button" class="icon-btn" id="studio-prev-slide" data-action="studio:prevSlide"
                            aria-label="${t('studio.preview.prev')}" title="${t('studio.preview.prev')}" ${i === 0 ? html.raw('disabled') : ''}>
                        <i data-lucide="chevron-left" aria-hidden="true"></i>
                    </button>
                    <span class="phone-count" aria-hidden="true">${UI.ltr(`${UI.formatNumber(i + 1)}/${UI.formatNumber(count)}`)}</span>
                    <button type="button" class="icon-btn" id="studio-next-slide" data-action="studio:nextSlide"
                            aria-label="${t('studio.preview.next')}" title="${t('studio.preview.next')}" ${i >= count - 1 ? html.raw('disabled') : ''}>
                        <i data-lucide="chevron-right" aria-hidden="true"></i>
                    </button>
                </div>
                ${line ? html`<p class="phone-caption user-content" dir="auto" lang="${lang}">${tab === 'ig' && brand ? html`<strong dir="auto">${brand}</strong> ` : ''}${line}</p>` : ''}
            </div>
        `;
    },

    /** No render yet: the slide's kind and its words, so the operator can still read what is on it. */
    wireframeMarkup(slide, busy) {
        const s = slide || {};
        const words = s.title || s.value || s.promise || s.label || '';
        return html`
            <div class="phone-wire${busy ? html.raw(' is-busy') : ''}">
                ${busy ? html`<span class="skel skel-block" aria-hidden="true"></span>` : ''}
                <span class="phone-wire-kind">${this.kindLabel(s.kind)}</span>
                ${words ? html`<span class="phone-wire-title user-content" dir="auto" lang="${this.contentLang()}">${words}</span>` : ''}
            </div>
        `;
    },

    /**
     * The slides as tabs: each one selects its form and its preview. One tab stop;
     * the arrow keys move along the rail in the reading direction.
     */
    railMarkup(tab, urls, i, count) {
        const slides = this.work && this.work.carousel ? this.work.carousel.slides : [];
        const busy = this.isBusyStatus(this.draft && this.draft.status);
        const items = [];
        for (let k = 0; k < count; k++) {
            const slide = slides[k] || null;
            const url = urls[k] || '';
            const selected = k === i;
            const flagged = !!(this.problems && (this.problems.slides.get(k) || []).length);
            let thumb;
            if (url) thumb = html`<img src="${url}" alt="" loading="lazy" decoding="async">`;
            else if (busy) thumb = html`<span class="skel skel-block"></span>`;
            else thumb = html`<span class="rail-wire">${this.kindLabel(slide && slide.kind)}</span>`;
            const name = t('studio.rail.tab', { n: k + 1, kind: this.kindLabel(slide && slide.kind) });
            items.push(html`
                <li class="rail-item" role="presentation">
                    <button type="button" role="tab" class="rail-tab${selected ? html.raw(' is-selected') : ''}${flagged ? html.raw(' has-problems') : ''}"
                            id="st-${k}-tab" aria-selected="${selected ? 'true' : 'false'}" aria-controls="st-${k}"
                            tabindex="${selected ? '0' : '-1'}" data-action="studio:selectSlide" data-slide="${k}"
                            aria-label="${flagged ? t('studio.rail.tabProblems', { name }) : name}">
                        ${thumb}
                        <span class="slide-num" aria-hidden="true">${UI.formatNumber(k + 1)}</span>
                        ${flagged ? html`<span class="rail-flag" aria-hidden="true"></span>` : ''}
                    </button>
                </li>
            `);
        }
        return html`<ol class="slide-rail slide-rail--${tab}" role="tablist" aria-label="${t('studio.rail.label')}">${items}</ol>`;
    },

    addSlideMarkup() {
        const total = this.slideCount();
        return html`
            <div class="studio-add-slide">
                <label class="sr-only" for="studio-add-kind">${t('studio.slides.addKind')}</label>
                <select class="select" id="studio-add-kind">
                    ${this.SLIDE_KINDS.filter((k) => k !== 'cover' && k !== 'cta').map((k) => html`<option value="${k}" ${k === 'point' ? html.raw('selected') : ''}>${this.kindLabel(k)}</option>`)}
                </select>
                ${UI.button({
                    variant: 'secondary', size: 'sm', icon: 'plus', label: t('studio.slides.add'),
                    action: 'studio:addSlide', id: 'studio-add-slide', disabled: total >= this.SLIDES_MAX,
                    title: total >= this.SLIDES_MAX ? t('studio.slides.full', { max: this.SLIDES_MAX }) : '',
                })}
            </div>
        `;
    },

    /**
     * What the render is waiting on, from what the status can tell: the Mac is
     * off, the job is queued, or it is being drawn. The elapsed time sits outside
     * the live region, so it is shown every second and announced never.
     */
    renderStateMarkup() {
        const d = this.draft || {};
        const render = d.render || {};
        if (d.status === 'rendering') {
            const s = this.status || {};
            const worker = s.worker || {};
            const jobs = s.jobs || {};
            const offline = !!this.status && worker.online !== true;
            let text = t('studio.preview.rendering');
            if (offline) text = t('studio.preview.waitingForMac');
            else if ((Number(jobs.claimed) || 0) > 0) text = t('studio.render.drawing', { name: worker.name || t('studio.render.theWorker') });
            const since = Date.parse(d.updated_at || '');
            const elapsed = Number.isFinite(since) ? Math.max(0, (Date.now() - since) / 1000) : 0;
            return html`
                <div class="studio-render-line${offline ? html.raw(' is-warning') : ''}">
                    <span class="spinner spinner-sm" aria-hidden="true"></span>
                    <span role="status">${text}</span>
                    <span class="studio-render-clock" id="studio-render-elapsed" aria-hidden="true">${this.clock(elapsed)}</span>
                </div>
                ${offline ? html`
                    <p class="form-hint">${t('studio.render.offlineHint')}</p>
                    <div class="row row--wrap gap-2">
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('studio.worker.retry'), action: 'studio:retryWorker', id: 'studio-render-retry' })}
                    </div>
                ` : ''}
            `;
        }
        if (d.status === 'generating') {
            return html`<p class="studio-progress" role="status"><span class="spinner spinner-sm" aria-hidden="true"></span> ${t('studio.preview.generating')}</p>`;
        }
        if (render.rendered_at) {
            return html`
                <p class="text-meta">
                    ${t('studio.preview.renderedAt', { when: UI.relativeAge(render.rendered_at).text })}
                    ${this.isDirty() ? html`<span class="text-warning"> ${t('studio.preview.stale')}</span>` : ''}
                </p>
            `;
        }
        return html`<p class="studio-empty-note">${t('studio.preview.none')}</p>`;
    },

    /** One second at a time while a render runs; nothing otherwise. */
    syncRenderTicker() {
        const rendering = !!(this.draft && this.draft.status === 'rendering');
        if (!rendering) { this.stopRenderTicker(); return; }
        if (this._renderTimer) return;
        this._renderTimer = setInterval(() => {
            const el = document.getElementById('studio-render-elapsed');
            if (!el || !this.draft || this.draft.status !== 'rendering') { this.stopRenderTicker(); return; }
            const since = Date.parse(this.draft.updated_at || '');
            el.textContent = this.clock(Number.isFinite(since) ? Math.max(0, (Date.now() - since) / 1000) : 0);
        }, 1000);
    },

    /**
     * Swipe on the preview: the pointer, not a scroll, so the direction is the
     * document's — in Arabic the next slide is to the left, as it is in the
     * rendered carousel's own "swipe" hint.
     */
    wirePreview() {
        const stage = document.querySelector && document.querySelector('.phone-stage');
        if (!stage || stage.dataset.wired === '1' || typeof stage.addEventListener !== 'function') return;
        stage.dataset.wired = '1';
        let start = null;
        stage.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY }; });
        stage.addEventListener('pointercancel', () => { start = null; });
        stage.addEventListener('pointerup', (e) => {
            if (!start) return;
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            start = null;
            if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
            StudioPage._swiped = true;
            const forward = StudioPage.isRtl() ? dx > 0 : dx < 0;
            StudioPage.selectSlide(StudioPage.selectedSlide + (forward ? 1 : -1), { focus: 'stage' });
        });
    },
    _swiped: false,

    /** The accent sits by the preview it colours: the palette as swatches, or any hex. */
    lookMarkup() {
        if (!this.work || !this.work.carousel) return '';
        const accent = String(this.work.carousel.accent || '').toUpperCase();
        const problems = this.fieldProblems('accent');
        const ro = this.readOnly();
        const palette = this.palette();
        return html`
            <div class="form-group studio-accent-row">
                <span class="form-label" id="st-accent-label">${t('studio.new.accent')}</span>
                ${palette.length ? html`
                    <ul class="swatch-row" role="group" aria-labelledby="st-accent-label">
                        ${palette.map((hex) => html`
                            <li>
                                <button type="button" class="swatch-btn" data-action="studio:accentSwatch" data-hex="${hex}"
                                        aria-pressed="${hex === accent ? 'true' : 'false'}" aria-label="${t('studio.new.accentUse', { hex })}"
                                        title="${hex}" ${ro ? html.raw('disabled') : ''}>
                                    <span class="swatch-dot" data-color="${hex}"></span>
                                </button>
                            </li>
                        `)}
                    </ul>
                ` : ''}
                <div class="field-row">
                    <label class="sr-only" for="st-accent">${t('studio.new.accentCustom')}</label>
                    <input class="field field-mono" id="st-accent" dir="ltr" maxlength="7" spellcheck="false" autocomplete="off"
                           value="${accent}" data-input="studio:accentField" data-picker="st-accent-picker"
                           ${ro ? html.raw('disabled') : ''}
                           ${problems.length ? html.raw('aria-invalid="true" aria-describedby="st-accent-problems"') : ''}>
                    <input type="color" class="studio-color" id="st-accent-picker"
                           value="${this.ACCENT_RE.test(accent) ? accent.toLowerCase() : this.paletteStart()}"
                           data-input="studio:accentFieldPicked" data-target="st-accent"
                           aria-label="${t('studio.new.accentPick')}" title="${t('studio.new.accentPick')}" ${ro ? html.raw('disabled') : ''}>
                </div>
                ${problems.length ? this.problemListMarkup('st-accent-problems', problems) : ''}
                <p class="form-hint">${t('studio.look.hint')}</p>
            </div>
        `;
    },

    // ─── Editor: slides ──────────────────────────────────────────────────────
    SLIDE_KINDS: Object.freeze(['cover', 'point', 'list', 'compare', 'steps', 'prompt', 'stat', 'shot', 'cta']),

    kindLabel(kind) {
        return this.SLIDE_KINDS.includes(kind) ? t(`studio.kind.${kind}`) : String(kind || '');
    },

    /** `st-3-items-0-text`: stable per slide index and path, so focus survives a repaint. */
    fieldId(index, path) {
        return `st-${index}-${String(path).replace(/\./g, '-')}`;
    },

    getPath(obj, path) {
        return String(path).split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), obj);
    },

    /** Write `value` at `path`; `undefined` removes an object key (an emptied optional field). */
    setPath(obj, path, value) {
        const keys = String(path).split('.');
        let node = obj;
        for (let k = 0; k < keys.length - 1; k++) {
            const key = keys[k];
            if (node[key] === null || typeof node[key] !== 'object') node[key] = /^\d+$/.test(keys[k + 1]) ? [] : {};
            node = node[key];
        }
        const last = keys[keys.length - 1];
        if (value === undefined && !Array.isArray(node)) delete node[last];
        else node[last] = value === undefined ? '' : value;
    },

    /** Problems filed under a slide and path, marked as shown so the card does not list them twice. */
    claim(ctx, path) {
        const list = this.problems ? (this.problems.slides.get(ctx.index) || []) : [];
        const mine = list.filter((p) => p.target && p.target.path === path);
        mine.forEach((p) => ctx.claimed.add(p.id));
        return mine;
    },

    fieldProblems(key) {
        return this.problems ? (this.problems.fields.get(key) || []) : [];
    },

    problemListMarkup(id, problems) {
        return html`
            <ul class="problem-list" id="${id}">
                ${problems.map((p) => html`<li dir="auto">${p.message}</li>`)}
            </ul>
        `;
    },

    /** The kinds a middle slide can be switched between. The cover opens and the CTA closes, always. */
    CONTENT_KINDS: Object.freeze(['point', 'list', 'compare', 'steps', 'prompt', 'stat', 'shot']),

    /**
     * Every slide's form is in the page, and only the chosen one is shown: a problem
     * can point at a field on any slide, and typing is never lost to a hidden repaint.
     */
    slidesMarkup() {
        const slides = this.work.carousel.slides;
        const total = slides.length;
        const outside = total < this.SLIDES_MIN || total > this.SLIDES_MAX;
        const general = this.fieldProblems('slides');
        const i = this.clampSlide(this.selectedSlide);
        return html`
            <div class="studio-section-head">
                <h2 class="studio-panel-title" id="studio-slides-title">${t('studio.slides.title')}</h2>
                <span class="field-count${outside ? html.raw(' is-warning') : ''}">${this.countMarkup(total, this.SLIDES_MAX)}</span>
            </div>
            <p class="form-hint">${t('studio.slides.rule', { min: this.SLIDES_MIN, max: this.SLIDES_MAX })}</p>
            ${general.length ? this.problemListMarkup('studio-slides-problems', general) : ''}
            <div class="slide-cards">
                ${slides.map((slide, k) => this.slideCardMarkup(slide, k, total, k === i))}
            </div>
        `;
    },

    slideCardMarkup(slide, i, total, visible) {
        const ro = this.readOnly();
        const claimed = new Set();
        const ctx = { slide: slide || {}, index: i, claimed, ro };
        const body = this.slideBodyMarkup(ctx);
        const all = this.problems ? (this.problems.slides.get(i) || []) : [];
        const rest = all.filter((p) => !claimed.has(p.id));
        const n = i + 1;
        const kind = ctx.slide.kind;
        const fixed = kind === 'cover' || kind === 'cta';
        const earlier = t('studio.slides.moveUp', { n });
        const later = t('studio.slides.moveDown', { n });
        const copy = t('studio.slides.duplicateN', { n });
        const remove = t('studio.slides.delete', { n });
        const copyOff = fixed || total >= this.SLIDES_MAX;
        return html`
            <div class="slide-card${all.length ? html.raw(' has-problems') : ''}" id="st-${i}" role="tabpanel" tabindex="-1"
                 aria-labelledby="st-${i}-name"${visible ? '' : html.raw(' hidden')}>
                <div class="slide-card-head">
                    <span class="slide-card-num" aria-hidden="true">${UI.formatNumber(n)}</span>
                    <h3 class="slide-card-name" id="st-${i}-name">${t('studio.slides.cardName', { n, kind: this.kindLabel(kind) })}</h3>
                    ${ro ? '' : html`
                        <div class="slide-card-actions">
                            <!-- Earlier and later, along the rail: the arrows point the reading
                                 direction's way (mirrored in Arabic by the RTL icon rule). -->
                            <button type="button" class="icon-btn" id="st-${i}-up" data-action="studio:moveSlide" data-slide="${i}" data-dir="-1"
                                    aria-label="${earlier}" title="${earlier}" ${i === 0 ? html.raw('disabled') : ''}>
                                <i data-lucide="arrow-left" aria-hidden="true"></i>
                            </button>
                            <button type="button" class="icon-btn" id="st-${i}-down" data-action="studio:moveSlide" data-slide="${i}" data-dir="1"
                                    aria-label="${later}" title="${later}" ${i === total - 1 ? html.raw('disabled') : ''}>
                                <i data-lucide="arrow-right" aria-hidden="true"></i>
                            </button>
                            <button type="button" class="icon-btn" id="st-${i}-copy" data-action="studio:duplicateSlide" data-slide="${i}"
                                    aria-label="${copy}" title="${fixed ? t('studio.slides.cantDuplicate') : copy}" ${copyOff ? html.raw('disabled') : ''}>
                                <i data-lucide="copy" aria-hidden="true"></i>
                            </button>
                            ${UI.button({
                                variant: 'ghost', size: 'sm', icon: 'sparkles', label: t('studio.slides.rewrite'),
                                action: 'studio:openRewrite', data: { slide: i }, id: `st-${i}-rewrite`,
                                ariaLabel: t('studio.slides.rewriteN', { n }),
                            })}
                            <button type="button" class="icon-btn icon-btn-danger" id="st-${i}-delete" data-action="studio:deleteSlide" data-slide="${i}"
                                    aria-label="${remove}" title="${remove}" ${total <= 1 ? html.raw('disabled') : ''}>
                                <i data-lucide="trash-2" aria-hidden="true"></i>
                            </button>
                        </div>
                    `}
                </div>
                ${ro || fixed ? '' : html`
                    <div class="form-group slide-kind-row">
                        <label class="form-label" for="st-${i}-kind">${t('studio.slides.kind')}</label>
                        <select class="select" id="st-${i}-kind" data-change="studio:changeKind" data-slide="${i}" aria-describedby="st-${i}-kind-hint">
                            ${this.withCurrent(this.CONTENT_KINDS, kind).map((k) => html`<option value="${k}" ${k === kind ? html.raw('selected') : ''}>${this.kindLabel(k)}</option>`)}
                        </select>
                        <p class="form-hint" id="st-${i}-kind-hint">${t('studio.slides.kindHint')}</p>
                    </div>
                `}
                <div class="slide-card-body">${body}</div>
                ${rest.length ? this.problemListMarkup(`st-${i}-problems`, rest) : ''}
            </div>
        `;
    },

    /** "Slide 3 · List": where a problem is, before the validator's own words. */
    problemWhere(problem) {
        const target = problem && problem.target;
        if (!target) return '';
        if (typeof target.slide === 'number') {
            const slide = this.work && this.work.carousel ? this.work.carousel.slides[target.slide] : null;
            return t('studio.problems.onSlide', { n: target.slide + 1, kind: this.kindLabel(slide && slide.kind) });
        }
        const where = {
            'captions.instagram': 'studio.captions.instagram',
            'captions.tiktokTitle': 'studio.captions.tiktokTitle',
            'captions.tiktok': 'studio.captions.tiktok',
            accent: 'studio.new.accent',
            keyword: 'studio.campaign.keyword',
            slides: 'studio.slides.title',
        }[target.field];
        return where ? t(where) : '';
    },

    /** Every problem the server named, each with the way to it. Slides on other tabs included. */
    problemsMarkup() {
        const p = this.problems;
        if (!p || !p.all.length) return '';
        return html`
            <div class="studio-problems" id="studio-problems-box" tabindex="-1" role="alert" aria-labelledby="studio-problems-title">
                <p class="studio-problems-title" id="studio-problems-title">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    ${t('studio.problems.title', { n: UI.formatNumber(p.all.length) })}
                </p>
                <ul class="problem-list">
                    ${p.all.map((x) => {
                        const where = this.problemWhere(x);
                        return html`
                            <li>
                                <span class="problem-text">
                                    ${where ? html`<strong class="problem-where">${where}</strong>` : ''}
                                    <span class="problem-raw" dir="auto">${x.message}</span>
                                </span>
                                ${this.problemFocusId(x) ? UI.button({
                                    variant: 'ghost', size: 'sm', label: t('studio.problems.show'),
                                    action: 'studio:focusProblem', data: { problem: x.id },
                                }) : ''}
                            </li>
                        `;
                    })}
                </ul>
            </div>
        `;
    },

    /**
     * One form per slide kind. The budgets are the design's hard limits, from the
     * comments in aicourse-captions' carousel/types.ts; `0` means "no budget".
     */
    slideBodyMarkup(ctx) {
        const f = (path, labelKey, max, opts) => this.textField(ctx, { path, label: t(labelKey), max, ...(opts || {}) });
        switch (ctx.slide.kind) {
            case 'cover': return html`
                ${f('kicker', 'studio.field.kicker', 24, { optional: true })}
                ${f('title', 'studio.field.title', 34)}
                ${f('highlight', 'studio.field.highlight', 0, { optional: true, hint: t('studio.field.highlightHint') })}
                ${f('subtitle', 'studio.field.subtitle', 70, { optional: true, multiline: true, rows: 2 })}
                ${this.shotField(ctx, false)}
            `;
            case 'point': return html`
                ${f('n', 'studio.field.n', 0, { optional: true, int: true, hint: t('studio.field.nHint') })}
                ${f('title', 'studio.field.title', 40)}
                ${f('body', 'studio.field.body', 150, { optional: true, multiline: true })}
                ${f('tip', 'studio.field.tip', 70, { optional: true })}
                ${this.shotField(ctx, false)}
            `;
            case 'list': return html`
                ${f('title', 'studio.field.title', 36)}
                ${this.itemsEditor(ctx, {
                    path: 'items', min: 3, max: 5, label: t('studio.field.items'),
                    fields: [
                        { key: 'icon', labelKey: 'studio.field.icon', max: 0, optional: true, short: true },
                        { key: 'text', labelKey: 'studio.field.text', max: 36 },
                        { key: 'sub', labelKey: 'studio.field.sub', max: 60, optional: true },
                    ],
                })}
            `;
            case 'compare': return html`
                ${f('title', 'studio.field.title', 36, { optional: true })}
                ${this.compareEditor(ctx)}
            `;
            case 'steps': return html`
                ${f('title', 'studio.field.title', 36)}
                ${this.itemsEditor(ctx, {
                    path: 'steps', min: 3, max: 4, label: t('studio.field.steps'),
                    fields: [
                        { key: 'title', labelKey: 'studio.field.stepTitle', max: 28 },
                        { key: 'body', labelKey: 'studio.field.body', max: 70, optional: true },
                    ],
                })}
            `;
            case 'prompt': return html`
                ${f('title', 'studio.field.title', 36)}
                ${f('label', 'studio.field.promptLabel', 20, { optional: true })}
                ${f('prompt', 'studio.field.prompt', 320, { multiline: true, rows: 6, hint: t('studio.field.promptHint') })}
                ${f('note', 'studio.field.note', 70, { optional: true })}
            `;
            case 'stat': return html`
                ${f('value', 'studio.field.value', 8)}
                ${f('label', 'studio.field.statLabel', 40)}
                ${f('body', 'studio.field.body', 120, { optional: true, multiline: true, rows: 2 })}
            `;
            case 'shot': return html`
                ${f('title', 'studio.field.title', 40)}
                ${this.shotField(ctx, true)}
                ${f('caption', 'studio.field.caption', 90, { optional: true })}
            `;
            case 'cta': return html`
                ${f('promise', 'studio.field.promise', 40, { optional: true })}
                <p class="form-hint">${t('studio.field.ctaHint')}</p>
            `;
            default:
                return html`<p class="form-hint">${t('studio.slides.unknownKind', { kind: String(ctx.slide.kind || '') })}</p>`;
        }
    },

    textField(ctx, o) {
        const id = this.fieldId(ctx.index, o.path);
        const raw = this.getPath(ctx.slide, o.path);
        const value = raw === undefined || raw === null ? '' : String(raw);
        const problems = this.claim(ctx, o.path);
        const invalid = problems.length > 0;
        const described = [o.max ? `${id}-count` : '', o.hint ? `${id}-hint` : '', invalid ? `${id}-problems` : '']
            .filter(Boolean).join(' ');
        const lang = this.contentLang();
        const attrs = html` id="${id}" data-input="studio:slideField" data-slide="${ctx.index}" data-path="${o.path}"${o.optional ? html.raw(' data-optional="1"') : ''}${o.int ? html.raw(' data-kind="int"') : ''}${ctx.ro ? html.raw(' disabled') : ''}${invalid ? html.raw(' aria-invalid="true"') : ''}${described ? html` aria-describedby="${described}"` : ''}`;
        let control;
        if (o.multiline) {
            control = html`<textarea class="field-textarea user-content" rows="${o.rows || 3}" dir="auto" lang="${lang}"${attrs}>${value}</textarea>`;
        } else if (o.int) {
            control = html`<input class="field studio-field-num" type="number" inputmode="numeric" min="1" max="99" value="${value}"${attrs}>`;
        } else {
            control = html`<input class="field user-content${o.short ? html.raw(' studio-field-short') : ''}" dir="auto" lang="${lang}" value="${value}"${attrs}>`;
        }
        return html`
            <div class="form-group studio-field">
                <div class="field-head">
                    <label class="form-label" for="${id}">
                        ${o.label}${o.optional ? html` <span class="label-optional">${t('common.optional')}</span>` : ''}
                    </label>
                    ${o.max ? html`<span class="field-count${value.length > o.max ? html.raw(' is-warning') : ''}" id="${id}-count" data-max="${o.max}">${this.countMarkup(value.length, o.max)}</span>` : ''}
                </div>
                ${control}
                ${o.hint ? html`<p class="form-hint" id="${id}-hint">${o.hint}</p>` : ''}
                ${invalid ? this.problemListMarkup(`${id}-problems`, problems) : ''}
            </div>
        `;
    },

    /** A list of 3–5 items (list), or 3–4 steps: one row per item, add and remove at the limits. */
    itemsEditor(ctx, o) {
        const list = Array.isArray(this.getPath(ctx.slide, o.path)) ? this.getPath(ctx.slide, o.path) : [];
        const problems = this.claim(ctx, o.path);
        const outside = list.length < o.min || list.length > o.max;
        const listId = this.fieldId(ctx.index, o.path);
        return html`
            <fieldset class="fieldset-plain studio-items" id="${listId}" tabindex="-1">
                <legend class="field-head studio-items-head">
                    <span class="form-label">${o.label}</span>
                    <span class="field-count${outside ? html.raw(' is-warning') : ''}">${this.countMarkup(list.length, o.max)}</span>
                </legend>
                <ol class="studio-item-list">
                    ${list.map((item, k) => html`
                        <li class="studio-item">
                            <span class="studio-item-num" aria-hidden="true">${UI.formatNumber(k + 1)}</span>
                            <div class="studio-item-fields">
                                ${o.fields.map((field) => this.textField(ctx, {
                                    path: `${o.path}.${k}.${field.key}`,
                                    label: t('studio.items.fieldLabel', { n: k + 1, field: t(field.labelKey) }),
                                    max: field.max, optional: field.optional, short: field.short,
                                }))}
                            </div>
                            ${ctx.ro ? '' : html`
                                <button type="button" class="icon-btn icon-btn-danger" data-action="studio:removeItem"
                                        data-slide="${ctx.index}" data-path="${o.path}" data-item="${k}"
                                        data-focus-key="${listId}-remove-${k}"
                                        aria-label="${t('studio.items.remove', { n: k + 1 })}" title="${t('studio.items.remove', { n: k + 1 })}"
                                        ${list.length <= o.min ? html.raw('disabled') : ''}>
                                    <i data-lucide="x" aria-hidden="true"></i>
                                </button>
                            `}
                        </li>
                    `)}
                </ol>
                ${ctx.ro ? '' : UI.button({
                    variant: 'ghost', size: 'sm', icon: 'plus', label: t('studio.items.add'),
                    action: 'studio:addItem', data: { slide: ctx.index, path: o.path }, id: `${listId}-add`,
                    disabled: list.length >= o.max,
                })}
                ${problems.length ? this.problemListMarkup(`${listId}-problems`, problems) : ''}
            </fieldset>
        `;
    },

    /**
     * Old way against new way, as rows: each row is one item on each side, so the
     * two sides are the same length by construction — the rule the design needs.
     */
    compareEditor(ctx) {
        const slide = ctx.slide;
        const left = slide.left && Array.isArray(slide.left.items) ? slide.left.items : [];
        const right = slide.right && Array.isArray(slide.right.items) ? slide.right.items : [];
        const rows = Math.max(left.length, right.length);
        const problems = [...this.claim(ctx, 'left.items'), ...this.claim(ctx, 'right.items'), ...this.claim(ctx, '')];
        const listId = this.fieldId(ctx.index, 'rows');
        const outside = rows < 2 || rows > 4;
        const rowMarkup = [];
        for (let k = 0; k < rows; k++) {
            rowMarkup.push(html`
                <li class="studio-item studio-item--compare">
                    <span class="studio-item-num" aria-hidden="true">${UI.formatNumber(k + 1)}</span>
                    <div class="studio-item-fields studio-compare-row">
                        ${this.textField(ctx, { path: `left.items.${k}`, label: t('studio.compare.leftItem', { n: k + 1 }), max: 30 })}
                        ${this.textField(ctx, { path: `right.items.${k}`, label: t('studio.compare.rightItem', { n: k + 1 }), max: 30 })}
                    </div>
                    ${ctx.ro ? '' : html`
                        <button type="button" class="icon-btn icon-btn-danger" data-action="studio:removeItem"
                                data-slide="${ctx.index}" data-path="rows" data-item="${k}" data-focus-key="${listId}-remove-${k}"
                                aria-label="${t('studio.items.remove', { n: k + 1 })}" title="${t('studio.items.remove', { n: k + 1 })}"
                                ${rows <= 2 ? html.raw('disabled') : ''}>
                            <i data-lucide="x" aria-hidden="true"></i>
                        </button>
                    `}
                </li>
            `);
        }
        return html`
            <div class="studio-compare-labels">
                ${this.textField(ctx, { path: 'left.label', label: t('studio.compare.leftLabel'), max: 16 })}
                ${this.textField(ctx, { path: 'right.label', label: t('studio.compare.rightLabel'), max: 16 })}
            </div>
            <fieldset class="fieldset-plain studio-items" id="${listId}" tabindex="-1">
                <legend class="field-head studio-items-head">
                    <span class="form-label">${t('studio.compare.rows')}</span>
                    <span class="field-count${outside ? html.raw(' is-warning') : ''}">${this.countMarkup(rows, 4)}</span>
                </legend>
                <ol class="studio-item-list">${rowMarkup}</ol>
                ${ctx.ro ? '' : UI.button({
                    variant: 'ghost', size: 'sm', icon: 'plus', label: t('studio.compare.addRow'),
                    action: 'studio:addItem', data: { slide: ctx.index, path: 'rows' }, id: `${listId}-add`,
                    disabled: rows >= 4,
                })}
                ${problems.length ? this.problemListMarkup(`${listId}-problems`, problems) : ''}
            </fieldset>
        `;
    },

    shotField(ctx, required) {
        const i = ctx.index;
        const shot = ctx.slide.shot;
        const name = shot && shot.name ? String(shot.name) : '';
        const spec = name && this.work.shots ? this.work.shots[name] : null;
        const problems = this.claim(ctx, 'shot');
        return html`
            <div class="form-group studio-field">
                <span class="form-label" id="st-${i}-shot-label">
                    ${t('studio.shot.label')}${required ? '' : html` <span class="label-optional">${t('common.optional')}</span>`}
                </span>
                <div class="shot-field${problems.length ? html.raw(' is-invalid') : ''}" role="group" aria-labelledby="st-${i}-shot-label">
                    <span class="shot-thumb" id="st-${i}-shot-thumb">${name ? this.shotThumbMarkup(name) : html`<i data-lucide="image-off" aria-hidden="true"></i>`}</span>
                    <div class="shot-info">
                        <span dir="auto">${spec && spec.desc ? spec.desc : (name || t('studio.shot.none'))}</span>
                        ${spec && spec.t !== undefined ? html`<span class="text-meta">${UI.ltr(this.clock(spec.t))}</span>` : ''}
                        ${ctx.ro ? '' : html`
                            <div class="row row--wrap gap-2">
                                ${UI.button({
                                    variant: 'secondary', size: 'sm', icon: 'image',
                                    label: name ? t('studio.shot.change') : t('studio.shot.pick'),
                                    action: 'studio:openShots', data: { slide: i }, id: `st-${i}-shot-change`,
                                })}
                                ${!required && name ? UI.button({
                                    variant: 'ghost', size: 'sm', icon: 'x', label: t('studio.shot.remove'),
                                    action: 'studio:removeShot', data: { slide: i }, id: `st-${i}-shot-remove`,
                                }) : ''}
                            </div>
                        `}
                    </div>
                </div>
                ${problems.length ? this.problemListMarkup(`st-${i}-shot-problems`, problems) : ''}
            </div>
        `;
    },

    // ─── Editor: captions, campaign, save bar ────────────────────────────────
    /**
     * The caption lines a tenant's settings require (STUDIO.md §10.3): the IG
     * caption carries `cta.instagramAsk` with the keyword filled in, the TikTok
     * caption carries `cta.tiktokLine`. Without settings, the IG check falls back
     * to the keyword itself and the TikTok check is left to the server.
     */
    requiredLines() {
        const cta = this.settings && this.settings.cta;
        const keyword = String((this.work && this.work.carousel && this.work.carousel.keyword) || '');
        const ask = cta && typeof cta.instagramAsk === 'string' && cta.instagramAsk.trim()
            ? cta.instagramAsk.split('{keyword}').join(keyword)
            : keyword;
        const tiktok = cta && typeof cta.tiktokLine === 'string' ? cta.tiktokLine.trim() : '';
        return { ig: ask, tt: tiktok };
    },

    /** "Contains …" or "Must contain …", as the caption stands right now. */
    lineCheck(caption, line) {
        if (!line) return null;
        const ok = String(caption || '').includes(line);
        return { ok, line };
    },

    lineCheckMarkup(id, check) {
        if (!check) return html`<p class="form-hint" id="${id}"></p>`;
        return html`
            <p class="form-hint ${check.ok ? html.raw('text-success') : html.raw('text-warning')}" id="${id}">
                <i data-lucide="${check.ok ? 'check-circle' : 'alert-triangle'}" aria-hidden="true"></i>
                ${check.ok ? t('studio.captions.has') : t('studio.captions.missing')}
                <span class="studio-line" dir="auto">${check.line}</span>
            </p>
        `;
    },

    CAPTION_FIELDS: Object.freeze([
        { id: 'st-cap-ig', path: 'captions.instagram', labelKey: 'studio.captions.instagram', maxKey: 'IG_CAPTION_MAX', rows: 8, check: 'ig' },
        { id: 'st-cap-tt-title', path: 'captions.tiktokTitle', labelKey: 'studio.captions.tiktokTitle', maxKey: 'TIKTOK_TITLE_MAX', rows: 0 },
        { id: 'st-cap-tt', path: 'captions.tiktok', labelKey: 'studio.captions.tiktok', maxKey: 'TIKTOK_CAPTION_MAX', rows: 5, check: 'tt' },
    ]),

    captionsMarkup() {
        const c = this.work.carousel;
        const ro = this.readOnly();
        const lines = this.requiredLines();
        const lang = this.contentLang();
        return html`
            <h2 class="studio-panel-title" id="studio-captions-title">${t('studio.captions.title')}</h2>
            ${this.CAPTION_FIELDS.map((f) => {
                const value = String(this.getPath(c, f.path) || '');
                const max = this[f.maxKey];
                const problems = this.fieldProblems(f.path);
                const described = [`${f.id}-count`, f.check ? `${f.id}-check` : '', problems.length ? `${f.id}-problems` : ''].filter(Boolean).join(' ');
                const attrs = html` id="${f.id}" dir="auto" lang="${lang}" data-input="studio:metaField" data-path="${f.path}" aria-describedby="${described}"${ro ? html.raw(' disabled') : ''}${problems.length ? html.raw(' aria-invalid="true"') : ''}`;
                return html`
                    <div class="form-group">
                        <div class="field-head">
                            <label class="form-label" for="${f.id}">${t(f.labelKey)}</label>
                            <span class="field-count${value.length > max ? html.raw(' is-warning') : ''}" id="${f.id}-count" data-max="${max}">${this.countMarkup(value.length, max)}</span>
                        </div>
                        ${f.rows
                            ? html`<textarea class="field-textarea user-content" rows="${f.rows}"${attrs}>${value}</textarea>`
                            : html`<input class="field user-content" value="${value}"${attrs}>`}
                        ${f.check ? this.lineCheckMarkup(`${f.id}-check`, this.lineCheck(value, lines[f.check])) : ''}
                        ${problems.length ? this.problemListMarkup(`${f.id}-problems`, problems) : ''}
                    </div>
                `;
            })}
        `;
    },

    campaignMarkup() {
        const campaign = this.work.campaign || {};
        const ro = this.readOnly();
        const keyword = String(this.work.carousel.keyword || campaign.keyword || '');
        const variants = Array.isArray(campaign.variants) ? campaign.variants.filter(Boolean) : [];
        const problems = this.fieldProblems('keyword');
        const lang = this.contentLang();
        return html`
            <h2 class="studio-panel-title" id="studio-campaign-title">${t('studio.campaign.title')}</h2>
            <div class="form-group">
                <label class="form-label" for="st-keyword">${t('studio.campaign.keyword')}</label>
                <input class="field user-content" id="st-keyword" dir="auto" lang="${lang}" autocomplete="off" value="${keyword}"
                       data-input="studio:keywordField" aria-describedby="st-keyword-hint${problems.length ? html.raw(' st-keyword-problems') : ''}"
                       ${ro ? html.raw('disabled') : ''} ${problems.length ? html.raw('aria-invalid="true"') : ''}>
                <p class="form-hint" id="st-keyword-hint">${t('studio.campaign.keywordHint')}</p>
                ${problems.length ? this.problemListMarkup('st-keyword-problems', problems) : ''}
                ${variants.length ? html`
                    <p class="draft-card-tags">
                        <span class="text-meta">${t('studio.campaign.variants')}</span>
                        ${variants.map((v) => html`<span class="chip" dir="auto">${v}</span>`)}
                    </p>
                ` : ''}
            </div>
            <div class="form-group">
                <label class="form-label" for="st-dm">${t('studio.campaign.dm')}</label>
                <textarea class="field-textarea user-content" id="st-dm" rows="10" dir="auto" lang="${lang}"
                          data-input="studio:campaignField" data-path="dm" aria-describedby="st-dm-hint"
                          ${ro ? html.raw('disabled') : ''}>${campaign.dm || ''}</textarea>
                <p class="form-hint" id="st-dm-hint">${t('studio.campaign.dmHint')}</p>
            </div>
            <div class="form-group switch-row">
                <label class="switch" for="st-create">
                    <span class="sr-only">${t('studio.campaign.create')}</span>
                    <input type="checkbox" id="st-create" data-change="studio:campaignToggle"
                           ${campaign.create ? html.raw('checked') : ''} ${ro ? html.raw('disabled') : ''} aria-describedby="st-create-hint">
                    <span class="switch-track"></span>
                </label>
                <span class="switch-text">
                    <span class="switch-label">${t('studio.campaign.create')}</span>
                    <span class="form-hint" id="st-create-hint">${t('studio.campaign.createHint')}</span>
                </span>
            </div>
        `;
    },

    /** "⌘S" on a Mac, "Ctrl+S" elsewhere: shown beside Save, and in its tooltip. */
    saveKeys() {
        const nav = typeof navigator !== 'undefined' ? navigator : {};
        const platform = String(nav.platform || nav.userAgent || '');
        return /Mac|iPhone|iPad/i.test(platform) ? '⌘S' : 'Ctrl+S';
    },

    /**
     * The action bar follows the operator down the page (and sits on the bottom
     * edge of a phone). It holds exactly one primary action: Save while there are
     * edits; otherwise the way to the schedule, which is the step's last action.
     */
    saveBarMarkup() {
        if (this.readOnly()) return html`<p class="text-meta">${t('studio.editor.readOnly')}</p>`;
        const dirty = this.isDirty();
        const n = this.problems ? this.problems.all.length : 0;
        const ready = !!(this.draft && this.draft.status === 'ready');
        const keys = this.saveKeys();
        return html`
            ${this.saveError ? UI.errorStrip(this.saveError, '', 'studio-save-error') : ''}
            <div class="studio-savebar-row">
                <p class="studio-dirty${dirty ? html.raw(' is-dirty') : ''}" id="studio-dirty" role="status">
                    <span class="studio-dirty-dot" aria-hidden="true"></span>
                    <span>${dirty ? t('studio.editor.unsaved') : t('studio.editor.saved')}</span>
                    ${n ? html`<span class="text-danger">· ${t('studio.problems.title', { n: UI.formatNumber(n) })}</span>` : ''}
                </p>
                <div class="studio-savebar-actions">
                    ${n ? UI.button({
                        variant: 'ghost', size: 'sm', icon: 'alert-circle', label: t('studio.problems.showFirst'),
                        action: 'studio:focusFirstProblem', id: 'studio-first-problem',
                    }) : ''}
                    ${dirty ? UI.button({
                        variant: 'ghost', size: 'sm', icon: 'rotate-ccw', label: t('studio.editor.discard'),
                        action: 'studio:discard', id: 'studio-discard',
                    }) : ''}
                    ${dirty ? html`
                        ${UI.button({
                            variant: 'primary', icon: 'save', label: t('studio.editor.save'),
                            action: 'studio:save', id: 'studio-save', title: t('studio.editor.saveShortcut', { keys }),
                        })}
                        <kbd class="studio-kbd" aria-hidden="true">${keys}</kbd>
                    ` : ready ? UI.button({
                        variant: 'secondary', icon: 'calendar-check', label: t('studio.editor.toSchedule'),
                        action: 'studio:goSchedule', id: 'studio-go-schedule',
                    }) : ''}
                </div>
            </div>
        `;
    },

    // ─── Editor: schedule ────────────────────────────────────────────────────
    /** The default slot: the one a plan proposed for this draft if it is still free, else the first free one. */
    defaultSlot() {
        const slots = Array.isArray(this.slots) ? this.slots : [];
        const planned = this.plannedSlots[String(this.draftId)];
        if (planned && slots.includes(planned)) return planned;
        return slots[0] || 'custom';
    },

    /** The tenant's own time zone (Settings → Schedule): the one its slots are written in. */
    scheduleZone() {
        const zone = this.settings && this.settings.schedule && this.settings.schedule.timezone;
        if (typeof zone === 'string' && zone) {
            try {
                new Intl.DateTimeFormat('en-US', { timeZone: zone });
                return zone;
            } catch { /* not a zone this browser knows: fall back to the device's */ }
        }
        return this.deviceZone();
    },

    deviceZone() {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
    },

    /** "Riyadh" / «الرياض»: the city part of an IANA zone, in the interface language when we have it. */
    zoneCity(zone) {
        const city = String(zone || 'UTC').split('/').pop().replace(/_/g, ' ');
        const key = `studio.city.${city.replace(/\s+/g, '')}`;
        const named = t(key);
        return named && named !== key ? named : city;
    },

    /** "Thu 25 Sep, 9:00 PM" in the tenant's zone, which is the zone the slot was chosen in. */
    zoneTime(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        try {
            return new Intl.DateTimeFormat(I18N.locale(), {
                weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: this.scheduleZone(),
            }).format(d);
        } catch {
            return UI.formatDateTime(iso);
        }
    },

    /** A slot as the picker lists it: "Thu 25 Sep, 9:00 PM · Riyadh". */
    slotOption(iso) {
        return `${this.zoneTime(iso)} · ${this.zoneCity(this.scheduleZone())}`;
    },

    /**
     * What pressing Schedule will do, in plain words, one line per destination.
     * Read from the form as it stands, so it changes with every choice.
     */
    scheduleSummary(choice) {
        const c = choice || {};
        const lines = [];
        const when = c.when ? t('studio.schedule.sumWhen', { time: this.zoneTime(c.when), city: this.zoneCity(this.scheduleZone()) }) : t('studio.schedule.sumNoTime');
        lines.push({ icon: 'instagram', text: t('studio.schedule.sumMeta', { when }) });
        if (c.tiktok === 'queue') lines.push({ icon: 'music-2', text: t('studio.schedule.sumTikTokQueue') });
        else if (c.tiktok === 'scheduled') lines.push({ icon: 'music-2', text: t('studio.schedule.sumTikTokSame', { when }) });
        else lines.push({ icon: 'music-2', text: t('studio.schedule.sumTikTokNone') });
        const keyword = String((this.work && this.work.carousel && this.work.carousel.keyword) || '').trim();
        if (keyword) {
            lines.push({
                icon: 'message-circle',
                text: c.campaign ? t('studio.schedule.sumDm', { keyword }) : t('studio.schedule.sumNoDm', { keyword }),
            });
        }
        return lines;
    },

    scheduleSummaryMarkup(choice) {
        return html`
            <p class="studio-summary-title">${t('studio.schedule.sumTitle')}</p>
            <ul class="studio-summary-list">
                ${this.scheduleSummary(choice).map((line) => html`
                    <li><i data-lucide="${line.icon}" aria-hidden="true"></i><span dir="auto">${line.text}</span></li>
                `)}
            </ul>
        `;
    },

    /** The form's current choice, for the summary; the same reading Schedule itself makes. */
    scheduleChoice() {
        const form = document.getElementById('studio-schedule-form');
        const audited = this.tiktokAudited();
        const fallback = { when: this.defaultSlot() === 'custom' ? null : this.defaultSlot(), tiktok: audited ? 'scheduled' : 'queue', campaign: !!(this.work && this.work.campaign && this.work.campaign.create) };
        if (!form || typeof FormData === 'undefined' || typeof form.querySelector !== 'function') return fallback;
        const read = this.readSchedule(form);
        if (read.ok) return { when: read.body.scheduled_time, tiktok: read.body.tiktok, campaign: read.body.create_campaign };
        const data = new FormData(form);
        return { when: null, tiktok: String(data.get('tiktok') || fallback.tiktok), campaign: data.get('create_campaign') === 'on' };
    },

    refreshScheduleSummary() {
        const choice = this.scheduleChoice();
        const host = document.getElementById('studio-schedule-summary');
        if (host) {
            host.innerHTML = esc(this.scheduleSummaryMarkup(choice));
            UI.icons(host);
        }
        const submit = document.getElementById('studio-schedule-submit');
        const label = submit ? submit.querySelector('.studio-submit-label') : null;
        if (label) label.textContent = choice.when ? t('studio.schedule.submitAt', { time: this.zoneTime(choice.when) }) : t('studio.schedule.submit');
    },

    scheduleMarkup() {
        const d = this.draft;
        if (!d) return '';
        if (d.status === 'scheduled') return this.scheduledMarkup();
        const audited = this.tiktokAudited();
        const dirty = this.isDirty();
        let blocked = '';
        if (d.status !== 'ready') blocked = t('studio.schedule.needsReady');
        else if (dirty) blocked = t('studio.schedule.saveFirst');
        const loading = this.slots === null;
        const slots = Array.isArray(this.slots) ? this.slots : [];
        const planned = this.plannedSlots[String(this.draftId)];
        const chosen = this.defaultSlot();
        const create = !!(this.work && this.work.campaign && this.work.campaign.create);
        const tiktokDefault = audited ? 'scheduled' : 'queue';
        const zone = this.scheduleZone();
        const device = this.deviceZone();
        const radio = (value, label, hint) => html`
            <label class="tiktok-delivery-option">
                <input type="radio" name="tiktok" value="${value}" ${value === tiktokDefault ? html.raw('checked') : ''}>
                <span class="check-text">
                    <span class="check-label">${label}</span>
                    <span class="form-hint">${hint}</span>
                </span>
            </label>
        `;
        const choice = { when: chosen === 'custom' ? null : chosen, tiktok: tiktokDefault, campaign: create };
        return html`
            <h2 class="studio-panel-title" id="studio-schedule-title" tabindex="-1">${t('studio.schedule.title')}</h2>
            <form id="studio-schedule-form" data-submit="studio:schedule" novalidate>
                <div class="form-group">
                    <label class="form-label" for="st-slot">${t('studio.schedule.slot')}</label>
                    <select class="select" id="st-slot" name="slot" data-change="studio:slotChange" aria-describedby="st-slot-hint" ${loading ? html.raw('disabled') : ''}>
                        ${loading ? html`<option value="">${t('studio.schedule.loadingSlots')}</option>` : ''}
                        ${slots.map((s) => html`<option value="${s}" ${s === chosen ? html.raw('selected') : ''}>${this.slotOption(s)}${s === planned ? ` · ${t('studio.schedule.planned')}` : ''}</option>`)}
                        ${loading ? '' : html`<option value="custom" ${chosen === 'custom' ? html.raw('selected') : ''}>${t('studio.schedule.custom')}</option>`}
                    </select>
                    <input type="datetime-local" class="field studio-custom-time${!loading && chosen === 'custom' ? '' : html.raw(' hidden')}"
                           id="st-slot-custom" name="custom_time" aria-label="${t('studio.schedule.customLabel')}"
                           data-change="studio:scheduleChange" aria-describedby="st-slot-custom-hint"
                           value="${UI.toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000))}">
                    <p class="form-hint" id="st-slot-hint">${this.slotsError
                        ? t('studio.schedule.slotsFailed')
                        : t('studio.schedule.zoneHint', { city: this.zoneCity(zone), zone })}</p>
                    ${zone !== device ? html`<p class="form-hint${chosen === 'custom' ? '' : html.raw(' hidden')}" id="st-slot-custom-hint">${t('studio.schedule.deviceZone', { zone: device })}</p>` : ''}
                </div>
                <fieldset class="tiktok-delivery" data-change="studio:scheduleChange">
                    <legend class="form-label">${t('studio.schedule.tiktok')}</legend>
                    ${audited
                        ? radio('scheduled', t('studio.schedule.tiktokScheduled'), t('studio.schedule.tiktokScheduledHint'))
                        : radio('queue', t('studio.schedule.tiktokQueue'), t('studio.schedule.tiktokQueueHint'))}
                    ${radio('none', t('studio.schedule.tiktokNone'), t('studio.schedule.tiktokNoneHint'))}
                </fieldset>
                <div class="form-group check-row" data-change="studio:scheduleChange">
                    <input type="checkbox" id="st-sched-campaign" name="create_campaign" ${create ? html.raw('checked') : ''}
                           aria-describedby="st-sched-campaign-hint">
                    <span class="check-text">
                        <label class="check-label" for="st-sched-campaign">${t('studio.schedule.createCampaign')}</label>
                        <span class="form-hint" id="st-sched-campaign-hint">${t('studio.campaign.createHint')}</span>
                    </span>
                </div>
                <div class="studio-summary" id="studio-schedule-summary" aria-live="polite">${this.scheduleSummaryMarkup(choice)}</div>
                <div id="studio-schedule-error"></div>
                ${blocked ? html`<p class="form-hint text-warning" id="studio-schedule-blocked">${blocked}</p>` : ''}
                <button type="submit" class="btn btn-primary btn-full" id="studio-schedule-submit" ${blocked ? html.raw('disabled') : ''}>
                    <i data-lucide="calendar-check" aria-hidden="true"></i>
                    <span class="studio-submit-label">${choice.when ? t('studio.schedule.submitAt', { time: this.zoneTime(choice.when) }) : t('studio.schedule.submit')}</span>
                </button>
            </form>
        `;
    },

    scheduledMarkup() {
        const s = (this.draft && this.draft.schedule) || {};
        return html`
            <h2 class="studio-panel-title" id="studio-schedule-title" tabindex="-1">${t('studio.schedule.scheduledTitle')}</h2>
            ${s.scheduled_time ? html`
                <p class="post-card-meta">
                    <i data-lucide="calendar-check" aria-hidden="true"></i>
                    <span>${t('studio.schedule.scheduledFor', { when: this.slotLabel(s.scheduled_time) })}</span>
                </p>
            ` : ''}
            <p><a class="btn btn-secondary btn-sm" href="#/posts"><i data-lucide="calendar-days" aria-hidden="true"></i> ${t('studio.schedule.openPosts')}</a></p>
            ${s.tiktok && s.tiktok !== 'none' ? this.tiktokChecklistMarkup(s) : html`<p class="text-meta">${t('studio.schedule.noTikTok')}</p>`}
        `;
    },

    /**
     * The one step left to a person: while TikTok has not approved the app, the
     * carousel goes up as "Only me" and has to be made public in the TikTok app.
     * The box can only be ticked once there is a TikTok post to make public.
     */
    tiktokChecklistMarkup(s) {
        const posted = !!s.tiktok_row_id;
        const waiting = s.tiktok === 'queue' && !posted;
        const done = s.tiktok_public_done === true;
        return html`
            <div class="tiktok-next" role="group" aria-labelledby="st-tt-check-title">
                <p class="tiktok-next-title" id="st-tt-check-title">
                    <i data-lucide="music-2" aria-hidden="true"></i>
                    <strong>${t('studio.tiktokCheck.title')}</strong>
                </p>
                <p class="tiktok-next-body">${waiting ? t('studio.tiktokCheck.queued') : t('studio.tiktokCheck.posted')}</p>
                <div class="check-row${waiting ? html.raw(' is-disabled') : ''}">
                    <input type="checkbox" id="st-tt-public" data-change="studio:tiktokPublic" aria-describedby="st-tt-public-hint"
                           ${done ? html.raw('checked') : ''} ${waiting ? html.raw('disabled') : ''}>
                    <span class="check-text">
                        <label class="check-label" for="st-tt-public">${t('studio.tiktokCheck.madePublic')}</label>
                        <span class="form-hint" id="st-tt-public-hint">${waiting ? t('studio.tiktokCheck.waitHint') : t('studio.tiktokCheck.hint')}</span>
                    </span>
                </div>
            </div>
        `;
    },

    // ─── Editor: typing ──────────────────────────────────────────────────────
    /** "12/34" beside a field, re-counted on every keystroke. Budgets are UTF-16 units, as the server counts. */
    refreshCount(el) {
        const count = el && el.id ? document.getElementById(`${el.id}-count`) : null;
        if (!count) return;
        const max = Number(count.dataset && count.dataset.max) || 0;
        const n = String(el.value || '').length;
        count.innerHTML = esc(this.countMarkup(n, max));
        count.classList.toggle('is-warning', n > max);
    },

    /**
     * Repaint what depends on "are there unsaved edits" — only when that flips,
     * never per keystroke: the Save button, the stale-preview note, and the
     * schedule panel (which schedules the LAST render, so it waits for a save).
     */
    markDirty() {
        // Every edit is kept in this browser at once: a closed tab or a crash costs nothing.
        this.persistEdits();
        const dirty = this.isDirty();
        if (dirty === this._lastDirty) return;
        this._lastDirty = dirty;
        this.paintSaveBar();
        this.paintPreviews();
        this.paintSchedule();
    },

    /** The caption's first line under the phone, kept in step with typing (text only, no repaint). */
    refreshPhoneCaption() {
        const el = document.querySelector && document.querySelector('.phone-caption');
        if (!el || !this.work || !this.work.carousel) return;
        const caps = this.work.carousel.captions || {};
        const line = String((this.previewTab === 'tt' ? caps.tiktokTitle : caps.instagram) || '').split('\n')[0];
        const strong = el.querySelector ? el.querySelector('strong') : null;
        el.textContent = line;
        if (strong && typeof document.createTextNode === 'function') {
            el.insertBefore(document.createTextNode(' '), el.firstChild);
            el.insertBefore(strong, el.firstChild);
        }
    },
    _lastDirty: false,

    slideField(el) {
        if (!el || !el.dataset || this.readOnly()) return;
        const index = Number(el.dataset.slide);
        const slide = this.work.carousel.slides[index];
        if (!slide) return;
        let value = String(el.value === undefined || el.value === null ? '' : el.value);
        if (el.dataset.kind === 'int') {
            const n = parseInt(value, 10);
            value = Number.isFinite(n) ? n : undefined;
        } else if (el.dataset.optional && value === '') {
            value = undefined;
        }
        this.setPath(slide, el.dataset.path, value);
        this.refreshCount(el);
        this.markDirty();
    },

    /** Captions and the accent: fields on the carousel itself rather than on a slide. */
    metaField(el) {
        if (!el || !el.dataset || this.readOnly()) return;
        const path = String(el.dataset.path || '');
        if (!['captions.instagram', 'captions.tiktokTitle', 'captions.tiktok', 'accent'].includes(path)) return;
        this.setPath(this.work.carousel, path, String(el.value || ''));
        this.refreshCount(el);
        this.refreshLineChecks();
        if (path === 'captions.instagram' || path === 'captions.tiktokTitle') this.refreshPhoneCaption();
        this.markDirty();
    },

    refreshLineChecks() {
        if (!this.work || !this.work.carousel) return;
        const lines = this.requiredLines();
        const caps = this.work.carousel.captions || {};
        const ig = document.getElementById('st-cap-ig-check');
        if (ig) ig.outerHTML = esc(this.lineCheckMarkup('st-cap-ig-check', this.lineCheck(caps.instagram, lines.ig)));
        const tt = document.getElementById('st-cap-tt-check');
        if (tt) tt.outerHTML = esc(this.lineCheckMarkup('st-cap-tt-check', this.lineCheck(caps.tiktok, lines.tt)));
        const host = document.getElementById('studio-captions');
        if (host) UI.icons(host);
    },

    /** One keyword, two places: the carousel's CTA and the campaign that answers it. */
    keywordField(el) {
        if (!el || this.readOnly()) return;
        const value = String(el.value || '').trim();
        this.work.carousel.keyword = value;
        this.work.campaign.keyword = value;
        this.refreshLineChecks();
        this.refreshScheduleSummary();
        this.markDirty();
    },

    campaignField(el) {
        if (!el || !el.dataset || this.readOnly()) return;
        if (el.dataset.path !== 'dm') return;
        this.work.campaign.dm = String(el.value || '');
        this.markDirty();
    },

    campaignToggle(el) {
        if (!el || this.readOnly()) return;
        this.work.campaign.create = !!el.checked;
        this.markDirty();
    },

    accentField(el) {
        if (!el || this.readOnly()) return;
        const value = String(el.value || '').trim();
        this.work.carousel.accent = value;
        const picker = document.getElementById(el.dataset && el.dataset.picker ? el.dataset.picker : '');
        if (picker && this.ACCENT_RE.test(value)) picker.value = value.toLowerCase();
        this.markLookSwatches(value.toUpperCase());
        this.markDirty();
    },

    accentFieldPicked(el) {
        if (!el || this.readOnly()) return;
        const value = String(el.value || '').toUpperCase();
        this.work.carousel.accent = value;
        const target = document.getElementById(el.dataset && el.dataset.target ? el.dataset.target : '');
        if (target) target.value = value;
        this.markLookSwatches(value);
        this.markDirty();
    },

    /** A palette swatch beside the preview: one click, the whole carousel's accent. */
    accentSwatch(el) {
        if (!el || !el.dataset || this.readOnly()) return;
        const hex = String(el.dataset.hex || '').toUpperCase();
        if (!this.ACCENT_RE.test(hex)) return;
        this.work.carousel.accent = hex;
        const field = document.getElementById('st-accent');
        if (field) field.value = hex;
        const picker = document.getElementById('st-accent-picker');
        if (picker) picker.value = hex.toLowerCase();
        this.markLookSwatches(hex);
        this.markDirty();
        Motion.announce(t('studio.look.changed', { hex }));
    },

    markLookSwatches(hex) {
        const look = document.getElementById('studio-look');
        if (!look || typeof look.querySelectorAll !== 'function') return;
        look.querySelectorAll('.swatch-btn').forEach((b) => {
            b.setAttribute('aria-pressed', (b.dataset.hex || '').toUpperCase() === hex ? 'true' : 'false');
        });
    },

    // ─── Editor: choosing a slide ────────────────────────────────────────────
    /**
     * Show slide `index` in the preview and open its form. `focus` is where the
     * keyboard goes: 'tab' (the rail), 'stage' (the preview), 'form' (the slide's
     * first field), or nowhere.
     */
    selectSlide(index, opts) {
        const o = opts || {};
        const to = this.clampSlide(index);
        const changed = to !== this.selectedSlide;
        this.selectedSlide = to;
        const panels = document.getElementById('studio-slides');
        if (panels && typeof panels.querySelectorAll === 'function') {
            panels.querySelectorAll('.slide-card[role="tabpanel"]').forEach((card) => {
                card.hidden = card.id !== `st-${to}`;
            });
        }
        this.paintPreviews();
        this.revealTab(document.getElementById(`st-${to}-tab`));
        if (changed) Motion.announce(t('studio.preview.slide', { n: to + 1, total: this.slideCount() }));
        let target = null;
        if (o.focus === 'tab') target = document.getElementById(`st-${to}-tab`);
        else if (o.focus === 'stage') target = document.querySelector && document.querySelector('.phone-stage');
        else if (o.focus === 'form') target = this.firstField(to);
        if (target && typeof target.focus === 'function') target.focus({ preventScroll: o.focus !== 'form' });
        if (o.focus === 'form' && target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
    },

    /**
     * Keep the chosen thumbnail in view by scrolling the rail sideways, and only
     * the rail: scrollIntoView would also move the page and the sticky column.
     * The deltas are visual, so they are right in either direction.
     */
    revealTab(tab) {
        const rail = tab && typeof tab.closest === 'function' ? tab.closest('.slide-rail') : null;
        if (!rail || typeof rail.getBoundingClientRect !== 'function') return;
        const r = rail.getBoundingClientRect();
        const b = tab.getBoundingClientRect();
        const pad = 8;
        if (b.left < r.left) rail.scrollLeft -= (r.left - b.left) + pad;
        else if (b.right > r.right) rail.scrollLeft += (b.right - r.right) + pad;
    },

    /** The slide's first words to edit — its body, not the "Slide type" control above them. */
    firstField(index) {
        const card = document.getElementById(`st-${index}`);
        if (!card || typeof card.querySelector !== 'function') return card;
        return card.querySelector('.slide-card-body input:not([disabled]):not([type="hidden"]):not([type="number"]), .slide-card-body textarea:not([disabled])')
            || card.querySelector('input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])')
            || card;
    },

    prevSlide() { this.selectSlide(this.selectedSlide - 1, { focus: 'stage' }); },
    nextSlide() { this.selectSlide(this.selectedSlide + 1, { focus: 'stage' }); },

    /** A click on the preview opens that slide's form, beside it (below it on a phone). A swipe does not. */
    editSlide(el) {
        if (this._swiped) { this._swiped = false; return; }
        const index = el && el.dataset ? Number(el.dataset.slide) : this.selectedSlide;
        if (this.readOnly()) return;
        this.selectSlide(index, { focus: 'form' });
    },

    goSchedule() {
        const heading = document.getElementById('studio-schedule-title');
        if (!heading) return;
        if (typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start' });
        if (typeof heading.focus === 'function') heading.focus({ preventScroll: true });
    },

    focusFirstProblem() {
        const first = this.problems && this.problems.all.find((p) => this.problemFocusId(p));
        if (first) this.focusProblem(first.id);
        else {
            const box = document.getElementById('studio-problems-box');
            if (box && typeof box.focus === 'function') box.focus();
        }
    },

    // ─── Editor: structure ───────────────────────────────────────────────────
    /** After any change to the slides' order or number: the forms, the rail, the problems. */
    paintStructure(focusKey) {
        this.problems = null;
        this.paintProblemsPanel();
        this.paintPreviews();
        this.paintSlides(focusKey);
        this.markDirty();
    },

    moveSlide(index, delta) {
        if (this.readOnly()) return;
        const slides = this.work.carousel.slides;
        const from = Number(index);
        const to = from + (delta < 0 ? -1 : 1);
        if (!slides[from] || to < 0 || to >= slides.length) return;
        [slides[from], slides[to]] = [slides[to], slides[from]];
        // Stay on the same button of the slide that moved; at an end it is disabled, so take the other one.
        const atEdge = to === 0 || to === slides.length - 1;
        const same = delta < 0 ? 'up' : 'down';
        const other = delta < 0 ? 'down' : 'up';
        this.selectedSlide = to;
        this.paintStructure(`st-${to}-${atEdge ? other : same}`);
        Motion.announce(t('studio.slides.moved', { from: from + 1, to: to + 1 }));
    },

    /**
     * Delete, with a way back: the slide (and the shot it used) is kept for a few
     * seconds, and Undo puts it back where it was.
     */
    deleteSlide(index) {
        if (this.readOnly()) return;
        const slides = this.work.carousel.slides;
        const i = Number(index);
        if (!slides[i] || slides.length <= 1) return;
        const [slide] = slides.splice(i, 1);
        this.setUndo({ type: 'delete', index: i, slide, message: t('studio.undo.deleted', { n: i + 1, kind: this.kindLabel(slide && slide.kind) }) });
        this.selectedSlide = Math.min(i, slides.length - 1);
        this.paintStructure();
        Motion.announce(t('studio.slides.deleted', { n: i + 1 }));
        const undo = document.getElementById('studio-undo');
        if (undo && typeof undo.focus === 'function') undo.focus();
    },

    setUndo(entry) {
        this.clearUndo();
        this.undo = entry;
        this.paintNotices();
        this._undoTimer = setTimeout(() => {
            this._undoTimer = null;
            this.undo = null;
            this.paintNotices();
        }, this.UNDO_MS);
    },

    clearUndo() {
        if (this._undoTimer) clearTimeout(this._undoTimer);
        this._undoTimer = null;
        this.undo = null;
    },

    undoLast() {
        const u = this.undo;
        if (!u || this.readOnly() || !this.work || !this.work.carousel) return;
        const slides = this.work.carousel.slides;
        if (u.type === 'delete') slides.splice(Math.min(u.index, slides.length), 0, u.slide);
        else if (u.type === 'kind' && slides[u.index]) slides[u.index] = u.slide;
        this.clearUndo();
        this.selectedSlide = this.clampSlide(u.index);
        this.paintNotices();
        this.paintStructure(`st-${this.selectedSlide}-tab`);
        const tab = document.getElementById(`st-${this.selectedSlide}-tab`);
        if (tab && typeof tab.focus === 'function') tab.focus();
        Motion.announce(t('studio.undo.done'));
    },

    /** A copy right after the original: the fastest way to a second slide in the same shape. */
    duplicateSlide(index) {
        if (this.readOnly()) return;
        const slides = this.work.carousel.slides;
        const i = Number(index);
        const slide = slides[i];
        if (!slide || slide.kind === 'cover' || slide.kind === 'cta' || slides.length >= this.SLIDES_MAX) return;
        slides.splice(i + 1, 0, this.clone(slide));
        this.selectedSlide = i + 1;
        this.paintStructure(`st-${i + 1}-copy`);
        Motion.announce(t('studio.slides.duplicated', { n: i + 1, to: i + 2 }));
    },

    /** The fields each kind has, for carrying text across a change of kind. */
    KIND_FIELDS: Object.freeze({
        cover: ['kicker', 'title', 'highlight', 'subtitle', 'shot'],
        point: ['n', 'title', 'body', 'tip', 'shot'],
        list: ['title', 'items'],
        compare: ['title', 'left', 'right'],
        steps: ['title', 'steps'],
        prompt: ['title', 'label', 'prompt', 'note'],
        stat: ['value', 'label', 'body'],
        shot: ['title', 'shot', 'caption'],
        cta: ['promise'],
    }),

    /**
     * Change a slide's kind and keep what the two kinds share — the title, the
     * body, the screenshot; a list's items become steps and back. Undo restores
     * the slide exactly as it was, since some fields cannot come along.
     */
    changeKind(el) {
        if (!el || !el.dataset || this.readOnly()) return;
        const i = Number(el.dataset.slide);
        const kind = String(el.value || '');
        const slides = this.work.carousel.slides;
        const old = slides[i];
        if (!old || !this.CONTENT_KINDS.includes(kind) || old.kind === kind) return;
        const next = this.slideTemplate(kind);
        const keep = this.KIND_FIELDS[kind] || [];
        ['title', 'body', 'shot', 'caption', 'note'].forEach((field) => {
            if (keep.includes(field) && old[field] !== undefined && old[field] !== '') next[field] = this.clone(old[field]);
        });
        if (kind === 'steps' && Array.isArray(old.items)) {
            next.steps = old.items.slice(0, 4).map((item) => ({ title: String((item && item.text) || '').slice(0, 28), ...(item && item.sub ? { body: String(item.sub) } : {}) }));
            while (next.steps.length < 3) next.steps.push({ title: '' });
        }
        if (kind === 'list' && Array.isArray(old.steps)) {
            next.items = old.steps.slice(0, 5).map((step) => ({ text: String((step && step.title) || ''), ...(step && step.body ? { sub: String(step.body) } : {}) }));
            while (next.items.length < 3) next.items.push({ text: '' });
        }
        if (kind === 'shot' && !next.shot) next.shot = { name: '' };
        slides[i] = next;
        this.setUndo({ type: 'kind', index: i, slide: old, message: t('studio.undo.kind', { n: i + 1, kind: this.kindLabel(kind) }) });
        this.paintStructure(`st-${i}-kind`);
        Motion.announce(t('studio.slides.kindChanged', { n: i + 1, kind: this.kindLabel(kind) }));
        if (kind === 'shot' && !(next.shot && next.shot.name)) this.openShots(i);
    },

    /** A new slide of each kind, with its required fields present and empty. */
    slideTemplate(kind) {
        switch (kind) {
            case 'cover': return { kind, title: '' };
            case 'list': return { kind, title: '', items: [{ text: '' }, { text: '' }, { text: '' }] };
            case 'compare': return { kind, left: { label: '', items: ['', ''] }, right: { label: '', items: ['', ''] } };
            case 'steps': return { kind, title: '', steps: [{ title: '' }, { title: '' }, { title: '' }] };
            case 'prompt': return { kind, title: '', prompt: '' };
            case 'stat': return { kind, value: '', label: '' };
            case 'shot': return { kind, title: '', shot: { name: '' } };
            case 'cta': return { kind };
            default: return { kind: 'point', title: '' };
        }
    },

    /** Added before the closing call to action, since the last slide has to stay the CTA. */
    addSlide() {
        if (this.readOnly()) return;
        const slides = this.work.carousel.slides;
        if (slides.length >= this.SLIDES_MAX) return;
        const select = document.getElementById('studio-add-kind');
        const kind = select && this.SLIDE_KINDS.includes(select.value) ? select.value : 'point';
        const slide = this.slideTemplate(kind);
        const last = slides[slides.length - 1];
        const at = kind !== 'cta' && last && last.kind === 'cta' ? slides.length - 1 : slides.length;
        slides.splice(at, 0, slide);
        this.selectedSlide = at;
        this.paintStructure();
        const field = this.firstField(at);
        if (field && typeof field.focus === 'function') field.focus();
        Motion.announce(t('studio.slides.added', { n: at + 1, kind: this.kindLabel(kind) }));
        if (kind === 'shot') this.openShots(at);
    },

    ITEM_LIMITS: Object.freeze({ items: 5, steps: 4, rows: 4 }),
    ITEM_MINIMUMS: Object.freeze({ items: 3, steps: 3, rows: 2 }),

    addItem(index, path) {
        if (this.readOnly()) return;
        const slide = this.work.carousel.slides[Number(index)];
        if (!slide || !Object.prototype.hasOwnProperty.call(this.ITEM_LIMITS, path)) return;
        const listId = this.fieldId(index, path);
        if (path === 'rows') {
            slide.left = slide.left || { label: '', items: [] };
            slide.right = slide.right || { label: '', items: [] };
            if (!Array.isArray(slide.left.items)) slide.left.items = [];
            if (!Array.isArray(slide.right.items)) slide.right.items = [];
            const rows = Math.max(slide.left.items.length, slide.right.items.length);
            if (rows >= this.ITEM_LIMITS.rows) return;
            while (slide.left.items.length < rows) slide.left.items.push('');
            while (slide.right.items.length < rows) slide.right.items.push('');
            slide.left.items.push('');
            slide.right.items.push('');
            this.paintSlides(this.fieldId(index, `left.items.${rows}`));
        } else {
            if (!Array.isArray(slide[path])) slide[path] = [];
            if (slide[path].length >= this.ITEM_LIMITS[path]) return;
            slide[path].push(path === 'steps' ? { title: '' } : { text: '' });
            const k = slide[path].length - 1;
            this.paintSlides(this.fieldId(index, `${path}.${k}.${path === 'steps' ? 'title' : 'text'}`));
        }
        this.markDirty();
        if (!document.activeElement || document.activeElement === document.body) {
            const add = document.getElementById(`${listId}-add`);
            if (add && typeof add.focus === 'function') add.focus();
        }
    },

    removeItem(index, path, item) {
        if (this.readOnly()) return;
        const slide = this.work.carousel.slides[Number(index)];
        const k = Number(item);
        if (!slide || !Object.prototype.hasOwnProperty.call(this.ITEM_MINIMUMS, path)) return;
        if (path === 'rows') {
            const left = slide.left && Array.isArray(slide.left.items) ? slide.left.items : [];
            const right = slide.right && Array.isArray(slide.right.items) ? slide.right.items : [];
            if (Math.max(left.length, right.length) <= this.ITEM_MINIMUMS.rows) return;
            left.splice(k, 1);
            right.splice(k, 1);
        } else {
            const list = Array.isArray(slide[path]) ? slide[path] : [];
            if (list.length <= this.ITEM_MINIMUMS[path]) return;
            list.splice(k, 1);
        }
        this.problems = null;
        this.paintSlides(`${this.fieldId(index, path)}-add`);
        this.markDirty();
    },

    // ─── Editor: screenshots ─────────────────────────────────────────────────
    _shotSlide: -1,
    _shotLesson: '',

    /** The draft's own lessons first, then every other indexed lesson once the list is in. */
    shotLessonOptions() {
        const own = this.draftLessonIds().map((id) => this.lessonById(id) || { id, lesson_no: '', title: id });
        const ownIds = new Set(own.map((l) => String(l.id)));
        const others = this.lessons.filter((l) => l && l.status === 'indexed' && !ownIds.has(String(l.id)));
        return { own, others };
    },

    shotLessonSelect() {
        const { own, others } = this.shotLessonOptions();
        const option = (l) => html`<option value="${l.id}" ${String(l.id) === this._shotLesson ? html.raw('selected') : ''}>${this.lessonName(l)}</option>`;
        return html`
            <select class="select" id="st-shot-lesson" data-change="studio:shotLesson">
                ${own.length ? html`<optgroup label="${t('studio.shot.draftLessons')}">${own.map(option)}</optgroup>` : ''}
                ${others.length ? html`<optgroup label="${t('studio.shot.otherLessons')}">${others.map(option)}</optgroup>` : ''}
            </select>
        `;
    },

    async openShots(index) {
        if (this.readOnly()) return;
        const i = Number(index);
        if (!this.work.carousel.slides[i]) return;
        const token = ++this._modalToken;
        this._shotSlide = i;
        const { own, others } = this.shotLessonOptions();
        this._shotLesson = String((own[0] && own[0].id) || (others[0] && others[0].id) || '');
        UI.showModal(html`
            ${this.modalHeader(t('studio.shot.pickTitle', { n: i + 1 }))}
            <p class="form-hint">${t('studio.shot.pickHint')}</p>
            <div class="shot-picker-controls">
                <div class="form-group">
                    <label class="form-label" for="st-shot-lesson">${t('studio.shot.lesson')}</label>
                    <div id="studio-shot-lessons">${this.shotLessonSelect()}</div>
                </div>
                <div class="form-group check-row">
                    <input type="checkbox" id="st-shot-clean" data-change="studio:shotClean" aria-describedby="st-shot-clean-hint"
                           ${this.cleanOnly ? html.raw('checked') : ''}>
                    <span class="check-text">
                        <label class="check-label" for="st-shot-clean">${t('studio.shot.cleanOnly')}</label>
                        <span class="form-hint" id="st-shot-clean-hint">${t('studio.shot.cleanHint')}</span>
                    </span>
                </div>
            </div>
            <div class="shot-picker">
                <div class="shot-hero" id="st-shot-hero"></div>
                <div id="studio-shot-grid" class="shot-picker-grid">${this.spinnerMarkup()}</div>
            </div>
            <div class="modal-actions">
                ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
            </div>
        `);
        if (!this.lessonsLoaded) {
            const [res] = await Promise.allSettled([API.getStudioLessons()]);
            if (res.status === 'fulfilled') this.applyLessons(res);
            if (!this.modalLive(token)) return;
            if (!this._shotLesson) {
                const next = this.shotLessonOptions();
                this._shotLesson = String((next.others[0] && next.others[0].id) || '');
            }
            this.paintRegion('studio-shot-lessons', this.shotLessonSelect());
        }
        await this.paintShotGrid(token);
    },

    /** The moments the picker shows: clean frames only, unless the operator asked for all. */
    shownMoments(moments) {
        const all = Array.isArray(moments) ? moments : [];
        return this.cleanOnly ? all.filter((m) => m && m.clean !== false) : all;
    },

    shotPickerMarkup(detail) {
        const all = detail.moments;
        if (!all.length) return html`<p class="studio-empty-note">${t('studio.shot.noMoments')}</p>`;
        const slide = this.work && this.work.carousel.slides[this._shotSlide];
        const current = slide && slide.shot ? String(slide.shot.name || '') : '';
        const shown = this.shownMoments(all);
        return html`
            <p class="text-meta" id="st-shot-count">${t('studio.shot.showing', { n: UI.formatNumber(shown.length), total: UI.formatNumber(all.length) })}</p>
            ${shown.length
                ? html`<ul class="moment-grid moment-grid--pick" id="st-shot-list">${shown.map((m) => this.momentTile(m, { slide: this._shotSlide, current }))}</ul>`
                : html`<p class="studio-empty-note">${t('studio.shot.noClean')}</p>`}
        `;
    },

    /** The big version of one moment: what the frame really shows, before it is picked. */
    shotHeroMarkup(moment) {
        if (!moment) return html`<p class="studio-empty-note">${t('studio.shot.heroEmpty')}</p>`;
        const thumb = safeUrl(moment.thumb_url);
        return html`
            <span class="shot-hero-frame">
                ${thumb ? html`<img src="${thumb}" alt="" decoding="async">` : html`<i data-lucide="image-off" aria-hidden="true"></i>`}
            </span>
            <span class="shot-hero-meta">
                ${UI.ltr(this.clock(moment.t))} · ${this.momentKind(moment.kind)}
                ${moment.clean === false ? html` · <span class="text-warning">${t('studio.moment.notClean')}</span>` : ''}
            </span>
            <span class="shot-hero-desc" dir="auto">${moment.description || ''}</span>
        `;
    },

    async paintShotGrid(token) {
        const lessonId = this._shotLesson;
        if (!lessonId) {
            if (this.modalLive(token)) this.paintRegion('studio-shot-grid', html`<p class="studio-empty-note">${t('studio.shot.noLessons')}</p>`);
            return;
        }
        if (this.modalLive(token)) this.paintRegion('studio-shot-grid', this.spinnerMarkup());
        let markup;
        let detail = null;
        try {
            detail = await this.fetchLesson(lessonId);
            markup = this.shotPickerMarkup(detail);
        } catch (err) {
            markup = UI.errorStrip((err && err.message) || t('error.unexpected'), '');
        }
        if (!this.modalLive(token) || lessonId !== this._shotLesson) return;
        this.paintRegion('studio-shot-grid', markup);
        // The hero starts on the slide's current frame, else the first one shown.
        const slide = this.work && this.work.carousel.slides[this._shotSlide];
        const current = slide && slide.shot && String(slide.shot.name || '').startsWith('m-') ? this.momentById(String(slide.shot.name).slice(2)) : null;
        const first = detail ? this.shownMoments(detail.moments)[0] : null;
        this.paintRegion('st-shot-hero', this.shotHeroMarkup(current || first || null));
        this.wireShotHero(token);
    },

    /** Hover or keyboard focus on a tile shows it large; a click (or Enter) picks it. */
    wireShotHero(token) {
        const list = document.getElementById('st-shot-list');
        if (!list || typeof list.addEventListener !== 'function') return;
        const show = (event) => {
            const tile = event.target && typeof event.target.closest === 'function' ? event.target.closest('.moment-pick') : null;
            if (!tile || !this.modalLive(token) || tile.dataset.moment === this._heroMoment) return;
            this._heroMoment = tile.dataset.moment;
            this.paintRegion('st-shot-hero', this.shotHeroMarkup(this.momentById(tile.dataset.moment)));
        };
        list.addEventListener('pointerover', show);
        list.addEventListener('focusin', show);
    },
    _heroMoment: '',

    shotClean(el) {
        this.cleanOnly = !!(el && el.checked);
        this._heroMoment = '';
        this.paintShotGrid(this._modalToken);
    },

    shotLesson(el) {
        this._shotLesson = String((el && el.value) || '');
        this._heroMoment = '';
        this.paintShotGrid(this._modalToken);
    },

    /**
     * `shots['m-<momentId>']` gets a ShotSpec at the moment's time, framed the way
     * generation frames one (zoom 1.3, centred) unless another slide already
     * uses that moment — then its spec is kept. The slide's own ShotRef starts
     * clean: a zoom tuned for the old frame means nothing on the new one.
     */
    pickShot(el) {
        if (!el || !el.dataset || this.readOnly()) return;
        const index = Number(el.dataset.slide);
        const slide = this.work.carousel.slides[index];
        const moment = this.momentById(el.dataset.moment);
        if (!slide || !moment) return;
        const name = `m-${moment.id}`;
        if (!this.work.shots || typeof this.work.shots !== 'object') this.work.shots = {};
        if (!this.work.shots[name]) {
            this.work.shots[name] = {
                lessonId: String(moment.lesson_id || el.dataset.lesson || this._shotLesson),
                t: Number(moment.t) || 0,
                zoom: 1.3,
                focusX: 0.5,
                focusY: 0.5,
                desc: String(moment.description || ''),
            };
        }
        slide.shot = { name };
        this.paintSlides();
        this.markDirty();
        UI.closeModal();
        UI.toast(t('studio.shot.swapped', { n: index + 1 }));
    },

    removeShot(index) {
        if (this.readOnly()) return;
        const slide = this.work.carousel.slides[Number(index)];
        if (!slide || slide.kind === 'shot') return;
        delete slide.shot;
        this.paintSlides(`st-${index}-shot-change`);
        this.markDirty();
    },

    // ─── Editor: problems ────────────────────────────────────────────────────
    /**
     * Where a validateCarousel message belongs. The messages follow
     * check-carousels.mts: `Id[3:point].title: 45 > 40 «…»` names slide 3's
     * title; `Id[2:list].items[0].text` its first item. compare counts both
     * sides as one run of `items[k]`, so k is split back into left and right.
     * Carousel-level messages are matched on the field they name.
     *
     * @returns {{ slide: number, path: string } | { field: string } | null}
     */
    problemTarget(message) {
        const text = String(message || '');
        const slide = /\[(\d+):([a-z]+)\]\.?([A-Za-z0-9_.[\]]*)/.exec(text);
        if (slide) {
            const index = Number(slide[1]) - 1;
            let path = slide[3].replace(/\[(\d+)\]/g, '.$1').replace(/^\.+|\.+$/g, '');
            const s = this.work && this.work.carousel ? this.work.carousel.slides[index] : null;
            const combined = /^items\.(\d+)$/.exec(path);
            if (s && s.kind === 'compare' && combined) {
                const k = Number(combined[1]);
                const left = s.left && Array.isArray(s.left.items) ? s.left.items.length : 0;
                path = k < left ? `left.items.${k}` : `right.items.${k - left}`;
            }
            return { slide: index, path };
        }
        const lower = text.toLowerCase();
        if (/tiktoktitle|tiktok title/.test(lower)) return { field: 'captions.tiktokTitle' };
        if (/tiktok caption|tiktok description|tiktokline|tiktok line/.test(lower)) return { field: 'captions.tiktok' };
        if (/instagram caption|instagramask|hashtag/.test(lower)) return { field: 'captions.instagram' };
        if (/\baccent\b/.test(lower)) return { field: 'accent' };
        if (/\bkeyword\b/.test(lower)) return { field: 'keyword' };
        if (/\bslides?\b/.test(lower)) return { field: 'slides' };
        return null;
    },

    sortProblems(list) {
        const out = { all: [], slides: new Map(), fields: new Map(), general: [] };
        list.forEach((message, n) => {
            const target = this.problemTarget(message);
            const problem = { id: n, message: String(message), target };
            out.all.push(problem);
            if (target && typeof target.slide === 'number') {
                if (!out.slides.has(target.slide)) out.slides.set(target.slide, []);
                out.slides.get(target.slide).push(problem);
            } else if (target && target.field) {
                if (!out.fields.has(target.field)) out.fields.set(target.field, []);
                out.fields.get(target.field).push(problem);
            } else {
                out.general.push(problem);
            }
        });
        return out;
    },

    FIELD_IDS: Object.freeze({
        'captions.instagram': 'st-cap-ig',
        'captions.tiktokTitle': 'st-cap-tt-title',
        'captions.tiktok': 'st-cap-tt',
        accent: 'st-accent',
        keyword: 'st-keyword',
        slides: 'studio-slides-title',
    }),

    /** The element a problem's "Show" button moves to: its field when it has one, else its slide. */
    problemFocusId(problem) {
        const target = problem && problem.target;
        if (!target) return '';
        if (target.field) return this.FIELD_IDS[target.field] || '';
        if (typeof target.slide === 'number') {
            if (target.path) {
                const id = this.fieldId(target.slide, target.path);
                if (document.getElementById(id)) return id;
            }
            return `st-${target.slide}`;
        }
        return '';
    },

    focusProblem(id) {
        const problem = this.problems && this.problems.all.find((p) => String(p.id) === String(id));
        if (!problem) return;
        // A problem on another slide first brings that slide up, in the preview and the form.
        if (problem.target && typeof problem.target.slide === 'number' && problem.target.slide !== this.selectedSlide) {
            this.selectSlide(problem.target.slide);
        }
        const el = document.getElementById(this.problemFocusId(problem));
        if (!el) return;
        if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        if (typeof el.focus === 'function') el.focus({ preventScroll: true });
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    },

    /** After a 400: every form that can show a problem, the rail's flags, and the list. */
    paintProblems() {
        // The first slide with a problem comes up, so the first thing seen is a field to fix.
        const first = this.problems && this.problems.all.find((p) => p.target && typeof p.target.slide === 'number');
        if (first && !(this.problems.slides.get(this.selectedSlide) || []).length) this.selectedSlide = this.clampSlide(first.target.slide);
        this.paintProblemsPanel();
        this.paintPreviews();
        this.paintSlides();
        this.paintCaptions();
        this.paintCampaign();
        this.paintLook();
        this.paintSaveBar();
        const summary = document.getElementById('studio-problems-box') || document.getElementById('studio-save-error');
        if (summary && typeof summary.focus === 'function') summary.focus();
        if (this.problems) Motion.announce(t('studio.problems.title', { n: UI.formatNumber(this.problems.all.length) }));
    },

    // ─── Editor: save, rewrite, render ───────────────────────────────────────
    /**
     * The PATCH body: the working copy, minus any shot no slide uses any more —
     * the worker extracts a frame for every entry in `shots`, so a swapped-out
     * screenshot would otherwise be rendered for nothing on every save.
     */
    patchPayload() {
        const work = this.clone(this.work);
        const used = new Set(work.carousel.slides.map((s) => s && s.shot && s.shot.name).filter(Boolean));
        const shots = {};
        Object.keys(work.shots || {}).forEach((name) => {
            if (used.has(name)) shots[name] = work.shots[name];
        });
        return { carousel: work.carousel, shots, campaign: work.campaign };
    },

    async patchDraft() {
        const res = await API.updateStudioDraft(this.draft.id, this.patchPayload());
        // Saved: the copy kept in this browser has done its job.
        this.forgetEdits();
        this.loadDraft({ draft: (res && res.draft) || this.draft, lessons: this.draftLessons });
        return res;
    },

    /** A 400 with problems, or any other failure, onto the save bar. */
    takeSaveFailure(err) {
        const problems = this.problemList(err);
        if (problems.length) {
            this.problems = this.sortProblems(problems);
            this.saveError = null;
        } else {
            this.problems = null;
            this.saveError = (err && err.message) || t('error.unexpected');
        }
        return problems.length > 0;
    },

    async save(el) {
        if (!this.draft || this.saving || this.readOnly() || !this.isDirty()) return;
        const restore = UI.actionBusy(el || document.getElementById('studio-save'), t('common.saving'));
        if (!restore) return;
        const seq = this._seq;
        this.saving = true;
        try {
            await this.patchDraft();
            this.saving = false;
            if (seq !== this._seq) return;
            UI.toast(t('studio.editor.savedToast'));
            this.paintEditor();
            this.startPoll(seq);
        } catch (err) {
            this.saving = false;
            if (seq !== this._seq) return;
            this.takeSaveFailure(err);
            this.paintProblems();
        } finally {
            this.saving = false;
            restore();
        }
    },

    discard() {
        if (!this.draft) return;
        this.forgetEdits();
        this.clearUndo();
        this.loadDraft({ draft: this.draft, lessons: this.draftLessons });
        this.paintEditor();
        Motion.announce(t('studio.editor.discarded'));
    },

    openRewrite(index) {
        if (this.readOnly()) return;
        const i = Number(index);
        const slide = this.work.carousel.slides[i];
        if (!slide) return;
        UI.showModal(html`
            ${this.modalHeader(t('studio.rewrite.title', { n: i + 1 }))}
            <form id="studio-rewrite-form" data-submit="studio:rewrite" data-slide="${i}" novalidate>
                <p class="modal-body-text">${t('studio.rewrite.body', { kind: this.kindLabel(slide.kind) })}</p>
                <div class="form-group">
                    <label class="form-label" for="st-rewrite-instruction">
                        ${t('studio.rewrite.instruction')} <span class="label-optional">${t('common.optional')}</span>
                    </label>
                    <textarea class="field-textarea" id="st-rewrite-instruction" name="instruction" rows="3" dir="auto"
                              lang="${this.contentLang()}" placeholder="${t('studio.rewrite.placeholder')}"></textarea>
                </div>
                ${this.isDirty() ? html`<p class="form-hint text-warning">${t('studio.rewrite.savesFirst')}</p>` : ''}
                <div id="studio-rewrite-error"></div>
                <div class="modal-actions">
                    ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'sparkles', label: t('studio.rewrite.submit') })}
                </div>
            </form>
        `);
    },

    /**
     * Rewrite works on the SERVER's copy of the carousel, by index. Unsaved edits
     * would be lost under it — or worse, a moved slide would make the index point
     * at a different slide — so they are saved first, and a refused save stops here.
     */
    async rewrite(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (!this.draft || this.readOnly()) return;
        const index = Number(form && form.dataset ? form.dataset.slide : NaN);
        if (!Number.isInteger(index) || !this.work.carousel.slides[index]) return;
        const instruction = String(new FormData(form).get('instruction') || '').trim();
        const restore = UI.formBusy(form, t('studio.rewrite.writing'));
        if (!restore) return;
        const seq = this._seq;
        try {
            if (this.isDirty()) {
                try {
                    await this.patchDraft();
                } catch (err) {
                    if (seq !== this._seq) return;
                    const refused = this.takeSaveFailure(err);
                    this.paintProblems();
                    this.paintRegion('studio-rewrite-error', UI.errorStrip(
                        refused ? t('studio.rewrite.saveRefused') : ((err && err.message) || t('error.unexpected')), '', 'studio-rewrite-error-strip'
                    ));
                    restore();
                    return;
                }
            }
            const body = { index };
            if (instruction) body.instruction = instruction;
            const res = await API.rewriteStudioSlide(this.draft.id, body);
            if (seq !== this._seq) return;
            if (res && res.draft) this.loadDraft({ draft: res.draft, lessons: this.draftLessons });
            this.paintEditor();
            UI.closeModal();
            UI.toast(t('studio.rewrite.done', { n: index + 1 }));
            this.startPoll(seq);
        } catch (err) {
            if (seq !== this._seq) return;
            this.paintRegion('studio-rewrite-error', UI.errorStrip((err && err.message) || t('error.unexpected'), '', 'studio-rewrite-error-strip'));
            restore();
        }
    },

    /**
     * Write the whole carousel again, from the same lessons or idea, at another
     * angle. It is a NEW draft (POST /drafts): this one stays as it is, so trying
     * an angle never costs the edits made to this version.
     */
    openRegenerate() {
        const d = this.draft;
        if (!d || !d.input || this.generating) {
            if (this.generating) UI.toast(t('studio.regen.busy'), 'error');
            return;
        }
        const current = this.ANGLES.includes(d.input.angle) ? d.input.angle : 'auto';
        const suggested = this.ANGLES.find((a) => a !== current && a !== 'auto') || 'tips';
        const slides = Math.min(this.SLIDES_MAX, Math.max(this.SLIDES_MIN, Number(d.input.slides) || this.slideCount()));
        const options = [];
        for (let n = this.SLIDES_MIN; n <= this.SLIDES_MAX; n++) options.push(n);
        const fromLessons = Array.isArray(d.input.lessonIds) && d.input.lessonIds.length > 0;
        UI.showModal(html`
            ${this.modalHeader(t('studio.regen.title'))}
            <form id="studio-regen-form" data-submit="studio:regenerate" novalidate>
                <p class="modal-body-text">${fromLessons ? t('studio.regen.bodyLessons') : t('studio.regen.bodyIdea')}</p>
                <div class="studio-new-grid">
                    <div class="form-group">
                        <label class="form-label" for="st-regen-angle">${t('studio.new.angle')}</label>
                        <select class="select" id="st-regen-angle" name="angle">
                            ${this.ANGLES.map((a) => html`<option value="${a}" ${a === suggested ? html.raw('selected') : ''}>${this.angleLabel(a)}${a === current ? ` · ${t('studio.regen.current')}` : ''}</option>`)}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="st-regen-slides">${t('studio.new.slides')}</label>
                        <select class="select" id="st-regen-slides" name="slides">
                            ${options.map((n) => html`<option value="${n}" ${n === slides ? html.raw('selected') : ''}>${UI.formatNumber(n)}</option>`)}
                        </select>
                    </div>
                </div>
                <p class="form-hint">${t('studio.regen.keeps')}</p>
                <div class="modal-actions">
                    ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'wand-sparkles', label: t('studio.regen.submit') })}
                </div>
            </form>
        `);
    },

    /** The new draft's input: the same source, keyword and accent, at the chosen angle and length. */
    regenInput(form) {
        const d = this.draft || {};
        const data = new FormData(form);
        let angle = String(data.get('angle') || 'auto');
        if (!this.ANGLES.includes(angle)) angle = 'auto';
        const slides = Math.min(this.SLIDES_MAX, Math.max(this.SLIDES_MIN, Math.round(Number(data.get('slides'))) || this.SLIDES_DEFAULT));
        const src = d.input || {};
        const input = { lessonIds: Array.isArray(src.lessonIds) ? src.lessonIds.map(String).slice(0, this.MAX_LESSONS) : [], angle, slides };
        if (src.idea) input.idea = String(src.idea);
        if (!input.lessonIds.length && !input.idea) input.idea = this.draftTitle(d);
        const keyword = String((this.work && this.work.carousel && this.work.carousel.keyword) || src.keyword || '').trim();
        if (keyword && !/\s/.test(keyword)) input.keyword = keyword;
        const accent = String((this.work && this.work.carousel && this.work.carousel.accent) || '').toUpperCase();
        if (this.ACCENT_RE.test(accent)) input.accent = accent;
        return input;
    },

    regenerate(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (!this.draft || this.generating) return undefined;
        const input = this.regenInput(form);
        UI.closeModal();
        // The progress lives on the home view, where the new draft will open from.
        if (typeof App !== 'undefined' && typeof App.go === 'function') App.go('studio');
        return this.runGeneration(input);
    },

    async renderAgain(el) {
        const d = this.draft;
        if (!d) return;
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            await API.renderStudioDraft(d.id);
            d.status = 'rendering';
            d.error = null;
            this.paintHead();
            this.paintPreviews();
            this.paintSchedule();
            this.startPoll(this._seq);
        } catch (err) {
            UI.toast((err && err.message) || t('common.error'), 'error');
        } finally {
            restore();
        }
    },

    /** Every 4s while the worker writes or renders. Updates `draft`; `work` only when it has no edits. */
    startPoll(seq) {
        this.stopPoll();
        if (!this.draft || !this.isBusyStatus(this.draft.status)) return;
        this._pollTimer = setTimeout(() => this.pollDraft(seq), this.RENDER_POLL_MS);
    },

    async pollDraft(seq) {
        this._pollTimer = null;
        if (seq !== this._seq || !this.draft) return;
        const [res] = await Promise.allSettled([API.getStudioDraft(this.draft.id)]);
        if (seq !== this._seq || !this.draft) return;
        const next = res.status === 'fulfilled' && res.value && res.value.draft ? res.value.draft : null;
        if (next) {
            const before = this.draft.status;
            const hadCarousel = !!(this.work && this.work.carousel);
            if (this.isDirty()) {
                this.draft = next;
                this.paintHead();
                this.paintPreviews();
                this.paintSchedule();
            } else {
                this.loadDraft({ draft: next, lessons: res.value.lessons || this.draftLessons });
                if (!hadCarousel && this.work.carousel) this.paintEditor();
                else {
                    this.paintHead();
                    this.paintPreviews();
                    this.paintSchedule();
                    this.paintSaveBar();
                }
            }
            if (before !== next.status && !this.isBusyStatus(next.status)) {
                const failed = next.status === 'failed';
                const message = failed ? t('studio.preview.renderFailed') : t('studio.preview.rendered');
                UI.toast(message, failed ? 'error' : 'success');
                Motion.announce(message);
            }
        }
        this.startPoll(seq);
    },

    async reloadDraft() {
        if (!this.draft) return;
        const seq = this._seq;
        const [res] = await Promise.allSettled([API.getStudioDraft(this.draft.id)]);
        if (seq !== this._seq || res.status !== 'fulfilled' || !res.value || !res.value.draft) return;
        if (this.isDirty()) this.draft = res.value.draft;
        else this.loadDraft(res.value);
        this.paintHead();
        this.paintSchedule();
    },

    previewTabSwitch(tab) {
        this.previewTab = tab === 'tt' ? 'tt' : 'ig';
        this.paintPreviews();
    },

    // ─── Editor: schedule actions ────────────────────────────────────────────
    slotChange(el) {
        const isCustom = !!(el && el.value === 'custom');
        const custom = document.getElementById('st-slot-custom');
        if (custom) custom.classList.toggle('hidden', !isCustom);
        const hint = document.getElementById('st-slot-custom-hint');
        if (hint) hint.classList.toggle('hidden', !isCustom);
        this.refreshScheduleSummary();
    },

    /** Any choice in the schedule form: the summary and the button say what will happen now. */
    scheduleChange() {
        this.refreshScheduleSummary();
    },

    /**
     * The POST /schedule body. A slot is the server's own ISO string, sent back
     * untouched; a custom time is local wall time from the datetime field.
     *
     * @returns {{ ok: true, body: object } | { ok: false, message: string, field: string }}
     */
    readSchedule(form) {
        const data = new FormData(form);
        const slot = String(data.get('slot') || '');
        let when = null;
        let field = 'st-slot';
        if (slot && slot !== 'custom') {
            when = slot;
        } else {
            field = 'st-slot-custom';
            when = UI.fromLocalInputValue(String(data.get('custom_time') || ''));
            if (when && Date.parse(when) <= Date.now()) return { ok: false, message: t('studio.schedule.inPast'), field };
        }
        if (!when) return { ok: false, message: t('studio.schedule.pickTime'), field };
        const allowed = this.tiktokAudited() ? ['scheduled', 'none'] : ['queue', 'none'];
        let tiktok = String(data.get('tiktok') || '');
        if (!allowed.includes(tiktok)) tiktok = allowed[0];
        return { ok: true, body: { scheduled_time: when, tiktok, create_campaign: data.get('create_campaign') === 'on' } };
    },

    showScheduleError(message, problems, fieldId) {
        this.paintRegion('studio-schedule-error', html`
            ${UI.errorStrip(message, '', 'studio-schedule-error-strip')}
            ${problems && problems.length ? html`<ul class="problem-list">${problems.map((p) => html`<li dir="auto">${p}</li>`)}</ul>` : ''}
        `);
        const field = fieldId ? document.getElementById(fieldId) : null;
        if (field) UI.markInvalid(field, 'studio-schedule-error-strip');
    },

    async schedule(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const d = this.draft;
        // The button is disabled in both cases; Enter in a field must not get past it either.
        if (!d || d.status !== 'ready' || this.isDirty()) return;
        const read = this.readSchedule(form);
        if (!read.ok) {
            this.showScheduleError(read.message, null, read.field);
            return;
        }
        const restore = UI.formBusy(form, t('studio.schedule.scheduling'));
        if (!restore) return;
        const seq = this._seq;
        try {
            const res = await API.scheduleStudioDraft(d.id, read.body);
            if (seq !== this._seq) return;
            if (res && res.draft) this.loadDraft({ draft: res.draft, lessons: this.draftLessons });
            UI.toast(t('studio.schedule.done', { when: this.slotLabel(read.body.scheduled_time) }));
            this.paintEditor();
            const heading = document.getElementById('studio-schedule-title');
            if (heading && typeof heading.focus === 'function') heading.focus();
            this.refreshStatus(seq);
        } catch (err) {
            restore();
            if (seq !== this._seq) return;
            this.showScheduleError((err && err.message) || t('error.unexpected'), this.problemList(err), null);
        }
    },

    async tiktokPublic(el) {
        const d = this.draft;
        if (!d || !el) return;
        const done = !!el.checked;
        el.disabled = true;
        try {
            const res = await API.setStudioTikTokPublic(d.id, done);
            if (res && res.draft) this.draft = res.draft;
            else d.schedule = { ...(d.schedule || {}), tiktok_public_done: done };
            UI.toast(done ? t('studio.tiktokCheck.doneToast') : t('studio.tiktokCheck.undoneToast'));
        } catch (err) {
            el.checked = !done;
            UI.toast((err && err.message) || t('common.error'), 'error');
        } finally {
            el.disabled = false;
        }
    },

    deleteDraft() {
        if (!this.draft) return;
        Admin.confirm({
            title: t('studio.editor.deleteTitle'),
            body: t('studio.editor.deleteBody', { title: this.draftTitle(this.draft) }),
            hint: t('studio.editor.deleteHint'),
            confirmLabel: t('common.delete'),
            onConfirm: () => StudioPage.deleteConfirmed(),
        });
    },

    /** Returns the promise: a refusal stays in the dialog, next to the button that caused it. */
    async deleteConfirmed() {
        const id = this.draft && this.draft.id;
        if (!id) return;
        await API.deleteStudioDraft(id);
        this.forgetEdits();
        this.drafts = this.drafts.filter((d) => String(d.id) !== String(id));
        UI.toast(t('studio.editor.deleted'));
        if (typeof App !== 'undefined' && typeof App.go === 'function') App.go('studio');
    },

    // ─── Settings tab (STUDIO.md §10) ────────────────────────────────────────
    /** The six sections the tab edits. `examples` is not one of them: PUT merges, so it is left alone. */
    SETTINGS_SECTIONS: Object.freeze(['brand', 'voice', 'product', 'cta', 'schedule', 'library']),
    FONTS_DISPLAY: Object.freeze(['Cairo', 'Tajawal', 'IBM Plex Sans Arabic', 'Inter']),
    FONTS_MONO: Object.freeze(['JetBrains Mono']),
    CTA_SLIDE_KEYS: Object.freeze(['igAsk', 'igSub', 'save', 'ttHeadline', 'ttPill', 'ttSub', 'follow', 'swipe']),
    DM_PLACEHOLDERS: Object.freeze(['username', 'question', 'pitch', 'url', 'bullets']),
    /** Offered when the browser cannot list its time zones (Intl.supportedValuesOf). */
    FALLBACK_ZONES: Object.freeze([
        'UTC', 'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Amman',
        'Africa/Cairo', 'Africa/Casablanca', 'Europe/London', 'Europe/Paris', 'Europe/Istanbul',
        'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Karachi', 'Asia/Kolkata',
        'Asia/Singapore', 'Australia/Sydney',
    ]),
    /** A worker seen within this long counts as online — the rule /status uses (STUDIO.md §4). */
    WORKER_ONLINE_MS: 90 * 1000,

    applyWorkers(result) {
        if (result.status === 'fulfilled') {
            this.workers = result.value && Array.isArray(result.value.workers) ? result.value.workers : [];
            this.workersLoaded = true;
            this.workersError = null;
        } else {
            this.workersError = result.reason;
        }
    },

    /**
     * Every field the form shows, present — so a tenant whose row predates a key
     * still gets an input for it. The fallbacks are the neutral defaults
     * (`defaultStudioSettings()`: English, Latin digits), used only for a missing key.
     */
    normalizeSettings(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        const list = (v) => (Array.isArray(v) ? v.map((x) => String(x === null || x === undefined ? '' : x)) : []);
        const str = (v, d) => (typeof v === 'string' ? v : d);
        const brand = obj(s.brand);
        const voice = obj(s.voice);
        const product = obj(s.product);
        const cta = obj(s.cta);
        const schedule = obj(s.schedule);
        const library = obj(s.library);
        const slide = obj(cta.slide);
        const slideWords = {};
        this.CTA_SLIDE_KEYS.forEach((key) => { slideWords[key] = str(slide[key], ''); });
        return {
            brand: {
                ...brand,
                name: str(brand.name, ''),
                signature: { latin: str(obj(brand.signature).latin, ''), local: str(obj(brand.signature).local, '') },
                palette: list(brand.palette),
                colors: {
                    ink: str(obj(brand.colors).ink, ''),
                    paper: str(obj(brand.colors).paper, ''),
                    muted: str(obj(brand.colors).muted, ''),
                },
                fonts: { display: str(obj(brand.fonts).display, 'Inter'), mono: str(obj(brand.fonts).mono, 'JetBrains Mono') },
                direction: brand.direction === 'rtl' ? 'rtl' : 'ltr',
                theme: str(brand.theme, 'dark-grid'),
            },
            voice: {
                ...voice,
                language: voice.language === 'ar' ? 'ar' : 'en',
                guide: str(voice.guide, ''),
                digits: voice.digits === 'arabic-indic' ? 'arabic-indic' : 'latin',
            },
            product: { ...product, name: str(product.name, ''), url: str(product.url, ''), facts: list(product.facts), dmBullets: list(product.dmBullets) },
            cta: {
                ...cta,
                instagramAsk: str(cta.instagramAsk, ''),
                tiktokLine: str(cta.tiktokLine, ''),
                dmTemplate: str(cta.dmTemplate, ''),
                slide: slideWords,
            },
            schedule: { ...schedule, timezone: str(schedule.timezone, 'UTC'), slots: list(schedule.slots) },
            library: { ...library, root: typeof library.root === 'string' && library.root.trim() ? library.root : null },
        };
    },

    loadSettingsWork() {
        this.settingsWork = this.settings ? this.normalizeSettings(this.settings) : null;
        this._settingsBaseline = this.settingsWork ? JSON.stringify(this.settingsWork) : '';
        this._settingsDirty = false;
        this.settingsProblems = null;
        this.settingsSaveError = null;
        this.settingsFieldProblems = null;
    },

    settingsDirty() {
        return !!this.settingsWork && JSON.stringify(this.settingsWork) !== this._settingsBaseline;
    },
    _settingsDirty: false,

    async renderSettingsPage(container, seq) {
        const gate = Motion.beginLoad(container, () => this.skeleton());
        const [settings, workers, status] = await Promise.allSettled([
            API.getStudioSettings(),
            API.getStudioWorkers(),
            API.getStudioStatus(),
        ]);
        if (!this.alive(seq)) return;
        gate.done();
        // A failed read must not leave an older answer standing in for this tenant's settings.
        if (settings.status === 'rejected') this.settings = null;
        this.applySettings(settings);
        this.applyWorkers(workers);
        this.applyStatus(status);
        this.loadSettingsWork();
        this.paintSettingsPage();
        this.bindKeys('settings');
        this.focusSettingsTarget();
        Motion.announce(t('studio.tabs.settings'));
    },

    paintSettingsPage() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const focus = UI.captureFocus(container);
        container.innerHTML = esc(html`
            <div class="page-toolbar">
                ${this.tabsMarkup('settings')}
                ${UI.helpLink('studio-settings', t('help.link.studioSettings'), { newTab: true, className: 'studio-settings-help' })}
            </div>
            ${this.settingsWork ? html`
                <form id="studio-settings-form" class="studio-settings" data-submit="studio:saveSettings" novalidate>
                    <section class="surface pad-5" id="sts-section-brand" aria-labelledby="sts-brand-title">${this.brandSectionMarkup()}</section>
                    <section class="surface pad-5" id="sts-section-voice" aria-labelledby="sts-voice-title">${this.voiceSectionMarkup()}</section>
                    <section class="surface pad-5" id="sts-section-product" aria-labelledby="sts-product-title">${this.productSectionMarkup()}</section>
                    <section class="surface pad-5" id="sts-section-schedule" aria-labelledby="sts-schedule-title">${this.scheduleSectionMarkup()}</section>
                    <section class="surface pad-5" id="sts-section-library" aria-labelledby="sts-library-title">${this.librarySectionMarkup()}</section>
                    <div class="studio-savebar surface" id="studio-settings-savebar">${this.settingsSaveBarMarkup()}</div>
                </form>
            ` : this.errorHost(this.settingsError, t('studio.settings.loadFailed'), 'page')}
            <section class="surface pad-5 studio-workers" id="studio-workers" aria-labelledby="sts-workers-title">
                ${this.workersMarkup()}
            </section>
        `);
        UI.icons(container);
        this.wireErrors(container);
        this.applySwatches(container);
        UI.restoreFocus(focus);
    },

    /** `#/studio?tab=settings&focus=library`: the setup checklist's links land on the field itself. */
    focusSettingsTarget() {
        const target = { library: 'sts-library-root', workers: 'sts-worker-name' }[this.hashValue('focus')];
        const el = target ? document.getElementById(target) : null;
        if (!el) return;
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
        if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    },

    settingId(path) {
        return `sts-${String(path).replace(/\./g, '-')}`;
    },

    /** One labelled settings control, bound to `settingsWork` at `path`. */
    /** Problems filed under a settings path, from the server's 400 or from the check before it. */
    settingProblems(path) {
        const map = this.settingsFieldProblems;
        return map && map.has(path) ? map.get(path) : [];
    },

    settingProblemsMarkup(id, problems) {
        return problems.length ? html`<ul class="problem-list" id="${id}-problems">${problems.map((p) => html`<li dir="auto">${p}</li>`)}</ul>` : '';
    },

    settingField(o) {
        const id = this.settingId(o.path);
        const raw = this.getPath(this.settingsWork, o.path);
        const value = raw === null || raw === undefined ? '' : String(raw);
        const hintId = o.hint ? `${id}-hint` : '';
        const problems = this.settingProblems(o.path);
        const described = [hintId, problems.length ? `${id}-problems` : ''].filter(Boolean).join(' ');
        const attrs = html` id="${id}" data-path="${o.path}"${described ? html` aria-describedby="${described}"` : ''}${problems.length ? html.raw(' aria-invalid="true"') : ''}`;
        let control;
        if (o.options) {
            control = html`
                <select class="select"${attrs} data-change="studio:setting">
                    ${o.options.map((opt) => html`<option value="${opt.value}" ${opt.value === value ? html.raw('selected') : ''}>${opt.label}</option>`)}
                </select>
            `;
        } else if (o.multiline) {
            control = html`<textarea class="field-textarea user-content" rows="${o.rows || 4}" dir="${o.dir || 'auto'}"${attrs} data-input="studio:setting">${value}</textarea>`;
        } else {
            control = html`<input class="field${o.mono ? html.raw(' field-mono') : ''}" type="${o.type || 'text'}" dir="${o.dir || 'auto'}" value="${value}"
                                  autocomplete="off" spellcheck="false" placeholder="${o.placeholder || ''}"${attrs} data-input="studio:setting">`;
        }
        return html`
            <div class="form-group">
                <label class="form-label" for="${id}">${o.label}</label>
                ${control}
                ${o.hint ? html`<p class="form-hint" id="${hintId}">${o.hint}</p>` : ''}
                ${this.settingProblemsMarkup(id, problems)}
            </div>
        `;
    },

    /** A colour: the picker, and its hex beside it so the value can be read and compared. */
    colorField(path, label) {
        const id = this.settingId(path);
        const raw = String(this.getPath(this.settingsWork, path) || '');
        const valid = this.ACCENT_RE.test(raw);
        return html`
            <div class="form-group studio-color-field">
                <label class="form-label" for="${id}">${label}</label>
                <span class="row gap-2">
                    <input type="color" class="studio-color" id="${id}" value="${valid ? raw.toLowerCase() : '#000000'}"
                           data-input="studio:setting" data-path="${path}" data-kind="color" data-hex="${id}-hex">
                    <code class="studio-hex" id="${id}-hex" dir="ltr">${valid ? raw.toUpperCase() : '—'}</code>
                </span>
            </div>
        `;
    },

    /** A list of strings (facts, DM bullets, slot times): one row each, add at the end, remove any. */
    listEditor(o) {
        const id = this.settingId(o.path);
        const items = Array.isArray(this.getPath(this.settingsWork, o.path)) ? this.getPath(this.settingsWork, o.path) : [];
        return html`
            <fieldset class="fieldset-plain studio-items" id="${id}" aria-describedby="${o.hint ? `${id}-hint` : ''}">
                <legend class="form-label">${o.label}</legend>
                ${items.length ? html`
                    <ol class="studio-item-list">
                        ${items.map((item, k) => {
                            const bad = this.settingProblems(`${o.path}.${k}`);
                            return html`
                            <li class="studio-item${bad.length ? html.raw(' has-problems') : ''}">
                                <input class="field${o.type === 'time' ? html.raw(' studio-field-time') : ''}" type="${o.type || 'text'}" dir="${o.type === 'time' ? 'ltr' : 'auto'}"
                                       id="${id}-${k}" value="${item}" data-input="studio:setting" data-path="${o.path}.${k}"
                                       ${bad.length ? html`aria-invalid="true" aria-describedby="${id}-${k}-problems"` : ''}
                                       aria-label="${t('studio.settings.itemN', { label: o.itemLabel, n: k + 1 })}">
                                <button type="button" class="icon-btn icon-btn-danger" data-action="studio:removeListItem"
                                        data-path="${o.path}" data-item="${k}" data-focus-key="${id}-remove-${k}"
                                        aria-label="${t('studio.settings.removeItem', { label: o.itemLabel, n: k + 1 })}"
                                        title="${t('studio.settings.removeItem', { label: o.itemLabel, n: k + 1 })}">
                                    <i data-lucide="x" aria-hidden="true"></i>
                                </button>
                                ${this.settingProblemsMarkup(`${id}-${k}`, bad)}
                            </li>
                        `;
                        })}
                    </ol>
                ` : html`<p class="text-meta">${t('studio.settings.listEmpty')}</p>`}
                ${UI.button({
                    variant: 'ghost', size: 'sm', icon: 'plus', label: o.addLabel,
                    action: 'studio:addListItem', data: { path: o.path }, id: `${id}-add`,
                })}
                ${o.hint ? html`<p class="form-hint" id="${id}-hint">${o.hint}</p>` : ''}
                ${this.settingProblemsMarkup(id, this.settingProblems(o.path))}
            </fieldset>
        `;
    },

    brandSectionMarkup() {
        const palette = this.settingsWork.brand.palette;
        return html`
            <h2 class="section-title" id="sts-brand-title">${t('studio.settings.brand')}</h2>
            <p class="form-hint studio-section-lede">${t('studio.settings.brandIntro')}</p>
            <div class="studio-settings-grid">
                ${this.settingField({ path: 'brand.name', label: t('studio.settings.brandName'), hint: t('studio.settings.brandNameHint') })}
                ${this.settingField({ path: 'brand.signature.latin', label: t('studio.settings.signatureLatin'), dir: 'ltr' })}
                ${this.settingField({ path: 'brand.signature.local', label: t('studio.settings.signatureLocal') })}
            </div>
            <fieldset class="fieldset-plain form-group" aria-describedby="sts-palette-hint">
                <legend class="form-label">${t('studio.settings.palette')}</legend>
                <ul class="studio-swatches">
                    ${palette.map((color, k) => {
                        const id = this.settingId(`brand.palette.${k}`);
                        const valid = this.ACCENT_RE.test(color);
                        return html`
                            <li class="studio-swatch">
                                <input type="color" class="studio-color" id="${id}" value="${valid ? color.toLowerCase() : '#000000'}"
                                       data-input="studio:setting" data-path="brand.palette.${k}" data-kind="color" data-hex="${id}-hex"
                                       aria-label="${t('studio.settings.swatch', { n: k + 1 })}">
                                <code class="studio-hex" id="${id}-hex" dir="ltr">${valid ? color.toUpperCase() : '—'}</code>
                                <button type="button" class="icon-btn icon-btn-danger" data-action="studio:removeSwatch" data-item="${k}"
                                        data-focus-key="sts-swatch-remove-${k}"
                                        aria-label="${t('studio.settings.removeSwatch', { n: k + 1 })}" title="${t('studio.settings.removeSwatch', { n: k + 1 })}"
                                        ${palette.length <= 1 ? html.raw('disabled') : ''}>
                                    <i data-lucide="x" aria-hidden="true"></i>
                                </button>
                            </li>
                        `;
                    })}
                </ul>
                ${UI.button({ variant: 'ghost', size: 'sm', icon: 'plus', label: t('studio.settings.addSwatch'), action: 'studio:addSwatch', id: 'sts-add-swatch' })}
                <p class="form-hint" id="sts-palette-hint">${t('studio.settings.paletteHint')}</p>
                ${this.settingProblemsMarkup('sts-brand-palette', [
                    ...this.settingProblems('brand.palette'),
                    ...palette.flatMap((c, k) => this.settingProblems(`brand.palette.${k}`)),
                ])}
            </fieldset>
            <div id="sts-brand-sample">${this.brandSampleMarkup()}</div>
            <div class="studio-settings-grid">
                ${this.colorField('brand.colors.ink', t('studio.settings.ink'))}
                ${this.colorField('brand.colors.paper', t('studio.settings.paper'))}
                ${this.colorField('brand.colors.muted', t('studio.settings.muted'))}
            </div>
            <div class="studio-settings-grid">
                ${this.settingField({
                    path: 'brand.fonts.display', label: t('studio.settings.fontDisplay'),
                    options: this.withCurrent(this.FONTS_DISPLAY, this.settingsWork.brand.fonts.display).map((f) => ({ value: f, label: f })),
                })}
                ${this.settingField({
                    path: 'brand.fonts.mono', label: t('studio.settings.fontMono'),
                    options: this.withCurrent(this.FONTS_MONO, this.settingsWork.brand.fonts.mono).map((f) => ({ value: f, label: f })),
                })}
                ${this.settingField({
                    path: 'brand.direction', label: t('studio.settings.direction'),
                    options: [{ value: 'rtl', label: t('studio.settings.rtl') }, { value: 'ltr', label: t('studio.settings.ltr') }],
                })}
            </div>
        `;
    },

    /**
     * A slide in miniature, painted with the brand's own ink, paper, muted and
     * accents, and signed with its signature — so a colour is judged where it will
     * be used, not as a hex code. Decorative for a screen reader: every value is a
     * labelled field above it.
     */
    brandSampleMarkup() {
        const b = this.settingsWork.brand;
        const hex = (v, d) => (this.ACCENT_RE.test(String(v || '')) ? String(v).toUpperCase() : d);
        const ink = hex(b.colors.ink, '#0B0B10');
        const paper = hex(b.colors.paper, '#F5F5F7');
        const muted = hex(b.colors.muted, '#8A8A99');
        const palette = b.palette.map((c) => hex(c, '')).filter(Boolean);
        const accent = palette[0] || '#FFD60A';
        const sign = [b.signature.latin, b.signature.local].map((s) => String(s || '').trim()).filter(Boolean).join(' · ');
        return html`
            <div class="brand-sample" aria-hidden="true">
                <span class="brand-sample-slide" data-bg="${ink}" dir="${b.direction === 'rtl' ? 'rtl' : 'ltr'}">
                    <span class="brand-sample-kicker" data-fg="${muted}">${t('studio.settings.sampleKicker')}</span>
                    <span class="brand-sample-title" data-fg="${paper}">${t('studio.settings.sampleTitle')} <span data-fg="${accent}">${t('studio.settings.sampleAccent')}</span></span>
                    <span class="brand-sample-sign" data-fg="${muted}">${sign || '—'}</span>
                </span>
                <span class="brand-sample-dots">${palette.map((c) => html`<span class="swatch-dot" data-color="${c}"></span>`)}</span>
            </div>
            <p class="form-hint">${t('studio.settings.sampleHint')}</p>
        `;
    },

    /** A fixed option list, plus whatever the tenant already has if it is not on it. */
    withCurrent(options, current) {
        const list = options.slice();
        if (current && !list.includes(current)) list.unshift(current);
        return list;
    },

    voiceSectionMarkup() {
        return html`
            <h2 class="section-title" id="sts-voice-title">${t('studio.settings.voice')}</h2>
            <p class="form-hint studio-section-lede">${t('studio.settings.voiceIntro')}</p>
            <div class="studio-settings-grid">
                ${this.settingField({
                    path: 'voice.language', label: t('studio.settings.language'),
                    options: [{ value: 'ar', label: t('lang.name.ar') }, { value: 'en', label: t('lang.name.en') }],
                })}
                ${this.settingField({
                    path: 'voice.digits', label: t('studio.settings.digits'), hint: t('studio.settings.digitsHint'),
                    options: [
                        { value: 'arabic-indic', label: t('studio.settings.digitsArabic') },
                        { value: 'latin', label: t('studio.settings.digitsLatin') },
                    ],
                })}
            </div>
            ${this.settingField({
                path: 'voice.guide', label: t('studio.settings.guide'), hint: t('studio.settings.guideHint'), multiline: true, rows: 8,
            })}
        `;
    },

    productSectionMarkup() {
        return html`
            <h2 class="section-title" id="sts-product-title">${t('studio.settings.product')}</h2>
            <p class="form-hint studio-section-lede">${t('studio.settings.productIntro')}</p>
            <div class="studio-settings-grid">
                ${this.settingField({ path: 'product.name', label: t('studio.settings.productName') })}
                ${this.settingField({ path: 'product.url', label: t('studio.settings.productUrl'), type: 'url', dir: 'ltr', mono: true, hint: t('studio.settings.productUrlHint') })}
            </div>
            ${this.listEditor({
                path: 'product.facts', label: t('studio.settings.facts'), itemLabel: t('studio.settings.fact'),
                addLabel: t('studio.settings.addFact'), hint: t('studio.settings.factsHint'),
            })}
            ${this.listEditor({
                path: 'product.dmBullets', label: t('studio.settings.dmBullets'), itemLabel: t('studio.settings.dmBullet'),
                addLabel: t('studio.settings.addBullet'), hint: t('studio.settings.dmBulletsHint'),
            })}
            <h3 class="studio-subhead">${t('studio.settings.ctas')}</h3>
            ${this.settingField({ path: 'cta.instagramAsk', label: t('studio.settings.instagramAsk'), hint: t('studio.settings.instagramAskHint') })}
            ${this.settingField({ path: 'cta.tiktokLine', label: t('studio.settings.tiktokLine'), hint: t('studio.settings.tiktokLineHint') })}
            ${this.settingField({
                path: 'cta.dmTemplate', label: t('studio.settings.dmTemplate'), multiline: true, rows: 12,
                hint: t('studio.settings.dmTemplateHint', { placeholders: this.DM_PLACEHOLDERS.map((p) => `{${p}}`).join(' ') }),
            })}
            <div id="sts-previews">${this.settingsPreviewsMarkup()}</div>
            <h3 class="studio-subhead">${t('studio.settings.slideWords')}</h3>
            <p class="form-hint">${t('studio.settings.slideWordsHint')}</p>
            <div class="studio-settings-grid">
                ${this.CTA_SLIDE_KEYS.map((key) => this.settingField({ path: `cta.slide.${key}`, label: t(`studio.settings.slide.${key}`) }))}
            </div>
        `;
    },

    /** `{placeholder}` → value, for the placeholders the DM template documents; anything else is left as typed. */
    fillTemplate(template, values) {
        return String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
            Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
        ));
    },

    settingsPreviewsMarkup() {
        const w = this.settingsWork;
        const lang = w.voice.language;
        const keyword = t('studio.settings.sample.keyword');
        const ask = this.fillTemplate(w.cta.instagramAsk, { keyword });
        const dm = this.fillTemplate(w.cta.dmTemplate, {
            username: t('studio.settings.sample.username'),
            question: t('studio.settings.sample.question'),
            pitch: t('studio.settings.sample.pitch'),
            url: w.product.url || t('studio.settings.sample.url'),
            bullets: w.product.dmBullets.filter((b) => String(b).trim()).join('\n'),
        });
        const missingKeyword = !!w.cta.instagramAsk && !w.cta.instagramAsk.includes('{keyword}');
        return html`
            <div class="studio-preview-card" aria-live="polite">
                <p class="studio-subhead">${t('studio.settings.previewIg', { keyword })}</p>
                <p class="studio-preview-line user-content" dir="auto" lang="${lang}">${ask || '—'}</p>
                ${missingKeyword ? html`<p class="form-hint text-warning">${t('studio.settings.askNoKeyword')}</p>` : ''}
                <p class="studio-subhead">${t('studio.settings.previewTt')}</p>
                <p class="studio-preview-line user-content" dir="auto" lang="${lang}">${w.cta.tiktokLine || '—'}</p>
                <p class="studio-subhead">${t('studio.settings.previewDm')}</p>
                <div class="studio-preview-dm user-content" dir="auto" lang="${lang}">${dm || '—'}</div>
            </div>
        `;
    },

    timeZones() {
        let zones = [];
        try {
            if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone');
        } catch { /* older engine: the short list */ }
        if (!zones || !zones.length) zones = this.FALLBACK_ZONES.slice();
        if (!zones.includes('UTC')) zones = ['UTC', ...zones];
        return this.withCurrent(zones, this.settingsWork.schedule.timezone);
    },

    scheduleSectionMarkup() {
        return html`
            <h2 class="section-title" id="sts-schedule-title">${t('studio.settings.schedule')}</h2>
            <p class="form-hint studio-section-lede">${t('studio.settings.scheduleIntro')}</p>
            ${this.settingField({
                path: 'schedule.timezone', label: t('studio.settings.timezone'), hint: t('studio.settings.timezoneHint'),
                options: this.timeZones().map((z) => ({ value: z, label: z })),
            })}
            ${this.listEditor({
                path: 'schedule.slots', type: 'time', label: t('studio.settings.slots'), itemLabel: t('studio.settings.slot'),
                addLabel: t('studio.settings.addSlot'), hint: t('studio.settings.slotsHint'),
            })}
        `;
    },

    librarySectionMarkup() {
        return html`
            <h2 class="section-title" id="sts-library-title">${t('studio.settings.library')}</h2>
            <p class="form-hint studio-section-lede">${t('studio.settings.libraryIntro')}</p>
            ${this.settingField({
                path: 'library.root', label: t('studio.settings.libraryRoot'), dir: 'ltr', mono: true,
                placeholder: t('studio.settings.libraryPlaceholder'), hint: t('studio.settings.libraryHint'),
            })}
        `;
    },

    settingsSaveBarMarkup() {
        const dirty = this.settingsDirty();
        const problems = this.settingsProblems || [];
        return html`
            ${this.settingsSaveError ? html`
                <div id="studio-settings-error" tabindex="-1">
                    ${UI.errorStrip(this.settingsSaveError, '', 'studio-settings-error-strip')}
                    ${problems.length ? html`<ul class="problem-list">${problems.map((p) => html`<li dir="auto">${p}</li>`)}</ul>` : ''}
                </div>
            ` : ''}
            <div class="studio-savebar-row">
                <p class="text-meta" role="status">${dirty ? t('studio.editor.unsaved') : t('studio.editor.saved')}</p>
                <div class="row row--wrap gap-2">
                    ${dirty ? UI.button({ variant: 'ghost', size: 'sm', icon: 'rotate-ccw', label: t('studio.editor.discard'), action: 'studio:discardSettings' }) : ''}
                    ${UI.button({
                        variant: 'primary', type: 'submit', icon: 'save', label: t('studio.settings.save'), id: 'sts-save', disabled: !dirty,
                        title: t('studio.editor.saveShortcut', { keys: this.saveKeys() }),
                    })}
                    ${dirty ? html`<kbd class="studio-kbd" aria-hidden="true">${this.saveKeys()}</kbd>` : ''}
                </div>
            </div>
        `;
    },

    // ─── Settings: editing ───────────────────────────────────────────────────
    isSettingPath(path) {
        return this.SETTINGS_SECTIONS.includes(String(path).split('.')[0]);
    },

    /** One handler for every settings control; `data-path` says where the value goes. */
    setting(el) {
        if (!el || !el.dataset || !this.settingsWork) return;
        const path = String(el.dataset.path || '');
        if (!this.isSettingPath(path)) return;
        let value = String(el.value === undefined || el.value === null ? '' : el.value);
        if (el.dataset.kind === 'color') {
            value = value.toUpperCase();
            const hex = document.getElementById(el.dataset.hex || '');
            if (hex) hex.textContent = value;
        }
        // An emptied folder is "not set", which the server and the Scan button read as null.
        if (path === 'library.root') value = value.trim() ? value : null;
        this.setPath(this.settingsWork, path, value);
        if (path.startsWith('cta.') || path.startsWith('product.')) {
            this.paintRegion('sts-previews', this.settingsPreviewsMarkup());
        }
        if (path.startsWith('brand.')) this.paintRegion('sts-brand-sample', this.brandSampleMarkup());
        // Being fixed: the field's own complaint goes the moment it is touched.
        const map = this.settingsFieldProblems;
        if (map && map.has(path)) {
            map.delete(path);
            if (typeof el.removeAttribute === 'function') el.removeAttribute('aria-invalid');
            const list = document.getElementById(`${el.id}-problems`);
            if (list && typeof list.remove === 'function') list.remove();
        }
        this.markSettingsDirty();
    },

    markSettingsDirty() {
        const dirty = this.settingsDirty();
        if (dirty === this._settingsDirty) return;
        this._settingsDirty = dirty;
        this.paintRegion('studio-settings-savebar', this.settingsSaveBarMarkup());
    },

    /** Structural edits repaint the one section they happened in. */
    paintSettingsSection(section) {
        const markup = {
            brand: () => this.brandSectionMarkup(),
            product: () => this.productSectionMarkup(),
            schedule: () => this.scheduleSectionMarkup(),
        }[section];
        if (markup) this.paintRegion(`sts-section-${section}`, markup());
    },

    LIST_PATHS: Object.freeze(['product.facts', 'product.dmBullets', 'schedule.slots']),

    addListItem(path) {
        if (!this.settingsWork || !this.LIST_PATHS.includes(path)) return;
        const list = this.getPath(this.settingsWork, path);
        const items = Array.isArray(list) ? list : [];
        // A new slot starts at noon rather than empty: a time input cannot show "no time".
        items.push(path === 'schedule.slots' ? '12:00' : '');
        this.setPath(this.settingsWork, path, items);
        this.paintSettingsSection(path.split('.')[0]);
        const field = document.getElementById(`${this.settingId(path)}-${items.length - 1}`);
        if (field && typeof field.focus === 'function') field.focus();
        this.markSettingsDirty();
    },

    removeListItem(path, index) {
        if (!this.settingsWork || !this.LIST_PATHS.includes(path)) return;
        const items = this.getPath(this.settingsWork, path);
        const k = Number(index);
        if (!Array.isArray(items) || !(k >= 0 && k < items.length)) return;
        items.splice(k, 1);
        this.paintSettingsSection(path.split('.')[0]);
        const add = document.getElementById(`${this.settingId(path)}-add`);
        if (add && typeof add.focus === 'function') add.focus();
        this.markSettingsDirty();
    },

    addSwatch() {
        if (!this.settingsWork) return;
        const palette = this.settingsWork.brand.palette;
        palette.push(palette.length ? String(palette[palette.length - 1]).toUpperCase() : '#888888');
        this.paintSettingsSection('brand');
        const swatch = document.getElementById(this.settingId(`brand.palette.${palette.length - 1}`));
        if (swatch && typeof swatch.focus === 'function') swatch.focus();
        this.markSettingsDirty();
    },

    removeSwatch(index) {
        if (!this.settingsWork) return;
        const palette = this.settingsWork.brand.palette;
        const k = Number(index);
        if (palette.length <= 1 || !(k >= 0 && k < palette.length)) return;
        palette.splice(k, 1);
        this.paintSettingsSection('brand');
        const add = document.getElementById('sts-add-swatch');
        if (add && typeof add.focus === 'function') add.focus();
        this.markSettingsDirty();
    },

    /**
     * The PUT body: all six sections, whole, so what the server stores is what the
     * form shows. Empty list rows are dropped, colours are upper-case hex, and an
     * empty library folder is null. `examples` is not sent, so the merge keeps it.
     */
    settingsPayload() {
        const w = this.clone(this.settingsWork);
        const tidy = (list) => (Array.isArray(list) ? list.map((x) => String(x).trim()).filter(Boolean) : []);
        w.brand.palette = w.brand.palette.map((c) => String(c).toUpperCase()).filter((c) => this.ACCENT_RE.test(c));
        ['ink', 'paper', 'muted'].forEach((key) => { w.brand.colors[key] = String(w.brand.colors[key] || '').toUpperCase(); });
        w.product.facts = tidy(w.product.facts);
        w.product.dmBullets = tidy(w.product.dmBullets);
        w.schedule.slots = tidy(w.schedule.slots);
        w.library.root = typeof w.library.root === 'string' && w.library.root.trim() ? w.library.root.trim() : null;
        const body = {};
        this.SETTINGS_SECTIONS.forEach((section) => { body[section] = w[section]; });
        return body;
    },

    /** `schedule.slots[1] must be…` → `schedule.slots.1`: the server leads every message with its path. */
    settingsProblemPath(message) {
        const m = /^([a-zA-Z]+(?:\.[a-zA-Z]+|\[\d+\])*)/.exec(String(message || ''));
        return m ? m[1].replace(/\[(\d+)\]/g, '.$1') : '';
    },

    /**
     * The server's own rules, checked before the round trip so the answer lands
     * beside the field at once. The server still checks everything.
     */
    localSettingsProblems(body) {
        const out = [];
        const add = (path, key) => out.push({ path, message: t(key) });
        if (body.product.url && !/^https:\/\//i.test(body.product.url)) add('product.url', 'studio.settings.err.url');
        if (body.cta.instagramAsk && !body.cta.instagramAsk.includes('{keyword}')) add('cta.instagramAsk', 'studio.settings.err.ask');
        if (!body.brand.palette.length) add('brand.palette', 'studio.settings.err.palette');
        if (!body.schedule.slots.length) add('schedule.slots', 'studio.settings.err.noSlot');
        const seen = new Set();
        (this.settingsWork.schedule.slots || []).forEach((slot, k) => {
            const v = String(slot || '').trim();
            if (v && seen.has(v)) add(`schedule.slots.${k}`, 'studio.settings.err.slotTwice');
            seen.add(v);
        });
        if (body.library.root && !/^(\/|[A-Za-z]:[\\/])/.test(body.library.root)) add('library.root', 'studio.settings.err.root');
        return out;
    },

    /** Problems beside their fields, the list in the save bar, and focus on the first field to fix. */
    showSettingsProblems(list, filed, message) {
        const map = new Map();
        filed.forEach((p) => {
            if (!p.path) return;
            if (!map.has(p.path)) map.set(p.path, []);
            map.get(p.path).push(p.message);
        });
        this.settingsFieldProblems = map;
        this.settingsProblems = list;
        this.settingsSaveError = message;
        this._settingsDirty = this.settingsDirty();
        this.paintSettingsPage();
        const first = filed.find((p) => p.path && document.getElementById(this.settingId(p.path)));
        const el = first ? document.getElementById(this.settingId(first.path)) : document.getElementById('studio-settings-error');
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
        if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
        Motion.announce(message);
    },

    async saveSettings(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (!this.settingsWork) return;
        const body = this.settingsPayload();
        const local = this.localSettingsProblems(body);
        if (local.length) {
            this.showSettingsProblems(local.map((p) => p.message), local, t('studio.settings.fixFirst'));
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        const seq = this._seq;
        try {
            const res = await API.saveStudioSettings(body);
            if (seq !== this._seq) return;
            this.settings = (res && res.settings) || { ...(this.settings || {}), ...body };
            this.loadSettingsWork();
            UI.toast(t('studio.settings.saved'));
            this.paintSettingsPage();
        } catch (err) {
            if (seq !== this._seq) return;
            const problems = this.problemList(err);
            this.showSettingsProblems(
                problems,
                problems.map((m) => ({ path: this.settingsProblemPath(m), message: m })),
                (err && err.message) || t('error.unexpected'),
            );
        } finally {
            restore();
        }
    },

    discardSettings() {
        this.loadSettingsWork();
        this.paintSettingsPage();
        Motion.announce(t('studio.editor.discarded'));
    },

    // ─── Settings: workers ───────────────────────────────────────────────────
    workerSeen(worker) {
        return (worker && (worker.last_seen_at || worker.lastSeen || worker.last_seen)) || null;
    },

    workerOnlineAt(worker) {
        const seen = Date.parse(this.workerSeen(worker) || '');
        return Number.isFinite(seen) && Date.now() - seen < this.WORKER_ONLINE_MS;
    },

    paintWorkers() {
        this.paintRegion('studio-workers', this.workersMarkup());
    },

    workersMarkup() {
        return html`
            <h2 class="section-title" id="sts-workers-title">${t('studio.workers.title')}</h2>
            <p class="form-hint">${t('studio.workers.intro')} ${UI.helpLink('worker', t('help.link.worker'), { newTab: true })}</p>
            ${this.newWorker ? this.newWorkerMarkup(this.newWorker) : ''}
            ${this.workersError && !this.workers.length
                ? this.errorHost(this.workersError, t('studio.workers.loadFailed'), 'page')
                : this.workersListMarkup()}
            <form id="studio-worker-form" class="studio-worker-form" data-submit="studio:createWorker" novalidate>
                <label class="form-label" for="sts-worker-name">${t('studio.workers.name')}</label>
                <div class="field-row">
                    <input class="field" id="sts-worker-name" name="name" dir="auto" autocomplete="off" maxlength="60"
                           placeholder="${t('studio.workers.namePlaceholder')}">
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'plus', label: t('studio.workers.create'), id: 'sts-worker-create' })}
                </div>
                <div id="studio-worker-error"></div>
            </form>
        `;
    },

    workersListMarkup() {
        const list = this.workers.slice().sort((a, b) => Number(!!(a && a.revoked_at)) - Number(!!(b && b.revoked_at)));
        if (!list.length) return html`<p class="studio-empty-note">${this.workersLoaded ? t('studio.workers.empty') : t('common.loading')}</p>`;
        return html`
            <ul class="studio-worker-list">
                ${list.map((w) => {
                    const revoked = !!w.revoked_at;
                    const seen = this.workerSeen(w);
                    const age = seen ? UI.relativeAge(seen) : null;
                    const online = !revoked && this.workerOnlineAt(w);
                    return html`
                        <li class="studio-worker${revoked ? html.raw(' is-revoked') : ''}">
                            <div class="studio-worker-main">
                                <strong dir="auto">${w.name || '—'}</strong>
                                <span class="text-meta" title="${age ? age.title : ''}">
                                    ${age ? t('studio.worker.lastSeen', { when: age.text }) : t('studio.workers.neverConnected')}
                                </span>
                                ${w.created_at ? html`<span class="text-meta">${t('studio.workers.created', { when: UI.formatDate(w.created_at) })}</span>` : ''}
                            </div>
                            ${revoked
                                ? html`<span class="badge badge-neutral">${t('studio.workers.revoked')}</span>`
                                : html`
                                    <span class="health-pill ${online ? html.raw('health-fresh') : html.raw('health-off')}">
                                        <span class="health-dot" aria-hidden="true"></span>
                                        ${online ? t('studio.worker.online') : t('studio.worker.offline')}
                                    </span>
                                    ${UI.button({
                                        variant: 'danger', size: 'sm', icon: 'ban', label: t('studio.workers.revoke'),
                                        action: 'studio:revokeWorker', data: { id: w.id }, focusKey: `worker-revoke-${w.id}`,
                                        ariaLabel: t('studio.workers.revokeNamed', { name: w.name || '' }),
                                    })}
                                `}
                        </li>
                    `;
                })}
            </ul>
        `;
    },

    /**
     * The token, once. It is on screen until Done, and nowhere else: not in the
     * list (the server returns only its hash's owner), not in a data attribute —
     * Copy reads it from memory — and not after this tab is left.
     */
    newWorkerMarkup(nw) {
        const name = (nw.worker && nw.worker.name) || '';
        return html`
            <div class="studio-token" role="alert" aria-labelledby="sts-token-title">
                <p class="studio-token-title" id="sts-token-title">
                    <i data-lucide="key-round" aria-hidden="true"></i>
                    <strong>${t('studio.workers.tokenTitle', { name })}</strong>
                </p>
                <p class="studio-token-warning">${t('studio.workers.tokenOnce')}</p>
                <div class="field-row">
                    <input class="field field-mono" id="sts-worker-token" readonly dir="ltr" spellcheck="false"
                           value="${nw.token}" aria-label="${t('studio.workers.tokenLabel')}" aria-describedby="sts-token-where">
                    ${UI.button({ variant: 'secondary', icon: 'copy', label: t('common.copy'), action: 'studio:copyToken', id: 'sts-copy-token' })}
                </div>
                <p class="form-hint" id="sts-token-where">${t('studio.workers.tokenWhere')}</p>
                ${UI.button({ variant: 'primary', size: 'sm', icon: 'check', label: t('studio.workers.tokenDone'), action: 'studio:dismissToken', id: 'sts-token-done' })}
            </div>
        `;
    },

    async createWorker(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const name = String(new FormData(form).get('name') || '').trim();
        if (!name) {
            this.paintRegion('studio-worker-error', UI.errorStrip(t('studio.workers.nameRequired'), '', 'studio-worker-error-strip'));
            const field = document.getElementById('sts-worker-name');
            if (field) UI.markInvalid(field, 'studio-worker-error-strip');
            return;
        }
        const restore = UI.formBusy(form, t('studio.workers.creating'));
        if (!restore) return;
        const seq = this._seq;
        try {
            const res = await API.createStudioWorker(name);
            if (seq !== this._seq) return;
            const token = res && typeof res.token === 'string' ? res.token : '';
            if (!token) throw new Error(t('studio.workers.noToken'));
            const worker = (res && res.worker) || { name };
            this.newWorker = { worker, token };
            this.workers = [worker, ...this.workers.filter((w) => !worker.id || String(w.id) !== String(worker.id))];
            this.workersLoaded = true;
            this.paintWorkers();
            const field = document.getElementById('sts-worker-token');
            if (field && typeof field.focus === 'function') {
                field.focus();
                if (typeof field.select === 'function') field.select();
            }
        } catch (err) {
            if (seq !== this._seq) return;
            this.paintRegion('studio-worker-error', UI.errorStrip((err && err.message) || t('error.unexpected'), '', 'studio-worker-error-strip'));
        } finally {
            restore();
        }
    },

    async copyToken() {
        const token = this.newWorker && this.newWorker.token;
        if (!token) return;
        try {
            await navigator.clipboard.writeText(token);
            UI.toast(t('common.copied'));
        } catch {
            // No clipboard outside a secure context: select it, so a manual copy is one keystroke.
            const field = document.getElementById('sts-worker-token');
            if (field && typeof field.select === 'function') field.select();
            UI.toast(t('studio.workers.copyFailed'), 'error');
        }
    },

    dismissToken() {
        this.newWorker = null;
        this.paintWorkers();
        const field = document.getElementById('sts-worker-name');
        if (field && typeof field.focus === 'function') field.focus();
    },

    revokeWorker(id) {
        const worker = this.workers.find((w) => String(w.id) === String(id));
        if (!worker) return;
        Admin.confirm({
            title: t('studio.workers.revokeTitle'),
            body: t('studio.workers.revokeBody', { name: worker.name || '' }),
            hint: t('studio.workers.revokeHint'),
            confirmLabel: t('studio.workers.revoke'),
            confirmIcon: 'ban',
            onConfirm: () => StudioPage.revokeConfirmed(id),
        });
    },

    async revokeConfirmed(id) {
        await API.revokeStudioWorker(id);
        const worker = this.workers.find((w) => String(w.id) === String(id));
        if (worker) worker.revoked_at = new Date().toISOString();
        if (this.newWorker && this.newWorker.worker && String(this.newWorker.worker.id) === String(id)) this.newWorker = null;
        UI.toast(t('studio.workers.revokedToast', { name: (worker && worker.name) || '' }));
        this.paintWorkers();
    },

};

/**
 * The delegated dispatcher catches synchronous throws only. Every async handler
 * here settles its own failures, but a rejection that got past one should still
 * be said out loud rather than left in the console.
 */
const studioReport = (value) => {
    Promise.resolve(value).catch((err) => UI.toast((err && err.message) || t('common.error'), 'error'));
};

UI.registerActions('studio', {
    // Status bar
    refreshStatus: () => studioReport(StudioPage.refreshStatus()),
    retryWorker: (el) => studioReport(StudioPage.retryWorker(el)),
    scanLibrary: (el) => studioReport(StudioPage.scanLibrary(el)),
    indexMissing: (el) => studioReport(StudioPage.indexMissing(el)),
    confirmTikTokBatch: () => StudioPage.confirmTikTokBatch(),
    // New carousel and the plan
    setMode: (el) => StudioPage.setMode(el.dataset.mode),
    newText: (el) => StudioPage.newTextInput(el),
    lessonSearch: (el) => StudioPage.lessonSearch(el),
    clearLessonSearch: () => StudioPage.clearLessonSearch(),
    rememberOption: (el) => StudioPage.rememberOption(el),
    pickAccent: (el) => StudioPage.pickAccent(el),
    toggleLesson: (el) => StudioPage.toggleLesson(el.dataset.id),
    showLesson: (el) => studioReport(StudioPage.showLesson(el.dataset.id)),
    indexLesson: (el) => studioReport(StudioPage.indexLesson(el, el.dataset.id)),
    generate: (el, e) => studioReport(StudioPage.generate(el, e)),
    accentPicked: (el) => StudioPage.accentPicked(el),
    accentTyped: (el) => StudioPage.accentTyped(el),
    planWeek: (el) => studioReport(StudioPage.planWeek(el)),
    closePlan: () => StudioPage.closePlan(),
    toggleProposal: (el) => StudioPage.toggleProposal(el.dataset.key),
    generateAll: () => studioReport(StudioPage.generateAll()),
    // Editor
    previewTab: (el) => StudioPage.previewTabSwitch(el.dataset.tab),
    selectSlide: (el) => StudioPage.selectSlide(Number(el.dataset.slide), { focus: 'tab' }),
    prevSlide: () => StudioPage.prevSlide(),
    nextSlide: () => StudioPage.nextSlide(),
    editSlide: (el) => StudioPage.editSlide(el),
    duplicateSlide: (el) => StudioPage.duplicateSlide(el.dataset.slide),
    changeKind: (el) => StudioPage.changeKind(el),
    undo: () => StudioPage.undoLast(),
    applyRestored: () => StudioPage.applyRestored(),
    dropRestored: () => StudioPage.dropRestored(),
    accentSwatch: (el) => StudioPage.accentSwatch(el),
    goSchedule: () => StudioPage.goSchedule(),
    focusFirstProblem: () => StudioPage.focusFirstProblem(),
    scheduleChange: () => StudioPage.scheduleChange(),
    openRegenerate: () => StudioPage.openRegenerate(),
    regenerate: (el, e) => studioReport(StudioPage.regenerate(el, e)),
    shotClean: (el) => StudioPage.shotClean(el),
    slideField: (el) => StudioPage.slideField(el),
    metaField: (el) => StudioPage.metaField(el),
    keywordField: (el) => StudioPage.keywordField(el),
    campaignField: (el) => StudioPage.campaignField(el),
    campaignToggle: (el) => StudioPage.campaignToggle(el),
    accentField: (el) => StudioPage.accentField(el),
    accentFieldPicked: (el) => StudioPage.accentFieldPicked(el),
    moveSlide: (el) => StudioPage.moveSlide(el.dataset.slide, Number(el.dataset.dir)),
    deleteSlide: (el) => StudioPage.deleteSlide(el.dataset.slide),
    addSlide: () => StudioPage.addSlide(),
    addItem: (el) => StudioPage.addItem(el.dataset.slide, el.dataset.path),
    removeItem: (el) => StudioPage.removeItem(el.dataset.slide, el.dataset.path, el.dataset.item),
    openShots: (el) => studioReport(StudioPage.openShots(el.dataset.slide)),
    shotLesson: (el) => StudioPage.shotLesson(el),
    pickShot: (el) => StudioPage.pickShot(el),
    removeShot: (el) => StudioPage.removeShot(el.dataset.slide),
    openRewrite: (el) => StudioPage.openRewrite(el.dataset.slide),
    rewrite: (el, e) => studioReport(StudioPage.rewrite(el, e)),
    save: (el) => studioReport(StudioPage.save(el)),
    discard: () => StudioPage.discard(),
    focusProblem: (el) => StudioPage.focusProblem(el.dataset.problem),
    renderAgain: (el) => studioReport(StudioPage.renderAgain(el)),
    slotChange: (el) => StudioPage.slotChange(el),
    schedule: (el, e) => studioReport(StudioPage.schedule(el, e)),
    tiktokPublic: (el) => studioReport(StudioPage.tiktokPublic(el)),
    deleteDraft: () => StudioPage.deleteDraft(),
    // Settings
    setting: (el) => StudioPage.setting(el),
    addListItem: (el) => StudioPage.addListItem(el.dataset.path),
    removeListItem: (el) => StudioPage.removeListItem(el.dataset.path, el.dataset.item),
    addSwatch: () => StudioPage.addSwatch(),
    removeSwatch: (el) => StudioPage.removeSwatch(el.dataset.item),
    saveSettings: (el, e) => studioReport(StudioPage.saveSettings(el, e)),
    discardSettings: () => StudioPage.discardSettings(),
    createWorker: (el, e) => studioReport(StudioPage.createWorker(el, e)),
    copyToken: () => studioReport(StudioPage.copyToken()),
    dismissToken: () => StudioPage.dismissToken(),
    revokeWorker: (el) => StudioPage.revokeWorker(el.dataset.id),
});
