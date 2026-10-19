/**
 * Settings: five tabs, one open at a time, so nothing here is a ten-screen scroll (UX US10; audit SE-02, SE-04, SE-05, ST-02).
 *
 *   Connections        a health summary first (one row per integration: one status, one detail, one action), then
 *                      Instagram & Facebook, TikTok, YouTube and WhatsApp
 *   Messages & alerts  Instagram ice breakers, handoff alerts
 *   Appearance         language and theme
 *   Advanced           (platform admin) the access token, the webhook verify token, the page ids
 *   Platform           (platform admin) what every workspace shares: the provider apps, media storage, the public site, onboarding
 *
 * The tab is the address: `#/settings?s=<tab>` (`App.route` writes it, `App.hashParams` reads it), so it survives a reload, Back works and
 * another screen can link to a tab, or to a card: `?s=meta` and `?s=<tab>&card=<id>` both open the card and put focus on it.
 *
 * Every card is drawn on every render. The tabs that are not open are `hidden`, not left out: a switch of tab changes nothing but which
 * panel shows, so a half-typed field in one tab is still there in another, and a dot on its tab says so. Each card's own markup, handlers
 * and save payloads are exactly what they were; the cards are only grouped, and wrapped in `[data-settings-card]` so the page can tell
 * which one a field belongs to.
 *
 * ─── Saving no longer throws away the other cards' edits (SE-02) ────────────
 * A save ends in `render()`, as it always did, and `render()` is now a REFRESH once the page is on screen: it keeps the page where it is
 * (no skeleton, same scroll), and a card that holds unsaved edits and was not the one just acted on is not redrawn at all: its live
 * element is carried into the new page, typed secrets and all, so nothing is copied out of a field and put back. `canLeave()` is true
 * only while no card holds unsaved edits, which is what the router's leave guard and the shared `beforeunload` ask.
 *
 * Every credential shown here is a Latin string sitting inside Arabic prose,
 * which is exactly where bidi goes wrong: an unisolated token preview drags
 * the sentence's punctuation to the wrong end. They all go through UI.ltr().
 */
const SettingsPage = {
    REQUIRED_SCOPES: [
        'pages_manage_engagement',
        'pages_messaging',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'instagram_content_publish',
        // Growth reads insights with these two (src/services/growth/common.ts);
        // without them the Growth screen reports numbers as missing.
        'instagram_manage_insights',
        'read_insights',
    ],

    /** The scopes above that only the Growth screen needs, tagged «للنمو». */
    GROWTH_SCOPES: ['instagram_manage_insights', 'read_insights'],

    /**
     * `t(key, params)` with ONE value isolated as Latin text, and the rest of
     * the sentence left to flow in the page's direction. `UI.ltr()` around the
     * whole translated sentence isolated the Arabic words too, so the sentence's
     * own punctuation landed at the wrong end.
     */
    ltrIn(key, params, name) {
        const MARK = '\u0000';
        const parts = t(key, Object.assign({}, params, { [name]: MARK })).split(MARK);
        if (parts.length !== 2) return t(key, params);
        return html`${parts[0]}${UI.ltr(params[name])}${parts[1]}`;
    },

    /** `ltrIn` for several values: each named value is isolated as Latin text, and the rest of the sentence flows in the page's direction. */
    ltrMany(key, params, names) {
        const probe = Object.assign({}, params);
        names.forEach((name, i) => { probe[name] = `\u0000${i}\u0000`; });
        const pieces = t(key, probe).split(/\u0000(\d+)\u0000/);
        // pieces: text, index, text, index ..., text
        return html`${pieces.map((piece, i) => (i % 2 === 1 ? UI.ltr(params[names[Number(piece)]]) : piece))}`;
    },

    // ─── The map: tabs and the cards in them ─────────────────────────────────

    /** The tabs, in order. A tab is shown only to a viewer who has a card in it. `platform`: what it holds applies to every workspace. */
    GROUPS: Object.freeze([
        Object.freeze({ id: 'connections' }),
        Object.freeze({ id: 'messages' }),
        Object.freeze({ id: 'appearance' }),
        Object.freeze({ id: 'advanced' }),
        Object.freeze({ id: 'platform', platform: true }),
    ]),

    DEFAULT_GROUP: 'connections',

    /**
     * Every card, in the order it is drawn inside its tab.
     *   id      the address (`?card=meta`, and `?s=meta`) and `data-settings-card`
     *   who     'all' | 'owner' (the workspace owner: `App.canAdminister()`) | 'admin' (the platform admin: `App.isAdmin()`)
     *   dom     the element a deep link scrolls to; the card's own `<section id>` when `inner`, else the wrapper this page draws
     *   focus   the control a row's Connect / Reconnect puts focus on, when the card has one
     *   platform  deployment-wide: it carries the «لكل المساحات» badge
     *   details   the card is a collapsed `<details>`, opened when it is the target
     */
    CARDS: Object.freeze([
        Object.freeze({ id: 'meta', group: 'connections', who: 'all', dom: 'settings-meta', inner: true, focus: 'meta-connect' }),
        Object.freeze({ id: 'tiktok', group: 'connections', who: 'all', dom: 'settings-tiktok', focus: 'settings-tiktok-connect' }),
        Object.freeze({ id: 'youtube', group: 'connections', who: 'all', dom: 'settings-youtube', focus: 'settings-youtube-connect' }),
        Object.freeze({ id: 'whatsapp', group: 'connections', who: 'all', dom: 'wa-card', inner: true, focus: 'wa-waba' }),
        Object.freeze({ id: 'iceb', group: 'messages', who: 'owner', dom: 'iceb-card', inner: true }),
        Object.freeze({ id: 'alerts', group: 'messages', who: 'admin', dom: 'settings-notify', platform: true }),
        Object.freeze({ id: 'appearance', group: 'appearance', who: 'all', dom: 'settings-appearance', focus: 'settings-lang' }),
        Object.freeze({ id: 'token', group: 'advanced', who: 'admin', dom: 'settings-token' }),
        Object.freeze({ id: 'webhook', group: 'advanced', who: 'admin', dom: 'settings-webhook' }),
        Object.freeze({ id: 'account', group: 'advanced', who: 'admin', dom: 'settings-account' }),
        Object.freeze({ id: 'meta-app', group: 'platform', who: 'admin', dom: 'settings-meta-app', platform: true, details: true }),
        Object.freeze({ id: 'tiktok-app', group: 'platform', who: 'admin', dom: 'settings-tiktok-app', platform: true, details: true }),
        Object.freeze({ id: 'youtube-app', group: 'platform', who: 'admin', dom: 'settings-youtube-app', platform: true, details: true }),
        Object.freeze({ id: 'storage', group: 'platform', who: 'admin', dom: 'settings-media', platform: true }),
        Object.freeze({ id: 'site', group: 'platform', who: 'admin', dom: 'settings-site', platform: true }),
        Object.freeze({ id: 'onboarding', group: 'platform', who: 'admin', dom: 'settings-onboarding', platform: true }),
    ]),

    cardById(id) {
        return this.CARDS.find((card) => card.id === id) || null;
    },

    /** May this viewer see the card? The same rules the cards always had: the owner's, the platform admin's, or everyone's. */
    cardVisible(card) {
        if (card.who === 'admin') return App.isAdmin();
        if (card.who === 'owner') return App.canAdminister();
        return true;
    },

    visibleCards(groupId) {
        return this.CARDS.filter((card) => card.group === groupId && this.cardVisible(card));
    },

    /** The tabs this viewer has cards in. */
    visibleGroups() {
        return this.GROUPS.filter((group) => this.visibleCards(group.id).length > 0);
    },

    /**
     * What the address asks for, as `{ group, card }`. `?s=` names a tab, or a card (`?s=meta`, the form the alerts link with); `?card=`
     * names a card inside the tab. A name this viewer cannot see, or that does not exist, is the default tab: an address never leads nowhere.
     */
    resolveView(params) {
        const p = params || {};
        const groups = this.visibleGroups().map((group) => group.id);
        const s = String(p.s || '');
        const wanted = String(p.card || '');
        const visibleCard = (id) => {
            const card = id ? this.cardById(id) : null;
            return card && this.cardVisible(card) ? card : null;
        };
        let group = groups.includes(s) ? s : '';
        let card = visibleCard(wanted);
        if (!group && !card) card = visibleCard(s);
        if (card && !group) group = card.group;
        if (card && card.group !== group) card = null;
        if (!groups.includes(group)) group = groups.includes(this.DEFAULT_GROUP) ? this.DEFAULT_GROUP : (groups[0] || this.DEFAULT_GROUP);
        return { group, card: card ? card.id : '' };
    },

    // ─── Page lifecycle ──────────────────────────────────────────────────────

    /**
     * Guards the write against landing after the operator has navigated away.
     * This page awaits its requests, so it owns the container for
     * longer than any other — and `#page-container` is refilled, never
     * replaced, so a late write lands on whatever page is there now. Same
     * `_seq`/`live()` shape as OverviewPage.
     */
    _seq: 0,

    /** The tab and card on screen: `{ group, card }`, or null before the first paint. */
    _view: null,

    destroy() {
        this._seq++;
        this._view = null;
        this._acted = null;
        this._saving.clear();
        this.unbindEdits();
        // The Page picker may still be open over the next screen; what it repaints on a change must not be this one.
        if (typeof MetaConnect !== 'undefined' && this._afterMeta && MetaConnect.afterChange === this._afterMeta) MetaConnect.afterChange = null;
    },

    skeleton() {
        return html`
            ${Motion.cardGrid(2, 5)}
            ${Motion.busy()}
        `;
    },

    /**
     * Everything the page shows, asked for at once. Each answer is its own: one that failed is that card's error with a Retry, never a
     * blank page and never the end of the others. (The access token's live check used to be asked FIRST and alone, and a failure of it
     * replaced the whole screen: SE-09.)
     */
    async load() {
        const ctx = {
            now: Date.now(),
            canAdmin: App.canAdminister(),
            isAdmin: App.isAdmin(),
            tokenStatus: null, tokenError: null,
            // The webhook verify token is the platform admin's. A failure to load it used to render "Not set" for a token that IS set,
            // inviting the creator to re-enter the one credential this project's docs say has already cost hours of debugging.
            webhookToken: null, webhookError: null,
            // The last webhook's age, for the Instagram & Facebook row. Optional: without it the row just does not say.
            health: null,
            // TikTok, YouTube, media storage, the public site, handoff alerts, onboarding and the provider apps: isolated like the rest.
            // The platform's own (storage, site, alerts, onboarding, the apps) are platform admins only.
            tiktok: null, tiktokError: null, tiktokApp: null, tiktokAppError: null,
            media: null, mediaError: null, cleanup: null,
            site: null, siteError: null,
            notify: null, notifyError: null,
            youtube: null, youtubeError: null, youtubeApp: null, youtubeAppError: null,
            onboarding: null, onboardingError: null,
            // Instagram & Facebook (P28), with the module that draws the card (loaded on first use, and shared with the wizard).
            meta: null, metaError: null, metaApp: null, metaAppError: null,
            // The Instagram ice breakers and persistent menu (DM plan S13): the tenant OWNER's, so nobody else is asked (the server refuses
            // them anyway). Reading them sends nothing to Instagram.
            iceBreakers: null, iceBreakersError: null,
            // WhatsApp (T025): any member reads it (the owner writes), with the module that draws the card (loaded on first use).
            whatsapp: null, whatsappError: null,
        };
        const [tk, wh, th, tt, ttApp, ms, st, yt, ytApp, cu, ob, mc, mcApp, mcModule, nt, ib, ibModule, wa, waModule] = await Promise.allSettled([
            API.getTokenStatus(),
            ctx.isAdmin ? API.getWebhookToken() : Promise.resolve(null),
            API.getTenantHealth(),
            API.getTikTokConnection(),
            App.isAdmin() ? API.getTikTokAppSettings() : Promise.resolve(null),
            App.isAdmin() ? API.getMediaStorage() : Promise.resolve(null),
            App.isAdmin() ? API.getSiteSettings() : Promise.resolve(null),
            API.getYouTubeConnection(),
            App.isAdmin() ? API.getYouTubeAppSettings() : Promise.resolve(null),
            App.isAdmin() ? API.getMediaCleanup() : Promise.resolve(null),
            App.isAdmin() ? API.getOnboardingSettings() : Promise.resolve(null),
            API.getMetaConnection(),
            App.isAdmin() ? API.getMetaAppSettings() : Promise.resolve(null),
            App.loadPageModule('meta_connect'),
            App.isAdmin() ? API.getNotifySettings() : Promise.resolve(null),
            App.canAdminister() ? API.getIceBreakers() : Promise.resolve(null),
            App.canAdminister() ? App.loadPageModule('ice_breakers') : Promise.resolve(null),
            API.getWhatsAppConnection(),
            App.loadPageModule('whatsapp_card'),
        ]);
        if (tk.status === 'fulfilled') ctx.tokenStatus = tk.value; else ctx.tokenError = tk.reason;
        if (wh.status === 'fulfilled') ctx.webhookToken = wh.value; else ctx.webhookError = wh.reason;
        if (th.status === 'fulfilled') ctx.health = th.value;
        if (wa.status === 'fulfilled') ctx.whatsapp = wa.value; else ctx.whatsappError = wa.reason;
        // A card whose module could not be fetched is a card that says so, with Retry: never a blank section.
        if (!ctx.whatsappError && !(waModule.status === 'fulfilled' && waModule.value)) ctx.whatsappError = new Error(t('wa.moduleFailed'));
        if (ib.status === 'fulfilled') ctx.iceBreakers = ib.value; else ctx.iceBreakersError = ib.reason;
        // A card whose module could not be fetched is a card that says so, with Retry: never a blank section.
        if (!ctx.iceBreakersError && App.canAdminister() && !(ibModule.status === 'fulfilled' && ibModule.value)) ctx.iceBreakersError = new Error(t('iceb.moduleFailed'));
        if (mc.status === 'fulfilled') ctx.meta = mc.value; else ctx.metaError = mc.reason;
        if (mcApp.status === 'fulfilled') ctx.metaApp = mcApp.value; else ctx.metaAppError = mcApp.reason;
        // A card whose module could not be fetched is a card that says so, with Retry: never a blank section.
        if (!ctx.metaError && !(mcModule.status === 'fulfilled' && mcModule.value)) ctx.metaError = new Error(t('meta.moduleFailed'));
        // The clean-up block is extra: if it fails to load, the storage card shows without it.
        if (cu.status === 'fulfilled') ctx.cleanup = cu.value;
        if (yt.status === 'fulfilled') ctx.youtube = yt.value; else ctx.youtubeError = yt.reason;
        if (ytApp.status === 'fulfilled') ctx.youtubeApp = ytApp.value; else ctx.youtubeAppError = ytApp.reason;
        if (tt.status === 'fulfilled') ctx.tiktok = tt.value; else ctx.tiktokError = tt.reason;
        if (ttApp.status === 'fulfilled') ctx.tiktokApp = ttApp.value; else ctx.tiktokAppError = ttApp.reason;
        if (ms.status === 'fulfilled') ctx.media = ms.value; else ctx.mediaError = ms.reason;
        if (st.status === 'fulfilled') ctx.site = st.value; else ctx.siteError = st.reason;
        if (nt.status === 'fulfilled') ctx.notify = nt.value; else ctx.notifyError = nt.reason;
        if (ob.status === 'fulfilled') ctx.onboarding = ob.value; else ctx.onboardingError = ob.reason;
        return ctx;
    },

    /**
     * Draw the page, or REFRESH it when it is already on screen (a save, a Retry, "Check again"). A refresh keeps what the person was
     * doing: no skeleton, the same scroll, the tab (it is the address), and every card that holds unsaved edits and is not the one they just
     * acted on, which is carried over as it is (see the header).
     */
    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const painted = typeof container.querySelector === 'function' ? container.querySelector('[data-settings-root]') : null;
        const scrollY = painted && typeof window.scrollY === 'number' ? window.scrollY : null;
        // The card the person just acted on is being saved (or disconnected, or cleaned up): it is redrawn from the answer, never carried.
        // Remembered until a render lands, so one that is overtaken by a later one still hands it on.
        const acted = this.takeActed();
        if (acted) this._saving.add(acted);
        const focus = UI.captureFocus(container);
        const gate = painted ? { done() {} } : Motion.beginLoad(container, () => this.skeleton());
        const seq = ++this._seq;
        const live = () => seq === this._seq && !!document.getElementById('page-container');

        const ctx = await this.load();
        if (!live()) return;
        gate.done();
        const saved = new Set(this._saving);
        this._saving.clear();

        const view = this.resolveView(App.hashParams());
        this._view = view;

        // The live elements of the cards to keep, taken BEFORE the page is replaced: the new markup holds an empty stand-in for each.
        const keep = painted ? this.dirtyCards(container).filter((id) => !saved.has(id) && this.cardById(id)) : [];
        const elements = {};
        keep.forEach((id) => { elements[id] = container.querySelector(`[data-settings-card="${id}"]`); });
        const carried = keep.filter((id) => elements[id]);

        container.innerHTML = esc(this.shell(ctx, view, carried));
        UI.icons(container);
        carried.forEach((id) => {
            const stand = container.querySelector(`[data-settings-card="${id}"][data-adopt]`);
            if (stand && typeof stand.replaceWith === 'function') stand.replaceWith(elements[id]);
        });

        this.bindEdits(container);
        this.syncDirtyDots();
        UI.restoreFocus(focus);
        if (painted) {
            if (scrollY !== null && typeof window.scrollTo === 'function') window.scrollTo({ top: scrollY, behavior: 'instant' });
        } else {
            Motion.announce(`${t('nav.settings')} — ${t('common.loaded')}`);
            if (view.card) this.revealCard(view.card);
            else this.scrollTabIntoView();
        }
        this.announceTikTokReturn();
        this.announceYouTubeReturn();
        this.announceMetaReturn().catch((err) => console.warn('Could not show the Meta return:', err));
    },

    /** The whole page: the tab bar, then every tab's panel (only the open one is not `hidden`). `carried`: cards whose live element is put back by `render`. */
    shell(ctx, view, carried) {
        const groups = this.visibleGroups();
        return html`
            <div data-settings-root>
                <div class="settings-tabbar" id="settings-tabbar">${this.tabsMarkup(view.group)}</div>
                ${groups.map((group) => html`
                    <div class="settings-panel" data-group="${group.id}" ${group.id === view.group ? '' : html.raw('hidden')}>
                        ${group.id === 'connections' ? this.connectionsLead(ctx) : ''}
                        ${group.platform ? html`<p class="form-hint settings-lead">${t('settings.platform.lead')}</p>` : ''}
                        ${this.visibleCards(group.id).map((card) => this.cardItem(card, carried.includes(card.id) ? null : this.renderCard(card.id, ctx)))}
                    </div>
                `)}
            </div>
        `;
    },

    /** One card inside its wrapper. `inner` null is the stand-in for a card carried over from the page before. */
    cardItem(card, inner) {
        if (inner === null) return html`<div class="settings-item" data-settings-card="${card.id}" data-adopt></div>`;
        // A card that has nothing to draw for this viewer (a provider's app, when its settings did not come) leaves no badge hanging over nothing.
        if (!String(inner).trim()) return '';
        return html`
            <div class="settings-item" data-settings-card="${card.id}"${card.inner ? '' : html` id="${card.dom}"`}>
                ${card.platform ? html`<p class="settings-scope"><span class="badge badge-neutral">${t('settings.scope.platform')}</span></p>` : ''}
                ${inner}
            </div>
        `;
    },

    renderCard(id, ctx) {
        switch (id) {
            case 'meta': return this.metaSection({ meta: ctx.meta, metaError: ctx.metaError, metaApp: null, metaAppError: null });
            case 'tiktok': return this.tiktokSection({ tiktok: ctx.tiktok, tiktokError: ctx.tiktokError });
            case 'youtube': return this.youtubeSection({ youtube: ctx.youtube, youtubeError: ctx.youtubeError });
            case 'whatsapp': return this.whatsappSection(ctx.whatsapp, ctx.whatsappError);
            case 'iceb': return this.iceBreakersSection(ctx.iceBreakers, ctx.iceBreakersError);
            case 'alerts': return this.notifySection(ctx.notify, ctx.notifyError);
            case 'appearance': return this.appearanceSection();
            case 'token': return this.accessTokenSection(ctx);
            case 'webhook': return this.webhookSection(ctx);
            case 'account': return this.accountSection(ctx);
            case 'meta-app': return this.metaAppSection(ctx);
            case 'tiktok-app': return this.tiktokAppSection(ctx);
            case 'youtube-app': return this.youtubeAppSection(ctx);
            case 'storage': return this.mediaStorageSection(ctx.media, ctx.mediaError, ctx.cleanup);
            case 'site': return this.siteSection(ctx.site, ctx.siteError);
            case 'onboarding': return this.onboardingSection(ctx.onboarding, ctx.onboardingError);
            default: return '';
        }
    },

    // ─── The tab bar, and which tab is open ──────────────────────────────────

    tabsMarkup(active) {
        const items = this.visibleGroups().map((group) => ({
            key: group.id,
            href: App.route('settings', { s: group.id }),
            // The dot is drawn hidden on every tab; `syncDirtyDots` shows it on a tab that holds unsaved edits. Its words are for a screen reader.
            label: html`${t(`settings.group.${group.id}`)}${group.platform ? html` <span class="badge badge-neutral settings-tab-badge">${t('settings.scope.platform')}</span>` : ''}<span class="settings-tab-dot" data-settings-dot="${group.id}" role="img" aria-label="${t('settings.tab.unsaved')}" hidden></span>`,
        }));
        return UI.tabs(items, { mode: 'link', current: active, label: t('settings.nav.label') });
    },

    /**
     * A change of address inside the page (a tab, or a deep link to a card): the panels and the tab marks follow it, and nothing is drawn
     * again, so what was typed in any tab is still there. The router calls this instead of tearing the page down.
     */
    onHashChange() {
        this.applyView();
    },

    applyView() {
        const view = this.resolveView(App.hashParams());
        const before = this._view;
        this._view = view;
        const container = document.getElementById('page-container');
        if (!container || typeof container.querySelectorAll !== 'function') return view;
        container.querySelectorAll('.settings-panel').forEach((panel) => { panel.hidden = panel.dataset.group !== view.group; });
        const ids = this.visibleGroups().map((group) => group.id);
        container.querySelectorAll('.settings-tabbar a.ui-tab').forEach((link, i) => {
            if (ids[i] === view.group) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
        if (view.card) {
            this.revealCard(view.card);
        } else if ((!before || before.group !== view.group) && typeof window.scrollTo === 'function') {
            window.scrollTo({ top: 0 });
        }
        this.scrollTabIntoView();
        if (!before || before.group !== view.group) Motion.announce(t(`settings.group.${view.group}`));
        return view;
    },

    /** On a phone the tabs are a row that scrolls sideways: keep the open one in it. */
    scrollTabIntoView() {
        const current = typeof document.querySelector === 'function' ? document.querySelector('.settings-tabbar a.ui-tab[aria-current="page"]') : null;
        if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' });
    },

    /**
     * Open a card from wherever the person is: a row of the health summary, a Connect button on another tab, an address. In another tab,
     * the address changes (so Back returns), and `applyView` does the rest; in this one, scroll to it and focus it.
     */
    openCard(id) {
        const card = id ? this.cardById(id) : null;
        if (!card || !this.cardVisible(card)) return;
        const here = this._view && this._view.group === card.group;
        if (!here) {
            location.hash = App.route('settings', { s: card.group, card: card.id });
            return;
        }
        this.revealCard(card.id);
    },

    /**
     * Scroll to a card and put focus on its main control (its Connect button, say), else on its title. The scroll offset that keeps the card
     * clear of the sticky header and tab bar is the card's `scroll-margin`. A collapsed card that is only a `<details>` is opened first.
     */
    revealCard(id) {
        const spec = this.cardById(id);
        const el = spec ? document.getElementById(spec.dom) : null;
        if (!el) return;
        if (spec.details && typeof el.querySelector === 'function') {
            const fold = el.querySelector('details');
            if (fold && !fold.open) fold.open = true;
        }
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: Motion.reduced() ? 'auto' : 'smooth' });
        let target = spec.focus ? document.getElementById(spec.focus) : null;
        if (!target && typeof el.querySelector === 'function') target = el.querySelector('h2, summary, button, a[href]');
        if (target && typeof target.focus === 'function') {
            // A title is not a control: give it a place in the focus order only for this, so a screen reader announces where it landed.
            if (target.tagName === 'H2' && typeof target.setAttribute === 'function') target.setAttribute('tabindex', '-1');
            target.focus({ preventScroll: true });
        }
    },

    // ─── Unsaved edits (SE-02) ───────────────────────────────────────────────

    /** Fields that never count as an edit: they hold no setting. */
    UNTRACKED_TYPES: Object.freeze(['file', 'hidden', 'button', 'submit', 'reset', 'image']),

    /**
     * Does this field differ from what the page drew? A text field against its `value` attribute, a box against `checked`, a select against
     * its default option. Pure: it reads the element and nothing else.
     */
    fieldIsDirty(el) {
        if (!el) return false;
        const type = String(el.type || '').toLowerCase();
        if (this.UNTRACKED_TYPES.includes(type)) return false;
        if (type === 'checkbox' || type === 'radio') return Boolean(el.checked) !== Boolean(el.defaultChecked);
        if (el.options) {
            const options = Array.from(el.options);
            // A select with no option marked as the default shows its first one: that is the default.
            const marked = options.findIndex((option) => option.defaultSelected);
            return el.selectedIndex !== (marked === -1 ? 0 : marked);
        }
        return String(el.value === undefined || el.value === null ? '' : el.value) !== String(el.defaultValue === undefined || el.defaultValue === null ? '' : el.defaultValue);
    },

    /**
     * The cards (by id) with unsaved edits in `root`: a changed field inside a `<form>`. A control that applies the moment it is touched (the
     * language and theme, the clean-up switch) is not in a form, so it never counts.
     */
    dirtyCards(root) {
        const host = root || document.getElementById('page-container');
        if (!host || typeof host.querySelectorAll !== 'function') return [];
        const out = [];
        host.querySelectorAll('[data-settings-card]').forEach((card) => {
            const id = card.dataset && card.dataset.settingsCard;
            if (!id || typeof card.querySelectorAll !== 'function') return;
            if (Array.from(card.querySelectorAll('form input, form select, form textarea')).some((field) => this.fieldIsDirty(field))) out.push(id);
        });
        return out;
    },

    /** The router's leave guard, and the shared `beforeunload` (a reload, a closed tab, the language switch): is any card holding edits? */
    canLeave() {
        return this.dirtyCards().length === 0;
    },

    /** Show the dot on each tab that holds unsaved edits, hide it on the rest. */
    syncDirtyDots() {
        if (typeof document.querySelectorAll !== 'function') return;
        const groups = new Set(this.dirtyCards().map((id) => (this.cardById(id) || {}).group));
        document.querySelectorAll('[data-settings-dot]').forEach((dot) => {
            dot.hidden = !groups.has(dot.dataset.settingsDot);
        });
    },

    /** The card a control sits in, or ''. */
    cardOfElement(el) {
        const wrap = el && typeof el.closest === 'function' ? el.closest('[data-settings-card]') : null;
        return wrap && wrap.dataset ? wrap.dataset.settingsCard || '' : '';
    },

    /**
     * How long, in ms, "the card they just acted on" stays that. A button that asks first (Disconnect, Remove) is pressed in the card and its
     * answer comes from a dialog, so this has to outlast somebody reading the question; two minutes does, and no longer than that.
     */
    ACTED_MS: 120000,
    _acted: null,
    /** Cards acted on by a render that has not landed yet. */
    _saving: new Set(),

    /** A button or a form in a card was used: that card is the one being saved, so its own edits are not the ones to keep. */
    noteActed(el) {
        const id = this.cardOfElement(el);
        this._acted = id ? { id, at: Date.now() } : null;
    },

    takeActed() {
        const acted = this._acted;
        this._acted = null;
        return acted && Date.now() - acted.at < this.ACTED_MS ? acted.id : '';
    },

    _editHost: null,
    _onEdit: null,
    _onAct: null,
    _onSubmit: null,

    /** Listen on the page container, once: typing moves the dots, and a click or submit says which card is acting. */
    bindEdits(container) {
        this.unbindEdits();
        if (!container || typeof container.addEventListener !== 'function') return;
        this._editHost = container;
        this._onEdit = () => this.syncDirtyDots();
        this._onAct = (event) => {
            const target = event && event.target;
            const control = target && typeof target.closest === 'function' ? target.closest('[data-action], button[type="submit"]') : null;
            if (!control) { this._acted = null; return; }
            // Copying a value is not an act on the card.
            if (String(control.getAttribute('data-action') || '').startsWith('app:')) return;
            this.noteActed(control);
        };
        this._onSubmit = (event) => this.noteActed(event && event.target);
        container.addEventListener('input', this._onEdit);
        container.addEventListener('change', this._onEdit);
        container.addEventListener('click', this._onAct, true);
        container.addEventListener('submit', this._onSubmit, true);
    },

    unbindEdits() {
        const host = this._editHost;
        if (host && typeof host.removeEventListener === 'function') {
            host.removeEventListener('input', this._onEdit);
            host.removeEventListener('change', this._onEdit);
            host.removeEventListener('click', this._onAct, true);
            host.removeEventListener('submit', this._onSubmit, true);
        }
        this._editHost = null;
        this._onEdit = null;
        this._onAct = null;
        this._onSubmit = null;
    },

    // ─── Connections health: one row per integration (SE-04, SE-08) ──────────

    /**
     * ONE rule for every connection that runs out (SE-08): amber at 14 days or fewer, red at 3 or fewer (or once it has passed). It was a
     * different number on every card: 7, 14, 30 days, or never.
     */
    EXPIRY: Object.freeze({ amber: 14, red: 3 }),

    /** Order of the rows: what is broken first, what is fine last. A check that could not run sits above "not set up": it is unanswered, not absent. */
    SEVERITY: Object.freeze({ broken: 0, expiring: 1, unknown: 2, not_set_up: 3, fine: 4 }),

    /** Rows in these states are what the headline counts. */
    NEEDS_ATTENTION: Object.freeze(['broken', 'expiring', 'unknown']),

    /** Media storage is "nearly full" from this share of its tier. */
    STORAGE_NEAR_FULL: 0.9,

    /** Whole days from `now` to `value`, rounded up, or null when `value` is empty or not a date. */
    daysUntil(value, now) {
        if (!value) return null;
        const at = new Date(value);
        if (Number.isNaN(at.getTime())) return null;
        return Math.ceil((at.getTime() - now) / 86400000);
    },

    /** The state a number of days left means: `broken` (red) at 3 or fewer, `expiring` (amber) at 14 or fewer, else `fine`. No date is `fine`. */
    expiryState(days) {
        if (days === null || days === undefined) return 'fine';
        if (days <= this.EXPIRY.red) return 'broken';
        if (days <= this.EXPIRY.amber) return 'expiring';
        return 'fine';
    },

    /** The nearest of several dates, as `{ days, at }`, or null when none is a date. */
    soonest(values, now) {
        let best = null;
        values.forEach((value) => {
            const days = this.daysUntil(value, now);
            if (days !== null && (best === null || days < best.days)) best = { days, at: new Date(value) };
        });
        return best;
    },

    /** The one sentence for "this runs out": the same words on every row. */
    within(days, at) {
        return days <= 0 ? t('settings.health.expired') : t('settings.health.within', { count: days, date: UI.formatDay(at) });
    },

    /** Parts of a detail line, with a dot between the ones that are there; `fallback` when none is. */
    joinDetail(parts, fallback) {
        const list = parts.filter(Boolean);
        if (list.length === 0) return fallback || '';
        return html`${list.map((part, i) => html`${i > 0 ? ' · ' : ''}${part}`)}`;
    },

    /** How long ago the last webhook arrived, as words, or '' when it is not known. */
    webhookAge(health) {
        const at = health && (health.lastWebhookAt || health.last_webhook_at);
        if (!at || Number.isNaN(new Date(at).getTime())) return '';
        return UI.relativeAge(at).text;
    },

    bytesText(n) {
        return typeof Admin !== 'undefined' && typeof Admin.bytes === 'function' ? Admin.bytes(n) : String(n);
    },

    /**
     * A row. Only the workspace owner can connect or reconnect, so anyone else is given the card to read, not a button the server would
     * refuse. `kind` is 'connect' | 'reconnect' | 'open'; every one only OPENS the card (and puts focus on its button): nothing here starts
     * an authorisation or changes a setting by itself.
     */
    healthRow(ctx, id, name, state, detail, kind, extra) {
        const action = (kind === 'connect' || kind === 'reconnect') && !ctx.canAdmin ? 'open' : kind;
        return Object.assign({ id, name, state, detail, action, target: id, platform: false }, extra || {});
    },

    /**
     * The rows, worst first: `{ id, name, state, detail, action, target, platform }`, state one of `broken | expiring | unknown | not_set_up
     * | fine`. Derived from what the page already loaded. Three rules hold for every row:
     *   - "not connected yet" is `not_set_up` (grey), never red (SE-01);
     *   - a failed request is `unknown` (it could not be checked), never `broken`: a network error is not a verdict on the account;
     *   - a date that runs out follows `expiryState`, the same for all.
     * A provider the platform has not set up is not a row for a tenant (the wizard hides it the same way); the platform admin sees it, with
     * the way to the app settings.
     */
    connectionRows(ctx) {
        const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
        const rows = [this.metaRow(ctx, now), this.tiktokRow(ctx, now), this.youtubeRow(ctx, now), this.whatsappRow(ctx, now)];
        if (ctx.isAdmin) rows.push(this.storageRow(ctx), this.alertsRow(ctx));
        return rows.filter(Boolean)
            .map((row, order) => ({ row, order }))
            .sort((a, b) => this.SEVERITY[a.row.state] - this.SEVERITY[b.row.state] || a.order - b.order)
            .map((entry) => entry.row);
    },

    metaRow(ctx, now) {
        const name = t('meta.title');
        const row = (state, detail, kind) => this.healthRow(ctx, 'meta', name, state, detail, kind);
        const c = ctx.meta && ctx.meta.connection;
        const connected = !!(c && c.connected);
        const state = ctx.tokenError ? 'unknown' : this.tokenState(ctx.tokenStatus);
        // Meta rejected the token, live; or Meta could not be asked and the stored status says it was rejected.
        if (state === 'invalid' || (state === 'unknown' && !!c && c.tokenStatus === 'invalid')) return row('broken', t('settings.health.meta.invalid'), 'reconnect');
        if (state === 'not_connected' && !connected) return row('not_set_up', t('settings.health.meta.notConnected'), 'connect');
        if (state !== 'valid') return row('unknown', t('settings.health.meta.unknown'), 'open');
        const status = ctx.tokenStatus;
        const due = this.soonest([status.dataAccessExpiresAt, status.expiresAt, c && c.dataAccessExpiresAt, c && c.tokenExpiresAt], now);
        const dueState = due ? this.expiryState(due.days) : (c && c.reconnectDue === true ? 'expiring' : 'fine');
        if (dueState !== 'fine') return row(dueState, due ? this.within(due.days, due.at) : t('settings.health.reconnectSoon'), 'reconnect');
        if (c && c.via === 'login' && c.webhookSubscribed === false) return row('expiring', t('settings.health.meta.webhookOff'), 'open');
        const age = this.webhookAge(ctx.health);
        return row('fine', this.joinDetail([
            c && c.instagramUsername ? UI.ltr(`@${c.instagramUsername}`) : '',
            age ? t('settings.health.lastWebhook', { age }) : '',
        ], t('settings.health.meta.connected')), 'open');
    },

    /** TikTok and YouTube answer alike: an app the platform set up, a connection that is there, broken or not, and an end date. */
    providerRow(ctx, now, spec) {
        const row = (state, detail, kind, target) => this.healthRow(ctx, spec.id, spec.name, state, detail, kind, target ? { target } : null);
        if (spec.error) return row('unknown', t('settings.health.unknown'), 'open');
        const data = spec.data;
        if (!data) return null;
        if (!data.appConfigured) return ctx.isAdmin ? row('not_set_up', t('settings.health.platformNotSet'), 'open', spec.appCard) : null;
        const c = data.connection;
        const needsReconnect = !!(c && c.status === 'invalid');
        if (needsReconnect) return row('broken', t('settings.health.invalid'), 'reconnect');
        if (!(c && c.connected)) return row('not_set_up', t('settings.health.notConnected'), 'connect');
        const due = this.soonest([c.refreshExpiresAt], now);
        const dueState = due ? this.expiryState(due.days) : 'fine';
        if (dueState !== 'fine') return row(dueState, this.within(due.days, due.at), 'reconnect');
        if (spec.cannotPost(c)) return row('expiring', t('settings.health.cannotPost'), 'reconnect');
        const who = spec.who(c) ? html`<bdi dir="auto">${spec.who(c)}</bdi>` : '';
        return row('fine', this.joinDetail([who, due ? t('settings.health.reconnectBy', { date: UI.formatDay(due.at) }) : ''], t('settings.health.connected')), 'open');
    },

    tiktokRow(ctx, now) {
        return this.providerRow(ctx, now, {
            id: 'tiktok', name: t('settings.tiktok.title'), data: ctx.tiktok, error: ctx.tiktokError, appCard: 'tiktok-app',
            who: (c) => c.displayName || '',
            cannotPost: (c) => !c.canUpload && !c.canDirectPost,
        });
    },

    youtubeRow(ctx, now) {
        return this.providerRow(ctx, now, {
            id: 'youtube', name: t('settings.youtube.title'), data: ctx.youtube, error: ctx.youtubeError, appCard: 'youtube-app',
            who: (c) => c.channelTitle || '',
            cannotPost: (c) => !c.canUpload,
        });
    },

    whatsappRow(ctx, now) {
        const row = (state, detail, kind) => this.healthRow(ctx, 'whatsapp', t('wa.title'), state, detail, kind);
        if (ctx.whatsappError) return row('unknown', t('settings.health.unknown'), 'open');
        const wa = ctx.whatsapp;
        if (!wa) return null;
        if (!wa.connected && wa.status === 'invalid') return row('broken', t('settings.health.invalid'), 'reconnect');
        if (!wa.connected) return row('not_set_up', t('settings.health.notConnected'), 'connect');
        const due = this.soonest([wa.token_expires_at], now);
        const dueState = due ? this.expiryState(due.days) : 'fine';
        if (dueState !== 'fine') return row(dueState, this.within(due.days, due.at), 'reconnect');
        return row('fine', this.joinDetail([
            wa.display_phone_number ? UI.ltr(wa.display_phone_number) : '',
            wa.verified_name ? html`<bdi dir="auto">${wa.verified_name}</bdi>` : '',
        ], t('settings.health.connected')), 'open');
    },

    storageRow(ctx) {
        const row = (state, detail) => this.healthRow(ctx, 'storage', t('settings.media.title'), state, detail, 'open', { platform: true });
        if (ctx.mediaError) return row('unknown', t('settings.health.unknown'));
        const ms = ctx.media;
        if (!ms) return null;
        if (ms.backend !== 'supabase') return row('not_set_up', t('settings.health.media.database'));
        const c = ms.connection;
        if (!(c && c.ok)) return row('broken', t('settings.health.media.failed'));
        if (c.bucketExists === false) return row('broken', t('settings.health.media.bucketMissing'));
        const u = ms.usage;
        if (u && Number(u.tierBytes) > 0 && u.storage) {
            const used = this.bytesText(u.storage.bytes);
            const total = this.bytesText(u.tierBytes);
            const near = Number(u.storage.bytes) / Number(u.tierBytes) >= this.STORAGE_NEAR_FULL;
            return row(near ? 'expiring' : 'fine', this.ltrMany(near ? 'settings.health.media.nearFull' : 'settings.health.media.used', { used, total }, ['used', 'total']));
        }
        return row('fine', t('settings.health.media.ok'));
    },

    alertsRow(ctx) {
        const row = (state, detail) => this.healthRow(ctx, 'alerts', t('settings.notify.title'), state, detail, 'open', { platform: true });
        if (ctx.notifyError) return row('unknown', t('settings.health.unknown'));
        const nt = ctx.notify;
        if (!nt) return null;
        const tg = nt.telegram || {};
        const em = nt.email || {};
        const telegramReady = !!(tg.enabled && tg.botToken && tg.botToken.set && tg.chatId);
        const emailReady = !!(em.ready && em.to);
        const channels = [telegramReady ? t('settings.health.alerts.telegram') : '', emailReady ? t('settings.health.alerts.email') : ''].filter(Boolean);
        if (channels.length > 0) return row('fine', t('settings.health.alerts.on', { channels: channels.join(' · ') }));
        // A channel switched on that cannot send is worse than none: the owner believes they will be told.
        if ((tg.enabled && !telegramReady) || (em.enabled && !emailReady)) return row('expiring', t('settings.health.alerts.incomplete'));
        return row('not_set_up', t('settings.health.alerts.none'));
    },

    /** The summary and, under it, the missing-permissions warning this tab has always carried. */
    connectionsLead(ctx) {
        return html`${this.healthMarkup(this.connectionRows(ctx))}${this.scopesWarning(ctx)}`;
    },

    healthRowMarkup(row) {
        const pill = UI.statusPill('connection', row.state, row.state === 'unknown' ? { label: t('settings.tokenUnknown') } : undefined);
        const verb = t(`settings.health.${row.action}`);
        return html`
            <li class="settings-row" data-row="${row.id}" data-state="${row.state}">
                <div class="settings-row-head">
                    <strong class="settings-row-name">${row.name}</strong>
                    ${row.platform ? html`<span class="badge badge-neutral settings-row-badge">${t('settings.scope.platform')}</span>` : ''}
                    ${pill}
                </div>
                <p class="settings-row-detail" dir="auto">${row.detail}</p>
                <div class="settings-row-action">
                    ${UI.button({
                        variant: 'secondary', size: 'sm', label: verb,
                        ariaLabel: t('settings.health.actionFor', { action: verb, name: row.name }),
                        action: 'settings:openCard', data: { card: row.target },
                    })}
                </div>
            </li>
        `;
    },

    /**
     * The panel itself. Everything fine is one line («كل الاتصالات تعمل») with the rows behind «عرض التفاصيل»; anything that needs the owner
     * shows the rows, worst first, under a headline that counts them. Nothing connected yet says that, with the rows (and their Connect).
     */
    healthMarkup(rows) {
        const needs = rows.filter((row) => this.NEEDS_ATTENTION.includes(row.state));
        const fine = rows.filter((row) => row.state === 'fine');
        const list = html`<ul class="settings-rows">${rows.map((row) => this.healthRowMarkup(row))}</ul>`;
        let body;
        if (needs.length === 0 && fine.length > 0) {
            body = html`
                <details class="settings-health-fold">
                    <summary class="settings-health-head is-fine">
                        <span class="settings-health-glyph" aria-hidden="true">●</span>
                        <strong>${t('settings.health.allFine')}</strong>
                        <span class="settings-health-more">${t('settings.health.showDetails')}<i data-lucide="chevron-down" aria-hidden="true"></i></span>
                    </summary>
                    ${list}
                </details>
            `;
        } else if (needs.length === 0) {
            body = html`
                <p class="settings-health-head"><span class="settings-health-glyph" aria-hidden="true">○</span> <strong>${t('settings.health.nothing')}</strong></p>
                ${list}
            `;
        } else {
            body = html`
                <p class="settings-health-head ${needs.some((row) => row.state === 'broken') ? html.raw('is-broken') : html.raw('is-attention')}" role="status">
                    <span class="settings-health-glyph" aria-hidden="true">${needs.some((row) => row.state === 'broken') ? '✕' : '▲'}</span>
                    <strong>${t('settings.health.needs', { count: needs.length })}</strong>
                </p>
                ${list}
            `;
        }
        return html`
            <section class="section settings-summary" id="settings-summary" aria-labelledby="settings-summary-title">
                <div class="settings-summary-top">
                    <h2 class="section-title" id="settings-summary-title">${t('settings.health.title')}</h2>
                    ${UI.button({ variant: 'ghost', size: 'sm', icon: 'rotate-cw', label: t('settings.health.recheck'), action: 'settings:render', id: 'settings-recheck' })}
                </div>
                <div class="settings-card surface">${body}</div>
            </section>
        `;
    },

    /** The permissions Meta did not grant: a warning card, only while the token is valid and some are missing. */
    scopesWarning(ctx) {
        const status = ctx.tokenStatus;
        const missingScopes = status && this.tokenState(status) === 'valid' && Array.isArray(status.scopes)
            ? this.REQUIRED_SCOPES.filter((scope) => !status.scopes.includes(scope))
            : [];
        if (missingScopes.length === 0) return '';
        return html`
            <div class="warning-card" role="alert">
                <div class="row row--start gap-4">
                    <span class="stat-icon warning shrink-0"><i data-lucide="alert-triangle" aria-hidden="true"></i></span>
                    <div>
                        <h3 class="warning-card-title">${t('settings.missingScopesTitle')}</h3>
                        <p class="mbe-3">${t('settings.missingScopesBody')}</p>
                        <ul class="warning-card-list">
                            ${missingScopes.map((s) => html`<li>${this.ltrIn('settings.scopeRequired', {
                                name: s, desc: t(`settings.scope.${s}`),
                            }, 'name')}${this.GROWTH_SCOPES.includes(s) ? html` <span class="badge badge-info">${t('settings.scopeForGrowth')}</span>` : ''}</li>`)}
                        </ul>
                    </div>
                </div>
            </div>
        `;
    },

    // ─── Advanced (platform admin): the access token, the webhook, the page ids ─────────────────────────

    /** A card that could not load: its title, why, and Retry. The same shape every card has always had. */
    cardError(id, title, message) {
        return html`
            <section class="section" id="${id}">
                <h2 class="section-title">${title}</h2>
                <div class="settings-card surface">
                    <div class="inline-error" role="alert">
                        <i data-lucide="alert-circle" aria-hidden="true"></i>
                        <div><strong dir="auto">${message}</strong></div>
                    </div>
                    ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
                </div>
            </section>
        `;
    },

    accessTokenSection(ctx) {
        const { tokenStatus } = ctx;
        if (ctx.tokenError || !tokenStatus) {
            return this.cardError('settings-token-card', t('settings.accessToken'), t('settings.token.loadFailed', { message: (ctx.tokenError && ctx.tokenError.message) || '' }));
        }
        // Four states, not two (SE-01, OV-08): what Meta said (`valid`, `invalid`), a tenant that never connected, and a check
        // that could not run. Everything but `invalid` used to be drawn as the red "Invalid / expired".
        const tokenState = this.tokenState(tokenStatus);
        const isValid = tokenState === 'valid';
        const expiresAt = tokenStatus.expiresAt ? new Date(tokenStatus.expiresAt) : null;
        const daysLeft = expiresAt ? Math.ceil((expiresAt - Date.now()) / 86400000) : null;
        // The 90-day data-access window is the date that actually lapses on a
        // never-expiring page token. It was fetched and never shown.
        const dataAccessAt = tokenStatus.dataAccessExpiresAt ? new Date(tokenStatus.dataAccessExpiresAt) : null;
        const dataAccessDays = dataAccessAt && !Number.isNaN(dataAccessAt.getTime())
            ? Math.ceil((dataAccessAt - Date.now()) / 86400000) : null;
        // The token, extend and verify-token routes are owner-only on the server
        // (`canAdminister`); an operator who could see the forms only learned that
        // from a 403 after pasting a 200-character token.
        const canAdmin = ctx.canAdmin;
        // Only a token Meta rejected has a reason of Meta's to show. The other two states say their own sentence: the server's
        // `message` for them is English, and was being printed inside the Arabic page (SE-01).
        const tokenReason = tokenState === 'invalid' ? (tokenStatus.error || tokenStatus.message || '') : '';

        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.accessToken')}</h2>
                <div class="settings-card surface">
                    <div class="token-status">
                        ${this.tokenPill(tokenState)}
                        ${tokenStatus.type ? html`<span class="text-meta">${t('settings.tokenType', { type: tokenStatus.type })}</span>` : ''}
                    </div>
                    ${tokenState === 'not_connected' ? this.notConnectedNote(canAdmin) : ''}
                    ${tokenState === 'unknown' ? this.tokenUnknownNote() : ''}
                    ${tokenReason ? html`<div class="mbe-4">${UI.errorStrip(t('settings.tokenProblem'), tokenReason)}</div>` : ''}
                    <p class="form-hint mbe-4">${UI.helpLink('connect-meta#token-health', t('help.link.tokenHealth'), { newTab: true })}</p>

                    ${expiresAt ? html`
                        <div class="row row--wrap gap-3 mbe-4">
                            <p class="token-info">
                                ${t('settings.expires', { date: UI.formatDay(expiresAt) })}
                                ${daysLeft !== null ? html`
                                    <span class="${daysLeft < 7 ? html.raw('text-warning') : ''}">
                                        ${daysLeft > 0
                                            ? t('settings.daysLeft', { count: daysLeft })
                                            : t('settings.expired')}
                                    </span>
                                ` : ''}
                            </p>
                            ${canAdmin ? UI.button({
                                variant: 'secondary', size: 'sm', icon: 'refresh-cw',
                                label: t('settings.extend'),
                                action: 'settings:extendToken', id: 'settings-extend',
                            }) : ''}
                        </div>
                    ` : (isValid ? html`
                        <p class="token-info mbe-4">${t('settings.expiresNever')}</p>
                    ` : '')}
                    ${dataAccessAt && dataAccessDays !== null ? html`
                        <p class="token-info mbe-4">
                            ${t('settings.dataAccessExpires', { date: UI.formatDay(dataAccessAt) })}
                            <span class="${dataAccessDays < 14 ? html.raw('text-warning') : ''}">
                                ${dataAccessDays > 0 ? t('settings.daysLeft', { count: dataAccessDays }) : t('settings.expired')}
                            </span>
                            <span class="form-hint">${t('settings.dataAccessHint')}</span>
                        </p>
                    ` : ''}

                    ${tokenStatus.scopes ? html`
                        <div class="mbe-4">
                            <p class="form-label">${t('settings.permissions')}</p>
                            <div class="scope-list">
                                ${tokenStatus.scopes.map((s) => html`<span class="chip">${UI.ltr(s)}</span>`)}
                            </div>
                        </div>
                    ` : ''}

                    ${canAdmin ? html`
                    <div class="settings-block">
                        <label class="form-label" for="settings-token-input">${t('settings.updateToken')}</label>
                        <p class="form-hint mbe-3">${t('settings.updateTokenHint')}</p>
                        <form id="token-form" data-submit="settings:handleTokenUpdate">
                            <!-- autocomplete/spellcheck off, matching the webhook
                                 field below and the confirm dialog's echo input.
                                 This one carried a live, never-expiring Meta Page
                                 Access Token in a plain spellchecked textarea:
                                 browsers with enhanced spell check send field
                                 contents to a remote service, and autofill will
                                 happily remember and re-offer a 200-character
                                 credential. The value is the one thing on this
                                 screen that must not leave the page by any route
                                 but the submit. -->
                            <textarea class="field-textarea field-mono" id="settings-token-input" name="token" dir="ltr"
                                      autocomplete="off" spellcheck="false" autocapitalize="off"
                                      placeholder="${t('settings.tokenPlaceholder')}" required></textarea>
                            <div class="form-actions">
                                ${UI.button({
                                    variant: 'primary', size: 'sm', type: 'submit', icon: 'key',
                                    label: t('settings.validateSave'), id: 'settings-token-submit',
                                })}
                            </div>
                        </form>
                    </div>
                    ` : html`<p class="form-hint">${t('settings.ownerOnlyMeta')}</p>`}
                </div>
            </section>
        `;
    },

    webhookSection(ctx) {
        const { webhookToken, webhookError } = ctx;
        const canAdmin = ctx.canAdmin;
        const webhookUrl = (webhookToken && webhookToken.webhookUrl) || `${location.origin}/webhook`;
        // When the fetch failed we do not know whether the token is set in the
        // environment, and the sentence that says so was being rendered with a
        // bare "." interpolated where the answer should be. There is no copy
        // for "unknown", so the sentence is simply not claimed.
        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.webhookTitle')}</h2>
                <div class="settings-card surface">
                    ${webhookError || !webhookToken ? html`
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div>
                                <strong dir="auto">${t('settings.webhookUnknown', { message: (webhookError && webhookError.message) || '' })}</strong>
                                <span class="inline-error-hint">${t('settings.webhookUnknownHint')}</span>
                            </div>
                        </div>
                        ${UI.button({
                            variant: 'secondary', size: 'sm', className: 'mbe-4',
                            icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render',
                        })}
                    ` : html`
                        <div class="token-status">
                            <span class="status-pill ${webhookToken.configuredInDatabase ? html.raw('sent') : html.raw('failed')}">
                                ${webhookToken.configuredInDatabase ? t('settings.webhookConfigured') : t('settings.webhookNotSet')}
                            </span>
                            ${webhookToken.configuredInDatabase ? html`
                                <span class="text-meta">${this.ltrIn('settings.webhookPreview', {
                                    preview: webhookToken.preview, count: Number(webhookToken.length) || 0,
                                }, 'preview')}</span>
                            ` : ''}
                        </div>
                    `}

                    <!-- The address Meta calls, beside the token Meta checks it
                         with: the two values pasted into the same Meta form. It
                         used to sit three sections down, under TikTok. -->
                    <div class="settings-copy-row mbe-4">
                        <span class="form-label">${t('settings.webhookUrl')}</span>
                        <code dir="ltr">${UI.ltr(webhookUrl)}</code>
                        ${UI.button({
                            variant: 'ghost', size: 'sm', icon: 'copy',
                            ariaLabel: t('setup.copyUrl'), title: t('setup.copyUrl'),
                            action: 'app:copyValue', data: { copy: webhookUrl },
                        })}
                    </div>

                    ${canAdmin && webhookToken && webhookToken.configuredInDatabase ? html`
                        <div class="row row--wrap gap-3 mbe-2">
                            ${UI.button({
                                variant: 'secondary', size: 'sm', icon: 'plug-zap',
                                label: t('settings.webhookTest'),
                                action: 'settings:testWebhook', id: 'settings-webhook-test',
                            })}
                            <span class="form-hint">${t('settings.webhookTestHint')}</span>
                        </div>
                        <div id="settings-webhook-test-result" class="mbe-4" aria-live="polite"></div>
                    ` : ''}

                    <p class="form-hint">${t('settings.webhookBody')} ${UI.helpLink('connect-meta#where', t('help.link.connectMetaWhere'), { newTab: true })}</p>
                    <p class="form-hint mbe-4">${t('settings.webhookBody2')}</p>

                    ${canAdmin ? html`
                    <form id="webhook-token-form" data-submit="settings:handleWebhookTokenUpdate">
                        <label class="form-label" for="settings-webhook-input">${t('settings.webhookLabel')}</label>
                        <input class="field field-mono" id="settings-webhook-input" name="token" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false"
                               placeholder="${t('settings.webhookPlaceholder')}" required>
                        <div class="form-actions">
                            <!-- Stable id: after a successful save the page
                                 re-renders and this button is destroyed, so it
                                 is what restoreFocus() re-finds. -->
                            ${UI.button({
                                variant: 'primary', size: 'sm', type: 'submit', icon: 'shield-check',
                                label: t('settings.webhookSave'), id: 'settings-webhook-submit',
                            })}
                        </div>
                    </form>
                    ` : html`<p class="form-hint">${t('settings.ownerOnlyMeta')}</p>`}
                </div>
            </section>
        `;
    },

    /** The page ids Meta's subscription screens ask about next. */
    accountSection(ctx) {
        const tokenStatus = ctx.tokenStatus || {};
        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.accountInfo')}</h2>
                <div class="settings-card surface stack gap-2">
                    <p class="token-info">${t('settings.igPageId')}: <strong>${UI.ltr(tokenStatus.instagramPageId || tokenStatus.pageId || '—')}</strong></p>
                    <p class="token-info">${t('settings.fbPageId')}: <strong>${UI.ltr(tokenStatus.facebookPageId || '—')}</strong></p>
                    <p class="token-info">${t('settings.accountStatus')}:
                        <strong class="${tokenStatus.isActive ? html.raw('text-success') : html.raw('text-danger')}">
                            ${tokenStatus.isActive ? t('settings.statusActive') : t('settings.statusInactive')}
                        </strong>
                    </p>
                </div>
            </section>
        `;
    },

    appearanceSection() {
        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.appearance')}</h2>
                <div class="settings-card surface">
                    <div class="form-grid">
                        <div class="form-group">
                            <label class="form-label" for="settings-lang">${t('app.language')}</label>
                            <!-- Each option carries its own lang attribute so
                                 العربية is shaped by the Arabic face and "English" set in
                                 Inter, whichever language the interface is in. -->
                            <select class="select" id="settings-lang" data-change="app:setLanguage">
                                ${Object.keys(I18N.LANGS).map((code) => html`
                                    <option value="${code}" lang="${I18N.LANGS[code].htmlLang}"
                                            ${code === I18N.lang ? html.raw('selected') : ''}>${I18N.LANGS[code].label}</option>
                                `)}
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="settings-theme">${t('app.theme')}</label>
                            <select class="select" id="settings-theme" data-change="app:setTheme">
                                ${['auto', 'dark', 'light'].map((value) => html`
                                    <option value="${value}" ${value === App.currentTheme() ? html.raw('selected') : ''}>${t(`app.theme.${value}`)}</option>
                                `)}
                            </select>
                        </div>
                    </div>
                    <p class="form-hint">${t('settings.appearanceHint')}</p>
                </div>
            </section>
        `;
    },

    // ─── The provider apps (platform admin): drawn in the Platform tab ───────────────────────────────────

    /** A provider's app block as a card of its own. It is a `<details>` that opens when it is the target, so it names itself: no extra title. */
    appCard(id, block) {
        if (!block) return '';
        return html`
            <section class="section" id="${id}">
                <div class="settings-card surface">${block}</div>
            </section>
        `;
    },

    metaAppSection(ctx) {
        if (typeof MetaConnect === 'undefined') return '';
        return this.appCard('settings-meta-app-card', MetaConnect.appBlock(ctx.metaApp, ctx.metaAppError));
    },

    tiktokAppSection(ctx) {
        const c = ctx.tiktok && ctx.tiktok.connection;
        return this.appCard('settings-tiktok-app-card', this.tiktokAppBlock(
            ctx.tiktokApp, ctx.tiktokAppError, !!(ctx.tiktok && ctx.tiktok.appConfigured), !!(c && (c.connected || c.status === 'invalid')),
        ));
    },

    youtubeAppSection(ctx) {
        return this.appCard('settings-youtube-app-card', this.youtubeAppBlock(ctx.youtubeApp, ctx.youtubeAppError, !!(ctx.youtube && ctx.youtube.appConfigured)));
    },

    /** What a platform admin sees on a connection card whose provider app is not set up yet: the sentence, and the way to the app's own card. */
    openAppNote(sentence, appCard) {
        return html`
            <p class="form-hint mbe-3">${sentence}</p>
            ${UI.button({
                variant: 'secondary', size: 'sm', icon: 'settings', label: t('settings.platform.openApp'),
                action: 'settings:openCard', data: { card: appCard },
            })}
        `;
    },

    /** The "danger zone" row at the end of a connection's card: Disconnect, away from Reconnect, so a mis-tap on a phone costs nothing (SE-13). */
    dangerZone(button) {
        return html`
            <div class="settings-danger">
                <p class="form-label settings-danger-title"><i data-lucide="alert-triangle" aria-hidden="true"></i> ${t('settings.dangerZone')}</p>
                <div class="row row--wrap gap-2 mbs-3">${button}</div>
            </div>
        `;
    },

    // ─── Instagram ice breakers and persistent menu (DM plan S13) ─────────────

    /**
     * The card's words, editor and buttons are `IceBreakersCard`'s (`ice_breakers.js`, loaded on first use); this hands it the server's answer, or
     * says why there is none. Owner only: the caller does not ask for it otherwise.
     */
    iceBreakersSection(data, error) {
        // The error card is drawn HERE, not by the module: a module that could not be fetched is the very case it is for.
        if (error || !data || typeof IceBreakersCard === 'undefined') {
            const message = (error && error.message) || t('iceb.moduleFailed');
            return html`
                <section class="section" id="iceb-card">
                    <h2 class="section-title">${t('iceb.title')}</h2>
                    <div class="settings-card surface">
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div><strong dir="auto">${t('iceb.loadFailed', { message })}</strong></div>
                        </div>
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
                    </div>
                </section>
            `;
        }
        return IceBreakersCard.section(data);
    },

    // ─── The access token's state (SE-01, OV-08) ─────────────────────────────

    /**
     * `GET /settings/token/status` as one of four states: `valid`, `invalid` (Meta rejected the token), `not_connected` (this
     * tenant never connected: there is no token, and nothing is wrong) and `unknown` (Meta did not answer, so nothing is known).
     * Any other status is `invalid`, as before: an answer this screen does not know is not a healthy one.
     */
    tokenState(tokenStatus) {
        const status = tokenStatus && tokenStatus.status;
        if (status === 'valid' || status === 'not_connected' || status === 'unknown') return status;
        return 'invalid';
    },

    /** The state's pill. A tenant that never connected, and a check that could not run, are neutral: only a rejected token is red. */
    tokenPill(state) {
        if (state === 'not_connected') return UI.statusPill('connection', 'not_set_up', { label: t('settings.notConnected') });
        if (state === 'unknown') return UI.statusPill('connection', 'unknown', { label: t('settings.tokenUnknown') });
        const valid = state === 'valid';
        return html`<span class="health-pill ${valid ? html.raw('health-fresh') : html.raw('health-stale')}">
            <i data-lucide="${valid ? 'check-circle' : 'alert-triangle'}" aria-hidden="true"></i>
            ${valid ? t('settings.valid') : t('settings.invalid')}
        </span>`;
    },

    /**
     * What to do about a tenant that never connected: one sentence of this screen's own (never the server's English `message`)
     * and the way there. Connect lives in the Connections card further down, so the button takes the owner to it. Only the
     * workspace owner can connect; anyone else is told so.
     */
    notConnectedNote(canAdmin) {
        return html`
            <div class="mbe-4 stack gap-3" data-token-state="not_connected">
                <p class="token-info">${t('settings.notConnectedBody')}</p>
                ${canAdmin
                    ? UI.button({ variant: 'primary', size: 'sm', icon: 'link', label: t('settings.connectAction'), action: 'settings:goConnect', id: 'settings-connect' })
                    : html`<p class="form-hint">${t('settings.ownerOnlyMeta')}</p>`}
            </div>
        `;
    },

    /** A check that could not run: said as that, with a way to run it again. It is not a verdict on the token. */
    tokenUnknownNote() {
        return html`
            <div class="mbe-4 stack gap-3" data-token-state="unknown">
                <p class="token-info">${t('settings.tokenUnknownBody')}</p>
                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
            </div>
        `;
    },

    /** Open the Instagram & Facebook card, in whichever tab it is, and put focus on its Connect button, which is where the owner connects. */
    goConnect() {
        this.openCard('meta');
    },

    // ─── Instagram & Facebook (P28) ──────────────────────────────────────────

    /**
     * The Connections card. The words, the Page picker and the actions are `MetaConnect`'s (`meta_connect.js`, shared with the wizard);
     * this only hands it what it needs and says what to repaint when something changed. The operator's own block (the switch and the
     * configuration id) is not in it: a platform admin finds that in the Platform tab (`metaAppSection`).
     */
    metaSection({ meta, metaError, metaApp, metaAppError }) {
        if (typeof MetaConnect === 'undefined') return this.metaFallback(metaError || new Error(t('meta.moduleFailed')));
        // After a Page is chosen or Meta is disconnected, this screen is read again. Dropped when the screen is left (`destroy`).
        this._afterMeta = this._afterMeta || (() => SettingsPage.render());
        MetaConnect.afterChange = this._afterMeta;
        return MetaConnect.settingsSection({
            meta, metaError, app: metaApp, appError: metaAppError, canAdminister: App.canAdminister(), isAdmin: false,
        });
    },

    /** The card when its module could not be fetched: a sentence and Retry, never a blank section. */
    metaFallback(error) {
        return html`
            <section class="section" id="settings-meta">
                <h2 class="section-title">${t('meta.title')}</h2>
                <div class="settings-card surface">
                    <div class="inline-error" role="alert">
                        <i data-lucide="alert-circle" aria-hidden="true"></i>
                        <div><strong dir="auto">${t('meta.loadFailed', { message: (error && error.message) || '' })}</strong></div>
                    </div>
                    ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
                </div>
            </section>
        `;
    },

    /**
     * Back from Facebook's dialog: `#/settings?meta=connected|error|pick`. A pick opens the Page picker over this screen; the others
     * are said once, as a toast. The parameters are dropped from the address either way, so a reload does not say it again.
     */
    async announceMetaReturn() {
        if (typeof MetaConnect === 'undefined') return;
        const ret = MetaConnect.readReturn((name) => App.hashParam(name));
        if (!ret) return;
        try {
            history.replaceState(null, '', `${location.pathname}#/settings`);
        } catch {
            // Only the repeat-on-reload is lost.
        }
        if (ret.outcome === 'pick') {
            await MetaConnect.openPicker(ret.pick, 'settings');
            return;
        }
        MetaConnect.announce(ret);
    },

    /** Reasons Google's callback can send back, each with its own sentence. */
    YOUTUBE_RETURN_REASONS: ['denied', 'state_mismatch', 'state_expired', 'channel_in_use', 'no_channel', 'scope_missing',
        'redirect_mismatch', 'bad_client', 'exchange_failed', 'no_base_url'],

    /** Back from Google's consent screen: `#/settings?youtube=connected|error&reason=…`, said once. */
    announceYouTubeReturn() {
        const outcome = App.hashParam('youtube');
        if (!outcome) return;
        if (outcome === 'connected') {
            UI.toast(t('settings.youtube.connectedToast'), 'success');
        } else {
            const reason = App.hashParam('reason');
            const known = this.YOUTUBE_RETURN_REASONS.includes(reason);
            UI.toast(known ? t(`settings.youtube.return.${reason}`) : t('settings.youtube.return.generic'), 'error');
        }
        try {
            history.replaceState(null, '', `${location.pathname}#/settings`);
        } catch {
            // Only the repeat-on-reload is lost.
        }
    },

    youtubeSection({ youtube, youtubeError }) {
        const isAdmin = App.isAdmin();
        const canAdminister = App.canAdminister();
        const c = youtube && youtube.connection;
        const connected = !!(c && c.connected);
        const needsReconnect = !!(c && c.status === 'invalid');
        const thumb = c ? safeUrl(c.thumbnailUrl) : '';
        // Only a Google app still in Testing hands out a refresh token with an end date (7 days).
        const refreshExpires = c && c.refreshExpiresAt ? new Date(c.refreshExpiresAt) : null;

        let body;
        let danger = '';
        if (youtubeError) {
            body = html`
                <div class="inline-error" role="alert">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    <div><strong dir="auto">${t('settings.youtube.loadFailed', { message: youtubeError.message })}</strong></div>
                </div>
                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
            `;
        } else if (!youtube.appConfigured) {
            body = isAdmin ? this.openAppNote(t('settings.youtube.notConfiguredAdmin'), 'youtube-app')
                : html`<p class="form-hint">${t('settings.youtube.notConfiguredMember')}</p>`;
        } else if (connected || needsReconnect) {
            body = html`
                <div class="row row--start gap-3 mbe-4">
                    ${thumb
                        ? html`<img class="tiktok-avatar-lg" src="${thumb}" alt="" width="44" height="44">`
                        : html`<span class="stat-icon shrink-0"><i data-lucide="youtube" aria-hidden="true"></i></span>`}
                    <div class="stack gap-1">
                        <strong dir="auto">${c.channelTitle || t('settings.youtube.unnamed')}</strong>
                        <span class="health-pill ${needsReconnect ? html.raw('health-stale') : html.raw('health-fresh')}">
                            <i data-lucide="${needsReconnect ? 'alert-triangle' : 'check-circle'}" aria-hidden="true"></i>
                            ${needsReconnect ? t('settings.youtube.statusInvalid') : t('settings.youtube.statusActive')}
                        </span>
                    </div>
                </div>
                ${needsReconnect && c.lastError ? html`
                    <p class="form-hint text-warning mbe-3" dir="auto">${t('settings.youtube.lastError', { message: c.lastError })}</p>
                ` : ''}
                ${connected && !c.canUpload ? html`<p class="form-hint text-warning mbe-3">${t('settings.youtube.cannotUpload')}</p>` : ''}
                <p class="token-info mbe-2">${youtube.publicUploads ? t('settings.youtube.privacyPublic') : t('settings.youtube.privacyPrivate')}</p>
                ${this.youtubeVisibilityLine(youtube.visibility)}
                ${refreshExpires ? html`
                    <p class="form-hint text-warning mbe-3">${t('settings.youtube.testingExpiry', { date: UI.formatDay(refreshExpires) })}</p>
                ` : ''}
                ${canAdminister ? html`
                    <div class="row row--wrap gap-2">
                        ${UI.button({
                            variant: needsReconnect ? 'primary' : 'secondary', size: 'sm', icon: 'refresh-cw',
                            label: t('settings.youtube.reconnect'), action: 'settings:connectYouTube', id: 'settings-youtube-connect',
                        })}
                    </div>
                ` : html`<p class="form-hint">${t('settings.youtube.ownerOnly')}</p>`}
            `;
            // Disconnect is the last thing in the card, apart from Reconnect (SE-13).
            danger = canAdminister ? this.dangerZone(UI.button({
                variant: 'danger', size: 'sm', icon: 'unlink',
                label: t('settings.youtube.disconnect'), action: 'settings:disconnectYouTube', id: 'settings-youtube-disconnect',
            })) : '';
        } else {
            body = html`
                ${canAdminister ? UI.button({
                    variant: 'primary', size: 'sm', icon: 'link',
                    label: t('settings.youtube.connect'), action: 'settings:connectYouTube', id: 'settings-youtube-connect',
                }) : html`<p class="form-hint">${t('settings.youtube.ownerOnly')}</p>`}
                ${canAdminister ? html`<p class="form-hint mbs-2">${t('settings.youtube.unverifiedHint')}</p>` : ''}
            `;
        }

        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.youtube.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${t('settings.youtube.intro')}</p>
                    ${body}
                    ${danger}
                </div>
            </section>
        `;
    },

    // ─── WhatsApp (T025) ─────────────────────────────────────────────────────

    /**
     * The card's words, form, editor and buttons are `WhatsAppCard`'s (`whatsapp_card.js`, loaded on first use); this hands it the server's
     * answer, or says why there is none. Any member sees it (the owner's controls are hidden from the rest by the card itself).
     */
    whatsappSection(data, error) {
        // The error card is drawn HERE, not by the module: a module that could not be fetched is the very case it is for.
        if (error || !data || typeof WhatsAppCard === 'undefined') {
            const known = error && typeof WhatsAppCard !== 'undefined' ? WhatsAppCard.describe(error).message : '';
            const message = known || (error && error.message) || t('wa.moduleFailed');
            return html`
                <section class="section" id="wa-card">
                    <h2 class="section-title">${t('wa.title')}</h2>
                    <div class="settings-card surface">
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div><strong dir="auto">${t('wa.loadFailed', { message })}</strong></div>
                        </div>
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
                    </div>
                </section>
            `;
        }
        return WhatsAppCard.section(data);
    },

    /** The daily check's verdict on the published Shorts (src/services/youtubeVisibility.ts). */
    youtubeVisibilityLine(v) {
        if (!v || !v.total) return '';
        if (v.flagged > 0) {
            return html`<p class="form-hint text-warning mbe-2">
                <i data-lucide="alert-triangle" aria-hidden="true"></i>
                ${t('settings.youtube.visibilityFlagged', { flagged: UI.formatNumber(v.flagged), total: UI.formatNumber(v.total) })}
            </p>`;
        }
        return html`<p class="token-info mbe-2">${v.checkedAt
            ? t('settings.youtube.visibilityOk', { total: UI.formatNumber(v.total), date: UI.formatDay(new Date(v.checkedAt)) })
            : t('settings.youtube.visibilityPending', { total: UI.formatNumber(v.total) })}</p>`;
    },

    /** The Google OAuth client — one for the whole deployment, so platform admins only. */
    youtubeAppBlock(app, error, configured) {
        if (error) {
            return html`<p class="form-hint text-warning" dir="auto">${t('settings.youtube.app.loadFailed', { message: error.message })}</p>`;
        }
        if (!app) return '';
        const secretHint = app.clientSecret.source === 'env'
            ? t('settings.tiktok.app.secretFromEnv')
            : (app.clientSecret.preview ? t('settings.tiktok.app.secretSet', { preview: app.clientSecret.preview }) : '');
        const reg = app.register;
        const row = (label, value) => html`
            <li>
                <span class="form-label">${label}</span>
                <code dir="ltr">${UI.ltr(value)}</code>
                ${UI.button({
                    variant: 'ghost', size: 'sm', icon: 'copy',
                    ariaLabel: t('setup.copyUrl'), title: t('setup.copyUrl'),
                    action: 'app:copyValue', data: { copy: value },
                })}
            </li>
        `;
        return html`
            <details class="settings-block" ${configured ? '' : html.raw('open')}>
                <summary class="form-label tiktok-app-summary">
                    <i data-lucide="chevron-down" aria-hidden="true"></i>
                    ${t('settings.youtube.app.title')}
                </summary>
                <p class="form-hint mbe-3">${t('settings.youtube.app.hint')}</p>
                ${reg ? html`
                    <p class="form-label">${t('settings.youtube.app.register')}</p>
                    <ul class="tiktok-register mbe-4">
                        ${row(t('settings.youtube.app.redirectUri'), reg.redirectUri)}
                        ${row(t('settings.tiktok.app.websiteUrl'), reg.homepageUrl)}
                        ${row(t('settings.tiktok.app.privacyUrl'), reg.privacyUrl)}
                        ${row(t('settings.tiktok.app.termsUrl'), reg.termsUrl)}
                        ${row(t('settings.tiktok.app.scopes'), (app.scopes || []).join(' '))}
                    </ul>
                ` : ''}
                <form id="youtube-app-form" data-submit="settings:saveYouTubeApp" data-redirect="${reg ? reg.redirectUri : ''}">
                    <div class="form-group">
                        <label class="form-label" for="youtube-json">${t('settings.youtube.app.json')}</label>
                        <input class="field" id="youtube-json" type="file" accept=".json,application/json" data-change="settings:readYouTubeJson">
                        <p class="form-hint" id="youtube-json-note" aria-live="polite">${t('settings.youtube.app.jsonHint')}</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="youtube-client-id">${t('settings.youtube.app.clientId')}</label>
                        <input class="field field-mono" id="youtube-client-id" name="clientId" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false" placeholder="123456789-abc.apps.googleusercontent.com"
                               value="${app.clientId.value || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="youtube-client-secret">${t('settings.youtube.app.clientSecret')}</label>
                        <input class="field field-mono" id="youtube-client-secret" name="clientSecret" type="password" dir="ltr"
                               autocomplete="new-password" spellcheck="false" placeholder="GOCSPX-…">
                        ${secretHint ? html`<p class="form-hint">${secretHint}</p>` : ''}
                    </div>
                    <div class="form-group">
                        <label class="check-row" for="youtube-public">
                            <input type="checkbox" id="youtube-public" name="publicUploads" ${app.publicUploads ? html.raw('checked') : ''}>
                            <span class="check-label">${t('settings.youtube.app.publicUploads')}</span>
                        </label>
                        <p class="form-hint">${t('settings.youtube.app.publicUploadsHint')}</p>
                    </div>
                    <div class="form-actions">
                        ${UI.button({
                            variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                            label: t('settings.youtube.app.save'), id: 'youtube-app-submit',
                        })}
                    </div>
                </form>
            </details>
        `;
    },

    /**
     * The JSON Google Cloud downloads for an OAuth client, read here in the browser: its client ID
     * and secret fill the two fields, and nothing is sent until Save. Says when the file's
     * redirect URIs do not include ours, which is the one mistake that fails every connect.
     */
    async readYouTubeJson(input) {
        const note = document.getElementById('youtube-json-note');
        const file = input && input.files && input.files[0];
        if (!file || !note) return;
        try {
            const parsed = JSON.parse(await file.text());
            const web = parsed.web || parsed.installed;
            if (!web || !web.client_id || !web.client_secret) throw new Error('shape');
            document.getElementById('youtube-client-id').value = web.client_id;
            document.getElementById('youtube-client-secret').value = web.client_secret;
            const form = document.getElementById('youtube-app-form');
            const expected = form ? form.dataset.redirect : '';
            const uris = Array.isArray(web.redirect_uris) ? web.redirect_uris : [];
            if (!parsed.web) note.textContent = t('settings.youtube.app.jsonNotWeb');
            else if (expected && !uris.includes(expected)) note.textContent = t('settings.youtube.app.jsonNoRedirect', { uri: expected });
            else note.textContent = t('settings.youtube.app.jsonRead');
        } catch {
            note.textContent = t('settings.youtube.app.jsonBad');
        } finally {
            // The file's contents are in the two fields now; the picker keeps nothing.
            input.value = '';
        }
    },

    async connectYouTube(btn) {
        if (!btn || btn.disabled) return;
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        try {
            const { url } = await API.startYouTubeConnect();
            window.location.href = url;
        } catch (err) {
            restore();
            UI.toast(err.message || t('settings.youtube.return.generic'), 'error');
        }
    },

    disconnectYouTube(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.youtube.disconnectTitle'),
            body: t('settings.youtube.disconnectBody'),
            hint: t('settings.youtube.disconnectHint'),
            confirmLabel: t('settings.youtube.disconnect'),
            confirmIcon: 'unlink',
            onConfirm: () => SettingsPage.disconnectYouTubeConfirmed(),
        });
    },

    async disconnectYouTubeConfirmed() {
        await API.disconnectYouTube();
        UI.toast(t('settings.youtube.disconnected'), 'success');
        await this.render();
    },

    async saveYouTubeApp(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const payload = {
            clientId: (data.get('clientId') || '').toString().trim(),
            publicUploads: data.get('publicUploads') === 'on',
        };
        // Blank means "leave it": the saved secret is never sent back to the page.
        const secret = (data.get('clientSecret') || '').toString().trim();
        if (secret) payload.clientSecret = secret;
        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveYouTubeAppSettings(payload);
            UI.toast(t('settings.youtube.app.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message, 'error');
        }
    },

    /** Reasons the OAuth callback can send back, each with its own sentence. */
    TIKTOK_RETURN_REASONS: ['denied', 'state_mismatch', 'state_expired', 'account_in_use', 'exchange_failed', 'no_base_url'],

    /**
     * Coming back from TikTok's consent screen: the callback redirects to
     * `#/settings?tiktok=connected|error&reason=…`. Say what happened once,
     * then drop the parameters so a reload does not say it again.
     */
    announceTikTokReturn() {
        const outcome = App.hashParam('tiktok');
        if (!outcome) return;
        if (outcome === 'connected') {
            UI.toast(t('settings.tiktok.connectedToast'), 'success');
        } else {
            const reason = App.hashParam('reason');
            const known = this.TIKTOK_RETURN_REASONS.includes(reason);
            UI.toast(known ? t(`settings.tiktok.return.${reason}`) : t('settings.tiktok.return.generic'), 'error');
        }
        try {
            history.replaceState(null, '', `${location.pathname}#/settings`);
        } catch {
            // Only the repeat-on-reload is lost.
        }
    },

    tiktokSection({ tiktok, tiktokError }) {
        const isAdmin = App.isAdmin();
        const canAdminister = App.canAdminister();
        const c = tiktok && tiktok.connection;
        const connected = !!(c && c.connected);
        const needsReconnect = !!(c && c.status === 'invalid');
        const refreshExpires = c && c.refreshExpiresAt ? new Date(c.refreshExpiresAt) : null;
        const daysToReconnect = refreshExpires ? Math.ceil((refreshExpires - Date.now()) / 86400000) : null;
        const avatar = c ? safeUrl(c.avatarUrl) : '';
        // Direct Post is switched on for the app but this connection predates
        // it, so it lacks `video.publish` — posts stay inbox drafts until reconnect.
        const needsDirectScope = !!(c && c.directPostEnabled && !c.canDirectPost);

        let body;
        let danger = '';
        if (tiktokError) {
            body = html`
                <div class="inline-error" role="alert">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    <div><strong dir="auto">${t('settings.tiktok.loadFailed', { message: tiktokError.message })}</strong></div>
                </div>
                ${UI.button({
                    variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render',
                })}
            `;
        } else if (!tiktok.appConfigured) {
            body = isAdmin ? this.openAppNote(t('settings.tiktok.notConfiguredAdmin'), 'tiktok-app')
                : html`<p class="form-hint">${t('settings.tiktok.notConfiguredMember')}</p>`;
        } else if (connected || needsReconnect) {
            body = html`
                <div class="row row--start gap-3 mbe-4">
                    ${avatar
                        ? html`<img class="tiktok-avatar-lg" src="${avatar}" alt="" width="44" height="44">`
                        : html`<span class="stat-icon shrink-0"><i data-lucide="music-2" aria-hidden="true"></i></span>`}
                    <div class="stack gap-1">
                        <strong dir="auto">${c.displayName || t('settings.tiktok.unnamed')}</strong>
                        <span class="health-pill ${needsReconnect ? html.raw('health-stale') : html.raw('health-fresh')}">
                            <i data-lucide="${needsReconnect ? 'alert-triangle' : 'check-circle'}" aria-hidden="true"></i>
                            ${needsReconnect ? t('settings.tiktok.statusInvalid') : t('settings.tiktok.statusActive')}
                        </span>
                    </div>
                </div>
                ${needsReconnect && c.lastError ? html`
                    <p class="form-hint text-warning mbe-3" dir="auto">${t('settings.tiktok.lastError', { message: c.lastError })}</p>
                ` : ''}
                <p class="token-info mbe-2">${t('settings.tiktok.modeLine', { mode: this.tiktokModeLabel(c) })}</p>
                ${needsDirectScope ? html`
                    <p class="form-hint text-warning mbe-3">
                        <i data-lucide="alert-triangle" aria-hidden="true"></i>
                        ${t('settings.tiktok.reconnectForDirect')}
                    </p>
                ` : ''}
                ${connected && c.directPostEnabled && !c.audited && c.canDirectPost && !c.canUpload ? html`
                    <p class="form-hint mbe-3">${t('settings.tiktok.reconnectForDrafts')}</p>
                ` : ''}
                ${connected && !c.canUpload && !c.canDirectPost ? html`
                    <p class="form-hint text-warning mbe-3">${t('settings.tiktok.cannotUpload')}</p>
                ` : ''}
                ${refreshExpires ? html`
                    <p class="token-info mbe-2">
                        ${t('settings.tiktok.reconnectBy', { date: UI.formatDay(refreshExpires) })}
                        ${daysToReconnect !== null && daysToReconnect < 30 ? html`
                            <span class="text-warning">${t('settings.daysLeft', { count: Math.max(daysToReconnect, 0) })}</span>
                        ` : ''}
                    </p>
                ` : ''}
                ${tiktok.inbox ? html`
                    <p class="token-info mbe-4 ${tiktok.inbox.pending >= tiktok.inbox.limit ? html.raw('text-warning') : ''}">
                        ${t('posts.tiktok.inboxUsage', { pending: tiktok.inbox.pending, limit: tiktok.inbox.limit })}
                    </p>
                ` : ''}
                ${c.scopes && c.scopes.length ? html`
                    <div class="mbe-4">
                        <p class="form-label">${t('settings.permissions')}</p>
                        <div class="scope-list">${c.scopes.map((sc) => html`<span class="chip">${UI.ltr(sc)}</span>`)}</div>
                    </div>
                ` : ''}
                ${canAdminister ? html`
                    <div class="row row--wrap gap-2">
                        ${UI.button({
                            variant: needsReconnect ? 'primary' : 'secondary', size: 'sm', icon: 'refresh-cw',
                            label: t('settings.tiktok.reconnect'), action: 'settings:connectTikTok', id: 'settings-tiktok-connect',
                        })}
                    </div>
                ` : html`<p class="form-hint">${t('settings.tiktok.ownerOnly')}</p>`}
            `;
            // Disconnect is the last thing in the card, apart from Reconnect (SE-13).
            danger = canAdminister ? this.dangerZone(UI.button({
                variant: 'danger', size: 'sm', icon: 'unlink',
                label: t('settings.tiktok.disconnect'), action: 'settings:disconnectTikTok', id: 'settings-tiktok-disconnect',
            })) : '';
        } else {
            body = html`
                ${canAdminister ? UI.button({
                    variant: 'primary', size: 'sm', icon: 'link',
                    label: t('settings.tiktok.connect'), action: 'settings:connectTikTok', id: 'settings-tiktok-connect',
                }) : html`<p class="form-hint">${t('settings.tiktok.ownerOnly')}</p>`}
            `;
        }

        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.tiktok.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${this.tiktokIntro(c)} ${UI.helpLink('tiktok', t('help.link.tiktok'), { className: 'settings-tiktok-help' })}</p>
                    ${body}
                    ${danger}
                </div>
            </section>
        `;
    },

    /**
     * The mode posts go out in right now. Only the server decides it
     * (`postMode` is 'direct' iff the connection has `video.publish` AND the
     * admin has switched Direct Post on); this only names it.
     */
    tiktokModeLabel(c) {
        if (!c || c.postMode !== 'direct') return t('settings.tiktok.mode.inbox');
        if (c.audited) return t('settings.tiktok.mode.direct');
        return c.canUpload && c.canDirectPost ? t('settings.tiktok.mode.choose') : t('settings.tiktok.mode.directUnaudited');
    },

    /**
     * The section's opening sentence, true for the mode in force. Not connected
     * yet with Direct Post switched on: connecting will ask for `video.publish`,
     * so the direct sentence is the one that will be true.
     */
    tiktokIntro(c) {
        const direct = !!(c && (c.postMode === 'direct' || (c.directPostEnabled && !c.connected)));
        return direct ? t('settings.tiktok.introDirect') : t('settings.tiktok.introInbox');
    },

    /**
     * The TikTok app's own credentials — one set for the whole deployment, so
     * platform admins only. Open by default until the app is configured, since
     * until then it is the only thing in the section that does anything.
     */
    tiktokAppBlock(app, error, configured, accountConnected) {
        if (error) {
            return html`<p class="form-hint text-warning" dir="auto">${t('settings.tiktok.app.loadFailed', { message: error.message })}</p>`;
        }
        if (!app) return '';
        const reg = app.register;
        const secretNote = app.clientSecret.source === 'env'
            ? t('settings.tiktok.app.secretFromEnv')
            : (app.clientSecret.preview ? t('settings.tiktok.app.secretSet', { preview: app.clientSecret.preview }) : '');
        const row = (label, value) => html`
            <li>
                <span class="form-label">${label}</span>
                <code dir="ltr">${UI.ltr(value)}</code>
                ${UI.button({
                    variant: 'ghost', size: 'sm', icon: 'copy',
                    ariaLabel: t('setup.copyUrl'), title: t('setup.copyUrl'),
                    action: 'app:copyValue', data: { copy: value },
                })}
            </li>
        `;

        return html`
            <details class="settings-block" ${configured ? '' : html.raw('open')}>
                <summary class="form-label tiktok-app-summary">
                    <i data-lucide="chevron-down" aria-hidden="true"></i>
                    ${t('settings.tiktok.app.title')}
                </summary>
                <p class="form-hint mbe-3">${t('settings.tiktok.app.hint')}</p>

                ${reg ? html`
                    <p class="form-label">${t('settings.tiktok.app.register')}</p>
                    <ul class="tiktok-register mbe-4">
                        ${row(t('settings.tiktok.app.websiteUrl'), reg.websiteUrl)}
                        ${row(t('settings.tiktok.app.termsUrl'), reg.termsUrl)}
                        ${row(t('settings.tiktok.app.privacyUrl'), reg.privacyUrl)}
                        ${row(t('settings.tiktok.app.redirectUri'), reg.redirectUri)}
                        ${row(t('settings.tiktok.app.webhookUrl'), reg.webhookUrl)}
                        ${row(t('settings.tiktok.app.scopes'), (app.scopes || []).join(','))}
                    </ul>
                ` : ''}

                <form id="tiktok-app-form" data-submit="settings:saveTikTokApp">
                    <div class="form-group">
                        <label class="form-label" for="tiktok-client-key">${t('settings.tiktok.app.clientKey')}</label>
                        <input class="field field-mono" id="tiktok-client-key" name="clientKey" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false" autocapitalize="off"
                               value="${app.clientKey.value || ''}">
                    </div>
                    <div class="form-group">
                        <!-- Never prefilled: the secret is never sent back. Blank
                             means "keep what is saved". -->
                        <label class="form-label" for="tiktok-client-secret">${t('settings.tiktok.app.clientSecret')}</label>
                        <input class="field field-mono" id="tiktok-client-secret" name="clientSecret" type="password" dir="ltr"
                               autocomplete="new-password" spellcheck="false" autocapitalize="off">
                        ${secretNote ? html`<p class="form-hint">${UI.ltr(secretNote)}</p>` : ''}
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="tiktok-base-url">${t('settings.tiktok.app.baseUrl')}</label>
                        <input class="field field-mono" id="tiktok-base-url" name="publicBaseUrl" type="url" dir="ltr"
                               autocomplete="off" spellcheck="false"
                               placeholder="${app.publicBaseUrl.effective || 'https://'}"
                               value="${app.publicBaseUrl.saved || ''}">
                        <p class="form-hint">${t('settings.tiktok.app.baseUrlHint')}</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="tiktok-verify-name">
                            ${t('settings.tiktok.app.verifyName')} <span class="label-optional">${t('common.optional')}</span>
                        </label>
                        <input class="field field-mono" id="tiktok-verify-name" name="verificationFilename" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false" placeholder="tiktokXXXXXXXX.txt"
                               value="${app.verification.filename || ''}">
                        <label class="form-label mbs-3" for="tiktok-verify-content">${t('settings.tiktok.app.verifyContent')}</label>
                        <input class="field field-mono" id="tiktok-verify-content" name="verificationContent" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false" placeholder="tiktok-developers-site-verification=…">
                        <p class="form-hint">${t('settings.tiktok.app.verifyHint')}</p>
                        ${app.verification.url ? html`<p class="form-hint">${UI.ltr(app.verification.url)}</p>` : ''}
                    </div>
                    <!-- Two facts only the admin can know, because they live in
                         TikTok's portal: whether Direct Post is on for the app,
                         and whether TikTok's audit has passed. -->
                    <fieldset class="form-group fieldset-plain">
                        <legend class="form-label">${t('settings.tiktok.app.directPostTitle')}</legend>
                        <div class="stack gap-3">
                            <div class="check-row">
                                <input type="checkbox" id="tiktok-direct-enabled" name="directPostEnabled"
                                       data-change="settings:previewDirectPost"
                                       data-saved="${app.directPostEnabled === true ? 'on' : 'off'}"
                                       data-connected="${accountConnected ? 'yes' : 'no'}"
                                       aria-describedby="tiktok-direct-consequence"
                                       ${app.directPostEnabled === true ? html.raw('checked') : ''}>
                                <span class="check-text">
                                    <label class="check-label" for="tiktok-direct-enabled">${t('settings.tiktok.app.directPostEnabled')}</label>
                                </span>
                            </div>
                            <div class="check-row">
                                <input type="checkbox" id="tiktok-audited" name="audited"
                                       ${app.audited === true ? html.raw('checked') : ''}>
                                <span class="check-text">
                                    <label class="check-label" for="tiktok-audited">${t('settings.tiktok.app.audited')}</label>
                                </span>
                            </div>
                        </div>
                        <!-- What saving THIS change will do, before it is saved.
                             Empty until the switch moves away from what is saved. -->
                        <p class="form-hint text-warning" id="tiktok-direct-consequence" aria-live="polite"></p>
                        <p class="form-hint">${t('settings.tiktok.app.directPostHint')}</p>
                    </fieldset>
                    <!-- A third fact only the admin can know, because it lives in
                         TikTok's portal: whether user.info.profile is approved. Off
                         keeps the authorise request exactly as it was. -->
                    <fieldset class="form-group fieldset-plain">
                        <legend class="form-label">${t('settings.tiktok.app.profileTitle')}</legend>
                        <div class="check-row">
                            <input type="checkbox" id="tiktok-profile-scope" name="profileScopeEnabled"
                                   aria-describedby="tiktok-profile-hint"
                                   ${app.profileScopeEnabled === true ? html.raw('checked') : ''}>
                            <span class="check-text">
                                <label class="check-label" for="tiktok-profile-scope">${t('settings.tiktok.app.profileScopeEnabled')}</label>
                            </span>
                        </div>
                        <p class="form-hint" id="tiktok-profile-hint">${t('settings.tiktok.app.profileHint')}</p>
                    </fieldset>
                    <div class="form-actions">
                        ${UI.button({
                            variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                            label: t('settings.tiktok.app.save'), id: 'tiktok-app-submit',
                        })}
                    </div>
                </form>
            </details>
        `;
    },

    /**
     * Where uploads are kept: one Supabase project for the whole deployment,
     * so platform admins only. The pill is Supabase's live answer, not the
     * saved config — a key that stopped working shows as not connected.
     */
    mediaStorageSection(ms, error, cleanup) {
        let body = '';
        if (error) {
            body = html`
                <div class="inline-error" role="alert">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    <div><strong dir="auto">${t('settings.media.loadFailed', { message: error.message })}</strong></div>
                </div>
                ${UI.button({
                    variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render',
                })}
            `;
        } else if (ms) {
            body = html`${this.mediaStorageStatus(ms)}${cleanup ? this.mediaCleanupBlock(cleanup) : ''}${this.mediaStorageForm(ms)}`;
        }
        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.media.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${t('settings.media.intro')}</p>
                    ${body}
                </div>
            </section>
        `;
    },

    /**
     * "Delete files once posted": the switch the daily sweep reads, and a button that applies the
     * same rule now. Instagram, Facebook and YouTube keep their own copy of what was posted.
     */
    mediaCleanupBlock(cleanup) {
        const p = cleanup.preview || { files: 0, bytes: 0 };
        return html`
            <div class="settings-block mbe-4">
                <label class="check-row" for="media-cleanup-on">
                    <input type="checkbox" id="media-cleanup-on" data-change="settings:toggleMediaCleanup"
                           aria-describedby="media-cleanup-hint" ${cleanup.on ? html.raw('checked') : ''}>
                    <span class="check-label">${t('settings.media.cleanupOn')}</span>
                </label>
                <p class="form-hint" id="media-cleanup-hint">${t('settings.media.cleanupHint')}</p>
                <p class="token-info mbs-2">
                    ${p.files > 0
                        ? t('settings.media.cleanupPreview', { files: UI.formatNumber(p.files), size: Admin.bytes(p.bytes) })
                        : t('settings.media.cleanupNothing')}
                </p>
                ${p.files > 0 ? UI.button({
                    variant: 'secondary', size: 'sm', icon: 'trash-2',
                    label: t('settings.media.cleanupNow'), action: 'settings:cleanUpMedia', id: 'media-cleanup-now',
                }) : ''}
            </div>
        `;
    },

    async toggleMediaCleanup(box) {
        if (!box) return;
        const on = box.checked;
        box.disabled = true;
        try {
            await API.setMediaCleanup(on);
            UI.toast(on ? t('settings.media.cleanupSavedOn') : t('settings.media.cleanupSavedOff'), 'success');
        } catch (err) {
            box.checked = !on;
            UI.toast(err.message, 'error');
        } finally {
            box.disabled = false;
        }
    },

    cleanUpMedia(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.media.cleanupTitle'),
            body: t('settings.media.cleanupBody'),
            hint: t('settings.media.cleanupConfirmHint'),
            confirmLabel: t('settings.media.cleanupNow'),
            confirmIcon: 'trash-2',
            onConfirm: () => SettingsPage.cleanUpMediaConfirmed(),
        });
    },

    /** A failure shows inside the confirm dialog, which stays open (Admin.runConfirm). */
    async cleanUpMediaConfirmed() {
        const out = await API.runMediaCleanup();
        UI.toast(t('settings.media.cleanupDone', { files: UI.formatNumber(out.files), size: Admin.bytes(out.bytes) }), 'success');
        await this.render();
    },

    mediaStorageStatus(ms) {
        const c = ms.connection;
        const connected = !!(c && c.ok);
        const pill = ms.backend !== 'supabase'
            ? { cls: 'health-stale', icon: 'database', text: t('settings.media.statusPostgres') }
            : connected
                ? { cls: 'health-fresh', icon: 'check-circle', text: t('settings.media.statusConnected') }
                : { cls: 'health-stale', icon: 'alert-triangle', text: t('settings.media.statusFailed') };
        const u = ms.usage;
        return html`
            <div class="token-status">
                <span class="health-pill ${html.raw(pill.cls)}">
                    <i data-lucide="${pill.icon}" aria-hidden="true"></i>
                    ${pill.text}
                </span>
                ${ms.url && ms.url.value ? html`<span class="text-meta">${UI.ltr(ms.url.value)}</span>` : ''}
            </div>
            ${c && !c.ok ? html`<p class="form-hint text-warning mbe-3" dir="auto">${c.error}</p>` : ''}
            <dl class="ops-facts mbe-4">
                ${Admin.field(t('settings.media.bucket'), connected && !c.bucketExists
                    ? t('settings.media.bucketMissing')
                    : UI.ltr(ms.bucket))}
                ${u ? html`
                    ${Admin.field(t('settings.media.used', { total: Admin.bytes(u.tierBytes) }), UI.ltr(Admin.bytes(u.storage.bytes)))}
                    ${Admin.field(t('settings.media.files'), UI.num(u.storage.files))}
                    ${u.database.files > 0 ? Admin.field(t('settings.media.inDatabase'), UI.ltr(Admin.bytes(u.database.bytes))) : ''}
                    ${u.queuedDeletions > 0 ? Admin.field(t('settings.media.queued'), UI.num(u.queuedDeletions)) : ''}
                ` : ''}
            </dl>
            ${u && u.database.files > 0 ? html`<p class="form-hint mbe-4">${t('settings.media.inDatabaseHint')}</p>` : ''}
            ${ms.usageError ? html`<p class="form-hint text-warning mbe-4" dir="auto">${t('settings.media.usageFailed', { message: ms.usageError })}</p>` : ''}
        `;
    },

    mediaStorageForm(ms) {
        const key = ms.key || {};
        const keyNote = key.source === 'database' && key.preview
            ? t('settings.media.keySaved', { preview: key.preview })
            : (key.source === 'env' ? t('settings.media.keyFromEnv') : '');
        const savedUrl = ms.url && ms.url.source === 'database' ? ms.url.value : '';
        const envUrl = ms.url && ms.url.source === 'env' ? ms.url.value : '';
        return html`
            <form id="media-storage-form" data-submit="settings:saveMediaStorage">
                <div class="form-group">
                    <label class="form-label" for="media-storage-url">${t('settings.media.url')}</label>
                    <input class="field field-mono" id="media-storage-url" name="url" type="url" dir="ltr"
                           autocomplete="off" spellcheck="false" autocapitalize="off" required
                           placeholder="${envUrl || 'https://abcd1234.supabase.co'}"
                           value="${savedUrl || ''}">
                    ${envUrl ? html`<p class="form-hint">${t('settings.media.urlFromEnv')}</p>` : ''}
                </div>
                <div class="form-group">
                    <!-- Never prefilled: the key is never sent back. Blank means
                         "keep what is saved". -->
                    <label class="form-label" for="media-storage-key">${t('settings.media.key')}</label>
                    <input class="field field-mono" id="media-storage-key" name="key" type="password" dir="ltr"
                           autocomplete="new-password" spellcheck="false" autocapitalize="off"
                           placeholder="sb_secret_…">
                    ${keyNote ? html`<p class="form-hint" dir="auto">${keyNote}</p>` : ''}
                    ${key.kind === 'legacy_jwt' ? html`<p class="form-hint text-warning">${t('settings.media.keyLegacy')}</p>` : ''}
                    <p class="form-hint">${t('settings.media.help')}</p>
                </div>
                <div class="form-actions">
                    ${UI.button({
                        variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                        label: t('settings.media.save'), id: 'media-storage-submit',
                    })}
                    ${savedUrl || key.source === 'database' ? UI.button({
                        variant: 'secondary', size: 'sm', icon: 'trash-2',
                        label: t('settings.media.remove'), action: 'settings:removeMediaStorage', id: 'media-storage-remove',
                    }) : ''}
                </div>
            </form>
        `;
    },

    /**
     * SE9: the Direct Post switch's consequence, live. Switching it on while an
     * account is connected means that account must reconnect to grant
     * `video.publish`; switching it off sends posts back to drafts at once.
     */
    previewDirectPost(box) {
        const out = document.getElementById('tiktok-direct-consequence');
        if (!out || !box) return;
        const wasOn = box.dataset.saved === 'on';
        const connected = box.dataset.connected === 'yes';
        let text = '';
        if (box.checked && !wasOn && connected) text = t('settings.tiktok.app.reconnectAfterSave');
        else if (!box.checked && wasOn) text = t('settings.tiktok.app.draftsAfterSave');
        out.textContent = text;
    },

    // ─── Webhook handshake ──────────────────────────────────────────────────
    /** Every reason the check route can answer with; anything else reads as unexpected. */
    HANDSHAKE_REASONS: ['ok', 'no_token', 'no_base_url', 'rejected', 'mismatch', 'unexpected', 'unreachable'],

    handshakeResult(r) {
        const result = r || {};
        const reason = this.HANDSHAKE_REASONS.includes(result.reason) ? result.reason : 'unexpected';
        const where = result.url ? this.ltrIn('settings.webhookTest.checked', { url: result.url }, 'url') : '';
        if (result.ok) {
            return html`
                <span class="health-pill health-fresh">
                    <i data-lucide="check-circle" aria-hidden="true"></i>
                    ${t('settings.webhookTest.ok')}
                </span>
                ${where ? html`<p class="form-hint">${where}</p>` : ''}
            `;
        }
        const status = Number.isFinite(Number(result.status)) && result.status !== null ? Number(result.status) : '';
        return UI.errorStrip(t(`settings.webhookTest.${reason}`, { status }), where, 'settings-webhook-test-strip');
    },

    /** «اختبر التحقق»: the server performs Meta's GET against the public webhook URL. */
    async testWebhook(btn) {
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        const host = document.getElementById('settings-webhook-test-result');
        if (host) host.innerHTML = '';
        try {
            const result = await API.checkWebhookHandshake();
            if (host) { host.innerHTML = esc(this.handshakeResult(result)); UI.icons(host); }
        } catch (err) {
            if (host) {
                host.innerHTML = esc(UI.errorStrip(t('settings.webhookTest.requestFailed'), (err && err.message) || '', 'settings-webhook-test-strip'));
                UI.icons(host);
            }
        } finally {
            restore();
        }
    },

    // ─── Public site ────────────────────────────────────────────────────────
    /**
     * The digits wa.me wants, exactly as the server normalises them
     * (src/services/appSettings.ts normaliseWhatsappNumber): Arabic-Indic
     * digits become Latin, spaces/dashes/brackets/dots go, a leading `+` or
     * `00` goes. '' when nothing is left; null when what is left is not a phone
     * number.
     */
    normaliseWhatsapp(value) {
        let digits = String(value || '')
            .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
            .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
            .replace(/[\s\-().]/g, '');
        if (!digits) return '';
        if (digits.startsWith('+')) digits = digits.slice(1);
        else if (digits.startsWith('00')) digits = digits.slice(2);
        return /^[1-9][0-9]{7,14}$/.test(digits) ? digits : null;
    },

    /** The line under the number field: the link the site will print, or why there is none. */
    whatsappPreview(value, fallback) {
        const typed = this.normaliseWhatsapp(value);
        if (typed === null) return html`<span class="text-warning">${t('settings.site.whatsappInvalid')}</span>`;
        const digits = typed || this.normaliseWhatsapp(fallback) || '';
        if (!digits) return t('settings.site.whatsappNone');
        const url = `https://wa.me/${digits}`;
        return html`${t('settings.site.whatsappPreview')} <a href="${url}" target="_blank" rel="noopener noreferrer">${UI.ltr(`wa.me/${digits}`)}</a>`;
    },

    previewWhatsapp(input) {
        const out = document.getElementById('site-whatsapp-preview');
        if (!out || !input) return;
        out.innerHTML = esc(this.whatsappPreview(input.value, input.dataset.fallback || ''));
    },

    /** Where a value comes from, when it is not saved here: the note under its field. */
    siteSourceNote(kind, value, source) {
        if (!value || source === 'database') return '';
        const key = source === 'default' ? `settings.site.${kind}FromDefault` : `settings.site.${kind}FromFallback`;
        return html`<p class="form-hint">${this.ltrIn(key, { value }, 'value')}</p>`;
    },

    siteSection(site, error) {
        if (error) {
            return html`
                <section class="section">
                    <h2 class="section-title">${t('settings.site.title')}</h2>
                    <div class="settings-card surface">
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div><strong dir="auto">${t('settings.site.loadFailed', { message: error.message })}</strong></div>
                        </div>
                        ${UI.button({
                            variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render',
                        })}
                    </div>
                </section>
            `;
        }
        if (!site) return '';
        const src = site.source || {};
        const saved = (field) => (src[field] === 'database' && site[field]) || '';
        const fallbackNumber = src.whatsappNumber && src.whatsappNumber !== 'database' ? (site.whatsappNumber || '') : '';
        const fallbackEmail = src.contactEmail && src.contactEmail !== 'database' ? (site.contactEmail || '') : '';
        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.site.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${t('settings.site.intro')}</p>
                    <div id="site-settings-error"></div>
                    <form id="site-settings-form" data-submit="settings:saveSiteSettings" novalidate>
                        <div class="form-group">
                            <label class="form-label" for="site-whatsapp">${t('settings.site.whatsapp')}</label>
                            <input class="field field-mono" id="site-whatsapp" name="whatsappNumber" type="tel" dir="ltr"
                                   inputmode="tel" autocomplete="off" spellcheck="false"
                                   placeholder="${fallbackNumber || '9665XXXXXXXX'}"
                                   value="${saved('whatsappNumber')}" data-fallback="${fallbackNumber}"
                                   data-input="settings:previewWhatsapp"
                                   aria-describedby="site-whatsapp-hint site-whatsapp-preview">
                            <p class="form-hint" id="site-whatsapp-hint">${t('settings.site.whatsappHint')}</p>
                            <p class="form-hint" id="site-whatsapp-preview" aria-live="polite">${this.whatsappPreview(saved('whatsappNumber'), fallbackNumber)}</p>
                            ${this.siteSourceNote('whatsapp', fallbackNumber, src.whatsappNumber)}
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="site-email">${t('settings.site.email')}</label>
                            <input class="field field-mono" id="site-email" name="contactEmail" type="email" dir="ltr"
                                   autocomplete="off" spellcheck="false" autocapitalize="off"
                                   placeholder="${fallbackEmail || 'name@example.com'}"
                                   value="${saved('contactEmail')}">
                            ${this.siteSourceNote('email', fallbackEmail, src.contactEmail)}
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="site-eid">
                                ${t('settings.site.eidExpire')} <span class="label-optional">${t('common.optional')}</span>
                            </label>
                            <input class="field" id="site-eid" name="eidCouponsExpire" type="date" dir="ltr"
                                   value="${saved('eidCouponsExpire')}" aria-describedby="site-eid-hint">
                            <p class="form-hint" id="site-eid-hint">${t('settings.site.eidHint')}</p>
                            ${this.siteSourceNote('eid', src.eidCouponsExpire !== 'database' ? site.eidCouponsExpire : '', src.eidCouponsExpire)}
                        </div>
                        <p class="form-hint">${t('settings.site.delayHint')}</p>
                        <div class="form-actions">
                            ${UI.button({
                                variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                                label: t('settings.site.save'), id: 'site-settings-submit',
                            })}
                        </div>
                    </form>
                </div>
            </section>
        `;
    },

    /** The field each input maps to, for marking the one a refusal names. */
    SITE_FIELDS: { whatsappNumber: 'site-whatsapp', contactEmail: 'site-email', eidCouponsExpire: 'site-eid' },

    showSiteError(field, message) {
        const host = document.getElementById('site-settings-error');
        const form = document.getElementById('site-settings-form');
        if (form) UI.clearInvalid(form);
        if (!host) { UI.toast(message, 'error'); return; }
        const stripId = 'site-settings-error-strip';
        host.innerHTML = esc(UI.errorStrip(message, '', stripId));
        UI.icons(host);
        const input = field && this.SITE_FIELDS[field] ? document.getElementById(this.SITE_FIELDS[field]) : null;
        if (input) UI.markInvalid(input, stripId);
        else if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    },

    async saveSiteSettings(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const read = (name) => (data.get(name) || '').toString().trim();
        const whatsapp = this.normaliseWhatsapp(read('whatsappNumber'));
        const email = read('contactEmail');
        const host = document.getElementById('site-settings-error');
        if (host) host.innerHTML = '';
        UI.clearInvalid(form);

        // Checked here first so the answer is in Arabic and on the field; the
        // server checks again and has the last word.
        if (whatsapp === null) { this.showSiteError('whatsappNumber', t('settings.site.invalid.whatsappNumber')); return; }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { this.showSiteError('contactEmail', t('settings.site.invalid.contactEmail')); return; }

        // All three are always sent: an emptied field is a real "clear it",
        // which hands the value back to its fallback.
        const payload = { whatsappNumber: whatsapp, contactEmail: email, eidCouponsExpire: read('eidCouponsExpire') };

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveSiteSettings(payload);
            UI.toast(t('settings.site.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            const field = err && err.body && err.body.field;
            const known = field && this.SITE_FIELDS[field];
            this.showSiteError(field, known ? t(`settings.site.invalid.${field}`) : ((err && err.message) || t('error.unexpected')));
        }
    },

    // ─── Handoff alerts and echo takeover (platform admin) ───────────────────────────────────────────────

    /** The field each input maps to, for marking the one a refusal names. */
    NOTIFY_FIELDS: {
        botToken: 'notify-token', chatId: 'notify-chat', enabled: 'notify-enabled', hotLeads: 'notify-hot', takeover: 'notify-echo', ownerAppIds: 'notify-app-ids',
        emailApiKey: 'notify-email-key', emailTo: 'notify-email-to', emailFrom: 'notify-email-from', emailEnabled: 'notify-email-enabled', emailHotLeads: 'notify-email-hot',
    },

    /**
     * What the email part of the card showed when it was drawn: a save sends only what the owner CHANGED from this, so pasting a key is all it
     * takes (an untouched switch is not sent, and the server switches email on with a new key), and an address still following the site contact
     * email keeps following it. A card never drawn (a test, or a page not yet rendered) has nothing on and nothing typed.
     */
    _emailLoaded: { enabled: false, hotLeads: false, to: '', from: '' },
    /** The test email the server sent right after a save carried a new key: it survives the re-draw that follows the save, and is shown once. */
    _pendingEmailTest: null,

    /**
     * The four steps that make the bot, in the order the owner does them. @BotFather is a name typed in Latin letters, so it goes through
     * `ltrIn`: in an Arabic sentence a bare «@BotFather» would have its @ jump to the other end.
     */
    notifyHelp() {
        return html`
            <details class="settings-block mbe-4">
                <summary class="form-label">${t('settings.notify.help.title')}</summary>
                <ol class="stack gap-2 mbs-4">
                    <li>${this.ltrIn('settings.notify.help.step1', { bot: '@BotFather' }, 'bot')}</li>
                    <li>${t('settings.notify.help.step2')}</li>
                    <li>${t('settings.notify.help.step3')}</li>
                    <li>${this.ltrIn('settings.notify.help.step4', { bot: '@userinfobot' }, 'bot')}</li>
                </ol>
            </details>
        `;
    },

    /** The three steps that set email up. `resend.com` is Latin text, so it goes through `ltrIn`. */
    notifyEmailHelp() {
        return html`
            <details class="settings-block mbe-4">
                <summary class="form-label">${t('settings.notify.email.help.title')}</summary>
                <ol class="stack gap-2 mbs-4">
                    <li>${this.ltrIn('settings.notify.email.help.step1', { site: 'resend.com' }, 'site')}</li>
                    <li>${t('settings.notify.email.help.step2')}</li>
                    <li>${t('settings.notify.email.help.step3')}</li>
                </ol>
            </details>
        `;
    },

    /** Where email stands, in one pill: on and where to, off, or not set up. The address is an isolated left-to-right run. */
    notifyEmailState(em) {
        const key = em.apiKey || {};
        if (em.ready && em.to) {
            return html`
                <span class="health-pill health-fresh" id="notify-email-state">
                    <i data-lucide="check-circle" aria-hidden="true"></i>
                    ${this.ltrIn('settings.notify.email.stateOn', { address: em.to }, 'address')}
                </span>
            `;
        }
        return html`
            <span class="health-pill health-off" id="notify-email-state">
                ${key.set ? t('settings.notify.email.stateOff') : t('settings.notify.email.stateNone')}
            </span>
        `;
    },

    /** The Email block of the card: the switch, the address, the key (never filled in), hot leads, an optional own domain, and its test. */
    notifyEmailBlock(em) {
        const key = em.apiKey || {};
        const pending = this._pendingEmailTest;
        this._pendingEmailTest = null;
        this._emailLoaded = { enabled: Boolean(em.enabled), hotLeads: Boolean(em.hotLeads), to: em.to || '', from: em.from || '' };
        return html`
            <fieldset class="form-group fieldset-plain">
                <legend class="form-label">${t('settings.notify.email.title')}</legend>
                <p class="form-hint mbe-4">${t('settings.notify.email.intro')}</p>
                ${this.notifyEmailHelp()}
                <p class="mbe-4">${this.notifyEmailState(em)}</p>
                <div class="form-group">
                    <div class="check-row">
                        <input type="checkbox" id="notify-email-enabled" name="emailEnabled" ${em.enabled ? html.raw('checked') : ''}>
                        <span class="check-text"><label class="check-label" for="notify-email-enabled">${t('settings.notify.email.enabled')}</label></span>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label" for="notify-email-to">${t('settings.notify.email.to')}${em.toIsDefault ? html` <span class="label-optional">${t('settings.notify.email.fromContact')}</span>` : ''}</label>
                    <input class="field field-mono" id="notify-email-to" name="emailTo" type="email" dir="ltr" maxlength="254"
                           autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="you@example.com"
                           value="${em.to || ''}" aria-describedby="notify-email-to-hint">
                    <p class="form-hint" id="notify-email-to-hint">${em.toIsDefault ? t('settings.notify.email.toHintDefault') : t('settings.notify.email.toHint')}</p>
                </div>
                <div class="form-group">
                    <!-- Never prefilled: the key is never sent back. Blank means "keep what is saved". -->
                    <label class="form-label" for="notify-email-key">${t('settings.notify.email.key')}</label>
                    <input class="field field-mono" id="notify-email-key" name="emailApiKey" type="password" dir="ltr" maxlength="160"
                           autocomplete="new-password" spellcheck="false" autocapitalize="off" placeholder="re_…"
                           aria-describedby="notify-email-key-hint">
                    <p class="form-hint" id="notify-email-key-hint">${key.set
                        ? (key.last4 ? this.ltrIn('settings.notify.email.keySaved', { mask: `••••${key.last4}` }, 'mask') : t('settings.notify.email.keySavedShort'))
                        : t('settings.notify.email.keyNone')}</p>
                </div>
                <div class="form-group">
                    <div class="check-row">
                        <input type="checkbox" id="notify-email-hot" name="emailHotLeads" ${em.hotLeads ? html.raw('checked') : ''}>
                        <span class="check-text"><label class="check-label" for="notify-email-hot">${t('settings.notify.email.hotLeads')}</label></span>
                    </div>
                </div>
                <details class="settings-block mbe-4">
                    <summary class="form-label">${t('settings.notify.email.advanced')}</summary>
                    <div class="form-group mbs-4">
                        <label class="form-label" for="notify-email-from">${t('settings.notify.email.from')} <span class="label-optional">${t('common.optional')}</span></label>
                        <input class="field field-mono" id="notify-email-from" name="emailFrom" type="text" dir="ltr" maxlength="200"
                               autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="${em.defaultFrom || ''}"
                               value="${em.from || ''}" aria-describedby="notify-email-from-hint">
                        <p class="form-hint" id="notify-email-from-hint">${t('settings.notify.email.fromHint')}</p>
                    </div>
                </details>
                <div class="form-actions">
                    ${UI.button({
                        variant: 'secondary', size: 'sm', icon: 'mail',
                        label: t('settings.notify.email.test'), action: 'settings:testNotifyEmail', id: 'notify-email-test',
                    })}
                    ${key.set ? UI.button({
                        variant: 'secondary', size: 'sm', icon: 'trash-2',
                        label: t('settings.notify.email.removeKey'), action: 'settings:removeNotifyEmailKey', id: 'notify-email-remove-key',
                    }) : ''}
                </div>
                <p class="form-hint">${t('settings.notify.email.testHint')}</p>
                <div id="notify-email-test-result" aria-live="polite">${pending ? this.notifyEmailTestResult(pending) : ''}</div>
            </fieldset>
        `;
    },

    notifySection(notify, error) {
        if (error || !notify) {
            if (!error) return '';
            return html`
                <section class="section">
                    <h2 class="section-title">${t('settings.notify.title')}</h2>
                    <div class="settings-card surface">
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div><strong dir="auto">${t('settings.notify.loadFailed', { message: error.message })}</strong></div>
                        </div>
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
                    </div>
                </section>
            `;
        }
        const tg = notify.telegram || {};
        const em = notify.email || {};
        const echo = notify.echo || {};
        const token = tg.botToken || {};
        const documented = (Array.isArray(echo.documentedAppIds) ? echo.documentedAppIds : []).join(', ');
        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.notify.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${t('settings.notify.intro')}</p>
                    ${this.notifyHelp()}
                    <div id="notify-settings-error"></div>
                    <form id="notify-settings-form" data-submit="settings:saveNotify" novalidate>
                        <div class="form-group">
                            <div class="check-row">
                                <input type="checkbox" id="notify-enabled" name="enabled" ${tg.enabled ? html.raw('checked') : ''}>
                                <span class="check-text"><label class="check-label" for="notify-enabled">${t('settings.notify.enabled')}</label></span>
                            </div>
                        </div>
                        <div class="form-group">
                            <!-- Never prefilled: the token is never sent back. Blank means "keep what is saved". -->
                            <label class="form-label" for="notify-token">${t('settings.notify.token')}</label>
                            <input class="field field-mono" id="notify-token" name="botToken" type="password" dir="ltr" maxlength="128"
                                   autocomplete="new-password" spellcheck="false" autocapitalize="off" placeholder="123456789:AA…"
                                   aria-describedby="notify-token-hint">
                            <p class="form-hint" id="notify-token-hint">${token.set
                                ? (token.last4 ? this.ltrIn('settings.notify.tokenSaved', { last4: token.last4 }, 'last4') : t('settings.notify.tokenSavedShort'))
                                : t('settings.notify.tokenNone')}</p>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="notify-chat">${t('settings.notify.chatId')}</label>
                            <input class="field field-mono" id="notify-chat" name="chatId" type="text" dir="ltr" maxlength="40"
                                   inputmode="numeric" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="123456789"
                                   value="${tg.chatId || ''}" aria-describedby="notify-chat-hint">
                            <p class="form-hint" id="notify-chat-hint">${t('settings.notify.chatIdHint')}</p>
                        </div>
                        <div class="form-group">
                            <div class="check-row">
                                <input type="checkbox" id="notify-hot" name="hotLeads" ${tg.hotLeads !== false ? html.raw('checked') : ''}>
                                <span class="check-text"><label class="check-label" for="notify-hot">${t('settings.notify.hotLeads')}</label></span>
                            </div>
                        </div>

                        ${this.notifyEmailBlock(em)}

                        <fieldset class="form-group fieldset-plain">
                            <legend class="form-label">${t('settings.notify.echo.title')}</legend>
                            <div class="check-row">
                                <input type="checkbox" id="notify-echo" name="takeover" aria-describedby="notify-echo-hint" ${echo.takeover ? html.raw('checked') : ''}>
                                <span class="check-text"><label class="check-label" for="notify-echo">${t('settings.notify.echo.takeover')}</label></span>
                            </div>
                            <p class="form-hint" id="notify-echo-hint">${t('settings.notify.echo.hint')}</p>
                            <div class="form-group mbs-4">
                                <label class="form-label" for="notify-app-ids">${t('settings.notify.echo.appIds')} <span class="label-optional">${t('common.optional')}</span></label>
                                <input class="field field-mono" id="notify-app-ids" name="ownerAppIds" type="text" dir="ltr" maxlength="300"
                                       autocomplete="off" spellcheck="false" placeholder="1217981644879628"
                                       value="${(Array.isArray(echo.ownerAppIds) ? echo.ownerAppIds : []).join(', ')}" aria-describedby="notify-app-ids-hint">
                                <p class="form-hint" id="notify-app-ids-hint">${this.ltrIn('settings.notify.echo.appIdsHint', { documented }, 'documented')}</p>
                            </div>
                        </fieldset>

                        <div class="form-actions">
                            ${UI.button({
                                variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                                label: t('settings.notify.save'), id: 'notify-settings-submit',
                            })}
                            ${UI.button({
                                variant: 'secondary', size: 'sm', icon: 'send',
                                label: t('settings.notify.test'), action: 'settings:testNotify', id: 'notify-test',
                            })}
                            ${token.set ? UI.button({
                                variant: 'secondary', size: 'sm', icon: 'trash-2',
                                label: t('settings.notify.removeToken'), action: 'settings:removeNotifyToken', id: 'notify-remove-token',
                            }) : ''}
                        </div>
                        <p class="form-hint">${t('settings.notify.testHint')}</p>
                        <div id="notify-test-result" aria-live="polite"></div>
                    </form>
                </div>
            </section>
        `;
    },

    showNotifyError(field, message) {
        const host = document.getElementById('notify-settings-error');
        const form = document.getElementById('notify-settings-form');
        if (form) UI.clearInvalid(form);
        if (!host) { UI.toast(message, 'error'); return; }
        const stripId = 'notify-settings-error-strip';
        host.innerHTML = esc(UI.errorStrip(message, '', stripId));
        UI.icons(host);
        const input = field && this.NOTIFY_FIELDS[field] ? document.getElementById(this.NOTIFY_FIELDS[field]) : null;
        if (input) UI.markInvalid(input, stripId);
        else if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    },

    async saveNotify(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const read = (name) => (data.get(name) || '').toString().trim();
        const host = document.getElementById('notify-settings-error');
        if (host) host.innerHTML = '';
        UI.clearInvalid(form);

        // A blank token is "keep it": it is never sent back to this page, so it cannot be re-sent. The two switches are always sent (a
        // cleared box is a real off), and so are the chat id and the app ids (an emptied field clears them).
        const telegram = { chatId: read('chatId'), enabled: data.get('enabled') !== null, hotLeads: data.get('hotLeads') !== null };
        const token = read('botToken');
        if (token) telegram.botToken = token;
        const payload = { telegram, echo: { takeover: data.get('takeover') !== null, ownerAppIds: read('ownerAppIds') } };
        const email = this.emailChanges(data, read);
        if (Object.keys(email).length > 0) payload.email = email;

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            const saved = await API.saveNotifySettings(payload);
            // A new key was tried by the server with one test email: keep its result for the card that is drawn next.
            this._pendingEmailTest = saved && saved.emailTest ? saved.emailTest : null;
            UI.toast(t('settings.notify.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            const field = err && err.body && err.body.field;
            const known = field && this.NOTIFY_FIELDS[field];
            this.showNotifyError(field, known ? t(`settings.notify.invalid.${field}`) : ((err && err.message) || t('error.unexpected')));
        }
    },

    /**
     * The email part of a save: only what differs from what the card showed (see `_emailLoaded`), so a Telegram-only save sends no `email` at
     * all and pasting a key sends the key alone (the server switches email on with it). A blank key is "keep it": it is never sent back here.
     */
    emailChanges(data, read) {
        const was = this._emailLoaded;
        const email = {};
        const key = read('emailApiKey');
        if (key) email.apiKey = key;
        const enabled = data.get('emailEnabled') !== null;
        if (enabled !== was.enabled) email.enabled = enabled;
        const hotLeads = data.get('emailHotLeads') !== null;
        if (hotLeads !== was.hotLeads) email.hotLeads = hotLeads;
        // An address left as the card filled it in (the contact email) is not sent: it keeps following the contact email. Emptied, it is cleared.
        if (read('emailTo') !== was.to) email.to = read('emailTo');
        if (read('emailFrom') !== was.from) email.from = read('emailFrom');
        return email;
    },

    /** What the server found when it tried the saved token and chat id: a strip that says so, in words, never the token. */
    notifyTestResult(r) {
        const result = r || {};
        if (result.ok) {
            return html`
                <span class="health-pill health-fresh">
                    <i data-lucide="check-circle" aria-hidden="true"></i>
                    ${t('settings.notify.test.ok')}
                </span>
            `;
        }
        const reason = ['not_configured', 'rejected', 'unreachable'].includes(result.reason) ? result.reason : 'unreachable';
        const status = Number.isFinite(Number(result.status)) && result.status !== null ? Number(result.status) : '';
        return UI.errorStrip(t(`settings.notify.test.${reason}`, { status }), result.description || '', 'notify-test-strip');
    },

    /** «أرسل رسالة تجريبية»: the server sends the message with what is SAVED, so a change has to be saved first (the card says so). */
    async testNotify(btn) {
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        const host = document.getElementById('notify-test-result');
        if (host) host.innerHTML = '';
        try {
            const result = await API.testNotify(I18N.lang === 'en' ? 'en' : 'ar');
            if (host) { host.innerHTML = esc(this.notifyTestResult(result)); UI.icons(host); }
        } catch (err) {
            if (host) {
                host.innerHTML = esc(UI.errorStrip(t('settings.notify.test.requestFailed'), (err && err.message) || '', 'notify-test-strip'));
                UI.icons(host);
            }
        } finally {
            restore();
        }
    },

    /** The email test's answer: a pill when it went, and each refusal in words with Resend's own (escaped) reason, never the key. */
    notifyEmailTestResult(r) {
        const result = r || {};
        if (result.ok) {
            return html`
                <span class="health-pill health-fresh">
                    <i data-lucide="check-circle" aria-hidden="true"></i>
                    ${t('settings.notify.email.test.ok')}
                </span>
            `;
        }
        const reason = ['not_configured', 'rejected', 'unreachable'].includes(result.reason) ? result.reason : 'unreachable';
        const status = Number.isFinite(Number(result.status)) && result.status !== null ? Number(result.status) : '';
        return UI.errorStrip(t(`settings.notify.email.test.${reason}`, { status }), result.description || '', 'notify-email-test-strip');
    },

    /** «أرسل بريداً تجريبياً»: the server sends with what is SAVED, so a change has to be saved first (the card says so). */
    async testNotifyEmail(btn) {
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        const host = document.getElementById('notify-email-test-result');
        if (host) host.innerHTML = '';
        try {
            const result = await API.testNotifyEmail(I18N.lang === 'en' ? 'en' : 'ar');
            if (host) { host.innerHTML = esc(this.notifyEmailTestResult(result)); UI.icons(host); }
        } catch (err) {
            if (host) {
                host.innerHTML = esc(UI.errorStrip(t('settings.notify.email.test.requestFailed'), (err && err.message) || '', 'notify-email-test-strip'));
                UI.icons(host);
            }
        } finally {
            restore();
        }
    },

    removeNotifyEmailKey(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.notify.email.removeTitle'),
            body: t('settings.notify.email.removeBody'),
            hint: t('settings.notify.email.removeHint'),
            confirmLabel: t('settings.notify.email.removeKey'),
            confirmIcon: 'trash-2',
            onConfirm: () => SettingsPage.removeNotifyEmailKeyConfirmed(),
        });
    },

    /** Email is switched off with the key: "on" with nothing to send with is refused by the server. */
    async removeNotifyEmailKeyConfirmed() {
        await API.saveNotifySettings({ email: { apiKey: null, enabled: false } });
        UI.toast(t('settings.notify.email.keyRemoved'), 'success');
        await this.render();
    },

    removeNotifyToken(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.notify.removeTitle'),
            body: t('settings.notify.removeBody'),
            hint: t('settings.notify.removeHint'),
            confirmLabel: t('settings.notify.removeToken'),
            confirmIcon: 'trash-2',
            onConfirm: () => SettingsPage.removeNotifyTokenConfirmed(),
        });
    },

    /** Alerts are switched off with the token: "on" with nothing to send with is refused by the server. */
    async removeNotifyTokenConfirmed() {
        await API.saveNotifySettings({ telegram: { botToken: null, enabled: false } });
        UI.toast(t('settings.notify.tokenRemoved'), 'success');
        await this.render();
    },

    // ─── Onboarding (platform admin): how invite links behave ─────────────────────────────────────────

    /** The field each input maps to, for marking the one a refusal names. */
    ONBOARDING_FIELDS: {
        inviteTtlDays: 'onboarding-ttl', resetTtlHours: 'onboarding-reset-ttl', sessionDays: 'onboarding-session-days',
        defaultRole: 'onboarding-role', inviterName: 'onboarding-inviter', whatsappText: 'onboarding-whatsapp', defaultRules: 'onboarding-rule-women',
        discoveryCreatorId: 'onboarding-discovery', youtubeApiKey: 'onboarding-yt-key',
    },

    onboardingSection(data, error) {
        if (error || !data) {
            return html`
                <section class="section">
                    <h2 class="section-title">${t('settings.onboarding.title')}</h2>
                    <div class="settings-card surface">
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div><strong dir="auto">${t('settings.onboarding.loadFailed', { message: (error && error.message) || '' })}</strong></div>
                        </div>
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
                    </div>
                </section>
            `;
        }
        const v = data.settings || {};
        const saved = data.saved || {};
        const limits = data.limits || {};
        const range = (key) => limits[key] || { min: 1, max: 90, fallback: 7 };
        const shown = (name, value) => (saved[name] ? value : '');
        const womenRule = Array.isArray(v.defaultRules) && v.defaultRules.includes('no_women_imagery');
        const defaults = data.whatsappDefaults || {};
        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.onboarding.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${t('settings.onboarding.intro')}</p>
                    <div id="onboarding-settings-error"></div>
                    <form id="onboarding-settings-form" data-submit="settings:saveOnboardingSettings" novalidate>
                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label" for="onboarding-ttl">${t('settings.onboarding.inviteTtl')}</label>
                                <input class="field" id="onboarding-ttl" name="inviteTtlDays" type="number" inputmode="numeric" dir="ltr"
                                       min="${range('inviteTtlDays').min}" max="${range('inviteTtlDays').max}" step="1"
                                       placeholder="${range('inviteTtlDays').fallback}" value="${shown('inviteTtlDays', v.inviteTtlDays)}"
                                       aria-describedby="onboarding-ttl-hint">
                                <p class="form-hint" id="onboarding-ttl-hint">${t('settings.onboarding.inviteTtlHint', { days: range('inviteTtlDays').fallback })}</p>
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="onboarding-reset-ttl">${t('settings.onboarding.resetTtl')}</label>
                                <input class="field" id="onboarding-reset-ttl" name="resetTtlHours" type="number" inputmode="numeric" dir="ltr"
                                       min="${range('resetTtlHours').min}" max="${range('resetTtlHours').max}" step="1"
                                       placeholder="${range('resetTtlHours').fallback}" value="${shown('resetTtlHours', v.resetTtlHours)}"
                                       aria-describedby="onboarding-reset-ttl-hint">
                                <p class="form-hint" id="onboarding-reset-ttl-hint">${t('settings.onboarding.resetTtlHint', { hours: range('resetTtlHours').fallback })}</p>
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="onboarding-session-days">${t('settings.onboarding.sessionDays')}</label>
                                <input class="field" id="onboarding-session-days" name="sessionDays" type="number" inputmode="numeric" dir="ltr"
                                       min="${range('sessionDays').min}" max="${range('sessionDays').max}" step="1"
                                       placeholder="${range('sessionDays').fallback}" value="${shown('sessionDays', v.sessionDays)}"
                                       aria-describedby="onboarding-session-days-hint">
                                <p class="form-hint" id="onboarding-session-days-hint">${t('settings.onboarding.sessionDaysHint', { days: range('sessionDays').fallback })}</p>
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="onboarding-role">${t('settings.onboarding.role')}</label>
                                <select class="select" id="onboarding-role" name="defaultRole">
                                    ${Admin.TENANT_ROLES.map((role) => html`<option value="${role}" ${role === (v.defaultRole || 'owner') ? html.raw('selected') : ''}>${t(`roles.${role}`)}</option>`)}
                                </select>
                                <p class="form-hint">${t('settings.onboarding.roleHint')}</p>
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="onboarding-inviter">
                                ${t('settings.onboarding.inviter')} <span class="label-optional">${t('common.optional')}</span>
                            </label>
                            <input class="field" id="onboarding-inviter" name="inviterName" type="text" dir="auto" maxlength="80" autocomplete="off"
                                   value="${shown('inviterName', v.inviterName || '')}" aria-describedby="onboarding-inviter-hint">
                            <p class="form-hint" id="onboarding-inviter-hint">${t('settings.onboarding.inviterHint')}</p>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="onboarding-whatsapp">
                                ${t('settings.onboarding.whatsapp')} <span class="label-optional">${t('common.optional')}</span>
                            </label>
                            <textarea class="field-textarea" id="onboarding-whatsapp" name="whatsappText" rows="3" maxlength="600" dir="auto"
                                      placeholder="${defaults[I18N.lang] || defaults.ar || ''}" aria-describedby="onboarding-whatsapp-hint">${shown('whatsappText', v.whatsappText || '')}</textarea>
                            <p class="form-hint" id="onboarding-whatsapp-hint">${t('settings.onboarding.whatsappHint')}</p>
                        </div>
                        <fieldset class="onboarding-rules">
                            <legend class="form-label">${t('settings.onboarding.rules')}</legend>
                            <div class="check-row">
                                <input type="checkbox" id="onboarding-rule-women" name="rule" value="no_women_imagery" ${womenRule ? html.raw('checked') : ''}>
                                <div class="check-text">
                                    <label class="check-label" for="onboarding-rule-women">${t('settings.onboarding.ruleWomen')}</label>
                                    <p class="form-hint">${t('settings.onboarding.rulesHint')}</p>
                                </div>
                            </div>
                        </fieldset>
                        ${this.draftSourcesGroup(data.draftSources)}
                        <div class="form-actions">
                            ${UI.button({
                                variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                                label: t('settings.onboarding.save'), id: 'onboarding-settings-submit',
                            })}
                        </div>
                    </form>
                </div>
            </section>
        `;
    },

    /**
     * What reads a new tenant's public accounts (the profile draft, docs/onboarding/03 §1): the tenant whose connected Instagram account reads other
     * people's profiles, and the YouTube Data API key. The key is a secret and the server never sends it back: only whether one is set, where it
     * comes from and its last four characters. An empty key field means "leave it"; the tick removes it. Nothing is rendered for a server that
     * does not describe them (an older deployment), so the rest of the card works as before.
     */
    draftSourcesGroup(sources) {
        if (!sources || !sources.youtubeApiKey || !sources.discovery) return '';
        const key = sources.youtubeApiKey;
        const discovery = sources.discovery;
        const tenants = Array.isArray(sources.tenants) ? sources.tenants : [];
        const chosen = discovery.source === 'setting' ? discovery.creatorId : '';
        const keyHint = key.set
            ? t(key.source === 'env' ? 'settings.onboarding.ytKeyEnv' : 'settings.onboarding.ytKeySaved', { last4: key.last4 || '••••' })
            : t('settings.onboarding.ytKeyNone');
        return html`
            <fieldset class="onboarding-rules onboarding-sources">
                <legend class="form-label">${t('settings.onboarding.sources.title')}</legend>
                <p class="form-hint mbe-3">${t('settings.onboarding.sources.intro')}</p>
                <div class="form-group">
                    <label class="form-label" for="onboarding-discovery">${t('settings.onboarding.discovery')}</label>
                    <select class="select" id="onboarding-discovery" name="discoveryCreatorId" aria-describedby="onboarding-discovery-hint">
                        <option value="" ${chosen === '' ? html.raw('selected') : ''}>${t('settings.onboarding.discoveryOwner')}</option>
                        ${tenants.map((tenant) => html`<option value="${tenant.id}" ${tenant.id === chosen ? html.raw('selected') : ''}>${tenant.name || tenant.id}${tenant.connected ? '' : html` · ${t('settings.onboarding.notConnected')}`}</option>`)}
                    </select>
                    <p class="form-hint" id="onboarding-discovery-hint">${t('settings.onboarding.discoveryHint')}</p>
                    ${discovery.creatorId && !discovery.connected ? html`<p class="form-hint text-warning" role="status">${t('settings.onboarding.discoveryUnconnected')}</p>` : ''}
                </div>
                <div class="form-group">
                    <label class="form-label" for="onboarding-yt-key">${t('settings.onboarding.ytKey')}</label>
                    <input class="field field-mono" id="onboarding-yt-key" name="youtubeApiKey" type="password" dir="ltr" maxlength="256"
                           autocomplete="new-password" spellcheck="false" placeholder="AIza…" aria-describedby="onboarding-yt-key-hint">
                    <p class="form-hint" id="onboarding-yt-key-hint">${keyHint}</p>
                    <p class="form-hint">${t('settings.onboarding.ytKeyHint')}</p>
                    ${key.set && key.source === 'database' ? html`
                        <div class="check-row">
                            <input type="checkbox" id="onboarding-yt-key-clear" name="clearYoutubeApiKey">
                            <div class="check-text"><label class="check-label" for="onboarding-yt-key-clear">${t('settings.onboarding.ytKeyClear')}</label></div>
                        </div>
                    ` : ''}
                </div>
            </fieldset>
        `;
    },

    showOnboardingError(field, message) {
        const host = document.getElementById('onboarding-settings-error');
        const form = document.getElementById('onboarding-settings-form');
        if (form) UI.clearInvalid(form);
        if (!host) { UI.toast(message, 'error'); return; }
        const stripId = 'onboarding-settings-error-strip';
        host.innerHTML = esc(UI.errorStrip(message, '', stripId));
        UI.icons(host);
        const input = field && this.ONBOARDING_FIELDS[field] ? document.getElementById(this.ONBOARDING_FIELDS[field]) : null;
        if (input) UI.markInvalid(input, stripId);
        else if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    },

    async saveOnboardingSettings(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const read = (name) => (data.get(name) || '').toString().trim();
        const host = document.getElementById('onboarding-settings-error');
        if (host) host.innerHTML = '';
        UI.clearInvalid(form);

        // Every field is always sent: an emptied one is a real "back to the default". The rules are an explicit list, so an
        // unticked box is a deliberate "none" and not a missing field. The server checks again and has the last word.
        const payload = {
            inviteTtlDays: read('inviteTtlDays'),
            resetTtlHours: read('resetTtlHours'),
            sessionDays: read('sessionDays'),
            defaultRole: read('defaultRole'),
            inviterName: read('inviterName'),
            whatsappText: read('whatsappText'),
            defaultRules: data.getAll('rule').map((value) => value.toString()),
        };
        // The draft's sources (when the card has them): the reading tenant is always sent (empty is "the owner's tenant"); the key only when typed,
        // or `null` when the tick removes the saved one. A blank key field means "leave it": the saved key is never sent to the page, so never back.
        if (form.elements.discoveryCreatorId) payload.discoveryCreatorId = read('discoveryCreatorId');
        const youtubeKey = read('youtubeApiKey');
        if (youtubeKey) payload.youtubeApiKey = youtubeKey;
        else if (data.get('clearYoutubeApiKey')) payload.youtubeApiKey = null;
        if (payload.whatsappText && !payload.whatsappText.includes('{link}')) {
            this.showOnboardingError('whatsappText', t('settings.onboarding.invalid.whatsappText'));
            return;
        }

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveOnboardingSettings(payload);
            UI.toast(t('settings.onboarding.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            const field = err && err.body && err.body.field;
            const known = field && this.ONBOARDING_FIELDS[field];
            this.showOnboardingError(field, known ? t(`settings.onboarding.invalid.${field}`) : ((err && err.message) || t('error.unexpected')));
        }
    },

    async saveMediaStorage(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const payload = { url: (data.get('url') || '').toString().trim() };
        // A blank key means "leave it" — it is never sent back to the page.
        const key = (data.get('key') || '').toString().trim();
        if (key) payload.key = key;

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveMediaStorage(payload);
            UI.toast(t('settings.media.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message, 'error');
        }
    },

    removeMediaStorage(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.media.removeTitle'),
            body: t('settings.media.removeBody'),
            hint: t('settings.media.removeHint'),
            confirmLabel: t('settings.media.remove'),
            confirmIcon: 'trash-2',
            onConfirm: () => SettingsPage.removeMediaStorageConfirmed(),
        });
    },

    /** A refusal (409: files still in Storage) is shown inside the dialog, which stays open. */
    async removeMediaStorageConfirmed() {
        await API.removeMediaStorage();
        UI.toast(t('settings.media.removed'), 'success');
        await this.render();
    },

    /**
     * The session lives in localStorage, so the connect flow cannot be a plain
     * link: this asks the server (authenticated) for TikTok's authorise URL,
     * which also sets the single-use state cookie, and only then navigates.
     */
    async connectTikTok(btn) {
        if (!btn || btn.disabled) return;
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        try {
            const { url } = await API.startTikTokConnect();
            window.location.href = url;
        } catch (err) {
            restore();
            UI.toast(err.message || t('settings.tiktok.return.generic'), 'error');
        }
    },

    disconnectTikTok(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.tiktok.disconnectTitle'),
            body: t('settings.tiktok.disconnectBody'),
            hint: t('settings.tiktok.disconnectHint'),
            confirmLabel: t('settings.tiktok.disconnect'),
            confirmIcon: 'unlink',
            onConfirm: () => SettingsPage.disconnectTikTokConfirmed(),
        });
    },

    /**
     * A rejection here is shown inside the confirm dialog, which stays open
     * (Admin.runConfirm) — so no toast of its own on failure.
     */
    async disconnectTikTokConfirmed() {
        await API.disconnectTikTok();
        UI.toast(t('settings.tiktok.disconnected'), 'success');
        await this.render();
    },

    async saveTikTokApp(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const payload = {
            clientKey: (data.get('clientKey') || '').toString().trim(),
            publicBaseUrl: (data.get('publicBaseUrl') || '').toString().trim(),
            // Always sent, as booleans: an unticked box is a real "no", and
            // FormData would otherwise omit it.
            directPostEnabled: data.get('directPostEnabled') === 'on',
            audited: data.get('audited') === 'on',
            profileScopeEnabled: data.get('profileScopeEnabled') === 'on',
        };
        // A blank secret means "leave it", not "clear it" — it is never sent
        // back to the page, so the field is always blank on load.
        const secret = (data.get('clientSecret') || '').toString().trim();
        if (secret) payload.clientSecret = secret;
        const verifyName = (data.get('verificationFilename') || '').toString().trim();
        const verifyContent = (data.get('verificationContent') || '').toString().trim();
        if (verifyContent) {
            payload.verificationFilename = verifyName;
            payload.verificationContent = verifyContent;
        }

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveTikTokAppSettings(payload);
            UI.toast(t('settings.tiktok.app.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message, 'error');
        }
    },

    /**
     * Both token forms were unguarded: submit twice on a cold serverless start
     * and the second POST overwrote the first with the same credential — or,
     * worse, raced the extend endpoint. `UI.formBusy` disables the button and
     * returns null if it was ALREADY disabled, which is the double-submit.
     */
    async handleWebhookTokenUpdate(form, event) {
        event.preventDefault();
        const token = (new FormData(form).get('token') || '').toString().trim();
        if (!token) return;

        // Captured BEFORE the button is disabled: disabling the focused element
        // blurs it, so by the time render() runs there is nothing to remember.
        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // a submit is already in flight

        try {
            const result = await API.updateWebhookToken(token);
            UI.toast(result.message || t('settings.webhookSaved'), 'success');
            // render() replaces the form, so the restore would be writing to a
            // detached button — and it must not run before the re-render puts
            // a fresh, enabled one on screen.
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message || t('settings.webhookSaveFailed'), 'error');
        }
    },

    async handleTokenUpdate(form, event) {
        event.preventDefault();
        const token = (new FormData(form).get('token') || '').toString().trim();
        if (!token) return;

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // a submit is already in flight

        try {
            const result = await API.updateToken(token);
            UI.toast(t('settings.tokenUpdated', {
                date: result.expiresAt ? UI.formatDay(result.expiresAt) : t('common.never'),
            }));
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message, 'error');
        }
    },

    /**
     * Ask first, in the product's own dialog — and NOT in red.
     *
     * Extending the token is consequential enough to confirm but destroys
     * nothing, so it passes tone: 'primary'. The hint carries the part that is
     * genuinely not obvious: Meta does not revoke the existing token when it
     * issues a new one.
     */
    extendToken(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.extendTitle'),
            body: t('settings.extendConfirm'),
            hint: t('settings.extendHint'),
            confirmLabel: t('settings.extend'),
            confirmIcon: 'key-round',
            tone: 'primary',
            onConfirm: () => SettingsPage.extendTokenConfirmed(btn),
        });
    },

    async extendTokenConfirmed(btn) {
        // Same reason as the two forms: disabling it blurs it, so the token is
        // taken first. `UI.actionBusy` replaces the hand-rolled version, which
        // set no `aria-busy` and called `buttonSpinner()` with no argument —
        // that falls back to "Loading", so the button both changed its label to
        // something meaningless and grew wide enough to shove the expiry line
        // beside it sideways. actionBusy keeps the button's own name for
        // assistive technology and pins the width it already had.
        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.actionBusy(btn);
        if (!restore) return; // already in flight

        try {
            await API.request('/settings/token/extend', { method: 'POST' });
            UI.toast(t('settings.extended'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            console.error(err);
            UI.toast(err.message || t('settings.extendFailed'), 'error');
            restore();
        }
    },
};

UI.registerActions('settings', {
    render: () => SettingsPage.render(),
    openCard: (el) => SettingsPage.openCard(el && el.dataset ? el.dataset.card : ''),
    goConnect: () => SettingsPage.goConnect(),
    extendToken: (el) => SettingsPage.extendToken(el),
    handleTokenUpdate: (el, e) => SettingsPage.handleTokenUpdate(el, e),
    handleWebhookTokenUpdate: (el, e) => SettingsPage.handleWebhookTokenUpdate(el, e),
    connectTikTok: (el) => SettingsPage.connectTikTok(el),
    disconnectTikTok: (el) => SettingsPage.disconnectTikTok(el),
    saveTikTokApp: (el, e) => SettingsPage.saveTikTokApp(el, e),
    connectYouTube: (el) => SettingsPage.connectYouTube(el),
    disconnectYouTube: (el) => SettingsPage.disconnectYouTube(el),
    saveYouTubeApp: (el, e) => SettingsPage.saveYouTubeApp(el, e),
    readYouTubeJson: (el) => SettingsPage.readYouTubeJson(el),
    saveMediaStorage: (el, e) => SettingsPage.saveMediaStorage(el, e),
    toggleMediaCleanup: (el) => SettingsPage.toggleMediaCleanup(el),
    cleanUpMedia: (el) => SettingsPage.cleanUpMedia(el),
    removeMediaStorage: (el) => SettingsPage.removeMediaStorage(el),
    testWebhook: (el) => SettingsPage.testWebhook(el),
    previewDirectPost: (el) => SettingsPage.previewDirectPost(el),
    previewWhatsapp: (el) => SettingsPage.previewWhatsapp(el),
    saveSiteSettings: (el, e) => SettingsPage.saveSiteSettings(el, e),
    saveNotify: (el, e) => SettingsPage.saveNotify(el, e),
    testNotify: (el) => SettingsPage.testNotify(el),
    removeNotifyToken: (el) => SettingsPage.removeNotifyToken(el),
    testNotifyEmail: (el) => SettingsPage.testNotifyEmail(el),
    removeNotifyEmailKey: (el) => SettingsPage.removeNotifyEmailKey(el),
    saveOnboardingSettings: (el, e) => SettingsPage.saveOnboardingSettings(el, e),
});
