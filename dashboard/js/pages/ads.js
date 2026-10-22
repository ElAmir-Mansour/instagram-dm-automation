/**
 * Ads — `#/ads`, the workspace OWNER's: every campaign on the Meta ad account (the boosts made from Posts, and the ones made in Meta), what
 * has been spent, the limits the owner set in Settings, and the four things that can be done to a campaign: Activate, Pause, Edit budget, Delete.
 *
 * ─── Money rules, said on the screen ────────────────────────────────────────
 * ACTIVATE STARTS SPENDING real money on the ad account, so it is never one click: the question names the budget (a day, or the total),
 * the account, the end date when there is one, and that the account's payment method is charged. Only the answer "yes" sends
 * `confirm: true`. Pause is one click (it stops spending), Delete asks first, and an ACTIVE campaign offers no Delete at all.
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
            ${Motion.statsGrid(4)}
            ${Motion.tableCard(4, [t('ads.col.name'), t('ads.col.status'), t('ads.col.budget'), t('ads.col.spend'), ''])}
            ${Motion.busy()}
        `;
    },

    render() {
        return this.load();
    },

    async load() {
        const container = document.getElementById('page-container');
        if (!container) return;
        if (!this.isOwner()) {
            this.view = 'forbidden';
            this.paint(container);
            return;
        }
        const seq = ++this._seq;
        const gate = Motion.beginLoad(container, () => this.skeleton());
        let answer;
        try {
            answer = await API.getAdsOverview();
        } catch (err) {
            gate.done();
            if (seq !== this._seq) return;
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
            return;
        }
        gate.done();
        if (seq !== this._seq) return;
        this.data = answer && typeof answer === 'object' ? answer : { configured: false };
        this.view = 'ready';
        this.paint(container);
        Motion.announce(t('ads.loaded', { count: this.campaigns().length }));
    },

    /** After an action the spend numbers have moved: ask again, quietly. A failure leaves the last answer. */
    async refreshQuiet() {
        const seq = ++this._seq;
        try {
            const answer = await API.getAdsOverview();
            if (seq !== this._seq || !answer || typeof answer !== 'object') return;
            this.data = answer;
            this.view = 'ready';
            const container = document.getElementById('page-container');
            if (container && document.getElementById('ads-page')) this.paint(container);
        } catch (err) { /* keep what was known */ }
    },

    async refresh(el) {
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            await this.load();
        } finally {
            restore();
        }
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

    // ─── Painting ────────────────────────────────────────────────────────────

    paint(container) {
        if (!container) return;
        const focus = UI.captureFocus(container);
        container.innerHTML = esc(this.markup());
        UI.icons(container);
        UI.restoreFocus(focus);
    },

    markup() {
        const refresh = UI.button({
            variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('ads.refresh'), action: 'ads:refresh', focusKey: 'ads-refresh',
        });
        const header = UI.pageHeader({
            title: t('ads.head.title'),
            actions: this.view === 'ready' && this.data && this.data.configured ? refresh : '',
        });
        if (this.view === 'forbidden') {
            return html`<div id="ads-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.owner.title'), body: t('ads.owner.body') })}</div>`;
        }
        const data = this.data || {};
        if (!data.configured) {
            return html`<div id="ads-page" class="ads-page">${header}${UI.emptyState({
                icon: 'megaphone',
                title: t('ads.notConfigured.title'),
                body: t('ads.notConfigured.body'),
                action: { label: t('ads.notConfigured.cta'), href: '#/settings?s=ads', icon: 'settings' },
            })}</div>`;
        }
        return html`
            <div id="ads-page" class="ads-page">
                ${header}
                ${this.accountStrip()}
                ${this.spendCards()}
                <section class="section" id="ads-campaigns-section" aria-labelledby="ads-campaigns-title">
                    <h2 class="section-title" id="ads-campaigns-title">${t('ads.campaigns.title')}</h2>
                    <div id="ads-campaigns">${this.campaignsMarkup()}</div>
                </section>
            </div>
        `;
    },

    accountStatusChip(account) {
        const label = this.ACCOUNT_STATUSES.includes(account.statusLabel) ? account.statusLabel : 'other';
        const tone = label === 'active' ? 'badge-success' : (label === 'disabled' || label === 'closed' ? 'badge-danger' : 'badge-warning');
        return html`<span class="badge ${html.raw(tone)}" data-ads-account-status="${label}">${t(`ads.account.status.${label}`)}</span>`;
    },

    /** The account: who it is, whether it can run ads, how it is paid for, and the way out to Meta for what this screen does not do. */
    accountStrip() {
        const d = this.data;
        const a = d.account;
        if (!a) {
            return html`<div class="mbe-4">${UI.errorStrip(t('ads.account.error'), d.accountError || '', 'ads-account-error-strip')}</div>`;
        }
        let payment;
        if (a.hasPaymentMethod === true) {
            payment = a.paymentMethod
                ? html`<span class="text-success">${t('ads.payment.onWith')}</span> <span dir="auto">${a.paymentMethod}</span>`
                : html`<span class="text-success">${t('ads.payment.on')}</span>`;
        } else if (a.hasPaymentMethod === false) {
            payment = html`<span class="text-warning">${t('ads.payment.off')}</span>`;
        } else {
            payment = html`<span class="form-hint">${t('ads.payment.unknown')}</span>`;
        }
        const open = UI._anchorButton({ href: a.adsManagerUrl, label: t('ads.account.openManager'), icon: 'external-link', variant: 'ghost', size: 'sm' });
        const missing = a.hasPaymentMethod === false ? UI.card({
            tone: 'warning',
            id: 'ads-payment-missing',
            className: 'ads-payment-missing',
            title: t('ads.payment.missingTitle'),
            body: html`
                <p dir="auto">${t('ads.payment.missingBody')}</p>
                <div class="ads-actions">${UI._anchorButton({ href: a.billingUrl, label: t('ads.payment.addButton'), icon: 'external-link', variant: 'primary' })}</div>
            `,
        }) : '';
        const strip = UI.card({
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
        return html`<div class="ads-account-block">${missing}${strip}</div>`;
    },

    statCard(o) {
        return html`
            <div class="stat-card surface ads-stat" id="${o.id}">
                <div class="stat-header">
                    <span class="stat-label">${o.label}</span>
                    <span class="stat-icon"><i data-lucide="${o.icon}" aria-hidden="true"></i></span>
                </div>
                <p class="stat-value">${o.value}</p>
                ${o.sub || ''}
            </div>
        `;
    },

    spendCards() {
        const d = this.data;
        const spend = d.spend || {};
        const limits = d.limits || {};
        const hasCap = limits.monthlyCap !== null && limits.monthlyCap !== undefined;
        const month = spend.thisMonth;

        let capSub = '';
        if (hasCap) {
            const used = Number.isFinite(Number(month)) && month !== null ? Number(month) : null;
            capSub = html`
                ${used === null ? html`<p class="stat-sub">${t('ads.cap.unknown')}</p>` : html`
                    <progress class="studio-meter ads-meter" max="${Number(limits.monthlyCap)}" value="${Math.min(used, Number(limits.monthlyCap))}"
                        aria-label="${t('ads.cap.used', { spent: this.money(used), cap: this.money(limits.monthlyCap) })}"></progress>
                    <p class="stat-sub">${t('ads.cap.used', { spent: this.money(used), cap: this.money(limits.monthlyCap) })}</p>`}
                <p class="stat-sub">${t('ads.cap.committed', { amount: this.money(limits.committedThisMonth) })}</p>
            `;
        } else {
            capSub = html`<p class="stat-sub">${t('ads.cap.none')}</p>`;
        }

        const worst = limits.worstCaseThisMonth;
        const overCap = hasCap && worst !== null && worst !== undefined && Number(worst) > Number(limits.monthlyCap);
        const worstSub = html`
            <p class="stat-sub">${t('ads.worst.hint')}</p>
            ${overCap ? html`<p class="stat-sub text-warning">${t('ads.worst.overCap', { cap: this.money(limits.monthlyCap) })}</p>` : ''}
        `;

        return html`
            <div class="stats-grid ads-stats" id="ads-stats">
                ${this.statCard({ id: 'ads-stat-today', label: t('ads.spend.today'), icon: 'clock', value: this.money(spend.today) })}
                ${this.statCard({ id: 'ads-stat-month', label: t('ads.spend.month'), icon: 'calendar-days', value: this.money(month) })}
                ${this.statCard({ id: 'ads-stat-cap', label: t('ads.cap.label'), icon: 'lock', value: hasCap ? this.money(limits.monthlyCap) : t('ads.cap.noneShort'), sub: capSub })}
                ${this.statCard({ id: 'ads-stat-worst', label: t('ads.worst.label'), icon: 'trending-up', value: this.money(worst), sub: worstSub })}
                ${this.statCard({ id: 'ads-stat-maxdaily', label: t('ads.maxDaily.label'), icon: 'megaphone', value: this.money(limits.maxDailyBudget), sub: html`<p class="stat-sub">${t('ads.maxDaily.hint')}</p>` })}
            </div>
        `;
    },

    /** The campaigns region only: an action repaints this, not the page, so the spend cards do not blink. */
    paintCampaigns() {
        const host = document.getElementById('ads-campaigns');
        if (!host) return;
        const focus = UI.captureFocus(host);
        host.innerHTML = esc(this.campaignsMarkup());
        UI.icons(host);
        UI.restoreFocus(focus);
    },

    campaignsMarkup() {
        const rows = this.campaigns();
        const noPayment = this.account() && this.account().hasPaymentMethod === false;
        return UI.table({
            id: 'ads-table',
            caption: t('ads.campaigns.title'),
            rows,
            empty: {
                icon: 'megaphone',
                title: t('ads.empty.title'),
                body: t('ads.empty.body'),
                action: { label: t('ads.empty.cta'), href: '#/posts', icon: 'calendar-days' },
            },
            columns: [
                { key: 'name', label: t('ads.col.name'), card: 'head', render: (c) => this.nameCell(c) },
                { key: 'effectiveStatus', label: t('ads.col.status'), card: 'badge', render: (c) => this.statusChip(c.effectiveStatus || c.status) },
                { key: 'objective', label: t('ads.col.objective'), render: (c) => this.objectiveWord(c.objective) },
                { key: 'budget', label: t('ads.col.budget'), render: (c) => this.budgetText(c.budget) },
                { key: 'endTime', label: t('ads.col.ends'), render: (c) => this.dayText(c.endTime) },
                { key: 'spend', label: t('ads.col.spend'), align: 'end', render: (c) => this.money(c.insights ? c.insights.spend : null) },
                { key: 'reach', label: t('ads.col.reach'), align: 'end', render: (c) => this.count(c.insights ? c.insights.reach : null) },
                { key: 'clicks', label: t('ads.col.clicks'), align: 'end', render: (c) => this.count(c.insights ? c.insights.clicks : null) },
                { key: 'results', label: t('ads.col.results'), align: 'end', render: (c) => this.count(c.insights ? c.insights.results : null) },
                { key: 'actions', label: t('ads.col.actions'), render: (c) => this.actionsCell(c, noPayment) },
            ],
        });
    },

    nameCell(c) {
        return html`
            <span class="ads-name">
                <strong dir="auto">${c.name || '—'}</strong>
                ${c.boostId ? html`<span class="ads-name-meta"><span class="badge badge-info">${t('ads.boost.chip')}</span> <a class="ads-post-link" href="#/posts">${t('ads.boost.post')}</a></span>` : ''}
            </span>
        `;
    },

    actionsCell(c, noPayment) {
        const id = String(c.id);
        const active = c.status === 'ACTIVE';
        const buttons = [];
        if (!active && !this.NOT_RUNNABLE.includes(c.status)) {
            buttons.push(UI.button({
                variant: 'primary', size: 'sm', icon: 'play', label: t('ads.activate'), action: 'ads:activate', data: { id }, focusKey: `ads-activate-${id}`,
                disabled: noPayment, title: noPayment ? t('ads.activate.noPayment') : '',
            }));
        }
        if (active) {
            buttons.push(UI.button({ variant: 'secondary', size: 'sm', icon: 'pause', label: t('ads.pause'), action: 'ads:pause', data: { id }, focusKey: `ads-pause-${id}` }));
        }
        if (c.budget && c.budget.editable) {
            buttons.push(UI.button({ variant: 'secondary', size: 'sm', icon: 'pencil', label: t('ads.editBudget'), action: 'ads:editBudget', data: { id }, focusKey: `ads-edit-${id}` }));
        }
        if (!active) {
            buttons.push(UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('common.delete'), action: 'ads:remove', data: { id }, focusKey: `ads-delete-${id}` }));
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

    activate(id) {
        const c = this.findCampaign(id);
        if (!c || c.status === 'ACTIVE') return;
        const account = this.account();
        if (account && account.hasPaymentMethod === false) return;
        const budget = c.budget || {};
        let phrase;
        if (budget.kind === 'daily' && budget.amount !== null && budget.amount !== undefined) phrase = t('ads.activate.budget.daily', { amount: this.money(budget.amount) });
        else if (budget.kind === 'lifetime' && budget.amount !== null && budget.amount !== undefined) phrase = t('ads.activate.budget.lifetime', { amount: this.money(budget.amount) });
        else phrase = t('ads.activate.budget.none');
        const until = c.endTime ? `${t('ads.activate.until', { date: this.dayText(c.endTime) })} ` : '';
        UI.confirm({
            title: t('ads.activate.title'),
            body: t('ads.activate.body', {
                name: this.isolate(c.name || c.id), budget: phrase, account: this.isolate((account && (account.name || account.id)) || ''),
            }),
            hint: `${until}${t('ads.activate.hint')}`,
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
        if (limits.monthlyCap !== null && limits.monthlyCap !== undefined) {
            const remaining = Math.max(0, Number(limits.monthlyCap) - (Number(limits.committedThisMonth) || 0));
            hints.push(t('ads.edit.capLeft', { remaining: this.money(remaining), cap: this.money(limits.monthlyCap) }));
        }
        const day = this.localDay(c.endTime);
        this._edit = { id: String(c.id), kind: c.budget.kind, day };
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">${t('ads.edit.title')}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <p class="form-hint" dir="auto">${c.name || ''}</p>
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
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            const answer = await API.setAdsCampaignBudget(state.id, payload);
            if (this._edit !== state) return;
            this._edit = null;
            UI.closeModal();
            this.applyCampaign(answer && answer.campaign);
            UI.toast(t('ads.edit.saved'), 'success');
            this.refreshQuiet();
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
    pause: (el) => AdsPage.pause(el),
    remove: (el) => AdsPage.remove(el.dataset.id),
    editBudget: (el) => AdsPage.editBudget(el.dataset.id),
    budgetSubmit: (el, e) => AdsPage.budgetSubmit(el, e),
});
