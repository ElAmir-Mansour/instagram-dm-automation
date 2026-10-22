/**
 * Ads → Audiences — `#/ads_audiences` (Meta Ads Manager A8, spec Story 6).
 *
 * Saved audiences the builder can include or exclude:
 *   - people who engaged with the Instagram account or the Facebook Page, who messaged, or who watched chosen videos, each over a window
 *     of days; and lookalikes of one of those, per country and size;
 *   - each card shows Meta's status and approximate size. "Being created" until Meta has built it (the page asks again every 10 s while
 *     one is); "too small" and "flagged" say why and what to do;
 *   - customer lists (emails or phones) are ALWAYS visible but LOCKED until the platform admin records a legal sign-off for the tenant's
 *     countries. Unlocked, the owner pastes or picks a file (≤ 3 MB, read here with FileReader), ticks that the people consented, and the
 *     server scrambles (hashes) every value before anything reaches Meta. The text is never stored here: not in localStorage, not in the
 *     address; the box is emptied after a successful upload.
 *
 * `AdsAudiencePicker.mount(el, { mode, value, onChange })` is the include/exclude picker the builder (A5) mounts.
 *
 * Everything the server wrote is escaped by `html`. `AdsTabs` lives in ads_campaigns.js; the styles in css/pages/ads.css.
 */
const AdsAudiencesPage = {
    /** 'loading' | 'ready' | 'forbidden' | 'disabled' | 'failed' */
    view: 'loading',
    /** The server's GET /api/ads/audiences answer. */
    data: null,
    /** GET /api/ads/audiences/sources, read when a form needs it. */
    sources: null,
    _seq: 0,
    _timer: null,

    POLL_MS: 10000,
    MAX_BYTES: 3 * 1024 * 1024,
    KINDS: Object.freeze(['ig_engagement', 'page_engagement', 'messagers', 'video_viewers', 'lookalike']),
    IG_EVENTS: Object.freeze(['engaged', 'all', 'visited', 'messaged']),
    PAGE_EVENTS: Object.freeze(['engaged', 'visited', 'cta', 'saved', 'messaged']),
    WATCHED: Object.freeze(['3s', 'thruplay', '25', '50', '75', '95']),
    /** Egypt and Saudi Arabia first, then the other Arab countries. */
    COUNTRIES: Object.freeze(['EG', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'JO', 'LB', 'IQ', 'MA', 'DZ', 'TN', 'LY', 'SD', 'PS', 'YE', 'SY']),
    COLUMNS: Object.freeze(['EMAIL', 'PHONE', 'FN', 'LN', 'COUNTRY']),

    resetTenantState() {
        this.destroy();
        this.view = 'loading';
        this.data = null;
        this.sources = null;
    },

    destroy() {
        this._seq++;
        this.stopPoll();
    },

    isOwner() {
        return typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
    },

    host() {
        return document.getElementById('page-container');
    },

    // ─── Reading ─────────────────────────────────────────────────────────────

    async render() {
        if (typeof App !== 'undefined' && typeof App.loadPageCss === 'function' && typeof App.entryOf === 'function') {
            await App.loadPageCss('ads', App.entryOf('ads'));
        }
        if (typeof AdsTabs === 'undefined' && typeof App !== 'undefined' && typeof App.loadPageModule === 'function') {
            try { await App.loadPageModule('ads_campaigns'); } catch { /* the page still works without its tab bar */ }
        }
        return this.load();
    },

    async load(quiet) {
        const container = this.host();
        if (!container) return false;
        const seq = ++this._seq;
        const gate = quiet ? { done() {} } : Motion.beginLoad(container, () => html`${Motion.tableCard(3, ['', '', ''])}${Motion.busy()}`);
        let answer;
        try {
            answer = await API.getAdsAudiences();
        } catch (err) {
            gate.done();
            if (seq !== this._seq) return false;
            if (err && (err.status === 403 || err.status === 404)) {
                this.view = err.status === 404 ? 'disabled' : 'forbidden';
                this.paint();
            } else if (!quiet) {
                this.view = 'failed';
                UI.renderError(container, { title: t('ads.aud.loadFailed'), message: (err && err.message) || t('error.unexpected'), hint: t('admin.loadFailedHint') }, () => this.load());
            }
            return false;
        }
        gate.done();
        if (seq !== this._seq) return false;
        this.data = answer || {};
        this.view = 'ready';
        this.paint();
        this.schedulePoll();
        if (!quiet) Motion.announce(t('ads.aud.loaded'));
        return true;
    },

    audiences() {
        return this.data && Array.isArray(this.data.audiences) ? this.data.audiences.filter((a) => a && a.id) : [];
    },

    /** Still being built at Meta, or a queued op on it: worth asking again. */
    pending(a) {
        return a.status === 'creating' || (a.op && ['pending', 'running', 'verify'].includes(a.op.state));
    },

    schedulePoll() {
        this.stopPoll();
        if (!this.audiences().some((a) => this.pending(a))) return;
        const seq = this._seq;
        this._timer = setTimeout(() => { if (seq === this._seq) this.load(true); }, this.POLL_MS);
    },

    stopPoll() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
    },

    paint() {
        const container = this.host();
        if (!container) return;
        const focus = UI.captureFocus ? UI.captureFocus(container) : null;
        container.innerHTML = esc(this.markup());
        UI.icons(container);
        if (focus && UI.restoreFocus) UI.restoreFocus(focus);
    },

    // ─── Words ───────────────────────────────────────────────────────────────

    isolate(value) {
        return `⁨${String(value === null || value === undefined ? '' : value)}⁩`;
    },

    sizeText(a) {
        const lo = Number(a.sizeLower);
        const hi = Number(a.sizeUpper);
        if (a.sizeLower === null || a.sizeLower === undefined || !Number.isFinite(lo)) return t('ads.aud.size.unknown');
        if (!Number.isFinite(hi) || a.sizeUpper === null) return t('ads.aud.size.atLeast', { n: `⁦${UI.formatNumber(lo)}⁩` });
        return t('ads.aud.size.range', { low: `⁦${UI.formatNumber(lo)}⁩`, high: `⁦${UI.formatNumber(hi)}⁩` });
    },

    countryName(code) {
        const key = `ads.aud.country.${code}`;
        const name = t(key);
        return name === key ? code : name;
    },

    /** A refusal in the reader's words. */
    refusalText(err) {
        const code = err && (err.code || (err.body && err.body.code));
        const reason = err && (err.reason || (err.body && err.body.reason));
        if (reason === 'sensitive_name') return t('ads.aud.err.sensitive_name');
        if (reason === 'no_instagram' || reason === 'no_page' || reason === 'no_rows' || reason === 'country_not_covered' || reason === 'too_large') return t(`ads.aud.err.${reason}`);
        const known = ['LOCKED_LEGAL', 'ADS_NOT_CONFIGURED', 'TERMS_NOT_ACCEPTED', 'SEED_TOO_SMALL', 'AUDIENCE_NOT_USABLE', 'NOT_FOUND', 'ADS_DISABLED', 'META_ERROR', 'RATE_LIMITED'];
        if (code && known.includes(code)) return t(`ads.aud.err.${code}`);
        return (err && err.message) || t('error.unexpected');
    },

    // ─── Markup ──────────────────────────────────────────────────────────────

    markup() {
        const tabs = typeof AdsTabs === 'undefined' || this.view === 'forbidden' || this.view === 'disabled' ? '' : AdsTabs.markup('audiences');
        const add = this.view === 'ready' && this.isOwner()
            ? UI.button({ variant: 'primary', size: 'sm', icon: 'plus', label: t('ads.aud.new'), action: 'adsaud:new', focusKey: 'adsaud-new' })
            : '';
        const header = UI.pageHeader({ title: t('ads.aud.title'), subtitle: t('ads.aud.subtitle'), actions: add });
        if (this.view === 'forbidden') return html`<div id="adsaud-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.owner.title'), body: t('ads.owner.body') })}</div>`;
        if (this.view === 'disabled') return html`<div id="adsaud-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.disabled.title'), body: t('ads.disabled.body') })}</div>`;
        const list = this.audiences();
        return html`
            <div id="adsaud-page" class="ads-page adsaud-page">
                ${tabs}
                ${header}
                <p class="ads-help" id="adsaud-help">
                    ${UI.helpLink('ads#audiences', t('ads.aud.help.audiences'))}
                    · ${UI.helpLink('ads#lookalikes', t('ads.aud.help.lookalikes'))}
                    · ${UI.helpLink('ads#customer-lists', t('ads.aud.help.lists'))}
                </p>
                ${this.termsMarkup()}
                ${list.length ? html`<div class="adsaud-list" id="adsaud-list">${list.map((a) => this.cardMarkup(a))}</div>`
                    : UI.emptyState({ icon: 'users', title: t('ads.aud.empty.title'), body: t('ads.aud.empty.body') })}
                ${this.customerListMarkup()}
                ${this.optOutMarkup()}
            </div>
        `;
    },

    /** "Do-not-target requests": a person who asked never to be in an uploaded list. Stored scrambled; removed from lists already at Meta. */
    optOutMarkup() {
        if (!this.isOwner()) return '';
        return html`
            <section class="card adsaud-lists" id="adsaud-optout" aria-labelledby="adsaud-optout-title">
                <h2 class="section-title" id="adsaud-optout-title"><i data-lucide="user-x" aria-hidden="true"></i> ${t('ads.aud.optout.title')}</h2>
                <p class="form-hint">${t('ads.aud.optout.body')}</p>
                <div class="form-group">
                    <label class="form-label" for="adsaud-optout-contact">${t('ads.aud.optout.label')}</label>
                    <input class="form-input" id="adsaud-optout-contact" dir="ltr" autocomplete="off" maxlength="200" placeholder="+20… / name@example.com">
                </div>
                <div id="adsaud-optout-msg"></div>
                <div class="adsaud-actions">
                    ${UI.button({ variant: 'secondary', icon: 'check', label: t('ads.aud.optout.save'), action: 'adsaud:optOut', focusKey: 'adsaud-optout-save' })}
                </div>
            </section>
        `;
    },

    async optOut() {
        const box = document.getElementById('adsaud-optout-contact');
        const msg = document.getElementById('adsaud-optout-msg');
        const contact = box ? String(box.value || '').trim() : '';
        if (!contact) return;
        try {
            await API.recordAdsAudienceOptOut(contact);
            if (box) box.value = '';
            if (msg) msg.innerHTML = esc(html`<p class="form-hint text-success">${t('ads.aud.optout.saved')}</p>`);
        } catch (err) {
            if (msg) msg.innerHTML = esc(html`<p class="form-error">${err && err.body && err.body.field === 'contact' ? t('ads.aud.optout.invalid') : this.refusalText(err)}</p>`);
        }
    },

    termsMarkup() {
        const d = this.data || {};
        if (!d.tosAccepted || d.tosAccepted.custom !== false || !d.tosUrl) return '';
        return html`
            <div class="card adsaud-terms" id="adsaud-terms" role="status">
                <i data-lucide="alert-triangle" class="text-warning" aria-hidden="true"></i>
                <div>
                    <strong>${t('ads.aud.terms.title')}</strong>
                    <p>${t('ads.aud.terms.body')}</p>
                    <a class="btn btn-sm btn-secondary" href="${d.tosUrl}" target="_blank" rel="noopener noreferrer" id="adsaud-terms-link">
                        <i data-lucide="external-link" aria-hidden="true"></i> ${t('ads.aud.terms.cta')}
                    </a>
                </div>
            </div>
        `;
    },

    statusBadge(a) {
        const tone = { creating: 'info', ready: 'success', too_small: 'warning', flagged: 'danger', deleted: 'neutral' }[a.status] || 'neutral';
        return html`<span class="badge badge-${tone}" id="adsaud-status-${a.id}">${t(`ads.aud.status.${a.status}`)}</span>`;
    },

    cardMarkup(a) {
        const id = String(a.id);
        const failed = a.op && a.op.state === 'failed' && a.op.kind === 'audience_create';
        const terms = failed && a.op.result && Number(a.op.result.code) === 200 && Number(a.op.result.subcode) === 1870090;
        return html`
            <article class="card adsaud-card" id="adsaud-${id}" data-status="${a.status}">
                <header class="adsaud-head">
                    <h3 class="adsaud-name" dir="auto">${a.name}</h3>
                    ${this.statusBadge(a)}
                    <span class="adsaud-kind">${t(`ads.aud.kind.${a.kind}`)}</span>
                </header>
                <p class="adsaud-size" id="adsaud-size-${id}">${this.sizeText(a)}</p>
                ${a.status === 'too_small' ? html`<p class="form-hint adsaud-why" id="adsaud-why-${id}">${t('ads.aud.why.too_small')}</p>` : ''}
                ${a.status === 'flagged' ? html`<p class="form-error adsaud-why" id="adsaud-why-${id}">${t('ads.aud.why.flagged')} ${UI.helpLink('ads#audiences', t('help.link.learnMore'))}</p>` : ''}
                ${this.pending(a) && !failed ? html`<p class="form-hint adsaud-wait" role="status"><span class="spinner" aria-hidden="true"></span> ${t('ads.aud.creatingAtMeta')}</p>` : ''}
                ${failed ? html`<p class="form-error" id="adsaud-failed-${id}">${terms ? t('ads.aud.err.TERMS_NOT_ACCEPTED') : t('ads.aud.failed')}</p>` : ''}
                ${a.kind === 'customer_list' && a.spec ? html`<p class="form-hint">${t('ads.aud.list.sent', { n: `⁦${UI.formatNumber(Number(a.spec.rows_sent) || 0)}⁩` })}</p>` : ''}
                ${this.isOwner() ? html`
                    <div class="adsaud-actions">
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('common.delete'), action: 'adsaud:remove', data: { id }, focusKey: `adsaud-remove-${id}` })}
                    </div>` : ''}
            </article>
        `;
    },

    customerListMarkup() {
        const lock = (this.data && this.data.customerList) || { locked: true, countries: [], needed: ['legal_signoff'] };
        const helpLink = UI.helpLink('ads#customer-lists', t('ads.aud.help.lists'));
        if (lock.locked) {
            return html`
                <section class="card adsaud-lists adsaud-locked" id="adsaud-lists" data-locked="true">
                    <header class="adsaud-head">
                        <h2 class="section-title"><i data-lucide="lock" aria-hidden="true"></i> ${t('ads.aud.list.title')}</h2>
                        <span class="badge badge-neutral">${t('ads.aud.list.lockedBadge')}</span>
                    </header>
                    <p>${t('ads.aud.list.locked.body')}</p>
                    <ul class="adsaud-needed" id="adsaud-needed">
                        ${(Array.isArray(lock.needed) && lock.needed.length ? lock.needed : ['legal_signoff']).map((k) => html`<li>${t(`ads.aud.list.needed.${k}`)}</li>`)}
                    </ul>
                    <p class="form-hint">${helpLink}</p>
                </section>
            `;
        }
        if (!this.isOwner()) {
            return html`<section class="card adsaud-lists" id="adsaud-lists" data-locked="false"><h2 class="section-title">${t('ads.aud.list.title')}</h2><p class="form-hint">${t('ads.aud.list.ownerOnly')}</p></section>`;
        }
        const countries = Array.isArray(lock.countries) ? lock.countries : [];
        return html`
            <section class="card adsaud-lists" id="adsaud-lists" data-locked="false">
                <header class="adsaud-head">
                    <h2 class="section-title"><i data-lucide="users" aria-hidden="true"></i> ${t('ads.aud.list.title')}</h2>
                    <span class="badge badge-success">${t('ads.aud.list.covered', { countries: countries.map((c) => this.countryName(c)).join('، ') })}</span>
                </header>
                <p class="form-hint">${t('ads.aud.list.privacy')} ${helpLink}</p>
                <div class="form-group">
                    <label class="form-label" for="adsaud-list-name">${t('ads.aud.form.name')}</label>
                    <input class="form-input" id="adsaud-list-name" maxlength="100" dir="auto" autocomplete="off">
                    <p class="form-hint">${t('ads.aud.form.nameHint')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="adsaud-list-country">${t('ads.aud.list.defaultCountry')}</label>
                    <select class="form-input" id="adsaud-list-country">
                        ${countries.map((c) => html`<option value="${c}">${this.countryName(c)}</option>`)}
                    </select>
                    <p class="form-hint">${t('ads.aud.list.defaultCountryHint')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="adsaud-list-columns">${t('ads.aud.list.columns')}</label>
                    <select class="form-input" id="adsaud-list-columns">
                        <option value="auto">${t('ads.aud.list.columns.auto')}</option>
                        <option value="EMAIL">${t('ads.aud.list.columns.EMAIL')}</option>
                        <option value="PHONE">${t('ads.aud.list.columns.PHONE')}</option>
                        <option value="EMAIL,PHONE">${t('ads.aud.list.columns.EMAIL_PHONE')}</option>
                        <option value="PHONE,FN,LN">${t('ads.aud.list.columns.PHONE_NAMES')}</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="adsaud-list-text">${t('ads.aud.list.paste')}</label>
                    <textarea class="form-input" id="adsaud-list-text" rows="6" dir="ltr" autocomplete="off" spellcheck="false"></textarea>
                    <label class="form-label" for="adsaud-list-file">${t('ads.aud.list.file')}</label>
                    <input class="form-input" type="file" id="adsaud-list-file" accept=".csv,.txt,text/csv,text/plain" data-change="adsaud:file">
                    <p class="form-hint">${t('ads.aud.list.fileHint')}</p>
                </div>
                <div class="check-row check-row-tap adsaud-consent">
                    <input type="checkbox" id="adsaud-list-consent" data-change="adsaud:consent">
                    <div class="check-text"><label class="check-label" for="adsaud-list-consent">${t('ads.aud.list.consent')}</label></div>
                </div>
                <div id="adsaud-list-error"></div>
                <div id="adsaud-list-result"></div>
                <div class="adsaud-actions">
                    ${UI.button({ variant: 'primary', icon: 'upload', label: t('ads.aud.list.upload'), action: 'adsaud:upload', focusKey: 'adsaud-upload', disabled: true, id: 'adsaud-upload' })}
                </div>
            </section>
        `;
    },

    // ─── Actions: create ─────────────────────────────────────────────────────

    async loadSources() {
        if (this.sources) return this.sources;
        try { this.sources = await API.getAdsAudienceSources(); } catch { this.sources = { instagram: null, page: null, videos: [] }; }
        return this.sources;
    },

    /** "New audience": pick the kind first. */
    async openNew() {
        const s = await this.loadSources();
        const usableSeeds = this.audiences().filter((a) => a.kind !== 'lookalike' && (a.usable || a.status === 'too_small') && a.metaId);
        const unavailable = {
            ig_engagement: !s.instagram ? 'ads.aud.form.noInstagram' : null,
            page_engagement: !s.page ? 'ads.aud.form.noPage' : null,
            messagers: !s.instagram && !s.page ? 'ads.aud.form.noSource' : null,
            video_viewers: !(Array.isArray(s.videos) && s.videos.length) ? 'ads.aud.form.noVideos' : null,
            lookalike: !usableSeeds.length ? 'ads.aud.form.noSeed' : null,
        };
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">${t('ads.aud.new')}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}"><i data-lucide="x" aria-hidden="true"></i></button>
            </div>
            <div class="adsaud-kinds" role="list">
                ${this.KINDS.map((k) => html`
                    <button type="button" class="card adsaud-kind-btn" role="listitem" data-action="adsaud:form" data-kind="${k}" id="adsaud-kind-${k}" ${unavailable[k] ? html.raw('disabled') : ''}>
                        <strong>${t(`ads.aud.kind.${k}`)}</strong>
                        <span class="form-hint">${unavailable[k] ? t(unavailable[k]) : t(`ads.aud.kind.${k}.hint`)}</span>
                    </button>
                `)}
            </div>
        `);
    },

    daysField(max, value) {
        return html`
            <div class="form-group">
                <label class="form-label" for="adsaud-days">${t('ads.aud.form.days')}</label>
                <input class="form-input" type="number" id="adsaud-days" min="1" max="${max}" step="1" value="${value}" inputmode="numeric">
                <p class="form-hint">${t('ads.aud.form.daysHint', { max: `⁦${max}⁩` })}</p>
            </div>
        `;
    },

    openForm(kind) {
        const s = this.sources || { instagram: null, page: null, videos: [] };
        const max = (this.data && this.data.retentionMaxDays && this.data.retentionMaxDays[kind]) || 365;
        let fields = '';
        if (kind === 'ig_engagement' || kind === 'page_engagement') {
            const events = kind === 'ig_engagement' ? this.IG_EVENTS : this.PAGE_EVENTS;
            fields = html`
                <div class="form-group">
                    <label class="form-label" for="adsaud-event">${t('ads.aud.form.event')}</label>
                    <select class="form-input" id="adsaud-event">${events.map((e) => html`<option value="${e}">${t(`ads.aud.event.${kind}.${e}`)}</option>`)}</select>
                </div>
                ${this.daysField(max, 30)}
            `;
        } else if (kind === 'messagers') {
            fields = html`
                <fieldset class="form-group fieldset-plain"><legend class="form-label">${t('ads.aud.form.sources')}</legend>
                    <div class="check-row"><input type="checkbox" id="adsaud-src-instagram" name="adsaud-source" value="instagram" ${s.instagram ? html.raw('checked') : html.raw('disabled')}><div class="check-text"><label class="check-label" for="adsaud-src-instagram">${t('ads.aud.source.instagram')}</label></div></div>
                    <div class="check-row"><input type="checkbox" id="adsaud-src-page" name="adsaud-source" value="page" ${s.page ? html.raw('checked') : html.raw('disabled')}><div class="check-text"><label class="check-label" for="adsaud-src-page">${t('ads.aud.source.page')}</label></div></div>
                </fieldset>
                ${this.daysField(max, 90)}
            `;
        } else if (kind === 'video_viewers') {
            const videos = Array.isArray(s.videos) ? s.videos : [];
            fields = html`
                <fieldset class="form-group fieldset-plain"><legend class="form-label">${t('ads.aud.form.videos')}</legend>
                    <div class="adsaud-videos">
                        ${videos.map((v, i) => html`
                            <label class="adsaud-video">
                                <input type="checkbox" name="adsaud-video" value="${v.id}" ${i < 5 ? html.raw('checked') : ''}>
                                ${v.thumbUrl ? html`<img src="${v.thumbUrl}" alt="" loading="lazy" width="48" height="48">` : html`<i data-lucide="film" aria-hidden="true"></i>`}
                                <span dir="auto">${v.caption || t('ads.aud.form.untitledVideo')}</span>
                                <span class="badge badge-neutral">${t(`ads.aud.source.${v.platform === 'instagram' ? 'instagram' : 'page'}`)}</span>
                            </label>
                        `)}
                    </div>
                </fieldset>
                <div class="form-group">
                    <label class="form-label" for="adsaud-watched">${t('ads.aud.form.watched')}</label>
                    <select class="form-input" id="adsaud-watched">${this.WATCHED.map((w) => html`<option value="${w}" ${w === '50' ? html.raw('selected') : ''}>${t(`ads.aud.watched.${w}`)}</option>`)}</select>
                </div>
                ${this.daysField(max, 30)}
            `;
        } else if (kind === 'lookalike') {
            const seeds = this.audiences().filter((a) => a.kind !== 'lookalike' && (a.usable || a.status === 'too_small') && a.metaId);
            fields = html`
                <div class="form-group">
                    <label class="form-label" for="adsaud-seed">${t('ads.aud.form.seed')}</label>
                    <select class="form-input" id="adsaud-seed">${seeds.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select>
                    <p class="form-hint">${t('ads.aud.form.seedHint')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="adsaud-country">${t('ads.aud.form.country')}</label>
                    <select class="form-input" id="adsaud-country">${this.COUNTRIES.map((c) => html`<option value="${c}">${this.countryName(c)}</option>`)}</select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="adsaud-ratio">${t('ads.aud.form.ratio')} <output id="adsaud-ratio-out" for="adsaud-ratio">1%</output></label>
                    <input class="form-input" type="range" id="adsaud-ratio" min="1" max="20" step="1" value="1" data-input="adsaud:ratio">
                    <p class="form-hint">${t('ads.aud.form.ratioHint')}</p>
                </div>
            `;
        }
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">${t(`ads.aud.kind.${kind}`)}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}"><i data-lucide="x" aria-hidden="true"></i></button>
            </div>
            <form id="adsaud-form" data-kind="${kind}" novalidate>
                <div class="form-group">
                    <label class="form-label" for="adsaud-name">${t('ads.aud.form.name')}</label>
                    <input class="form-input" id="adsaud-name" maxlength="100" dir="auto" autocomplete="off" placeholder="${t('ads.aud.form.namePlaceholder')}">
                    <p class="form-hint">${t('ads.aud.form.nameHint')}</p>
                    <p class="form-error" id="adsaud-name-error" hidden></p>
                </div>
                ${fields}
                <div id="adsaud-form-error"></div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    ${UI.button({ variant: 'primary', icon: 'check', label: t('ads.aud.form.create'), action: 'adsaud:create', focusKey: 'adsaud-create' })}
                </div>
            </form>
        `);
    },

    /** The form's values as the server's `{ kind, name, spec }`. */
    readForm() {
        const form = document.getElementById('adsaud-form');
        if (!form) return null;
        const kind = form.dataset.kind;
        const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
        const checked = (name) => Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((el) => el.value);
        const days = Number(val('adsaud-days'));
        let spec;
        if (kind === 'ig_engagement' || kind === 'page_engagement') spec = { event: val('adsaud-event'), retentionDays: days };
        else if (kind === 'messagers') spec = { sources: checked('adsaud-source'), retentionDays: days };
        else if (kind === 'video_viewers') spec = { videoIds: checked('adsaud-video'), watched: val('adsaud-watched'), retentionDays: days };
        else if (kind === 'lookalike') spec = { seedAudienceId: val('adsaud-seed'), country: val('adsaud-country'), ratio: Number(val('adsaud-ratio')) / 100 };
        return { kind, name: val('adsaud-name'), spec };
    },

    async create() {
        const input = this.readForm();
        if (!input) return;
        const error = document.getElementById('adsaud-form-error');
        const nameError = document.getElementById('adsaud-name-error');
        if (nameError) { nameError.hidden = true; nameError.textContent = ''; }
        try {
            const answer = await API.createAdsAudience(input);
            UI.closeModal();
            UI.toast(t('ads.aud.created'), 'success');
            if (answer && answer.audience && this.data) this.data.audiences = [answer.audience, ...this.audiences().filter((a) => a.id !== answer.audience.id)];
            this.paint();
            this.schedulePoll();
        } catch (err) {
            const field = err && (err.field || (err.body && err.body.field));
            if (field === 'name' && nameError) {
                nameError.textContent = this.refusalText(err);
                nameError.hidden = false;
                return;
            }
            if (error) error.innerHTML = esc(html`<p class="form-error" dir="auto">${this.refusalText(err)}</p>`);
        }
    },

    ratio(el) {
        const out = document.getElementById('adsaud-ratio-out');
        if (out && el) out.textContent = `${el.value}%`;
    },

    // ─── Actions: delete ─────────────────────────────────────────────────────

    remove(id) {
        const a = this.audiences().find((x) => String(x.id) === String(id));
        if (!a) return;
        UI.confirm({
            title: t('ads.aud.delete.title'),
            body: t('ads.aud.delete.body', { name: this.isolate(a.name) }),
            confirmLabel: t('common.delete'),
            confirmIcon: 'trash-2',
            tone: 'danger',
            onConfirm: () => AdsAudiencesPage.removeConfirmed(String(id)),
        });
    },

    async removeConfirmed(id) {
        try {
            await API.deleteAdsAudience(id);
            if (this.data) this.data.audiences = this.audiences().filter((a) => String(a.id) !== String(id));
            this.paint();
        } catch (err) {
            throw new Error(this.refusalText(err));
        }
    },

    // ─── Actions: customer list ──────────────────────────────────────────────

    consent() {
        const box = document.getElementById('adsaud-list-consent');
        const btn = document.getElementById('adsaud-upload');
        const locked = !this.data || !this.data.customerList || this.data.customerList.locked;
        if (btn) btn.disabled = locked || !(box && box.checked);
    },

    /** Read the chosen file into the textarea (never anywhere else). */
    file(input) {
        const f = input && input.files && input.files[0];
        const error = document.getElementById('adsaud-list-error');
        if (!f) return;
        if (f.size > this.MAX_BYTES) {
            if (error) error.innerHTML = esc(html`<p class="form-error">${t('ads.aud.err.too_large')}</p>`);
            input.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const box = document.getElementById('adsaud-list-text');
            if (box) box.value = String(reader.result || '');
            if (error) error.innerHTML = '';
        };
        reader.readAsText(f);
    },

    async upload() {
        const lock = this.data && this.data.customerList;
        const consent = document.getElementById('adsaud-list-consent');
        if (!lock || lock.locked || !consent || !consent.checked) return;
        const box = document.getElementById('adsaud-list-text');
        const text = box ? String(box.value || '') : '';
        const error = document.getElementById('adsaud-list-error');
        const result = document.getElementById('adsaud-list-result');
        if (error) error.innerHTML = '';
        if (!text.trim()) {
            if (error) error.innerHTML = esc(html`<p class="form-error">${t('ads.aud.list.empty')}</p>`);
            return;
        }
        if (typeof Blob !== 'undefined' && new Blob([text]).size > this.MAX_BYTES) {
            if (error) error.innerHTML = esc(html`<p class="form-error">${t('ads.aud.err.too_large')}</p>`);
            return;
        }
        const columnsEl = document.getElementById('adsaud-list-columns');
        const columns = columnsEl && columnsEl.value !== 'auto' ? columnsEl.value.split(',') : 'auto';
        const nameEl = document.getElementById('adsaud-list-name');
        const countryEl = document.getElementById('adsaud-list-country');
        try {
            const answer = await API.uploadAdsCustomerList({ name: nameEl ? nameEl.value.trim() : '', columns, defaultCountry: countryEl ? countryEl.value : undefined, text });
            // The list leaves this page: the box, the file input and the tick are cleared.
            if (box) box.value = '';
            const fileEl = document.getElementById('adsaud-list-file');
            if (fileEl) fileEl.value = '';
            consent.checked = false;
            this.consent();
            if (result) result.innerHTML = esc(this.countsMarkup(answer || {}));
            if (answer && answer.audience && this.data) this.data.audiences = [answer.audience, ...this.audiences()];
            const list = document.getElementById('adsaud-list');
            if (list || this.audiences().length === 1) this.paintListOnly();
            this.schedulePoll();
            UI.toast(t('ads.aud.list.uploaded'), 'success');
        } catch (err) {
            if (error) error.innerHTML = esc(html`<p class="form-error" dir="auto">${this.refusalText(err)}</p>${err && err.body && typeof err.body.rowsAccepted === 'number' ? this.countsMarkup(err.body) : ''}`);
        }
    },

    countsMarkup(c) {
        const n = (v) => `⁦${UI.formatNumber(Number(v) || 0)}⁩`;
        return html`
            <ul class="adsaud-counts" id="adsaud-counts">
                <li>${t('ads.aud.list.counts.accepted', { n: n(c.rowsAccepted) })}</li>
                <li>${t('ads.aud.list.counts.optOut', { n: n(c.rowsExcludedOptOut) })}</li>
                <li>${t('ads.aud.list.counts.invalid', { n: n(c.rowsInvalid) })}</li>
                <li>${t('ads.aud.list.counts.country', { n: n(c.rowsExcludedCountry) })}</li>
                <li>${t('ads.aud.list.counts.duplicate', { n: n(c.rowsDuplicate) })}</li>
            </ul>
        `;
    },

    /** Repaint the audience cards without touching the customer-list form (its counts stay on screen). */
    paintListOnly() {
        const page = document.getElementById('adsaud-page');
        const list = document.getElementById('adsaud-list');
        const markup = html`<div class="adsaud-list" id="adsaud-list">${this.audiences().map((a) => this.cardMarkup(a))}</div>`;
        if (list) { list.outerHTML = esc(markup); }
        else if (page) { this.paint(); return; }
        if (page) UI.icons(page);
    },
};

/**
 * The include/exclude picker the builder mounts (A5): checkboxes of the tenant's audiences; ones that cannot be used are shown disabled
 * with the reason. `onChange(ids)` gets our audience ids; the server turns them into Meta ids.
 */
const AdsAudiencePicker = {
    _cache: null,

    async list() {
        if (!this._cache) {
            this._cache = API.getAdsAudiences().then((a) => (a && Array.isArray(a.audiences) ? a.audiences : [])).catch(() => { this._cache = null; return []; });
        }
        return this._cache;
    },

    async mount(el, opts) {
        if (!el) return;
        const mode = opts && opts.mode === 'exclude' ? 'exclude' : 'include';
        const value = new Set((opts && Array.isArray(opts.value) ? opts.value : []).map(String));
        const all = await this.list();
        const ok = (a) => (mode === 'include' ? a.usable : !!a.metaId && a.status !== 'deleted');
        el.innerHTML = esc(html`
            <fieldset class="form-group fieldset-plain adsaud-picker" data-mode="${mode}">
                <legend class="form-label">${t(`ads.aud.picker.${mode}`)}</legend>
                ${all.length ? all.map((a) => html`
                    <div class="check-row">
                        <input type="checkbox" id="adsaud-pick-${mode}-${a.id}" value="${a.id}" ${value.has(String(a.id)) ? html.raw('checked') : ''} ${ok(a) ? '' : html.raw('disabled')}>
                        <div class="check-text">
                            <label class="check-label" for="adsaud-pick-${mode}-${a.id}" dir="auto">${a.name}</label>
                            <p class="form-hint">${ok(a) ? AdsAudiencesPage.sizeText(a) : t(`ads.aud.status.${a.status}`)}</p>
                        </div>
                    </div>
                `) : html`<p class="form-hint">${t('ads.aud.picker.none')} <a href="#/ads_audiences">${t('ads.tabs.audiences')}</a></p>`}
            </fieldset>
        `);
        el.querySelectorAll('input[type="checkbox"]').forEach((box) => {
            box.addEventListener('change', () => {
                const ids = Array.from(el.querySelectorAll('input[type="checkbox"]:checked')).map((b) => b.value);
                if (opts && typeof opts.onChange === 'function') opts.onChange(ids);
            });
        });
    },
};

UI.registerActions('adsaud', {
    new: () => AdsAudiencesPage.openNew(),
    form: (el) => AdsAudiencesPage.openForm(el.dataset.kind),
    create: () => AdsAudiencesPage.create(),
    remove: (el) => AdsAudiencesPage.remove(el.dataset.id),
    upload: () => AdsAudiencesPage.upload(),
    consent: () => AdsAudiencesPage.consent(),
    file: (el) => AdsAudiencesPage.file(el),
    ratio: (el) => AdsAudiencesPage.ratio(el),
    optOut: () => AdsAudiencesPage.optOut(),
});
