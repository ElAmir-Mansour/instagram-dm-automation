/**
 * Attention: the one set of rules for "does this conversation need a person?".
 *
 * Three screens used to answer that question with three different copies: the Overview counted threads where the AI is off and the
 * customer spoke last, the Inbox's nav badge counted those plus handed-over threads, and the Inbox's own count line counted only the
 * first. The badge then changed number with the page you were on, and a failure handoff (the bot could not write a reply) never reached
 * the screen the owner opens first (UX audit IN-03, OV-02). Every screen now calls the functions below, so they cannot drift.
 *
 * Every function is PURE: it reads the conversation-list item it is handed (a row of `GET /api/conversations`) and, where it needs
 * the clock or the AI settings, takes them as arguments. None of them touches the DOM, `App` or `I18N`, which is also why a test can
 * run them with no page at all. None uses `this`, so `threads.filter(Attention.needsHuman)` works.
 *
 * Fields read from a list item (all optional; a missing one means "no" rather than an error, so a database that is behind flags nothing):
 *   is_bot_active, last_message_direction, last_message_at, last_inbound_message_at, last_inbound_at, last_operator_at,
 *   stage, handoff_at, handoff_reason, last_intent, opted_out_at, link_clicks.clicks, handled_at, instagram_user_id.
 * `handled_at` is the "Mark handled" stamp (v45: `POST /api/conversations/:id/handled`, UX plan R-04). The list sends it as an ISO string, or null
 * for a thread nobody has marked, and a server that is behind sends none, which reads as not handled.
 *
 * Loaded in index.html straight after components.js, with the same `?v=`.
 */
const Attention = {
    /** Meta's standard messaging window: a reply is allowed for 24 h after the customer's last message (DM plan §2). */
    WINDOW_MS: 24 * 60 * 60 * 1000,

    /**
     * The Studio's items in a `GET /api/attention` answer (src/services/attention.ts, research USE-1 and USE-4): Claude signed out on the Mac, the
     * worker offline, TikTok drafts left in the inbox, clips waiting for review. The server sorts them (danger first, then the longest wait).
     */
    STUDIO_TYPES: ['mac_signed_out', 'worker_offline', 'tiktok_draft', 'reel_review'],

    /**
     * The items of an attention summary (`GET /api/attention`) whose type is one of `types`, in the server's order. Anything that is not an item with a
     * sentence and one action to a screen of this dashboard (`#/...`) is left out: what the server sends is data, and a link from a response never
     * reaches an `href` unchecked.
     */
    itemsOfType(summary, types) {
        const items = summary && Array.isArray(summary.items) ? summary.items : [];
        return items.filter((item) => item && types.indexOf(item.type) !== -1
            && item.sentence && typeof item.sentence.key === 'string'
            && item.action && typeof item.action.verb === 'string' && typeof item.action.href === 'string' && item.action.href.indexOf('#/') === 0);
    },

    /** The Studio's items of an attention summary, in the server's order. */
    studioItems(summary) {
        return Attention.itemsOfType(summary, Attention.STUDIO_TYPES);
    },

    /** `counts.studio` as a whole number: the Studio nav item's badge. 0 for a server that does not send it. */
    studioCount(summary) {
        const n = summary && summary.counts ? Math.floor(Number(summary.counts.studio)) : NaN;
        return Number.isFinite(n) && n > 0 ? n : 0;
    },

    /** The sentence's values for `t()`: numbers formatted with `format` (the page's own number formatter), the rest as text. Pure. */
    studioParams(item, format) {
        const out = {};
        const params = item && item.sentence && item.sentence.params && typeof item.sentence.params === 'object' ? item.sentence.params : {};
        Object.keys(params).forEach((key) => {
            const value = params[key];
            out[key] = typeof value === 'number' ? format(value) : String(value);
        });
        return out;
    },

    /** The one tone of a Studio item on screen: what is broken is danger, what is late is warning, what is merely waiting is info. */
    studioLevel(item) {
        return item && (item.severity === 'danger' || item.severity === 'warning') ? item.severity : 'info';
    },

    /** The customer spoke last and nobody is going to answer unless a human does: the AI is off for this thread and the last message is theirs. */
    isWaiting(thread) {
        return !!thread && thread.is_bot_active === false && thread.last_message_direction === 'inbound';
    },

    /**
     * The bot handed this conversation to a person and nobody has answered yet: a refund, a complaint, "I want to talk to someone" (the
     * bot is PAUSED for these), or a reply that could not be written at all, because the model was down (the bot is left ON, so the
     * customer's next message gets a normal reply: DM plan §8, S8). The bot being on or off is therefore not part of the answer, which is
     * why handoffs and failure handoffs are one test here. `stage` and `handoff_at` are the v39 columns, so a database that is behind flags
     * nothing. `last_operator_at` is the owner's last reply, from here or from the Instagram app: a reply after the handoff ends it. So
     * does turning the AI back on (the server moves the stage on: `toggle-bot`), and so does the bot's own next turn in the sales flow,
     * which leaves the `handoff` stage by answering.
     */
    isHandoff(thread) {
        if (!thread || thread.stage !== 'handoff') return false;
        const handedAt = Date.parse(thread.handoff_at);
        const answeredAt = Date.parse(thread.last_operator_at);
        return !(Number.isFinite(handedAt) && Number.isFinite(answeredAt) && answeredAt >= handedAt);
    },

    /**
     * A thread worth the owner's attention first (DM plan §8, "Hot"): a PERSON opened the link we sent (`link_clicks.clicks` leaves out
     * preview crawlers and prefetches), or their last message said they are ready to buy, or the bot flagged it a hot lead. Not for someone
     * who has asked to be left alone or has been closed: a click from before that is not a lead any more. The v39 columns and the click
     * counts are read as they come, so a database that is behind has no hot threads rather than an error.
     */
    isHot(thread) {
        if (!thread) return false;
        if (thread.stage === 'closed' || thread.opted_out_at) return false;
        if (thread.last_intent === 'ready_to_buy' || thread.handoff_reason === 'hot_lead') return true;
        const clicks = thread.link_clicks && typeof thread.link_clicks === 'object' ? Number(thread.link_clicks.clicks) : 0;
        return Number.isFinite(clicks) && clicks > 0;
    },

    /**
     * The newest message the CUSTOMER sent, in epoch milliseconds, or null when the item names none. The list item carries it in up to
     * three places (the v39 `last_inbound_at` is stamped only by a sales turn, so it can be old; `last_inbound_message_at` is read from
     * `messages`; and the last message itself may be the inbound one), and the newest of them is the truth.
     */
    lastInboundMs(thread) {
        if (!thread) return null;
        const candidates = [Date.parse(thread.last_inbound_message_at), Date.parse(thread.last_inbound_at)];
        if (thread.last_message_direction === 'inbound') candidates.push(Date.parse(thread.last_message_at));
        const known = candidates.filter((ms) => Number.isFinite(ms));
        return known.length === 0 ? null : Math.max(...known);
    },

    /**
     * The owner marked this thread handled (`handled_at`) and the customer has not written since. A newer inbound message ends it by
     * itself, whatever the server did, so a customer who asks again re-enters the queue even if the stamp was not cleared (UX plan R-04).
     * False for an item with no `handled_at`, which is every item until that column ships.
     */
    isHandled(thread) {
        if (!thread) return false;
        const handledAt = Date.parse(thread.handled_at);
        if (!Number.isFinite(handledAt)) return false;
        const inboundAt = Attention.lastInboundMs(thread);
        return inboundAt === null || inboundAt <= handledAt;
    },

    /**
     * A person has to act: the thread is waiting for a reply, or handed over, and nobody has marked it handled since the customer last
     * wrote. These are the threads the nav badge counts and the 24 h window is counted down on.
     */
    needsHuman(thread) {
        return (Attention.isWaiting(thread) || Attention.isHandoff(thread)) && !Attention.isHandled(thread);
    },

    /**
     * Milliseconds left of Meta's 24 h window, counted from the customer's LAST message (`last_inbound_message_at`, read from
     * `messages`: the v39 `last_inbound_at` is stamped only by a sales turn, so it is old for a customer who wrote again after the
     * bot was paused). 0 once it has closed; null when there is no such message. `now` is a parameter so a test, or a screen drawing a
     * whole list from one reading of the clock, gets the same answer for every row.
     */
    windowLeftMs(thread, now = Date.now()) {
        if (!thread) return null;
        const at = Date.parse(thread.last_inbound_message_at || thread.last_inbound_at);
        if (!Number.isFinite(at)) return null;
        return Math.max(0, Math.min(Attention.WINDOW_MS, at + Attention.WINDOW_MS - now));
    },

    /**
     * When a reply typed in the Inbox stops being accepted, in ms, or null when nobody knows (the customer has not written). It is the SERVER's
     * rule, sent as `reply_window_ends_at` (`src/services/replyWindow.ts`: 24 h from the customer's last message, or an ad conversation's longer
     * window when the owner switched that on), because the server refuses a send past it. A copy of the list from before the field existed has
     * only the last message, and gets the standard 24 hours from it. `windowLeftMs` is the same standard count and stays what the rows' countdown
     * and the nav badge read; this is what the composer reads.
     */
    replyWindowEndsMs(thread) {
        if (!thread) return null;
        const given = Date.parse(thread.reply_window_ends_at);
        if (Number.isFinite(given)) return given;
        const at = Date.parse(thread.last_inbound_message_at || thread.last_inbound_at);
        return Number.isFinite(at) ? at + Attention.WINDOW_MS : null;
    },

    /** Milliseconds left to reply from the Inbox, 0 once past, null when not known. See `replyWindowEndsMs`. */
    replyWindowLeftMs(thread, now = Date.now()) {
        const ends = Attention.replyWindowEndsMs(thread);
        return ends === null ? null : Math.max(0, ends - now);
    },

    /**
     * A reply from here can no longer reach this customer: Instagram or Facebook, and the window is known to have closed. Never true for WhatsApp
     * (its window is its own, and the server answers it), nor for a thread whose last customer message is not known.
     */
    replyClosed(thread, now = Date.now()) {
        if (!thread || thread.platform === 'whatsapp') return false;
        return Attention.replyWindowLeftMs(thread, now) === 0;
    },

    /**
     * Who would answer this thread's next message, as one word (UX audit IN-02). `aiSettings` is `GET /api/settings/ai`
     * (`is_active`, `sales_mode`, `sales_test_senders`), or null while it has not been read.
     *
     *   off_global     the whole assistant is switched off: nobody answers anyone, whatever this thread says. It outranks a per-thread
     *                  pause because turning that thread's AI back on would change nothing.
     *   paused_thread  the assistant is on, but not for this thread (the owner took it over, or the bot handed it over).
     *   sales_live     the sales assistant answers every follower (sales mode `on`).
     *   sales_test     the sales assistant answers only listed test senders, and this is one of them.
     *   on             the ordinary reply path.
     *
     * With no settings the global switch and the sales mode are unknown, so the thread's own switch is the only thing that can be said
     * (`paused_thread` or `on`): an unread setting is never reported as off.
     */
    effectiveAi(thread, aiSettings) {
        const settings = aiSettings && typeof aiSettings === 'object' ? aiSettings : null;
        if (settings && settings.is_active === false) return 'off_global';
        if (thread && thread.is_bot_active === false) return 'paused_thread';
        if (!settings) return 'on';
        if (settings.sales_mode === 'on') return 'sales_live';
        if (settings.sales_mode === 'test') {
            const senders = Array.isArray(settings.sales_test_senders) ? settings.sales_test_senders.map(String) : [];
            if (thread && thread.instagram_user_id !== undefined && thread.instagram_user_id !== null && senders.includes(String(thread.instagram_user_id))) return 'sales_test';
        }
        return 'on';
    },
};
