/**
 * Overview Page — Dashboard home with hero stats and activity chart.
 */
const OverviewPage = {
    chart: null,

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();

        try {
            const [stats, interactions] = await Promise.all([
                API.getStats(),
                API.getInteractions({ limit: 8 }),
            ]);

            container.innerHTML = `
                <div class="stats-grid">
                    <div class="stat-card glass-card">
                        <div class="stat-header">
                            <span class="stat-label">Total DMs Sent</span>
                            <div class="stat-icon accent"><i data-lucide="send"></i></div>
                        </div>
                        <div class="stat-value" id="stat-sent">0</div>
                        <div class="stat-change">${stats.todayActivity} today</div>
                    </div>
                    <div class="stat-card glass-card">
                        <div class="stat-header">
                            <span class="stat-label">Success Rate</span>
                            <div class="stat-icon success"><i data-lucide="check-circle"></i></div>
                        </div>
                        <div class="stat-value" id="stat-rate">0</div>
                        <div class="stat-change">${stats.sent} sent / ${stats.failed} failed</div>
                    </div>
                    <div class="stat-card glass-card">
                        <div class="stat-header">
                            <span class="stat-label">Users Reached</span>
                            <div class="stat-icon warning"><i data-lucide="users"></i></div>
                        </div>
                        <div class="stat-value" id="stat-users">0</div>
                        <div class="stat-change">Unique users reached</div>
                    </div>
                    <div class="stat-card glass-card">
                        <div class="stat-header">
                            <span class="stat-label">Active Campaigns</span>
                            <div class="stat-icon accent"><i data-lucide="megaphone"></i></div>
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
                            <canvas id="activity-chart"></canvas>
                        </div>
                    </div>
                    <div class="chart-card glass-card">
                        <div class="chart-card-header">
                            <span class="chart-card-title">Status Breakdown</span>
                        </div>
                        <div class="chart-wrapper">
                            <canvas id="status-chart"></canvas>
                        </div>
                    </div>
                </div>

                <div class="table-card glass-card">
                    <div class="table-header">
                        <span class="table-title">Recent Activity</span>
                        <button class="btn btn-secondary btn-sm" onclick="App.navigate('activity')">View All</button>
                    </div>
                    <div class="table-wrapper">
                        <table class="data-table">
                            <thead><tr>
                                <th>User</th><th>Keyword</th><th>Status</th><th>Time</th>
                            </tr></thead>
                            <tbody>
                                ${interactions.data.map(i => `
                                    <tr>
                                        <td><a href="https://instagram.com/${i.sender_username}" target="_blank" class="username-link">@${i.sender_username}</a></td>
                                        <td>${i.trigger_keyword || '—'}</td>
                                        <td><span class="status-pill ${i.status.toLowerCase()}">${i.status}</span></td>
                                        <td>${UI.formatDate(i.timestamp)}</td>
                                    </tr>
                                `).join('')}
                                ${interactions.data.length === 0 ? '<tr><td colspan="4" style="text-align:center;padding:30px;color:var(--text-muted);">No activity yet.</td></tr>' : ''}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;

            lucide.createIcons({ nodes: [container] });

            // Animate counters
            UI.animateCounter(document.getElementById('stat-sent'), stats.sent);
            UI.animateCounter(document.getElementById('stat-rate'), stats.successRate);
            UI.animateCounter(document.getElementById('stat-users'), stats.uniqueUsersReached);
            UI.animateCounter(document.getElementById('stat-campaigns'), stats.activeCampaigns);

            // Add % suffix to rate
            const rateEl = document.getElementById('stat-rate');
            setTimeout(() => { rateEl.textContent += '%'; }, 1300);

            // Render charts
            await this.renderCharts(stats);

        } catch (err) {
            container.innerHTML = `<div class="empty-state"><i data-lucide="wifi-off"></i><h3>Connection Error</h3><p>${err.message}</p></div>`;
            lucide.createIcons({ nodes: [container] });
        }
    },

    async renderCharts(stats) {
        // Activity chart
        try {
            const hourly = await API.getDailyStats(7);
            const ctx = document.getElementById('activity-chart')?.getContext('2d');
            if (!ctx) return;

            new Chart(ctx, {
                type: 'line',
                data: {
                    labels: hourly.map(h => new Date(h.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
                    datasets: [{
                        label: 'Sent',
                        data: hourly.map(h => h.sent),
                        borderColor: '#22c55e',
                        backgroundColor: 'rgba(34,197,94,0.1)',
                        fill: true, tension: 0.4, pointRadius: 4, pointHoverRadius: 6,
                    }, {
                        label: 'Failed',
                        data: hourly.map(h => h.failed),
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239,68,68,0.05)',
                        fill: true, tension: 0.4, pointRadius: 4, pointHoverRadius: 6,
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: '#94a3b8', font: { family: 'Inter' } } } },
                    scales: {
                        x: { ticks: { color: '#475569', font: { family: 'Inter' } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                        y: { ticks: { color: '#475569', font: { family: 'Inter' } }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true }
                    }
                }
            });
        } catch (e) { console.warn('Chart error:', e); }

        // Status donut
        try {
            const ctx2 = document.getElementById('status-chart')?.getContext('2d');
            if (!ctx2) return;

            new Chart(ctx2, {
                type: 'doughnut',
                data: {
                    labels: ['Sent', 'Failed'],
                    datasets: [{
                        data: [stats.sent, stats.failed],
                        backgroundColor: ['#22c55e', '#ef4444'],
                        borderWidth: 0,
                        hoverOffset: 8,
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    cutout: '72%',
                    plugins: {
                        legend: { position: 'bottom', labels: { color: '#94a3b8', font: { family: 'Inter' }, padding: 16 } }
                    }
                }
            });
        } catch (e) { console.warn('Donut chart error:', e); }
    }
};
