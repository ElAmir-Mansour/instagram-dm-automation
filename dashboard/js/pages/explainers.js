/**
 * Explainers: researched, narrated, illustrated videos (v59).
 *
 * The server's contract is src/services/explainers/ and docs/specs/003-illustrated-explainers/contracts/http-api.md. A topic goes to Claude on the
 * owner's Mac (to Gemini when the Mac cannot write), which researches it and writes a script of one-sentence scenes, each with a picture brief and a
 * short label. The owner approves the script (gate 1); the Mac voices it and times every cut; the app draws one picture per scene; the owner approves
 * the pictures (gate 2); the Mac renders a vertical video, a horizontal video and a cover; Schedule posts them. This page has three views:
 *
 *   #/explainers                the new-explainer form, and the list
 *   #/explainers?id=<id>        one explainer as five steps: Script, Voice, Pictures, Video, Publish (`&step=` names the one that is open)
 *   #/explainers?tab=settings   the look (style, characters, voices, title colour, defaults), who writes the script, the music library
 *
 * Owner only, behind the platform admin's switch (Settings → Platform → Explainers). While the switch is off every route answers 404
 * EXPLAINERS_DISABLED, and the page says so instead of showing an error.
 *
 * ─── Nothing typed is lost to a poll ────────────────────────────────────────
 * While anything is being written, voiced, drawn or rendered, GET the list or the explainer every 5 s, only while the tab is visible. A poll repaints
 * the status, the notices and the step bar; the open step is repainted only when what it shows changed (`stepSignature`), and the pictures step patches
 * one scene at a time. The script editor is never repainted under the owner's hands: what is typed in it lives in `this.work`, the working copy, which
 * `captureEditor()` fills from the fields before anything that could repaint them (a structural edit, a save, another step, leaving the page).
 * `canLeave()` is true only while the working copy equals what was saved, so the router's leave guard and the shared `beforeunload` ask the question.
 *
 * ─── What the server decides, and what this page only mirrors ───────────────
 * The limits and the warnings below (scene counts, the length estimate, the label's four words) are copies of src/services/explainers/spec.ts so
 * the owner sees them while typing. The server checks every one again and its refusal is shown as the server worded it (`errors.<CODE>`).
 */
const ExplainersPage = {
    POLL_MS: 5000,
    ROWS_POLL_MS: 10000,

    LANGUAGES: ['ar', 'en'],
    TIERS: ['short', 'medium', 'long'],
    /** `sfx` is "sound effects only"; `music` is a track from the library under the voice. */
    SOUNDS: ['sfx', 'music'],
    STEPS: ['script', 'voice', 'pictures', 'video', 'publish'],
    STATUSES: ['writing', 'draft', 'voicing', 'drawing', 'review', 'rendering', 'ready', 'scheduled', 'failed'],
    /** A job is working on it: the page polls. */
    OPEN: ['writing', 'voicing', 'drawing', 'rendering'],
    /** The step of the page a failed step belongs to. */
    FAILED_STEP: { write: 'script', voice: 'voice', draw: 'pictures', render: 'video', schedule: 'publish' },
    /** Statuses in which the script, the pictures and the sound can be edited: not while a step that reads them is running. */
    EDITABLE: ['draft', 'drawing', 'review', 'ready', 'scheduled', 'failed'],
    ID_RE: /^[A-Za-z0-9_-]{1,64}$/,

    TOPIC_MIN: 3,
    TOPIC_MAX: 300,
    NOTES_MAX: 2000,
    LINKS_MAX: 10,
    REWRITE_NOTE_MAX: 1000,
    DRAW_NOTE_MAX: 300,
    /** Copies of `LIMITS` in src/services/explainers/spec.ts. */
    LIMITS: { title: 70, narration: 300, spoken: 400, brief: 500, label: 40, labelWords: 4, characters: 4 },
    SCENES_MAX: 300,
    SCENE_BOUNDS: { short: { min: 10, max: 30 }, medium: { min: 30, max: 90 }, long: { min: 120, max: 300 } },
    /** The seconds a script's estimate is held to (spec.ts `DURATION_RANGE_S`): a little wider than the tier it is named for. */
    DURATION_RANGE: { short: { min: 55, max: 95 }, medium: { min: 170, max: 310 }, long: { min: 570, max: 930 } },
    MIN_SOURCES_SHORT: 3,
    MIN_REPLIES: 5,
    /** Words a second the narrator speaks (`DEFAULT_EXPLAINER_PACE`); the settings can override it. */
    PACE: { ar: 2.1, en: 2.5 },
    /** The vertical video is posted as a Short up to this long; a longer one goes to YouTube as the horizontal video (FR-027). */
    SHORT_SECONDS: 180,

    /** `EXPLAINER_VOICES` in src/services/studio/settings.ts: a voice outside the list fails at the voice step, a day later. */
    GEMINI_VOICES: ['Charon', 'Sadaltager', 'Schedar', 'Gacrux', 'Sulafat', 'Achernar', 'Vindemiatrix', 'Rasalgethi'],
    STYLE_MAX: 600,
    VOICE_STYLE_MAX: 300,
    CHARACTERS_MAX: 6,
    TRACKS_MAX: 30,
    CHARACTER_NAME_MAX: 30,
    CHARACTER_DESCRIPTION_MAX: 400,
    TRACK_TEXT_MAX: 120,
    TRACK_CREDIT_MAX: 300,
    KEY_RE: /^[a-z0-9][a-z0-9_-]{0,29}$/,
    COLOUR_RE: /^#[0-9a-fA-F]{6}$/,
    /** An image model takes references under 512 x 512: the browser resizes an upload to at most this many pixels on its longest side. */
    REFERENCE_PX: 448,
    UPLOAD_MAX_BYTES: 25 * 1024 * 1024,
    AUDIO_TYPES: { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav' },
    DEFAULT_CONFIG: {
        style: '',
        characters: [],
        voices: { ar: 'ar-001-commercial-3', en: 'Sadaltager' },
        voice_style: '',
        pace: { ar: 2.1, en: 2.5 },
        writer: 'claude_mac',
        writer_fallback: true,
        title_color: '#FFD43B',
        defaults: { sound_mode: 'sfx', subtitles: true, language: 'ar', length_tier: 'short' },
        music: [],
    },

    // ─── State ───────────────────────────────────────────────────────────────
    kind: 'list',
    items: [],
    listError: null,
    detail: null,
    id: '',
    step: 'script',
    /** The settings' `explainer` section as read (over the defaults), or null until the settings were read. */
    cfg: null,
    cfgError: null,
    worker: null,
    /** The scheduled posts of this explainer's `schedule.row_ids`, read from the Scheduler's list: `{ id, platform, status, … }`. */
    rows: [],
    rowsError: null,
    rowsLoaded: false,
    /** The script as the owner is editing it (see the header): null until the script step was opened for this explainer. */
    work: null,
    workBase: '',
    /** A redraw note typed under a scene, by position, so a repaint of the grid never wipes it. */
    notes: Object.create(null),
    /** The four candidates generated for a character, by character index. */
    candidates: Object.create(null),
    /** The allowance meter on the settings view (GET /explainers/allowance). */
    allowance: null,
    /** Where the open view was painted (`location.hash`), to put the address back when the owner declines to leave unsaved edits. */
    _painted: '',
    _bodySig: '',
    _seq: 0,
    _timer: null,
    _rowsTimer: null,
    _onVisible: null,
    _destroyed: false,
    _uploads: 0,

    // ─── Lifecycle ───────────────────────────────────────────────────────────
    destroy() {
        // The edits stay in `this.work`: a visit that comes back to the same explainer finds them, one that is asked about leaving drops them.
        this.captureEditor();
        this._seq++;
        this._destroyed = true;
        this.stopPoll();
        if (this._onVisible) document.removeEventListener('visibilitychange', this._onVisible);
        this._onVisible = null;
    },

    resetTenantState() {
        this.destroy();
        this.kind = 'list';
        this.items = [];
        this.listError = null;
        this.detail = null;
        this.id = '';
        this.step = 'script';
        this.cfg = null;
        this.cfgError = null;
        this.worker = null;
        this.rows = [];
        this.rowsError = null;
        this.rowsLoaded = false;
        this.work = null;
        this.workBase = '';
        this.notes = Object.create(null);
        this.candidates = Object.create(null);
        this.allowance = null;
        this._bodySig = '';
        this._painted = '';
    },

    /** The router asks before it leaves for another page; a modal that is dirty is the shell's to ask about. */
    canLeave() {
        this.captureEditor();
        return !this.editorDirty() && this._uploads === 0;
    },

    /** The owner agreed to lose what was typed. */
    discardChanges() {
        this.work = null;
        this.workBase = '';
    },

    canUse() {
        return typeof App === 'undefined' || typeof App.canOperate !== 'function' || App.canOperate();
    },

    isAdmin() {
        return typeof App !== 'undefined' && typeof App.isAdmin === 'function' && App.isAdmin();
    },

    alive(seq) {
        if (seq !== this._seq || this._destroyed || !document.getElementById('page-container')) return false;
        return typeof App === 'undefined' || !App.currentPage || App.currentPage === 'explainers';
    },

    hashParam(name) {
        if (typeof App === 'undefined' || typeof App.hashParam !== 'function') return '';
        return String(App.hashParam(name) || '');
    },

    /** What the address asks for: `{ kind: 'detail', id, step }`, `{ kind: 'settings' }` or `{ kind: 'list' }`. */
    wanted() {
        const id = this.hashParam('id');
        if (id && this.ID_RE.test(id)) return { kind: 'detail', id, step: this.hashParam('step') };
        if (this.hashParam('tab') === 'settings') return { kind: 'settings' };
        return { kind: 'list' };
    },

    address(params) {
        if (typeof App !== 'undefined' && typeof App.route === 'function') return App.route('explainers', params);
        const query = Object.keys(params || {}).filter((k) => params[k]).map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&');
        return `#/explainers${query ? `?${query}` : ''}`;
    },

    /** Go to an address of this page: the router re-reads it (`onHashChange`). */
    go(params) {
        const target = this.address(params);
        if (String(location.hash || '') === target) { this.render(); return; }
        location.hash = target;
    },

    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        this.stopPoll();
        const seq = ++this._seq;
        this._destroyed = false;
        if (!this.canUse()) {
            container.innerHTML = esc(html`
                ${this.toolbarMarkup('videos')}
                <div class="surface pad-5">${Admin.emptyState('lock', t('explainers.viewer.title'), t('explainers.viewer.body'))}</div>
            `);
            UI.icons(container);
            return;
        }
        const want = this.wanted();
        this.kind = want.kind;
        if (want.kind === 'detail') await this.renderDetail(container, seq, want);
        else if (want.kind === 'settings') await this.renderSettings(container, seq);
        else await this.renderList(container, seq);
        if (this.alive(seq)) this._painted = String(location.hash || '');
    },

    /**
     * An address changed inside the page: another explainer, the list, the settings, or only the step. A change of view while the script
     * holds edits that were never saved asks first, and puts the address back when the owner keeps them.
     */
    async onHashChange() {
        const want = this.wanted();
        const sameView = want.kind === this.kind && (want.kind !== 'detail' || want.id === this.id);
        if (sameView && want.kind === 'detail') {
            if (want.step && this.STEPS.includes(want.step) && want.step !== this.step) this.setStep(want.step, false);
            this._painted = String(location.hash || '');
            return;
        }
        if (sameView) { this._painted = String(location.hash || ''); return; }
        const target = String(location.hash || '');
        if (!this.canLeave() && typeof App !== 'undefined' && typeof App.confirmLeave === 'function') {
            try { history.replaceState(null, '', this._painted || this.address({})); } catch { /* the address stays */ }
            const leave = await App.confirmLeave('page');
            if (!leave) return;
            this.discardChanges();
            location.hash = target;
            return;
        }
        this.discardChanges();
        await this.render();
    },

    skeleton() {
        return html`${Motion.cardGrid(3, 2)}${Motion.busy()}`;
    },

    // ─── Small pure helpers (tested directly) ────────────────────────────────
    /** Spoken words, as src/services/explainers/spec.ts counts them: what is between white space and has a letter or a digit in it. */
    countWords(text) {
        let count = 0;
        for (const token of String(text == null ? '' : text).split(/\s+/)) if (/[\p{L}\p{N}]/u.test(token)) count++;
        return count;
    },

    /** How long the narration takes to say: the spoken words of every scene over the narrator's pace, to a tenth of a second. */
    estimateSeconds(scenes, language, pace) {
        const lang = language === 'en' ? 'en' : 'ar';
        const perSecond = typeof pace === 'number' && Number.isFinite(pace) && pace > 0 ? pace : this.PACE[lang];
        let spoken = 0;
        for (const scene of Array.isArray(scenes) ? scenes : []) spoken += this.countWords(scene && scene.spoken);
        return Math.round((spoken / perSecond) * 10) / 10;
    },

    /** Whether a line ends in a question mark, Latin or Arabic, with closing quotes and brackets after it allowed. */
    endsWithQuestion(text) {
        const trimmed = String(text == null ? '' : text).replace(/[\s"'’”»)\]}›]+$/u, '');
        return trimmed.endsWith('?') || trimmed.endsWith('؟');
    },

    /** Seconds as m:ss, in Latin digits, for a time in the audio. */
    clock(seconds) {
        const s = Number(seconds);
        if (!Number.isFinite(s) || s < 0) return '—';
        const whole = Math.round(s);
        return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
    },

    /** "about 1:25": a length to read, from seconds. */
    lengthText(seconds) {
        const s = Number(seconds);
        return Number.isFinite(s) && s > 0 ? this.clock(s) : '—';
    },

    /**
     * The warnings of a script that the owner may still approve over, from what is in the editor: the same five as `checkDraft` in spec.ts.
     * Returns codes with the numbers their sentence needs.
     */
    scriptWarnings(scenes, sources, tier, language, pace) {
        const out = [];
        const list = Array.isArray(scenes) ? scenes : [];
        const range = this.DURATION_RANGE[tier] || this.DURATION_RANGE.short;
        const bounds = this.SCENE_BOUNDS[tier] || this.SCENE_BOUNDS.short;
        if (list.length > 0) {
            if (list.length < bounds.min || list.length > bounds.max) out.push({ code: 'scene_count', n: list.length, min: bounds.min, max: bounds.max });
            const est = this.estimateSeconds(list, language, pace);
            if (est < range.min) out.push({ code: 'duration_short', est, min: range.min, max: range.max });
            else if (est > range.max) out.push({ code: 'duration_long', est, min: range.min, max: range.max });
        }
        const cited = (Array.isArray(sources) ? sources : []).filter((s) => s && (String(s.title || '').trim() || String(s.url || '').trim())).length;
        if (cited === 0) out.push({ code: 'needs_sources' });
        else if (tier === 'short' && cited < this.MIN_SOURCES_SHORT) out.push({ code: 'few_sources', n: cited, min: this.MIN_SOURCES_SHORT });
        return out;
    },

    /**
     * The caption as LinkedIn keeps it: every blank line becomes a line holding one U+2800 (a blank Braille pattern), because LinkedIn
     * strips empty lines and keeps that one. Leading and trailing blank lines are dropped, so the post does not start or end on one.
     */
    linkedinText(text) {
        const trimmed = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
        if (!trimmed) return '';
        const lines = trimmed.split('\n');
        return lines.map((line) => (line.trim() === '' ? '\u2800' : line.replace(/\s+$/, ''))).join('\n');
    },

    /** `width x height` scaled down, never up, so its longest side is at most `max`; both sides stay at least 1. */
    fitWithin(width, height, max) {
        const w = Number(width);
        const h = Number(height);
        const limit = Number(max);
        if (!(w > 0) || !(h > 0) || !(limit > 0)) return { width: 1, height: 1 };
        const scale = Math.min(1, limit / Math.max(w, h));
        return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
    },

    /** A key for a character or a track from its name: lower-case Latin letters, digits, - and _, at most 30; `fallback` when the name has none. */
    keyFrom(text, taken, fallback) {
        const used = new Set(taken || []);
        const base = String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || fallback;
        let key = base.slice(0, 30);
        for (let n = 2; used.has(key); n += 1) key = `${base.slice(0, 26)}-${n}`;
        return key;
    },

    /** Every http or https link in `text`, one per line, in order, once each. Anything else on a line is `bad`. */
    parseLinks(text) {
        const links = [];
        const bad = [];
        for (const raw of String(text == null ? '' : text).split(/\s*[\n,]+\s*/)) {
            const line = raw.trim();
            if (!line) continue;
            let ok = false;
            try { ok = /^https?:$/.test(new URL(line).protocol); } catch { ok = false; }
            if (!ok) bad.push(line);
            else if (!links.includes(line)) links.push(line);
        }
        return { links, bad };
    },

    statusTone(status) {
        return { writing: 'info', voicing: 'info', drawing: 'info', rendering: 'info', draft: 'accent', review: 'accent', ready: 'success', scheduled: 'neutral', failed: 'danger' }[status] || 'neutral';
    },

    statusBadge(item) {
        const status = this.STATUSES.includes(item && item.status) ? item.status : 'draft';
        return html`<span class="badge badge-${html.raw(this.statusTone(status))}">${t(`explainers.status.${status}`)}</span>`;
    },

    isOpen(item) {
        return !!item && this.OPEN.includes(item.status);
    },

    /** A summary's progress, whichever way it comes: words, `{ done, total }` or a fraction. '' when there is none to say. */
    progressLabel(progress) {
        if (typeof progress === 'string') return progress.trim();
        if (progress && typeof progress === 'object' && Number.isFinite(Number(progress.done)) && Number.isFinite(Number(progress.total))) {
            return t('explainers.progress.drawn', { n: UI.formatNumber(Number(progress.done)), m: UI.formatNumber(Number(progress.total)) });
        }
        if (typeof progress === 'number' && Number.isFinite(progress)) return UI.formatPercent(Math.round(progress <= 1 ? progress * 100 : progress));
        return '';
    },

    /** What an open step is doing, in words: waiting for the Mac, its own progress line, or the step's name. */
    progressText(item) {
        const job = item && item.job;
        if (job && job.status === 'pending') {
            return this.worker && !this.worker.online ? t('explainers.progress.waitingOffline') : t('explainers.progress.waiting');
        }
        if (item && item.status === 'drawing' && item.draw_paused_until) return t('explainers.progress.paused');
        const said = (job && job.progress ? String(job.progress).trim() : '') || this.progressLabel(item && item.progress);
        if (said) return said;
        return t(`explainers.progress.${this.OPEN.includes(item && item.status) ? item.status : 'writing'}`);
    },

    tierLabel(tier) {
        return this.TIERS.includes(tier) ? t(`explainers.tier.${tier}`) : '';
    },

    /** The title a card or a header shows: the draft's title, else the topic the owner typed. */
    titleOf(item) {
        return String((item && (item.title || item.topic)) || '').trim() || t('explainers.untitled');
    },

    /** The name a downloaded file is saved under: the title (or the topic), the part (vertical, horizontal, cover) and the extension. */
    fileName(item, part, ext) {
        const base = String(item && (item.title || item.topic) || 'explainer').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'explainer';
        return `${base}-${part}.${ext}`;
    },

    /** The explainer as the pages read it: every field present, so no markup has to ask whether a list exists. */
    normalize(raw) {
        const d = raw && typeof raw === 'object' ? raw : {};
        const scenes = (Array.isArray(d.scenes) ? d.scenes : []).filter((s) => s && typeof s === 'object').map((s, i) => ({
            position: Number.isInteger(s.position) ? s.position : i,
            narration: String(s.narration || ''),
            spoken: String(s.spoken || ''),
            label: String(s.label || ''),
            brief: String(s.brief || ''),
            characters: Array.isArray(s.characters) ? s.characters.map(String) : [],
            continues: s.continues === true,
            start_s: Number.isFinite(Number(s.start_s)) && s.start_s !== null ? Number(s.start_s) : null,
            end_s: Number.isFinite(Number(s.end_s)) && s.end_s !== null ? Number(s.end_s) : null,
            picture: s.picture && typeof s.picture === 'object' ? s.picture : null,
            pictures: Array.isArray(s.pictures) ? s.pictures.filter((p) => p && typeof p === 'object') : [],
            draw_status: String(s.draw_status || 'pending'),
            draw_error: s.draw_error ? String(s.draw_error) : '',
            draw_note: s.draw_note ? String(s.draw_note) : '',
        }));
        return {
            ...d,
            id: String(d.id || ''),
            status: this.STATUSES.includes(d.status) ? d.status : 'draft',
            language: d.language === 'en' ? 'en' : 'ar',
            length_tier: this.TIERS.includes(d.length_tier) ? d.length_tier : 'short',
            sound_mode: d.sound_mode === 'music' ? 'music' : 'sfx',
            music_track_id: d.music_track_id ? String(d.music_track_id) : '',
            subtitles: d.subtitles !== false,
            source_links: Array.isArray(d.source_links) ? d.source_links.map((l) => (l && typeof l === 'object' ? String(l.url || '') : String(l || ''))).filter(Boolean) : [],
            draft_version: Number.isFinite(Number(d.draft_version)) ? Number(d.draft_version) : 0,
            audio_stale: d.audio_stale === true,
            scenes,
            allowance: d.allowance && typeof d.allowance === 'object' ? d.allowance : null,
            job: d.job && typeof d.job === 'object' ? d.job : null,
        };
    },

    normalizeConfig(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const base = this.DEFAULT_CONFIG;
        const str = (v, d) => (typeof v === 'string' ? v : d);
        const defaults = s.defaults && typeof s.defaults === 'object' ? s.defaults : {};
        const voices = s.voices && typeof s.voices === 'object' ? s.voices : {};
        const pace = s.pace && typeof s.pace === 'object' ? s.pace : {};
        const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
        return {
            style: str(s.style, base.style),
            characters: (Array.isArray(s.characters) ? s.characters : []).filter((c) => c && typeof c === 'object').map((c) => ({
                key: str(c.key, ''), name: str(c.name, ''), description: str(c.description, ''),
                ref_media_id: str(c.ref_media_id, '') || null, ref_url: str(c.ref_url, '') || null, approved_at: str(c.approved_at, '') || null,
            })),
            voices: { ar: str(voices.ar, base.voices.ar), en: str(voices.en, base.voices.en) },
            voice_style: str(s.voice_style, base.voice_style),
            pace: { ar: num(pace.ar, base.pace.ar), en: num(pace.en, base.pace.en) },
            writer: s.writer === 'gemini' ? 'gemini' : 'claude_mac',
            writer_fallback: s.writer_fallback !== false,
            title_color: this.COLOUR_RE.test(str(s.title_color, '')) ? s.title_color : base.title_color,
            defaults: {
                sound_mode: defaults.sound_mode === 'music' ? 'music' : 'sfx',
                subtitles: defaults.subtitles !== false,
                language: defaults.language === 'en' ? 'en' : 'ar',
                length_tier: this.TIERS.includes(defaults.length_tier) ? defaults.length_tier : 'short',
            },
            music: (Array.isArray(s.music) ? s.music : []).filter((m) => m && typeof m === 'object').map((m) => ({
                key: str(m.key, ''), title: str(m.title, ''), artist: str(m.artist, ''), media_id: str(m.media_id, ''), url: str(m.url, ''),
                license: str(m.license, ''), credit: str(m.credit, ''), credit_required: m.credit_required === true,
            })),
        };
    },

    /** The settings answer's `explainer` section, over the defaults; null when the read failed (the page still works with defaults). */
    acceptSettings(result) {
        if (result && result.status === 'fulfilled') {
            const s = result.value && result.value.settings;
            this.cfg = this.normalizeConfig(s && s.explainer);
            this.cfgError = null;
            // Every time on this page is the tenant's: tell the shared zone what the settings carry (as the Monteur does).
            if (s && s.schedule && s.schedule.timezone) UI.setZone(s.schedule.timezone);
        } else if (result) {
            this.cfgError = result.reason || new Error(t('error.unexpected'));
            if (!this.cfg) this.cfg = this.normalizeConfig(null);
        }
    },

    acceptWorker(result) {
        if (result && result.status === 'fulfilled' && result.value && result.value.worker) this.worker = result.value.worker;
    },

    isDisabled(err) {
        return !!err && err.code === 'EXPLAINERS_DISABLED';
    },

    /** A 404 that names no error is a server that does not have these routes yet (the dashboard can deploy before the backend). */
    notDeployed(err) {
        return !!err && err.status === 404 && !err.code;
    },

    disabledMarkup(err) {
        const missing = this.notDeployed(err);
        const target = this.isAdmin() && !missing && typeof App !== 'undefined' && typeof App.route === 'function'
            ? { action: { label: t('explainers.disabled.open'), href: App.route('settings', { s: 'platform', card: 'explainers' }), icon: 'settings' } }
            : undefined;
        return html`<div class="surface pad-5">${Admin.emptyState(
            'lock',
            missing ? t('explainers.notDeployed.title') : t('explainers.disabled.title'),
            missing ? t('explainers.notDeployed.body') : (this.isAdmin() ? t('explainers.disabled.bodyAdmin') : t('explainers.disabled.body')),
            target,
        )}</div>`;
    },

    // ─── Chrome: the Studio's tab bar and this page's own views ──────────────
    /** The Studio's tab bar with Explainers current (studio.js, monteur.js and infographics.js list the same links), and this page's views. */
    toolbarMarkup(active) {
        const tab = (key, href, icon, label) => html`
            <a class="btn btn-sm btn-ghost" href="${href}"
               ${key === 'explainers' ? html.raw('aria-current="page"') : ''}>
                <i data-lucide="${icon}" aria-hidden="true"></i> ${label}
            </a>
        `;
        return html`
            <div class="page-toolbar studio-toolbar">
                <nav class="segmented studio-seg studio-tabs" aria-label="${t('studio.tabs.label')}">
                    ${tab('home', '#/studio', 'layers', t('studio.tabs.carousels'))}
                    ${tab('monteur', '#/monteur', 'scissors', t('studio.tabs.monteur'))}
                    ${tab('infographics', '#/infographics', 'images', t('studio.tabs.infographics'))}
                    ${tab('explainers', '#/explainers', 'lightbulb', t('studio.tabs.explainers'))}
                    ${tab('settings', '#/studio?tab=settings', 'settings', t('studio.tabs.settings'))}
                </nav>
            </div>
            <div class="ex-views">${UI.tabs([
                { key: 'videos', label: t('explainers.views.videos'), href: '#/explainers' },
                { key: 'settings', label: t('explainers.views.settings'), href: '#/explainers?tab=settings' },
            ], { mode: 'link', current: active === 'settings' ? 'settings' : 'videos', label: t('explainers.views.label') })}</div>
        `;
    },

    /** Only when it matters: something is waiting and the Mac isn't there to do it. */
    workerMarkup() {
        const waiting = this.kind === 'detail'
            ? !!(this.detail && this.detail.job && this.detail.job.status === 'pending' && this.isOpen(this.detail))
            : this.items.some((i) => this.isOpen(i));
        if (!waiting || !this.worker || this.worker.online) return '';
        return html`<div class="ig-notice" role="status">
            <i data-lucide="wifi-off" aria-hidden="true"></i>
            <span>${t('explainers.worker.offline')}</span>
        </div>`;
    },

    // ─── Polling ─────────────────────────────────────────────────────────────
    wantsPoll() {
        if (this.kind === 'detail') return this.isOpen(this.detail) || this.rowsOpen();
        if (this.kind === 'list') return this.items.some((i) => this.isOpen(i));
        return false;
    },

    schedulePoll(seq) {
        this.stopPoll();
        if (!this.alive(seq) || !this.wantsPoll()) return;
        if (document.visibilityState === 'hidden') return; // resumed by the visibility listener
        this._timer = setTimeout(() => this.poll(seq), this.POLL_MS);
    },

    stopPoll() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        if (this._rowsTimer) clearTimeout(this._rowsTimer);
        this._rowsTimer = null;
    },

    bindVisibility(seq) {
        if (this._onVisible) document.removeEventListener('visibilitychange', this._onVisible);
        this._onVisible = () => { if (document.visibilityState === 'visible' && this.wantsPoll()) this.poll(seq); };
        document.addEventListener('visibilitychange', this._onVisible);
    },

    async poll(seq) {
        if (!this.alive(seq)) return;
        if (this.kind === 'detail') {
            const id = this.id;
            const [one, status] = await Promise.allSettled([API.getExplainer(id), API.getStudioStatus()]);
            if (!this.alive(seq) || id !== this.id) return;
            this.acceptWorker(status);
            if (one.status === 'fulfilled') this.applyDetail(one.value, { poll: true });
            if (this.detail && this.detail.schedule && this.rowsOpen()) await this.loadRows(seq);
            if (!this.alive(seq)) return;
            this.paintDetail();
        } else if (this.kind === 'list') {
            const [list, status] = await Promise.allSettled([API.getExplainers(), API.getStudioStatus()]);
            if (!this.alive(seq)) return;
            this.acceptList(list);
            this.acceptWorker(status);
            this.paintList();
        }
        this.schedulePoll(seq);
    },

    // ─── The list view ───────────────────────────────────────────────────────
    async renderList(container, seq) {
        const gate = Motion.beginLoad(container, () => html`${Motion.cardGrid(3, 2)}${Motion.busy()}`);
        const [list, settings, status] = await Promise.allSettled([API.getExplainers(), API.getStudioSettings(), API.getStudioStatus()]);
        if (!this.alive(seq)) return;
        gate.done();
        const failed = list.status === 'rejected' ? list.reason : null;
        if (failed && (this.isDisabled(failed) || this.notDeployed(failed))) {
            container.innerHTML = esc(html`${this.toolbarMarkup('videos')}${this.disabledMarkup(failed)}`);
            UI.icons(container);
            return;
        }
        this.acceptList(list);
        this.acceptSettings(settings);
        this.acceptWorker(status);
        container.innerHTML = esc(html`
            ${this.toolbarMarkup('videos')}
            <div id="ex-worker">${this.workerMarkup()}</div>
            <section class="surface pad-5 ex-new" aria-labelledby="ex-new-title">${this.newFormMarkup()}</section>
            <section aria-labelledby="ex-list-title" class="ex-list-section">
                <h2 class="section-title" id="ex-list-title">${t('explainers.list.title')}</h2>
                <div id="ex-list">${this.listMarkup()}</div>
            </section>
        `);
        UI.icons(container);
        this.syncSoundFields(document.getElementById('ex-new-form'));
        this.bindVisibility(seq);
        this.schedulePoll(seq);
    },

    acceptList(result) {
        if (result.status === 'fulfilled') {
            const rows = result.value && Array.isArray(result.value.items) ? result.value.items : [];
            this.items = rows.filter((r) => r && typeof r.id === 'string');
            this.listError = null;
        } else {
            this.listError = result.reason || new Error(t('error.unexpected'));
        }
    },

    paintList() {
        const list = document.getElementById('ex-list');
        if (list) {
            list.innerHTML = esc(this.listMarkup());
            UI.icons(list);
        }
        const worker = document.getElementById('ex-worker');
        if (worker) {
            worker.innerHTML = esc(this.workerMarkup());
            UI.icons(worker);
        }
    },

    listMarkup() {
        if (this.listError && !this.items.length) {
            return html`<div class="surface pad-5">${UI.errorBox(this.listError)}</div>`;
        }
        if (!this.items.length) {
            return html`<div class="surface pad-5">${Admin.emptyState('lightbulb', t('explainers.empty.title'), t('explainers.empty.body'))}</div>`;
        }
        return html`<div class="ex-grid">${this.items.map((item) => this.cardMarkup(item))}</div>`;
    },

    cardMarkup(item) {
        const thumb = safeUrl(item.thumb_url);
        const open = this.isOpen(item);
        const media = thumb
            ? html`<img src="${thumb}" alt="" loading="lazy" width="640" height="360">`
            : html`<div class="ex-thumb-empty" aria-hidden="true"><i data-lucide="${open ? 'loader' : 'image'}"></i></div>`;
        const detailHref = this.address({ id: item.id });
        const length = Number(item.est_seconds) > 0 ? this.lengthText(item.est_seconds) : '';
        return html`
            <article class="surface ex-card" data-id="${item.id}" data-focus-key="ex-${item.id}">
                <a class="ex-thumb" href="${detailHref}" tabindex="-1" aria-hidden="true">${media}</a>
                <div class="ex-body">
                    <h3 class="ex-title" dir="auto"><a href="${detailHref}">${this.titleOf(item)}</a></h3>
                    <div class="ex-meta">
                        ${this.statusBadge(item)}
                        <span class="badge badge-neutral">${t(`explainers.lang.${item.language === 'en' ? 'en' : 'ar'}`)}</span>
                        ${this.TIERS.includes(item.length_tier) ? html`<span class="badge badge-neutral">${this.tierLabel(item.length_tier)}</span>` : ''}
                        ${length ? html`<span class="badge badge-neutral">${UI.ltr(length)}</span>` : ''}
                    </div>
                    ${open ? html`<p class="ex-progress" role="status"><span class="spinner" aria-hidden="true"></span> <span dir="auto">${this.progressText(item)}</span></p>` : ''}
                    ${item.status === 'failed' && item.error ? html`<div class="ex-error">${this.failureHtml(item.error)}</div>` : ''}
                    <div class="ex-actions">
                        <a class="btn btn-secondary btn-sm" href="${detailHref}"><i data-lucide="${item.status === 'draft' ? 'pencil' : 'eye'}" aria-hidden="true"></i> ${t(item.status === 'draft' ? 'explainers.action.review' : 'explainers.action.open')}</a>
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', ariaLabel: t('explainers.action.delete'), action: 'explainers:removeFromList', data: { id: item.id } })}
                    </div>
                </div>
            </article>
        `;
    },

    /**
     * A stored failure as a sentence. The Mac's voice limit and a signed-out Claude are the two the owner can do something about, so they
     * are said plainly; any other text goes through `UI.failureError` (technical text is never the sentence, it is behind "Details").
     */
    failureHtml(text) {
        const raw = String(text == null ? '' : text).trim();
        if (/\bVOICE_LIMIT\b/.test(raw)) {
            return html`<div class="error-text"><strong class="error-sentence" dir="auto">${t('explainers.failed.voiceLimit')}</strong>${UI.errorDetails({ message: raw })}</div>`;
        }
        if (/failed to authenticate|not logged in|\boauth\b|\bsign[- ]?in\b|\/login\b/i.test(raw)) {
            return html`<div class="error-text"><strong class="error-sentence" dir="auto">${t('explainers.failed.macSignedOut')}</strong><span class="error-next" dir="auto">${t('explainers.failed.macSignedOutNext')}</span>${UI.errorDetails({ message: raw })}</div>`;
        }
        return UI.errorHtml(UI.failureError(raw));
    },

    // ─── The new-explainer form ──────────────────────────────────────────────
    /** The tracks of the music library, as `<option>`s. */
    trackOptions(selected) {
        const tracks = this.cfg ? this.cfg.music : [];
        return tracks.map((m) => html`<option value="${m.key}" ${m.key === selected ? html.raw('selected') : ''}>${m.title}${m.artist ? ` — ${m.artist}` : ''}${m.credit_required ? ` (${t('explainers.music.creditRequiredShort')})` : ''}</option>`);
    },

    /**
     * The Sound choice and the subtitles, the same in the new form and under the Video step: "music" shows the track picker (from the
     * music library in the settings), "sound effects only" hides it. `idp` prefixes the ids so the two forms never share one.
     */
    soundFieldsMarkup(idp, values) {
        const sound = values.sound_mode === 'music' ? 'music' : 'sfx';
        const tracks = this.cfg ? this.cfg.music : [];
        return html`
            <fieldset class="form-group ex-sound">
                <legend class="form-label">${t('explainers.sound.label')}</legend>
                <label class="ex-radio"><input type="radio" name="sound_mode" value="sfx" data-change="explainers:soundChanged" ${sound === 'sfx' ? html.raw('checked') : ''}> <span>${t('explainers.sound.sfx')}</span></label>
                <label class="ex-radio"><input type="radio" name="sound_mode" value="music" data-change="explainers:soundChanged" ${sound === 'music' ? html.raw('checked') : ''}> <span>${t('explainers.sound.music')}</span></label>
                <p class="form-hint">${t('explainers.sound.hint')}</p>
            </fieldset>
            <div class="form-group" data-ex-tracks ${sound === 'music' ? '' : html.raw('hidden')}>
                <label class="form-label" for="${idp}-track">${t('explainers.sound.track')}</label>
                ${tracks.length
                    ? html`<select class="select" id="${idp}-track" name="music_track_id">
                            <option value="">${t('explainers.sound.chooseTrack')}</option>
                            ${this.trackOptions(values.music_track_id)}
                        </select>
                        <p class="form-hint">${t('explainers.sound.trackHint')}</p>`
                    : html`<p class="form-hint">${t('explainers.sound.noTracks')} <a href="#/explainers?tab=settings">${t('explainers.sound.addTracks')}</a></p>`}
            </div>
            <label class="check-row ex-check"><input type="checkbox" name="subtitles" ${values.subtitles ? html.raw('checked') : ''}> <span>${t('explainers.subtitles.label')}</span></label>
        `;
    },

    newFormMarkup() {
        const d = (this.cfg || this.normalizeConfig(null)).defaults;
        const option = (value, label, selected) => html`<option value="${value}" ${selected ? html.raw('selected') : ''}>${label}</option>`;
        return html`
            <h2 class="section-title" id="ex-new-title"><i data-lucide="sparkles" aria-hidden="true"></i> ${t('explainers.new.title')}</h2>
            <p class="form-hint">${t('explainers.new.hint')} ${UI.helpLink('explainers#start', t('explainers.help.start'))}</p>
            <form id="ex-new-form" data-submit="explainers:create" novalidate>
                <div class="form-group">
                    <label class="form-label" for="ex-topic">${t('explainers.new.topic')}</label>
                    <textarea class="field field-textarea" id="ex-topic" name="topic" rows="2" maxlength="${this.TOPIC_MAX}" dir="auto" required
                              aria-describedby="ex-topic-hint" placeholder="${t('explainers.new.topicPlaceholder')}"></textarea>
                    <p class="form-hint" id="ex-topic-hint">${t('explainers.new.topicHint', { min: this.TOPIC_MIN, max: this.TOPIC_MAX })}</p>
                </div>
                <div class="ex-row">
                    <div class="form-group">
                        <label class="form-label" for="ex-language">${t('explainers.new.language')}</label>
                        <select class="select" id="ex-language" name="language">
                            ${this.LANGUAGES.map((l) => option(l, t(`explainers.lang.${l}`), d.language === l))}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="ex-tier">${t('explainers.new.length')}</label>
                        <select class="select" id="ex-tier" name="length_tier">
                            ${this.TIERS.map((x) => option(x, t(`explainers.tier.${x}`), d.length_tier === x))}
                        </select>
                    </div>
                </div>
                ${this.soundFieldsMarkup('ex-new', { sound_mode: d.sound_mode, music_track_id: '', subtitles: d.subtitles })}
                <details class="ex-more">
                    <summary>${t('explainers.new.more')}<i data-lucide="chevron-down" aria-hidden="true"></i></summary>
                    <div class="form-group">
                        <label class="form-label" for="ex-links">${t('explainers.new.links')}</label>
                        <textarea class="field field-textarea field-mono" id="ex-links" name="links" rows="3" dir="ltr" spellcheck="false"
                                  aria-describedby="ex-links-hint" placeholder="https://arxiv.org/abs/…"></textarea>
                        <p class="form-hint" id="ex-links-hint">${t('explainers.new.linksHint', { max: this.LINKS_MAX })}</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="ex-notes">${t('explainers.new.notes')}</label>
                        <textarea class="field field-textarea" id="ex-notes" name="notes" rows="3" maxlength="${this.NOTES_MAX}" dir="auto"
                                  placeholder="${t('explainers.new.notesPlaceholder')}"></textarea>
                    </div>
                </details>
                <div id="ex-new-error"></div>
                ${UI.button({ variant: 'primary', type: 'submit', icon: 'wand-sparkles', label: t('explainers.new.create') })}
            </form>
        `;
    },

    /** Show the track picker only while "music" is the choice. */
    syncSoundFields(form) {
        if (!form || typeof form.querySelector !== 'function') return;
        const checked = form.querySelector('input[name="sound_mode"]:checked');
        const wrap = form.querySelector('[data-ex-tracks]');
        if (wrap) wrap.hidden = !(checked && checked.value === 'music');
    },

    /** What a sound form holds: `{ sound_mode, music_track_id, subtitles }`, with the track only for music. */
    readSound(form) {
        const checked = form && form.querySelector ? form.querySelector('input[name="sound_mode"]:checked') : null;
        const sound = checked && checked.value === 'music' ? 'music' : 'sfx';
        const track = form && form.elements && form.elements.music_track_id ? String(form.elements.music_track_id.value || '') : '';
        const subtitles = form && form.elements && form.elements.subtitles ? !!form.elements.subtitles.checked : true;
        return { sound_mode: sound, music_track_id: sound === 'music' ? track : '', subtitles };
    },

    showError(id, err) {
        const box = document.getElementById(id);
        if (!box) return;
        box.innerHTML = esc(this.errorMarkup(err));
        UI.icons(box);
    },

    /** A refused request's sentence, with the server's problem list when it sent one (strings, or findings with a `code` and a `message`). */
    errorMarkup(err) {
        const raw = err && err.body && (Array.isArray(err.body.problems) ? err.body.problems : (Array.isArray(err.body.findings) ? err.body.findings : []));
        const problems = (raw || []).map((p) => this.findingText(p)).filter(Boolean);
        return html`${UI.errorBox(err)}
            ${problems.length ? html`<ul class="ig-problems">${problems.map((p) => html`<li dir="auto">${p}</li>`)}</ul>` : ''}`;
    },

    /** A finding (`{ code, message, scene?, field? }`) as a line: its own sentence when the catalogue has one, else the server's. */
    findingText(finding) {
        if (typeof finding === 'string') return finding;
        if (!finding || typeof finding !== 'object') return '';
        const code = typeof finding.code === 'string' ? finding.code : '';
        const key = code ? `explainers.finding.${code}` : '';
        const said = key ? t(key) : '';
        const text = said && said !== key ? said : String(finding.message || '');
        return Number.isInteger(finding.scene) ? t('explainers.finding.scene', { n: UI.formatNumber(finding.scene + 1), text }) : text;
    },

    // ─── The detail view ─────────────────────────────────────────────────────
    async renderDetail(container, seq, want) {
        const id = want.id;
        const gate = Motion.beginLoad(container, () => html`${Motion.cardGrid(1, 4)}${Motion.busy()}`);
        const [one, settings, status] = await Promise.allSettled([API.getExplainer(id), API.getStudioSettings(), API.getStudioStatus()]);
        if (!this.alive(seq)) return;
        gate.done();
        if (this.id !== id) {
            // Another explainer: nothing typed for the one before is this one's.
            this.work = null;
            this.workBase = '';
            this.notes = Object.create(null);
            this.rows = [];
            this.rowsLoaded = false;
            this.rowsError = null;
        }
        this.id = id;
        if (one.status === 'rejected') {
            this.detail = null;
            container.innerHTML = esc(html`${this.toolbarMarkup('videos')}${this.detailErrorMarkup(one.reason)}`);
            UI.icons(container);
            return;
        }
        this.acceptSettings(settings);
        this.acceptWorker(status);
        this.detail = null;
        if (!this.applyDetail(one.value, { first: true, step: want.step })) {
            container.innerHTML = esc(html`${this.toolbarMarkup('videos')}<div class="surface pad-5">${UI.errorBox(new Error(t('error.unexpected')))}</div>`);
            UI.icons(container);
            return;
        }
        this._bodySig = this.stepSignature();
        container.innerHTML = esc(html`
            ${this.toolbarMarkup('videos')}
            <div id="ex-detail">${this.detailMarkup()}</div>
        `);
        UI.icons(container);
        this.afterBodyPaint();
        this.bindVisibility(seq);
        if (this.detail.schedule) await this.loadRows(seq);
        if (!this.alive(seq)) return;
        if (this.detail.schedule && this.step === 'publish') this.paintBody(true);
        this.schedulePoll(seq);
    },

    detailErrorMarkup(err) {
        if (this.isDisabled(err) || this.notDeployed(err)) return this.disabledMarkup(err);
        if (err && err.code === 'EXPLAINER_NOT_FOUND') {
            return html`<div class="surface pad-5">${Admin.emptyState('search-x', t('explainers.notFound.title'), t('explainers.notFound.body'), { action: { label: t('explainers.back'), href: '#/explainers', icon: 'arrow-left' } })}</div>`;
        }
        return html`<div class="surface pad-5">${UI.errorBox(err)}
            <div class="ex-actions">${UI.button({ variant: 'secondary', icon: 'rotate-cw', label: t('common.retry'), action: 'explainers:reload' })}</div></div>`;
    },

    /** Take an explainer from the server into the page: the first read, a poll, or the answer of a route. */
    applyDetail(raw, options) {
        const o = options || {};
        const d = this.normalize(raw);
        if (!d.id || (this.id && d.id !== this.id)) return false;
        const before = this.detail;
        this.detail = d;
        // What is typed in the editor is read first: a poll must never find the working copy behind the fields.
        this.captureEditor();
        // A script the server moved on from (another version): edits that were never saved stay and follow the version; an untouched copy is
        // read again from what the server holds. The same version keeps the working copy as it is.
        if (this.work && this.work.id === d.id && this.work.base !== d.draft_version) {
            if (this.editorDirty()) this.work.base = d.draft_version;
            else { this.work = null; this.workBase = ''; }
        }
        if (o.first) {
            const asked = this.STEPS.includes(o.step) ? o.step : '';
            this.step = asked && this.reachable(asked, d) ? asked : this.defaultStep(d);
        } else if (before && this.step === this.defaultStep(before) && this.defaultStep(before) !== this.defaultStep(d)) {
            // They were watching the step that just finished: the page moves on with the pipeline.
            this.step = this.defaultStep(d);
            this.syncAddress();
        } else if (!this.reachable(this.step, d)) {
            this.step = this.defaultStep(d);
        }
        if (before && before.status !== d.status && typeof Motion !== 'undefined' && typeof Motion.announce === 'function') {
            Motion.announce(t('explainers.announce.status', { status: t(`explainers.status.${d.status}`) }));
        }
        return true;
    },

    /** The step the pipeline is at: where the owner is most likely to want to be. */
    defaultStep(d) {
        switch (d && d.status) {
            case 'voicing': return 'voice';
            case 'drawing': case 'review': return 'pictures';
            case 'rendering': case 'ready': return 'video';
            case 'scheduled': return 'publish';
            case 'failed': return this.FAILED_STEP[d.failed_step] || 'script';
            default: return 'script';
        }
    },

    hasDraft(d) {
        return !!d && (d.scenes.length > 0 || !!d.draft);
    },

    hasPictures(d) {
        return !!d && d.scenes.some((s) => s.picture || s.pictures.length);
    },

    /** Whether a step has something to show yet. The script is always there; the captions and the LinkedIn kit are in Publish from the first draft. */
    reachable(step, d) {
        if (!d) return false;
        switch (step) {
            case 'voice': return !!d.audio || d.status === 'voicing' || (d.status === 'failed' && d.failed_step === 'voice');
            case 'pictures': return this.hasPictures(d) || ['drawing', 'review', 'rendering', 'ready', 'scheduled'].includes(d.status) || (d.status === 'failed' && d.failed_step === 'draw');
            case 'video': return !!d.render || ['rendering', 'ready', 'scheduled'].includes(d.status) || (d.status === 'failed' && d.failed_step === 'render');
            case 'publish': return this.hasDraft(d);
            default: return true;
        }
    },

    isEditable() {
        return !!this.detail && this.EDITABLE.includes(this.detail.status);
    },

    syncAddress() {
        const next = this.address({ id: this.id, step: this.step });
        try {
            history.replaceState(null, '', next);
            this._painted = next;
        } catch { /* the address stays; the page on screen is still the right one */ }
    },

    setStep(step, replace) {
        if (!this.detail || !this.STEPS.includes(step) || !this.reachable(step, this.detail)) return;
        this.captureEditor();
        this.step = step;
        if (replace !== false) this.syncAddress();
        this.paintRegion('ex-notices', this.noticesMarkup());
        this.paintSteps();
        this.paintBody(true);
    },

    paintRegion(id, markup) {
        const el = document.getElementById(id);
        if (!el) return null;
        el.innerHTML = esc(markup);
        UI.icons(el);
        return el;
    },

    paintSteps() {
        this.paintRegion('ex-steps', this.stepsMarkup());
    },

    paintDetail() {
        if (this.kind !== 'detail' || !this.detail) return;
        const host = document.getElementById('ex-detail');
        if (!host) return;
        const focus = UI.captureFocus(host);
        this.paintRegion('ex-head', this.headMarkup());
        this.paintRegion('ex-worker', this.workerMarkup());
        this.paintRegion('ex-notices', this.noticesMarkup());
        this.paintSteps();
        this.paintBody(false);
        UI.restoreFocus(focus);
    },

    /**
     * Repaint the open step, but only when what it shows has changed: a poll that finds nothing new must not reset a video that is playing,
     * a select the owner is choosing from, or the script they are typing. The pictures step is patched a scene at a time instead.
     */
    paintBody(force) {
        const body = document.getElementById('ex-body');
        if (!body || !this.detail) return;
        const sig = this.stepSignature();
        if (!force && sig === this._bodySig) {
            this.patchBody();
            return;
        }
        this.captureEditor();
        this.capturePictureNotes();
        const focus = UI.captureFocus(body);
        body.innerHTML = esc(this.bodyMarkup());
        this._bodySig = sig;
        UI.icons(body);
        this.afterBodyPaint();
        UI.restoreFocus(focus);
    },

    /** Everything a step's markup depends on except what lives in its fields. A new value is a repaint. */
    stepSignature() {
        const d = this.detail;
        if (!d) return '';
        const job = d.job ? `${d.job.status || ''}~${d.job.progress || ''}` : '';
        const base = [this.step, d.status, d.draft_version, d.audio_stale ? 1 : 0, d.failed_step || '', this.worker && this.worker.online ? 1 : 0];
        switch (this.step) {
            case 'script':
                return [...base, this.isEditable() ? 'e' : 'r', d.scenes.length ? 's' : '', d.status === 'writing' ? job : ''].join('|');
            case 'voice': {
                const a = d.audio;
                return [...base, a ? `${a.url}~${a.version}~${a.fallback ? 1 : 0}` : '', d.scenes.map((s) => `${s.start_s}-${s.end_s}`).join(','), d.status === 'voicing' ? job : ''].join('|');
            }
            case 'pictures':
                return [...base, d.scenes.length].join('|');
            case 'video': {
                const r = d.render;
                return [...base, r ? `${r.vertical_url}~${r.horizontal_url}~${r.cover_url}~${r.version}~${r.sound_mode}` : '', d.sound_mode, d.music_track_id, d.subtitles ? 1 : 0, d.status === 'rendering' ? job : ''].join('|');
            }
            case 'publish':
                return [...base, d.schedule ? `${d.schedule.scheduled_time}~${(d.schedule.row_ids || []).join(',')}` : '', this.rows.map((r) => `${r.id}~${r.status}~${r.published_post_id || ''}`).join(','), d.render ? d.render.version : ''].join('|');
            default:
                return base.join('|');
        }
    },

    bodyMarkup() {
        switch (this.step) {
            case 'voice': return this.voiceMarkup();
            case 'pictures': return this.picturesMarkup();
            case 'video': return this.videoMarkup();
            case 'publish': return this.publishMarkup();
            default: return this.scriptMarkup();
        }
    },

    /** Work that follows a paint of the body: what only the live DOM can do. */
    afterBodyPaint() {
        if (this.step === 'script') this.refreshEstimate();
        if (this.step === 'pictures') this.restorePictureNotes();
        if (this.step === 'video') this.syncSoundFields(document.getElementById('ex-sound-form'));
    },

    /** The pictures step is patched in place: the summary, the approve block, and each scene whose picture or status changed. */
    patchBody() {
        if (this.step !== 'pictures' || !this.detail) return;
        this.paintRegion('ex-pic-summary', this.picSummaryMarkup());
        this.paintRegion('ex-pic-approve', this.picApproveMarkup());
        for (const s of this.detail.scenes) {
            const media = document.getElementById(`ex-media-${s.position}`);
            const sig = this.sceneSig(s);
            if (media && media.dataset && media.dataset.sig !== sig) {
                media.dataset.sig = sig;
                media.innerHTML = esc(this.sceneMediaMarkup(s));
                UI.icons(media);
            }
        }
    },

    // ─── Head, notices, steps ────────────────────────────────────────────────
    headMarkup() {
        const d = this.detail;
        const writer = d.draft && d.draft.writer ? t(`explainers.writer.${d.draft.writer === 'gemini' ? 'gemini' : 'claude_mac'}`) : '';
        return html`
            <header class="ex-head">
                <div class="ex-head-main">
                    <a class="btn btn-ghost btn-sm ex-back" href="#/explainers"><i data-lucide="arrow-left" aria-hidden="true"></i> ${t('explainers.back')}</a>
                    <h2 class="ex-head-title" dir="auto">${this.titleOf(d)}</h2>
                    ${d.title && d.topic && d.title !== d.topic ? html`<p class="ex-head-topic" dir="auto">${d.topic}</p>` : ''}
                    <div class="ex-meta" role="status">
                        ${this.statusBadge(d)}
                        <span class="badge badge-neutral">${t(`explainers.lang.${d.language}`)}</span>
                        <span class="badge badge-neutral">${this.tierLabel(d.length_tier)}</span>
                        <span class="badge badge-neutral">${t(d.sound_mode === 'music' ? 'explainers.sound.musicShort' : 'explainers.sound.sfxShort')}</span>
                        ${writer ? html`<span class="badge badge-neutral">${t('explainers.writtenBy', { writer })}</span>` : ''}
                    </div>
                </div>
                <div class="ex-head-actions">
                    ${UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('explainers.action.delete'), action: 'explainers:remove', id: 'ex-delete' })}
                </div>
            </header>
        `;
    },

    callout(icon, body, tone) {
        return html`<div class="studio-callout${tone === 'warning' ? ' is-warning' : ''}" role="status">
            <i data-lucide="${icon}" aria-hidden="true"></i>
            <div class="studio-callout-body">${body}</div>
        </div>`;
    },

    /** What needs the owner's eye on every step: a failure, a pause, audio out of date, a render older than the edits. */
    noticesMarkup() {
        const d = this.detail;
        if (!d) return '';
        const out = [];
        if (d.status === 'failed') {
            out.push(this.callout('alert-triangle', html`
                <p class="studio-callout-title">${t('explainers.failed.title', { step: t(`explainers.failedStep.${this.FAILED_STEP[d.failed_step] ? d.failed_step : 'write'}`) })}</p>
                ${d.error ? this.failureHtml(d.error) : html`<p>${t('explainers.failed.noReason')}</p>`}
                <div class="row row--wrap gap-2">
                    ${UI.button({ variant: 'primary', size: 'sm', icon: 'rotate-cw', label: t('explainers.action.retry'), action: 'explainers:retry', id: 'ex-retry' })}
                    ${UI.helpLink('explainers#troubleshooting', t('explainers.help.troubleshooting'))}
                </div>`, 'warning'));
        } else if (d.error && this.isOpen(d) && !(d.status === 'drawing' && d.draw_paused_until)) {
            out.push(this.callout('info', html`<p class="studio-callout-title">${t('explainers.note.title')}</p>${this.failureHtml(d.error)}`));
        }
        if (d.audio_stale && this.step !== 'script' && ['drawing', 'review', 'ready'].includes(d.status)) {
            out.push(this.callout('history', html`
                <p class="studio-callout-title">${t('explainers.stale.title')}</p>
                <p>${t('explainers.stale.body')}</p>
                <div class="row row--wrap gap-2">
                    ${UI.button({ variant: 'primary', size: 'sm', icon: 'refresh-cw', label: t('explainers.action.revoice'), action: 'explainers:revoice', id: 'ex-revoice' })}
                </div>`, 'warning'));
        }
        if (d.render && d.render.version !== undefined && Number(d.render.version) !== d.draft_version && ['ready', 'scheduled'].includes(d.status) && this.step === 'video') {
            out.push(this.callout('history', html`<p>${t('explainers.render.older')}</p>`, 'warning'));
        }
        return html`${out}`;
    },

    stepsMarkup() {
        const d = this.detail;
        const at = this.STEPS.indexOf(this.defaultStep(d));
        return html`<ol class="studio-stepper ex-steps">${this.STEPS.map((key, i) => {
            const reachable = this.reachable(key, d);
            const open = key === this.step;
            const state = i < at ? 'done' : i === at ? 'current' : 'todo';
            const name = t(`explainers.step.${key}`);
            const inner = html`<span class="studio-step-num" aria-hidden="true">${state === 'done' ? html`<i data-lucide="check" aria-hidden="true"></i>` : UI.formatNumber(i + 1)}</span><span class="studio-step-label">${name}</span>`;
            // The name is on the link itself: on a phone the shared stylesheet hides every label but one, and a link must stay named.
            return html`<li class="studio-step is-${html.raw(state)}${open ? ' is-open' : ''}">${reachable
                ? html`<a class="ex-step-link" href="${this.address({ id: d.id, step: key })}" aria-label="${name}" data-action="explainers:goStep" data-step="${key}"${open ? html.raw(' aria-current="step"') : ''}>${inner}</a>`
                : html`<span class="ex-step-link is-off" role="link" aria-disabled="true" aria-label="${name}">${inner}</span>`}</li>`;
        })}</ol>`;
    },

    detailMarkup() {
        return html`
            <div id="ex-head">${this.headMarkup()}</div>
            <div id="ex-worker">${this.workerMarkup()}</div>
            <div id="ex-notices" class="ex-notices">${this.noticesMarkup()}</div>
            <nav id="ex-steps" aria-label="${t('explainers.steps.label')}">${this.stepsMarkup()}</nav>
            <section id="ex-body" class="surface pad-5 ex-step-body" aria-label="${t('explainers.steps.label')}">${this.bodyMarkup()}</section>
        `;
    },

    stepHead(titleKey, helpMarkup) {
        return html`<div class="ex-step-head"><h3 class="section-title">${t(titleKey)}</h3>${helpMarkup}</div>`;
    },

    /** A step with nothing to show yet, or a job working on it: one calm panel with a spinner when something is running. */
    waitingMarkup(titleKey, bodyKey, running) {
        const d = this.detail;
        return html`<div class="ex-wait">
            ${running ? html`<span class="spinner" aria-hidden="true"></span>` : html`<i data-lucide="hourglass" aria-hidden="true"></i>`}
            <div>
                <p class="ex-wait-title">${t(titleKey)}</p>
                ${running ? html`<p class="ex-progress" dir="auto" role="status">${this.progressText(d)}</p>` : ''}
                <p class="form-hint">${t(bodyKey)}</p>
            </div>
        </div>`;
    },

    // ─── Step 1: the script ──────────────────────────────────────────────────
    scriptMarkup() {
        const d = this.detail;
        const help = UI.helpLink('explainers#script', t('explainers.help.script'));
        if (!this.hasDraft(d)) {
            const running = d.status === 'writing';
            return html`${this.stepHead('explainers.script.title', help)}${this.waitingMarkup(
                running ? 'explainers.script.writingTitle' : 'explainers.script.noneTitle',
                running ? 'explainers.script.writingBody' : 'explainers.script.noneBody',
                running,
            )}`;
        }
        this.ensureWork();
        const w = this.work;
        const ro = !this.isEditable();
        const lock = ro ? html.raw(' readonly') : '';
        const writer = d.draft && d.draft.writer ? t(`explainers.writer.${d.draft.writer === 'gemini' ? 'gemini' : 'claude_mac'}`) : '';
        return html`
            ${this.stepHead('explainers.script.title', help)}
            ${d.status === 'writing' ? this.callout('refresh-cw', html`<p>${t('explainers.script.rewriting')}</p><p class="ex-progress" dir="auto" role="status">${this.progressText(d)}</p>`) : ''}
            ${ro && d.status !== 'writing' ? html`<p class="form-hint">${t('explainers.script.readOnly')}</p>` : ''}
            ${writer ? html`<p class="form-hint ex-writer">${t('explainers.script.writer', { writer })} ${d.draft && d.draft.writer === 'gemini' ? t('explainers.script.writerGemini') : ''}</p>` : ''}
            ${!ro && d.status !== 'draft' && d.audio ? html`<p class="form-hint">${t('explainers.script.editsStale')}</p>` : ''}
            <form id="ex-editor" data-submit="explainers:saveScript" data-input="explainers:editInput" novalidate>
                <div id="ex-estimate" class="ex-estimate" aria-live="polite"></div>
                <div class="form-group">
                    <label class="form-label" for="ex-f-title">${t('explainers.script.videoTitle')}</label>
                    <input class="field" id="ex-f-title" data-field="title" maxlength="${this.LIMITS.title}" dir="auto" value="${w.title}"${lock}>
                    <p class="form-hint">${t('explainers.script.videoTitleHint', { max: this.LIMITS.title })}</p>
                </div>
                <h4 class="ex-sub">${t('explainers.script.scenes')}</h4>
                <ol class="ex-scenes" id="ex-scenes">${this.scenesMarkup(w.scenes, ro)}</ol>
                ${ro ? '' : html`<div class="ex-actions" id="ex-scene-add">${UI.button({ size: 'sm', icon: 'plus', label: t('explainers.scene.addEnd'), action: 'explainers:sceneAdd', data: { i: w.scenes.length - 1 }, id: 'ex-scene-add-btn' })}</div>`}
                <details class="ex-more" open>
                    <summary>${t('explainers.script.captions')}<i data-lucide="chevron-down" aria-hidden="true"></i></summary>
                    <p class="form-hint">${t('explainers.script.captionsHint')}</p>
                    ${this.textField('ex-f-cap-meta', 'caption-meta', t('explainers.script.captionMeta'), w.captions.meta, 2200, ro, { area: true, rows: 5 })}
                    ${this.textField('ex-f-cap-yt-title', 'caption-yt-title', t('explainers.script.captionYoutubeTitle'), w.captions.youtube.title, 100, ro)}
                    ${this.textField('ex-f-cap-yt-desc', 'caption-yt-description', t('explainers.script.captionYoutubeDescription'), w.captions.youtube.description, 5000, ro, { area: true, rows: 5 })}
                    ${this.textField('ex-f-cap-tiktok', 'caption-tiktok', t('explainers.script.captionTikTok'), w.captions.tiktok, 2200, ro, { area: true, rows: 3 })}
                    ${this.textField('ex-f-first', 'first-comment', t('explainers.script.firstComment'), w.first_comment, 2200, ro, { area: true, rows: 4, hint: t('explainers.script.firstCommentHint') })}
                </details>
                <details class="ex-more">
                    <summary>${t('explainers.script.replies')}<i data-lucide="chevron-down" aria-hidden="true"></i></summary>
                    <p class="form-hint">${t('explainers.script.repliesHint', { min: this.MIN_REPLIES })}</p>
                    <ol class="ex-list-edit" id="ex-replies">${this.repliesMarkup(w.replies, ro)}</ol>
                    ${ro ? '' : UI.button({ size: 'sm', icon: 'plus', label: t('explainers.reply.add'), action: 'explainers:replyAdd', id: 'ex-reply-add' })}
                </details>
                <details class="ex-more">
                    <summary>${t('explainers.script.sources')}<i data-lucide="chevron-down" aria-hidden="true"></i></summary>
                    <p class="form-hint">${t('explainers.script.sourcesHint')}</p>
                    <ol class="ex-list-edit" id="ex-sources">${this.sourcesMarkup(w.sources, ro)}</ol>
                    ${ro ? '' : UI.button({ size: 'sm', icon: 'plus', label: t('explainers.source.add'), action: 'explainers:sourceAdd', id: 'ex-source-add' })}
                </details>
                <div id="ex-script-error"></div>
                ${ro ? '' : html`<div class="ex-actions ex-actions-main">
                    ${UI.button({ variant: 'secondary', type: 'submit', icon: 'save', label: t('explainers.script.save'), id: 'ex-save' })}
                    ${UI.button({ variant: 'ghost', icon: 'refresh-cw', label: t('explainers.script.rewrite'), action: 'explainers:openRewrite', id: 'ex-rewrite' })}
                    ${d.status === 'draft' ? UI.button({ variant: 'primary', icon: 'check', label: t('explainers.script.approve'), action: 'explainers:approve', id: 'ex-approve' }) : ''}
                </div>`}
            </form>
        `;
    },

    textField(id, field, label, value, max, ro, opts) {
        const o = opts || {};
        const lock = ro ? html.raw(' readonly') : '';
        return html`
            <div class="form-group">
                <label class="form-label" for="${id}">${label}</label>
                ${o.area
                    ? html`<textarea class="field field-textarea" id="${id}" data-field="${field}" rows="${o.rows || 3}" maxlength="${max}" dir="auto"${lock}>${value}</textarea>`
                    : html`<input class="field" id="${id}" data-field="${field}" maxlength="${max}" dir="auto" value="${value}"${lock}>`}
                ${o.hint ? html`<p class="form-hint">${o.hint}</p>` : ''}
            </div>
        `;
    },

    scenesMarkup(scenes, ro) {
        return html`${scenes.map((s, i) => this.sceneRowMarkup(s, i, ro, scenes.length))}`;
    },

    sceneRowMarkup(s, i, ro, count) {
        const n = i + 1;
        const id = `ex-s-${i}`;
        const lock = ro ? html.raw(' readonly') : '';
        const off = ro ? html.raw(' disabled') : '';
        const known = (this.cfg ? this.cfg.characters : []).map((c) => c.key);
        const keys = [...known, ...s.characters.filter((k) => !known.includes(k))];
        const names = Object.fromEntries((this.cfg ? this.cfg.characters : []).map((c) => [c.key, c.name]));
        const timing = s.start_s !== null && s.end_s !== null
            ? html`<span class="ex-scene-time">${UI.ltr(`${this.clock(s.start_s)}–${this.clock(s.end_s)}`)}</span>` : '';
        return html`
            <li class="ex-scene" data-scene-row="${i}">
                <div class="ex-scene-head">
                    <h4 class="ex-scene-n">${t('explainers.scene.n', { n: UI.formatNumber(n) })}</h4>
                    ${timing}
                    ${ro ? '' : html`<span class="ex-scene-tools">
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'arrow-up', ariaLabel: t('explainers.scene.up', { n: UI.formatNumber(n) }), action: 'explainers:sceneUp', data: { i }, disabled: i === 0, id: `${id}-up` })}
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'arrow-down', ariaLabel: t('explainers.scene.down', { n: UI.formatNumber(n) }), action: 'explainers:sceneDown', data: { i }, disabled: i === count - 1, id: `${id}-down` })}
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'plus', ariaLabel: t('explainers.scene.addAfter', { n: UI.formatNumber(n) }), action: 'explainers:sceneAdd', data: { i }, id: `${id}-add` })}
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', ariaLabel: t('explainers.scene.remove', { n: UI.formatNumber(n) }), action: 'explainers:sceneRemove', data: { i }, id: `${id}-remove` })}
                    </span>`}
                </div>
                <div class="form-group">
                    <label class="form-label" for="${id}-narration">${t('explainers.scene.narration')}</label>
                    <textarea class="field field-textarea" id="${id}-narration" data-field="narration" rows="2" maxlength="${this.LIMITS.narration}" dir="auto"${lock}>${s.narration}</textarea>
                </div>
                <div class="form-group">
                    <label class="form-label" for="${id}-spoken">${t('explainers.scene.spoken')}</label>
                    <textarea class="field field-textarea" id="${id}-spoken" data-field="spoken" rows="2" maxlength="${this.LIMITS.spoken}" dir="auto" aria-describedby="${id}-spoken-hint"${lock}>${s.spoken}</textarea>
                    <p class="form-hint" id="${id}-spoken-hint">${t('explainers.scene.spokenHint')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="${id}-label">${t('explainers.scene.label')}</label>
                    <input class="field" id="${id}-label" data-field="label" maxlength="${this.LIMITS.label}" dir="auto" value="${s.label}" aria-describedby="${id}-label-hint"${lock}>
                    <p class="form-hint" id="${id}-label-hint">${t('explainers.scene.labelHint', { words: this.LIMITS.labelWords })}</p>
                </div>
                <label class="check-row ex-check ex-continues"><input type="checkbox" data-field="continues" ${s.continues ? html.raw('checked') : ''}${off}> <span>${t('explainers.scene.continues')}</span></label>
                <div class="form-group">
                    <label class="form-label" for="${id}-brief">${t('explainers.scene.brief')}</label>
                    <textarea class="field field-textarea" id="${id}-brief" data-field="brief" rows="2" maxlength="${this.LIMITS.brief}" dir="ltr" aria-describedby="${id}-brief-hint"${lock}>${s.brief}</textarea>
                    <p class="form-hint" id="${id}-brief-hint">${t('explainers.scene.briefHint')}</p>
                </div>
                <fieldset class="ex-chars">
                    <legend class="form-label">${t('explainers.scene.characters')}</legend>
                    ${keys.length
                        ? keys.map((key) => html`<label class="ex-char-check"><input type="checkbox" data-char="${key}" data-change="explainers:characterChanged" ${s.characters.includes(key) ? html.raw('checked') : ''}${off}> <span dir="auto">${names[key] || key}</span></label>`)
                        : html`<span class="form-hint">${t('explainers.scene.noCharacters')} <a href="#/explainers?tab=settings">${t('explainers.scene.addCharacters')}</a></span>`}
                </fieldset>
            </li>
        `;
    },

    repliesMarkup(replies, ro) {
        const lock = ro ? html.raw(' readonly') : '';
        if (!replies.length) return html`<li class="form-hint">${t('explainers.reply.none')}</li>`;
        return html`${replies.map((r, i) => html`
            <li class="ex-pair" data-reply-row="${i}">
                <div class="form-group">
                    <label class="form-label" for="ex-r-${i}-q">${t('explainers.reply.q', { n: UI.formatNumber(i + 1) })}</label>
                    <textarea class="field field-textarea" id="ex-r-${i}-q" data-field="q" rows="2" maxlength="600" dir="auto"${lock}>${r.q}</textarea>
                </div>
                <div class="form-group">
                    <label class="form-label" for="ex-r-${i}-a">${t('explainers.reply.a', { n: UI.formatNumber(i + 1) })}</label>
                    <textarea class="field field-textarea" id="ex-r-${i}-a" data-field="a" rows="3" maxlength="1500" dir="auto"${lock}>${r.a}</textarea>
                </div>
                ${ro ? '' : UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('explainers.reply.remove'), action: 'explainers:replyRemove', data: { i }, id: `ex-r-${i}-remove` })}
            </li>`)}`;
    },

    sourcesMarkup(sources, ro) {
        const lock = ro ? html.raw(' readonly') : '';
        if (!sources.length) return html`<li class="form-hint">${t('explainers.source.none')}</li>`;
        return html`${sources.map((s, i) => html`
            <li class="ex-pair" data-source-row="${i}">
                <div class="ex-row">
                    <div class="form-group">
                        <label class="form-label" for="ex-src-${i}-title">${t('explainers.source.title')}</label>
                        <input class="field" id="ex-src-${i}-title" data-field="title" maxlength="300" dir="auto" value="${s.title}"${lock}>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="ex-src-${i}-by">${t('explainers.source.by')}</label>
                        <input class="field" id="ex-src-${i}-by" data-field="by" maxlength="300" dir="auto" value="${s.by}"${lock}>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="ex-src-${i}-year">${t('explainers.source.year')}</label>
                        <input class="field" id="ex-src-${i}-year" data-field="year" maxlength="10" dir="ltr" value="${s.year}"${lock}>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label" for="ex-src-${i}-url">${t('explainers.source.url')}</label>
                    <input class="field field-mono" id="ex-src-${i}-url" data-field="url" maxlength="2000" dir="ltr" spellcheck="false" value="${s.url}"${lock}>
                </div>
                ${ro ? '' : UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('explainers.source.remove'), action: 'explainers:sourceRemove', data: { i }, id: `ex-src-${i}-remove` })}
            </li>`)}`;
    },

    // ─── The script's working copy ───────────────────────────────────────────
    workFrom(d) {
        const draft = d.draft && typeof d.draft === 'object' ? d.draft : {};
        const caps = draft.captions && typeof draft.captions === 'object' ? draft.captions : {};
        const yt = caps.youtube && typeof caps.youtube === 'object' ? caps.youtube : {};
        const str = (v) => (typeof v === 'string' ? v : '');
        return {
            id: d.id,
            base: d.draft_version,
            title: str(d.title),
            scenes: d.scenes.map((s) => ({
                narration: s.narration, spoken: s.spoken, label: s.label, brief: s.brief, characters: [...s.characters], continues: s.continues,
                start_s: s.start_s, end_s: s.end_s,
            })),
            captions: { meta: str(caps.meta), youtube: { title: str(yt.title), description: str(yt.description) }, tiktok: str(caps.tiktok) },
            first_comment: str(draft.first_comment),
            replies: (Array.isArray(draft.replies) ? draft.replies : []).filter((r) => r && typeof r === 'object').map((r) => ({ q: str(r.q), a: str(r.a) })),
            sources: (Array.isArray(draft.sources) ? draft.sources : []).filter((s) => s && typeof s === 'object').map((s) => ({ title: str(s.title), by: str(s.by), year: str(s.year), url: str(s.url) })),
        };
    },

    ensureWork() {
        const d = this.detail;
        if (!d) return;
        if (!this.work || this.work.id !== d.id) {
            this.work = this.workFrom(d);
            this.workBase = this.workKey(this.work);
        }
    },

    /** What a save sends, from a working copy: trimmed, with the empty replies and sources dropped. */
    payloadOf(w) {
        const clean = (v) => String(v == null ? '' : v).trim();
        return {
            title: clean(w.title),
            draft: {
                captions: { meta: clean(w.captions.meta), youtube: { title: clean(w.captions.youtube.title), description: clean(w.captions.youtube.description) }, tiktok: clean(w.captions.tiktok) },
                first_comment: clean(w.first_comment),
                replies: w.replies.map((r) => ({ q: clean(r.q), a: clean(r.a) })).filter((r) => r.q || r.a),
                sources: w.sources.map((s) => ({ title: clean(s.title), by: clean(s.by), year: clean(s.year), url: clean(s.url) })).filter((s) => s.title || s.by || s.year || s.url),
            },
            scenes: w.scenes.map((s) => ({
                narration: clean(s.narration), spoken: clean(s.spoken), label: clean(s.label), brief: clean(s.brief),
                characters: [...s.characters], continues: s.continues === true,
            })),
        };
    },

    workKey(w) {
        return JSON.stringify(this.payloadOf(w));
    },

    editorDirty() {
        return !!this.work && this.workKey(this.work) !== this.workBase;
    },

    /** Read the script's fields into the working copy. Called before anything repaints them, saves them or leaves the page. */
    captureEditor() {
        if (typeof document === 'undefined') return;
        const form = document.getElementById('ex-editor');
        const w = this.work;
        if (!form || !w || w.id !== this.id || typeof form.querySelector !== 'function' || typeof form.querySelectorAll !== 'function') return;
        const one = (scope, name, fallback) => {
            const el = scope.querySelector(`[data-field="${name}"]`);
            return el && el.value !== undefined && el.value !== null ? String(el.value) : fallback;
        };
        w.title = one(form, 'title', w.title);
        w.captions.meta = one(form, 'caption-meta', w.captions.meta);
        w.captions.youtube.title = one(form, 'caption-yt-title', w.captions.youtube.title);
        w.captions.youtube.description = one(form, 'caption-yt-description', w.captions.youtube.description);
        w.captions.tiktok = one(form, 'caption-tiktok', w.captions.tiktok);
        w.first_comment = one(form, 'first-comment', w.first_comment);
        const rows = Array.from(form.querySelectorAll('[data-scene-row]'));
        if (rows.length === w.scenes.length) {
            w.scenes = rows.map((row, i) => {
                const cont = row.querySelector('[data-field="continues"]');
                const chars = Array.from(row.querySelectorAll('input[data-char]')).filter((c) => c.checked).map((c) => String(c.dataset.char));
                return { ...w.scenes[i], narration: one(row, 'narration', w.scenes[i].narration), spoken: one(row, 'spoken', w.scenes[i].spoken), label: one(row, 'label', w.scenes[i].label), brief: one(row, 'brief', w.scenes[i].brief), characters: chars, continues: !!(cont && cont.checked) };
            });
        }
        const replies = Array.from(form.querySelectorAll('[data-reply-row]'));
        if (replies.length === w.replies.length) w.replies = replies.map((row, i) => ({ q: one(row, 'q', w.replies[i].q), a: one(row, 'a', w.replies[i].a) }));
        const sources = Array.from(form.querySelectorAll('[data-source-row]'));
        if (sources.length === w.sources.length) {
            w.sources = sources.map((row, i) => ({ title: one(row, 'title', w.sources[i].title), by: one(row, 'by', w.sources[i].by), year: one(row, 'year', w.sources[i].year), url: one(row, 'url', w.sources[i].url) }));
        }
    },

    /** The length of the script against the target, with its warnings, from the fields as they stand. */
    estimateMarkup(scenes, sources) {
        const d = this.detail;
        const pace = this.cfg && this.cfg.pace ? this.cfg.pace[d.language] : undefined;
        const est = this.estimateSeconds(scenes, d.language, pace);
        const range = this.DURATION_RANGE[d.length_tier];
        const warnings = this.scriptWarnings(scenes, sources, d.length_tier, d.language, pace);
        const last = scenes.length ? scenes[scenes.length - 1] : null;
        const lines = warnings.map((w) => {
            const params = { n: UI.formatNumber(w.n || 0), min: UI.formatNumber(w.min || 0), max: UI.formatNumber(w.max || 0), est: this.lri(this.clock(w.est || 0)), tier: this.tierLabel(d.length_tier) };
            return html`<li><i data-lucide="alert-circle" aria-hidden="true"></i> ${t(`explainers.warning.${w.code}`, params)}</li>`;
        });
        if (last && !this.endsWithQuestion(last.narration)) {
            lines.push(html`<li><i data-lucide="alert-circle" aria-hidden="true"></i> ${t('explainers.warning.closing_question')}</li>`);
        }
        return html`
            <p class="ex-estimate-line"><i data-lucide="clock" aria-hidden="true"></i>
                ${t('explainers.script.estimate', { est: this.lri(this.clock(est)), target: this.lri(`${this.clock(range.min)}–${this.clock(range.max)}`), n: UI.formatNumber(scenes.length) })}</p>
            ${lines.length ? html`<ul class="ig-problems" aria-label="${t('explainers.script.warnings')}">${lines}</ul>` : ''}
        `;
    },

    /** A value isolated as left-to-right text inside a sentence (a time, a range): it survives an Arabic sentence in order. */
    lri(text) {
        return `\u2066${text}\u2069`;
    },

    refreshEstimate() {
        const box = document.getElementById('ex-estimate');
        if (!box || !this.detail || !this.hasDraft(this.detail)) return;
        this.captureEditor();
        if (!this.work) return;
        box.innerHTML = esc(this.estimateMarkup(this.work.scenes, this.work.sources));
        UI.icons(box);
    },

    paintScenes(focusId) {
        const host = document.getElementById('ex-scenes');
        if (!host || !this.work) return;
        host.innerHTML = esc(this.scenesMarkup(this.work.scenes, !this.isEditable()));
        UI.icons(host);
        const add = document.getElementById('ex-scene-add-btn');
        if (add && add.dataset) add.dataset.i = String(this.work.scenes.length - 1);
        const target = focusId ? document.getElementById(focusId) : null;
        if (target && typeof target.focus === 'function' && !target.disabled) target.focus();
        this.refreshEstimate();
    },

    /** Change the scene list: read the fields first so nothing typed is lost, change the copy, repaint the list. */
    editScenes(change, focusId) {
        this.captureEditor();
        if (!this.work || !this.isEditable()) return;
        change(this.work.scenes);
        this.paintScenes(focusId);
    },

    blankScene() {
        return { narration: '', spoken: '', label: '', brief: '', characters: [], continues: false, start_s: null, end_s: null };
    },

    /** Change the replies or the sources: read the fields first, change the copy, repaint that list. */
    editList(kind, change) {
        this.captureEditor();
        if (!this.work || !this.isEditable()) return;
        change(this.work[kind]);
        if (kind === 'replies') this.paintRegion('ex-replies', this.repliesMarkup(this.work.replies, false));
        else this.paintRegion('ex-sources', this.sourcesMarkup(this.work.sources, false));
        this.refreshEstimate();
    },

    // ─── Script actions ──────────────────────────────────────────────────────
    async saveWork() {
        this.captureEditor();
        const w = this.work;
        if (!w) return this.detail;
        const saved = await API.updateExplainer(w.id, this.payloadOf(w));
        this.work = null;
        this.workBase = '';
        this.applyDetail(saved);
        // The fields on screen are what was just saved: the working copy is read again from the answer, so it is never missing behind them.
        this.ensureWork();
        return this.detail;
    },

    rewriteMarkup() {
        return html`
            ${Admin.modalHeader(t('explainers.rewrite.title'))}
            <form id="ex-rewrite-form" data-submit="explainers:rewrite" novalidate>
                <p class="modal-body-text">${t('explainers.rewrite.body')}</p>
                <div class="form-group">
                    <label class="form-label" for="ex-rewrite-note">${t('explainers.rewrite.note')}</label>
                    <textarea class="field field-textarea" id="ex-rewrite-note" name="note" rows="4" maxlength="${this.REWRITE_NOTE_MAX}" dir="auto" data-guard-dirty
                              placeholder="${t('explainers.rewrite.placeholder')}"></textarea>
                </div>
                <p class="form-hint">${t('explainers.rewrite.hint')}</p>
                <div id="ex-rewrite-error"></div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'refresh-cw', label: t('explainers.rewrite.submit') })}
                </div>
            </form>
        `;
    },

    // ─── Step 2: the voice ───────────────────────────────────────────────────
    voiceMarkup() {
        const d = this.detail;
        const help = UI.helpLink('explainers#voice', t('explainers.help.voice'));
        const a = d.audio;
        if (!a) {
            const running = d.status === 'voicing';
            return html`${this.stepHead('explainers.voice.title', help)}${this.waitingMarkup(
                running ? 'explainers.voice.workingTitle' : 'explainers.voice.noneTitle',
                running ? 'explainers.voice.workingBody' : 'explainers.voice.noneBody',
                running,
            )}`;
        }
        const url = safeUrl(a.url);
        const timed = d.scenes.filter((s) => s.start_s !== null && s.end_s !== null);
        return html`
            ${this.stepHead('explainers.voice.title', help)}
            ${d.status === 'voicing' ? this.callout('refresh-cw', html`<p>${t('explainers.voice.again')}</p><p class="ex-progress" dir="auto" role="status">${this.progressText(d)}</p>`) : ''}
            <div class="ex-audio">
                ${url ? html`<audio id="ex-audio" controls preload="metadata" src="${url}" aria-label="${t('explainers.voice.player')}"></audio>` : ''}
                <p class="form-hint">${t('explainers.voice.meta', { voice: a.voice || '—', length: this.lri(this.clock(a.duration)) })}</p>
            </div>
            ${a.fallback ? this.callout('alert-triangle', html`<p class="studio-callout-title">${t('explainers.voice.checkTiming.title')}</p><p>${t('explainers.voice.checkTiming.body')}</p>`, 'warning') : ''}
            ${d.audio_stale && !['drawing', 'review', 'ready'].includes(d.status) ? html`<p class="form-hint">${t('explainers.stale.body')}</p>` : ''}
            <h4 class="ex-sub">${t('explainers.voice.times')}</h4>
            ${timed.length ? html`<ol class="ex-timing">${timed.map((s) => html`
                <li class="ex-time">
                    <span class="ex-time-n">${UI.formatNumber(s.position + 1)}</span>
                    <span class="ex-time-t">${UI.ltr(`${this.clock(s.start_s)}–${this.clock(s.end_s)}`)}</span>
                    <span class="ex-time-text" dir="auto">${s.narration}</span>
                    ${url ? UI.button({ variant: 'ghost', size: 'sm', icon: 'play', ariaLabel: t('explainers.voice.playFrom', { n: UI.formatNumber(s.position + 1) }), action: 'explainers:playFrom', data: { t: s.start_s }, id: `ex-play-${s.position}` }) : ''}
                </li>`)}</ol>`
                : html`<p class="form-hint">${t('explainers.voice.noTimes')}</p>`}
        `;
    },

    // ─── Step 3: the pictures ────────────────────────────────────────────────
    /** The scenes that get a picture of their own: one that continues the previous scene is copied, never drawn. */
    drawable(d) {
        const own = d.scenes.filter((s) => !s.continues);
        return own.length ? own : d.scenes;
    },

    /** Whether the unattended drawing loop is working on it now (not waiting for the allowance, not finished). */
    drawingNow(d) {
        return d.status === 'drawing' && !d.draw_paused_until && !!d.job && (d.job.status === 'pending' || d.job.status === 'running');
    },

    picturesMarkup() {
        const d = this.detail;
        const help = UI.helpLink('explainers#pictures', t('explainers.help.pictures'));
        if (!d.scenes.length) {
            return html`${this.stepHead('explainers.pictures.title', help)}${this.waitingMarkup('explainers.pictures.noneTitle', 'explainers.pictures.noneBody', false)}`;
        }
        return html`
            ${this.stepHead('explainers.pictures.title', help)}
            <div id="ex-pic-summary">${this.picSummaryMarkup()}</div>
            <ol class="ex-pics" id="ex-pics">${d.scenes.map((s) => this.sceneCardMarkup(s))}</ol>
            <div id="ex-pic-approve">${this.picApproveMarkup()}</div>
        `;
    },

    picSummaryMarkup() {
        const d = this.detail;
        const own = this.drawable(d);
        const total = own.length;
        const drawn = own.filter((s) => s.picture).length;
        const remaining = total - drawn;
        const paused = d.status === 'drawing' && d.draw_paused_until;
        const running = this.drawingNow(d);
        const a = d.allowance;
        const cap = a && Number(a.cap) > 0 ? Number(a.cap) : null;
        const used = a && Number.isFinite(Number(a.pictures)) ? Number(a.pictures) : null;
        const left = a && Number.isFinite(Number(a.est_left)) ? Math.max(0, Math.round(Number(a.est_left))) : null;
        const canDraw = remaining > 0 && !running && ['drawing', 'review'].includes(d.status);
        return html`
            <div class="ex-pic-summary">
                <p class="ex-pic-count">${t('explainers.pictures.progress', { n: UI.formatNumber(drawn), m: UI.formatNumber(total) })}</p>
                <progress class="studio-meter" value="${drawn}" max="${total || 1}" aria-label="${t('explainers.pictures.progressLabel')}"></progress>
                ${paused ? this.callout('hourglass', html`
                    <p class="studio-callout-title">${t('explainers.pictures.paused', { n: UI.formatNumber(drawn), m: UI.formatNumber(total) })}</p>
                    <p>${t('explainers.pictures.pausedBody', { when: this.lri(UI.formatDateTime(d.draw_paused_until, { zone: true })) })}</p>`, 'warning') : ''}
                ${running ? html`<p class="ex-progress" role="status"><span class="spinner" aria-hidden="true"></span> <span dir="auto">${this.progressText(d)}</span></p>` : ''}
                ${used !== null ? html`<p class="form-hint ex-allowance">${t(cap ? 'explainers.allowance.line' : 'explainers.allowance.lineNoCap', { used: UI.formatNumber(used), cap: UI.formatNumber(cap || 0), left: UI.formatNumber(left === null ? 0 : left) })}
                    ${cap ? html`<progress class="studio-meter" value="${Math.min(used, cap)}" max="${cap}" aria-label="${t('explainers.allowance.label')}"></progress>` : ''}</p>` : ''}
                ${canDraw ? html`<div class="ex-actions">${UI.button({ variant: 'primary', icon: 'sparkles', label: t(drawn === 0 ? 'explainers.pictures.drawAll' : 'explainers.pictures.continue'), action: 'explainers:drawAll', id: 'ex-draw-all' })}</div>` : ''}
            </div>
        `;
    },

    /** What a scene's picture area shows, as a value: the area is repainted only when this changes. */
    sceneSig(s) {
        return [s.draw_status, s.picture ? s.picture.media_id : '', s.pictures.map((p) => p.media_id).join(','), s.draw_error, s.continues ? 1 : 0].join('~');
    },

    sceneCardMarkup(s) {
        const i = s.position;
        const n = UI.formatNumber(i + 1);
        return html`
            <li class="ex-pic" data-scene="${i}">
                <div class="ex-pic-media" id="ex-media-${i}" data-sig="${this.sceneSig(s)}">${this.sceneMediaMarkup(s)}</div>
                <div class="ex-pic-body">
                    <p class="ex-pic-n">${t('explainers.scene.n', { n })}</p>
                    <p class="ex-pic-text" dir="auto">${s.narration}</p>
                    ${s.label ? html`<p class="ex-pic-label"><span class="ex-tag" dir="auto">${s.label}</span></p>` : ''}
                    ${s.continues
                        ? html`<p class="form-hint">${t('explainers.pictures.continues')}</p>`
                        : html`<div class="ex-pic-controls">
                            <input class="field" type="text" id="ex-note-${i}" maxlength="${this.DRAW_NOTE_MAX}" dir="auto" autocomplete="off"
                                   data-input="explainers:noteInput" data-scene="${i}"
                                   aria-label="${t('explainers.pictures.noteLabel', { n })}" placeholder="${t('explainers.pictures.notePlaceholder')}">
                            ${UI.button({ size: 'sm', icon: 'refresh-cw', label: t('explainers.pictures.redraw'), ariaLabel: t('explainers.pictures.redrawScene', { n }), action: 'explainers:redraw', data: { scene: i }, id: `ex-redraw-${i}` })}
                        </div>`}
                </div>
            </li>
        `;
    },

    sceneMediaMarkup(s) {
        const n = UI.formatNumber(s.position + 1);
        const url = s.picture ? safeUrl(s.picture.url) : '';
        let main;
        if (url) {
            main = html`<img class="ex-pic-img" src="${url}" alt="${t('explainers.pictures.alt', { n, label: s.label || s.narration })}" loading="lazy" decoding="async" width="1024" height="576">`;
        } else if (s.draw_status === 'drawing') {
            main = html`<div class="ex-pic-empty" role="status"><span class="spinner" aria-hidden="true"></span><span>${t('explainers.pictures.drawing')}</span></div>`;
        } else if (s.draw_status === 'failed') {
            main = html`<div class="ex-pic-empty ex-pic-failed"><i data-lucide="alert-triangle" aria-hidden="true"></i><span dir="auto">${s.draw_error ? this.drawErrorText(s.draw_error) : t('explainers.pictures.failed')}</span></div>`;
        } else {
            main = html`<div class="ex-pic-empty"><i data-lucide="${s.continues ? 'copy' : 'image'}" aria-hidden="true"></i><span>${t(s.continues ? 'explainers.pictures.continuesEmpty' : 'explainers.pictures.pending')}</span></div>`;
        }
        const history = s.pictures.length > 1 ? html`
            <div class="ex-history" role="group" aria-label="${t('explainers.pictures.history', { n })}">
                ${s.pictures.map((p, k) => {
                    const thumb = safeUrl(p.url);
                    const current = !!(s.picture && p.media_id === s.picture.media_id);
                    return thumb ? html`<button type="button" class="ex-hist" data-action="explainers:pick" data-scene="${s.position}" data-index="${k}" aria-pressed="${current ? 'true' : 'false'}"
                        aria-label="${t(current ? 'explainers.pictures.pickCurrent' : 'explainers.pictures.pick', { k: UI.formatNumber(k + 1) })}"><img src="${thumb}" alt="" loading="lazy" width="96" height="54"></button>` : '';
                })}
            </div>` : '';
        return html`${main}${history}${s.draw_note ? html`<p class="form-hint ex-pic-note" dir="auto">${t('explainers.pictures.lastNote', { note: s.draw_note })}</p>` : ''}`;
    },

    /** A stored draw error as one line: the server's own sentence, or the generic one when it is technical text. */
    drawErrorText(text) {
        const f = UI.failureError(text);
        return f.code ? t('explainers.pictures.failed') : (f.message || t('explainers.pictures.failed'));
    },

    picApproveMarkup() {
        const d = this.detail;
        if (!['drawing', 'review'].includes(d.status)) return '';
        const missing = this.drawable(d).filter((s) => !s.picture).length;
        let blocked = '';
        if (d.status !== 'review') blocked = 'explainers.pictures.blockedDrawing';
        else if (missing > 0) blocked = 'explainers.pictures.blockedMissing';
        else if (d.audio_stale) blocked = 'explainers.pictures.blockedStale';
        return html`<div class="ex-approve">
            <p class="form-hint" id="ex-approve-hint">${blocked ? t(blocked, { n: UI.formatNumber(missing) }) : t('explainers.pictures.approveHint')}</p>
            ${UI.button({ variant: 'primary', icon: 'check', label: t('explainers.pictures.approve'), action: 'explainers:approvePictures', id: 'ex-approve-pictures', disabled: !!blocked })}
        </div>`;
    },

    /** A redraw note typed under a scene survives a repaint of the grid. */
    capturePictureNotes() {
        if (this.step !== 'pictures' || !this.detail || typeof document === 'undefined') return;
        for (const s of this.detail.scenes) {
            const el = document.getElementById(`ex-note-${s.position}`);
            if (el && typeof el.value === 'string') {
                if (el.value) this.notes[s.position] = el.value; else delete this.notes[s.position];
            }
        }
    },

    restorePictureNotes() {
        for (const key of Object.keys(this.notes)) {
            const el = document.getElementById(`ex-note-${key}`);
            if (el) el.value = this.notes[key];
        }
    },

    // ─── Step 4: the video ───────────────────────────────────────────────────
    videoMarkup() {
        const d = this.detail;
        const help = UI.helpLink('explainers#video', t('explainers.help.video'));
        const r = d.render;
        if (!r) {
            const running = d.status === 'rendering';
            return html`${this.stepHead('explainers.video.title', help)}${this.waitingMarkup(
                running ? 'explainers.video.workingTitle' : 'explainers.video.noneTitle',
                running ? 'explainers.video.workingBody' : 'explainers.video.noneBody',
                running,
            )}`;
        }
        const vertical = safeUrl(r.vertical_url);
        const horizontal = safeUrl(r.horizontal_url);
        const cover = safeUrl(r.cover_url);
        const download = (href, part, ext, label) => (href
            ? html`<a class="btn btn-secondary btn-sm" href="${href}" download="${this.fileName(d, part, ext)}"><i data-lucide="download" aria-hidden="true"></i> ${label}</a>` : '');
        return html`
            ${this.stepHead('explainers.video.title', help)}
            ${d.status === 'rendering' ? this.callout('refresh-cw', html`<p>${t('explainers.video.again')}</p><p class="ex-progress" dir="auto" role="status">${this.progressText(d)}</p>`) : ''}
            <div class="ex-videos">
                <figure class="ex-video ex-video-v">
                    ${vertical ? html`<video controls playsinline preload="metadata"${cover ? html` poster="${cover}"` : ''} src="${vertical}" aria-label="${t('explainers.video.verticalLabel')}"></video>` : ''}
                    <figcaption>${t('explainers.video.vertical')} ${download(vertical, 'vertical', 'mp4', t('explainers.video.download'))}</figcaption>
                </figure>
                <figure class="ex-video ex-video-h">
                    ${horizontal ? html`<video controls playsinline preload="metadata"${cover ? html` poster="${cover}"` : ''} src="${horizontal}" aria-label="${t('explainers.video.horizontalLabel')}"></video>` : ''}
                    <figcaption>${t('explainers.video.horizontal')} ${download(horizontal, 'horizontal', 'mp4', t('explainers.video.download'))}</figcaption>
                </figure>
                <figure class="ex-cover">
                    ${cover ? html`<img src="${cover}" alt="${t('explainers.video.coverAlt')}" loading="lazy" decoding="async">` : ''}
                    <figcaption>${t('explainers.video.cover')} ${download(cover, 'cover', 'jpg', t('explainers.video.download'))}</figcaption>
                </figure>
            </div>
            <p class="form-hint">${t('explainers.video.meta', { length: this.lri(this.clock(r.duration)), sound: t(r.sound_mode === 'music' ? 'explainers.sound.musicShort' : 'explainers.sound.sfxShort') })}</p>
            ${d.status === 'ready' ? html`
                <form id="ex-sound-form" data-submit="explainers:rerender" novalidate>
                    <h4 class="ex-sub">${t('explainers.video.next')}</h4>
                    ${this.soundFieldsMarkup('ex-video', { sound_mode: d.sound_mode, music_track_id: d.music_track_id, subtitles: d.subtitles })}
                    <div id="ex-sound-error"></div>
                    ${UI.button({ variant: 'secondary', type: 'submit', icon: 'refresh-cw', label: t('explainers.action.rerender'), id: 'ex-rerender' })}
                    <p class="form-hint">${t('explainers.video.rerenderHint')}</p>
                </form>` : ''}
        `;
    },

    // ─── Step 5: publish ─────────────────────────────────────────────────────
    /** The credit line of the chosen music track, when its licence asks for one: the server adds it to every caption, and the LinkedIn caption gets it here. */
    creditLine() {
        const d = this.detail;
        if (!d || d.sound_mode !== 'music' || !this.cfg) return '';
        const track = this.cfg.music.find((m) => m.key === d.music_track_id);
        return track && track.credit_required && track.credit ? track.credit : '';
    },

    savedCaptions() {
        const draft = this.detail && this.detail.draft && typeof this.detail.draft === 'object' ? this.detail.draft : {};
        const caps = draft.captions && typeof draft.captions === 'object' ? draft.captions : {};
        const yt = caps.youtube && typeof caps.youtube === 'object' ? caps.youtube : {};
        const str = (v) => (typeof v === 'string' ? v : '');
        return { meta: str(caps.meta), ytTitle: str(yt.title), ytDescription: str(yt.description), tiktok: str(caps.tiktok), firstComment: str(draft.first_comment) };
    },

    /** The caption LinkedIn gets: the Instagram and Facebook caption, the credit line when the track asks for one, every blank line a U+2800. */
    linkedinCaption() {
        const caps = this.savedCaptions();
        const credit = this.creditLine();
        return this.linkedinText(credit ? `${caps.meta}\n\n${credit}` : caps.meta);
    },

    /** The platforms and what each gets: the same rule the server's Schedule applies (FR-027). */
    planMarkup() {
        const d = this.detail;
        const seconds = d.render && Number(d.render.duration) > 0 ? Number(d.render.duration) : (d.audio ? Number(d.audio.duration) : 0);
        const longVideo = seconds > this.SHORT_SECONDS;
        // Not `icon` as a parameter name: scripts/build-icons.mjs reads the matching argument of every same-named call in the dashboard as an icon.
        const plan = (glyph, name, what) => html`<li><i data-lucide="${glyph}" aria-hidden="true"></i><span><strong>${name}</strong> ${what}</span></li>`;
        return html`<ul class="ex-plan">
            ${plan('instagram', t('explainers.platform.instagramFacebook'), t('explainers.plan.meta'))}
            ${plan('youtube', t('explainers.platform.youtube'), t(longVideo ? 'explainers.plan.youtubeLong' : 'explainers.plan.youtubeShort'))}
            ${plan('music', t('explainers.platform.tiktok'), t('explainers.plan.tiktok'))}
            ${plan('share-2', t('explainers.platform.linkedin'), t('explainers.plan.linkedin'))}
        </ul>`;
    },

    publishMarkup() {
        const d = this.detail;
        const help = UI.helpLink('explainers#publish', t('explainers.help.publish'));
        const caps = this.savedCaptions();
        const credit = this.creditLine();
        const area = (id, label, text, rows) => html`
            <div class="form-group">
                <label class="form-label" for="${id}">${label}</label>
                <textarea class="field field-textarea" id="${id}" readonly rows="${rows}" dir="auto">${text}</textarea>
                ${UI.button({ variant: 'ghost', size: 'sm', icon: 'copy', label: t('explainers.publish.copy'), ariaLabel: t('explainers.publish.copyNamed', { name: label }), action: 'explainers:copyField', data: { target: id }, id: `${id}-copy` })}
            </div>`;
        return html`
            ${this.stepHead('explainers.publish.title', help)}
            ${this.editorDirty() ? html`<p class="form-hint text-warning">${t('explainers.publish.unsaved')}</p>` : ''}
            ${d.status === 'scheduled' || d.schedule ? this.scheduledMarkup() : (d.status === 'ready' ? this.scheduleFormMarkup() : this.callout('hourglass', html`<p>${t('explainers.publish.notReady')}</p>`))}
            <h4 class="ex-sub">${t('explainers.publish.where')}</h4>
            ${this.planMarkup()}
            <h4 class="ex-sub">${t('explainers.publish.captions')}</h4>
            ${credit ? html`<p class="form-hint">${t('explainers.publish.credit', { credit })}</p>` : ''}
            ${area('ex-p-meta', t('explainers.publish.capMeta'), caps.meta, 5)}
            ${area('ex-p-yt-title', t('explainers.publish.capYoutubeTitle'), caps.ytTitle, 2)}
            ${area('ex-p-yt-desc', t('explainers.publish.capYoutubeDescription'), caps.ytDescription, 5)}
            ${area('ex-p-tiktok', t('explainers.publish.capTikTok'), caps.tiktok, 3)}
            <section class="ex-linkedin" aria-labelledby="ex-li-title">
                <h4 class="ex-sub" id="ex-li-title"><i data-lucide="share-2" aria-hidden="true"></i> ${t('explainers.linkedin.title')}</h4>
                <p class="form-hint">${t('explainers.linkedin.hint')}</p>
                <div class="form-group">
                    <label class="form-label" for="ex-li-text">${t('explainers.linkedin.caption')}</label>
                    <textarea class="field field-textarea" id="ex-li-text" readonly rows="6" dir="auto">${this.linkedinCaption()}</textarea>
                </div>
                <div class="ex-actions">
                    ${UI.button({ variant: 'secondary', icon: 'copy', label: t('explainers.linkedin.copyCaption'), action: 'explainers:copyLinkedIn', id: 'ex-li-caption' })}
                    ${UI.button({ variant: 'secondary', icon: 'copy', label: t('explainers.linkedin.copyComment'), action: 'explainers:copyFirstComment', id: 'ex-li-comment', disabled: !caps.firstComment })}
                </div>
                <p class="form-hint">${t('explainers.linkedin.commentHint')}</p>
            </section>
        `;
    },

    zone() {
        return UI.zone();
    },

    scheduleFormMarkup() {
        const zone = this.zone();
        return html`
            <form id="ex-schedule-form" data-submit="explainers:schedule" novalidate>
                <fieldset class="ex-when-choice">
                    <legend class="form-label">${t('explainers.publish.when')}</legend>
                    <label class="ex-radio"><input type="radio" name="when" value="next" checked> <span>${t('explainers.publish.next')}</span></label>
                    <label class="ex-radio"><input type="radio" name="when" value="now"> <span>${t('explainers.publish.now')}</span></label>
                    <label class="ex-radio"><input type="radio" name="when" value="at"> <span>${t('explainers.publish.at')}</span></label>
                    <input class="field" type="datetime-local" name="at" id="ex-when-at" data-input="explainers:atInput"
                           aria-label="${t('explainers.publish.atLabel')}" aria-describedby="ex-when-at-hint">
                    <span class="form-hint" id="ex-when-at-hint">${t('explainers.publish.zoneHint', { city: UI.zoneCity(zone), zone })}</span>
                </fieldset>
                <div id="ex-schedule-error"></div>
                ${UI.button({ variant: 'primary', type: 'submit', icon: 'calendar-check', label: t('explainers.publish.schedule'), id: 'ex-schedule' })}
            </form>
        `;
    },

    rowTone(row) {
        if (UI.heldReason(row)) return 'warning';
        return { PUBLISHED: 'success', IN_INBOX: 'info', FAILED: 'danger' }[row.status] || 'info';
    },

    rowLink(row) {
        const id = String(row.published_post_id || '');
        if (row.platform === 'youtube' && /^YT:[\w-]+$/.test(id)) {
            const video = id.slice(3);
            const long = this.detail && this.detail.render && Number(this.detail.render.duration) > this.SHORT_SECONDS;
            return { href: `https://www.youtube.com/${long ? `watch?v=${video}` : `shorts/${video}`}`, label: t('explainers.rows.openYoutube'), external: true };
        }
        return { href: '#/posts', label: t('explainers.rows.openPosts'), external: false };
    },

    rowMarkup(row) {
        const platform = t(`explainers.rowPlatform.${['both', 'instagram', 'facebook', 'tiktok', 'youtube'].includes(row.platform) ? row.platform : 'both'}`);
        const link = this.rowLink(row);
        return html`<li class="ex-row-post">
            <span class="ex-row-name">${platform}</span>
            <span class="badge badge-${html.raw(this.rowTone(row))}">${UI.postStatusLabel(row)}</span>
            ${row.scheduled_time ? html`<span class="form-hint">${UI.formatDateTime(row.scheduled_time, { zone: true })}</span>` : ''}
            <a href="${link.href}"${link.external ? html.raw(' target="_blank" rel="noopener noreferrer"') : ''}>${link.label}${link.external ? html`<span class="sr-only"> ${t('help.link.newTab')}</span>` : ''}</a>
            ${row.error_log && (row.status === 'FAILED' || UI.heldReason(row)) ? html`<span class="form-hint text-warning" dir="auto">${row.error_log}</span>` : ''}
        </li>`;
    },

    scheduledMarkup() {
        const d = this.detail;
        const when = d.schedule && d.schedule.scheduled_time ? UI.formatDateTime(d.schedule.scheduled_time, { zone: true, weekday: true }) : '';
        return html`
            <div class="ex-scheduled">
                ${when ? html`<p class="ex-when"><i data-lucide="calendar-check" aria-hidden="true"></i> ${t('explainers.publish.scheduledFor', { when: this.lri(when) })}</p>` : ''}
                ${this.rowsError ? html`<p class="form-hint text-warning">${t('explainers.rows.failed')}</p>`
                    : (this.rows.length
                        ? html`<ul class="ex-rows" aria-label="${t('explainers.rows.label')}">${this.rows.map((r) => this.rowMarkup(r))}</ul>`
                        : html`<p class="form-hint">${t(this.rowsLoaded ? 'explainers.rows.none' : 'explainers.rows.loading')}</p>`)}
                <p class="form-hint"><a href="#/posts">${t('explainers.publish.openPosts')}</a></p>
            </div>
        `;
    },

    rowsOpen() {
        const d = this.detail;
        if (!d || !d.schedule) return false;
        if (!this.rowsLoaded) return true;
        return this.rows.some((r) => ['PENDING', 'PUBLISHING', 'PROCESSING'].includes(String(r.status)));
    },

    /** The scheduled posts of this explainer, read from the Scheduler's list by the ids the schedule names. */
    async loadRows(seq) {
        const d = this.detail;
        if (!d || !d.schedule) { this.rows = []; this.rowsLoaded = true; return; }
        const ids = new Set((Array.isArray(d.schedule.row_ids) ? d.schedule.row_ids : []).map(String));
        try {
            const all = await API.getScheduledPosts();
            if (seq !== undefined && !this.alive(seq)) return;
            this.rows = (Array.isArray(all) ? all : []).filter((p) => p && ids.has(String(p.id)));
            this.rowsError = null;
        } catch (err) {
            this.rowsError = err;
        }
        this.rowsLoaded = true;
    },

    // ─── The settings view ───────────────────────────────────────────────────
    async renderSettings(container, seq) {
        const gate = Motion.beginLoad(container, () => html`${Motion.cardGrid(2, 4)}${Motion.busy()}`);
        const [settings, allowance, status] = await Promise.allSettled([API.getStudioSettings(), API.getExplainerAllowance(), API.getStudioStatus()]);
        if (!this.alive(seq)) return;
        gate.done();
        if (allowance.status === 'rejected' && (this.isDisabled(allowance.reason) || this.notDeployed(allowance.reason))) {
            container.innerHTML = esc(html`${this.toolbarMarkup('settings')}${this.disabledMarkup(allowance.reason)}`);
            UI.icons(container);
            return;
        }
        this.acceptSettings(settings);
        this.allowance = allowance.status === 'fulfilled' ? allowance.value : null;
        this.acceptWorker(status);
        this.candidates = Object.create(null);
        container.innerHTML = esc(html`
            ${this.toolbarMarkup('settings')}
            <p class="form-hint ex-settings-lead">${t('explainers.settings.lead')} ${UI.helpLink('explainers#settings', t('explainers.help.settings'))}</p>
            ${this.cfgError && settings.status === 'rejected' ? html`<div class="surface pad-5">${UI.errorBox(this.cfgError)}</div>` : html`<div id="ex-settings">${this.settingsMarkup()}</div>`}
        `);
        UI.icons(container);
    },

    settingsMarkup() {
        return html`${this.lookMarkup()}${this.writerMarkup()}${this.charactersMarkup()}${this.musicMarkup()}`;
    },

    paintSettingsCard(id, markup) {
        const el = document.getElementById(id);
        if (!el) return;
        el.outerHTML = esc(markup);
        const fresh = document.getElementById(id);
        if (fresh) UI.icons(fresh);
    },

    voiceOptions(lang, selected) {
        const list = lang === 'ar' ? ['ar-001-commercial-3', ...this.GEMINI_VOICES] : this.GEMINI_VOICES;
        const names = list.includes(selected) ? list : [selected, ...list];
        return names.filter(Boolean).map((v) => html`<option value="${v}" ${v === selected ? html.raw('selected') : ''}>${v}</option>`);
    },

    lookMarkup() {
        const c = this.cfg;
        const option = (value, label, selected) => html`<option value="${value}" ${selected ? html.raw('selected') : ''}>${label}</option>`;
        return html`
            <section class="surface pad-5 ex-set" id="ex-card-look" aria-labelledby="ex-look-title">
                <h2 class="section-title" id="ex-look-title">${t('explainers.look.title')}</h2>
                <p class="form-hint">${t('explainers.look.hint')}</p>
                <form id="ex-look-form" data-submit="explainers:saveLook" novalidate>
                    <div class="form-group">
                        <label class="form-label" for="ex-l-style">${t('explainers.look.style')}</label>
                        <textarea class="field field-textarea" id="ex-l-style" name="style" rows="3" maxlength="${this.STYLE_MAX}" dir="ltr" aria-describedby="ex-l-style-hint">${c.style}</textarea>
                        <p class="form-hint" id="ex-l-style-hint">${t('explainers.look.styleHint')}</p>
                    </div>
                    <div class="ex-row">
                        <div class="form-group">
                            <label class="form-label" for="ex-l-voice-ar">${t('explainers.look.voiceAr')}</label>
                            <select class="select" id="ex-l-voice-ar" name="voice_ar">${this.voiceOptions('ar', c.voices.ar)}</select>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="ex-l-voice-en">${t('explainers.look.voiceEn')}</label>
                            <select class="select" id="ex-l-voice-en" name="voice_en">${this.voiceOptions('en', c.voices.en)}</select>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="ex-l-voice-style">${t('explainers.look.voiceStyle')}</label>
                        <textarea class="field field-textarea" id="ex-l-voice-style" name="voice_style" rows="2" maxlength="${this.VOICE_STYLE_MAX}" dir="ltr" aria-describedby="ex-l-voice-style-hint">${c.voice_style}</textarea>
                        <p class="form-hint" id="ex-l-voice-style-hint">${t('explainers.look.voiceStyleHint')}</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="ex-l-colour">${t('explainers.look.titleColour')}</label>
                        <input class="field ig-colour" id="ex-l-colour" name="title_color" type="color" value="${c.title_color}" aria-describedby="ex-l-colour-hint">
                        <p class="form-hint" id="ex-l-colour-hint">${t('explainers.look.titleColourHint')}</p>
                    </div>
                    <fieldset class="ex-defaults">
                        <legend class="form-label">${t('explainers.look.defaults')}</legend>
                        <div class="ex-row">
                            <div class="form-group">
                                <label class="form-label" for="ex-l-d-language">${t('explainers.new.language')}</label>
                                <select class="select" id="ex-l-d-language" name="default_language">${this.LANGUAGES.map((l) => option(l, t(`explainers.lang.${l}`), c.defaults.language === l))}</select>
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="ex-l-d-tier">${t('explainers.new.length')}</label>
                                <select class="select" id="ex-l-d-tier" name="default_tier">${this.TIERS.map((x) => option(x, t(`explainers.tier.${x}`), c.defaults.length_tier === x))}</select>
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="ex-l-d-sound">${t('explainers.sound.label')}</label>
                                <select class="select" id="ex-l-d-sound" name="default_sound">${this.SOUNDS.map((x) => option(x, t(`explainers.sound.${x}`), c.defaults.sound_mode === x))}</select>
                            </div>
                        </div>
                        <label class="check-row ex-check"><input type="checkbox" name="default_subtitles" ${c.defaults.subtitles ? html.raw('checked') : ''}> <span>${t('explainers.subtitles.label')}</span></label>
                    </fieldset>
                    <details class="ex-more">
                        <summary>${t('explainers.look.pace')}<i data-lucide="chevron-down" aria-hidden="true"></i></summary>
                        <p class="form-hint">${t('explainers.look.paceHint')}</p>
                        <div class="ex-row">
                            <div class="form-group">
                                <label class="form-label" for="ex-l-pace-ar">${t('explainers.look.paceAr')}</label>
                                <input class="field" id="ex-l-pace-ar" name="pace_ar" type="number" min="1" max="4" step="0.1" dir="ltr" value="${c.pace.ar}">
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="ex-l-pace-en">${t('explainers.look.paceEn')}</label>
                                <input class="field" id="ex-l-pace-en" name="pace_en" type="number" min="1" max="4" step="0.1" dir="ltr" value="${c.pace.en}">
                            </div>
                        </div>
                    </details>
                    <div id="ex-look-error"></div>
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'save', label: t('explainers.look.save') })}
                </form>
            </section>
        `;
    },

    readLook(form) {
        const v = (name) => String((form.elements[name] && form.elements[name].value) || '').trim();
        const n = (name, fallback) => (Number.isFinite(Number(v(name))) && v(name) !== '' ? Number(v(name)) : fallback);
        const base = this.cfg;
        return {
            style: v('style'),
            voice_style: v('voice_style'),
            voices: { ar: v('voice_ar'), en: v('voice_en') },
            pace: { ar: n('pace_ar', base.pace.ar), en: n('pace_en', base.pace.en) },
            title_color: v('title_color').toUpperCase(),
            defaults: {
                sound_mode: v('default_sound') === 'music' ? 'music' : 'sfx',
                subtitles: !!(form.elements.default_subtitles && form.elements.default_subtitles.checked),
                language: v('default_language') === 'en' ? 'en' : 'ar',
                length_tier: this.TIERS.includes(v('default_tier')) ? v('default_tier') : 'short',
            },
        };
    },

    writerMarkup() {
        const c = this.cfg;
        return html`
            <section class="surface pad-5 ex-set" id="ex-card-writer" aria-labelledby="ex-writer-title">
                <h2 class="section-title" id="ex-writer-title">${t('explainers.writerSetting.title')}</h2>
                <p class="form-hint">${t('explainers.writerSetting.hint')}</p>
                <form id="ex-writer-form" data-submit="explainers:saveWriter" novalidate>
                    <div class="form-group">
                        <label class="form-label" for="ex-w-writer">${t('explainers.writerSetting.writer')}</label>
                        <select class="select" id="ex-w-writer" name="writer">
                            <option value="claude_mac" ${c.writer === 'claude_mac' ? html.raw('selected') : ''}>${t('explainers.writerSetting.claude')}</option>
                            <option value="gemini" ${c.writer === 'gemini' ? html.raw('selected') : ''}>${t('explainers.writerSetting.gemini')}</option>
                        </select>
                    </div>
                    <label class="check-row ex-check"><input type="checkbox" name="writer_fallback" aria-describedby="ex-w-fallback-hint" ${c.writer_fallback ? html.raw('checked') : ''}> <span>${t('explainers.writerSetting.fallback')}</span></label>
                    <p class="form-hint" id="ex-w-fallback-hint">${t('explainers.writerSetting.fallbackHint')}</p>
                    <div id="ex-writer-error"></div>
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'save', label: t('explainers.writerSetting.save') })}
                </form>
            </section>
        `;
    },

    // Characters ---------------------------------------------------------------
    charactersMarkup() {
        const list = this.cfg.characters;
        const a = this.allowance;
        return html`
            <section class="surface pad-5 ex-set" id="ex-card-characters" aria-labelledby="ex-chars-title">
                <h2 class="section-title" id="ex-chars-title">${t('explainers.characters.title')}</h2>
                <p class="form-hint">${t('explainers.characters.hint')}</p>
                ${a && Number(a.cap) > 0 ? html`<p class="form-hint ex-allowance">${t('explainers.allowance.line', { used: UI.formatNumber(Number(a.pictures) || 0), cap: UI.formatNumber(Number(a.cap)), left: UI.formatNumber(Math.max(0, Math.round(Number(a.est_left) || 0))) })}</p>` : ''}
                <form id="ex-characters-form" data-submit="explainers:saveCharacters" novalidate>
                    ${list.length ? list.map((c, i) => this.characterMarkup(c, i)) : html`<p class="form-hint">${t('explainers.characters.none')}</p>`}
                    <div id="ex-characters-error"></div>
                    <div class="ex-actions">
                        ${UI.button({ size: 'sm', icon: 'plus', label: t('explainers.character.add'), action: 'explainers:characterAdd', id: 'ex-character-add', disabled: list.length >= this.CHARACTERS_MAX })}
                        ${list.length ? UI.button({ variant: 'primary', type: 'submit', icon: 'save', label: t('explainers.characters.save') }) : ''}
                    </div>
                </form>
            </section>
        `;
    },

    characterMarkup(c, i) {
        const ref = c.ref_url ? safeUrl(c.ref_url) : '';
        const cands = this.candidates[i] || [];
        const name = c.name || c.key || t('explainers.character.new');
        return html`
            <fieldset class="ex-char" data-char-row="${i}">
                <legend>${name}</legend>
                <div class="ex-row">
                    <div class="form-group">
                        <label class="form-label" for="ex-c-${i}-name">${t('explainers.character.name')}</label>
                        <input class="field" id="ex-c-${i}-name" data-field="name" maxlength="${this.CHARACTER_NAME_MAX}" dir="auto" value="${c.name}">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="ex-c-${i}-key">${t('explainers.character.key')}</label>
                        <input class="field field-mono" id="ex-c-${i}-key" data-field="key" maxlength="30" dir="ltr" spellcheck="false" autocapitalize="off" value="${c.key}" aria-describedby="ex-c-${i}-key-hint">
                        <p class="form-hint" id="ex-c-${i}-key-hint">${t('explainers.character.keyHint')}</p>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label" for="ex-c-${i}-description">${t('explainers.character.description')}</label>
                    <textarea class="field field-textarea" id="ex-c-${i}-description" data-field="description" rows="3" maxlength="${this.CHARACTER_DESCRIPTION_MAX}" dir="ltr" aria-describedby="ex-c-${i}-description-hint">${c.description}</textarea>
                    <p class="form-hint" id="ex-c-${i}-description-hint">${t('explainers.character.descriptionHint')}</p>
                </div>
                <div class="ex-ref">
                    ${ref ? html`<img class="ex-ref-img" src="${ref}" alt="${t('explainers.character.refAlt', { name })}" width="96" height="96">`
                        : html`<span class="ex-ref-img ex-ref-empty" aria-hidden="true"><i data-lucide="image-plus"></i></span>`}
                    <p class="form-hint">${t(ref ? 'explainers.character.approved' : 'explainers.character.notApproved')}</p>
                </div>
                <div class="ex-actions">
                    ${UI.button({ size: 'sm', icon: 'sparkles', label: t('explainers.character.generate'), action: 'explainers:candidates', data: { i }, id: `ex-c-${i}-gen` })}
                    <label class="btn btn-secondary btn-sm" for="ex-c-${i}-file"><i data-lucide="upload" aria-hidden="true"></i> ${t('explainers.character.upload')}</label>
                    <input class="sr-only" id="ex-c-${i}-file" type="file" accept="image/png,image/jpeg,image/webp" data-change="explainers:uploadReference" data-i="${i}">
                    ${UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('explainers.character.remove'), action: 'explainers:characterRemove', data: { i }, id: `ex-c-${i}-remove` })}
                </div>
                <p class="form-hint">${t('explainers.character.generateHint', { px: this.REFERENCE_PX })}</p>
                <div id="ex-c-${i}-status" role="status" aria-live="polite"></div>
                ${cands.length ? html`<div class="ex-cands" role="group" aria-label="${t('explainers.character.candidates', { name })}">${cands.map((cand, k) => {
                    const src = safeUrl(cand.url);
                    return src ? html`<button type="button" class="ex-cand" data-action="explainers:approveCandidate" data-i="${i}" data-k="${k}"
                        aria-label="${t('explainers.character.useCandidate', { k: UI.formatNumber(k + 1) })}"><img src="${src}" alt="" width="112" height="112"><span>${t('explainers.character.useThis')}</span></button>` : '';
                })}</div>` : ''}
            </fieldset>
        `;
    },

    /** The characters' text fields into `this.cfg`, so a repaint or a save starts from what is typed (the approved picture is never in a field). */
    captureCharacters() {
        const form = document.getElementById('ex-characters-form');
        if (!form || !this.cfg || typeof form.querySelectorAll !== 'function') return;
        const rows = Array.from(form.querySelectorAll('[data-char-row]'));
        if (rows.length !== this.cfg.characters.length) return;
        rows.forEach((row, i) => {
            const get = (name) => { const el = row.querySelector(`[data-field="${name}"]`); return el && el.value !== undefined ? String(el.value).trim() : ''; };
            const c = this.cfg.characters[i];
            c.name = get('name');
            c.key = get('key');
            c.description = get('description');
        });
    },

    charactersPayload() {
        return this.cfg.characters.map((c) => ({ key: c.key, name: c.name, description: c.description, ref_media_id: c.ref_media_id, ref_url: c.ref_url, approved_at: c.approved_at }));
    },

    /** Problems the owner can fix before asking the server: what every character must have. */
    characterProblems(list) {
        const problems = [];
        const seen = new Set();
        list.forEach((c, i) => {
            const n = UI.formatNumber(i + 1);
            if (!this.KEY_RE.test(c.key)) problems.push(t('explainers.character.problemKey', { n }));
            else if (seen.has(c.key)) problems.push(t('explainers.character.problemKeyTwice', { n, key: c.key }));
            else seen.add(c.key);
            if (!c.name.trim()) problems.push(t('explainers.character.problemName', { n }));
            if (!c.description.trim()) problems.push(t('explainers.character.problemDescription', { n }));
        });
        return problems;
    },

    /** Save the characters (the whole list: the server replaces it) and take the answer back. Throws what the server refused. */
    async saveCharacters() {
        this.captureCharacters();
        const saved = await API.saveStudioSettings({ explainer: { characters: this.charactersPayload() } });
        this.cfg = this.normalizeConfig(saved && saved.settings && saved.settings.explainer);
    },

    paintCharacters() {
        this.paintSettingsCard('ex-card-characters', this.charactersMarkup());
    },

    // Music --------------------------------------------------------------------
    musicMarkup() {
        const list = this.cfg.music;
        return html`
            <section class="surface pad-5 ex-set" id="ex-card-music" aria-labelledby="ex-music-title">
                <h2 class="section-title" id="ex-music-title">${t('explainers.music.title')}</h2>
                <p class="form-hint">${t('explainers.music.hint')} ${UI.helpLink('explainers#music', t('explainers.help.music'))}</p>
                <form id="ex-music-form" data-submit="explainers:saveMusic" novalidate>
                    ${list.length ? html`<ol class="ex-tracks">${list.map((m, i) => this.trackMarkup(m, i))}</ol>` : html`<p class="form-hint">${t('explainers.music.none')}</p>`}
                    <div id="ex-music-error"></div>
                    ${list.length ? UI.button({ variant: 'primary', type: 'submit', icon: 'save', label: t('explainers.music.save') }) : ''}
                </form>
                <form id="ex-track-form" data-submit="explainers:addTrack" novalidate class="ex-track-add">
                    <h3 class="ex-sub">${t('explainers.music.addTitle')}</h3>
                    <div class="form-group">
                        <label class="form-label" for="ex-t-file">${t('explainers.music.file')}</label>
                        <input class="field" id="ex-t-file" name="file" type="file" accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,.mp3,.m4a,.wav" aria-describedby="ex-t-file-hint">
                        <p class="form-hint" id="ex-t-file-hint">${t('explainers.music.fileHint', { mb: this.UPLOAD_MAX_BYTES / (1024 * 1024) })}</p>
                    </div>
                    <div class="ex-row">
                        <div class="form-group">
                            <label class="form-label" for="ex-t-title">${t('explainers.music.trackTitle')}</label>
                            <input class="field" id="ex-t-title" name="title" maxlength="${this.TRACK_TEXT_MAX}" dir="auto" autocomplete="off">
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="ex-t-artist">${t('explainers.music.artist')}</label>
                            <input class="field" id="ex-t-artist" name="artist" maxlength="${this.TRACK_TEXT_MAX}" dir="auto" autocomplete="off">
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="ex-t-license">${t('explainers.music.license')}</label>
                            <input class="field" id="ex-t-license" name="license" maxlength="${this.TRACK_TEXT_MAX}" dir="auto" autocomplete="off" placeholder="${t('explainers.music.licensePlaceholder')}">
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="ex-t-credit">${t('explainers.music.credit')}</label>
                        <input class="field" id="ex-t-credit" name="credit" maxlength="${this.TRACK_CREDIT_MAX}" dir="auto" autocomplete="off" aria-describedby="ex-t-credit-hint">
                        <p class="form-hint" id="ex-t-credit-hint">${t('explainers.music.creditHint')}</p>
                    </div>
                    <label class="check-row ex-check"><input type="checkbox" name="credit_required"> <span>${t('explainers.music.creditRequired')}</span></label>
                    <div id="ex-track-error"></div>
                    <div id="ex-track-progress" role="status" aria-live="polite"></div>
                    ${UI.button({ variant: 'secondary', type: 'submit', icon: 'upload', label: t('explainers.music.add'), disabled: list.length >= this.TRACKS_MAX })}
                </form>
            </section>
        `;
    },

    trackMarkup(m, i) {
        const src = safeUrl(m.url);
        return html`
            <li class="ex-track" data-track-row="${i}">
                <div class="ex-row">
                    <div class="form-group">
                        <label class="form-label" for="ex-m-${i}-title">${t('explainers.music.trackTitle')}</label>
                        <input class="field" id="ex-m-${i}-title" data-field="title" maxlength="${this.TRACK_TEXT_MAX}" dir="auto" value="${m.title}">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="ex-m-${i}-artist">${t('explainers.music.artist')}</label>
                        <input class="field" id="ex-m-${i}-artist" data-field="artist" maxlength="${this.TRACK_TEXT_MAX}" dir="auto" value="${m.artist}">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="ex-m-${i}-license">${t('explainers.music.license')}</label>
                        <input class="field" id="ex-m-${i}-license" data-field="license" maxlength="${this.TRACK_TEXT_MAX}" dir="auto" value="${m.license}">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label" for="ex-m-${i}-credit">${t('explainers.music.credit')}</label>
                    <input class="field" id="ex-m-${i}-credit" data-field="credit" maxlength="${this.TRACK_CREDIT_MAX}" dir="auto" value="${m.credit}">
                </div>
                <label class="check-row ex-check"><input type="checkbox" data-field="credit_required" ${m.credit_required ? html.raw('checked') : ''}> <span>${t('explainers.music.creditRequired')}</span></label>
                ${src ? html`<audio class="ex-track-audio" controls preload="none" src="${src}" aria-label="${t('explainers.music.preview', { title: m.title })}"></audio>` : ''}
                ${UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('explainers.music.remove'), ariaLabel: t('explainers.music.removeNamed', { title: m.title }), action: 'explainers:trackRemove', data: { i }, id: `ex-m-${i}-remove` })}
            </li>
        `;
    },

    captureMusic() {
        const form = document.getElementById('ex-music-form');
        if (!form || !this.cfg || typeof form.querySelectorAll !== 'function') return;
        const rows = Array.from(form.querySelectorAll('[data-track-row]'));
        if (rows.length !== this.cfg.music.length) return;
        rows.forEach((row, i) => {
            const get = (name) => { const el = row.querySelector(`[data-field="${name}"]`); return el && el.value !== undefined ? String(el.value).trim() : ''; };
            const box = row.querySelector('[data-field="credit_required"]');
            const m = this.cfg.music[i];
            m.title = get('title');
            m.artist = get('artist');
            m.license = get('license');
            m.credit = get('credit');
            m.credit_required = !!(box && box.checked);
        });
    },

    /** What every track must have before the server is asked: a title and a licence, and a credit line when the licence requires one. */
    trackProblems(list) {
        const problems = [];
        list.forEach((m, i) => {
            const n = UI.formatNumber(i + 1);
            if (!m.title.trim()) problems.push(t('explainers.music.problemTitle', { n }));
            if (!m.license.trim()) problems.push(t('explainers.music.problemLicense', { n }));
            if (m.credit_required && !m.credit.trim()) problems.push(t('explainers.music.problemCredit', { n }));
        });
        return problems;
    },

    async saveMusic() {
        this.captureMusic();
        const saved = await API.saveStudioSettings({ explainer: { music: this.cfg.music.map((m) => ({ ...m })) } });
        this.cfg = this.normalizeConfig(saved && saved.settings && saved.settings.explainer);
    },

    paintMusic() {
        this.paintSettingsCard('ex-card-music', this.musicMarkup());
    },

    // Uploads ------------------------------------------------------------------
    /** An image resized in the browser to at most `max` px on its longest side (an image model takes references under 512 px): a PNG stays a PNG, anything else becomes a JPEG. */
    resizeImage(file, max) {
        return new Promise((resolve, reject) => {
            const fail = () => reject(new Error(t('explainers.character.imageFailed')));
            const reader = new FileReader();
            reader.onerror = fail;
            reader.onload = () => {
                const img = new Image();
                img.onerror = fail;
                img.onload = () => {
                    const size = this.fitWithin(img.naturalWidth, img.naturalHeight, max);
                    const canvas = document.createElement('canvas');
                    canvas.width = size.width;
                    canvas.height = size.height;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) { fail(); return; }
                    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                    // A JPEG has no transparency: what is clear in the source is painted white first.
                    if (mime === 'image/jpeg') { ctx.fillStyle = 'white'; ctx.fillRect(0, 0, size.width, size.height); }
                    ctx.drawImage(img, 0, 0, size.width, size.height);
                    canvas.toBlob((blob) => (blob ? resolve(blob) : fail()), mime, 0.92);
                };
                img.src = String(reader.result);
            };
            reader.readAsDataURL(file);
        });
    },

    /** The PUT of a file to the address the server signed for it. XHR, because fetch has no upload progress. */
    putFile(signed, blob, onProgress) {
        const upload = signed && signed.upload && typeof signed.upload === 'object'
            ? signed.upload
            : { method: 'PUT', url: signed && signed.upload_url, headers: {} };
        return new Promise((resolve, reject) => {
            if (!upload.url) { reject(new Error(t('explainers.upload.failed'))); return; }
            const xhr = new XMLHttpRequest();
            xhr.open(upload.method || 'PUT', upload.url);
            const headers = upload.headers || {};
            Object.keys(headers).forEach((k) => xhr.setRequestHeader(k, headers[k]));
            if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type') && blob.type) xhr.setRequestHeader('Content-Type', blob.type);
            if (xhr.upload && typeof onProgress === 'function') xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
            xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(t('explainers.upload.failed'))));
            xhr.onerror = () => reject(new Error(t('explainers.upload.failed')));
            xhr.send(blob);
        });
    },

    /** The media type of a music file: the browser's, else what its extension says (a .m4a is often reported as nothing). */
    audioType(file) {
        const ext = String((file && file.name) || '').split('.').pop().toLowerCase();
        if (this.AUDIO_TYPES[ext]) return this.AUDIO_TYPES[ext];
        const type = String((file && file.type) || '');
        if (type === 'audio/x-m4a' || type === 'audio/mp4') return 'audio/mp4';
        return ['audio/mpeg', 'audio/wav'].includes(type) ? type : '';
    },

    // ─── Shared by the actions ───────────────────────────────────────────────
    /** Take an answer that is the whole explainer, repaint, and keep polling while a step is running. */
    afterAction(res) {
        this.applyDetail(res);
        this.paintDetail();
        this.schedulePoll(this._seq);
    },

    /** Read the explainer again, once, without a word: what a route answered with is already on screen, and this brings in what it left to the server. */
    async refreshQuietly() {
        const seq = this._seq;
        const id = this.id;
        try {
            const res = await API.getExplainer(id);
            if (!this.alive(seq) || id !== this.id) return;
            this.applyDetail(res, { poll: true });
            this.paintDetail();
        } catch { /* the page already shows the answer it got */ }
    },

    /** A scene (and the allowance) the server answered with, put into the explainer on screen. */
    applySceneAnswer(res) {
        const d = this.detail;
        if (!d || !res) return;
        if (res.scene && typeof res.scene === 'object') {
            const incoming = this.normalize({ id: d.id, scenes: [res.scene] }).scenes[0];
            const at = d.scenes.findIndex((s) => s.position === incoming.position);
            if (at !== -1) d.scenes[at] = { ...d.scenes[at], ...incoming };
        }
        if (res.allowance && typeof res.allowance === 'object') d.allowance = res.allowance;
        this.patchBody();
        this.paintRegion('ex-notices', this.noticesMarkup());
    },

    async copyText(text, doneKey) {
        try {
            await navigator.clipboard.writeText(text);
            UI.toast(t(doneKey));
        } catch {
            // No clipboard outside a secure context or in some embedded browsers: say so.
            UI.toast(t('setup.copyFailed'), 'error');
        }
    },

    problemsMarkup(list) {
        return html`<div class="inline-error" role="alert"><i data-lucide="alert-circle" aria-hidden="true"></i><ul class="ex-problems">${list.map((p) => html`<li dir="auto">${p}</li>`)}</ul></div>`;
    },

    showProblems(id, list) {
        const box = document.getElementById(id);
        if (!box) return;
        box.innerHTML = esc(this.problemsMarkup(list));
        UI.icons(box);
    },

    clearError(id) {
        const box = document.getElementById(id);
        if (box) box.innerHTML = '';
    },
};

UI.registerActions('explainers', {
    // ─── The new form and the list ───────────────────────────────────────────
    async create(form, event) {
        event.preventDefault();
        const P = ExplainersPage;
        const topic = String(form.elements.topic.value || '').trim();
        if (topic.length < P.TOPIC_MIN || topic.length > P.TOPIC_MAX) {
            P.showError('ex-new-error', new Error(t('explainers.new.topicInvalid', { min: P.TOPIC_MIN, max: P.TOPIC_MAX })));
            if (typeof form.elements.topic.focus === 'function') form.elements.topic.focus();
            return;
        }
        const sound = P.readSound(form);
        if (sound.sound_mode === 'music' && !sound.music_track_id) {
            P.showError('ex-new-error', new Error(t(P.cfg && P.cfg.music.length ? 'explainers.new.trackMissing' : 'explainers.new.noTracksYet')));
            return;
        }
        const parsed = P.parseLinks(form.elements.links ? form.elements.links.value : '');
        if (parsed.bad.length) {
            P.showError('ex-new-error', new Error(t('explainers.new.linksBad', { link: parsed.bad[0] })));
            return;
        }
        if (parsed.links.length > P.LINKS_MAX) {
            P.showError('ex-new-error', new Error(t('explainers.new.linksTooMany', { max: P.LINKS_MAX })));
            return;
        }
        const notes = String(form.elements.notes ? form.elements.notes.value : '').trim();
        if (notes.length > P.NOTES_MAX) {
            P.showError('ex-new-error', new Error(t('explainers.new.notesTooLong', { max: P.NOTES_MAX })));
            return;
        }
        const restore = UI.formBusy(form, t('explainers.new.creating'));
        if (!restore) return;
        try {
            const body = {
                topic,
                language: form.elements.language.value,
                length_tier: form.elements.length_tier.value,
                sound_mode: sound.sound_mode,
                subtitles: sound.subtitles,
            };
            if (sound.sound_mode === 'music') body.music_track_id = sound.music_track_id;
            if (notes) body.notes = notes;
            if (parsed.links.length) body.source_links = parsed.links;
            const created = await API.createExplainer(body);
            UI.toast(t('explainers.new.started'));
            if (created && typeof created.id === 'string') P.go({ id: created.id });
            else await P.render();
        } catch (err) {
            restore();
            P.showError('ex-new-error', err);
        }
    },

    soundChanged(el) {
        ExplainersPage.syncSoundFields(el && el.closest ? el.closest('form') : null);
    },

    reload() {
        return ExplainersPage.render();
    },

    removeFromList(el) {
        const P = ExplainersPage;
        const id = el.dataset.id;
        const item = P.items.find((i) => i.id === id);
        Admin.confirm({
            title: t('explainers.delete.title'),
            body: item ? P.titleOf(item) : '',
            hint: t('explainers.delete.hint'),
            confirmLabel: t('explainers.action.delete'),
            onConfirm: async () => {
                await API.deleteExplainer(id);
                P.items = P.items.filter((i) => i.id !== id);
                P.paintList();
            },
        });
    },

    // ─── One explainer ───────────────────────────────────────────────────────
    remove() {
        const P = ExplainersPage;
        const d = P.detail;
        if (!d) return;
        Admin.confirm({
            title: t('explainers.delete.title'),
            body: P.titleOf(d),
            hint: t('explainers.delete.hint'),
            confirmLabel: t('explainers.action.delete'),
            onConfirm: async () => {
                await API.deleteExplainer(d.id);
                P.discardChanges();
                P.go({});
            },
        });
    },

    goStep(el, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        ExplainersPage.setStep(el.dataset.step);
    },

    async retry(el) {
        const P = ExplainersPage;
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            P.afterAction(await API.retryExplainer(P.id));
        } catch (err) {
            UI.toast(UI.errorLine(err), 'error');
            restore();
        }
    },

    async revoice(el) {
        const P = ExplainersPage;
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            P.afterAction(await API.revoiceExplainer(P.id));
            UI.toast(t('explainers.revoice.started'));
        } catch (err) {
            UI.toast(UI.errorLine(err), 'error');
            restore();
        }
    },

    // ─── Step 1: the script ──────────────────────────────────────────────────
    editInput(form, event) {
        const field = event && event.target && event.target.dataset ? event.target.dataset.field : '';
        if (field === 'narration' || field === 'spoken' || field === 'url' || field === 'title') ExplainersPage.refreshEstimate();
    },

    sceneUp(el) {
        const i = Number(el.dataset.i);
        ExplainersPage.editScenes((list) => { if (i > 0 && i < list.length) [list[i - 1], list[i]] = [list[i], list[i - 1]]; }, `ex-s-${Math.max(0, i - 1)}-up`);
    },

    sceneDown(el) {
        const i = Number(el.dataset.i);
        ExplainersPage.editScenes((list) => { if (i >= 0 && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]]; }, `ex-s-${i + 1}-down`);
    },

    sceneAdd(el) {
        const P = ExplainersPage;
        const i = Number(el.dataset.i);
        P.captureEditor();
        if (P.work && P.work.scenes.length >= P.SCENES_MAX) {
            UI.toast(t('explainers.scene.tooMany', { max: P.SCENES_MAX }), 'warning');
            return;
        }
        P.editScenes((list) => { list.splice(Number.isInteger(i) ? i + 1 : list.length, 0, P.blankScene()); }, `ex-s-${Number.isInteger(i) ? i + 1 : 0}-narration`);
    },

    sceneRemove(el) {
        const i = Number(el.dataset.i);
        ExplainersPage.editScenes((list) => { if (i >= 0 && i < list.length) list.splice(i, 1); }, 'ex-scene-add-btn');
    },

    characterChanged(el) {
        const P = ExplainersPage;
        const row = el && el.closest ? el.closest('[data-scene-row]') : null;
        const checked = row && typeof row.querySelectorAll === 'function' ? row.querySelectorAll('input[data-char]:checked') : [];
        if (checked.length > P.LIMITS.characters) {
            el.checked = false;
            UI.toast(t('explainers.scene.tooManyCharacters', { max: P.LIMITS.characters }), 'warning');
        }
    },

    replyAdd() {
        ExplainersPage.editList('replies', (list) => { list.push({ q: '', a: '' }); });
    },

    replyRemove(el) {
        const i = Number(el.dataset.i);
        ExplainersPage.editList('replies', (list) => { if (i >= 0 && i < list.length) list.splice(i, 1); });
    },

    sourceAdd() {
        ExplainersPage.editList('sources', (list) => { list.push({ title: '', by: '', year: '', url: '' }); });
    },

    sourceRemove(el) {
        const i = Number(el.dataset.i);
        ExplainersPage.editList('sources', (list) => { if (i >= 0 && i < list.length) list.splice(i, 1); });
    },

    async saveScript(form, event) {
        event.preventDefault();
        const P = ExplainersPage;
        if (!P.isEditable()) return;
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await P.saveWork();
            P.paintDetail();
            P.paintBody(true);
            UI.toast(t('explainers.script.saved'));
        } catch (err) {
            restore();
            P.showError('ex-script-error', err);
        }
    },

    openRewrite() {
        const P = ExplainersPage;
        P.captureEditor();
        UI.showModal(P.rewriteMarkup());
    },

    async rewrite(form, event) {
        event.preventDefault();
        const P = ExplainersPage;
        const note = String(form.elements.note.value || '').trim();
        if (!note) {
            P.showError('ex-rewrite-error', new Error(t('explainers.rewrite.noteMissing')));
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            const res = await API.rewriteExplainer(P.id, { note });
            // The new draft replaces this one when it arrives: the edits that were never saved go with it.
            P.work = null;
            P.workBase = '';
            UI.closeModal();
            P.afterAction(res);
            UI.toast(t('explainers.rewrite.started'));
        } catch (err) {
            restore();
            P.showError('ex-rewrite-error', err);
        }
    },

    approve() {
        const P = ExplainersPage;
        P.captureEditor();
        const d = P.detail;
        if (!d || d.status !== 'draft') return;
        Admin.confirm({
            title: t('explainers.approve.title'),
            body: t('explainers.approve.body'),
            hint: t('explainers.approve.hint'),
            confirmLabel: t('explainers.script.approve'),
            confirmIcon: 'check',
            tone: 'primary',
            onConfirm: async () => {
                // What was typed is saved first, and the version the approval names is the one that save answered with.
                const current = P.editorDirty() ? await P.saveWork() : P.detail;
                const res = await API.approveExplainer(current.id, current.draft_version);
                P.afterAction(res);
                UI.toast(t('explainers.approve.started'));
            },
        });
    },

    // ─── Step 2: the voice ───────────────────────────────────────────────────
    playFrom(el) {
        const audio = document.getElementById('ex-audio');
        const at = Number(el.dataset.t);
        if (!audio || !Number.isFinite(at)) return;
        audio.currentTime = at;
        if (typeof audio.play === 'function') {
            const started = audio.play();
            if (started && typeof started.catch === 'function') started.catch(() => {});
        }
    },

    // ─── Step 3: the pictures ────────────────────────────────────────────────
    async drawAll(el) {
        const P = ExplainersPage;
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            P.afterAction(await API.drawExplainer(P.id));
            UI.toast(t('explainers.pictures.drawStarted'));
        } catch (err) {
            UI.toast(UI.errorLine(err), 'error');
            restore();
        }
    },

    noteInput(el) {
        const P = ExplainersPage;
        const key = el && el.dataset ? el.dataset.scene : '';
        if (key === undefined || key === '') return;
        if (el.value) P.notes[key] = el.value; else delete P.notes[key];
    },

    async redraw(el) {
        const P = ExplainersPage;
        const position = Number(el.dataset.scene);
        const input = document.getElementById(`ex-note-${position}`);
        const note = String((input && input.value) || '').trim();
        const restore = UI.actionBusy(el, t('explainers.pictures.drawingNow'));
        if (!restore) return;
        try {
            const res = await API.drawExplainerScene(P.id, position, note ? { note } : {});
            delete P.notes[position];
            if (input) input.value = '';
            P.applySceneAnswer(res);
            UI.toast(t('explainers.pictures.redrawn', { n: UI.formatNumber(position + 1) }));
            P.refreshQuietly();
        } catch (err) {
            UI.toast(UI.errorLine(err), 'error');
        } finally {
            restore();
        }
    },

    async pick(el) {
        const P = ExplainersPage;
        const position = Number(el.dataset.scene);
        const index = Number(el.dataset.index);
        try {
            P.applySceneAnswer(await API.pickExplainerPicture(P.id, position, { index }));
            P.refreshQuietly();
        } catch (err) {
            UI.toast(UI.errorLine(err), 'error');
        }
    },

    approvePictures() {
        const P = ExplainersPage;
        Admin.confirm({
            title: t('explainers.pictures.approveTitle'),
            body: t('explainers.pictures.approveBody'),
            hint: t('explainers.pictures.approveConfirmHint'),
            confirmLabel: t('explainers.pictures.approve'),
            confirmIcon: 'check',
            tone: 'primary',
            onConfirm: async () => {
                const res = await API.approveExplainerPictures(P.id);
                P.afterAction(res);
                UI.toast(t('explainers.pictures.approved'));
            },
        });
    },

    // ─── Step 4: the video ───────────────────────────────────────────────────
    async rerender(form, event) {
        event.preventDefault();
        const P = ExplainersPage;
        const d = P.detail;
        if (!d) return;
        const sound = P.readSound(form);
        if (sound.sound_mode === 'music' && !sound.music_track_id) {
            P.showError('ex-sound-error', new Error(t(P.cfg && P.cfg.music.length ? 'explainers.new.trackMissing' : 'explainers.new.noTracksYet')));
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            const changed = sound.sound_mode !== d.sound_mode || sound.subtitles !== d.subtitles
                || (sound.sound_mode === 'music' && sound.music_track_id !== d.music_track_id);
            if (changed) {
                const body = { sound_mode: sound.sound_mode, subtitles: sound.subtitles };
                if (sound.sound_mode === 'music') body.music_track_id = sound.music_track_id;
                P.applyDetail(await API.updateExplainer(d.id, body));
            }
            P.afterAction(await API.renderExplainer(d.id));
            UI.toast(t('explainers.video.rerenderStarted'));
        } catch (err) {
            restore();
            P.showError('ex-sound-error', err);
        }
    },

    // ─── Step 5: publish ─────────────────────────────────────────────────────
    atInput(el) {
        const form = el && el.closest ? el.closest('form') : null;
        const radio = form ? form.querySelector('input[name="when"][value="at"]') : null;
        if (radio) radio.checked = true;
    },

    async schedule(form, event) {
        event.preventDefault();
        const P = ExplainersPage;
        const checked = form.querySelector('input[name="when"]:checked');
        const choice = (checked && checked.value) || 'next';
        let when = choice;
        if (choice === 'at') {
            // Read as wall time in the tenant's zone, not in the browser's.
            const at = UI.zoneInput(form.elements.at ? form.elements.at.value : '', P.zone());
            if (!at) {
                P.showError('ex-schedule-error', new Error(t('explainers.publish.atMissing')));
                return;
            }
            when = at;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            const res = await API.scheduleExplainer(P.id, { when });
            P.applyDetail(res);
            await P.loadRows(P._seq);
            P.paintDetail();
            P.paintBody(true);
            P.schedulePoll(P._seq);
            UI.toast(t('explainers.publish.scheduled'));
        } catch (err) {
            restore();
            P.showError('ex-schedule-error', err);
        }
    },

    copyField(el) {
        const target = document.getElementById(el.dataset.target);
        if (!target) return;
        ExplainersPage.copyText(String(target.value || ''), 'explainers.publish.copied');
    },

    copyLinkedIn() {
        ExplainersPage.copyText(ExplainersPage.linkedinCaption(), 'explainers.linkedin.copiedCaption');
    },

    copyFirstComment() {
        const text = ExplainersPage.savedCaptions().firstComment;
        if (text) ExplainersPage.copyText(text, 'explainers.linkedin.copiedComment');
    },

    // ─── The settings view ───────────────────────────────────────────────────
    async saveLook(form, event) {
        event.preventDefault();
        const P = ExplainersPage;
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            const saved = await API.saveStudioSettings({ explainer: P.readLook(form) });
            P.cfg = P.normalizeConfig(saved && saved.settings && saved.settings.explainer);
            P.paintSettingsCard('ex-card-look', P.lookMarkup());
            UI.toast(t('explainers.look.saved'));
        } catch (err) {
            restore();
            P.showError('ex-look-error', err);
        }
    },

    async saveWriter(form, event) {
        event.preventDefault();
        const P = ExplainersPage;
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            const saved = await API.saveStudioSettings({
                explainer: { writer: form.elements.writer.value === 'gemini' ? 'gemini' : 'claude_mac', writer_fallback: !!form.elements.writer_fallback.checked },
            });
            P.cfg = P.normalizeConfig(saved && saved.settings && saved.settings.explainer);
            P.paintSettingsCard('ex-card-writer', P.writerMarkup());
            UI.toast(t('explainers.writerSetting.saved'));
        } catch (err) {
            restore();
            P.showError('ex-writer-error', err);
        }
    },

    characterAdd() {
        const P = ExplainersPage;
        P.captureCharacters();
        if (!P.cfg || P.cfg.characters.length >= P.CHARACTERS_MAX) return;
        P.cfg.characters.push({ key: P.keyFrom('', P.cfg.characters.map((c) => c.key), 'character'), name: '', description: '', ref_media_id: null, ref_url: null, approved_at: null });
        P.paintCharacters();
        const field = document.getElementById(`ex-c-${P.cfg.characters.length - 1}-name`);
        if (field && typeof field.focus === 'function') field.focus();
    },

    characterRemove(el) {
        const P = ExplainersPage;
        const i = Number(el.dataset.i);
        P.captureCharacters();
        const c = P.cfg && P.cfg.characters[i];
        if (!c) return;
        Admin.confirm({
            title: t('explainers.character.removeTitle'),
            body: c.name || c.key,
            hint: t('explainers.character.removeHint'),
            confirmLabel: t('explainers.character.remove'),
            onConfirm: async () => {
                P.captureCharacters();
                P.cfg.characters.splice(i, 1);
                // The candidates of the characters after it move up with them.
                const moved = Object.create(null);
                Object.keys(P.candidates).forEach((k) => { const n = Number(k); if (n < i) moved[n] = P.candidates[k]; else if (n > i) moved[n - 1] = P.candidates[k]; });
                P.candidates = moved;
                P.paintCharacters();
            },
        });
    },

    async saveCharacters(form, event) {
        event.preventDefault();
        const P = ExplainersPage;
        P.captureCharacters();
        const problems = P.characterProblems(P.cfg.characters);
        if (problems.length) {
            P.showProblems('ex-characters-error', problems);
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await P.saveCharacters();
            P.paintCharacters();
            UI.toast(t('explainers.characters.saved'));
        } catch (err) {
            restore();
            P.showError('ex-characters-error', err);
        }
    },

    async candidates(el) {
        const P = ExplainersPage;
        const i = Number(el.dataset.i);
        P.captureCharacters();
        const c = P.cfg && P.cfg.characters[i];
        if (!c) return;
        const status = document.getElementById(`ex-c-${i}-status`);
        if (!c.description.trim()) {
            if (status) { status.innerHTML = esc(P.errorMarkup(new Error(t('explainers.character.describeFirst')))); UI.icons(status); }
            return;
        }
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            const res = await API.createExplainerCandidates({ description: c.description });
            const found = (res && Array.isArray(res.candidates) ? res.candidates : []).filter((x) => x && typeof x.url === 'string').slice(0, 4);
            P.candidates[i] = found;
            P.paintCharacters();
            UI.toast(t('explainers.character.candidatesReady'));
            const first = document.querySelector(`[data-char-row="${i}"] .ex-cand`);
            if (first && typeof first.focus === 'function') first.focus();
        } catch (err) {
            restore();
            if (status) { status.innerHTML = esc(P.errorMarkup(err)); UI.icons(status); }
        }
    },

    async approveCandidate(el) {
        const P = ExplainersPage;
        const i = Number(el.dataset.i);
        const k = Number(el.dataset.k);
        P.captureCharacters();
        const c = P.cfg && P.cfg.characters[i];
        const cand = P.candidates[i] && P.candidates[i][k];
        if (!c || !cand) return;
        const before = { ref_media_id: c.ref_media_id, ref_url: c.ref_url, approved_at: c.approved_at };
        c.ref_media_id = String(cand.media_id || '');
        c.ref_url = String(cand.url || '');
        c.approved_at = new Date().toISOString();
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            const problems = P.characterProblems(P.cfg.characters);
            if (problems.length) throw Object.assign(new Error(problems[0]), { body: { problems } });
            await P.saveCharacters();
            delete P.candidates[i];
            P.paintCharacters();
            UI.toast(t('explainers.character.approvedToast'));
        } catch (err) {
            Object.assign(c, before);
            restore();
            const status = document.getElementById(`ex-c-${i}-status`);
            if (status) { status.innerHTML = esc(P.errorMarkup(err)); UI.icons(status); }
        }
    },

    async uploadReference(input) {
        const P = ExplainersPage;
        const i = Number(input.dataset.i);
        const file = input.files && input.files[0];
        if (!file) return;
        P.captureCharacters();
        const c = P.cfg && P.cfg.characters[i];
        const status = document.getElementById(`ex-c-${i}-status`);
        const say = (err) => { if (status) { status.innerHTML = esc(P.errorMarkup(err)); UI.icons(status); } };
        if (!c) return;
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { say(new Error(t('explainers.character.imageType'))); input.value = ''; return; }
        P._uploads += 1;
        const before = { ref_media_id: c.ref_media_id, ref_url: c.ref_url, approved_at: c.approved_at };
        try {
            if (status) status.textContent = t('explainers.upload.working');
            const blob = await P.resizeImage(file, P.REFERENCE_PX);
            const signed = await API.signExplainerUpload({ purpose: 'reference', mime: blob.type, size: blob.size });
            if (!signed || !signed.media_id || !signed.url) throw new Error(t('error.unexpected'));
            await P.putFile(signed, blob);
            c.ref_media_id = String(signed.media_id);
            c.ref_url = String(signed.url);
            c.approved_at = new Date().toISOString();
            const problems = P.characterProblems(P.cfg.characters);
            if (problems.length) throw Object.assign(new Error(problems[0]), { body: { problems } });
            await P.saveCharacters();
            delete P.candidates[i];
            P.paintCharacters();
            UI.toast(t('explainers.character.approvedToast'));
        } catch (err) {
            Object.assign(c, before);
            say(err);
        } finally {
            P._uploads -= 1;
            input.value = '';
        }
    },

    async saveMusic(form, event) {
        event.preventDefault();
        const P = ExplainersPage;
        P.captureMusic();
        const problems = P.trackProblems(P.cfg.music);
        if (problems.length) {
            P.showProblems('ex-music-error', problems);
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await P.saveMusic();
            P.paintMusic();
            UI.toast(t('explainers.music.saved'));
        } catch (err) {
            restore();
            P.showError('ex-music-error', err);
        }
    },

    async addTrack(form, event) {
        event.preventDefault();
        const P = ExplainersPage;
        const val = (name) => String((form.elements[name] && form.elements[name].value) || '').trim();
        const file = form.elements.file && form.elements.file.files ? form.elements.file.files[0] : null;
        const track = {
            title: val('title'), artist: val('artist'), license: val('license'), credit: val('credit'),
            credit_required: !!(form.elements.credit_required && form.elements.credit_required.checked),
        };
        const problems = [];
        const mime = file ? P.audioType(file) : '';
        if (!file) problems.push(t('explainers.music.problemFile'));
        else if (!mime) problems.push(t('explainers.music.problemType'));
        else if (file.size > P.UPLOAD_MAX_BYTES) problems.push(t('explainers.music.problemSize', { mb: P.UPLOAD_MAX_BYTES / (1024 * 1024) }));
        if (!track.title) problems.push(t('explainers.music.addNeedTitle'));
        if (!track.license) problems.push(t('explainers.music.addNeedLicense'));
        if (track.credit_required && !track.credit) problems.push(t('explainers.music.addNeedCredit'));
        if (P.cfg && P.cfg.music.length >= P.TRACKS_MAX) problems.push(t('explainers.music.problemFull', { max: P.TRACKS_MAX }));
        if (problems.length) {
            P.showProblems('ex-track-error', problems);
            return;
        }
        P.clearError('ex-track-error');
        const restore = UI.formBusy(form, t('explainers.music.uploading'));
        if (!restore) return;
        P._uploads += 1;
        const progress = document.getElementById('ex-track-progress');
        let added = false;
        try {
            P.captureMusic();
            const signed = await API.signExplainerUpload({ purpose: 'music', mime, size: file.size });
            if (!signed || !signed.media_id || !signed.url) throw new Error(t('error.unexpected'));
            const body = file.type === mime ? file : new Blob([file], { type: mime });
            await P.putFile(signed, body, (pct) => { if (progress) progress.textContent = t('explainers.music.progress', { pct: UI.formatPercent(pct) }); });
            P.cfg.music.push({ key: P.keyFrom(track.title, P.cfg.music.map((m) => m.key), 'track'), title: track.title, artist: track.artist, media_id: String(signed.media_id), url: String(signed.url), license: track.license, credit: track.credit, credit_required: track.credit_required });
            added = true;
            await P.saveMusic();
            P.paintMusic();
            UI.toast(t('explainers.music.added'));
        } catch (err) {
            if (added) P.cfg.music.pop();
            restore();
            if (progress) progress.textContent = '';
            P.showError('ex-track-error', err);
        } finally {
            P._uploads -= 1;
        }
    },

    trackRemove(el) {
        const P = ExplainersPage;
        const i = Number(el.dataset.i);
        P.captureMusic();
        const m = P.cfg && P.cfg.music[i];
        if (!m) return;
        Admin.confirm({
            title: t('explainers.music.removeTitle'),
            body: m.title,
            hint: t('explainers.music.removeHint'),
            confirmLabel: t('explainers.music.remove'),
            onConfirm: async () => {
                P.captureMusic();
                const [gone] = P.cfg.music.splice(i, 1);
                try {
                    await P.saveMusic();
                } catch (err) {
                    P.cfg.music.splice(i, 0, gone);
                    throw err;
                }
                P.paintMusic();
            },
        });
    },
});
