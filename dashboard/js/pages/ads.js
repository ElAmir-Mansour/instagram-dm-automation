/**
 * Ads — `#/ads`, the workspace OWNER's: every campaign on the Meta ad account (the boosts made from Posts, and the ones made in Meta), what
 * has been spent, the limits the owner set in Settings, and the four things that can be done to a campaign: Activate, Pause, Edit budget, Delete.
 *
 * ─── First run ──────────────────────────────────────────────────────────────
 * Not configured: three steps and one way in (Settings). Configured but the ad account has NO payment method (Meta's API cannot add one):
 * a calm card at the top with numbered steps, the one primary button (Meta's billing page, a new tab) and "Check again"; everything else
 * stays usable, and Activate, instead of being disabled, explains. Configured but the account cannot be read: one card that says so, with
 * Retry, rather than empty numbers and a "no campaigns" that would be a lie.
 *
 * ─── Money rules, said on the screen ────────────────────────────────────────
 * ACTIVATE STARTS SPENDING real money on the ad account, so it is never one click: the question names the budget (a day, or the total),
 * the account, the end date when there is one, and that the account's payment method is charged. Only the answer "yes" sends
 * `confirm: true`. A RAISE on a running campaign (a higher amount, or a later end) asks too, over the form, with the arithmetic; lowering
 * it does not. Pause is one click (it stops spending), Delete asks first, and an ACTIVE campaign offers no Delete at all.
 * Every limit is the server's (`BUDGET_OVER_DAILY_MAX`, `BUDGET_OVER_MONTHLY_CAP`, `PAYMENT_METHOD_MISSING`, ...): this page shows
 * the numbers beside the field so a refusal is no surprise, and shows the server's own sentence when one comes.
 *
 * ─── Silent where it should be ──────────────────────────────────────────────
 * A member who is not the owner, or a 403 from the API, gets a calm "owners only" panel and no error toast, the same silence the Settings
 * card and Posts keep (`App.canAdminister()`). A null number is "—", never 0: a zero would say nothing was spent.
 */
const AdsPage = {
    /** The server's GET /ads/overview answer; null until the first one. */
    data: null,
    /** 'loading' | 'ready' | 'forbidden' | 'failed' */
    view: 'loading',
    /** Bumped on every read and on destroy(), so a slow answer cannot land on another screen. */
    _seq: 0,
    _edit: null,
    /** When the last answer came, as an ISO instant: the page says how fresh its numbers are. */
    _loadedAt: null,

    /** The statuses Meta reports that this page words; any other is shown as written, in the warning tone. */
    STATUSES: Object.freeze(['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', 'DISAPPROVED', 'PENDING_BILLING_INFO', 'ARCHIVED', 'DELETED']),
    OBJECTIVES: Object.freeze(['OUTCOME_ENGAGEMENT', 'OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_APP_PROMOTION']),
    ACCOUNT_STATUSES: Object.freeze(['active', 'disabled', 'unsettled', 'pending_review', 'closed', 'other']),
    /** The statuses from which Activate is not offered: Meta no longer runs these. */
    NOT_RUNNABLE: Object.freeze(['ARCHIVED', 'DELETED']),
    EDIT_FIELDS: Object.freeze({ amount: 'ads-amount', endTime: 'ads-end' }),

    resetTenantState() {
        this._seq++;
        this.data = null;
        this.view = 'loading';
        this._edit = null;
        this._loadedAt = null;
    },

    destroy() {
        this._seq++;
        this._edit = null;
    },

    // ─── Reading ─────────────────────────────────────────────────────────────

    isOwner() {
        return typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
    },

    skeleton() {
        return html`
            ${Motion.statsGrid(3)}
            ${Motion.tableCard(4, [t('ads.col.name'), t('ads.col.status'), t('ads.col.budget'), t('ads.col.spend'), ''])}
            ${Motion.busy()}
        `;
    },

    render() {
        return this.load();
    },

    /** Reads the overview and paints it. Answers true when a fresh answer is on screen, false when it is not (forbidden, failed, superseded). */
    async load() {
        const container = document.getElementById('page-container');
        if (!container) return false;
        if (!this.isOwner()) {
            this.view = 'forbidden';
            this.paint(container);
            return false;
        }
        const seq = ++this._seq;
        const gate = Motion.beginLoad(container, () => this.skeleton());
        let answer;
        try {
            answer = await API.getAdsOverview();
        } catch (err) {
            gate.done();
            if (seq !== this._seq) return false;
            if (err && err.status === 403) {
                this.view = 'forbidden';
                this.paint(container);
            } else if (this.data) {
                // A refresh that failed leaves what is on screen, and says why.
                UI.toast(this.failure(err), 'error');
            } else {
                this.view = 'failed';
                UI.renderError(container, {
                    title: t('ads.loadFailed'),
                    message: this.failure(err),
                    hint: t('admin.loadFailedHint'),
                }, () => this.load());
            }
            return false;
        }
        gate.done();
        if (seq !== this._seq) return false;
        this.data = answer && typeof answer === 'object' ? answer : { configured: false };
        this._loadedAt = new Date().toISOString();
        this.view = 'ready';
        this.paint(container);
        Motion.announce(t('ads.loaded', { count: this.campaigns().length }));
        return true;
    },

    /** After an action the spend numbers have moved: ask again, quietly. A failure leaves the last answer. */
    async refreshQuiet() {
        const seq = ++this._seq;
        try {
            const answer = await API.getAdsOverview();
            if (seq !== this._seq || !answer || typeof answer !== 'object') return;
            this.data = answer;
            this._loadedAt = new Date().toISOString();
            this.view = 'ready';
            const container = document.getElementById('page-container');
            if (container && document.getElementById('ads-page')) this.paint(container);
        } catch (err) { /* keep what was known */ }
    },

    /**
     * Refresh, and "Check again" on the payment card. When the owner came back from Meta to see whether the payment method is there, the
     * answer is said out loud (a live region), and focus stays on something real when the card that held the button is gone.
     */
    async refresh(el) {
        const restore = UI.actionBusy(el);
        if (!restore) return;
        const waiting = this.account() && this.account().hasPaymentMethod === false;
        let fresh = false;
        try {
            fresh = await this.load();
        } finally {
            restore();
        }
        if (waiting && fresh) {
            const now = this.account() && this.account().hasPaymentMethod;
            Motion.announce(now === true ? t('ads.payment.nowOn') : t('ads.payment.stillOff'));
            if (now === true) this.focusOn('ads-account-title');
        }
    },

    /** Put focus on a heading that is still on screen (a button that was pressed has been replaced, and focus must not fall to the page). */
    focusOn(id) {
        const el = document.getElementById(id);
        if (!el || typeof el.focus !== 'function') return;
        if (typeof el.setAttribute === 'function') el.setAttribute('tabindex', '-1');
        el.focus();
    },

    /** The server's own sentence, or the generic one. */
    failure(err) {
        return (err && err.message) || t('error.unexpected');
    },

    campaigns() {
        return this.data && Array.isArray(this.data.campaigns) ? this.data.campaigns : [];
    },

    findCampaign(id) {
        return this.campaigns().find((c) => String(c.id) === String(id)) || null;
    },

    account() {
        return this.data && this.data.account ? this.data.account : null;
    },

    currency() {
        const a = this.account();
        return a && a.currency ? a.currency : '';
    },

    // ─── Formatting ──────────────────────────────────────────────────────────

    /** `12.5 USD` as one isolated run: a currency code never reorders an Arabic sentence. */
    money(amount, currency) {
        const n = Number(amount);
        if (amount === null || amount === undefined || !Number.isFinite(n)) return '—';
        const cur = currency === undefined ? this.currency() : currency;
        return `⁦${UI.formatNumber(n)}${cur ? ` ${cur}` : ''}⁩`;
    },

    /** A name from the server isolated by its own first strong letter, for a sentence in the other script. */
    isolate(text) {
        return `⁨${String(text === null || text === undefined ? '' : text)}⁩`;
    },

    count(value) {
        return value === null || value === undefined ? '—' : UI.formatNumber(value);
    },

    dayText(iso) {
        return iso ? UI.formatDay(iso) : '—';
    },

    /** The status in words: the catalogue's, else the server's own word as written. */
    statusWord(status) {
        const key = `ads.status.${status}`;
        const said = t(key);
        return said === key ? String(status || '—') : said;
    },

    statusChip(status) {
        const tone = status === 'ACTIVE' ? 'badge-success' : (status === 'PAUSED' || status === 'CAMPAIGN_PAUSED' || status === 'ADSET_PAUSED' ? 'badge-neutral' : 'badge-warning');
        return html`<span class="badge ${html.raw(tone)}" data-ads-status="${status}">${this.statusWord(status)}</span>`;
    },

    objectiveWord(objective) {
        const key = `ads.objective.${objective}`;
        const said = t(key);
        return said === key ? String(objective || '—') : said;
    },

    budgetText(budget) {
        if (!budget || budget.kind === 'none' || budget.amount === null || budget.amount === undefined) return t('ads.budget.perAdset');
        const amount = this.money(budget.amount);
        return budget.kind === 'lifetime' ? t('ads.budget.lifetime', { amount }) : t('ads.budget.daily', { amount });
    },

    /** Whole days from now to `iso` (at least 1), or null when there is no end or it has passed. */
    daysLeft(iso) {
        const at = iso ? Date.parse(iso) : NaN;
        if (!Number.isFinite(at) || at <= Date.now()) return null;
        return Math.max(1, Math.ceil((at - Date.now()) / 86400000));
    },

    /** How much of this month's cap is still free, or null when there is no cap. */
    capLeft() {
        const limits = (this.data && this.data.limits) || {};
        if (limits.monthlyCap === null || limits.monthlyCap === undefined) return null;
        return Math.max(0, Number(limits.monthlyCap) - (Number(limits.committedThisMonth) || 0));
    },

    /** `Name` of the ad account for a sentence: its name, else its id, isolated. */
    accountLabel() {
        const a = this.account();
        return this.isolate((a && (a.name || a.id)) || '');
    },

    // ─── Painting ────────────────────────────────────────────────────────────

    paint(container) {
        if (!container) return;
        const focus = UI.captureFocus(container);
        container.innerHTML = esc(this.markup());
        UI.icons(container);
        UI.restoreFocus(focus);
    },

    markup() {
        const ready = this.view === 'ready' && this.data && this.data.configured;
        const refresh = UI.button({
            variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('ads.refresh'), action: 'ads:refresh', focusKey: 'ads-refresh',
        });
        const header = UI.pageHeader({
            title: t('ads.head.title'),
            subtitle: ready && this._loadedAt ? t('ads.updatedAt', { time: `⁦${UI.formatTime(this._loadedAt)}⁩` }) : '',
            actions: ready ? refresh : '',
        });
        if (this.view === 'forbidden') {
            return html`<div id="ads-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.owner.title'), body: t('ads.owner.body') })}</div>`;
        }
        const data = this.data || {};
        if (!data.configured) return html`<div id="ads-page" class="ads-page">${header}${this.firstRun()}</div>`;
        if (!data.account) return html`<div id="ads-page" class="ads-page">${header}${this.accountProblem()}</div>`;
        return html`
            <div id="ads-page" class="ads-page">
                ${header}
                ${this.paymentCard()}
                ${this.accountStrip()}
                ${this.spendCards()}
                ${this.limitsRow()}
                <section class="section" id="ads-campaigns-section" aria-labelledby="ads-campaigns-title">
                    <div class="ads-section-head">
                        <h2 class="section-title" id="ads-campaigns-title" tabindex="-1">${t('ads.campaigns.title')}</h2>
                        <p class="form-hint" id="ads-summary">${this.summaryText()}</p>
                    </div>
                    <div id="ads-campaigns">${this.campaignsMarkup()}</div>
                </section>
            </div>
        `;
    },

    /** Not set up yet: what the three steps are, one way in, and the two things that are calm to know before starting. */
    firstRun() {
        return UI.card({
            id: 'ads-first-run',
            title: t('ads.notConfigured.title'),
            body: html`
                <p dir="auto">${t('ads.notConfigured.body')}</p>
                <ol class="ads-steps">
                    <li>${t('ads.notConfigured.step1')}</li>
                    <li>${t('ads.notConfigured.step2')}</li>
                    <li>${t('ads.notConfigured.step3')}</li>
                </ol>
                <p class="form-hint">${t('ads.notConfigured.note')}</p>
                <div class="ads-actions">${UI._anchorButton({ href: '#/settings?s=ads', label: t('ads.notConfigured.cta'), icon: 'settings', variant: 'primary' })}</div>
            `,
        });
    },

    /** Configured, but Meta would not describe the account (a token that lapsed, an account that was removed): say so instead of showing empty numbers. */
    accountProblem() {
        const d = this.data;
        return UI.card({
            id: 'ads-account-problem',
            tone: 'warning',
            title: t('ads.account.error'),
            body: html`
                ${d.accountError ? html`<p dir="auto">${d.accountError}</p>` : ''}
                <p class="form-hint">${t('ads.account.errorHint')}</p>
                <div class="ads-actions">
                    ${UI.button({ variant: 'primary', icon: 'rotate-cw', label: t('common.retry'), action: 'ads:refresh', focusKey: 'ads-retry' })}
                    ${UI._anchorButton({ href: '#/settings?s=ads', label: t('ads.notConfigured.cta'), icon: 'settings', variant: 'secondary' })}
                </div>
            `,
        });
    },

    accountStatusChip(account) {
        const label = this.ACCOUNT_STATUSES.includes(account.statusLabel) ? account.statusLabel : 'other';
        const tone = label === 'active' ? 'badge-success' : (label === 'disabled' || label === 'closed' ? 'badge-danger' : 'badge-warning');
        return html`<span class="badge ${html.raw(tone)}" data-ads-account-status="${label}">${t(`ads.account.status.${label}`)}</span>`;
    },

    /**
     * No payment method yet. Meta's API cannot add one, so this is the screen's one obvious next step, in a calm tone (info, not an alarm):
     * everything else works, the steps are numbered, and "Check again" brings the owner back from Meta without hunting for Refresh.
     */
    paymentCard() {
        const a = this.account();
        if (!a) return '';
        // Meta did not say (`null`): nothing is blocked, but the owner is told once, with the same way to Meta's billing page.
        if (a.hasPaymentMethod === null || a.hasPaymentMethod === undefined) {
            return UI.card({
                tone: 'info',
                id: 'ads-payment-unknown',
                className: 'ads-payment-missing',
                title: t('ads.payment.unknownTitle'),
                body: html`
                    <p dir="auto">${t('ads.payment.unknownBody')}</p>
                    <div class="ads-actions">${UI._anchorButton({ href: a.billingUrl, label: t('ads.payment.addButton'), icon: 'external-link', variant: 'secondary' })}</div>
                `,
            });
        }
        if (a.hasPaymentMethod !== false) return '';
        return UI.card({
            tone: 'info',
            id: 'ads-payment-missing',
            className: 'ads-payment-missing',
            title: t('ads.payment.missingTitle'),
            body: html`
                <p dir="auto">${t('ads.payment.missingBody')}</p>
                <ol class="ads-steps">
                    <li>${t('ads.payment.step1')}</li>
                    <li>${t('ads.payment.step2')}</li>
                    <li>${t('ads.payment.step3')}</li>
                </ol>
                <div class="ads-actions">
                    ${UI._anchorButton({ href: a.billingUrl, label: t('ads.payment.addButton'), icon: 'external-link', variant: 'primary' })}
                    ${UI.button({ variant: 'secondary', icon: 'rotate-cw', label: t('ads.payment.check'), action: 'ads:refresh', focusKey: 'ads-payment-check' })}
                </div>
            `,
        });
    },

    /** The account: who it is, whether it can run ads, how it is paid for, and the way out to Meta for what this screen does not do. */
    accountStrip() {
        const a = this.data.account;
        let payment;
        if (a.hasPaymentMethod === true) {
            payment = html`<span class="ads-state text-success"><i data-lucide="check-circle" aria-hidden="true"></i> ${a.paymentMethod ? t('ads.payment.onWith') : t('ads.payment.on')}</span>${a.paymentMethod ? html` <span dir="auto">${a.paymentMethod}</span>` : ''}`;
        } else if (a.hasPaymentMethod === false) {
            payment = html`<span class="ads-state text-warning"><i data-lucide="alert-circle" aria-hidden="true"></i> ${t('ads.payment.off')}</span>`;
        } else {
            payment = html`<span class="form-hint">${t('ads.payment.unknown')}</span>`;
        }
        const open = UI._anchorButton({ href: a.adsManagerUrl, label: t('ads.account.openManager'), icon: 'external-link', variant: 'ghost', size: 'sm' });
        return UI.card({
            id: 'ads-account',
            title: t('ads.account.title'),
            actions: open,
            body: html`
                <dl class="ads-account-grid">
                    <div><dt class="form-hint">${t('ads.account.name')}</dt><dd><span dir="auto">${a.name || '—'}</span> <span class="form-hint">${UI.ltr(a.id || '')}</span></dd></div>
                    <div><dt class="form-hint">${t('ads.account.status')}</dt><dd>${this.accountStatusChip(a)}${a.disableReason ? html` <span class="form-hint" dir="auto">${a.disableReason}</span>` : ''}</dd></div>
                    <div><dt class="form-hint">${t('ads.account.payment')}</dt><dd>${payment}</dd></div>
                </dl>
            `,
        });
    },

    statCard(o) {
        return html`
            <div class="stat-card surface ads-stat ${o.warn ? html.raw('ads-stat--warn') : ''}" id="${o.id}">
                <div class="stat-header">
                    <span class="stat-label">${o.label}</span>
                    <span class="stat-icon"><i data-lucide="${o.icon}" aria-hidden="true"></i></span>
                </div>
                <p class="stat-value">${o.value}</p>
                ${o.sub || ''}
            </div>
        `;
    },

    /**
     * Three figures, not five: what was spent today, what was spent this month against the cap (the meter lives here, where the two are
     * compared), and the most the month could reach if nothing is paused. The two limits the owner set are one line below (`limitsRow`).
     */
    spendCards() {
        const d = this.data;
        const spend = d.spend || {};
        const limits = d.limits || {};
        const hasCap = limits.monthlyCap !== null && limits.monthlyCap !== undefined;
        const month = spend.thisMonth;

        let monthSub;
        if (hasCap) {
            const used = Number.isFinite(Number(month)) && month !== null ? Number(month) : null;
            monthSub = html`
                ${used === null ? html`<p class="stat-sub">${t('ads.cap.unknown')}</p>` : html`
                    <progress class="studio-meter ads-meter" max="${Number(limits.monthlyCap)}" value="${Math.min(used, Number(limits.monthlyCap))}"
                        aria-label="${t('ads.cap.used', { spent: this.money(used), cap: this.money(limits.monthlyCap) })}"></progress>
                    <p class="stat-sub">${t('ads.cap.used', { spent: this.money(used), cap: this.money(limits.monthlyCap) })}</p>`}
                <p class="stat-sub">${t('ads.cap.committed', { amount: this.money(limits.committedThisMonth) })}</p>
            `;
        } else {
            monthSub = html`<p class="stat-sub">${t('ads.cap.none')}</p>`;
        }

        const worst = limits.worstCaseThisMonth;
        const overCap = hasCap && worst !== null && worst !== undefined && Number(worst) > Number(limits.monthlyCap);
        const worstSub = html`
            <p class="stat-sub">${t('ads.worst.hint')}</p>
            ${overCap ? html`<p class="stat-sub text-warning"><i data-lucide="alert-triangle" aria-hidden="true"></i> ${t('ads.worst.overCap', { cap: this.money(limits.monthlyCap) })}</p>` : ''}
        `;

        return html`
            <div class="stats-grid ads-stats" id="ads-stats">
                ${this.statCard({ id: 'ads-stat-today', label: t('ads.spend.today'), icon: 'clock', value: this.money(spend.today) })}
                ${this.statCard({ id: 'ads-stat-month', label: t('ads.spend.month'), icon: 'calendar-days', value: this.money(month), sub: monthSub })}
                ${this.statCard({ id: 'ads-stat-worst', label: t('ads.worst.label'), icon: 'trending-up', value: this.money(worst), sub: worstSub, warn: overCap })}
            </div>
        `;
    },

    /** The two limits the server enforces, in one line, with the way to change them. */
    limitsRow() {
        const limits = (this.data && this.data.limits) || {};
        const has = (v) => v !== null && v !== undefined;
        return html`
            <div class="ads-limits surface" id="ads-limits">
                <p class="ads-limits-text">
                    <strong>${t('ads.limits.title')}</strong>
                    <span>${has(limits.maxDailyBudget) ? t('ads.limits.maxDaily', { amount: this.money(limits.maxDailyBudget) }) : t('ads.limits.maxDailyNone')}</span>
                    <span>${has(limits.monthlyCap) ? t('ads.limits.cap', { amount: this.money(limits.monthlyCap) }) : t('ads.limits.capNone')}</span>
                </p>
                ${UI._anchorButton({ href: '#/settings?s=ads', label: t('ads.limits.change'), icon: 'sliders-horizontal', variant: 'ghost', size: 'sm' })}
                ${has(limits.monthlyCap) ? html`<p class="form-hint ads-limits-note" id="ads-autopause">${t('ads.cap.autoPause')}</p>` : ''}
            </div>
        `;
    },

    summaryText() {
        const rows = this.campaigns();
        const active = rows.filter((c) => c.status === 'ACTIVE').length;
        return t('ads.summary', { active: UI.formatNumber(active), total: UI.formatNumber(rows.length) });
    },

    /** The campaigns region only: an action repaints this, not the page, so the spend cards do not blink. */
    paintCampaigns() {
        const host = document.getElementById('ads-campaigns');
        if (!host) return;
        const focus = UI.captureFocus(host);
        host.innerHTML = esc(this.campaignsMarkup());
        UI.icons(host);
        UI.restoreFocus(focus);
        const summary = document.getElementById('ads-summary');
        if (summary) summary.innerHTML = esc(this.summaryText());
    },

    /** Running campaigns first: they are the ones that spend, so they are what a glance should find. The order within each group is the server's. */
    sortedCampaigns() {
        return this.campaigns().slice().sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE'));
    },

    campaignsMarkup() {
        const noPayment = this.account() && this.account().hasPaymentMethod === false;
        return UI.table({
            id: 'ads-table',
            caption: t('ads.campaigns.title'),
            rows: this.sortedCampaigns(),
            empty: {
                icon: 'megaphone',
                title: t('ads.empty.title'),
                body: t('ads.empty.body'),
                action: { label: t('ads.empty.cta'), href: '#/posts', icon: 'calendar-days' },
            },
            columns: [
                { key: 'name', label: t('ads.col.name'), card: 'head', render: (c) => this.nameCell(c) },
                { key: 'effectiveStatus', label: t('ads.col.status'), card: 'badge', render: (c) => this.statusChip(c.effectiveStatus || c.status) },
                { key: 'budget', label: t('ads.col.budget'), render: (c) => this.budgetCell(c) },
                { key: 'spend', label: t('ads.col.spend'), align: 'end', render: (c) => this.money(c.insights ? c.insights.spend : null) },
                { key: 'reach', label: t('ads.col.reach'), align: 'end', render: (c) => this.count(c.insights ? c.insights.reach : null) },
                { key: 'clicks', label: t('ads.col.clicks'), align: 'end', render: (c) => this.count(c.insights ? c.insights.clicks : null) },
                { key: 'results', label: t('ads.col.results'), align: 'end', render: (c) => this.count(c.insights ? c.insights.results : null) },
                { key: 'actions', label: t('ads.col.actions'), render: (c) => this.actionsCell(c, noPayment) },
            ],
        });
    },

    /** The name, its goal in words, and where it came from: a boost made here (with the way to its post) or a campaign made in Meta. */
    nameCell(c) {
        const name = String(c.name || c.id || '—');
        return html`
            <span class="ads-name">
                <strong dir="auto">${name}</strong>
                <span class="ads-name-sub">${this.objectiveWord(c.objective)}</span>
                ${c.boostId
                    ? html`<span class="ads-name-meta"><span class="badge badge-info">${t('ads.boost.chip')}</span> <a class="ads-post-link" href="#/posts" aria-label="${t('ads.actionFor', { action: t('ads.boost.post'), name: this.isolate(name) })}">${t('ads.boost.post')}</a></span>`
                    : html`<span class="ads-name-sub">${t('ads.origin.meta')}</span>`}
            </span>
        `;
    },

    /** The budget, and below it when the campaign ends (or that nothing ends it). */
    budgetCell(c) {
        return html`<span class="ads-budget"><span>${this.budgetText(c.budget)}</span><span class="ads-name-sub">${c.endTime ? t('ads.col.endsOn', { date: this.dayText(c.endTime) }) : t('ads.col.noEnd')}</span></span>`;
    },

    actionsCell(c, noPayment) {
        const id = String(c.id);
        const active = c.status === 'ACTIVE';
        const name = this.isolate(c.name || c.id);
        // A button that says only "Pause" is read out of its row by a screen reader: the name says which campaign it is for.
        const label = (key) => t('ads.actionFor', { action: t(key), name });
        const buttons = [];
        if (!active && !this.NOT_RUNNABLE.includes(c.status)) {
            // Without a payment method Activate stays pressable (a disabled button cannot say why, and a tooltip is not on a phone): it explains,
            // and it is not the primary action while that is the case.
            buttons.push(UI.button({
                variant: noPayment ? 'secondary' : 'primary', size: 'sm', icon: 'play', label: t('ads.activate'),
                action: noPayment ? 'ads:needPayment' : 'ads:activate', data: { id }, focusKey: `ads-activate-${id}`, ariaLabel: label('ads.activate'),
            }));
        }
        if (active) {
            buttons.push(UI.button({ variant: 'secondary', size: 'sm', icon: 'pause', label: t('ads.pause'), action: 'ads:pause', data: { id }, focusKey: `ads-pause-${id}`, ariaLabel: label('ads.pause') }));
        }
        if (c.budget && c.budget.editable) {
            buttons.push(UI.button({ variant: 'secondary', size: 'sm', icon: 'pencil', label: t('ads.editBudget'), action: 'ads:editBudget', data: { id }, focusKey: `ads-edit-${id}`, ariaLabel: label('ads.editBudget') }));
        }
        if (!active) {
            buttons.push(UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('common.delete'), action: 'ads:remove', data: { id }, focusKey: `ads-delete-${id}`, ariaLabel: label('common.delete') }));
        }
        return html`<div class="ads-actions">${buttons}</div>`;
    },

    /** Put the server's answer for one campaign in the list (its insights kept when the answer has none) and repaint the table. */
    applyCampaign(campaign) {
        if (!campaign || campaign.id === undefined || campaign.id === null || !this.data) return;
        const list = this.campaigns();
        const index = list.findIndex((c) => String(c.id) === String(campaign.id));
        if (index === -1) return;
        list[index] = Object.assign({}, list[index], campaign);
        this.data.campaigns = list;
        this.paintCampaigns();
    },

    // ─── Activate: STARTS SPENDING MONEY ─────────────────────────────────────

    /** The ad account has no payment method: Activate explains, and takes the owner to Meta's billing page if they say so. */
    needPayment() {
        const account = this.account();
        const href = account && account.billingUrl ? UI._href(account.billingUrl) : '';
        UI.confirm({
            title: t('ads.needPayment.title'),
            body: t('ads.needPayment.body'),
            hint: t('ads.needPayment.hint'),
            tone: 'primary',
            confirmLabel: t('ads.payment.addButton'),
            confirmIcon: 'external-link',
            cancelLabel: t('ads.needPayment.later'),
            onConfirm: () => { if (href && typeof window.open === 'function') window.open(href, '_blank', 'noopener,noreferrer'); },
        });
    },

    /** What a campaign is allowed to spend, in a phrase: "up to 5 USD a day", "up to 40 USD in total", or "the budget set on each of its ad sets". */
    budgetPhrase(budget) {
        const b = budget || {};
        if (b.kind === 'daily' && b.amount !== null && b.amount !== undefined) return t('ads.activate.budget.daily', { amount: this.money(b.amount) });
        if (b.kind === 'lifetime' && b.amount !== null && b.amount !== undefined) return t('ads.activate.budget.lifetime', { amount: this.money(b.amount) });
        return t('ads.activate.budget.none');
    },

    /**
     * How long money would be spent, as sentences: the end date, or that there is none; for a daily budget with an end date, the arithmetic
     * (days x amount) so the total is not a surprise; and what is left of this month's cap. The server checks the cap again.
     */
    durationFacts(budget, endTime) {
        const b = budget || {};
        const facts = [];
        const days = this.daysLeft(endTime);
        if (endTime) {
            facts.push(t('ads.activate.until', { date: this.dayText(endTime) }));
            if (b.kind === 'daily' && b.amount !== null && b.amount !== undefined && days !== null) {
                facts.push(t('ads.activate.estimate', { count: days, daily: this.money(b.amount), total: this.money(Number(b.amount) * days) }));
            }
        } else {
            facts.push(b.kind === 'daily' ? t('ads.activate.noEnd.daily') : t('ads.activate.noEnd.other'));
        }
        // Several ad sets, each with its own budget: Meta gives no single amount, so say that, instead of letting a missing number read as "free".
        if (b.kind !== 'daily' && b.kind !== 'lifetime') facts.push(t('ads.activate.checkSets'));
        const left = this.capLeft();
        const limits = (this.data && this.data.limits) || {};
        if (left !== null) facts.push(t('ads.edit.capLeft', { remaining: this.money(left), cap: this.money(limits.monthlyCap) }));
        return facts;
    },

    /** The payment method on the ad account in a sentence, or '' when Meta did not say. */
    payLine() {
        const a = this.account();
        if (a && a.paymentMethod) return t('ads.activate.payWith', { method: this.isolate(a.paymentMethod) });
        return a && (a.hasPaymentMethod === null || a.hasPaymentMethod === undefined) ? t('ads.activate.payUnknown') : '';
    },

    activate(id) {
        const c = this.findCampaign(id);
        if (!c || c.status === 'ACTIVE') return;
        const account = this.account();
        if (account && account.hasPaymentMethod === false) { this.needPayment(); return; }
        const hint = [...this.durationFacts(c.budget, c.endTime), this.payLine(), t('ads.activate.hint')].filter(Boolean).join(' ');
        UI.confirm({
            title: t('ads.activate.title'),
            body: t('ads.activate.body', { name: this.isolate(c.name || c.id), budget: this.budgetPhrase(c.budget), account: this.accountLabel() }),
            hint,
            confirmLabel: t('ads.activate.confirm'),
            confirmIcon: 'play',
            onConfirm: () => AdsPage.activateConfirmed(id),
        });
    },

    /** The question was answered yes. A refusal is thrown, so the dialog stays open and says why. */
    async activateConfirmed(id) {
        const answer = await API.setAdsCampaignStatus(id, 'ACTIVE', true);
        this.applyCampaign(answer && answer.campaign);
        UI.toast(t('ads.activated'), 'success');
        this.refreshQuiet();
    },

    async pause(el) {
        const id = el && el.dataset ? el.dataset.id : '';
        const restore = UI.actionBusy(el);
        if (!restore) return;
        let answer = null;
        try {
            answer = await API.setAdsCampaignStatus(id, 'PAUSED', false);
        } catch (err) {
            UI.toast(this.failure(err), 'error');
        } finally {
            restore();
        }
        if (answer && answer.campaign) {
            this.applyCampaign(answer.campaign);
            UI.toast(t('ads.paused'), 'success');
            this.refreshQuiet();
        }
    },

    // ─── Delete ──────────────────────────────────────────────────────────────

    remove(id) {
        const c = this.findCampaign(id);
        if (!c || c.status === 'ACTIVE') return;
        UI.confirm({
            title: t('ads.delete.title'),
            body: t('ads.delete.body', { name: this.isolate(c.name || c.id) }),
            hint: t('ads.delete.hint'),
            confirmLabel: t('common.delete'),
            onConfirm: () => AdsPage.removeConfirmed(id),
        });
    },

    async removeConfirmed(id) {
        await API.deleteAdsCampaign(id);
        if (this.data) this.data.campaigns = this.campaigns().filter((c) => String(c.id) !== String(id));
        this.paintCampaigns();
        UI.toast(t('ads.deleted'), 'success');
        // The row the focus was on is gone: it goes to the list's heading, not to the top of the page.
        this.focusOn('ads-campaigns-title');
        this.refreshQuiet();
    },

    // ─── Edit budget ─────────────────────────────────────────────────────────

    /** `2026-10-31` in the browser's own zone, for a date input. '' for anything that is not a date. */
    localDay(iso) {
        const d = iso ? new Date(iso) : null;
        if (!d || Number.isNaN(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },

    /** The end of the picked day in local time, as an ISO instant; null when the value is not a date. */
    endOfDayIso(value) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
        if (!m) return null;
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    },

    editBudget(id) {
        const c = this.findCampaign(id);
        if (!c || !c.budget || !c.budget.editable) return;
        const limits = (this.data && this.data.limits) || {};
        const lifetime = c.budget.kind === 'lifetime';
        const currency = this.currency();
        const hints = [];
        if (!lifetime && limits.maxDailyBudget !== null && limits.maxDailyBudget !== undefined) {
            hints.push(t('ads.edit.maxDaily', { max: this.money(limits.maxDailyBudget) }));
        }
        const left = this.capLeft();
        if (left !== null) hints.push(t('ads.edit.capLeft', { remaining: this.money(left), cap: this.money(limits.monthlyCap) }));
        const day = this.localDay(c.endTime);
        this._edit = { id: String(c.id), kind: c.budget.kind, day };
        // Said before the form, so nobody finds out after pressing Save: a running campaign spends the new amount from now on.
        const running = c.status === 'ACTIVE';
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">${t('ads.edit.title')}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <p class="ads-edit-name" dir="auto"><strong>${c.name || ''}</strong></p>
            <p class="form-hint ${running ? html.raw('text-warning') : ''}" id="ads-edit-state">${running ? t('ads.edit.running') : t('ads.edit.notRunning')}</p>
            <div id="ads-edit-error"></div>
            <form id="ads-edit-form" data-submit="ads:budgetSubmit" novalidate>
                <div class="form-group">
                    <label class="form-label" for="ads-amount">${lifetime ? t('ads.edit.total') : t('ads.edit.daily')} ${currency ? html`<span class="label-optional">${UI.ltr(currency)}</span>` : ''}</label>
                    <input class="field field-mono" id="ads-amount" name="amount" type="number" dir="ltr" inputmode="decimal" min="0" step="any"
                           value="${c.budget.amount === null || c.budget.amount === undefined ? '' : c.budget.amount}" aria-describedby="ads-amount-hint" required>
                    <p class="form-hint" id="ads-amount-hint">${hints.length ? hints.join(' ') : t('ads.edit.limitsServer')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="ads-end">${t('ads.edit.end')} <span class="label-optional">${t('common.optional')}</span></label>
                    <input class="field field-mono" id="ads-end" name="end" type="date" dir="ltr" min="${this.localDay(new Date().toISOString())}" value="${day}" aria-describedby="ads-end-hint">
                    <p class="form-hint" id="ads-end-hint">${t('ads.edit.endHint')}</p>
                </div>
                <div class="modal-actions">
                    ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'check', label: t('common.save') })}
                </div>
            </form>
        `);
    },

    showEditError(message, field) {
        const host = document.getElementById('ads-edit-error');
        const form = document.getElementById('ads-edit-form');
        if (form) UI.clearInvalid(form);
        if (!host) { UI.toast(message, 'error'); return; }
        const stripId = 'ads-edit-error-strip';
        host.innerHTML = esc(UI.errorStrip(message, '', stripId));
        UI.icons(host);
        const input = field && this.EDIT_FIELDS[field] ? document.getElementById(this.EDIT_FIELDS[field]) : null;
        if (input) UI.markInvalid(input, stripId);
        else if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    },

    /**
     * Whether this edit makes a RUNNING campaign spend more: a higher amount, or a later end. Only then is a question asked (lowering a
     * budget or ending sooner can only spend less). Answers `{ amountUp, endLater }` or null.
     */
    raiseOf(c, amount, endTime) {
        if (!c || c.status !== 'ACTIVE' || !c.budget) return null;
        const was = Number(c.budget.amount);
        const amountUp = Number.isFinite(was) && amount > was;
        const endLater = Boolean(endTime && c.endTime && Date.parse(endTime) > Date.parse(c.endTime));
        return amountUp || endLater ? { amountUp, endLater } : null;
    },

    /**
     * The question for a raise: from what to what, until when, the total it can add up to, who is charged. Drawn over the form (`stack`), so
     * "no" leaves the form as it was, and a refusal from the server (the cap, the daily maximum) is said inside the question.
     */
    confirmRaise(state, c, payload, raise) {
        const unit = state.kind === 'lifetime' ? 'ads.budget.lifetime' : 'ads.budget.daily';
        const to = { kind: state.kind, amount: payload.amount };
        const endTime = payload.endTime || c.endTime;
        const body = raise.amountUp
            ? t('ads.raise.body', {
                name: this.isolate(c.name || c.id), from: t(unit, { amount: this.money(c.budget.amount) }), to: t(unit, { amount: this.money(payload.amount) }), account: this.accountLabel(),
            })
            : t('ads.raise.bodyEnd', { name: this.isolate(c.name || c.id), date: this.dayText(endTime), budget: t(unit, { amount: this.money(payload.amount) }), account: this.accountLabel() });
        const hint = [...this.durationFacts(to, endTime), this.payLine(), t('ads.activate.hint')].filter(Boolean).join(' ');
        UI.confirm({
            stack: true,
            title: t('ads.raise.title'),
            body,
            hint,
            confirmLabel: t('ads.raise.confirm'),
            confirmIcon: 'trending-up',
            cancelLabel: t('ads.raise.back'),
            // The server requires `confirm: true` for a raise on a running campaign; only the answer "yes" sends it.
            onConfirm: () => AdsPage.saveBudget(state, Object.assign({}, payload, { confirm: true })),
        });
    },

    /** Send the budget. A refusal is thrown (the question or the form shows it); success closes the form and puts the new numbers on screen. */
    async saveBudget(state, payload) {
        const answer = await API.setAdsCampaignBudget(state.id, payload);
        if (this._edit !== state) return;
        this._edit = null;
        UI.closeModal();
        this.applyCampaign(answer && answer.campaign);
        UI.toast(t('ads.edit.saved'), 'success');
        this.refreshQuiet();
    },

    async budgetSubmit(form, event) {
        event.preventDefault();
        const state = this._edit;
        if (!state || !form) return;
        const host = document.getElementById('ads-edit-error');
        if (host) host.innerHTML = '';
        const raw = String(form.elements.amount ? form.elements.amount.value : '').trim();
        const amount = raw === '' ? NaN : Number(raw);
        const end = String(form.elements.end ? form.elements.end.value : '').trim();
        const limits = (this.data && this.data.limits) || {};
        if (!Number.isFinite(amount) || amount <= 0) { this.showEditError(t('ads.err.amount'), 'amount'); return; }
        if (state.kind === 'daily' && limits.maxDailyBudget !== null && limits.maxDailyBudget !== undefined && amount > Number(limits.maxDailyBudget)) {
            this.showEditError(t('ads.err.overMax', { max: this.money(limits.maxDailyBudget) }), 'amount');
            return;
        }
        const payload = { amount };
        if (end && end !== state.day) {
            const iso = this.endOfDayIso(end);
            if (!iso) { this.showEditError(t('ads.err.end'), 'endTime'); return; }
            if (Date.parse(iso) <= Date.now()) { this.showEditError(t('ads.err.endPast'), 'endTime'); return; }
            payload.endTime = iso;
        }
        const c = this.findCampaign(state.id);
        const raise = this.raiseOf(c, amount, payload.endTime);
        if (raise) { this.confirmRaise(state, c, payload, raise); return; }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await this.saveBudget(state, payload);
        } catch (err) {
            restore();
            const code = err && err.code;
            const budget = code === 'BUDGET_OVER_DAILY_MAX' || code === 'BUDGET_OVER_MONTHLY_CAP';
            const field = (err && err.body && err.body.field) || (budget ? 'amount' : '');
            this.showEditError(this.failure(err), field);
        }
    },
};

UI.registerActions('ads', {
    refresh: (el) => AdsPage.refresh(el),
    activate: (el) => AdsPage.activate(el.dataset.id),
    needPayment: () => AdsPage.needPayment(),
    pause: (el) => AdsPage.pause(el),
    remove: (el) => AdsPage.remove(el.dataset.id),
    editBudget: (el) => AdsPage.editBudget(el.dataset.id),
    budgetSubmit: (el, e) => AdsPage.budgetSubmit(el, e),
});
