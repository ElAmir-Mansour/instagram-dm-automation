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
 * Everything is assembled from endpoints that already exist.
 *
 * ─── Why this page renders in four pieces ───────────────────────────────────
 * Six requests go out on load, deliberately, because the briefing needs six
 * answers. It used to `await Promise.allSettled` on all six and render nothing
 * until the slowest returned — and then fire a SEVENTH request for the daily
 * series before it could draw the chart, so the page's real cost was two
 * round trips deep, not one.
 *
 * Now the frame is painted immediately as four regions, every request
 * (including the daily series and Chart.js itself) goes out in the same tick,
 * and each region fills the moment its own source lands. The layout does not
 * move as they arrive because every region's skeleton is built from the real
 * component classes and therefore already occupies the real component's box.
 *
 * Only the core stats call is still fatal: without it there is no page.
 */
const OverviewPage = {

    /** Guards a fill against landing after the operator has navigated away. */
    _seq: 0,

    /**
     * Success-rate thresholds — named so they are not a magic number buried
     * in a conditional. `SUCCESS_RATE_*` colour the all-time `stats.successRate`
     * stat tile (below `DANGER_MAX` → danger, up to `WARNING_MAX` → warning,
     * above → success — same text-success/text-warning/text-danger classes the
     * per-campaign table in analytics.js already uses).
     *
     * `TRAILING_SUCCESS_RATE_ALERT_MIN` is deliberately a separate number: it
     * gates the 7-day-window alert in buildAlerts(), not the stat tile. An
     * all-time rate is diluted by a long history and can look calm through a
     * genuinely bad week — see buildAlerts() below.
     */
    SUCCESS_RATE_DANGER_MAX: 70,
    SUCCESS_RATE_WARNING_MAX: 90,
    TRAILING_SUCCESS_RATE_ALERT_MIN: 85,

    /** text-success / text-warning / text-danger for a 0–100 rate, or '' if unknown. */
    successRateClass(rate) {
        const n = Number(rate);
        if (!Number.isFinite(n)) return '';
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

    /**
     * The frame. `App.navigate` paints this inside the view transition, and
     * `render()` fills the four `[data-region]` hosts in place rather than
     * replacing the container — which is why the regions can land in any
     * order without the page reflowing.
     */
    skeleton() {
        return html`
            <div data-region="briefing">${this.briefingSkeleton()}</div>
            <div data-region="stats">${Motion.statsGrid(4)}</div>
            <div data-region="charts">${Motion.chartGrid(2)}</div>
            <div data-region="recent">
                ${Motion.tableCard(8, [t('table.user'), t('table.keyword'), t('table.status'), t('table.time')])}
            </div>
            <div data-region="busy">${Motion.busy()}</div>
        `;
    },

    /** Sized to the all-clear card, which is the state this page is in most days. */
    briefingSkeleton() {
        return html`
            <section class="briefing" aria-hidden="true">
                <div class="briefing-head">
                    <h2>${Motion.line('md')}</h2>
                    <span class="briefing-date">${Motion.line('full')}</span>
                </div>
                <div class="alert-card">
                    <span class="alert-icon"></span>
                    <div>
                        <h3>${Motion.line('md')}</h3>
                        <p>${Motion.line('lg')}</p>
                    </div>
                </div>
            </section>
        `;
    },

    region(name) {
        const container = document.getElementById('page-container');
        if (!container) return null;
        return container.querySelector(`[data-region="${name}"]`);
    },

    /** Turn a promise into an allSettled-shaped record without awaiting it. */
    _settle(promise) {
        return promise.then(
            (value) => ({ status: 'fulfilled', value }),
            (reason) => ({ status: 'rejected', reason })
        );
    },

    render() {
        const container = document.getElementById('page-container');
        if (!container) return;

        this.destroy();
        const seq = this._seq;
        const live = () => seq === this._seq && !!document.getElementById('page-container');

        // Painted by App.navigate on a navigation; painted here on a retry or
        // a theme change, where the container holds something else.
        if (!container.querySelector('[data-region="briefing"]')) {
            container.innerHTML = esc(this.skeleton());
            UI.icons(container);
        }
        Motion.clearSkeleton(container);

        // Every request in the same tick, including the daily series that used
        // to wait for the other six and the chart library that used to be
        // ~201KB on the critical path of all ten screens.
        const statsP = this._settle(API.getStats());
        const recentP = this._settle(API.getInteractions({ limit: 8 }));
        const failedP = this._settle(API.getInteractions({ status: 'FAILED', limit: 50 }));
        const tokenP = this._settle(API.getTokenStatus());
        const postsP = this._settle(API.getScheduledPosts());
        const threadsP = this._settle(API.getConversations());
        const dailyP = this._settle(API.getDailyStats(7));

        // ── Region 1+2+3: the stats tiles, then the charts they feed ────────
        statsP.then(async (statsRes) => {
            if (!live()) return;

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

            const statsHost = this.region('stats');
            if (statsHost) {
                statsHost.innerHTML = esc(this.renderStats(stats));
                UI.icons(statsHost);
                UI.animateCounter(document.getElementById('stat-sent'), stats.sent);
                UI.animateCounter(document.getElementById('stat-users'), stats.uniqueUsersReached);
                UI.animateCounter(document.getElementById('stat-campaigns'), stats.activeCampaigns);
            }

            // No library to wait on: the charts are SVG built from this data.
            const dailyRes = await dailyP;
            if (!live()) return;
            this.renderCharts(stats, dailyRes);
        });

        // ── Region 4: the recent-activity table ────────────────────────────
        recentP.then((recentRes) => {
            if (!live()) return;
            this.fillRecent(recentRes);
        });

        // ── Region 1: the briefing, once its six sources have answered ─────
        // dailyP joins the wait here too: buildAlerts() now reads it for the
        // trailing 7-day rate, and it was already being fetched in the same
        // tick for the chart below, so this adds no extra round trip.
        Promise.all([statsP, failedP, tokenP, postsP, threadsP, dailyP]).then(
            ([statsRes, failedRes, tokenRes, postsRes, threadsRes, dailyRes]) => {
                if (!live()) return;
                const host = this.region('briefing');
                if (!host || statsRes.status !== 'fulfilled') return;
                const alerts = this.buildAlerts(statsRes.value || {}, failedRes, tokenRes, postsRes, threadsRes, dailyRes);
                host.innerHTML = esc(this.renderBriefing(alerts));
                UI.icons(host);

                // The briefing is the last region to settle, so the live region
                // that announced "loading" has nothing left to say.
                const busy = this.region('busy');
                if (busy) busy.innerHTML = '';

                // …but something has to say the page ARRIVED, and it cannot be
                // a region inside the container that the same write replaces.
                // The briefing is the page's actual answer, so announce it.
                Motion.announce(alerts.length
                    ? t('overview.attention')
                    : t('overview.allClear'));
            }
        );
    },

    renderRecent(rows) {
        return html`
            <div class="table-card surface">
                <div class="table-header">
                    <!-- A real heading, so the table is reachable from a
                         heading list rather than being an unnamed region. -->
                    <h2 class="table-title">${t('overview.recent')}</h2>
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
        `;
    },

    /**
     * Fills the recent-activity region from a settled `getInteractions()`
     * result. A rejection used to fall back to `[]` — the same empty state a
     * genuinely quiet account shows — so a broken request and a quiet day
     * were indistinguishable. Branches on `.status` the way the stats/briefing
     * region above already does, and gives a real error panel with retry.
     */
    fillRecent(recentRes) {
        const host = this.region('recent');
        if (!host) return;

        if (recentRes.status === 'rejected') {
            const err = recentRes.reason || new Error(t('error.unexpected'));
            UI.renderError(host, {
                title: t('overview.recentErrorTitle'),
                message: err.message,
                hint: err.isNetworkError ? t('error.network') : '',
            }, () => this.reloadRecent());
            return;
        }

        const rows = (recentRes.value && recentRes.value.data) || [];
        host.innerHTML = esc(this.renderRecent(rows));
        UI.icons(host);
    },

    /** Retries just the recent-activity region — not the whole page. */
    reloadRecent() {
        const seq = this._seq;
        const live = () => seq === this._seq && !!document.getElementById('page-container');
        const host = this.region('recent');
        if (host) {
            host.innerHTML = esc(Motion.tableCard(8, [t('table.user'), t('table.keyword'), t('table.status'), t('table.time')]));
        }
        this._settle(API.getInteractions({ limit: 8 })).then((recentRes) => {
            if (!live()) return;
            this.fillRecent(recentRes);
        });
    },

    // ─── Briefing ────────────────────────────────────────────────────────────

    /**
     * Turn six API answers into a list of things that are actually wrong.
     * Ordered by how much damage they are doing right now: a dead token stops
     * everything, a failed DM already lost a customer, an overdue post is just
     * late.
     */
    buildAlerts(stats, failedRes, tokenRes, postsRes, threadsRes, dailyRes) {
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
        } else if (tokenRes.status === 'rejected') {
            // Honest uncertainty, not silence: a rejected fetch used to
            // contribute zero alerts, which looks identical to "token is
            // fine". Same target as the confirmed-bad case, different copy.
            alerts.push({
                level: 'warning', icon: 'help-circle',
                title: t('overview.alert.tokenUnknown'),
                body: t('overview.alert.tokenUnknownBody'),
                action: t('overview.openSettings'), target: 'settings',
            });
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

        // 3. The trailing 7-day send success rate — "failed today" is zero on
        //    any day that is not one of the bad ones, so a week that was 39%
        //    failure overall can sail through check #2 on 5 days out of 7.
        //    Reads the SAME daily series the chart below already fetches
        //    (dailyP), so this costs no extra request.
        if (dailyRes.status === 'fulfilled' && Array.isArray(dailyRes.value)) {
            const trailingSent = dailyRes.value.reduce((sum, d) => sum + (Number(d.sent) || 0), 0);
            const trailingFailed = dailyRes.value.reduce((sum, d) => sum + (Number(d.failed) || 0), 0);
            const trailingTotal = trailingSent + trailingFailed;
            if (trailingTotal > 0) {
                const rate = Math.round((trailingSent / trailingTotal) * 100);
                if (rate < this.TRAILING_SUCCESS_RATE_ALERT_MIN) {
                    alerts.push({
                        level: 'danger', icon: 'trending-down',
                        title: t('overview.alert.lowSuccessRate', { rate: UI.formatPercent(rate) }),
                        body: t('overview.alert.lowSuccessRateBody', {
                            failed: UI.formatNumber(trailingFailed), total: UI.formatNumber(trailingTotal),
                        }),
                        action: t('overview.openActivity'), target: 'activity',
                    });
                }
            }
        } else if (dailyRes.status === 'rejected') {
            alerts.push({
                level: 'warning', icon: 'help-circle',
                title: t('overview.alert.trendUnknown'),
                body: t('overview.alert.trendUnknownBody'),
                action: t('overview.openActivity'), target: 'activity',
            });
        }

        // 4. The publishing queue.
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
        } else if (postsRes.status === 'rejected') {
            alerts.push({
                level: 'warning', icon: 'help-circle',
                title: t('overview.alert.postsUnknown'),
                body: t('overview.alert.postsUnknownBody'),
                action: t('overview.openPosts'), target: 'posts',
            });
        }

        // 5. Conversations where the AI is off and the customer spoke last —
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
        } else if (threadsRes.status === 'rejected') {
            alerts.push({
                level: 'warning', icon: 'help-circle',
                title: t('overview.alert.threadsUnknown'),
                body: t('overview.alert.threadsUnknownBody'),
                action: t('overview.openInbox'), target: 'inbox',
            });
        }

        // 6. Nothing is armed at all.
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
                        <span class="stat-icon"><i data-lucide="send" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value" id="stat-sent">0</p>
                    <p class="stat-sub">${t('overview.stat.sentSub', { count: UI.formatNumber(stats.todayActivity) })}</p>
                </div>
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('overview.stat.successRate')}</span>
                        <span class="stat-icon"><i data-lucide="check-circle" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value ${html.raw(this.successRateClass(stats.successRate))}">${UI.formatPercent(stats.successRate)}</p>
                    <p class="stat-sub">${t('overview.stat.successRateSub', {
                        sent: UI.formatNumber(stats.sent), failed: UI.formatNumber(stats.failed),
                    })}</p>
                </div>
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('overview.stat.users')}</span>
                        <span class="stat-icon"><i data-lucide="users" aria-hidden="true"></i></span>
                    </div>
                    <!-- No sub-line: the label already says "People reached",
                         and "Unique users" underneath it was the same fact in
                         different words. -->
                    <p class="stat-value" id="stat-users">0</p>
                </div>
                <div class="stat-card surface">
                    <!-- "Total", not "Active": the backing query counts every
                         campaign row with no WHERE is_active. -->
                    <div class="stat-header">
                        <span class="stat-label">${t('overview.stat.campaigns')}</span>
                        <span class="stat-icon"><i data-lucide="megaphone" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value" id="stat-campaigns">0</p>
                    <p class="stat-sub">${t('overview.stat.campaignsSub', { count: UI.formatNumber(stats.totalInteractions) })}</p>
                </div>
            </div>
        `;
    },

    /**
     * The chart region.
     *
     * No library and no canvas: `Charts.dayStrip` and `Charts.splitBar` return SVG
     * strings, so this renders synchronously from data it already has. The old
     * version had to await a CDN and bailed out entirely when Chart.js failed to
     * arrive, leaving the skeleton in place forever.
     */
    renderCharts(stats, dailyRes) {
        const host = this.region('charts');
        if (!host) return;

        const daily = (dailyRes && dailyRes.status === 'fulfilled' && Array.isArray(dailyRes.value))
            ? dailyRes.value
            : [];

        host.innerHTML = esc(html`
            <div class="chart-grid">
                <div class="chart-card surface">
                    <div class="chart-card-header">
                        <h2 class="chart-card-title">${t('overview.chart.activity')}</h2>
                    </div>
                    ${Charts.dayStrip(daily, {
                        label: t('overview.chart.activity'),
                        emptyMessage: t('overview.chart.noActivity'),
                        dayHeader: t('common.day'),
                        sentHeader: t('common.sent'),
                        failedHeader: t('common.failed'),
                    })}
                    <p class="chart-foot">${t('overview.chart.stripLegend')}</p>
                </div>
                <div class="chart-card surface">
                    <div class="chart-card-header">
                        <h2 class="chart-card-title">${t('overview.chart.status')}</h2>
                    </div>
                    ${Charts.splitBar([
                        { label: t('common.sent'), value: stats.sent || 0, token: '--success', fallback: '#34c759' },
                        { label: t('common.failed'), value: stats.failed || 0, token: '--danger', fallback: '#ff3b30' },
                    ], {
                        label: t('overview.chart.status'),
                        emptyMessage: t('overview.chart.noActivity'),
                        nameHeader: t('common.status'),
                        valueHeader: t('common.count'),
                    })}
                </div>
            </div>
        `);
        UI.icons(host);
    },
};
