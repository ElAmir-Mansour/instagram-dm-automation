/**
 * Overview — the morning screen.
 *
 * ─── What changed and why ───────────────────────────────────────────────────
 * This page used to be four vanity tiles and two charts: "Total DMs Sent",
 * "Success Rate", "Users Reached", "Total Campaigns". None of them answers the
 * question the operator actually opens the dashboard with, which is *is
 * anything broken right now, and what do I have to do about it*. Cumulative
 * totals never change fast enough to be news, and a 96% success rate looks
 * calm while forty DMs failed this morning.
 *
 * So the page now leads with a briefing: a short list of things that are wrong
 * and a link straight to the screen that fixes each one. The totals stay,
 * below it, because they are worth a glance — they are just not the headline.
 *
 * Everything is assembled from endpoints that already exist. Each source is
 * fetched with allSettled, so a failing token check (or an admin route that is
 * not deployed) removes one card instead of blanking the page.
 */
const OverviewPage = {
    charts: [],

    destroy() {
        this.charts.forEach((c) => { try { c.destroy(); } catch (e) { /* already gone */ } });
        this.charts = [];
    },

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();
        this.destroy();

        const [statsRes, recentRes, failedRes, tokenRes, postsRes, threadsRes] = await Promise.allSettled([
            API.getStats(),
            API.getInteractions({ limit: 8 }),
            API.getInteractions({ status: 'FAILED', limit: 50 }),
            API.getTokenStatus(),
            API.getScheduledPosts(),
            API.getConversations(),
        ]);

        // Only the core stats call is fatal: without it there is no page.
        if (statsRes.status !== 'fulfilled') {
            const err = statsRes.reason || new Error(t('error.unexpected'));
            UI.renderError(container, {
                icon: 'wifi-off',
                title: t('error.pageTitle'),
                message: err.message,
                hint: err.isNetworkError ? t('error.network') : '',
            }, () => this.render());
            return;
        }

        const stats = statsRes.value || {};
        const rows = (recentRes.status === 'fulfilled' && recentRes.value && recentRes.value.data) || [];
        const alerts = this.buildAlerts(stats, failedRes, tokenRes, postsRes, threadsRes);

        container.innerHTML = esc(html`
            ${this.renderBriefing(alerts)}
            ${this.renderStats(stats)}

            <div class="chart-grid">
                <div class="chart-card surface">
                    <div class="chart-card-header">
                        <span class="chart-card-title">${t('overview.chart.activity')}</span>
                    </div>
                    <div class="chart-wrapper">
                        <canvas id="activity-chart" role="img" aria-label="${t('overview.chart.activity')}"></canvas>
                    </div>
                </div>
                <div class="chart-card surface">
                    <div class="chart-card-header">
                        <span class="chart-card-title">${t('overview.chart.status')}</span>
                    </div>
                    <div class="chart-wrapper">
                        <canvas id="status-chart" role="img" aria-label="${t('overview.chart.status')}"></canvas>
                    </div>
                </div>
            </div>

            <div class="table-card surface">
                <div class="table-header">
                    <span class="table-title">${t('overview.recent')}</span>
                    <button type="button" class="btn btn-secondary btn-sm" data-action="app:navigate" data-target="activity">
                        ${t('common.viewAll')}
                    </button>
                </div>
                <div class="table-wrapper">
                    <table class="data-table">
                        <thead><tr>
                            <th scope="col">${t('table.user')}</th>
                            <th scope="col">${t('table.keyword')}</th>
                            <th scope="col">${t('table.status')}</th>
                            <th scope="col">${t('table.time')}</th>
                        </tr></thead>
                        <tbody>
                            ${rows.map((i) => html`
                                <tr>
                                    <td>${UI.userCell(i)}</td>
                                    <td dir="auto">${i.trigger_keyword || '—'}</td>
                                    <td><span class="status-pill ${String(i.status || '').toLowerCase()}">${UI.statusLabel(i.status)}</span></td>
                                    <td class="nowrap">${UI.formatDate(i.timestamp)}</td>
                                </tr>
                            `)}
                            ${rows.length === 0
                                ? html`<tr><td colspan="4" class="table-empty-cell">${t('table.noActivity')}</td></tr>`
                                : ''}
                        </tbody>
                    </table>
                </div>
            </div>
        `);

        UI.icons(container);

        UI.animateCounter(document.getElementById('stat-sent'), stats.sent);
        UI.animateCounter(document.getElementById('stat-users'), stats.uniqueUsersReached);
        UI.animateCounter(document.getElementById('stat-campaigns'), stats.activeCampaigns);

        await this.renderCharts(stats);
    },

    // ─── Briefing ────────────────────────────────────────────────────────────

    /**
     * Turn six API answers into a list of things that are actually wrong.
     * Ordered by how much damage they are doing right now: a dead token stops
     * everything, a failed DM already lost a customer, an overdue post is just
     * late.
     */
    buildAlerts(stats, failedRes, tokenRes, postsRes, threadsRes) {
        const alerts = [];
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        // 1. Access token — nothing works without it.
        if (tokenRes.status === 'fulfilled' && tokenRes.value) {
            const token = tokenRes.value;
            if (token.status && token.status !== 'valid') {
                alerts.push({
                    level: 'danger', icon: 'key-round',
                    title: t('overview.alert.tokenInvalid'),
                    body: t('overview.alert.tokenInvalidBody'),
                    action: t('overview.openSettings'), target: 'settings',
                });
            } else if (token.expiresAt) {
                const days = Math.ceil((new Date(token.expiresAt) - Date.now()) / 86400000);
                if (Number.isFinite(days) && days <= 14) {
                    alerts.push({
                        level: 'warning', icon: 'clock-alert',
                        title: t('overview.alert.tokenExpiring', { count: Math.max(days, 0) }),
                        body: t('overview.alert.tokenExpiringBody'),
                        action: t('overview.openSettings'), target: 'settings',
                    });
                }
            }
        }

        // 2. DMs that failed today. /interactions has no date filter, so the
        //    most recent failures are fetched and counted client-side.
        if (failedRes.status === 'fulfilled' && failedRes.value) {
            const failedToday = ((failedRes.value.data) || []).filter((row) => {
                const at = row.timestamp ? new Date(row.timestamp) : null;
                return at && !Number.isNaN(at.getTime()) && at >= startOfToday;
            }).length;
            if (failedToday > 0) {
                alerts.push({
                    level: 'danger', icon: 'send-horizontal',
                    title: t('overview.alert.failedToday', { count: failedToday }),
                    body: t('overview.alert.failedTodayBody'),
                    action: t('overview.openActivity'), target: 'activity',
                });
            }
        }

        // 3. The publishing queue.
        if (postsRes.status === 'fulfilled' && Array.isArray(postsRes.value)) {
            const posts = postsRes.value;
            const now = Date.now();
            const overdue = posts.filter((p) => (
                p.status === 'PENDING' && p.scheduled_time && new Date(p.scheduled_time).getTime() < now
            )).length;
            const failed = posts.filter((p) => p.status === 'FAILED').length;

            if (failed > 0) {
                alerts.push({
                    level: 'danger', icon: 'image-off',
                    title: t('overview.alert.failedPosts', { count: failed }),
                    body: t('overview.alert.failedPostsBody'),
                    action: t('overview.openPosts'), target: 'posts',
                });
            }
            if (overdue > 0) {
                alerts.push({
                    level: 'warning', icon: 'calendar-clock',
                    title: t('overview.alert.overduePosts', { count: overdue }),
                    body: t('overview.alert.overduePostsBody'),
                    action: t('overview.openPosts'), target: 'posts',
                });
            }
        }

        // 4. Conversations where the AI is off and the customer spoke last —
        //    nobody is going to answer these unless a human does.
        if (threadsRes.status === 'fulfilled' && threadsRes.value) {
            const waiting = ((threadsRes.value.data) || []).filter((thread) => (
                thread.is_bot_active === false && thread.last_message_direction === 'inbound'
            )).length;
            if (waiting > 0) {
                alerts.push({
                    level: 'warning', icon: 'message-square-dot',
                    title: t('overview.alert.waitingHumans', { count: waiting }),
                    body: t('overview.alert.waitingHumansBody'),
                    action: t('overview.openInbox'), target: 'inbox',
                });
            }
        }

        // 5. Nothing is armed at all.
        if (Number(stats.activeCampaigns) === 0) {
            alerts.push({
                level: 'info', icon: 'megaphone-off',
                title: t('overview.alert.noCampaigns'),
                body: t('overview.alert.noCampaignsBody'),
                action: t('overview.openCampaigns'), target: 'campaigns',
            });
        }

        return alerts;
    },

    renderBriefing(alerts) {
        return html`
            <section class="briefing" aria-labelledby="briefing-heading">
                <div class="briefing-head">
                    <h2 id="briefing-heading">${alerts.length ? t('overview.attention') : t('overview.briefing')}</h2>
                    <span class="briefing-date">${UI.formatWeekday(new Date())}</span>
                </div>
                ${alerts.length === 0 ? html`
                    <div class="alert-card alert-success">
                        <span class="alert-icon"><i data-lucide="check-circle" aria-hidden="true"></i></span>
                        <div>
                            <h3>${t('overview.allClear')}</h3>
                            <p>${t('overview.allClearBody')}</p>
                        </div>
                    </div>
                ` : html`
                    <div class="briefing-list">
                        ${alerts.map((a) => html`
                            <div class="alert-card alert-${html.raw(a.level)}">
                                <span class="alert-icon"><i data-lucide="${a.icon}" aria-hidden="true"></i></span>
                                <div>
                                    <h3>${a.title}</h3>
                                    <p>${a.body}</p>
                                    <button type="button" class="alert-link" data-action="app:navigate" data-target="${a.target}">
                                        ${a.action}
                                        <i data-lucide="arrow-right" aria-hidden="true"></i>
                                    </button>
                                </div>
                            </div>
                        `)}
                    </div>
                `}
            </section>
        `;
    },

    renderStats(stats) {
        return html`
            <div class="stats-grid">
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('overview.stat.sent')}</span>
                        <span class="stat-icon accent"><i data-lucide="send" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value" id="stat-sent">0</p>
                    <p class="stat-sub">${t('overview.stat.sentSub', { count: UI.formatNumber(stats.todayActivity) })}</p>
                </div>
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('overview.stat.successRate')}</span>
                        <span class="stat-icon success"><i data-lucide="check-circle" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value">${UI.formatPercent(stats.successRate)}</p>
                    <p class="stat-sub">${t('overview.stat.successRateSub', {
                        sent: UI.formatNumber(stats.sent), failed: UI.formatNumber(stats.failed),
                    })}</p>
                </div>
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('overview.stat.users')}</span>
                        <span class="stat-icon warning"><i data-lucide="users" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value" id="stat-users">0</p>
                    <p class="stat-sub">${t('overview.stat.usersSub')}</p>
                </div>
                <div class="stat-card surface">
                    <!-- "Total", not "Active": the backing query counts every
                         campaign row with no WHERE is_active. -->
                    <div class="stat-header">
                        <span class="stat-label">${t('overview.stat.campaigns')}</span>
                        <span class="stat-icon accent"><i data-lucide="megaphone" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value" id="stat-campaigns">0</p>
                    <p class="stat-sub">${t('overview.stat.campaignsSub', { count: UI.formatNumber(stats.totalInteractions) })}</p>
                </div>
            </div>
        `;
    },

    async renderCharts(stats) {
        if (typeof Chart === 'undefined') return;
        const c = Charts.palette();

        try {
            const daily = await API.getDailyStats(7);
            const chart = Charts.create('activity-chart', {
                type: 'line',
                data: {
                    labels: daily.map((d) => UI.formatDayShort(d.day)),
                    datasets: [{
                        label: t('common.sent'),
                        data: daily.map((d) => d.sent),
                        borderColor: c.positive,
                        backgroundColor: Charts.alpha(c.positive, 0.12),
                        fill: true, tension: 0.35, pointRadius: 3, pointHoverRadius: 6,
                    }, {
                        label: t('common.failed'),
                        data: daily.map((d) => d.failed),
                        borderColor: c.negative,
                        backgroundColor: Charts.alpha(c.negative, 0.08),
                        fill: true, tension: 0.35, pointRadius: 3, pointHoverRadius: 6,
                    }],
                },
                options: Charts.cartesian(),
            });
            if (chart) this.charts.push(chart);
        } catch (e) {
            console.warn('Activity chart error:', e);
        }

        const donut = Charts.create('status-chart', {
            type: 'doughnut',
            data: Charts.statusData(stats.sent, stats.failed),
            options: Charts.doughnut(),
        });
        if (donut) this.charts.push(donut);
    },
};
