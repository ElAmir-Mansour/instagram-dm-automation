/**
 * Live DM Inbox — conversations, messages, manual replies, per-thread AI toggle.
 *
 * Polling contract:
 *   - one request per tick (the thread list), not three
 *   - messages are only re-fetched when that thread's last_message_at changed
 *   - polling stops while the tab is hidden, and on destroy() (navigate/logout)
 *   - the composer is built ONCE per selected thread and never re-rendered, so
 *     an unsent draft survives every poll
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

    render() {
        const container = document.getElementById('page-container');
        container.innerHTML = esc(html`
            <div class="inbox-layout" data-pane="threads">
                <!-- Threads list -->
                <div class="inbox-sidebar glass-card">
                    <div class="sidebar-search">
                        <i data-lucide="search" class="search-icon" aria-hidden="true"></i>
                        <label class="sr-only" for="inbox-search">Search conversations</label>
                        <input type="search" id="inbox-search" placeholder="Search conversations..."
                               autocomplete="off" data-input="inbox:handleSearch">
                    </div>
                    <div class="threads-list" id="threads-container">
                        ${html.raw(UI.loader('Loading conversations…'))}
                    </div>
                </div>

                <!-- Chat Pane -->
                <div class="chat-pane glass-card" id="chat-pane-container">
                    ${this.emptyChatState()}
                </div>
            </div>
        `);

        UI.icons(container);

        this.selectedConversationId = null;
        this.chatShellThreadId = null;
        this.renderedMessageIds = new Set();
        this.lastMessageStamp = null;

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
        this.lastMessageStamp = null;
        this.threads = [];
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
            <div class="empty-chat-state">
                <i data-lucide="message-square" class="empty-icon" aria-hidden="true"></i>
                <h3>Select a Conversation</h3>
                <p>Choose a contact from the sidebar to view history or send messages.</p>
            </div>
        `;
    },

    threadName(thread) {
        if (thread.username) return thread.username;
        const id = String(thread.instagram_user_id || '');
        return `User ${id.slice(-4)}`;
    },

    // ─── Threads ─────────────────────────────────────────────────────────────
    async loadThreads(silent = false) {
        try {
            const result = await API.getConversations();
            this.threads = (result && result.data) || [];
            this.renderThreads();

            // Only refetch the open conversation when it actually changed.
            if (this.selectedConversationId) {
                const thread = this.threads.find((t) => t.id === this.selectedConversationId);
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
            if (silent) return;
            const container = document.getElementById('threads-container');
            if (container) {
                UI.renderError(
                    container,
                    { title: 'Could not load conversations', message: err.message },
                    () => this.loadThreads()
                );
            }
        }
    },

    visibleThreads() {
        const term = this.searchTerm.trim().toLowerCase();
        if (!term) return this.threads;
        return this.threads.filter((t) => {
            const haystack = [
                t.username,
                t.instagram_user_id,
                t.last_message_text,
            ].filter(Boolean).join(' ').toLowerCase();
            return haystack.includes(term);
        });
    },

    renderThreads() {
        const container = document.getElementById('threads-container');
        if (!container) return;

        const threads = this.visibleThreads();

        if (threads.length === 0) {
            container.innerHTML = esc(html`
                <div class="empty-threads">
                    <p>${this.searchTerm ? 'No conversations match that search.' : 'No conversations found yet.'}</p>
                </div>
            `);
            return;
        }

        container.innerHTML = esc(html`
            ${threads.map((t) => {
                const isActive = t.id === this.selectedConversationId;
                const direction = t.last_message_direction === 'inbound' ? '📥' : '📤';
                const username = this.threadName(t);
                return html`
                    <button type="button"
                            class="thread-item ${isActive ? 'active' : ''}"
                            aria-current="${isActive ? 'true' : 'false'}"
                            data-action="inbox:selectThread" data-id="${t.id}">
                        <div class="thread-info">
                            <div class="thread-header">
                                <span class="thread-username" dir="auto">@${username}</span>
                                <span class="thread-time">${UI.formatTime(t.last_message_at)}</span>
                            </div>
                            <p class="thread-preview" dir="auto">${direction} ${t.last_message_text || 'No messages yet'}</p>
                            <div class="thread-badges">
                                ${t.is_bot_active
                                    ? html`<span class="badge badge-success-glow flex-center gap-1"><span class="dot-blink bg-success" aria-hidden="true"></span>AI Active</span>`
                                    : html`<span class="badge badge-warning-glow">AI Paused</span>`}
                            </div>
                        </div>
                    </button>
                `;
            })}
        `);
    },

    handleSearch(value) {
        this.searchTerm = value || '';
        this.renderThreads();
    },

    // ─── Chat pane ───────────────────────────────────────────────────────────
    selectThread(id) {
        if (this.selectedConversationId === id) return;
        this.selectedConversationId = id;
        this.renderedMessageIds = new Set();

        const thread = this.threads.find((t) => t.id === id);
        this.lastMessageStamp = thread ? thread.last_message_at : null;
        this.renderChatShell(thread);
        this.renderThreads(); // highlight the active row
        this.loadMessages(id, { scroll: true });

        // Mobile: the layout is a single pane, so switch to the chat.
        const layout = document.querySelector('.inbox-layout');
        if (layout) layout.dataset.pane = 'chat';
    },

    backToThreads() {
        const layout = document.querySelector('.inbox-layout');
        if (layout) layout.dataset.pane = 'threads';
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
            <div class="chat-header">
                <button type="button" class="chat-back-btn" data-action="inbox:backToThreads" aria-label="Back to conversations">
                    <i data-lucide="arrow-left" aria-hidden="true"></i>
                </button>
                <div class="chat-header-info">
                    <h3 dir="auto" data-chat-username>@${username}</h3>
                    <span class="sub-text">Instagram User: ${thread.instagram_user_id}</span>
                </div>
                <div class="chat-header-actions">
                    <label class="toggle-switch" for="bot-toggle-input">
                        <span class="sr-only">AI assistant for this conversation</span>
                        <input type="checkbox" id="bot-toggle-input"
                               ${thread.is_bot_active ? html.raw('checked') : ''}
                               data-change="inbox:toggleBot" data-id="${thread.id}">
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="toggle-label flex-center gap-1" aria-hidden="true">
                        <i data-lucide="bot" style="width:16px;height:16px;"></i>
                        AI Assistant
                    </span>
                </div>
            </div>

            <div class="chat-messages" id="chat-messages-container" role="log" aria-live="polite" aria-label="Conversation messages">
                ${html.raw(UI.loader('Loading messages…'))}
            </div>

            <div class="chat-input-area">
                <form id="chat-send-form" data-submit="inbox:sendMessage" data-id="${thread.id}">
                    <label class="sr-only" for="chat-input-text">Manual reply</label>
                    <textarea id="chat-input-text" dir="auto" class="arabic-text"
                              placeholder="Type a manual reply... (This will automatically pause the AI Bot for this conversation)"></textarea>
                    <button type="submit" class="btn btn-primary flex-center gap-2">
                        <span>Send</span>
                        <i data-lucide="send" style="width:16px;height:16px;" aria-hidden="true"></i>
                    </button>
                </form>
            </div>
        `);

        this.chatShellThreadId = thread.id;
        UI.icons(chatPane);
    },

    /** Poll-safe header refresh: text nodes only, never a re-render. */
    updateChatHeader(thread) {
        if (this.chatShellThreadId !== thread.id) return;
        const nameEl = document.querySelector('[data-chat-username]');
        if (nameEl) nameEl.textContent = `@${this.threadName(thread)}`;
        const toggle = document.getElementById('bot-toggle-input');
        if (toggle && document.activeElement !== toggle) toggle.checked = !!thread.is_bot_active;
    },

    async loadMessages(id, { scroll = false } = {}) {
        try {
            const messages = await API.getConversationMessages(id);
            if (this.selectedConversationId !== id) return; // user moved on mid-flight
            this.renderMessages(Array.isArray(messages) ? messages : [], scroll);
        } catch (err) {
            console.error('Messages Load Error:', err);
            const list = document.getElementById('chat-messages-container');
            if (list && this.renderedMessageIds.size === 0) {
                UI.renderError(
                    list,
                    { title: 'Could not load this conversation', message: err.message },
                    () => this.loadMessages(id, { scroll: true })
                );
            }
        }
    },

    /** Append-only: existing bubbles are left alone, so scroll position holds. */
    renderMessages(messages, forceScroll) {
        const list = document.getElementById('chat-messages-container');
        if (!list) return;

        const firstPaint = this.renderedMessageIds.size === 0;
        if (firstPaint) list.innerHTML = '';

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
    },

    messageBubble(msg) {
        const isOut = msg.direction === 'outbound';
        return html`
            <div class="message-row ${isOut ? 'row-outbound' : 'row-inbound'}">
                <div class="message-bubble ${isOut ? 'bubble-outbound' : 'bubble-inbound'}">
                    <p dir="auto">${msg.text}</p>
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
                    ${payload.quick_replies.map((qr) => html`<span class="qr-pill" dir="auto">${qr && qr.title}</span>`)}
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
                            <div class="carousel-card glass-card">
                                ${image ? html`<img src="${image}" class="carousel-card-img" alt="${(el && el.title) || 'Carousel image'}">` : ''}
                                <div class="carousel-card-body">
                                    <h4 class="carousel-card-title" dir="auto">${el && el.title}</h4>
                                    ${el && el.subtitle ? html`<p class="carousel-card-desc" dir="auto">${el.subtitle}</p>` : ''}
                                    <div class="carousel-card-buttons">
                                        ${buttons.map((btn) => html`<span class="carousel-btn" dir="auto">${btn && btn.title}</span>`)}
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
    async toggleBot(id, checked) {
        try {
            await API.toggleConversationBot(id, checked);
            UI.toast(
                checked ? 'AI Bot enabled for this chat thread.' : 'AI Bot paused. Manual response mode active.',
                checked ? 'success' : 'error'
            );
            this.loadThreads(true);
        } catch (err) {
            console.error('Toggle Bot Error:', err);
            UI.toast(err.message || 'Failed to change AI state.', 'error');
            const toggle = document.getElementById('bot-toggle-input');
            if (toggle) toggle.checked = !checked;
        }
    },

    async sendMessage(form, event) {
        event.preventDefault();
        const id = form.dataset.id;
        const input = document.getElementById('chat-input-text');
        const button = form.querySelector('button[type="submit"]');
        const text = input.value.trim();
        if (!text) return;

        input.disabled = true;
        if (button) button.disabled = true;

        try {
            await API.sendConversationMessage(id, text);
            input.value = '';
            UI.toast('Message sent. AI auto-replies paused for this thread.');
            this.lastMessageStamp = null; // force the next poll to pick it up
            await this.loadMessages(id, { scroll: true });
            await this.loadThreads(true);
        } catch (err) {
            console.error('Send Message Error:', err);
            // The draft is deliberately left in the box so nothing is lost.
            UI.toast(err.message || 'Failed to send message.', 'error');
        } finally {
            input.disabled = false;
            if (button) button.disabled = false;
            input.focus();
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
