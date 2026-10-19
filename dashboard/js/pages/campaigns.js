/**
 * Campaigns — keywords, DM templates, public replies.
 *
 * ─── The keyword hazard ─────────────────────────────────────────────────────
 * Matching in production is SUBSTRING matching over Arabic-normalised text
 * (src/services/matching.ts → src/utils/arabic.ts). `تم` therefore fires inside
 * اهتمام, تمام and يتم, and the old form's own placeholder suggested `تم`.
 *
 * `keywordMatches()` in the backend takes a `'word'` mode, and every campaign has
 * its own (`match_mode`, migration v14): the editor sets it, the card says it, and
 * the "will match inside longer words" warning exists only for substring mode.
 * What a keyword will also fire on is named from the SAME normalisation the
 * webhook runs. Which OTHER campaign answers a comment is not decided here: the
 * server's own rule says so (`POST /api/campaigns/try`), see "Collisions" below.
 */
const CampaignsPage = {
    campaigns: [],
    pendingImport: null,

    /**
     * Guards the write against landing after the operator has navigated away.
     * `App.navigate` calls `render()` fire-and-forget and `#page-container` is
     * refilled rather than replaced, so a late GET /campaigns painted this
     * page's card grid into whatever screen the operator had moved to. Same
     * `_seq`/`live()` shape as OverviewPage.
     */
    _seq: 0,

    destroy() {
        this._seq++;
        this.resetCollisions();
    },

    /** Tenant switch: cached campaigns and any half-finished CSV import. */
    resetTenantState() {
        this.campaigns = [];
        this.pendingImport = null;
        this.resetCollisions();
    },

    skeleton() {
        return html`
            ${Motion.toolbar()}
            ${Motion.cardGrid(4, 3)}
            ${Motion.busy()}
        `;
    },

    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;

        const focus = UI.captureFocus(container);
        const seq = ++this._seq;
        const live = () => seq === this._seq && !!document.getElementById('page-container');

        // On a navigation the skeleton is already up (App.navigate painted it
        // inside the view transition). On an in-place refresh — after a create,
        // an edit, a rolled-back delete — it is only painted if the request
        // takes longer than a blink, so a fast round trip does not flash.
        const gate = Motion.beginLoad(container, () => this.skeleton());

        let campaigns;
        try {
            campaigns = await API.getCampaigns();
        } catch (err) {
            if (!live()) return;
            gate.done();
            UI.renderError(container, { title: t('error.pageTitle'), message: err.message }, () => this.render());
            return;
        }
        if (!live()) return;
        gate.done();

        this.campaigns = campaigns;
        // POST/PUT/DELETE /campaigns are `canOperate` on the server; a viewer used
        // to see every button and learn that from an English 403 toast.
        const canOperate = App.canOperate();

        container.innerHTML = esc(html`
            <div class="page-toolbar">
                <!-- The count was a <p>, so this screen had no heading below
                     the page <h1> and no way to reach the grid by heading. -->
                <h2 class="page-toolbar-count">${t('campaigns.count', { count: campaigns.length })}</h2>
                <div class="toolbar-actions">
                    ${UI.helpLink('campaigns#matching', t('help.link.matching'), { className: 'campaigns-help' })}
                    ${canOperate ? html`
                        ${UI.button({
                            variant: 'secondary', size: 'sm', icon: 'upload', label: t('campaigns.import'),
                            action: 'campaigns:triggerCSVSelect', id: 'campaigns-import',
                        })}
                        <!-- Stable id: the modal trigger has to be findable again
                             after the re-render that follows a successful create. -->
                        ${UI.button({
                            variant: 'primary', size: 'sm', icon: 'plus', label: t('campaigns.new'),
                            action: 'campaigns:showCreateModal', id: 'campaigns-new',
                        })}
                    ` : html`<span class="text-meta">${t('campaigns.readOnly')}</span>`}
                </div>
            </div>
            <label class="sr-only" for="csv-file-input">${t('campaigns.csvLabel')}</label>
            <input type="file" id="csv-file-input" accept=".csv" class="hidden" data-change="campaigns:handleCSVSelect">

            ${campaigns.length === 0 ? html`
                <div class="surface pad-5">
                    ${Admin.emptyState('megaphone', t('campaigns.emptyTitle'), t('campaigns.emptyBody'))}
                    <p class="text-center">${UI.helpLink('campaigns#how', t('help.link.campaignsHow'))}</p>
                    <div class="row gap-3 row--center row--wrap mbs-4">
                        ${canOperate ? UI.button({
                            variant: 'secondary', size: 'sm', icon: 'upload', label: t('campaigns.import'),
                            action: 'campaigns:triggerCSVSelect',
                        }) : ''}
                        ${canOperate ? UI.button({
                            variant: 'primary', size: 'sm', icon: 'plus', label: t('common.create'),
                            action: 'campaigns:showCreateModal', id: 'campaigns-new-empty',
                        }) : ''}
                    </div>
                </div>
            ` : html`
                <div class="card-grid">${campaigns.map((c) => this.renderCard(c))}</div>
            `}
        `);

        UI.icons(container);
        UI.revealClipped(container);
        UI.restoreFocus(focus);
        Motion.announce(t('campaigns.count', { count: campaigns.length }));
    },

    /**
     * The delete button carries data-id / data-keyword instead of an inline
     * onclick that interpolated them into a JS string literal. HTML-escaping
     * does NOT protect that position: the parser decodes &#39; back to a quote
     * before the JS is parsed, so a keyword of it's broke the handler and
     * ');alert(1);// executed.
     */
    renderCard(c) {
        const canOperate = App.canOperate();
        const isActive = c.is_active !== false;
        const keywords = this.splitKeywords(c.trigger_keyword);
        // The card used to judge every keyword as if it were substring-matched, so a whole-word campaign (and every Monteur
        // one is) wore red "will match inside many longer words" warnings that are false for it (CA-08). The mode decides.
        const mode = this.modeOf(c);
        const riskOf = (k) => this.keywordRisk(k, mode);
        const risky = keywords.filter((k) => riskOf(k).risky);

        return html`
            <!-- An <article> with no accessible name is announced as "article"
                 and nothing else, so eight campaigns were eight identical
                 landmarks. Named by its own keyword list, which is how the
                 operator identifies a campaign — and by reference, so the name
                 keeps the list's dir="auto" instead of being flattened into an
                 aria-label string. -->
            <article class="campaign-card surface ${isActive ? '' : html.raw('is-paused')}"
                     data-id="${c.id}" aria-labelledby="campaign-keywords-${c.id}">
                <div class="campaign-card-head">
                    <div class="keyword-list" id="campaign-keywords-${c.id}">
                        ${isActive ? '' : html`<span class="chip"><i data-lucide="pause" aria-hidden="true"></i> ${t('campaigns.pausedChip')}</span>`}
                        ${keywords.map((k) => html`
                            <span class="chip ${riskOf(k).risky ? html.raw('chip-danger') : ''}" dir="auto">
                                <i data-lucide="${riskOf(k).risky ? 'alert-triangle' : 'hash'}" aria-hidden="true"></i>
                                ${k}
                            </span>
                        `)}
                    </div>
                    <div class="row gap-2 shrink-0">
                        <label class="switch">
                            <!-- Every one of these used to be named "Campaign
                                 active" and nothing else, so tabbing eight
                                 switches gave eight identical announcements
                                 with no way to tell which campaign you were
                                 about to pause. -->
                            <span class="sr-only">${t('campaigns.toggleLabel')}: <span dir="auto">${keywords.join(', ')}</span></span>
                            <input type="checkbox" ${isActive ? html.raw('checked') : ''} ${canOperate ? '' : html.raw('disabled')}
                                   data-change="campaigns:toggleActive" data-id="${c.id}"
                                   data-focus-key="campaign-toggle-${c.id}">
                            <span class="switch-track"></span>
                        </label>
                    </div>
                </div>

                <!-- How the keywords are matched, always said (CA-08): the card never showed it, so nothing told the owner that a
                     whole-word campaign will not fire on «الكورس». Neutral: a mode is a choice, not a problem. It is a sibling of
                     the keyword list, not inside it, so it stays out of the card's accessible name (that list). -->
                <div class="row gap-2 row--wrap">
                    ${this.modeChip(mode)}
                </div>

                ${risky.length > 0 ? html`
                    <p class="text-meta text-warning">
                        <i data-lucide="alert-triangle" aria-hidden="true"></i>
                        ${t('campaigns.match.riskGeneric', { keyword: risky[0], length: UI.formatNumber(risky[0].length) })}
                    </p>
                ` : ''}

                <!-- The DM template is clipped at 7.5em. previewBlock() adds the
                     disclosure that lets the operator read the rest of the
                     message they are about to send — revealed only when the
                     text is genuinely cut off. lang="ar": the template is
                     always Arabic, so under the English UI a screen reader was
                     reading it with an English voice. -->
                ${UI.previewBlock(c.dm_template, { label: t('campaigns.dmTemplate'), arabic: true })}

                ${c.public_reply_template ? html`
                    <p class="campaign-meta-line row gap-2">
                        <i data-lucide="message-circle" aria-hidden="true"></i>
                        <!-- The label is UI copy in whichever language the
                             interface is in; only the reply itself is the
                             creator's Arabic, so only it carries lang. -->
                        ${t('campaigns.publicPrefix')}: <span dir="auto" lang="ar">${c.public_reply_template}</span>
                    </p>
                ` : ''}
                ${c.post_id ? html`
                    <p class="campaign-meta-line row gap-2">
                        <i data-lucide="image" aria-hidden="true"></i>
                        ${t('campaigns.postId')}: ${UI.ltr(c.post_id)}
                    </p>
                ` : ''}

                ${this.renderStats(c)}

                ${canOperate ? html`
                <div class="card-actions">
                    <!-- data-focus-key, not id: these buttons are destroyed and
                         rebuilt by every render, and the key is what lets
                         closeModal() find this card's Edit button again after a
                         save has re-rendered the grid. -->
                    ${UI.button({
                        variant: 'secondary', size: 'sm', icon: 'pencil', label: t('common.edit'),
                        action: 'campaigns:showEditModal', data: { id: c.id },
                        focusKey: `campaign-edit-${c.id}`,
                    })}
                    ${UI.button({
                        variant: 'danger', size: 'sm', icon: 'trash-2', label: t('common.delete'),
                        action: 'campaigns:confirmDelete',
                        data: { id: c.id, keyword: c.trigger_keyword },
                        focusKey: `campaign-delete-${c.id}`,
                    })}
                </div>
                ` : ''}
            </article>
        `;
    },

    // ─── The card: match mode and what became of its replies ─────────────────

    /**
     * `'word'` or `'substring'`: the same reading the server has (`normalizeMatchMode`). A row with no `match_mode` (older
     * than migration v14, or from a query that did not select it) is substring, which is how it is matched.
     */
    modeOf(c) {
        return c && c.match_mode === 'word' ? 'word' : 'substring';
    },

    /** The neutral chip that says how a campaign's keywords are matched: a glyph and a word, and what the word means as the title. */
    modeChip(mode) {
        const word = mode === 'word';
        return html`
            <span class="chip" data-match-mode="${word ? 'word' : 'substring'}"
                  title="${word ? t('campaigns.mode.word.hint') : t('campaigns.mode.substring.hint')}">
                <i data-lucide="${word ? 'target' : 'scan-text'}" aria-hidden="true"></i>
                <span class="sr-only">${t('campaigns.matchMode')}: </span>${word ? t('campaigns.mode.word') : t('campaigns.mode.substring')}
            </span>
        `;
    },

    /**
     * The outcome split `GET /campaigns` sends with each campaign: `{ delivered, by_design, actionable, pending }`, under
     * `counts.all` in the contract (specs/001-dashboard-ux/contracts/api.md) or flat under `counts`. Returns
     * `{ delivered, byDesign, actionable, pending }` as numbers, or null when the server did not send a usable one: the card then
     * falls back to `sent_count` / `failed_count`, which is what it showed before the split existed. A split missing one of the
     * three counts that matter is treated as absent, not as zeros: a number the server did not send is not a count of 0.
     */
    outcomeSplit(c) {
        const counts = c && c.counts;
        if (!counts || typeof counts !== 'object') return null;
        const source = counts.all && typeof counts.all === 'object' ? counts.all : counts;
        const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
        const delivered = num(source.delivered);
        const byDesign = num(source.by_design);
        const actionable = num(source.actionable);
        if (![delivered, byDesign, actionable].every(Number.isFinite)) return null;
        const pending = num(source.pending);
        return { delivered, byDesign, actionable, pending: Number.isFinite(pending) ? pending : 0 };
    },

    /**
     * The card's numbers. With the split (FR-002): delivered, handled by design (neutral: nothing to do), waiting to send, and
     * FAILED, which is only what the owner can act on. Red belongs to that last one alone, and only while it is above zero: a red
     * dot beside "0 failed" is a red that asks for nothing. Without the split, sent and failed as before.
     */
    renderStats(c) {
        const split = this.outcomeSplit(c);
        const n = (v) => UI.formatNumber(v);
        if (!split) {
            return html`
                <div class="campaign-stats">
                    <span class="campaign-stat"><span class="dot ok" aria-hidden="true"></span> ${t('campaigns.statSent', { count: n(c.sent_count) })}</span>
                    ${this.failedStat(c, Number(c.failed_count) || 0)}
                    <span class="campaign-stat text-muted">${t('campaigns.statTotal', { count: n(c.total_interactions) })}</span>
                </div>
            `;
        }
        return html`
            <div class="campaign-stats" data-outcomes="split">
                <span class="campaign-stat"><span class="dot ok" aria-hidden="true"></span> ${t('campaigns.stat.delivered', { count: n(split.delivered) })}</span>
                ${split.byDesign > 0 ? html`
                    <span class="campaign-stat text-muted" title="${t('campaigns.stat.byDesign.hint')}">
                        <span class="dot neutral" aria-hidden="true"></span> ${t('campaigns.stat.byDesign', { count: n(split.byDesign) })}
                    </span>
                ` : ''}
                ${split.pending > 0 ? html`
                    <span class="campaign-stat text-muted"><span class="dot neutral" aria-hidden="true"></span> ${t('campaigns.stat.pending', { count: n(split.pending) })}</span>
                ` : ''}
                ${this.failedStat(c, split.actionable)}
                <span class="campaign-stat text-muted">${t('campaigns.statTotal', { count: n(c.total_interactions) })}</span>
            </div>
        `;
    },

    /**
     * The failed count. C8: above zero it opens exactly those failures in the log (App.goWithQuery via app:navigate). At zero it is
     * plain text with a neutral dot: a link to an empty list is a control that does nothing, and a red dot beside it a red that
     * needs nothing.
     */
    failedStat(c, count) {
        const label = t('campaigns.statFailed', { count: UI.formatNumber(count) });
        if (count > 0) {
            return html`
                <button type="button" class="campaign-stat campaign-stat-link"
                        data-action="app:navigate" data-target="activity"
                        data-query="${new URLSearchParams({ campaign: String(c.id), status: 'FAILED' }).toString()}"
                        title="${t('campaigns.openFailed')}">
                    <span class="dot bad" aria-hidden="true"></span> ${label}
                    <span class="sr-only">${t('campaigns.openFailed')}</span>
                </button>
            `;
        }
        return html`<span class="campaign-stat"><span class="dot neutral" aria-hidden="true"></span> ${label}</span>`;
    },

    // ─── Keyword hazard analysis ─────────────────────────────────────────────

    splitKeywords(value) {
        // Both commas: the placeholder shows «،» and an Arabic keyboard types it.
        // matching.ts splits the same way, so what the inspector sees is what fires.
        return String(value || '').split(/[,،]/).map((k) => k.trim()).filter(Boolean);
    },

    /**
     * Common Arabic words used to DEMONSTRATE a false positive, rather than
     * just asserting one. These are ordinary comment vocabulary — the point is
     * that the operator sees `اهتمام` listed under `تم` and understands the
     * failure without having to imagine it.
     */
    COMMON_WORDS: [
        'اهتمام', 'تمام', 'يتم', 'اهتم', 'تمت', 'مهتم', 'التمام', 'استمرار',
        'كتاب', 'كتابه', 'مكتوب', 'كتب',
        'سلام', 'السلام', 'اسلام', 'تسليم', 'مسلم',
        'شكرا', 'مشكور', 'الشكر',
        'ممكن', 'يمكن', 'امكانيه', 'مكان',
        'جميل', 'تجميل', 'جمال',
        'رابط', 'روابط', 'مرتبط',
        'كورس', 'كورسات', 'الكورس',
        'حساب', 'حسابي', 'محاسبه', 'الحساب',
        'دوره', 'دورات', 'الدوره', 'مدور',
        'سعر', 'اسعار', 'التسعير', 'مسعر',
        'خصم', 'خصومات', 'شخص', 'شخصي',
        'برمجه', 'مبرمج', 'البرنامج', 'برنامج',
        'عمل', 'اعمال', 'معلم', 'علم', 'تعليم', 'معلومات',
        'جديد', 'تجديد', 'جد', 'جدا',
        'نعم', 'انعام', 'طعم',
        'ابي', 'حبيبي', 'تجربه', 'جربت',
        'ارجو', 'الرجاء', 'راجع',
        'وين', 'اين', 'عين', 'زين',
        'كم', 'كمال', 'اكمل', 'يكمل', 'حكم', 'حكمه',
        'هل', 'اهلا', 'سهل', 'مهله', 'جاهل',
        'من', 'ممتاز', 'امن', 'زمن', 'ثمن', 'يمن',
    ],

    /**
     * Arabic inflections of the keyword itself — كورس → كورسات, الكورس — are
     * matches the operator WANTS. Flagging them would make the warning noise,
     * and a warning that cries wolf on every keyword is worse than none.
     * A candidate only counts as a false positive if it is not one of these.
     */
    SUFFIXES: ['ات', 'ون', 'ين', 'ان', 'ها', 'هم', 'يه', 'ه', 'ي', 'ك', 'نا'],

    isMorphologicalVariant(candidate, keyword) {
        if (candidate === keyword) return true;
        // Definite article, with or without a suffix on top of it.
        const bare = candidate.startsWith('ال') ? candidate.slice(2) : candidate;
        if (bare === keyword) return true;
        if (!bare.startsWith(keyword)) return false;
        const suffix = bare.slice(keyword.length);
        return this.SUFFIXES.includes(suffix);
    },

    /**
     * What will this keyword also match? Runs the same normalisation the
     * webhook runs, then looks for common words that CONTAIN it but are not
     * inflections of it. Returns { risky, examples, reason }.
     *
     * `mode` is the campaign's match mode. In `'word'` mode the keyword is anchored to word boundaries, so it cannot fire inside
     * a longer word and there is nothing to warn about: a warning here would be false (CA-08). Any other value is substring,
     * the default, which is how the server reads it.
     */
    keywordRisk(keyword, mode) {
        if (mode === 'word') return { risky: false, examples: [], reason: null };
        const normalized = UI.normalizeArabic(keyword);
        if (!normalized) return { risky: false, examples: [], reason: null };

        // A keyword with a space is a phrase; substring matching on a phrase is
        // specific enough that false positives stop being a practical worry.
        if (/\s/.test(normalized)) return { risky: false, examples: [], reason: null };

        const examples = [];
        for (const word of this.COMMON_WORDS) {
            const nWord = UI.normalizeArabic(word);
            if (nWord === normalized) continue;
            if (!nWord.includes(normalized)) continue;
            if (this.isMorphologicalVariant(nWord, normalized)) continue;
            examples.push(word);
            if (examples.length === 4) break;
        }

        // Latin keywords are just as exposed: "ai" matches "email", "said".
        if (examples.length > 0) return { risky: true, examples, reason: 'examples' };
        if (normalized.length <= 3) return { risky: true, examples: [], reason: 'short' };
        return { risky: false, examples: [], reason: null };
    },

    // ─── Collisions with the other campaigns: the server's rule, not a client copy ───

    /**
     * Which campaign answers a comment is decided by `matchCampaign` on the server: every live campaign that fires, ranked by
     * "tied to a post", then the length of the whole keyword list, then newest, and the FIRST one answers. A client copy of that
     * drifted (it called «كورس» against «الكورس» safe, and said both campaigns "could trigger" when only one ever does: CA-07),
     * so the editor asks the dry run, `POST /api/campaigns/try`, with the draft it is holding: once per keyword, the keyword
     * itself standing in as the comment (research R-06). The answer is the winner and why.
     *
     * Two answers are worth saying:
     *   - another campaign answers that keyword's comments, so THIS one never fires on them (`shadowed`);
     *   - this one answers, and at least one other campaign also matches, so THAT one never fires on them (`first`).
     * A keyword nobody else matches says nothing. The check is only ever allowed to say "safe" once EVERY keyword has been
     * answered: while it runs, or when it could not run, the inspector says so instead (constitution III: silence never
     * reads as success).
     */
    COLLISION_DEBOUNCE_MS: 450,
    /** The most keywords one check asks about; the rest are said not to have been checked. */
    COLLISION_MAX_KEYWORDS: 20,

    _collide: { seq: 0, keywordsKey: '', fullKey: '', state: 'idle', rows: [], failed: 0, unchecked: 0 },
    _collideDebounced: null,

    /** Forget any answer, and any check still on its way (the editor was opened or closed, or the tenant changed). */
    resetCollisions() {
        if (this._collideDebounced) this._collideDebounced.cancel();
        this._collide = { seq: this._collide.seq + 1, keywordsKey: '', fullKey: '', state: 'idle', rows: [], failed: 0, unchecked: 0 };
    },

    /** The keywords and the mode: what the answer is about as far as the inspector's text goes. Whitespace and case in the field do not change it. */
    keywordsKey(value, mode) {
        return `${mode === 'word' ? 'word' : 'substring'}|${this.splitKeywords(value).join('|')}`;
    },

    /** The editor's draft, read off its form: the id it edits (none for a new one), the keywords, the mode and the post it is tied to. */
    draftOf(form) {
        const field = (selector) => (form && typeof form.querySelector === 'function' ? form.querySelector(selector) : null);
        const trigger = field('#campaign-trigger');
        const mode = field('#campaign-match-mode');
        const post = field('#campaign-post-id');
        return {
            id: form && form.dataset && form.dataset.id ? String(form.dataset.id) : null,
            trigger_keyword: trigger ? String(trigger.value || '') : '',
            match_mode: mode && mode.value === 'word' ? 'word' : 'substring',
            post_id: post ? String(post.value || '').trim() : '',
        };
    },

    /**
     * After any change to the draft: say "checking" now, and ask the server once the typing pauses. Unchanged since the last
     * check (a repaint, a focus), it does nothing. `now` asks at once (the editor was just opened); `force` asks again though
     * nothing changed (Retry).
     */
    queueCollisionCheck(form, { now = false, force = false } = {}) {
        const draft = this.draftOf(form);
        const keywords = this.splitKeywords(draft.trigger_keyword);
        if (keywords.length === 0) { this.resetCollisions(); return; }

        const fullKey = JSON.stringify([draft.id, this.keywordsKey(draft.trigger_keyword, draft.match_mode), draft.post_id]);
        if (!force && this._collide.fullKey === fullKey) return;

        const seq = this._collide.seq + 1;
        this._collide = {
            seq, keywordsKey: this.keywordsKey(draft.trigger_keyword, draft.match_mode), fullKey,
            state: 'checking', rows: [], failed: 0, unchecked: 0,
        };
        if (this._collideDebounced) this._collideDebounced.cancel();
        if (now) { this.runCollisionCheck(draft, seq); return; }
        if (!this._collideDebounced) {
            this._collideDebounced = Motion.debounce((d, s) => this.runCollisionCheck(d, s), this.COLLISION_DEBOUNCE_MS);
        }
        this._collideDebounced(draft, seq);
    },

    /**
     * One `POST /campaigns/try` per distinct keyword of the draft, in parallel. The draft is sent as live (`is_active: true`) even
     * when its switch is off: the question is what happens WHEN it is on, and a paused draft matches nothing, so it would never
     * be shadowed by anything. A later answer for a newer draft (a higher `seq`) wins; this one is dropped.
     */
    async runCollisionCheck(draft, seq) {
        const seen = new Set();
        const distinct = [];
        for (const keyword of this.splitKeywords(draft.trigger_keyword)) {
            const key = UI.normalizeArabic(keyword);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            distinct.push(keyword);
        }
        const asked = distinct.slice(0, this.COLLISION_MAX_KEYWORDS);
        const postId = draft.post_id || null;

        // `async`, so a call that throws before it returns a promise is a failed check like any other, not an unhandled rejection.
        const settled = await Promise.allSettled(asked.map(async (keyword) => API.tryCampaign({
            comment: keyword,
            postId,
            draft: {
                id: draft.id,
                trigger_keyword: draft.trigger_keyword,
                match_mode: draft.match_mode,
                post_id: postId,
                is_active: true,
            },
        })));
        if (seq !== this._collide.seq) return;

        const rows = [];
        let failed = 0;
        settled.forEach((outcome, i) => {
            if (outcome.status !== 'fulfilled') { failed++; return; }
            const row = this.collisionRow(asked[i], outcome.value);
            if (row && !rows.some((r) => r.kind === row.kind && r.keyword === row.keyword && r.otherId === row.otherId)) rows.push(row);
        });
        this._collide = {
            ...this._collide,
            state: failed > 0 ? 'failed' : 'done',
            rows, failed, unchecked: distinct.length - asked.length,
        };
        // Repaint the verdict only: the keywords field, and whatever the owner is typing in it, are not touched.
        this.inspect(draft.trigger_keyword, draft.match_mode);
    },

    /** What one `/campaigns/try` answer says about one keyword: a collision row, or null when nobody else is involved. */
    collisionRow(keyword, answer) {
        const winner = answer && answer.winner;
        if (!winner) return null;
        if (winner.id !== 'draft') {
            const keywords = Array.isArray(winner.keywords) ? winner.keywords.filter((k) => typeof k === 'string' && k) : [];
            return { kind: 'shadowed', keyword, otherId: String(winner.id), other: keywords.join('، ') || String(winner.matched || '') };
        }
        // The draft answers. `only_match` means no other campaign fired; any other reason names the tier it beat someone on.
        if (winner.reason && winner.reason !== 'only_match') return { kind: 'first', keyword, otherId: '', other: '' };
        return null;
    },

    /** The bidi isolate around text of an unknown direction (a keyword) inside a sentence of the other direction. */
    iso(value) {
        return `⁨${value}⁩`;
    },

    /**
     * A collision as a list row: the sentence, and what the owner can do about it. "Use whole-word mode" only where it is not
     * already the mode; "Edit the other campaign" only where that campaign is one this page knows. The answer after either is
     * the server's again, so an action that does not clear the collision does not claim to.
     */
    renderCollision(row, mode) {
        const known = row.kind === 'shadowed' && this.campaigns.some((c) => String(c.id) === row.otherId);
        const actions = [];
        if (row.kind === 'shadowed' && mode !== 'word') {
            actions.push(UI.button({
                variant: 'secondary', size: 'sm', icon: 'target', label: t('campaigns.try.useWord'),
                action: 'campaigns:useWholeWord',
            }));
        }
        if (known) {
            actions.push(UI.button({
                variant: 'secondary', size: 'sm', icon: 'pencil', label: t('campaigns.try.editOther'),
                action: 'campaigns:editOther', data: { id: row.otherId },
            }));
        }
        return html`
            <li dir="auto" data-collision="${row.kind}">
                ${row.kind === 'shadowed'
                    ? t('campaigns.try.shadowed', { keyword: this.iso(row.keyword), other: this.iso(row.other) })
                    : t('campaigns.try.first', { keyword: this.iso(row.keyword) })}
                ${actions.length ? html`<span class="row gap-2 row--wrap mbs-2">${actions}</span>` : ''}
            </li>
        `;
    },

    /** The mode select was set to whole word by the "Use whole-word mode" action: the same as choosing it, then the check runs again. */
    useWholeWord(el) {
        const form = el && typeof el.closest === 'function' ? el.closest('form') : null;
        const select = (form && form.querySelector('#campaign-match-mode')) || document.getElementById('campaign-match-mode');
        if (!select) return;
        select.value = 'word';
        // A script setting `value` fires no `change`: do what that handler does, then leave focus on the control that changed.
        this.reinspect(select);
        if (typeof select.focus === 'function') select.focus();
    },

    /**
     * Open the other campaign's editor in place of this one. Unsaved edits here would be lost with it, so when there are any
     * the owner is asked first, over the editor (the same question closing it asks).
     */
    editOther(id) {
        if (!this.campaigns.some((c) => String(c.id) === String(id))) return;
        if (UI.isModalDirty()) {
            UI.confirm({
                stack: true,
                title: t('ui.discard.title'),
                body: t('common.discardConfirm'),
                confirmLabel: t('ui.discard.confirm'),
                cancelLabel: t('ui.discard.keep'),
                onConfirm: () => { UI.closeModal(); this.showEditModal(String(id)); },
            });
            return;
        }
        this.showEditModal(String(id));
    },

    /** Ask again after a check that could not run. */
    retryCollisions(el) {
        const form = el && typeof el.closest === 'function' ? el.closest('form') : document.getElementById('campaign-form');
        if (form) this.queueCollisionCheck(form, { now: true, force: true });
        this.inspect(this.draftOf(form).trigger_keyword, this.draftOf(form).match_mode);
    },

    /**
     * What this keyword will also fire on. Computed on every keystroke, so the
     * warning appears at the moment of the decision rather than after the
     * campaign has been live for a week.
     *
     * Returns { state, hasProblem, verdict } rather than the whole inspector,
     * because the container and the static explanation must NOT be rebuilt —
     * see renderMatchInspector() and inspect() below.
     */
    matchVerdict(value, mode) {
        // Whole-word mode anchors the keyword to token boundaries, so the
        // "fires inside a longer word" hazard does not apply; duplicates and
        // collisions with another campaign still do.
        const keywords = this.splitKeywords(value);
        const seen = new Set();
        const duplicates = [];
        const risks = [];

        keywords.forEach((k) => {
            const n = UI.normalizeArabic(k);
            if (seen.has(n)) duplicates.push(k); else seen.add(n);
            const risk = this.keywordRisk(k, mode);
            if (risk.risky) risks.push({ keyword: k, ...risk });
        });

        // The other campaigns' answer, from the server (see "Collisions" above), and only when it is about THESE keywords in
        // THIS mode: an answer for what was typed a moment ago is not an answer. Until it is in, the inspector says it is
        // checking; if it could not run, it says that. Neither is "safe".
        const answer = this._collide;
        const current = keywords.length > 0 && answer.keywordsKey === this.keywordsKey(value, mode);
        const checking = keywords.length > 0 && (!current || answer.state === 'checking' || answer.state === 'idle');
        const failed = current && answer.state === 'failed';
        const collisions = current ? answer.rows : [];
        const unchecked = current ? answer.unchecked : 0;

        const hasProblem = risks.length > 0 || duplicates.length > 0 || collisions.length > 0;
        const safe = keywords.length > 0 && !hasProblem && current && answer.state === 'done' && unchecked === 0;

        return {
            hasProblem,
            state: keywords.length === 0 ? '' : (hasProblem ? 'is-risky' : (safe ? 'is-safe' : '')),
            verdict: html`
                ${safe ? html`<p class="text-success">${t('campaigns.match.safe')}</p>` : ''}
                ${hasProblem ? html`
                    <ul class="match-risk-list">
                        ${collisions.map((row) => this.renderCollision(row, mode))}
                        ${risks.map((r) => html`
                            <li dir="auto">
                                ${r.reason === 'examples'
                                    ? html`${t('campaigns.match.riskRow', { keyword: r.keyword, examples: '' })}<span class="match-example" lang="ar">${r.examples.join('، ')}</span>`
                                    : t('campaigns.match.riskGeneric', { keyword: r.keyword, length: UI.formatNumber(UI.normalizeArabic(r.keyword).length) })}
                            </li>
                        `)}
                        ${duplicates.map((d) => html`<li dir="auto">${t('campaigns.match.duplicate', { keyword: d })}</li>`)}
                    </ul>
                    ${risks.length > 0 ? html`<p class="mbs-4">${t('campaigns.match.advice')} ${t('campaigns.match.adviceWord')}</p>` : ''}
                ` : ''}
                <!-- Said, not left out: with no word about the other campaigns this would read as "none clash". While it runs the
                     line is hidden from assistive technology (the live region would speak it after every pause in typing); the
                     answer, when it lands, is spoken. -->
                ${checking ? html`<p class="form-hint" aria-hidden="true">${t('campaigns.try.checking')}</p>` : ''}
                ${failed ? html`
                    <p class="text-warning mbs-2" dir="auto">
                        <i data-lucide="alert-triangle" aria-hidden="true"></i> ${t('campaigns.try.failed')}
                    </p>
                    ${UI.button({
                        variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'),
                        action: 'campaigns:retryCollisions',
                    })}
                ` : ''}
                ${unchecked > 0 ? html`<p class="form-hint" dir="auto">${t('campaigns.try.partial', { count: UI.formatNumber(this.COLLISION_MAX_KEYWORDS) })}</p>` : ''}
            `,
        };
    },

    /**
     * The inspector under the keyword field.
     *
     * The live region is the INNER div and it is permanent. The old version
     * put aria-live on the outer container and then replaced that container
     * on every keystroke — and a live region that is destroyed and recreated
     * announces nothing at all, because there is no region in the
     * accessibility tree for the change to be a change TO. So the single most
     * expensive warning this product can give — that "تم" also fires inside
     * اهتمام, تمام and يتم — was never once spoken.
     *
     * The static explanation sits OUTSIDE the region too, so what gets
     * announced is the verdict and not the paragraph about how matching works,
     * repeated on every keystroke.
     */
    matchExplain(mode) {
        return mode === 'word' ? t('campaigns.match.wordMode') : t('campaigns.match.explain');
    },

    renderMatchInspector(value, mode) {
        const { state, hasProblem, verdict } = this.matchVerdict(value, mode);
        return html`
            <div class="match-inspector ${html.raw(state)}" id="match-inspector">
                <h4 id="match-inspector-heading">
                    <i data-lucide="${hasProblem ? 'alert-triangle' : 'search-check'}" aria-hidden="true"></i>
                    ${t('campaigns.match.title')}
                </h4>
                <p><span id="match-inspector-explain">${this.matchExplain(mode)}</span> ${UI.helpLink('campaigns#matching', t('help.link.matching'), { newTab: true })}</p>
                <div id="match-inspector-verdict" aria-live="polite">${verdict}</div>
            </div>
        `;
    },

    /**
     * Live update from the keyword input — but not on the typing path.
     *
     * This is the heaviest per-keystroke handler in the dashboard: for every
     * comma-separated keyword it runs the webhook's own Arabic normalisation
     * (a five-regex chain) against a 60-word corpus, normalising each corpus
     * word too, then rebuilds the inspector's DOM. At one keyword that is ~120
     * regex passes per character typed, and at four keywords it is ~480 —
     * enough to show up between a key press and the glyph appearing on a
     * phone.
     *
     * The work is now trailing-debounced at 140ms, which is under the ~200ms
     * at which a reaction stops feeling immediate and well past the gap
     * between two keystrokes. The verdict still appears while the operator is
     * looking at the field, which was the whole point of it.
     */
    inspect(value, mode) {
        const host = document.getElementById('match-inspector');
        const verdictHost = document.getElementById('match-inspector-verdict');
        if (!host || !verdictHost) return;

        const { state, hasProblem, verdict } = this.matchVerdict(value, mode);
        const explain = document.getElementById('match-inspector-explain');
        if (explain) explain.textContent = this.matchExplain(mode);

        // Only the CONTENTS of the permanent live region are written. The
        // region itself, the heading and the explanation stay put — replacing
        // them is what silenced the warning.
        host.className = `match-inspector${state ? ` ${state}` : ''}`;
        verdictHost.innerHTML = esc(verdict);

        // The icon is outside the region, so swapping it announces nothing.
        const icon = host.querySelector('#match-inspector-heading i, #match-inspector-heading svg');
        if (icon) {
            const next = document.createElement('i');
            next.setAttribute('data-lucide', hasProblem ? 'alert-triangle' : 'search-check');
            next.setAttribute('aria-hidden', 'true');
            icon.replaceWith(next);
        }
        UI.icons(host);
    },

    _inspectDebounced: null,

    inspectKeywords(input) {
        if (!this._inspectDebounced) {
            this._inspectDebounced = Motion.debounce((value, mode) => this.inspect(value, mode), 140);
        }
        // `input.form` is the standard DOM link from a field to its owning <form>. The edit form's data-id (set in
        // showEditModal()) is how "the campaign being edited" is told apart from the other campaigns: the draft sent to the
        // server for the collision check carries it, so the stored copy of this campaign is replaced and never collides with itself.
        const modeSelect = input.form ? input.form.querySelector('#campaign-match-mode') : null;
        // The collision check first: it puts "checking" in place at once, so the repaint below never shows an old answer's "safe".
        this.queueCollisionCheck(input.form);
        this._inspectDebounced(input.value, modeSelect ? modeSelect.value : 'substring');
    },

    /** The mode (or the post the campaign is tied to) changed: re-inspect the keywords under the new rule. */
    reinspect(el) {
        const trigger = el && el.form ? el.form.querySelector('#campaign-trigger') : null;
        if (trigger) this.inspectKeywords(trigger);
    },

    matchModeChange(select) {
        this.reinspect(select);
    },

    // ─── Modals ──────────────────────────────────────────────────────────────
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

    keywordField(value, mode) {
        const word = mode === 'word';
        return html`
            <div class="form-group">
                <label class="form-label" for="campaign-trigger">${t('campaigns.keywords')}</label>
                <input class="field" id="campaign-trigger" name="trigger_keyword" dir="auto"
                       value="${value || ''}" placeholder="${t('campaigns.keywordsPlaceholder')}"
                       aria-describedby="campaign-trigger-hint"
                       data-input="campaigns:inspectKeywords" data-guard-dirty required>
                <p class="form-hint" id="campaign-trigger-hint">${t('campaigns.keywordsHint')}</p>
            </div>
            <!-- match_mode has existed end to end since migration_v14 (validated and
                 stored by the API, honoured by matching.ts); this is the first
                 control that can set it. The header comment above that said the
                 column did not exist was stale. -->
            <div class="form-group">
                <label class="form-label" for="campaign-match-mode">${t('campaigns.matchMode')}</label>
                <select class="select" id="campaign-match-mode" name="match_mode"
                        aria-describedby="campaign-match-mode-hint"
                        data-change="campaigns:matchModeChange" data-guard-dirty>
                    <option value="substring" ${word ? '' : html.raw('selected')}>${t('campaigns.matchMode.substring')}</option>
                    <option value="word" ${word ? html.raw('selected') : ''}>${t('campaigns.matchMode.word')}</option>
                </select>
                <p class="form-hint" id="campaign-match-mode-hint">${t('campaigns.matchMode.hint')}</p>
                ${this.renderMatchInspector(value || '', mode)}
            </div>
        `;
    },

    postIdField(value) {
        return html`
            <div class="form-group">
                <label class="form-label" for="campaign-post-id">
                    ${t('campaigns.postId')} <span class="label-optional">${t('common.optional')}</span>
                </label>
                <div class="field-row">
                    <!-- data-input: the post a campaign is tied to is part of the draft the collision check sends (a campaign tied to a
                         post outranks one that answers every post), so changing it asks again. -->
                    <input class="field" id="campaign-post-id" name="post_id" value="${value}"
                           inputmode="numeric" dir="ltr" placeholder="17841459652725922"
                           data-input="campaigns:draftChange">
                    <!-- This button toggles the panel below it, which is a
                         disclosure — and it said nothing about that. A screen
                         reader announced "Pick a post, button", the operator
                         pressed it, and the only feedback that a list had
                         appeared was that the list had appeared, which is not
                         feedback they get. aria-expanded/aria-controls are kept
                         in step by togglePicker() below. -->
                    ${UI.button({
                        variant: 'secondary', size: 'sm', className: 'shrink-0',
                        icon: 'image', label: t('campaigns.pickPost'),
                        action: 'campaigns:openPostPicker', id: 'campaign-post-picker-btn',
                    })}
                </div>
                <div id="post-picker-container" class="post-picker hidden" role="group"
                     aria-label="${t('campaigns.pickPost')}"></div>
                <p class="form-hint">${t('campaigns.postIdHint')}</p>
            </div>
        `;
    },

    showCreateModal() {
        // A new editor starts with no answer about the other campaigns: the last one was about another draft.
        this.resetCollisions();
        UI.showModal(html`
            ${this.modalHeader(t('campaigns.createTitle'))}
            <form id="campaign-form" data-submit="campaigns:handleCreate">
                <div id="campaign-form-error"></div>
                ${this.keywordField('')}
                <div class="form-group">
                    <label class="form-label" for="campaign-dm">${t('campaigns.dmTemplate')}</label>
                    <!-- data-guard-dirty: closing this modal by Escape, by the
                         overlay or by Cancel now asks before throwing a
                         half-written template away. lang="ar" because the
                         template is always Arabic. -->
                    <textarea class="field-textarea user-content" id="campaign-dm" name="dm_template" dir="auto" lang="ar"
                              placeholder="${t('campaigns.dmPlaceholder')}" aria-describedby="campaign-dm-hint" data-guard-dirty required></textarea>
                    <p class="form-hint" id="campaign-dm-hint">${t('campaigns.dmHint')} ${UI.helpLink('campaigns#dm', t('help.link.campaignDm'), { newTab: true })}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="campaign-public">
                        ${t('campaigns.publicReply')} <span class="label-optional">${t('common.optional')}</span>
                    </label>
                    <input class="field" id="campaign-public" name="public_reply_template" dir="auto" lang="ar"
                           aria-describedby="campaign-public-hint"
                           placeholder="${t('campaigns.publicReplyPlaceholder')}" data-guard-dirty>
                    <p class="form-hint" id="campaign-public-hint">${t('campaigns.publicReplyHint')}</p>
                </div>
                ${this.postIdField('')}
                <div class="modal-actions">
                    ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'plus', label: t('common.create') })}
                </div>
            </form>
        `);
    },

    showEditModal(id) {
        const c = this.campaigns.find((x) => x.id === id);
        if (!c) return;

        this.resetCollisions();
        UI.showModal(html`
            ${this.modalHeader(t('campaigns.editTitle'))}
            <form id="campaign-form" data-submit="campaigns:handleEdit" data-id="${c.id}">
                <div id="campaign-form-error"></div>
                ${this.keywordField(c.trigger_keyword, this.modeOf(c))}
                <div class="form-group">
                    <label class="form-label" for="campaign-dm">${t('campaigns.dmTemplate')}</label>
                    <textarea class="field-textarea user-content" id="campaign-dm" name="dm_template" dir="auto" lang="ar"
                              aria-describedby="campaign-dm-hint" data-guard-dirty required>${c.dm_template}</textarea>
                    <p class="form-hint" id="campaign-dm-hint">${t('campaigns.dmHint')} ${UI.helpLink('campaigns#dm', t('help.link.campaignDm'), { newTab: true })}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="campaign-public">
                        ${t('campaigns.publicReply')} <span class="label-optional">${t('common.optional')}</span>
                    </label>
                    <input class="field" id="campaign-public" name="public_reply_template" dir="auto" lang="ar"
                           aria-describedby="campaign-public-hint" data-guard-dirty
                           value="${c.public_reply_template || ''}" placeholder="${t('campaigns.publicReplyPlaceholder')}">
                    <p class="form-hint" id="campaign-public-hint">${t('campaigns.publicReplyHint')}</p>
                </div>
                ${this.postIdField(c.post_id || '')}
                <div class="form-group switch-row">
                    <label class="switch" for="campaign-active-toggle">
                        <input type="checkbox" id="campaign-active-toggle" name="is_active" ${c.is_active !== false ? html.raw('checked') : ''}>
                        <span class="switch-track"></span>
                    </label>
                    <label class="switch-label" for="campaign-active-toggle">${t('campaigns.toggleLabel')}</label>
                </div>
                <div class="modal-actions">
                    ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                    ${UI.button({ variant: 'primary', type: 'submit', icon: 'check', label: t('common.save') })}
                </div>
            </form>
        `);
        // The campaign being edited already has keywords: ask about them now, not only after the first keystroke.
        this.queueCollisionCheck(document.getElementById('campaign-form'), { now: true });
    },

    /**
     * A create cannot be optimistic: the row's id comes from the server and the
     * server is the only thing that can reject the keyword. What it CAN do is
     * stop looking dead while it works — the submit button used to sit there
     * unchanged until the response came back.
     */
    /** Now one implementation, shared with posts.js and settings.js. */
    _busy(form, running) {
        return UI.formBusy(form, running);
    },

    async handleCreate(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const restore = this._busy(form, t('common.saving'));
        if (!restore) return; // already in flight
        try {
            await API.createCampaign({
                trigger_keyword: data.get('trigger_keyword'),
                match_mode: data.get('match_mode') === 'word' ? 'word' : 'substring',
                dm_template: data.get('dm_template'),
                public_reply_template: data.get('public_reply_template') || null,
                post_id: data.get('post_id') || null,
            });
            UI.toast(t('campaigns.created'));
            // render() FIRST, closeModal() after. The other order restored
            // focus to the "New campaign" button and then destroyed it in the
            // re-render, which left focus on a button inside a display:none
            // overlay — i.e. on <body>. closeModal() re-finds the trigger by
            // key in the freshly rendered toolbar.
            await this.render();
            UI.closeModal();
        } catch (err) {
            restore();
            this.showFormError(err);
        }
    },

    /**
     * A rejected save used to go to a corner toast while the modal kept focus and
     * no field was marked. Posts already does this right; same shape here.
     */
    showFormError(err) {
        const message = (err && err.message) || t('error.unexpected');
        const host = document.getElementById('campaign-form-error');
        if (!host) { UI.toast(message, 'error'); return; }
        const form = document.getElementById('campaign-form');
        UI.clearInvalid(form);
        const stripId = 'campaign-form-error-strip';
        host.innerHTML = esc(UI.errorStrip(message, '', stripId));
        UI.icons(host);
        const trigger = err && err.status === 400 ? document.getElementById('campaign-trigger') : null;
        if (trigger) UI.markInvalid(trigger, stripId);
        if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    },

    async handleEdit(form, event) {
        event.preventDefault();
        const id = form.dataset.id;
        const data = new FormData(form);
        const restore = this._busy(form, t('common.saving'));
        if (!restore) return; // already in flight
        try {
            await API.updateCampaign(id, {
                trigger_keyword: data.get('trigger_keyword'),
                match_mode: data.get('match_mode') === 'word' ? 'word' : 'substring',
                dm_template: data.get('dm_template'),
                public_reply_template: data.get('public_reply_template') || null,
                post_id: data.get('post_id') || null,
                is_active: data.get('is_active') === 'on',
            });
            UI.toast(t('campaigns.updated'));
            // Render, then close — focus lands back on this card's Edit button.
            await this.render();
            UI.closeModal();
        } catch (err) {
            restore();
            this.showFormError(err);
        }
    },

    /**
     * Pausing a campaign is one boolean, and the operator has already moved
     * the switch. Waiting for the server, then re-fetching the whole list, then
     * rebuilding every card was three round trips of latency to show a state
     * the screen was already showing.
     *
     * Now the card dims immediately and the request goes out behind it. If it
     * fails, the switch and the card go back to where they were and the error
     * is named — the screen is allowed to be ahead of the server, never wrong
     * about it.
     */
    toggleActive(id, isChecked) {
        const campaign = this.campaigns.find((x) => String(x.id) === String(id));
        const previous = campaign ? campaign.is_active !== false : !isChecked;
        const card = document.querySelector(`.campaign-card[data-id="${CSS.escape(String(id))}"]`);
        const input = card && card.querySelector('input[type="checkbox"]');

        const paint = (active) => {
            if (campaign) campaign.is_active = active;
            if (card) card.classList.toggle('is-paused', !active);
            if (input && input.checked !== active) input.checked = active;
        };

        paint(isChecked);

        return Motion.optimistic({
            // Send the WHOLE row, not just is_active. PUT /campaigns/:id assigns
            // public_reply_template and post_id unconditionally — deliberately, so both can be
            // cleared — so a partial body sends them as undefined -> null. A one-click pause was
            // erasing the campaign's public reply and its post targeting, with no undo.
            send: () => API.updateCampaign(id, {
                trigger_keyword: campaign && campaign.trigger_keyword,
                dm_template: campaign && campaign.dm_template,
                public_reply_template: (campaign && campaign.public_reply_template) || null,
                post_id: (campaign && campaign.post_id) || null,
                match_mode: campaign && campaign.match_mode,
                is_active: isChecked,
            }),
            revert: () => paint(previous),
            onError: (err) => UI.toast((err && err.message) || t('common.error'), 'error'),
        });
    },

    confirmDelete(id, keyword) {
        UI.showModal(html`
            ${this.modalHeader(t('campaigns.deleteTitle'))}
            <p class="modal-body-text" dir="auto">${t('campaigns.deleteBody', { keyword })}</p>
            <p class="form-hint">${t('campaigns.deleteWarning')}</p>
            <div class="modal-actions">
                ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                ${UI.button({
                    variant: 'danger', icon: 'trash-2', label: t('common.delete'),
                    action: 'campaigns:handleDelete', data: { id },
                })}
            </div>
        `);
    },

    /**
     * The confirmation modal already asked. Once the operator has said yes,
     * the card goes immediately and the DELETE follows it; a failure puts the
     * card back where it was, at its old index, and says why.
     */
    handleDelete(id) {
        const index = this.campaigns.findIndex((x) => String(x.id) === String(id));
        if (index === -1) return Promise.resolve();
        const removed = this.campaigns[index];
        const card = document.querySelector(`.campaign-card[data-id="${CSS.escape(String(id))}"]`);

        const countEl = document.querySelector('.page-toolbar-count');
        const paintCount = () => {
            if (countEl) countEl.textContent = t('campaigns.count', { count: this.campaigns.length });
        };

        this.campaigns.splice(index, 1);
        if (card) card.remove();
        paintCount();

        // Closed AFTER the card is gone, so closeModal() does not restore
        // focus to a button it is about to lose — with the card removed there
        // is nothing to return to and focus goes to the page region instead.
        UI.closeModal();
        Motion.announce(t('campaigns.count', { count: this.campaigns.length }));

        return Motion.optimistic({
            send: () => API.deleteCampaign(id),
            revert: () => {
                this.campaigns.splice(index, 0, removed);
                // The card element is gone; the grid is the honest way back.
                this.renderGrid();
                paintCount();
            },
            onError: (err) => UI.toast((err && err.message) || t('campaigns.deleteFailed'), 'error'),
        });
    },

    /** Re-paint just the card grid from `this.campaigns`, with no fetch. */
    renderGrid() {
        const grid = document.querySelector('.card-grid');
        if (!grid) { this.render(); return; }
        const focus = UI.captureFocus(grid);
        grid.innerHTML = esc(html`${this.campaigns.map((c) => this.renderCard(c))}`);
        UI.icons(grid);
        UI.revealClipped(grid);
        UI.restoreFocus(focus);
    },

    // ─── Post picker ─────────────────────────────────────────────────────────
    /** Keep the panel's visibility and the trigger's `aria-expanded` together. */
    togglePicker(picker, btn, open) {
        if (picker) picker.classList.toggle('hidden', !open);
        if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    },

    async openPostPicker(btn) {
        const picker = document.getElementById('post-picker-container');
        if (!picker) return;

        if (!picker.classList.contains('hidden')) {
            this.togglePicker(picker, btn, false);
            return;
        }

        // Was hand-rolled with no `aria-busy`, and `buttonSpinner()` with no
        // argument relabels the button "Loading" — so the control the operator
        // just pressed lost its own name mid-request. actionBusy keeps it and
        // no-ops a second click, which used to fire a second /posts/live.
        const restore = UI.actionBusy(btn);
        if (!restore) return;

        try {
            const livePosts = await API.getLivePosts();
            this.togglePicker(picker, btn, true);

            if (!livePosts || livePosts.length === 0) {
                picker.innerHTML = esc(html`<p class="post-picker-note">${t('campaigns.postPickerEmpty')}</p>`);
            } else {
                picker.innerHTML = esc(html`
                    ${livePosts.map((p) => {
                        const media = safeUrl(p.media_url);
                        return html`
                            <button type="button" class="post-picker-item" data-action="campaigns:selectPickedPost" data-id="${p.id}">
                                ${media
                                    ? html`<img src="${media}" alt="">`
                                    : html`<span class="post-picker-thumb"><i data-lucide="${p.platform === 'facebook' ? 'facebook' : 'instagram'}" aria-hidden="true"></i></span>`}
                                <span class="post-picker-body">
                                    <span class="post-picker-id">${UI.ltr(p.id)}</span>
                                    <span class="post-picker-caption" dir="auto">${p.caption || t('posts.noCaption')}</span>
                                </span>
                            </button>
                        `;
                    })}
                `);
                UI.icons(picker);
            }
        } catch (err) {
            this.togglePicker(picker, btn, true);
            picker.innerHTML = esc(html`<p class="post-picker-note is-error" dir="auto">${t('campaigns.postPickerFailed', { message: err.message })}</p>`);
        } finally {
            restore();
        }
    },

    selectPickedPost(id) {
        const input = document.getElementById('campaign-post-id');
        if (input) input.value = id;
        // A script setting `value` fires no `input` event: the draft changed, so ask again.
        if (input) this.reinspect(input);
        const picker = document.getElementById('post-picker-container');
        const btn = document.getElementById('campaign-post-picker-btn');
        this.togglePicker(picker, btn, false);
        // The button the operator just pressed is inside the panel that has now
        // been hidden, so focus was about to land on <body> in the middle of a
        // modal. The field the choice just filled in is where they are going.
        if (input && typeof input.focus === 'function') input.focus();
    },

    // ─── CSV bulk import ─────────────────────────────────────────────────────
    triggerCSVSelect() {
        document.getElementById('csv-file-input').click();
    },

    handleCSVSelect(input) {
        const file = input.files && input.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const rows = this.parseCSV(event.target.result);
                if (rows.length <= 1) {
                    UI.toast(t('campaigns.bulk.emptyCsv'), 'error');
                    return;
                }

                const courseMap = {};
                // Neither skip below used to be counted or shown, so a CSV
                // with a few malformed rows imported silently short.
                let skippedRows = 0;
                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i];
                    if (row.length < 10) { skippedRows++; continue; }
                    const courseId = row[0].trim();
                    if (!courseId) { skippedRows++; continue; }

                    const redemptions = parseInt(row[3], 10) || 0;
                    if (!courseMap[courseId] || redemptions > courseMap[courseId].redemptions) {
                        courseMap[courseId] = {
                            id: courseId,
                            name: (row[1] || '').trim(),
                            couponType: (row[2] || '').trim(),
                            redemptions,
                            code: (row[4] || '').trim(),
                            startDate: (row[5] || '').trim(),
                            endDate: (row[6] || '').trim(),
                            url: (row[9] || '').trim(),
                        };
                    }
                }

                const uniqueCourses = Object.values(courseMap);
                if (uniqueCourses.length === 0) {
                    UI.toast(t('campaigns.bulk.noCourses'), 'error');
                    return;
                }

                if (skippedRows > 0) {
                    UI.toast(t('campaigns.bulk.rowsSkipped', { count: skippedRows }), 'error');
                }

                // The seeds are the tenant's own (their offers' campaigns), so they are asked for per import and
                // not cached: a tenant switch or a profile edit is then never answered with the last one's.
                const loaded = await this.loadSeeds();
                if (loaded === null) return;
                this.showBulkImportModal(uniqueCourses, loaded.seeds, loaded.fallback);
            } catch (err) {
                UI.toast(t('campaigns.bulk.parseError', { message: err.message }), 'error');
            }
        };
        reader.readAsText(file);
        input.value = '';
    },

    parseCSV(text) {
        const lines = [];
        let row = [''];
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            const next = text[i + 1];
            if (c === '"') {
                if (inQuotes && next === '"') {
                    row[row.length - 1] += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (c === ',' && !inQuotes) {
                row.push('');
            } else if ((c === '\r' || c === '\n') && !inQuotes) {
                if (c === '\r' && next === '\n') i++;
                lines.push(row);
                row = [''];
            } else {
                row[row.length - 1] += c;
            }
        }
        if (row.length > 1 || row[0] !== '') lines.push(row);
        return lines;
    },

    /**
     * The wording each imported course starts from: `GET /api/profile/campaign-seeds`, one seed per offer of the
     * ACTIVE tenant that has a campaign, in the order the import tries them, and the `fallback` a course no seed names
     * starts from. Both used to be in this file, nine entries of one creator's Arabic and a template of his; they are the
     * tenant's own now (docs/onboarding/05, P13 and P15).
     *
     * Resolves to `{ seeds, fallback }` (`seeds` empty for a tenant with no campaigns yet: every row is then generated
     * from the fallback), or to null when they could not be read: the caller stops there, because importing without the
     * seeds would quietly stamp generic text on courses that have curated copy, and a retry costs one click.
     */
    async loadSeeds() {
        try {
            const answer = await API.getCampaignSeeds();
            return {
                seeds: Array.isArray(answer && answer.seeds) ? answer.seeds : [],
                fallback: answer && answer.fallback ? answer.fallback : null,
            };
        } catch (err) {
            console.error('Campaign seeds error:', err);
            UI.toast(t('campaigns.bulk.seedsFailed'), 'error');
            return null;
        }
    },

    /**
     * The seed a course name picks: the first, in order, whose `name_match` the lower-cased name contains. A seed
     * with no `name_match` picks nothing (an empty string is a substring of every name).
     */
    seedFor(courseName, seeds) {
        const nameLower = String(courseName || '').toLowerCase();
        for (const seed of seeds) {
            const key = String((seed && seed.name_match) || '').trim().toLowerCase();
            if (key && nameLower.includes(key)) return seed;
        }
        return null;
    },

    /**
     * What a course no seed names starts from when the server sent no fallback: the link alone. It holds no words, so it
     * speaks no one's language; the operator edits it in the modal before anything is sent to a customer.
     */
    PLAIN_FALLBACK: Object.freeze({ dm_template: '{url}', public_reply_template: '' }),

    /**
     * A fallback DM with the course's name and link put in: `{name}` and `{url}`, in one pass, so a link that happens to
     * contain «{name}» is not read a second time. (`{username}` stays: the webhook fills it when the DM is sent.)
     */
    fillFallback(template, name, url) {
        return String(template).replace(/\{(name|url)\}/g, (_match, key) => (key === 'name' ? name : url));
    },

    showBulkImportModal(courses, seeds = [], fallback = null) {
        const fallbackLines = fallback && typeof fallback.dm_template === 'string' ? fallback : this.PLAIN_FALLBACK;
        const campaignData = courses.map((course, index) => {
            const mapping = this.seedFor(course.name, seeds);

            let triggerKeywords;
            let dmTemplate;
            let publicReplies;

            if (mapping) {
                triggerKeywords = mapping.trigger_keyword;
                dmTemplate = mapping.dm_template.replace(/{url}/g, course.url);
                publicReplies = mapping.public_reply_template;
            } else {
                const cleanName = String(course.name || '').split('[')[0].split('|')[0].split('-')[0].trim();
                // Only the course's own words. A generic list used to be stamped on every
                // unmapped row, so two imported courses fired on the same comment.
                triggerKeywords = `${cleanName.split(' ')[0].toLowerCase()}, ${cleanName}`;
                // The wording is the tenant's (the server's `fallback`): this file carries none.
                dmTemplate = this.fillFallback(fallbackLines.dm_template, cleanName, course.url);
                publicReplies = String(fallbackLines.public_reply_template || '');
            }

            return {
                index,
                id: course.id,
                name: course.name,
                couponCode: course.code,
                redemptions: course.redemptions,
                triggerKeywords,
                dmTemplate,
                publicReplies,
                matched: !!mapping,
                // Only a seed that asks for whole-word matching says so: a substring one is what the server
                // creates without being told, so its row carries nothing extra.
                ...(mapping && mapping.match === 'word' ? { matchMode: 'word' } : {}),
            };
        });

        // Held in memory instead of being serialised into an onclick attribute.
        this.pendingImport = campaignData;

        UI.showModal(html`
            ${this.modalHeader(t('campaigns.bulk.title', { count: UI.formatNumber(campaignData.length) }))}
            <div class="bulk-scroll" id="bulk-import-container">
                <p class="bulk-intro">${t('campaigns.bulk.intro', { count: campaignData.length })}</p>
                ${campaignData.map((c) => html`
                    <div class="bulk-row ${c.matched ? html.raw('is-mapped') : ''}">
                        <div class="bulk-row-head">
                            <div class="row row--start gap-2">
                                <input type="checkbox" class="import-checkbox" id="import-check-${c.index}"
                                       data-index="${c.index}" checked>
                                <div>
                                    <label class="bulk-name" for="import-check-${c.index}" dir="auto">${c.name}</label>
                                    <p class="bulk-coupon" dir="auto">${t('campaigns.bulk.coupon', {
                                        code: c.couponCode, count: Number(c.redemptions) || 0,
                                    })}</p>
                                </div>
                            </div>
                            ${c.matched
                                ? html`<span class="chip chip-accent"><i data-lucide="sparkles" aria-hidden="true"></i> ${t('campaigns.bulk.mapped')}</span>`
                                : html`<span class="chip">${t('campaigns.bulk.generated')}</span>`}
                        </div>

                        <div>
                            <label class="form-label" for="import-trigger-${c.index}">${t('campaigns.keywords')}</label>
                            <input class="field bulk-import-input" dir="auto"
                                   id="import-trigger-${c.index}" value="${c.triggerKeywords}">
                        </div>
                        <div>
                            <label class="form-label" for="import-dm-${c.index}">${t('campaigns.dmTemplate')}</label>
                            <!-- Seed copy from the tenant's offers (campaign seeds):
                                 authored text, and the operator edits it here
                                 before it is sent to real customers. -->
                            <textarea class="field-textarea bulk-import-textarea user-content" dir="auto" lang="ar"
                                      id="import-dm-${c.index}">${c.dmTemplate}</textarea>
                        </div>
                        <div>
                            <label class="form-label" for="import-public-${c.index}">${t('campaigns.publicReply')}</label>
                            <input class="field bulk-import-input" dir="auto" lang="ar"
                                   id="import-public-${c.index}" value="${c.publicReplies}">
                        </div>
                    </div>
                `)}
            </div>
            <div class="modal-actions">
                ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                ${UI.button({
                    variant: 'primary', icon: 'check', label: t('campaigns.bulk.importSelected'),
                    action: 'campaigns:executeBulkImport', id: 'bulk-import-submit',
                })}
            </div>
        `);
    },

    async executeBulkImport() {
        const campaignData = this.pendingImport || [];
        const checkboxes = document.querySelectorAll('.import-checkbox');
        const toImport = [];

        for (const cb of checkboxes) {
            if (!cb.checked) continue;
            const idx = parseInt(cb.getAttribute('data-index'), 10);
            const original = campaignData.find((c) => c.index === idx);
            if (!original) continue;

            const trigger_keyword = document.getElementById(`import-trigger-${idx}`).value.trim();
            const dm_template = document.getElementById(`import-dm-${idx}`).value.trim();
            const public_reply_template = document.getElementById(`import-public-${idx}`).value.trim();

            if (!trigger_keyword || !dm_template) {
                UI.toast(t('campaigns.bulk.required', { name: original.name }), 'error');
                return;
            }

            toImport.push({
                trigger_keyword,
                dm_template,
                public_reply_template: public_reply_template || null,
                post_id: null,
                // Only when the seed asked for whole-word matching (see showBulkImportModal).
                ...(original.matchMode === 'word' ? { match_mode: 'word' } : {}),
            });
        }

        if (toImport.length === 0) {
            UI.toast(t('campaigns.bulk.nothingSelected'), 'error');
            return;
        }

        UI.showModal(html`
            <div class="import-progress" role="status" aria-live="polite">
                <div class="spinner"></div>
                <h3 class="modal-title">${t('campaigns.bulk.progressTitle')}</h3>
                <p id="import-progress-status">${t('campaigns.bulk.progress', {
                    current: UI.formatNumber(1), total: UI.formatNumber(toImport.length),
                })}</p>
            </div>
        `);

        let successCount = 0;
        let failCount = 0;
        let lastError = '';

        for (let i = 0; i < toImport.length; i++) {
            const statusEl = document.getElementById('import-progress-status');
            if (statusEl) {
                statusEl.textContent = t('campaigns.bulk.progress', {
                    current: UI.formatNumber(i + 1), total: UI.formatNumber(toImport.length),
                });
            }

            try {
                await API.createCampaign(toImport[i]);
                successCount++;
            } catch (err) {
                console.error('Bulk Import error:', err);
                lastError = err.message;
                failCount++;
            }
        }

        UI.closeModal();
        this.pendingImport = null;

        if (failCount === 0) {
            UI.toast(t('campaigns.bulk.allOk', { count: successCount }));
        } else {
            UI.toast(t('campaigns.bulk.partial', {
                ok: UI.formatNumber(successCount), failed: UI.formatNumber(failCount), message: lastError,
            }), 'error');
        }

        this.render();
    },
};

UI.registerActions('campaigns', {
    showCreateModal: () => CampaignsPage.showCreateModal(),
    showEditModal: (el) => CampaignsPage.showEditModal(el.dataset.id),
    confirmDelete: (el) => CampaignsPage.confirmDelete(el.dataset.id, el.dataset.keyword),
    handleDelete: (el) => CampaignsPage.handleDelete(el.dataset.id),
    toggleActive: (el) => CampaignsPage.toggleActive(el.dataset.id, el.checked),
    handleCreate: (el, e) => CampaignsPage.handleCreate(el, e),
    handleEdit: (el, e) => CampaignsPage.handleEdit(el, e),
    inspectKeywords: (el) => CampaignsPage.inspectKeywords(el),
    matchModeChange: (el) => CampaignsPage.matchModeChange(el),
    draftChange: (el) => CampaignsPage.reinspect(el),
    useWholeWord: (el) => CampaignsPage.useWholeWord(el),
    editOther: (el) => CampaignsPage.editOther(el.dataset.id),
    retryCollisions: (el) => CampaignsPage.retryCollisions(el),
    openPostPicker: (el) => CampaignsPage.openPostPicker(el),
    selectPickedPost: (el) => CampaignsPage.selectPickedPost(el.dataset.id),
    triggerCSVSelect: () => CampaignsPage.triggerCSVSelect(),
    handleCSVSelect: (el) => CampaignsPage.handleCSVSelect(el),
    executeBulkImport: () => CampaignsPage.executeBulkImport(),
});
