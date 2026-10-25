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
 * ─── The sales view (DM sales plan S11, S12) ────────────────────────────────
 * What the sales flow knows about a thread, drawn where the operator already looks:
 *   - a stage chip on each thread, in the list and in the header (the v39 stages: `STAGES`, one tone each);
 *   - the "Hot" filter: a person opened the link we sent, or said they are ready to buy, or the bot flagged
 *     a hot lead (`Attention.isHot`), and not someone who asked to be left alone;
 *   - the link clicks in the header: how many times a PERSON opened the thread's links, and when last. The
 *     server leaves preview crawlers and prefetches out of that number, and the chip says so;
 *   - under each AI bubble, what the bot decided (`messages.ai_meta`): intent, stage, next action, offer,
 *     engine and the handoff reason. Every value but the offer id comes from a closed list (`AI_INTENTS`
 *     and friends, the same lists as src/services/dmSales/types.ts, with a test that they agree); a value
 *     outside its list is shown as escaped text and never looked up, so it cannot name a key or a class;
 *   - the funnel card (`GET /api/dm/funnel`): conversations by the step they reached, the plan's rates and
 *     the bot's reply time, over 7, 30 or 90 days. It sits above the list, closed, and asks the server only
 *     when opened or when the period changes: it is not part of the poll.
 *
 * ─── Handled, and who is really answering (UX overhaul US1: audit IN-01, IN-02) ──────────
 *   - "Mark handled" ends a thread's turn in the owner's To do (`handled_at`, v45): a thread answered from the Instagram app is
 *     recorded nowhere else, so it stayed "Needs you" and in every count for ever. It is set from the chat header, from a button on
 *     the row, and from the composer once Meta's 24 h window has closed. It is undoable (a toast with Undo, and "Reopen" in the
 *     header), and a new message from the customer clears it on the server, so it never hides someone who asks again. The write is
 *     optimistic and held in `pendingHandled` until the server answers, like the AI switch's `pendingBotState`, so a poll cannot
 *     bring the thread back for a tick.
 *   - Every badge about the assistant is the EFFECTIVE state (`effectiveAi`): the assistant's global switch, then the thread's own,
 *     then the sales mode. It used to read the thread's switch alone, so with the assistant off every thread still wore a green
 *     "AI active". The list answer carries `assistant` (what it is set to) and each item's `effective_ai`; a strip above the list says
 *     when nobody is being answered, or when sales is only in test.
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
    FILTERS: Object.freeze(['all', 'waiting', 'needs_you', 'hot', 'paused', 'ads']),
    /** What `effective_ai` says (src/services/inboxAssistant.ts: a test fails when these differ). */
    EFFECTIVE_STATES: Object.freeze(['on', 'off_global', 'paused_thread', 'sales_test', 'sales_live']),
    /** The effective state → the state of the `assistant` status pill (components.js). No prototype, so a stranger finds nothing. */
    ASSISTANT_PILL: Object.freeze(Object.assign(Object.create(null), {
        on: 'on', off_global: 'off', paused_thread: 'paused_here', sales_test: 'sales_test', sales_live: 'sales_live',
    })),
    /** A conversation id as the alert's link carries it (`#/inbox?c=<id>`); anything else in the hash is data. */
    ID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    /** Hidden for longer than this, the list on return is old news, and the reload says so. */
    RETURN_NOTICE_MS: 60 * 1000,

    // ─── The sales flow's vocabulary (src/services/dmSales/types.ts: a test fails when these differ) ──
    AI_INTENTS: Object.freeze([
        'greeting', 'info', 'price', 'level_fit', 'objection_price', 'objection_time', 'objection_trust', 'ready_to_buy', 'support',
        'refund_or_complaint', 'wants_human', 'off_topic', 'abuse', 'opt_out', 'other',
    ]),
    STAGES: Object.freeze(['new', 'qualify', 'recommend', 'objection', 'link', 'follow_up', 'handoff', 'closed']),
    NEXT_ACTIONS: Object.freeze(['reply', 'ask_qualifier', 'recommend', 'send_link', 'handoff', 'close']),
    /** 'none' (the schema's stand-in for no reason) is not a reason, so it is not here and is never drawn. */
    HANDOFF_REASONS: Object.freeze(['unsure', 'refund', 'complaint', 'wants_human', 'hot_lead', 'abuse']),
    /** Who wrote a reply (`ai_meta.engine`): the AI providers layer, Gemini after it failed, a fixed rule, the safety pre-filter, a kit line. */
    ENGINES: Object.freeze(['providers', 'gemini_fallback', 'rule', 'prefilter', 'kit']),
    /** One badge tone per stage, from the tones the stylesheet has. No prototype, so a stage from the data finds nothing but a stage here. */
    STAGE_TONES: Object.freeze(Object.assign(Object.create(null), {
        new: 'neutral', qualify: 'info', recommend: 'info', objection: 'warning', link: 'success', follow_up: 'info', handoff: 'warning', closed: 'neutral',
    })),
    /** Longest an offer id or an unknown value is shown, so a long string cannot stretch the line it is in. */
    AI_META_TEXT_MAX: 48,

    // ─── The funnel card ─────────────────────────────────────────────────────
    FUNNEL_WINDOWS: Object.freeze([7, 30, 90]),
    /** The server's step ids, in the order they are drawn. */
    FUNNEL_STEPS: Object.freeze(['conversations', 'qualified', 'recommended', 'link_sent', 'clicked']),
    /** An open card older than this asks again when it is reopened. */
    FUNNEL_STALE_MS: 60 * 1000,
    /** The A/B wording slots (DM plan S14), in the order they are drawn: a letter from this table, never one from the response. */
    FUNNEL_VARIANT_SLOTS: Object.freeze(['A', 'B', 'C']),

    // ─── What the stored rows say, so a placeholder is never mistaken for words ──
    /** The text the pipeline stores for a carousel (which has none) and for a story mention. */
    STRUCTURED_PLACEHOLDER: '[Structured Template]',
    STORY_MENTION_PLACEHOLDER: '[Story Mention]',
    /** What an Instagram voice note is stored as (src/webhook/attachments.ts). A WhatsApp voice note's text is its transcript instead, once it has been transcribed. */
    VOICE_PLACEHOLDER: '[voice note]',
    /**
     * A message with no words (src/webhook/attachments.ts): the pipeline stores its kind as `message_type` and a placeholder (`[photo]`) as
     * its text. This maps each kind to the chip that names it (`attachmentStyle`), so the chip is the message and the placeholder is never
     * printed. No prototype, so a `message_type` from the data cannot find anything but a kind here.
     */
    WORDLESS_KINDS: Object.freeze(Object.assign(Object.create(null), {
        image: 'image', video: 'video', audio: 'audio', file: 'file', sticker: 'sticker', share: 'share', reel: 'reel',
        story_share: 'storyShare', story_mention: 'storyMention', story_reply: 'storyReply', attachment: 'other',
    })),
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
    /** 'all' | 'waiting' | 'needs_you' | 'hot' | 'paused' */
    filter: 'all',
    /**
     * The funnel card: whether it is open, the period shown, what came back, whether it failed, and which request is the live one
     * (`seq`: an answer that arrives after a newer question, or after the page was left, is dropped).
     */
    funnel: { open: false, days: 30, data: null, failed: false, loading: false, seq: 0, at: 0 },
    /** The conversation the page was opened on (`#/inbox?c=<id>`, the link in the owner's alert), until the list has loaded and it is opened. */
    _deepLinkId: '',
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

    /** id → the `handled_at` the owner chose (an ISO stamp, or null for a reopen), until the server confirms it. */
    pendingHandled: new Map(),

    /**
     * What the assistant is set to, from the list's answer (`{ configured, is_active, sales_mode, sales_test_senders }`), or null while
     * it is unknown or could not be read. Unknown is never reported as off: a thread then says only what its own switch says.
     */
    assistant: null,
    /** What the header's handled slot, the composer's window offer and the strip last wrote, so an idle poll writes nothing. */
    _handledMarkup: null,
    _windowOfferMarkup: null,
    _stripMarkup: null,

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
                    <!-- When nobody is being answered automatically, or sales is only in test: said once, here, instead of
                         being left for a row's badge to imply. Hidden until the first answer says there is something to say. -->
                    <div id="assistant-strip" class="assistant-strip hidden" role="status" aria-label="${t('inbox.strip.label')}"></div>
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
                    ${this.funnelShell()}
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
        this._deepLinkId = this.threadFromHash();
        this.syncFilterButtons();
        this.paintFunnel();
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
        this.pendingHandled = new Map();
        this.assistant = null;
        this._handledMarkup = null;
        this._windowOfferMarkup = null;
        this._stripMarkup = null;
        this._profileAsked = new Set();
        this._backfilled = false;
        this._avatarMarkup = null;
        this._metaMarkup = null;
        this.lastMessageStamp = null;
        this.searchTerm = '';
        this.searchMatches = null;
        this.filter = 'all';
        this._deepLinkId = '';
        this._pollFailures = 0;
        this._unchangedTicks = 0;
        this._listSignature = null;
        this._countMarkup = null;
        this._staleShown = false;
        // Closed again, and the request in flight (if any) is no longer the live one: its answer is dropped. Painted too, because a tenant
        // switch resets the page without repainting the layout, and the card must not stay open on the new tenant's numbers.
        this.funnel = { open: false, days: 30, data: null, failed: false, loading: false, seq: ((this.funnel && this.funnel.seq) || 0) + 1, at: 0 };
        this.paintFunnel();
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
        const sig = [this.total, ...rows.map((r) => [r.id, r.last_message_at, r.is_bot_active, r.last_message_direction, r.handled_at || '', r.effective_ai || ''].join('|'))].join('\n');
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
     * message it was; a story mention reads as one; a message with no words (a photo, a voice note, a shared reel, a sticker) reads
     * as what it was, not as its placeholder.
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
        const wordless = this.wordlessKind(thread.last_message_type);
        if (wordless && thread.last_message_type !== 'story_mention') return t(this.attachmentStyle(wordless).label);
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

    // The rules for "does this thread need a person" (waiting, handed over, hot, the 24 h window) live in dashboard/js/attention.js,
    // shared with the Overview and the nav badge. This page only draws what they answer.

    /** "5 h 20 min", "40 min" or "under a minute". Latin digits, as every number on this screen. */
    windowTime(ms) {
        const minutes = Math.floor(ms / 60000);
        if (minutes < 1) return t('inbox.window.lt1');
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (h === 0) return t('inbox.window.m', { m: UI.formatNumber(m) });
        return m === 0 ? t('inbox.window.h', { h: UI.formatNumber(h) }) : t('inbox.window.hm', { h: UI.formatNumber(h), m: UI.formatNumber(m) });
    },

    /** The countdown for a thread that needs a person: its words, or '' for any other thread and for one with no message from the customer. */
    windowText(thread, now = Date.now()) {
        if (!Attention.needsHuman(thread)) return '';
        const ms = Attention.windowLeftMs(thread, now);
        if (ms === null) return '';
        return ms <= 0 ? t('inbox.window.closed') : t('inbox.window.left', { time: this.windowTime(ms) });
    },

    // ─── Handled, and who is really answering ────────────────────────────────
    /** Marking handled is an operator's act (`POST /conversations/:id/handled` is `canOperate`); a viewer sees the state and no buttons. */
    canMark() {
        return typeof App === 'undefined' || typeof App.canOperate !== 'function' || App.canOperate();
    },

    /** Waiting for a reply, and not marked handled since the customer last wrote: what "Needs reply" counts and filters. */
    needsReply(thread) {
        return Attention.isWaiting(thread) && !Attention.isHandled(thread);
    },

    /** Handed to a person, not answered, and not marked handled since the customer last wrote: what "Needs you" counts and filters. */
    needsYou(thread) {
        return Attention.isHandoff(thread) && !Attention.isHandled(thread);
    },

    /**
     * Who would answer this thread's next message: one of `EFFECTIVE_STATES`.
     *
     * Worked out from the thread as it is NOW and what the assistant is set to (`Attention.effectiveAi`, the same decision the server makes
     * for `effective_ai`), so flipping the thread's own switch moves it at once instead of a poll later. Until a list answer has said what
     * the assistant is set to (or when it could not), the item's own `effective_ai` is what there is, and failing that only the thread's own
     * switch: an unknown setting is never reported as off.
     */
    effectiveAi(thread) {
        if (this.assistant) return Attention.effectiveAi(thread, this.assistant);
        if (thread && this.EFFECTIVE_STATES.includes(thread.effective_ai)) return thread.effective_ai;
        return Attention.effectiveAi(thread, null);
    },

    /**
     * The state as a pill: a glyph, a word and a tone, never colour alone (`UI.statusPill`). "On" and "Off" alone say nothing on a row, so
     * those two name what they are about. The pill's own `title` says what it means for the person and what to do.
     */
    assistantPill(thread) {
        const state = this.effectiveAi(thread);
        const label = state === 'on' ? t('inbox.assistant.on') : state === 'off_global' ? t('inbox.assistant.off_global') : '';
        return UI.statusPill('assistant', this.ASSISTANT_PILL[state], label ? { label } : undefined);
    },

    /** The state in words, beside the header's switch. A boolean (the thread's own switch, as this once took) reads as `on` / `paused_thread`. */
    aiStateText(state) {
        const key = state === true ? 'on' : state === false ? 'paused_thread' : state;
        if (key === 'off_global') return t('inbox.aiState.off_global');
        if (key === 'sales_test') return t('inbox.aiState.sales_test');
        if (key === 'sales_live') return t('inbox.aiState.sales_live');
        return key === 'paused_thread' ? t('inbox.aiOff') : t('inbox.aiOn');
    },

    /** "Handled" as a neutral badge: the reason a row has lost its Needs-reply and countdown badges. */
    handledBadge() {
        return html`<span class="badge badge-neutral" data-handled><i data-lucide="check" aria-hidden="true"></i>${t('inbox.handled.state')}</span>`;
    },

    /** The conversation id in `#/inbox?c=<id>`, or '' (anything that is not an id is ignored). */
    threadFromHash() {
        const raw = typeof App !== 'undefined' && typeof App.hashParam === 'function' ? String(App.hashParam('c') || '') : '';
        return this.ID_PATTERN.test(raw) ? raw.toLowerCase() : '';
    },

    /** Open the conversation the page was opened on, once, when the list that holds it has arrived. One that is not among the newest threads is left alone. */
    openDeepLink() {
        const id = this._deepLinkId;
        if (!id) return;
        this._deepLinkId = '';
        if (this.findThread(id)) this.selectThread(id);
    },

    matchesFilter(thread) {
        if (this.filter === 'waiting') return this.needsReply(thread);
        if (this.filter === 'needs_you') return this.needsYou(thread);
        if (this.filter === 'hot') return Attention.isHot(thread);
        if (this.filter === 'paused') return !!thread && thread.is_bot_active === false;
        if (this.filter === 'ads') return this.fromAd(thread);
        return true;
    },

    // ─── Ads → DM attribution (A3) ───────────────────────────────────────────
    /** The thread began from an ad (click-to-message or click-to-WhatsApp), or a later ad brought the person back: what the Ads filter keeps. */
    fromAd(thread) {
        return !!thread && (!!thread.ad || Number(thread.adTouches) > 0);
    },

    /** "From ad: <name>" on a thread that began from one, "From an ad" when its name is not known; '' for any other. */
    adBadge(thread) {
        if (!thread || !thread.ad) return '';
        const label = thread.ad.name ? t('inbox.ad.from', { name: thread.ad.name }) : t('inbox.ad.fromUnnamed');
        return html`<span class="badge badge-info" data-from-ad><i data-lucide="megaphone" aria-hidden="true"></i><bdi dir="auto">${label}</bdi></span>`;
    },

    /** Meta Business AI holds the thread, so nothing the bot sends gets through until the owner takes it back. */
    businessAiBadge(thread) {
        if (!thread || thread.noReplyReason !== 'business_ai_owns_thread') return '';
        return html`<span class="badge badge-warning" data-business-ai><i data-lucide="alert-circle" aria-hidden="true"></i>${t('inbox.ad.businessAi')}</span>`;
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

    /** The AI toggle, and the handled stamp, the operator has just chosen outrank a poll that may have left before the write committed. */
    applyPending(rows) {
        if (this.pendingHandled.size > 0) {
            rows.forEach((row) => {
                if (this.pendingHandled.has(row.id)) row.handled_at = this.pendingHandled.get(row.id);
            });
        }
        if (this.pendingBotState.size > 0) {
            rows.forEach((row) => {
                if (this.pendingBotState.has(row.id)) {
                    row.is_bot_active = this.pendingBotState.get(row.id);
                    // A poll that left before the server moved the stage on must not bring "Needs you" back for a tick.
                    if (row.is_bot_active && row.stage === 'handoff') row.stage = 'new';
                }
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
            this.adoptAssistant(result);
            this.threads = rows;
            this.total = Number.isFinite(total) ? total : rows.length;
            this.noteListChange(rows);
            this.renderThreads();
            this.reportWaiting();
            this.openDeepLink();
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
        // Waiting for a reply, or handed over to a person: the two are what the owner opens the inbox for.
        App.setInboxWaiting(this.threads.filter((x) => Attention.needsHuman(x)).length);
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
    /**
     * A stage as a badge: its word, in the tone it has. '' for anything that is not one of the flow's stages (a thread from before v39 has
     * none, and the server pins a stranger to null), so the chip is drawn from the closed list and from nothing the data can add to.
     */
    stageChip(stage) {
        if (typeof stage !== 'string' || !this.STAGES.includes(stage)) return '';
        return html`<span class="badge badge-${this.STAGE_TONES[stage]}" data-stage="${stage}">${t(`inbox.stage.${stage}`)}</span>`;
    },

    hotBadge() {
        return html`<span class="badge badge-accent" data-hot><i data-lucide="zap" aria-hidden="true"></i>${t('inbox.hot')}</span>`;
    },

    threadRow(x) {
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
                ${this.assistantPill(x)}
                ${this.businessAiBadge(x)}
                ${this.adBadge(x)}
                ${this.stageChip(x.stage)}
                ${Attention.isHot(x) ? this.hotBadge() : ''}
                ${this.needsReply(x)
                    ? html`<span class="badge badge-danger"><i data-lucide="reply" aria-hidden="true"></i>${t('inbox.inbound')}</span>`
                    : ''}
                ${this.needsYou(x)
                    ? html`<span class="badge badge-warning"><i data-lucide="alert-circle" aria-hidden="true"></i>${t('inbox.needsYou')}</span>`
                    : ''}
                ${Attention.isHandled(x) ? this.handledBadge() : ''}
                ${this.windowText(x)
                    ? html`<span class="badge badge-neutral"><i data-lucide="clock" aria-hidden="true"></i>${this.windowText(x)}</span>`
                    : ''}
            </span>
        `;
    },

    /**
     * The row's own "Mark handled": a check button beside the row for a thread that needs a person (`Attention.needsHuman`), so the
     * owner can clear a thread he answered from the Instagram app without opening it. A sibling of the row's button and never inside
     * it (a button in a button is not a control a keyboard or a screen reader can use). '' for any other thread, and for a viewer.
     */
    rowActionMarkup(x) {
        if (!this.canMark() || !Attention.needsHuman(x)) return '';
        const name = `\u2068${this.threadTitle(x)}\u2069`;
        return html`<button type="button" class="icon-button thread-row-action" data-action="inbox:markHandled" data-id="${x.id}"
                            data-focus-key="handled-row-${x.id}" aria-label="${t('inbox.handled.markFor', { name })}"
                            title="${t('inbox.handled.mark')}"><i data-lucide="check" aria-hidden="true"></i></button>`;
    },

    /**
     * I7: "3 need a reply" under the search, and I2: "Showing 100 of 240" when
     * the list is not all of them. Written only when the text changes, so an
     * idle poll touches nothing.
     */
    renderCount() {
        const host = document.getElementById('inbox-count');
        if (!host) return;
        const waiting = this.threads.filter((x) => this.needsReply(x)).length;
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
        if (kind === 'needs_you') return html`<div class="empty-threads" data-empty="needs_you"><p>${t('inbox.noNeedsYou')}</p></div>`;
        if (kind === 'hot') return html`<div class="empty-threads" data-empty="hot"><p>${t('inbox.noHot')}</p></div>`;
        if (kind === 'paused') return html`<div class="empty-threads" data-empty="paused"><p>${t('inbox.noPaused')}</p></div>`;
        if (kind === 'ads') return html`<div class="empty-threads" data-empty="ads"><p>${t('inbox.noAds')}</p>${UI.helpLink('ads#message-ads-inbox', t('inbox.ad.help'))}</div>`;
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
                // Who would actually answer (the global switch and the sales mode count, not only the thread's own), and whether the
                // owner has marked the thread handled: both change what the row says without touching the thread's own columns.
                this.effectiveAi(x),
                Attention.isHandled(x) ? '1' : '0',
                Attention.needsHuman(x) ? '1' : '0',
                x.last_message_direction,
                x.id === this.selectedConversationId ? '1' : '0',
                Attention.isHandoff(x) ? '1' : '0',
                x.stage || '',
                Attention.isHot(x) ? '1' : '0',
                // The text shown, so the row is repainted when the minute changes and not before.
                this.windowText(x),
            ].join('\u001f'),
            create: () => {
                const item = document.createElement('div');
                item.setAttribute('role', 'listitem');
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'thread-item';
                item.appendChild(btn);
                // The row's own actions sit beside its button, not in it.
                const actions = document.createElement('span');
                actions.className = 'thread-row-actions';
                item.appendChild(actions);
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
                // A stable key, so focus can come back to the row when the button beside it has done its work and gone.
                btn.dataset.focusKey = `thread-${x.id}`;
                btn.innerHTML = esc(this.threadRow(x));
                const actions = typeof el.querySelector === 'function' ? el.querySelector('.thread-row-actions') : null;
                if (actions) actions.innerHTML = esc(this.rowActionMarkup(x));
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
            this.adoptAssistant(result);
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

    /**
     * The line under the composer. The consequence of a manual reply used to
     * live only in the placeholder, which vanishes on the first keystroke —
     * exactly when it matters. Once the AI is paused here (a manual reply does
     * that), the line offers the way back: "Hand back to AI".
     */
    composerHintMarkup(thread) {
        const state = this.effectiveAi(thread);
        // Off for everyone: there is nothing to pause or hand back, so neither is offered. The person writing is the only one answering.
        if (state === 'off_global') return html`<span>${t('inbox.composerHintOffGlobal')}</span>`;
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
        // The EFFECTIVE state: the assistant's global switch and the sales mode count, not only this thread's switch.
        const effective = this.effectiveAi(thread);
        const answering = effective !== 'off_global' && effective !== 'paused_thread';
        const state = document.getElementById('ai-state');
        if (state) {
            const text = this.aiStateText(effective);
            if (state.textContent !== text) state.textContent = text;
            state.classList.toggle('is-on', answering);
        }
        const hint = document.getElementById('composer-hint');
        // Keyed on the thread's own switch AND the effective state: the same effective state can need a different hint.
        const hintKey = `${effective}|${thread.is_bot_active !== false ? 'on' : 'off'}`;
        if (hint && hint.dataset && hint.dataset.state !== hintKey) {
            hint.innerHTML = esc(this.composerHintMarkup(thread));
            hint.dataset.state = hintKey;
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
        // `on` is this thread's own switch (the toggle); `effective` is who would actually answer (the words beside it).
        const on = thread.is_bot_active !== false;
        const effective = this.effectiveAi(thread);
        const answering = effective !== 'off_global' && effective !== 'paused_thread';
        // Written once here and remembered, so the poll's repaint compares against what is on screen.
        const avatar = this.avatarMarkup(thread);
        const meta = this.metaMarkup(thread);
        const handled = this.handledSlotMarkup(thread);
        const windowOffer = this.windowOfferMarkup(thread);
        this._avatarMarkup = esc(avatar);
        this._metaMarkup = esc(meta);
        this._handledMarkup = esc(handled);
        this._windowOfferMarkup = esc(windowOffer);

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
                    <!-- "Mark handled" (or "Reopen"), for a thread that needs a person: painted by paintHandled, which keeps it in step. -->
                    <span class="chat-handled-slot" id="chat-handled-slot">${handled}</span>
                    <!-- The switch already announces its state; this is the same
                         fact for the eye, so it is hidden from the reader. -->
                    <span class="ai-state${answering ? html.raw(' is-on') : ''}" id="ai-state" aria-hidden="true">${this.aiStateText(effective)}</span>
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
                <!-- Once Meta's 24 h window has closed a reply from here cannot reach the person: the answer is in the Instagram app,
                     and this is where the owner says he has given it. Painted by paintWindowOffer. -->
                <div class="composer-window" id="composer-window">${windowOffer}</div>
                <form id="chat-send-form" data-submit="inbox:sendMessage" data-id="${thread.id}">
                    <label class="sr-only" for="chat-input-text">${t('inbox.replyLabel')}</label>
                    <textarea id="chat-input-text" dir="auto" placeholder="${t('inbox.replyPlaceholder')}"
                              aria-describedby="composer-hint"></textarea>
                    ${UI.button({
                        variant: 'primary', type: 'submit', icon: 'send',
                        ariaLabel: t('inbox.sendLabel'),
                    })}
                </form>
                <p class="composer-hint" id="composer-hint" data-state="${`${effective}|${on ? 'on' : 'off'}`}">${this.composerHintMarkup(thread)}</p>
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

    /** One chip of the detail strip. `note` is what the chip does not say on its face: a tooltip, and read out after it. */
    metaChip(label, { icon = '', accent = false, note = '' } = {}) {
        return html`<span class="chip${accent ? html.raw(' chip-accent') : ''}"${note ? html` title="${note}"` : ''}>${icon ? html`<i data-lucide="${icon}" aria-hidden="true"></i>` : ''}${label}${note ? html`<span class="sr-only">. ${note}</span>` : ''}</span>`;
    },

    /**
     * What the thread's links did, as chips (DM plan S11): how many times a PERSON opened them and when last, or that none has yet. Only for a
     * thread a link was sent in (`last_link_at`, or a tracked link on the server's side). The count is the server's `link_clicks.clicks`, which
     * leaves out preview crawlers and prefetches, and the chip says so.
     */
    linkChips(thread) {
        if (!thread) return [];
        const found = thread.link_clicks && typeof thread.link_clicks === 'object' && Number(thread.link_clicks.links) > 0 ? thread.link_clicks : null;
        // A link went out, but what people did with it is not known (the lookup failed, or the table is not there): say only that it went out.
        if (!found) return thread.last_link_at ? [this.metaChip(t('inbox.links.sent'), { icon: 'link' })] : [];
        const note = t('inbox.links.note');
        const clicks = Math.floor(Number(found.clicks));
        if (!Number.isFinite(clicks) || clicks <= 0) return [this.metaChip(t('inbox.links.notClicked'), { icon: 'link', note })];
        const last = Date.parse(found.last_click_at);
        const label = t('inbox.links.clicked', { count: clicks, n: UI.formatNumber(clicks) })
            + (Number.isFinite(last) ? ` · ${t('inbox.links.last', { when: this.threadTime(found.last_click_at) })}` : '');
        return [this.metaChip(label, { icon: 'link', accent: true, note })];
    },

    /**
     * What is known about the sender and the thread, as chips: whether they follow you, whether you follow them, their verification,
     * their follower count, when they first wrote and how many messages there are. Each is shown only when it is known, so a
     * Messenger thread, or an Instagram one whose profile has not been looked up yet, shows the two it has (the dates and the count).
     */
    metaMarkup(thread) {
        if (!thread) return '';
        const chips = [];
        // Where the sales flow has got to with this person, and whether they are a hot lead.
        if (this.STAGES.includes(thread.stage)) {
            chips.push(this.metaChip(t('inbox.stage.chip', { stage: t(`inbox.stage.${thread.stage}`) }), { icon: 'flag', accent: thread.stage === 'link' }));
        }
        if (Attention.isHot(thread)) chips.push(this.metaChip(t('inbox.hot'), { icon: 'zap', accent: true }));
        // A3: Meta Business AI holds the thread (the bot's sends are refused), and the ad the thread began from, each with where to read more.
        if (thread.noReplyReason === 'business_ai_owns_thread') {
            chips.push(this.metaChip(t('inbox.ad.businessAi'), { icon: 'alert-circle', accent: true, note: t('inbox.ad.businessAiNote') }));
            chips.push(UI.helpLink('ads#business-ai', t('inbox.ad.businessAiHelp')));
        }
        if (thread.ad) {
            chips.push(this.metaChip(thread.ad.name ? t('inbox.ad.from', { name: thread.ad.name }) : t('inbox.ad.fromUnnamed'), { icon: 'megaphone' }));
            chips.push(UI.helpLink('ads#message-ads-inbox', t('inbox.ad.help')));
        } else if (Number(thread.adTouches) > 0) {
            chips.push(this.metaChip(t('inbox.ad.returned'), { icon: 'megaphone' }));
        }
        // Handed over to a person, and how long Meta's window leaves to answer (a closed window is answered from the Instagram app).
        if (this.needsYou(thread)) chips.push(this.metaChip(t('inbox.needsYou'), { icon: 'alert-circle', accent: true }));
        // Marked handled by the owner, and the customer has not written since: why the two chips above are gone.
        if (Attention.isHandled(thread)) chips.push(this.metaChip(t('inbox.handled.state'), { icon: 'check' }));
        const countdown = this.windowText(thread);
        if (countdown) {
            const closed = Attention.windowLeftMs(thread) === 0;
            chips.push(this.metaChip(closed ? `${countdown}: ${t('inbox.window.closedHint')}` : countdown, { icon: 'clock' }));
        }
        chips.push(...this.linkChips(thread));
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
        this.paintHandled(thread);
        this.paintWindowOffer(thread);
    },

    /**
     * The header's "Mark handled" for a thread that needs a person, "Reopen" for one the owner has marked, nothing for the rest (and for
     * a viewer). One button with one id, so focus can be put back on it when it changes into the other.
     */
    handledSlotMarkup(thread) {
        if (!thread || !this.canMark()) return '';
        if (Attention.isHandled(thread)) {
            return UI.button({ variant: 'ghost', size: 'sm', icon: 'rotate-ccw', label: t('inbox.handled.reopen'), action: 'inbox:unmarkHandled', id: 'chat-mark-handled', data: { id: thread.id } });
        }
        if (Attention.needsHuman(thread)) {
            return UI.button({ variant: 'secondary', size: 'sm', icon: 'check', label: t('inbox.handled.mark'), action: 'inbox:markHandled', id: 'chat-mark-handled', data: { id: thread.id } });
        }
        return '';
    },

    /**
     * What the composer offers once the 24 h window has closed on a thread that needs a person: the way to say "I answered it in the
     * Instagram app". Only then: with the window open the owner can simply reply here, and a thread nobody has to answer needs nothing.
     */
    windowOfferMarkup(thread) {
        if (!thread || !this.canMark() || !Attention.needsHuman(thread) || Attention.windowLeftMs(thread) !== 0) return '';
        // The answer is in the app the person wrote from: Instagram, or the Page inbox for a Messenger thread.
        const facebook = thread.platform === 'facebook';
        const text = facebook ? t('inbox.window.offerFacebook') : t('inbox.window.offer');
        const label = facebook ? t('inbox.window.offerActionFacebook') : t('inbox.window.offerAction');
        return html`<p class="composer-window-text">${text}</p>${UI.button({ variant: 'secondary', size: 'sm', icon: 'check', label, action: 'inbox:markHandled', id: 'composer-mark-handled', data: { id: thread.id } })}`;
    },

    paintHandled(thread) {
        const slot = document.getElementById('chat-handled-slot');
        if (!slot || !thread || this.chatShellThreadId !== thread.id) return;
        const markup = esc(this.handledSlotMarkup(thread));
        if (markup === this._handledMarkup) return;
        const focus = UI.captureFocus(slot);
        this._handledMarkup = markup;
        slot.innerHTML = markup;
        UI.icons(slot);
        UI.restoreFocus(focus);
    },

    paintWindowOffer(thread) {
        const host = document.getElementById('composer-window');
        if (!host || !thread || this.chatShellThreadId !== thread.id) return;
        const markup = esc(this.windowOfferMarkup(thread));
        if (markup === this._windowOfferMarkup) return;
        const focus = UI.captureFocus(host);
        this._windowOfferMarkup = markup;
        host.innerHTML = markup;
        UI.icons(host);
        UI.restoreFocus(focus, 'chat-mark-handled');
    },

    // ─── The strip above the list ────────────────────────────────────────────
    /** Keep what the list's answer says the assistant is set to. An answer without it (an older server, a read that failed) leaves it unknown: null. */
    adoptAssistant(result) {
        const a = result && typeof result === 'object' ? result.assistant : null;
        this.assistant = a && typeof a === 'object' && typeof a.is_active === 'boolean' ? a : null;
        this.paintAssistantStrip();
    },

    /**
     * What the strip says, or null when there is nothing to say: the assistant was never set up, it is switched off, or sales is only in
     * test. "Not set up" and "off" are different sentences (nobody switched it off), and with the assistant off the sales mode is moot.
     */
    stripKind() {
        const a = this.assistant;
        if (!a) return null;
        if (a.configured === false) return 'notSetUp';
        if (a.is_active === false) return 'off';
        if (a.sales_mode === 'test') return Array.isArray(a.sales_test_senders) && a.sales_test_senders.length > 0 ? 'salesTest' : 'salesTestEmpty';
        return null;
    },

    stripMarkup() {
        const kind = this.stripKind();
        if (!kind) return '';
        const href = typeof App !== 'undefined' && typeof App.route === 'function' ? App.route('ai_settings') : '#/ai_settings';
        const label = kind === 'notSetUp' ? t('inbox.strip.notSetUpAction') : kind === 'off' ? t('inbox.strip.offAction') : t('inbox.strip.settingsAction');
        // Only someone who can change it is offered the way there (the settings routes are `canOperate`).
        const action = this.canMark() ? html`<a class="btn btn-sm btn-secondary" href="${href}">${label}</a>` : '';
        const glyph = kind === 'salesTest' || kind === 'salesTestEmpty' ? '◔' : '○';
        return html`<span class="assistant-strip-glyph" aria-hidden="true">${glyph}</span><span class="assistant-strip-text">${t(`inbox.strip.${kind}`)}</span>${action}`;
    },

    /** Poll-safe: written only when what it says changes. */
    paintAssistantStrip() {
        const host = document.getElementById('assistant-strip');
        if (!host) return;
        const kind = this.stripKind();
        const markup = kind ? esc(this.stripMarkup()) : '';
        if (markup === this._stripMarkup) return;
        this._stripMarkup = markup;
        if (!markup) {
            host.classList.add('hidden');
            host.innerHTML = '';
            if (host.dataset) delete host.dataset.kind;
            return;
        }
        host.innerHTML = markup;
        if (host.dataset) host.dataset.kind = kind;
        host.classList.remove('hidden');
        UI.icons(host);
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
        const transcript = isOut ? '' : this.voiceTranscript(msg);

        // A placeholder is not words. "[Structured Template]" is what a carousel is stored as; its cards are the message, and
        // when they cannot be drawn (the stored body is pruned after a while) the bubble says what it was instead.
        let shown = text;
        let note = '';
        if (text === this.STRUCTURED_PLACEHOLDER) {
            shown = '';
            if (!structure) note = t(msg.message_type === 'carousel' ? 'inbox.carouselGone' : 'inbox.structuredGone');
        } else if (text === this.STORY_MENTION_PLACEHOLDER) {
            shown = t('inbox.storyMention');
        } else if (!isOut && msg.message_type !== 'story_mention' && this.wordlessKind(msg.message_type)) {
            // A message with no words: `[photo]` is what the pipeline stored, not what the customer said. The chips are the message.
            shown = '';
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
                    ${transcript ? html`<div class="msg-transcript"><span class="msg-transcript-label">${t('inbox.voiceTranscript')}</span><p class="msg-transcript-text" dir="auto">${transcript}</p></div>` : ''}
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
     * stories, and, when the row's own `message_type` names a kind that was not read from the event (the body is pruned after a while, or the
     * kind has no attachment entry, like a message Instagram could not show), that kind with no link.
     */
    attachmentsOf(msg) {
        const out = [];
        const raw = this.parsePayload(msg && msg.raw_payload);
        const message = raw && raw.message && typeof raw.message === 'object' ? raw.message : null;
        if (message && Array.isArray(message.attachments)) {
            message.attachments.forEach((att) => {
                if (!att || typeof att !== 'object') return;
                const type = this.plainText(att.type).toLowerCase();
                // Messenger sends a sticker as an `image` that carries a `sticker_id`.
                const sticker = type === 'image' && att.payload && att.payload.sticker_id;
                out.push({ kind: sticker ? 'sticker' : this.attachmentKind(type), url: this.plainText(att.payload && att.payload.url) });
            });
        }
        const story = message && message.reply_to && message.reply_to.story;
        if (story && typeof story === 'object') out.push({ kind: 'storyReply', url: this.plainText(story.url) });
        const stored = this.wordlessKind(msg && msg.message_type);
        if (stored && !out.some((a) => a.kind === stored)) out.push({ kind: stored, url: '' });
        return out.slice(0, this.MAX_ATTACHMENTS);
    },

    /**
     * What a voice note SAID, for the owner to read under its chip. A WhatsApp voice note is transcribed and the transcript is stored as the inbound row's `text`
     * (src/webhook/whatsappMediaInput.ts); an Instagram one is stored as the `[voice note]` placeholder and has no words, and one that could not be transcribed has none
     * either. So: an inbound `audio` row whose text is neither empty nor the placeholder. '' for everything else (a customer's typed `[voice note]` in a text row included).
     * The caller prints it through `html`, which escapes it like every other message text.
     */
    voiceTranscript(msg) {
        if (!msg || msg.direction !== 'inbound' || msg.message_type !== 'audio') return '';
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        return text && text !== this.VOICE_PLACEHOLDER ? text : '';
    },

    /** The chip kind a row's `message_type` stands for when the message had no words, or '' for anything else (text, a tap, a carousel). */
    wordlessKind(messageType) {
        return typeof messageType === 'string' ? (this.WORDLESS_KINDS[messageType] || '') : '';
    },

    /** Meta's attachment `type` as one of the kinds this screen words; anything it does not know is a plain "Attachment". */
    attachmentKind(type) {
        const KINDS = Object.assign(Object.create(null), {
            image: 'image', video: 'video', audio: 'audio', file: 'file',
            sticker: 'sticker', share: 'share', ig_post: 'share', post: 'share', fallback: 'share', template: 'share',
            ig_reel: 'reel', reel: 'reel', story: 'storyShare', ig_story: 'storyShare', story_mention: 'storyMention',
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
            sticker: { icon: 'heart', label: 'inbox.attach.sticker' },
            share: { icon: 'share-2', label: 'inbox.attach.share' },
            reel: { icon: 'film', label: 'inbox.attach.reel' },
            storyShare: { icon: 'history', label: 'inbox.attach.storyShare' },
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
        const decided = this.aiMetaDetail(msg);
        return items.length || decided ? html`${items.length ? html`<div class="msg-detail">${items}</div>` : ''}${decided}` : '';
    },

    // ─── What the bot decided (`messages.ai_meta`) ───────────────────────────
    /** `ai_meta` of an AI reply as an object: JSONB arrives parsed, a string is parsed, anything else (an operator's row, an old one) is null. */
    aiMetaOf(msg) {
        if (!msg || msg.direction !== 'outbound' || msg.sender !== 'ai') return null;
        return this.parsePayload(msg.ai_meta);
    },

    /**
     * A value of one of the flow's closed lists as its word. A value that is on the list is looked up; one that is not (a newer server, a
     * hand-edited row, text a model put in a field) is shown as the escaped text it is, cut short, and is never turned into a key.
     * '' for nothing, and for the schema's own "none".
     */
    vocabText(prefix, list, value) {
        const text = this.plainText(value);
        if (!text || text === 'none') return '';
        if (list.includes(text)) return t(`${prefix}.${text}`);
        return text.length > this.AI_META_TEXT_MAX ? `${text.slice(0, this.AI_META_TEXT_MAX - 1)}…` : text;
    },

    /** One "label value" pair of the decision line. */
    aiMetaItem(labelKey, value) {
        return html`<span class="msg-detail-item"><span class="msg-detail-key">${t(labelKey)}:</span> ${value}</span>`;
    },

    /**
     * The line under an AI reply that says what the bot decided: what it took the customer's message to be (intent), where that left the
     * conversation (stage), what it did (next action), which offer it was about, who wrote the reply (engine) and, when it handed over, why.
     * Each is shown only when the row has it, so the follow-up nudge and the handoff line (which carry fewer fields) and a reply from before
     * v39 (which carries none) draw what they have. Every value goes through `html`; none is ever markup.
     */
    aiMetaDetail(msg) {
        const meta = this.aiMetaOf(msg);
        if (!meta) return '';
        const items = [];
        const intent = this.vocabText('inbox.intent', this.AI_INTENTS, meta.intent);
        if (intent) items.push(this.aiMetaItem('inbox.aiMeta.intent', html`<bdi dir="auto">${intent}</bdi>`));
        const stage = this.plainText(meta.stage);
        if (stage) {
            items.push(this.aiMetaItem('inbox.aiMeta.stage', this.STAGES.includes(stage)
                ? this.stageChip(stage)
                : html`<bdi class="ltr-text" dir="ltr">${this.vocabText('inbox.stage', this.STAGES, stage)}</bdi>`));
        }
        const action = this.vocabText('inbox.nextAction', this.NEXT_ACTIONS, meta.next_action);
        if (action) items.push(this.aiMetaItem('inbox.aiMeta.next', html`<bdi dir="auto">${action}</bdi>`));
        const offer = this.plainText(meta.offer_id);
        if (offer && offer !== 'none') {
            const shown = offer.length > this.AI_META_TEXT_MAX ? `${offer.slice(0, this.AI_META_TEXT_MAX - 1)}…` : offer;
            items.push(this.aiMetaItem('inbox.aiMeta.offer', html`<bdi class="ltr-text" dir="ltr">${shown}</bdi>`));
        }
        const engine = this.vocabText('inbox.engine', this.ENGINES, meta.engine);
        if (engine) items.push(this.aiMetaItem('inbox.aiMeta.engine', html`<bdi dir="auto">${engine}</bdi>`));
        const reason = this.vocabText('inbox.handoffReason', this.HANDOFF_REASONS, meta.handoff_reason);
        if (reason) items.push(this.aiMetaItem('inbox.aiMeta.handoff', html`<span class="badge badge-warning"><bdi dir="auto">${reason}</bdi></span>`));
        return items.length ? html`<div class="msg-detail msg-detail--meta" data-ai-meta>${items}</div>` : '';
    },

    // ─── The funnel card (DM plan S12) ───────────────────────────────────────
    /**
     * The card's shell: a closed toggle above the list. It holds no numbers until it is opened, and the poll never touches it: the funnel is
     * three statements over the whole period, which is not something to repeat every five seconds.
     */
    funnelShell() {
        const open = !!(this.funnel && this.funnel.open);
        return html`
            <section class="dm-funnel" id="dm-funnel" aria-label="${t('inbox.funnel.title')}">
                <button type="button" class="dm-funnel-toggle${open ? html.raw(' is-open') : ''}" id="dm-funnel-toggle" data-action="inbox:toggleFunnel"
                        aria-expanded="${open ? 'true' : 'false'}" aria-controls="dm-funnel-panel">
                    <i data-lucide="bar-chart-3" aria-hidden="true"></i>
                    <span class="dm-funnel-title">${t('inbox.funnel.title')}</span>
                    <i data-lucide="chevron-down" class="dm-funnel-chevron" aria-hidden="true"></i>
                </button>
                <div class="dm-funnel-panel${open ? '' : html.raw(' hidden')}" id="dm-funnel-panel"></div>
            </section>
        `;
    },

    /** Bring the toggle and the panel in line with `this.funnel`. Safe when the page is not on screen. */
    paintFunnel() {
        const toggle = document.getElementById('dm-funnel-toggle');
        const panel = document.getElementById('dm-funnel-panel');
        if (!toggle || !panel) return;
        const f = this.funnel;
        toggle.setAttribute('aria-expanded', f.open ? 'true' : 'false');
        if (toggle.classList) toggle.classList.toggle('is-open', f.open);
        if (panel.classList) panel.classList.toggle('hidden', !f.open);
        if (!f.open) {
            if (panel.innerHTML !== '') panel.innerHTML = '';
            return;
        }
        const focus = UI.captureFocus(panel);
        panel.innerHTML = esc(this.renderFunnel());
        UI.icons(panel);
        UI.restoreFocus(focus);
    },

    toggleFunnel() {
        const f = this.funnel;
        f.open = !f.open;
        this.paintFunnel();
        if (f.open && !f.loading && (!f.data || Date.now() - f.at > this.FUNNEL_STALE_MS)) this.loadFunnel(f.days);
    },

    setFunnelWindow(days) {
        const span = Number(days);
        if (!this.FUNNEL_WINDOWS.includes(span) || span === this.funnel.days) return Promise.resolve();
        return this.loadFunnel(span);
    },

    /**
     * Ask for `days` days and redraw when the answer lands. What was on screen stays until the answer replaces it (for the same period), and
     * an answer that comes after a newer question, or after the page was left, is dropped.
     */
    async loadFunnel(days) {
        const span = this.FUNNEL_WINDOWS.includes(days) ? days : 30;
        const seq = (this.funnel.seq || 0) + 1;
        const kept = this.funnel.days === span ? this.funnel.data : null;
        this.funnel = { ...this.funnel, days: span, data: kept, failed: false, loading: true, seq };
        this.paintFunnel();
        let data = null;
        let failed = false;
        try {
            data = await API.getDmFunnel(span);
        } catch (err) {
            console.error('Funnel Load Error:', err);
            failed = true;
        }
        if (this.funnel.seq !== seq) return;
        this.funnel = {
            ...this.funnel, data: failed ? null : data, loading: false, at: Date.now(),
            failed: failed || !data || typeof data !== 'object' || !Array.isArray(data.steps),
        };
        this.paintFunnel();
    },

    /** "67%", or "—" when there was nothing to divide by. */
    funnelPercent(pct) {
        return pct === null || pct === undefined || !Number.isFinite(Number(pct)) ? '—' : UI.formatPercent(Number(pct));
    },

    renderFunnel() {
        const f = this.funnel;
        return html`
            <div class="dm-funnel-body">
                <div class="segmented dm-funnel-window" role="group" aria-label="${t('inbox.funnel.windowLabel')}">
                    ${this.FUNNEL_WINDOWS.map((days) => html`
                        <button type="button" class="btn btn-sm btn-ghost" id="dm-funnel-window-${days}" data-action="inbox:funnelWindow" data-days="${days}"
                                aria-pressed="${f.days === days ? 'true' : 'false'}">${t('inbox.funnel.window', { count: days, n: UI.formatNumber(days) })}</button>
                    `)}
                </div>
                ${f.loading && !f.data ? html`<p class="form-hint" role="status">${t('common.loading')}</p>` : ''}
                ${!f.loading && f.failed ? html`
                    <p class="form-hint text-warning" role="alert">${t('inbox.funnel.failed')}</p>
                    ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'inbox:funnelRetry', id: 'dm-funnel-retry' })}
                ` : ''}
                ${f.data && !f.failed ? this.renderFunnelBody(f.data) : ''}
            </div>
        `;
    },

    /** A whole-number count the server sent, or 0 for anything else. */
    funnelCount(value) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    },

    /** One rate: its name, its percentage, and the numbers it is made of, so a small sample reads as a small sample. */
    funnelRate(labelKey, rate, ofKey) {
        const r = rate && typeof rate === 'object' ? rate : {};
        const count = this.funnelCount(r.count);
        const of = this.funnelCount(r.of);
        return html`
            <div class="dm-funnel-rate">
                <dt>${t(labelKey)}</dt>
                <dd><strong>${UI.ltr(this.funnelPercent(r.pct))}</strong>
                    <span class="dm-funnel-of">${t('inbox.funnel.of', { count: UI.formatNumber(count), total: UI.formatNumber(of), what: t(ofKey) })}</span></dd>
            </div>
        `;
    },

    renderFunnelBody(data) {
        const total = this.funnelCount(data.conversations);
        const days = this.funnelCount(data.days) || this.funnel.days;
        if (total === 0) {
            return html`
                <p class="form-hint">${t('inbox.funnel.empty', { count: days, n: UI.formatNumber(days) })}</p>
                ${this.renderFunnelVariants(data.variants)}
            `;
        }

        // The ids are the server's, but only the five this page knows are drawn, in its order: a word from a fixed table, never one from the response.
        const byId = new Map((Array.isArray(data.steps) ? data.steps : []).filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]));
        const rates = data.rates && typeof data.rates === 'object' ? data.rates : {};
        const outcomes = data.outcomes && typeof data.outcomes === 'object' ? data.outcomes : {};
        const reply = data.reply && typeof data.reply === 'object' ? data.reply : {};
        const clicks = data.clicks && typeof data.clicks === 'object' ? data.clicks : {};
        const sample = this.funnelCount(reply.sample);
        const time = (ms) => (ms !== null && ms !== undefined && Number.isFinite(Number(ms)) ? this.durationText(Number(ms)) || '—' : '—');
        const previews = this.funnelCount(clicks.preview);
        return html`
            <p class="form-hint">${t('inbox.funnel.intro', { count: days, n: UI.formatNumber(days) })}</p>
            <ol class="dm-funnel-steps">
                ${this.FUNNEL_STEPS.map((id) => {
                    const step = byId.get(id) || {};
                    const count = Math.min(this.funnelCount(step.count), total);
                    const pct = this.funnelPercent(Math.round((100 * count) / total));
                    const label = t(`inbox.funnel.step.${id}`);
                    const figure = `${UI.formatNumber(count)} · ${pct}`;
                    return html`
                        <li class="dm-funnel-step" data-step="${id}">
                            <span class="dm-funnel-label">${label}</span>
                            <span class="dm-funnel-count">${UI.ltr(figure)}</span>
                            <progress class="studio-meter" max="${total}" value="${count}" aria-label="${label}: ${figure}"></progress>
                        </li>
                    `;
                })}
            </ol>

            <dl class="dm-funnel-rates">
                ${this.funnelRate('inbox.funnel.rate.link', rates.link, 'inbox.funnel.of.recommended')}
                ${this.funnelRate('inbox.funnel.rate.click', rates.click, 'inbox.funnel.of.linked')}
                ${this.funnelRate('inbox.funnel.rate.handoff', rates.handoff, 'inbox.funnel.of.conversations')}
                ${this.funnelRate('inbox.funnel.rate.optOut', rates.opt_out, 'inbox.funnel.of.conversations')}
                <div class="dm-funnel-rate">
                    <dt>${t('inbox.funnel.reply.median')}</dt>
                    <dd><strong>${UI.ltr(time(reply.median_ms))}</strong>
                        <span class="dm-funnel-of">${sample > 0 ? t('inbox.funnel.reply.p90', { time: time(reply.p90_ms), count: sample, n: UI.formatNumber(sample) }) : t('inbox.funnel.reply.none')}</span></dd>
                </div>
            </dl>

            <ul class="dm-funnel-outcomes" aria-label="${t('inbox.funnel.outcomes')}">
                ${[['followUp', 'follow_up'], ['handoff', 'handoff'], ['closed', 'closed'], ['optedOut', 'opted_out'], ['complaints', 'complaints']].map(([key, field]) => html`
                    <li class="chip"><span>${t(`inbox.funnel.outcome.${key}`)}</span> <strong>${UI.num(this.funnelCount(outcomes[field]))}</strong></li>
                `)}
            </ul>

            <p class="form-hint">${t('inbox.funnel.previews', { count: previews, n: UI.formatNumber(previews) })}</p>

            ${this.renderFunnelVariants(data.variants)}
        `;
    },

    /**
     * One variant's rate: its name and, only when the arm has enough conversations (the SERVER's `enough`, which is its minimum-sample gate), its
     * percentage; with the numbers it is made of either way. Below the floor the percentage is a dash and the counts stand alone.
     */
    variantRate(labelKey, rate, ofKey, enough) {
        const r = rate && typeof rate === 'object' ? rate : {};
        const shown = enough && r.pct !== null && r.pct !== undefined && Number.isFinite(Number(r.pct));
        return html`
            <div class="dm-funnel-rate">
                <dt>${t(labelKey)}</dt>
                <dd><strong>${UI.ltr(shown ? this.funnelPercent(r.pct) : '—')}</strong>
                    <span class="dm-funnel-of">${t('inbox.funnel.of', { count: UI.formatNumber(this.funnelCount(r.count)), total: UI.formatNumber(this.funnelCount(r.of)), what: t(ofKey) })}</span></dd>
            </div>
        `;
    },

    /** One A/B arm: its letter and the owner's name for it, how many conversations it was given, and its two rates (or why it shows none yet). */
    renderFunnelArm(arm, need) {
        const slot = this.FUNNEL_VARIANT_SLOTS.includes(arm.id) ? arm.id : '';
        if (!slot) return '';
        const enough = arm.enough === true;
        const conversations = this.funnelCount(arm.conversations);
        const label = typeof arm.label === 'string' ? arm.label.trim() : '';
        const retired = arm.weight === 0;
        return html`
            <li class="dm-funnel-arm" data-arm="${slot}">
                <div class="dm-funnel-arm-head">
                    <strong class="dm-funnel-arm-name">
                        <span class="badge badge-accent">${UI.ltr(slot)}</span>
                        ${label ? html`<bdi dir="auto">${label}</bdi>` : html`<span>${t('inbox.funnel.variants.arm', { slot })}</span> <span class="dm-funnel-of">(${t('inbox.funnel.variants.removed')})</span>`}
                    </strong>
                    <span class="dm-funnel-of">${t('inbox.funnel.variants.conversations', { count: conversations, n: UI.formatNumber(conversations) })}${retired ? html` · ${t('inbox.funnel.variants.retired')}` : ''}</span>
                </div>
                <dl class="dm-funnel-rates">
                    ${this.variantRate('inbox.funnel.rate.link', arm.link, 'inbox.funnel.of.recommended', enough)}
                    ${this.variantRate('inbox.funnel.rate.click', arm.click, 'inbox.funnel.of.linked', enough)}
                </dl>
                ${enough ? '' : html`<p class="form-hint text-warning">${t('inbox.funnel.variants.notEnough', { have: UI.formatNumber(conversations), need: UI.formatNumber(need) })}</p>`}
            </li>
        `;
    },

    /**
     * The A/B comparison of the owner's wording variants (S14): present only when the server sent one (an experiment is saved, or a conversation was
     * given an arm). Counts and rates, the minimum-sample gate the server applied, and no word about which arm is better: nothing here claims more
     * than a count. The slots are a fixed table, the arms' names are the owner's text and go through the `html` tag.
     */
    renderFunnelVariants(variants) {
        if (!variants || typeof variants !== 'object' || !Array.isArray(variants.arms)) return '';
        const arms = variants.arms.filter((a) => a && typeof a === 'object' && this.FUNNEL_VARIANT_SLOTS.includes(a.id));
        if (arms.length === 0) return '';
        const need = this.funnelCount(variants.min_sample);
        return html`
            <section class="dm-funnel-variants" id="dm-funnel-variants" aria-labelledby="dm-funnel-variants-title">
                <div class="dm-funnel-variants-head">
                    <h4 id="dm-funnel-variants-title" aria-level="3" class="dm-funnel-variants-title">${t('inbox.funnel.variants.title')}</h4>
                    <span class="badge ${variants.running === true ? 'badge-success' : 'badge-neutral'}">${t(variants.running === true ? 'inbox.funnel.variants.running' : 'inbox.funnel.variants.stopped')}</span>
                </div>
                <p class="form-hint">${t('inbox.funnel.variants.intro')}</p>
                <ul class="dm-funnel-arms">${arms.map((arm) => this.renderFunnelArm(arm, need))}</ul>
                ${variants.comparable === true ? '' : html`<p class="form-hint">${t('inbox.funnel.variants.waiting', { need: UI.formatNumber(need) })}</p>`}
                <p class="form-hint">${t('inbox.funnel.variants.note')}</p>
            </section>
        `;
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
        const stages = copies.map((copy) => copy.stage);

        // Turning the AI on for a thread that was handed over ends the handoff, as the server does (`toggle-bot` moves the stage on);
        // a revert puts the stage back with the switch.
        const paint = (value, restore = false) => {
            copies.forEach((copy, i) => {
                copy.is_bot_active = value;
                if (restore) copy.stage = stages[i];
                else if (value && copy.stage === 'handoff') copy.stage = 'new';
            });
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
            revert: () => paint(previous, true),
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

    // ─── Mark handled ────────────────────────────────────────────────────────
    /**
     * Set (`handled` true) or clear the owner's "I took care of this" stamp on a thread. Optimistic, like the AI switch: the thread
     * leaves To do and every count in the same frame, the request goes out behind it, and the chosen stamp is parked in `pendingHandled`
     * so a poll that left before the write committed cannot bring the thread back for a tick. A refusal puts everything back and says why
     * in words (`UI.errorText`), not as a status code.
     *
     * The stamp it paints is never earlier than the customer's last message (`Attention.isHandled` compares the two), even when this
     * computer's clock is behind the server's; the server's own stamp replaces it when the answer arrives.
     *
     * @returns {Promise<boolean>} whether it was done
     */
    async setHandled(id, handled) {
        const copies = this.threadCopies(id);
        if (!id || copies.length === 0 || this.pendingHandled.has(id)) return false;
        const epoch = this._epoch;
        const lastInbound = Attention.lastInboundMs(copies[0]);
        const stamp = handled ? new Date(Math.max(Date.now(), (lastInbound === null ? 0 : lastInbound) + 1)).toISOString() : null;
        const previous = copies.map((copy) => (copy.handled_at === undefined ? null : copy.handled_at));
        const focus = UI.captureFocus(document.getElementById('page-container'));

        const paint = (values) => {
            copies.forEach((copy, i) => { copy.handled_at = values[i]; });
            this.renderThreads();
            this.reportWaiting();
            const thread = this.findThread(id);
            if (thread) this.updateChatHeader(thread);
            // Whatever had focus may have gone with the button that said "Mark handled": the row or the header's button takes it.
            UI.restoreFocus(focus, `thread-${id}`);
        };

        this.resetBackoff();
        this.pendingHandled.set(id, stamp);
        paint(copies.map(() => stamp));
        try {
            const result = await (handled ? API.markConversationHandled(id) : API.unmarkConversationHandled(id));
            if (epoch !== this._epoch) return true;
            const at = result && result.handled_at !== undefined ? result.handled_at : stamp;
            paint(copies.map(() => at));
            return true;
        } catch (err) {
            console.error('Mark Handled Error:', err);
            if (epoch === this._epoch) {
                paint(previous);
                UI.toast(UI.errorText(err).sentence, 'error');
            }
            return false;
        } finally {
            if (epoch === this._epoch) this.pendingHandled.delete(id);
        }
    },

    /** "Mark handled": done at once and undoable for a few seconds (a toast with Undo), and says what it will take to bring the thread back. */
    async markHandled(id) {
        if (!this.canMark()) return;
        const done = await this.setHandled(id, true);
        if (!done) return;
        UI.undoToast(t('inbox.handled.done'), { onUndo: () => this.setHandled(id, false) });
    },

    /** "Reopen": the thread is in the owner's To do again if it still needs a person. */
    async unmarkHandled(id) {
        if (!this.canMark()) return;
        const done = await this.setHandled(id, false);
        if (done) Motion.announce(t('inbox.handled.reopened'));
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
    markHandled: (el) => InboxPage.markHandled(el && el.dataset ? el.dataset.id : ''),
    unmarkHandled: (el) => InboxPage.unmarkHandled(el && el.dataset ? el.dataset.id : ''),
    toggleFunnel: () => InboxPage.toggleFunnel(),
    funnelWindow: (el) => InboxPage.setFunnelWindow(el && el.dataset ? el.dataset.days : ''),
    funnelRetry: () => InboxPage.loadFunnel(InboxPage.funnel.days),
});
