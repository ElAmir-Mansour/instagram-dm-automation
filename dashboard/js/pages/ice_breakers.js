/**
 * Settings → Instagram ice breakers and persistent menu (docs/DM_SALES_PLAN.md S13): the owner's buttons for a new chat, as an editor,
 * and the one button that puts them on Instagram.
 *
 * Not a route. The Settings page loads this module on first use (`App.loadPageModule('ice_breakers')`, like `meta_connect`) and calls
 * `section()`; every later change repaints the card's own element, never the whole page, so a half-typed question survives it.
 *
 * Three separate things, never blurred:
 *   - EDIT   the draft is a copy held here and shown in the editor. Typing changes nothing but this copy.
 *   - SAVE   `PUT /api/dm/ice-breakers` writes the draft to the tenant's own row. It sends nothing to Instagram.
 *   - PUBLISH / REMOVE   the two buttons that change what every visitor to the account sees. Each asks first (`Admin.confirm`), publishes
 *     only the SAVED draft (the button is off while the editor differs from what was saved, and says so), and shows what Instagram holds
 *     afterwards, read back from Instagram and not from our own record.
 *
 * Suggestions are the editor's starting point for an account that has never saved a draft: they are shown, labelled as suggestions,
 * and they are NOT saved until the owner presses Save, nor published until he presses Publish.
 *
 * Everything here that came from a person or from Instagram (the questions, the menu titles and links, the words Instagram reports back,
 * Instagram's own refusal, who published) goes through the `html` tag, which escapes it. A link is shown as text and never made an href.
 * Interpolating a value into an inline handler is the one thing the dashboard never does (components.js), and nothing here does.
 */
const IceBreakersCard = {
    /** The server's last answer (`GET /api/dm/ice-breakers`), or null. */
    state: null,
    /** The editor's own copy. Blank rows are legal here and dropped when saving. */
    draft: { iceBreakers: [], menu: [] },
    /** The editor shows suggestions and no draft was ever saved: a starting point, not the owner's words yet. */
    suggested: false,
    /** What Instagram holds, as the last read-back said (`{ iceBreakers, menu }`), or null when it was not read. */
    live: null,
    /** A line about that read-back that is not the read-back: it failed. */
    liveNote: '',
    /** The last refusal: `{ message, hint, field }`. */
    error: null,
    /** Which request is in flight: 'save' | 'publish' | 'remove' | 'live' | null. Every button is off while one is. */
    busy: null,

    BLANK_ICE: () => ({ question: '', payload: 'TAP_INFO' }),
    BLANK_MENU: () => ({ type: 'postback', title: '', payload: 'TAP_HUMAN', url: '' }),

    // ─── State ────────────────────────────────────────────────────────────────────────────

    /** Start from what the server said: the saved draft, or the suggestions for an account that has none. */
    init(state) {
        this.state = state;
        this.live = null;
        this.liveNote = '';
        this.error = null;
        this.busy = null;
        this.draftFrom(state);
    },

    draftFrom(state) {
        const cfg = (state && state.config) || {};
        this.suggested = !(state && state.saved);
        const ice = this.suggested
            ? ((state && state.suggestions && state.suggestions.items) || [])
            : (cfg.iceBreakers || []);
        this.draft = {
            iceBreakers: ice.map((b) => ({ question: String(b.question || ''), payload: String(b.payload || 'TAP_INFO') })),
            menu: (cfg.menu || []).map((m) => ({
                type: m.type === 'web_url' ? 'web_url' : 'postback',
                title: String(m.title || ''),
                payload: String(m.payload || 'TAP_HUMAN'),
                url: String(m.url || ''),
            })),
        };
    },

    limits() {
        const l = (this.state && this.state.limits) || {};
        return { ice: l.iceBreakers || 4, question: l.question || 80, menu: l.menuItems || 5, title: l.menuTitle || 30 };
    },

    taps() { return (this.state && Array.isArray(this.state.taps)) ? this.state.taps : []; },

    connected() { return !!(this.state && this.state.connected && this.state.connected.instagram); },

    chars(value) { return Array.from(String(value || '')).length; },

    /** Copy the typed values out of the editor into the draft. A field that is not on the page keeps what the draft has. */
    syncFromDom() {
        const read = (id, fallback) => {
            const el = document.getElementById(id);
            return el && typeof el.value === 'string' ? el.value : fallback;
        };
        this.draft.iceBreakers.forEach((row, i) => {
            row.question = read(`iceb-ice-${i}-question`, row.question);
            row.payload = read(`iceb-ice-${i}-payload`, row.payload);
        });
        this.draft.menu.forEach((row, i) => {
            row.type = read(`iceb-menu-${i}-type`, row.type) === 'web_url' ? 'web_url' : 'postback';
            row.title = read(`iceb-menu-${i}-title`, row.title);
            row.payload = read(`iceb-menu-${i}-payload`, row.payload);
            row.url = read(`iceb-menu-${i}-url`, row.url);
        });
    },

    /**
     * The draft as the server takes it: rows with nothing typed are dropped, and each row carries only what its type uses. `map` says, for
     * each kept row, which editor row it was, so a refusal that names row 1 of what was sent marks the right field.
     */
    toPayload() {
        const map = { iceBreakers: [], menu: [] };
        const iceBreakers = [];
        this.draft.iceBreakers.forEach((row, i) => {
            const question = String(row.question || '').trim();
            if (!question) return;
            iceBreakers.push({ question, payload: row.payload });
            map.iceBreakers.push(i);
        });
        const menu = [];
        this.draft.menu.forEach((row, i) => {
            const title = String(row.title || '').trim();
            const url = String(row.url || '').trim();
            if (!title && (row.type === 'postback' || !url)) return;
            menu.push(row.type === 'web_url' ? { type: 'web_url', title, url } : { type: 'postback', title, payload: row.payload });
            map.menu.push(i);
        });
        return { payload: { iceBreakers, menu }, map };
    },

    /** One string for a config, the same for what is typed and what is saved, so "unsaved changes" is a comparison. */
    canon(config) {
        const c = config || {};
        return JSON.stringify({
            i: (c.iceBreakers || []).map((b) => [String(b.question).replace(/\s+/g, ' ').trim(), b.payload]),
            m: (c.menu || []).map((m) => (m.type === 'web_url' ? ['u', String(m.title).replace(/\s+/g, ' ').trim(), String(m.url).trim()] : ['p', String(m.title).replace(/\s+/g, ' ').trim(), m.payload])),
        });
    },

    /** The editor differs from what was saved, or shows suggestions nobody saved. */
    dirty() {
        if (this.suggested) return true;
        return this.canon(this.toPayload().payload) !== this.canon(this.state && this.state.config);
    },

    /** There is something for Publish to do: a saved draft with buttons in it, or buttons this app put on Instagram that are now gone from it. */
    hasSomethingToPublish() {
        const cfg = (this.state && this.state.config) || {};
        const pub = this.state && this.state.published;
        return (cfg.iceBreakers || []).length + (cfg.menu || []).length > 0 || !!(pub && (pub.iceBreakers > 0 || pub.menu > 0));
    },

    canPublish() {
        return this.connected() && !this.busy && !this.dirty() && this.hasSomethingToPublish();
    },

    // ─── Words ────────────────────────────────────────────────────────────────────────────

    /** The sentence for a refusal the server made, in this language. Meta's own words (a 502) are quoted, and escaped where they are shown. */
    problemText(problem) {
        const l = this.limits();
        const max = problem.field === 'menu' ? l.menu : problem.field === 'iceBreakers' ? l.ice : /\.title$/.test(problem.field) ? l.title : l.question;
        const key = `iceb.err.${problem.code}`;
        const text = t(key, { max });
        return text === key ? String(problem.message || t('error.unexpected')) : text;
    },

    /** Where a refusal about row `i` of what was sent is on the page: the editor row it came from, and its field. */
    fieldIdFor(path, map) {
        const m = /^(iceBreakers|menu)\[(\d+)\]\.(\w+)$/.exec(String(path || ''));
        if (!m) return null;
        const row = map && map[m[1]] ? map[m[1]][Number(m[2])] : undefined;
        if (row === undefined) return null;
        return `iceb-${m[1] === 'menu' ? 'menu' : 'ice'}-${row}-${m[3]}`;
    },

    /** An error from a request as `{ message, hint, field }`. */
    describe(err, map) {
        const body = (err && err.body) || {};
        if (body.code === 'ICE_BREAKERS_INVALID' && Array.isArray(body.problems) && body.problems.length > 0) {
            const texts = body.problems.map((p) => this.problemText(p));
            return { message: texts[0], hint: texts.slice(1).join(' · '), field: this.fieldIdFor(body.problems[0].field, map) };
        }
        const known = ['NOTHING_TO_PUBLISH', 'META_NOT_CONNECTED', 'INSTAGRAM_NOT_CONNECTED'];
        if (known.includes(body.code)) return { message: t(`iceb.err.${body.code}`), hint: '', field: null };
        if (body.code === 'META_ERROR') return { message: t('iceb.err.META_ERROR', { message: String(err.message || '') }), hint: t('iceb.err.META_ERROR_HINT'), field: null };
        return { message: (err && err.message) || t('error.unexpected'), hint: '', field: null };
    },

    // ─── Markup ───────────────────────────────────────────────────────────────────────────

    /** The Settings card. Called by the Settings page with the server's answer; sets the state and returns the markup. */
    section(state) {
        this.init(state);
        return html`<section class="section" id="iceb-card">${this.body()}</section>`;
    },

    tapOptions(selected) {
        return this.taps().map((tap) => html`<option value="${tap.code}" ${tap.code === selected ? html.raw('selected') : ''}>${t(`iceb.tap.${tap.code}`)}</option>`);
    },

    iceRow(row, i) {
        const l = this.limits();
        const base = `iceb-ice-${i}`;
        return html`
            <div class="tp-row" role="group" aria-labelledby="${base}-title">
                <div class="tp-row-head">
                    <span class="tp-row-title" id="${base}-title">${t('iceb.ice.row', { n: i + 1 })}</span>
                    ${UI.button({
                        variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('iceb.row.remove'), ariaLabel: t('iceb.ice.removeN', { n: i + 1 }),
                        action: 'iceb:removeRow', data: { list: 'iceBreakers', index: i }, disabled: !!this.busy,
                    })}
                </div>
                <div class="form-group">
                    <label class="form-label" for="${base}-question">${t('iceb.ice.question')}</label>
                    <input class="field" id="${base}-question" type="text" dir="auto" maxlength="${l.question}" autocomplete="off"
                           value="${row.question}" data-input="iceb:edit" aria-describedby="${base}-count">
                    <p class="form-hint" id="${base}-count">${t('iceb.counter', { n: this.chars(row.question), max: l.question })}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="${base}-payload">${t('iceb.ice.asks')}</label>
                    <select class="select" id="${base}-payload" data-change="iceb:edit">${this.tapOptions(row.payload)}</select>
                </div>
            </div>
        `;
    },

    menuRow(row, i) {
        const l = this.limits();
        const base = `iceb-menu-${i}`;
        const isLink = row.type === 'web_url';
        return html`
            <div class="tp-row" role="group" aria-labelledby="${base}-title">
                <div class="tp-row-head">
                    <span class="tp-row-title" id="${base}-title">${t('iceb.menu.row', { n: i + 1 })}</span>
                    ${UI.button({
                        variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('iceb.row.remove'), ariaLabel: t('iceb.menu.removeN', { n: i + 1 }),
                        action: 'iceb:removeRow', data: { list: 'menu', index: i }, disabled: !!this.busy,
                    })}
                </div>
                <div class="form-group">
                    <label class="form-label" for="${base}-type">${t('iceb.menu.type')}</label>
                    <select class="select" id="${base}-type" data-change="iceb:menuType">
                        <option value="postback" ${isLink ? '' : html.raw('selected')}>${t('iceb.menu.type.postback')}</option>
                        <option value="web_url" ${isLink ? html.raw('selected') : ''}>${t('iceb.menu.type.web_url')}</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="${base}-title">${t('iceb.menu.title')}</label>
                    <input class="field" id="${base}-title" type="text" dir="auto" maxlength="${l.title}" autocomplete="off"
                           value="${row.title}" data-input="iceb:edit" aria-describedby="${base}-count">
                    <p class="form-hint" id="${base}-count">${t('iceb.counter', { n: this.chars(row.title), max: l.title })}</p>
                </div>
                ${isLink ? html`
                    <div class="form-group">
                        <label class="form-label" for="${base}-url">${t('iceb.menu.url')}</label>
                        <input class="field field-mono" id="${base}-url" type="url" dir="ltr" maxlength="2000" autocomplete="off" spellcheck="false"
                               autocapitalize="off" placeholder="https://" value="${row.url}" data-input="iceb:edit">
                    </div>
                ` : html`
                    <div class="form-group">
                        <label class="form-label" for="${base}-payload">${t('iceb.ice.asks')}</label>
                        <select class="select" id="${base}-payload" data-change="iceb:edit">${this.tapOptions(row.payload)}</select>
                    </div>
                `}
            </div>
        `;
    },

    /** "Published 14 Oct, 2 ice breakers, 1 menu item" and whether that is what the draft says: the contents of `#iceb-status`. */
    statusMarkup() {
        const pub = this.state && this.state.published;
        const unsaved = this.dirty();
        let pill;
        if (unsaved) pill = html`<span class="health-pill health-stale" id="iceb-status-pill"><i data-lucide="alert-circle" aria-hidden="true"></i> ${t('iceb.status.unsaved')}</span>`;
        else if (!pub) pill = html`<span class="status-pill" id="iceb-status-pill">${t('iceb.status.never')}</span>`;
        else if (this.state.inSync) pill = html`<span class="health-pill health-fresh" id="iceb-status-pill"><i data-lucide="check-circle" aria-hidden="true"></i> ${t('iceb.status.inSync')}</span>`;
        else if (!pub.hash) pill = html`<span class="health-pill health-stale" id="iceb-status-pill"><i data-lucide="alert-circle" aria-hidden="true"></i> ${t('iceb.status.partial')}</span>`;
        else pill = html`<span class="health-pill health-stale" id="iceb-status-pill"><i data-lucide="alert-circle" aria-hidden="true"></i> ${t('iceb.status.changed')}</span>`;
        return html`
            ${pill}
            ${pub ? html`<span class="text-meta">${t('iceb.status.last', { when: UI.formatDateTime(pub.at), ice: pub.iceBreakers, menu: pub.menu })}</span>` : ''}
        `;
    },

    liveMarkup() {
        if (!this.live && !this.liveNote) return '';
        const note = this.liveNote ? html`<p class="form-hint" role="status" dir="auto">${this.liveNote}</p>` : '';
        if (!this.live) return html`<div class="settings-block" id="iceb-live">${note}</div>`;
        const known = new Set(this.taps().map((x) => x.code));
        const label = (payload) => (known.has(payload) ? t(`iceb.tap.${payload}`) : UI.ltr(payload));
        const ice = this.live.iceBreakers || [];
        const menu = this.live.menu || [];
        return html`
            <div class="settings-block" id="iceb-live">
                <h3 class="form-label">${t('iceb.live.title')}</h3>
                ${note}
                ${ice.length + menu.length === 0 ? html`<p class="form-hint">${t('iceb.live.empty')}</p>` : ''}
                ${ice.map((group) => html`
                    <p class="form-label">${t('iceb.live.ice')} <span class="text-meta">${UI.ltr(group.locale)}</span></p>
                    <ul class="stack gap-2 mbe-3">
                        ${(group.items || []).map((item) => html`<li><span dir="auto">${item.question}</span> <span class="chip">${label(item.payload)}</span></li>`)}
                    </ul>
                `)}
                ${menu.map((group) => html`
                    <p class="form-label">${t('iceb.live.menu')} <span class="text-meta">${UI.ltr(group.locale)}</span></p>
                    <ul class="stack gap-2 mbe-3">
                        ${(group.items || []).map((item) => html`<li><span dir="auto">${item.title}</span> ${item.url
                            ? html`<span class="chip">${UI.ltr(item.url)}</span>`
                            : html`<span class="chip">${label(item.payload || '')}</span>`}</li>`)}
                    </ul>
                `)}
            </div>
        `;
    },

    /** The whole card, inside its `<section>`: what the repaint replaces. */
    body() {
        const l = this.limits();
        const busy = this.busy;
        const ice = this.draft.iceBreakers;
        const menu = this.draft.menu;
        return html`
            <h2 class="section-title">${t('iceb.title')}</h2>
            <div class="settings-card surface">
                <p class="form-hint mbe-2">${t('iceb.intro', { max: l.ice })}</p>
                <p class="form-hint mbe-4">${t('iceb.desktopNote')}</p>
                ${this.connected() ? '' : html`<div class="mbe-4">${UI.errorStrip(t('iceb.notConnected'), '', 'iceb-connect-note')}</div>`}
                <div class="token-status mbe-4" id="iceb-status" aria-live="polite">${this.statusMarkup()}</div>
                <div id="iceb-error" aria-live="polite">${this.error ? UI.errorStrip(this.error.message, this.error.hint, 'iceb-error-strip') : ''}</div>

                <form id="iceb-form" data-submit="iceb:save" novalidate>
                    ${this.suggested ? html`<p class="form-hint mbe-3" id="iceb-suggested" role="status">${t('iceb.suggested')}</p>` : ''}
                    <fieldset class="form-group fieldset-plain tp-rows">
                        <legend class="form-label">${t('iceb.ice.legend')}</legend>
                        <p class="form-hint">${t('iceb.ice.hint', { max: l.ice, chars: l.question })}</p>
                        ${ice.map((row, i) => this.iceRow(row, i))}
                        <div class="row row--wrap gap-3">
                            ${UI.button({ variant: 'secondary', size: 'sm', icon: 'plus', label: t('iceb.ice.add'), action: 'iceb:add', data: { list: 'iceBreakers' }, disabled: !!busy || ice.length >= l.ice })}
                            ${UI.button({ variant: 'ghost', size: 'sm', icon: 'refresh-cw', label: t('iceb.useSuggestions'), action: 'iceb:useSuggestions', disabled: !!busy })}
                        </div>
                    </fieldset>

                    <details class="settings-block" id="iceb-menu-block" ${menu.length > 0 ? html.raw('open') : ''}>
                        <summary class="form-label">${t('iceb.menu.legend')}</summary>
                        <p class="form-hint mbs-2">${t('iceb.menu.hint', { max: l.menu })}</p>
                        <div class="tp-rows">
                            ${menu.map((row, i) => this.menuRow(row, i))}
                            ${UI.button({ variant: 'secondary', size: 'sm', icon: 'plus', label: t('iceb.menu.add'), action: 'iceb:add', data: { list: 'menu' }, disabled: !!busy || menu.length >= l.menu })}
                        </div>
                    </details>

                    <div class="form-actions">
                        ${UI.button({ variant: 'primary', size: 'sm', type: 'submit', icon: 'save', label: t('iceb.save'), id: 'iceb-save', busy: busy === 'save', disabled: !!busy })}
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'send', label: t('iceb.publish'), action: 'iceb:publish', id: 'iceb-publish', busy: busy === 'publish', disabled: !this.canPublish() })}
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'refresh-cw', label: t('iceb.readLive'), action: 'iceb:readLive', id: 'iceb-read', busy: busy === 'live', disabled: !this.connected() || !!busy })}
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('iceb.remove'), action: 'iceb:askRemove', id: 'iceb-remove', busy: busy === 'remove', disabled: !this.connected() || !!busy })}
                    </div>
                    <p class="form-hint" id="iceb-publish-hint">${t('iceb.publishHint')}</p>
                </form>
                ${this.liveMarkup()}
            </div>
        `;
    },

    // ─── Painting ─────────────────────────────────────────────────────────────────────────

    /** Replace the card's contents, keeping focus where it was. The editor rows come from the draft, so what is typed is synced first by the caller. */
    repaint() {
        const host = document.getElementById('iceb-card');
        if (!host) return;
        const focus = UI.captureFocus(host);
        host.innerHTML = esc(this.body());
        UI.icons(host);
        UI.restoreFocus(focus);
        if (this.error && this.error.field) {
            const input = document.getElementById(this.error.field);
            if (input) UI.markInvalid(input, 'iceb-error-strip');
        }
    },

    /**
     * What typing changes without a repaint of the editor (which would take the caret away): the counters, the status line, and whether
     * Publish is on. The status block is repainted whole, since which pill it shows depends on whether the editor still matches what was saved.
     */
    updateChrome() {
        const l = this.limits();
        const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        this.draft.iceBreakers.forEach((row, i) => set(`iceb-ice-${i}-count`, t('iceb.counter', { n: this.chars(row.question), max: l.question })));
        this.draft.menu.forEach((row, i) => set(`iceb-menu-${i}-count`, t('iceb.counter', { n: this.chars(row.title), max: l.title })));
        const publish = document.getElementById('iceb-publish');
        if (publish) publish.disabled = !this.canPublish();
        const status = document.getElementById('iceb-status');
        if (status) { status.innerHTML = esc(this.statusMarkup()); UI.icons(status); }
    },

    // ─── Actions ──────────────────────────────────────────────────────────────────────────

    /** Typing or choosing in the editor. */
    edit() {
        this.syncFromDom();
        this.updateChrome();
    },

    menuType() {
        this.syncFromDom();
        this.repaint();
    },

    add(el) {
        this.syncFromDom();
        const list = el && el.dataset ? el.dataset.list : '';
        const l = this.limits();
        if (list === 'iceBreakers' && this.draft.iceBreakers.length < l.ice) this.draft.iceBreakers.push(this.BLANK_ICE());
        else if (list === 'menu' && this.draft.menu.length < l.menu) this.draft.menu.push(this.BLANK_MENU());
        else return;
        this.error = null;
        this.repaint();
        const last = list === 'menu' ? `iceb-menu-${this.draft.menu.length - 1}-title` : `iceb-ice-${this.draft.iceBreakers.length - 1}-question`;
        const input = document.getElementById(last);
        if (input && typeof input.focus === 'function') input.focus();
    },

    removeRow(el) {
        this.syncFromDom();
        const list = el && el.dataset ? el.dataset.list : '';
        const index = Number(el && el.dataset ? el.dataset.index : -1);
        if (!['iceBreakers', 'menu'].includes(list) || !Number.isInteger(index) || index < 0 || index >= this.draft[list].length) return;
        this.draft[list].splice(index, 1);
        this.error = null;
        this.repaint();
    },

    /** Put the suggested questions in the editor. They replace the questions only, never the menu the owner built, and they are still not saved. */
    useSuggestions() {
        this.syncFromDom();
        const items = (this.state && this.state.suggestions && this.state.suggestions.items) || [];
        this.draft.iceBreakers = items.map((b) => ({ question: String(b.question || ''), payload: String(b.payload || 'TAP_INFO') }));
        this.error = null;
        this.repaint();
    },

    /** Take a server answer as the state, and the draft from it. */
    apply(answer) {
        const keepLive = this.live;
        this.state = Object.assign({}, this.state, answer);
        this.draftFrom(this.state);
        this.live = keepLive;
        this.error = null;
    },

    /** SAVE: writes the draft to our own row. Nothing goes to Instagram. */
    async save(form, event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (this.busy) return;
        this.syncFromDom();
        const { payload, map } = this.toPayload();
        this.busy = 'save';
        this.error = null;
        this.repaint();
        try {
            const answer = await API.saveIceBreakers(payload);
            this.busy = null;
            this.apply(answer);
            this.repaint();
            UI.toast(t('iceb.saved'), 'success');
        } catch (err) {
            this.busy = null;
            this.error = this.describe(err, map);
            this.repaint();
        }
    },

    /** PUBLISH, step one: ask. Nothing is sent until the owner confirms. */
    publish() {
        if (!this.canPublish()) return;
        const cfg = this.state.config;
        Admin.confirm({
            title: t('iceb.publish.title'),
            body: t('iceb.publish.body', { ice: cfg.iceBreakers.length, menu: cfg.menu.length }),
            hint: t('iceb.publish.hint'),
            confirmLabel: t('iceb.publish.confirm'),
            confirmIcon: 'send',
            tone: 'primary',
            onConfirm: () => IceBreakersCard.publishConfirmed(),
        });
    },

    /** PUBLISH, step two: the one write to Instagram. */
    async publishConfirmed() {
        if (this.busy) return;
        this.busy = 'publish';
        this.error = null;
        this.repaint();
        try {
            const answer = await API.publishIceBreakers();
            this.busy = null;
            this.afterWrite(answer);
            UI.toast(t('iceb.published'), 'success');
        } catch (err) {
            this.busy = null;
            this.error = this.describe(err, null);
            this.repaint();
        }
    },

    /** REMOVE, step one: ask. */
    askRemove() {
        if (!this.connected() || this.busy) return;
        Admin.confirm({
            title: t('iceb.remove.title'),
            body: t('iceb.remove.body'),
            hint: t('iceb.remove.hint'),
            confirmLabel: t('iceb.remove.confirm'),
            confirmIcon: 'trash-2',
            onConfirm: () => IceBreakersCard.removeConfirmed(),
        });
    },

    async removeConfirmed() {
        if (this.busy) return;
        this.busy = 'remove';
        this.error = null;
        this.repaint();
        try {
            const answer = await API.removeIceBreakers();
            this.busy = null;
            this.afterWrite(answer);
            UI.toast(t('iceb.removed'), 'success');
        } catch (err) {
            this.busy = null;
            this.error = this.describe(err, null);
            this.repaint();
        }
    },

    /** What a publish or a removal answers: the new state, and what Instagram holds now (or why that could not be read). */
    afterWrite(answer) {
        this.apply(answer);
        this.live = answer && answer.live ? answer.live : null;
        this.liveNote = answer && answer.liveError ? t('iceb.readFailed', { message: String(answer.liveError) }) : '';
        this.repaint();
    },

    /** READ FROM INSTAGRAM: a read from Meta, shown as it is. Changes nothing. */
    async readLive() {
        if (!this.connected() || this.busy) return;
        this.busy = 'live';
        this.error = null;
        this.repaint();
        try {
            const answer = await API.readIceBreakersLive();
            this.busy = null;
            this.live = answer && answer.live ? answer.live : { iceBreakers: [], menu: [] };
            this.liveNote = '';
            this.repaint();
        } catch (err) {
            this.busy = null;
            this.error = this.describe(err, null);
            this.repaint();
        }
    },
};

UI.registerActions('iceb', {
    edit: () => IceBreakersCard.edit(),
    menuType: () => IceBreakersCard.menuType(),
    add: (el) => IceBreakersCard.add(el),
    removeRow: (el) => IceBreakersCard.removeRow(el),
    useSuggestions: () => IceBreakersCard.useSuggestions(),
    save: (el, e) => IceBreakersCard.save(el, e),
    publish: () => IceBreakersCard.publish(),
    askRemove: () => IceBreakersCard.askRemove(),
    readLive: () => IceBreakersCard.readLive(),
});
