/**
 * Ads → Proposals — `#/ads_proposals`, AI proposals (Meta Ads Manager A7, spec Story 3).
 *
 * Claude drafts; a person approves. Two kinds of card:
 *   - a NEW CAMPAIGN, drafted from the owner's words ("Suggest a campaign" here or on the Overview) or from a post (the same button on a
 *     Posts card): the goal, budget, audience and copy, the rationale and the assumptions, and what it adds to the month's worst case;
 *   - a CHANGE from the daily review of running ads (pause, lower or raise a budget, move budget): the numbers behind it, always the
 *     account's own (a number the model made up is dropped on the server before it can reach this screen).
 *
 * Approve asks once, then the server re-runs the policy check and the money rule and enqueues the ops: a new campaign is created PAUSED,
 * so nothing spends until it is switched on in Campaigns. "Edit in builder" opens the full builder (`ads_create.js`) with the draft filled
 * in. Reject creates nothing. A proposal expires after 7 days.
 *
 * Drafting can take minutes when Claude writes it on the owner's Mac: a drafting card says so and the page asks again every few seconds
 * (slower after a minute) until it is ready, failed, or the page is left.
 *
 * Everything the server or the model wrote is escaped by `html`. `AdsTabs` lives in ads_campaigns.js; the styles in css/pages/ads.css.
 */
const AdsProposalsPage = {
    /** 'loading' | 'ready' | 'forbidden' | 'disabled' | 'failed' */
    view: 'loading',
    /** ProposalView[], newest first, as the server last said. */
    items: [],
    /** Drafting proposals being followed: id → { started, timer }. */
    _polls: Object.create(null),
    _seq: 0,

    POLL_FAST_MS: 5000,
    POLL_SLOW_MS: 15000,
    POLL_SLOW_AFTER_MS: 60000,
    MAX_REQUEST: 1000,
    LIVE: Object.freeze(['drafting', 'open', 'approved', 'applying']),
    SHOWN: Object.freeze(['drafting', 'open', 'approved', 'applying', 'applied', 'failed', 'rejected', 'expired']),
    /** How many decided proposals the "Earlier" list keeps. */
    EARLIER_MAX: 10,

    resetTenantState() {
        this.destroy();
        this.view = 'loading';
        this.items = [];
    },

    destroy() {
        this._seq++;
        Object.keys(this._polls).forEach((id) => this.stopPoll(id));
    },

    isOwner() {
        return typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
    },

    canOperate() {
        return typeof App === 'undefined' || typeof App.canOperate !== 'function' || App.canOperate();
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
            answer = await API.getAdsProposals(this.SHOWN);
        } catch (err) {
            gate.done();
            if (seq !== this._seq) return false;
            if (err && (err.status === 403 || err.status === 404)) {
                this.view = err.status === 404 ? 'disabled' : 'forbidden';
                this.paint();
            } else {
                this.view = 'failed';
                UI.renderError(container, { title: t('ads.proposals.loadFailed'), message: (err && err.message) || t('error.unexpected'), hint: t('admin.loadFailedHint') }, () => this.load());
            }
            return false;
        }
        gate.done();
        if (seq !== this._seq) return false;
        this.items = (answer && Array.isArray(answer.proposals) ? answer.proposals : []).filter((p) => p && p.id);
        this.view = 'ready';
        this.paint();
        this.items.filter((p) => p.state === 'drafting').forEach((p) => this.startPoll(p.id));
        Motion.announce(t('ads.proposals.loaded'));
        return true;
    },

    paint() {
        const container = this.host();
        if (!container) return;
        const focus = UI.captureFocus ? UI.captureFocus(container) : null;
        container.innerHTML = esc(this.markup());
        UI.icons(container);
        if (focus && UI.restoreFocus) UI.restoreFocus(focus);
    },

    find(id) {
        return this.items.find((p) => String(p.id) === String(id)) || null;
    },

    /** Put the server's answer for one proposal in the list (a new one at the top) and repaint. */
    upsert(p) {
        if (!p || !p.id) return;
        const i = this.items.findIndex((x) => String(x.id) === String(p.id));
        if (i >= 0) this.items[i] = p; else this.items.unshift(p);
        if (this.view === 'ready') this.paint();
    },

    // ─── Following a draft ───────────────────────────────────────────────────

    startPoll(id) {
        if (this._polls[id]) return;
        this._polls[id] = { started: Date.now(), timer: null };
        this.schedulePoll(id);
    },

    schedulePoll(id) {
        const poll = this._polls[id];
        if (!poll) return;
        const wait = Date.now() - poll.started > this.POLL_SLOW_AFTER_MS ? this.POLL_SLOW_MS : this.POLL_FAST_MS;
        poll.timer = setTimeout(() => this.pollOnce(id), wait);
    },

    stopPoll(id) {
        const poll = this._polls[id];
        if (poll && poll.timer) clearTimeout(poll.timer);
        delete this._polls[id];
    },

    async pollOnce(id) {
        const seq = this._seq;
        let answer = null;
        try {
            answer = await API.getAdsProposal(id);
        } catch (err) {
            if (err && err.status === 404) {
                // A review that found nothing worth changing is removed by the server: so is its card.
                this.stopPoll(id);
                this.items = this.items.filter((x) => String(x.id) !== String(id));
                if (this.view === 'ready' && seq === this._seq) this.paint();
                return;
            }
        }
        if (seq !== this._seq || !this._polls[id]) return;
        const p = answer && answer.proposal;
        if (p) this.upsert(p);
        if (p && p.state !== 'drafting') {
            this.stopPoll(id);
            if (p.state === 'open') Motion.announce(t('ads.proposals.ready'));
            return;
        }
        this.schedulePoll(id);
    },

    // ─── Words and numbers ───────────────────────────────────────────────────

    isolate(text) {
        return `⁨${String(text === null || text === undefined ? '' : text)}⁩`;
    },

    money(amount, currency) {
        const n = Number(amount);
        if (amount === null || amount === undefined || !Number.isFinite(n)) return '—';
        return `⁦${UI.formatNumber(n)}${currency ? ` ${currency}` : ''}⁩`;
    },

    /** Days left before it expires, at least 0. */
    daysLeft(p) {
        const end = Date.parse(p && p.expiresAt);
        return Number.isFinite(end) ? Math.max(0, Math.ceil((end - Date.now()) / 86400000)) : null;
    },

    title(p) {
        if (p.spec && p.spec.name) return p.spec.name;
        if (p.change) return t(`ads.proposals.change.${p.change.kind}`);
        if (p.state === 'drafting') return p.request || t('ads.proposals.drafting.title');
        return t('ads.proposals.untitled');
    },

    /** A refusal from the server in the reader's words. */
    refusalText(err) {
        const code = err && (err.code || (err.body && err.body.code));
        const known = ['AI_NOT_CONFIGURED', 'NOT_WIRED', 'POLICY_BLOCKED', 'OVER_MONTHLY_CAP', 'OVER_DAILY_MAX', 'BELOW_META_MINIMUM', 'ADS_DISABLED', 'ADS_NOT_CONFIGURED', 'META_ERROR', 'INVALID', 'RATE_LIMITED'];
        if (code && known.includes(code)) {
            const words = t(`ads.proposals.err.${code}`);
            return code === 'META_ERROR' || code === 'INVALID' ? `${words} ${(err && err.message) || ''}`.trim() : words;
        }
        return (err && err.message) || t('error.unexpected');
    },

    // ─── Markup ──────────────────────────────────────────────────────────────

    markup() {
        const tabs = typeof AdsTabs === 'undefined' || this.view === 'forbidden' || this.view === 'disabled' ? '' : AdsTabs.markup('proposals');
        const suggest = this.view === 'ready' && this.canOperate()
            ? UI.button({ variant: 'primary', size: 'sm', icon: 'sparkles', label: t('ads.proposals.suggest'), action: 'adsprop:suggest', focusKey: 'adsprop-suggest' })
            : '';
        const header = UI.pageHeader({ title: t('ads.proposals.title'), subtitle: t('ads.proposals.subtitle'), actions: suggest });
        if (this.view === 'forbidden') return html`<div id="adsprop-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.owner.title'), body: t('ads.owner.body') })}</div>`;
        if (this.view === 'disabled') return html`<div id="adsprop-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.disabled.title'), body: t('ads.disabled.body') })}</div>`;
        const live = this.items.filter((p) => this.LIVE.includes(p.state));
        const earlier = this.items.filter((p) => !this.LIVE.includes(p.state)).slice(0, this.EARLIER_MAX);
        return html`
            <div id="adsprop-page" class="ads-page adsprop-page">
                ${tabs}
                ${header}
                <p class="ads-help" id="adsprop-help">
                    ${UI.helpLink('ads#ai-proposals', t('ads.proposals.help.how'))}
                    · ${UI.helpLink('ads#what-ai-sees', t('ads.proposals.help.sees'))}
                </p>
                ${live.length ? html`<div class="adsprop-list" id="adsprop-live">${live.map((p) => this.cardMarkup(p))}</div>`
                    : UI.emptyState({ icon: 'sparkles', title: t('ads.proposals.empty.title'), body: t('ads.proposals.empty.body') })}
                ${earlier.length ? html`
                    <h2 class="section-title" id="adsprop-earlier-title">${t('ads.proposals.earlier')}</h2>
                    <div class="adsprop-list adsprop-earlier" id="adsprop-earlier">${earlier.map((p) => this.cardMarkup(p))}</div>
                ` : ''}
            </div>
        `;
    },

    stateBadge(p) {
        const tone = { drafting: 'info', open: 'warning', approved: 'info', applying: 'info', applied: 'success', failed: 'danger', rejected: 'neutral', expired: 'neutral' }[p.state] || 'neutral';
        return html`<span class="badge badge-${tone}" id="adsprop-state-${p.id}">${t(`ads.proposals.state.${p.state}`)}</span>`;
    },

    cardMarkup(p) {
        const id = String(p.id);
        if (p.state === 'drafting') return this.draftingMarkup(p);
        const days = this.daysLeft(p);
        return html`
            <article class="card adsprop-card" id="adsprop-${id}" data-state="${p.state}">
                <header class="adsprop-head">
                    <h3 class="adsprop-title" dir="auto">${this.title(p)}</h3>
                    ${this.stateBadge(p)}
                    <span class="adsprop-source">${t(`ads.proposals.source.${p.source}`)}</span>
                </header>
                ${p.rationale ? html`<p class="adsprop-rationale" dir="auto" id="adsprop-rationale-${id}">${p.rationale}</p>` : ''}
                ${p.spec ? this.specMarkup(p) : ''}
                ${p.change && !p.spec ? this.changeMarkup(p) : ''}
                ${this.evidenceMarkup(p)}
                ${this.effectMarkup(p)}
                ${this.checksMarkup(p)}
                ${p.state === 'failed' && p.error ? html`<p class="form-error adsprop-error" dir="auto" id="adsprop-error-${id}">${p.error}</p>` : ''}
                ${p.state === 'rejected' && p.error ? html`<p class="form-hint" dir="auto">${t('ads.proposals.rejectedBecause', { reason: this.isolate(p.error) })}</p>` : ''}
                ${p.state === 'open' && days !== null ? html`<p class="form-hint adsprop-expiry">${t('ads.proposals.expiresIn', { days: t('analytics.days', { count: days, n: `⁦${days}⁩` }) })}</p>` : ''}
                ${p.state === 'applying' ? html`<p class="form-hint">${t('ads.proposals.applying.hint')}</p>` : ''}
                ${p.state === 'applied' ? html`<p class="form-hint">${t('ads.proposals.applied.hint')} <a href="#/ads_campaigns">${t('ads.tabs.campaigns')}</a></p>` : ''}
                ${p.state === 'open' ? this.actionsMarkup(p) : ''}
            </article>
        `;
    },

    draftingMarkup(p) {
        const mac = p.via === 'mac';
        return html`
            <article class="card adsprop-card adsprop-drafting" id="adsprop-${String(p.id)}" data-state="drafting" aria-busy="true">
                <header class="adsprop-head">
                    <h3 class="adsprop-title" dir="auto">${this.title(p)}</h3>
                    ${this.stateBadge(p)}
                </header>
                <div class="adsprop-wait" role="status">
                    <span class="spinner" aria-hidden="true"></span>
                    <span>${mac ? t('ads.proposals.drafting.mac') : t('ads.proposals.drafting.api')}</span>
                </div>
                ${Motion && typeof Motion.busy === 'function' ? Motion.busy() : ''}
            </article>
        `;
    },

    specMarkup(p) {
        const s = p.spec;
        const b = s.budget || {};
        const set = Array.isArray(s.adsets) && s.adsets[0] ? s.adsets[0] : null;
        const ad = Array.isArray(s.ads) && s.ads[0] ? s.ads[0] : null;
        const currency = (p.effect && p.effect.currency) || '';
        const tg = set && set.targeting ? set.targeting : {};
        const ages = tg.ageMin ? (tg.ageMax ? `${tg.ageMin}–${tg.ageMax}` : `${tg.ageMin}+`) : '—';
        const rows = [
            [t('ads.proposals.spec.goal'), t(`ads.proposals.goal.${s.goal}`)],
            [t('ads.proposals.spec.budget'), html`${this.money(b.amount, currency)} · ${t(b.kind === 'lifetime' ? 'ads.proposals.spec.lifetime' : 'ads.proposals.spec.daily')}${b.end ? html` · ${t('ads.proposals.spec.until', { date: `⁦${UI.formatDate ? UI.formatDate(b.end) : String(b.end).slice(0, 10)}⁩` })}` : ''}`],
            [t('ads.proposals.spec.countries'), Array.isArray(tg.countries) ? tg.countries.join(', ') : '—'],
            [t('ads.proposals.spec.ages'), ages],
        ];
        return html`
            <dl class="adsprop-spec" id="adsprop-spec-${String(p.id)}">
                ${rows.map(([k, v]) => html`<div><dt>${k}</dt><dd dir="auto">${v}</dd></div>`)}
            </dl>
            ${ad && ad.copy && ad.copy.primaryText ? html`<blockquote class="adsprop-copy" dir="auto">${ad.copy.primaryText}</blockquote>` : ''}
            ${ad && ad.message && ad.message.greeting ? html`
                <p class="adsprop-greeting" dir="auto"><strong>${t('ads.proposals.spec.greeting')}</strong> ${ad.message.greeting}</p>
                ${Array.isArray(ad.message.iceBreakers) && ad.message.iceBreakers.length ? html`<div class="adsprop-ice">${ad.message.iceBreakers.map((x) => html`<span class="chip" dir="auto">${x.title}</span>`)}</div>` : ''}
            ` : ''}
            ${Array.isArray(p.assumptions) && p.assumptions.length ? html`
                <details class="adsprop-assumptions"><summary>${t('ads.proposals.assumptions')}</summary>
                    <ul>${p.assumptions.map((a) => html`<li dir="auto">${a}</li>`)}</ul>
                </details>
            ` : ''}
            ${p.expected ? html`<p class="form-hint">${p.expected.range
                ? t('ads.proposals.expected.range', { low: p.expected.range[0], high: p.expected.range[1], metric: t(`ads.proposals.metric.${p.expected.metric}`) })
                : t('ads.proposals.expected.none')}</p>` : ''}
        `;
    },

    changeMarkup(p) {
        const c = p.change;
        const ch = c.change || {};
        let what = '';
        if (typeof ch.percent === 'number') what = c.kind === 'pause' ? t('ads.proposals.change.pause.what') : t('ads.proposals.change.percent', { percent: `⁦${ch.percent > 0 ? '+' : ''}${ch.percent}%⁩` });
        else if (ch.from && ch.to) what = t('ads.proposals.change.shift', { amount: this.money(ch.amount, p.effect && p.effect.currency) });
        return html`<p class="adsprop-change" id="adsprop-change-${String(p.id)}"><strong>${t(`ads.proposals.change.${c.kind}`)}</strong> ${what}</p>`;
    },

    evidenceMarkup(p) {
        const ev = p.evidence;
        const numbers = ev && ev.numbers && typeof ev.numbers === 'object' ? ev.numbers : null;
        if (!numbers || !Object.keys(numbers).length) return '';
        return html`
            <div class="adsprop-evidence" id="adsprop-evidence-${String(p.id)}">
                <span class="adsprop-label">${t('ads.proposals.evidence', { window: this.isolate(ev.window || '7d') })}</span>
                <ul>${Object.keys(numbers).map((k) => html`<li><span>${t(`ads.proposals.measure.${k}`) === `ads.proposals.measure.${k}` ? k : t(`ads.proposals.measure.${k}`)}</span> <strong>⁦${UI.formatNumber(Number(numbers[k]))}⁩</strong></li>`)}</ul>
            </div>
        `;
    },

    effectMarkup(p) {
        const e = p.effect;
        if (!e || e.worstCaseDelta === null || e.worstCaseDelta === undefined) return '';
        const delta = Number(e.worstCaseDelta);
        return html`
            <div class="adsprop-effect" id="adsprop-effect-${String(p.id)}">
                <span>${delta > 0 ? t('ads.proposals.effect.adds', { amount: this.money(delta, e.currency) }) : delta < 0 ? t('ads.proposals.effect.saves', { amount: this.money(-delta, e.currency) }) : t('ads.proposals.effect.none')}</span>
                ${e.newWorstCase !== null && e.newWorstCase !== undefined ? html`<span>${t('ads.proposals.effect.newWorst', { amount: this.money(e.newWorstCase, e.currency) })}</span>` : ''}
                <span class="form-hint ads-tax-note">${t('ads.tax.note')}</span>
            </div>
        `;
    },

    checksMarkup(p) {
        const c = p.checks;
        if (!c) return '';
        const warnings = (Array.isArray(c.policy) ? c.policy : []).filter((f) => f && f.severity === 'warn');
        const unavailable = Array.isArray(c.unavailable) ? c.unavailable : [];
        return html`
            ${warnings.length ? html`<ul class="adsprop-warnings" id="adsprop-warnings-${String(p.id)}">${warnings.map((f) => html`<li dir="auto"><i data-lucide="alert-triangle" aria-hidden="true"></i> ${f.message}</li>`)}</ul>` : ''}
            ${c.money && c.money.note ? html`<p class="form-hint adsprop-money-note" dir="auto" id="adsprop-money-${String(p.id)}">${c.money.note}</p>` : ''}
            ${unavailable.length ? html`<p class="form-hint adsprop-unavailable">${t('ads.proposals.unavailable')}</p>` : ''}
        `;
    },

    canEditInBuilder(p) {
        return !!(p.spec && typeof App !== 'undefined' && typeof App.loadPageModule === 'function') || !!(p.spec && typeof AdsCreatePage !== 'undefined');
    },

    actionsMarkup(p) {
        const id = String(p.id);
        if (!this.isOwner()) return html`<p class="form-hint">${t('ads.proposals.ownerDecides')}</p>`;
        const blocked = Array.isArray(p.checks && p.checks.unavailable) && p.checks.unavailable.length > 0;
        return html`
            <div class="adsprop-actions">
                ${UI.button({ variant: 'primary', size: 'sm', icon: 'check', label: t('ads.proposals.approve'), action: 'adsprop:approve', data: { id }, focusKey: `adsprop-approve-${id}`, disabled: blocked })}
                ${this.canEditInBuilder(p) ? UI.button({ variant: 'secondary', size: 'sm', icon: 'pencil', label: t('ads.proposals.edit'), action: 'adsprop:edit', data: { id }, focusKey: `adsprop-edit-${id}` }) : ''}
                ${UI.button({ variant: 'ghost', size: 'sm', icon: 'x', label: t('ads.proposals.reject'), action: 'adsprop:reject', data: { id }, focusKey: `adsprop-reject-${id}` })}
            </div>
        `;
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    /** "Suggest a campaign": the owner's words, at most 1000 characters. */
    suggest() {
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">${t('ads.proposals.suggest.title')}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}"><i data-lucide="x" aria-hidden="true"></i></button>
            </div>
            <div class="form-group">
                <label class="form-label" for="adsprop-request">${t('ads.proposals.suggest.label')}</label>
                <textarea class="form-input" id="adsprop-request" rows="4" maxlength="${this.MAX_REQUEST}" dir="auto" placeholder="${t('ads.proposals.suggest.placeholder')}"></textarea>
                <p class="form-hint">${t('ads.proposals.suggest.hint')}</p>
            </div>
            <div id="adsprop-suggest-error"></div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                ${UI.button({ variant: 'primary', icon: 'sparkles', label: t('ads.proposals.suggest.send'), action: 'adsprop:suggestSend', focusKey: 'adsprop-suggest-send' })}
            </div>
        `);
    },

    async suggestSend() {
        const box = document.getElementById('adsprop-request');
        const text = box ? String(box.value || '').trim() : '';
        const error = document.getElementById('adsprop-suggest-error');
        if (!text) {
            if (error) error.innerHTML = esc(html`<p class="form-error">${t('ads.proposals.suggest.empty')}</p>`);
            return;
        }
        try {
            const answer = await API.requestAdsProposal({ request: text.slice(0, this.MAX_REQUEST) });
            UI.closeModal();
            this.started(answer && answer.proposal);
        } catch (err) {
            if (error) error.innerHTML = esc(html`<p class="form-error" dir="auto">${this.refusalText(err)}</p>`);
        }
    },

    /** "Suggest a campaign" on a Posts card. Opens this tab with the drafting card. */
    async suggestFromPost(postId, platform) {
        try {
            await API.requestAdsProposal({ postId, platform });
            UI.toast(t('ads.proposals.started'), 'success');
            if (typeof location !== 'undefined') location.hash = '#/ads_proposals';
        } catch (err) {
            UI.toast(this.refusalText(err), 'error');
        }
    },

    started(p) {
        if (!p) return;
        this.upsert(p);
        if (p.state === 'drafting') this.startPoll(p.id);
        UI.toast(t('ads.proposals.started'), 'success');
    },

    approve(id) {
        const p = this.find(id);
        if (!p || p.state !== 'open') return;
        UI.confirm({
            title: t('ads.proposals.approve.title'),
            body: p.spec ? t('ads.proposals.approve.body.campaign', { name: this.isolate(this.title(p)) }) : t('ads.proposals.approve.body.change', { name: this.isolate(this.title(p)) }),
            hint: t('ads.proposals.approve.hint'),
            tone: 'primary',
            confirmLabel: t('ads.proposals.approve'),
            confirmIcon: 'check',
            onConfirm: () => AdsProposalsPage.approveConfirmed(String(id)),
        });
    },

    async approveConfirmed(id) {
        try {
            const answer = await API.approveAdsProposal(id);
            if (answer && answer.proposal) this.upsert(answer.proposal);
            UI.toast(t('ads.proposals.approved'), 'success');
        } catch (err) {
            throw new Error(this.refusalText(err));
        }
    },

    reject(id) {
        const p = this.find(id);
        if (!p || p.state !== 'open') return;
        UI.confirm({
            title: t('ads.proposals.reject.title'),
            body: t('ads.proposals.reject.body', { name: this.isolate(this.title(p)) }),
            confirmLabel: t('ads.proposals.reject'),
            confirmIcon: 'x',
            onConfirm: () => AdsProposalsPage.rejectConfirmed(String(id)),
        });
    },

    async rejectConfirmed(id) {
        try {
            const answer = await API.rejectAdsProposal(id);
            if (answer && answer.proposal) this.upsert(answer.proposal);
        } catch (err) {
            throw new Error(this.refusalText(err));
        }
    },

    /** The full builder, filled in with the draft. Creating there makes the owner's own campaign; this proposal stays until rejected or expired. */
    async edit(id) {
        const p = this.find(id);
        if (!p || !p.spec) return;
        try {
            if (typeof AdsCreatePage === 'undefined' && typeof App !== 'undefined' && typeof App.loadPageModule === 'function') await App.loadPageModule('ads_create');
        } catch { /* said below */ }
        if (typeof AdsCreatePage === 'undefined' || typeof AdsCreatePage.openWith !== 'function') {
            UI.toast(t('ads.proposals.edit.unavailable'), 'error');
            return;
        }
        AdsCreatePage.openWith({ spec: p.spec, proposalId: String(p.id) });
    },
};

UI.registerActions('adsprop', {
    suggest: () => AdsProposalsPage.suggest(),
    suggestSend: () => AdsProposalsPage.suggestSend(),
    approve: (el) => AdsProposalsPage.approve(el.dataset.id),
    reject: (el) => AdsProposalsPage.reject(el.dataset.id),
    edit: (el) => AdsProposalsPage.edit(el.dataset.id),
});
