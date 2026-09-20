/**
 * Overview Page — Dashboard home with hero stats and activity chart.
 */
const OverviewPage = {
    charts: [],

    destroy() {
        this.charts.forEach((c) => { try { c.destroy(); } catch (e) { /* already gone */ } });
        this.charts = [];
    },

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader('Loading overview…');
        this.destroy();

        let stats;
        let interactions;
        try {
            [stats, interactions] = await Promise.all([
                API.getStats(),
                API.getInteractions({ limit: 8 }),
            ]);
        } catch (err) {
            UI.renderError(
                container,
                {
                    icon: 'wifi-off',
                    title: 'Could not load the dashboard',
                    message: err.message,
                    hint: err.isNetworkError ? 'The dashboard could not reach /api at all.' : '',
                },
                () => this.render()
            );
            return;
        }

        const rows = (interactions && interactions.data) || [];

        container.innerHTML = esc(html`
            <div class="stats-grid">
                <div class="stat-card glass-card">
                    <div class="stat-header">
                        <span class="stat-label">Total DMs Sent</span>
                        <div class="stat-icon accent"><i data-lucide="send" aria-hidden="true"></i></div>
                    </div>
                    <div class="stat-value" id="stat-sent">0</div>
                    <div class="stat-change">${stats.todayActivity} today</div>
                </div>
                <div class="stat-card glass-card">
                    <div class="stat-header">
                        <span class="stat-label">Success Rate</span>
                        <div class="stat-icon success"><i data-lucide="check-circle" aria-hidden="true"></i></div>
                    </div>
                    <div class="stat-value" id="stat-rate">0</div>
                    <div class="stat-change">${stats.sent} sent / ${stats.failed} failed</div>
                </div>
                <div class="stat-card glass-card">
                    <div class="stat-header">
                        <span class="stat-label">Users Reached</span>
                        <div class="stat-icon warning"><i data-lucide="users" aria-hidden="true"></i></div>
                    </div>
                    <div class="stat-value" id="stat-users">0</div>
                    <div class="stat-change">Unique users reached</div>
                </div>
                <div class="stat-card glass-card">
                    <div class="stat-header">
                        <!-- Renamed: the backing query counts every campaign row, with no
                             WHERE is_active, so "Active Campaigns" was never true. -->
                        <span class="stat-label">Total Campaigns</span>
                        <div class="stat-icon accent"><i data-lucide="megaphone" aria-hidden="true"></i></div>
                    </div>
                    <div class="stat-value" id="stat-campaigns">0</div>
                    <div class="stat-change">${stats.totalInteractions} total interactions</div>
                </div>
            </div>

            <div class="chart-grid">
                <div class="chart-card glass-card">
                    <div class="chart-card-header">
                        <span class="chart-card-title">DM Activity — Last 7 Days</span>
                    </div>
                    <div class="chart-wrapper">
                        <canvas id="activity-chart" aria-label="DM activity over the last 7 days" role="img"></canvas>
                    </div>
                </div>
                <div class="chart-card glass-card">
                    <div class="chart-card-header">
                        <span class="chart-card-title">Status Breakdown</span>
                    </div>
                    <div class="chart-wrapper">
                        <canvas id="status-chart" aria-label="Sent versus failed breakdown" role="img"></canvas>
                    </div>
                </div>
            </div>

            <div class="table-card glass-card">
                <div class="table-header">
                    <span class="table-title">Recent Activity</span>
                    <button type="button" class="btn btn-secondary btn-sm" data-action="app:navigate" data-target="activity">View All</button>
                </div>
                <div class="table-wrapper">
                    <table class="data-table">
                        <thead><tr>
                            <th scope="col">User</th><th scope="col">Keyword</th><th scope="col">Status</th><th scope="col">Time</th>
                        </tr></thead>
                        <tbody>
                            ${rows.map((i) => html`
                                <tr>
                                    <td>${UI.userCell(i)}</td>
                                    <td dir="auto">${i.trigger_keyword || '—'}</td>
                                    <td><span class="status-pill ${String(i.status || '').toLowerCase()}">${i.status}</span></td>
                                    <td>${UI.formatDate(i.timestamp)}</td>
                                </tr>
                            `)}
                            ${rows.length === 0
                                ? html`<tr><td colspan="4" class="table-empty-cell">No activity yet.</td></tr>`
                                : ''}
                        </tbody>
                    </table>
                </div>
            </div>
        `);

        UI.icons(container);

        UI.animateCounter(document.getElementById('stat-sent'), stats.sent);
        UI.animateCounter(document.getElementById('stat-rate'), stats.successRate);
        UI.animateCounter(document.getElementById('stat-users'), stats.uniqueUsersReached);
        UI.animateCounter(document.getElementById('stat-campaigns'), stats.activeCampaigns);

        const rateEl = document.getElementById('stat-rate');
        setTimeout(() => { if (rateEl && rateEl.isConnected) rateEl.textContent += '%'; }, 1300);

        await this.renderCharts(stats);
    },

    async renderCharts(stats) {
        if (typeof Chart === 'undefined') return;

        const tickColor = '#94a3b8';
        const gridColor = 'rgba(255,255,255,0.06)';

        try {
            const daily = await API.getDailyStats(7);
            const ctx = document.getElementById('activity-chart');
            if (ctx) {
                this.charts.push(new Chart(ctx.getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: daily.map((h) => UI.formatDay(h.day)),
                        datasets: [{
                            label: 'Sent',
                            data: daily.map((h) => h.sent),
                            borderColor: '#22c55e',
                            backgroundColor: 'rgba(34,197,94,0.1)',
                            fill: true, tension: 0.4, pointRadius: 4, pointHoverRadius: 6,
                        }, {
                            label: 'Failed',
                            data: daily.map((h) => h.failed),
                            borderColor: '#ef4444',
                            backgroundColor: 'rgba(239,68,68,0.05)',
                            fill: true, tension: 0.4, pointRadius: 4, pointHoverRadius: 6,
                        }],
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { legend: { labels: { color: tickColor, font: { family: 'Inter' } } } },
                        scales: {
                            x: { ticks: { color: tickColor, font: { family: 'Inter' } }, grid: { color: gridColor } },
                            y: { ticks: { color: tickColor, font: { family: 'Inter' } }, grid: { color: gridColor }, beginAtZero: true },
                        },
                    },
                }));
            }
        } catch (e) { console.warn('Chart error:', e); }

        try {
            const ctx2 = document.getElementById('status-chart');
            if (ctx2) {
                this.charts.push(new Chart(ctx2.getContext('2d'), {
                    type: 'doughnut',
                    data: {
                        labels: ['Sent', 'Failed'],
                        datasets: [{
                            data: [stats.sent, stats.failed],
                            backgroundColor: ['#22c55e', '#ef4444'],
                            borderWidth: 0,
                            hoverOffset: 8,
                        }],
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        cutout: '72%',
                        plugins: { legend: { position: 'bottom', labels: { color: tickColor, font: { family: 'Inter' }, padding: 16 } } },
                    },
                }));
            }
        } catch (e) { console.warn('Donut chart error:', e); }
    },
};
