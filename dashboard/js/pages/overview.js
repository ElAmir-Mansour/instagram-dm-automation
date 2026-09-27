/**
 * Overview — the morning screen.
 *
 * ─── What changed and why ───────────────────────────────────────────────────
 * This page used to be four vanity tiles and two charts: "Total DMs Sent",
 * "Success Rate", "Users Reached", "Total Campaigns". None of them answers the
 * question the operator actually opens the dashboard with, which is *what
 * happened, and what should I do today*. Cumulative totals never change fast
 * enough to be news, and a 96% success rate looks calm while forty DMs failed
 * this morning.
 *
 * So the page leads with a briefing — a short list of things that are wrong,
 * the worst first, each with a link straight to the screen that fixes it —
 * then the content half of the question (views this week against the week
 * before, followers against the goal, the skip rate, and the coach's first
 * action), then today's automation tiles, the 7-day strip and the recent
 * table. The all-time totals and the sent-vs-failed split live on Analytics,
 * from the same request; showing them twice said nothing twice.
 *
 * Everything is assembled from endpoints that already exist.
 *
 * ─── Why this page renders in pieces ────────────────────────────────────────
 * The requests go out on load in the same tick, deliberately, because the
 * briefing needs six answers. It used to `await Promise.allSettled` on all of
 * them and render nothing until the slowest returned — and then fire another
 * request for the daily series before it could draw the chart, so the page's
 * real cost was two round trips deep, not one.
 *
 * Now the frame is painted immediately as regions, and each region fills the
 * moment its own sources land. The layout does not move as they arrive
 * because every region's skeleton is built from the real component classes
 * and therefore already occupies the real component's box.
 *
 * Only the core stats call is still fatal: without it there is no page.
 *
 * ─── A screen left open all day ─────────────────────────────────────────────
 * The briefing says when it was computed ("as of 14:05") and has a Refresh.
 * Coming back to the tab after more than `STALE_MS` re-renders it in place:
 * the old numbers stay until the new ones land, so nothing blanks.
 */
const OverviewPage = {

    /** Guards a fill against landing after the operator has navigated away. */
    _seq: 0,

    OVERDUE_GRACE_MS: 15 * 60 * 1000,

    /**
     * O9: "DMs failed today" asks for today's failures only (`since` = local
     * midnight) and as many as the route gives in one page. It used to take
     * the latest 50 of all time and count today's among them, so a bad day
     * stopped at 50 and said nothing.
     */
    FAILED_TODAY_LIMIT: 100,

    /** Local midnight, the start of the operator's "today". */
    localMidnight(now) {
        const at = now instanceof Date ? new Date(now.getTime()) : new Date();
        at.setHours(0, 0, 0, 0);
        return at;
    },

    /**
     * Gates the 7-day-window alert in buildAlerts(). A long history dilutes an
     * all-time rate, which can look calm through a genuinely bad week.
     */
    TRAILING_SUCCESS_RATE_ALERT_MIN: 85,

    /** Older than this when the tab comes back, and the briefing is re-read. */
    STALE_MS: 5 * 60 * 1000,

    /** The growth region reads two weeks: this one, and the one it is compared with. */
    GROWTH_DAYS: 14,

    /**
     * The skip rate's bands (% of views gone in the first 3 s): above
     * `SKIP_DANGER_ABOVE` the hook is losing most people, from
     * `SKIP_WARNING_FROM` half of them. Same numbers as growth.js, which is
     * lazily loaded, so they are restated here.
     */
    SKIP_DANGER_ABOVE: 70,
    SKIP_WARNING_FROM: 50,

    /**
     * Where the Growth coach keeps its last plan in this browser, and how long
     * it counts as current. Mirrors GrowthPage.COACH_KEY_PREFIX / COACH_KEEP_MS
     * (a lazily loaded module, so restated like the overdue grace above).
     */
    COACH_KEY_PREFIX: 'growth:coach:',
    COACH_KEEP_MS: 7 * 24 * 60 * 60 * 1000,

    /** When the regions were last asked for, for the return-to-tab refresh. */
    _renderedAt: 0,
    onVisibilityChange: null,

    destroy() {
        this._seq++;
        if (this.onVisibilityChange) {
            document.removeEventListener('visibilitychange', this.onVisibilityChange);
            this.onVisibilityChange = null;
        }
        // No chart instances to destroy any more: the charts are SVG strings written
        // into the page, so navigating away removes them with the markup. This loop
        // existed only because Chart.js held canvases and event listeners alive.
    },

    /** The content numbers need the operator role (the Growth routes do), so a viewer gets none. */
    canSeeGrowth() {
        return typeof App === 'undefined' || typeof App.canOperate !== 'function' || App.canOperate();
    },

    /**
     * The frame. `App.navigate` paints this inside the view transition, and
     * `render()` fills the `[data-region]` hosts in place rather than
     * replacing the container — which is why the regions can land in any
     * order without the page reflowing.
     */
    skeleton() {
        return html`
            <div data-region="briefing">${this.briefingSkeleton()}</div>
            <div data-region="growth">${this.canSeeGrowth() ? this.growthSkeleton() : ''}</div>
            <div data-region="stats">${Motion.statsGrid(4)}</div>
            <div data-region="charts">${this.chartSkeleton()}</div>
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

    growthSkeleton() {
        return html`
            <section class="growth-strip" aria-hidden="true">
                <div class="briefing-head"><h2>${Motion.line('md')}</h2></div>
                ${Motion.statsGrid(3)}
            </section>
        `;
    },

    chartSkeleton() {
        return html`
            <div class="chart-grid chart-grid--one" aria-hidden="true">
                <div class="chart-card surface">
                    <div class="chart-card-header"><span class="chart-card-title">${Motion.line('lg')}</span></div>
                    <div class="chart-skel"><span class="skel skel-block"></span></div>
                </div>
            </div>
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
        this._renderedAt = Date.now();

        // Painted by App.navigate on a navigation; painted here on a retry or
        // a theme change, where the container holds something else.
        if (!container.querySelector('[data-region="briefing"]')) {
            container.innerHTML = esc(this.skeleton());
            UI.icons(container);
        }
        Motion.clearSkeleton(container);

        // O7: the screen left open all day. On return after STALE_MS, re-read
        // in place; the numbers on screen stay until the new ones land.
        this.onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            if (Date.now() - this._renderedAt > this.STALE_MS) this.render();
        };
        document.addEventListener('visibilitychange', this.onVisibilityChange);

        // Every request in the same tick, including the daily series that used
        // to wait for the other six and the chart library that used to be
        // ~201KB on the critical path of all ten screens.
        const statsP = this._settle(API.getStats());
        const recentP = this._settle(API.getInteractions({ limit: 8 }));
        const failedP = this._settle(API.getInteractions({
            status: 'FAILED', limit: this.FAILED_TODAY_LIMIT, since: this.localMidnight().toISOString(),
        }));
        const tokenP = this._settle(API.getTokenStatus());
        const postsP = this._settle(API.getScheduledPosts());
        // 100, the route's cap: the default of 20 undercounted who is waiting.
        const threadsP = this._settle(API.getConversations({ limit: 100 }));
        const dailyP = this._settle(API.getDailyStats(7));
        const growth = this.canSeeGrowth();
        const growthP = growth ? this._settle(API.getGrowthOverview(this.GROWTH_DAYS)) : null;
        const goalsP = growth ? this._settle(API.getGrowthSettings()) : null;

        // ── The fatal one ───────────────────────────────────────────────────
        statsP.then((statsRes) => {
            if (!live() || statsRes.status === 'fulfilled') return;
            const err = statsRes.reason || new Error(t('error.unexpected'));
            UI.renderError(container, {
                icon: 'wifi-off',
                title: t('error.pageTitle'),
                message: err.message,
                hint: err.isNetworkError ? t('error.network') : '',
            }, () => this.render());
        });

        // ── Today's tiles, then the 7-day strip ─────────────────────────────
        Promise.all([statsP, dailyP, threadsP]).then(([statsRes, dailyRes, threadsRes]) => {
            if (!live() || statsRes.status !== 'fulfilled') return;
            const statsHost = this.region('stats');
            if (statsHost) {
                statsHost.innerHTML = esc(this.renderStats(statsRes.value || {}, dailyRes, threadsRes));
                UI.icons(statsHost);
            }
            this.renderCharts(dailyRes);
        });

        // SH3: the waiting count on the Inbox nav item, from this screen too.
        threadsP.then((threadsRes) => {
            if (!live() || threadsRes.status !== 'fulfilled') return;
            if (typeof App !== 'undefined' && typeof App.setInboxWaiting === 'function') {
                App.setInboxWaiting(this.waitingThreads(threadsRes).length);
            }
        });

        // ── The content region ──────────────────────────────────────────────
        if (growth) {
            Promise.all([growthP, goalsP]).then(([growthRes, goalsRes]) => {
                if (!live()) return;
                const host = this.region('growth');
                if (!host) return;
                host.innerHTML = esc(this.renderGrowth(growthRes, goalsRes));
                UI.icons(host);
            });
        }

        // ── The recent-activity table ───────────────────────────────────────
        recentP.then((recentRes) => {
            if (!live()) return;
            this.fillRecent(recentRes);
        });

        // ── The briefing, once its six sources have answered ────────────────
        // dailyP joins the wait here too: buildAlerts() reads it for the
        // trailing 7-day rate, and it was already being fetched in the same
        // tick for the chart, so this adds no extra round trip.
        Promise.all([statsP, failedP, tokenP, postsP, threadsP, dailyP]).then(
            ([statsRes, failedRes, tokenRes, postsRes, threadsRes, dailyRes]) => {
                if (!live()) return;
                const host = this.region('briefing');
                if (!host || statsRes.status !== 'fulfilled') return;
                const alerts = this.sortAlerts(this.buildAlerts(statsRes.value || {}, failedRes, tokenRes, postsRes, threadsRes, dailyRes));
                // Refresh lives inside the region it rewrites; keep focus on it.
                const focus = UI.captureFocus(host);
                host.innerHTML = esc(this.renderBriefing(alerts, new Date()));
                UI.icons(host);
                UI.restoreFocus(focus);

                // The briefing is the last region to settle, so the live region
                // that announced "loading" has nothing left to say.
                const busy = this.region('busy');
                if (busy) busy.innerHTML = '';

                // …but something has to say the page ARRIVED, and it cannot be
                // a region inside the container that the same write replaces.
                // The briefing is the page's actual answer, so announce it.
                Motion.announce(alerts.length
                    ? t('overview.attentionCount', { count: alerts.length })
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
                    ${UI.button({
                        variant: 'secondary', size: 'sm', label: t('common.viewAll'),
                        action: 'app:navigate', data: { target: 'activity' },
                    })}
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
                                    <td>
                                        <span class="status-pill ${String(i.status || '').toLowerCase()}">${UI.statusLabel(i.status)}</span>
                                        ${i.status === 'FAILED' && i.error_log ? html`<span class="cell-note" dir="auto">${i.error_log}</span>` : ''}
                                    </td>
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
     * were indistinguishable. Branches on `.status` the way the other regions
     * do, and gives a real error panel with retry.
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

    // ─── Shared readings ─────────────────────────────────────────────────────

    /** Threads where the AI is off and the customer spoke last, oldest wait first. */
    waitingThreads(threadsRes) {
        if (!threadsRes || threadsRes.status !== 'fulfilled' || !threadsRes.value) return [];
        return ((threadsRes.value.data) || [])
            .filter((thread) => thread.is_bot_active === false && thread.last_message_direction === 'inbound')
            .sort((a, b) => String(a.last_message_at || '').localeCompare(String(b.last_message_at || '')));
    },

    /** "3h" / "2d" — how long the oldest customer has been waiting, as a duration. */
    waitAge(iso) {
        const at = iso ? new Date(iso).getTime() : NaN;
        if (!Number.isFinite(at)) return null;
        const ms = Math.max(0, Date.now() - at);
        const minute = 60000;
        const hour = 60 * minute;
        const day = 24 * hour;
        if (ms < hour) return t('common.minutes', { n: UI.formatNumber(Math.max(1, Math.floor(ms / minute))) });
        if (ms < day) return t('common.hours', { n: UI.formatNumber(Math.floor(ms / hour)) });
        return t('common.days', { n: UI.formatNumber(Math.floor(ms / day)) });
    },

    /**
     * "+23" / "-4" / "0" as TEXT, wrapped in a left-to-right isolate (U+2066 …
     * U+2069, the text form of `<bdi dir="ltr">`) so the sign stays on the
     * number inside an Arabic sentence. Text, because it also goes through
     * `t()`, which only substitutes strings.
     */
    signed(n) {
        return `\u2066${this.signedDigits(n)}\u2069`;
    },

    signedDigits(n) {
        try {
            return new Intl.NumberFormat(I18N.locale(), { signDisplay: 'exceptZero', maximumFractionDigits: 0 }).format(n);
        } catch {
            return n > 0 ? `+${n}` : String(n);
        }
    },

    /** The skip rate's band, as the text class of its tile. */
    skipClass(rate) {
        const n = Number(rate);
        if (rate === null || rate === undefined || !Number.isFinite(n)) return '';
        if (n > this.SKIP_DANGER_ABOVE) return 'text-danger';
        if (n >= this.SKIP_WARNING_FROM) return 'text-warning';
        return 'text-success';
    },

    // ─── Briefing ────────────────────────────────────────────────────────────

    /**
     * Turn six API answers into a list of things that are actually wrong.
     * Pushed in the order the checks run; `sortAlerts()` then puts what is
     * broken before what is late before what is merely worth knowing.
     */
    buildAlerts(stats, failedRes, tokenRes, postsRes, threadsRes, dailyRes) {
        const alerts = [];
        const startOfToday = this.localMidnight();

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

        // 2. DMs that failed today. Asked for with `since` = local midnight
        //    (O9), so every row is today's; the client-side date check stays as
        //    a belt to that brace. One page is at most FAILED_TODAY_LIMIT rows,
        //    so when the total says there are more, the title says "more than
        //    100" rather than a number that simply stopped.
        if (failedRes.status === 'fulfilled' && failedRes.value) {
            const rows = Array.isArray(failedRes.value.data) ? failedRes.value.data : [];
            const failedToday = rows.filter((row) => {
                const at = row.timestamp ? new Date(row.timestamp) : null;
                return at && !Number.isNaN(at.getTime()) && at >= startOfToday;
            }).length;
            const total = Number(failedRes.value.pagination && failedRes.value.pagination.total);
            const truncated = failedToday >= this.FAILED_TODAY_LIMIT && Number.isFinite(total) && total > failedToday;
            if (failedToday > 0) {
                alerts.push({
                    level: 'danger', icon: 'send-horizontal',
                    title: truncated
                        ? t('overview.alert.failedTodayMore', { n: UI.formatNumber(this.FAILED_TODAY_LIMIT) })
                        : t('overview.alert.failedToday', { count: failedToday }),
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
            // Overdue by more than the sweep can explain. The Heroku worker polls
            // every 60s and a video container can take ~75s, so a row two minutes
            // past its time is on its way, not stuck; fifteen minutes is stuck.
            // (Mirrors posts.js FREQUENT_SWEEP_LAG_MS ×3; the constant lives in a
            // lazily loaded module, so it is restated here.)
            const now = Date.now();
            const overdue = posts.filter((p) => (
                p.status === 'PENDING' && p.scheduled_time
                // A held row (Instagram still processing the reel, TikTok's daily limit) is
                // late on purpose and says so on its own card; it is not a stuck post.
                && !UI.heldReason(p)
                && new Date(p.scheduled_time).getTime() < now - this.OVERDUE_GRACE_MS
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
        //    nobody is going to answer these unless a human does. The link
        //    opens the inbox already filtered to them (O10), and the body says
        //    how long the oldest has waited.
        if (threadsRes.status === 'fulfilled' && threadsRes.value) {
            const waiting = this.waitingThreads(threadsRes);
            if (waiting.length > 0) {
                const age = this.waitAge(waiting[0].last_message_at);
                alerts.push({
                    level: 'warning', icon: 'message-square-dot',
                    title: t('overview.alert.waitingHumans', { count: waiting.length }),
                    body: age ? t('overview.alert.waitingOldest', { age }) : t('overview.alert.waitingHumansBody'),
                    action: t('overview.openInbox'), target: 'inbox', query: 'filter=waiting',
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

    /**
     * O8: danger, then warning, then info — stable within a level, so the
     * order the checks run in (a dead token before a failed DM) still breaks
     * ties. They used to land in insertion order in an auto-fit grid, so a
     * dead token could sit beside, or after, "no campaign is active".
     */
    sortAlerts(alerts) {
        const rank = { danger: 0, warning: 1, info: 2 };
        return alerts
            .map((a, i) => ({ a, i }))
            .sort((x, y) => ((rank[x.a.level] ?? 3) - (rank[y.a.level] ?? 3)) || (x.i - y.i))
            .map((x) => x.a);
    },

    renderBriefing(alerts, at) {
        const count = alerts.length;
        return html`
            <section class="briefing" aria-labelledby="briefing-heading">
                <div class="briefing-head">
                    <h2 id="briefing-heading">${count ? t('overview.attentionCount', { count }) : t('overview.briefing')}</h2>
                    <span class="briefing-date">${UI.formatWeekday(at)}</span>
                    <span class="briefing-asof">${t('overview.asOf', { time: UI.formatTime(at) })}</span>
                    ${UI.button({
                        variant: 'ghost', size: 'sm', icon: 'refresh-cw', label: t('overview.refresh'),
                        action: 'overview:refresh', id: 'overview-refresh',
                    })}
                </div>
                ${count === 0 ? html`
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
                                    <button type="button" class="alert-link" data-action="app:navigate" data-target="${a.target}"${a.query ? html` data-query="${a.query}"` : ''}>
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

    // ─── The content region (O1 + G1) ───────────────────────────────────────

    /**
     * The coach's first action, as the Growth page would number it: biggest
     * impact first, then the least effort, then the coach's own order. Read
     * from the plan Growth keeps for this tenant in this browser; nothing is
     * asked of the server (a plan costs most of a minute of Gemini).
     */
    coachFirst() {
        const id = typeof App !== 'undefined' && App.session && App.session.tenantId;
        let saved = null;
        try {
            const raw = localStorage.getItem(`${this.COACH_KEY_PREFIX}${id || 'default'}`);
            saved = raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
        if (!saved || !saved.result || !saved.at) return null;
        const at = Date.parse(saved.at);
        if (!Number.isFinite(at) || Date.now() - at > this.COACH_KEEP_MS) return null;
        const text = (v) => (typeof v === 'string' ? v.trim() : '');
        const level = (v) => { const s = String(v || '').toLowerCase(); return s === 'medium' ? 'med' : s; };
        const impact = { high: 3, med: 2, low: 1 };
        const ease = { low: 3, med: 2, high: 1 };
        const actions = (Array.isArray(saved.result.actions) ? saved.result.actions : [])
            .filter((a) => a && typeof a === 'object' && (text(a.title) || text(a.how)))
            .map((a, i) => ({ title: text(a.title) || text(a.how), impact: level(a.impact), effort: level(a.effort), order: i }))
            .sort((a, b) => ((impact[b.impact] || 1.5) - (impact[a.impact] || 1.5))
                || ((ease[b.effort] || 2) - (ease[a.effort] || 2))
                || (a.order - b.order));
        return actions.length ? actions[0].title : null;
    },

    /** Sum of the measured days; null when not one day was measured. */
    sumMeasured(rows, key) {
        const values = rows.map((r) => (r && r[key] !== null && r[key] !== undefined && r[key] !== '' ? Number(r[key]) : NaN)).filter(Number.isFinite);
        return values.length ? values.reduce((s, v) => s + v, 0) : null;
    },

    /** The follower change over the last 7 days of the series, or null when the series cannot say. */
    followersWeekDelta(trend) {
        const values = trend.map((r) => (r && r.followers !== null && r.followers !== undefined ? Number(r.followers) : NaN));
        let last = -1;
        for (let i = values.length - 1; i >= 0; i--) { if (Number.isFinite(values[i])) { last = i; break; } }
        if (last < 7 || !Number.isFinite(values[last - 7])) return null;
        return values[last] - values[last - 7];
    },

    growthTile(id, icon, label, value, subs, valueClass) {
        return html`
            <div class="stat-card surface" id="${id}">
                <div class="stat-header">
                    <span class="stat-label">${label}</span>
                    <span class="stat-icon"><i data-lucide="${icon}" aria-hidden="true"></i></span>
                </div>
                <p class="stat-value${valueClass ? html` ${html.raw(valueClass)}` : ''}">${value}</p>
                ${subs.filter(Boolean).map((sub) => html`<p class="stat-sub">${sub}</p>`)}
            </div>
        `;
    },

    /**
     * "What happened to my content, and what should I do today": views this
     * week against last week, followers against the goal, the skip rate in its
     * band, and the coach's first action. Every number is the API's; anything
     * it could not measure is "—" with the reason, never a zero.
     */
    renderGrowth(growthRes, goalsRes) {
        const failed = !growthRes || growthRes.status !== 'fulfilled';
        const o = !failed && growthRes.value && typeof growthRes.value === 'object' ? growthRes.value : {};
        const k = o.kpis && typeof o.kpis === 'object' ? o.kpis : {};
        const trend = (Array.isArray(o.trend) ? o.trend : [])
            .filter((r) => r && r.day)
            .sort((a, b) => String(a.day).localeCompare(String(b.day)));
        const settings = goalsRes && goalsRes.status === 'fulfilled' && goalsRes.value ? goalsRes.value.settings || {} : {};
        const goal = Number(settings.goal_followers);
        const noData = failed ? '' : t('overview.growth.noData');

        // Views: the last 7 days of the daily series against the 7 before.
        const week = trend.slice(-7);
        const prevWeek = trend.slice(-14, -7);
        const views = this.sumMeasured(week, 'views');
        const prevViews = this.sumMeasured(prevWeek, 'views');
        let viewsSub = noData;
        if (views !== null) {
            if (prevViews === null) {
                viewsSub = t('overview.growth.noPrev');
            } else {
                const diff = views - prevViews;
                const pct = prevViews > 0 ? Math.round((diff / prevViews) * 100) : null;
                const dir = diff > 0 ? 'is-up' : diff < 0 ? 'is-down' : '';
                viewsSub = html`
                    <span class="stat-trend ${html.raw(dir)}">${diff !== 0 ? html`<i data-lucide="${diff > 0 ? 'trending-up' : 'trending-down'}" aria-hidden="true"></i>` : ''}${pct !== null ? UI.ltr(`${this.signedDigits(pct)}%`) : this.signed(diff)}</span>
                    ${t('overview.growth.vsPrev', { n: UI.formatNumber(prevViews) })}
                `;
            }
        }

        // Followers: the latest total, the week's change, the distance to goal.
        const followers = k.followers === null || k.followers === undefined ? null : Number(k.followers);
        const hasFollowers = followers !== null && Number.isFinite(followers);
        const delta = this.followersWeekDelta(trend);
        let followersSub = noData;
        if (hasFollowers) {
            followersSub = delta !== null
                ? html`<span class="${html.raw(delta > 0 ? 'text-success' : delta < 0 ? 'text-danger' : '')}">${t('overview.growth.weekDelta', { delta: this.signed(delta) })}</span>`
                : (followers < 100 ? t('growth.small.delta') : t('growth.kpi.deltaMissing'));
        }
        const goalLine = Number.isFinite(goal) && goal > 0
            ? t('overview.growth.ofGoal', { n: hasFollowers ? UI.formatNumber(followers) : '—', goal: UI.formatNumber(goal) })
            : '';

        // Skip rate: Instagram's reels_skip_rate, the median over the window's reels.
        const skip = k.skip_rate === null || k.skip_rate === undefined ? null : Number(k.skip_rate);
        const hasSkip = skip !== null && Number.isFinite(skip);
        const skipClass = hasSkip ? this.skipClass(skip) : '';
        const band = { 'text-danger': 'danger', 'text-warning': 'warning', 'text-success': 'success' }[skipClass];
        let skipText = '—';
        if (hasSkip) {
            try { skipText = `${new Intl.NumberFormat(I18N.locale(), { maximumFractionDigits: 1 }).format(skip)}%`; } catch { skipText = `${Math.round(skip)}%`; }
        }

        const first = this.coachFirst();
        return html`
            <section class="growth-strip" aria-labelledby="overview-growth-title">
                <div class="briefing-head"><h2 id="overview-growth-title">${t('overview.growth.title')}</h2></div>
                ${failed ? html`<p class="growth-unavailable" role="status">${t('overview.growth.unavailable', {
                    reason: (growthRes && growthRes.reason && growthRes.reason.message) || t('error.unexpected'),
                })}</p>` : ''}
                <div class="stats-grid">
                    ${this.growthTile('overview-views', 'eye', t('overview.growth.views'), views === null ? '—' : UI.formatNumber(views), [viewsSub])}
                    ${this.growthTile('overview-followers', 'users', t('overview.growth.followers'), hasFollowers ? UI.formatNumber(followers) : '—', [followersSub, goalLine])}
                    ${this.growthTile('overview-skip', 'skip-forward', t('overview.growth.skip'), skipText,
                        hasSkip ? [t(`growth.kpi.skipBand.${band}`), t('overview.growth.skipSub')] : [noData], skipClass)}
                </div>
                <div class="do-first" id="overview-do-first">
                    <i data-lucide="lightbulb" aria-hidden="true"></i>
                    ${first ? html`
                        <strong>${t('overview.growth.doFirst')}</strong>
                        <span class="do-first-text user-content" dir="auto">${first}</span>
                    ` : html`<span class="do-first-text">${t('overview.growth.noPlan')}</span>`}
                    <button type="button" class="alert-link" data-action="app:navigate" data-target="growth">
                        ${t('overview.growth.openGrowth')}
                        <i data-lucide="arrow-right" aria-hidden="true"></i>
                    </button>
                </div>
            </section>
        `;
    },

    // ─── Today's tiles ───────────────────────────────────────────────────────

    /**
     * Sent today · failed today · waiting for you · active campaigns. "Today"
     * is the last row of the gap-filled daily series (local midnight on the
     * server's calendar), the same day the "failed today" alert counts — it
     * used to be a rolling 24 hours of every status, two numbers called
     * "today" on one screen. The all-time totals are Analytics'.
     */
    renderStats(stats, dailyRes, threadsRes) {
        const daily = dailyRes && dailyRes.status === 'fulfilled' && Array.isArray(dailyRes.value) ? dailyRes.value : null;
        const today = daily && daily.length ? daily[daily.length - 1] || {} : null;
        const sentToday = today ? Number(today.sent) || 0 : null;
        const failedToday = today ? Number(today.failed) || 0 : null;
        const weekSent = daily ? daily.reduce((s, d) => s + (Number(d.sent) || 0), 0) : null;
        const weekFailed = daily ? daily.reduce((s, d) => s + (Number(d.failed) || 0), 0) : null;
        const dailyReason = t('overview.alert.trendUnknown');

        const threadsOk = threadsRes && threadsRes.status === 'fulfilled';
        const waiting = this.waitingThreads(threadsRes);
        const oldest = waiting.length ? this.waitAge(waiting[0].last_message_at) : null;
        let waitingSub = t('overview.stat.waitingUnknown');
        if (threadsOk) waitingSub = waiting.length ? (oldest ? t('overview.stat.waitingOldest', { age: oldest }) : '') : t('overview.stat.waitingNone');

        return html`
            <div class="stats-grid">
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('overview.stat.sentToday')}</span>
                        <span class="stat-icon"><i data-lucide="send" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value" id="stat-sent-today">${sentToday === null ? '—' : UI.formatNumber(sentToday)}</p>
                    <p class="stat-sub">${weekSent === null ? dailyReason : t('overview.stat.inWeek', { n: UI.formatNumber(weekSent) })}</p>
                </div>
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('overview.stat.failedToday')}</span>
                        <span class="stat-icon"><i data-lucide="alert-circle" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value${failedToday > 0 ? html.raw(' text-danger') : ''}" id="stat-failed-today">${failedToday === null ? '—' : UI.formatNumber(failedToday)}</p>
                    <p class="stat-sub">${weekFailed === null ? dailyReason : t('overview.stat.inWeek', { n: UI.formatNumber(weekFailed) })}</p>
                </div>
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('overview.stat.waiting')}</span>
                        <span class="stat-icon"><i data-lucide="message-square-dot" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value${waiting.length > 0 ? html.raw(' text-warning') : ''}" id="stat-waiting">${threadsOk ? UI.formatNumber(waiting.length) : '—'}</p>
                    ${waitingSub ? html`<p class="stat-sub">${waitingSub}</p>` : ''}
                </div>
                <div class="stat-card surface">
                    <div class="stat-header">
                        <span class="stat-label">${t('overview.stat.campaigns')}</span>
                        <span class="stat-icon"><i data-lucide="megaphone" aria-hidden="true"></i></span>
                    </div>
                    <p class="stat-value" id="stat-campaigns">${UI.formatNumber(stats.activeCampaigns)}</p>
                    <p class="stat-sub">${t('overview.stat.campaignsSub', { count: Number(stats.totalInteractions) || 0, n: UI.formatNumber(stats.totalInteractions) })}</p>
                </div>
            </div>
        `;
    },

    /**
     * The chart region: the 7-day strip, with its total as one line under it
     * ("7 days: 84 sent · 6 failed (7%)") where a legend paragraph used to
     * explain the encoding and give no number at all.
     *
     * No library and no canvas: `Charts.dayStrip` returns an SVG string, so
     * this renders synchronously from data it already has.
     */
    renderCharts(dailyRes) {
        const host = this.region('charts');
        if (!host) return;

        const daily = (dailyRes && dailyRes.status === 'fulfilled' && Array.isArray(dailyRes.value))
            ? dailyRes.value
            : [];
        const sent = daily.reduce((s, d) => s + (Number(d.sent) || 0), 0);
        const failed = daily.reduce((s, d) => s + (Number(d.failed) || 0), 0);
        const total = sent + failed;

        host.innerHTML = esc(html`
            <div class="chart-grid chart-grid--one">
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
                    ${total > 0 ? html`<p class="chart-foot" id="overview-week-summary">${t('overview.chart.summary', {
                        sent: UI.formatNumber(sent),
                        failed: UI.formatNumber(failed),
                        rate: UI.formatPercent(Math.round((failed / total) * 100)),
                    })}</p>` : ''}
                </div>
            </div>
        `);
        UI.icons(host);
    },
};

UI.registerActions('overview', {
    refresh: () => OverviewPage.render(),
});
