/**
 * Ads → Leads — `#/ads_leads` (Meta Ads Manager A10, spec Story 8).
 *
 * Instant forms on the tenant's Facebook Page, and the people who filled them in:
 *   - LOCKED until the platform admin records a legal sign-off for lead ads (Egypt's and Saudi Arabia's data-protection laws). Locked, the
 *     page is one calm panel saying what lead ads are, why they are locked, what a sign-off means and that nothing is collected; no
 *     builder, no table;
 *   - unlocked: the sign-off's countries, the forms (status, leads, last lead) and "New form" (Arabic or English; name, email, phone, city;
 *     up to 5 questions of your own; the optional consent question; the thank-you screen). Only the allowed question types are offered, a
 *     label that asks for restricted information is warned about here and refused by the server;
 *   - the leads table is the OWNER's (a viewer sees the forms only): date, form, answers, whether the person agreed to be contacted, and
 *     until when the answers are kept. A purged lead shows that its answers were deleted. "Download CSV" is a plain link with the filters:
 *     the server records the export in the audit log.
 * AutoReply never contacts a lead by itself, and the page says so.
 *
 * Lead answers are other people's words: everything the server sent is escaped by `html`, and nothing here is stored in the browser.
 * `AdsTabs` lives in ads_campaigns.js; the styles in css/pages/ads.css.
 */
const AdsLeadsPage = {
    /** 'loading' | 'ready' | 'forbidden' | 'disabled' | 'failed' */
    view: 'loading',
    /** GET /api/ads/lead-forms. */
    data: null,
    /** GET /api/ads/leads (owner only); null until read or when not the owner. */
    leads: null,
    leadsError: null,
    filters: { formId: '', from: '', to: '' },
    _seq: 0,
    _dialogKey: null,

    STANDARD: Object.freeze(['FULL_NAME', 'EMAIL', 'PHONE', 'CITY']),
    MAX_CUSTOM: 5,
    /** Words that ask for what Meta restricts in lead forms; the server has the full list and the last word. */
    RESTRICTED_HINTS: Object.freeze([
        'health', 'medical', 'disease', 'religio', 'sexual', 'criminal', 'politic', 'ethnic', 'bank', 'card number', 'account number', 'iban',
        'salary', 'income', 'password', 'national id', 'passport',
        'الصحة', 'صحية', 'مرض', 'طبية', 'ديان', 'الدين', 'مذهب', 'التوجه الجنسي', 'جنائي', 'سوابق', 'سياسي', 'حزب', 'عرق', 'قبيلة',
        'حساب بنكي', 'رقم الحساب', 'رقم البطاقة', 'بنك', 'راتب', 'كلمة المرور', 'كلمة السر', 'رقم الهوية', 'الرقم القومي', 'جواز السفر',
    ]),

    resetTenantState() {
        this.destroy();
        this.view = 'loading';
        this.data = null;
        this.leads = null;
        this.leadsError = null;
        this.filters = { formId: '', from: '', to: '' };
    },

    destroy() {
        this._seq++;
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

    async load() {
        const container = this.host();
        if (!container) return false;
        const seq = ++this._seq;
        const gate = Motion.beginLoad(container, () => html`${Motion.tableCard(3, ['', '', ''])}${Motion.busy()}`);
        let answer;
        try {
            answer = await API.getAdsLeadForms();
        } catch (err) {
            gate.done();
            if (seq !== this._seq) return false;
            if (err && (err.status === 403 || err.status === 404)) {
                this.view = err.status === 404 ? 'disabled' : 'forbidden';
                this.paint();
            } else {
                this.view = 'failed';
                UI.renderError(container, { title: t('ads.leads.loadFailed'), message: (err && err.message) || t('error.unexpected'), hint: t('admin.loadFailedHint') }, () => this.load());
            }
            return false;
        }
        this.data = answer || {};
        if (!this.locked() && this.isOwner()) await this.readLeads(seq);
        gate.done();
        if (seq !== this._seq) return false;
        this.view = 'ready';
        this.paint();
        Motion.announce(t('ads.leads.loaded'));
        return true;
    },

    async readLeads(seq) {
        try {
            const answer = await API.getAdsLeads(this.query());
            if (seq !== this._seq) return;
            this.leads = answer && Array.isArray(answer.leads) ? answer.leads : [];
            this.leadsError = null;
        } catch (err) {
            if (seq !== this._seq) return;
            this.leads = null;
            this.leadsError = (err && err.message) || t('error.unexpected');
        }
    },

    locked() {
        return !this.data || this.data.locked !== false;
    },

    forms() {
        return this.data && Array.isArray(this.data.forms) ? this.data.forms.filter((f) => f && f.id) : [];
    },

    retentionDays() {
        const n = this.data && Number(this.data.retentionDays);
        return Number.isFinite(n) && n > 0 ? n : 90;
    },

    /** The filters as the server reads them; empty ones left out. */
    query() {
        const q = {};
        if (this.filters.formId) q.formId = this.filters.formId;
        if (this.filters.from) q.from = this.filters.from;
        if (this.filters.to) q.to = this.filters.to;
        return q;
    },

    csvHref() {
        const params = new URLSearchParams(this.query()).toString();
        return `/api/ads/leads.csv${params ? `?${params}` : ''}`;
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

    countryName(code) {
        const key = `ads.aud.country.${code}`;
        const name = t(key);
        return name === key ? code : name;
    },

    num(v) {
        return `⁦${UI.formatNumber(Number(v) || 0)}⁩`;
    },

    refusalText(err) {
        const code = err && (err.code || (err.body && err.body.code));
        const known = ['LOCKED_LEGAL', 'RESTRICTED_QUESTION', 'NOT_CONNECTED', 'META_ERROR', 'ADS_DISABLED'];
        if (code === 'META_ERROR' && err && err.message) return t('ads.leads.err.META_ERROR_with', { message: err.message });
        if (code && known.includes(code)) return t(`ads.leads.err.${code}`);
        return (err && err.message) || t('error.unexpected');
    },

    restrictedHint(label) {
        const text = String(label || '').toLowerCase();
        return this.RESTRICTED_HINTS.some((w) => text.includes(w));
    },

    // ─── Markup ──────────────────────────────────────────────────────────────

    markup() {
        const tabs = typeof AdsTabs === 'undefined' || this.view === 'forbidden' || this.view === 'disabled' ? '' : AdsTabs.markup('leads');
        const locked = this.locked();
        const add = this.view === 'ready' && !locked && this.isOwner()
            ? UI.button({ variant: 'primary', size: 'sm', icon: 'plus', label: t('ads.leads.new'), action: 'adsleads:new', focusKey: 'adsleads-new' })
            : '';
        const header = UI.pageHeader({ title: t('ads.leads.title'), subtitle: t('page.ads_leads.subtitle'), actions: add });
        if (this.view === 'forbidden') return html`<div id="adsleads-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.owner.title'), body: t('ads.owner.body') })}</div>`;
        if (this.view === 'disabled') return html`<div id="adsleads-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.disabled.title'), body: t('ads.disabled.body') })}</div>`;
        return html`
            <div id="adsleads-page" class="ads-page adsleads-page" data-locked="${locked ? 'true' : 'false'}">
                ${tabs}
                ${header}
                <p class="ads-help" id="adsleads-help">
                    ${UI.helpLink('ads#lead-ads', t('ads.leads.help.leadAds'))}
                    · ${UI.helpLink('ads#leads-and-privacy', t('ads.leads.help.privacy'))}
                </p>
                ${locked ? this.lockedMarkup() : html`${this.coveredMarkup()}${this.formsMarkup()}${this.leadsMarkup()}`}
            </div>
        `;
    },

    lockedMarkup() {
        return html`
            <section class="card adsaud-lists adsaud-locked adsleads-locked" id="adsleads-locked" data-locked="true">
                <header class="adsaud-head">
                    <h2 class="section-title"><i data-lucide="lock" aria-hidden="true"></i> ${t('ads.leads.locked.title')}</h2>
                    <span class="badge badge-neutral">${t('ads.leads.locked.badge')}</span>
                </header>
                <p>${t('ads.leads.locked.what')}</p>
                <p>${t('ads.leads.locked.why')}</p>
                <p>${t('ads.leads.locked.signoff')}</p>
                <p class="form-hint">${t('ads.leads.locked.nothing')}</p>
                <p class="form-hint">${UI.helpLink('ads#leads-and-privacy', t('ads.leads.help.privacy'))}</p>
            </section>
        `;
    },

    coveredMarkup() {
        const s = (this.data && this.data.signoff) || { countries: [] };
        const countries = Array.isArray(s.countries) ? s.countries : [];
        return html`
            <div class="card adsleads-covered" id="adsleads-covered" role="status">
                <span class="badge badge-success">${t('ads.leads.covered', { countries: countries.map((c) => this.countryName(c)).join('، ') })}</span>
                <p class="form-hint">${t('ads.leads.retention', { days: this.num(this.retentionDays()) })}</p>
                <p class="form-hint">${t('ads.leads.noContact')}</p>
                <p class="form-hint">${t('ads.leads.makeAd')} <a href="#/ads_create">${t('ads.tabs.create')}</a></p>
            </div>
        `;
    },

    statusBadge(f) {
        const tone = { pending: 'info', active: 'success', archived: 'neutral', failed: 'danger' }[f.status] || 'neutral';
        return html`<span class="badge badge-${tone}" id="adsleads-status-${f.id}">${t(`ads.leads.status.${f.status}`)}</span>`;
    },

    formsMarkup() {
        const forms = this.forms();
        if (!forms.length) {
            return UI.emptyState({ icon: 'clipboard-list', title: t('ads.leads.forms.empty.title'), body: t('ads.leads.forms.empty.body') });
        }
        return html`
            <section class="adsaud-list adsleads-forms" id="adsleads-forms" aria-label="${t('ads.leads.forms.title')}">
                ${forms.map((f) => html`
                    <article class="card adsaud-card" id="adsleads-form-${f.id}" data-status="${f.status}">
                        <header class="adsaud-head">
                            <h3 class="adsaud-name" dir="auto">${f.name}</h3>
                            ${this.statusBadge(f)}
                            <span class="adsaud-kind">${t(f.origin === 'meta' ? 'ads.leads.origin.meta' : 'ads.leads.origin.app')}</span>
                        </header>
                        <p class="adsaud-size">${t('ads.leads.forms.count', { n: this.num(f.leadCount) })}</p>
                        <p class="form-hint">${f.lastLeadAt ? t('ads.leads.forms.last', { when: UI.formatDateTime(f.lastLeadAt) }) : t('ads.leads.forms.none')}</p>
                        ${f.status === 'failed' && f.error ? html`<p class="form-error" dir="auto" id="adsleads-error-${f.id}">${f.error}</p>` : ''}
                        ${f.status === 'pending' ? html`<p class="form-hint" role="status">${t('ads.leads.forms.pending')}</p>` : ''}
                    </article>
                `)}
            </section>
        `;
    },

    leadsMarkup() {
        if (!this.isOwner()) {
            return html`<section class="card" id="adsleads-leads" data-owner="false"><h2 class="section-title">${t('ads.leads.table.title')}</h2><p class="form-hint">${t('ads.leads.ownerOnly')}</p></section>`;
        }
        const forms = this.forms();
        const leads = Array.isArray(this.leads) ? this.leads : [];
        const days = this.retentionDays();
        const cell = (l) => {
            if (l.purged || !Array.isArray(l.answers)) return html`<span class="form-hint">${t('ads.leads.purged', { days: this.num(days) })}</span>`;
            return html`<dl class="adsleads-answers">${l.answers.map((a) => html`<div><dt dir="auto">${a.name}</dt><dd dir="auto">${(Array.isArray(a.values) ? a.values : []).join('، ')}</dd></div>`)}</dl>`;
        };
        return html`
            <section class="card" id="adsleads-leads" data-owner="true" aria-labelledby="adsleads-leads-title">
                <h2 class="section-title" id="adsleads-leads-title"><i data-lucide="inbox" aria-hidden="true"></i> ${t('ads.leads.table.title')}</h2>
                <div class="adsleads-filters">
                    <div class="form-group">
                        <label class="form-label" for="adsleads-filter-form">${t('ads.leads.filter.form')}</label>
                        <select class="form-input" id="adsleads-filter-form" data-change="adsleads:filter">
                            <option value="">${t('ads.leads.filter.allForms')}</option>
                            ${forms.map((f) => html`<option value="${f.id}" ${this.filters.formId === f.id ? html.raw('selected') : ''}>${f.name}</option>`)}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="adsleads-filter-from">${t('ads.leads.filter.from')}</label>
                        <input class="form-input" type="date" id="adsleads-filter-from" value="${this.filters.from}" data-change="adsleads:filter">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="adsleads-filter-to">${t('ads.leads.filter.to')}</label>
                        <input class="form-input" type="date" id="adsleads-filter-to" value="${this.filters.to}" data-change="adsleads:filter">
                    </div>
                </div>
                <p class="adsleads-csv">
                    <a class="btn btn-sm btn-secondary" id="adsleads-csv" href="${this.csvHref()}" download>
                        <i data-lucide="download" aria-hidden="true"></i> ${t('ads.leads.csv')}
                    </a>
                    <span class="form-hint">${t('ads.leads.csvAudited')}</span>
                </p>
                ${this.leadsError ? html`<p class="form-error" id="adsleads-leads-error">${this.leadsError}</p>` : ''}
                ${leads.length ? html`
                    <div class="table-wrap">
                        <table class="table" id="adsleads-table">
                            <thead><tr>
                                <th scope="col">${t('ads.leads.col.date')}</th>
                                <th scope="col">${t('ads.leads.col.form')}</th>
                                <th scope="col">${t('ads.leads.col.answers')}</th>
                                <th scope="col">${t('ads.leads.col.consent')}</th>
                                <th scope="col">${t('ads.leads.col.keptUntil')}</th>
                            </tr></thead>
                            <tbody>
                                ${leads.map((l) => html`
                                    <tr id="adsleads-lead-${l.id}" data-purged="${l.purged ? 'true' : 'false'}">
                                        <td>${UI.formatDateTime(l.createdTime)}</td>
                                        <td dir="auto">${l.formName || '—'}</td>
                                        <td>${cell(l)}</td>
                                        <td>${l.consentContact ? html`<span class="badge badge-success">${t('ads.leads.consent.yes')}</span>` : html`<span class="badge badge-neutral">${t('ads.leads.consent.no')}</span>`}</td>
                                        <td>${l.purged ? '—' : UI.formatDay(l.retainUntil)}</td>
                                    </tr>
                                `)}
                            </tbody>
                        </table>
                    </div>
                ` : (this.leadsError ? '' : html`<p class="form-hint" id="adsleads-empty">${t('ads.leads.table.empty')}</p>`)}
            </section>
        `;
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    async filter() {
        const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
        this.filters = { formId: val('adsleads-filter-form'), from: val('adsleads-filter-from'), to: val('adsleads-filter-to') };
        const seq = ++this._seq;
        await this.readLeads(seq);
        if (seq !== this._seq) return;
        this.paint();
    },

    customRow(i) {
        return html`
            <div class="form-group adsleads-custom" id="adsleads-custom-${i}">
                <label class="form-label" for="adsleads-custom-label-${i}">${t('ads.leads.form.customLabel', { n: `⁦${i + 1}⁩` })}</label>
                <input class="form-input" id="adsleads-custom-label-${i}" maxlength="80" dir="auto" autocomplete="off" data-input="adsleads:checkLabel" data-index="${i}">
                <p class="form-error" id="adsleads-custom-warn-${i}" hidden>${t('ads.leads.form.restricted')}</p>
            </div>
        `;
    },

    /** "New form". One idempotency key per opening of the dialog: a double submit is one form. */
    openNew() {
        if (this.locked() || !this.isOwner()) return;
        this._dialogKey = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">${t('ads.leads.new')}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}"><i data-lucide="x" aria-hidden="true"></i></button>
            </div>
            <form id="adsleads-form" novalidate>
                <div class="form-group">
                    <label class="form-label" for="adsleads-name">${t('ads.leads.form.name')}</label>
                    <input class="form-input" id="adsleads-name" maxlength="100" dir="auto" autocomplete="off">
                </div>
                <div class="form-group">
                    <label class="form-label" for="adsleads-locale">${t('ads.leads.form.locale')}</label>
                    <select class="form-input" id="adsleads-locale">
                        <option value="AR_AR">${t('ads.leads.form.locale.ar')}</option>
                        <option value="EN_US">${t('ads.leads.form.locale.en')}</option>
                    </select>
                </div>
                <fieldset class="form-group fieldset-plain">
                    <legend class="form-label">${t('ads.leads.form.standard')}</legend>
                    ${this.STANDARD.map((q) => html`
                        <div class="check-row"><input type="checkbox" id="adsleads-q-${q}" name="adsleads-q" value="${q}" ${q === 'FULL_NAME' || q === 'PHONE' ? html.raw('checked') : ''}><div class="check-text"><label class="check-label" for="adsleads-q-${q}">${t(`ads.leads.q.${q}`)}</label></div></div>
                    `)}
                </fieldset>
                <fieldset class="form-group fieldset-plain">
                    <legend class="form-label">${t('ads.leads.form.custom')}</legend>
                    <p class="form-hint">${t('ads.leads.form.customHint')}</p>
                    ${Array.from({ length: this.MAX_CUSTOM }, (_, i) => this.customRow(i))}
                </fieldset>
                <div class="check-row check-row-tap">
                    <input type="checkbox" id="adsleads-consent">
                    <div class="check-text">
                        <label class="check-label" for="adsleads-consent">${t('ads.leads.form.consent')}</label>
                        <p class="form-hint">${t('ads.leads.form.consentHint')}</p>
                    </div>
                </div>
                <fieldset class="form-group fieldset-plain">
                    <legend class="form-label">${t('ads.leads.form.thankYou')}</legend>
                    <label class="form-label" for="adsleads-ty-title">${t('ads.leads.form.tyTitle')}</label>
                    <input class="form-input" id="adsleads-ty-title" maxlength="60" dir="auto">
                    <label class="form-label" for="adsleads-ty-body">${t('ads.leads.form.tyBody')}</label>
                    <input class="form-input" id="adsleads-ty-body" maxlength="160" dir="auto">
                    <label class="form-label" for="adsleads-ty-button">${t('ads.leads.form.tyButton')}</label>
                    <input class="form-input" id="adsleads-ty-button" maxlength="30" dir="auto">
                    <label class="form-label" for="adsleads-ty-url">${t('ads.leads.form.tyUrl')}</label>
                    <input class="form-input" id="adsleads-ty-url" type="url" dir="ltr" placeholder="https://">
                </fieldset>
                <p class="form-hint">${t('ads.leads.form.privacy')}</p>
                <div id="adsleads-form-error"></div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    ${UI.button({ variant: 'primary', icon: 'check', label: t('ads.leads.form.create'), action: 'adsleads:create', focusKey: 'adsleads-create' })}
                </div>
            </form>
        `);
    },

    checkLabel(el) {
        if (!el) return;
        const warn = document.getElementById(`adsleads-custom-warn-${el.dataset.index}`);
        if (warn) warn.hidden = !this.restrictedHint(el.value);
    },

    /** The dialog's values as the server's FormInput. */
    readForm() {
        const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
        const standard = this.STANDARD.filter((q) => { const el = document.getElementById(`adsleads-q-${q}`); return el && el.checked; });
        const custom = [];
        for (let i = 0; i < this.MAX_CUSTOM; i++) {
            const label = val(`adsleads-custom-label-${i}`);
            if (label) custom.push({ type: 'CUSTOM', label });
        }
        const consent = document.getElementById('adsleads-consent');
        return {
            name: val('adsleads-name'),
            locale: val('adsleads-locale') || 'AR_AR',
            questions: [...standard.map((type) => ({ type })), ...custom],
            consentQuestion: Boolean(consent && consent.checked),
            thankYou: { title: val('adsleads-ty-title'), body: val('adsleads-ty-body'), buttonText: val('adsleads-ty-button'), url: val('adsleads-ty-url') },
            idempotencyKey: this._dialogKey,
        };
    },

    async create() {
        const input = this.readForm();
        const error = document.getElementById('adsleads-form-error');
        if (error) error.innerHTML = '';
        if (input.questions.some((q) => q.type === 'CUSTOM' && this.restrictedHint(q.label))) {
            if (error) error.innerHTML = esc(html`<p class="form-error">${t('ads.leads.form.restricted')}</p>`);
            return;
        }
        try {
            const answer = await API.createAdsLeadForm(input);
            UI.closeModal();
            UI.toast(t('ads.leads.created'), 'success');
            if (answer && answer.form && this.data) this.data.forms = [answer.form, ...this.forms().filter((f) => f.id !== answer.form.id)];
            this.paint();
        } catch (err) {
            if (error) error.innerHTML = esc(html`<p class="form-error" dir="auto">${this.refusalText(err)}</p>`);
        }
    },
};

UI.registerActions('adsleads', {
    new: () => AdsLeadsPage.openNew(),
    create: () => AdsLeadsPage.create(),
    filter: () => AdsLeadsPage.filter(),
    checkLabel: (el) => AdsLeadsPage.checkLabel(el),
});
