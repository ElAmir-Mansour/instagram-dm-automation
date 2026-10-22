/**
 * Ads, the "Tests" tab (#/ads_tests, A12): SPLIT TESTS (Meta's A/B tests). Two versions of an ad, or two audiences, run side by side
 * with the budget split between them and Meta's own statistics pick the better one. `AdsTests` renders INTO an element it is given
 * (`AdsTests.mount(el)`); `AdsTestsPage`, at the end of this file, is the routed page around it (the tab bar, the header, the host).
 *
 * ─── What it shows ──────────────────────────────────────────────────────────
 * A short intro and its help link, then the tests: name, kind, state, dates, the daily budget, and each arm with its share of the
 * audience. Once Meta has a result the winner is marked with its confidence (a null confidence is "—", never 0%); "no clear winner"
 * is said as such; and a test that has a proposal waiting ("keep the winner, pause the other") links to the proposals screen.
 *
 * ─── Money rules, said on the screen ────────────────────────────────────────
 * CREATING a test spends nothing: its arms stay paused, and the question says so. The API still demands `confirm: true`, so the
 * question is asked and only the answer "yes" sends it. START spends real money, so it is never one click: the question names the
 * daily budget, the number of days, the worst case (daily x days), the currency, and that the ad account's payment method is charged.
 * The limits (monthly cap, daily maximum) are the server's; its refusals are said in a sentence of ours, and its own text only when
 * the code is one we do not know.
 *
 * ─── Silent where it should be ──────────────────────────────────────────────
 * A member who is not the owner (`App.canAdminister()`) reads the list and gets no buttons and no form; a 403 is the same calm panel
 * the Ads screen shows, never an error toast.
 */
const AdsTests = {
    /** The host element `mount()` was given; null before the first mount and after destroy(). */
    _host: null,
    /** The server's GET /ads/studies answer's list, and the business portfolio the owner saved (or null). */
    studies: [],
    businessId: null,
    /** 'loading' | 'ready' | 'forbidden' | 'disabled' | 'failed' */
    view: 'loading',
    /** Bumped on every read and on destroy(), so a slow answer cannot land on another screen. */
    _seq: 0,
    /** The same guard for the candidate lists (a quick switch between the two kinds must not show the first kind's arms). */
    _candSeq: 0,
    /** The "New test" form while it is open: `{ type, name, daily, start, end, picked: [objectId] }`; null when closed. */
    _form: null,
    /** The paused ads (or ad sets) a test can be built from: `{ level, state: 'loading'|'ready'|'empty'|'failed', items, error }`. */
    _cands: null,
    /** True while the create request is out, so a second press cannot send a second test. */
    _creating: false,
    /** The business picker while it is open: `{ choices, payload, chosen }`; and whether its modal is on screen. */
    _pick: null,
    _pickOpen: false,
    /** Why the list could not be read, for the failed view. */
    _loadError: '',

    TYPES: Object.freeze(['creative', 'audience']),
    /** How many arms each kind takes (Meta's own limits), and how many days a test may run. */
    ARMS: Object.freeze({ creative: Object.freeze({ min: 2, max: 7 }), audience: Object.freeze({ min: 2, max: 5 }) }),
    MIN_DAYS: 1,
    MAX_DAYS: 30,
    STATES: Object.freeze(['creating', 'ready', 'running', 'ended', 'stopped', 'failed']),
    /** The server's refusal codes this tab has a sentence for; any other shows the server's own text. */
    CODES: Object.freeze(['INVALID', 'BUSINESS_REQUIRED', 'NOT_OWN_OBJECT', 'OVER_MONTHLY_CAP', 'OVER_DAILY_MAX', 'ADS_NOT_CONFIGURED', 'RATE_LIMITED']),
    /** The form field the server names in `field`, and the input it belongs to. */
    FIELDS: Object.freeze({ dailyBudget: 'ads-tests-daily', start: 'ads-tests-start', end: 'ads-tests-end', name: 'ads-tests-name' }),

    resetTenantState() {
        this._seq++;
        this._candSeq++;
        this.studies = [];
        this.businessId = null;
        this.view = 'loading';
        this._form = null;
        this._cands = null;
        this._creating = false;
        this._pick = null;
        this._pickOpen = false;
    },

    destroy() {
        this._seq++;
        this._candSeq++;
        this._host = null;
        this._form = null;
        this._cands = null;
        this._pick = null;
    },

    // ─── Reading ─────────────────────────────────────────────────────────────

    isOwner() {
        return typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
    },

    /** Paint into `container` and read the tests. Answers true when a fresh answer is on screen. */
    mount(container) {
        this._host = container || null;
        this.view = 'loading';
        return this.load();
    },

    async load() {
        const host = this._host;
        if (!host) return false;
        const seq = ++this._seq;
        this.view = 'loading';
        this.paint();
        let answer;
        try {
            answer = await API.getAdsStudies();
        } catch (err) {
            if (seq !== this._seq) return false;
            if (err && (err.status === 403 || err.status === 404)) {
                // 404 is ADS_DISABLED: ads are off for this workspace.
                this.view = err.status === 404 ? 'disabled' : 'forbidden';
            } else {
                this.view = 'failed';
                this._loadError = this.failure(err);
            }
            this.paint();
            return false;
        }
        if (seq !== this._seq) return false;
        this.studies = answer && Array.isArray(answer.studies) ? answer.studies : [];
        this.businessId = answer && answer.businessId ? String(answer.businessId) : null;
        this.view = 'ready';
        this.paint();
        Motion.announce(t('ads.tests.loaded', { count: this.studies.length }));
        return true;
    },

    /** After an action the states have moved: ask again, quietly. A failure leaves what is on screen. */
    async refreshQuiet() {
        const seq = ++this._seq;
        try {
            const answer = await API.getAdsStudies();
            if (seq !== this._seq || !answer || !Array.isArray(answer.studies)) return;
            this.studies = answer.studies;
            this.view = 'ready';
            this.paint();
        } catch (err) { /* keep what was known */ }
    },

    /** The server's own sentence, or the generic one. */
    failure(err) {
        return (err && err.message) || t('error.unexpected');
    },

    findStudy(id) {
        return this.studies.find((s) => String(s.id) === String(id)) || null;
    },

    /** Put the server's answer for one test in the list (at the top when it is new) and repaint. */
    applyStudy(study) {
        if (!study || study.id === undefined || study.id === null) return;
        const at = this.studies.findIndex((s) => String(s.id) === String(study.id));
        if (at === -1) this.studies = [study, ...this.studies];
        else this.studies[at] = Object.assign({}, this.studies[at], study);
        this.paint();
    },

    // ─── Numbers and words ───────────────────────────────────────────────────

    /**
     * How the audience is split between `n` arms: 100 / n, the remainder going to the first arms, so 3 arms are 34 / 33 / 33 and the
     * shares always add up to 100. Fewer than two arms is no split: [].
     */
    shares(n) {
        const count = Math.floor(Number(n));
        if (!Number.isFinite(count) || count < 2) return [];
        const base = Math.floor(100 / count);
        const extra = 100 - base * count;
        return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
    },

    /** `12.5 SAR` as one isolated run: a currency code never reorders an Arabic sentence. */
    money(amount, currency) {
        const n = Number(amount);
        if (amount === null || amount === undefined || amount === '' || !Number.isFinite(n)) return '—';
        return `⁦${UI.formatNumber(n)}${currency ? ` ${currency}` : ''}⁩`;
    },

    /** A name from the server isolated by its own first strong letter, for a sentence in the other script. */
    isolate(text) {
        return `⁨${String(text === null || text === undefined ? '' : text)}⁩`;
    },

    /** A `YYYY-MM-DD` day in words. Read at noon UTC so no zone moves it to the neighbouring day. */
    dayText(day) {
        return /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? UI.formatDay(`${day}T12:00:00Z`) : '—';
    },

    /** Whole days from `start` to `end` (both `YYYY-MM-DD`), or null when either is not a day. */
    daysBetween(start, end) {
        const m = (v) => /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
        const a = m(start);
        const b = m(end);
        if (!a || !b) return null;
        return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000);
    },

    /** `day` plus `n` days, as `YYYY-MM-DD`. */
    addDays(day, n) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
        if (!m) return '';
        return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
    },

    /** Today in the browser's own zone, as `YYYY-MM-DD`. */
    today() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },

    /** The earliest start the form takes: tomorrow. */
    tomorrow() {
        return this.addDays(this.today(), 1);
    },

    /**
     * Meta's confidence as a percentage, or null. The server sends it as written by Meta: a share of 1 ("0.95") or already a percentage
     * ("95"); a number above 1 is a percentage, one up to 1 a share. (A "1%" confidence is not a winner anyone would be shown.)
     */
    confidencePercent(value) {
        const n = Number(value);
        if (value === null || value === undefined || value === '' || !Number.isFinite(n) || n < 0) return null;
        return Math.min(100, Math.round(n <= 1 ? n * 100 : n));
    },

    confidenceText(value) {
        const p = this.confidencePercent(value);
        return p === null ? '—' : UI.formatPercent(p);
    },

    stateWord(state) {
        const key = `ads.tests.state.${state}`;
        const said = t(key);
        return said === key ? String(state || '—') : said;
    },

    stateChip(state) {
        const tone = state === 'running' ? 'badge-success' : state === 'failed' ? 'badge-danger' : state === 'creating' ? 'badge-info' : 'badge-neutral';
        return html`<span class="badge ${html.raw(tone)}" data-ads-test-state="${state}">${this.stateWord(state)}</span>`;
    },

    typeWord(type) {
        return type === 'audience' ? t('ads.tests.type.audience') : t('ads.tests.type.creative');
    },

    /** The currency the candidates are in (the first that names one), else the one of the tests already listed. */
    currency() {
        const items = this._cands && Array.isArray(this._cands.items) ? this._cands.items : [];
        const own = items.find((i) => i && i.budget && i.budget.currency);
        if (own) return String(own.budget.currency);
        const study = this.studies.find((s) => s && s.currency);
        return study ? String(study.currency) : '';
    },

    // ─── Painting ────────────────────────────────────────────────────────────

    paint() {
        const host = this._host;
        if (!host) return;
        const focus = UI.captureFocus(host);
        host.innerHTML = esc(this.markup());
        UI.icons(host);
        UI.restoreFocus(focus);
    },

    markup() {
        const intro = html`
            <p class="ads-tests-intro form-hint">${t('ads.tests.intro')} ${UI.helpLink('ads#split-tests', t('ads.tests.helpLink'))}</p>
        `;
        if (this.view === 'forbidden') {
            return html`<div id="ads-tests" class="ads-tests">${UI.emptyState({ icon: 'lock', title: t('ads.owner.title'), body: t('ads.owner.body') })}</div>`;
        }
        if (this.view === 'disabled') {
            return html`<div id="ads-tests" class="ads-tests">${UI.emptyState({ icon: 'lock', title: t('ads.disabled.title'), body: t('ads.disabled.body') })}</div>`;
        }
        if (this.view === 'loading') {
            return html`<div id="ads-tests" class="ads-tests">${intro}<div class="ads-tests-loading" role="status">${Motion.busy()}${Motion.tableCard(3, [t('ads.tests.col.name'), t('ads.tests.col.state'), t('ads.tests.col.budget')])}</div></div>`;
        }
        if (this.view === 'failed') {
            return html`
                <div id="ads-tests" class="ads-tests">
                    ${intro}
                    ${UI.errorStrip(t('ads.tests.loadFailed'), this._loadError || '', 'ads-tests-load-error')}
                    <div class="ads-actions">${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('ads.refresh'), action: 'adstests:reload', focusKey: 'ads-tests-reload' })}</div>
                </div>
            `;
        }
        const owner = this.isOwner();
        return html`
            <div id="ads-tests" class="ads-tests">
                <div class="ads-section-head">
                    ${intro}
                    ${owner && !this._form ? UI.button({ variant: 'primary', size: 'sm', icon: 'plus', label: t('ads.tests.new'), action: 'adstests:openForm', focusKey: 'ads-tests-new' }) : ''}
                </div>
                ${owner && this._form ? this.formCard() : ''}
                <div id="ads-tests-list" class="ads-tests-list">${this.listMarkup(owner)}</div>
            </div>
        `;
    },

    listMarkup(owner) {
        if (this.studies.length === 0) {
            return UI.emptyState({
                icon: 'layers',
                title: t('ads.tests.empty.title'),
                body: owner ? t('ads.tests.empty.body') : t('ads.tests.empty.bodyViewer'),
            });
        }
        return html`<ul class="ads-tests-items" aria-label="${t('ads.tests.title')}">${this.studies.map((s) => html`<li>${this.studyCard(s, owner)}</li>`)}</ul>`;
    },

    /** One test: its header, what it spends and when, its arms, what Meta found, and what can be done to it. */
    studyCard(s, owner) {
        const id = String(s.id);
        const state = String(s.state || '');
        const cells = Array.isArray(s.cells) ? s.cells : [];
        const result = s.result && typeof s.result === 'object' ? s.result : null;
        const days = Number.isFinite(Number(s.days)) ? Number(s.days) : this.daysBetween(s.start, s.end);
        const name = String(s.name || s.id);
        return html`
            <article class="surface ui-card ads-test" id="ads-test-${id}" data-ads-test="${id}" aria-labelledby="ads-test-${id}-title">
                <div class="ads-test-head">
                    <h3 class="card-title" id="ads-test-${id}-title" dir="auto">${name}</h3>
                    <span class="ads-name-meta">
                        <span class="badge badge-neutral">${this.typeWord(s.type)}</span>
                        ${this.stateChip(state)}
                    </span>
                </div>
                <dl class="ads-test-facts">
                    <div><dt>${t('ads.tests.col.dates')}</dt><dd>${t('ads.tests.dates', { start: this.dayText(s.start), end: this.dayText(s.end) })}${days !== null ? html` <span class="form-hint">(${t('ads.tests.days', { count: days })})</span>` : ''}</dd></div>
                    <div><dt>${t('ads.tests.col.budget')}</dt><dd>${t('ads.tests.budgetDaily', { amount: this.money(s.dailyBudget, s.currency) })}</dd></div>
                </dl>
                <ul class="ads-test-arms" aria-label="${t('ads.tests.col.arms')}">${cells.map((c) => this.armRow(c, result))}</ul>
                ${this.resultNote(s, result)}
                ${state === 'creating' ? html`<p class="form-hint ads-test-creating"><i data-lucide="loader" aria-hidden="true"></i> ${t('ads.tests.creating')}</p>` : ''}
                ${state === 'failed' ? UI.errorStrip(s.error || t('ads.tests.failed'), '', `ads-test-${id}-error`) : ''}
                ${s.proposalId ? html`<p class="ads-test-proposal"><i data-lucide="inbox" aria-hidden="true"></i> ${t('ads.tests.proposal')} <a class="ads-post-link" href="#/ads/proposals">${t('ads.tests.proposal.open')}</a></p>` : ''}
                ${this.actionsRow(s, owner)}
            </article>
        `;
    },

    /** One arm: its name, its share of the audience, and (with a result) whether it won and how sure Meta is. */
    armRow(c, result) {
        const label = String(c.name || c.objectName || '');
        const sub = c.objectName && c.objectName !== c.name ? c.objectName : '';
        const share = Number(c.treatmentPercentage);
        return html`
            <li class="ads-test-arm${c.winner ? html.raw(' ads-test-arm--winner') : ''}" data-ads-arm="${c.objectId}">
                <span class="ads-name">
                    <strong dir="auto">${label}</strong>
                    ${sub ? html`<span class="ads-name-sub" dir="auto">${sub}</span>` : ''}
                </span>
                <span class="ads-test-share">${t('ads.tests.share', { percent: Number.isFinite(share) ? UI.formatPercent(share) : '—' })}</span>
                ${result ? html`<span class="ads-test-confidence">${t('ads.tests.confidence', { percent: this.confidenceText(c.confidence) })}</span>` : ''}
                ${c.winner ? html`<span class="badge badge-success ads-test-winner"><i data-lucide="check-circle" aria-hidden="true"></i> ${t('ads.tests.winner')}</span>` : ''}
            </li>
        `;
    },

    /** What Meta found, in a sentence: interim or final, or that it could not tell the arms apart. */
    resultNote(s, result) {
        if (!result) return '';
        if (result.noWinner) return html`<p class="form-hint ads-test-result" data-ads-result="none">${t('ads.tests.noWinner')}</p>`;
        const when = result.checkedAt ? ` ${t('ads.tests.checkedAt', { date: UI.formatDay(result.checkedAt) })}` : '';
        return html`<p class="form-hint ads-test-result" data-ads-result="${result.final ? 'final' : 'interim'}">${result.final ? t('ads.tests.result.final') : t('ads.tests.result.interim')}${when}</p>`;
    },

    /** Start and Stop for the owner; nothing for a viewer. A link to the test in Ads Manager is not an action, so everyone has it. */
    actionsRow(s, owner) {
        const id = String(s.id);
        const name = this.isolate(s.name || s.id);
        const label = (key) => t('ads.tests.actionFor', { action: t(key), name });
        const buttons = [];
        if (owner && s.state === 'ready') {
            buttons.push(UI.button({ variant: 'primary', size: 'sm', icon: 'play', label: t('ads.tests.start'), action: 'adstests:start', data: { id }, focusKey: `ads-tests-start-${id}`, ariaLabel: label('ads.tests.start') }));
        }
        if (owner && (s.state === 'ready' || s.state === 'running')) {
            buttons.push(UI.button({ variant: 'secondary', size: 'sm', icon: 'pause', label: t('ads.tests.stop'), action: 'adstests:stop', data: { id }, focusKey: `ads-tests-stop-${id}`, ariaLabel: label('ads.tests.stop') }));
        }
        const link = s.adsManagerUrl ? UI._anchorButton({ href: s.adsManagerUrl, label: t('ads.tests.openManager'), icon: 'external-link', variant: 'ghost', size: 'sm' }) : '';
        if (buttons.length === 0 && !link) return '';
        return html`<div class="ads-actions ads-test-actions">${buttons}${link}</div>`;
    },

    // ─── The form ────────────────────────────────────────────────────────────

    /** A fresh form: the first kind, a week from tomorrow, nothing picked. */
    freshForm(type) {
        const start = this.tomorrow();
        return { type: type === 'audience' ? 'audience' : 'creative', name: '', daily: '', start, end: this.addDays(start, 7), picked: [] };
    },

    openForm() {
        if (!this.isOwner() || this._form) return;
        this._form = this.freshForm('creative');
        this.paint();
        this.loadCandidates();
        this.focusOn('ads-tests-form-title');
    },

    closeForm() {
        this._form = null;
        this._cands = null;
        this._candSeq++;
        this.paint();
        this.focusOn('ads-tests-new');
    },

    /** Put focus on something that is still on screen (the button that was pressed has been replaced). */
    focusOn(id) {
        const el = document.getElementById(id);
        if (!el || typeof el.focus !== 'function') return;
        if (typeof el.setAttribute === 'function' && !/^(BUTTON|INPUT|A)$/i.test(el.tagName || '')) el.setAttribute('tabindex', '-1');
        el.focus();
    },

    formCard() {
        const f = this._form;
        const limits = this.ARMS[f.type];
        const levelWord = f.type === 'audience' ? 'audience' : 'creative';
        return UI.card({
            id: 'ads-tests-form-card',
            title: html`<span id="ads-tests-form-title" tabindex="-1">${t('ads.tests.new.title')}</span>`,
            body: html`
                <form id="ads-tests-form" class="ads-test-form" data-submit="adstests:submit" novalidate>
                    <div id="ads-tests-form-error"></div>
                    <fieldset class="fieldset-plain form-group">
                        <legend class="form-label">${t('ads.tests.field.type')}</legend>
                        <label class="ads-test-radio"><input type="radio" id="ads-tests-type-creative" name="type" value="creative" data-change="adstests:typeChanged"${f.type === 'creative' ? html.raw(' checked') : ''}> ${t('ads.tests.type.creative.long')}</label>
                        <label class="ads-test-radio"><input type="radio" id="ads-tests-type-audience" name="type" value="audience" data-change="adstests:typeChanged"${f.type === 'audience' ? html.raw(' checked') : ''}> ${t('ads.tests.type.audience.long')}</label>
                        <p class="form-hint" id="ads-tests-type-hint">${t(`ads.tests.type.${levelWord}.hint`)}</p>
                    </fieldset>
                    <fieldset class="fieldset-plain form-group" aria-describedby="ads-tests-arms-hint">
                        <legend class="form-label">${t(`ads.tests.arms.legend.${levelWord}`)}</legend>
                        <p class="form-hint" id="ads-tests-arms-hint">${t('ads.tests.arms.hint', { min: UI.formatNumber(limits.min), max: UI.formatNumber(limits.max) })}</p>
                        <div id="ads-tests-candidates">${this.candidatesMarkup()}</div>
                    </fieldset>
                    <div class="form-grid ads-test-fields">
                        <div class="form-group">
                            <label class="form-label" for="ads-tests-daily">${t('ads.tests.field.daily')} ${this.currency() ? html`<span class="label-optional">${UI.ltr(this.currency())}</span>` : ''}</label>
                            <input class="field field-mono" id="ads-tests-daily" name="dailyBudget" type="number" dir="ltr" inputmode="decimal" min="0" step="any"
                                   value="${f.daily}" data-input="adstests:formChanged" aria-describedby="ads-tests-daily-hint" required>
                            <p class="form-hint" id="ads-tests-daily-hint">${t('ads.tests.field.dailyHint')}</p>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="ads-tests-name">${t('ads.tests.field.name')} <span class="label-optional">${t('common.optional')}</span></label>
                            <input class="field" id="ads-tests-name" name="name" type="text" maxlength="80" dir="auto" value="${f.name}" data-input="adstests:formChanged">
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="ads-tests-start">${t('ads.tests.field.start')}</label>
                            <input class="field field-mono" id="ads-tests-start" name="start" type="date" dir="ltr" min="${this.tomorrow()}" value="${f.start}"
                                   data-change="adstests:formChanged" data-input="adstests:formChanged" aria-describedby="ads-tests-start-hint" required>
                            <p class="form-hint" id="ads-tests-start-hint">${t('ads.tests.field.startHint')}</p>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="ads-tests-end">${t('ads.tests.field.end')}</label>
                            <input class="field field-mono" id="ads-tests-end" name="end" type="date" dir="ltr" min="${this.addDays(f.start, this.MIN_DAYS)}" max="${this.addDays(f.start, this.MAX_DAYS)}" value="${f.end}"
                                   data-change="adstests:formChanged" data-input="adstests:formChanged" aria-describedby="ads-tests-end-hint" required>
                            <p class="form-hint" id="ads-tests-end-hint">${t('ads.tests.field.endHint', { min: UI.formatNumber(this.MIN_DAYS), max: UI.formatNumber(this.MAX_DAYS) })}</p>
                        </div>
                    </div>
                    <div class="ads-test-summary surface" id="ads-tests-summary" aria-live="polite">${this.summaryMarkup()}</div>
                    <p class="form-hint">${t('ads.tests.noSpend')}</p>
                    <div class="ads-actions">
                        ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'adstests:closeForm', focusKey: 'ads-tests-cancel' })}
                        ${UI.button({ variant: 'primary', type: 'submit', id: 'ads-tests-submit', icon: 'check', label: t('ads.tests.create') })}
                    </div>
                </form>
            `,
        });
    },

    /** The arms to choose from: paused ads (or ad sets), each with a checkbox, a thumbnail and its name. */
    candidatesMarkup() {
        const c = this._cands;
        const f = this._form;
        if (!c || c.state === 'loading') return html`<p class="form-hint" role="status">${t('common.loading')}</p>`;
        if (c.state === 'failed') {
            return html`${UI.errorStrip(t('ads.tests.cands.failed'), c.error || '', 'ads-tests-cands-error')}
                <div class="ads-actions">${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('ads.refresh'), action: 'adstests:reloadCandidates', focusKey: 'ads-tests-cands-retry' })}</div>`;
        }
        if (c.state === 'empty' || c.items.length === 0) {
            return UI.emptyState({
                icon: 'layers',
                title: t('ads.tests.cands.empty.title'),
                body: f && f.type === 'audience' ? t('ads.tests.cands.empty.audience') : t('ads.tests.cands.empty.creative'),
            });
        }
        return html`<div class="ads-test-cands" role="group">${c.items.map((item) => this.candidateRow(item, f))}</div>`;
    },

    candidateRow(item, f) {
        const id = String(item.id);
        const on = !!f && f.picked.includes(id);
        const thumb = item.creative && item.creative.thumbUrl ? UI._href(item.creative.thumbUrl) : '';
        const budget = item.budget && item.budget.amount !== null && item.budget.amount !== undefined
            ? t('ads.tests.budgetDaily', { amount: this.money(item.budget.amount, item.budget.currency) }) : '';
        return html`
            <label class="check-row check-row-tap ads-test-cand">
                <input type="checkbox" name="cell" value="${id}" data-change="adstests:armToggled"${on ? html.raw(' checked') : ''}>
                ${thumb ? html`<img class="ads-test-thumb" src="${thumb}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
                <span class="check-text">
                    <span class="check-label" dir="auto">${item.name || id}</span>
                    ${budget && f && f.type === 'audience' ? html`<span class="form-hint">${budget}</span>` : ''}
                </span>
            </label>
        `;
    },

    /** The live lines under the form: the split between the arms picked, and the worst case this test could cost. */
    summaryMarkup() {
        const f = this._form;
        if (!f) return '';
        const limits = this.ARMS[f.type];
        const split = this.shares(f.picked.length);
        const days = this.daysBetween(f.start, f.end);
        const daily = Number(f.daily);
        const haveMoney = f.daily !== '' && Number.isFinite(daily) && daily > 0 && days !== null && days >= this.MIN_DAYS && days <= this.MAX_DAYS;
        return html`
            <p id="ads-tests-split">${split.length
                ? t('ads.tests.split', { shares: split.map((p) => UI.formatPercent(p)).join(' / ') })
                : t('ads.tests.split.need', { min: UI.formatNumber(limits.min) })}</p>
            <p id="ads-tests-worst">${haveMoney
                ? t('ads.tests.worst', { daily: this.money(daily, this.currency()), days: t('ads.tests.days', { count: days }), total: this.money(daily * days, this.currency()) })
                : t('ads.tests.worst.pending')}</p>
            ${haveMoney ? html`<p class="form-hint">${t('ads.tests.worst.cap')}</p>` : ''}
        `;
    },

    paintSummary() {
        const host = document.getElementById('ads-tests-summary');
        if (host) host.innerHTML = esc(this.summaryMarkup());
    },

    paintCandidates() {
        const host = document.getElementById('ads-tests-candidates');
        if (!host) return;
        const focus = UI.captureFocus(host);
        host.innerHTML = esc(this.candidatesMarkup());
        UI.icons(host);
        UI.restoreFocus(focus);
    },

    /** Read the paused ads (creative) or ad sets (audience). A 404 (the route is not there yet) is the empty state, not an error. */
    async loadCandidates() {
        const f = this._form;
        if (!f) return;
        const level = f.type === 'audience' ? 'adset' : 'ad';
        const seq = ++this._candSeq;
        this._cands = { level, state: 'loading', items: [], error: '' };
        this.paintCandidates();
        let answer;
        try {
            answer = await API.getAdsObjects({ level, status: 'PAUSED' });
        } catch (err) {
            if (seq !== this._candSeq || !this._form) return;
            this._cands = err && err.status === 404
                ? { level, state: 'empty', items: [], error: '' }
                : { level, state: 'failed', items: [], error: this.failure(err) };
            this.paintCandidates();
            return;
        }
        if (seq !== this._candSeq || !this._form) return;
        const items = answer && Array.isArray(answer.items) ? answer.items.filter((i) => i && i.id !== undefined && i.id !== null) : [];
        this._cands = { level, state: items.length ? 'ready' : 'empty', items, error: '' };
        this.paintCandidates();
        // The currency may have just become known: the budget label and the summary say it.
        this.paintSummary();
    },

    /** Pull the form's values into `_form` (the page reads them from the form on submit, and from the events in between). */
    syncFrom(form) {
        const f = this._form;
        if (!f || !form || !form.elements) return;
        const read = (name) => (form.elements[name] && form.elements[name].value !== undefined ? String(form.elements[name].value) : null);
        const daily = read('dailyBudget');
        const name = read('name');
        const start = read('start');
        const end = read('end');
        if (daily !== null) f.daily = daily.trim();
        if (name !== null) f.name = name;
        if (start !== null) f.start = start.trim();
        if (end !== null) f.end = end.trim();
    },

    typeChanged(el) {
        const f = this._form;
        if (!f || !el) return;
        const type = el.value === 'audience' ? 'audience' : 'creative';
        if (type === f.type) return;
        f.type = type;
        f.picked = [];
        // The hint, the legend and the arms all belong to the kind: repaint the card (the typed values are in `_form`).
        const form = document.getElementById('ads-tests-form');
        this.syncFrom(form);
        this.paint();
        this.loadCandidates();
    },

    armToggled(el) {
        const f = this._form;
        if (!f || !el) return;
        const id = String(el.value);
        const max = this.ARMS[f.type].max;
        if (el.checked) {
            if (f.picked.length >= max) {
                // One more than the kind takes: say so, and put the box back.
                el.checked = false;
                this.showFormError(t('ads.tests.err.pickMax', { max: UI.formatNumber(max) }));
                return;
            }
            if (!f.picked.includes(id)) f.picked.push(id);
        } else {
            f.picked = f.picked.filter((x) => x !== id);
        }
        this.clearFormError();
        this.paintSummary();
    },

    formChanged(el) {
        const f = this._form;
        if (!f || !el) return;
        const form = document.getElementById('ads-tests-form');
        if (form && form.elements) this.syncFrom(form);
        else if (el.name === 'dailyBudget') f.daily = String(el.value || '').trim();
        // The end date can only be 1-30 days after the start: the input says so, the moment the start moves.
        const end = document.getElementById('ads-tests-end');
        if (end && typeof end.setAttribute === 'function' && f.start) {
            end.setAttribute('min', this.addDays(f.start, this.MIN_DAYS));
            end.setAttribute('max', this.addDays(f.start, this.MAX_DAYS));
        }
        this.paintSummary();
    },

    // ─── Create ──────────────────────────────────────────────────────────────

    showFormError(message, field) {
        const host = document.getElementById('ads-tests-form-error');
        const form = document.getElementById('ads-tests-form');
        if (form) UI.clearInvalid(form);
        if (!host) { UI.toast(message, 'error'); return; }
        const stripId = 'ads-tests-error-strip';
        host.innerHTML = esc(UI.errorStrip(message, '', stripId));
        UI.icons(host);
        const input = field && this.FIELDS[field] ? document.getElementById(this.FIELDS[field]) : null;
        if (input) UI.markInvalid(input, stripId);
        else if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    },

    clearFormError() {
        const host = document.getElementById('ads-tests-form-error');
        if (host) host.innerHTML = '';
    },

    /**
     * What is wrong with the form, as `{ message, field }`, or null. The server checks all of it again (and knows the limits we do not);
     * this is so the common slips are said before a question is asked.
     */
    problem(f) {
        const limits = this.ARMS[f.type];
        if (f.picked.length < limits.min) return { message: t('ads.tests.err.pick', { min: UI.formatNumber(limits.min) }), field: '' };
        if (f.picked.length > limits.max) return { message: t('ads.tests.err.pickMax', { max: UI.formatNumber(limits.max) }), field: '' };
        if (f.type === 'creative') {
            // Versions of one ad are ads of ONE ad set: Meta splits that ad set's audience between them.
            const items = (this._cands && this._cands.items) || [];
            const parents = new Set(f.picked.map((id) => {
                const item = items.find((i) => String(i.id) === id);
                return item && item.parentId !== undefined && item.parentId !== null ? String(item.parentId) : '';
            }));
            if (parents.size > 1) return { message: t('ads.tests.err.sameAdset'), field: '' };
        }
        const daily = Number(f.daily);
        if (f.daily === '' || !Number.isFinite(daily) || daily <= 0) return { message: t('ads.tests.err.daily'), field: 'dailyBudget' };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(f.start) || f.start < this.tomorrow()) return { message: t('ads.tests.err.start'), field: 'start' };
        const days = this.daysBetween(f.start, f.end);
        if (days === null || days < this.MIN_DAYS || days > this.MAX_DAYS) {
            return { message: t('ads.tests.err.days', { min: UI.formatNumber(this.MIN_DAYS), max: UI.formatNumber(this.MAX_DAYS) }), field: 'end' };
        }
        return null;
    },

    submit(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const f = this._form;
        if (!f || !this.isOwner() || this._creating) return;
        this.syncFrom(form);
        this.clearFormError();
        const bad = this.problem(f);
        if (bad) { this.showFormError(bad.message, bad.field); return; }
        const payload = { type: f.type, cells: f.picked.slice(), dailyBudget: Number(f.daily), start: f.start, end: f.end, confirm: true };
        if (f.name.trim()) payload.name = f.name.trim();
        const days = this.daysBetween(f.start, f.end);
        // Creating spends nothing (the arms stay paused). The server still demands `confirm: true`, so the question is asked and only
        // "yes" sends it.
        UI.confirm({
            title: t('ads.tests.create.title'),
            body: t('ads.tests.create.body'),
            hint: t('ads.tests.create.hint', {
                count: UI.formatNumber(payload.cells.length), start: this.dayText(f.start), end: this.dayText(f.end), days: t('ads.tests.days', { count: days }),
            }),
            tone: 'primary',
            confirmLabel: t('ads.tests.create'),
            confirmIcon: 'check',
            // Not returned: the question closes at once, and a refusal is said on the form (which stays), or by the business picker.
            onConfirm: () => { AdsTests.create(payload); },
        });
    },

    async create(payload) {
        if (this._creating) return;
        this._creating = true;
        const button = document.getElementById('ads-tests-submit');
        const restore = UI.actionBusy(button, t('ads.tests.creating.button'));
        try {
            const answer = await API.createAdsStudy(payload);
            this.created(answer);
        } catch (err) {
            this.createFailed(err, payload);
        } finally {
            this._creating = false;
            if (restore) restore();
        }
    },

    created(answer) {
        this._form = null;
        this._cands = null;
        this._candSeq++;
        this._pick = null;
        if (this._pickOpen) { this._pickOpen = false; UI.closeModal(); }
        if (answer && answer.study) this.applyStudy(answer.study);
        else this.paint();
        UI.toast(t('ads.tests.created'), 'success');
        Motion.announce(t('ads.tests.created'));
        this.focusOn('ads-tests-list');
        this.refreshQuiet();
    },

    createFailed(err, payload) {
        const code = err && err.code;
        if (code === 'BUSINESS_REQUIRED') {
            const body = err.body || {};
            const choices = Array.isArray(body.choices) ? body.choices : (Array.isArray(err.choices) ? err.choices : []);
            this.askBusiness(choices, payload);
            return;
        }
        const field = (err && err.body && err.body.field) || '';
        this.showFormError(this.sentence(err), field);
    },

    /**
     * The server's refusal as a sentence of ours when its code is one we know (the server's own text is for the codes we do not): the
     * monthly cap and the daily maximum are the owner's own settings, and the sentence says where they are changed.
     */
    sentence(err) {
        const code = err && typeof err.code === 'string' ? err.code : '';
        if (!this.CODES.includes(code)) return this.failure(err);
        if (code === 'RATE_LIMITED') {
            const at = err.body && err.body.retryAt !== undefined ? err.body.retryAt : err.retryAt;
            const when = at !== undefined && at !== null && Number.isFinite(new Date(at).getTime()) ? UI.formatTime(new Date(at).toISOString()) : '';
            return when ? t('ads.tests.err.RATE_LIMITED', { time: `⁦${when}⁩` }) : t('ads.tests.err.RATE_LIMITED.soon');
        }
        return t(`ads.tests.err.${code}`);
    },

    // ─── The business portfolio ──────────────────────────────────────────────

    /**
     * A split test belongs to a Meta business portfolio, and none is saved yet. The owner picks one of the portfolios the token can see; it is
     * saved with the ads settings, and the test is created again. Nothing is sent until the pick is made.
     */
    askBusiness(choices, payload) {
        const list = (choices || []).filter((c) => c && c.id !== undefined && c.id !== null);
        this._pick = { choices: list, payload, chosen: list.length === 1 ? String(list[0].id) : '' };
        this._pickOpen = true;
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">${t('ads.tests.business.title')}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <p class="modal-body-text">${t('ads.tests.business.body')}</p>
            <div id="ads-tests-business-error"></div>
            <form id="ads-tests-business-form" data-submit="adstests:businessSubmit" novalidate>
                ${list.length === 0
                    ? html`<p class="form-hint">${t('ads.tests.business.none')}</p>`
                    : html`<fieldset class="fieldset-plain form-group">
                        <legend class="sr-only">${t('ads.tests.business.title')}</legend>
                        ${list.map((c) => html`<label class="ads-test-radio"><input type="radio" name="business" value="${c.id}" data-change="adstests:businessChosen"${String(c.id) === this._pick.chosen ? html.raw(' checked') : ''}> <span dir="auto">${c.name || c.id}</span> <span class="form-hint">${UI.ltr(String(c.id))}</span></label>`)}
                    </fieldset>`}
                <div class="modal-actions">
                    ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                    ${list.length ? UI.button({ variant: 'primary', type: 'submit', id: 'ads-tests-business-save', icon: 'check', label: t('ads.tests.business.save') }) : ''}
                </div>
            </form>
        `);
    },

    businessChosen(el) {
        if (this._pick && el) this._pick.chosen = String(el.value || '');
    },

    showPickError(message) {
        const host = document.getElementById('ads-tests-business-error');
        if (!host) { UI.toast(message, 'error'); return; }
        host.innerHTML = esc(UI.errorStrip(message, '', 'ads-tests-business-error-strip'));
        UI.icons(host);
    },

    /** Save the portfolio with the ads settings, then create the test again. */
    async businessSubmit(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const pick = this._pick;
        if (!pick) return;
        const chosen = pick.chosen || (form && form.elements && form.elements.business ? String(form.elements.business.value || '') : '');
        const host = document.getElementById('ads-tests-business-error');
        if (host) host.innerHTML = '';
        if (!chosen) { this.showPickError(t('ads.tests.business.pickOne')); return; }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveAdsSettings({ businessId: chosen });
            this.businessId = chosen;
        } catch (err) {
            restore();
            this.showPickError(this.failure(err));
            return;
        }
        // Saved: the same test, once more. A refusal now is said on the form, behind the closed picker.
        let answer;
        try {
            answer = await API.createAdsStudy(pick.payload);
        } catch (err) {
            restore();
            this._pickOpen = false;
            UI.closeModal();
            this._pick = null;
            this.createFailed(err, pick.payload);
            return;
        }
        restore();
        this.created(answer);
    },

    // ─── Start: STARTS SPENDING MONEY ────────────────────────────────────────

    start(id) {
        const s = this.findStudy(id);
        if (!s || s.state !== 'ready' || !this.isOwner()) return;
        const days = Number.isFinite(Number(s.days)) ? Number(s.days) : this.daysBetween(s.start, s.end);
        const daily = Number(s.dailyBudget);
        const worst = Number.isFinite(daily) && days !== null ? daily * days : null;
        UI.confirm({
            title: t('ads.tests.start.title'),
            body: t('ads.tests.start.body', {
                name: this.isolate(s.name || s.id), daily: this.money(s.dailyBudget, s.currency), days: t('ads.tests.days', { count: days }),
                total: this.money(worst, s.currency),
            }),
            hint: `${t('ads.tests.start.hint', { start: this.dayText(s.start), end: this.dayText(s.end) })} ${t('ads.tests.start.payment')}`,
            confirmLabel: t('ads.tests.start.confirm'),
            confirmIcon: 'play',
            // The promise keeps the question open: a refusal (the cap, the daily maximum) is said inside it, in our words.
            onConfirm: () => AdsTests.startConfirmed(id),
        });
    },

    /** The question was answered yes: the one place `confirm: true` is sent. */
    async startConfirmed(id) {
        let answer;
        try {
            answer = await API.startAdsStudy(id);
        } catch (err) {
            throw new Error(this.sentence(err));
        }
        if (answer && answer.study) this.applyStudy(answer.study);
        UI.toast(t('ads.tests.started'), 'success');
        this.refreshQuiet();
    },

    // ─── Stop ────────────────────────────────────────────────────────────────

    stop(id) {
        const s = this.findStudy(id);
        if (!s || (s.state !== 'ready' && s.state !== 'running') || !this.isOwner()) return;
        UI.confirm({
            title: t('ads.tests.stop.title'),
            body: t('ads.tests.stop.body', { name: this.isolate(s.name || s.id) }),
            hint: t('ads.tests.stop.hint'),
            tone: 'primary',
            confirmLabel: t('ads.tests.stop'),
            confirmIcon: 'pause',
            onConfirm: () => AdsTests.stopConfirmed(id),
        });
    },

    async stopConfirmed(id) {
        let answer;
        try {
            answer = await API.stopAdsStudy(id);
        } catch (err) {
            throw new Error(this.sentence(err));
        }
        if (answer && answer.study) this.applyStudy(answer.study);
        UI.toast(t('ads.tests.stopped'), 'success');
        this.refreshQuiet();
    },
};

UI.registerActions('adstests', {
    reload: () => AdsTests.load(),
    openForm: () => AdsTests.openForm(),
    closeForm: () => AdsTests.closeForm(),
    typeChanged: (el) => AdsTests.typeChanged(el),
    armToggled: (el) => AdsTests.armToggled(el),
    formChanged: (el) => AdsTests.formChanged(el),
    reloadCandidates: () => AdsTests.loadCandidates(),
    submit: (el, e) => AdsTests.submit(el, e),
    businessChosen: (el) => AdsTests.businessChosen(el),
    businessSubmit: (el, e) => AdsTests.businessSubmit(el, e),
    start: (el) => AdsTests.start(el.dataset.id),
    stop: (el) => AdsTests.stop(el.dataset.id),
});

/** The routed page (#/ads_tests): the Ads tab bar and header around `AdsTests`, like the other Ads tabs. */
const AdsTestsPage = {
    resetTenantState() {
        AdsTests.resetTenantState();
    },

    destroy() {
        AdsTests.destroy();
    },

    async render() {
        if (typeof App !== 'undefined' && typeof App.loadPageCss === 'function' && typeof App.entryOf === 'function') {
            await App.loadPageCss('ads', App.entryOf('ads'));
        }
        if (typeof AdsTabs === 'undefined' && typeof App !== 'undefined' && typeof App.loadPageModule === 'function') {
            try { await App.loadPageModule('ads_campaigns'); } catch { /* the page still works without its tab bar */ }
        }
        const container = document.getElementById('page-container');
        if (!container) return false;
        container.innerHTML = html`
            <div id="ads-tests-page" class="ads-page">
                ${typeof AdsTabs === 'undefined' ? '' : AdsTabs.markup('tests')}
                ${UI.pageHeader({ title: t('ads.tests.title'), subtitle: t('ads.tests.subtitle') })}
                <div id="ads-tests-host"></div>
            </div>
        `;
        return AdsTests.mount(document.getElementById('ads-tests-host'));
    },
};
