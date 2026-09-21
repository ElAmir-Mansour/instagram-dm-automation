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
 * Everything rendered from the preview — the handle, the sample rows, the
 * table names — is attacker-controlled: the handle is a profile name the
 * subject chooses and the sample is their own message text. It all goes
 * through the escaping `html` tag as text.
 */
const ErasurePage = {
    /** The handle that was previewed, and the preview itself. */
    handle: '',
    preview: null,

    /** Short-lived, single-use, and deliberately not in the document. */
    _token: null,

    /** The outcome of the last erase, so the screen can report it. */
    result: null,

    resetTenantState() {
        this.handle = '';
        this.preview = null;
        this._token = null;
        this.result = null;
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

    async loadPreview(handle) {
        const host = this.resultHost();
        if (!host) return;

        this.handle = handle;
        this.result = null;
        this._token = null;
        this.preview = null;

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

    sample() {
        const raw = Admin.pick(this.preview, 'sample', 'samples', 'examples');
        return Array.isArray(raw) ? raw.slice(0, 10) : [];
    },

    paintPreview() {
        const host = this.resultHost();
        if (!host) return;

        const counts = this.counts();
        const total = this.total(counts);
        const sample = this.sample();
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
            return;
        }

        host.innerHTML = esc(html`
            <section class="section">
                <h2 class="section-title">${t('erasure.previewTitle', { handle })}</h2>

                <div class="warning-card" role="alert">
                    <div class="row row--start gap-4">
                        <span class="stat-icon danger shrink-0"><i data-lucide="alert-octagon" aria-hidden="true"></i></span>
                        <div>
                            <h3 class="warning-card-title">${t('erasure.warnTitle', { count: total })}</h3>
                            <p>${t('erasure.warnBody')}</p>
                        </div>
                    </div>
                </div>

                <div class="surface pad-5">
                    <h3 class="erasure-subtitle">${t('erasure.countsTitle')}</h3>
                    <div class="table-wrapper">
                        <table class="data-table">
                            <thead><tr>
                                <th scope="col">${t('erasure.table.table')}</th>
                                <th scope="col" class="cell-num">${t('erasure.table.rows')}</th>
                            </tr></thead>
                            <tbody>
                                ${counts.map((row) => html`
                                    <tr>
                                        <td><code>${UI.ltr(row.table)}</code></td>
                                        <td class="cell-num">${Admin.count(row.count)}</td>
                                    </tr>
                                `)}
                                <tr>
                                    <td class="text-strong">${t('erasure.table.total')}</td>
                                    <td class="cell-num text-strong">${UI.num(total)}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    ${sample.length > 0 ? html`
                        <h3 class="erasure-subtitle mbs-4">${t('erasure.sampleTitle')}</h3>
                        <ul class="erasure-sample">
                            ${sample.map((row) => html`
                                <li dir="auto">${
                                    typeof row === 'string'
                                        ? row
                                        : (Admin.pick(row, 'text', 'message_text', 'comment_text', 'preview', 'body')
                                            || JSON.stringify(row))
                                }</li>
                            `)}
                        </ul>
                        <p class="form-hint">${t('erasure.sampleHint')}</p>
                    ` : ''}

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
    },

    cancelPreview() {
        this.preview = null;
        this._token = null;
        this.result = null;
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

        try {
            const result = await API.executeErasure(token);
            this.result = result || {};
            this.preview = null;
            UI.toast(t('erasure.done', { handle: this.handle }));
            this.paintResult();
        } catch (err) {
            const expired = err && (err.status === 400 || err.status === 404 || err.status === 410 || err.status === 422);
            this.preview = null;
            if (host) {
                UI.renderError(host, {
                    title: t('erasure.eraseFailed'),
                    message: (err && err.message) || t('error.unexpected'),
                    hint: expired ? t('erasure.expiredHint') : t('erasure.eraseFailedHint'),
                }, () => this.loadPreview(this.handle));
            }
        }
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
        return this.render();
    },
};

UI.registerActions('erasure', {
    handlePreview: (el, e) => Admin.report(ErasurePage.handlePreview(el, e)),
    confirmErase: () => ErasurePage.confirmErase(),
    cancelPreview: () => ErasurePage.cancelPreview(),
    reset: () => Admin.report(ErasurePage.reset()),
});
