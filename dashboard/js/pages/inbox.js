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
 * ─── The detail view ("I want to see everything in here in detail") ─────────
 * What the server stores about a thread, drawn rather than left in the database:
 *   - the header: the sender's picture or initials, their name and @handle, the platform, what they
 *     are to you (follows you / you follow them / verified / followers) and how long and how much they
 *     have written (`metaMarkup`). Each chip is shown only when it is known.
 *   - a carousel or quick reply as its cards and pills, from `raw_payload`, which is JSONB and so
 *     arrives as an OBJECT (`parsePayload`; the first version insisted on a string and drew nothing).
 *     "[Structured Template]" is a placeholder and is never shown as words, in the log or the list.
 *   - under a customer's bubble: the tap that produced it, what they attached, and a failing reply.
 *     Under an AI reply: how long it took, which model, and "retried" (`pairReplies`).
 *   - the sender's profile arrives lazily: the server looks it up when a DM comes in, and the inbox asks
 *     for it when a thread is opened (and for the newest few when the page opens), through a throttle
 *     that lives on the server. A failed lookup, or a picture link that has expired, leaves the initials.
 * Everything drawn from a message or a payload is attacker-reachable: only the `html` tag, `safeUrl`
 * and `linkUrl` ever put it in the page.
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

    // ─── What the stored rows say, so a placeholder is never mistaken for words ──
    /** The text the pipeline stores for a carousel (which has none) and for a story mention. */
    STRUCTURED_PLACEHOLDER: '[Structured Template]',
    STORY_MENTION_PLACEHOLDER: '[Story Mention]',
    /**
     * How close an AI reply's row and its inbound's `handled_at` are when the pipeline wrote one right after the other
     * (it marks the inbound handled the moment the reply is stored). The pairing for "replied in 4 s".
     */
    HANDLED_MATCH_MS: 5000,
    /**
     * Most of each a message shows. Meta's own limits are 10 cards, 3 buttons and 13 quick replies; the numbers are
     * here because this renders JSON an attacker can reach, and a payload with ten thousand cards is not a message.
     */
    MAX_CARDS: 10,
    MAX_BUTTONS: 3,
    MAX_QUICK_REPLIES: 13,
    MAX_ATTACHMENTS: 6,
    /** The server throttles a sender's lookup to one a day (`PROFILE_REFRESH_SECONDS`) and one an hour while none has worked. */
    PROFILE_STALE_MS: 24 * 60 * 60 * 1000,
    PROFILE_RETRY_MS: 60 * 60 * 1000,
    /** How many of the newest threads get their profile looked up when the inbox opens; the rest fill in when opened. */
    PROFILE_BACKFILL_PER_VISIT: 5,

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

    /** Threads whose profile this visit has already asked the server about: once each, whatever the answer. */
    _profileAsked: new Set(),
    /** The visit's batch of lookups for the newest threads has run. */
    _backfilled: false,
    /** Picture links that failed to load (Meta's expire after a few days), so a repaint does not put the broken one back. */
    _brokenPics: new Set(),
    /** What the header's avatar and detail strip last wrote, so an idle poll writes nothing. */
    _avatarMarkup: null,
    _metaMarkup: null,
    /** The chat pane the capturing `error` listener is on, and that listener (`bindImageGuard`). */
    onImageError: null,
    _imageGuardHost: null,

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
        this.bindImageGuard();

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
        this._profileAsked = new Set();
        this._backfilled = false;
        this._avatarMarkup = null;
        this._metaMarkup = null;
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
        this.unbindImageGuard();
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

    /** `@sara_dev`, or '' when the sender's handle is not known. The "@" belongs to a handle and to nothing else. */
    threadHandle(thread) {
        const username = thread && typeof thread.username === 'string' ? thread.username.trim() : '';
        return username ? `@${username}` : '';
    },

    /**
     * The sender, as a person: the name on their profile, else their @handle, else "User 3051" (the last four of
     * the id). The last used to be printed as "@User 3051": the "@" was part of the row's template, so a sender
     * nobody had looked up read like a handle that does not exist.
     */
    threadTitle(thread) {
        const name = thread && typeof thread.profile_name === 'string' ? thread.profile_name.trim() : '';
        if (name) return name;
        const handle = this.threadHandle(thread);
        if (handle) return handle;
        const id = String((thread && thread.instagram_user_id) || '');
        return t('inbox.anonUser', { id: id.slice(-4) });
    },

    /** Up to two letters for the avatar: first letters of the first two words, or the first two of one. '' when nothing is a letter. */
    initialsOf(thread) {
        const source = String((thread && (thread.profile_name || thread.username)) || '').trim().replace(/^@/, '');
        const words = source.split(/[\s._-]+/u).map((w) => w.replace(/^[^\p{L}\p{N}]+/u, '')).filter(Boolean);
        if (words.length === 0) return '';
        const letters = (word) => Array.from(word);
        const pair = words.length > 1 ? letters(words[0])[0] + letters(words[1])[0] : letters(words[0]).slice(0, 2).join('');
        return pair.toLocaleUpperCase();
    },

    /**
     * What a thread row says its last message was.
     *
     * Not `last_message_text` as it stands: a carousel is stored as the placeholder "[Structured Template]", which the
     * operator saw in the list as if the customer had been sent those words. A carousel reads as its cards ("2 cards:
     * Pricing"); a placeholder with no cards behind it (the stored body is pruned after a while) reads as what kind of
     * message it was; a story mention reads as one.
     */
    threadPreview(thread) {
        if (!thread) return t('inbox.noMessages');
        const cards = Number(thread.last_message_cards);
        if (Number.isFinite(cards) && cards > 0) {
            const label = t('inbox.preview.cards', { count: cards });
            const title = typeof thread.last_message_card_title === 'string' ? thread.last_message_card_title.trim() : '';
            return title ? t('inbox.preview.withTitle', { label, title }) : label;
        }
        const text = typeof thread.last_message_text === 'string' ? thread.last_message_text : '';
        if (text === this.STRUCTURED_PLACEHOLDER) {
            return thread.last_message_type === 'carousel' ? t('inbox.preview.carousel') : t('inbox.preview.structured');
        }
        if (text === this.STORY_MENTION_PLACEHOLDER || (thread.last_message_type === 'story_mention' && !text)) return t('inbox.storyMention');
        return text || t('inbox.noMessages');
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
            // Not awaited, and never throws: the names of the newest threads fill in behind the list, one at a time.
            this.backfillProfiles(rows);

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
                    x.profile_name,
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
        // I8: which network the thread is on, as the same IG / FB tag the
        // activity log uses. A thread from before v26 has no platform and
        // shows none, rather than a guess.
        return html`
            <span class="thread-top">
                <span class="thread-who">
                    <span class="thread-name"><bdi dir="auto">${this.threadTitle(x)}</bdi></span>${UI.platformTag(x.platform)}
                </span>
                <span class="thread-time">${this.threadTime(x.last_message_at)}</span>
            </span>
            <span class="thread-preview" dir="auto">${this.threadPreview(x)}</span>
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
                this.threadTitle(x),
                x.platform || '',
                this.threadTime(x.last_message_at),
                this.threadPreview(x),
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
        // A thread written before profiles were stored (or last looked up more than a day ago) is looked up now: its name and
        // picture arrive a moment after it opens, and Meta's expiring picture link is replaced while it still works.
        if (thread) this.maybeRefreshProfile(thread);
    },

    // ─── The sender's profile ────────────────────────────────────────────────
    /**
     * Should this thread's profile be looked up? Instagram only (the one network with a profile API wired); never looked up, or
     * last looked up over a day ago; and not tried so recently that the server would refuse (an hour while none has worked, a
     * day otherwise): it throttles for itself, but a request that is certain to be refused is not worth the round trip.
     */
    needsProfile(thread) {
        if (!thread || thread.platform !== 'instagram') return false;
        const now = Date.now();
        const fetched = Date.parse(thread.profile_fetched_at || '');
        if (Number.isFinite(fetched) && now - fetched <= this.PROFILE_STALE_MS) return false;
        const checked = Date.parse(thread.profile_checked_at || '');
        const wait = Number.isFinite(fetched) ? this.PROFILE_STALE_MS : this.PROFILE_RETRY_MS;
        return !(Number.isFinite(checked) && now - checked < wait);
    },

    /** The first `limit` of `threads` that need a profile and have not been asked about this visit. Pure. */
    profileCandidates(threads, limit) {
        return (Array.isArray(threads) ? threads : [])
            .filter((x) => x && !this._profileAsked.has(x.id) && this.needsProfile(x))
            .slice(0, limit);
    },

    maybeRefreshProfile(thread) {
        return this.needsProfile(thread) ? this.refreshProfile(thread.id) : Promise.resolve();
    },

    /**
     * The newest few threads, once per visit. The rest are looked up when the operator opens them. Bounded on purpose: each one is a
     * call to Meta, and a hundred of them in one go on opening the inbox is the kind of burst that gets an app throttled.
     */
    async backfillProfiles(rows) {
        if (this._backfilled) return;
        this._backfilled = true;
        const epoch = this._epoch;
        for (const row of this.profileCandidates(rows, this.PROFILE_BACKFILL_PER_VISIT)) {
            if (epoch !== this._epoch) return;
            await this.refreshProfile(row.id);
        }
    },

    /**
     * Ask the server to look one sender up. Best effort, and says nothing on failure: the thread keeps its initials and its "User
     * 3051", exactly as it was. A viewer cannot ask (the server would refuse: it sends things to Meta), so does not.
     */
    async refreshProfile(id) {
        if (!id || this._profileAsked.has(id)) return;
        if (typeof App !== 'undefined' && typeof App.canOperate === 'function' && !App.canOperate()) return;
        this._profileAsked.add(id);
        const epoch = this._epoch;
        try {
            const result = await API.refreshConversationProfile(id);
            if (epoch !== this._epoch || !result || !result.profile) return;
            this.applyProfile(id, result.profile);
        } catch (err) {
            console.debug('Profile refresh skipped:', err && err.message);
        }
    },

    /** The fields a refresh answers with, copied onto every copy of the thread this page holds, then repainted. */
    applyProfile(id, profile) {
        const keys = [
            'username', 'profile_name', 'profile_pic_url', 'follower_count', 'is_user_follow_business',
            'is_business_follow_user', 'is_verified_user', 'profile_fetched_at', 'profile_checked_at',
        ];
        this.threadCopies(id).forEach((copy) => {
            keys.forEach((key) => { if (key in profile) copy[key] = profile[key]; });
        });
        this.renderThreads();
        const thread = this.findThread(id);
        if (thread) this.updateChatHeader(thread);
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

        const title = this.threadTitle(thread);
        const on = thread.is_bot_active !== false;
        // Written once here and remembered, so the poll's repaint compares against what is on screen.
        const avatar = this.avatarMarkup(thread);
        const meta = this.metaMarkup(thread);
        this._avatarMarkup = esc(avatar);
        this._metaMarkup = esc(meta);

        chatPane.innerHTML = esc(html`
            <header class="chat-header">
                <button type="button" class="icon-button chat-back" data-action="inbox:backToThreads"
                        aria-label="${t('inbox.backToThreads')}">
                    <i data-lucide="arrow-left" aria-hidden="true"></i>
                </button>
                <!-- The sender's picture, or their initials: both are painted, the picture over the initials, so a link that
                     has expired (Meta's do, after a few days) or is slow simply leaves the initials showing. -->
                <span class="avatar" id="chat-avatar" aria-hidden="true">${avatar}</span>
                <div class="chat-header-info">
                    <!-- aria-level, not <h2>: the stylesheet scopes this rule to
                         the element (.chat-header h3), so changing the tag would
                         change the type size. This fixes the outline, not the
                         pixels. -->
                    <h3 aria-level="2" data-chat-username><bdi dir="auto">${title}</bdi></h3>
                    <!-- I8: the platform, then the @handle (when the profile has been looked up), then the id.
                         «المعرّف» / "ID", not "User ID": on Facebook it is a Page-scoped id, not an Instagram user's. -->
                    <span class="chat-sub"><span data-chat-platform data-platform="${thread.platform || ''}">${UI.platformTag(thread.platform)}</span>${this.handleSlot(thread)}${t('inbox.userId', { id: '' })}${UI.ltr(thread.instagram_user_id)}</span>
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

            <!-- Who they are and how long they have been talking to you: follows you / you follow them, followers, first
                 message, message count. Only what is known is shown; the strip is empty (and hidden) until something is. -->
            <div class="chat-meta" id="chat-meta">${meta}</div>

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

    /** The @handle for the header's sub-line: only when the title is the person's NAME, since otherwise the title already is the handle. */
    handleText(thread) {
        const named = thread && typeof thread.profile_name === 'string' && thread.profile_name.trim() !== '';
        return named ? this.threadHandle(thread) : '';
    },

    /**
     * The handle, in an LTR island inside a wrapper that keeps the line's own direction: the separator after it is drawn by the wrapper
     * (`.chat-handle:has(…)::after`), so it falls between the handle and the id in both directions. Drawn inside the island it fell
     * on the wrong side of the handle in Arabic.
     */
    handleSlot(thread) {
        return html`<span class="chat-handle"><bdi class="ltr-text" dir="ltr" data-chat-handle>${this.handleText(thread)}</bdi></span>`;
    },

    /**
     * The avatar's contents. Initials (or a person glyph when the sender has no name to take them from) are always painted; the
     * picture sits on top of them. Meta's picture links expire after a few days, so a failed load is expected, not exceptional:
     * `handleImageError` removes the broken <img> and remembers the link, and what is left is the initials.
     */
    avatarMarkup(thread) {
        const pic = safeUrl(thread && thread.profile_pic_url);
        const initials = this.initialsOf(thread);
        const face = initials
            ? html`<span class="avatar-initials"><bdi dir="auto">${initials}</bdi></span>`
            : html`<i data-lucide="user" aria-hidden="true"></i>`;
        const picture = pic && !this._brokenPics.has(pic)
            ? html`<img class="avatar-img" src="${pic}" alt="" width="40" height="40" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
            : '';
        return html`${face}${picture}`;
    },

    /** One chip of the detail strip. */
    metaChip(label, { icon = '', accent = false } = {}) {
        return html`<span class="chip${accent ? html.raw(' chip-accent') : ''}">${icon ? html`<i data-lucide="${icon}" aria-hidden="true"></i>` : ''}${label}</span>`;
    },

    /**
     * What is known about the sender and the thread, as chips: whether they follow you, whether you follow them, their verification,
     * their follower count, when they first wrote and how many messages there are. Each is shown only when it is known, so a
     * Messenger thread, or an Instagram one whose profile has not been looked up yet, shows the two it has (the dates and the count).
     */
    metaMarkup(thread) {
        if (!thread) return '';
        const chips = [];
        if (thread.is_user_follow_business === true) chips.push(this.metaChip(t('inbox.meta.followsYou'), { icon: 'user-check', accent: true }));
        else if (thread.is_user_follow_business === false) chips.push(this.metaChip(t('inbox.meta.notFollowsYou')));
        if (thread.is_business_follow_user === true) chips.push(this.metaChip(t('inbox.meta.youFollow'), { icon: 'users', accent: true }));
        else if (thread.is_business_follow_user === false) chips.push(this.metaChip(t('inbox.meta.youDontFollow')));
        if (thread.is_verified_user === true) chips.push(this.metaChip(t('inbox.meta.verified'), { accent: true }));
        const followers = Number(thread.follower_count);
        if (thread.follower_count !== null && thread.follower_count !== undefined && Number.isFinite(followers)) {
            chips.push(this.metaChip(t('inbox.meta.followers', { count: followers, n: UI.formatNumber(followers) })));
        }
        if (thread.created_at) chips.push(this.metaChip(t('inbox.meta.since', { date: UI.formatDay(thread.created_at) })));
        const messages = Number(thread.message_count);
        if (thread.message_count !== null && thread.message_count !== undefined && Number.isFinite(messages)) {
            chips.push(this.metaChip(t('inbox.meta.messages', { count: messages, n: UI.formatNumber(messages) })));
        }
        return chips.length ? html`${chips}` : '';
    },

    /** Poll-safe, like everything in the header: written only when the markup differs from what is on screen. */
    paintAvatar(thread) {
        const el = document.getElementById('chat-avatar');
        if (!el) return;
        const markup = esc(this.avatarMarkup(thread));
        if (markup === this._avatarMarkup) return;
        this._avatarMarkup = markup;
        el.innerHTML = markup;
        UI.icons(el);
    },

    paintMeta(thread) {
        const el = document.getElementById('chat-meta');
        if (!el) return;
        const markup = esc(this.metaMarkup(thread));
        if (markup === this._metaMarkup) return;
        this._metaMarkup = markup;
        el.innerHTML = markup;
        UI.icons(el);
    },

    /**
     * A picture that would not load, in the header or in a message. Error events do not bubble, so this is one capturing listener
     * on the chat pane rather than an `onerror` on each image (which would be an inline handler, and this dashboard has none).
     * The element is removed: an avatar falls back to the initials under it, an attachment to the chip beside it.
     */
    handleImageError(event) {
        const img = event && event.target;
        if (!img || !img.classList || typeof img.remove !== 'function') return;
        if (img.classList.contains('avatar-img')) {
            const src = typeof img.getAttribute === 'function' ? img.getAttribute('src') : '';
            if (src) this._brokenPics.add(src);
            this._avatarMarkup = null;
            img.remove();
        } else if (img.classList.contains('msg-attachment-img') || img.classList.contains('carousel-card-img')) {
            img.remove();
        }
    },

    bindImageGuard() {
        this.unbindImageGuard();
        const pane = document.getElementById('chat-pane-container');
        if (!pane || typeof pane.addEventListener !== 'function') return;
        this.onImageError = (event) => this.handleImageError(event);
        pane.addEventListener('error', this.onImageError, true);
        this._imageGuardHost = pane;
    },

    unbindImageGuard() {
        if (this.onImageError && this._imageGuardHost && typeof this._imageGuardHost.removeEventListener === 'function') {
            this._imageGuardHost.removeEventListener('error', this.onImageError, true);
        }
        this.onImageError = null;
        this._imageGuardHost = null;
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
        if (nameEl) nameEl.textContent = this.threadTitle(thread);
        // The @handle that arrives once the sender's profile has been looked up.
        const handleEl = document.querySelector('[data-chat-handle]');
        if (handleEl && handleEl.textContent !== this.handleText(thread)) handleEl.textContent = this.handleText(thread);
        this.paintAvatar(thread);
        this.paintMeta(thread);
        // A thread from before v26 gets its platform on its next DM; written
        // only when it changes, so an idle poll touches nothing.
        const platformEl = document.querySelector('[data-chat-platform]');
        const platform = thread.platform || '';
        if (platformEl && platformEl.dataset && platformEl.dataset.platform !== platform) {
            platformEl.innerHTML = esc(UI.platformTag(thread.platform));
            platformEl.dataset.platform = platform;
        }
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
        // Which inbound each AI reply answered, from the whole batch: the reply's detail line needs the message BEFORE it.
        const replies = this.pairReplies(messages);

        messages.forEach((msg) => {
            const key = msg.id != null ? String(msg.id) : `${msg.created_at}|${msg.direction}|${msg.text}`;
            if (this.renderedMessageIds.has(key)) return;
            this.renderedMessageIds.add(key);
            const day = this.dayKey(msg.created_at);
            if (day && day !== this._lastDayKey) {
                list.insertAdjacentHTML('beforeend', esc(this.dayDivider(msg.created_at)));
                this._lastDayKey = day;
            }
            list.insertAdjacentHTML('beforeend', esc(this.messageBubble(msg, msg.id != null ? replies.get(String(msg.id)) : undefined)));
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

    /**
     * I4: who wrote an outbound message — the AI or the operator — as a small
     * tint above the bubble (DESIGN §3: a tint with its -text label, never a
     * solid fill). Outside the bubble on purpose: the outbound bubble is the
     * brand gradient, and a tint laid on it would fall below AA. A row written
     * before v26 carries no sender and gets no tag rather than a guess.
     */
    senderTag(msg) {
        if (!msg || msg.direction !== 'outbound') return '';
        if (msg.sender === 'ai') return html`<span class="sender-tag sender-tag--ai">${t('inbox.senderAi')}</span>`;
        if (msg.sender === 'operator') return html`<span class="sender-tag sender-tag--operator">${t('inbox.senderOperator')}</span>`;
        return '';
    },

    /**
     * One bubble, and under it what is known about the message beyond its words.
     *
     * `reply` is `pairReplies`' answer for an AI reply: how long it took and how many attempts the message it answered needed. It is
     * optional, and a bubble without it is exactly what it was before the detail view: the bubble tests call it with one argument.
     */
    messageBubble(msg, reply) {
        const isOut = msg.direction === 'outbound';
        const tag = this.senderTag(msg);
        const detail = isOut ? this.outboundDetail(msg, reply) : this.inboundDetail(msg);
        const text = typeof msg.text === 'string' ? msg.text : '';
        const structure = this.structuredContent(msg);
        const attachments = isOut ? '' : this.attachmentsMarkup(msg);

        // A placeholder is not words. "[Structured Template]" is what a carousel is stored as; its cards are the message, and
        // when they cannot be drawn (the stored body is pruned after a while) the bubble says what it was instead.
        let shown = text;
        let note = '';
        if (text === this.STRUCTURED_PLACEHOLDER) {
            shown = '';
            if (!structure) note = t(msg.message_type === 'carousel' ? 'inbox.carouselGone' : 'inbox.structuredGone');
        } else if (text === this.STORY_MENTION_PLACEHOLDER) {
            shown = t('inbox.storyMention');
        }

        return html`
            <div class="message-row ${isOut ? 'row-outbound' : 'row-inbound'}${tag ? html.raw(' message-row--tagged') : (detail ? html.raw(' message-row--stacked') : '')}">
                ${tag}
                <div class="message-bubble ${isOut ? 'bubble-outbound' : 'bubble-inbound'}">
                    <!-- lang on the OUTBOUND side only. What this account sends
                         is always Arabic — it is the AI's reply or the
                         operator's own — so with the English UI a screen reader
                         was reading it with an English voice. What arrives is
                         genuinely unknown, so an inbound bubble gets dir="auto"
                         and no lang claim. -->
                    ${shown ? html`<p dir="auto" ${isOut ? html.raw('lang="ar"') : ''}>${shown}</p>` : ''}
                    ${note ? html`<p class="msg-note" dir="auto">${note}</p>` : ''}
                    ${structure}
                    ${attachments}
                    <span class="message-time">${UI.formatTime(msg.created_at)}</span>
                </div>
                ${detail}
            </div>
        `;
    },

    // ─── The payload a message carries ───────────────────────────────────────
    /**
     * `messages.raw_payload` as an object, whatever shape it arrives in. The column is JSONB, so the API hands back an object; this
     * used to insist on a string and so drew nothing for every carousel and quick reply the AI had ever sent. A string is still
     * parsed (a row written before the column was JSONB, a double-encoded one, a fixture). Null for anything that is not a JSON
     * object: pruned (`RAW_PAYLOAD_RETENTION_DAYS`), absent, an array, or unreadable.
     */
    parsePayload(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        let value = raw;
        if (typeof raw === 'string') {
            try { value = JSON.parse(raw); } catch { return null; }
        }
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    },

    /** A string or a number as text; anything else (an object, null, a list) as nothing, so it cannot print "[object Object]". */
    plainText(value) {
        if (typeof value === 'string') return value.trim();
        return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    },

    /** An http(s) link, for something the reader may open. `safeUrl` also lets a site-relative path and an image data: URI through: right for an <img>, wrong for a link out. */
    linkUrl(value) {
        const url = safeUrl(value);
        return /^https?:\/\//i.test(url) ? url : '';
    },

    /** A URL as the short text of a link: no scheme, no query, no fragment, at most 48 characters. */
    urlLabel(url) {
        const bare = String(url).replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/$/, '');
        return bare.length > 48 ? `${bare.slice(0, 47)}…` : bare;
    },

    /**
     * Quick replies and carousels out of raw_payload — all attacker-reachable.
     *
     * Returns one piece of markup, or '' when there is nothing to draw (no payload, or a plain text reply whose payload is `{ "text": … }`).
     * Every value is text through `html`, every URL through `safeUrl`; the counts are capped.
     */
    structuredContent(msg) {
        const payload = this.parsePayload(msg && msg.raw_payload);
        if (!payload) return '';

        const parts = [];

        if (Array.isArray(payload.quick_replies)) {
            const titles = payload.quick_replies
                .slice(0, this.MAX_QUICK_REPLIES)
                .map((qr) => this.plainText(qr && qr.title))
                .filter(Boolean);
            if (titles.length) {
                parts.push(html`
                    <div class="msg-quick-replies">
                        <!-- Quick-reply titles are authored by this account (the AI
                             writes them from the Arabic prompt), so they carry lang. -->
                        ${titles.map((title) => html`<span class="qr-pill" dir="auto" lang="ar">${title}</span>`)}
                    </div>
                `);
            }
        }

        const elements = payload.attachment
            && payload.attachment.payload
            && payload.attachment.payload.elements;

        if (Array.isArray(elements) && elements.length > 0) {
            parts.push(html`
                <div class="msg-carousel">
                    ${elements.slice(0, this.MAX_CARDS).map((el) => this.carouselCard(el))}
                </div>
            `);
        }

        return parts.length ? html`${parts}` : '';
    },

    /** One card of a carousel: its picture, title, subtitle, and each button's title with where it goes. */
    carouselCard(el) {
        const card = el && typeof el === 'object' ? el : {};
        const title = this.plainText(card.title);
        const subtitle = this.plainText(card.subtitle);
        const image = safeUrl(card.image_url);
        const buttons = (Array.isArray(card.buttons) ? card.buttons : []).slice(0, this.MAX_BUTTONS);
        return html`
            <div class="carousel-card">
                ${image ? html`<img src="${image}" class="carousel-card-img" alt="${title}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
                <div class="carousel-card-body">
                    <h4 class="carousel-card-title" dir="auto" lang="ar">${title}</h4>
                    ${subtitle ? html`<p class="carousel-card-desc" dir="auto" lang="ar">${subtitle}</p>` : ''}
                    <div class="stack gap-1">
                        ${buttons.map((btn) => this.carouselButton(btn))}
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * A button as the customer saw it (a picture of it, see `.carousel-btn`) and, under it, what it does: a link out as a small real
     * link, or a postback as the payload it sends back. Both are the AI's own output, and both are escaped.
     */
    carouselButton(btn) {
        const b = btn && typeof btn === 'object' ? btn : {};
        const title = this.plainText(b.title);
        const url = this.linkUrl(b.url);
        const payload = url ? '' : this.plainText(b.payload);
        return html`
            <div class="carousel-btn-wrap">
                <span class="carousel-btn" dir="auto" lang="ar">${title}</span>
                ${url ? html`<a class="carousel-btn-url" href="${url}" target="_blank" rel="noopener noreferrer" dir="ltr">${this.urlLabel(url)}<span class="sr-only"> ${t('help.link.newTab')}</span></a>` : ''}
                ${payload ? html`<span class="carousel-btn-payload" dir="ltr">${payload}</span>` : ''}
            </div>
        `;
    },

    // ─── What came in: taps and attachments ──────────────────────────────────
    /**
     * Did this message come from a tap? `{ via, payload }` or null. The payload column is what was tapped (`OTHER_PLANS`); the stored
     * event says which kind of tap it was (`message.quick_reply` or `postback`), and when that body has been pruned the payload still
     * says that something was tapped, just not what kind.
     */
    tappedOf(msg) {
        const payload = typeof msg.payload === 'string' ? msg.payload.trim() : '';
        if (!payload) return null;
        const raw = this.parsePayload(msg.raw_payload);
        let via = 'generic';
        if (raw && raw.postback) via = 'button';
        else if (raw && raw.message && raw.message.quick_reply) via = 'quickReply';
        return { via, payload: payload.slice(0, 120) };
    },

    /**
     * Everything the stored event says the customer attached, as `{ kind, url }`: the attachments Meta listed, a reply to one of your
     * stories, and a story mention (also when the stored body is pruned and only the message's type remains).
     */
    attachmentsOf(msg) {
        const out = [];
        const raw = this.parsePayload(msg && msg.raw_payload);
        const message = raw && raw.message && typeof raw.message === 'object' ? raw.message : null;
        if (message && Array.isArray(message.attachments)) {
            message.attachments.forEach((att) => {
                if (!att || typeof att !== 'object') return;
                const type = this.plainText(att.type).toLowerCase();
                out.push({ kind: this.attachmentKind(type), url: this.plainText(att.payload && att.payload.url) });
            });
        }
        const story = message && message.reply_to && message.reply_to.story;
        if (story && typeof story === 'object') out.push({ kind: 'storyReply', url: this.plainText(story.url) });
        if (msg && msg.message_type === 'story_mention' && !out.some((a) => a.kind === 'storyMention')) {
            out.push({ kind: 'storyMention', url: '' });
        }
        return out.slice(0, this.MAX_ATTACHMENTS);
    },

    /** Meta's attachment `type` as one of the kinds this screen words; anything it does not know is a plain "Attachment". */
    attachmentKind(type) {
        const KINDS = Object.assign(Object.create(null), {
            image: 'image', video: 'video', audio: 'audio', file: 'file',
            share: 'share', ig_post: 'share', ig_reel: 'reel', reel: 'reel', story_mention: 'storyMention',
        });
        return KINDS[type] || 'other';
    },

    /** Its glyph and its name, by kind. A lookup table, so a kind from the data can only ever name an icon this file lists. */
    attachmentStyle(kind) {
        const STYLES = Object.assign(Object.create(null), {
            image: { icon: 'image', label: 'inbox.attach.image' },
            video: { icon: 'play', label: 'inbox.attach.video' },
            audio: { icon: 'music', label: 'inbox.attach.audio' },
            file: { icon: 'file', label: 'inbox.attach.file' },
            share: { icon: 'share-2', label: 'inbox.attach.share' },
            reel: { icon: 'film', label: 'inbox.attach.reel' },
            storyMention: { icon: 'history', label: 'inbox.attach.storyMention' },
            storyReply: { icon: 'history', label: 'inbox.attach.storyReply' },
            other: { icon: 'file', label: 'inbox.attach.other' },
        });
        return STYLES[kind] || STYLES.other;
    },

    /**
     * What the customer attached, inside their bubble: a picture for an image, and for every kind a chip that names it, with an
     * "Open" link when Meta gave a URL. Never blank: a voice note, a reel or a story reply is at least a chip, and an image that
     * will not load (the picture is removed by `handleImageError`) leaves its chip.
     */
    attachmentsMarkup(msg) {
        const list = this.attachmentsOf(msg);
        if (list.length === 0) return '';
        return html`
            <div class="msg-attachments">
                ${list.map((att) => {
                    const style = this.attachmentStyle(att.kind);
                    const label = t(style.label);
                    const url = this.linkUrl(att.url);
                    return html`
                        <div class="msg-attachment">
                            ${att.kind === 'image' && url ? html`<img class="msg-attachment-img" src="${url}" alt="${label}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
                            <span class="badge badge-neutral"><i data-lucide="${style.icon}" aria-hidden="true"></i>${label}</span>
                            ${url ? html`<a class="msg-attachment-link" href="${url}" target="_blank" rel="noopener noreferrer">${t('inbox.attach.open')}<span class="sr-only"> ${t('help.link.newTab')}</span></a>` : ''}
                        </div>
                    `;
                })}
            </div>
        `;
    },

    // ─── Under the bubble ────────────────────────────────────────────────────
    /** The tap the message came from, and the state of the reply to it when that reply is failing: chips, or '' when there is neither. */
    inboundDetail(msg) {
        const chips = [];
        const tap = this.tappedOf(msg);
        if (tap) {
            const key = tap.via === 'button' ? 'inbox.detail.tappedButton' : tap.via === 'quickReply' ? 'inbox.detail.tappedQuickReply' : 'inbox.detail.tapped';
            chips.push(html`<span class="badge badge-info"><i data-lucide="reply" aria-hidden="true"></i>${t(key)} <bdi class="ltr-text" dir="ltr">${tap.payload}</bdi></span>`);
        }
        const failing = this.deliveryChip(msg);
        if (failing) chips.push(failing);
        return chips.length ? html`<div class="msg-detail">${chips}</div>` : '';
    },

    /**
     * A reply that did not go: from the queue's record of the message's job (the server's `delivery`). Red once it is out of
     * attempts, amber while it will be tried again. A refusal Meta makes for good (a blocked recipient) is settled by the
     * pipeline without a trace in the queue, so it cannot appear here: this shows what is stored and nothing else.
     */
    deliveryChip(msg) {
        const d = msg && msg.delivery;
        if (!d || (d.state !== 'failed' && d.state !== 'retrying')) return '';
        const code = Number.isFinite(d.code) ? html` · <bdi class="ltr-text" dir="ltr">${t('inbox.detail.code', { code: d.code })}</bdi>` : '';
        if (d.state === 'failed') {
            return html`<span class="badge badge-danger"><i data-lucide="alert-circle" aria-hidden="true"></i>${t('inbox.detail.failed')}${code}</span>`;
        }
        const attempt = Number.isFinite(d.attempts) && Number.isFinite(d.max_attempts) && d.max_attempts > 0
            ? t('inbox.detail.retryingAttempt', { n: d.attempts, max: d.max_attempts })
            : t('inbox.detail.retrying');
        return html`<span class="badge badge-warning"><i data-lucide="rotate-cw" aria-hidden="true"></i>${attempt}${code}</span>`;
    },

    /** "4 s", "2 min", "1.5 h": the reply's wait in the unit a person would say it in. */
    durationText(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '';
        if (ms < 1000) return t('inbox.detail.underSecond');
        const seconds = Math.round(ms / 1000);
        if (seconds < 120) return t('inbox.detail.seconds', { n: UI.formatNumber(seconds) });
        const minutes = Math.round(seconds / 60);
        if (minutes < 120) return t('inbox.detail.minutes', { n: UI.formatNumber(minutes) });
        return t('inbox.detail.hours', { n: UI.formatNumber(Math.round(ms / 360000) / 10) });
    },

    /**
     * For each AI reply in a batch of messages: how long it took, and how many attempts the message it answered needed.
     * `Map<reply id, { ms, attempts }>`; a reply whose inbound is not in the batch (the history is the newest 100) has no entry.
     * Pure, and the arithmetic the reply's detail line is made of.
     *
     * Which inbound a reply answered: the pipeline marks the inbound handled the moment it stores the reply, so the inbound whose
     * `handled_at` lies within `HANDLED_MATCH_MS` of the reply is the one (the nearest such, if two). Failing that (an old row, a
     * clock that disagrees), the newest inbound before it that no earlier reply has taken. A reply takes one inbound and an inbound
     * is taken once, so two messages sent together and answered one after the other get a time each and not the same one twice.
     *
     * `ms` is the reply's row minus the inbound's row: it includes any wait for a retry, which is why `attempts` is beside it.
     */
    pairReplies(messages) {
        const result = new Map();
        const taken = new Set();
        const inbound = [];
        (Array.isArray(messages) ? messages : []).forEach((msg) => {
            if (!msg) return;
            if (msg.direction === 'inbound') { inbound.push(msg); return; }
            if (msg.direction !== 'outbound' || msg.sender !== 'ai' || msg.id === null || msg.id === undefined) return;
            const repliedAt = Date.parse(msg.created_at);
            if (!Number.isFinite(repliedAt)) return;

            let match = null;
            let nearest = Infinity;
            inbound.forEach((candidate) => {
                if (taken.has(candidate)) return;
                const handledAt = Date.parse(candidate.handled_at);
                if (!Number.isFinite(handledAt)) return;
                const gap = Math.abs(handledAt - repliedAt);
                if (gap <= this.HANDLED_MATCH_MS && gap < nearest) { nearest = gap; match = candidate; }
            });
            if (!match) {
                for (let i = inbound.length - 1; i >= 0; i--) {
                    if (!taken.has(inbound[i])) { match = inbound[i]; break; }
                }
            }
            if (!match) return;
            taken.add(match);

            const askedAt = Date.parse(match.created_at);
            if (!Number.isFinite(askedAt)) return;
            result.set(String(msg.id), { ms: Math.max(0, repliedAt - askedAt), attempts: Number(match.reply_attempts) || 0 });
        });
        return result;
    },

    /**
     * The line under an AI reply: how long it took, which model wrote it, and "retried" when the message it answered needed more
     * than one attempt. Only the AI's replies carry it: the operator's own reply is not a measurement of the AI, and a row from before
     * v26 cannot say which of the two wrote it.
     *
     * The model is `ai_usage`'s when a usage row matched the reply (the providers engine writes one) and otherwise the model the
     * agent is set to now, which for a reply from before a change of model is a statement about today. The screen says "model" and no more.
     */
    outboundDetail(msg, reply) {
        if (!msg || msg.direction !== 'outbound' || msg.sender !== 'ai') return '';
        const items = [];
        if (reply && Number.isFinite(reply.ms)) {
            items.push(html`<span class="msg-detail-item"><i data-lucide="clock" aria-hidden="true"></i>${t('inbox.detail.repliedIn', { time: this.durationText(reply.ms) })}</span>`);
        }
        const model = msg.ai && typeof msg.ai.model === 'string' ? msg.ai.model.trim() : '';
        if (model) {
            items.push(html`<span class="msg-detail-item"><i data-lucide="bot" aria-hidden="true"></i><bdi class="ltr-text" dir="ltr">${model}</bdi></span>`);
        }
        if (reply && reply.attempts > 1) {
            items.push(html`<span class="badge badge-warning"><i data-lucide="rotate-cw" aria-hidden="true"></i>${t('inbox.detail.retried', { count: reply.attempts, n: UI.formatNumber(reply.attempts) })}</span>`);
        }
        return items.length ? html`<div class="msg-detail">${items}</div>` : '';
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
        // The operator's own reply, so it carries «أنت» from the start and the
        // canonical row (sender = 'operator') lands looking the same.
        return html`
            <div class="message-row row-outbound message-row--tagged" data-pending="${key}">
                ${this.senderTag({ direction: 'outbound', sender: 'operator' })}
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
