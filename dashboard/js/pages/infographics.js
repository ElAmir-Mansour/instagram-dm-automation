/**
 * Infographics — animated comparisons in the creator's personal brand (v31).
 *
 * The server's contract is src/services/studio/infographics.ts. A topic goes to the AI, which writes the
 * page and its caption in one answer (Claude on the Mac for the owner and studio.mac_brain_tenants, the AI
 * providers layer for every other workspace), so the strings say "the AI", never "Claude" (copyTruth.test.ts).
 * The Mac renders it as an MP4 (posted to Instagram, Facebook and YouTube by Schedule), a GIF (downloaded
 * here for LinkedIn, X and anywhere else) and a cover. This page is three parts:
 *
 *   New        the topic, the language and the theme (dark, light or both)
 *   List       each infographic: its GIF, what to fix, Download, Schedule, Edit, the other theme
 *   Brand      the name, site, handles, colours and portrait every page is drawn with
 *
 * ─── Nothing typed is lost to a poll ────────────────────────────────────────
 * While anything is being written or rendered, GET /studio/infographics every 5 s, only while
 * the tab is visible. A poll repaints the list alone: the New form and the Brand form are
 * painted once per visit and keep what was typed, and the editor is a modal the list never
 * touches.
 *
 * ─── The caption is about the GIF ───────────────────────────────────────────
 * The server refuses to schedule a caption that doesn't name every column the GIF shows. The
 * editor shows the same check live, column by column, so the refusal is never a surprise.
 */
const InfographicsPage = {
    POLL_MS: 5000,
    THEMES: ['dark', 'light'],
    LANGUAGES: ['ar', 'en'],
    SOCIALS: ['instagram', 'youtube', 'linkedin', 'x', 'tiktok', 'facebook', 'github'],
    PLATFORMS: ['instagram', 'facebook', 'youtube', 'tiktok'],
    /** The diagrams the template draws (infographicSpec.ts DIAGRAMS). */
    DIAGRAMS: ['docs', 'chunk-db', 'topk', 'augment', 'window', 'preload', 'kv', 'instant', 'graph', 'graph-build', 'hops', 'grounded', 'chat', 'loop', 'icon'],

    items: [],
    listError: null,
    worker: null,
    brand: null,
    settingsLoaded: false,
    editing: null,
    /** What "the next free slot" is, read when the Schedule dialog opens: `{ status: 'loading'|'ready'|'none'|'error', next, timezone }`. */
    slot: null,
    _slotSeq: 0,
    _seq: 0,
    _timer: null,
    _onVisible: null,
    _destroyed: false,

    // ─── Lifecycle ───────────────────────────────────────────────────────────
    destroy() {
        this._seq++;
        this._destroyed = true;
        this.stopPoll();
        if (this._onVisible) document.removeEventListener('visibilitychange', this._onVisible);
        this._onVisible = null;
    },

    resetTenantState() {
        this.destroy();
        this.items = [];
        this.listError = null;
        this.worker = null;
        this.brand = null;
        this.settingsLoaded = false;
        this.editing = null;
        this.slot = null;
        this._slotSeq++;
    },

    canUse() {
        return typeof App === 'undefined' || typeof App.canOperate !== 'function' || App.canOperate();
    },

    alive(seq) {
        if (seq !== this._seq || this._destroyed || !document.getElementById('page-container')) return false;
        return typeof App === 'undefined' || !App.currentPage || App.currentPage === 'infographics';
    },

    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        this.stopPoll();
        const seq = ++this._seq;
        this._destroyed = false;
        if (!this.canUse()) {
            container.innerHTML = esc(html`
                ${this.toolbarMarkup()}
                <div class="surface pad-5">${Admin.emptyState('lock', t('infographics.viewer.title'), t('infographics.viewer.body'))}</div>
            `);
            UI.icons(container);
            return;
        }
        const gate = Motion.beginLoad(container, () => html`${Motion.cardGrid(3, 2)}${Motion.busy()}`);
        const [list, settings, status] = await Promise.allSettled([API.getInfographics(), API.getStudioSettings(), API.getStudioStatus()]);
        if (!this.alive(seq)) return;
        gate.done();
        this.acceptList(list);
        if (settings.status === 'fulfilled') {
            const s = settings.value && settings.value.settings;
            this.brand = this.normalizeBrand(s && s.infographic);
            this.settingsLoaded = true;
            // Every time on this page is the tenant's: tell the shared zone what the settings carry (as the Monteur does).
            if (s && s.schedule && s.schedule.timezone) UI.setZone(s.schedule.timezone);
        }
        this.worker = status.status === 'fulfilled' && status.value && status.value.worker ? status.value.worker : null;
        container.innerHTML = esc(html`
            ${this.toolbarMarkup()}
            <div id="ig-worker">${this.workerMarkup()}</div>
            <section class="surface pad-5 ig-new" aria-labelledby="ig-new-title">${this.newFormMarkup()}</section>
            <section aria-labelledby="ig-list-title" class="ig-list-section">
                <h2 class="section-title" id="ig-list-title">${t('infographics.list.title')}</h2>
                <div id="ig-list">${this.listMarkup()}</div>
            </section>
            <details class="surface pad-5 ig-brand" id="ig-brand" ${this.brandMissing() ? html.raw('open') : ''}>
                <summary class="ig-brand-summary"><i data-lucide="settings" aria-hidden="true"></i> ${t('infographics.brand.title')}</summary>
                <div id="ig-brand-body">${this.brandFormMarkup()}</div>
            </details>
        `);
        UI.icons(container);
        this.bindVisibility(seq);
        this.schedulePoll(seq);
    },

    acceptList(result) {
        if (result.status === 'fulfilled') {
            const rows = result.value && Array.isArray(result.value.infographics) ? result.value.infographics : [];
            this.items = rows.filter((r) => r && typeof r.id === 'string');
            this.listError = null;
        } else {
            this.listError = result.reason || new Error(t('error.unexpected'));
        }
    },

    // ─── Polling ─────────────────────────────────────────────────────────────
    open(item) { return item.status === 'writing' || item.status === 'rendering'; },

    schedulePoll(seq) {
        this.stopPoll();
        if (!this.alive(seq) || !this.items.some((i) => this.open(i))) return;
        if (document.visibilityState === 'hidden') return; // resumed by the visibility listener
        this._timer = setTimeout(() => this.poll(seq), this.POLL_MS);
    },

    stopPoll() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
    },

    bindVisibility(seq) {
        if (this._onVisible) document.removeEventListener('visibilitychange', this._onVisible);
        this._onVisible = () => { if (document.visibilityState === 'visible') this.poll(seq); };
        document.addEventListener('visibilitychange', this._onVisible);
    },

    async poll(seq) {
        if (!this.alive(seq)) return;
        const [list, status] = await Promise.allSettled([API.getInfographics(), API.getStudioStatus()]);
        if (!this.alive(seq)) return;
        this.acceptList(list);
        if (status.status === 'fulfilled' && status.value && status.value.worker) this.worker = status.value.worker;
        this.paintList();
        this.schedulePoll(seq);
    },

    paintList() {
        const list = document.getElementById('ig-list');
        if (list) {
            list.innerHTML = esc(this.listMarkup());
            UI.icons(list);
        }
        const worker = document.getElementById('ig-worker');
        if (worker) {
            worker.innerHTML = esc(this.workerMarkup());
            UI.icons(worker);
        }
    },

    // ─── Markup: toolbar, worker, new ────────────────────────────────────────
    /** The Studio's tab bar with Infographics current; studio.js, monteur.js and explainers.js list the same links. */
    toolbarMarkup() {
        const tab = (key, href, icon, label) => html`
            <a class="btn btn-sm btn-ghost" href="${href}"
               ${key === 'infographics' ? html.raw('aria-current="page"') : ''}>
                <i data-lucide="${icon}" aria-hidden="true"></i> ${label}
            </a>
        `;
        return html`
            <div class="page-toolbar studio-toolbar">
                <nav class="segmented studio-seg studio-tabs" aria-label="${t('studio.tabs.label')}">
                    ${tab('home', '#/studio', 'layers', t('studio.tabs.carousels'))}
                    ${tab('monteur', '#/monteur', 'scissors', t('studio.tabs.monteur'))}
                    ${tab('infographics', '#/infographics', 'images', t('studio.tabs.infographics'))}
                    ${tab('explainers', '#/explainers', 'lightbulb', t('studio.tabs.explainers'))}
                    ${tab('settings', '#/studio?tab=settings', 'settings', t('studio.tabs.settings'))}
                </nav>
            </div>
        `;
    },

    /** Only when it matters: something is waiting and the Mac isn't there to do it. */
    workerMarkup() {
        const waiting = this.items.some((i) => this.open(i));
        if (!waiting || !this.worker || this.worker.online) return '';
        return html`<div class="ig-notice" role="status">
            <i data-lucide="wifi-off" aria-hidden="true"></i>
            <span>${t('infographics.worker.offline')}</span>
        </div>`;
    },

    newFormMarkup() {
        const b = this.brand || this.normalizeBrand(null);
        const option = (value, label, selected) => html`<option value="${value}" ${selected ? html.raw('selected') : ''}>${label}</option>`;
        return html`
            <h2 class="section-title" id="ig-new-title"><i data-lucide="sparkles" aria-hidden="true"></i> ${t('infographics.new.title')}</h2>
            <p class="form-hint">${t('infographics.new.hint')} ${UI.helpLink('infographics', t('help.link.infographics'))}</p>
            <form id="ig-new-form" data-submit="infographics:create" novalidate>
                <div class="form-group">
                    <label class="form-label" for="ig-topic">${t('infographics.new.topic')}</label>
                    <textarea class="field field-textarea" id="ig-topic" name="topic" rows="2" maxlength="300" dir="auto" required
                              placeholder="${t('infographics.new.topicPlaceholder')}"></textarea>
                </div>
                <details class="ig-more">
                    <summary>${t('infographics.new.more')}</summary>
                    <div class="form-group">
                        <label class="form-label" for="ig-notes">${t('infographics.new.notes')}</label>
                        <textarea class="field field-textarea" id="ig-notes" name="notes" rows="3" maxlength="2000" dir="auto"
                                  placeholder="${t('infographics.new.notesPlaceholder')}"></textarea>
                    </div>
                </details>
                <div class="ig-row">
                    <div class="form-group">
                        <label class="form-label" for="ig-language">${t('infographics.new.language')}</label>
                        <select class="select" id="ig-language" name="language">
                            ${option('ar', t('infographics.lang.ar'), b.language === 'ar')}
                            ${option('en', t('infographics.lang.en'), b.language === 'en')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="ig-theme">${t('infographics.new.theme')}</label>
                        <select class="select" id="ig-theme" name="theme">
                            ${option('both', t('infographics.theme.both'), true)}
                            ${option('dark', t('infographics.theme.dark'), false)}
                            ${option('light', t('infographics.theme.light'), false)}
                        </select>
                    </div>
                </div>
                <div id="ig-new-error"></div>
                ${UI.button({ variant: 'primary', type: 'submit', icon: 'wand-sparkles', label: t('infographics.new.create') })}
            </form>
        `;
    },

    // ─── Markup: the list ────────────────────────────────────────────────────
    listMarkup() {
        if (this.listError && !this.items.length) {
            return html`<div class="surface pad-5">${UI.errorBox(this.listError)}</div>`;
        }
        if (!this.items.length) {
            return html`<div class="surface pad-5">${Admin.emptyState('images', t('infographics.empty.title'), t('infographics.empty.body'))}</div>`;
        }
        return html`<div class="ig-grid">${this.items.map((item) => this.cardMarkup(item))}</div>`;
    },

    statusBadge(item) {
        const tone = { writing: 'info', rendering: 'info', ready: 'success', failed: 'danger', scheduled: 'neutral' }[item.status] || 'neutral';
        return html`<span class="badge badge-${tone}">${t(`infographics.status.${item.status}`)}</span>`;
    },

    /** What an open job is doing, in words: waiting for the Mac, the AI writing, or the render's own line. */
    progressText(item) {
        if (item.job && item.job.status === 'pending') {
            return this.worker && !this.worker.online ? t('infographics.progress.waitingOffline') : t('infographics.progress.waiting');
        }
        if (item.job && item.job.progress) return item.job.progress;
        return item.status === 'writing' ? t('infographics.progress.writing') : t('infographics.progress.rendering');
    },

    fileName(item, ext) {
        const base = (item.headline || 'infographic').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'infographic';
        return `${base}-${item.theme}.${ext}`;
    },

    cardMarkup(item) {
        const r = item.render || null;
        const gif = r ? safeUrl(r.gif_url) : '';
        const id = item.id;
        const ready = item.status === 'ready';
        const preview = gif && (ready || item.status === 'scheduled')
            ? html`<img src="${gif}" alt="${item.headline}" loading="lazy" width="720" height="900">`
            : item.status === 'failed'
                ? html`<div class="ig-wait ig-wait-failed"><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('infographics.failed')}</span></div>`
                : html`<div class="ig-wait"><span class="spinner" aria-hidden="true"></span><span>${this.progressText(item)}</span></div>`;
        const when = item.schedule && item.schedule.scheduled_time ? item.schedule.scheduled_time : null;
        const downloads = r ? html`
            <a class="btn btn-secondary btn-sm" href="${safeUrl(r.gif_url)}" download="${this.fileName(item, 'gif')}">
                <i data-lucide="download" aria-hidden="true"></i> ${t('infographics.action.gif')}</a>
            <a class="btn btn-secondary btn-sm" href="${safeUrl(r.mp4_url)}" download="${this.fileName(item, 'mp4')}">
                <i data-lucide="film" aria-hidden="true"></i> ${t('infographics.action.mp4')}</a>
        ` : '';
        const other = item.theme === 'dark' ? 'light' : 'dark';
        return html`
            <article class="surface ig-card" data-id="${id}" data-focus-key="ig-${id}">
                <div class="ig-preview ig-preview-${this.THEMES.includes(item.theme) ? item.theme : 'dark'}">${preview}</div>
                <div class="ig-body">
                    <h3 class="ig-title" dir="auto">${item.headline || item.topic}</h3>
                    <div class="ig-meta">
                        ${this.statusBadge(item)}
                        <span class="badge badge-neutral">${t(`infographics.theme.${item.theme}`)}</span>
                        <span class="badge badge-neutral">${t(`infographics.lang.${item.language}`)}</span>
                    </div>
                    ${item.status === 'failed' && item.error ? html`<div class="ig-error">${UI.errorHtml(UI.failureError(item.error))}</div>` : ''}
                    ${ready && item.problems && item.problems.length ? html`
                        <ul class="ig-problems" aria-label="${t('infographics.problems')}">
                            ${item.problems.map((p) => html`<li dir="auto"><i data-lucide="alert-circle" aria-hidden="true"></i> ${p}</li>`)}
                        </ul>` : ''}
                    ${this.reviewMarkup(item)}
                    ${when ? html`<p class="ig-when"><i data-lucide="calendar-check" aria-hidden="true"></i>
                        ${t('infographics.scheduledFor', { when: this.zoneLabel(when) })}
                        <a href="#/posts">${t('infographics.openPosts')}</a></p>` : ''}
                    <div class="ig-actions">
                        ${ready ? UI.button({ variant: 'primary', size: 'sm', icon: 'calendar-check', label: t('infographics.action.schedule'), action: 'infographics:openSchedule', data: { id } }) : ''}
                        ${downloads}
                        ${ready ? UI.button({ size: 'sm', icon: 'pencil', label: t('infographics.action.edit'), action: 'infographics:edit', data: { id } }) : ''}
                        ${item.spec && !this.open(item) ? UI.button({ size: 'sm', icon: 'copy', label: t(`infographics.action.copy.${other}`), action: 'infographics:copy', data: { id, theme: other } }) : ''}
                        ${item.status === 'failed' ? UI.button({ size: 'sm', icon: 'rotate-cw', label: t('infographics.action.retry'), action: 'infographics:retry', data: { id } }) : ''}
                        ${ready || item.status === 'failed' ? UI.button({ variant: 'ghost', size: 'sm', icon: 'refresh-cw', label: t('infographics.action.rewrite'), action: 'infographics:rewrite', data: { id } }) : ''}
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', ariaLabel: t('infographics.action.delete'), action: 'infographics:remove', data: { id } })}
                    </div>
                </div>
            </article>
        `;
    },

    /**
     * The practitioner review (v32): the comments experts are likely to post under it, each with a
     * reply one tap from the clipboard, so the owner is ready before the first one arrives.
     */
    reviewMarkup(item) {
        const objections = item.review && Array.isArray(item.review.objections) ? item.review.objections : [];
        if (!objections.length) return '';
        return html`
            <details class="ig-review">
                <summary><i data-lucide="message-square" aria-hidden="true"></i> ${t('infographics.review.title', { n: objections.length })}</summary>
                <ul>
                    ${objections.map((o, i) => html`
                        <li>
                            <p class="ig-review-comment" dir="auto">“${o.comment}”</p>
                            <p class="ig-review-reply" dir="auto">${o.reply}</p>
                            ${UI.button({ variant: 'ghost', size: 'sm', icon: 'copy', label: t('infographics.review.copy'), action: 'infographics:copyReply', data: { id: item.id, index: i } })}
                        </li>`)}
                </ul>
            </details>
        `;
    },

    find(id) { return this.items.find((i) => i.id === id) || null; },

    /** One item replaced in place, from a route's answer, then the list repainted. */
    put(item) {
        if (!item || typeof item.id !== 'string') return;
        const at = this.items.findIndex((i) => i.id === item.id);
        if (at === -1) this.items.unshift(item); else this.items[at] = item;
        this.paintList();
        this.schedulePoll(this._seq);
    },

    // ─── The editor ──────────────────────────────────────────────────────────
    columnNames(spec) {
        return spec && Array.isArray(spec.columns) ? spec.columns.map((c) => (c && typeof c.name === 'string' ? c.name.trim() : '')).filter(Boolean) : [];
    },

    /** The server's caption check, as the editor shows it: each column name, found or not. */
    captionCheck(caption, names) {
        const fold = (s) => UI.normalizeArabic(String(s || '')).toLowerCase();
        const text = fold(caption);
        return names.map((name) => ({ name, found: text.includes(fold(name)) }));
    },

    captionCheckMarkup(caption, names) {
        return html`${this.captionCheck(caption, names).map((c) => html`
            <span class="ig-check ${c.found ? 'ig-check-ok' : 'ig-check-missing'}">
                <i data-lucide="${c.found ? 'check' : 'x'}" aria-hidden="true"></i> ${c.name}
            </span>`)}`;
    },

    diagramFields(prefix, mini, label) {
        const kind = mini && this.DIAGRAMS.includes(mini.kind) ? mini.kind : 'icon';
        return html`
            <div class="ig-row ig-diagram">
                <div class="form-group">
                    <label class="form-label" for="${prefix}-kind">${label}</label>
                    <select class="select" id="${prefix}-kind" data-field="${prefix}-kind">
                        ${this.DIAGRAMS.map((d) => html`<option value="${d}" ${d === kind ? html.raw('selected') : ''}>${t(`infographics.diagram.${d}`)}</option>`)}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="${prefix}-extra">${t('infographics.edit.diagramExtra')}</label>
                    <input class="field" id="${prefix}-extra" data-field="${prefix}-extra" dir="ltr" maxlength="40"
                           value="${(mini && (mini.name || mini.badge || mini.label)) || ''}">
                </div>
            </div>
        `;
    },

    editorMarkup(item) {
        const spec = item.spec || {};
        const field = (key, label, value, max, opts = {}) => html`
            <div class="form-group">
                <label class="form-label" for="ig-e-${key}">${label}</label>
                ${opts.area
                    ? html`<textarea class="field field-textarea" id="ig-e-${key}" data-field="${key}" rows="${opts.rows || 2}" maxlength="${max}" dir="auto">${value || ''}</textarea>`
                    : html`<input class="field" id="ig-e-${key}" data-field="${key}" maxlength="${max}" dir="auto" value="${value || ''}">`}
            </div>
        `;
        const sub = spec.subtitle || {};
        const columns = Array.isArray(spec.columns) ? spec.columns : [];
        return html`
            ${Admin.modalHeader(t('infographics.edit.title'))}
            <form id="ig-editor" data-submit="infographics:save" data-id="${item.id}" novalidate class="ig-editor">
                <div class="form-group">
                    <label class="form-label" for="ig-e-caption">${t('infographics.edit.caption')}</label>
                    <textarea class="field field-textarea" id="ig-e-caption" data-field="caption" rows="9" maxlength="2200" dir="auto"
                              data-input="infographics:captionInput">${item.caption || ''}</textarea>
                    <p class="form-hint">${t('infographics.edit.captionHint')}</p>
                    <div class="ig-checks" id="ig-caption-check">${this.captionCheckMarkup(item.caption, this.columnNames(spec))}</div>
                </div>
                <details class="ig-more">
                    <summary>${t('infographics.edit.page')}</summary>
                    <p class="form-hint">${t('infographics.edit.pageHint')}</p>
                    ${field('subtitle', t('infographics.edit.subtitle'), sub.text, 70)}
                    ${field('accent', t('infographics.edit.accent'), sub.accent, 40)}
                    ${columns.map((col, c) => html`
                        <fieldset class="ig-column">
                            <legend>${t('infographics.edit.column', { n: c + 1 })}</legend>
                            ${field(`c${c}-name`, t('infographics.edit.name'), col.name, 20)}
                            ${field(`c${c}-kind`, t('infographics.edit.kind'), col.kind, 40)}
                            ${field(`c${c}-note`, t('infographics.edit.note'), col.note, 60)}
                            ${this.diagramFields(`c${c}-hero`, col.hero, t('infographics.edit.hero'))}
                            ${(Array.isArray(col.steps) ? col.steps : []).map((s, i) => html`
                                <div class="ig-step">
                                    <p class="ig-step-label">${t('infographics.edit.step', { n: i + 1 })}</p>
                                    ${field(`c${c}-s${i}-title`, t('infographics.edit.stepTitle'), s.title, 30)}
                                    ${field(`c${c}-s${i}-desc`, t('infographics.edit.stepDesc'), s.desc, 60)}
                                    ${this.diagramFields(`c${c}-s${i}-mini`, s.mini, t('infographics.edit.diagram'))}
                                </div>
                            `)}
                        </fieldset>
                    `)}
                </details>
                <div id="ig-editor-error"></div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'save', label: t('infographics.edit.save') })}
                </div>
            </form>
        `;
    },

    /** The editor's fields back into a spec, over the one it opened with (so nothing it doesn't show is lost). */
    readEditor(form, item) {
        const get = (key) => {
            const el = form.querySelector(`[data-field="${key}"]`);
            return el ? String(el.value || '').trim() : '';
        };
        const mini = (prefix, before) => {
            const kind = get(`${prefix}-kind`) || (before && before.kind) || 'icon';
            const extra = get(`${prefix}-extra`);
            if (kind === 'icon') return { kind, name: extra || 'sparkles' };
            if (kind === 'docs') return extra ? { kind, badge: extra } : { kind };
            if (kind === 'augment') return extra ? { kind, label: extra } : { kind };
            return { kind };
        };
        const spec = JSON.parse(JSON.stringify(item.spec || {}));
        const accent = get('accent');
        spec.subtitle = accent ? { text: get('subtitle'), accent } : { text: get('subtitle') };
        spec.columns = (spec.columns || []).map((col, c) => ({
            ...col,
            name: get(`c${c}-name`),
            kind: get(`c${c}-kind`),
            note: get(`c${c}-note`),
            hero: mini(`c${c}-hero`, col.hero),
            steps: (col.steps || []).map((s, i) => ({
                ...s,
                title: get(`c${c}-s${i}-title`),
                desc: get(`c${c}-s${i}-desc`),
                mini: mini(`c${c}-s${i}-mini`, s.mini),
            })),
        }));
        return { spec, caption: get('caption') };
    },

    /** Only what changed: a caption alone is saved without a render. */
    changes(item, read) {
        const out = {};
        if (JSON.stringify(read.spec) !== JSON.stringify(item.spec)) out.spec = read.spec;
        if (read.caption !== (item.caption || '').trim()) out.caption = read.caption;
        return out;
    },

    // ─── Schedule ────────────────────────────────────────────────────────────
    // What the dialog says is what Schedule does (UX US1, IG-01): every time here is the tenant's, the slot option names the
    // slot's real time and city, the field is dormant (disabled) until "at a time I choose" is the choice, and the submit button
    // reads the time and city it will post at.

    /** The tenant's zone: the one the slot answer carried, else the one the settings did, else the browser's. */
    zone() {
        return UI.zone(this.slot && this.slot.timezone);
    },

    /** "Sun, 28 Sep, 19:00 (Riyadh)": a time in the tenant's zone with the city it is in. '' when it is not a time. */
    zoneLabel(value) {
        const zone = this.zone();
        const time = UI.zoneTime(value, { zone });
        return time ? t('time.zoned', { time, city: UI.zoneCity(zone) }) : '';
    },

    /** The slot option's words: the real time and city once known; the plain label while looking or if it could not be read. */
    slotText() {
        const slot = this.slot;
        if (slot && slot.status === 'ready' && slot.next) return t('infographics.schedule.slotAt', { when: this.zoneLabel(slot.next) });
        if (slot && slot.status === 'none') return t('infographics.schedule.slotNone');
        return t('infographics.schedule.slot');
    },

    scheduleMarkup(item) {
        // TikTok in the list is for explainers: an infographic is never sent there.
        const platforms = ((this.brand && this.brand.platforms) || []).filter((p) => p !== 'tiktok');
        const none = !!(this.slot && this.slot.status === 'none');
        const zone = this.zone();
        return html`
            ${Admin.modalHeader(t('infographics.schedule.title'))}
            <form id="ig-schedule" data-submit="infographics:schedule" data-id="${item.id}" novalidate>
                <p class="modal-body-text" dir="auto">${item.headline}</p>
                <p class="form-hint">${t('infographics.schedule.where', { platforms: platforms.map((p) => t(`infographics.platform.${p}`)).join(' · ') || '—' })}</p>
                <fieldset class="ig-when-choice">
                    <legend class="form-label">${t('infographics.schedule.when')}</legend>
                    <label class="ig-radio"><input type="radio" name="when" value="slot" data-change="infographics:whenChanged"${none ? html.raw(' disabled') : html.raw(' checked')}> <span id="ig-when-slot">${this.slotText()}</span></label>
                    <label class="ig-radio"><input type="radio" name="when" value="now" data-change="infographics:whenChanged"> ${t('infographics.schedule.now')}</label>
                    <label class="ig-radio"><input type="radio" name="when" value="at" data-change="infographics:whenChanged"${none ? html.raw(' checked') : ''}> ${t('infographics.schedule.at')}</label>
                    <span class="ig-at-wrap">
                        <input class="field" type="datetime-local" name="at" id="ig-when-at" data-input="infographics:atInput"${none ? '' : html.raw(' disabled')} aria-label="${t('infographics.schedule.at')}" aria-describedby="ig-when-at-hint">
                        <span class="ig-at-claim" id="ig-when-at-claim" data-action="infographics:pickAt" aria-hidden="true"${none ? html.raw(' hidden') : ''}></span>
                    </span>
                    <span class="form-hint" id="ig-when-at-hint">${t('infographics.schedule.zoneHint', { city: UI.zoneCity(zone), zone })}</span>
                </fieldset>
                <p class="form-hint">${t('infographics.schedule.gifHint')}</p>
                <div id="ig-schedule-error"></div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary" id="ig-schedule-submit"><i data-lucide="calendar-check" aria-hidden="true"></i> <span id="ig-schedule-submit-label">${t('infographics.action.schedule')}</span></button>
                </div>
            </form>
        `;
    },

    /** Which option is chosen: 'slot', 'now' or 'at'. */
    whenChoice(form) {
        const checked = form && form.querySelector('input[name="when"]:checked');
        return (checked && checked.value) || 'slot';
    },

    /** The typed time as an instant, read as wall time in the TENANT's zone (not the browser's); null when it is not one. */
    atInstant(form) {
        const field = form && form.elements && form.elements.at;
        return field ? UI.zoneInput(field.value, this.zone()) : null;
    },

    /** What the submit button says it will do, for the choice as it stands. The plain "Schedule" only when there is no time to name. */
    submitLabel(form) {
        const choice = this.whenChoice(form);
        if (choice === 'now') return t('infographics.schedule.submitNow');
        const iso = choice === 'at' ? this.atInstant(form) : (this.slot && this.slot.status === 'ready' ? this.slot.next : null);
        const when = iso ? this.zoneLabel(iso) : '';
        return when ? t('infographics.schedule.submitAt', { when }) : t('infographics.action.schedule');
    },

    /** Make the dialog agree with the choice: the field is live only for "at", its claim layer covers it otherwise, the button names the time. */
    syncSchedule(form) {
        if (!form) return;
        const at = form.elements && form.elements.at;
        const claim = form.querySelector('#ig-when-at-claim');
        const on = this.whenChoice(form) === 'at';
        if (at) at.disabled = !on;
        if (claim) claim.hidden = on;
        const label = form.querySelector('#ig-schedule-submit-label');
        if (label) label.textContent = this.submitLabel(form);
    },

    /** Choose "at a time I choose", open the field on the slot's time when it is empty (so the button names a real time at once), and sync. */
    chooseAt(form) {
        if (!form) return;
        const radio = form.querySelector('input[name="when"][value="at"]');
        if (radio) radio.checked = true;
        const at = form.elements && form.elements.at;
        if (at && !at.value && this.slot && this.slot.next) at.value = UI.zoneInputValue(this.slot.next, this.zone());
        this.syncSchedule(form);
    },

    /** Focus landed on something in the dialog: when it is the time field, that is the choice. */
    atFocus(target) {
        if (!target || target.name !== 'at') return;
        const form = target.closest && target.closest('form');
        if (form && this.whenChoice(form) !== 'at') this.chooseAt(form);
    },

    /** The dialog that is open for `id`, or null: the preview may land after it was closed, or after another was opened. */
    openScheduleForm(id) {
        const form = document.getElementById('ig-schedule');
        return form && form.dataset && form.dataset.id === id ? form : null;
    },

    /** Read "the next free slot" and say it in the dialog. A slot that can't be read leaves the plain label: Schedule still works. */
    async loadSlot(id) {
        const seq = ++this._slotSeq;
        this.slot = { status: 'loading', next: null, timezone: '' };
        let slot;
        try {
            const res = await API.getInfographicNextSlot();
            if (res && typeof res.timezone === 'string') UI.setZone(res.timezone);
            const next = res && typeof res.next_slot === 'string' && UI._date(res.next_slot) ? res.next_slot : null;
            slot = { status: next ? 'ready' : 'none', next, timezone: UI.zone(res && res.timezone) };
        } catch {
            slot = { status: 'error', next: null, timezone: '' };
        }
        if (seq !== this._slotSeq || this._destroyed) return;
        this.slot = slot;
        const form = this.openScheduleForm(id);
        if (!form) return;
        const text = form.querySelector('#ig-when-slot');
        if (text) text.textContent = this.slotText();
        const hint = form.querySelector('#ig-when-at-hint');
        if (hint) hint.textContent = t('infographics.schedule.zoneHint', { city: UI.zoneCity(this.zone()), zone: this.zone() });
        if (slot.status === 'none') {
            // Nothing for "next free slot" to mean: the choice moves to a time of his own, and the slot option says why it is off.
            const radio = form.querySelector('input[name="when"][value="slot"]');
            if (radio) radio.disabled = true;
            this.chooseAt(form);
        } else {
            this.syncSchedule(form);
        }
    },

    // ─── Brand ───────────────────────────────────────────────────────────────
    normalizeBrand(raw) {
        const s = raw && typeof raw === 'object' ? raw : {};
        const name = s.name && typeof s.name === 'object' ? s.name : {};
        const str = (v) => (typeof v === 'string' ? v : '');
        const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
        return {
            name: { ar: str(name.ar), en: str(name.en) },
            site: str(s.site),
            handle: str(s.handle),
            socials: Array.isArray(s.socials) ? this.SOCIALS.filter((x) => s.socials.includes(x)) : [],
            primary: hex(s.primary, '#0E3B5C'),
            accent: hex(s.accent, '#F2A33A'),
            photo_url: typeof s.photo_url === 'string' && s.photo_url ? s.photo_url : null,
            theme: this.THEMES.includes(s.theme) ? s.theme : 'dark',
            language: this.LANGUAGES.includes(s.language) ? s.language : 'ar',
            platforms: Array.isArray(s.platforms) ? this.PLATFORMS.filter((x) => s.platforms.includes(x)) : ['instagram', 'facebook'],
        };
    },

    brandMissing() {
        return this.settingsLoaded && this.brand && !this.brand.name.ar && !this.brand.name.en;
    },

    brandFormMarkup() {
        if (!this.settingsLoaded) return html`<p class="form-hint">${t('infographics.brand.unavailable')}</p>`;
        const b = this.brand;
        const check = (name, value, on, label) => html`
            <label class="check-row"><input type="checkbox" name="${name}" value="${value}" ${on ? html.raw('checked') : ''}> ${label}</label>`;
        const photo = b.photo_url ? safeUrl(b.photo_url) : '';
        return html`
            <form id="ig-brand-form" data-submit="infographics:saveBrand" novalidate>
                <p class="form-hint">${t('infographics.brand.hint')}</p>
                <div class="ig-row">
                    <div class="form-group"><label class="form-label" for="ig-b-name-ar">${t('infographics.brand.nameAr')}</label>
                        <input class="field" id="ig-b-name-ar" name="name_ar" dir="rtl" maxlength="40" value="${b.name.ar}"></div>
                    <div class="form-group"><label class="form-label" for="ig-b-name-en">${t('infographics.brand.nameEn')}</label>
                        <input class="field" id="ig-b-name-en" name="name_en" dir="ltr" maxlength="40" value="${b.name.en}"></div>
                </div>
                <div class="ig-row">
                    <div class="form-group"><label class="form-label" for="ig-b-site">${t('infographics.brand.site')}</label>
                        <input class="field" id="ig-b-site" name="site" dir="ltr" maxlength="40" value="${b.site}" placeholder="example.dev"></div>
                    <div class="form-group"><label class="form-label" for="ig-b-handle">${t('infographics.brand.handle')}</label>
                        <input class="field" id="ig-b-handle" name="handle" dir="ltr" maxlength="32" value="${b.handle}" placeholder="@you"></div>
                </div>
                <fieldset class="form-group ig-checkset">
                    <legend class="form-label">${t('infographics.brand.socials')}</legend>
                    ${this.SOCIALS.map((s) => check('socials', s, b.socials.includes(s), t(`infographics.social.${s}`)))}
                </fieldset>
                <div class="ig-row">
                    <div class="form-group"><label class="form-label" for="ig-b-primary">${t('infographics.brand.primary')}</label>
                        <input class="field ig-colour" id="ig-b-primary" name="primary" type="color" value="${b.primary}"></div>
                    <div class="form-group"><label class="form-label" for="ig-b-accent">${t('infographics.brand.accent')}</label>
                        <input class="field ig-colour" id="ig-b-accent" name="accent" type="color" value="${b.accent}"></div>
                </div>
                <div class="form-group ig-portrait">
                    <span class="form-label">${t('infographics.brand.portrait')}</span>
                    <div class="ig-portrait-row">
                        ${photo ? html`<img src="${photo}" alt="${t('infographics.brand.portrait')}" class="ig-portrait-img" width="64" height="64">`
                            : html`<span class="ig-portrait-img ig-portrait-empty" aria-hidden="true"><i data-lucide="image-plus"></i></span>`}
                        <label class="btn btn-secondary btn-sm" for="ig-b-photo"><i data-lucide="upload" aria-hidden="true"></i> ${t('infographics.brand.upload')}</label>
                        <input class="sr-only" id="ig-b-photo" type="file" accept="image/jpeg,image/png,image/webp" data-change="infographics:photo">
                        ${photo ? UI.button({ variant: 'ghost', size: 'sm', icon: 'x', label: t('infographics.brand.removePhoto'), action: 'infographics:removePhoto' }) : ''}
                    </div>
                    <p class="form-hint">${t('infographics.brand.portraitHint')}</p>
                </div>
                <fieldset class="form-group ig-checkset">
                    <legend class="form-label">${t('infographics.brand.platforms')}</legend>
                    ${this.PLATFORMS.map((p) => check('platforms', p, b.platforms.includes(p), t(`infographics.platform.${p}`)))}
                </fieldset>
                <div class="ig-row">
                    <div class="form-group"><label class="form-label" for="ig-b-theme">${t('infographics.brand.theme')}</label>
                        <select class="select" id="ig-b-theme" name="theme">
                            ${this.THEMES.map((x) => html`<option value="${x}" ${x === b.theme ? html.raw('selected') : ''}>${t(`infographics.theme.${x}`)}</option>`)}
                        </select></div>
                    <div class="form-group"><label class="form-label" for="ig-b-language">${t('infographics.brand.language')}</label>
                        <select class="select" id="ig-b-language" name="language">
                            ${this.LANGUAGES.map((x) => html`<option value="${x}" ${x === b.language ? html.raw('selected') : ''}>${t(`infographics.lang.${x}`)}</option>`)}
                        </select></div>
                </div>
                <div id="ig-brand-error"></div>
                ${UI.button({ variant: 'primary', type: 'submit', icon: 'save', label: t('infographics.brand.save') })}
            </form>
        `;
    },

    readBrand(form) {
        const v = (name) => String((form.elements[name] && form.elements[name].value) || '').trim();
        const all = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((el) => el.value);
        return {
            name: { ar: v('name_ar'), en: v('name_en') },
            site: v('site'),
            handle: v('handle'),
            socials: all('socials'),
            primary: v('primary').toUpperCase(),
            accent: v('accent').toUpperCase(),
            photo_url: this.brand ? this.brand.photo_url : null,
            theme: v('theme'),
            language: v('language'),
            platforms: all('platforms'),
        };
    },

    paintBrand() {
        const body = document.getElementById('ig-brand-body');
        if (!body) return;
        body.innerHTML = esc(this.brandFormMarkup());
        UI.icons(body);
    },

    /** A portrait as a 512 px square JPEG data URL: small enough for /api/upload, sharp enough for a 70 px circle. */
    squareJpeg(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(t('infographics.brand.photoFailed')));
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error(t('infographics.brand.photoFailed')));
                img.onload = () => {
                    const side = Math.min(img.naturalWidth, img.naturalHeight);
                    const canvas = document.createElement('canvas');
                    canvas.width = 512;
                    canvas.height = 512;
                    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 512, 512);
                    resolve(canvas.toDataURL('image/jpeg', 0.9));
                };
                img.src = String(reader.result);
            };
            reader.readAsDataURL(file);
        });
    },

    /** A refused request's message, with the server's problem list when it sent one. */
    errorMarkup(err) {
        const problems = err && err.body && Array.isArray(err.body.problems) ? err.body.problems : [];
        return html`${UI.errorBox(err)}
            ${problems.length ? html`<ul class="ig-problems">${problems.map((p) => html`<li dir="auto">${p}</li>`)}</ul>` : ''}`;
    },

    showError(id, err) {
        const box = document.getElementById(id);
        if (!box) return;
        box.innerHTML = esc(this.errorMarkup(err));
        UI.icons(box);
    },
};

UI.registerActions('infographics', {
    async create(form, event) {
        event.preventDefault();
        const P = InfographicsPage;
        const topic = String(form.elements.topic.value || '').trim();
        if (topic.length < 3) {
            P.showError('ig-new-error', new Error(t('infographics.new.topicMissing')));
            form.elements.topic.focus();
            return;
        }
        const restore = UI.formBusy(form, t('infographics.new.creating'));
        if (!restore) return;
        try {
            const item = await API.createInfographic({
                topic,
                notes: String(form.elements.notes.value || '').trim() || undefined,
                language: form.elements.language.value,
                theme: form.elements.theme.value,
            });
            form.elements.topic.value = '';
            form.elements.notes.value = '';
            document.getElementById('ig-new-error').innerHTML = '';
            P.put(item);
            UI.toast(t('infographics.new.started'));
        } catch (err) {
            P.showError('ig-new-error', err);
        } finally {
            restore();
        }
    },

    async copyReply(el) {
        const item = InfographicsPage.find(el.dataset.id);
        const o = item && item.review && item.review.objections ? item.review.objections[Number(el.dataset.index)] : null;
        if (!o) return;
        try {
            await navigator.clipboard.writeText(o.reply);
            UI.toast(t('infographics.review.copied'));
        } catch {
            // No clipboard outside a secure context or in some embedded browsers: say so.
            UI.toast(t('setup.copyFailed'), 'error');
        }
    },

    edit(el) {
        const P = InfographicsPage;
        const item = P.find(el.dataset.id);
        if (!item) return;
        P.editing = item.id;
        UI.showModal(P.editorMarkup(item));
    },

    captionInput(el) {
        const P = InfographicsPage;
        const item = P.find(P.editing);
        const box = document.getElementById('ig-caption-check');
        if (!item || !box) return;
        // The names as they stand in the editor, so renaming a column updates the check too.
        const form = el.closest('form');
        const names = (item.spec && item.spec.columns ? item.spec.columns : []).map((col, c) => {
            const input = form && form.querySelector(`[data-field="c${c}-name"]`);
            return input ? String(input.value || '').trim() : col.name;
        }).filter(Boolean);
        box.innerHTML = esc(P.captionCheckMarkup(el.value, names));
        UI.icons(box);
    },

    async save(form, event) {
        event.preventDefault();
        const P = InfographicsPage;
        const item = P.find(form.dataset.id);
        if (!item) return;
        const body = P.changes(item, P.readEditor(form, item));
        if (!Object.keys(body).length) {
            UI.closeModal();
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            const updated = await API.updateInfographic(item.id, body);
            UI.closeModal();
            P.put(updated);
            UI.toast(body.spec ? t('infographics.edit.rendering') : t('infographics.edit.saved'));
        } catch (err) {
            P.showError('ig-editor-error', err);
            restore();
        }
    },

    openSchedule(el) {
        const P = InfographicsPage;
        const item = P.find(el.dataset.id);
        if (!item) return;
        P.slot = { status: 'loading', next: null, timezone: '' };
        UI.showModal(P.scheduleMarkup(item));
        const form = document.getElementById('ig-schedule');
        // Focusing the time field, however it was reached, chooses "at a time I choose". (The field is only focusable once that is on,
        // or through its claim layer, but a script or a screen reader can put focus there too.)
        if (form) form.addEventListener('focusin', (event) => InfographicsPage.atFocus(event.target));
        P.loadSlot(item.id);
    },

    /** A choice was made among the radios. */
    whenChanged(el) {
        const P = InfographicsPage;
        const form = el.closest('form');
        if (form && P.whenChoice(form) === 'at') P.chooseAt(form);
        else P.syncSchedule(form);
    },

    /** Typing in the time field is choosing it. (It cannot be typed in while another option is chosen: this is for a field that is live.) */
    atInput(el) {
        const P = InfographicsPage;
        const form = el.closest('form');
        if (!form) return;
        const radio = form.querySelector('input[name="when"][value="at"]');
        if (radio && !radio.checked) radio.checked = true;
        P.syncSchedule(form);
    },

    /** The layer over the dormant field was pressed or touched: choose "at", then put the cursor in the field. */
    pickAt(el) {
        const P = InfographicsPage;
        const form = el.closest('form');
        if (!form) return;
        P.chooseAt(form);
        const at = form.elements && form.elements.at;
        if (at && typeof at.focus === 'function') at.focus();
    },

    async schedule(form, event) {
        event.preventDefault();
        const P = InfographicsPage;
        const id = form.dataset.id;
        const when = (form.querySelector('input[name="when"]:checked') || {}).value || 'slot';
        const body = {};
        if (when === 'now') body.now = true;
        if (when === 'at') {
            // Read in the tenant's zone, as the Monteur's override is: not in the zone of the browser this happens to be open in.
            const at = P.atInstant(form);
            if (!at) {
                P.showError('ig-schedule-error', new Error(t('infographics.schedule.atMissing')));
                return;
            }
            body.scheduled_time = at;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            const res = await API.scheduleInfographic(id, body);
            UI.closeModal();
            P.put(res && res.infographic);
            UI.toast(t('infographics.schedule.done', { when: P.zoneLabel(res.scheduled_time) }));
        } catch (err) {
            P.showError('ig-schedule-error', err);
            restore();
        }
    },

    async copy(el) {
        const P = InfographicsPage;
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            P.put(await API.copyInfographic(el.dataset.id, { theme: el.dataset.theme }));
            UI.toast(t('infographics.copy.started'));
        } catch (err) {
            UI.toast(UI.errorLine(err), 'error');
            restore();
        }
    },

    async retry(el) {
        const P = InfographicsPage;
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            P.put(await API.renderInfographic(el.dataset.id, {}));
        } catch (err) {
            UI.toast(UI.errorLine(err), 'error');
            restore();
        }
    },

    rewrite(el) {
        const P = InfographicsPage;
        const id = el.dataset.id;
        Admin.confirm({
            title: t('infographics.rewrite.title'),
            body: t('infographics.rewrite.body'),
            confirmLabel: t('infographics.action.rewrite'),
            confirmIcon: 'refresh-cw',
            tone: 'primary',
            // Admin.confirm closes the dialog once this resolves, and shows the error in it if it throws.
            onConfirm: async () => {
                P.put(await API.renderInfographic(id, { rewrite: true }));
            },
        });
    },

    remove(el) {
        const P = InfographicsPage;
        const id = el.dataset.id;
        const item = P.find(id);
        Admin.confirm({
            title: t('infographics.delete.title'),
            body: item ? item.headline : '',
            hint: t('infographics.delete.hint'),
            confirmLabel: t('infographics.action.delete'),
            onConfirm: async () => {
                await API.deleteInfographic(id);
                P.items = P.items.filter((i) => i.id !== id);
                P.paintList();
            },
        });
    },

    async photo(input) {
        const P = InfographicsPage;
        const file = input.files && input.files[0];
        if (!file) return;
        try {
            const dataUrl = await P.squareJpeg(file);
            const res = await API.uploadMedia({ filename: 'portrait.jpg', mime_type: 'image/jpeg', base64_data: dataUrl });
            if (!res || typeof res.url !== 'string') throw new Error(t('error.unexpected'));
            const saved = await API.saveStudioSettings({ infographic: { photo_url: res.url } });
            P.brand = P.normalizeBrand(saved && saved.settings && saved.settings.infographic);
            P.paintBrand();
            UI.toast(t('infographics.brand.photoSaved'));
        } catch (err) {
            P.showError('ig-brand-error', err);
        } finally {
            input.value = '';
        }
    },

    async removePhoto(el) {
        const P = InfographicsPage;
        const restore = UI.actionBusy(el);
        if (!restore) return;
        try {
            const saved = await API.saveStudioSettings({ infographic: { photo_url: null } });
            P.brand = P.normalizeBrand(saved && saved.settings && saved.settings.infographic);
            P.paintBrand();
        } catch (err) {
            P.showError('ig-brand-error', err);
            restore();
        }
    },

    async saveBrand(form, event) {
        event.preventDefault();
        const P = InfographicsPage;
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            const saved = await API.saveStudioSettings({ infographic: P.readBrand(form) });
            P.brand = P.normalizeBrand(saved && saved.settings && saved.settings.infographic);
            P.paintBrand();
            UI.toast(t('infographics.brand.saved'));
        } catch (err) {
            restore();
            P.showError('ig-brand-error', err);
        }
    },
});
