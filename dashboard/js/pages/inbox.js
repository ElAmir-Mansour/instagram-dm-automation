/**
 * DM Inbox — conversations, messages, manual replies, per-thread AI toggle.
 *
 * ─── Polling contract (do not regress) ──────────────────────────────────────
 *   - one request per tick (the thread list), not three
 *   - messages are only re-fetched when that thread's last_message_at changed
 *   - polling stops while the tab is hidden, and on destroy() (navigate/logout)
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
 * ─── Mobile ─────────────────────────────────────────────────────────────────
 * This is the screen the creator opens on a phone, and the one that used to be
 * least usable there. The layout is a single grid cell below 900px with the
 * two panes stacked on top of each other and `data-pane` deciding which is
 * shown, so "list → thread → back" is a real navigation, not a 39px-wide chat
 * column. The back button is part of the chat header, is 44px, and its chevron
 * flips with the document direction.
 */
const InboxPage = {
    POLL_MS: 5000,

    selectedConversationId: null,
    pollInterval: null,
    threads: [],
    searchTerm: '',
    renderedMessageIds: new Set(),
    lastMessageStamp: null,
    chatShellThreadId: null,
    onVisibilityChange: null,

    /** True once the message list has been painted for the open thread. */
    messagesPainted: false,

    /** id → the AI state the operator chose, until the server confirms it. */
    pendingBotState: new Map(),

    _pendingSeq: 0,
    _searchRender: null,

    /** Consecutive silent poll failures. Two is enough to stop pretending. */
    _pollFailures: 0,

    /**
     * The shell. `App.navigate` paints this inside the view transition, so the
     * two panes and the thread rows' shapes are on screen before any request
     * has come back; `render()` then finds the layout already there and leaves
     * it alone rather than painting the same markup a second time.
     */
    layout() {
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

        this.selectedConversationId = null;
        this.chatShellThreadId = null;
        this.renderedMessageIds = new Set();
        this.messagesPainted = false;
        this.pendingBotState = new Map();
        this.lastMessageStamp = null;
        this._pollFailures = 0;
        this.markStale(false);

        this.loadThreads();
        this.startPolling();

        // Pause polling while the tab is in the background — an inbox left open
        // in a spare tab was the single biggest source of serverless invocations.
        this.onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                this.stopPolling();
            } else {
                this.loadThreads(true);
                this.startPolling();
            }
        };
        document.addEventListener('visibilitychange', this.onVisibilityChange);
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
        this.selectedConversationId = null;
        this.chatShellThreadId = null;
        this.renderedMessageIds = new Set();
        this.messagesPainted = false;
        this.pendingBotState = new Map();
        this.lastMessageStamp = null;
        this.threads = [];
        this._pollFailures = 0;
    },

    /**
     * Tenant switch: this thread list, the open thread and every rendered
     * message id belong to the previous tenant's token. Keeping any of it is
     * how tenant A's conversation ends up under tenant B's name.
     */
    resetTenantState() {
        this.selectedConversationId = null;
        this.chatShellThreadId = null;
        this.renderedMessageIds = new Set();
        this.messagesPainted = false;
        this.pendingBotState = new Map();
        this.lastMessageStamp = null;
        this.threads = [];
        this.searchTerm = '';
        this._pollFailures = 0;
    },

    startPolling() {
        this.stopPolling();
        this.pollInterval = setInterval(() => {
            if (!API.token) { this.stopPolling(); return; }
            this.loadThreads(true);
        }, this.POLL_MS);
    },

    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
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

    // ─── Threads ─────────────────────────────────────────────────────────────
    /**
     * The stale marker. `api.js` already tags a dropped connection with
     * `isNetworkError`, so the honest thing is to say the list has stopped
     * updating rather than leave it looking live. One failure is a blip on a
     * mobile connection; two in a row is a state the operator has to know
     * about, because every decision on this screen assumes the list is current.
     */
    markStale(show, err) {
        const host = document.getElementById('threads-stale');
        if (!host) return;
        if (!show) {
            if (!host.classList.contains('hidden')) {
                host.classList.add('hidden');
                host.innerHTML = '';
            }
            return;
        }
        if (!host.classList.contains('hidden')) return; // already saying it
        host.innerHTML = esc(UI.errorStrip(
            t('inbox.stale'),
            err && err.isNetworkError ? t('error.network') : (err && err.message) || ''
        ));
        host.classList.remove('hidden');
        UI.icons(host);
    },

    async loadThreads(silent = false) {
        try {
            const result = await API.getConversations();
            const rows = (result && result.data) || [];
            this._pollFailures = 0;
            this.markStale(false);
            // An AI toggle the operator has just flipped outranks a poll that
            // may have left before the write committed. Without this the badge
            // flips back for one tick and then forward again.
            if (this.pendingBotState.size > 0) {
                rows.forEach((row) => {
                    if (this.pendingBotState.has(row.id)) {
                        row.is_bot_active = this.pendingBotState.get(row.id);
                    }
                });
            }
            this.threads = rows;
            this.renderThreads();

            // Only refetch the open conversation when it actually changed.
            if (this.selectedConversationId) {
                const thread = this.threads.find((x) => x.id === this.selectedConversationId);
                if (thread) {
                    this.updateChatHeader(thread);
                    if (thread.last_message_at !== this.lastMessageStamp) {
                        this.lastMessageStamp = thread.last_message_at;
                        this.loadMessages(this.selectedConversationId);
                    }
                }
            }
        } catch (err) {
            console.error('Threads Load Error:', err);
            this._pollFailures++;
            if (silent) {
                // A silent tick must not replace the list the operator is
                // reading — but after two failures it must stop implying the
                // list is live.
                if (this._pollFailures >= 2) this.markStale(true, err);
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

    visibleThreads() {
        const term = this.searchTerm.trim().toLowerCase();
        if (!term) return this.threads;
        return this.threads.filter((x) => {
            const haystack = [
                x.username,
                x.instagram_user_id,
                x.last_message_text,
            ].filter(Boolean).join(' ').toLowerCase();
            return haystack.includes(term);
        });
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
                <span class="thread-time">${UI.formatTime(x.last_message_at)}</span>
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
     * Patch, never rebuild. This runs every five seconds; on a tick where
     * nothing changed, every row's signature matches and not one DOM node is
     * written — so the scroller does not jump, the focused row keeps focus, and
     * there is nothing to flash.
     */
    renderThreads() {
        const container = document.getElementById('threads-container');
        if (!container) return;

        const threads = this.visibleThreads();

        if (threads.length === 0) {
            const message = this.searchTerm ? t('inbox.noMatch') : t('inbox.noThreads');
            const existing = container.querySelector('.empty-threads');
            if (existing) {
                if (existing.textContent !== message) existing.textContent = message;
                return;
            }
            // A paragraph is not a listitem, so the role comes off with the rows.
            container.removeAttribute('role');
            container.removeAttribute('aria-label');
            container.innerHTML = esc(html`<p class="empty-threads">${message}</p>`);
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
            // appear in a username or a DM, so no two states collide.
            signature: (x) => [
                this.threadName(x),
                x.last_message_at,
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
     * Search feedback stays immediate, but at most one render per frame: a fast
     * typist firing eight `input` events inside one frame used to get eight
     * full list rebuilds, of which seven were thrown away unpainted.
     */
    handleSearch(value) {
        this.searchTerm = value || '';
        if (!this._searchRender) {
            this._searchRender = Motion.coalesce(() => this.renderThreads());
        }
        this._searchRender();
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

        if (this.selectedConversationId === id) { this.focusChatPane(trigger); return; }
        this.selectedConversationId = id;
        this.renderedMessageIds = new Set();
        this.messagesPainted = false;

        const thread = this.threads.find((x) => x.id === id);
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
                    <label class="switch" for="bot-toggle-input">
                        <span class="sr-only">${t('inbox.aiToggleLabel')}</span>
                        <input type="checkbox" id="bot-toggle-input"
                               ${thread.is_bot_active ? html.raw('checked') : ''}
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
                    <textarea id="chat-input-text" dir="auto" placeholder="${t('inbox.replyPlaceholder')}"></textarea>
                    <button type="submit" class="btn btn-primary" aria-label="${t('inbox.sendLabel')}">
                        <i data-lucide="send" aria-hidden="true"></i>
                    </button>
                </form>
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

    /** Append-only: existing bubbles are left alone, so scroll position holds. */
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
            this.clearChatLoading();
        }

        const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
        let appended = 0;

        messages.forEach((msg) => {
            const key = msg.id != null ? String(msg.id) : `${msg.created_at}|${msg.direction}|${msg.text}`;
            if (this.renderedMessageIds.has(key)) return;
            this.renderedMessageIds.add(key);
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
        const thread = this.threads.find((x) => x.id === id);
        const previous = thread ? thread.is_bot_active !== false : !checked;

        const paint = (value) => {
            if (thread) thread.is_bot_active = value;
            const toggle = document.getElementById('bot-toggle-input');
            if (toggle && toggle.checked !== value) toggle.checked = value;
            this.renderThreads();
        };

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
            if (input) input.focus();
        }
    },
};

UI.registerActions('inbox', {
    selectThread: (el) => InboxPage.selectThread(el.dataset.id),
    backToThreads: () => InboxPage.backToThreads(),
    toggleBot: (el) => InboxPage.toggleBot(el.dataset.id, el.checked),
    sendMessage: (el, e) => InboxPage.sendMessage(el, e),
    handleSearch: (el) => InboxPage.handleSearch(el.value),
});
