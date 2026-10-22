/**
 * Data-subject erasure — platform-admin only.
 *
 * This is the only hard delete in the product. Everything else either sets a
 * flag or removes one row the operator is looking at; this removes a person
 * from every table at once and cannot be undone by anything in this UI.
 *
 * Three properties make that safe, and all three are load-bearing:
 *
 *  1. PREVIEW IS MANDATORY, structurally. The erase call takes nothing but the
 *     short-lived `token` the preview returns, so there is no request this
 *     screen could send that skips being shown the counts first.
 *  2. The token lives in a JS variable, never in the DOM. No id, no data
 *     attribute, no hidden input — nothing a stray click or an injected
 *     fragment could reach.
 *  3. Confirming requires TYPING THE HANDLE. A styled `btn-danger` behind a
 *     typed echo cannot be hit by accident, by a mistargeted Enter, or by
 *     tabbing into the wrong button. `window.confirm()` is never used here:
 *     it cannot be styled as dangerous and cannot be gated at all.
 *
 * Everything rendered from the preview — the handle, the matched usernames and
 * IDs, the workspace names — is attacker-controlled: the handle is a profile
 * name the subject chooses. It all goes through the escaping `html` tag as text.
 *
 * What the preview shows is WHO matched, never what they wrote (ER-01, ER-02):
 * the matched usernames and Instagram IDs, a few of the conversations (workspace,
 * username, last message date), every workspace that holds rows and how many
 * (matching is cross-tenant: one erasure removes the person from every client's
 * inbox), and the rows, oldest and newest date per data type. The server's
 * `sample` is an OBJECT of metadata (`{ conversations, messages, interactions }`),
 * and only its conversations are drawn; no message text is read from anywhere,
 * so none can reach the page.
 *
 * What a failure says is what happened (ER-03). The erasure is one transaction:
 * it deleted everything or nothing. A stale preview (new data arrived: the counts
 * drifted) is re-previewed automatically, with a line that says so; an expired or
 * invalid preview offers "Preview again"; any other refusal says nothing was
 * deleted. The one case that cannot say so is NO ANSWER (a dropped connection or
 * a gateway error after the request went out): the request may have run, so the
 * screen says it is not certain, and a fresh preview settles it, because a
 * finished erasure leaves nothing to match.
 */
const ErasurePage = {
    /** The handle that was previewed, and the preview itself. */
    handle: '',
    preview: null,

    /** Short-lived, single-use, and deliberately not in the document. */
    _token: null,

    /** The outcome of the last erase, so the screen can report it. */
    result: null,

    /**
     * What to say above a preview that replaced one the server found stale: `{ sentence, change }`, or null. Set only by the
     * automatic re-preview after ERASURE_COUNTS_DRIFTED; any preview the person asks for starts clean.
     */
    notice: null,

    /** The data types, in the order a person reads them: who, what was said, what was commented, what was sent. */
    TYPES: ['conversations', 'messages', 'interactions', 'dmSendLog', 'leads'],

    /** Identifiers listed before "and N more", and conversations shown (the server sends the newest five). */
    LIST_MAX: 12,
    SAMPLE_MAX: 5,

    resetTenantState() {
        this.handle = '';
        this.preview = null;
        this._token = null;
        this.result = null;
        this.notice = null;
    },

    skeleton() {
        return html`
            ${Motion.cardGrid(1, 4)}
            ${Motion.busy()}
        `;
    },

    render() {
        const container = document.getElementById('page-container');
        container.innerHTML = esc(html`
            <section class="section">
                <h2 class="section-title">${t('erasure.searchTitle')}</h2>
                <div class="surface pad-5">
                    <p class="modal-body-text mbe-4">${t('erasure.intro')}</p>
                    <form id="erasure-form" data-submit="erasure:handlePreview">
                        <div class="form-group">
                            <label class="form-label" for="erasure-handle">${t('erasure.handleLabel')}</label>
                            <div class="field-row">
                                <input class="field" id="erasure-handle" name="handle" type="text" dir="ltr"
                                       autocomplete="off" spellcheck="false" placeholder="username"
                                       value="${this.handle}" required aria-describedby="erasure-handle-hint">
                                <button type="submit" class="btn btn-primary">
                                    <i data-lucide="search" aria-hidden="true"></i> ${t('erasure.preview')}
                                </button>
                            </div>
                            <p class="form-hint" id="erasure-handle-hint">${t('erasure.handleHint')}</p>
                        </div>
                    </form>
                </div>
            </section>

            <div id="erasure-result"></div>
        `);

        UI.icons(container);

        // A finished erase or a live preview survives a re-render of the form.
        if (this.result) this.paintResult();
        else if (this.preview) this.paintPreview();
        return Promise.resolve();
    },

    resultHost() {
        return document.getElementById('erasure-result');
    },

    // ─── Preview ─────────────────────────────────────────────────────────────

    handlePreview(form, event) {
        event.preventDefault();
        const handle = (new FormData(form).get('handle') || '').toString().trim().replace(/^@/, '');
        if (!handle) return Promise.resolve();
        return this.loadPreview(handle);
    },

    async loadPreview(handle, notice) {
        const host = this.resultHost();
        if (!host) return;

        this.handle = handle;
        this.result = null;
        this._token = null;
        this.preview = null;
        this.notice = notice || null;

        host.innerHTML = esc(html`
            <section class="section">
                <div class="surface pad-5">
                    ${html.raw(UI.loader(t('erasure.previewing')))}
                </div>
            </section>
        `);

        let preview;
        try {
            preview = await API.previewErasure(handle);
        } catch (err) {
            if (Admin.isUnavailable(err)) {
                Admin.renderUnavailable(document.getElementById('page-container'), t('erasure.unavailableTitle'));
                return;
            }
            this.notice = null;
            UI.renderError(host, {
                title: t('erasure.previewFailed'),
                message: (err && err.message) || t('error.unexpected'),
                hint: t('erasure.previewFailedHint'),
            }, () => this.loadPreview(handle));
            return;
        }

        this.preview = preview || {};
        this._token = Admin.pick(this.preview, 'token') || null;
        this.paintPreview();
    },

    /** `{ table: count }`, or `[{ table, count }]` — both happen. */
    counts() {
        const raw = Admin.pick(this.preview, 'counts', 'tables', 'rows');
        if (Array.isArray(raw)) {
            return raw.map((r) => ({
                table: Admin.pick(r, 'table', 'name', 'relation') || '—',
                count: Admin.num(r, 'count', 'rows', 'n'),
            }));
        }
        if (raw && typeof raw === 'object') {
            return Object.keys(raw).map((key) => ({ table: key, count: Admin.num(raw, key) }));
        }
        return [];
    },

    total(counts) {
        return counts.reduce((sum, row) => sum + (row.count || 0), 0);
    },

    /** A data type's name in the interface language; the raw key for one this dashboard does not know. */
    typeLabel(key) {
        const name = `erasure.type.${key}`;
        const said = t(name);
        return said === name ? key : said;
    },

    /** A date, no clock, in the acting tenant's zone (the page says which); '—' for none. */
    day(value) {
        return (value && UI.zoneFormat(value, { year: 'numeric', month: 'short', day: 'numeric' })) || '—';
    },

    /**
     * One row per data type: the count, and the oldest and newest date over everything that matched (`ranges`, from the server's
     * MIN and MAX; the sample cannot say when the oldest row is). A type with no rows has no dates.
     */
    dataRows() {
        const ranges = Admin.pick(this.preview, 'ranges');
        const order = (key) => {
            const at = this.TYPES.indexOf(key);
            return at === -1 ? this.TYPES.length : at;
        };
        return this.counts()
            .map((row, at) => ({ row, at }))
            .sort((a, b) => order(a.row.table) - order(b.row.table) || a.at - b.at)
            .map(({ row }) => {
                const range = ranges && typeof ranges === 'object' ? ranges[row.table] : null;
                const has = (row.count || 0) > 0 && range && typeof range === 'object';
                return {
                    key: row.table,
                    label: this.typeLabel(row.table),
                    count: row.count,
                    first: has ? range.first || null : null,
                    last: has ? range.last || null : null,
                };
            });
    },

    /**
     * The usernames and Instagram IDs the server resolved the handle to: who the delete will match on. The server also puts the handle
     * AS TYPED in both lists (it is the query, so the delete covers it either way); that echo is not a match, and "sara" under
     * "Instagram IDs" reads as one. It stays in the list it belongs to (all digits is an ID, anything else a username) and is dropped
     * from the other.
     */
    matched() {
        const raw = Admin.pick(this.preview, 'matched');
        const list = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x !== '') : []);
        const typed = String(this.handle || '').trim().toLowerCase();
        const isId = /^\d+$/.test(typed);
        const notEcho = (value) => value.toLowerCase() !== typed;
        const usernames = list(raw && raw.usernames);
        const ids = list(raw && Admin.pick(raw, 'instagramUserIds', 'instagram_user_ids'));
        return {
            usernames: isId ? usernames.filter(notEcho) : usernames,
            ids: isId ? ids : ids.filter(notEcho),
        };
    },

    /** Every workspace that holds rows for the person, with how many: `byTenant` (matching is cross-tenant). */
    workspaces() {
        const raw = Admin.pick(this.preview, 'byTenant', 'by_tenant');
        if (!Array.isArray(raw)) return [];
        return raw.map((r) => ({
            name: String(Admin.pick(r, 'name') || ''),
            rows: Admin.num(r, 'rows', 'count'),
        }));
    },

    /**
     * The conversations the server sampled, as who / where / when. `sample` is an object `{ conversations, messages, interactions }`
     * of metadata; only the conversations are drawn, and only these three fields of each, so nothing a person wrote is read.
     */
    conversationSample() {
        const raw = Admin.pick(this.preview, 'sample');
        const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.conversations : null;
        if (!Array.isArray(list)) return [];
        return list.slice(0, this.SAMPLE_MAX).map((c) => {
            const username = Admin.pick(c, 'username');
            return {
                who: String(username ? `@${username}` : (Admin.pick(c, 'instagramUserId', 'instagram_user_id') || '')),
                workspace: String(Admin.pick(c, 'creatorName', 'creator_name') || ''),
                last: Admin.pick(c, 'lastMessageAt', 'last_message_at') || null,
            };
        });
    },

    /** A handful of identifiers as chips, then "and N more"; a dash when there are none. Each is Latin text inside whatever the page's direction is. */
    chips(values) {
        if (values.length === 0) return html`<span class="text-meta">—</span>`;
        const shown = values.slice(0, this.LIST_MAX);
        const rest = values.length - shown.length;
        return html`<span class="row row--wrap gap-2">${shown.map((v) => html`<span class="chip">${UI.ltr(v)}</span>`)}${
            rest > 0 ? html`<span class="text-meta">${t('erasure.matched.more', { count: rest })}</span>` : ''
        }</span>`;
    },

    /** "Who matched": the identifiers, a few conversations, and every workspace the erasure will reach. */
    matchedBlock(counts) {
        const matched = this.matched();
        const workspaces = this.workspaces();
        const conversations = this.conversationSample();
        const conversationCount = (counts.find((c) => c.table === 'conversations') || {}).count || 0;

        return html`
            <div class="surface pad-5 mbe-4">
                <h3 class="erasure-subtitle">${t('erasure.matchedTitle')}</h3>
                <p class="form-hint">${t('erasure.matchedBody')}</p>
                <dl class="ops-facts">
                    ${Admin.field(t('erasure.matched.handles'), this.chips(matched.usernames.map((u) => `@${u}`)))}
                    ${Admin.field(t('erasure.matched.ids'), this.chips(matched.ids))}
                </dl>

                ${conversations.length > 0 ? html`
                    <h3 class="erasure-subtitle mbs-4">${t('erasure.conversationsTitle')}</h3>
                    <ul class="erasure-sample">
                        ${conversations.map((c) => html`
                            <li>${UI.ltr(c.who)}${
                                c.workspace ? html` <span class="text-meta" dir="auto">· ${c.workspace}</span>` : ''
                            }${
                                c.last ? html` <span class="text-meta">· ${t('erasure.conversationLast', { date: this.day(c.last) })}</span>` : ''
                            }</li>
                        `)}
                    </ul>
                    ${conversationCount > conversations.length ? html`
                        <p class="form-hint">${t('erasure.conversationsShown', { shown: conversations.length, total: conversationCount })}</p>
                    ` : ''}
                ` : ''}

                ${workspaces.length > 0 ? html`
                    <h3 class="erasure-subtitle mbs-4">${t('erasure.workspacesTitle')}</h3>
                    <ul class="erasure-sample">
                        ${workspaces.map((w) => html`
                            <li><strong class="text-strong" dir="auto">${w.name || t('erasure.workspaceUnknown')}</strong> <span class="text-meta">· ${
                                w.rows === null ? '—' : t('erasure.workspaceRows', { count: w.rows })
                            }</span></li>
                        `)}
                    </ul>
                    <p class="form-hint">${t('erasure.workspacesScope')}</p>
                ` : ''}
            </div>
        `;
    },

    /** A line above a preview that replaced a stale one: what the server said, what changed, and that this is the new one. */
    noticeBlock() {
        const n = this.notice;
        if (!n) return '';
        return html`
            <div class="warning-card" role="status">
                <div class="row row--start gap-4">
                    <span class="stat-icon warning shrink-0"><i data-lucide="alert-triangle" aria-hidden="true"></i></span>
                    <div>
                        <h3 class="warning-card-title" dir="auto">${n.sentence}</h3>
                        <p dir="auto">${n.change ? `${n.change} ` : ''}${t('erasure.driftReview')}</p>
                    </div>
                </div>
            </div>
        `;
    },

    paintPreview() {
        const host = this.resultHost();
        if (!host) return;

        const counts = this.counts();
        const total = this.total(counts);
        const rows = this.dataRows();
        const handle = this.handle;
        const hasToken = !!this._token;

        if (counts.length === 0 || total === 0) {
            host.innerHTML = esc(html`
                <section class="section">
                    <div class="surface pad-5">
                        ${Admin.emptyState('user-x', t('erasure.noneTitle'), t('erasure.noneBody', { handle }))}
                    </div>
                </section>
            `);
            UI.icons(host);
            Motion.announce(t('erasure.noneTitle'));
            return;
        }

        host.innerHTML = esc(html`
            <section class="section">
                <h2 class="section-title">${t('erasure.previewTitle', { handle })}</h2>

                ${this.noticeBlock()}

                <div class="warning-card" role="alert">
                    <div class="row row--start gap-4">
                        <span class="stat-icon danger shrink-0"><i data-lucide="alert-octagon" aria-hidden="true"></i></span>
                        <div>
                            <h3 class="warning-card-title">${t('erasure.warnTitle', { count: total })}</h3>
                            <p>${t('erasure.warnBody')}</p>
                        </div>
                    </div>
                </div>

                ${this.matchedBlock(counts)}

                <div class="surface pad-5">
                    <h3 class="erasure-subtitle">${t('erasure.countsTitle')}</h3>
                    <div class="table-wrapper">
                        <table class="data-table">
                            <thead><tr>
                                <th scope="col">${t('erasure.table.type')}</th>
                                <th scope="col" class="cell-num">${t('erasure.table.rows')}</th>
                                <th scope="col">${t('erasure.table.first')}</th>
                                <th scope="col">${t('erasure.table.last')}</th>
                            </tr></thead>
                            <tbody>
                                ${rows.map((row) => html`
                                    <tr data-type="${row.key}">
                                        <td>${row.label}</td>
                                        <td class="cell-num">${Admin.count(row.count)}</td>
                                        <td class="nowrap">${this.day(row.first)}</td>
                                        <td class="nowrap">${this.day(row.last)}</td>
                                    </tr>
                                `)}
                                <tr>
                                    <td class="text-strong">${t('erasure.table.total')}</td>
                                    <td class="cell-num text-strong">${UI.num(total)}</td>
                                    <td></td>
                                    <td></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <p class="form-hint">${t('erasure.datesHint', { city: UI.zoneCity() })}</p>

                    <div class="form-actions">
                        <button type="button" class="btn btn-danger" data-action="erasure:confirmErase"
                                ${hasToken ? '' : html.raw('disabled')}>
                            <i data-lucide="trash-2" aria-hidden="true"></i> ${t('erasure.eraseCta')}
                        </button>
                        <button type="button" class="btn btn-ghost" data-action="erasure:cancelPreview">
                            ${t('common.cancel')}
                        </button>
                    </div>
                    ${hasToken ? html`
                        <p class="form-hint">${t('erasure.tokenHint')}</p>
                    ` : html`
                        <p class="form-hint text-warning">${t('erasure.noTokenHint')}</p>
                    `}
                </div>
            </section>
        `);

        UI.icons(host);
        // The row-count table just replaced the loader silently — this is the
        // count the operator is about to permanently delete, so it is worth
        // announcing on its own, not just leaving it to be read visually. After a
        // stale preview was replaced, what happened comes first.
        const warn = t('erasure.warnTitle', { count: total });
        Motion.announce(this.notice ? `${this.notice.sentence} ${warn}` : warn);
    },

    cancelPreview() {
        this.preview = null;
        this._token = null;
        this.result = null;
        this.notice = null;
        const host = this.resultHost();
        if (host) host.innerHTML = '';
        const field = document.getElementById('erasure-handle');
        if (field && typeof field.focus === 'function') field.focus();
    },

    // ─── Erase ───────────────────────────────────────────────────────────────

    /**
     * The gate. `requireText` is the handle, so confirming is an act of
     * typing — there is no arrangement of stray clicks or keypresses that
     * reaches the request.
     */
    confirmErase() {
        if (!this._token) {
            UI.toast(t('erasure.noToken'), 'error');
            return;
        }
        const counts = this.counts();
        Admin.confirm({
            title: t('erasure.confirmTitle'),
            body: t('erasure.confirmBody', { handle: this.handle, count: this.total(counts) }),
            hint: t('erasure.confirmHint'),
            confirmLabel: t('erasure.confirmCta'),
            confirmIcon: 'trash-2',
            requireText: this.handle,
            requireHint: t('erasure.confirmEcho'),
            onConfirm: () => this.erase(),
        });
    },

    async erase() {
        const token = this._token;
        if (!token) {
            UI.toast(t('erasure.noToken'), 'error');
            return;
        }
        // One use, whatever happens next.
        this._token = null;

        const host = this.resultHost();
        if (host) {
            host.innerHTML = esc(html`
                <section class="section">
                    <div class="surface pad-5">${html.raw(UI.loader(t('erasure.erasing')))}</div>
                </section>
            `);
        }

        // Only the REQUEST is inside the try. A failure to draw the result afterwards must never be read as a failed erasure: it
        // would tell the person nothing was deleted when everything was.
        let result;
        try {
            result = await API.executeErasure(token);
        } catch (err) {
            this.preview = null;
            await this.failed(err);
            return;
        }
        this.result = result || {};
        this.preview = null;
        this.notice = null;
        UI.toast(t('erasure.done', { handle: this.handle }));
        this.paintResult();
    },

    // ─── When the erase does not go through (ER-03) ─────────────────────────

    /**
     * What kind of failure this was, because each says something different and only one is ever "I do not know":
     *   drifted  new data arrived since the preview (409): nothing was deleted, and the counts the person confirmed are stale.
     *   expired  the preview's token is older than 10 minutes, or is not one of ours (400): nothing was deleted.
     *   unknown  no answer from our handler (a dropped connection, a gateway error, or an answer that could not be read after a
     *            2xx): the request may have run.
     *   refused  everything else the server answered: it rolled the transaction back, so nothing was deleted.
     */
    failureKind(err) {
        const code = err && typeof err.code === 'string' ? err.code : '';
        const status = err && err.status;
        if (code === 'ERASURE_COUNTS_DRIFTED' || (!code && status === 409)) return 'drifted';
        if (code === 'ERASURE_PREVIEW_EXPIRED' || code === 'ERASURE_TOKEN_INVALID'
            || (!code && (status === 400 || status === 410 || status === 422))) return 'expired';
        if (!err || err.isNetworkError || (status >= 200 && status < 300) || status === 502 || status === 503 || status === 504) return 'unknown';
        return 'refused';
    },

    /** `err` when its code has a sentence in the catalogue; otherwise a stand-in with `fallbackCode`, so the sentence is never the server's English. */
    asCoded(err, fallbackCode) {
        const code = err && typeof err.code === 'string' ? err.code : '';
        if (code && t(`errors.${code}`) !== `errors.${code}`) return err;
        return { code: fallbackCode, status: err && err.status, message: err && err.message };
    },

    /** The total of a counts object the server sent back (`expected` / `actual`), or null when it did not send one. */
    countsTotalOf(counts) {
        if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
        const keys = Object.keys(counts);
        if (keys.length === 0) return null;
        return keys.reduce((sum, key) => sum + (Number(counts[key]) || 0), 0);
    },

    async failed(err) {
        const kind = this.failureKind(err);
        if (kind === 'drifted') {
            // Nothing was deleted and the numbers the person confirmed are out of date: show the new ones, with a line that says so.
            // One GET, then the person decides again; there is no loop, and the new token still needs the handle typed.
            const info = UI.errorText(this.asCoded(err, 'ERASURE_COUNTS_DRIFTED'));
            const before = this.countsTotalOf(err && err.body && err.body.expected);
            const after = this.countsTotalOf(err && err.body && err.body.actual);
            const isolate = (n) => `\u2066${UI.formatNumber(n)}\u2069`;
            const change = before !== null && after !== null && before !== after
                ? t('erasure.driftChange', { before: isolate(before), after: isolate(after) })
                : '';
            return this.loadPreview(this.handle, { sentence: info.sentence, change });
        }
        this.paintFailure(kind, err);
        return undefined;
    },

    /** The sentence, its next step, and the server's own words behind "Details". Escaped as text, `dir="auto"`. */
    failureBody(sentence, next, details) {
        return html`
            <div class="error-panel-message error-text">
                <strong class="error-sentence" dir="auto">${sentence}</strong>
                ${next ? html`<span class="error-next" dir="auto">${next}</span>` : ''}
                ${details ? html`<details class="error-details">
                    <summary>${t('error.details')}</summary>
                    <p class="error-details-text" dir="auto">${details}</p>
                </details>` : ''}
            </div>
        `;
    },

    paintFailure(kind, err) {
        const host = this.resultHost();
        if (!host) return;

        const raw = err && typeof err.message === 'string' ? err.message.trim() : '';
        const tag = err && typeof err.code === 'string' && err.code
            ? (err.status ? `${err.code} (HTTP ${err.status})` : err.code)
            : (err && err.status ? `HTTP ${err.status}` : '');
        let title;
        let sentence;
        let next = '';
        let details = [raw, tag].filter(Boolean).join('\n');

        if (kind === 'expired') {
            // "The preview expired. Preview again." — for an expired token and for one that does not verify alike: the cure is the same.
            const info = UI.errorText(this.asCoded(err, 'ERASURE_PREVIEW_EXPIRED'));
            title = t('erasure.expiredTitle');
            sentence = info.sentence;
            next = info.next;
            details = info.details;
        } else if (kind === 'unknown') {
            title = t('erasure.unknownTitle');
            sentence = t('erasure.unknownBody');
        } else {
            // The server answered and rolled back. A coded refusal says its own sentence (the audit log could not be written);
            // anything else says the one thing that is always true of it.
            title = t('erasure.eraseFailed');
            const coded = err && typeof err.code === 'string' && err.code && t(`errors.${err.code}`) !== `errors.${err.code}`;
            if (coded) {
                const info = UI.errorText(err);
                sentence = info.sentence;
                next = info.next;
                details = info.details;
            } else {
                sentence = t('erasure.nothingDeleted');
            }
        }

        host.innerHTML = esc(html`
            <section class="section">
                <div class="error-panel surface" role="alert">
                    <div class="error-panel-icon"><i data-lucide="alert-circle" aria-hidden="true"></i></div>
                    <h3>${title}</h3>
                    ${this.failureBody(sentence, next, details)}
                    <button type="button" class="btn btn-secondary btn-sm" data-action="erasure:previewAgain">
                        <i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('erasure.previewAgain')}
                    </button>
                </div>
            </section>
        `);
        UI.icons(host);
        Motion.announce(`${title}. ${sentence}`);
    },

    /** "Preview again": the same handle, a fresh token. */
    previewAgain() {
        return this.loadPreview(this.handle);
    },

    paintResult() {
        const host = this.resultHost();
        if (!host) return;
        const result = this.result || {};
        const deleted = Admin.pick(result, 'deleted', 'counts', 'removed');
        const rows = Array.isArray(deleted)
            ? deleted.map((r) => ({ table: Admin.pick(r, 'table', 'name') || '—', count: Admin.num(r, 'count', 'rows') }))
            : (deleted && typeof deleted === 'object'
                ? Object.keys(deleted).map((key) => ({ table: key, count: Admin.num(deleted, key) }))
                : []);

        host.innerHTML = esc(html`
            <section class="section">
                <h2 class="section-title">${t('erasure.resultTitle')}</h2>
                <div class="surface pad-5">
                    <div class="row row--start gap-4 mbe-4">
                        <span class="stat-icon success shrink-0"><i data-lucide="check-circle" aria-hidden="true"></i></span>
                        <div>
                            <h3 class="erasure-subtitle">${t('erasure.resultHeading', { handle: this.handle })}</h3>
                            <p class="form-hint">${t('erasure.resultBody')}</p>
                        </div>
                    </div>

                    ${rows.length > 0 ? html`
                        <div class="table-wrapper">
                            <table class="data-table">
                                <thead><tr>
                                    <th scope="col">${t('erasure.table.table')}</th>
                                    <th scope="col" class="cell-num">${t('erasure.table.deleted')}</th>
                                </tr></thead>
                                <tbody>
                                    ${rows.map((row) => html`
                                        <tr><td><code>${UI.ltr(row.table)}</code></td><td class="cell-num">${Admin.count(row.count)}</td></tr>
                                    `)}
                                </tbody>
                            </table>
                        </div>
                    ` : html`<p class="form-hint">${t('erasure.resultNoDetail')}</p>`}

                    <div class="form-actions">
                        <button type="button" class="btn btn-secondary" data-action="erasure:reset">
                            <i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('erasure.another')}
                        </button>
                    </div>
                </div>
            </section>
        `);
        UI.icons(host);
    },

    reset() {
        this.handle = '';
        this.preview = null;
        this._token = null;
        this.result = null;
        this.notice = null;
        return this.render();
    },
};

UI.registerActions('erasure', {
    handlePreview: (el, e) => Admin.report(ErasurePage.handlePreview(el, e)),
    confirmErase: () => ErasurePage.confirmErase(),
    cancelPreview: () => ErasurePage.cancelPreview(),
    previewAgain: () => Admin.report(ErasurePage.previewAgain()),
    reset: () => Admin.report(ErasurePage.reset()),
});
