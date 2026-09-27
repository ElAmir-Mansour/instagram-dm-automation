/**
 * Analytics — the "how is this performing over time" screen.
 *
 * Overview answers "what happened today and what do I do about it"; this page
 * is the one the operator opens on purpose, so it keeps the all-time totals,
 * the long series and the per-campaign table. The chart configuration comes
 * from `Charts` (one definition, theme-aware, direction-aware), and the
 * platform split reads from brand tokens rather than `#1877f2` in the markup.
 *
 * Each panel answers for itself: the stats call is fatal (every tile reads
 * it), the 30-day series and the campaign table each have their own error
 * panel whose Retry re-asks for that panel alone.
 */
const AnalyticsPage = {

    /**
     * Guards the write against landing after the operator has navigated away.
     *
     * This page fires three requests and `App.navigate` calls `render()`
     * fire-and-forget; `#page-container` is refilled, never replaced. Leave
     * Analytics while those three are outstanding and the resolved handler
     * wrote this page's stats grid into the container the NEXT page already
     * owned — charts and all. Same `_seq`/`live()` shape as OverviewPage.
     */
    _seq: 0,

    /**
     * Success-rate thresholds — named so they are not a magic number buried
     * in a conditional. Kept as a separate copy, not a shared import: this
     * dashboard has no bundler, and page modules are plain globals injected
     * as independent <script> tags, so a top-level const here would collide
     * with one of the same name loaded from another page module.
     */
    SUCCESS_RATE_DANGER_MAX: 70,
    SUCCESS_RATE_WARNING_MAX: 90,

    /** text-success / text-warning / text-danger for a 0–100 rate, or '' if unknown. */
    successRateClass(rate) {
        const n = Number(rate);
        if (rate === null || rate === undefined || !Number.isFinite(n)) return '';
        if (n <= this.SUCCESS_RATE_DANGER_MAX) return 'text-danger';
        if (n <= this.SUCCESS_RATE_WARNING_MAX) return 'text-warning';
        return 'text-success';
    },

    destroy() {
        this._seq++;
        // No chart instances to destroy any more: the charts are SVG strings written
        // into the page, so navigating away removes them with the markup. This loop
        // existed only because Chart.js held canvases and event listeners alive.
    },

    skeleton() {
        return html`
            ${Motion.statsGrid(4)}
            ${Motion.chartGrid(2)}
            ${Motion.tableCard(6, [
                t('table.keyword'), t('analytics.matches'), t('common.sent'), t('common.failed'), t('analytics.successRate'),
            ])}
            ${Motion.busy()}
        `;
    },

    /** A panel's liveness check, bound to the render that asked. */
    liveness() {
        const seq = this._seq;
        return () => seq === this._seq && !!document.getElementById('page-container');
    },

    _settle(promise) {
        return promise.then(
            (value) => ({ status: 'fulfilled', value }),
            (reason) => ({ status: 'rejected', reason })
        );
    },

    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const gate = Motion.beginLoad(container, () => this.skeleton());
        this.destroy();
        const live = this.liveness();

        /**
         * `Promise.all` used to gate the whole screen on all three requests, so
         * a 500 from `/campaign-stats` — the narrowest panel on the page, one
         * table in the bottom-left — took the four stat tiles, the 30-day strip,
         * the status split and the platform breakdown down with it and replaced
         * the lot with a single error panel. Three of those four had already
         * arrived.
         *
         * `allSettled` lets each panel answer for itself. The stats call is
         * still fatal, because every tile and both charts read from it and
         * there is genuinely no page without it; the other two degrade to their
         * own panel and leave the rest of the screen standing.
         */
        const [statsRes, dailyRes, campaignRes] = await Promise.all([
            this._settle(API.getStats()),
            this._settle(API.getDailyStats(30)),
            this._settle(API.getCampaignStats()),
        ]);
        if (!live()) return;
        gate.done();

        if (statsRes.status === 'rejected') {
            const err = statsRes.reason || new Error(t('error.unexpected'));
            UI.renderError(container, {
                title: t('analytics.errorTitle'),
                message: err.message,
                hint: err.isNetworkError ? t('error.network') : '',
            }, () => this.render());
            return;
        }

        const stats = statsRes.value || {};
        const daily = dailyRes.status === 'fulfilled' && Array.isArray(dailyRes.value) ? dailyRes.value : [];

        // Today = today's row of the gap-filled daily series, not the rolling
        // 24-hour `todayActivity` that also counted failures.
        const todayRow = daily.length ? (daily[daily.length - 1] || {}) : null;
        const todaySent = todayRow ? (Number(todayRow.sent) || 0) : (stats.todayActivity || 0);
        const todayFailed = todayRow ? (Number(todayRow.failed) || 0) : null;
        const total = stats.totalInteractions || 0;
        const split = this.platformSplit(stats.instagramCount, stats.facebookCount);

        container.innerHTML = esc(html`
            <div class="stats-grid">
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('analytics.total')}</span>
                        <span class="stat-icon"><i data-lucide="activity" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value">${UI.formatNumber(total)}</p>
                </div>
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('analytics.successRate')}</span>
                        <span class="stat-icon"><i data-lucide="trending-up" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value ${html.raw(this.successRateClass(stats.successRate))}">${UI.formatPercent(stats.successRate)}</p>
                </div>
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('analytics.users')}</span>
                        <span class="stat-icon"><i data-lucide="users" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value">${UI.formatNumber(stats.uniqueUsersReached)}</p>
                </div>
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('analytics.today')}</span>
                        <span class="stat-icon"><i data-lucide="calendar" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value">${UI.formatNumber(todaySent)}</p>
                    ${todayFailed !== null ? html`<p class="stat-sub">${t('analytics.todaySub', { failed: UI.formatNumber(todayFailed) })}</p>` : ''}
                </div>
            </div>

            <div class="chart-grid">
                <!-- Every panel title on this screen was a <span>, so the page
                     had ZERO headings below the page <h1> and a screen-reader
                     user had no way to move between the four panels. Real
                     headings, same classes. -->
                <div class="chart-card surface">
                    <div class="chart-card-header"><h2 class="chart-card-title">${t('analytics.chart30')}</h2></div>
                    <!-- Filled below: the summary and the strip when the series
                         arrived, an error panel with its own Retry when it did
                         not. An empty strip and a failed fetch are not the same
                         claim about the last 30 days. -->
                    <div id="analytics-strip"></div>
                </div>
                <div class="chart-card surface">
                    <div class="chart-card-header"><h2 class="chart-card-title">${t('analytics.chartStatus')}</h2></div>
                    <div id="analytics-split"></div>
                </div>
            </div>

            <div class="chart-grid chart-grid--even">
                <div class="chart-card surface">
                    <div class="chart-card-header">
                        <h2 class="chart-card-title">${t('analytics.topCampaigns')}</h2>
                    </div>
                    <div class="table-wrapper" id="analytics-campaigns"></div>
                </div>

                <div class="chart-card surface">
                    <div class="chart-card-header">
                        <h2 class="chart-card-title">${t('analytics.platformSplit')}</h2>
                    </div>
                    <div class="platform-legend">
                        <div class="platform-legend-row">
                            <span>${t('common.instagram')}</span>
                            <strong class="text-strong">${t('analytics.share', {
                                count: UI.formatNumber(split.ig), percent: UI.formatNumber(split.igPct),
                            })}</strong>
                        </div>
                        <div class="platform-legend-row">
                            <span>${t('common.facebook')}</span>
                            <strong class="text-strong">${t('analytics.share', {
                                count: UI.formatNumber(split.fb), percent: UI.formatNumber(split.fbPct),
                            })}</strong>
                        </div>
                    </div>
                    <!-- The bar's aria-label described only Instagram's share
                         while the legend above it states both, so a screen
                         reader heard half the split twice. The legend and the
                         totals below carry every number the bar encodes, so
                         the bar itself is decoration. -->
                    <div class="platform-bar" aria-hidden="true">
                        <span class="platform-bar-ig" data-share="${split.igPct}"></span>
                        <span class="platform-bar-fb" data-share="${split.fbPct}"></span>
                    </div>
                    <div class="platform-totals">
                        <div>
                            <p class="platform-total-value">${UI.formatNumber(split.ig)}</p>
                            <p class="platform-total-label">${t('common.instagram')} · ${t('analytics.hits')}</p>
                        </div>
                        <div class="platform-totals-divider" aria-hidden="true"></div>
                        <div>
                            <p class="platform-total-value">${UI.formatNumber(split.fb)}</p>
                            <p class="platform-total-label">${t('common.facebook')} · ${t('analytics.hits')}</p>
                        </div>
                    </div>
                </div>
            </div>
        `);

        UI.icons(container);

        // Motion.busy() announced "loading" and the swap to real content was
        // silent. This page has no row count, so it names its own arrival.
        Motion.announce(`${t('nav.analytics')} — ${t('common.loaded')}`);

        // The two bar widths are data, not style: set as inline flex-basis from
        // the data-share attribute rather than interpolated into the markup.
        container.querySelectorAll('.platform-bar > span[data-share]').forEach((el) => {
            el.style.flexBasis = `${Number(el.dataset.share) || 0}%`;
        });

        // SVG, synchronous, no library. Each panel is filled from its own
        // settled result, so one failure is one error panel rather than a
        // blank screen — and its Retry re-asks for that panel only.
        this.fillStrip(dailyRes);
        this.fillCampaigns(campaignRes);

        const splitHost = document.getElementById('analytics-split');
        if (splitHost) {
            splitHost.innerHTML = esc(html`${Charts.splitBar([
                { label: t('common.sent'), value: stats.sent || 0, token: '--success', fallback: '#34c759' },
                { label: t('common.failed'), value: stats.failed || 0, token: '--danger', fallback: '#ff3b30' },
            ], {
                label: t('analytics.chartStatus'),
                emptyMessage: t('analytics.noData'),
                nameHeader: t('common.status'),
                valueHeader: t('common.count'),
            })}`);
        }
    },

    /**
     * A8: the platform split, over the platforms it is a split OF. It used to
     * divide each by `totalInteractions` and round both, so two shares could
     * sum to 99 or 101, and an interaction with no platform shrank both bars.
     * Now the base is Instagram + Facebook, and Facebook is the remainder of a
     * rounded Instagram share whenever both are non-zero: 100, always.
     */
    platformSplit(igRaw, fbRaw) {
        const ig = Math.max(0, Number(igRaw) || 0);
        const fb = Math.max(0, Number(fbRaw) || 0);
        const base = ig + fb;
        if (base === 0) return { ig, fb, igPct: 0, fbPct: 0 };
        const igPct = Math.round((ig / base) * 100);
        const fbPct = ig > 0 && fb > 0 ? 100 - igPct : Math.round((fb / base) * 100);
        return { ig, fb, igPct, fbPct };
    },

    /**
     * A7: one line above the strip — "30 days: 412 sent · 9 failed (2%) ·
     * busiest day Friday". The strip showed shape and no number; the busiest
     * WEEKDAY (summed over the window) is the rhythm a posting plan can use,
     * where the single busiest date is usually one viral post.
     */
    summary30(daily) {
        const rows = Array.isArray(daily) ? daily : [];
        const sent = rows.reduce((s, d) => s + (Number(d.sent) || 0), 0);
        const failed = rows.reduce((s, d) => s + (Number(d.failed) || 0), 0);
        const total = sent + failed;
        if (total === 0) return '';
        const byWeekday = [0, 0, 0, 0, 0, 0, 0];
        const sample = [];
        rows.forEach((d) => {
            const at = new Date(d.day);
            if (Number.isNaN(at.getTime())) return;
            const wd = at.getUTCDay();
            byWeekday[wd] += (Number(d.sent) || 0) + (Number(d.failed) || 0);
            if (!sample[wd]) sample[wd] = at;
        });
        const best = byWeekday.indexOf(Math.max(...byWeekday));
        let day = '—';
        if (byWeekday[best] > 0 && sample[best]) {
            try {
                day = new Intl.DateTimeFormat(I18N.locale(), { weekday: 'long', timeZone: 'UTC' }).format(sample[best]);
            } catch {
                day = UI.formatDayShort(sample[best]);
            }
        }
        return t('analytics.summary30', {
            sent: UI.formatNumber(sent),
            failed: UI.formatNumber(failed),
            rate: UI.formatPercent(Math.round((failed / total) * 100)),
            day,
        });
    },

    fillStrip(dailyRes) {
        const host = document.getElementById('analytics-strip');
        if (!host) return;
        if (dailyRes.status === 'rejected') {
            const err = dailyRes.reason || new Error(t('error.unexpected'));
            UI.renderError(host, {
                title: t('analytics.trendErrorTitle'),
                message: err.message || t('error.unexpected'),
                hint: err.isNetworkError ? t('error.network') : '',
            }, () => this.retryPanel('strip'));
            return;
        }
        const daily = Array.isArray(dailyRes.value) ? dailyRes.value : [];
        const summary = this.summary30(daily);
        host.innerHTML = esc(html`
            ${summary ? html`<p class="chart-summary" id="analytics-summary">${summary}</p>` : ''}
            ${Charts.dayStrip(daily, {
                label: t('analytics.chart30'),
                emptyMessage: t('analytics.noData'),
                dayHeader: t('common.day'),
                sentHeader: t('common.sent'),
                failedHeader: t('common.failed'),
            })}
        `);
        UI.icons(host);
    },

    /** Sent ÷ (sent + failed), or null before anything was attempted. */
    campaignRate(c) {
        const sent = Number(c && c.sent_count) || 0;
        const failed = Number(c && c.failed_count) || 0;
        return sent + failed > 0 ? Math.round((sent / (sent + failed)) * 100) : null;
    },

    /**
     * A3: "Top performing" is now sorted by what was actually sent and says
     * how well each did; it used to be the route's trigger order with no rate.
     * A4: a keyword opens the activity log filtered to that campaign.
     */
    campaignsMarkup(rows) {
        const list = [...rows].sort((a, b) => ((Number(b.sent_count) || 0) - (Number(a.sent_count) || 0))
            || ((Number(b.total_triggers) || 0) - (Number(a.total_triggers) || 0)));
        return html`
            <table class="data-table">
                <thead>
                    <tr>
                        <th scope="col">${t('table.keyword')}</th>
                        <th scope="col" class="cell-num">${t('analytics.matches')}</th>
                        <th scope="col" class="cell-num" aria-sort="descending">${t('common.sent')}</th>
                        <th scope="col" class="cell-num">${t('common.failed')}</th>
                        <th scope="col" class="cell-num">${t('analytics.successRate')}</th>
                    </tr>
                </thead>
                <tbody>
                    ${list.map((c) => {
                        const rate = this.campaignRate(c);
                        const keyword = c.trigger_keyword || '—';
                        const query = c.id !== null && c.id !== undefined && c.id !== '' ? new URLSearchParams({ campaign: String(c.id) }).toString() : '';
                        return html`
                            <tr>
                                <td>${query ? html`
                                    <button type="button" class="chip chip-accent chip-link" dir="auto"
                                            data-action="app:navigate" data-target="activity" data-query="${query}"
                                            title="${t('analytics.openInActivity', { keyword })}"
                                            aria-label="${t('analytics.openInActivity', { keyword })}">${keyword}</button>
                                ` : html`<span class="chip chip-accent" dir="auto">${keyword}</span>`}</td>
                                <td class="cell-num text-strong">${UI.formatNumber(c.total_triggers)}</td>
                                <td class="cell-num text-success">${UI.formatNumber(c.sent_count)}</td>
                                <td class="cell-num text-danger">${UI.formatNumber(c.failed_count)}</td>
                                <td class="cell-num ${html.raw(this.successRateClass(rate))}">${rate === null ? '—' : UI.formatPercent(rate)}</td>
                            </tr>
                        `;
                    })}
                </tbody>
            </table>
        `;
    },

    fillCampaigns(campaignRes) {
        const host = document.getElementById('analytics-campaigns');
        if (!host) return;
        if (campaignRes.status === 'rejected') {
            // A rejected /campaign-stats used to reach the template as undefined
            // and render the cheerful "no campaign data yet" state, which tells
            // an operator with eight live campaigns that they have none.
            const err = campaignRes.reason || new Error(t('error.unexpected'));
            UI.renderError(host, {
                title: t('analytics.campaignsErrorTitle'),
                message: err.message || t('error.unexpected'),
                hint: err.isNetworkError ? t('error.network') : '',
            }, () => this.retryPanel('campaigns'));
            return;
        }
        const rows = Array.isArray(campaignRes.value) ? campaignRes.value : [];
        host.innerHTML = esc(rows.length
            ? this.campaignsMarkup(rows)
            : Admin.emptyState('award', t('analytics.noCampaignDataTitle'), t('analytics.noCampaignData')));
        UI.icons(host);
    },

    /** A6: one panel's Retry re-asks for that panel alone; the rest of the screen stays. */
    retryPanel(panel) {
        const live = this.liveness();
        const host = document.getElementById(panel === 'strip' ? 'analytics-strip' : 'analytics-campaigns');
        if (host) host.innerHTML = esc(html`<div class="chart-skel" aria-hidden="true"><span class="skel skel-block"></span></div>${Motion.busy()}`);
        const request = panel === 'strip' ? API.getDailyStats(30) : API.getCampaignStats();
        return this._settle(request).then((res) => {
            if (!live()) return;
            if (panel === 'strip') this.fillStrip(res);
            else this.fillCampaigns(res);
        });
    },
};
