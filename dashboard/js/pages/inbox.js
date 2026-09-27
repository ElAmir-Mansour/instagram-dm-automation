/**
 * DM Inbox — conversations, messages, manual replies, per-thread AI toggle.
 *
 * ─── Polling contract (do not regress) ──────────────────────────────────────
 *   - one request per tick (the thread list), not three
 *   - messages are only re-fetched when that thread's last_message_at changed
 *   - polling stops while the tab is hidden, and on destroy() (navigate/logout)
 *   - an idle list is polled less: 5s, then 15s, then 30s after runs of
 *     unchanged ticks (`POLL_STEPS`), and back to 5s the moment anything
 *     changes, the window regains focus, or the operator acts on a thread
 *   - the composer is built ONCE per selected thread and never re-rendered, so
 *     an unsent draft survives every poll
 *   - the thread list is DIFFED, not rebuilt. `renderThreads()` used to write
 *     `container.innerHTML` every five seconds, which reset the scroller to
 *     the top, dropped focus off whatever row had it, and re-ran the icon pass
 *     over every row. Now `Motion.patchList()` touches only the rows whose
 *     visible content actually changed and moves the rest with `moveBefore()`,
 *     so a tick in which nothing happened does nothing at all.
 *   - an optimistic AI toggle is held in `pendingBotState` until the server
 *     confirms it, so the next poll cannot undo what the operator just did
 *     and then redo it a tick later.
 *
 * ─── Which threads are on screen ────────────────────────────────────────────
 * The list is the newest `LIMIT` (100) threads; the route defaulted to 20 and
 * the screen never said so. When there are more, the count line says "Showing
 * 100 of N". A search goes to the server (`?search=`, debounced) so a customer
 * who wrote last month is findable, and is merged with the loaded threads that
 * match on their last message — the server matches the sender only. The
 * segmented filter (All · Needs reply · AI paused) is applied last, and is
 * seeded from `#/inbox?filter=waiting`, which is where the Overview links.
 *
 * ─── Mobile ─────────────────────────────────────────────────────────────────
 * This is the screen the creator opens on a phone, and the one that used to be
 * least usable there. The layout is a single grid cell below 900px with the
 * two panes stacked on top of each other and `data-pane` deciding which is
 * shown, so "list → thread → back" is a real navigation, not a 39px-wide chat
 * column. The back button is part of the chat header, is 44px, and its chevron
 * flips with the document direction.
 */
const InboxPage = {
    /** How the poll slows down on an idle list, and how many unchanged ticks each step waits. */
    POLL_STEPS: Object.freeze([5000, 15000, 30000]),
    IDLE_TICKS_PER_STEP: 3,
    /** The route's own cap. */
    LIMIT: 100,
    SEARCH_DEBOUNCE_MS: 300,
    FILTERS: Object.freeze(['all', 'waiting', 'paused']),
    /** Hidden for longer than this, the list on return is old news, and the reload says so. */
    RETURN_NOTICE_MS: 60 * 1000,

    selectedConversationId: null,
    pollTimer: null,
    threads: [],
    /** `pagination.total` of the thread list: how many threads there really are. */
    total: null,
    searchTerm: '',
    /** The server's answer for a search: `{ term, rows }`, the term lower-cased and trimmed. */
    searchMatches: null,
    /** 'all' | 'waiting' | 'paused' */
    filter: 'all',
    renderedMessageIds: new Set(),
    lastMessageStamp: null,
    chatShellThreadId: null,
    onVisibilityChange: null,
    onWindowFocus: null,

    /** True once the message list has been painted for the open thread. */
    messagesPainted: false,

    /** The local day of the last message in the log, so a divider goes in when it changes. */
    _lastDayKey: null,

    /** id → the AI state the operator chose, until the server confirms it. */
    pendingBotState: new Map(),

    _pendingSeq: 0,
    _searchRender: null,
    _searchFetch: null,
    _searchSeq: 0,

    /** Bumped by every reset, so a response for a previous visit (or tenant) lands nowhere. */
    _epoch: 0,
    _polling: false,
    _unchangedTicks: 0,
    _listSignature: null,
    _hiddenAt: 0,
    /** What `renderCount()` last wrote. */
    _countMarkup: null,
    /** The stale strip has been shown since the list last loaded, so a success is news. */
    _staleShown: false,

    /** Consecutive silent poll failures. Two is enough to stop pretending. */
    _pollFailures: 0,

    /**
     * The shell. `App.navigate` paints this inside the view transition, so the
     * two panes and the thread rows' shapes are on screen before any request
     * has come back; `render()` then finds the layout already there and leaves
     * it alone rather than painting the same markup a second time.
     */
    layout() {
        const current = this.filterFromHash();
        return html`
            <div class="inbox-layout" data-pane="threads">
                <section class="inbox-sidebar surface" aria-label="${t('inbox.threads')}">
                    <div class="inbox-search">
                        <label class="sr-only" for="inbox-search">${t('inbox.searchLabel')}</label>
                        <div class="input-affix">
                            <i data-lucide="search" aria-hidden="true"></i>
                            <input class="field" type="search" id="inbox-search"
                                   placeholder="${t('inbox.searchPlaceholder')}"
                                   autocomplete="off" data-input="inbox:handleSearch">
                        </div>
                        <div class="segmented" role="group" id="inbox-filter" aria-label="${t('inbox.filter.label')}">
                            ${this.FILTERS.map((key) => html`
                                <button type="button" class="btn btn-sm btn-ghost" id="inbox-filter-${key}"
                                        data-action="inbox:setFilter" data-filter="${key}"
                                        aria-pressed="${key === current ? 'true' : 'false'}">${t(`inbox.filter.${key}`)}</button>
                            `)}
                        </div>
                        <p class="inbox-count" id="inbox-count"></p>
                    </div>
                    <!-- The 5s poll used to fail completely silently, so a
                         dropped network looked exactly like a quiet inbox:
                         a frozen list, indefinitely, with no way to tell. -->
                    <div id="threads-stale" class="hidden"></div>
                    <div class="threads-list" id="threads-container">
                        ${Motion.threadRows(7)}
                    </div>
                </section>

                <section class="chat-pane surface" id="chat-pane-container" aria-label="${t('inbox.messages')}">
                    ${this.emptyChatState()}
                </section>
            </div>
        `;
    },

    skeleton() {
        return this.layout();
    },

    render() {
        const container = document.getElementById('page-container');
        if (!container) return;

        if (!container.querySelector('.inbox-layout')) {
            container.innerHTML = esc(this.layout());
            UI.icons(container);
        }
        Motion.clearSkeleton(container);

        this.resetViewState();
        this.filter = this.filterFromHash();
        this.syncFilterButtons();
        this.markStale(false);

        this.loadThreads();
        this.startPolling();

        // Pause polling while the tab is in the background — an inbox left open
        // in a spare tab was the single biggest source of serverless invocations.
        // Coming back is NOT silent: after a while away the list is certainly
        // old, so the reload says it is refreshing and a failure shows at once
        // instead of after two more quiet ticks.
        this.onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                this._hiddenAt = Date.now();
                this.stopPolling();
            } else {
                const away = this._hiddenAt ? Date.now() - this._hiddenAt : 0;
                this._hiddenAt = 0;
                this.loadThreads(true, { loud: true, notice: away > this.RETURN_NOTICE_MS });
                this.startPolling();
            }
        };
        document.addEventListener('visibilitychange', this.onVisibilityChange);

        // Focus is the operator looking again: back to the fast poll.
        this.onWindowFocus = () => this.resetBackoff();
        if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('focus', this.onWindowFocus);
    },

    /**
     * Everything that belongs to a previous visit to this screen.
     *
     * This list was written out three times — in `render()`, in `destroy()` and
     * in `resetTenantState()` — and the three had drifted. `searchTerm` was in
     * none of them, and that is a bug the operator sees: `layout()` is
     * repainted on every arrival, so `#inbox-search` comes back empty, while
     * the TERM survived as module state. Leave the inbox having typed "sara",
     * come back, and the list is filtered to Sara with an empty search box and
     * nothing on screen explaining it — on the one screen where a conversation
     * you cannot see is a customer who does not get answered.
     *
     * One list, three callers, so a field added here cannot be added to two of
     * the three again.
     */
    resetViewState() {
        this._epoch++;
        this.selectedConversationId = null;
        this.chatShellThreadId = null;
        this.renderedMessageIds = new Set();
        this.messagesPainted = false;
        this._lastDayKey = null;
        this.pendingBotState = new Map();
        this.lastMessageStamp = null;
        this.searchTerm = '';
        this.searchMatches = null;
        this.filter = 'all';
        this._pollFailures = 0;
        this._unchangedTicks = 0;
        this._listSignature = null;
        this._countMarkup = null;
        this._staleShown = false;
        if (this._searchFetch && typeof this._searchFetch.cancel === 'function') this._searchFetch.cancel();
    },

    /**
     * Called by App before navigating away AND on logout. The previous version
     * monkey-patched App.navigate, which logout never went through — so the
     * poller kept running after sign-out, 401ing and re-rendering the login
     * screen on every tick, forever.
     */
    destroy() {
        this.stopPolling();
        if (this.onVisibilityChange) {
            document.removeEventListener('visibilitychange', this.onVisibilityChange);
            this.onVisibilityChange = null;
        }
        if (this.onWindowFocus) {
            if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('focus', this.onWindowFocus);
            this.onWindowFocus = null;
        }
        this.resetViewState();
        this.threads = [];
        this.total = null;
    },

    /**
     * Tenant switch: this thread list, the open thread and every rendered
     * message id belong to the previous tenant's token. Keeping any of it is
     * how tenant A's conversation ends up under tenant B's name.
     */
    resetTenantState() {
        this.resetViewState();
        this.threads = [];
        this.total = null;
    },

    // ─── Polling, with an idle backoff ───────────────────────────────────────
    /** 5s while things move; 15s, then 30s, after runs of ticks where nothing did. */
    pollDelay() {
        const step = Math.min(this.POLL_STEPS.length - 1, Math.floor(this._unchangedTicks / this.IDLE_TICKS_PER_STEP));
        return this.POLL_STEPS[step];
    },

    startPolling() {
        this.stopPolling();
        this._polling = true;
        this.schedulePoll();
    },

    schedulePoll() {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(async () => {
            this.pollTimer = null;
            if (!this._polling) return;
            if (!API.token) { this.stopPolling(); return; }
            await this.loadThreads(true);
            if (this._polling) this.schedulePoll();
        }, this.pollDelay());
    },

    stopPolling() {
        this._polling = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    },

    /** Back to the fast poll; a long wait already scheduled is replaced. */
    resetBackoff() {
        const slowed = this._unchangedTicks >= this.IDLE_TICKS_PER_STEP;
        this._unchangedTicks = 0;
        if (this._polling && slowed) this.schedulePoll();
    },

    /** Did this tick change anything the list shows? Counts the idle run the backoff reads. */
    noteListChange(rows) {
        const sig = [this.total, ...rows.map((r) => [r.id, r.last_message_at, r.is_bot_active, r.last_message_direction].join('|'))].join('\n');
        if (sig === this._listSignature) this._unchangedTicks++;
        else this._unchangedTicks = 0;
        this._listSignature = sig;
    },

    emptyChatState() {
        return html`
            <div class="chat-empty">
                <i data-lucide="message-square" aria-hidden="true"></i>
                <h3>${t('inbox.emptyTitle')}</h3>
                <p>${t('inbox.emptyBody')}</p>
            </div>
        `;
    },

    threadName(thread) {
        if (thread.username) return thread.username;
        const id = String(thread.instagram_user_id || '');
        return t('inbox.anonUser', { id: id.slice(-4) });
    },

    // ─── Dates ───────────────────────────────────────────────────────────────
    /** A local calendar day, for "is this today". */
    dayKey(value) {
        const d = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(d.getTime())) return '';
        return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    },

    /** 'today' | 'yesterday' | null, in the browser's local days. */
    relativeDay(value) {
        const key = this.dayKey(value);
        if (!key) return null;
        const now = new Date();
        if (key === this.dayKey(now)) return 'today';
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
        return key === this.dayKey(yesterday) ? 'yesterday' : null;
    },

    /**
     * A thread's time: "14:05" today, "Yesterday 14:05", else "Mar 4, 14:05".
     * It used to be HH:MM whatever the day, so a customer who wrote a week ago
     * looked like one who wrote an hour ago.
     */
    threadTime(value) {
        if (!value) return '';
        const rel = this.relativeDay(value);
        if (rel === 'today') return UI.formatTime(value);
        if (rel === 'yesterday') return `${t('inbox.yesterday')} ${UI.formatTime(value)}`;
        return UI.formatDate(value);
    },

    /** The label of a day divider in the log. */
    dayLabel(value) {
        const rel = this.relativeDay(value);
        if (rel === 'today') return t('common.today');
        if (rel === 'yesterday') return t('inbox.yesterday');
        return UI.formatDay(value);
    },

    // ─── Filter ──────────────────────────────────────────────────────────────
    filterFromHash() {
        const raw = typeof App !== 'undefined' && typeof App.hashParam === 'function' ? String(App.hashParam('filter') || '') : '';
        return this.FILTERS.includes(raw) ? raw : 'all';
    },

    /** The customer spoke last and nobody is going to answer unless a human does. */
    isWaiting(thread) {
        return !!thread && thread.is_bot_active === false && thread.last_message_direction === 'inbound';
    },

    matchesFilter(thread) {
        if (this.filter === 'waiting') return this.isWaiting(thread);
        if (this.filter === 'paused') return !!thread && thread.is_bot_active === false;
        return true;
    },

    syncFilterButtons() {
        this.FILTERS.forEach((key) => {
            const btn = document.getElementById(`inbox-filter-${key}`);
            if (btn) btn.setAttribute('aria-pressed', key === this.filter ? 'true' : 'false');
        });
    },

    setFilter(value) {
        const next = this.FILTERS.includes(value) ? value : 'all';
        if (next === this.filter) return;
        this.filter = next;
        this.syncFilterButtons();
        // The hash says what is on screen, so a reload or a copied link keeps
        // it — replaced, not pushed, and without a hashchange (which would
        // re-render the page and drop the open thread).
        try {
            if (typeof history !== 'undefined' && history.replaceState) {
                history.replaceState(null, '', next === 'all' ? '#/inbox' : `#/inbox?filter=${next}`);
            }
        } catch { /* a sandboxed frame: the filter still applies */ }
        this.renderThreads();
    },

    // ─── Threads ─────────────────────────────────────────────────────────────
    /**
     * The strip above the list: nothing, "refreshing…" on a return from a long
     * absence, or the stale marker. `api.js` already tags a dropped connection
     * with `isNetworkError`, so the honest thing is to say the list has stopped
     * updating rather than leave it looking live. One failure is a blip on a
     * mobile connection; two in a row is a state the operator has to know
     * about, because every decision on this screen assumes the list is current.
     * The stale strip carries its own Retry: waiting for the next tick is not a
     * thing the operator can do on purpose.
     */
    setStrip(state, err) {
        const host = document.getElementById('threads-stale');
        if (!host) return;
        const current = (host.dataset && host.dataset.state) || null;
        if (state === current) return; // already saying it
        if (!state) {
            host.classList.add('hidden');
            host.innerHTML = '';
            if (host.dataset) delete host.dataset.state;
            if (this._staleShown) Motion.announce(t('inbox.reconnected'));
            this._staleShown = false;
            return;
        }
        if (state === 'stale') this._staleShown = true;
        if (state === 'refreshing') {
            host.innerHTML = esc(html`
                <p class="inbox-count" role="status"><span class="spinner spinner-sm" aria-hidden="true"></span> ${t('inbox.refreshing')}</p>
            `);
        } else {
            const hint = err && err.isNetworkError ? t('error.network') : (err && err.message) || '';
            host.innerHTML = esc(html`
                <div class="inline-error" role="alert" id="threads-stale-strip">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    <div>
                        <strong>${t('inbox.stale')}</strong>
                        ${hint ? html`<span class="inline-error-hint" dir="auto">${hint}</span>` : ''}
                    </div>
                    ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'inbox:retryThreads', id: 'threads-retry' })}
                </div>
            `);
        }
        if (host.dataset) host.dataset.state = state;
        host.classList.remove('hidden');
        UI.icons(host);
    },

    markStale(show, err) {
        this.setStrip(show ? 'stale' : null, err);
    },

    retryThreads() {
        this.resetBackoff();
        return this.loadThreads(true, { loud: true, notice: true });
    },

    /** The AI toggle the operator has just flipped outranks a poll that may have left before the write committed. */
    applyPending(rows) {
        if (this.pendingBotState.size > 0) {
            rows.forEach((row) => {
                if (this.pendingBotState.has(row.id)) row.is_bot_active = this.pendingBotState.get(row.id);
            });
        }
        return rows;
    },

    /**
     * @param silent  a poll: a failure keeps the list the operator is reading
     * @param opts    `loud`: a failure shows the stale strip at once (tab return, Retry);
     *                `notice`: say "refreshing" while it is in flight
     */
    async loadThreads(silent = false, opts = {}) {
        const epoch = this._epoch;
        if (opts.notice) this.setStrip('refreshing');
        try {
            const result = await API.getConversations({ limit: this.LIMIT });
            if (epoch !== this._epoch) return; // a previous visit, or the previous tenant
            const rows = this.applyPending((result && Array.isArray(result.data)) ? result.data : []);
            const total = Number(result && result.pagination && result.pagination.total);
            this._pollFailures = 0;
            this.setStrip(null);
            this.threads = rows;
            this.total = Number.isFinite(total) ? total : rows.length;
            this.noteListChange(rows);
            this.renderThreads();
            this.reportWaiting();

            // Only refetch the open conversation when it actually changed.
            if (this.selectedConversationId) {
                const thread = this.findThread(this.selectedConversationId);
                if (thread) {
                    this.updateChatHeader(thread);
                    if (thread.last_message_at !== this.lastMessageStamp) {
                        this.lastMessageStamp = thread.last_message_at;
                        this.loadMessages(this.selectedConversationId);
                    }
                }
            }
        } catch (err) {
            if (epoch !== this._epoch) return;
            console.error('Threads Load Error:', err);
            this._pollFailures++;
            if (silent) {
                // A silent tick must not replace the list the operator is
                // reading — but after two failures it must stop implying the
                // list is live, and after a return it must say so at once.
                if (opts.loud || this._pollFailures >= 2) this.markStale(true, err);
                else if (opts.notice) this.setStrip(null);
                return;
            }
            const container = document.getElementById('threads-container');
            if (container) {
                // The error panel is not a row, so the list role would be a lie.
                container.removeAttribute('role');
                container.removeAttribute('aria-label');
                UI.renderError(
                    container,
                    { title: t('inbox.threadsErrorTitle'), message: err.message },
                    () => this.loadThreads()
                );
            }
        }
    },

    /** SH3: the count on the Inbox nav item and in the tab title, from every screen. */
    reportWaiting() {
        if (typeof App === 'undefined' || typeof App.setInboxWaiting !== 'function') return;
        App.setInboxWaiting(this.threads.filter((x) => this.isWaiting(x)).length);
    },

    /** A thread from the list or from the search's answer — the open one may be either. */
    findThread(id) {
        const own = this.threads.find((x) => x.id === id);
        if (own) return own;
        const rows = this.searchMatches ? this.searchMatches.rows : [];
        return rows.find((x) => x.id === id) || null;
    },

    /** Every copy of a thread this page holds: the list's and the search's. */
    threadCopies(id) {
        const rows = this.searchMatches ? this.searchMatches.rows : [];
        return [...this.threads, ...rows].filter((x) => x.id === id);
    },

    visibleThreads() {
        const term = this.searchTerm.trim().toLowerCase();
        let list = this.threads;
        if (term) {
            const local = this.threads.filter((x) => {
                const haystack = [
                    x.username,
                    x.instagram_user_id,
                    x.last_message_text,
                ].filter(Boolean).join(' ').toLowerCase();
                return haystack.includes(term);
            });
            const server = this.searchMatches && this.searchMatches.term === term ? this.searchMatches.rows : [];
            if (server.length) {
                // The loaded list is polled, so its copy of a thread is the fresher one.
                const byId = new Map();
                server.forEach((x) => byId.set(x.id, x));
                local.forEach((x) => byId.set(x.id, x));
                list = [...byId.values()].sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
            } else {
                list = local;
            }
        }
        return list.filter((x) => this.matchesFilter(x));
    },

    /**
     * A row's inner markup.
     *
     * The 📥/📤 prefix that used to open the preview line is gone. It restated
     * `last_message_direction`, which the operator only acts on in exactly the
     * case the "needs a reply" badge below already covers — when the AI is off
     * and the customer spoke last. While the AI is answering, who spoke last is
     * not a decision the operator makes, so the glyph was two characters of
     * chrome on every row of the busiest screen in the product.
     *
     * The blinking dot is gone from the "AI active" badge for the same kind of
     * reason: it animated a state that never changes while you look at it. The
     * one place a blink still earns its place is a post that is publishing
     * right now, where something really is in flight.
     */
    threadRow(x) {
        const isInbound = x.last_message_direction === 'inbound';
        return html`
            <span class="thread-top">
                <span class="thread-name"><bdi dir="auto">@${this.threadName(x)}</bdi></span>
                <span class="thread-time">${this.threadTime(x.last_message_at)}</span>
            </span>
            <span class="thread-preview" dir="auto">${x.last_message_text || t('inbox.noMessages')}</span>
            <span class="thread-badges">
                ${x.is_bot_active
                    ? html`<span class="badge badge-success">${t('inbox.aiActive')}</span>`
                    : html`<span class="badge badge-neutral">${t('inbox.aiPaused')}</span>`}
                ${!x.is_bot_active && isInbound
                    ? html`<span class="badge badge-danger"><i data-lucide="reply" aria-hidden="true"></i>${t('inbox.inbound')}</span>`
                    : ''}
            </span>
        `;
    },

    /**
     * I7: "3 need a reply" under the search, and I2: "Showing 100 of 240" when
     * the list is not all of them. Written only when the text changes, so an
     * idle poll touches nothing.
     */
    renderCount() {
        const host = document.getElementById('inbox-count');
        if (!host) return;
        const waiting = this.threads.filter((x) => this.isWaiting(x)).length;
        const shown = this.threads.length;
        const truncated = !this.searchTerm.trim() && Number(this.total) > shown;
        const markup = esc(html`<strong>${waiting === 0 ? t('inbox.needReply_zero') : t('inbox.needReply', { count: waiting })}</strong>${truncated ? html` · <span>${t('inbox.showing', { shown: UI.formatNumber(shown), total: UI.formatNumber(this.total) })}</span>` : ''}`);
        // Compared with what this page last wrote, not with innerHTML, which the
        // browser re-serialises and would never match.
        if (this._countMarkup === markup && host.innerHTML !== '') return;
        this._countMarkup = markup;
        host.innerHTML = markup;
    },

    /** Why the list is empty, and — when it is genuinely empty — when it fills and where to look. */
    emptyKind() {
        if (this.searchTerm.trim()) return 'search';
        if (this.threads.length > 0 && this.filter !== 'all') return this.filter;
        return 'none';
    },

    emptyMarkup(kind) {
        if (kind === 'search') return html`<div class="empty-threads" data-empty="search"><p>${t('inbox.noMatch')}</p></div>`;
        if (kind === 'waiting') return html`<div class="empty-threads" data-empty="waiting"><p>${t('inbox.noWaiting')}</p></div>`;
        if (kind === 'paused') return html`<div class="empty-threads" data-empty="paused"><p>${t('inbox.noPaused')}</p></div>`;
        return html`
            <div class="empty-threads" data-empty="none">
                <p>${t('inbox.noThreads')}</p>
                <p class="empty-hint">${t('inbox.emptyHint')}</p>
                ${UI.helpLink('troubleshooting#dms', t('inbox.emptyHelp'))}
            </div>
        `;
    },

    /**
     * Patch, never rebuild. This runs on every poll; on a tick where nothing
     * changed, every row's signature matches and not one DOM node is written —
     * so the scroller does not jump, the focused row keeps focus, and there is
     * nothing to flash.
     */
    renderThreads() {
        this.renderCount();
        const container = document.getElementById('threads-container');
        if (!container) return;

        const threads = this.visibleThreads();

        if (threads.length === 0) {
            const kind = this.emptyKind();
            const existing = container.querySelector('.empty-threads');
            if (existing && existing.dataset && existing.dataset.empty === kind) return;
            // A paragraph is not a listitem, so the role comes off with the rows.
            container.removeAttribute('role');
            container.removeAttribute('aria-label');
            container.innerHTML = esc(this.emptyMarkup(kind));
            UI.icons(container);
            return;
        }

        /**
         * List semantics.
         *
         * This was a plain <div> of <button>s, so there was no "list, 24
         * items" and no "3 of 24" as you moved down it — on the busiest screen
         * in the product, and the one the creator uses on a phone. The role
         * goes on the container and each row is a real listitem WRAPPING the
         * button: role="listitem" on the button itself would replace the
         * button role, and the row would stop being announced as pressable.
         */
        container.setAttribute('role', 'list');
        container.setAttribute('aria-label', t('inbox.threads'));

        Motion.patchList(container, threads, {
            key: (x) => x.id,
            // Everything the row displays, and nothing else. `\u001f` cannot
            // appear in a username or a DM, so no two states collide. The time
            // is the TEXT shown, so "14:05" becomes "Yesterday 14:05" at midnight.
            signature: (x) => [
                this.threadName(x),
                this.threadTime(x.last_message_at),
                x.last_message_text,
                x.is_bot_active ? '1' : '0',
                x.last_message_direction,
                x.id === this.selectedConversationId ? '1' : '0',
            ].join('\u001f'),
            create: () => {
                const item = document.createElement('div');
                item.setAttribute('role', 'listitem');
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'thread-item';
                item.appendChild(btn);
                return item;
            },
            update: (el, x) => {
                const btn = el.querySelector('.thread-item') || el.firstElementChild;
                if (!btn) return;
                const isActive = x.id === this.selectedConversationId;
                btn.className = `thread-item${isActive ? ' active' : ''}`;
                // Conventionally the attribute is REMOVED rather than set to
                // "false": aria-current="false" on the other 23 rows is 23
                // announcements of a state that is not the case.
                if (isActive) btn.setAttribute('aria-current', 'true');
                else btn.removeAttribute('aria-current');
                btn.dataset.action = 'inbox:selectThread';
                btn.dataset.id = x.id;
                btn.innerHTML = esc(this.threadRow(x));
            },
        });
    },

    /**
     * Search feedback stays immediate over what is loaded, at most one render
     * per frame: a fast typist firing eight `input` events inside one frame
     * used to get eight full list rebuilds, of which seven were thrown away
     * unpainted. Then, once typing pauses, the server is asked — it searches
     * every thread, not just the newest hundred.
     */
    handleSearch(value) {
        this.searchTerm = value || '';
        if (!this._searchRender) {
            this._searchRender = Motion.coalesce(() => this.renderThreads());
        }
        this._searchRender();
        if (!this._searchFetch) {
            this._searchFetch = Motion.debounce(() => this.searchServer(), this.SEARCH_DEBOUNCE_MS);
        }
        if (this.searchTerm.trim()) this._searchFetch();
        else {
            this._searchFetch.cancel();
            this.searchMatches = null;
        }
    },

    async searchServer() {
        const term = this.searchTerm.trim();
        if (!term) return;
        const seq = ++this._searchSeq;
        const epoch = this._epoch;
        try {
            const result = await API.getConversations({ limit: this.LIMIT, search: term });
            if (seq !== this._searchSeq || epoch !== this._epoch || term !== this.searchTerm.trim()) return;
            const rows = this.applyPending((result && Array.isArray(result.data)) ? result.data : []);
            this.searchMatches = { term: term.toLowerCase(), rows };
            this.renderThreads();
        } catch (err) {
            // The loaded threads that match are already on screen; the older
            // ones are what is missing, and the next keystroke asks again.
            console.error('Inbox Search Error:', err);
        }
    },

    // ─── Chat pane ───────────────────────────────────────────────────────────
    selectThread(id) {
        // Mobile: even re-selecting the open thread has to move to the chat pane.
        const layout = document.querySelector('.inbox-layout');
        if (layout) layout.dataset.pane = 'chat';

        // The row that was just activated. At 900px and below the sidebar
        // becomes display:none the instant data-pane flips, so this element is
        // now inside a hidden subtree and the browser has thrown focus away.
        const trigger = document.activeElement;

        this.resetBackoff();
        if (this.selectedConversationId === id) { this.focusChatPane(trigger); return; }
        this.selectedConversationId = id;
        this.renderedMessageIds = new Set();
        this.messagesPainted = false;
        this._lastDayKey = null;

        const thread = this.findThread(id);
        this.lastMessageStamp = thread ? thread.last_message_at : null;
        this.renderChatShell(thread);
        this.renderThreads(); // highlight the active row
        this.loadMessages(id, { scroll: true });
        this.focusChatPane(trigger);
    },

    /**
     * The mirror image of backToThreads(), which has always done this
     * correctly: after a pane swap, put focus somewhere real.
     *
     * On a wide screen both panes are visible and the row keeps focus, which
     * is right — moving it would be motion the operator did not ask for. The
     * check is on whether the trigger is still RENDERED rather than on a
     * hardcoded breakpoint, so it cannot drift from the stylesheet.
     */
    focusChatPane(trigger) {
        if (trigger && document.contains(trigger) && trigger.offsetParent !== null) return;
        const back = document.querySelector('.chat-pane .chat-back');
        if (back && back.offsetParent !== null && typeof back.focus === 'function') {
            back.focus();
            return;
        }
        const composer = document.getElementById('chat-input-text');
        // Not focused on a phone unless there is nothing better: focusing a
        // textarea raises the on-screen keyboard over the conversation the
        // operator just opened to read.
        if (composer && !back && typeof composer.focus === 'function') composer.focus();
    },

    backToThreads() {
        const layout = document.querySelector('.inbox-layout');
        if (layout) layout.dataset.pane = 'threads';
        // Send focus somewhere real, or it lands on <body> after the pane swap.
        const active = document.querySelector('.thread-item.active') || document.getElementById('inbox-search');
        if (active && typeof active.focus === 'function') active.focus();
    },

    /** "AI replies: on" beside the switch — the state in words, not only a knob position. */
    aiStateText(on) {
        return on ? t('inbox.aiOn') : t('inbox.aiOff');
    },

    /**
     * The line under the composer. The consequence of a manual reply used to
     * live only in the placeholder, which vanishes on the first keystroke —
     * exactly when it matters. Once the AI is paused here (a manual reply does
     * that), the line offers the way back: "Hand back to AI".
     */
    composerHintMarkup(thread) {
        const on = !!thread && thread.is_bot_active !== false;
        if (on) return html`<span>${t('inbox.composerHint')}</span>`;
        return html`
            <span>${t('inbox.composerHintOff')}</span>
            ${UI.button({
                variant: 'secondary', size: 'sm', icon: 'bot', label: t('inbox.handBack'),
                action: 'inbox:handBack', id: 'inbox-hand-back', data: { id: thread ? thread.id : '' },
            })}
        `;
    },

    /** Keeps the visible state and the hint in step with the switch; writes only on a change. */
    paintAiState(thread) {
        if (!thread || this.chatShellThreadId !== thread.id) return;
        const on = thread.is_bot_active !== false;
        const state = document.getElementById('ai-state');
        if (state) {
            const text = this.aiStateText(on);
            if (state.textContent !== text) state.textContent = text;
            state.classList.toggle('is-on', on);
        }
        const hint = document.getElementById('composer-hint');
        if (hint && hint.dataset && hint.dataset.state !== (on ? 'on' : 'off')) {
            hint.innerHTML = esc(this.composerHintMarkup(thread));
            hint.dataset.state = on ? 'on' : 'off';
            UI.icons(hint);
        }
    },

    /**
     * The chat shell — header, message list container and composer — is built
     * ONCE per selected thread. loadMessages() only touches the message list,
     * so the textarea (and whatever the creator has typed into it, and its
     * focus and caret) is never destroyed by a poll.
     */
    renderChatShell(thread) {
        const chatPane = document.getElementById('chat-pane-container');
        if (!chatPane || !thread) return;

        const username = this.threadName(thread);
        const on = thread.is_bot_active !== false;

        chatPane.innerHTML = esc(html`
            <header class="chat-header">
                <button type="button" class="icon-button chat-back" data-action="inbox:backToThreads"
                        aria-label="${t('inbox.backToThreads')}">
                    <i data-lucide="arrow-left" aria-hidden="true"></i>
                </button>
                <div class="chat-header-info">
                    <!-- aria-level, not <h2>: the stylesheet scopes this rule to
                         the element (.chat-header h3), so changing the tag would
                         change the type size. This fixes the outline, not the
                         pixels. -->
                    <h3 aria-level="2" data-chat-username><bdi dir="auto">@${username}</bdi></h3>
                    <span class="chat-sub">${t('inbox.userId', { id: '' })}${UI.ltr(thread.instagram_user_id)}</span>
                </div>
                <div class="chat-header-actions">
                    <!-- The switch already announces its state; this is the same
                         fact for the eye, so it is hidden from the reader. -->
                    <span class="ai-state${on ? html.raw(' is-on') : ''}" id="ai-state" aria-hidden="true">${this.aiStateText(on)}</span>
                    <label class="switch" for="bot-toggle-input">
                        <span class="sr-only">${t('inbox.aiToggleLabel')}</span>
                        <input type="checkbox" id="bot-toggle-input"
                               ${on ? html.raw('checked') : ''}
                               data-change="inbox:toggleBot" data-id="${thread.id}">
                        <span class="switch-track"></span>
                    </label>
                    <span class="switch-label" aria-hidden="true">
                        <i data-lucide="bot" aria-hidden="true"></i>
                    </span>
                </div>
            </header>

            <!-- The loader is a live region of its own (role="status") and it
                 used to be injected INSIDE the log, so opening a thread
                 announced "Loading messages…" from inside the thing that was
                 about to announce the whole thread. It lives outside now. -->
            <div id="chat-messages-loading">${html.raw(UI.loader(t('inbox.loadingMessages')))}</div>

            <!-- aria-live starts OFF.
                 role="log" carries an implicit polite live region, and
                 renderMessages() clears the list and appends every bubble — so
                 opening a conversation read the ENTIRE history aloud before the
                 operator could reach the composer. The initial paint happens
                 with the region suppressed and renderMessages() turns it on
                 afterwards, so only genuinely new messages announce.
                 aria-relevant drops the default "text", which would otherwise
                 re-announce a bubble whose text changed in place. -->
            <div class="chat-messages" id="chat-messages-container" role="log" aria-live="off"
                 aria-relevant="additions" aria-label="${t('inbox.messages')}"></div>

            <div class="chat-composer">
                <form id="chat-send-form" data-submit="inbox:sendMessage" data-id="${thread.id}">
                    <label class="sr-only" for="chat-input-text">${t('inbox.replyLabel')}</label>
                    <textarea id="chat-input-text" dir="auto" placeholder="${t('inbox.replyPlaceholder')}"
                              aria-describedby="composer-hint"></textarea>
                    ${UI.button({
                        variant: 'primary', type: 'submit', icon: 'send',
                        ariaLabel: t('inbox.sendLabel'),
                    })}
                </form>
                <p class="composer-hint" id="composer-hint" data-state="${on ? 'on' : 'off'}">${this.composerHintMarkup(thread)}</p>
            </div>
        `);

        this.chatShellThreadId = thread.id;
        UI.icons(chatPane);
    },

    /**
     * Poll-safe header refresh: text nodes only, never a re-render.
     *
     * It writes into the <bdi>, not the <h3>. Replacing the h3's textContent
     * destroyed the isolation element, and a bare "@sara_dev" in an RTL
     * heading renders as "sara_dev@" — the @ jumps to the other end on the
     * first poll, five seconds after the thread opens.
     */
    updateChatHeader(thread) {
        if (this.chatShellThreadId !== thread.id) return;
        const nameEl = document.querySelector('[data-chat-username] bdi');
        if (nameEl) nameEl.textContent = `@${this.threadName(thread)}`;
        const toggle = document.getElementById('bot-toggle-input');
        if (toggle && document.activeElement !== toggle) toggle.checked = !!thread.is_bot_active;
        this.paintAiState(thread);
    },

    /** The loader / error host that sits OUTSIDE the log region. */
    clearChatLoading() {
        const host = document.getElementById('chat-messages-loading');
        if (host && host.innerHTML !== '') host.innerHTML = '';
    },

    async loadMessages(id, { scroll = false } = {}) {
        try {
            const messages = await API.getConversationMessages(id);
            if (this.selectedConversationId !== id) return; // user moved on mid-flight
            this.renderMessages(Array.isArray(messages) ? messages : [], scroll);
        } catch (err) {
            console.error('Messages Load Error:', err);
            const host = document.getElementById('chat-messages-loading');
            if (host && !this.messagesPainted) {
                // Into the host, not into the log: an error panel is not a
                // message, and the log is append-only.
                UI.renderError(
                    host,
                    { title: t('inbox.messagesErrorTitle'), message: err.message },
                    () => this.loadMessages(id, { scroll: true })
                );
            }
        }
    },

    /** A day divider: "Today", "Yesterday", or the date. */
    dayDivider(value) {
        return html`<div class="chat-day"><span>${this.dayLabel(value)}</span></div>`;
    },

    /**
     * Append-only: existing bubbles are left alone, so scroll position holds.
     * A divider goes in wherever the local day changes, so a thread that ran
     * over three days reads as three days rather than one column of HH:MM.
     */
    renderMessages(messages, forceScroll) {
        const list = document.getElementById('chat-messages-container');
        if (!list) return;

        // Tracked explicitly rather than inferred from renderedMessageIds,
        // whose size can now be non-zero before the first server payload lands
        // (an optimistic outbound bubble holds a key of its own).
        const firstPaint = !this.messagesPainted;
        if (firstPaint) {
            list.innerHTML = '';
            this.messagesPainted = true;
            this._lastDayKey = null;
            this.clearChatLoading();
        }

        const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
        let appended = 0;

        messages.forEach((msg) => {
            const key = msg.id != null ? String(msg.id) : `${msg.created_at}|${msg.direction}|${msg.text}`;
            if (this.renderedMessageIds.has(key)) return;
            this.renderedMessageIds.add(key);
            const day = this.dayKey(msg.created_at);
            if (day && day !== this._lastDayKey) {
                list.insertAdjacentHTML('beforeend', esc(this.dayDivider(msg.created_at)));
                this._lastDayKey = day;
            }
            list.insertAdjacentHTML('beforeend', esc(this.messageBubble(msg)));
            appended++;
        });

        if (appended > 0) {
            UI.icons(list);
            if (forceScroll || firstPaint || nearBottom) list.scrollTop = list.scrollHeight;
        }

        // The history that was already on screen when the thread opened is not
        // news, so it is painted with the region off and the region is armed
        // AFTERWARDS — from here on, an append is a message that has just
        // arrived, which is exactly what a log should announce.
        this.armMessageLog();
    },

    /**
     * Turn the log's live region on, one frame after the initial paint.
     *
     * The delay matters: a live region that is armed in the same task as the
     * nodes it contains can still have those nodes treated as additions,
     * because the AT diffs the subtree at the end of the task rather than per
     * mutation.
     */
    armMessageLog() {
        const list = document.getElementById('chat-messages-container');
        if (!list || list.getAttribute('aria-live') === 'polite') return;
        requestAnimationFrame(() => {
            const el = document.getElementById('chat-messages-container');
            if (el) el.setAttribute('aria-live', 'polite');
        });
    },

    messageBubble(msg) {
        const isOut = msg.direction === 'outbound';
        return html`
            <div class="message-row ${isOut ? 'row-outbound' : 'row-inbound'}">
                <div class="message-bubble ${isOut ? 'bubble-outbound' : 'bubble-inbound'}">
                    <!-- lang on the OUTBOUND side only. What this account sends
                         is always Arabic — it is the AI's reply or the
                         operator's own — so with the English UI a screen reader
                         was reading it with an English voice. What arrives is
                         genuinely unknown, so an inbound bubble gets dir="auto"
                         and no lang claim. -->
                    <p dir="auto" ${isOut ? html.raw('lang="ar"') : ''}>${msg.text}</p>
                    ${this.structuredContent(msg)}
                    <span class="message-time">${UI.formatTime(msg.created_at)}</span>
                </div>
            </div>
        `;
    },

    /** Quick replies and carousels out of raw_payload — all attacker-reachable. */
    structuredContent(msg) {
        if (!msg.raw_payload || typeof msg.raw_payload !== 'string') return '';

        let payload;
        try { payload = JSON.parse(msg.raw_payload); } catch { return ''; }
        if (!payload || typeof payload !== 'object') return '';

        const parts = [];

        if (Array.isArray(payload.quick_replies)) {
            parts.push(html`
                <div class="msg-quick-replies">
                    <!-- Quick-reply titles are authored by this account (the AI
                         writes them from the Arabic prompt), so they carry lang. -->
                    ${payload.quick_replies.map((qr) => html`<span class="qr-pill" dir="auto" lang="ar">${qr && qr.title}</span>`)}
                </div>
            `);
        }

        const elements = payload.attachment
            && payload.attachment.payload
            && payload.attachment.payload.elements;

        if (Array.isArray(elements)) {
            parts.push(html`
                <div class="msg-carousel">
                    ${elements.map((el) => {
                        const image = safeUrl(el && el.image_url);
                        const buttons = Array.isArray(el && el.buttons) ? el.buttons : [];
                        return html`
                            <div class="carousel-card">
                                ${image ? html`<img src="${image}" class="carousel-card-img" alt="${(el && el.title) || ''}">` : ''}
                                <div class="carousel-card-body">
                                    <h4 class="carousel-card-title" dir="auto" lang="ar">${el && el.title}</h4>
                                    ${el && el.subtitle ? html`<p class="carousel-card-desc" dir="auto" lang="ar">${el.subtitle}</p>` : ''}
                                    <div class="stack gap-1">
                                        ${buttons.map((btn) => html`<span class="carousel-btn" dir="auto" lang="ar">${btn && btn.title}</span>`)}
                                    </div>
                                </div>
                            </div>
                        `;
                    })}
                </div>
            `);
        }

        return parts;
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    /**
     * The operator has already moved the switch; the thread's badge follows in
     * the same frame and the request goes out behind it. The chosen value is
     * parked in `pendingBotState` until the server answers, so an in-flight
     * poll cannot flip the badge back for a tick.
     *
     * The success toast is gone: it announced a state the switch and the badge
     * were both already showing.
     */
    toggleBot(id, checked) {
        const copies = this.threadCopies(id);
        const thread = copies[0] || null;
        const previous = thread ? thread.is_bot_active !== false : !checked;

        const paint = (value) => {
            copies.forEach((copy) => { copy.is_bot_active = value; });
            const toggle = document.getElementById('bot-toggle-input');
            if (toggle && toggle.checked !== value) toggle.checked = value;
            this.renderThreads();
            if (thread) this.paintAiState(thread);
            this.reportWaiting();
        };

        this.resetBackoff();
        this.pendingBotState.set(id, checked);
        paint(checked);

        return Motion.optimistic({
            send: () => API.toggleConversationBot(id, checked),
            revert: () => paint(previous),
            onError: (err) => {
                console.error('Toggle Bot Error:', err);
                UI.toast((err && err.message) || t('inbox.botFailed'), 'error');
            },
        }).then((result) => {
            this.pendingBotState.delete(id);
            return result;
        });
    },

    /**
     * I6: the "done" the inbox never had. A manual reply pauses the AI and the
     * row said "AI paused" forever; this hands the conversation back in one
     * press, from where the operator just typed. The button goes with the
     * state it offered to change, so focus moves to the composer.
     */
    async handBack(id) {
        if (!id) return;
        const result = await this.toggleBot(id, true);
        if (result === null) return; // reverted, and the error toast said why
        Motion.announce(t('inbox.handedBack'));
        const input = document.getElementById('chat-input-text');
        if (input && typeof input.focus === 'function') input.focus();
    },

    /** A bubble for a reply that has left the composer but not yet the server. */
    pendingBubble(key, text) {
        return html`
            <div class="message-row row-outbound" data-pending="${key}">
                <div class="message-bubble bubble-outbound is-pending">
                    <p dir="auto" lang="ar">${text}</p>
                    <span class="message-time">${t('inbox.sending')}</span>
                </div>
            </div>
        `;
    },

    /**
     * Send a manual reply.
     *
     * The composer used to disable its own textarea and sit there until the
     * server answered — on a cold serverless function, a second or more of a
     * dead field with the operator's text still in it. Now the draft leaves the
     * box immediately and appears as a dimmed bubble at the bottom of the
     * thread, which is what every messaging client the operator uses does.
     *
     * The textarea is deliberately NOT disabled: disabling the field the user
     * is typing in is the single most common way a composer feels slow, and it
     * takes focus with it.
     *
     * On failure the placeholder is REMOVED rather than left behind as a failed
     * marker, and the draft goes back in the box — so the screen never shows a
     * message that was not sent. The original contract that nothing typed is
     * ever lost is kept, except that a draft the operator has already started
     * replacing is not overwritten.
     */
    async sendMessage(form, event) {
        event.preventDefault();
        const id = form.dataset.id;
        const input = document.getElementById('chat-input-text');
        const text = input ? input.value.trim() : '';
        if (!text) return;

        // The only double-submit guard in the dashboard (see components.js).
        // It only touches the submit button — the textarea stays enabled per
        // the note above — and no label is passed because this button is
        // icon-only (aria-label, no visible text), matching the login
        // button's own icon-only spinner call in app.js.
        const restore = UI.formBusy(form);
        if (!restore) return; // already in flight

        const list = document.getElementById('chat-messages-container');
        const key = `pending:${++this._pendingSeq}`;

        input.value = '';
        this.resetBackoff();

        if (list) {
            // The bubble used to be appended only `if (this.messagesPainted)`,
            // so a reply typed while the history was still loading vanished
            // from the composer and appeared nowhere — the operator's text
            // existed only in this closure. If the list has not been painted
            // yet, paint it now (which drops the loader) and put the reply in
            // it; the server's canonical copy replaces the placeholder later,
            // exactly as on the painted path.
            if (!this.messagesPainted) {
                list.innerHTML = '';
                this.messagesPainted = true;
                this._lastDayKey = null;
                this.clearChatLoading();
                this.armMessageLog();
            }
            this.renderedMessageIds.add(key);
            list.insertAdjacentHTML('beforeend', esc(this.pendingBubble(key, text)));
            list.scrollTop = list.scrollHeight;
        }

        const placeholder = () => (list ? list.querySelector(`[data-pending="${CSS.escape(key)}"]`) : null);
        const dropPlaceholder = () => {
            const el = placeholder();
            if (el) el.remove();
            this.renderedMessageIds.delete(key);
        };

        try {
            await API.sendConversationMessage(id, text);
            // Drop the placeholder first, then let the canonical row land in
            // its place — otherwise the same reply appears twice.
            dropPlaceholder();
            // Not "sent": the operator cannot see that a manual reply also
            // pauses the AI for this thread, and that is the part they act on.
            UI.toast(t('inbox.sent'));
            // The server paused the AI; say so here now rather than a poll
            // later, so "Hand back to AI" is under the composer at once.
            this.threadCopies(id).forEach((copy) => { copy.is_bot_active = false; });
            const thread = this.findThread(id);
            if (thread) this.paintAiState(thread);
            const toggle = document.getElementById('bot-toggle-input');
            if (toggle && document.activeElement !== toggle) toggle.checked = false;
            this.lastMessageStamp = null; // force the next poll to pick it up
            await this.loadMessages(id, { scroll: true });
            await this.loadThreads(true);
        } catch (err) {
            console.error('Send Message Error:', err);
            dropPlaceholder();
            if (input && !input.value) input.value = text;
            UI.toast(err.message || t('inbox.sendFailed'), 'error');
        } finally {
            restore();
            // `finally` runs after loadMessages() AND loadThreads(), which on a
            // cold start is seconds after the click — long enough for the
            // operator to have moved to the AI switch or back to the thread
            // list. Focus is therefore only reclaimed when the busy button
            // dropped it (disabling the focused element sends focus to
            // <body>), not unconditionally.
            const lost = !document.activeElement || document.activeElement === document.body;
            if (lost && input && typeof input.focus === 'function') input.focus();
        }
    },
};

UI.registerActions('inbox', {
    selectThread: (el) => InboxPage.selectThread(el.dataset.id),
    backToThreads: () => InboxPage.backToThreads(),
    toggleBot: (el) => InboxPage.toggleBot(el.dataset.id, el.checked),
    sendMessage: (el, e) => InboxPage.sendMessage(el, e),
    handleSearch: (el) => InboxPage.handleSearch(el.value),
    setFilter: (el) => InboxPage.setFilter(el && el.dataset ? el.dataset.filter : 'all'),
    retryThreads: () => InboxPage.retryThreads(),
    handBack: (el) => InboxPage.handBack(el && el.dataset ? el.dataset.id : ''),
});
