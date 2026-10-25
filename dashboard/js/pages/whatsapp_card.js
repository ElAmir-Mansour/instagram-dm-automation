/**
 * Settings → WhatsApp (docs/specs/001-whatsapp-agent, T025): connect a number, see its health and the free-replies meter, choose who the
 * assistant answers, and decide whether Meta may charge for replies beyond the free ones. The routes are `src/routes/whatsapp.ts`.
 *
 * Not a route. The Settings page loads this module on first use (`App.loadPageModule('whatsapp_card')`, like `ice_breakers`) and calls
 * `section()` with the server's answer; every later change repaints the card's own element, never the whole page, so a half-typed test
 * sender survives it.
 *
 * What is shown, by state:
 *   not connected   what to do on Meta's side, and the form: WABA id, phone number id, access token, Connect (the owner's)
 *   connected       the number, its verified name, a test-number badge, status / quality / limit chips, the free-replies meter with its
 *                   estimated cost, Refresh and Disconnect (which asks first), then the agent's mode and test senders, then billing
 *   needs reconnect Meta refused the stored token: the same, with the reason and the connect form again
 * Members who are not the owner see the same state, read only.
 *
 * ── Entry points (T052 / T053) ──
 * A connected number also draws two sections the card reads from Meta by itself, once it is in the page (`section()` starts the reads in a
 * microtask, after Settings has put the markup in the document; nothing is read for a number that is not connected, and nothing is read
 * while drawing):
 *   campaign links  `GET/POST /entry-links`, `DELETE /entry-links/:code`: each link is a short `wa.me` address and a QR image that open a chat
 *                   with a first message the owner wrote (the server appends a tracking code), listed with Copy, Download and Delete
 *   ice breakers    `GET/PUT /ice-breakers`: up to four one-line questions a customer can tap in a new chat, edited as four fields
 * Both read and write at Meta, so each shows what Meta holds (`PUT` answers with it) and never what was typed. Their limits are checked here
 * first (`validateLink`, `checkPrompts`: the server's own, so a typo costs no round trip); the server checks again. The owner writes, members
 * read. Every code they can answer with (`ENTRY_POINT_ERROR_CODES` in the service) has a sentence in `wa.err.<code>` in both languages.
 *
 * ── The access token ──
 * It is typed into a password input that has no `name` (nothing could ever serialise it into an address), is read ONCE in `connect()`
 * into a local variable, and the input is emptied in the same breath, before the request leaves. The module never stores it: not in its
 * state, not in the markup it draws, not in `localStorage`, not in a toast or a log line. A refused connect repaints the form from the
 * non-secret fields only, so the token field comes back empty and the owner pastes it again. The server never sends it back either.
 *
 * ── Words ──
 * Every refusal the server can make has a sentence in `wa.err.<code>` in both languages (`describe()`); Meta's own English words, when the
 * server passes them along, are shown beneath it as the reason. Everything that came from a person or from Meta goes through the `html` tag.
 */
const WhatsAppCard = {
    /** The server's last answer (`GET /api/whatsapp/connection`), or null. */
    state: null,
    /** The connect form's NON-secret fields, kept across repaints. The token is deliberately not here: see the header. */
    form: { waba: '', phone: '' },
    /** The agent editor's own copy: the mode chosen and the test senders as typed, one per line. */
    draft: { mode: 'off', senders: '' },
    /** The last refusal of each part of the card: `{ code, message, hint, field }`. */
    errors: { connect: null, agent: null, billing: null, header: null, linkForm: null, ice: null },
    /**
     * Which request is in flight: 'connect' | 'refresh' | 'disconnect' | 'agent' | 'billing' | 'linkCreate' | 'linkDelete' | 'iceSave' | null.
     * Every button is off while one is. The two READS of the entry points are not in this list: they take nothing off.
     */
    busy: null,
    /**
     * What Meta holds for the number's entry points, as last read. `status` is 'idle' (not asked yet) | 'loading' | 'ready' | 'error'.
     * links: `items` are `GET /entry-links` rows. ice: `held` is the list of questions Meta holds, `limits` Meta's limits as the server sent
     * them, `notice` a line about the last save that is not the save ('unverified' | 'mismatch' | '').
     */
    entry: null,
    /** The new-link form's own copy, kept across repaints. */
    linkForm: { label: '', prefill: '' },
    /** The ice breakers editor's own copy, one string per field. */
    iceDraft: [],
    /** Bumped by every `init()` and `resetTenantState()`: an answer to a read started before one is not applied after it. */
    gen: 0,
    /** The reads of the entry points that are in flight, so a caller (and a test) can wait for them. */
    entryLoading: null,
    /** The value the paid-messages switch is being set to while that request is out, so the switch does not flicker back; null otherwise. */
    billingWanted: null,

    /** The two permissions the token needs (the server checks both with `debug_token`). */
    SCOPES: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    /** The same shapes the server checks, so a typo costs no round trip and the token goes nowhere until it looks like one. */
    META_ID: /^\d{5,32}$/,
    TOKEN_SHAPE: /^[\x21-\x7E]{20,2000}$/,
    /** A WhatsApp user id (`EG.123…`, `US.ENT.…`) or a phone number in international digits. The phone check is the server's plus "never starts with 0" (no country code does). */
    BSUID: /^[A-Z]{2}\.[A-Za-z0-9.]{1,125}$/,
    PHONE: /^[1-9]\d{7,14}$/,
    MAX_SENDERS: 20,
    MODES: ['off', 'test', 'everyone'],

    /**
     * Every `code` (or machine-word `error`) the routes send, with the editor field it is about ('' when it is about none). Each has a
     * sentence in `wa.err.<code>`; `whatsappCard.test.ts` reads the route file and fails if one is missing here. A null-prototype table:
     * the key comes from the server, and a plain `{}` answers 'constructor' with a function.
     */
    ERRORS: (() => Object.freeze(Object.assign(Object.create(null), {
        invalid_waba_id: 'wa-waba',
        invalid_phone_number_id: 'wa-phone',
        invalid_access_token: 'wa-token',
        token_refused: 'wa-token',
        missing_scopes: 'wa-token',
        number_unreadable: 'wa-phone',
        subscribe_failed: 'wa-waba',
        number_in_use: 'wa-phone',
        meta_unreachable: '',
        meta_refused: '',
        not_connected: '',
        invalid_mode: '',
        invalid_test_senders: 'wa-senders',
        invalid_allow_billable: '',
        invalid_free_tier_alert_at: '',
        go_live_not_ready: '',
        agent_not_configured: '',
        migration_pending: '',
    })))(),

    /** The refusals whose reason is Meta's own words (or the server's precise sentence), shown beneath ours. */
    HINT_FROM_SERVER: [
        'token_refused', 'missing_scopes', 'number_unreadable', 'subscribe_failed', 'meta_refused', 'invalid_test_senders',
        'qr_refused', 'ice_breakers_refused', 'entry_links_unreadable', 'ice_breakers_unreadable',
    ],

    /** What stands between the owner and mode `everyone`, as the server names it (`go_live.missing`): each has a phrase in `wa.golive.<item>`. */
    GO_LIVE_ITEMS: ['active_connection', 'not_test_number', 'public_pages', 'provider_allow_list'],

    /**
     * The entry points' limits, the server's own (`ENTRY_LABEL_MAX_CHARS`, `ENTRY_PREFILL_MAX_CHARS`, Meta's ice breaker limits). Lengths are
     * JavaScript string lengths, as the server counts them, and the inputs' `maxlength` counts the same way. The ice breaker and command
     * limits are replaced by what `GET /ice-breakers` says (`limits()`), so a change at Meta is not a second copy here.
     */
    LABEL_MAX: 60,
    PREFILL_MAX: 120,
    ICE_MAX: 4,
    ICE_CHARS: 80,
    COMMANDS_MAX: 30,
    COMMAND_NAME_MAX: 32,
    COMMAND_DESCRIPTION_MAX: 256,
    /** An emoji or a pictographic symbol: the server's `hasEmoji` (`©`, `®` and `™` are plain text), so the check here refuses what it would. */
    EMOJI: /(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\uFE0F\u20E3]/u,

    /**
     * Every `code` the entry-point routes answer with (`ENTRY_POINT_ERROR_CODES` in `whatsappEntryLinks.ts`: the routes' own and each validator's),
     * with the field it is about ('' for none). Each has a sentence in `wa.err.<code>` in both languages. A separate table from `ERRORS`: that one
     * is checked against the connection routes' file, this one against the service's list (`whatsappEntryCard.test.ts`).
     */
    ENTRY_ERRORS: (() => Object.freeze(Object.assign(Object.create(null), {
        entry_links_unreadable: '',
        ice_breakers_unreadable: '',
        qr_refused: '',
        ice_breakers_refused: '',
        not_confirmed: '',
        not_found: '',
        invalid_code: '',
        invalid_label: 'wa-link-label',
        label_too_long: 'wa-link-label',
        invalid_prefill: 'wa-link-prefill',
        prefill_too_long: 'wa-link-prefill',
        invalid_prompts: '',
        too_many_prompts: '',
        prompt_too_long: '',
        prompt_has_emoji: '',
        invalid_commands: '',
        too_many_commands: '',
        invalid_command_name: '',
        command_name_too_long: '',
        invalid_command_description: '',
        command_description_too_long: '',
        command_has_emoji: '',
        duplicate_command: '',
    })))(),

    /** Which limit a code's sentence names as `{max}`. */
    LIMIT_OF: (() => Object.freeze(Object.assign(Object.create(null), {
        label_too_long: 'label',
        prefill_too_long: 'prefill',
        too_many_prompts: 'prompts',
        prompt_too_long: 'promptChars',
        too_many_commands: 'commands',
        command_name_too_long: 'commandName',
        command_description_too_long: 'commandDescription',
    })))(),

    /** Meta's words for the number's status and quality, each with the tone that says whether to look at it. Words in `wa.numberStatus.<X>` / `wa.quality.<X>`. */
    NUMBER_STATUS: (() => Object.freeze(Object.assign(Object.create(null), {
        CONNECTED: 'success', FLAGGED: 'warning', RESTRICTED: 'danger', PENDING: 'warning', UNVERIFIED: 'warning',
        DISCONNECTED: 'danger', DELETED: 'danger', BANNED: 'danger', MIGRATED: 'neutral', UNKNOWN: 'neutral',
    })))(),
    QUALITY: (() => Object.freeze(Object.assign(Object.create(null), {
        GREEN: 'success', YELLOW: 'warning', RED: 'danger', UNKNOWN: 'neutral',
    })))(),
    /** The name review's states that need the owner's attention; the happy ones are not shown. Words in `wa.nameStatus.<X>`. */
    NAME_STATUS: (() => Object.freeze(Object.assign(Object.create(null), {
        PENDING_REVIEW: 'warning', DECLINED: 'danger', EXPIRED: 'danger',
    })))(),
    /** A tone's glyph: a shape, so the colour is never the only signal. */
    GLYPHS: (() => Object.freeze(Object.assign(Object.create(null), {
        success: '●', warning: '▲', danger: '✕', neutral: '○',
    })))(),

    // ─── State ────────────────────────────────────────────────────────────────────────────

    /** Start from what the server said. The connect form's typed ids survive; everything else starts clean. */
    init(state) {
        this.errors = { connect: null, agent: null, billing: null, header: null, linkForm: null, ice: null };
        this.busy = null;
        this.billingWanted = null;
        this.resetEntry();
        this.linkForm = { label: '', prefill: '' };
        this.apply(state, true);
    },

    /** Nothing known about the entry points: they are asked for again (`loadEntry`), and an answer to a read begun before this is dropped. */
    resetEntry() {
        this.gen += 1;
        this.entry = {
            links: { status: 'idle', items: [], error: null },
            ice: { status: 'idle', held: [], limits: null, notice: '', error: null },
        };
        this.iceDraft = [];
        this.entryLoading = null;
    },

    /** Take a server answer as the state; `resetDraft` also takes the agent editor's copy from it (a save, a connect), as opposed to keeping what is typed. */
    apply(state, resetDraft) {
        this.state = state && typeof state === 'object' ? state : null;
        if (resetDraft) this.draftFrom(this.state);
        // A number that no longer works has no entry points to show; when it works again they are read again, not shown from before.
        if (!this.entryReady()) this.resetEntry();
    },

    draftFrom(state) {
        const s = state || {};
        this.draft = {
            mode: this.MODES.includes(s.mode) ? s.mode : 'off',
            senders: Array.isArray(s.test_senders) ? s.test_senders.filter((x) => typeof x === 'string').join('\n') : '',
        };
    },

    /** A tenant switch: nothing of the previous account's number, senders or typed ids stays. */
    resetTenantState() {
        this.state = null;
        this.form = { waba: '', phone: '' };
        this.draft = { mode: 'off', senders: '' };
        this.errors = { connect: null, agent: null, billing: null, header: null, linkForm: null, ice: null };
        this.busy = null;
        this.billingWanted = null;
        this.resetEntry();
        this.linkForm = { label: '', prefill: '' };
    },

    /** A connection exists, whether it works or Meta refused it (the server calls a disowned one `revoked`). */
    live() { return !!(this.state && (this.state.connected || this.state.status === 'invalid')); },

    needsReconnect() { return !!(this.state && !this.state.connected && this.state.status === 'invalid'); },

    /** The tenant's owner writes; everyone else reads. The server enforces it too. */
    canWrite() { return App.canAdminister(); },

    // ─── Words ────────────────────────────────────────────────────────────────────────────

    /**
     * `t(key, params)` with ONE value isolated as Latin text, the rest of the sentence left to flow in the page's direction. Isolating the
     * whole translated sentence isolated the Arabic words too, and its own punctuation landed at the wrong end (see `SettingsPage.ltrIn`).
     */
    ltrIn(key, params, name) {
        const MARK = '\u0000';
        const parts = t(key, Object.assign({}, params, { [name]: MARK })).split(MARK);
        if (parts.length !== 2) return t(key, params);
        return html`${parts[0]}${UI.ltr(params[name])}${parts[1]}`;
    },

    /** The code of a refusal, whichever way the server spelled it: `code`, or the machine word it put in `error` (`go_live_not_ready`, `not_connected`), or a pending migration. */
    codeOf(err) {
        if (!err) return '';
        const body = err.body && typeof err.body === 'object' ? err.body : {};
        if (body.migrationPending) return 'migration_pending';
        if (typeof err.code === 'string' && err.code) return err.code;
        if (typeof body.code === 'string' && body.code) return body.code;
        const word = typeof body.error === 'string' ? body.error : '';
        return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(word) ? word : '';
    },

    /** The server's own sentence for a refusal (Meta's words, or our precise English), or ''. A bare machine word is not a sentence. */
    serverWords(err) {
        const body = err && err.body && typeof err.body === 'object' ? err.body : {};
        const said = typeof body.error === 'string' && /\s/.test(body.error) ? body.error : (typeof body.message === 'string' ? body.message : '');
        return said.trim().slice(0, 300);
    },

    /** What `go_live.missing` lists, as one phrase in this language. */
    missingText(items) {
        const words = (Array.isArray(items) ? items : []).filter((x) => typeof x === 'string').map((x) => {
            const key = `wa.golive.${x}`;
            const said = this.GO_LIVE_ITEMS.includes(x) ? t(key) : key;
            return said === key ? x : said;
        });
        if (words.length === 0) return '';
        try { return new Intl.ListFormat(I18N.locale(), { style: 'long', type: 'conjunction' }).format(words); } catch { return words.join(', '); }
    },

    /**
     * A failed request as `{ code, message, hint, field }`: the sentence for the code in this language, Meta's words beneath it as the
     * reason when the server passed them, and the field to mark. A refusal the table does not know shows the server's message, or the
     * generic one: never a raw key and never "undefined".
     */
    describe(err) {
        const code = this.codeOf(err);
        const own = (table) => !!code && Object.prototype.hasOwnProperty.call(table, code);
        if (own(this.ERRORS) || own(this.ENTRY_ERRORS)) {
            let hint = this.HINT_FROM_SERVER.includes(code) ? this.serverWords(err) : '';
            if (code === 'go_live_not_ready') {
                const body = err.body && typeof err.body === 'object' ? err.body : {};
                const missing = this.missingText(body.missing);
                hint = missing ? t('wa.golive.missing', { items: missing }) : '';
            }
            const field = own(this.ERRORS) ? this.ERRORS[code] : this.ENTRY_ERRORS[code];
            const limit = this.LIMIT_OF[code];
            const message = limit ? t(`wa.err.${code}`, { max: this.limits()[limit] }) : t(`wa.err.${code}`);
            return { code, message, hint, field: field || null };
        }
        return { code: '', message: (err && err.message) || t('common.error'), hint: '', field: null };
    },

    /** The entry points' limits now: the server's, once `GET /ice-breakers` has answered, else the ones written above. */
    limits() {
        const l = this.entry && this.entry.ice.limits ? this.entry.ice.limits : {};
        const n = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
        return {
            label: this.LABEL_MAX,
            prefill: this.PREFILL_MAX,
            prompts: n(l.prompts, this.ICE_MAX),
            promptChars: n(l.prompt_chars, this.ICE_CHARS),
            commands: n(l.commands, this.COMMANDS_MAX),
            commandName: n(l.command_name_chars, this.COMMAND_NAME_MAX),
            commandDescription: n(l.command_description_chars, this.COMMAND_DESCRIPTION_MAX),
        };
    },

    /** The reason beneath a sentence, in its own direction: Meta's English sits left to right inside an Arabic page. */
    hintMarkup(hint) {
        return hint ? html`<bdi dir="auto">${hint}</bdi>` : '';
    },

    /** A refusal as an error strip with room around it, or nothing at all: the live region that holds it takes no space while it is empty. `above` adds room on top. */
    errorBlock(err, id, above) {
        if (!err) return '';
        return html`<div class="mbe-3 ${above ? html.raw('mbs-4') : ''}">${UI.errorStrip(err.message, this.hintMarkup(err.hint), id)}</div>`;
    },

    /** "$0.04": an amount in US dollars, in Latin digits. A value that is not a number is a dash. */
    usd(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '—';
        return `$${n.toFixed(2)}`;
    },

    /** Meta's tier name as a count of contacts: TIER_250 -> 250, TIER_1K -> 1,000, TIER_100K -> 100,000. Null for a name this does not read. */
    tierCount(tier) {
        const m = /^TIER_(\d+)(K?)$/.exec(String(tier || ''));
        if (!m) return null;
        return Number(m[1]) * (m[2] === 'K' ? 1000 : 1);
    },

    // ─── Test senders ─────────────────────────────────────────────────────────────────────

    /**
     * The editor's text as a list the server takes: one entry per line or comma, a phone number as people write it (+20 100 123 4567) reduced
     * to digits, duplicates dropped. Anything that is neither a phone number nor a WhatsApp user id is named in `invalid`, never dropped:
     * a typo must not quietly leave off the one number the owner meant to test with. The server validates again.
     */
    parseSenders(text) {
        const senders = [];
        const invalid = [];
        for (const raw of String(text || '').split(/[\n,;،]+/)) {
            let value = raw.trim();
            if (!value) continue;
            if (/^\+?[\d\s().-]+$/.test(value)) value = value.replace(/\D/g, '');
            if (!(this.BSUID.test(value) || this.PHONE.test(value))) { invalid.push(raw.trim()); continue; }
            if (!senders.includes(value)) senders.push(value);
        }
        return { senders, invalid };
    },

    /** The agent editor differs from what the server holds. */
    agentDirty() {
        const s = this.state || {};
        const saved = Array.isArray(s.test_senders) ? s.test_senders : [];
        const typed = this.parseSenders(this.draft.senders);
        if (typed.invalid.length > 0) return true;
        return this.draft.mode !== (this.MODES.includes(s.mode) ? s.mode : 'off') || typed.senders.join('\n') !== saved.join('\n');
    },

    // ─── Entry points: what is checked here, and what Meta holds ──────────────────────────

    /** An address that may be put in an `href` or a `src`: `https` only, and nothing `safeUrl` refuses. Anything else is ''. */
    httpsUrl(value) {
        const url = typeof value === 'string' ? safeUrl(value) : '';
        return /^https:\/\//i.test(url) ? url : '';
    },

    /**
     * The new-link form checked the way the server checks it (`parseEntryLinkInput`), in the same order. Returns the trimmed values, or the code of
     * the first thing wrong. A value is never shortened: over the limit is an error that names it.
     */
    validateLink(input) {
        const raw = input && typeof input === 'object' ? input : {};
        const label = typeof raw.label === 'string' ? raw.label.trim() : '';
        const prefill = typeof raw.prefill === 'string' ? raw.prefill.trim() : '';
        const l = this.limits();
        if (!label) return { code: 'invalid_label' };
        if (label.length > l.label) return { code: 'label_too_long' };
        if (!prefill) return { code: 'invalid_prefill' };
        if (prefill.length > l.prefill) return { code: 'prefill_too_long' };
        return { value: { label, prefill } };
    },

    /**
     * The ice breaker fields checked the way the server checks them (`parseConversationalAutomation`): blank fields are dropped, each question is
     * trimmed and must fit and carry no emoji, and there are at most as many as Meta allows. Returns `{ prompts }`, or `{ prompts, problem }` with
     * the code and the number (1-based) of the field it is about, so the owner is shown which one.
     */
    checkPrompts(fields) {
        const l = this.limits();
        const prompts = [];
        const list = Array.isArray(fields) ? fields : [];
        for (let i = 0; i < list.length; i++) {
            const prompt = typeof list[i] === 'string' ? list[i].trim() : '';
            if (!prompt) continue;
            if (prompt.length > l.promptChars) return { prompts, problem: { code: 'prompt_too_long', n: i + 1 } };
            if (this.EMOJI.test(prompt)) return { prompts, problem: { code: 'prompt_has_emoji', n: i + 1 } };
            prompts.push(prompt);
        }
        if (prompts.length > l.prompts) return { prompts, problem: { code: 'too_many_prompts', n: 0 } };
        return { prompts };
    },

    /** The ice breaker fields as they are now, as the list Meta would be sent, and whether it differs from what Meta holds. */
    iceDirty() {
        const held = this.entry.ice.held;
        const typed = this.checkPrompts(this.iceDraft);
        if (typed.problem) return true;
        return typed.prompts.length !== held.length || typed.prompts.some((p, i) => p !== held[i]);
    },

    /** One field per question Meta allows, filled from the list (more fields than Meta allows are never made, and none is lost). */
    iceFields(prompts) {
        const size = Math.max(this.limits().prompts, prompts.length);
        return Array.from({ length: size }, (_, i) => prompts[i] || '');
    },

    /** Rows the server sent, reduced to what the card draws: a row with no code is dropped, a value of the wrong type is empty. */
    cleanLinks(rows) {
        const text = (v) => (typeof v === 'string' ? v : '');
        return (Array.isArray(rows) ? rows : [])
            .filter((r) => r && typeof r === 'object' && typeof r.code === 'string' && r.code)
            .map((r) => ({
                code: r.code,
                label: typeof r.label === 'string' && r.label.trim() ? r.label : '',
                ref: text(r.ref),
                prefill: text(r.prefill),
                url: this.httpsUrl(r.url),
                qr: this.httpsUrl(r.qr_image_url),
                conversations: Number.isInteger(r.conversations) && r.conversations >= 0 ? r.conversations : null,
            }));
    },

    /** The entry points are Meta's objects of a number that works: a number whose token Meta refused has none to read. */
    entryReady() { return !!(this.state && this.state.connected === true); },

    /**
     * Ask Meta for what is not known yet (both parts, or `force` for both again). Returns a promise that settles when the reads have: the
     * ones already in flight are not asked twice. A part that fails says so in its own section and the other is unaffected.
     */
    loadEntry(force) {
        if (!this.entryReady()) {
            this.resetEntry();
            return Promise.resolve();
        }
        const { links, ice } = this.entry;
        const gen = this.gen;
        const parts = [];
        if (force || links.status === 'idle') parts.push(this.loadLinks(gen));
        if (force || ice.status === 'idle') parts.push(this.loadIce(gen));
        if (parts.length === 0) return this.entryLoading || Promise.resolve();
        const all = Promise.all(parts).then(() => { if (this.entryLoading === all) this.entryLoading = null; });
        this.entryLoading = all;
        return all;
    },

    /**
     * `GET /entry-links`. `gen` is the generation it was asked in: an answer from before a tenant switch or a redraw is dropped. `focus` is where
     * focus goes after the repaint when the owner pressed a button to ask (the first read, started by the card itself, never moves focus).
     */
    async loadLinks(gen, focus) {
        const links = this.entry.links;
        links.status = 'loading';
        links.error = null;
        let answer = null;
        let failure = null;
        try {
            answer = await API.getWhatsAppEntryLinks();
        } catch (err) {
            failure = err;
        }
        if (gen !== this.gen) return;
        if (failure) {
            links.status = 'error';
            links.error = this.describe(failure);
        } else {
            links.status = 'ready';
            links.items = this.cleanLinks(answer);
        }
        this.paintLinks(focus);
    },

    /** `GET /ice-breakers`: what Meta holds, and Meta's limits. `gen` and `focus` as for `loadLinks`. */
    async loadIce(gen, focus) {
        const ice = this.entry.ice;
        ice.status = 'loading';
        ice.error = null;
        let answer = null;
        let failure = null;
        try {
            answer = await API.getWhatsAppIceBreakers();
        } catch (err) {
            failure = err;
        }
        if (gen !== this.gen) return;
        if (failure) {
            ice.status = 'error';
            ice.error = this.describe(failure);
        } else {
            // Meta's answer replaces the ice breaker fields: it is what is held.
            this.takeIce(answer);
            ice.status = 'ready';
            ice.notice = '';
        }
        this.paintIce(focus);
    },

    /**
     * Redraw ONLY the list of links, when a read finished: the rest of the card, and whatever is typed in it (the new-link form, the senders,
     * the ice breaker fields), is not touched, so a read that comes back while the owner types costs them nothing.
     */
    paintLinks(focus) {
        const host = document.getElementById('wa-links-list');
        if (!host) return;
        const token = UI.captureFocus(host);
        host.innerHTML = esc(this.linksListMarkup());
        UI.icons(host);
        UI.restoreFocus(token, this.focusFallback(token, focus));
    },

    /** Redraw ONLY the ice breakers' block (see `paintLinks`). The fields in it were replaced by what Meta holds. */
    paintIce(focus) {
        const host = document.getElementById('wa-ice');
        if (!host) return;
        const token = UI.captureFocus(host);
        host.innerHTML = esc(this.iceInner());
        UI.icons(host);
        UI.restoreFocus(token, this.focusFallback(token, focus));
    },

    /**
     * Where focus goes when the control that had it is gone: the `focus` the caller named, but only when focus was in the redrawn part or
     * nowhere (the button the owner pressed was replaced while the read was out). Focus the owner has since put elsewhere is never taken.
     */
    focusFallback(token, focus) {
        const active = document.activeElement;
        return token || !active || active === document.body ? focus : undefined;
    },

    /** What Meta says it holds becomes the state, and the fields show it. */
    takeIce(answer) {
        const a = answer && typeof answer === 'object' ? answer : {};
        const ice = this.entry.ice;
        ice.limits = a.limits && typeof a.limits === 'object' ? a.limits : null;
        ice.held = (Array.isArray(a.prompts) ? a.prompts : []).filter((x) => typeof x === 'string');
        this.iceDraft = this.iceFields(ice.held);
    },

    // ─── Markup ───────────────────────────────────────────────────────────────────────────

    /** The Settings card. Called by the Settings page with the server's answer; sets the state and returns the markup. */
    section(state) {
        this.init(state);
        // The reads of the entry points start once Settings has put this markup in the page (the same task, after it), not while drawing:
        // an answer that came back before the card existed would have nowhere to be drawn.
        const gen = this.gen;
        if (this.entryReady()) Promise.resolve().then(() => { if (gen === this.gen) this.loadEntry(); });
        return html`<section class="section" id="wa-card">${this.body()}</section>`;
    },

    /** A badge: a glyph (its shape says what the colour says), a label and, optionally, the value. `tone` and its class come from tables written here. */
    chip(tone, label, value) {
        const cls = UI.STATUS_TONE_CLASS[tone] || UI.STATUS_TONE_CLASS.neutral;
        const glyph = this.GLYPHS[tone] || this.GLYPHS.neutral;
        return html`<span class="badge ${html.raw(cls)}"><span aria-hidden="true">${glyph}</span> <span>${label}</span>${value ? html` ${value}` : ''}</span>`;
    },

    /** Meta's word for something, translated when this knows it and shown as written (isolated) when it does not. */
    wordOf(prefix, table, value) {
        const raw = String(value);
        if (!Object.prototype.hasOwnProperty.call(table, raw)) return { tone: 'neutral', text: UI.ltr(raw) };
        const key = `${prefix}.${raw}`;
        const said = t(key);
        return { tone: table[raw], text: said === key ? UI.ltr(raw) : said };
    },

    chipsMarkup() {
        const s = this.state;
        const chips = [];
        if (s.number_status) {
            const w = this.wordOf('wa.numberStatus', this.NUMBER_STATUS, s.number_status);
            chips.push(this.chip(w.tone, t('wa.chip.status'), w.text));
        }
        if (s.quality_rating) {
            const w = this.wordOf('wa.quality', this.QUALITY, s.quality_rating);
            chips.push(this.chip(w.tone, t('wa.chip.quality'), w.text));
        }
        if (s.messaging_limit) {
            const count = this.tierCount(s.messaging_limit);
            const value = count !== null
                ? t('wa.limit.count', { n: UI.formatNumber(count) })
                : (s.messaging_limit === 'TIER_UNLIMITED' ? t('wa.limit.top') : UI.ltr(s.messaging_limit));
            chips.push(this.chip('neutral', t('wa.chip.limit'), value));
        }
        // The name review is only said when it is not fine: an approved name is the normal case and needs no badge.
        if (s.name_status && Object.prototype.hasOwnProperty.call(this.NAME_STATUS, s.name_status)) {
            const w = this.wordOf('wa.nameStatus', this.NAME_STATUS, s.name_status);
            chips.push(this.chip(w.tone, t('wa.chip.name'), w.text));
        }
        return chips;
    },

    /** The free-replies meter and what it costs, or why there is no meter. */
    usageMarkup() {
        const u = this.state && this.state.usage;
        if (!u || u.unavailable) {
            return html`<p class="form-hint" role="status">${t('wa.usage.unavailable')}</p>`;
        }
        const limit = Number(u.free_limit) > 0 ? Number(u.free_limit) : 1000;
        const used = Math.max(0, Number(u.free_used) || 0);
        const billable = Math.max(0, Number(u.billable) || 0);
        const alertAt = Number(this.state.free_tier_alert_at);
        const near = Number.isFinite(alertAt) && alertAt > 0 && used >= alertAt;
        const figure = `${UI.formatNumber(used)} / ${UI.formatNumber(limit)}`;
        return html`
            <div class="row row--wrap gap-3 mbe-2">
                <span class="form-label">${t('wa.usage.title')}</span>
                <strong class="${near ? html.raw('text-warning') : ''}">${UI.ltr(figure)}</strong>
            </div>
            <progress class="studio-meter mbe-3" max="${limit}" value="${Math.min(used, limit)}"
                      aria-label="${t('wa.usage.aria', { used: UI.formatNumber(used), limit: UI.formatNumber(limit) })}"></progress>
            ${near ? html`<p class="form-hint text-warning mbe-2">${t('wa.usage.near')}</p>` : ''}
            <p class="token-info mbe-2">${t('wa.usage.cost')}: <strong>${UI.ltr(this.usd(u.est_cost_usd))}</strong></p>
            <p class="token-info mbe-2">${t('wa.usage.projected')}: <strong>${UI.ltr(this.usd(u.projected_cost_usd))}</strong></p>
            ${billable > 0 ? html`<p class="token-info mbe-2 text-warning">${t('wa.usage.billable')}: <strong>${UI.ltr(UI.formatNumber(billable))}</strong></p>` : ''}
        `;
    },

    /** The connected (or refused) number: who it is, how it is doing, what it has used, and the owner's two buttons. */
    connectedBlock() {
        const s = this.state;
        const invalid = this.needsReconnect();
        const canWrite = this.canWrite();
        const when = s.last_refreshed_at ? new Date(s.last_refreshed_at) : null;
        const expires = s.token_expires_at ? new Date(s.token_expires_at) : null;
        const daysLeft = expires && !Number.isNaN(expires.getTime()) ? Math.ceil((expires - Date.now()) / 86400000) : null;
        const err = this.errors.header;
        return html`
            <div class="row row--start gap-3 mbe-4">
                <span class="stat-icon shrink-0"><i data-lucide="message-circle" aria-hidden="true"></i></span>
                <div class="stack gap-1">
                    <strong dir="auto">${s.verified_name || t('wa.unnamed')}</strong>
                    ${s.display_phone_number ? html`<span class="token-info">${UI.ltr(s.display_phone_number)}</span>` : ''}
                    <div class="row row--wrap gap-2">
                        <span class="health-pill ${invalid ? html.raw('health-stale') : html.raw('health-fresh')}">
                            <i data-lucide="${invalid ? 'alert-triangle' : 'check-circle'}" aria-hidden="true"></i>
                            ${invalid ? t('wa.pill.invalid') : t('wa.pill.active')}
                        </span>
                        ${s.is_test_number ? this.chip('warning', t('wa.badge.test'), '') : ''}
                        ${this.chipsMarkup()}
                    </div>
                </div>
            </div>
            ${s.is_test_number ? html`<p class="form-hint mbe-3">${t('wa.testNumberHint')}</p>` : ''}
            ${s.messaging_limit ? html`<p class="form-hint mbe-3">${t('wa.limit.hint')}</p>` : ''}
            ${invalid ? html`
                <div class="mbe-3">${UI.errorStrip(t('wa.invalidNote'), s.last_error ? this.hintMarkup(t('wa.lastError', { message: s.last_error })) : '', 'wa-invalid-strip')}</div>
            ` : ''}
            ${when && !Number.isNaN(when.getTime()) ? html`<p class="form-hint mbe-2">${t('wa.lastRead', { date: UI.formatDateTime(when) })}</p>` : ''}
            ${expires && daysLeft !== null
                ? html`<p class="form-hint mbe-3 ${daysLeft < 14 ? html.raw('text-warning') : ''}">${t('wa.tokenExpires', { date: UI.formatDay(expires) })}</p>`
                : html`<p class="form-hint mbe-3">${t('wa.tokenNever')}</p>`}
            ${invalid ? '' : html`<div class="settings-block" id="wa-usage">${this.usageMarkup()}</div>`}
            <div id="wa-header-error" aria-live="polite">${this.errorBlock(err, 'wa-header-error-strip', true)}</div>
            ${canWrite ? html`
                <div class="row row--wrap gap-2 mbs-4">
                    ${UI.button({
                        variant: invalid ? 'primary' : 'secondary', size: 'sm', icon: 'refresh-cw', label: t('wa.refresh'),
                        action: 'wa:refresh', id: 'wa-refresh', busy: this.busy === 'refresh', disabled: !!this.busy,
                    })}
                    ${UI.button({
                        variant: 'danger', size: 'sm', icon: 'unlink', label: t('wa.disconnect'),
                        action: 'wa:askDisconnect', id: 'wa-disconnect', disabled: !!this.busy,
                    })}
                </div>
            ` : html`<p class="form-hint mbs-4">${t('wa.ownerOnly')}</p>`}
        `;
    },

    /** The three fields and Connect: the owner's, for a number that is not connected or whose token Meta refused. No other member gets a token field. */
    connectBlock() {
        if (!this.canWrite()) return html`<p class="form-hint">${t('wa.connect.ownerOnly')}</p>`;
        const reconnect = this.needsReconnect();
        const err = this.errors.connect;
        const busy = this.busy === 'connect';
        const off = this.busy ? html.raw(' disabled') : '';
        return html`
            <div class="${this.live() ? html.raw('settings-block') : ''}" id="wa-connect-block">
                <h3 class="form-label">${reconnect ? t('wa.reconnect.title') : t('wa.connect.title')}</h3>
                <div id="wa-connect-error" aria-live="polite">${this.errorBlock(err, 'wa-connect-error-strip')}</div>
                <!-- No input here has a name: nothing in this form can be serialised into an address or a native submit, whatever happens to the script. -->
                <form id="wa-connect-form" data-submit="wa:connect" novalidate autocomplete="off">
                    ${UI.field({
                        id: 'wa-waba',
                        label: t('wa.field.waba'),
                        hint: this.ltrIn('wa.field.wabaHint', { page: 'API Setup' }, 'page'),
                        control: html`<input class="field field-mono" type="text" inputmode="numeric" dir="ltr" maxlength="32" autocomplete="off"
                                             spellcheck="false" autocapitalize="off" value="${this.form.waba}" data-input="wa:edit"${off}>`,
                    })}
                    ${UI.field({
                        id: 'wa-phone',
                        label: t('wa.field.phone'),
                        hint: t('wa.field.phoneHint'),
                        control: html`<input class="field field-mono" type="text" inputmode="numeric" dir="ltr" maxlength="32" autocomplete="off"
                                             spellcheck="false" autocapitalize="off" value="${this.form.phone}" data-input="wa:edit"${off}>`,
                    })}
                    ${UI.field({
                        id: 'wa-token',
                        label: t('wa.field.token'),
                        hint: html`${t('wa.field.tokenHint')} ${this.SCOPES.map((scope) => html`<span class="chip">${UI.ltr(scope)}</span> `)}`,
                        control: html`<input class="field field-mono" type="password" dir="ltr" maxlength="2000" autocomplete="new-password"
                                             spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true"${off}>`,
                    })}
                    <div class="form-actions">
                        ${UI.button({
                            variant: 'primary', size: 'sm', type: 'submit', icon: 'link',
                            label: reconnect ? t('wa.reconnect.submit') : t('wa.connect.submit'),
                            id: 'wa-connect-submit', busy, disabled: !!this.busy,
                        })}
                    </div>
                </form>
            </div>
        `;
    },

    /** One mode as a radio row. `everyone` is drawn disabled, with the reason, until the server's go-live gate opens. */
    modeOption(value, hint, disabled) {
        const writable = this.canWrite();
        const off = disabled || !writable || !!this.busy;
        return html`
            <label class="check-row ${off ? html.raw('is-disabled') : ''}" for="wa-mode-${value}">
                <input type="radio" name="wa-mode" id="wa-mode-${value}" value="${value}" data-change="wa:mode"
                       aria-describedby="wa-mode-${value}-hint" ${this.draft.mode === value ? html.raw('checked') : ''} ${off ? html.raw('disabled') : ''}>
                <span class="check-text">
                    <span class="check-label">${t(`wa.mode.${value}`)}</span>
                    <span class="form-hint" id="wa-mode-${value}-hint">${hint}</span>
                </span>
            </label>
        `;
    },

    /** Who the assistant answers: the mode and, for test mode, the list. */
    agentBlock() {
        const s = this.state;
        const writable = this.canWrite();
        const gate = s.go_live && typeof s.go_live === 'object' ? s.go_live : {};
        const everyoneOpen = gate.ready === true || s.mode === 'everyone';
        const missing = everyoneOpen ? '' : this.missingText(gate.missing);
        const parsed = this.parseSenders(this.draft.senders);
        const err = this.errors.agent;
        const everyoneHint = html`${t('wa.mode.everyoneHint')}${missing ? html` ${t('wa.golive.missing', { items: missing })}` : ''}`;
        return html`
            <div class="settings-block" id="wa-agent">
                <h3 class="form-label">${t('wa.agent.title')}</h3>
                <p class="form-hint mbe-3">${t('wa.agent.intro')}</p>
                <div id="wa-agent-error" aria-live="polite">${this.errorBlock(err, 'wa-agent-error-strip')}</div>
                <form id="wa-agent-form" data-submit="wa:saveAgent" novalidate>
                    <fieldset class="fieldset-plain form-group">
                        <legend class="form-label">${t('wa.mode.legend')}</legend>
                        ${this.modeOption('off', t('wa.mode.offHint'), false)}
                        ${this.modeOption('test', t('wa.mode.testHint'), false)}
                        ${this.modeOption('everyone', everyoneHint, !everyoneOpen)}
                    </fieldset>
                    ${UI.field({
                        id: 'wa-senders',
                        label: t('wa.senders.label'),
                        hint: t('wa.senders.hint', { max: this.MAX_SENDERS }),
                        control: html`<textarea class="field-textarea field-mono" rows="4" dir="ltr" autocomplete="off" spellcheck="false" autocapitalize="off"
                                                placeholder="201001234567" data-input="wa:edit"${writable ? '' : html.raw(' readonly')}>${this.draft.senders}</textarea>`,
                    })}
                    <p class="form-hint" id="wa-senders-count" aria-live="polite">${this.sendersNote(parsed)}</p>
                    ${writable ? html`
                        <div class="form-actions">
                            ${UI.button({
                                variant: 'primary', size: 'sm', type: 'submit', icon: 'save', label: t('common.save'),
                                id: 'wa-agent-save', busy: this.busy === 'agent', disabled: !!this.busy || !this.agentDirty(),
                            })}
                        </div>
                    ` : html`<p class="form-hint">${t('wa.ownerOnly')}</p>`}
                </form>
            </div>
        `;
    },

    /** The line under the list: how many senders it holds, and that test mode with none answers no one. */
    sendersNote(parsed) {
        const count = t('wa.senders.count', { n: parsed.senders.length, max: this.MAX_SENDERS });
        if (this.draft.mode === 'test' && parsed.senders.length === 0 && parsed.invalid.length === 0) return `${count} ${t('wa.senders.none')}`;
        return count;
    },

    /** The one choice about money: may replies beyond the free ones go out at Meta's price. Off by default; turning it on asks first. */
    billingBlock() {
        const s = this.state;
        const writable = this.canWrite();
        const on = this.busy === 'billing' && this.billingWanted !== null ? this.billingWanted : s.allow_billable === true;
        const limit = UI.formatNumber(s.usage && Number(s.usage.free_limit) > 0 ? Number(s.usage.free_limit) : 1000);
        const err = this.errors.billing;
        const off = !writable || !!this.busy;
        return html`
            <div class="settings-block" id="wa-billing">
                <h3 class="form-label">${t('wa.billing.title')}</h3>
                <div id="wa-billing-error" aria-live="polite">${this.errorBlock(err, 'wa-billing-error-strip')}</div>
                <div class="switch-row">
                    <label class="switch" for="wa-billing-toggle">
                        <span class="sr-only">${t('wa.billing.label', { limit })}</span>
                        <input type="checkbox" id="wa-billing-toggle" data-change="wa:billing" aria-describedby="wa-billing-hint"
                               ${on ? html.raw('checked') : ''} ${off ? html.raw('disabled') : ''}>
                        <span class="switch-track"></span>
                    </label>
                    <span class="switch-text">
                        <span class="switch-label">${t('wa.billing.label', { limit })}</span>
                        <span class="form-hint" id="wa-billing-hint">${t('wa.billing.hint', { rates: t('wa.billing.rates') })}</span>
                    </span>
                </div>
                ${writable ? '' : html`<p class="form-hint mbs-4">${t('wa.ownerOnly')}</p>`}
            </div>
        `;
    },

    // ─── Markup: campaign links ───────────────────────────────────────────────────────────

    /** The line under a field: how much of the limit is used. */
    counter(n, max) { return t('wa.counter', { n, max }); },

    /** One link: its name, the first message, the short address with Copy, the QR image with Download, and (the owner's) Delete. */
    linkItem(item) {
        const canWrite = this.canWrite();
        const name = item.label || t('wa.link.unnamed');
        return html`
            <li class="tp-row" id="wa-link-${item.code}">
                <div class="tp-row-head">
                    <span class="tp-row-title" dir="auto">${name}</span>
                    ${canWrite ? UI.button({
                        variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('common.delete'), ariaLabel: t('wa.link.deleteN', { name }),
                        action: 'wa:askDeleteLink', data: { code: item.code }, disabled: !!this.busy,
                    }) : ''}
                </div>
                <div class="row row--start row--wrap gap-3">
                    <div class="stack gap-2 shrink-0">
                        ${item.qr ? html`
                            <img src="${item.qr}" width="132" height="132" loading="lazy" alt="${t('wa.link.qr.alt', { name })}">
                            <a class="btn btn-secondary btn-sm" href="${item.qr}" download="${`whatsapp-${item.code}.png`}" target="_blank" rel="noopener noreferrer"
                               aria-label="${t('wa.link.downloadN', { name })}"><i data-lucide="download" aria-hidden="true"></i> ${t('wa.link.download')}</a>
                        ` : html`<p class="form-hint">${t('wa.link.qr.missing')}</p>`}
                    </div>
                    <div class="stack gap-2 grow">
                        <div>
                            <span class="form-label">${t('wa.link.firstMessage')}</span>
                            <p dir="auto">${item.prefill}</p>
                        </div>
                        ${item.ref ? html`<p class="token-info">${t('wa.link.tracking')}: <span class="chip">${UI.ltr(`#${item.ref}`)}</span></p>` : ''}
                        ${item.url ? html`
                            <div>
                                <span class="form-label">${t('wa.link.url')}</span>
                                <div class="row row--wrap gap-2">
                                    <span class="field-mono">${UI.ltr(item.url)}</span>
                                    ${UI.button({
                                        variant: 'ghost', size: 'sm', icon: 'copy', label: t('wa.link.copy'), ariaLabel: t('wa.link.copyN', { name }),
                                        action: 'wa:copyLink', data: { code: item.code },
                                    })}
                                </div>
                            </div>
                        ` : ''}
                        ${item.conversations !== null ? html`<p class="token-info">${t('wa.link.conversations', { n: UI.formatNumber(item.conversations) })}</p>` : ''}
                    </div>
                </div>
            </li>
        `;
    },

    /** The list's contents by state: reading, refused (with Retry), empty, or the links. */
    linksListMarkup() {
        const links = this.entry.links;
        if (links.status === 'idle' || links.status === 'loading') {
            return html`<p class="form-hint" role="status">${t('wa.link.loading')}</p>`;
        }
        if (links.status === 'error') {
            return html`
                <div class="mbe-3">${this.errorBlock(links.error, 'wa-links-error-strip')}</div>
                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'refresh-cw', label: t('common.retry'), action: 'wa:reloadLinks', id: 'wa-links-reload', disabled: !!this.busy })}
            `;
        }
        if (links.items.length === 0) {
            return html`
                <p class="mbe-2"><strong>${t('wa.link.empty.title')}</strong></p>
                <p class="form-hint mbe-3">${this.canWrite() ? t('wa.link.empty.body') : t('wa.link.empty.bodyReadOnly')}</p>
            `;
        }
        return html`
            <ul class="tp-rows" role="list">${links.items.map((item) => this.linkItem(item))}</ul>
            <div class="mbe-3">${UI.button({ variant: 'ghost', size: 'sm', icon: 'refresh-cw', label: t('wa.link.reload'), action: 'wa:reloadLinks', id: 'wa-links-reload', disabled: !!this.busy })}</div>
        `;
    },

    /** The owner's form for a new link. */
    linkFormMarkup() {
        const l = this.limits();
        const err = this.errors.linkForm || null;
        const busy = this.busy === 'linkCreate';
        const off = this.busy ? html.raw(' disabled') : '';
        return html`
            <div class="mbs-4" id="wa-link-new">
                <h4 class="form-label">${t('wa.link.form.title')}</h4>
                <div id="wa-link-error" aria-live="polite">${this.errorBlock(err, 'wa-link-error-strip')}</div>
                <form id="wa-link-form" data-submit="wa:createLink" novalidate autocomplete="off">
                    ${UI.field({
                        id: 'wa-link-label',
                        label: t('wa.link.form.label'),
                        hint: t('wa.link.form.labelHint', { max: l.label }),
                        control: html`<input class="field" type="text" dir="auto" maxlength="${l.label}" autocomplete="off" value="${this.linkForm.label}"
                                             aria-describedby="wa-link-label-count" data-input="wa:edit"${off}>`,
                    })}
                    <p class="form-hint" id="wa-link-label-count">${this.counter(this.linkForm.label.length, l.label)}</p>
                    ${UI.field({
                        id: 'wa-link-prefill',
                        label: t('wa.link.firstMessage'),
                        hint: t('wa.link.form.prefillHint', { max: l.prefill }),
                        control: html`<textarea class="field-textarea" rows="2" dir="auto" maxlength="${l.prefill}" autocomplete="off"
                                                aria-describedby="wa-link-prefill-count" data-input="wa:edit"${off}>${this.linkForm.prefill}</textarea>`,
                    })}
                    <p class="form-hint" id="wa-link-prefill-count">${this.counter(this.linkForm.prefill.length, l.prefill)}</p>
                    <div class="form-actions">
                        ${UI.button({
                            variant: 'primary', size: 'sm', type: 'submit', icon: 'plus', label: t('wa.link.create'),
                            id: 'wa-link-create', busy, disabled: !!this.busy,
                        })}
                    </div>
                </form>
            </div>
        `;
    },

    /** Campaign links: shown for a number that works. */
    linksBlock() {
        return html`
            <div class="settings-block" id="wa-links">
                <h3 class="form-label">${t('wa.link.title')}</h3>
                <p class="form-hint mbe-3">${this.ltrIn('wa.link.intro', { example: '#K7M3QA' }, 'example')}</p>
                <div id="wa-links-list" aria-live="polite">${this.linksListMarkup()}</div>
                ${this.canWrite() ? this.linkFormMarkup() : html`<p class="form-hint mbs-4">${t('wa.ownerOnly')}</p>`}
            </div>
        `;
    },

    // ─── Markup: ice breakers ─────────────────────────────────────────────────────────────

    /** One field for one question, with how much of the limit it uses. */
    iceField(i) {
        const l = this.limits();
        const value = this.iceDraft[i] || '';
        const id = `wa-ice-${i}`;
        const off = this.busy ? html.raw(' disabled') : '';
        return html`
            ${UI.field({
                id,
                label: t('wa.ice.row', { n: i + 1 }),
                control: html`<input class="field" type="text" dir="auto" maxlength="${l.promptChars}" autocomplete="off" value="${value}"
                                     aria-describedby="${id}-count" data-input="wa:edit"${off}>`,
            })}
            <p class="form-hint" id="${id}-count">${this.counter(value.length, l.promptChars)}</p>
        `;
    },

    /** The ice breakers' contents by state: reading, refused (with Retry), what Meta holds (a member reads it), or the owner's editor. */
    iceBodyMarkup() {
        const ice = this.entry.ice;
        const l = this.limits();
        if (ice.status === 'idle' || ice.status === 'loading') {
            return html`<p class="form-hint" role="status">${t('wa.ice.loading')}</p>`;
        }
        if (ice.status === 'error') {
            return html`
                <div class="mbe-3">${this.errorBlock(ice.error, 'wa-ice-load-error-strip')}</div>
                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'refresh-cw', label: t('common.retry'), action: 'wa:reloadIce', id: 'wa-ice-reload', disabled: !!this.busy })}
            `;
        }
        const notice = ice.notice === 'unverified' ? t('wa.ice.unverified') : (ice.notice === 'mismatch' ? t('wa.ice.mismatch') : '');
        const noticeMarkup = notice ? html`
            <div class="mbe-3">
                <p class="form-hint text-warning" role="status">${notice}</p>
                ${UI.button({ variant: 'ghost', size: 'sm', icon: 'refresh-cw', label: t('wa.ice.reload'), action: 'wa:reloadIce', id: 'wa-ice-reload', disabled: !!this.busy })}
            </div>
        ` : '';
        if (!this.canWrite()) {
            return html`
                ${noticeMarkup}
                ${ice.held.length === 0
                    ? html`<p class="form-hint">${t('wa.ice.none')}</p>`
                    : html`<ol class="stack gap-2" aria-label="${t('wa.ice.title')}">${ice.held.map((p) => html`<li dir="auto">${p}</li>`)}</ol>`}
            `;
        }
        const err = this.errors.ice || null;
        return html`
            ${noticeMarkup}
            <div id="wa-ice-error" aria-live="polite">${this.errorBlock(err, 'wa-ice-error-strip')}</div>
            <form id="wa-ice-form" data-submit="wa:saveIce" novalidate autocomplete="off">
                <p class="form-hint mbe-3">${t('wa.ice.hint', { chars: l.promptChars })}</p>
                ${this.iceDraft.map((_, i) => this.iceField(i))}
                <div class="form-actions">
                    ${UI.button({
                        variant: 'primary', size: 'sm', type: 'submit', icon: 'save', label: t('wa.ice.save'),
                        id: 'wa-ice-save', busy: this.busy === 'iceSave', disabled: !!this.busy || !this.iceDirty(),
                    })}
                </div>
            </form>
        `;
    },

    /** What is inside the ice breakers' block: the part `paintIce` replaces. */
    iceInner() {
        const l = this.limits();
        return html`
            <h3 class="form-label">${t('wa.ice.title')}</h3>
            <p class="form-hint mbe-2">${t('wa.ice.intro', { max: l.prompts })}</p>
            <p class="form-hint mbe-3">${t('wa.ice.prefillNote')}</p>
            <div id="wa-ice-body">${this.iceBodyMarkup()}</div>
        `;
    },

    /** Ice breakers: shown for a number that works. */
    iceBlock() {
        return html`<div class="settings-block" id="wa-ice">${this.iceInner()}</div>`;
    },

    /** The whole card, inside its `<section>`: what the repaint replaces. */
    body() {
        const live = this.live();
        return html`
            <h2 class="section-title">${t('wa.title')}</h2>
            <div class="settings-card surface">
                ${live ? '' : html`<p class="form-hint mbe-4">${this.ltrIn('wa.intro', { page: 'API Setup' }, 'page')}</p>`}
                ${live ? this.connectedBlock() : ''}
                ${!live || this.needsReconnect() ? this.connectBlock() : ''}
                ${live ? this.agentBlock() : ''}
                ${this.entryReady() ? this.linksBlock() : ''}
                ${this.entryReady() ? this.iceBlock() : ''}
                ${live ? this.billingBlock() : ''}
            </div>
        `;
    },

    // ─── Painting ─────────────────────────────────────────────────────────────────────────

    /**
     * Replace the card's contents, keeping focus where it was, and point at the field a refusal was about. Typed ids and senders are copied into
     * the state first by the caller. `fallback` is where focus goes when the control that had it is gone or off (a button that was busy, a form
     * that became a number): the last repaint after an action names it, so a keyboard user is never dropped onto the page.
     */
    repaint(fallback) {
        const host = document.getElementById('wa-card');
        if (!host) return;
        const focus = UI.captureFocus(host);
        host.innerHTML = esc(this.body());
        UI.icons(host);
        UI.restoreFocus(focus, fallback);
        const failing = [
            [this.errors.connect, 'wa-connect-error-strip'], [this.errors.agent, 'wa-agent-error-strip'],
            [this.errors.linkForm, 'wa-link-error-strip'], [this.errors.ice, 'wa-ice-error-strip'],
        ];
        for (const [error, strip] of failing) {
            if (!error || !error.field) continue;
            const input = document.getElementById(error.field);
            if (input) UI.markInvalid(input, strip);
        }
    },

    /**
     * Copy what is typed out of the page into the state: the ids, the test senders, the new link and the ice breaker fields. The token is not read
     * here, or anywhere but `connect()`. A field that is not on the page keeps what the state has.
     */
    syncFromDom() {
        const read = (id, fallback) => {
            const el = document.getElementById(id);
            return el && typeof el.value === 'string' ? el.value : fallback;
        };
        this.form.waba = read('wa-waba', this.form.waba);
        this.form.phone = read('wa-phone', this.form.phone);
        this.draft.senders = read('wa-senders', this.draft.senders);
        this.linkForm.label = read('wa-link-label', this.linkForm.label);
        this.linkForm.prefill = read('wa-link-prefill', this.linkForm.prefill);
        this.iceDraft = this.iceDraft.map((value, i) => read(`wa-ice-${i}`, value));
    },

    /**
     * What typing changes without a repaint (which would take the caret away): the sender count, the character counters, and whether the two
     * Save buttons are on.
     */
    updateChrome() {
        const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        set('wa-senders-count', this.sendersNote(this.parseSenders(this.draft.senders)));
        const save = document.getElementById('wa-agent-save');
        if (save) save.disabled = !!this.busy || !this.agentDirty();
        const l = this.limits();
        set('wa-link-label-count', this.counter(this.linkForm.label.length, l.label));
        set('wa-link-prefill-count', this.counter(this.linkForm.prefill.length, l.prefill));
        this.iceDraft.forEach((value, i) => set(`wa-ice-${i}-count`, this.counter(value.length, l.promptChars)));
        const iceSave = document.getElementById('wa-ice-save');
        if (iceSave && this.entry && this.entry.ice.status === 'ready') iceSave.disabled = !!this.busy || !this.iceDirty();
    },

    // ─── Actions ──────────────────────────────────────────────────────────────────────────

    /** Typing in the connect form or the senders list. */
    edit() {
        this.syncFromDom();
        this.updateChrome();
    },

    /** A mode was chosen. Nothing is sent until Save. */
    mode(el) {
        const value = el && typeof el.value === 'string' ? el.value : '';
        if (!this.MODES.includes(value)) return;
        this.syncFromDom();
        this.draft.mode = value;
        this.updateChrome();
    },

    /**
     * CONNECT. The token is read from its input into a local, the input is emptied before anything leaves, and the card repaints in its busy
     * state from the non-secret fields. Whatever the outcome, the token field is empty afterwards and the module holds no copy of it.
     */
    async connect(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (this.busy || !this.canWrite()) return;
        this.syncFromDom();
        const tokenInput = document.getElementById('wa-token');
        const token = tokenInput && typeof tokenInput.value === 'string' ? tokenInput.value.trim() : '';
        const waba = this.form.waba.trim();
        const phone = this.form.phone.trim();
        // What is kept for the repaint (and shown again after a refusal) is what was sent: the ids without the spaces a paste brings along.
        this.form = { waba, phone };

        // Checked here first, so a typo costs no round trip and the token goes nowhere until it looks like one. The token is left in its field.
        const problem = !this.META_ID.test(waba) ? 'invalid_waba_id'
            : !this.META_ID.test(phone) ? 'invalid_phone_number_id'
            : !this.TOKEN_SHAPE.test(token) ? 'invalid_access_token' : '';
        if (problem) {
            this.errors.connect = this.describe({ code: problem });
            this.repaintKeepingToken(token);
            return;
        }

        if (tokenInput) tokenInput.value = '';
        this.busy = 'connect';
        this.errors.connect = null;
        this.repaint();
        try {
            const view = await API.connectWhatsApp({ waba_id: waba, phone_number_id: phone, access_token: token });
            this.busy = null;
            this.form = { waba: '', phone: '' };
            this.apply(view, true);
            this.repaint('wa-refresh');
            this.loadEntry();
            UI.toast(t('wa.connected.toast'), 'success');
        } catch (err) {
            this.busy = null;
            this.errors.connect = this.describe(err);
            this.repaint('wa-connect-submit');
        }
    },

    /**
     * Repaint after a refusal made here, before anything was sent, without losing a token the owner is still typing: the field is repainted
     * empty (the markup never carries it) and the typed value is put back into the live input, which is the one place it is allowed to be.
     */
    repaintKeepingToken(token) {
        this.repaint();
        const input = document.getElementById('wa-token');
        if (input && token) input.value = token;
    },

    /** REFRESH: re-read the number's health from Meta. A token Meta now refuses is an answer, not an error: the card shows what it found. */
    async refresh() {
        if (this.busy || !this.canWrite()) return;
        this.syncFromDom();
        this.busy = 'refresh';
        this.errors.header = null;
        this.repaint();
        try {
            const view = await API.refreshWhatsApp();
            this.busy = null;
            this.apply(view, false);
            this.repaint('wa-refresh');
            this.loadEntry();
            if (view && view.status === 'invalid') UI.toast(t('wa.refreshStillInvalid'), 'warning');
            else UI.toast(t('wa.refreshed'), 'success');
        } catch (err) {
            this.busy = null;
            this.errors.header = this.describe(err);
            this.repaint('wa-refresh');
        }
    },

    /** DISCONNECT, step one: ask. Nothing is sent until the owner confirms. */
    askDisconnect() {
        if (this.busy || !this.canWrite() || !this.live()) return;
        UI.confirm({
            title: t('wa.disconnect.title'),
            body: t('wa.disconnect.body'),
            hint: t('wa.disconnect.hint'),
            confirmLabel: t('wa.disconnect'),
            confirmIcon: 'unlink',
            onConfirm: () => WhatsAppCard.disconnectConfirmed(),
        });
    },

    /** DISCONNECT, step two. A failure stays inside the dialog (it throws), in the owner's language. */
    async disconnectConfirmed() {
        if (this.busy) return;
        this.syncFromDom();
        this.busy = 'disconnect';
        this.repaint();
        try {
            await API.disconnectWhatsApp();
        } catch (err) {
            this.busy = null;
            this.repaint();
            throw new Error(this.describe(err).message);
        }
        this.busy = null;
        // The agent went back to off on the server; ask what it holds now. If that read fails, the card still says what is certain.
        let view = null;
        try {
            view = await API.getWhatsAppConnection();
        } catch {
            view = Object.assign({}, this.state, {
                connected: false, status: 'revoked', mode: 'off', allow_billable: false, phone_number_id: null, display_phone_number: null,
                verified_name: null, is_test_number: false, last_error: null,
            });
        }
        this.form = { waba: '', phone: '' };
        this.apply(view, true);
        this.repaint('wa-waba');
        UI.toast(t('wa.disconnected'), 'success');
    },

    /** SAVE the agent: the mode and the test senders, exactly as typed once checked. */
    async saveAgent(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (this.busy || !this.canWrite()) return;
        this.syncFromDom();
        const parsed = this.parseSenders(this.draft.senders);
        let refusal = null;
        if (parsed.invalid.length > 0) {
            refusal = Object.assign(this.describe({ code: 'invalid_test_senders' }), { hint: parsed.invalid[0].slice(0, 40) });
        } else if (parsed.senders.length > this.MAX_SENDERS) {
            refusal = { code: '', message: t('wa.val.tooMany', { max: this.MAX_SENDERS }), hint: '', field: 'wa-senders' };
        }
        if (refusal) {
            this.errors.agent = refusal;
            this.repaint();
            return;
        }
        this.busy = 'agent';
        this.errors.agent = null;
        this.repaint();
        try {
            const view = await API.saveWhatsAppAgent({ mode: this.draft.mode, test_senders: parsed.senders });
            this.busy = null;
            this.apply(view, true);
            this.repaint(`wa-mode-${this.draft.mode}`);
            UI.toast(t('wa.agent.saved'), 'success');
        } catch (err) {
            this.busy = null;
            this.errors.agent = this.describe(err);
            this.repaint('wa-agent-save');
        }
    },

    /**
     * The paid-messages switch. Turning it OFF is applied at once. Turning it ON costs money, so the switch goes back to off and the owner
     * is asked; only the dialog's own confirm sends it.
     */
    billing(el) {
        if (this.busy || !this.canWrite()) return;
        const wanted = !!(el && el.checked);
        if (wanted) {
            el.checked = false;
            UI.confirm({
                title: t('wa.billing.confirm.title'),
                body: t('wa.billing.confirm.body', { rates: t('wa.billing.rates') }),
                confirmLabel: t('wa.billing.confirm.ok'),
                confirmIcon: 'check',
                tone: 'primary',
                onConfirm: () => WhatsAppCard.billingConfirmed(),
            });
            return;
        }
        return this.writeBilling(false).catch((err) => {
            this.errors.billing = this.describe(err);
            this.repaint('wa-billing-toggle');
        });
    },

    /** Step two of turning it on. A failure stays inside the dialog, in the owner's language. */
    async billingConfirmed() {
        try {
            await this.writeBilling(true);
        } catch (err) {
            throw new Error(this.describe(err).message);
        }
    },

    // ─── Actions: campaign links ──────────────────────────────────────────────────────────

    /** The owner pressed Reload (or Retry) on the list: ask Meta again. */
    reloadLinks() {
        if (this.busy || !this.entryReady()) return undefined;
        const pending = this.loadLinks(this.gen, 'wa-links-reload');
        this.paintLinks();
        return pending;
    },

    /** Reload (or Retry) the ice breakers. What was typed is replaced by what Meta holds. */
    reloadIce() {
        if (this.busy || !this.entryReady()) return undefined;
        const pending = this.loadIce(this.gen, 'wa-ice-reload');
        this.paintIce();
        return pending;
    },

    /**
     * CREATE a link: the form is checked here first, so a typo costs no round trip; then `POST /entry-links` makes the link and its QR code at Meta
     * and answers the new link (with `label_saved: false` when the link exists but its name could not be kept). It is never sent twice by this
     * card: a press while one is out does nothing, and an answer that never came is said to be unknown, with the list asked for again.
     */
    async createLink(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (this.busy || !this.canWrite() || !this.entryReady()) return;
        this.syncFromDom();
        const checked = this.validateLink(this.linkForm);
        if (!checked.value) {
            this.errors.linkForm = this.describe({ code: checked.code });
            this.repaint();
            return;
        }
        this.busy = 'linkCreate';
        this.errors.linkForm = null;
        this.repaint();
        try {
            const made = await API.createWhatsAppEntryLink(checked.value);
            this.busy = null;
            this.linkForm = { label: '', prefill: '' };
            const links = this.entry.links;
            const [item] = this.cleanLinks([made]);
            if (item && links.status === 'ready') links.items = [item, ...links.items.filter((x) => x.code !== item.code)];
            this.repaint('wa-link-label');
            if (!item || links.status !== 'ready') this.loadLinks(this.gen);
            const named = !made || made.label_saved !== false;
            UI.toast(named ? t('wa.link.created') : t('wa.link.createdUnnamed'), named ? 'success' : 'warning');
        } catch (err) {
            this.busy = null;
            const refusal = this.describe(err);
            // A create whose answer never came may have landed. The generic "nothing was saved" would be false here, so say what is true.
            if (refusal.code === 'meta_unreachable') {
                this.errors.linkForm = { code: refusal.code, message: t('wa.link.createUnknown'), hint: '', field: null };
                this.loadLinks(this.gen);
            } else {
                this.errors.linkForm = refusal;
            }
            this.repaint('wa-link-create');
        }
    },

    /** DELETE, step one: ask. Nothing is sent until the owner confirms. */
    askDeleteLink(el) {
        if (this.busy || !this.canWrite() || !this.entryReady()) return;
        const code = el && el.dataset && typeof el.dataset.code === 'string' ? el.dataset.code : '';
        const item = this.entry.links.items.find((x) => x.code === code);
        if (!item) return;
        const name = item.label || t('wa.link.unnamed');
        UI.confirm({
            title: t('wa.link.delete.title', { name }),
            body: t('wa.link.delete.body'),
            hint: t('wa.link.delete.hint'),
            confirmLabel: t('common.delete'),
            onConfirm: () => WhatsAppCard.deleteLinkConfirmed(code),
        });
    },

    /**
     * DELETE, step two. A refusal stays inside the dialog (it throws), in the owner's language with Meta's words after it. A link that is
     * already gone at Meta (404) is what the owner wanted: it leaves the list and the dialog closes.
     */
    async deleteLinkConfirmed(code) {
        if (this.busy) return;
        this.syncFromDom();
        this.busy = 'linkDelete';
        this.repaint();
        let alreadyGone = false;
        try {
            await API.deleteWhatsAppEntryLink(code);
        } catch (err) {
            const refusal = this.describe(err);
            if (refusal.code !== 'not_found') {
                this.busy = null;
                this.repaint();
                throw new Error(refusal.hint ? `${refusal.message} ${refusal.hint}` : refusal.message);
            }
            alreadyGone = true;
        }
        this.busy = null;
        const links = this.entry.links;
        links.items = links.items.filter((x) => x.code !== code);
        this.repaint('wa-link-label');
        UI.toast(alreadyGone ? t('wa.link.alreadyGone') : t('wa.link.deleted'), alreadyGone ? 'info' : 'success');
    },

    /** Copy a link's short address. The address is looked up by the link's code, never carried in the markup. */
    async copyLink(el) {
        const code = el && el.dataset && typeof el.dataset.code === 'string' ? el.dataset.code : '';
        const item = this.entry && this.entry.links.items.find((x) => x.code === code);
        if (!item || !item.url) return;
        try {
            await navigator.clipboard.writeText(item.url);
            UI.toast(t('wa.link.copied'));
        } catch {
            // No clipboard outside a secure context or in some embedded browsers: say so rather than appearing to have worked.
            UI.toast(t('setup.copyFailed'), 'error');
        }
    },

    // ─── Actions: ice breakers ────────────────────────────────────────────────────────────

    /**
     * SAVE the ice breakers: the fields are checked here first, then `PUT /ice-breakers` sets them at Meta and answers what Meta holds NOW.
     * That answer is what the fields show afterwards. If it is not what was sent, or could not be read back, the card says so and does not
     * claim the change.
     */
    async saveIce(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (this.busy || !this.canWrite() || !this.entryReady() || this.entry.ice.status !== 'ready') return;
        this.syncFromDom();
        const checked = this.checkPrompts(this.iceDraft);
        if (checked.problem) {
            const { code, n } = checked.problem;
            const refusal = this.describe({ code });
            // Name the field when the problem is in one: the sentence says what, the hint says which.
            this.errors.ice = n > 0
                ? Object.assign(refusal, { hint: t('wa.ice.row', { n }), field: `wa-ice-${n - 1}` })
                : refusal;
            this.repaint();
            return;
        }
        const ice = this.entry.ice;
        this.busy = 'iceSave';
        this.errors.ice = null;
        this.repaint();
        try {
            const answer = await API.saveWhatsAppIceBreakers({ prompts: checked.prompts });
            this.busy = null;
            const verified = !answer || answer.verified !== false;
            this.takeIce(answer);
            const held = ice.held;
            const same = held.length === checked.prompts.length && held.every((p, i) => p === checked.prompts[i]);
            // A write that could not be read back is not claimed as confirmed: the card says it is unconfirmed, and offers the read.
            ice.notice = !verified ? 'unverified' : (same ? '' : 'mismatch');
            this.repaint('wa-ice-save');
            if (!verified) UI.toast(t('wa.ice.savedUnverified'), 'warning');
            else if (!same) UI.toast(t('wa.ice.savedDifferent'), 'warning');
            else UI.toast(t('wa.ice.saved'), 'success');
        } catch (err) {
            this.busy = null;
            this.errors.ice = this.describe(err);
            this.repaint('wa-ice-save');
        }
    },

    /** `PUT /billing`. Rethrows: each caller says where the refusal is shown. */
    async writeBilling(value) {
        if (this.busy) return;
        this.syncFromDom();
        this.busy = 'billing';
        this.billingWanted = value;
        this.errors.billing = null;
        this.repaint();
        try {
            const view = await API.saveWhatsAppBilling({ allow_billable: value });
            this.busy = null;
            this.billingWanted = null;
            this.apply(view, false);
            this.repaint('wa-billing-toggle');
            UI.toast(value ? t('wa.billing.on') : t('wa.billing.off'), 'success');
        } catch (err) {
            this.busy = null;
            this.billingWanted = null;
            this.repaint('wa-billing-toggle');
            throw err;
        }
    },
};

UI.registerActions('wa', {
    edit: () => WhatsAppCard.edit(),
    mode: (el) => WhatsAppCard.mode(el),
    connect: (el, e) => WhatsAppCard.connect(el, e),
    refresh: () => WhatsAppCard.refresh(),
    askDisconnect: () => WhatsAppCard.askDisconnect(),
    saveAgent: (el, e) => WhatsAppCard.saveAgent(el, e),
    billing: (el) => WhatsAppCard.billing(el),
    createLink: (el, e) => WhatsAppCard.createLink(el, e),
    askDeleteLink: (el) => WhatsAppCard.askDeleteLink(el),
    copyLink: (el) => WhatsAppCard.copyLink(el),
    reloadLinks: () => WhatsAppCard.reloadLinks(),
    saveIce: (el, e) => WhatsAppCard.saveIce(el, e),
    reloadIce: () => WhatsAppCard.reloadIce(),
});
