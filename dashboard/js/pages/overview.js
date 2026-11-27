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
 * ─── One "needs you", and clearing it here (U2) ─────────────────────────────
 * The briefing's list of what needs the owner is NOT worked out on this page any more: it is `GET /api/attention` (src/services/attention.ts), the
 * same answer the Inbox and Scheduler badges count. Today used to download every scheduled post (344 rows, 93 KB) just to count the failures and
 * 100 conversations to count who waits, and so disagreed with the tenant page (failed posts: 4 here, 2 there) and with the badge (waiting: 2 here, 1
 * there). Now: a heartbeat line on top (last comment, last DM, are events arriving, is the Mac worker online), then one card per item with one verb
 * and the server's own link; a failed-posts card lists why each failed and can "Archive these", a conversation past Meta's 24 h window can be "Marked
 * handled", both with one Undo and no question, and neither is shown to a viewer. FLOWS.md §16 walks it.
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
 * ─── The profile card (P30) ─────────────────────────────────────────────────
 * Above the briefing: how complete the creator's profile is and the next three things worth doing, each with where to do it
 * (`GET /api/profile/progress`, which carries ids, paths and numbers; the words are here, in both languages). It is a region like
 * the others and fills when its own request lands. It is also the one region that can never hurt the page: if the answer does not
 * come, or is not what was expected, the region stays empty. A tenant that predates profiles (the owner) is measured only on what
 * his setup can hold, so a finished card for him is one line.
 *
 * ─── Get the workspace live (U3, SA-12) ────────────────────────────────────
 * For the OWNER of a company workspace, above everything: a short checklist (`GET /api/golive`, `src/services/goLive.ts`) of what is left before it
 * works for real, one button each, with Hide (and Undo) and, once the test comment has arrived, one "you're live" line for three days. The server
 * answers `{ show: false }` for the platform owner's own workspace, for a workspace made before the wizard, for everyone but the owner and once it
 * is hidden: this page draws nothing then. While the card shows, the profile card is not drawn (one to-do card, not two). An operator or a viewer
 * sees instead, once per browser, a short orientation card (their role in plain words, where to choose how they are told, the inbox).
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
     * The views tile reads its own seven-day answer, so the comparison is the server's and not a derivation here (audit OV-06). The
     * 14-day read above still feeds the followers' change and the skip rate; slicing its daily series into "this week" and "last
     * week" summed the six days that had been measured against seven, which read as -92%. `GET /growth/overview?days=7` answers
     * `kpis.views` and `previous.views` over the same span a week apart, and `previous.views` is null whenever the two do not
     * compare exactly.
     */
    VIEWS_DAYS: 7,

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
     * Is this module part of the workspace? `App.hasModule` (the shell's registry). Fails open when it cannot be asked (no `App`, or a session with no
     * module list), so a screen that cannot ask shows everything, as it always did.
     */
    hasModule(id) {
        if (typeof App === 'undefined' || typeof App.hasModule !== 'function') return true;
        try {
            return App.hasModule(id) !== false;
        } catch (_) {
            return true;
        }
    },

    /** The growth strip: an operator's, and only for a workspace that has the Growth module. */
    showsGrowth() {
        return this.canSeeGrowth() && this.hasModule('growth');
    },

    /**
     * The frame. `App.navigate` paints this inside the view transition, and
     * `render()` fills the `[data-region]` hosts in place rather than
     * replacing the container — which is why the regions can land in any
     * order without the page reflowing.
     */
    skeleton() {
        return html`
            <div data-region="golive"></div>
            <div data-region="profile"></div>
            <div data-region="briefing">${this.briefingSkeleton()}</div>
            <div data-region="growth">${this.showsGrowth() ? this.growthSkeleton() : ''}</div>
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
        // `outcome: 'actionable'`, not `status: 'FAILED'`: a DM skipped on purpose (the 24 h cap, a person who already had their
        // reply) is written FAILED and needs nobody, so counting it made this alert red for things that went right (audit OV-03).
        const failedP = this._settle(API.getInteractions({
            outcome: 'actionable', limit: this.FAILED_TODAY_LIMIT, since: this.localMidnight().toISOString(),
        }));
        const tokenP = this._settle(API.getTokenStatus());
        // The stored Facebook connection (columns only, no call to Meta): "reconnect due" comes from the daily recheck (P29).
        const metaP = this._settle(API.getMetaConnection());
        // Where Meta sends the events, as the hourly check last stored it (no call to Meta): another project that uses the same Meta app can take Instagram away
        // while every connection above still reads "Connected" (src/services/metaWebhooks.ts).
        const healthP = this._settle(API.getTenantHealth());
        // What in the Studio needs the owner (src/services/attention.ts): Claude signed out on the Mac, the worker offline, TikTok drafts, clips to review.
        // Columns only on the server, no call to Meta. A failed read adds nothing here: the Studio's own strip and nav badge ask again.
        // It is also the whole "needs you" list (U2, DW-T2): failed and overdue posts, waiting and handed-over conversations, connections, the Studio's
        // four, and the heartbeat. Today used to build the first two itself from every scheduled post (344 rows, 93 KB, just to count failures) and 100
        // conversations, and read a different count from the tenant page and the nav badge. One answer, one truth.
        const attentionP = this._settle(API.getAttention());
        const dailyP = this._settle(API.getDailyStats(7));
        const operator = this.canSeeGrowth();
        const growth = this.showsGrowth();
        const growthP = growth ? this._settle(API.getGrowthOverview(this.GROWTH_DAYS)) : null;
        const viewsP = growth ? this._settle(API.getGrowthOverview(this.VIEWS_DAYS)) : null;
        // The go-live checklist (U3): the owner's, and only for a company workspace. It is asked before the profile card because it replaces it.
        this._goLiveShown = false;
        this.fillOrientation();
        const goLiveP = this.askGoLive();
        // The profile card: for an operator or an owner (a viewer's answer is a 403 and the region stays empty).
        if (operator) {
            this._settle(API.getProfileProgress()).then(async (progressRes) => {
                // One to-do card, not two: when the checklist shows, the profile card waits for its answer and stays out.
                await goLiveP;
                if (live()) this.fillProfile(progressRes);
            });
        }
        goLiveP.then((goLiveRes) => {
            if (live()) this.fillGoLive(goLiveRes);
        });
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
        Promise.all([statsP, dailyP, attentionP]).then(([statsRes, dailyRes, attentionRes]) => {
            if (!live() || statsRes.status !== 'fulfilled') return;
            this._statsInputs = { statsRes, dailyRes };
            const statsHost = this.region('stats');
            if (statsHost) {
                statsHost.innerHTML = esc(this.renderStats(statsRes.value || {}, dailyRes, attentionRes));
                UI.icons(statsHost);
            }
            this.renderCharts(dailyRes);
        });

        // SH3: the count on the Inbox nav item, from this screen too: the server's own `counts.inbox`, the number the To do list holds, so the badge is
        // one number on every screen and not a different one on each.
        attentionP.then((attentionRes) => {
            if (!live()) return;
            const inbox = this.attentionCount(attentionRes, 'inbox');
            if (inbox !== null && typeof App !== 'undefined' && typeof App.setInboxWaiting === 'function') App.setInboxWaiting(inbox);
        });

        // ── The content region ──────────────────────────────────────────────
        if (growth) {
            Promise.all([growthP, goalsP, viewsP]).then(([growthRes, goalsRes, viewsRes]) => {
                if (!live()) return;
                const host = this.region('growth');
                if (!host) return;
                host.innerHTML = esc(this.renderGrowth(growthRes, goalsRes, viewsRes));
                UI.icons(host);
            });
        }

        // ── The recent-activity table ───────────────────────────────────────
        recentP.then((recentRes) => {
            if (!live()) return;
            this.fillRecent(recentRes);
        });

        // ── The briefing, once its sources have answered ────────────────────
        // dailyP joins the wait here too: buildAlerts() reads it for the
        // trailing 7-day rate, and it was already being fetched in the same
        // tick for the chart, so this adds no extra round trip.
        Promise.all([statsP, failedP, tokenP, dailyP, metaP, healthP, attentionP]).then(
            ([statsRes, failedRes, tokenRes, dailyRes, metaRes, healthRes, attentionRes]) => {
                if (!live()) return;
                const host = this.region('briefing');
                if (!host || statsRes.status !== 'fulfilled') return;
                // Kept so a clear (Archive, Mark handled, or their Undo) can read the attention summary again and repaint this region alone.
                this._briefingInputs = { statsRes, failedRes, tokenRes, dailyRes, metaRes, healthRes };
                const alerts = this.paintBriefing(host, attentionRes);

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
                    ${this.hasModule('results') ? UI.button({
                        variant: 'secondary', size: 'sm', label: t('common.viewAll'),
                        action: 'app:navigate', data: { target: 'activity' },
                    }) : ''}
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
                                        ${UI.outcomePill(i)}
                                        ${i.status === 'FAILED' && i.error_log ? UI.failure({ message: i.error_log, at: i.updated_at }, { next: false }) : ''}
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

    // ─── Get the workspace live (U3, SA-12) ──────────────────────────────────

    /** The checklist's answer, settled, or a resolved null when this session cannot have one (not the owner) or the client cannot ask. */
    askGoLive() {
        const owner = typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
        if (!owner || typeof API.getGoLive !== 'function') return Promise.resolve(null);
        // `#/overview?golive=show` (from Help): bring a hidden checklist back before reading it.
        const reopen = typeof App !== 'undefined' && typeof App.hashParam === 'function' && App.hashParam('golive') === 'show' && typeof API.undismissGoLive === 'function';
        const first = reopen ? this._settle(API.undismissGoLive()) : Promise.resolve(null);
        return first.then(() => this._settle(API.getGoLive()));
    },

    /** The items the card knows how to word (`golive.item.<id>`), and the optional ones. A name from a response never reaches the page unchecked. */
    GOLIVE_IDS: ['profile', 'meta', 'test_comment', 'first_reply_on', 'assistant_tested', 'team', 'alerts_chosen'],
    GOLIVE_OPTIONAL: ['whatsapp', 'youtube'],

    /** Fills the region from a settled `getGoLive()`. Anything but a well-formed `show: true` leaves it empty, and never hurts the page. */
    fillGoLive(res) {
        const host = this.region('golive');
        if (!host) return;
        const value = res && res.status === 'fulfilled' ? res.value : null;
        if (!value || value.show !== true || !Array.isArray(value.items)) {
            this._goLiveShown = false;
            this._goLive = null;
            return;
        }
        this._goLiveShown = true;
        this._goLive = value;
        host.innerHTML = esc(this.renderGoLive(value));
        UI.icons(host);
        // One to-do card, not two: the profile card may have landed first.
        const profile = this.region('profile');
        if (profile) profile.innerHTML = '';
    },

    /** The workspace's name for the title, or '' when the session does not carry it. */
    workspaceName() {
        const tenant = typeof App !== 'undefined' && typeof App.currentTenant === 'function' ? App.currentTenant() : null;
        const name = tenant && typeof tenant.name === 'string' ? tenant.name.trim() : '';
        return name.slice(0, 80);
    },

    /** Where an item's button goes: a dashboard hash (`#/settings?s=team`) as the page and its query, or null when it is not a screen of this dashboard. */
    goLiveTarget(href) {
        if (typeof href !== 'string') return null;
        const m = /^#\/([a-z_]+)(?:\?([A-Za-z0-9_=&%.-]*))?$/.exec(href);
        if (!m) return null;
        return this.isOpenablePage(m[1]) ? { target: m[1], query: m[2] || '' } : null;
    },

    renderGoLiveItem(item) {
        const done = item.done === true;
        const id = item.id;
        let action = '';
        if (!done) {
            if (id === 'profile') {
                // Only the platform admin opens a workspace's setup from here (as the profile card does); the tenant is sent there by the gate.
                if (typeof App !== 'undefined' && typeof App.isAdmin === 'function' && App.isAdmin()) {
                    action = html`<button type="button" class="btn btn-secondary btn-sm" data-action="overview:wizard">${t('golive.do.profile')}</button>`;
                }
            } else if (id === 'test_comment') {
                action = UI.helpLink('go-live#test-comment', t('golive.do.test_comment'));
            } else {
                const to = this.goLiveTarget(item.href);
                if (to) {
                    action = html`<button type="button" class="btn btn-secondary btn-sm" data-action="app:navigate" data-target="${to.target}"${to.query ? html` data-query="${to.query}"` : ''}>${t(`golive.do.${id}`)}</button>`;
                }
            }
        }
        const handle = item.detail && typeof item.detail.handle === 'string' ? item.detail.handle : '';
        const why = `golive.item.${id}.why`;
        return html`
            <li class="golive-item${done ? ' golive-item--done' : ''}" data-item="${id}" data-done="${done ? 'true' : 'false'}">
                <span class="golive-mark" aria-hidden="true">${done ? '✓' : '○'}</span>
                <div class="golive-item-body">
                    <span class="golive-item-title">${t(`golive.item.${id}`)}</span>
                    <span class="sr-only">${t(done ? 'golive.done' : 'golive.todo')}</span>
                    ${handle ? html`<span class="golive-detail" dir="ltr">@${handle}</span>` : ''}
                    ${!done && t(why) !== why ? html`<span class="golive-why">${t(why)}</span>` : ''}
                </div>
                ${action}
            </li>
        `;
    },

    renderGoLive(v) {
        const items = v.items.filter((i) => i && typeof i.id === 'string' && this.GOLIVE_IDS.indexOf(i.id) !== -1);
        if (v.live === true) {
            return html`
                <section class="golive-card golive-card--live surface" aria-label="${t('golive.live')}">
                    <span class="alert-icon golive-live-icon"><i data-lucide="check-circle" aria-hidden="true"></i></span>
                    <p class="golive-live-line"><strong>${t('golive.live')}</strong> ${t('golive.liveBody')}</p>
                </section>
            `;
        }
        const total = Number.isFinite(Number(v.total)) ? Number(v.total) : items.length;
        const done = Number.isFinite(Number(v.done)) ? Number(v.done) : items.filter((i) => i.done).length;
        const name = this.workspaceName();
        const counts = { done: UI.formatNumber(done), total: UI.formatNumber(total) };
        const title = name ? t('golive.title', Object.assign({ name }, counts)) : t('golive.titleNoName', counts);
        const optional = (Array.isArray(v.optional) ? v.optional : []).filter((o) => o && this.GOLIVE_OPTIONAL.indexOf(o.id) !== -1 && o.done !== true);
        return html`
            <section class="golive-card surface" aria-labelledby="golive-title">
                <div class="golive-head">
                    <h2 class="golive-title" id="golive-title" dir="auto">${title}</h2>
                    <button type="button" class="btn btn-ghost btn-sm" data-action="overview:hideGoLive">${t('golive.hide')}</button>
                </div>
                <progress class="studio-meter golive-meter" max="${Math.max(1, total)}" value="${Math.min(done, Math.max(1, total))}" aria-label="${title}"></progress>
                <ul class="golive-items">${items.map((i) => this.renderGoLiveItem(i))}</ul>
                ${optional.length > 0 ? html`
                    <p class="golive-optional">${t('golive.optional')}
                        ${optional.map((o) => {
                            const to = this.goLiveTarget(o.href);
                            return to
                                ? html` <button type="button" class="btn btn-ghost btn-sm" data-action="app:navigate" data-target="${to.target}"${to.query ? html` data-query="${to.query}"` : ''}>${t(`golive.optional.${o.id}`)}</button>`
                                : '';
                        })}
                    </p>` : ''}
                <p class="form-hint golive-help">${UI.helpLink('go-live', t('golive.help'))}</p>
            </section>
        `;
    },

    /** Hide the checklist, with an Undo: the request is sent at once, and Undo asks for it back. */
    async hideGoLive(el) {
        const restore = typeof UI.actionBusy === 'function' ? UI.actionBusy(el) : () => {};
        if (!restore) return;
        try {
            await API.dismissGoLive();
            const host = this.region('golive');
            if (host) host.innerHTML = '';
            this._goLiveShown = false;
            UI.undoToast(t('golive.hidden'), {
                onUndo: async () => {
                    await API.undismissGoLive();
                    this.fillGoLive(await this._settle(API.getGoLive()));
                },
            });
        } catch (err) {
            UI.toast(UI.errorText(err).sentence, 'error');
        } finally {
            if (typeof restore === 'function') restore();
        }
    },

    // ─── The staff orientation card (U3) ────────────────────────────────────

    /** The browser-local key that says this person saw the card: per workspace, and per person ("shared" for the shared password). */
    orientationKey() {
        const s = typeof App !== 'undefined' ? App.session : null;
        if (!s || !s.tenantId) return null;
        return `orientation_seen:${s.tenantId}:${s.userId || 'shared'}`;
    },

    /** An operator or a viewer, and not the platform admin: the people the card is for. */
    orientationRole() {
        if (typeof App === 'undefined' || !App.session || App.session.role === 'platform_admin' || typeof App.tenantRole !== 'function') return null;
        const role = App.tenantRole();
        return role === 'operator' || role === 'viewer' ? role : null;
    },

    orientationSeen() {
        const key = this.orientationKey();
        if (!key) return true;
        try {
            return window.localStorage.getItem(key) === '1';
        } catch (_) {
            // Storage blocked: show it, once per visit, rather than never.
            return false;
        }
    },

    /** Draws the card into the checklist's region for a staff member who has not seen it. The checklist is the owner's, so the two never meet. */
    fillOrientation() {
        const host = this.region('golive');
        if (!host) return;
        const role = this.orientationRole();
        if (!role || this.orientationSeen()) return;
        host.innerHTML = esc(html`
            <section class="orientation-card surface" aria-labelledby="orientation-title">
                <div class="golive-head">
                    <h2 class="golive-title" id="orientation-title">${t('orientation.title')}</h2>
                    <button type="button" class="btn btn-ghost btn-sm" data-action="overview:closeOrientation" aria-label="${t('orientation.close')}"><i data-lucide="x" aria-hidden="true"></i></button>
                </div>
                <p><strong>${t('roles.yours')}: ${t(`roles.${role}`)}.</strong> ${t(`roles.${role}.what`)}</p>
                <div class="form-actions">
                    <button type="button" class="btn btn-primary btn-sm" data-action="app:navigate" data-target="settings" data-query="s=notifications">${t('orientation.choose')}</button>
                    <button type="button" class="btn btn-secondary btn-sm" data-action="app:navigate" data-target="inbox">${t('orientation.inbox')}</button>
                </div>
            </section>
        `);
        UI.icons(host);
    },

    closeOrientation() {
        const key = this.orientationKey();
        if (key) {
            try { window.localStorage.setItem(key, '1'); } catch (_) { /* seen for this visit only */ }
        }
        const host = this.region('golive');
        if (host) host.innerHTML = '';
    },

    // ─── The profile card (P30) ──────────────────────────────────────────────

    /** The lucide icon of each action, by id: names the icon subset already carries. */
    PROFILE_ICONS: Object.assign(Object.create(null), {
        finish_setup: 'rocket', connect_meta: 'instagram', voice_samples: 'sparkles', dm_handoff: 'message-square', presenter: 'film',
        portrait: 'image-plus', audience: 'target', connect_tiktok: 'music-2', connect_youtube: 'youtube',
    }),

    /** Which agent each "add" action is for, so the sheet opens with that agent's own line. */
    PROFILE_AGENTS: Object.assign(Object.create(null), { voice_samples: 'studio', presenter: 'monteur', dm_handoff: 'dm', audience: 'coach' }),

    /** How many posts "add posts you're proud of" asks for (`SAMPLES_ENOUGH` in completeness.ts). */
    PROFILE_SAMPLES: 3,

    /** Fills the region from a settled `getProfileProgress()`. Anything but a well-formed answer leaves it empty. */
    fillProfile(progressRes) {
        const host = this.region('profile');
        if (!host) return;
        if (this._goLiveShown) {
            host.innerHTML = '';
            return;
        }
        const value = progressRes && progressRes.status === 'fulfilled' ? progressRes.value : null;
        if (!value || typeof value !== 'object' || !Number.isFinite(Number(value.percent))) {
            host.innerHTML = '';
            return;
        }
        host.innerHTML = esc(this.renderProfileCard(value));
        UI.icons(host);
    },

    /** The percentage the server sent, kept to a whole number from 0 to 100. */
    profilePercent(progress) {
        const n = Math.round(Number(progress && progress.percent));
        return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    },

    renderProfileCard(progress) {
        const actions = (Array.isArray(progress.actions) ? progress.actions : []).filter((a) => a && typeof a.id === 'string' && this.PROFILE_ICONS[a.id]);
        const percent = this.profilePercent(progress);
        if (progress.complete === true && actions.length === 0) {
            return html`
                <section class="profile-card profile-card--done surface" aria-label="${t('profileCard.done')}">
                    <span class="alert-icon profile-done-icon"><i data-lucide="check-circle" aria-hidden="true"></i></span>
                    <div>
                        <h2 class="profile-card-title">${t('profileCard.done')}</h2>
                        <p>${t('profileCard.doneBody')}</p>
                    </div>
                </section>
            `;
        }
        // `formatPercent` is already a left-to-right isolate, so "46%" stays "46%" inside an Arabic sentence (OV-30).
        const shown = UI.formatPercent(percent);
        return html`
            <section class="profile-card surface" aria-labelledby="profile-card-title">
                <div class="profile-card-head">
                    <h2 class="profile-card-title" id="profile-card-title">${t('profileCard.title', { pct: shown })}</h2>
                    <progress class="studio-meter profile-card-meter" max="100" value="${percent}" aria-label="${t('profileCard.meter', { pct: shown })}"></progress>
                </div>
                ${actions.length > 0 ? html`
                    <h3 class="sr-only">${t('profileCard.actionsLabel')}</h3>
                    <ul class="profile-actions">${actions.map((action) => this.renderProfileAction(action, progress.canEdit === true))}</ul>
                ` : html`<p class="form-hint">${t('profileCard.noActions')}</p>`}
            </section>
        `;
    },

    /** Is `target` a screen of this dashboard a person may open? A name from a response never reaches `data-target` unchecked. */
    isOpenablePage(target) {
        if (typeof target !== 'string' || typeof App === 'undefined' || !App.pages) return false;
        const entry = Object.prototype.hasOwnProperty.call(App.pages, target) ? App.pages[target] : null;
        if (!entry || entry.routable === false || entry.adminOnly) return false;
        // U3: a screen of a module this workspace does not have is not offered (the shell's registry, when it is on the page).
        if (typeof Shell !== 'undefined' && Shell && typeof Shell.canSee === 'function' && typeof App.shellContext === 'function') {
            try { return Shell.canSee(target, App.shellContext()) !== false; } catch (_) { return true; }
        }
        return true;
    },

    renderProfileAction(action, canEdit) {
        const link = action.link && typeof action.link === 'object' ? action.link : {};
        const icon = this.PROFILE_ICONS[action.id];
        const title = action.id === 'voice_samples'
            ? t(`profileCard.action.${action.id}`, { n: UI.formatNumber(this.PROFILE_SAMPLES) })
            : t(`profileCard.action.${action.id}`);
        return html`
            <li class="profile-action" data-action-id="${action.id}">
                <span class="alert-icon profile-action-icon"><i data-lucide="${icon}" aria-hidden="true"></i></span>
                <div class="profile-action-body">
                    <h4 class="profile-action-title">${title}</h4>
                    <p class="profile-action-why">${t(`profileCard.action.${action.id}.why`)}</p>
                </div>
                ${this.renderProfileDoer(action, link, canEdit)}
            </li>
        `;
    },

    /** The button (or the sentence that stands in for one) of an action, by where it is carried out. */
    renderProfileDoer(action, link, canEdit) {
        if (link.kind === 'ask') {
            // The sheet writes the profile, which is the owner's: anyone else is told who to ask.
            if (!canEdit) return html`<span class="profile-action-note">${t('profileCard.ownerOnly')}</span>`;
            const fields = (Array.isArray(link.fields) ? link.fields : []).filter((f) => typeof f === 'string').join(',');
            return html`<button type="button" class="btn btn-secondary btn-sm" data-action="overview:ask" data-fields="${fields}" data-agent="${action.id}">${t('profileCard.do.ask')}</button>`;
        }
        if (link.kind === 'wizard') {
            // Only the platform admin can open a tenant's setup from here (`#/welcome?mode=behalf`); the tenant is sent there by the gate.
            if (typeof App === 'undefined' || typeof App.isAdmin !== 'function' || !App.isAdmin()) return '';
            return html`<button type="button" class="btn btn-secondary btn-sm" data-action="overview:wizard">${t('profileCard.do.wizard')}</button>`;
        }
        if (link.kind === 'page' && this.isOpenablePage(link.target)) {
            const connect = typeof action.id === 'string' && action.id.startsWith('connect_');
            return html`<button type="button" class="btn btn-secondary btn-sm" data-action="app:navigate" data-target="${link.target}">${connect ? t('profileCard.do.connect') : t('profileCard.do.open')}</button>`;
        }
        return '';
    },

    /** An "add" button: the sheet for the fields, then the card again from the server, so the percentage is the server's. */
    async askProfile(el) {
        const fields = String(el.dataset.fields || '').split(',').filter(Boolean);
        const saved = await ProfileAsk.require(fields, { agent: this.PROFILE_AGENTS[el.dataset.agent] || '' });
        if (!saved) return;
        const res = await this._settle(API.getProfileProgress());
        this.fillProfile(res);
    },

    openWizard() {
        location.hash = '#/welcome?mode=behalf';
    },

    // ─── Shared readings ─────────────────────────────────────────────────────

    /** The attention summary a settled `GET /api/attention` holds, or null (rejected, absent, or not a summary): the one place this page opens the response. */
    attentionOf(res) {
        if (!res || res.status !== 'fulfilled' || !res.value || !Array.isArray(res.value.items)) return null;
        return res.value;
    },

    /** One of the summary's nav counts (`inbox`, `studio`, `scheduler`) as a whole number, or null when the summary did not say. */
    attentionCount(res, name) {
        const summary = this.attentionOf(res);
        const n = summary && summary.counts ? Math.floor(Number(summary.counts[name])) : NaN;
        return Number.isFinite(n) && n >= 0 ? n : null;
    },

    /** The conversations that need a person, as the server counts them: handed over, or waiting for a reply (`counts.inbox`), and how long the oldest has waited. */
    waitingFact(res) {
        const summary = this.attentionOf(res);
        const count = this.attentionCount(res, 'inbox');
        if (!summary || count === null) return null;
        const dates = summary.items
            .filter((item) => item && (item.type === 'handoff' || item.type === 'thread_waiting') && item.oldestAt)
            .map((item) => Date.parse(item.oldestAt))
            .filter((ms) => Number.isFinite(ms));
        const lastAt = this.windowOf(summary.items.filter((item) => item && (item.type === 'handoff' || item.type === 'thread_waiting'))).lastInboundAt;
        return { count, oldestAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null, lastInboundAt: lastAt };
    },

    /**
     * The reply window of a group of thread items (QA-02), from the server's `detail.window`: counted from the customer's LAST message, the timestamp the Inbox
     * reads, and not from the handoff (a thread handed over 16 days ago whose customer wrote yesterday has a window, and it is the Inbox's). `known` is false
     * unless EVERY item carries it (an answer from before the fact existed says nothing, and the old wording stays). `lastInboundAt`: the newest message (ISO);
     * `open`: windows still open; `closesAt`: ms when the soonest open one closes, or null.
     */
    windowOf(items) {
        const list = (Array.isArray(items) ? items : []).map((i) => (i && i.detail && i.detail.window) || null);
        const none = { known: false, lastInboundAt: null, open: 0, closesAt: null };
        if (!list.length || list.some((w) => !w || !Number.isFinite(Date.parse(w.lastInboundAt)))) return none;
        const last = Math.max(...list.map((w) => Date.parse(w.lastInboundAt)));
        const closes = list.map((w) => Date.parse(w.closesAt)).filter((ms) => Number.isFinite(ms));
        return {
            known: true,
            lastInboundAt: new Date(last).toISOString(),
            open: list.reduce((n, w) => n + (Math.max(0, Math.floor(Number(w.open)) || 0)), 0),
            closesAt: closes.length ? Math.min(...closes) : null,
        };
    },

    /** How much of a reply window is left, as a plural-aware phrase: «ساعتين», "2 hours", "under a minute". Whole hours above an hour, minutes below. */
    leftWords(ms) {
        const minute = 60000;
        const hour = 60 * minute;
        if (!(ms >= minute)) return t('overview.window.lt1');
        if (ms < hour) return t('overview.age.minutes', { count: Math.floor(ms / minute) });
        return t('overview.age.hours', { count: Math.floor(ms / hour) });
    },

    /**
     * What the waiting-conversations card says about time, leading with the reply window like the Inbox chip: "Last message 22 hours ago · 2 hours left to
     * reply", or "· the reply window has closed". null when the server did not say (then the old "has waited" line is used).
     */
    waitingWindowBody(items, total) {
        const w = this.windowOf(items);
        if (!w.known) return null;
        const ago = this.spanWords(w.lastInboundAt);
        if (w.open > 0 && w.closesAt !== null && w.closesAt - Date.now() > 0) {
            return t('overview.alert.waitingWindow', { count: total, ago, left: this.leftWords(w.closesAt - Date.now()) });
        }
        return t('overview.alert.waitingWindowClosed', { count: total, ago });
    },

    // ─── Durations, in words ─────────────────────────────────────────────────

    /**
     * How long ago `iso` was, as a plural-aware phrase WITHOUT "ago": "12 days", «12 يومًا», «يومين». The dictionaries' short forms («12 ي») are for
     * tables; a sentence needs a word. null for a missing or invalid date. A moment in the future reads as no time at all (one minute).
     */
    spanWords(iso) {
        const at = iso ? new Date(iso).getTime() : NaN;
        if (!Number.isFinite(at)) return null;
        const ms = Math.max(0, Date.now() - at);
        const minute = 60000;
        const hour = 60 * minute;
        const day = 24 * hour;
        if (ms < hour) return t('overview.age.minutes', { count: Math.max(1, Math.floor(ms / minute)) });
        if (ms < day) return t('overview.age.hours', { count: Math.floor(ms / hour) });
        return t('overview.age.days', { count: Math.floor(ms / day) });
    },

    // ─── The heartbeat ───────────────────────────────────────────────────────

    /** Events from Meta count as "arriving" when the newest is under this old: a quiet day is normal, a quiet week is not. */
    EVENTS_FRESH_MS: 24 * 60 * 60 * 1000,

    /**
     * The one line that answers "is it working?" before "what is wrong?" (U2, DW-T2; research T-d): when the last comment and the last DM came in, whether
     * events from Meta are arriving at all, and whether the Mac worker is online. Everything is the server's (`heartbeat` of `GET /api/attention`: columns
     * only, no call to Meta). `[]` for a summary without one. The worker is left out for a tenant that never registered one: there is no Mac to be offline.
     * Each part is `{ key, level: 'ok' | 'warn' | 'info', icon, text }`; the level is for colour and the icon and words carry the same meaning.
     */
    heartbeatParts(res) {
        const summary = this.attentionOf(res);
        const beat = summary && summary.heartbeat && typeof summary.heartbeat === 'object' ? summary.heartbeat : null;
        if (!beat) return [];
        const parts = [];
        const comment = this.spanWords(beat.lastCommentAt);
        parts.push({ key: 'comments', level: 'info', icon: 'message-circle',
            text: comment ? t('overview.heartbeat.comment', { age: comment }) : t('overview.heartbeat.noComment') });
        const dm = this.spanWords(beat.lastDmAt);
        parts.push({ key: 'dms', level: 'info', icon: 'send-horizontal',
            text: dm ? t('overview.heartbeat.dm', { age: dm }) : t('overview.heartbeat.noDm') });
        const eventAt = beat.lastWebhookAt ? Date.parse(beat.lastWebhookAt) : NaN;
        if (Number.isFinite(eventAt) && Date.now() - eventAt < this.EVENTS_FRESH_MS) {
            parts.push({ key: 'events', level: 'ok', icon: 'activity', text: t('overview.heartbeat.eventsOk') });
        } else {
            const quiet = this.spanWords(beat.lastWebhookAt);
            parts.push({ key: 'events', level: 'warn', icon: 'activity',
                text: quiet ? t('overview.heartbeat.eventsQuiet', { age: quiet }) : t('overview.heartbeat.eventsNone') });
        }
        const worker = beat.worker && typeof beat.worker === 'object' ? beat.worker : null;
        if (worker && worker.lastSeenAt) {
            parts.push(worker.online
                ? { key: 'worker', level: 'ok', icon: 'laptop', text: t('overview.heartbeat.workerOnline') }
                : { key: 'worker', level: 'warn', icon: 'laptop', text: t('overview.heartbeat.workerOffline', { age: this.spanWords(worker.lastSeenAt) || '' }) });
        }
        return parts;
    },

    renderHeartbeat(res) {
        const parts = this.heartbeatParts(res);
        if (!parts.length) return '';
        return html`
            <ul class="heartbeat" aria-label="${t('overview.heartbeat.label')}">
                ${parts.map((part) => html`<li class="heartbeat-item heartbeat-${html.raw(part.level)}" data-heartbeat="${part.key}"><i data-lucide="${part.icon}" aria-hidden="true"></i><span>${part.text}</span></li>`)}
            </ul>
        `;
    },

    /**
     * What one day of `/stats/daily` says about the comment DMs, as `{ delivered, actionable, byDesign, split }`. `split` is false for
     * a row without the outcome split, which is read as it always was (sent, failed): never a split invented from nothing.
     * `actionable` is what needs the owner, so it is the only red number; `byDesign` is what the product skipped on purpose.
     */
    dayOutcomes(row) {
        const d = row || {};
        const n = (v) => Number(v) || 0;
        if ('delivered' in d || 'actionable' in d) {
            return { delivered: n(d.delivered), actionable: n(d.actionable), byDesign: n(d.by_design), split: true };
        }
        return { delivered: n(d.sent), actionable: n(d.failed), byDesign: 0, split: false };
    },

    /** The sum of `dayOutcomes` over a series, with `assistant` (null when the series carries no `assistant_replies`). */
    weekOutcomes(daily) {
        const rows = Array.isArray(daily) ? daily : [];
        const out = { delivered: 0, actionable: 0, byDesign: 0, assistant: null, split: false };
        rows.forEach((row) => {
            const day = this.dayOutcomes(row);
            out.delivered += day.delivered;
            out.actionable += day.actionable;
            out.byDesign += day.byDesign;
            out.split = out.split || day.split;
            if (row && 'assistant_replies' in row) out.assistant = (out.assistant || 0) + (Number(row.assistant_replies) || 0);
        });
        return out;
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
     * Turn the API answers into a list of things that are actually wrong. What needs the owner in the app's own queues (posts, conversations, the Studio)
     * is not worked out here: it is `GET /api/attention`'s items (U2, DW-T2), which every other screen counts the same way.
     * Pushed in the order the checks run; `sortAlerts()` then puts what is
     * broken before what is late before what is merely worth knowing.
     */
    buildAlerts(stats, failedRes, tokenRes, dailyRes, metaRes, healthRes, attentionRes) {
        const alerts = [];
        const startOfToday = this.localMidnight();

        // 1. Access token — nothing works without it.
        if (tokenRes.status === 'fulfilled' && tokenRes.value) {
            const token = tokenRes.value;
            if (token.status === 'not_connected') {
                // A tenant that has not connected yet is not broken (OV-04): neutral, with the way to connect. This used to be the
                // red "access token invalid" below, on the first screen a new tenant ever sees, beside the profile card's own Connect.
                alerts.push({
                    level: 'info', icon: 'link',
                    title: t('overview.alert.notConnected'),
                    body: t('overview.alert.notConnectedBody'),
                    action: t('overview.alert.connect'), target: 'settings',
                });
            } else if (token.status === 'unknown') {
                // Meta did not answer the check (OV-08): not a verdict on the token, so not the red one below.
                alerts.push({
                    level: 'warning', icon: 'help-circle',
                    title: t('overview.alert.tokenUnknown'),
                    body: t('overview.alert.tokenUnansweredBody'),
                    action: t('overview.openSettings'), target: 'settings',
                });
            } else if (token.status && token.status !== 'valid') {
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

        // 1b. A Facebook connection that needs its owner to reconnect (P29): Meta said the token is dead, or Instagram's access is about to
        //     lapse. Read from what the daily recheck STORED (`reconnectDue`), so a Meta outage can never raise it. Said once: not again
        //     when the live check above already called the token bad. A connection that failed to load says nothing here: this is an
        //     early warning, and the card in Settings reports its own failures.
        const connection = metaRes && metaRes.status === 'fulfilled' && metaRes.value ? metaRes.value.connection : null;
        const liveSaidSo = alerts.some((a) => a.icon === 'key-round' || a.icon === 'clock-alert');
        if (connection && connection.connected === true && connection.reconnectDue === true && !liveSaidSo) {
            const invalid = connection.reconnectReason === 'invalid' || connection.tokenStatus === 'invalid';
            alerts.push({
                level: invalid ? 'danger' : 'warning', icon: invalid ? 'key-round' : 'clock-alert',
                title: t(invalid ? 'overview.alert.metaInvalid' : 'overview.alert.metaExpiring'),
                body: t(invalid ? 'overview.alert.metaInvalidBody' : 'overview.alert.metaExpiringBody'),
                action: t('overview.openSettings'), target: 'settings',
            });
        }

        // 1c. Meta is not sending this account's events to AutoReply (src/services/metaWebhooks.ts): an event type points at another website, is switched off, or lacks
        //     a field. Nothing else on this screen can show it: the token is valid, every connection reads "Connected", and a Facebook event keeps "last webhook" fresh
        //     while Instagram's go elsewhere. Read from the hourly check's stored answer (`health.webhooks`), and only a definite `ok: false` is an alert: a check that
        //     could not run, or a server that does not send it, says nothing. The platform admin is sent to the card that fixes it; everyone else is told whom to ask.
        const webhooks = healthRes && healthRes.status === 'fulfilled' && healthRes.value ? healthRes.value.webhooks : null;
        const webhookNotice = typeof HealthStrip !== 'undefined' ? HealthStrip.webhookNotice(webhooks) : null;
        if (webhookNotice) {
            const admin = typeof App !== 'undefined' && typeof App.isAdmin === 'function' && App.isAdmin();
            alerts.push({
                level: 'danger', icon: 'plug-zap',
                title: webhookNotice.title,
                body: [...webhookNotice.lines, admin ? '' : t('webhooks.banner.askOwner')].filter(Boolean).join(' '),
                action: admin ? t('webhooks.banner.fix') : '', target: admin ? 'settings' : '', query: admin ? 's=platform&card=meta-events' : '',
            });
        }

        // 1d. Cloudflare R2's free tier at 80% or more, or used up (src/services/r2Usage.ts): the platform admin's, so the server sends it to nobody else. At 100% new
        //     uploads to R2 are refused and its files stop being served until the 1st (UTC), so it is the owner's to know before a post fails on it.
        const r2 = healthRes && healthRes.status === 'fulfilled' && healthRes.value ? healthRes.value.r2 : null;
        if (r2 && (r2.level === 'warn' || r2.level === 'full') && typeof App !== 'undefined' && typeof App.isAdmin === 'function' && App.isAdmin()) {
            alerts.push({
                level: r2.level === 'full' ? 'danger' : 'warning', icon: 'cloud-off',
                title: t(r2.level === 'full' ? 'overview.alert.r2Full' : 'overview.alert.r2Warn'),
                body: [...(Array.isArray(r2.items) ? r2.items : []).map((i) => `${t(`settings.media.r2.meter.${i.kind}`)} ${UI.formatNumber(i.pct)}%`), t('overview.alert.r2Body', { date: UI.formatDate(r2.resetsAt) })].join(' · '),
                action: t('overview.alert.r2Fix'), target: 'settings', query: 's=platform&card=storage',
            });
        }

        // 1e. What the server says needs the owner (`GET /api/attention`, columns only, no call to Meta): waiting and handed-over conversations, failed and
        //     overdue posts, a TikTok or YouTube connection that stopped working, and the Studio's alarms (research USE-1, USE-4). Each is ONE alert with one
        //     verb and a link that lands on exactly those items; a failed post, or a thread past Meta's 24 h window, can be cleared from the card. A read that
        //     failed says so (it is NOT a quiet screen); a server that does not send it (an older one, a test) says nothing.
        if (attentionRes && attentionRes.status === 'rejected') {
            alerts.push({
                level: 'warning', icon: 'help-circle', key: 'unknown',
                title: t('overview.alert.attentionUnknown'),
                body: t('overview.alert.attentionUnknownBody'),
                action: t('overview.openInbox'), target: 'inbox',
            });
        }
        this.attentionAlerts(attentionRes, { tokenAlertShown: alerts.some((a) => a.icon === 'key-round' || a.icon === 'clock-alert') }).forEach((alert) => alerts.push(alert));

        // 2. DMs that failed today. Asked for with `since` = local midnight
        //    (O9), so every row is today's; the client-side date check stays as
        //    a belt to that brace. One page is at most FAILED_TODAY_LIMIT rows,
        //    so when the total says there are more, the title says "more than
        //    100" rather than a number that simply stopped.
        if (failedRes.status === 'fulfilled' && failedRes.value) {
            const rows = Array.isArray(failedRes.value.data) ? failedRes.value.data : [];
            const failedToday = rows.filter((row) => {
                const at = row.timestamp ? new Date(row.timestamp) : null;
                // The route was asked for `outcome=actionable`; a row that says it is anything else is not one that needs the owner.
                return at && !Number.isNaN(at.getTime()) && at >= startOfToday && (!row.outcome || row.outcome === 'actionable');
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
                    action: t('overview.openActivity'), target: 'activity', query: 'outcome=actionable',
                });
            }
        }

        // 3. The trailing 7-day send success rate — "failed today" is zero on
        //    any day that is not one of the bad ones, so a week that was 39%
        //    failure overall can sail through check #2 on 5 days out of 7.
        //    Reads the SAME daily series the chart below already fetches
        //    (dailyP), so this costs no extra request.
        if (dailyRes.status === 'fulfilled' && Array.isArray(dailyRes.value)) {
            // Delivered ÷ (delivered + actionable), the one success definition (audit OV-20): a DM skipped on purpose is not an attempt
            // that failed, so a week of "already had its reply" no longer reads as a failing account.
            const week = this.weekOutcomes(dailyRes.value);
            const trailingSent = week.delivered;
            const trailingFailed = week.actionable;
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

    // ─── The server's items as alerts, and clearing them (U2, DW-T2 / DW-T3) ──────

    /** The item types this page turns into alerts, besides the Studio's four. */
    ATTENTION_TYPES: ['handoff', 'thread_waiting', 'post_failed', 'post_failed_old', 'post_overdue', 'connection_broken'],

    /** The failure reasons the dictionaries name (`overview.failed.reason.*`); anything else the server might one day send reads as `other`. */
    FAILURE_REASONS: ['replaced', 'tiktok_private', 'token', 'media', 'other'],

    /** Archive and Mark handled change the owner's data, so they are the operator's (the routes answer 403 to a viewer): a viewer is not shown them. */
    canClear() {
        return typeof App === 'undefined' || typeof App.canOperate !== 'function' || App.canOperate();
    },

    /**
     * How old a failed post is, as the reason line says it: "35 days ago", or "dated 1 Jan 2027" for one whose time is still ahead (a placeholder, a reel
     * replaced before its slot), which has no age. '' for no date.
     */
    failureAge(iso) {
        const at = iso ? Date.parse(iso) : NaN;
        if (!Number.isFinite(at)) return '';
        if (at > Date.now()) return t('overview.failed.dated', { date: this.datedWords(iso) });
        const span = this.spanWords(iso);
        return span ? t('overview.failed.ago', { age: span }) : '';
    },

    /** "1 Jan 2027" for a date outside this year, "1 Jan" inside it (QA-04: a date read as "Jan 1" does not say which year it is). Latin digits, like every date. */
    datedWords(iso) {
        const at = new Date(iso);
        const sameYear = at.getFullYear() === new Date().getFullYear();
        return UI._fmt(iso, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
    },

    /** One line per reason a post failed: "2 TikTok direct posts need a private TikTok account · 35 days ago". The server counts posts (one per group), so these add up to the card. */
    failureLines(item) {
        const reasons = item && item.detail && Array.isArray(item.detail.reasons) ? item.detail.reasons : [];
        return reasons.map((r) => {
            const reason = this.FAILURE_REASONS.indexOf(r && r.reason) === -1 ? 'other' : r.reason;
            const count = Math.max(1, Math.floor(Number(r && r.count)) || 1);
            const age = this.failureAge(r && r.oldestAt);
            return age ? t('overview.failed.line', { what: t(`overview.failed.reason.${reason}`, { count }), age }) : t(`overview.failed.reason.${reason}`, { count });
        });
    },

    /** The ids an item carries for one kind of clearing, as plain strings, unique and bounded. */
    detailIds(list) {
        return [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === 'string' && /^[0-9a-f-]{8,64}$/i.test(id)))].slice(0, 100);
    },

    /**
     * The alerts the attention summary holds: each is `{ key, level, icon, title, body, action, href, reasons?, clear? }`, in the server's order (it sorts by
     * severity, then the longest wait). Handed-over and waiting conversations are ONE card (one To do list, one link). `clear` is what the card can do
     * about itself: archive these failed posts, or mark these conversations handled; absent for a viewer, and when there is nothing to clear.
     * `opts.tokenAlertShown`: the access token already has its own card, so a stored "Meta connection broken" is not said a second time.
     */
    attentionAlerts(res, opts) {
        const summary = this.attentionOf(res);
        if (!summary) return [];
        const canClear = this.canClear();
        const tokenShown = !!(opts && opts.tokenAlertShown);
        const wanted = this.ATTENTION_TYPES.concat(Attention.STUDIO_TYPES);
        const items = Attention.itemsOfType(summary, wanted);
        const studioIcon = { mac_signed_out: 'key-round', worker_offline: 'laptop', tiktok_draft: 'music-2', reel_review: 'scissors' };
        const out = [];
        let threadsDone = false;
        const params = (item) => Attention.studioParams(item, (n) => UI.formatNumber(n));

        items.forEach((item) => {
            const verb = t(item.action.verb);
            const count = Math.max(1, Math.floor(Number(item.count)) || 1);

            if (item.type === 'handoff' || item.type === 'thread_waiting') {
                if (threadsDone) return;
                threadsDone = true;
                const group = items.filter((i) => i.type === 'handoff' || i.type === 'thread_waiting');
                const total = group.reduce((n, i) => n + (Math.max(0, Math.floor(Number(i.count)) || 0)), 0);
                const dates = group.map((i) => Date.parse(i.oldestAt)).filter((ms) => Number.isFinite(ms));
                const age = dates.length ? this.spanWords(new Date(Math.min(...dates)).toISOString()) : null;
                const closed = group.map((i) => (i.detail && i.detail.closed) || null).filter(Boolean);
                const ids = this.detailIds([].concat(...closed.map((c) => c.ids)));
                const alert = {
                    key: 'waiting', level: 'warning', icon: 'message-square-dot',
                    title: t('overview.alert.waitingHumans', { count: total }),
                    body: this.waitingWindowBody(group, total) || (age ? t('overview.alert.waitingOldest', { age, count: total }) : t('overview.alert.waitingHumansBody')),
                    action: verb, href: item.action.href,
                };
                if (canClear && ids.length) {
                    alert.clear = { kind: 'handled', ids, count: ids.length, icon: 'check', button: t('inbox.handled.mark'), line: t('overview.waiting.closedLine', { count: ids.length }) };
                }
                out.push(alert);
                return;
            }

            if (item.type === 'post_failed' || item.type === 'post_failed_old') {
                const old = item.type === 'post_failed_old';
                const ids = this.detailIds(item.detail && item.detail.ids);
                const alert = {
                    key: item.type, level: old ? 'info' : 'danger', icon: old ? 'archive' : 'image-off',
                    title: old ? t('overview.alert.failedOld', { count, days: Number(item.sentence.params && item.sentence.params.days) || 14 }) : t('overview.alert.failedPosts', { count }),
                    body: old ? t('overview.alert.failedOldBody') : t('overview.alert.failedPostsBody'),
                    action: verb, href: item.action.href, reasons: this.failureLines(item),
                };
                if (canClear && ids.length) alert.clear = { kind: 'archive', ids, count, icon: 'eye-off', button: t('overview.failed.archive', { count }) };
                out.push(alert);
                return;
            }

            if (item.type === 'post_overdue') {
                out.push({
                    key: 'post_overdue', level: 'warning', icon: 'calendar-clock',
                    title: t('overview.alert.overduePosts', { count }), body: t('overview.alert.overduePostsBody'),
                    action: verb, href: item.action.href,
                });
                return;
            }

            if (item.type === 'connection_broken') {
                const platform = item.sentence.params && item.sentence.params.platform;
                // Facebook and Instagram have the token cards above; TikTok and YouTube have nothing else on this screen.
                if (platform === 'meta' && tokenShown) return;
                const label = { tiktok: t('common.tiktok'), youtube: t('common.youtube'), meta: t('common.both') }[platform];
                if (!label) return;
                out.push({
                    key: `connection_${platform}`, level: 'danger', icon: 'plug-zap',
                    title: t('overview.alert.connectionBroken', { platform: label }), body: t('overview.alert.connectionBrokenBody'),
                    action: verb, href: item.action.href,
                });
                return;
            }

            // The Studio's four: the server's own sentence, and its `.body`.
            out.push({
                key: item.type, level: Attention.studioLevel(item), icon: studioIcon[item.type] || 'info',
                title: t(item.sentence.key, params(item)), body: t(`${item.sentence.key}.body`),
                action: verb, href: item.action.href,
            });
        });
        return out;
    },

    /**
     * Paint the briefing region from the inputs it was last built with and this attention answer. Used on load and again after a clear, so the card
     * disappears (or shrinks) at once. Returns the alerts, for the announcement.
     */
    paintBriefing(host, attentionRes) {
        const input = this._briefingInputs;
        if (!host || !input) return [];
        const alerts = this.sortAlerts(this.buildAlerts(input.statsRes.value || {}, input.failedRes, input.tokenRes, input.dailyRes, input.metaRes, input.healthRes, attentionRes));
        this._clears = {};
        alerts.forEach((alert) => { if (alert.clear) this._clears[alert.key] = alert.clear; });
        // Refresh lives inside the region it rewrites; keep focus on it.
        const focus = UI.captureFocus(host);
        host.innerHTML = esc(this.renderBriefing(alerts, new Date(), attentionRes));
        UI.icons(host);
        UI.restoreFocus(focus);
        return alerts;
    },

    /** Read the attention summary again after a clear and repaint what depends on it: the briefing, the waiting tile and the Inbox badge. */
    async refreshAttention() {
        const seq = this._seq;
        const res = await this._settle(API.getAttention());
        if (seq !== this._seq) return;
        const host = this.region('briefing');
        if (host && this._briefingInputs) this.paintBriefing(host, res);
        const stats = this.region('stats');
        const input = this._statsInputs;
        if (stats && input) {
            stats.innerHTML = esc(this.renderStats(input.statsRes.value || {}, input.dailyRes, res));
            UI.icons(stats);
        }
        const inbox = this.attentionCount(res, 'inbox');
        if (inbox !== null && typeof App !== 'undefined' && typeof App.setInboxWaiting === 'function') App.setInboxWaiting(inbox);
    },

    /** Clear one card: "Archive these" or "Mark handled". Done at once, with ONE Undo toast and no question (the plan: undo, not confirm). */
    async clear(el) {
        const key = el && el.dataset ? el.dataset.key : '';
        const clear = this._clears && this._clears[key];
        if (!clear || !this.canClear()) return;
        const restore = typeof UI.actionBusy === 'function' ? UI.actionBusy(el) : () => {};
        if (!restore) return; // already in flight
        const archive = clear.kind === 'archive';
        const doIt = (id) => (archive ? API.archiveScheduledPost(id) : API.markConversationHandled(id));
        const undoIt = (id) => (archive ? API.unarchiveScheduledPost(id) : API.unmarkConversationHandled(id));
        try {
            const results = await Promise.allSettled(clear.ids.map(doIt));
            const done = clear.ids.filter((id, i) => results[i].status === 'fulfilled');
            const failures = clear.ids.length - done.length;
            if (done.length === 0) {
                const reason = results.find((r) => r.status === 'rejected');
                UI.toast(reason && reason.reason ? UI.errorText(reason.reason).sentence : t('overview.clear.failed'), 'error');
                return;
            }
            // Nothing is asked first, so the way back is real: Undo restores exactly the rows that were just cleared, and says so if one cannot be.
            UI.undoToast(t(archive ? 'overview.failed.archived' : 'overview.waiting.handled', { count: failures ? done.length : clear.count }), {
                onUndo: async () => {
                    const back = await Promise.allSettled(done.map(undoIt));
                    await this.refreshAttention();
                    if (back.some((r) => r.status === 'rejected')) throw new Error(t('overview.clear.undoFailed'));
                    Motion.announce(t(archive ? 'posts.unarchived.done' : 'inbox.handled.reopened'));
                },
            });
            if (failures) UI.toast(t('overview.clear.someFailed', { count: failures }), 'error');
            await this.refreshAttention();
        } catch (err) {
            UI.toast(UI.errorText(err).sentence, 'error');
        } finally {
            if (typeof restore === 'function') restore();
        }
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

    renderBriefing(alerts, at, attentionRes) {
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
                ${this.renderHeartbeat(attentionRes)}
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
                                    ${a.reasons && a.reasons.length ? html`<ul class="alert-reasons">${a.reasons.map((line) => html`<li>${line}</li>`)}</ul>` : ''}
                                    ${a.clear ? html`
                                        <div class="alert-clear">
                                            ${a.clear.line ? html`<p class="alert-clear-line">${a.clear.line}</p>` : ''}
                                            ${UI.button({
                                                variant: 'secondary', size: 'sm', icon: a.clear.icon, label: a.clear.button,
                                                action: 'overview:clear', data: { key: a.key },
                                            })}
                                        </div>
                                    ` : ''}
                                    ${a.target ? html`<button type="button" class="alert-link" data-action="app:navigate" data-target="${a.target}"${a.query ? html` data-query="${a.query}"` : ''}>
                                        ${a.action}
                                        <i data-lucide="arrow-right" aria-hidden="true"></i>
                                    </button>` : a.href ? html`<a class="alert-link" href="${a.href}">
                                        ${a.action}
                                        <i data-lucide="arrow-right" aria-hidden="true"></i>
                                    </a>` : ''}
                                </div>
                            </div>
                        `)}
                    </div>
                `}
                <p class="form-hint mbs-3 briefing-help">${UI.helpLink('getting-started', t('help.link.gettingStarted'))}</p>
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

    /** A number the server measured, or null: a missing, null or non-numeric value is "not measured", never 0. */
    measured(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
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
     * "What happened to my content, and what should I do today": views over the
     * last 7 days to yesterday against the same days a week earlier, followers
     * against the goal, the skip rate in its band, and the coach's first action.
     * Every number is the API's; anything it could not measure is "—" with the
     * reason, never a zero.
     *
     * `viewsRes` is the settled `getGrowthOverview(VIEWS_DAYS)`. The views and the
     * week before them are `kpis.views` and `previous.views`, which the server
     * compares over exactly the same span (or answers null when it cannot): this
     * page no longer sums a daily series itself (audit OV-06).
     */
    renderGrowth(growthRes, goalsRes, viewsRes) {
        const failed = !growthRes || growthRes.status !== 'fulfilled';
        const o = !failed && growthRes.value && typeof growthRes.value === 'object' ? growthRes.value : {};
        const k = o.kpis && typeof o.kpis === 'object' ? o.kpis : {};
        const trend = (Array.isArray(o.trend) ? o.trend : [])
            .filter((r) => r && r.day)
            .sort((a, b) => String(a.day).localeCompare(String(b.day)));
        const settings = goalsRes && goalsRes.status === 'fulfilled' && goalsRes.value ? goalsRes.value.settings || {} : {};
        const goal = Number(settings.goal_followers);
        const noData = failed ? '' : t('overview.growth.noData');

        // Views: the server's own answer for the last 7 days, and its exact comparison with the same days a week earlier.
        const viewsFailed = !viewsRes || viewsRes.status !== 'fulfilled';
        const vo = !viewsFailed && viewsRes.value && typeof viewsRes.value === 'object' ? viewsRes.value : {};
        const views = this.measured(vo.kpis && vo.kpis.views);
        const prevViews = this.measured(vo.previous && vo.previous.views);
        // A views read that failed on its own says why under "—"; when the whole region failed it has already said so above.
        let viewsSub = viewsFailed
            ? (failed ? '' : t('overview.growth.unavailable', { reason: (viewsRes && viewsRes.reason && viewsRes.reason.message) || t('error.unexpected') }))
            : noData;
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
     * is the last row of the gap-filled daily series (the tenant's own day, cut
     * on the server), the same day the "failed today" alert counts — it
     * used to be a rolling 24 hours of every status, two numbers called
     * "today" on one screen. The all-time totals are Analytics'.
     *
     * "Failed" is what needs the owner (`actionable`): a DM skipped on purpose
     * is not a failure, so it is named under the number and is not red in it.
     */
    renderStats(stats, dailyRes, attentionRes) {
        const daily = dailyRes && dailyRes.status === 'fulfilled' && Array.isArray(dailyRes.value) ? dailyRes.value : null;
        const today = daily && daily.length ? this.dayOutcomes(daily[daily.length - 1]) : null;
        const sentToday = today ? today.delivered : null;
        const failedToday = today ? today.actionable : null;
        const week = daily ? this.weekOutcomes(daily) : null;
        const weekSent = week ? week.delivered : null;
        const weekFailed = week ? week.actionable : null;
        const weekByDesign = week ? week.byDesign : 0;
        const dailyReason = t('overview.alert.trendUnknown');

        // The same count as the nav badge and the To do list (the server's `counts.inbox`), never a count of its own.
        const waitingFact = this.waitingFact(attentionRes);
        const threadsOk = waitingFact !== null;
        const waiting = { length: threadsOk ? waitingFact.count : 0 };
        const oldest = threadsOk ? this.spanWords(waitingFact.oldestAt) : null;
        // The last message, not the handoff, when the server says it (QA-02): the same moment the Inbox counts its window from.
        const lastWords = threadsOk && waitingFact.lastInboundAt ? this.spanWords(waitingFact.lastInboundAt) : null;
        let waitingSub = t('overview.stat.waitingUnknown');
        if (threadsOk) waitingSub = waiting.length ? (lastWords ? t('overview.stat.waitingLast', { age: lastWords }) : (oldest ? t('overview.stat.waitingOldest', { age: oldest }) : '')) : t('overview.stat.waitingNone');

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
                    <p class="stat-sub">${weekFailed === null ? dailyReason : (weekByDesign > 0
                        ? t('overview.stat.inWeekByDesign', { n: UI.formatNumber(weekFailed), d: UI.formatNumber(weekByDesign) })
                        : t('overview.stat.inWeek', { n: UI.formatNumber(weekFailed) }))}</p>
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
     * The chart region: two labelled 7-day strips, with what they add up to as one line under them.
     *
     *   Comment auto-replies  the private DMs sent in answer to a comment: a cell is the day's delivered DMs, the red foot is what
     *                         needs the owner. A DM skipped on purpose is not drawn red; it is in the tooltip and the table.
     *   Assistant replies     the DMs the assistant sent to people who wrote first. Overview used to draw only the first and read
     *                         all zeros in a week the assistant had answered people (audit OV-18).
     *
     * A series the answer does not carry (a daily row without `assistant_replies`) is left out, not drawn as a row of zeros: a
     * number that was not measured is not 0. A daily read that failed says so, and is not drawn as a quiet week.
     *
     * No library and no canvas: `Charts.dayStrip` returns an SVG string, so
     * this renders synchronously from data it already has.
     */
    renderCharts(dailyRes) {
        const host = this.region('charts');
        if (!host) return;

        const frame = (body) => html`
            <div class="chart-grid chart-grid--one">
                <div class="chart-card surface">
                    <div class="chart-card-header">
                        <h2 class="chart-card-title">${t('overview.chart.activity')}</h2>
                    </div>
                    ${body}
                </div>
            </div>
        `;

        if (!dailyRes || dailyRes.status !== 'fulfilled' || !Array.isArray(dailyRes.value)) {
            host.innerHTML = esc(frame(html`<p class="chart-empty" id="overview-strip-unavailable" role="status">${t('overview.chart.unavailable')}</p>`));
            return;
        }

        const daily = dailyRes.value;
        const week = this.weekOutcomes(daily);
        const strip = (id, labelKey, tone, total, options) => html`
            <div class="strip-series" id="${id}">
                <div class="strip-series-head">
                    <span class="strip-series-label">
                        <span class="chart-dot" style="background: ${Charts.token(tone.token, tone.fallback)}" aria-hidden="true"></span>${t(labelKey)}
                    </span>
                    <span class="strip-series-total">${t('overview.stat.inWeek', { n: UI.formatNumber(total) })}</span>
                </div>
                ${Charts.dayStrip(daily, Object.assign({
                    label: t(labelKey),
                    emptyMessage: t('overview.chart.noActivity'),
                    dayHeader: t('common.day'),
                }, options))}
            </div>
        `;

        // The comment strip draws what became of each DM when the server says so, and what it always drew when it does not.
        const commentOptions = week.split
            ? {
                valueKey: 'delivered', badKey: 'actionable', noteKey: 'by_design',
                valueHeader: t('status.outcome.delivered'), badHeader: t('status.outcome.actionable'), noteHeader: t('status.outcome.by_design'),
            }
            : { sentHeader: t('common.sent'), failedHeader: t('common.failed') };

        let summary = '';
        if (week.split) {
            if (week.delivered + week.actionable + week.byDesign > 0) {
                summary = t('overview.chart.summaryOutcomes', {
                    delivered: UI.formatNumber(week.delivered),
                    actionable: UI.formatNumber(week.actionable),
                    byDesign: UI.formatNumber(week.byDesign),
                });
            }
        } else if (week.delivered + week.actionable > 0) {
            summary = t('overview.chart.summary', {
                sent: UI.formatNumber(week.delivered),
                failed: UI.formatNumber(week.actionable),
                rate: UI.formatPercent(Math.round((week.actionable / (week.delivered + week.actionable)) * 100)),
            });
        }

        host.innerHTML = esc(frame(html`
            ${strip('overview-series-comments', 'overview.chart.series.comments', { token: '--success', fallback: '#34c759' }, week.delivered, commentOptions)}
            ${week.assistant === null ? '' : strip('overview-series-assistant', 'overview.chart.series.assistant',
                { token: '--chart-accent', fallback: 'currentColor' }, week.assistant, {
                    valueKey: 'assistant_replies', badKey: null, valueToken: '--chart-accent', valueFallback: 'currentColor',
                    valueHeader: t('overview.chart.series.assistant'),
                })}
            ${summary ? html`<p class="chart-foot" id="overview-week-summary">${summary}</p>` : ''}
        `));
        UI.icons(host);
    },
};

UI.registerActions('overview', {
    refresh: () => OverviewPage.render(),
    clear: (el) => OverviewPage.clear(el),
    ask: (el) => OverviewPage.askProfile(el),
    wizard: () => OverviewPage.openWizard(),
    hideGoLive: (el) => { OverviewPage.hideGoLive(el).catch((err) => console.warn('Hiding the checklist failed:', err)); },
    closeOrientation: () => OverviewPage.closeOrientation(),
});
