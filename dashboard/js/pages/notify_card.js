/**
 * How each person is told when a customer needs them (U3, SA-11; docs/specs/007-company-shell §6.6).
 *
 * Not a route (`routable: false`). Settings → Notifications loads this module on first use (`App.loadPageModule('notify_card')`, like
 * `ice_breakers`) and hands it a host element for each of its two cards:
 *
 *   `NotifyCard.mountMine(host, { hasAccount })`        "You": the Inbox badge and Today (always), and the person's own Telegram: Link / Pause /
 *                                                        Unlink. Without an account of their own (the shared password) or without a bot on the
 *                                                        platform, one sentence says why there is no button.
 *   `NotifyCard.mountRouting(host, { canAdminister })`  "This workspace", the owner's: one row per member, two columns (conversations that
 *                                                        need you, hot leads), and Save. Draws nothing for anyone else.
 *   `NotifyCard.canLeave()`                              false while the routing table has changes that were not saved.
 *
 * The card draws its BODY only: the title and the frame are Settings' (the keys `notifyMe.title` and `notifyRouting.title` are here for it).
 *
 * ── The link, step by step ──
 * Link asks the server for a one-time address (`POST /api/notify/telegram/link`), opens it in a new tab, and then asks `confirm` every
 * 3 s for two minutes. The person presses START in Telegram; the next poll finds their message, and the card says "Linked as <first name>".
 * A refused link (expired, or the platform has no bot) stops the polling and says so. Navigating away, or the card being redrawn into a
 * different host, stops it too: a timer never outlives the screen it was started on.
 *
 * Nothing here ever shows or keeps the bot token or a chat id: the server does not send either.
 * Everything that came from a person (an email, a first name from Telegram) goes through the `html` tag, which escapes it.
 */
const NotifyCard = {
    /** The last answers, or null. */
    mine: null,
    routing: null,
    /** The routing table's own copy: `{ handoff: Set, hotLeads: Set }` of user ids, and whether it differs from what the server holds. */
    draft: null,
    dirty: false,
    /** Which request is in flight: 'link' | 'pause' | 'unlink' | 'save' | null. Every button is off while one is. */
    busy: null,
    /** The link in progress: `{ url, endsAt }` while we are waiting for START, else null. Plus its timer and a state word. */
    linking: null,
    _timer: null,
    /** 'idle' | 'waiting' | 'expired' */
    linkState: 'idle',
    _hostMine: null,
    _hostRouting: null,
    _opts: { hasAccount: true, canAdminister: false },

    /** How often the handshake is asked about, and for how long (the code itself lives ten minutes: the person is not left waiting that long). */
    POLL_MS: 3000,
    POLL_FOR_MS: 2 * 60 * 1000,

    // ─── Mount ──────────────────────────────────────────────────────────────────────────

    /** Draw the person's own card into `host`. Resolves in every case; a failed read says so in the card. */
    async mountMine(host, opts) {
        if (!host) return;
        if (this._hostMine !== host) this.stopLink();
        this._hostMine = host;
        this._opts = Object.assign({}, this._opts, opts || {});
        this.paintMine({ loading: true });
        try {
            this.mine = await API.getNotifyMe();
            this.paintMine();
        } catch (err) {
            this.paintMine({ error: err });
        }
    },

    /** Draw the owner's routing table into `host`. Draws nothing unless `canAdminister`. */
    async mountRouting(host, opts) {
        if (!host) return;
        this._hostRouting = host;
        this._opts = Object.assign({}, this._opts, opts || {});
        if (this._opts.canAdminister === false) {
            host.innerHTML = '';
            return;
        }
        host.innerHTML = esc(html`<div class="skel skel-block" aria-hidden="true"></div>`);
        try {
            this.routing = await API.getNotifyRouting();
            this.draft = { handoff: new Set(this.routing.handoff || []), hotLeads: new Set(this.routing.hotLeads || []) };
            this.dirty = false;
            this.paintRouting();
        } catch (err) {
            this.paintRouting({ error: err });
        }
    },

    /** Settings asks this before it leaves the tab: false while the table has unsaved changes. */
    canLeave() {
        return !this.dirty;
    },

    /** The screen is going away: no timer outlives it. */
    destroy() {
        this.stopLink();
    },

    // ─── Mine ───────────────────────────────────────────────────────────────────────────

    paintMine(state) {
        const host = this._hostMine;
        if (!host) return;
        try {
            host.innerHTML = esc(this.bodyMine(state || {}));
            UI.icons(host);
        } catch (err) {
            console.warn('Could not draw the notices card:', err);
            host.innerHTML = '';
        }
    },

    /** The words that say which notices cover this person. */
    coversLine(me) {
        const c = (me && me.covers) || {};
        if (c.handoff && c.hotLeads) return t('notifyMe.covers.both');
        if (c.handoff) return t('notifyMe.covers.handoff');
        if (c.hotLeads) return t('notifyMe.covers.hot');
        return t('notifyMe.covers.none');
    },

    bodyMine(state) {
        if (state.loading) return html`<div class="skel skel-block" aria-hidden="true"></div>`;
        if (state.error) return html`<p class="form-hint" role="alert">${t('notifyMe.loadFailed', { message: UI.errorText(state.error).sentence })}</p>`;
        const me = this.mine || {};
        const always = html`<p class="notify-always"><i data-lucide="check-circle" aria-hidden="true"></i> ${t('notifyMe.always')}</p>`;
        let telegram;
        if (me.platformAdmin === true) {
            telegram = html`<p class="form-hint">${t('notifyMe.platformAdmin')}</p>`;
        } else if (me.hasAccount === false || this._opts.hasAccount === false) {
            telegram = html`<p class="form-hint">${t('notifyMe.needAccount')}</p>`;
        } else if (me.telegram && me.telegram.linked) {
            telegram = this.linkedBlock(me);
        } else if (me.botReady === false) {
            telegram = html`<p class="form-hint">${t('notifyMe.noBot')}</p>`;
        } else {
            telegram = this.unlinkedBlock(me);
        }
        return html`
            <div class="notify-card" id="notify-me">
                ${always}
                <div class="notify-channel">
                    <h3 class="form-label">${t('notifyMe.telegram')}</h3>
                    <p class="form-hint">${t('notifyMe.telegram.hint')}</p>
                    ${telegram}
                </div>
                ${me.hasAccount === false || me.platformAdmin === true ? '' : html`<p class="form-hint notify-covers" id="notify-covers">${this.coversLine(me)}</p>`}
                <p class="mbs-2">${UI.helpLink('notifications', t('notifyMe.help'))}</p>
            </div>
        `;
    },

    linkedBlock(me) {
        const tg = me.telegram;
        const off = this.busy !== null;
        return html`
            <div class="notify-linked" id="notify-linked">
                <p class="notify-status">
                    <span class="health-pill ${tg.paused ? 'warning' : 'success'}" role="status">
                        <span aria-hidden="true">${tg.paused ? '◔' : '●'}</span>
                        <span>${tg.paused ? t('notifyMe.paused') : t('notifyMe.active')}</span>
                    </span>
                    <strong dir="auto">${tg.name ? t('notifyMe.linkedAs', { name: tg.name }) : t('notifyMe.linked')}</strong>
                </p>
                ${tg.paused ? html`<p class="form-hint">${t('notifyMe.pausedHint')}</p>` : ''}
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="notifyCard:pause" ${off ? html.raw('disabled') : ''}>${tg.paused ? t('notifyMe.resume') : t('notifyMe.pause')}</button>
                    <button type="button" class="btn btn-ghost btn-sm" data-action="notifyCard:unlink" ${off ? html.raw('disabled') : ''}>${t('notifyMe.unlink')}</button>
                </div>
            </div>
        `;
    },

    unlinkedBlock() {
        const off = this.busy !== null;
        if (this.linkState === 'waiting' && this.linking) {
            const url = this.safeTelegramUrl(this.linking.url);
            return html`
                <div class="notify-waiting" id="notify-waiting" aria-live="polite">
                    <p><span class="spinner spinner-sm spinner-inline" aria-hidden="true"></span> ${t('notifyMe.waiting')}</p>
                    <div class="form-actions">
                        ${url ? html`<a class="btn btn-secondary btn-sm" href="${url}" target="_blank" rel="noopener noreferrer">${t('notifyMe.openLink')}</a>` : ''}
                        <button type="button" class="btn btn-ghost btn-sm" data-action="notifyCard:cancel">${t('common.cancel')}</button>
                    </div>
                </div>
            `;
        }
        return html`
            ${this.linkState === 'expired' ? html`<p class="form-hint" role="alert" id="notify-expired">${t('notifyMe.expired')}</p>` : ''}
            <div class="form-actions">
                <button type="button" class="btn btn-primary btn-sm" data-action="notifyCard:link" ${off ? html.raw('disabled') : ''}>${t('notifyMe.link')}</button>
            </div>
        `;
    },

    /** The address the person opens: only ever Telegram's own, never whatever a response happened to say. */
    safeTelegramUrl(value) {
        return typeof value === 'string' && /^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]+$/.test(value) ? value : '';
    },

    // ─── The handshake ──────────────────────────────────────────────────────────────────

    stopLink() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this.linking = null;
        if (this.linkState === 'waiting') this.linkState = 'idle';
    },

    async startLink() {
        if (this.busy) return;
        this.busy = 'link';
        this.linkState = 'idle';
        this.paintMine();
        let started;
        try {
            started = await API.startTelegramLink();
        } catch (err) {
            this.busy = null;
            this.paintMine();
            UI.toast(UI.errorText(err).sentence, 'error');
            return;
        }
        this.busy = null;
        const url = this.safeTelegramUrl(started && started.url);
        if (!url) {
            this.paintMine();
            UI.toast(t('notifyMe.failed'), 'error');
            return;
        }
        this.linking = { url, code: new URL(url).searchParams.get('start'), endsAt: Date.now() + this.POLL_FOR_MS };
        this.linkState = 'waiting';
        this.paintMine();
        // A new tab, so this one keeps polling. A blocked popup leaves the "Open Telegram" link in the card.
        try {
            window.open(url, '_blank', 'noopener,noreferrer');
        } catch (_) { /* the link in the card still works */ }
        this.schedulePoll();
    },

    schedulePoll() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => this.poll(), this.POLL_MS);
    },

    async poll() {
        this._timer = null;
        const link = this.linking;
        if (!link || this.linkState !== 'waiting') return;
        // The card was taken off the page (another tab of Settings, another screen): stop.
        if (this._hostMine && this._hostMine.isConnected === false) {
            this.stopLink();
            return;
        }
        if (Date.now() > link.endsAt) {
            this.linking = null;
            this.linkState = 'expired';
            this.paintMine();
            return;
        }
        try {
            const answer = await API.confirmTelegramLink(link.code);
            if (this.linking !== link) return; // cancelled while the request was out
            if (answer && answer.linked === true) {
                this.stopLink();
                this.linkState = 'idle';
                try {
                    this.mine = await API.getNotifyMe();
                } catch (_) {
                    this.mine = Object.assign({}, this.mine, { telegram: { linked: true, name: answer.name || '', paused: false } });
                }
                this.paintMine();
                UI.toast(answer.name ? t('notifyMe.linkedToast', { name: answer.name }) : t('notifyMe.linked'), 'success');
                return;
            }
            this.schedulePoll();
        } catch (err) {
            if (this.linking !== link) return;
            // An expired or foreign code will not get better: stop asking and offer a new link. Anything else (a blip) is asked again.
            if (err && (err.code === 'TELEGRAM_LINK_EXPIRED' || err.status === 410)) {
                this.stopLink();
                this.linkState = 'expired';
                this.paintMine();
                return;
            }
            if (err && (err.code === 'TELEGRAM_BOT_MISSING' || err.code === 'NO_USER_ACCOUNT')) {
                this.stopLink();
                this.paintMine();
                UI.toast(UI.errorText(err).sentence, 'error');
                return;
            }
            this.schedulePoll();
        }
    },

    cancelLink() {
        this.stopLink();
        this.linkState = 'idle';
        this.paintMine();
    },

    async togglePause() {
        if (this.busy || !this.mine || !this.mine.telegram) return;
        const next = !this.mine.telegram.paused;
        this.busy = 'pause';
        this.paintMine();
        try {
            this.mine = await API.setNotifyPaused(next);
            UI.toast(t(next ? 'notifyMe.pausedToast' : 'notifyMe.resumedToast'), 'success');
        } catch (err) {
            UI.toast(UI.errorText(err).sentence, 'error');
        }
        this.busy = null;
        this.paintMine();
    },

    async unlinkTelegram() {
        if (this.busy) return;
        this.busy = 'unlink';
        this.paintMine();
        try {
            await API.unlinkTelegram();
            this.mine = Object.assign({}, this.mine, { telegram: { linked: false, linkedAt: null, name: null, paused: false } });
            UI.toast(t('notifyMe.unlinkedToast'), 'success');
        } catch (err) {
            UI.toast(UI.errorText(err).sentence, 'error');
        }
        this.busy = null;
        this.paintMine();
    },

    // ─── Routing (the owner's) ──────────────────────────────────────────────────────────

    paintRouting(state) {
        const host = this._hostRouting;
        if (!host) return;
        try {
            host.innerHTML = esc(this.bodyRouting(state || {}));
            UI.icons(host);
        } catch (err) {
            console.warn('Could not draw the routing card:', err);
            host.innerHTML = '';
        }
    },

    bodyRouting(state) {
        if (state.error) return html`<p class="form-hint" role="alert">${t('notifyRouting.loadFailed', { message: UI.errorText(state.error).sentence })}</p>`;
        const r = this.routing || {};
        const members = Array.isArray(r.members) ? r.members : [];
        const draft = this.draft || { handoff: new Set(), hotLeads: new Set() };
        const off = this.busy !== null;
        return html`
            <div class="notify-card" id="notify-routing">
                <p class="form-hint">${t('notifyRouting.intro')}</p>
                ${r.defaults && !this.dirty ? html`<p class="form-hint" id="notify-defaults">${t('notifyRouting.defaults')}</p>` : ''}
                ${r.botReady === false ? html`<p class="form-hint" id="notify-nobot">${t('notifyRouting.noBot')}</p>` : ''}
                <div class="table-wrapper">
                    <table class="data-table notify-routing-table">
                        <thead><tr>
                            <th scope="col">${t('notifyRouting.person')}</th>
                            <th scope="col">${t('notifyRouting.handoff')}</th>
                            <th scope="col">${t('notifyRouting.hotLeads')}</th>
                        </tr></thead>
                        <tbody>
                            ${members.map((m) => html`
                                <tr data-user-id="${m.userId}">
                                    <th scope="row">
                                        <span dir="auto">${m.email}</span>
                                        <span class="form-hint">${t(`roles.${m.role}`)}${m.telegramLinked ? '' : html` · ${t('notifyRouting.noTelegram')}`}</span>
                                    </th>
                                    <td>${this.box('handoff', m, draft.handoff.has(m.userId))}</td>
                                    <td>${this.box('hotLeads', m, draft.hotLeads.has(m.userId))}</td>
                                </tr>
                            `)}
                            ${members.length === 0 ? html`<tr><td colspan="3" class="table-empty-cell">${t('notifyRouting.empty')}</td></tr>` : ''}
                        </tbody>
                    </table>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-primary btn-sm" data-action="notifyCard:saveRouting" ${off || !this.dirty ? html.raw('disabled') : ''}>${t('common.save')}</button>
                </div>
            </div>
        `;
    },

    /** One checkbox. Its label names the person and the column, so a screen reader hears what it changes. */
    box(column, member, checked) {
        const label = t(column === 'handoff' ? 'notifyRouting.boxHandoff' : 'notifyRouting.boxHot', { person: member.email });
        return html`<label class="notify-box"><span class="sr-only" dir="auto">${label}</span>
            <input type="checkbox" data-change="notifyCard:toggleBox" data-column="${column}" data-user-id="${member.userId}" ${checked ? html.raw('checked') : ''}></label>`;
    },

    toggleBox(input) {
        const column = input.dataset.column === 'hotLeads' ? 'hotLeads' : 'handoff';
        const id = input.dataset.userId;
        if (!this.draft || !id) return;
        if (input.checked) this.draft[column].add(id);
        else this.draft[column].delete(id);
        this.dirty = true;
        // Only the Save button changes: the boxes stay as they are, so focus is not lost.
        const host = this._hostRouting;
        const save = host && typeof host.querySelector === 'function' ? host.querySelector('[data-action="notifyCard:saveRouting"]') : null;
        if (save) save.disabled = false;
    },

    async saveRouting() {
        if (this.busy || !this.draft) return;
        this.busy = 'save';
        this.paintRouting();
        try {
            this.routing = await API.saveNotifyRouting({ handoff: [...this.draft.handoff], hotLeads: [...this.draft.hotLeads] });
            this.draft = { handoff: new Set(this.routing.handoff || []), hotLeads: new Set(this.routing.hotLeads || []) };
            this.dirty = false;
            UI.toast(t('notifyRouting.saved'), 'success');
        } catch (err) {
            UI.toast(UI.errorText(err).sentence, 'error');
        }
        this.busy = null;
        this.paintRouting();
    },
};

UI.registerActions('notifyCard', {
    link: () => { NotifyCard.startLink().catch((err) => console.warn('Telegram link failed:', err)); },
    cancel: () => NotifyCard.cancelLink(),
    pause: () => { NotifyCard.togglePause().catch((err) => console.warn('Pause failed:', err)); },
    unlink: () => { NotifyCard.unlinkTelegram().catch((err) => console.warn('Unlink failed:', err)); },
    toggleBox: (el) => NotifyCard.toggleBox(el),
    saveRouting: () => { NotifyCard.saveRouting().catch((err) => console.warn('Routing save failed:', err)); },
});
