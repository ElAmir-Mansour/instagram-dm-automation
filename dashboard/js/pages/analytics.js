/**
 * Analytics — the "how is this performing over time" screen.
 *
 * Overview answers "what is broken this morning"; this page is the one the
 * operator opens on purpose, so it keeps the long series and the per-campaign
 * table. What changed: the chart configuration now comes from `Charts` (one
 * definition, theme-aware, direction-aware) instead of two divergent copies of
 * the same hex values, and the platform split reads from brand tokens rather
 * than `#1877f2` written into the markup.
 */
const AnalyticsPage = {
    charts: [],

    destroy() {
        this.charts.forEach((c) => { try { c.destroy(); } catch (e) { /* already gone */ } });
        this.charts = [];
    },

    skeleton() {
        return html`
            ${Motion.statsGrid(4)}
            ${Motion.chartGrid(2)}
            ${Motion.tableCard(6, [
                t('table.keyword'), t('analytics.matches'), t('common.sent'), t('common.failed'),
            ])}
            ${Motion.busy()}
        `;
    },

    async render() {
        const container = document.getElementById('page-container');
        const gate = Motion.beginLoad(container, () => this.skeleton());
        this.destroy();

        let stats;
        let daily;
        let campaignStats;
        // Chart.js is fetched alongside the data rather than after it: this
        // screen is nothing but charts, so the library is on its critical path
        // and there is no reason for it to queue behind three requests.
        const chartLib = Charts.ensure();
        try {
            [stats, daily, campaignStats] = await Promise.all([
                API.getStats(),
                API.getDailyStats(30),
                API.getCampaignStats(),
            ]);
        } catch (err) {
            gate.done();
            UI.renderError(container, { title: t('analytics.errorTitle'), message: err.message }, () => this.render());
            return;
        }
        gate.done();
        await chartLib;

        const total = stats.totalInteractions || 0;
        const igCount = stats.instagramCount || 0;
        const fbCount = stats.facebookCount || 0;
        const igPct = total > 0 ? Math.round((igCount / total) * 100) : 0;
        const fbPct = total > 0 ? Math.round((fbCount / total) * 100) : 0;

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
                    <p class="stat-value">${UI.formatPercent(stats.successRate)}</p>
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
                    <p class="stat-value">${UI.formatNumber(stats.todayActivity)}</p>
                </div>
            </div>

            <div class="chart-grid">
                <div class="chart-card surface">
                    <div class="chart-card-header"><span class="chart-card-title">${t('analytics.chart30')}</span></div>
                    <div class="chart-wrapper">
                        <canvas id="analytics-line" role="img" aria-label="${t('analytics.chart30')}"></canvas>
                    </div>
                </div>
                <div class="chart-card surface">
                    <div class="chart-card-header"><span class="chart-card-title">${t('analytics.chartStatus')}</span></div>
                    <div class="chart-wrapper">
                        <canvas id="analytics-donut" role="img" aria-label="${t('analytics.chartStatus')}"></canvas>
                    </div>
                </div>
            </div>

            <div class="chart-grid chart-grid--even">
                <div class="chart-card surface">
                    <div class="chart-card-header">
                        <span class="chart-card-title">${t('analytics.topCampaigns')}</span>
                    </div>
                    <div class="table-wrapper">
                        ${campaignStats && campaignStats.length > 0 ? html`
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th scope="col">${t('table.keyword')}</th>
                                        <th scope="col" class="cell-num">${t('analytics.matches')}</th>
                                        <th scope="col" class="cell-num">${t('common.sent')}</th>
                                        <th scope="col" class="cell-num">${t('common.failed')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${campaignStats.map((c) => html`
                                        <tr>
                                            <td><span class="chip chip-accent" dir="auto">${c.trigger_keyword}</span></td>
                                            <td class="cell-num text-strong">${UI.formatNumber(c.total_triggers)}</td>
                                            <td class="cell-num text-success">${UI.formatNumber(c.sent_count)}</td>
                                            <td class="cell-num text-danger">${UI.formatNumber(c.failed_count)}</td>
                                        </tr>
                                    `)}
                                </tbody>
                            </table>
                        ` : html`
                            <div class="empty-state">
                                <i data-lucide="award" aria-hidden="true"></i>
                                <p>${t('analytics.noCampaignData')}</p>
                            </div>
                        `}
                    </div>
                </div>

                <div class="chart-card surface">
                    <div class="chart-card-header">
                        <span class="chart-card-title">${t('analytics.platformSplit')}</span>
                    </div>
                    <div class="platform-legend">
                        <div class="platform-legend-row">
                            <span>${t('common.instagram')}</span>
                            <strong class="text-strong">${t('analytics.share', {
                                count: UI.formatNumber(igCount), percent: UI.formatNumber(igPct),
                            })}</strong>
                        </div>
                        <div class="platform-legend-row">
                            <span>${t('common.facebook')}</span>
                            <strong class="text-strong">${t('analytics.share', {
                                count: UI.formatNumber(fbCount), percent: UI.formatNumber(fbPct),
                            })}</strong>
                        </div>
                    </div>
                    <div class="platform-bar" role="img"
                         aria-label="${t('analytics.share', { count: UI.formatNumber(igCount), percent: UI.formatNumber(igPct) })} — ${t('common.instagram')}">
                        <span class="platform-bar-ig" data-share="${total > 0 ? igPct : 0}"></span>
                        <span class="platform-bar-fb" data-share="${total > 0 ? fbPct : 0}"></span>
                    </div>
                    <div class="platform-totals">
                        <div>
                            <p class="platform-total-value">${UI.formatNumber(igCount)}</p>
                            <p class="platform-total-label">${t('common.instagram')} · ${t('analytics.hits')}</p>
                        </div>
                        <div class="platform-totals-divider" aria-hidden="true"></div>
                        <div>
                            <p class="platform-total-value">${UI.formatNumber(fbCount)}</p>
                            <p class="platform-total-label">${t('common.facebook')} · ${t('analytics.hits')}</p>
                        </div>
                    </div>
                </div>
            </div>
        `);

        UI.icons(container);

        // The two bar widths are data, not style: set as inline flex-basis from
        // the data-share attribute rather than interpolated into the markup.
        container.querySelectorAll('.platform-bar > span[data-share]').forEach((el) => {
            el.style.flexBasis = `${Number(el.dataset.share) || 0}%`;
        });

        if (typeof Chart === 'undefined') return;
        const c = Charts.palette();

        const bars = Charts.create('analytics-line', {
            type: 'bar',
            data: {
                labels: daily.map((d) => UI.formatDayShort(d.day)),
                datasets: [{
                    label: t('common.sent'),
                    data: daily.map((d) => d.sent),
                    backgroundColor: Charts.alpha(c.positive, 0.75),
                    borderRadius: 6,
                }, {
                    label: t('common.failed'),
                    data: daily.map((d) => d.failed),
                    backgroundColor: Charts.alpha(c.negative, 0.65),
                    borderRadius: 6,
                }],
            },
            options: Charts.cartesian({ scales: { x: { stacked: true }, y: { stacked: true } } }),
        });
        if (bars) this.charts.push(bars);

        const donut = Charts.create('analytics-donut', {
            type: 'doughnut',
            data: Charts.statusData(stats.sent, stats.failed),
            options: Charts.doughnut(),
        });
        if (donut) this.charts.push(donut);
    },
};
