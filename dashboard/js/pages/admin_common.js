/**
 * Admin foundation — shared by every administration screen, plus the health
 * strip the ORDINARY operator sees.
 *
 * This file is not a page. It lives beside them because that is where the
 * administration UI lives, and it is loaded eagerly (one <script> in
 * index.html) for two reasons: `Admin.confirm` replaces `window.confirm()` for
 * destructive actions anywhere in the app, and `HealthStrip` has to be
 * available on a page whose own module does not know about it.
 *
 * ─── Reading the API tolerantly ─────────────────────────────────────────────
 * The admin API is being built in parallel with this UI. `pick()`/`num()` read
 * a value under any of several plausible keys, so a field that lands under
 * `last_webhook_at` instead of `lastWebhookAt` renders as data rather than as
 * "undefined", and a field that has not shipped at all renders as "—" instead
 * of taking the screen down.
 *
 * ─── Escaping ───────────────────────────────────────────────────────────────
 * Everything here goes through the `html` tag from components.js. No markup is
 * ever concatenated by hand, no value is ever interpolated into an inline
 * event attribute, and every URL that came from the server goes through
 * `safeUrl()`. `Admin.confirm` keeps its callback in a JS variable rather than
 * writing an id or a payload into the DOM, so a confirm dialog carries no
 * attacker-reachable attribute at all.
 */
const Admin = {

    // ─── Reading rows ───────────────────────────────────────────────────────
    /** First value present under any of these keys. */
    pick(row, ...keys) {
        for (const key of keys) {
            if (row && row[key] !== undefined && row[key] !== null) return row[key];
        }
        return undefined;
    },

    /** Numeric, or null — never NaN, and never the string "undefined". */
    num(row, ...keys) {
        const value = Admin.pick(row, ...keys);
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
            return Number(value);
        }
        return null;
    },

    /** A count, or an em dash. Latin numerals isolated inside Arabic copy. */
    count(value) {
        return value === null || value === undefined ? html`—` : UI.num(value);
    },

    // ─── Failure modes ──────────────────────────────────────────────────────
    /**
     * An admin route answered 403 or 404. Both mean the same thing to the
     * operator — this session cannot administer, or the route is not deployed
     * — and neither is fixed by retrying, so there is no Retry button.
     */
    isUnavailable(err) {
        return !!err && (err.status === 403 || err.status === 404);
    },

    renderUnavailable(container, title) {
        App.dropAdminAccess();
        UI.renderError(container, {
            title: title || t('admin.unavailableTitle'),
            message: t('tenants.unavailableBody'),
            icon: 'shield-off',
        });
    },

    /**
     * The one error path every admin page shares: hide when the route is not
     * there, and otherwise show a real error WITH a retry — a failed fetch
     * must never be mistaken for an empty screen.
     */
    renderLoadFailure(container, err, options) {
        const { unavailableTitle, failedTitle, retry } = options || {};
        if (Admin.isUnavailable(err)) {
            Admin.renderUnavailable(container, unavailableTitle);
            return;
        }
        UI.renderError(container, {
            title: failedTitle || t('admin.loadFailed'),
            message: (err && err.message) || t('error.unexpected'),
            hint: t('admin.loadFailedHint'),
        }, typeof retry === 'function' ? retry : null);
    },

    /** An empty result, distinct from a failed one. */
    emptyState(icon, title, body) {
        return html`
            <div class="empty-state">
                <i data-lucide="${icon}" aria-hidden="true"></i>
                <h3>${title}</h3>
                ${body ? html`<p dir="auto">${body}</p>` : ''}
            </div>
        `;
    },

    // ─── Modals ─────────────────────────────────────────────────────────────
    modalHeader(title) {
        return html`
            <div class="modal-header">
                <h2 class="modal-title">${title}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
        `;
    },

    /** The callback the styled confirm will run. Never written into the DOM. */
    _pending: null,

    /**
     * The styled destructive confirmation — the shape `campaigns.js` already
     * uses, made shareable.
     *
     * `window.confirm()` is a browser chrome dialog: it drops the product's
     * visual identity, cannot be translated, cannot be styled as dangerous,
     * and appears at exactly the moment the operator is deciding whether to
     * destroy something. Nothing in the administration UI uses it.
     *
     *   title        heading
     *   body         what will happen, in one sentence
     *   hint         the consequence that is not obvious
     *   confirmLabel a VERB
     *   requireText  the operator must type this string to enable the button
     *   onConfirm()  runs after the modal closes
     */
    confirm(options) {
        const {
            title, body, hint, confirmLabel, confirmIcon = 'trash-2',
            requireText = '', requireHint = '', onConfirm,
        } = options || {};

        Admin._pending = typeof onConfirm === 'function' ? onConfirm : null;
        const gated = !!requireText;

        UI.showModal(html`
            ${Admin.modalHeader(title)}
            <p class="modal-body-text" dir="auto">${body}</p>
            ${hint ? html`<p class="form-hint">${hint}</p>` : ''}
            ${gated ? html`
                <div class="form-group mbs-4">
                    <label class="form-label" for="admin-confirm-echo">${requireHint || t('admin.confirmEcho')}</label>
                    <input class="field field-mono" id="admin-confirm-echo" type="text" dir="ltr"
                           autocomplete="off" spellcheck="false" data-input="admin:gateConfirm"
                           data-expect="${requireText}" aria-describedby="admin-confirm-echo-hint">
                    <p class="form-hint" id="admin-confirm-echo-hint">${t('admin.confirmEchoHint', { value: requireText })}</p>
                </div>
            ` : ''}
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                <button type="button" class="btn btn-danger" id="admin-confirm-btn"
                        data-action="admin:runConfirm" ${gated ? html.raw('disabled') : ''}>
                    <i data-lucide="${confirmIcon}" aria-hidden="true"></i> ${confirmLabel || t('common.delete')}
                </button>
            </div>
        `);
    },

    /** The typed-echo gate: the button turns on only on an exact match. */
    gateConfirm(input) {
        const btn = document.getElementById('admin-confirm-btn');
        if (!btn) return;
        btn.disabled = String(input.value || '').trim() !== String(input.dataset.expect || '');
    },

    runConfirm() {
        const fn = Admin._pending;
        Admin._pending = null;
        UI.closeModal();
        if (typeof fn !== 'function') return;
        try {
            const result = fn();
            Admin.report(result);
        } catch (err) {
            UI.toast((err && err.message) || t('common.error'), 'error');
        }
    },

    /** The delegated dispatcher only catches synchronous throws. */
    report(promise) {
        if (promise && typeof promise.catch === 'function') {
            promise.catch((err) => UI.toast((err && err.message) || t('common.error'), 'error'));
        }
        return promise;
    },

    // ─── Health vocabulary ──────────────────────────────────────────────────
    /** Webhook freshness: warn at 6h, red at 24h. A tenant silent for days is red. */
    WEBHOOK_AGE: { warnMs: 6 * 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 },
    /** A token status is a claim about the past; after a day it is a guess. */
    CHECK_AGE: { warnMs: 24 * 60 * 60 * 1000, staleMs: 7 * 24 * 60 * 60 * 1000 },

    /**
     * A relative age as a coloured pill. The whole point of this component is
     * that "3 days ago" in red needs no arithmetic — the operator does not
     * subtract a timestamp from today to find out something is broken.
     */
    agePill(value, options) {
        const age = UI.relativeAge(value, options || Admin.WEBHOOK_AGE);
        return html`
            <span class="health-pill health-${html.raw(age.level)}" title="${age.title}">
                <span class="health-dot" aria-hidden="true"></span>${age.text}
            </span>
        `;
    },

    /** `valid` / `invalid` / anything else, including nothing at all. */
    tokenState(status) {
        const value = String(status || '').toLowerCase();
        if (!value || value === 'unknown') return 'unknown';
        return (value === 'valid' || value === 'ok' || value === 'active') ? 'valid' : 'invalid';
    },

    tokenPill(status) {
        const state = Admin.tokenState(status);
        const label = state === 'unknown' ? t('common.unknown')
            : state === 'valid' ? t('settings.valid') : t('settings.invalid');
        const level = state === 'unknown' ? 'warn' : state === 'valid' ? 'fresh' : 'stale';
        const icon = state === 'unknown' ? 'help-circle'
            : state === 'valid' ? 'check-circle' : 'alert-triangle';
        return html`
            <span class="health-pill health-${html.raw(level)}">
                <i data-lucide="${icon}" aria-hidden="true"></i>${label}
            </span>
        `;
    },

    /**
     * Meta's own explanation of why a token is bad. It is on the wire in
     * `tokenError` and was being thrown away, which left the operator with a
     * red pill and no diagnosis.
     */
    tokenError(message) {
        if (!message) return html``;
        return html`
            <p class="health-diagnosis" dir="auto">
                <i data-lucide="alert-circle" aria-hidden="true"></i>
                <span>${message}</span>
            </p>
        `;
    },

    /**
     * A used/ceiling meter. The width is applied from `data-share` by
     * `applyMeters()` AFTER the markup is escaped, so no number is ever
     * interpolated into a style attribute.
     */
    meter(used, ceiling, ariaLabel) {
        if (used === null && ceiling === null) return html`<span class="text-meta">—</span>`;
        if (ceiling === null || !(ceiling > 0)) {
            return html`<span class="dm-meter-text">${used === null ? html`—` : UI.num(used)}</span>`;
        }
        const value = used === null ? 0 : used;
        const ratio = Math.max(0, Math.min(1, value / ceiling));
        const level = ratio >= 0.9 ? 'stale' : ratio >= 0.6 ? 'warn' : 'fresh';
        return html`
            <div class="dm-meter">
                <span class="dm-meter-text">${UI.ltr(`${UI.formatNumber(value)} / ${UI.formatNumber(ceiling)}`)}</span>
                <span class="dm-meter-track" role="img" aria-label="${ariaLabel || ''}">
                    <span class="dm-meter-fill dm-meter-${html.raw(level)}" data-share="${Math.round(ratio * 100)}"></span>
                </span>
            </div>
        `;
    },

    /** pending / running / failed on one line, with failed always visible. */
    queueTriple(queue) {
        const pending = Admin.num(queue, 'pending');
        const running = Admin.num(queue, 'running');
        const failed = Admin.num(queue, 'failed');
        if (pending === null && running === null && failed === null) {
            return html`<span class="text-meta">—</span>`;
        }
        return html`
            <span class="queue-triple">
                <span>${t('ops.queuePending', { count: pending === null ? '—' : UI.formatNumber(pending) })}</span>
                ${running === null ? '' : html`<span>${t('ops.queueRunning', { count: UI.formatNumber(running) })}</span>`}
                <span class="count-bad ${failed ? '' : html.raw('count-zero')}">${
                    t('ops.queueFailed', { count: failed === null ? '—' : UI.formatNumber(failed) })
                }</span>
            </span>
        `;
    },

    applyMeters(root) {
        const scope = root || document;
        scope.querySelectorAll('.dm-meter-fill[data-share]').forEach((el) => {
            el.style.inlineSize = `${Math.max(0, Math.min(100, Number(el.dataset.share) || 0))}%`;
        });
    },

    /** Bytes, in the active locale, with a unit the operator recognises. */
    bytes(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return '—';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        let out = n;
        while (out >= 1024 && i < units.length - 1) { out /= 1024; i += 1; }
        const digits = out < 10 && i > 0 ? 1 : 0;
        let text;
        try {
            text = out.toLocaleString(I18N.locale(), {
                minimumFractionDigits: digits, maximumFractionDigits: digits,
            });
        } catch {
            text = out.toFixed(digits);
        }
        return `${text} ${units[i]}`;
    },

    /** A stat tile, used by Operations for the platform-wide numbers. */
    statTile(options) {
        const { label, value, sub, icon, tone = 'accent' } = options || {};
        return html`
            <div class="stat-card surface">
                <div class="stat-header">
                    <span class="stat-label">${label}</span>
                    ${icon ? html`<span class="stat-icon ${html.raw(tone)}"><i data-lucide="${icon}" aria-hidden="true"></i></span>` : ''}
                </div>
                <p class="stat-value">${value}</p>
                ${sub ? html`<p class="stat-sub" dir="auto">${sub}</p>` : ''}
            </div>
        `;
    },

    /** One definition pair inside a detail card. */
    field(label, value) {
        return html`
            <div class="detail-field">
                <dt>${label}</dt>
                <dd dir="auto">${value}</dd>
            </div>
        `;
    },

    /**
     * The message for a PATCH that collided with another tenant. The server
     * answers 409; "Request failed (409)" tells the operator nothing, and this
     * is the one mistake on that form that is genuinely easy to make.
     */
    describeWriteError(err, fallbackKey) {
        if (err && err.status === 409) {
            const detail = (err.body && (err.body.error || err.body.message)) || '';
            return t('tenantDetail.claimed') + (detail ? ` (${detail})` : '');
        }
        return (err && err.message) || t(fallbackKey || 'common.error');
    },
};

UI.registerActions('admin', {
    runConfirm: () => Admin.runConfirm(),
    gateConfirm: (el) => Admin.gateConfirm(el),
});

/* ═══════════════════════════════════════════════════════════════════════════
   HEALTH STRIP — the ordinary operator's answer to "are webhooks arriving?"
   ═══════════════════════════════════════════════════════════════════════════

   `last_webhook_at` used to be computed only for the platform-admin tenants
   list, which meant the one person who actually runs the account could not see
   the product's defining failure: a webhook subscription that has silently
   stopped delivering looks exactly like a quiet day. CLAUDE.md calls it the
   invisible failure — "a comment that matches no campaign writes no row at
   all, so silence is not proof of a delivery failure".

   `GET /api/health/tenant` answers for the ACTING tenant and is open to any
   authenticated user, so this strip renders for a non-admin. It is mounted by
   App.navigate into #page-prelude, above the page's own content, which keeps
   it entirely independent of the page module below it.
   ═══════════════════════════════════════════════════════════════════════════ */
const HealthStrip = {
    /** Pages that get the strip. */
    PAGES: ['settings'],

    _seq: 0,

    host() {
        return document.getElementById('page-prelude');
    },

    hide() {
        // Bump the sequence too: a `load()` started on the previous page must
        // not paint into a host we have just taken away.
        HealthStrip._seq += 1;
        const host = HealthStrip.host();
        if (!host) return;
        host.classList.add('hidden');
        host.innerHTML = '';
    },

    /** Called on every navigation. Shows the strip only where it belongs. */
    mountFor(page) {
        if (HealthStrip.PAGES.indexOf(page) === -1) {
            HealthStrip.hide();
            return Promise.resolve();
        }
        return HealthStrip.load();
    },

    async load() {
        const host = HealthStrip.host();
        if (!host) return;

        const seq = ++HealthStrip._seq;
        host.classList.remove('hidden');
        host.innerHTML = esc(html`
            <section class="health-strip surface" aria-busy="true">
                <h2 class="health-strip-title">${t('health.title')}</h2>
                <div class="health-strip-grid" aria-hidden="true">
                    ${[0, 1, 2, 3].map(() => html`
                        <div class="health-tile"><span>${Motion.line('sm')}</span><span>${Motion.line('md')}</span></div>
                    `)}
                </div>
                ${Motion.busy(t('health.loading'))}
            </section>
        `);
        UI.icons(host);

        let data;
        try {
            data = await API.getTenantHealth();
        } catch (err) {
            if (seq !== HealthStrip._seq) return;
            // Not deployed yet, or not permitted: the strip simply is not there.
            // Anything else is a real failure and says so, with a retry.
            if (err && (err.status === 404 || err.status === 403 || err.status === 501)) {
                HealthStrip.hide();
                return;
            }
            host.innerHTML = esc(html`
                <section class="health-strip surface">
                    <h2 class="health-strip-title">${t('health.title')}</h2>
                    ${UI.errorStrip(t('health.failed', { message: (err && err.message) || t('error.unexpected') }), t('health.failedHint'))}
                    <button type="button" class="btn btn-secondary btn-sm" data-action="health:reload">
                        <i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('common.retry')}
                    </button>
                </section>
            `);
            UI.icons(host);
            return;
        }

        if (seq !== HealthStrip._seq) return;
        HealthStrip.paint(host, data || {});
    },

    paint(host, data) {
        const webhookAt = Admin.pick(data, 'lastWebhookAt', 'last_webhook_at');
        const commentAt = Admin.pick(data, 'lastCommentAt', 'last_comment_at');
        const dmAt = Admin.pick(data, 'lastInboundDmAt', 'last_inbound_dm_at');
        const tokenStatus = Admin.pick(data, 'tokenStatus', 'token_status');
        const tokenCheckedAt = Admin.pick(data, 'tokenLastCheckedAt', 'token_last_checked_at');
        const tokenErr = Admin.pick(data, 'tokenError', 'token_error');
        const expiresAt = Admin.pick(data, 'tokenExpiresAt', 'token_expires_at');
        const dataAccessAt = Admin.pick(data, 'dataAccessExpiresAt', 'data_access_expires_at');
        const dmUsed = Admin.num(data, 'dmThisHour', 'dm_this_hour');
        const dmCeiling = Admin.num(data, 'dmCeiling', 'dm_ceiling');
        const queue = Admin.pick(data, 'queue') || {};
        const queueFailed = Admin.num(queue, 'failed');
        const queuePending = Admin.num(queue, 'pending');
        const postsPending = Admin.num(data, 'postsPending', 'posts_pending');
        const postsFailed = Admin.num(data, 'postsFailed7d', 'posts_failed_7d');

        const webhookAge = UI.relativeAge(webhookAt, Admin.WEBHOOK_AGE);
        const alarm = webhookAge.level === 'stale' || Admin.tokenState(tokenStatus) === 'invalid';

        host.innerHTML = esc(html`
            <section class="health-strip surface ${alarm ? html.raw('health-strip-alarm') : ''}">
                <div class="health-strip-head">
                    <h2 class="health-strip-title">${t('health.title')}</h2>
                    <button type="button" class="btn btn-secondary btn-sm" data-action="health:recheck">
                        <i data-lucide="refresh-cw" aria-hidden="true"></i> ${t('health.recheck')}
                    </button>
                </div>

                ${alarm ? html`
                    <p class="health-strip-lede" role="alert" dir="auto">${
                        webhookAge.level === 'stale' ? t('health.silentLede', { age: webhookAge.text }) : t('health.tokenLede')
                    }</p>
                ` : ''}

                <div class="health-strip-grid">
                    <div class="health-tile">
                        <span class="health-tile-label">${t('health.lastWebhook')}</span>
                        ${Admin.agePill(webhookAt, Admin.WEBHOOK_AGE)}
                        <span class="health-tile-note">${t('health.lastWebhookNote')}</span>
                    </div>

                    <div class="health-tile">
                        <span class="health-tile-label">${t('health.token')}</span>
                        ${Admin.tokenPill(tokenStatus)}
                        <span class="health-tile-note">${
                            tokenCheckedAt
                                ? t('health.checked', { age: UI.relativeAge(tokenCheckedAt, Admin.CHECK_AGE).text })
                                : t('health.neverChecked')
                        }</span>
                    </div>

                    <div class="health-tile">
                        <span class="health-tile-label">${t('health.lastComment')}</span>
                        ${Admin.agePill(commentAt, Admin.WEBHOOK_AGE)}
                        <span class="health-tile-note">${t('health.lastCommentNote')}</span>
                    </div>

                    <div class="health-tile">
                        <span class="health-tile-label">${t('health.lastDm')}</span>
                        ${Admin.agePill(dmAt, Admin.WEBHOOK_AGE)}
                        <span class="health-tile-note">${t('health.lastDmNote')}</span>
                    </div>
                </div>

                ${tokenErr ? Admin.tokenError(t('health.tokenReason', { message: tokenErr })) : ''}

                <dl class="health-strip-facts">
                    ${Admin.field(t('health.dmHeadroom'), Admin.meter(dmUsed, dmCeiling,
                        t('tenants.dmMeter', {
                            used: UI.formatNumber(dmUsed || 0),
                            ceiling: dmCeiling === null ? '—' : UI.formatNumber(dmCeiling),
                        })))}
                    ${Admin.field(t('health.queue'), html`${
                        queuePending === null && queueFailed === null
                            ? html`<span class="text-meta">—</span>`
                            : html`<span>${t('health.queueValue', {
                                pending: queuePending === null ? '—' : UI.formatNumber(queuePending),
                            })}</span> ${queueFailed ? html`<span class="count-bad">${
                                t('ops.queueFailed', { count: UI.formatNumber(queueFailed) })
                            }</span>` : ''}`
                    }`)}
                    ${Admin.field(t('health.posts'), html`${
                        postsPending === null && postsFailed === null
                            ? html`<span class="text-meta">—</span>`
                            : html`<span>${t('health.postsValue', {
                                pending: postsPending === null ? '—' : UI.formatNumber(postsPending),
                            })}</span> ${postsFailed ? html`<span class="count-bad">${
                                t('tenants.postsFailed', { count: UI.formatNumber(postsFailed) })
                            }</span>` : ''}`
                    }`)}
                    ${expiresAt ? Admin.field(t('health.expires'), UI.formatDay(expiresAt)) : ''}
                    ${dataAccessAt ? Admin.field(t('health.dataAccess'), UI.formatDay(dataAccessAt)) : ''}
                </dl>
            </section>
        `);
        UI.icons(host);
        Admin.applyMeters(host);
    },

    /**
     * Ask Meta now. The point of the button is that a token status can be
     * weeks old: a green pill checked eleven days ago is not evidence.
     */
    async recheck(btn) {
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = UI.buttonSpinner(t('health.rechecking'));
        try {
            await API.recheckToken();
            UI.toast(t('health.rechecked'));
            await HealthStrip.load();
        } catch (err) {
            btn.disabled = false;
            btn.innerHTML = original;
            UI.icons(btn);
            UI.toast((err && err.message) || t('health.recheckFailed'), 'error');
        }
    },
};

UI.registerActions('health', {
    reload: () => Admin.report(HealthStrip.load()),
    recheck: (el) => Admin.report(HealthStrip.recheck(el)),
});
