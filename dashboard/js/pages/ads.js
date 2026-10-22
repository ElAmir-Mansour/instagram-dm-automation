/**
 * Ads — `#/ads`, the Overview of the workspace OWNER's Meta ads: what needs attention, what has been spent against the limits the owner set in
 * Settings, the changes waiting to be sent, and the way into the Campaigns tab (`ads_campaigns.js`, where every campaign, ad set and ad is
 * listed and changed). This screen lists no campaigns and changes nothing.
 *
 * ─── The stored copy only ───────────────────────────────────────────────────
 * `GET /ads/overview` reads the stored copy, never Meta (research R2): the account as the last health check saw it, the spend of the last sync,
 * the objects that need attention and the queued changes. So the screen says when it was last updated (`syncedAt`), and that the last three
 * days of results can still be revised by Meta (`provisionalFrom`). It never calls `GET /ads/money` (that reads Meta live and costs points).
 *
 * ─── First run ──────────────────────────────────────────────────────────────
 * Not configured (`GET /ads/overview` answers 200 `{ configured: false, steps }`, never an error): the server's four steps (token, account,
 * payment, limits), each done or not with its own hint and a help link, and one way in (Settings). Configured but the ad account has NO payment method (Meta's API cannot add one):
 * a calm card at the top with numbered steps, the one primary button (Meta's billing page, a new tab) and "Check again". Configured but the
 * account cannot be read: one card that says so, with Retry, rather than empty numbers.
 *
 * ─── Money, said on the screen ──────────────────────────────────────────────
 * Every money figure is the server's `overview.money`, from the stored copy, and the screen says once that they exclude tax: Meta's invoices
 * are the accounting record. A null number is "—", never 0: a zero would say nothing was spent.
 *
 * ─── Two things that must never be silent ───────────────────────────────────
 * `guard.blind` (the hourly spend check has not succeeded for two hours: nothing is watching the cap) and `tokenHealth: 'dead'` (Meta no
 * longer accepts the token) are banners at the top of the screen, above everything, each with the way out.
 *
 * ─── Silent where it should be ──────────────────────────────────────────────
 * A member who is not the owner, or a 403 from the API, gets a calm "owners only" panel and no error toast, the same silence the Settings
 * card and Posts keep (`App.canAdminister()`); a 404 (`ADS_DISABLED`: Ads is off for this workspace) gets an equally calm "not available" panel.
 */
const AdsPage = {
    /** The server's GET /ads/overview answer; null until the first one. */
    data: null,
    /** 'loading' | 'ready' | 'forbidden' | 'disabled' | 'failed' */
    view: 'loading',
    /** Bumped on every read and on destroy(), so a slow answer cannot land on another screen. */
    _seq: 0,
    /** When the last answer came, as an ISO instant: the page says how fresh its numbers are. */
    _loadedAt: null,

    ACCOUNT_STATUSES: Object.freeze(['active', 'disabled', 'unsettled', 'pending_review', 'closed', 'other']),
    TOKEN_HEALTHS: Object.freeze(['ok', 'expiring', 'dead', 'unknown']),
    ATTENTION_KINDS: Object.freeze(['rejected', 'issues', 'billing', 'op_failed']),
    OP_KINDS: Object.freeze(['status', 'budget', 'archive', 'delete', 'update', 'create']),
    OP_STATES: Object.freeze(['pending', 'running', 'verify']),

    resetTenantState() {
        this._seq++;
        this.data = null;
        this.view = 'loading';
        this._loadedAt = null;
    },

    destroy() {
        this._seq++;
    },

    // ─── Reading ─────────────────────────────────────────────────────────────

    isOwner() {
        return typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
    },

    skeleton() {
        return html`
            ${Motion.statsGrid(3)}
            ${Motion.tableCard(3, [t('ads.attn.title'), '', ''])}
            ${Motion.busy()}
        `;
    },

    async render() {
        // The Overview | Campaigns tab bar (`AdsTabs`) lives in ads_campaigns.js, which this loads (and so warms the second tab).
        if (typeof App !== 'undefined' && typeof App.loadPageModule === 'function') await App.loadPageModule('ads_campaigns');
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
            if (err && (err.status === 403 || err.status === 404)) {
                // 404 is ADS_DISABLED (Ads is off for this workspace): nothing is offered, and nothing is an error.
                this.view = err.status === 404 ? 'disabled' : 'forbidden';
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
        Motion.announce(t('ads.loaded', { count: this.counts().campaigns }));
        return true;
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

    /** The counts of the stored campaigns; zeros when the answer has none. */
    counts() {
        const c = (this.data && this.data.counts) || {};
        return { campaigns: Number(c.campaigns) || 0, active: Number(c.active) || 0 };
    },

    attention() {
        return this.data && Array.isArray(this.data.attention) ? this.data.attention : [];
    },

    queued() {
        return this.data && Array.isArray(this.data.queued) ? this.data.queued : [];
    },

    account() {
        return this.data && this.data.account ? this.data.account : null;
    },

    /**
     * The money figures, from `overview.money` (Meta's own numbers, summed by the server): spent today and this month, the worst case of the
     * month, the cap and what is left of it. The v1 fields stand in for an answer that has no `money`, with no `remaining`.
     */
    figures() {
        const d = this.data || {};
        if (d.money) return d.money;
        const spend = d.spend || {};
        const limits = d.limits || {};
        return {
            spentToday: spend.today, spentThisMonth: spend.thisMonth, worstCaseThisMonth: limits.worstCaseThisMonth,
            monthlyCap: limits.monthlyCap, remaining: null, maxDailyBudget: limits.maxDailyBudget,
        };
    },

    currency() {
        const m = this.data && this.data.money;
        if (m && m.currency) return m.currency;
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

    dayText(iso) {
        return iso ? UI.formatDay(iso) : '—';
    },

    /** A moment as date and time, isolated: it sits inside Arabic and English sentences alike. */
    stamp(iso) {
        const text = iso ? UI.formatDateTime(iso) : '';
        return text && text !== '—' ? `⁦${text}⁩` : '';
    },

    /** How much of this month's cap is still free (the server's `remaining`), or null when there is no cap or it could not be worked out. */
    capLeft() {
        const left = this.figures().remaining;
        return left === null || left === undefined || !Number.isFinite(Number(left)) ? null : Math.max(0, Number(left));
    },

    // ─── Painting ────────────────────────────────────────────────────────────

    paint(container) {
        if (!container) return;
        const focus = UI.captureFocus(container);
        // No tab bar on the "owners only" and "not available" panels: there is nothing to switch to.
        const tabs = typeof AdsTabs === 'undefined' || this.view === 'forbidden' || this.view === 'disabled' ? '' : AdsTabs.markup('overview');
        container.innerHTML = esc(html`${tabs}${this.markup()}`);
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
            actions: ready ? refresh : '',
        });
        if (this.view === 'forbidden') {
            return html`<div id="ads-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.owner.title'), body: t('ads.owner.body') })}</div>`;
        }
        if (this.view === 'disabled') {
            return html`<div id="ads-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.disabled.title'), body: t('ads.disabled.body') })}</div>`;
        }
        const data = this.data || {};
        if (!data.configured) return html`<div id="ads-page" class="ads-page">${header}${this.firstRun()}</div>`;
        // No stored account check yet (the daily health check has not run since setup, and nobody pressed Test connection): say that, and
        // still show what the stored copy has. A check that FAILED is the account problem card alone.
        if (!data.account && !data.accountError) {
            return html`<div id="ads-page" class="ads-page">${header}${this.banners()}${this.accountUnchecked()}${this.attentionSection()}${this.queuedSection()}${this.campaignsLink()}</div>`;
        }
        if (!data.account) return html`<div id="ads-page" class="ads-page">${header}${this.banners()}${this.accountProblem()}</div>`;
        return html`
            <div id="ads-page" class="ads-page">
                ${header}
                ${this.banners()}
                ${this.paymentCard()}
                ${this.healthStrip()}
                ${this.moneySection()}
                ${this.attentionSection()}
                ${this.queuedSection()}
                ${this.campaignsLink()}
            </div>
        `;
    },

    /** The server's four steps, in its order. A step the answer does not carry is not drawn. */
    STEP_IDS: Object.freeze(['token', 'account', 'payment', 'limits']),

    /**
     * What is needed before ads can run, as a list where each step is done or not (a check mark AND a word, never colour alone) with the
     * server's hint under the ones that are not, and a help link that names its step. Every step leads to the one article about connecting.
     */
    stepsList(steps) {
        const rows = (Array.isArray(steps) ? steps : []).filter((s) => s && this.STEP_IDS.includes(s.id));
        return html`
            <ol class="ads-checklist ads-steps-list" id="ads-steps" aria-label="${t('ads.steps.label')}">
                ${rows.map((step) => html`
                    <li class="ads-check ads-step ${step.done ? html.raw('ads-check--done') : ''}" data-step="${step.id}" data-done="${step.done ? 'true' : 'false'}">
                        <i data-lucide="${step.done ? 'check-circle' : 'circle-dashed'}" aria-hidden="true"></i>
                        <span class="ads-step-text">
                            <span>${t(`ads.step.${step.id}`)}</span>
                            ${!step.done && step.hintCode ? html`<span class="form-hint">${t(`ads.stepHint.${step.hintCode}`)}</span>` : ''}
                        </span>
                        <span class="sr-only">${step.done ? t('ads.step.done') : t('ads.step.todo')}</span>
                        ${UI.helpLink('ads#connect', t('ads.step.helpFor', { step: t(`ads.step.${step.id}`) }), { iconOnly: true })}
                    </li>
                `)}
            </ol>
        `;
    },

    /** Not set up yet: the four steps with what is still to do, and one way in. Not an error: the server answers 200 for this. */
    firstRun() {
        return UI.card({
            id: 'ads-first-run',
            title: t('ads.notConfigured.title'),
            body: html`
                <p dir="auto">${t('ads.notConfigured.body')}</p>
                ${this.stepsList(this.data && this.data.steps)}
                <p class="form-hint">${t('ads.notConfigured.note')}</p>
                <div class="ads-actions">${UI._anchorButton({ href: '#/settings?s=ads', label: t('ads.notConfigured.cta'), icon: 'settings', variant: 'primary' })}</div>
            `,
        });
    },

    /**
     * The two things that must never be silent. `guard.blind`: the hourly spend check has not succeeded for two hours, so nothing is watching
     * the cap. `tokenHealth: 'dead'`: Meta no longer accepts the token, so spend cannot be read or limited. Each is a banner above everything.
     */
    banners() {
        const d = this.data || {};
        const out = [];
        if (d.guard && d.guard.blind) {
            out.push(UI.card({
                id: 'ads-blind-banner',
                tone: 'danger',
                title: t('ads.blind.title'),
                body: html`
                    <p dir="auto">${t('ads.blind.body')}</p>
                    <div class="ads-actions">${UI.helpLink('ads#troubleshooting', t('ads.blind.help'))}</div>
                `,
            }));
        }
        if (d.tokenHealth === 'dead') {
            out.push(UI.card({
                id: 'ads-token-dead-banner',
                tone: 'danger',
                title: t('ads.tokenDead.title'),
                body: html`
                    <p dir="auto">${t('ads.tokenDead.body')}</p>
                    <div class="ads-actions">${UI._anchorButton({ href: '#/settings?s=ads', label: t('ads.notConfigured.cta'), icon: 'settings', variant: 'primary' })}</div>
                `,
            }));
        }
        return out;
    },

    /** Configured, but the account has never been checked: the stored copy has no account yet. Not an error, a step. */
    accountUnchecked() {
        return UI.card({
            id: 'ads-account-unchecked',
            title: t('ads.account.unchecked'),
            body: html`
                <p class="form-hint">${t('ads.account.uncheckedHint')}</p>
                <div class="ads-actions">
                    ${UI._anchorButton({ href: '#/settings?s=ads', label: t('ads.notConfigured.cta'), icon: 'settings', variant: 'secondary' })}
                    ${UI.helpLink('ads#account-health', t('ads.health.title'))}
                </div>
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

    /** The token's health in a chip: a word AND a tone, never colour alone. */
    tokenChip(health) {
        const key = this.TOKEN_HEALTHS.includes(health) ? health : 'unknown';
        const tone = key === 'ok' ? 'badge-success' : (key === 'dead' ? 'badge-danger' : (key === 'expiring' ? 'badge-warning' : 'badge-neutral'));
        return html`<span class="badge ${html.raw(tone)}" data-ads-token="${key}">${t(`ads.health.token.${key}`)}</span>`;
    },

    /** The spend guard: when it last checked the month's spend, or that it is not watching (the banner above says what to do). */
    guardLine() {
        const g = (this.data && this.data.guard) || {};
        const at = this.stamp(g.lastCheckedAt);
        if (g.blind) {
            return html`<span class="ads-state text-warning"><i data-lucide="alert-triangle" aria-hidden="true"></i> ${t('ads.health.guard.blind')}</span>${at ? html` <span class="form-hint">${t('ads.health.guard.last', { time: at })}</span>` : ''}`;
        }
        if (!at) return html`<span class="form-hint">${t('ads.health.guard.never')}</span>`;
        return html`<span class="ads-state text-success"><i data-lucide="check-circle" aria-hidden="true"></i> ${t('ads.health.guard.ok')}</span> <span class="form-hint">${t('ads.health.guard.last', { time: at })}</span>`;
    },

    /**
     * The health strip: the account (who it is and whether it can run ads), how it is paid for, whether Meta still accepts the token, and the
     * spend guard's last check, with the way out to Meta for what this screen does not do. All of it from the stored health check.
     */
    healthStrip() {
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
            id: 'ads-health',
            title: t('ads.health.title'),
            actions: open,
            body: html`
                <dl class="ads-account-grid">
                    <div><dt class="form-hint">${t('ads.account.name')}</dt><dd><span dir="auto">${a.name || '—'}</span> <span class="form-hint">${UI.ltr(a.id || '')}</span></dd></div>
                    <div><dt class="form-hint">${t('ads.account.status')}</dt><dd>${this.accountStatusChip(a)}${a.disableReason ? html` <span class="form-hint" dir="auto">${a.disableReason}</span>` : ''}</dd></div>
                    <div><dt class="form-hint">${t('ads.account.payment')}</dt><dd>${payment}</dd></div>
                    <div><dt class="form-hint">${t('ads.health.token')}</dt><dd>${this.tokenChip(this.data.tokenHealth)}</dd></div>
                    <div><dt class="form-hint">${t('ads.health.guard')}</dt><dd>${this.guardLine()}</dd></div>
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
     * compared, with what is left of it), and the most the month could reach if nothing is paused. The two limits the owner set are one line
     * below (`limitsRow`). One note says the figures exclude tax: Meta's invoices are the accounting record, not this screen.
     */
    spendCards() {
        const m = this.figures();
        const hasCap = m.monthlyCap !== null && m.monthlyCap !== undefined;
        const month = m.spentThisMonth;
        const left = this.capLeft();

        let monthSub;
        if (hasCap) {
            const used = Number.isFinite(Number(month)) && month !== null ? Number(month) : null;
            monthSub = html`
                ${used === null ? html`<p class="stat-sub">${t('ads.cap.unknown')}</p>` : html`
                    <progress class="studio-meter ads-meter" max="${Number(m.monthlyCap)}" value="${Math.min(used, Number(m.monthlyCap))}"
                        aria-label="${t('ads.cap.used', { spent: this.money(used), cap: this.money(m.monthlyCap) })}"></progress>
                    <p class="stat-sub">${t('ads.cap.used', { spent: this.money(used), cap: this.money(m.monthlyCap) })}</p>`}
                ${left === null ? '' : html`<p class="stat-sub" id="ads-cap-left">${t('ads.cap.remaining', { remaining: this.money(left) })}</p>`}
            `;
        } else {
            monthSub = html`<p class="stat-sub">${t('ads.cap.none')}</p>`;
        }

        const worst = m.worstCaseThisMonth;
        const overCap = hasCap && worst !== null && worst !== undefined && Number(worst) > Number(m.monthlyCap);
        const worstSub = html`
            <p class="stat-sub">${t('ads.worst.hint')}</p>
            ${overCap ? html`<p class="stat-sub text-warning"><i data-lucide="alert-triangle" aria-hidden="true"></i> ${t('ads.worst.overCap', { cap: this.money(m.monthlyCap) })}</p>` : ''}
        `;

        return html`
            <div class="stats-grid ads-stats" id="ads-stats">
                ${this.statCard({ id: 'ads-stat-today', label: t('ads.spend.today'), icon: 'clock', value: this.money(m.spentToday) })}
                ${this.statCard({ id: 'ads-stat-month', label: t('ads.spend.month'), icon: 'calendar-days', value: this.money(month), sub: monthSub })}
                ${this.statCard({ id: 'ads-stat-worst', label: t('ads.worst.label'), icon: 'trending-up', value: this.money(worst), sub: worstSub, warn: overCap })}
            </div>
        `;
    },

    /**
     * When the figures were last read from Meta (`syncedAt`), that the newest days are provisional (`provisionalFrom`: Meta can still revise the
     * last three days), which time zone the day and the month follow, and the one note that every figure excludes tax.
     */
    freshness() {
        const d = this.data || {};
        const m = d.money || {};
        const at = this.stamp(d.syncedAt);
        return html`
            <div class="ads-fresh" id="ads-fresh">
                <p class="form-hint" id="ads-synced">${at ? t('ads.camp.updated', { time: at }) : t('ads.money.neverSynced')}</p>
                ${d.provisionalFrom ? html`<p class="form-hint" id="ads-provisional">${t('ads.money.provisional', { date: this.dayText(d.provisionalFrom) })}</p>` : ''}
                ${m.monthBoundaryTz ? html`<p class="form-hint" id="ads-tz">${t('ads.money.tz', { tz: `⁦${m.monthBoundaryTz}⁩` })}</p>` : ''}
                <p class="form-hint ads-tax-note" id="ads-tax-note">${t('ads.tax.note')}</p>
            </div>
        `;
    },

    /** The money: the three figures, when they are from, and the two limits. */
    moneySection() {
        return html`
            <section class="section" id="ads-money" aria-labelledby="ads-money-title">
                <div class="ads-section-head"><h2 class="section-title" id="ads-money-title">${t('ads.money.title')}</h2></div>
                ${this.spendCards()}
                ${this.freshness()}
                ${this.limitsRow()}
            </section>
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

    /** The kind of a thing that needs attention, in a chip: a word AND a tone. */
    attentionChip(kind) {
        const key = this.ATTENTION_KINDS.includes(kind) ? kind : '';
        const tone = key === 'rejected' || key === 'op_failed' ? 'badge-danger' : 'badge-warning';
        return html`<span class="badge ${html.raw(tone)}">${key ? t(`ads.attn.kind.${key}`) : t('ads.account.status.other')}</span>`;
    },

    attentionItem(item) {
        const detail = item.detail ? html`<p class="ads-attn-detail" dir="auto">${item.detail}</p>` : '';
        const at = this.stamp(item.at);
        const help = item.helpSection ? UI.helpLink(`ads#${item.helpSection}`, t('ads.attn.help'), { className: 'ads-attn-help' }) : '';
        return html`
            <li class="ads-attn-item surface" data-attn-kind="${item.kind}">
                <div class="ads-attn-main">
                    <div class="ads-badges">${this.attentionChip(item.kind)}<strong class="ads-attn-title" dir="auto">${item.title || '—'}</strong></div>
                    ${detail}
                    ${at ? html`<p class="form-hint ads-attn-at">${t('ads.attn.at', { time: at })}</p>` : ''}
                </div>
                <div class="ads-actions ads-attn-links">
                    ${item.objectId ? UI._anchorButton({ href: '#/ads_campaigns', label: t('ads.attn.open'), icon: 'megaphone', variant: 'ghost', size: 'sm' }) : ''}
                    ${help}
                </div>
            </li>
        `;
    },

    /** What needs the owner: rejected ads, ads with issues, billing, and changes that failed lately. Empty is said, not left blank. */
    attentionSection() {
        const items = this.attention();
        return html`
            <section class="section" id="ads-attention" aria-labelledby="ads-attention-title">
                <div class="ads-section-head">
                    <h2 class="section-title" id="ads-attention-title">${t('ads.attn.title')}</h2>
                    ${items.length ? html`<p class="form-hint">${t('ads.attn.count', { count: items.length })}</p>` : ''}
                </div>
                ${items.length
                    ? html`<ul class="ads-attn-list" id="ads-attn-list">${items.map((item) => this.attentionItem(item))}</ul>`
                    : html`<p class="ads-calm surface" id="ads-attn-empty"><i data-lucide="check-circle" aria-hidden="true"></i> ${t('ads.attn.none')}</p>`}
            </section>
        `;
    },

    /** One queued change: what, to which object, how far along, and when it should go out. */
    queuedItem(op) {
        const kind = this.OP_KINDS.includes(op.kind) ? t(`ads.queue.kind.${op.kind}`) : t('ads.queue.kind.other');
        const state = this.OP_STATES.includes(op.state) ? t(`ads.queue.state.${op.state}`) : String(op.state || '');
        const due = op.notBefore ? Date.parse(op.notBefore) : NaN;
        const expected = Number.isFinite(due) && due > Date.now() && op.state !== 'running';
        return html`
            <li class="ads-queue-item surface" data-op-id="${op.id}" data-op-state="${op.state}">
                <div class="ads-queue-main">
                    <strong>${kind}</strong>
                    <span class="ads-queue-object" dir="auto">${op.objectName || '—'}</span>
                </div>
                <div class="ads-badges">
                    <span class="badge badge-info"><i data-lucide="clock" aria-hidden="true"></i> ${state}</span>
                    ${expected ? html`<span class="form-hint ads-queue-due">${t('ads.queue.expected', { time: this.stamp(op.notBefore) })}</span>` : ''}
                </div>
            </li>
        `;
    },

    /** The changes accepted but not yet sent to Meta (queued, sending, being checked): Meta limits how fast changes may go, so they wait their turn. */
    queuedSection() {
        const ops = this.queued();
        return html`
            <section class="section" id="ads-queued" aria-labelledby="ads-queued-title">
                <div class="ads-section-head">
                    <h2 class="section-title" id="ads-queued-title">${t('ads.queued.title')}</h2>
                    ${UI.helpLink('ads#queued-changes', t('ads.help.queued'))}
                </div>
                ${ops.length
                    ? html`<ul class="ads-queue-list" id="ads-queue-list">${ops.map((op) => this.queuedItem(op))}</ul>`
                    : html`<p class="ads-calm surface" id="ads-queued-empty"><i data-lucide="check-circle" aria-hidden="true"></i> ${t('ads.queued.none')}</p>`}
            </section>
        `;
    },

    /** How many campaigns there are and how many run, and the way into the Campaigns tab where they are listed and changed. */
    campaignsLink() {
        const c = this.counts();
        return html`
            <section class="section ads-campaigns-link surface" id="ads-campaigns-link" aria-labelledby="ads-campaigns-title">
                <h2 class="section-title" id="ads-campaigns-title">${t('ads.campaigns.title')}</h2>
                <p class="ads-counts" id="ads-counts" data-campaigns="${c.campaigns}" data-active="${c.active}">${t('ads.summary', { active: UI.formatNumber(c.active), total: UI.formatNumber(c.campaigns) })}</p>
                ${UI._anchorButton({ href: '#/ads_campaigns', label: t('ads.campaigns.open'), icon: 'megaphone', variant: 'secondary' })}
            </section>
        `;
    },
};

UI.registerActions('ads', {
    refresh: (el) => AdsPage.refresh(el),
});
