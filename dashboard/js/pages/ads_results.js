/**
 * Ads → Results — `#/ads_results`, the third tab of the Ads area (Overview `#/ads`, Campaigns `#/ads_campaigns`).
 *
 * What the money did, day by day: spend, results, cost per result, cost per conversation and cost per tracked click, for the whole account,
 * one campaign or one ad, compared by ad, by country (Egypt vs Saudi Arabia) or by placement. Everything comes from the STORED copy
 * (`GET /api/ads/results`): opening the tab makes no call to Meta, so it opens fast and never spends the ad account's Limited-tier points.
 *
 * ─── Honest numbers ─────────────────────────────────────────────────────────
 *   - Sales happen on another website (a store, a learning platform, a checkout), which neither Meta nor the app can see. So there is no sales-based figure here at all: results are
 *     conversations, link clicks, the app's own tracked-link clicks (direct on the ad's link, and via the links the assistant sent in
 *     conversations the ad started), hand-offs, follows and leads.
 *   - Meta restates results for up to 28 days. The last three days are provisional: shaded on every chart, marked in every table.
 *   - Days are the ad account's days. Money in two currencies is never added: one totals strip per currency, and the charts draw one
 *     currency at a time (the account's), naming any other.
 *   - Every spend figure carries the note that it excludes tax and that Meta's invoices are the accounting record.
 *   - A null is "—", never 0. One measure per chart, never a second y-axis.
 *
 * `AdsTabs` (the tab bar) lives in ads_campaigns.js, which this loads; the styles are the area's one stylesheet, `css/pages/ads.css`.
 */
const AdsResultsPage = {
    /** 'loading' | 'ready' | 'forbidden' | 'disabled' | 'failed' */
    view: 'loading',
    /** The answer for the chosen scope (account, a campaign or an ad); null until the first one. */
    data: null,
    /** The answer at ad level over the same days: the per-ad table and the "by ad" comparison. */
    ads: null,
    /** The scope's answer split by country or placement, when that comparison is chosen. */
    split: null,
    /** The campaigns that can be chosen as a scope (stored copy). */
    campaigns: [],
    days: 28,
    /** '' (the whole account) or `campaign:<metaId>` / `ad:<metaId>`. */
    scope: '',
    /** 'ad' | 'country' | 'placement' */
    compare: 'ad',
    _seq: 0,
    _reloadTimer: null,

    RANGES: Object.freeze([7, 28, 90]),
    COMPARES: Object.freeze(['ad', 'country', 'placement']),
    /** The charts, in order. Each is one measure over the days. */
    CHARTS: Object.freeze(['spend', 'results', 'costPerResult', 'costPerConversation', 'costPerTrackedClick']),
    /** The measures that are money (they carry the currency and the tax note). */
    MONEY: Object.freeze(['spend', 'costPerResult', 'costPerConversation', 'costPerTrackedClick']),
    SYNC_RELOAD_MS: 20000,

    resetTenantState() {
        this.destroy();
        this.view = 'loading';
        this.data = null;
        this.ads = null;
        this.split = null;
        this.campaigns = [];
        this.scope = '';
    },

    destroy() {
        this._seq++;
        if (this._reloadTimer) clearTimeout(this._reloadTimer);
        this._reloadTimer = null;
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

    skeleton() {
        return html`${Motion.statsGrid(4)}${Motion.chartGrid(2)}${Motion.busy()}`;
    },

    /** A calendar day `n` days before today, as YYYY-MM-DD. The server cuts the stored rows by the ad account's days. */
    dayOffset(n) {
        const d = new Date(Date.now() - n * 86400000);
        return d.toISOString().slice(0, 10);
    },

    /** The scope as API parameters. */
    scopeParams() {
        const [level, id] = this.scope ? this.scope.split(':') : ['account', ''];
        return level === 'campaign' || level === 'ad' ? { level, ids: [id] } : { level: 'account' };
    },

    /** Reads the scope, the ads and (for a country or placement comparison) the split. `quiet` keeps the page on screen while it reads. */
    async load(quiet) {
        const container = this.host();
        if (!container) return false;
        const seq = ++this._seq;
        const gate = quiet ? { done() {} } : Motion.beginLoad(container, () => this.skeleton());
        const range = { from: this.dayOffset(this.days - 1), to: this.dayOffset(0) };
        const scope = this.scopeParams();
        const breakdown = this.compare === 'country' || this.compare === 'placement' ? this.compare : null;
        let answers;
        try {
            answers = await Promise.all([
                API.getAdsResults({ ...scope, ...range }),
                API.getAdsResults({ level: 'ad', ...range }),
                breakdown ? API.getAdsResults({ ...scope, ...range, breakdown }) : Promise.resolve(null),
                this.campaigns.length ? Promise.resolve(null) : API.getAdsObjects({ level: 'campaign' }).catch(() => null),
            ]);
        } catch (err) {
            gate.done();
            if (seq !== this._seq) return false;
            if (err && (err.status === 403 || err.status === 404)) {
                this.view = err.status === 404 ? 'disabled' : 'forbidden';
                this.paint(container);
            } else if (this.view === 'ready') {
                UI.toast((err && err.message) || t('error.unexpected'), 'error');
            } else {
                this.view = 'failed';
                UI.renderError(container, {
                    title: t('adsResults.loadFailed'),
                    message: (err && err.message) || t('error.unexpected'),
                    hint: t('admin.loadFailedHint'),
                }, () => this.load());
            }
            return false;
        }
        gate.done();
        if (seq !== this._seq) return false;
        const [data, ads, split, campaigns] = answers;
        this.data = data || null;
        this.ads = ads || null;
        this.split = split || null;
        if (campaigns && Array.isArray(campaigns.items)) this.campaigns = campaigns.items.filter((o) => o && o.metaId);
        this.view = 'ready';
        this.paint(container);
        Motion.announce(t('adsResults.loaded'));
        return true;
    },

    paint(container) {
        if (!container) return;
        const focus = UI.captureFocus(container);
        container.innerHTML = esc(this.markup());
        UI.icons(container);
        UI.restoreFocus(focus);
    },

    // ─── Numbers ─────────────────────────────────────────────────────────────

    isolate(text) {
        return `⁨${String(text === null || text === undefined ? '' : text)}⁩`;
    },

    /** `12.5 EGP` as one isolated run, so a currency code never reorders an Arabic sentence. */
    money(amount, currency) {
        const n = Number(amount);
        if (amount === null || amount === undefined || !Number.isFinite(n)) return '—';
        return `⁦${UI.formatNumber(n)}${currency ? ` ${currency}` : ''}⁩`;
    },

    count(value) {
        return value === null || value === undefined ? '—' : UI.formatNumber(value);
    },

    /** spend / count to two places; null when there is nothing to divide by. */
    per(spend, n) {
        return n === null || n === undefined || !(Number(n) > 0) || spend === null || spend === undefined ? null : Math.round((Number(spend) / Number(n)) * 100) / 100;
    },

    /** The currency the charts draw: the answer's only one, else the one with the most spend. */
    chartCurrency(answer) {
        if (!answer) return null;
        if (answer.currency) return answer.currency;
        const totals = (answer.totals && answer.totals.byCurrency) || {};
        const list = Object.keys(totals).sort((a, b) => (Number(totals[b].spend) || 0) - (Number(totals[a].spend) || 0));
        return list[0] || null;
    },

    /**
     * The daily series for one measure, oldest first, one point per day of the range (a day with no row is a gap, not a zero), in the
     * chart currency, with the provisional flag.
     */
    series(measure) {
        const answer = this.data;
        const currency = this.chartCurrency(answer);
        if (!answer || !currency) return [];
        const byDay = new Map();
        (answer.rows || []).forEach((r) => {
            if (!r || r.currency !== currency) return;
            const d = byDay.get(r.day) || { spend: 0, results: null, conversations: 0, provisional: false };
            d.spend += Number(r.spend) || 0;
            if (r.results !== null && r.results !== undefined) d.results = (d.results || 0) + Number(r.results);
            d.conversations += Number(r.conversations) || 0;
            d.provisional = d.provisional || r.provisional === true;
            byDay.set(r.day, d);
        });
        const tracked = new Map();
        (answer.appDaily || []).forEach((e) => {
            if (!e) return;
            tracked.set(e.day, (tracked.get(e.day) || 0) + (Number(e.trackedDirect) || 0) + (Number(e.trackedViaChat) || 0));
        });
        const out = [];
        for (let day = answer.from; day && day <= answer.to; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
            const d = byDay.get(day);
            let value = null;
            if (d) {
                if (measure === 'spend') value = Math.round(d.spend * 100) / 100;
                else if (measure === 'results') value = d.results;
                else if (measure === 'costPerResult') value = this.per(d.spend, d.results);
                else if (measure === 'costPerConversation') value = this.per(d.spend, d.conversations);
                else if (measure === 'costPerTrackedClick') value = this.per(d.spend, tracked.get(day) || 0);
            }
            out.push({ day, value, provisional: !!(d && d.provisional) });
            if (out.length > 400) break;
        }
        return out;
    },

    /** The name of an object in an answer, or its id. */
    nameOf(answer, id) {
        const o = answer && Array.isArray(answer.objects) ? answer.objects.find((x) => x && x.id === id) : null;
        return (o && o.name) || id;
    },

    /** A breakdown key in words: a country code by the browser's own names, a placement `instagram:reels` as "Instagram · Reels". */
    keyLabel(key) {
        const text = String(key || '');
        if (this.compare === 'country') {
            try {
                const names = new Intl.DisplayNames([I18N.lang || 'ar'], { type: 'region' });
                return names.of(text.toUpperCase()) || text;
            } catch {
                return text;
            }
        }
        const words = (part) => part.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        return text.split(':').map(words).join(' · ');
    },

    /**
     * The comparison: one entry per ad, country or placement, in the chart currency, most spend first. Tracked clicks and hand-offs
     * exist per ad only (a click has no country), so they are null on a country or placement row.
     */
    comparison() {
        const currency = this.chartCurrency(this.data);
        if (this.compare === 'ad') {
            const answer = this.ads;
            const list = answer && Array.isArray(answer.perObject) ? answer.perObject : [];
            return list.filter((p) => p && p.currency === currency).map((p) => ({
                label: this.nameOf(answer, p.id), spend: p.spend, results: p.results, costPerResult: p.costPerResult,
                conversations: p.conversations, tracked: (Number(p.trackedClicks && p.trackedClicks.direct) || 0) + (Number(p.trackedClicks && p.trackedClicks.viaChat) || 0),
            })).sort((a, b) => b.spend - a.spend);
        }
        const answer = this.split;
        const by = new Map();
        (answer && Array.isArray(answer.rows) ? answer.rows : []).forEach((r) => {
            if (!r || r.currency !== currency || !r.key) return;
            const e = by.get(r.key) || { label: this.keyLabel(r.key), key: r.key, spend: 0, results: null, conversations: 0, tracked: null };
            e.spend = Math.round((e.spend + (Number(r.spend) || 0)) * 100) / 100;
            if (r.results !== null && r.results !== undefined) e.results = (e.results || 0) + Number(r.results);
            e.conversations += Number(r.conversations) || 0;
            by.set(r.key, e);
        });
        return [...by.values()].map((e) => ({ ...e, costPerResult: this.per(e.spend, e.results) })).sort((a, b) => b.spend - a.spend);
    },

    // ─── Markup ──────────────────────────────────────────────────────────────

    markup() {
        const tabs = typeof AdsTabs === 'undefined' || this.view === 'forbidden' || this.view === 'disabled' ? '' : AdsTabs.markup('results');
        const ready = this.view === 'ready';
        const synced = ready && this.data ? this.data.syncedAt : null;
        const updated = ready ? (synced ? t('ads.camp.updated', { time: `⁦${UI.formatDateTime(synced)}⁩` }) : t('ads.camp.neverSynced')) : '';
        const refresh = ready && this.isOwner()
            ? UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('ads.camp.refreshResults'), action: 'adsres:sync', focusKey: 'adsres-sync' })
            : '';
        const header = UI.pageHeader({ title: t('adsResults.title'), subtitle: updated, actions: refresh });
        if (this.view === 'forbidden') {
            return html`<div id="adsres-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.owner.title'), body: t('ads.owner.body') })}</div>`;
        }
        if (this.view === 'disabled') {
            return html`<div id="adsres-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.disabled.title'), body: t('ads.disabled.body') })}</div>`;
        }
        const hasRows = !!(this.data && Array.isArray(this.data.rows) && this.data.rows.length);
        return html`
            <div id="adsres-page" class="ads-page adsres-page">
                ${tabs}
                ${header}
                ${this.controlsMarkup()}
                <p class="form-hint ads-tax-note" id="adsres-tax-note">${t('ads.tax.note')}</p>
                ${this.provisionalMarkup()}
                <p class="ads-help" id="adsres-help">
                    ${UI.helpLink('ads#results', t('adsResults.help.results'))}
                    ${UI.helpLink('ads#provisional-numbers', t('adsResults.help.provisional'))}
                    ${UI.helpLink('ads#cost-per-conversation', t('adsResults.help.costs'))}
                </p>
                ${hasRows ? html`
                    ${this.totalsMarkup()}
                    ${this.currencyNoteMarkup()}
                    <div class="chart-grid chart-grid--even adsres-charts" id="adsres-charts">${this.CHARTS.map((m) => this.chartMarkup(m))}</div>
                    ${this.compareMarkup()}
                    ${this.adsTableMarkup()}
                ` : UI.emptyState({ icon: 'bar-chart-3', title: t('adsResults.empty.title'), body: t('adsResults.empty.body') })}
            </div>
        `;
    },

    controlsMarkup() {
        const options = [html`<option value="" ${this.scope === '' ? html.raw('selected') : ''}>${t('adsResults.scope.account')}</option>`];
        this.campaigns.forEach((c) => {
            const v = `campaign:${c.metaId}`;
            options.push(html`<option value="${v}" ${this.scope === v ? html.raw('selected') : ''}>${t('adsResults.scope.campaign', { name: this.isolate(c.name || c.metaId) })}</option>`);
        });
        const adObjects = this.ads && Array.isArray(this.ads.objects) ? this.ads.objects : [];
        adObjects.forEach((o) => {
            const v = `ad:${o.id}`;
            options.push(html`<option value="${v}" ${this.scope === v ? html.raw('selected') : ''}>${t('adsResults.scope.ad', { name: this.isolate(o.name || o.id) })}</option>`);
        });
        return html`
            <div class="page-toolbar adsres-controls" id="adsres-controls">
                <div class="segmented studio-seg adsres-range" role="group" aria-label="${t('adsResults.range.label')}">
                    ${this.RANGES.map((n) => html`
                        <button type="button" class="btn btn-sm btn-ghost" id="adsres-range-${n}" data-action="adsres:setDays" data-days="${n}"
                                aria-pressed="${n === this.days ? 'true' : 'false'}">${t('adsResults.range.days', { count: n })}</button>`)}
                </div>
                <label class="adsres-scope">
                    <span class="sr-only">${t('adsResults.scope.label')}</span>
                    <select class="select" id="adsres-scope" data-change="adsres:setScope" aria-label="${t('adsResults.scope.label')}">${options}</select>
                </label>
            </div>
        `;
    },

    provisionalMarkup() {
        const from = this.data && this.data.provisionalFrom;
        if (!from) return '';
        return html`<p class="form-hint adsres-provisional" id="adsres-provisional"><span class="adsres-swatch" aria-hidden="true"></span>${t('adsResults.provisional.note', { day: `⁦${Charts.dayLabel(from)}⁩` })}</p>`;
    },

    /** One strip per currency: money in two currencies is never added together. */
    totalsMarkup() {
        const totals = (this.data && this.data.totals && this.data.totals.byCurrency) || {};
        const currencies = Object.keys(totals).sort();
        return html`${currencies.map((cur) => {
            const x = totals[cur] || {};
            const tracked = (Number(x.trackedClicks && x.trackedClicks.direct) || 0) + (Number(x.trackedClicks && x.trackedClicks.viaChat) || 0);
            const tile = (id, label, value, sub) => html`
                <div class="stat-card surface ads-stat" id="adsres-${id}-${cur}">
                    <div class="stat-header"><span class="stat-label">${label}</span></div>
                    <p class="stat-value">${value}</p>
                    ${sub ? html`<p class="stat-sub">${sub}</p>` : ''}
                </div>`;
            return html`
                <section class="adsres-totals" data-currency="${cur}" aria-label="${t('adsResults.totals.label', { currency: cur })}">
                    <div class="stats-grid">
                        ${tile('spend', t('adsResults.m.spend'), this.money(x.spend, cur), t('adsResults.taxShort'))}
                        ${tile('results', t('adsResults.m.results'), this.count(x.results), t('adsResults.m.costPerResultIs', { cost: this.money(x.costPerResult, cur) }))}
                        ${tile('conversations', t('adsResults.m.conversations'), this.count(x.conversations), t('adsResults.m.costPerConversationIs', { cost: this.money(x.costPerConversation, cur) }))}
                        ${tile('tracked', t('adsResults.m.tracked'), this.count(tracked), t('adsResults.m.costPerTrackedIs', { cost: this.money(x.costPerTrackedClick, cur) }))}
                        ${tile('handoffs', t('adsResults.m.handoffs'), this.count(x.handoffs), '')}
                        ${tile('follows', t('adsResults.m.follows'), this.count(x.follows), '')}
                        ${tile('leads', t('adsResults.m.leads'), this.count(x.leads), t('adsResults.m.costPerLeadIs', { cost: this.money(x.costPerLead, cur) }))}
                    </div>
                </section>`;
        })}`;
    },

    currencyNoteMarkup() {
        const list = (this.data && this.data.currencies) || [];
        if (list.length < 2) return '';
        const shown = this.chartCurrency(this.data);
        return html`<p class="form-hint adsres-currency-note" id="adsres-currency-note">${t('adsResults.currency.note', {
            shown, others: list.filter((c) => c !== shown).join('، '),
        })}</p>`;
    },

    chartMarkup(measure) {
        const currency = this.chartCurrency(this.data);
        const isMoney = this.MONEY.includes(measure);
        const name = t(`adsResults.m.${measure}`);
        const label = isMoney ? t('adsResults.chart.moneyLabel', { metric: name, currency: currency || '' }) : name;
        return html`
            <section class="chart-card surface adsres-chart" id="adsres-chart-${measure}" aria-labelledby="adsres-chart-${measure}-title">
                <div class="chart-card-header"><h2 class="chart-card-title" id="adsres-chart-${measure}-title">${label}</h2></div>
                ${Charts.lineChart(this.series(measure), {
                    label, token: '--chart-accent',
                    format: isMoney ? (v) => this.money(v, '') : undefined,
                    dayHeader: t('common.day'), valueHeader: name,
                    provisionalLabel: t('adsResults.provisional.short'),
                    emptyMessage: t('adsResults.chart.empty'),
                })}
                ${isMoney ? html`<p class="text-meta adsres-chart-note">${t('adsResults.taxShort')}</p>` : ''}
            </section>
        `;
    },

    compareMarkup() {
        const items = this.comparison();
        const currency = this.chartCurrency(this.data);
        const perAd = this.compare === 'ad';
        const head = html`
            <div class="chart-card-header">
                <h2 class="chart-card-title" id="adsres-compare-title">${t('adsResults.compare.title')}</h2>
                <div class="segmented studio-seg adsres-compare-by" role="group" aria-label="${t('adsResults.compare.label')}">
                    ${this.COMPARES.map((c) => html`
                        <button type="button" class="btn btn-sm btn-ghost" id="adsres-compare-${c}" data-action="adsres:setCompare" data-compare="${c}"
                                aria-pressed="${c === this.compare ? 'true' : 'false'}">${t(`adsResults.compare.${c}`)}</button>`)}
                </div>
            </div>`;
        const body = items.length === 0
            ? html`<p class="chart-empty">${t('adsResults.compare.empty')}</p>`
            : html`
                ${Charts.compareBars(items.map((it) => ({ label: it.label, value: it.spend, display: this.money(it.spend, currency) })), {
                    label: t('adsResults.compare.spendLabel', { currency: currency || '' }), nameHeader: t(`adsResults.compare.${this.compare}`), valueHeader: t('adsResults.m.spend'),
                })}
                <div class="table-wrapper">
                    <table class="data-table adsres-compare-table">
                        <thead><tr>
                            <th scope="col">${t(`adsResults.compare.${this.compare}`)}</th>
                            <th scope="col">${t('adsResults.m.spend')}*</th>
                            <th scope="col">${t('adsResults.m.results')}</th>
                            <th scope="col">${t('adsResults.m.costPerResult')}*</th>
                            <th scope="col">${t('adsResults.m.conversations')}</th>
                            ${perAd ? html`<th scope="col">${t('adsResults.m.tracked')}</th>` : ''}
                        </tr></thead>
                        <tbody>${items.map((it) => html`<tr>
                            <th scope="row">${this.isolate(it.label)}</th>
                            <td>${this.money(it.spend, currency)}</td>
                            <td>${this.count(it.results)}</td>
                            <td>${this.money(it.costPerResult, currency)}</td>
                            <td>${this.count(it.conversations)}</td>
                            ${perAd ? html`<td>${this.count(it.tracked)}</td>` : ''}
                        </tr>`)}</tbody>
                    </table>
                </div>
                <p class="text-meta">* ${t('adsResults.taxShort')}${perAd ? '' : ` ${t('adsResults.compare.noClicks')}`}</p>`;
        return html`<section class="chart-card surface adsres-compare" id="adsres-compare" aria-labelledby="adsres-compare-title">${head}${body}</section>`;
    },

    /** Every ad over the range, one row per ad and currency, most spend first. */
    adsTableMarkup() {
        const answer = this.ads;
        const list = answer && Array.isArray(answer.perObject) ? [...answer.perObject].sort((a, b) => (Number(b.spend) || 0) - (Number(a.spend) || 0)) : [];
        if (!list.length) return '';
        return html`
            <section class="section adsres-ads" id="adsres-ads" aria-labelledby="adsres-ads-title">
                <h2 class="section-title" id="adsres-ads-title">${t('adsResults.ads.title')}</h2>
                <div class="table-wrapper">
                    <table class="data-table adsres-ads-table">
                        <thead><tr>
                            <th scope="col">${t('adsResults.ads.name')}</th>
                            <th scope="col">${t('adsResults.m.spend')}*</th>
                            <th scope="col">${t('adsResults.m.conversations')}</th>
                            <th scope="col">${t('adsResults.m.costPerConversation')}*</th>
                            <th scope="col">${t('adsResults.m.linkClicks')}</th>
                            <th scope="col">${t('adsResults.m.trackedDirect')}</th>
                            <th scope="col">${t('adsResults.m.trackedViaChat')}</th>
                            <th scope="col">${t('adsResults.m.handoffs')}</th>
                            <th scope="col">${t('adsResults.m.follows')}</th>
                            <th scope="col">${t('adsResults.m.leads')}</th>
                        </tr></thead>
                        <tbody>${list.map((p) => html`<tr data-ad="${p.id}">
                            <th scope="row">${this.isolate(this.nameOf(answer, p.id))}</th>
                            <td>${this.money(p.spend, p.currency)}</td>
                            <td>${this.count(p.conversations)}</td>
                            <td>${this.money(p.costPerConversation, p.currency)}</td>
                            <td>${this.count(p.linkClicks)}</td>
                            <td>${this.count(p.trackedClicks ? p.trackedClicks.direct : null)}</td>
                            <td>${this.count(p.trackedClicks ? p.trackedClicks.viaChat : null)}</td>
                            <td>${this.count(p.handoffs)}</td>
                            <td>${this.count(p.follows)}</td>
                            <td>${this.count(p.leads)}</td>
                        </tr>`)}</tbody>
                    </table>
                </div>
                <p class="text-meta">* ${t('adsResults.taxShort')}</p>
            </section>
        `;
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    setDays(el) {
        const n = Number(el && el.dataset ? el.dataset.days : NaN);
        if (!this.RANGES.includes(n) || n === this.days) return;
        this.days = n;
        this.load(true);
    },

    setScope(el) {
        const v = el && typeof el.value === 'string' ? el.value : '';
        if (v === this.scope) return;
        this.scope = /^(campaign|ad):[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : '';
        this.load(true);
    },

    setCompare(el) {
        const c = el && el.dataset ? el.dataset.compare : '';
        if (!this.COMPARES.includes(c) || c === this.compare) return;
        this.compare = c;
        this.load(true);
    },

    timeText(iso) {
        return iso ? `⁦${UI.formatTime(iso)}⁩` : '';
    },

    /**
     * "Refresh results": asks the server to queue a refresh from Meta (the owner's; at most one per 15 minutes for the account). The
     * page reads the stored copy again once the refresh has had time to run.
     */
    async sync(el) {
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            const out = await API.requestAdsSync();
            restore();
            const at = out && out.notBefore ? Date.parse(out.notBefore) : NaN;
            UI.toast(Number.isFinite(at) && at > Date.now() ? t('adsResults.refresh.queuedAt', { time: this.timeText(out.notBefore) }) : t('ads.camp.refreshAsked'), 'success');
            if (this._reloadTimer) clearTimeout(this._reloadTimer);
            this._reloadTimer = setTimeout(() => { this._reloadTimer = null; this.load(true); }, this.SYNC_RELOAD_MS);
        } catch (err) {
            restore();
            if (err && (err.code === 'RATE_LIMITED' || err.status === 429)) {
                const retryAt = err.body && err.body.retryAt ? err.body.retryAt : '';
                UI.toast(retryAt ? t('ads.camp.refreshLimited', { time: this.timeText(retryAt) }) : t('ads.camp.refreshLimitedLater'), 'info');
            } else if (err && err.status === 404) {
                UI.toast(t('adsResults.refresh.unavailable'), 'info');
            } else {
                UI.toast((err && err.message) || t('error.unexpected'), 'error');
            }
        }
    },
};

UI.registerActions('adsres', {
    setDays: (el) => AdsResultsPage.setDays(el),
    setScope: (el) => AdsResultsPage.setScope(el),
    setCompare: (el) => AdsResultsPage.setCompare(el),
    sync: (el) => AdsResultsPage.sync(el),
});
