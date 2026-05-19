/**
 * Analytics Page — Charts and insights.
 */
const AnalyticsPage = {
    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();

        try {
            const [stats, daily] = await Promise.all([
                API.getStats(),
                API.getDailyStats(30),
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
