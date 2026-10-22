/**
 * Client ads — platform-admin only (A11, "managed clients"). One card per workspace: is ads switched on, the spending ceiling the
 * client's own limits may not pass, the account's health, how much of the monthly cap is used, the alerts of the last week, the
 * client's spend (only when THEY chose to share it) and the legal sign-offs.
 *
 * What the server sends is contract-shaped (`GET /api/admin/ads/tenants`, see the A11 contract) and read as it is:
 *   - `spend` is simply absent when the client has not shared it, and so is every monthly cap with it (cap × percentage would give the
 *     spend away). This page draws spend only when the key is there and says so in a muted line otherwise: it never shows a zero.
 *   - `capUsePct` is a percentage or null; null is "unknown", never 0.
 *   - `signoffs` is null only while A8's `ads_legal_signoffs` table (v56) is missing; a 404 from the sign-off routes means the same.
 *     Either way the card says so and shows no form. The writes are A8's routes (`API.recordAdminLegalSignoff` / `revokeAdminLegalSignoff`).
 *
 * Writes: the switch (a refusal 409 `CEILING_REQUIRED` is told next to the ceiling fields, in the interface language), the ceiling,
 * and the sign-offs (revoking asks first). Every spend figure carries "excluding tax; Meta's invoices are the accounting record".
 * Every server value goes through the `html` tag; nothing is written into an attribute by hand.
 */
const AdminAdsPage = {
    tenants: [],

    SCOPES: ['lead_ads', 'customer_lists'],
    TOKEN_LEVEL: { ok: 'fresh', expiring: 'warn', dead: 'stale', unknown: 'warn', none: 'stale' },
    TOKEN_ICON: { ok: 'check-circle', expiring: 'alert-triangle', dead: 'alert-circle', unknown: 'help-circle', none: 'alert-circle' },

    resetTenantState() {
        this.tenants = [];
        this._busy = new Set();
    },

    _busy: new Set(),

    render() {
        return this.load();
    },

    skeleton() {
        return html`${Motion.cardGrid(3, 5)}${Motion.busy()}`;
    },

    /** `quiet`: after a write, redraw from a fresh answer without the skeleton. */
    async load(quiet) {
        const container = document.getElementById('page-container');
        const gate = quiet ? { done() {} } : Motion.beginLoad(container, () => this.skeleton());
        let result;
        try {
            result = await API.getAdminAdsTenants();
        } catch (err) {
            gate.done();
            if (quiet) {
                UI.toast(this.failureText(err, 'adsAdmin.loadFailed'), 'error');
                return;
            }
            Admin.renderLoadFailure(container, err, {
                unavailableTitle: t('adsAdmin.unavailableTitle'),
                failedTitle: t('adsAdmin.loadFailed'),
                retry: () => this.load(),
            });
            return;
        }
        gate.done();
        const list = result && Array.isArray(result.tenants) ? result.tenants : (Array.isArray(result) ? result : []);
        this.tenants = list.filter((row) => row && typeof row === 'object');
        this.paint(container);
    },

    // ─── Reading a row ───────────────────────────────────────────────────────

    /** The server's figure as a number, or null (never NaN, never a string that looks like one). */
    num(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    },

    /** `12.5 USD` as one isolated run, so the currency code never reorders an Arabic sentence. */
    money(amount, currency) {
        const n = this.num(amount);
        if (n === null) return '—';
        return `⁦${UI.formatNumber(n)}${currency ? ` ${currency}` : ''}⁩`;
    },

    find(id) {
        return this.tenants.find((row) => String(row.tenantId) === String(id)) || null;
    },

    /** The row's position, used to make DOM ids that never carry a server value. */
    slot(id) {
        return this.tenants.findIndex((row) => String(row.tenantId) === String(id));
    },

    // ─── Drawing ─────────────────────────────────────────────────────────────

    paint(container) {
        if (!container) return;
        const rows = this.tenants;
        container.innerHTML = esc(html`
            <section class="section">
                <div class="row gap-3 row--wrap aa-toolbar">
                    <span class="text-meta">${t('adsAdmin.count', { count: rows.length })}</span>
                    ${UI.helpLink('ads#for-clients', t('adsAdmin.help.overview'))}
                    <button type="button" class="btn btn-secondary btn-sm" data-action="adminAds:reload">
                        <i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('ops.refresh')}
                    </button>
                </div>
                ${rows.length === 0
                    ? Admin.emptyState('inbox', t('adsAdmin.emptyTitle'), t('adsAdmin.emptyBody'))
                    : html`<div class="aa-list">${rows.map((row, i) => this.card(row, i))}</div>`}
            </section>
        `);
        UI.icons(container);
        Motion.announce(t('adsAdmin.count', { count: rows.length }));
    },

    card(row, i) {
        const id = row.tenantId;
        const owner = row.isPlatformOwner === true;
        const on = row.enabled === true;
        return html`
            <article class="surface aa-card" data-tenant-id="${id}" aria-labelledby="aa-name-${i}">
                <header class="aa-head">
                    <div class="aa-title">
                        <h2 class="aa-name" id="aa-name-${i}" dir="auto">${row.name || id}</h2>
                        <div class="row gap-2 row--wrap">
                            ${owner ? html`<span class="badge badge-accent">${t('adsAdmin.platformOwner')}</span>` : ''}
                            ${row.configured === true
                                ? html`<span class="badge badge-success">${t('adsAdmin.configured')}</span>`
                                : html`<span class="badge badge-neutral">${t('adsAdmin.notConfigured')}</span>`}
                        </div>
                    </div>
                    <div class="aa-switch">
                        <div class="switch-row">
                            <label class="switch" for="aa-enabled-${i}">
                                <span class="sr-only">${t('adsAdmin.enabled.label', { name: row.name || id })}</span>
                                <input type="checkbox" id="aa-enabled-${i}" data-change="adminAds:setEnabled" data-id="${id}"
                                       aria-describedby="aa-enabled-hint-${i}" ${on ? html.raw('checked') : ''}>
                                <span class="switch-track"></span>
                            </label>
                            <span class="switch-text">
                                <span class="switch-label">${on ? t('adsAdmin.enabled.on') : t('adsAdmin.enabled.off')}</span>
                            </span>
                        </div>
                        <p class="text-meta" id="aa-enabled-hint-${i}">${t('adsAdmin.enabled.hint')}</p>
                    </div>
                </header>

                <div class="aa-grid">
                    ${this.healthBlock(row)}
                    ${this.capBlock(row)}
                    ${this.alertsBlock(row)}
                    ${this.spendBlock(row)}
                </div>
                ${this.ceilingBlock(row, i)}
                ${this.signoffsBlock(row, i)}
            </article>
        `;
    },

    sectionHead(title, helpLabel) {
        return html`
            <div class="aa-section-head">
                <h3 class="aa-h3">${title}</h3>
                ${UI.helpLink('ads#for-clients', helpLabel)}
            </div>
        `;
    },

    pill(level, icon, label) {
        return html`<span class="health-pill health-${html.raw(level)}"><i data-lucide="${icon}" aria-hidden="true"></i>${label}</span>`;
    },

    healthBlock(row) {
        const token = Object.prototype.hasOwnProperty.call(this.TOKEN_LEVEL, row.tokenHealth) ? row.tokenHealth : 'unknown';
        const status = typeof row.accountStatus === 'string' && row.accountStatus ? row.accountStatus : '';
        const statusKey = `adsAdmin.account.${status}`;
        const statusText = !status ? t('adsAdmin.account.unknown') : (t(statusKey) === statusKey ? status : t(statusKey));
        const payment = row.paymentMethod === true ? 'yes' : row.paymentMethod === false ? 'no' : 'unknown';
        const checked = row.checkedAt ? UI.relativeAge(row.checkedAt, Admin.CHECK_AGE) : null;
        return html`
            <section class="aa-block" aria-label="${t('adsAdmin.health.title')}">
                ${this.sectionHead(t('adsAdmin.health.title'), t('adsAdmin.help.health'))}
                <dl class="aa-facts">
                    ${Admin.field(t('adsAdmin.health.token'), this.pill(this.TOKEN_LEVEL[token], this.TOKEN_ICON[token], t(`adsAdmin.token.${token}`)))}
                    ${Admin.field(t('adsAdmin.health.account'), statusText)}
                    ${Admin.field(t('adsAdmin.health.payment'), t(`adsAdmin.payment.${payment}`))}
                    ${Admin.field(t('adsAdmin.health.checked'), checked ? html`<span title="${checked.title}">${checked.text}</span>` : t('common.never'))}
                </dl>
            </section>
        `;
    },

    /** The share of the monthly cap used: a bar and the figure, or "unknown" (null is not zero). */
    capBlock(row) {
        const pct = this.num(row.capUsePct);
        const level = pct === null ? 'fresh' : pct >= 90 ? 'stale' : pct >= 60 ? 'warn' : 'fresh';
        return html`
            <section class="aa-block" aria-label="${t('adsAdmin.cap.title')}">
                <h3 class="aa-h3">${t('adsAdmin.cap.title')}</h3>
                ${pct === null
                    ? html`<p class="text-meta" data-cap="unknown">${t('adsAdmin.cap.unknown')}</p>`
                    : html`
                        <p class="aa-cap-figure" data-cap="known">${t('adsAdmin.cap.use', { pct: UI.formatPercent(pct) })}</p>
                        <progress class="aa-meter aa-meter--${html.raw(level)}" max="100" value="${Math.max(0, Math.min(100, pct))}"
                                  aria-label="${t('adsAdmin.cap.use', { pct: UI.formatPercent(pct) })}"></progress>`}
            </section>
        `;
    },

    alertsBlock(row) {
        const alerts = Array.isArray(row.openAlerts) ? row.openAlerts.filter((a) => a && typeof a === 'object') : [];
        return html`
            <section class="aa-block" aria-label="${t('adsAdmin.alerts.title')}">
                <h3 class="aa-h3">${t('adsAdmin.alerts.title')}</h3>
                ${alerts.length === 0
                    ? html`<p class="text-meta">${t('adsAdmin.alerts.none')}</p>`
                    : html`<ul class="aa-alerts" role="list">${alerts.map((a) => {
                        const key = `adsAdmin.alert.${a.kind}`;
                        const label = t(key) === key ? String(a.kind || '—') : t(key);
                        const age = a.lastAt ? UI.relativeAge(a.lastAt, Admin.CHECK_AGE) : null;
                        return html`<li dir="auto" title="${age ? age.title : ''}">${t('adsAdmin.alerts.item', {
                            kind: label, n: UI.formatNumber(this.num(a.count) === null ? 0 : a.count), when: age ? age.text : t('common.never'),
                        })}</li>`;
                    })}</ul>`}
            </section>
        `;
    },

    /** Spend only when the key is there; otherwise one muted line. */
    spendBlock(row) {
        const spend = row.spend && typeof row.spend === 'object' ? row.spend : null;
        return html`
            <section class="aa-block" aria-label="${t('adsAdmin.spend.title')}">
                ${this.sectionHead(t('adsAdmin.spend.title'), t('adsAdmin.help.spend'))}
                ${spend ? html`
                    <dl class="aa-facts" data-spend="shared">
                        ${Admin.field(t('adsAdmin.spend.today'), this.money(spend.spentToday, spend.currency))}
                        ${Admin.field(t('adsAdmin.spend.month'), this.money(spend.spentThisMonth, spend.currency))}
                        ${Admin.field(t('adsAdmin.spend.cap'), this.money(spend.monthlyCap, spend.currency))}
                        ${Admin.field(t('adsAdmin.spend.daily'), this.money(spend.maxDailyBudget, spend.currency))}
                    </dl>
                    <p class="text-meta">${t('adsAdmin.excludesTax')}</p>
                ` : html`<p class="text-meta" data-spend="private">${t('adsAdmin.spend.notShared')}</p>`}
            </section>
        `;
    },

    ceilingBlock(row, i) {
        const ceiling = row.ceiling && typeof row.ceiling === 'object' ? row.ceiling : null;
        const value = (n) => (this.num(n) === null ? '' : String(n));
        return html`
            <section class="aa-section" aria-label="${t('adsAdmin.ceiling.title')}">
                ${this.sectionHead(t('adsAdmin.ceiling.title'), t('adsAdmin.help.ceiling'))}
                <p class="form-hint">${t('adsAdmin.ceiling.hint')}</p>
                ${row.isPlatformOwner === true ? html`<p class="text-meta">${t('adsAdmin.ceiling.ownerNote')}</p>` : html`
                    <p class="text-meta">${ceiling
                        ? t('adsAdmin.ceiling.current', { daily: this.money(ceiling.maxDailyBudget), monthly: this.money(ceiling.monthlyCap) })
                        : t('adsAdmin.ceiling.none')}</p>
                    <div id="aa-ceiling-error-${i}" aria-live="polite"></div>
                    <form class="aa-form" data-submit="adminAds:saveCeiling" data-id="${row.tenantId}" data-slot="${i}" novalidate>
                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label" for="aa-daily-${i}">${t('adsAdmin.ceiling.daily')}</label>
                                <input class="field field-mono" id="aa-daily-${i}" name="maxDailyBudget" type="number" dir="ltr" inputmode="decimal"
                                       min="0" step="any" value="${value(ceiling && ceiling.maxDailyBudget)}">
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="aa-monthly-${i}">${t('adsAdmin.ceiling.monthly')}</label>
                                <input class="field field-mono" id="aa-monthly-${i}" name="monthlyCap" type="number" dir="ltr" inputmode="decimal"
                                       min="0" step="any" value="${value(ceiling && ceiling.monthlyCap)}">
                            </div>
                        </div>
                        <div class="form-actions">
                            ${UI.button({ variant: 'primary', size: 'sm', type: 'submit', icon: 'save', label: t('adsAdmin.ceiling.save') })}
                        </div>
                    </form>
                `}
            </section>
        `;
    },

    signoffsBlock(row, i) {
        const list = Array.isArray(row.signoffs) ? row.signoffs.filter((s) => s && typeof s === 'object') : null;
        return html`
            <section class="aa-section" aria-label="${t('adsAdmin.signoffs.title')}">
                ${this.sectionHead(t('adsAdmin.signoffs.title'), t('adsAdmin.help.signoffs'))}
                ${list === null ? html`<p class="text-meta" data-signoffs="pending">${t('adsAdmin.signoffs.pending')}</p>` : html`
                    <p class="form-hint">${t('adsAdmin.signoffs.hint')}</p>
                    ${list.length === 0
                        ? html`<p class="text-meta">${t('adsAdmin.signoffs.none')}</p>`
                        : html`<ul class="aa-signoffs" role="list">${list.map((s) => this.signoffItem(row, s))}</ul>`}
                    <div id="aa-signoff-error-${i}" aria-live="polite"></div>
                    <form class="aa-form" data-submit="adminAds:addSignoff" data-id="${row.tenantId}" data-slot="${i}" novalidate>
                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label" for="aa-scope-${i}">${t('adsAdmin.signoffs.scope')}</label>
                                <select class="select" id="aa-scope-${i}" name="scope">
                                    ${this.SCOPES.map((s) => html`<option value="${s}">${t(`adsAdmin.signoffs.scope.${s}`)}</option>`)}
                                </select>
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="aa-countries-${i}">${t('adsAdmin.signoffs.countries')}</label>
                                <input class="field field-mono" id="aa-countries-${i}" name="countries" type="text" dir="ltr" autocomplete="off"
                                       spellcheck="false" autocapitalize="characters" placeholder="SA, AE, EG">
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="aa-note-${i}">${t('adsAdmin.signoffs.note')}</label>
                            <input class="field" id="aa-note-${i}" name="note" type="text" dir="auto" maxlength="500" autocomplete="off">
                        </div>
                        <div class="form-actions">
                            ${UI.button({ variant: 'primary', size: 'sm', type: 'submit', icon: 'save', label: t('adsAdmin.signoffs.add') })}
                        </div>
                    </form>
                `}
            </section>
        `;
    },

    scopeLabel(scope) {
        const key = `adsAdmin.signoffs.scope.${scope}`;
        return t(key) === key ? String(scope || '—') : t(key);
    },

    signoffItem(row, s) {
        const scope = this.scopeLabel(s.scope);
        const countries = (Array.isArray(s.countries) ? s.countries : []).join(', ');
        const age = s.recordedAt ? UI.relativeAge(s.recordedAt, Admin.CHECK_AGE) : null;
        return html`
            <li class="aa-signoff" data-signoff-id="${s.id}">
                <div class="aa-signoff-body">
                    <strong dir="auto">${scope}</strong>
                    <span class="badge badge-neutral" dir="ltr">${countries || '—'}</span>
                    ${s.note ? html`<p class="text-meta" dir="auto">${s.note}</p>` : ''}
                    ${age ? html`<p class="text-meta" title="${age.title}">${t('adsAdmin.signoffs.recorded', { when: age.text })}</p>` : ''}
                </div>
                <button type="button" class="btn btn-secondary btn-sm" data-action="adminAds:confirmRevoke"
                        data-id="${row.tenantId}" data-sid="${s.id}" aria-label="${t('adsAdmin.signoffs.revokeFor', { scope })}">
                    <i data-lucide="ban" aria-hidden="true"></i> ${t('adsAdmin.signoffs.revoke')}
                </button>
            </li>
        `;
    },

    // ─── Failures ────────────────────────────────────────────────────────────

    /**
     * A refusal as one sentence in the interface language: the catalogue's (`errors.<code>`) when the server sent a code it has words for,
     * the network sentence when there was no answer, otherwise this screen's own line. The server's English is never the sentence.
     */
    failureText(err, fallbackKey, params) {
        const code = err && typeof err.code === 'string' ? err.code : '';
        if (err && (err.isNetworkError || (code && t(`errors.${code}`) !== `errors.${code}`))) {
            const { sentence, next } = UI.errorText(err);
            return next ? `${sentence} ${next}` : sentence;
        }
        return t(fallbackKey, params);
    },

    codeOf(err) {
        return (err && (err.code || (err.body && err.body.code))) || '';
    },

    /** Put a sentence in a card's error host and, when it names a field, mark that field. */
    showError(hostId, message, inputId) {
        const host = document.getElementById(hostId);
        if (!host) { UI.toast(message, 'error'); return; }
        const stripId = `${hostId}-error-strip`;
        host.innerHTML = esc(UI.errorStrip(message, '', stripId));
        UI.icons(host);
        const input = inputId ? document.getElementById(inputId) : null;
        if (input) UI.markInvalid(input, stripId);
    },

    clearError(hostId) {
        const host = document.getElementById(hostId);
        if (host) host.innerHTML = '';
    },

    /** Sign-offs are not shipped yet (the route answers 404): the card says so and shows no form. */
    markSignoffsPending(id) {
        const row = this.find(id);
        if (row) row.signoffs = null;
        this.paint(document.getElementById('page-container'));
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    async setEnabled(input) {
        const id = input.dataset.id;
        const row = this.find(id);
        const slot = this.slot(id);
        const on = !!input.checked;
        const name = (row && row.name) || id;
        if (this._busy.has(`en:${id}`)) { input.checked = !on; return; }
        this._busy.add(`en:${id}`);
        try {
            await API.setAdminAdsEnabled(id, on);
        } catch (err) {
            this._busy.delete(`en:${id}`);
            input.checked = !on;
            if (this.codeOf(err) === 'CEILING_REQUIRED') {
                this.showError(`aa-ceiling-error-${slot}`, t('adsAdmin.err.ceilingRequired'), `aa-daily-${slot}`);
                const host = document.getElementById(`aa-ceiling-error-${slot}`);
                if (host && typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'center' });
            } else {
                UI.toast(this.failureText(err, 'adsAdmin.enabled.failed', { name }), 'error');
            }
            return;
        }
        this._busy.delete(`en:${id}`);
        if (row) row.enabled = on;
        UI.toast(t(on ? 'adsAdmin.enabled.savedOn' : 'adsAdmin.enabled.savedOff', { name }), 'success');
        await this.load(true);
    },

    async saveCeiling(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const id = form.dataset.id;
        const row = this.find(id);
        const slot = this.slot(id);
        const read = (name) => {
            const input = typeof form.querySelector === 'function' ? form.querySelector(`[name="${name}"]`) : null;
            return input ? String(input.value || '').trim() : '';
        };
        const host = `aa-ceiling-error-${slot}`;
        this.clearError(host);
        const daily = read('maxDailyBudget') === '' ? NaN : Number(read('maxDailyBudget'));
        const monthly = read('monthlyCap') === '' ? NaN : Number(read('monthlyCap'));
        if (!Number.isFinite(daily) || daily <= 0) { this.showError(host, t('adsAdmin.ceiling.invalid'), `aa-daily-${slot}`); return; }
        if (!Number.isFinite(monthly) || monthly <= 0) { this.showError(host, t('adsAdmin.ceiling.invalid'), `aa-monthly-${slot}`); return; }
        if (this._busy.has(`ce:${id}`)) return;
        this._busy.add(`ce:${id}`);
        try {
            await API.setAdminAdsCeiling(id, daily, monthly);
        } catch (err) {
            this._busy.delete(`ce:${id}`);
            const field = err && err.body && err.body.field;
            this.showError(host, this.failureText(err, 'adsAdmin.ceiling.failed'),
                field === 'monthlyCap' ? `aa-monthly-${slot}` : field === 'maxDailyBudget' ? `aa-daily-${slot}` : '');
            return;
        }
        this._busy.delete(`ce:${id}`);
        UI.toast(t('adsAdmin.ceiling.saved', { name: (row && row.name) || id }), 'success');
        await this.load(true);
    },

    /** "SA, ae ; EG" as ['SA', 'AE', 'EG']; null when any piece is not two letters. */
    parseCountries(raw) {
        const parts = String(raw || '').split(/[\s,;،]+/).map((p) => p.trim().toUpperCase()).filter(Boolean);
        if (parts.length === 0 || parts.some((p) => !/^[A-Z]{2}$/.test(p))) return null;
        return Array.from(new Set(parts));
    },

    async addSignoff(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const id = form.dataset.id;
        const slot = this.slot(id);
        const read = (name) => {
            const input = typeof form.querySelector === 'function' ? form.querySelector(`[name="${name}"]`) : null;
            return input ? String(input.value || '').trim() : '';
        };
        const host = `aa-signoff-error-${slot}`;
        this.clearError(host);
        const scope = read('scope');
        const countries = this.parseCountries(read('countries'));
        if (!this.SCOPES.includes(scope)) { this.showError(host, t('adsAdmin.signoffs.addFailed'), `aa-scope-${slot}`); return; }
        if (!countries) { this.showError(host, t('adsAdmin.signoffs.invalidCountries'), `aa-countries-${slot}`); return; }
        if (this._busy.has(`so:${id}`)) return;
        this._busy.add(`so:${id}`);
        try {
            await API.recordAdminLegalSignoff(id, { scope, countries, note: read('note') });
        } catch (err) {
            this._busy.delete(`so:${id}`);
            if (err && err.status === 404) { this.markSignoffsPending(id); return; }
            this.showError(host, this.failureText(err, 'adsAdmin.signoffs.addFailed'), '');
            return;
        }
        this._busy.delete(`so:${id}`);
        UI.toast(t('adsAdmin.signoffs.added'), 'success');
        await this.load(true);
    },

    confirmRevoke(btn) {
        const id = btn.dataset.id;
        const sid = btn.dataset.sid;
        const row = this.find(id);
        const sign = row && Array.isArray(row.signoffs) ? row.signoffs.find((s) => String(s.id) === String(sid)) : null;
        Admin.confirm({
            title: t('adsAdmin.signoffs.revokeTitle'),
            body: t('adsAdmin.signoffs.revokeBody', {
                scope: this.scopeLabel(sign && sign.scope),
                name: (row && row.name) || id,
                countries: sign && Array.isArray(sign.countries) ? sign.countries.join(', ') : '—',
            }),
            hint: t('adsAdmin.signoffs.revokeHint'),
            confirmLabel: t('adsAdmin.signoffs.revokeCta'),
            confirmIcon: 'ban',
            onConfirm: () => this.revoke(id, sid),
        });
    },

    /** Runs inside the confirmation: a failure is thrown, and the dialog shows it next to the button (and keeps it open for a retry). */
    async revoke(id, sid) {
        try {
            await API.revokeAdminLegalSignoff(id, sid);
        } catch (err) {
            if (err && err.status === 404) { this.markSignoffsPending(id); return; }
            throw new Error(this.failureText(err, 'adsAdmin.signoffs.revokeFailed'));
        }
        UI.toast(t('adsAdmin.signoffs.revoked'), 'success');
        await this.load(true);
    },
};

UI.registerActions('adminAds', {
    reload: () => Admin.report(AdminAdsPage.load()),
    setEnabled: (el) => Admin.report(AdminAdsPage.setEnabled(el)),
    saveCeiling: (form, event) => Admin.report(AdminAdsPage.saveCeiling(form, event)),
    addSignoff: (form, event) => Admin.report(AdminAdsPage.addSignoff(form, event)),
    confirmRevoke: (el) => AdminAdsPage.confirmRevoke(el),
});
