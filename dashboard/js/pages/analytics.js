/**
 * Analytics Page — Charts and insights.
 */
const AnalyticsPage = {
    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();

        try {
            const [stats, daily, campaignStats] = await Promise.all([
                API.getStats(),
                API.getDailyStats(30),
                API.getCampaignStats(),
            ]);

            container.innerHTML = `
                <div class="stats-grid" style="margin-bottom:24px;">
                    <div class="stat-card glass-card">
                        <div class="stat-header"><span class="stat-label">Total Interactions</span><div class="stat-icon accent"><i data-lucide="activity"></i></div></div>
                        <div class="stat-value">${stats.totalInteractions}</div>
                    </div>
                    <div class="stat-card glass-card">
                        <div class="stat-header"><span class="stat-label">Success Rate</span><div class="stat-icon success"><i data-lucide="trending-up"></i></div></div>
                        <div class="stat-value">${stats.successRate}%</div>
                    </div>
                    <div class="stat-card glass-card">
                        <div class="stat-header"><span class="stat-label">Users Reached</span><div class="stat-icon warning"><i data-lucide="users"></i></div></div>
                        <div class="stat-value">${stats.uniqueUsersReached}</div>
                    </div>
                    <div class="stat-card glass-card">
                        <div class="stat-header"><span class="stat-label">Today</span><div class="stat-icon accent"><i data-lucide="calendar"></i></div></div>
                        <div class="stat-value">${stats.todayActivity}</div>
                    </div>
                </div>
                <div class="chart-grid">
                    <div class="chart-card glass-card">
                        <div class="chart-card-header"><span class="chart-card-title">DMs Over Last 30 Days</span></div>
                        <div class="chart-wrapper"><canvas id="analytics-line"></canvas></div>
                    </div>
                    <div class="chart-card glass-card">
                        <div class="chart-card-header"><span class="chart-card-title">Sent vs Failed</span></div>
                        <div class="chart-wrapper"><canvas id="analytics-donut"></canvas></div>
                    </div>
                </div>
                <div class="chart-grid" style="margin-top: 24px;">
                    <div class="chart-card glass-card" style="padding: 24px;">
                        <div class="chart-card-header">
                            <span class="chart-card-title">Top Performing Campaigns</span>
                        </div>
                        <div class="table-wrapper">
                            ${campaignStats && campaignStats.length > 0 ? `
                                <table class="data-table">
                                    <thead>
                                        <tr>
                                            <th>Trigger Keyword</th>
                                            <th style="text-align: right;">Total Matches</th>
                                            <th style="text-align: right;">Sent (Success)</th>
                                            <th style="text-align: right;">Failed</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${campaignStats.map(c => `
                                            <tr>
                                                <td><span class="campaign-keyword" style="margin: 0; font-size: 12px; padding: 4px 10px;">${c.trigger_keyword}</span></td>
                                                <td style="text-align: right; font-weight: 600;">${c.total_triggers}</td>
                                                <td style="text-align: right; color: var(--success);">${c.sent_count}</td>
                                                <td style="text-align: right; color: var(--danger);">${c.failed_count}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            ` : `
                                <div class="empty-state" style="padding: 20px;">
                                    <i data-lucide="award" style="width:32px;height:32px;"></i>
                                    <p>No campaign performance data yet.</p>
                                </div>
                            `}
                        </div>
                    </div>
                    <div class="chart-card glass-card">
                        <div class="chart-card-header">
                            <span class="chart-card-title">Platform Distribution</span>
                        </div>
                        <div style="display:flex; flex-direction:column; justify-content:center; height: calc(100% - 40px); padding: 10px 0;">
                            <div style="display:flex; justify-content:space-between; margin-bottom: 8px; font-size: 13px; color: var(--text-secondary);">
                                <span>Instagram</span>
                                <span style="font-weight: 600; color: var(--accent);">${stats.instagramCount || 0} (${stats.totalInteractions > 0 ? Math.round((stats.instagramCount / stats.totalInteractions) * 100) : 0}%)</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; margin-bottom: 20px; font-size: 13px; color: var(--text-secondary);">
                                <span>Facebook</span>
                                <span style="font-weight: 600; color: #1877f2;">${stats.facebookCount || 0} (${stats.totalInteractions > 0 ? Math.round((stats.facebookCount / stats.totalInteractions) * 100) : 0}%)</span>
                            </div>
                            <div style="height: 10px; border-radius: 5px; background: rgba(255,255,255,0.05); display: flex; overflow: hidden; margin-bottom: 24px;">
                                <div style="width: ${stats.totalInteractions > 0 ? (stats.instagramCount / stats.totalInteractions) * 100 : 50}%; background: var(--gradient-hero);"></div>
                                <div style="width: ${stats.totalInteractions > 0 ? (stats.facebookCount / stats.totalInteractions) * 100 : 50}%; background: #1877f2;"></div>
                            </div>
                            <div style="display: flex; justify-content: space-around; text-align: center;">
                                <div>
                                    <div style="font-size: 20px; font-weight: 700; color: var(--text-primary);">${stats.instagramCount || 0}</div>
                                    <div style="font-size: 11px; color: var(--text-muted);">Instagram Hits</div>
                                </div>
                                <div style="border-left: 1px solid var(--border-glass); height: 32px;"></div>
                                <div>
                                    <div style="font-size: 20px; font-weight: 700; color: var(--text-primary);">${stats.facebookCount || 0}</div>
                                    <div style="font-size: 11px; color: var(--text-muted);">Facebook Hits</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            lucide.createIcons({ nodes: [container] });

            // Line chart
            const ctx = document.getElementById('analytics-line')?.getContext('2d');
            if (ctx) {
                new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: daily.map(d => new Date(d.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
                        datasets: [{
                            label: 'Sent', data: daily.map(d => d.sent),
                            backgroundColor: 'rgba(34,197,94,0.6)', borderRadius: 6,
                        }, {
                            label: 'Failed', data: daily.map(d => d.failed),
                            backgroundColor: 'rgba(239,68,68,0.5)', borderRadius: 6,
                        }]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { legend: { labels: { color: '#94a3b8', font: { family: 'Inter' } } } },
                        scales: {
                            x: { stacked: true, ticks: { color: '#475569' }, grid: { color: 'rgba(255,255,255,0.04)' } },
                            y: { stacked: true, ticks: { color: '#475569' }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true }
                        }
                    }
                });
            }

            // Donut
            const ctx2 = document.getElementById('analytics-donut')?.getContext('2d');
            if (ctx2) {
                new Chart(ctx2, {
                    type: 'doughnut',
                    data: {
                        labels: ['Sent', 'Failed'],
                        datasets: [{ data: [stats.sent, stats.failed], backgroundColor: ['#22c55e', '#ef4444'], borderWidth: 0, hoverOffset: 8 }]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false, cutout: '72%',
                        plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', font: { family: 'Inter' }, padding: 16 } } }
                    }
                });
            }
        } catch (err) {
            container.innerHTML = `<div class="empty-state"><i data-lucide="alert-circle"></i><h3>Error</h3><p>${err.message}</p></div>`;
            lucide.createIcons({ nodes: [container] });
        }
    }
};
