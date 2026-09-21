/**
 * Campaigns — keywords, DM templates, public replies.
 *
 * ─── The keyword hazard ─────────────────────────────────────────────────────
 * Matching in production is SUBSTRING matching over Arabic-normalised text
 * (src/services/matching.ts → src/utils/arabic.ts). `تم` therefore fires inside
 * اهتمام, تمام and يتم, and the old form's own placeholder suggested `تم`.
 *
 * `keywordMatches()` in the backend does take a `'word'` mode — but nothing
 * persists a per-campaign choice: the campaigns table has no such column, the
 * POST/PUT handlers destructure only trigger_keyword, dm_template,
 * public_reply_template, post_id and is_active, and the webhook calls
 * matchCampaign() with no mode argument. A mode switch here would be a control
 * that silently does nothing, which is worse than no control, so this screen
 * does the honest version instead: it runs the SAME normalisation the webhook
 * runs, and at the moment the operator types a keyword it names the real
 * Arabic words that keyword will also fire on. Shipping the persisted `word`
 * mode is a backend change (one column, two handlers, one call site).
 */
const CampaignsPage = {
    campaigns: [],
    pendingImport: null,

    /** Tenant switch: cached campaigns and any half-finished CSV import. */
    resetTenantState() {
        this.campaigns = [];
        this.pendingImport = null;
    },

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();

        try {
            this.campaigns = await API.getCampaigns();
        } catch (err) {
            UI.renderError(container, { title: t('error.pageTitle'), message: err.message }, () => this.render());
            return;
        }

        const campaigns = this.campaigns;

        container.innerHTML = esc(html`
            <div class="page-toolbar">
                <p class="page-toolbar-count">${t('campaigns.count', { count: campaigns.length })}</p>
                <div class="toolbar-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="campaigns:triggerCSVSelect">
                        <i data-lucide="upload" aria-hidden="true"></i> ${t('campaigns.import')}
                    </button>
                    <button type="button" class="btn btn-primary btn-sm" data-action="campaigns:showCreateModal">
                        <i data-lucide="plus" aria-hidden="true"></i> ${t('campaigns.new')}
                    </button>
                </div>
            </div>
            <label class="sr-only" for="csv-file-input">${t('campaigns.csvLabel')}</label>
            <input type="file" id="csv-file-input" accept=".csv" class="hidden" data-change="campaigns:handleCSVSelect">

            ${campaigns.length === 0 ? html`
                <div class="empty-state surface">
                    <i data-lucide="megaphone" aria-hidden="true"></i>
                    <h3>${t('campaigns.emptyTitle')}</h3>
                    <p>${t('campaigns.emptyBody')}</p>
                    <div class="row gap-3 row--center row--wrap">
                        <button type="button" class="btn btn-secondary btn-sm" data-action="campaigns:triggerCSVSelect">
                            <i data-lucide="upload" aria-hidden="true"></i> ${t('campaigns.import')}
                        </button>
                        <button type="button" class="btn btn-primary btn-sm" data-action="campaigns:showCreateModal">
                            <i data-lucide="plus" aria-hidden="true"></i> ${t('common.create')}
                        </button>
                    </div>
                </div>
            ` : html`
                <div class="card-grid">${campaigns.map((c) => this.renderCard(c))}</div>
            `}
        `);

        UI.icons(container);
    },

    /**
     * The delete button carries data-id / data-keyword instead of an inline
     * onclick that interpolated them into a JS string literal. HTML-escaping
     * does NOT protect that position: the parser decodes &#39; back to a quote
     * before the JS is parsed, so a keyword of it's broke the handler and
     * ');alert(1);// executed.
     */
    renderCard(c) {
        const isActive = c.is_active !== false;
        const keywords = this.splitKeywords(c.trigger_keyword);
        const risky = keywords.filter((k) => this.keywordRisk(k).risky);

        return html`
            <article class="campaign-card surface ${isActive ? '' : html.raw('is-paused')}" data-id="${c.id}">
                <div class="campaign-card-head">
                    <div class="keyword-list">
                        ${keywords.map((k) => html`
                            <span class="chip ${this.keywordRisk(k).risky ? html.raw('chip-danger') : ''}" dir="auto">
                                <i data-lucide="${this.keywordRisk(k).risky ? 'alert-triangle' : 'hash'}" aria-hidden="true"></i>
                                ${k}
                            </span>
                        `)}
                    </div>
                    <div class="row gap-2 shrink-0">
                        <span class="campaign-state ${isActive ? html.raw('is-on') : html.raw('is-off')}">
                            ${isActive ? t('common.active') : t('common.paused')}
                        </span>
                        <label class="switch">
                            <span class="sr-only">${t('campaigns.toggleLabel')}</span>
                            <input type="checkbox" ${isActive ? html.raw('checked') : ''}
                                   data-change="campaigns:toggleActive" data-id="${c.id}">
                            <span class="switch-track"></span>
                        </label>
                    </div>
                </div>

                ${risky.length > 0 ? html`
                    <p class="text-meta text-warning">
                        <i data-lucide="alert-triangle" aria-hidden="true"></i>
                        ${t('campaigns.match.riskGeneric', { keyword: risky[0], length: UI.formatNumber(risky[0].length) })}
                    </p>
                ` : ''}

                <div class="template-preview user-content" dir="auto">${c.dm_template}</div>

                ${c.public_reply_template ? html`
                    <p class="campaign-meta-line" dir="auto">
                        💬 ${t('campaigns.publicPrefix')}: ${c.public_reply_template}
                    </p>
                ` : ''}
                ${c.post_id ? html`
                    <p class="campaign-meta-line row gap-2">
                        <i data-lucide="image" aria-hidden="true"></i>
                        ${t('campaigns.postId')}: ${UI.ltr(c.post_id)}
                    </p>
                ` : ''}

                <div class="campaign-stats">
                    <span class="campaign-stat"><span class="dot ok" aria-hidden="true"></span> ${t('campaigns.statSent', { count: UI.formatNumber(c.sent_count) })}</span>
                    <span class="campaign-stat"><span class="dot bad" aria-hidden="true"></span> ${t('campaigns.statFailed', { count: UI.formatNumber(c.failed_count) })}</span>
                    <span class="campaign-stat text-muted">${t('campaigns.statTotal', { count: UI.formatNumber(c.total_interactions) })}</span>
                </div>

                <div class="card-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="campaigns:showEditModal" data-id="${c.id}">
                        <i data-lucide="pencil" aria-hidden="true"></i> ${t('common.edit')}
                    </button>
                    <button type="button" class="btn btn-danger btn-sm"
                            data-action="campaigns:confirmDelete" data-id="${c.id}" data-keyword="${c.trigger_keyword}">
                        <i data-lucide="trash-2" aria-hidden="true"></i> ${t('common.delete')}
                    </button>
                </div>
            </article>
        `;
    },

    // ─── Keyword hazard analysis ─────────────────────────────────────────────

    splitKeywords(value) {
        return String(value || '').split(',').map((k) => k.trim()).filter(Boolean);
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
     */
    keywordRisk(keyword) {
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

    /**
     * The inspector under the keyword field. Re-rendered on every keystroke,
     * so the warning appears at the moment of the decision rather than after
     * the campaign has been live for a week.
     */
    renderMatchInspector(value) {
        const keywords = this.splitKeywords(value);
        const seen = new Set();
        const duplicates = [];
        const risks = [];

        keywords.forEach((k) => {
            const n = UI.normalizeArabic(k);
            if (seen.has(n)) duplicates.push(k); else seen.add(n);
            const risk = this.keywordRisk(k);
            if (risk.risky) risks.push({ keyword: k, ...risk });
        });

        const hasProblem = risks.length > 0 || duplicates.length > 0;
        const state = keywords.length === 0 ? '' : (hasProblem ? 'is-risky' : 'is-safe');

        return html`
            <div class="match-inspector ${html.raw(state)}" id="match-inspector" aria-live="polite">
                <h4>
                    <i data-lucide="${hasProblem ? 'alert-triangle' : 'search-check'}" aria-hidden="true"></i>
                    ${t('campaigns.match.title')}
                </h4>
                <p>${t('campaigns.match.explain')}</p>
                ${!hasProblem && keywords.length > 0 ? html`<p class="text-success">${t('campaigns.match.safe')}</p>` : ''}
                ${hasProblem ? html`
                    <ul class="match-risk-list">
                        ${risks.map((r) => html`
                            <li dir="auto">
                                ${r.reason === 'examples'
                                    ? html`${t('campaigns.match.riskRow', { keyword: r.keyword, examples: '' })}<span class="match-example">${r.examples.join('، ')}</span>`
                                    : t('campaigns.match.riskGeneric', { keyword: r.keyword, length: UI.formatNumber(UI.normalizeArabic(r.keyword).length) })}
                            </li>
                        `)}
                        ${duplicates.map((d) => html`<li dir="auto">${t('campaigns.match.duplicate', { keyword: d })}</li>`)}
                    </ul>
                    <p class="mbs-4">${t('campaigns.match.advice')}</p>
                ` : ''}
            </div>
        `;
    },

    /** Live update from the keyword input. */
    inspectKeywords(input) {
        const host = document.getElementById('match-inspector');
        if (!host) return;
        const replacement = document.createElement('div');
        replacement.innerHTML = esc(this.renderMatchInspector(input.value));
        const next = replacement.firstElementChild;
        if (!next) return;
        host.replaceWith(next);
        UI.icons(next);
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

    keywordField(value) {
        return html`
            <div class="form-group">
                <label class="form-label" for="campaign-trigger">${t('campaigns.keywords')}</label>
                <input class="field" id="campaign-trigger" name="trigger_keyword" dir="auto"
                       value="${value || ''}" placeholder="${t('campaigns.keywordsPlaceholder')}"
                       data-input="campaigns:inspectKeywords" required>
                <p class="form-hint">${t('campaigns.keywordsHint')}</p>
                ${this.renderMatchInspector(value || '')}
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
                    <input class="field" id="campaign-post-id" name="post_id" value="${value}"
                           inputmode="numeric" dir="ltr" placeholder="17841459652725922">
                    <button type="button" class="btn btn-secondary btn-sm shrink-0" data-action="campaigns:openPostPicker">
                        <i data-lucide="image" aria-hidden="true"></i> ${t('campaigns.pickPost')}
                    </button>
                </div>
                <div id="post-picker-container" class="post-picker hidden"></div>
                <p class="form-hint">${t('campaigns.postIdHint')}</p>
            </div>
        `;
    },

    showCreateModal() {
        UI.showModal(html`
            ${this.modalHeader(t('campaigns.createTitle'))}
            <form id="campaign-form" data-submit="campaigns:handleCreate">
                ${this.keywordField('')}
                <div class="form-group">
                    <label class="form-label" for="campaign-dm">${t('campaigns.dmTemplate')}</label>
                    <textarea class="field-textarea user-content" id="campaign-dm" name="dm_template" dir="auto"
                              placeholder="${t('campaigns.dmPlaceholder')}" required></textarea>
                </div>
                <div class="form-group">
                    <label class="form-label" for="campaign-public">
                        ${t('campaigns.publicReply')} <span class="label-optional">${t('common.optional')}</span>
                    </label>
                    <input class="field" id="campaign-public" name="public_reply_template" dir="auto"
                           placeholder="${t('campaigns.publicReplyPlaceholder')}">
                    <p class="form-hint">${t('campaigns.publicReplyHint')}</p>
                </div>
                ${this.postIdField('')}
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="plus" aria-hidden="true"></i> ${t('common.create')}</button>
                </div>
            </form>
        `);
    },

    showEditModal(id) {
        const c = this.campaigns.find((x) => x.id === id);
        if (!c) return;

        UI.showModal(html`
            ${this.modalHeader(t('campaigns.editTitle'))}
            <form id="campaign-form" data-submit="campaigns:handleEdit" data-id="${c.id}">
                ${this.keywordField(c.trigger_keyword)}
                <div class="form-group">
                    <label class="form-label" for="campaign-dm">${t('campaigns.dmTemplate')}</label>
                    <textarea class="field-textarea user-content" id="campaign-dm" name="dm_template" dir="auto" required>${c.dm_template}</textarea>
                </div>
                <div class="form-group">
                    <label class="form-label" for="campaign-public">
                        ${t('campaigns.publicReply')} <span class="label-optional">${t('common.optional')}</span>
                    </label>
                    <input class="field" id="campaign-public" name="public_reply_template" dir="auto"
                           value="${c.public_reply_template || ''}" placeholder="${t('campaigns.publicReplyPlaceholder')}">
                    <p class="form-hint">${t('campaigns.publicReplyHint')}</p>
                </div>
                ${this.postIdField(c.post_id || '')}
                <div class="form-group switch-row">
                    <label class="switch" for="campaign-active-toggle">
                        <span class="sr-only">${t('campaigns.toggleLabel')}</span>
                        <input type="checkbox" id="campaign-active-toggle" name="is_active" ${c.is_active !== false ? html.raw('checked') : ''}>
                        <span class="switch-track"></span>
                    </label>
                    <span class="switch-label">${t('campaigns.toggleLabel')}</span>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="check" aria-hidden="true"></i> ${t('common.save')}</button>
                </div>
            </form>
        `);
    },

    async handleCreate(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        try {
            await API.createCampaign({
                trigger_keyword: data.get('trigger_keyword'),
                dm_template: data.get('dm_template'),
                public_reply_template: data.get('public_reply_template') || null,
                post_id: data.get('post_id') || null,
            });
            UI.closeModal();
            UI.toast(t('campaigns.created'));
            this.render();
        } catch (err) { UI.toast(err.message, 'error'); }
    },

    async handleEdit(form, event) {
        event.preventDefault();
        const id = form.dataset.id;
        const data = new FormData(form);
        try {
            await API.updateCampaign(id, {
                trigger_keyword: data.get('trigger_keyword'),
                dm_template: data.get('dm_template'),
                public_reply_template: data.get('public_reply_template') || null,
                post_id: data.get('post_id') || null,
                is_active: data.get('is_active') === 'on',
            });
            UI.closeModal();
            UI.toast(t('campaigns.updated'));
            this.render();
        } catch (err) { UI.toast(err.message, 'error'); }
    },

    async toggleActive(id, isChecked) {
        try {
            await API.updateCampaign(id, { is_active: isChecked });
            UI.toast(isChecked ? t('campaigns.activated') : t('campaigns.pausedToast'));
            this.render();
        } catch (err) {
            UI.toast(err.message, 'error');
            this.render();
        }
    },

    confirmDelete(id, keyword) {
        UI.showModal(html`
            ${this.modalHeader(t('campaigns.deleteTitle'))}
            <p class="modal-body-text" dir="auto">${t('campaigns.deleteBody', { keyword })}</p>
            <p class="form-hint">${t('campaigns.deleteWarning')}</p>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                <button type="button" class="btn btn-danger" data-action="campaigns:handleDelete" data-id="${id}">
                    <i data-lucide="trash-2" aria-hidden="true"></i> ${t('common.delete')}
                </button>
            </div>
        `);
    },

    async handleDelete(id) {
        try {
            await API.deleteCampaign(id);
            UI.closeModal();
            UI.toast(t('campaigns.deleted'));
            this.render();
        } catch (err) { UI.toast(err.message, 'error'); }
    },

    // ─── Post picker ─────────────────────────────────────────────────────────
    async openPostPicker(btn) {
        const picker = document.getElementById('post-picker-container');
        if (!picker) return;

        if (!picker.classList.contains('hidden')) {
            picker.classList.add('hidden');
            return;
        }

        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = UI.buttonSpinner();

        try {
            const livePosts = await API.getLivePosts();
            picker.classList.remove('hidden');

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
            picker.classList.remove('hidden');
            picker.innerHTML = esc(html`<p class="post-picker-note is-error" dir="auto">${t('campaigns.postPickerFailed', { message: err.message })}</p>`);
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
            UI.icons(btn);
        }
    },

    selectPickedPost(id) {
        const input = document.getElementById('campaign-post-id');
        if (input) input.value = id;
        const picker = document.getElementById('post-picker-container');
        if (picker) picker.classList.add('hidden');
    },

    // ─── CSV bulk import ─────────────────────────────────────────────────────
    triggerCSVSelect() {
        document.getElementById('csv-file-input').click();
    },

    handleCSVSelect(input) {
        const file = input.files && input.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const rows = this.parseCSV(event.target.result);
                if (rows.length <= 1) {
                    UI.toast(t('campaigns.bulk.emptyCsv'), 'error');
                    return;
                }

                const courseMap = {};
                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i];
                    if (row.length < 10) continue;
                    const courseId = row[0].trim();
                    if (!courseId) continue;

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

                this.showBulkImportModal(uniqueCourses);
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
     * Seed copy for known courses. This is CONTENT, not chrome: it is the
     * Arabic the creator actually sends, so it is not part of the i18n catalog
     * and does not change with the interface language.
     */
    COURSE_MAPPINGS: {
        'agentic ai': {
            triggerKeywords: 'ذكاء اصطناعي, ايجنتك, عميل ذكي, agentic ai, ai agent',
            dmTemplate: `أهلاً بك {username}! 👋\nسعيد جداً باهتمامك بدورة "Agentic AI: الدليل العملي لبناء ما تحتاجه بالذكاء الاصطناعي". 🤖🚀\n\nهذا هو رابط التسجيل المجاني المباشر الخاص بك (الكوبون مفعّل تلقائياً):\n🔗 {url}\n\n💡 الكوبون صالح لفترة محدودة ولـ 100 مقعد فقط. سارع بالتسجيل واستمتع بالرحلة التعليمية!\nإذا كان لديك أي استفسار، أنا هنا دائماً لمساعدتك. بالتوفيق! ✨`,
            publicReplies: 'تم إرسال رابط الدورة والتفاصيل إلى الخاص بك يا {username}! تفقد رسائلك 📩🤖 | أهلاً بك {username}! شيك الخاص أرسلت لك كوبون التسجيل المجاني 🚀✨ | تم الإرسال على الخاص بنجاح! بالتوفيق في رحلتك التعليمية 🎓🌟',
        },
        golang: {
            triggerKeywords: 'جولانج, كورس جو, لغة جو, golang, go lang',
            dmTemplate: `أهلاً بك {username}! 👋\nسعيد باهتمامك بتعلم لغة Go القوية مع دورة "GoLang Course: Learn Go in Arabic". 🐹🚀\n\nإليك رابط التسجيل المجاني المباشر الخاص بك (الكوبون مفعّل):\n🔗 {url}\n\n💡 الكوبون مخصص لـ 100 طالب وصالح لفترة محدودة. سجل الآن لتبدأ في بناء تطبيقات عالية الأداء!\nأراك داخل الدورة! 🎓✨`,
            publicReplies: 'شيك الخاص يا {username}! أرسلت لك رابط الدورة المجاني 🐹📩 | تم إرسال كوبون لغة Go إلى الخاص بك بنجاح! بالتوفيق 🚀 | أهلاً {username}، تفقد صندوق الوارد للبدء فوراً! 🎓💡',
        },
        swift: {
            triggerKeywords: 'سويفت, برمجة ايفون, تطبيقات ايفون, swift programming, swift arabic',
            dmTemplate: `أهلاً بك {username}! 👋\nخطوة رائعة لدخول عالم برمجة تطبيقات الآيفون والآيباد! 📱✨\nإليك رابط التسجيل المجاني المباشر في دورة "Swift Programming Language | in Arabic":\n🔗 {url}\n\n💡 الكوبون متاح لأول 100 مقعد فقط. لا تفوت الفرصة وابدأ الآن!\nبالتوفيق لك في مسيرتك البرمجية! 🚀`,
            publicReplies: 'أهلاً بك {username}! تم إرسال رابط كورس سويفت على الخاص 📩📱 | شيك الخاص يا {username} لتجد كوبون الدورة المجاني! 🚀✨ | تم الإرسال بنجاح! بالتوفيق في برمجة تطبيقات iOS 🍏💡',
        },
        css3: {
            triggerKeywords: 'سي اس اس, تصميم ويب, css3, web design',
            dmTemplate: `أهلاً بك {username}! 👋\nهل أنت جاهز لتصميم مواقع ويب احترافية وجذابة؟ 🎨💻\nإليك رابط التسجيل المجاني المباشر في دورة "CSS3 For Beginners [In Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لفترة محدودة ومحدود بـ 100 عملية تسجيل.\nبالتوفيق وسأكون سعيداً برؤية تصميماتك! 🚀✨`,
            publicReplies: 'تم إرسال كوبون كورس CSS3 إلى الخاص بك يا {username}! 🎨📩 | تفقد الخاص {username} لتجد رابط التسجيل المجاني! 💻✨ | أهلاً بك! تم الإرسال بنجاح، بالتوفيق في مسيرتك في تصميم الويب 🚀🌟',
        },
        html5: {
            triggerKeywords: 'اتش تي ام ال, بناء موقع, html5, html beginners',
            dmTemplate: `أهلاً بك {username}! 👋\nأول خطوة في تطوير الويب تبدأ من هنا! 🌐💻\nإليك رابط التسجيل المجاني المباشر لدورة "HTML5 For Beginners [In Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لأول 100 طالب مسجل فقط. احجز مقعدك الآن!\nبالتوفيق لك في بدايتك الموفقة! 🚀✨`,
            publicReplies: 'أرسلت لك رابط كورس HTML5 على الخاص يا {username}! 🌐📩 | تفقد رسائلك {username} للتسجيل في الدورة مجاناً! 🚀 | تم إرسال الكوبون بنجاح! بداية موفقة في تطوير الويب 💻✨',
        },
        'problem solving': {
            triggerKeywords: 'حل مسائل, بروبلم سولفينج, problem solving, c# problem',
            dmTemplate: `أهلاً بك {username}! 👋\nحل المسائل هو السلاح السري لكل مبرمج محترف! 🧠💻\nإليك رابط التسجيل المجاني في دورة "Problem Solving - with C# [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لـ 100 مقعد فقط. سجل الآن وابدأ بتدريب عقلك البرمجي!\nبالتوفيق لك! 🚀✨`,
            publicReplies: 'تم إرسال رابط كورس حل المسائل على الخاص يا {username}! 🧠📩 | تفقد الخاص {username} لتجد الكوبون المجاني! 🚀✨ | تم الإرسال بنجاح! تمنياتي لك بالتوفيق في صقل مهاراتك المنطقية 💻🌟',
        },
        java: {
            triggerKeywords: 'كورس جافا, جافا, java for beginners, java arabic',
            dmTemplate: `أهلاً بك {username}! 👋\nتعلم واحدة من أكثر لغات البرمجة طلباً واستخداماً في الشركات! ☕️🚀\nإليك رابط التسجيل المجاني المباشر في دورة "Java for Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون مخصص لـ 100 طالب وصالح لفترة محدودة. سجل الآن لتبني أساساً قوياً!\nبالتوفيق لك! 🎓✨`,
            publicReplies: 'تم إرسال رابط كورس الجافا على الخاص يا {username}! ☕️📩 | شيك الخاص {username} للحصول على الكوبون المجاني 🚀 | تم الإرسال بنجاح! بالتوفيق في مسيرتك البرمجية 💻✨',
        },
        python: {
            triggerKeywords: 'بايثون, بايثون للمبتدئين, python arabic, python course',
            dmTemplate: `أهلاً بك {username}! 👋\nالبداية الأسهل والأكثر متعة في عالم البرمجة هي لغة بايثون! 🐍🚀\nإليك رابط التسجيل المجاني لدورة "Python For Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لأول 100 طالب مسجل فقط. احجز مقعدك الآن!\nأتمنى لك رحلة ممتعة وموفقة! ✨`,
            publicReplies: 'شيك الخاص يا {username}! أرسلت لك رابط كورس بايثون المجاني 🐍📩 | تم إرسال الكوبون إلى الخاص بك بنجاح! بالتوفيق 🚀 | أهلاً {username}، تفقد صندوق الوارد للبدء فوراً! 🎓💡',
        },
        'c#': {
            triggerKeywords: 'سي شارب, كورس سي شارب, csharp, c# beginners',
            dmTemplate: `أهلاً بك {username}! 👋\nتعلم لغة C# القوية لبناء تطبيقات سطح المكتب، الألعاب، والمواقع! 🎮💻\nإليك رابط التسجيل المجاني المباشر لدورة "C# For Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لـ 100 مقعد فقط ولفترة محدودة. احرص على التسجيل الآن!\nبالتوفيق وسأكون سعيداً بمتابعة تقدمك! 🚀✨`,
            publicReplies: 'تم إرسال رابط كورس سي شارب على الخاص يا {username}! 💻📩 | تفقد رسائل الخاص {username} لتجد الكوبون المجاني 🚀 | تم الإرسال بنجاح! بالتوفيق في مسيرتك البرمجية 🎓🌟',
        },
    },

    showBulkImportModal(courses) {
        const campaignData = courses.map((course, index) => {
            const nameLower = String(course.name || '').toLowerCase();
            let mapping = null;
            for (const key in this.COURSE_MAPPINGS) {
                if (nameLower.includes(key)) { mapping = this.COURSE_MAPPINGS[key]; break; }
            }

            let triggerKeywords;
            let dmTemplate;
            let publicReplies;

            if (mapping) {
                triggerKeywords = mapping.triggerKeywords;
                dmTemplate = mapping.dmTemplate.replace(/{url}/g, course.url);
                publicReplies = mapping.publicReplies;
            } else {
                const cleanName = String(course.name || '').split('[')[0].split('|')[0].split('-')[0].trim();
                triggerKeywords = `${cleanName.split(' ')[0].toLowerCase()}, كورس, كوبون, رابط`;
                dmTemplate = `أهلاً بك {username}! 👋\nإليك رابط التسجيل المجاني لكورس "${cleanName}":\n🔗 ${course.url}\n\nسجل الآن قبل نفاد الكوبون! ✨`;
                publicReplies = 'تم إرسال الرابط والتفاصيل على الخاص يا {username}! 📩 | تفقد الخاص {username} للحصول على كوبون الدورة! 🚀';
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
            };
        });

        // Held in memory instead of being serialised into an onclick attribute.
        this.pendingImport = campaignData;

        UI.showModal(html`
            ${this.modalHeader(t('campaigns.bulk.title', { count: UI.formatNumber(campaignData.length) }))}
            <div class="bulk-scroll" id="bulk-import-container">
                <p class="bulk-intro">${t('campaigns.bulk.intro', { count: UI.formatNumber(campaignData.length) })}</p>
                ${campaignData.map((c) => html`
                    <div class="bulk-row ${c.matched ? html.raw('is-mapped') : ''}">
                        <div class="bulk-row-head">
                            <div class="row row--start gap-2">
                                <input type="checkbox" class="import-checkbox" id="import-check-${c.index}"
                                       data-index="${c.index}" checked>
                                <div>
                                    <label class="bulk-name" for="import-check-${c.index}" dir="auto">${c.name}</label>
                                    <p class="bulk-coupon" dir="auto">${t('campaigns.bulk.coupon', {
                                        code: c.couponCode, count: UI.formatNumber(c.redemptions),
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
                            <textarea class="field-textarea bulk-import-textarea user-content" dir="auto"
                                      id="import-dm-${c.index}">${c.dmTemplate}</textarea>
                        </div>
                        <div>
                            <label class="form-label" for="import-public-${c.index}">${t('campaigns.publicReply')}</label>
                            <input class="field bulk-import-input" dir="auto"
                                   id="import-public-${c.index}" value="${c.publicReplies}">
                        </div>
                    </div>
                `)}
            </div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                <button type="button" class="btn btn-primary" data-action="campaigns:executeBulkImport">
                    <i data-lucide="check" aria-hidden="true"></i> ${t('campaigns.bulk.importSelected')}
                </button>
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
            UI.toast(t('campaigns.bulk.allOk', { count: UI.formatNumber(successCount) }));
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
    openPostPicker: (el) => CampaignsPage.openPostPicker(el),
    selectPickedPost: (el) => CampaignsPage.selectPickedPost(el.dataset.id),
    triggerCSVSelect: () => CampaignsPage.triggerCSVSelect(),
    handleCSVSelect: (el) => CampaignsPage.handleCSVSelect(el),
    executeBulkImport: () => CampaignsPage.executeBulkImport(),
});
