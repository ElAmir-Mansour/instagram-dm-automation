/**
 * Ads → Campaigns — `#/ads_campaigns`, the second tab of the Ads area (the first, Overview, is `#/ads`).
 *
 * A tree, campaign → ad set → ad, read from the STORED copy of the ad account (`GET /api/ads/objects`): opening this page makes no call to
 * Meta, so it opens fast and cannot run into Meta's rate limits. Each row says what it is (name, level, where it was made), how it is doing
 * (Meta's effective status in plain words, the review reasons when Meta gave any), what it may spend (budget, and how many budget changes
 * Meta still allows this hour), what it has done (spent, conversations, cost per conversation) and which changes are already queued for it.
 *
 * ─── Writes are a queue ─────────────────────────────────────────────────────
 * Pause, resume, budget, archive and delete do not talk to Meta from the request: the server answers `{ op }` at once and a queue sends
 * the change within Meta's limits, then checks it took. So an action here (1) answers "queued" on the row, (2) polls `GET /api/ads/ops/:id`
 * every few seconds for about a minute, and (3) reloads the row when the op is done or failed. After a minute it stops asking and says so:
 * the change still applies by itself, and the next visit to the page shows it.
 *
 * ─── Money rules, said on the screen ────────────────────────────────────────
 * RESUME STARTS SPENDING real money, so it always asks first and only the answer "yes" sends `confirm: true`. A RAISE on a running object
 * asks too (lowering does not). The budget form says how many changes Meta still allows this hour (4 per ad set) and, when the server
 * refuses (EDIT_LIMIT, RATE_LIMITED), when to try again. Delete is a second, separate question and is not offered while the object is
 * running. Every limit stays the server's: this page only makes them visible.
 *
 * ─── Who sees what ──────────────────────────────────────────────────────────
 * Anyone who can open the screen can read it. The change buttons need `App.canOperate()` (a viewer gets none), and "Refresh results"
 * needs the owner (`App.canAdminister()`): the same silence the rest of the app keeps. A null number is "—", never 0.
 *
 * `AdsTabs` (the Overview | Campaigns | Results | Create bar) lives here and is shared with `ads.js`, `ads_results.js` and `ads_create.js`, which load this module for it.
 */
const AdsTabs = {
    TABS: Object.freeze([
        Object.freeze({ key: 'overview', href: '#/ads', icon: 'layout-dashboard', label: 'ads.tabs.overview' }),
        Object.freeze({ key: 'campaigns', href: '#/ads_campaigns', icon: 'megaphone', label: 'ads.tabs.campaigns' }),
        Object.freeze({ key: 'results', href: '#/ads_results', icon: 'bar-chart-3', label: 'ads.tabs.results' }),
        Object.freeze({ key: 'proposals', href: '#/ads_proposals', icon: 'sparkles', label: 'ads.tabs.proposals' }),
        Object.freeze({ key: 'audiences', href: '#/ads_audiences', icon: 'users', label: 'ads.tabs.audiences' }),
        Object.freeze({ key: 'rules', href: '#/ads_rules', icon: 'list-checks', label: 'ads.tabs.rules' }),
        // A10: lead forms and leads, locked until a legal sign-off. The tab is always there; the page says when it is locked.
        Object.freeze({ key: 'leads', href: '#/ads_leads', icon: 'clipboard-list', label: 'ads.tabs.leads' }),
        // A12: split tests, two versions of an ad or two audiences.
        Object.freeze({ key: 'tests', href: '#/ads_tests', icon: 'split', label: 'ads.tabs.tests' }),
        // A5: the full builder. Owners only on the server; the tab is shown to whoever sees the Ads area, and Create explains a refusal.
        Object.freeze({ key: 'create', href: '#/ads_create', icon: 'plus', label: 'ads.tabs.create' }),
    ]),

    /** The tab bar, with `active` ('overview' | 'campaigns' | 'results' | 'create') marked as the current page. Plain links: a tab is a place, so it has an address. */
    markup(active) {
        const tab = (item) => html`
            <a class="btn btn-sm btn-ghost" href="${item.href}" ${item.key === active ? html.raw('aria-current="page"') : ''}>
                <i data-lucide="${item.icon}" aria-hidden="true"></i> ${t(item.label)}
            </a>
        `;
        return html`
            <div class="page-toolbar ads-tabs" id="ads-tabs">
                <nav class="segmented studio-seg ads-tabs-seg" aria-label="${t('ads.tabs.label')}">
                    ${this.TABS.map(tab)}
                </nav>
            </div>
        `;
    },
};

const AdsCampaignsPage = {
    /** 'loading' | 'ready' | 'forbidden' | 'disabled' | 'failed' | 'unconfigured' */
    view: 'loading',
    /** The campaigns (ObjectView[]), as the server last said. */
    items: [],
    /** When the stored copy was last refreshed from Meta (ISO), or null when it never was. */
    syncedAt: null,
    /** What is inside an opened object: id → { state: 'loading' | 'ready' | 'failed', items: ObjectView[] }. */
    kids: Object.create(null),
    /** The ids that are opened. */
    _open: Object.create(null),
    /** Ops being followed: op id → { objectId, kind, started, timer }. */
    _tracked: Object.create(null),
    /** Bumped on every read and on destroy(), so a slow answer cannot land on another screen. */
    _seq: 0,
    _edit: null,
    _reloadTimer: null,

    /** How often an op is asked about, and how long it is followed before the page lets go (and says so). */
    POLL_MS: 3000,
    POLL_MAX_MS: 60000,
    /** After "Refresh results" the page asks again once, when the refresh has had time to run. */
    SYNC_RELOAD_MS: 20000,

    /** The states of an op that are still on their way, and the ones that are over. */
    LIVE: Object.freeze(['pending', 'running', 'verify']),
    FINISHED: Object.freeze(['done', 'failed', 'cancelled']),
    /** Objects Meta no longer runs: nothing is offered on them. */
    NOT_RUNNABLE: Object.freeze(['ARCHIVED', 'DELETED']),
    LEVELS: Object.freeze(['campaign', 'adset', 'ad']),
    OP_KINDS: Object.freeze(['status', 'budget', 'archive', 'delete', 'update', 'create']),
    EDIT_FIELDS: Object.freeze({ amount: 'ads-amount', endTime: 'ads-end' }),

    resetTenantState() {
        this.stopAll();
        this._seq++;
        this.view = 'loading';
        this.items = [];
        this.syncedAt = null;
        this.kids = Object.create(null);
        this._open = Object.create(null);
        this._edit = null;
    },

    destroy() {
        this.stopAll();
        this._seq++;
        this._edit = null;
    },

    /** Every timer this page owns. */
    stopAll() {
        Object.keys(this._tracked).forEach((id) => { clearTimeout(this._tracked[id].timer); });
        this._tracked = Object.create(null);
        if (this._reloadTimer) clearTimeout(this._reloadTimer);
        this._reloadTimer = null;
    },

    // ─── Who ─────────────────────────────────────────────────────────────────

    /** May this session change things (pause, budget, archive, delete)? A viewer reads only. Optimistic when the shell is absent, like ads.js. */
    canWrite() {
        return typeof App === 'undefined' || typeof App.canOperate !== 'function' || App.canOperate();
    },

    /** "Refresh results" is the owner's (the server holds the 15-minute limit for the account). */
    isOwner() {
        return typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
    },

    // ─── Reading ─────────────────────────────────────────────────────────────

    skeleton() {
        return html`
            ${Motion.statsGrid(1)}
            ${Motion.tableCard(4, [t('ads.camp.title'), t('ads.col.status'), t('ads.col.budget'), t('ads.col.spend')])}
            ${Motion.busy()}
        `;
    },

    /**
     * The shared Ads stylesheet is asked for first (the tab has no stylesheet of its own: `ads.css` belongs to the whole area, and is the
     * `ads` entry's `css: true`), so the tree never paints unstyled.
     */
    async render() {
        if (typeof App !== 'undefined' && typeof App.loadPageCss === 'function' && typeof App.entryOf === 'function') {
            await App.loadPageCss('ads', App.entryOf('ads'));
        }
        return this.load();
    },

    /** The page's host: where the tab paints. */
    host() {
        return document.getElementById('page-container');
    },

    /** Reads the campaigns and paints them. Answers true when a fresh answer is on screen. `quiet` keeps what is on screen if the read fails. */
    async load(quiet) {
        const container = this.host();
        if (!container) return false;
        const seq = ++this._seq;
        const gate = quiet ? { done() {} } : Motion.beginLoad(container, () => this.skeleton());
        let answer;
        try {
            answer = await API.getAdsObjects({ level: 'campaign' });
        } catch (err) {
            gate.done();
            if (seq !== this._seq) return false;
            if (err && (err.status === 403 || err.status === 404)) {
                // 404 is ADS_DISABLED (Ads is off for this workspace): nothing is offered, and nothing is an error, as on the Overview.
                this.view = err.status === 404 ? 'disabled' : 'forbidden';
                this.paint(container);
            } else if (err && (err.code === 'ADS_NOT_CONFIGURED' || err.status === 409)) {
                this.view = 'unconfigured';
                this.paint(container);
            } else if (this.view === 'ready') {
                UI.toast(this.failure(err), 'error');
            } else {
                this.view = 'failed';
                UI.renderError(container, {
                    title: t('ads.loadFailed'),
                    message: this.failure(err),
                    hint: t('admin.loadFailedHint'),
                }, () => this.load());
            }
            return false;
        }
        gate.done();
        if (seq !== this._seq) return false;
        this.items = this.visible(answer && Array.isArray(answer.items) ? answer.items : []);
        this.syncedAt = answer && answer.syncedAt ? answer.syncedAt : null;
        this.view = 'ready';
        this.items.forEach((o) => this.adopt(o));
        this.paint(container);
        // What is open stays open across a refresh: its insides are read again, quietly.
        Object.keys(this._open).forEach((id) => { if (this.find(id)) this.loadKids(id, true); else delete this._open[id]; });
        Motion.announce(t('ads.loaded', { count: this.items.length }));
        return true;
    },

    /** The server's own sentence, or the generic one. */
    failure(err) {
        return (err && err.message) || t('error.unexpected');
    },

    /** Deleted objects are history, not part of the account any more: Meta's own Ads Manager hides them by default, and so does this. */
    visible(list) {
        return list.filter((o) => o && o.status !== 'DELETED' && o.effectiveStatus !== 'DELETED');
    },

    /** Running campaigns first: they are the ones that spend. The order within each group is the server's. */
    sorted(list) {
        return list.slice().sort((a, b) => Number(this.running(b)) - Number(this.running(a)));
    },

    running(o) {
        return !!o && (o.status === 'ACTIVE' || o.effectiveStatus === 'ACTIVE');
    },

    // ─── Finding and replacing ───────────────────────────────────────────────

    /** The object with this id anywhere in the tree, or null. */
    find(id) {
        const key = String(id);
        const top = this.items.find((o) => String(o.id) === key);
        if (top) return top;
        const parents = Object.keys(this.kids);
        for (let i = 0; i < parents.length; i++) {
            const hit = this.kids[parents[i]].items.find((o) => String(o.id) === key);
            if (hit) return hit;
        }
        return null;
    },

    /** Put a fresh answer for one object in the tree, wherever it is. */
    replace(object) {
        if (!object || object.id === undefined || object.id === null) return;
        const key = String(object.id);
        const at = this.items.findIndex((o) => String(o.id) === key);
        if (at !== -1) { this.items[at] = object; return; }
        Object.keys(this.kids).forEach((parent) => {
            const list = this.kids[parent].items;
            const i = list.findIndex((o) => String(o.id) === key);
            if (i !== -1) list[i] = object;
        });
    },

    /** Take an object out of the tree (it was deleted). */
    dropObject(id) {
        const key = String(id);
        this.items = this.items.filter((o) => String(o.id) !== key);
        Object.keys(this.kids).forEach((parent) => {
            this.kids[parent].items = this.kids[parent].items.filter((o) => String(o.id) !== key);
        });
        delete this.kids[key];
        delete this._open[key];
    },

    // ─── Opening ─────────────────────────────────────────────────────────────

    toggle(id) {
        const key = String(id);
        if (this._open[key]) {
            delete this._open[key];
            this.paintTree();
            return;
        }
        this._open[key] = true;
        const known = this.kids[key];
        if (!known || known.state === 'failed') this.loadKids(key);
        else this.paintTree();
    },

    /** Reads what is inside one object (its ad sets, or its ads). `quiet`: keep what is shown while it is read again. */
    async loadKids(id, quiet) {
        const key = String(id);
        if (!quiet || !this.kids[key]) this.kids[key] = { state: 'loading', items: [] };
        if (!quiet) this.paintTree();
        const seq = this._seq;
        let answer;
        try {
            answer = await API.getAdsObject(key);
        } catch (err) {
            if (seq !== this._seq) return;
            if (!quiet || this.kids[key].state !== 'ready') this.kids[key] = { state: 'failed', items: [] };
            this.paintTree();
            return;
        }
        if (seq !== this._seq) return;
        const children = this.visible(answer && Array.isArray(answer.children) ? answer.children : []);
        this.kids[key] = { state: 'ready', items: children };
        if (answer && answer.object) this.replace(answer.object);
        children.forEach((o) => this.adopt(o));
        this.paintTree();
    },

    // ─── Formatting ──────────────────────────────────────────────────────────

    /** The currency of the account, from the first object that names one (every budget carries it). */
    currency() {
        const all = this.items.concat(...Object.keys(this.kids).map((k) => this.kids[k].items));
        const hit = all.find((o) => o && o.budget && o.budget.currency);
        return hit ? hit.budget.currency : '';
    },

    /** `12.5 USD` as one isolated run: a currency code never reorders an Arabic sentence. */
    money(amount, currency) {
        const n = Number(amount);
        if (amount === null || amount === undefined || !Number.isFinite(n)) return '—';
        const cur = currency === undefined || currency === null ? this.currency() : currency;
        return `⁦${UI.formatNumber(n)}${cur ? ` ${cur}` : ''}⁩`;
    },

    count(value) {
        return value === null || value === undefined ? '—' : UI.formatNumber(value);
    },

    /** A name from the server isolated by its own first strong letter, for a sentence in the other script. */
    isolate(text) {
        return `⁨${String(text === null || text === undefined ? '' : text)}⁩`;
    },

    timeText(iso) {
        return iso ? `⁦${UI.formatTime(iso)}⁩` : '';
    },

    /** The status key for an object: the server's `effectiveLabel` (an i18n key) when it is one of ours, else built from the status. */
    statusKey(o) {
        const given = o && typeof o.effectiveLabel === 'string' ? o.effectiveLabel : '';
        if (/^ads\.status\.[a-z_]+$/.test(given)) return given;
        const raw = String((o && (o.effectiveStatus || o.status)) || '').toLowerCase().replace(/[^a-z_]/g, '');
        return `ads.status.${raw || 'other'}`;
    },

    /** The status in words. A status Meta adds one day and this catalogue lacks is shown as Meta wrote it, never as a raw key. */
    statusWord(o) {
        const key = this.statusKey(o);
        // `ads.status.unknown` is the server's "a status I could not read": the raw Meta status (shown below) says more than that.
        const said = t(key);
        const raw = o && (o.effectiveStatus || o.status) ? (o.effectiveStatus || o.status) : '';
        if (said !== key && !(key === 'ads.status.unknown' && raw)) return said;
        return t('ads.status.other', { status: this.isolate(raw || '—') });
    },

    statusTone(o) {
        const status = String((o && (o.effectiveStatus || o.status)) || '');
        if (status === 'ACTIVE') return 'badge-success';
        if (['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED'].includes(status)) return 'badge-neutral';
        if (status === 'DISAPPROVED' || status === 'WITH_ISSUES') return 'badge-danger';
        return 'badge-warning';
    },

    statusChip(o) {
        return html`<span class="badge ${html.raw(this.statusTone(o))}" data-ads-status="${o.effectiveStatus || o.status || ''}">${this.statusWord(o)}</span>`;
    },

    levelWord(level) {
        return this.LEVELS.includes(level) ? t(`ads.camp.level.${level}`) : '';
    },

    kindWord(kind) {
        return this.OP_KINDS.includes(kind) ? t(`ads.queue.kind.${kind}`) : t('ads.queue.kind.other');
    },

    budgetText(budget) {
        if (!budget || budget.kind === 'none' || budget.amount === null || budget.amount === undefined) return '';
        const amount = this.money(budget.amount, budget.currency);
        return budget.kind === 'lifetime' ? t('ads.budget.lifetime', { amount }) : t('ads.budget.daily', { amount });
    },

    // ─── Painting ────────────────────────────────────────────────────────────

    paint(container) {
        if (!container) return;
        const focus = UI.captureFocus(container);
        container.innerHTML = esc(this.markup());
        UI.icons(container);
        UI.restoreFocus(focus);
    },

    /** The tree region only: an action repaints this, not the page, so nothing blinks. */
    paintTree() {
        const host = document.getElementById('ads-tree');
        if (!host) return;
        const focus = UI.captureFocus(host);
        host.innerHTML = esc(this.treeMarkup());
        UI.icons(host);
        UI.restoreFocus(focus);
        const help = document.getElementById('ads-camp-help');
        if (help) { help.innerHTML = esc(this.helpMarkup()); UI.icons(help); }
    },

    /** The links into the Help Center. The queued-changes one appears only while something is queued. */
    helpMarkup() {
        return html`
            ${UI.helpLink('ads#campaigns', t('ads.help.campaigns'))}
            ${UI.helpLink('ads#statuses', t('ads.help.statuses'))}
            ${this.anyQueued() ? UI.helpLink('ads#queued-changes', t('ads.help.queued')) : ''}
        `;
    },

    /** Whether any object on screen has a change on its way. */
    anyQueued() {
        const all = this.items.concat(...Object.keys(this.kids).map((k) => this.kids[k].items));
        return all.some((o) => this.queuedOps(o).length > 0);
    },

    markup() {
        const ready = this.view === 'ready';
        const refresh = ready && this.isOwner()
            ? UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('ads.camp.refreshResults'), action: 'adscamp:sync', focusKey: 'ads-camp-sync' })
            : '';
        const updated = ready
            ? (this.syncedAt ? t('ads.camp.updated', { time: `⁦${UI.formatDateTime(this.syncedAt)}⁩` }) : t('ads.camp.neverSynced'))
            : '';
        const header = UI.pageHeader({ title: t('ads.camp.title'), subtitle: updated, actions: refresh });
        const tabs = AdsTabs.markup('campaigns');
        // Not available / owners only: there is nothing to switch to, so no tab bar (the Overview draws the same panels, and the same bar rule).
        if (this.view === 'forbidden') {
            return html`<div id="ads-camp-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.owner.title'), body: t('ads.owner.body') })}</div>`;
        }
        if (this.view === 'disabled') {
            return html`<div id="ads-camp-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.disabled.title'), body: t('ads.disabled.body') })}</div>`;
        }
        if (this.view === 'unconfigured') {
            return html`<div id="ads-camp-page" class="ads-page">${tabs}${header}${UI.emptyState({
                icon: 'megaphone', title: t('ads.notConfigured.title'), body: t('ads.notConfigured.body'),
                action: { label: t('ads.notConfigured.cta'), href: '#/settings?s=ads', icon: 'settings' },
            })}</div>`;
        }
        return html`
            <div id="ads-camp-page" class="ads-page ads-camp-page">
                ${tabs}
                ${header}
                <p class="form-hint ads-tax-note" id="ads-tax-note">${t('ads.tax.note')}</p>
                <p class="ads-help" id="ads-camp-help">${this.helpMarkup()}</p>
                <section class="section" id="ads-tree-section" aria-label="${t('ads.camp.treeLabel')}">
                    <div id="ads-tree">${this.treeMarkup()}</div>
                </section>
            </div>
        `;
    },

    treeMarkup() {
        if (this.items.length === 0) {
            return UI.emptyState({
                icon: 'megaphone', title: t('ads.camp.empty.title'), body: t('ads.camp.empty.body'),
                action: { label: t('ads.empty.cta'), href: '#/posts', icon: 'calendar-days' },
            });
        }
        return html`<ul class="ads-tree" aria-label="${t('ads.camp.treeLabel')}">${this.sorted(this.items).map((o) => this.nodeMarkup(o))}</ul>`;
    },

    /** One row and, when it is open, what is inside it. */
    nodeMarkup(o) {
        const id = String(o.id);
        const level = this.LEVELS.includes(o.level) ? o.level : 'campaign';
        const open = !!this._open[id];
        return html`
            <li class="ads-node ads-node--${html.raw(level)}" data-level="${level}" data-id="${id}" id="ads-node-${id}">
                <div class="ads-row">
                    <div class="ads-row-lead">${level === 'ad' ? '' : this.toggleButton(o, open)}</div>
                    <div class="ads-row-main">${this.mainMarkup(o)}</div>
                    ${this.figuresMarkup(o)}
                    ${this.actionsMarkup(o)}
                </div>
                ${open ? this.kidsMarkup(o) : ''}
            </li>
        `;
    },

    toggleButton(o, open) {
        const id = String(o.id);
        const name = this.isolate(o.name || o.id);
        return html`<button type="button" class="btn btn-ghost btn-sm ads-toggle" data-action="adscamp:toggle" data-id="${id}" data-focus-key="ads-toggle-${id}"
            aria-expanded="${open ? 'true' : 'false'}" aria-controls="ads-kids-${id}" aria-label="${t(open ? 'ads.camp.collapse' : 'ads.camp.expand', { name })}"><i data-lucide="${open ? 'chevron-down' : 'chevron-right'}" aria-hidden="true"></i></button>`;
    },

    mainMarkup(o) {
        const origin = o.origin === 'boost'
            ? html`<span class="badge badge-info">${t('ads.boost.chip')}</span>`
            : html`<span class="badge badge-neutral">${t('ads.origin.meta')}</span>`;
        const queued = this.queuedOps(o).map((op) => this.queuedBadge(op));
        return html`
            <span class="ads-level">${this.levelWord(o.level)}</span>
            <strong class="ads-row-name" dir="auto">${o.name || o.id}</strong>
            <span class="ads-badges">${origin}${this.statusChip(o)}${queued}</span>
            ${this.reviewMarkup(o)}
        `;
    },

    /** Meta's own reasons (a rejected ad, a restricted account) and the learning phase, said where the status is. */
    reviewMarkup(o) {
        const review = o.review || {};
        const reasons = Array.isArray(review.reasons) ? review.reasons.filter((r) => typeof r === 'string' && r) : [];
        const learning = String(review.learning || '').toUpperCase();
        const learningKey = learning === 'LEARNING' ? 'ads.camp.learning.learning' : (learning === 'LEARNING_LIMITED' ? 'ads.camp.learning.limited' : '');
        if (reasons.length === 0 && !learningKey) return '';
        return html`
            <span class="ads-review">
                ${reasons.length ? html`<span class="ads-review-title">${t('ads.camp.review.title')}</span>
                    <ul class="ads-review-list">${reasons.map((r) => html`<li dir="auto">${r}</li>`)}</ul>` : ''}
                ${learningKey ? html`<span class="ads-name-sub">${t(learningKey)}</span>` : ''}
            </span>
        `;
    },

    /** The changes on their way for this object: the server's, kept current by the poll. */
    queuedOps(o) {
        return o && Array.isArray(o.queued) ? o.queued.filter((op) => op && this.LIVE.includes(op.state)) : [];
    },

    /** "Budget change · Queued · expected at 14:05": what, how far along, and when it should be through. */
    queuedBadge(op) {
        const parts = [this.kindWord(op.kind), t(`ads.queue.state.${op.state}`)];
        const due = op.notBefore ? Date.parse(op.notBefore) : NaN;
        if (Number.isFinite(due) && due > Date.now() && op.state !== 'running') parts.push(t('ads.queue.expected', { time: this.timeText(op.notBefore) }));
        return html`<span class="badge badge-info ads-queued" data-op-id="${op.id}" data-op-state="${op.state}"><i data-lucide="clock" aria-hidden="true"></i> ${parts.join(' · ')}</span>`;
    },

    /** Budget (and the changes Meta still allows this hour), then the results. Every spend figure points at the note about tax. */
    figuresMarkup(o) {
        const budget = o.budget || {};
        const text = this.budgetText(budget);
        const left = budget.editsLeftThisHour;
        const leftText = left === null || left === undefined ? '' : t('ads.camp.editsLeft', { count: Number(left) });
        const hasBudget = budget.kind === 'daily' || budget.kind === 'lifetime';
        let budgetCell = '';
        if (hasBudget) {
            budgetCell = html`<div class="ads-figure"><dt>${t('ads.col.budget')}</dt><dd><span class="ads-budget-amount">${text}</span>${leftText ? html`<span class="ads-name-sub ads-edits-left ${Number(left) === 0 ? html.raw('text-warning') : ''}" data-edits-left="${left}">${leftText}</span>` : ''}</dd></div>`;
        } else if (o.level === 'campaign') {
            budgetCell = html`<div class="ads-figure"><dt>${t('ads.col.budget')}</dt><dd>${t('ads.budget.perAdset')}</dd></div>`;
        }
        const r = o.results;
        const cur = budget.currency;
        const results = r
            ? html`
                <div class="ads-figure"><dt>${t('ads.col.spend')}</dt><dd aria-describedby="ads-tax-note">${this.money(r.spend, cur)}</dd></div>
                <div class="ads-figure"><dt>${t('ads.camp.res.conversations')}</dt><dd>${this.count(r.conversations)}</dd></div>
                <div class="ads-figure"><dt>${t('ads.camp.res.costPerConv')}</dt><dd aria-describedby="ads-tax-note">${this.money(r.costPerConversation, cur)}</dd></div>`
            : html`<div class="ads-figure ads-figure--none"><dt class="sr-only">${t('ads.col.results')}</dt><dd class="form-hint">${t('ads.camp.res.none')}</dd></div>`;
        return html`<dl class="ads-figures">${budgetCell}${results}</dl>`;
    },

    /** What is inside an opened row. */
    kidsMarkup(o) {
        const id = String(o.id);
        const known = this.kids[id] || { state: 'loading', items: [] };
        let inner;
        if (known.state === 'loading') {
            inner = html`<li class="ads-kids-note form-hint" role="status">${t('common.loading')}</li>`;
        } else if (known.state === 'failed') {
            inner = html`<li class="ads-kids-note"><span class="form-hint">${t('ads.camp.children.failed')}</span>
                ${UI.button({ variant: 'ghost', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'adscamp:retryKids', data: { id }, focusKey: `ads-retry-${id}` })}</li>`;
        } else if (known.items.length === 0) {
            inner = html`<li class="ads-kids-note form-hint">${t(o.level === 'adset' ? 'ads.camp.children.noneAds' : 'ads.camp.children.noneSets')}</li>`;
        } else {
            inner = known.items.map((k) => this.nodeMarkup(k));
        }
        return html`<ul class="ads-children" id="ads-kids-${id}">${inner}</ul>`;
    },

    // ─── Actions per row ─────────────────────────────────────────────────────

    actionsMarkup(o) {
        if (!this.canWrite()) return '';
        // While a change is on its way the row offers nothing else: its badge says what is happening, and a second change on top of an
        // unfinished one is how a budget ends up other than the one the owner meant.
        if (this.queuedOps(o).length > 0) return '';
        const id = String(o.id);
        const status = String(o.status || '');
        if (this.NOT_RUNNABLE.includes(status)) return '';
        const name = this.isolate(o.name || o.id);
        // A button that says only "Pause" is read out of its row by a screen reader: the name says which one it is for.
        const label = (key) => t('ads.actionFor', { action: t(key), name });
        const running = this.running(o);
        const buttons = [];
        if (running) {
            buttons.push(UI.button({ variant: 'secondary', size: 'sm', icon: 'pause', label: t('ads.camp.act.pause'), action: 'adscamp:pause', data: { id }, focusKey: `ads-pause-${id}`, ariaLabel: label('ads.camp.act.pause') }));
        } else if (status === 'PAUSED') {
            buttons.push(UI.button({ variant: 'primary', size: 'sm', icon: 'play', label: t('ads.camp.act.resume'), action: 'adscamp:resume', data: { id }, focusKey: `ads-resume-${id}`, ariaLabel: label('ads.camp.act.resume') }));
        }
        if (o.budget && o.budget.editable) {
            buttons.push(UI.button({ variant: 'secondary', size: 'sm', icon: 'pencil', label: t('ads.camp.act.editBudget'), action: 'adscamp:editBudget', data: { id }, focusKey: `ads-edit-${id}`, ariaLabel: label('ads.camp.act.editBudget') }));
        }
        if (o.level !== 'creative') {
            buttons.push(UI.button({ variant: 'ghost', size: 'sm', icon: 'copy', label: t('ads.camp.act.duplicate'), action: 'adscamp:duplicate', data: { id }, focusKey: `ads-duplicate-${id}`, ariaLabel: label('ads.camp.act.duplicate') }));
        }
        buttons.push(UI.button({ variant: 'ghost', size: 'sm', icon: 'archive', label: t('ads.camp.act.archive'), action: 'adscamp:archive', data: { id }, focusKey: `ads-archive-${id}`, ariaLabel: label('ads.camp.act.archive') }));
        // A running object is never deleted in one step: it is paused first, and then deleting is its own question.
        if (!running) {
            buttons.push(UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('ads.camp.act.delete'), action: 'adscamp:remove', data: { id }, focusKey: `ads-delete-${id}`, ariaLabel: label('ads.camp.act.delete') }));
        }
        return html`<div class="ads-actions">${buttons}</div>`;
    },

    // ─── Following an op ─────────────────────────────────────────────────────

    /** Follow every change already queued on an object when it is read (a rule's, an earlier visit's): its badge then clears by itself. */
    adopt(o) {
        this.queuedOps(o).forEach((op) => {
            if (op.id !== undefined && !this._tracked[op.id]) this.track(o.id, op, true);
        });
    },

    /** An action was answered `{ op }`: show it on the row and ask about it until it is over (or a minute has gone). */
    track(objectId, op, quiet) {
        if (!op || op.id === undefined || op.id === null) return;
        if (!this.LIVE.includes(op.state) && !this.FINISHED.includes(op.state)) op = Object.assign({}, op, { state: 'pending' });
        const key = String(op.id);
        if (this._tracked[key]) clearTimeout(this._tracked[key].timer);
        this._tracked[key] = { objectId: String(objectId), kind: op.kind, started: this._tracked[key] ? this._tracked[key].started : Date.now(), timer: null };
        if (this.FINISHED.includes(op.state)) { this.finish(key, op); return; }
        if (!quiet) this.setQueued(objectId, op);
        this.schedule(key);
    },

    schedule(key) {
        const entry = this._tracked[key];
        if (!entry) return;
        entry.timer = setTimeout(() => { this.poll(key); }, this.POLL_MS);
    },

    async poll(key) {
        const entry = this._tracked[key];
        if (!entry) return;
        let op = null;
        try {
            const answer = await API.getAdsOp(key);
            op = answer && answer.op ? answer.op : null;
        } catch (err) {
            // A refusal that will not change (no access, the op is gone) ends the watch; a network blip is asked again.
            if (err && (err.status === 403 || err.status === 404)) { this.untrack(key); this.reloadObject(entry.objectId); return; }
        }
        if (!this._tracked[key]) return;
        if (op && this.FINISHED.includes(op.state)) { this.finish(key, op); return; }
        if (op) this.setQueued(entry.objectId, op);
        if (Date.now() - entry.started >= this.POLL_MAX_MS) { this.giveUp(key); return; }
        this.schedule(key);
    },

    untrack(key) {
        const entry = this._tracked[key];
        if (entry) clearTimeout(entry.timer);
        delete this._tracked[key];
        return entry;
    },

    /** The op is over: the badge goes, the person is told how it ended, and the row is read again from the server. */
    async finish(key, op) {
        const entry = this.untrack(key);
        if (!entry) return;
        const kind = this.kindWord(op.kind || entry.kind);
        this.dropQueued(entry.objectId, key);
        if (op.state === 'done') {
            UI.toast(t('ads.camp.opDone', { kind }), 'success');
            Motion.announce(t('ads.camp.opDone', { kind }));
        } else {
            const why = this.reasonOf(op);
            const text = why ? t('ads.camp.opFailedWhy', { kind, reason: why }) : t('ads.camp.opFailed', { kind });
            UI.toast(text, 'error');
            Motion.announce(text);
        }
        await this.reloadObject(entry.objectId, op.kind === 'delete' && op.state === 'done');
    },

    /** The reason an op failed, when the server gave one as text. */
    reasonOf(op) {
        const r = op && op.result;
        if (r && typeof r === 'object') {
            if (typeof r.message === 'string' && r.message) return r.message;
            if (typeof r.error === 'string' && r.error) return r.error;
        }
        return typeof r === 'string' ? r : '';
    },

    /** A minute passed and Meta is not through: stop asking, and say the change is still coming. */
    giveUp(key) {
        const entry = this.untrack(key);
        if (!entry) return;
        const text = t('ads.camp.opSlow', { kind: this.kindWord(entry.kind) });
        UI.toast(text, 'info');
        Motion.announce(text);
    },

    /** Put (or refresh) an op in an object's queued list and repaint. */
    setQueued(objectId, op) {
        const o = this.find(objectId);
        if (!o) return;
        o.queued = (Array.isArray(o.queued) ? o.queued : []).filter((q) => String(q.id) !== String(op.id)).concat([op]);
        this.paintTree();
    },

    dropQueued(objectId, opId) {
        const o = this.find(objectId);
        if (!o) return;
        o.queued = (Array.isArray(o.queued) ? o.queued : []).filter((q) => String(q.id) !== String(opId));
    },

    /** Read one object (and what is inside it) again and repaint. `gone`: it was deleted, so it leaves the tree instead. */
    async reloadObject(id, gone) {
        if (gone) {
            this.dropObject(id);
            this.paintTree();
            this.focusOn('ads-tree-section');
            return;
        }
        const seq = this._seq;
        try {
            const answer = await API.getAdsObject(String(id));
            if (seq !== this._seq || !answer || !answer.object) return;
            if (answer.object.status === 'DELETED' || answer.object.effectiveStatus === 'DELETED') {
                this.dropObject(id);
                this.paintTree();
                this.focusOn('ads-tree-section');
                return;
            }
            this.replace(answer.object);
            if (this._open[String(id)] && Array.isArray(answer.children)) {
                this.kids[String(id)] = { state: 'ready', items: this.visible(answer.children) };
            }
            this.paintTree();
        } catch (err) {
            // The row keeps what it showed; the next visit reads it again.
        }
    },

    focusOn(id) {
        const el = document.getElementById(id);
        if (!el || typeof el.focus !== 'function') return;
        if (typeof el.setAttribute === 'function') el.setAttribute('tabindex', '-1');
        el.focus();
    },

    /** The answer to a write: `{ op }`. Show it queued and follow it. */
    applyWrite(objectId, answer, toastKey) {
        const op = answer && answer.op ? answer.op : null;
        if (op) this.track(objectId, op);
        // An op that is already over (the queue ran it before it answered) is told by `finish`: one message, not "queued" and then "done".
        if (op && this.FINISHED.includes(op.state)) return op;
        UI.toast(t(toastKey || 'ads.camp.queued'), 'success');
        Motion.announce(t('ads.camp.queued'));
        return op;
    },

    // ─── Pause ───────────────────────────────────────────────────────────────

    async pause(el) {
        const id = el && el.dataset ? el.dataset.id : '';
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            const answer = await API.setAdsObjectStatus(id, { status: 'PAUSED' });
            restore();
            this.applyWrite(id, answer);
        } catch (err) {
            restore();
            UI.toast(this.failure(err), 'error');
        }
    },

    // ─── Resume: STARTS SPENDING MONEY ───────────────────────────────────────

    resume(id) {
        const o = this.find(id);
        if (!o || this.running(o)) return;
        const budget = this.budgetText(o.budget);
        const hint = [budget ? t('ads.camp.resume.budget', { budget }) : '', t('ads.activate.hint')].filter(Boolean).join(' ');
        UI.confirm({
            title: t('ads.camp.resume.title'),
            body: t('ads.camp.resume.body', { name: this.isolate(o.name || o.id) }),
            hint,
            tone: 'primary',
            confirmLabel: t('ads.camp.resume.confirm'),
            confirmIcon: 'play',
            onConfirm: () => AdsCampaignsPage.resumeConfirmed(String(o.id)),
        });
    },

    /**
     * A refusal inside a question, in words: the dialog keeps itself open and shows the thrown message, so the hourly limit and Meta's rate
     * limit become "try again at 14:05" there too, not the server's English.
     */
    async asked(work) {
        try {
            return await work();
        } catch (err) {
            throw new Error(this.refusalText(err));
        }
    },

    /** The question was answered yes. A refusal is thrown, so the dialog stays open and says why. */
    resumeConfirmed(id) {
        return this.asked(async () => {
            const answer = await API.setAdsObjectStatus(id, { status: 'ACTIVE', confirm: true });
            this.applyWrite(id, answer);
        });
    },

    // ─── Duplicate (A5) ──────────────────────────────────────────────────────

    /** A copy is created PAUSED and re-enters Meta's review and learning: said before, never a surprise. */
    duplicate(id) {
        const o = this.find(id);
        if (!o) return;
        UI.confirm({
            title: t('ads.camp.duplicate.title'),
            body: t('ads.camp.duplicate.body', { name: this.isolate(o.name || o.id) }),
            hint: t('ads.camp.duplicate.hint'),
            tone: 'primary',
            confirmLabel: t('ads.camp.act.duplicate'),
            confirmIcon: 'copy',
            onConfirm: () => AdsCampaignsPage.duplicateConfirmed(String(o.id)),
        });
    },

    duplicateConfirmed(id) {
        return this.asked(async () => {
            const answer = await API.duplicateAdsObject(id, { deep: true });
            this.applyWrite(id, answer);
        });
    },

    // ─── Archive and delete ──────────────────────────────────────────────────

    archive(id) {
        const o = this.find(id);
        if (!o || this.NOT_RUNNABLE.includes(o.status)) return;
        UI.confirm({
            title: t('ads.camp.archive.title'),
            body: t('ads.camp.archive.body', { name: this.isolate(o.name || o.id) }),
            hint: t('ads.camp.archive.hint'),
            tone: 'primary',
            confirmLabel: t('ads.camp.act.archive'),
            confirmIcon: 'archive',
            onConfirm: () => AdsCampaignsPage.archiveConfirmed(String(o.id)),
        });
    },

    archiveConfirmed(id) {
        return this.asked(async () => {
            const answer = await API.archiveAdsObject(id);
            this.applyWrite(id, answer);
        });
    },

    /** Delete is its own question, and is not offered (nor accepted here) while the object is running. */
    remove(id) {
        const o = this.find(id);
        if (!o || this.running(o)) return;
        UI.confirm({
            title: t('ads.camp.delete.title'),
            body: t('ads.camp.delete.body', { name: this.isolate(o.name || o.id) }),
            hint: t('ads.camp.delete.hint'),
            confirmLabel: t('ads.camp.act.delete'),
            onConfirm: () => AdsCampaignsPage.removeConfirmed(String(o.id)),
        });
    },

    removeConfirmed(id) {
        return this.asked(async () => {
            const answer = await API.deleteAdsObject(id, { confirm: true });
            this.applyWrite(id, answer);
        });
    },

    // ─── Edit budget ─────────────────────────────────────────────────────────

    /** `2026-10-31` in the browser's own zone, for a date input. '' for anything that is not a date. */
    localDay(iso) {
        const d = iso ? new Date(iso) : null;
        if (!d || Number.isNaN(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },

    /** The end of the picked day in local time, as an ISO instant; null when the value is not a date. */
    endOfDayIso(value) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
        if (!m) return null;
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    },

    editBudget(id) {
        const o = this.find(id);
        if (!o || !o.budget || !o.budget.editable) return;
        const lifetime = o.budget.kind === 'lifetime';
        const currency = o.budget.currency || this.currency();
        const left = o.budget.editsLeftThisHour;
        const day = this.localDay(o.schedule && o.schedule.end);
        this._edit = { id: String(o.id), kind: o.budget.kind === 'lifetime' ? 'lifetime' : 'daily', day };
        const running = this.running(o);
        const leftText = left === null || left === undefined ? '' : t('ads.camp.editsLeft', { count: Number(left) });
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">${t('ads.edit.title')}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <p class="ads-edit-name" dir="auto"><strong>${o.name || ''}</strong></p>
            <p class="form-hint ${running ? html.raw('text-warning') : ''}" id="ads-edit-state">${running ? t('ads.edit.running') : t('ads.edit.notRunning')}</p>
            <div id="ads-edit-error"></div>
            <form id="ads-edit-form" data-submit="adscamp:budgetSubmit" novalidate>
                <div class="form-group">
                    <label class="form-label" for="ads-amount">${lifetime ? t('ads.edit.total') : t('ads.edit.daily')} ${currency ? html`<span class="label-optional">${UI.ltr(currency)}</span>` : ''}</label>
                    <input class="field field-mono" id="ads-amount" name="amount" type="number" dir="ltr" inputmode="decimal" min="0" step="any"
                           value="${o.budget.amount === null || o.budget.amount === undefined ? '' : o.budget.amount}" aria-describedby="ads-amount-hint" required>
                    <p class="form-hint" id="ads-amount-hint">${t('ads.camp.budget.limitServer')}</p>
                    <p class="form-hint ${Number(left) === 0 ? html.raw('text-warning') : ''}" id="ads-edits-hint">${leftText ? `${leftText} ` : ''}${t('ads.camp.editsLimit')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="ads-end">${t('ads.edit.end')} <span class="label-optional">${t('common.optional')}</span></label>
                    <input class="field field-mono" id="ads-end" name="end" type="date" dir="ltr" min="${this.localDay(new Date().toISOString())}" value="${day}" aria-describedby="ads-end-hint">
                    <p class="form-hint" id="ads-end-hint">${t('ads.edit.endHint')}</p>
                </div>
                <div class="modal-actions">
                    ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'check', label: t('common.save') })}
                </div>
            </form>
        `);
    },

    showEditError(message, field) {
        const host = document.getElementById('ads-edit-error');
        const form = document.getElementById('ads-edit-form');
        if (form) UI.clearInvalid(form);
        if (!host) { UI.toast(message, 'error'); return; }
        const stripId = 'ads-edit-error-strip';
        host.innerHTML = esc(UI.errorStrip(message, '', stripId));
        UI.icons(host);
        const input = field && this.EDIT_FIELDS[field] ? document.getElementById(this.EDIT_FIELDS[field]) : null;
        if (input) UI.markInvalid(input, stripId);
        else if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    },

    /** The sentence for a refusal: the hourly limit and Meta's own rate limit say when to try again; anything else is the server's words. */
    refusalText(err) {
        const code = err && err.code;
        const retryAt = err && err.body && err.body.retryAt ? err.body.retryAt : '';
        const time = retryAt ? this.timeText(retryAt) : '';
        if (code === 'EDIT_LIMIT') return time ? t('ads.camp.err.limit', { time }) : t('ads.camp.err.limitLater');
        if (code === 'RATE_LIMITED') return time ? t('ads.camp.err.rate', { time }) : t('ads.camp.err.rateLater');
        return this.failure(err);
    },

    /**
     * Whether this edit makes a RUNNING object spend more: a higher amount, or a later end. Only then is a question asked (lowering a budget
     * or ending sooner can only spend less). Answers `{ amountUp, endLater }` or null.
     */
    raiseOf(o, amount, endTime) {
        if (!o || !this.running(o) || !o.budget) return null;
        const was = Number(o.budget.amount);
        const amountUp = Number.isFinite(was) && amount > was;
        const was2 = o.schedule && o.schedule.end ? Date.parse(o.schedule.end) : NaN;
        const endLater = Boolean(endTime && Number.isFinite(was2) && Date.parse(endTime) > was2);
        return amountUp || endLater ? { amountUp, endLater } : null;
    },

    /** The question for a raise, drawn over the form so "no" leaves the form as it was. A refusal from the server is said inside the question. */
    confirmRaise(state, o, payload) {
        const unit = state.kind === 'lifetime' ? 'ads.budget.lifetime' : 'ads.budget.daily';
        const cur = o.budget.currency;
        UI.confirm({
            stack: true,
            title: t('ads.camp.raise.title'),
            body: t('ads.camp.raise.body', {
                name: this.isolate(o.name || o.id),
                from: t(unit, { amount: this.money(o.budget.amount, cur) }),
                to: t(unit, { amount: this.money(payload.amount, cur) }),
            }),
            hint: t('ads.activate.hint'),
            tone: 'primary',
            confirmLabel: t('ads.raise.confirm'),
            confirmIcon: 'trending-up',
            cancelLabel: t('ads.raise.back'),
            // The server requires `confirm: true` for a raise on a running object; only the answer "yes" sends it.
            onConfirm: () => AdsCampaignsPage.asked(() => AdsCampaignsPage.saveBudget(state, Object.assign({}, payload, { confirm: true }))),
        });
    },

    /** Send the budget. A refusal is thrown (the question or the form shows it); success closes the form and shows the op queued. */
    async saveBudget(state, payload) {
        const answer = await API.setAdsObjectBudget(state.id, payload);
        // The change was accepted whether or not the form is still open: the op is followed either way.
        if (this._edit === state) {
            this._edit = null;
            UI.closeModal();
        }
        this.applyWrite(state.id, answer, 'ads.camp.budget.queued');
    },

    async budgetSubmit(form, event) {
        event.preventDefault();
        const state = this._edit;
        if (!state || !form) return;
        const host = document.getElementById('ads-edit-error');
        if (host) host.innerHTML = '';
        const raw = String(form.elements.amount ? form.elements.amount.value : '').trim();
        const amount = raw === '' ? NaN : Number(raw);
        const end = String(form.elements.end ? form.elements.end.value : '').trim();
        if (!Number.isFinite(amount) || amount <= 0) { this.showEditError(t('ads.err.amount'), 'amount'); return; }
        const payload = { kind: state.kind, amount };
        if (end && end !== state.day) {
            const iso = this.endOfDayIso(end);
            if (!iso) { this.showEditError(t('ads.err.end'), 'endTime'); return; }
            if (Date.parse(iso) <= Date.now()) { this.showEditError(t('ads.err.endPast'), 'endTime'); return; }
            payload.endTime = iso;
        }
        const o = this.find(state.id);
        if (this.raiseOf(o, amount, payload.endTime)) { this.confirmRaise(state, o, payload); return; }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await this.saveBudget(state, payload);
        } catch (err) {
            restore();
            const field = (err && err.body && err.body.field) || '';
            this.showEditError(this.refusalText(err), field);
        }
    },

    // ─── Refresh results ─────────────────────────────────────────────────────

    /** Asks the server to refresh the stored copy from Meta. It may refuse (one refresh per 15 minutes): then it says when. */
    async sync(el) {
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            await API.requestAdsSync();
            restore();
            UI.toast(t('ads.camp.refreshAsked'), 'success');
            if (this._reloadTimer) clearTimeout(this._reloadTimer);
            this._reloadTimer = setTimeout(() => { this._reloadTimer = null; this.load(true); }, this.SYNC_RELOAD_MS);
        } catch (err) {
            restore();
            if (err && (err.code === 'RATE_LIMITED' || err.status === 429)) {
                const retryAt = err.body && err.body.retryAt ? err.body.retryAt : '';
                UI.toast(retryAt ? t('ads.camp.refreshLimited', { time: this.timeText(retryAt) }) : t('ads.camp.refreshLimitedLater'), 'info');
            } else {
                UI.toast(this.failure(err), 'error');
            }
        }
    },
};

UI.registerActions('adscamp', {
    toggle: (el) => AdsCampaignsPage.toggle(el.dataset.id),
    retryKids: (el) => AdsCampaignsPage.loadKids(el.dataset.id),
    pause: (el) => AdsCampaignsPage.pause(el),
    resume: (el) => AdsCampaignsPage.resume(el.dataset.id),
    editBudget: (el) => AdsCampaignsPage.editBudget(el.dataset.id),
    budgetSubmit: (el, e) => AdsCampaignsPage.budgetSubmit(el, e),
    archive: (el) => AdsCampaignsPage.archive(el.dataset.id),
    duplicate: (el) => AdsCampaignsPage.duplicate(el.dataset.id),
    remove: (el) => AdsCampaignsPage.remove(el.dataset.id),
    sync: (el) => AdsCampaignsPage.sync(el),
});
