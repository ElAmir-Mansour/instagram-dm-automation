/**
 * Ads → Rules — `#/ads_rules` (Meta Ads Manager A9, spec Story 7).
 *
 * The owner's standing conditions on his ads, checked about once an hour by the server (src/services/ads/rules.ts):
 *   - four templates (cost per conversation too high → pause; spending too fast → notify; frequency too high → lower the budget 20%;
 *     ad rejected → notify) and a custom form: up to 5 conditions that must all hold, a minimum of data, and what to do;
 *   - saving IS approving: pause, lower the budget and notify then run on their own. Raising a budget and resuming never do: each time
 *     they become a proposal in Ads → Proposals that he approves. The monthly cap and the daily max always apply;
 *   - each rule shows its last check, a "not watching" badge after 24 hours without a real check, and its history (every check, what
 *     matched, what was done or why not).
 *
 * Viewers read; only the owner writes (the server refuses the rest anyway). Everything the server wrote is escaped by `html`.
 * `AdsTabs` lives in ads_campaigns.js; the styles in css/pages/ads.css.
 */
const AdsRulesPage = {
    /** 'loading' | 'ready' | 'forbidden' | 'disabled' | 'failed' */
    view: 'loading',
    /** GET /api/ads/rules: { rules, templates, limits, currency }. */
    data: null,
    /** The open history panels: rule id → { state: 'loading' | 'ready' | 'failed', runs }. */
    runs: Object.create(null),
    /** The rule being written in the dialog (read back from the dialog before every redraw). */
    draft: null,
    /** The objects the dialog's "chosen items" lists, per level: null = not read yet, false = could not be read. */
    objects: Object.create(null),
    _seq: 0,

    METRICS: Object.freeze(['cost_per_conversation', 'cost_per_result', 'spend', 'results', 'ctr', 'cpm', 'frequency', 'budget_pace', 'rejected']),
    MONEY_METRICS: Object.freeze(['spend', 'cost_per_result', 'cost_per_conversation', 'cpm']),
    OPS: Object.freeze(['>', '>=', '<', '<=']),
    /** The i18n key of each comparison (`ads.rules.op.<key>`). */
    OP_KEY: Object.freeze({ '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' }),
    WINDOWS: Object.freeze(['today', '3d', '7d']),
    LEVELS: Object.freeze(['campaign', 'adset', 'ad']),
    EFFECTS: Object.freeze(['none', 'pause', 'lower_budget', 'raise_budget', 'resume']),
    MAX_CONDITIONS: 5,

    resetTenantState() {
        this.destroy();
        this.view = 'loading';
        this.data = null;
        this.runs = Object.create(null);
        this.draft = null;
        this.objects = Object.create(null);
    },

    destroy() {
        this._seq++;
    },

    isOwner() {
        return typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
    },

    host() {
        return document.getElementById('page-container');
    },

    // ─── Reading ─────────────────────────────────────────────────────────────

    async render() {
        if (typeof App !== 'undefined' && typeof App.loadPageCss === 'function' && typeof App.entryOf === 'function') {
            await App.loadPageCss('ads', App.entryOf('ads'));
        }
        if (typeof AdsTabs === 'undefined' && typeof App !== 'undefined' && typeof App.loadPageModule === 'function') {
            try { await App.loadPageModule('ads_campaigns'); } catch { /* the page still works without its tab bar */ }
        }
        return this.load();
    },

    async load(quiet) {
        const container = this.host();
        if (!container) return false;
        const seq = ++this._seq;
        const gate = quiet ? { done() {} } : Motion.beginLoad(container, () => html`${Motion.tableCard(3, ['', '', ''])}${Motion.busy()}`);
        let answer;
        try {
            answer = await API.getAdsRules();
        } catch (err) {
            gate.done();
            if (seq !== this._seq) return false;
            if (err && (err.status === 403 || err.status === 404)) {
                this.view = err.status === 404 ? 'disabled' : 'forbidden';
                this.paint();
            } else if (!quiet) {
                this.view = 'failed';
                UI.renderError(container, { title: t('ads.rules.loadFailed'), message: (err && err.message) || t('error.unexpected'), hint: t('admin.loadFailedHint') }, () => this.load());
            }
            return false;
        }
        gate.done();
        if (seq !== this._seq) return false;
        this.data = answer || {};
        this.view = 'ready';
        this.paint();
        if (!quiet) Motion.announce(t('ads.rules.loaded'));
        return true;
    },

    rules() {
        return this.data && Array.isArray(this.data.rules) ? this.data.rules.filter((r) => r && r.id) : [];
    },

    templates() {
        return this.data && Array.isArray(this.data.templates) ? this.data.templates : [];
    },

    currency() {
        return (this.data && this.data.currency) || '';
    },

    paint() {
        const container = this.host();
        if (!container) return;
        const focus = UI.captureFocus ? UI.captureFocus(container) : null;
        container.innerHTML = esc(this.markup());
        UI.icons(container);
        if (focus && UI.restoreFocus) UI.restoreFocus(focus);
    },

    // ─── Words ───────────────────────────────────────────────────────────────

    num(v) {
        return `⁦${UI.formatNumber(Math.round(Number(v) * 100) / 100)}⁩`;
    },

    /** A metric's value as the reader expects it: money with the currency, CTR as a percentage. */
    valueText(metric, v) {
        if (v === null || v === undefined || !Number.isFinite(Number(v))) return t('ads.rules.value.none');
        if (this.MONEY_METRICS.includes(metric)) return `${this.num(v)} ${this.currency()}`.trim();
        if (metric === 'ctr') return `${this.num(v)}%`;
        if (metric === 'budget_pace') return `×${this.num(v)}`;
        return this.num(v);
    },

    conditionText(c) {
        if (c.metric === 'rejected') return t('ads.rules.say.rejected');
        return t('ads.rules.say.condition', {
            metric: t(`ads.rules.metric.${c.metric}`), op: t(`ads.rules.op.${this.OP_KEY[c.op]}`), value: this.valueText(c.metric, c.value), window: t(`ads.rules.window.${c.window}`),
        });
    },

    actionText(a) {
        if (a.type === 'lower_budget' || a.type === 'raise_budget') return t(`ads.rules.say.${a.type}`, { percent: `⁦${a.percent}%⁩` });
        return t(`ads.rules.say.${a.type}`);
    },

    /** The rule in one sentence: "Ads: when cost per conversation (last 3 days) is over 15 SAR, after 500 impressions → pause, tell me." */
    sentence(r) {
        const conditions = (r.conditions || []).map((c) => this.conditionText(c)).join(t('ads.rules.say.and'));
        const md = r.minData || {};
        const min = [
            md.impressions ? t('ads.rules.say.minImpressions', { n: this.num(md.impressions) }) : '',
            md.spend ? t('ads.rules.say.minSpend', { amount: this.valueText('spend', md.spend) }) : '',
        ].filter(Boolean).join(t('ads.rules.say.and'));
        const scope = r.scope && Array.isArray(r.scope.objectIds)
            ? t('ads.rules.say.scopeSome', { level: t(`ads.rules.level.${r.scope.level}`), n: `⁦${r.scope.objectIds.length}⁩` })
            : t('ads.rules.say.scopeAll', { level: t(`ads.rules.level.${r.scope && r.scope.level}`) });
        const actions = (r.actions || []).map((a) => this.actionText(a)).join(t('ads.rules.say.sep'));
        return t('ads.rules.say.rule', { scope, conditions, min: min ? t('ads.rules.say.after', { min }) : '', actions });
    },

    whenText(iso) {
        return iso ? UI.formatDateTime(iso) : t('ads.rules.never');
    },

    /** A refusal in the reader's words: the server names the field; the dialog says which part to fix. */
    refusalText(err) {
        const body = (err && err.body) || {};
        const field = typeof body.field === 'string' ? body.field.split('.')[0] : '';
        if (body.code === 'INVALID' && ['name', 'scope', 'conditions', 'minData', 'actions', 'rule'].includes(field)) return t(`ads.rules.err.field.${field}`);
        if (body.code === 'NOT_FOUND') return t('ads.rules.err.notFound');
        if (err && (err.status === 403)) return t('ads.owner.body');
        return (err && err.message) || t('error.unexpected');
    },

    // ─── Markup ──────────────────────────────────────────────────────────────

    markup() {
        const tabs = typeof AdsTabs === 'undefined' || this.view === 'forbidden' || this.view === 'disabled' ? '' : AdsTabs.markup('rules');
        const add = this.view === 'ready' && this.isOwner()
            ? UI.button({ variant: 'primary', size: 'sm', icon: 'plus', label: t('ads.rules.new'), action: 'adsrule:new', focusKey: 'adsrule-new' })
            : '';
        const header = UI.pageHeader({ title: t('ads.rules.title'), subtitle: t('page.ads_rules.subtitle'), actions: add });
        if (this.view === 'forbidden') return html`<div id="adsrule-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.owner.title'), body: t('ads.owner.body') })}</div>`;
        if (this.view === 'disabled') return html`<div id="adsrule-page" class="ads-page">${header}${UI.emptyState({ icon: 'lock', title: t('ads.disabled.title'), body: t('ads.disabled.body') })}</div>`;
        const list = this.rules();
        return html`
            <div id="adsrule-page" class="ads-page adsrule-page">
                ${tabs}
                ${header}
                <div class="card adsrule-intro" id="adsrule-intro">
                    <p><i data-lucide="shield-check" aria-hidden="true"></i> ${t('ads.rules.intro.alone')}</p>
                    <p><i data-lucide="sparkles" aria-hidden="true"></i> ${t('ads.rules.intro.asks')}</p>
                    <p class="form-hint">${t('ads.rules.intro.caps')}
                        ${UI.helpLink('ads#rules', t('ads.rules.help.rules'))} · ${UI.helpLink('ads#rule-templates', t('ads.rules.help.templates'))}</p>
                </div>
                ${this.isOwner() ? this.templatesMarkup() : ''}
                <section class="section" id="adsrule-list-section" aria-labelledby="adsrule-list-title">
                    <h2 class="section-title" id="adsrule-list-title">${t('ads.rules.list.title')}</h2>
                    ${list.length ? html`<div class="adsrule-list" id="adsrule-list">${list.map((r) => this.ruleMarkup(r))}</div>`
                        : UI.emptyState({ icon: 'list-checks', title: t('ads.rules.empty.title'), body: t('ads.rules.empty.body') })}
                </section>
            </div>
        `;
    },

    templatesMarkup() {
        const tpls = this.templates();
        if (!tpls.length) return '';
        return html`
            <section class="section" id="adsrule-templates" aria-labelledby="adsrule-templates-title">
                <h2 class="section-title" id="adsrule-templates-title">${t('ads.rules.templates.title')}</h2>
                <div class="adsrule-templates">
                    ${tpls.map((tpl) => html`
                        <article class="card adsrule-tpl" id="adsrule-tpl-${tpl.id}">
                            <h3 class="adsrule-name">${t(`ads.rules.tpl.${tpl.id}`)}</h3>
                            <p class="form-hint">${t(`ads.rules.tpl.${tpl.id}.hint`)}</p>
                            <div class="adsaud-actions">
                                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'plus', label: t('ads.rules.tpl.use'), action: 'adsrule:template', data: { id: tpl.id }, focusKey: `adsrule-tpl-${tpl.id}` })}
                            </div>
                        </article>
                    `)}
                </div>
            </section>
        `;
    },

    outcomeBadge(outcome) {
        const tone = { ok: 'success', acted: 'info', proposed: 'info', skipped_no_data: 'neutral', blind: 'warning' }[outcome] || 'neutral';
        return html`<span class="badge badge-${tone}">${t(`ads.rules.outcome.${outcome}`)}</span>`;
    },

    ruleMarkup(r) {
        const id = String(r.id);
        const owner = this.isOwner();
        const open = this.runs[id];
        return html`
            <article class="card adsrule-card" id="adsrule-${id}" data-enabled="${r.enabled ? 'true' : 'false'}">
                <header class="adsaud-head">
                    <h3 class="adsrule-name" dir="auto">${r.name}</h3>
                    <span class="badge badge-${r.enabled ? 'success' : 'neutral'}" id="adsrule-state-${id}">${t(r.enabled ? 'ads.rules.on' : 'ads.rules.off')}</span>
                    ${r.raises ? html`<span class="badge badge-info" id="adsrule-asks-${id}">${t('ads.rules.asksBadge')}</span>` : ''}
                    ${r.blind ? html`<span class="badge badge-warning" id="adsrule-blind-${id}"><i data-lucide="eye-off" aria-hidden="true"></i> ${t('ads.rules.blindBadge')}</span>` : ''}
                </header>
                <p class="adsrule-sentence" id="adsrule-say-${id}">${this.sentence(r)}</p>
                ${r.blind ? html`<p class="form-hint text-warning" id="adsrule-blind-why-${id}">${t('ads.rules.blindWhy')} ${UI.helpLink('ads#rules', t('help.link.learnMore'))}</p>` : ''}
                <p class="form-hint adsrule-last" id="adsrule-last-${id}">
                    ${r.lastRun ? html`${t('ads.rules.lastRun', { when: this.whenText(r.lastRun.ranAt) })} ${this.outcomeBadge(r.lastRun.outcome)}` : t('ads.rules.notRunYet')}
                </p>
                <div class="adsaud-actions">
                    ${UI.button({ variant: 'ghost', size: 'sm', icon: 'history', label: t(open ? 'ads.rules.history.hide' : 'ads.rules.history.show'), action: 'adsrule:history', data: { id }, focusKey: `adsrule-history-${id}` })}
                    ${owner ? html`
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: r.enabled ? 'pause' : 'play', label: t(r.enabled ? 'ads.rules.turnOff' : 'ads.rules.turnOn'), action: 'adsrule:toggle', data: { id }, focusKey: `adsrule-toggle-${id}` })}
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'pencil', label: t('common.edit'), action: 'adsrule:edit', data: { id }, focusKey: `adsrule-edit-${id}` })}
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('common.delete'), action: 'adsrule:remove', data: { id }, focusKey: `adsrule-remove-${id}` })}
                    ` : ''}
                </div>
                ${open ? html`<div class="adsrule-history" id="adsrule-history-${id}">${this.historyMarkup(open)}</div>` : ''}
            </article>
        `;
    },

    historyMarkup(open) {
        if (open.state === 'loading') return html`<p class="form-hint" role="status"><span class="spinner" aria-hidden="true"></span> ${t('common.loading')}</p>`;
        if (open.state === 'failed') return html`<p class="form-error">${t('ads.rules.history.failed')}</p>`;
        const runs = Array.isArray(open.runs) ? open.runs : [];
        if (!runs.length) return html`<p class="form-hint">${t('ads.rules.history.empty')}</p>`;
        return html`<ol class="adsrule-runs">${runs.map((run) => this.runMarkup(run))}</ol>`;
    },

    runMarkup(run) {
        const matched = Array.isArray(run.matched) ? run.matched : [];
        return html`
            <li class="adsrule-run" id="adsrule-run-${String(run.id)}">
                <div class="adsrule-run-head">
                    <span class="adsrule-when">${this.whenText(run.ranAt)}</span>
                    ${this.outcomeBadge(run.outcome)}
                    ${run.reason ? html`<span class="form-hint">${t(`ads.rules.reason.${run.reason}`)}</span>` : ''}
                    ${run.proposalId ? html`<a href="#/ads_proposals" class="adsrule-proposal">${t('ads.rules.history.proposal')}</a>` : ''}
                </div>
                ${matched.length ? html`<ul class="adsrule-matched">${matched.map((m) => html`
                    <li>
                        <strong dir="auto">${m.name}</strong>:
                        ${Object.keys(m.values || {}).map((k) => {
                            const [metric, win] = k.split(':');
                            return metric === 'rejected' ? '' : html`<span class="adsrule-value">${t(`ads.rules.metric.${metric}`)} (${t(`ads.rules.window.${win}`)}) ${this.valueText(metric, m.values[k])}</span>`;
                        })}
                        ${(m.steps || []).map((s) => html`<span class="adsrule-step">→ ${this.stepText(s)}</span>`)}
                        ${(m.skipped || []).map((s) => html`<span class="adsrule-skip">${t(`ads.rules.skipped.${s}`)}</span>`)}
                    </li>`)}</ul>` : ''}
            </li>
        `;
    },

    stepText(s) {
        if (s.kind === 'notify') return t('ads.rules.step.notify');
        if (s.kind === 'op' && s.action === 'pause') return t('ads.rules.step.pause');
        if (s.action === 'lower_budget' || s.action === 'raise_budget') {
            return t(`ads.rules.step.${s.action}`, { from: this.valueText('spend', s.from), to: this.valueText('spend', s.to) });
        }
        return t('ads.rules.step.resume');
    },

    // ─── The dialog ──────────────────────────────────────────────────────────

    blankDraft() {
        return { id: null, name: '', level: 'ad', objectIds: 'all', conditions: [{ metric: 'cost_per_conversation', op: '>', value: '', window: '3d' }], minData: { impressions: 500 }, effect: 'pause', percent: 20, notify: true };
    },

    /** A rule (or a template's spec) as the dialog's draft. */
    toDraft(r, name) {
        const effect = (r.actions || []).find((a) => a.type !== 'notify');
        return {
            id: r.id || null,
            name: name !== undefined ? name : r.name || '',
            level: (r.scope && r.scope.level) || 'ad',
            objectIds: r.scope && Array.isArray(r.scope.objectIds) ? r.scope.objectIds.map(String) : 'all',
            conditions: (r.conditions || []).map((c) => ({ ...c })),
            minData: { ...(r.minData || {}) },
            effect: effect ? effect.type : 'none',
            percent: effect && effect.percent ? effect.percent : 20,
            notify: (r.actions || []).some((a) => a.type === 'notify'),
        };
    },

    /** The draft as the server's rule. */
    toBody(d) {
        const actions = [];
        if (d.effect !== 'none') actions.push(d.effect === 'lower_budget' || d.effect === 'raise_budget' ? { type: d.effect, percent: Number(d.percent) } : { type: d.effect });
        if (d.notify) actions.push({ type: 'notify' });
        const minData = {};
        if (Number(d.minData.impressions) > 0) minData.impressions = Number(d.minData.impressions);
        if (Number(d.minData.spend) > 0) minData.spend = Number(d.minData.spend);
        return {
            name: String(d.name || '').trim(),
            scope: { level: d.level, objectIds: d.objectIds },
            conditions: d.conditions.map((c) => ({ metric: c.metric, op: c.op, value: c.metric === 'rejected' ? 1 : Number(c.value), window: c.window })),
            minData,
            actions,
        };
    },

    /** The same rules the server keeps (rulesEval.parseRuleSpec), so the owner hears about a mistake before he presses Save. Null = fine. */
    problem(d) {
        if (!String(d.name || '').trim()) return 'name';
        if (d.objectIds !== 'all' && (!Array.isArray(d.objectIds) || !d.objectIds.length)) return 'scope';
        if (!d.conditions.length) return 'conditions';
        for (const c of d.conditions) {
            if (c.metric !== 'rejected' && (c.value === '' || !Number.isFinite(Number(c.value)) || Number(c.value) < 0)) return 'value';
            if (c.metric === 'frequency' && (c.window !== 'today' || d.level === 'adset')) return 'frequency';
            if (c.metric === 'budget_pace' && d.level === 'ad') return 'pace';
        }
        const rejected = d.conditions.some((c) => c.metric === 'rejected');
        if (rejected && d.effect !== 'none') return 'rejected';
        if (d.effect === 'none' && !d.notify) return 'noAction';
        if (d.effect === 'lower_budget' && !(Number(d.percent) >= 5 && Number(d.percent) <= 90)) return 'lowerPercent';
        if (d.effect === 'raise_budget' && !(Number(d.percent) >= 5 && Number(d.percent) <= 100)) return 'raisePercent';
        return null;
    },

    async openForm(draft) {
        this.draft = draft;
        if (draft.objectIds !== 'all') await this.loadObjects(draft.level);
        UI.showModal(this.formMarkup(draft));
    },

    async loadObjects(level) {
        if (this.objects[level] !== undefined && this.objects[level] !== null) return;
        try {
            const answer = await API.getAdsObjects({ level, status: 'ACTIVE,PAUSED' });
            this.objects[level] = answer && Array.isArray(answer.items) ? answer.items : [];
        } catch {
            this.objects[level] = false;
        }
    },

    /** Read the dialog back into the draft (before a redraw and before Save). */
    readForm() {
        const d = this.draft || this.blankDraft();
        const val = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
        const checked = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };
        if (val('adsrule-f-name') !== undefined) d.name = val('adsrule-f-name');
        if (val('adsrule-f-level') !== undefined) d.level = val('adsrule-f-level');
        if (document.getElementById('adsrule-f-scope-all')) {
            if (checked('adsrule-f-scope-all')) d.objectIds = 'all';
            else {
                const boxes = document.querySelectorAll('input[name="adsrule-f-object"]');
                d.objectIds = Array.from(boxes || []).filter((b) => b.checked).map((b) => b.value);
            }
        }
        d.conditions = d.conditions.map((c, i) => ({
            metric: val(`adsrule-f-metric-${i}`) ?? c.metric,
            op: val(`adsrule-f-op-${i}`) ?? c.op,
            value: val(`adsrule-f-value-${i}`) ?? c.value,
            window: val(`adsrule-f-window-${i}`) ?? c.window,
        }));
        if (val('adsrule-f-min-impressions') !== undefined) d.minData = { impressions: val('adsrule-f-min-impressions'), spend: val('adsrule-f-min-spend') };
        const effect = document.querySelector('input[name="adsrule-f-effect"]:checked');
        if (effect) d.effect = effect.value;
        if (val('adsrule-f-percent') !== undefined) d.percent = val('adsrule-f-percent');
        if (document.getElementById('adsrule-f-notify')) d.notify = checked('adsrule-f-notify');
        this.draft = d;
        return d;
    },

    redrawForm() {
        const d = this.readForm();
        UI.showModal(this.formMarkup(d));
    },

    formMarkup(d) {
        const opt = (value, label, current) => html`<option value="${value}" ${String(current) === String(value) ? html.raw('selected') : ''}>${label}</option>`;
        const objects = this.objects[d.level];
        const raises = d.effect === 'raise_budget' || d.effect === 'resume';
        return html`
            <div class="modal-header">
                <h2 class="modal-title">${t(d.id ? 'ads.rules.form.editTitle' : 'ads.rules.form.title')}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}"><i data-lucide="x" aria-hidden="true"></i></button>
            </div>
            <div class="adsrule-form" id="adsrule-form">
                <div class="form-group">
                    <label class="form-label" for="adsrule-f-name">${t('ads.rules.form.name')}</label>
                    <input class="form-input" id="adsrule-f-name" maxlength="80" dir="auto" autocomplete="off" value="${d.name}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="adsrule-f-level">${t('ads.rules.form.level')}</label>
                    <select class="form-input" id="adsrule-f-level" data-change="adsrule:level">${this.LEVELS.map((l) => opt(l, t(`ads.rules.level.${l}`), d.level))}</select>
                </div>
                <fieldset class="form-group fieldset-plain">
                    <legend class="form-label">${t('ads.rules.form.scope')}</legend>
                    <div class="check-row"><input type="radio" name="adsrule-f-scope" id="adsrule-f-scope-all" value="all" data-change="adsrule:scope" ${d.objectIds === 'all' ? html.raw('checked') : ''}>
                        <div class="check-text"><label class="check-label" for="adsrule-f-scope-all">${t('ads.rules.form.scopeAll')}</label></div></div>
                    <div class="check-row"><input type="radio" name="adsrule-f-scope" id="adsrule-f-scope-some" value="some" data-change="adsrule:scope" ${d.objectIds !== 'all' ? html.raw('checked') : ''}>
                        <div class="check-text"><label class="check-label" for="adsrule-f-scope-some">${t('ads.rules.form.scopeSome')}</label></div></div>
                    ${d.objectIds !== 'all' ? (objects === false ? html`<p class="form-error">${t('ads.rules.form.objectsFailed')}</p>`
                        : html`<div class="adsrule-objects" id="adsrule-f-objects">${(objects || []).length ? (objects || []).map((o) => html`
                            <div class="check-row"><input type="checkbox" name="adsrule-f-object" id="adsrule-f-object-${o.id}" value="${o.id}" ${Array.isArray(d.objectIds) && d.objectIds.includes(String(o.id)) ? html.raw('checked') : ''}>
                                <div class="check-text"><label class="check-label" for="adsrule-f-object-${o.id}" dir="auto">${o.name || o.metaId}</label></div></div>`)
                            : html`<p class="form-hint">${t('ads.rules.form.noObjects')}</p>`}</div>`) : ''}
                </fieldset>
                <fieldset class="form-group fieldset-plain">
                    <legend class="form-label">${t('ads.rules.form.conditions')}</legend>
                    <p class="form-hint">${t('ads.rules.form.conditionsHint')}</p>
                    ${d.conditions.map((c, i) => html`
                        <div class="adsrule-cond" id="adsrule-f-cond-${i}">
                            <select class="form-input" id="adsrule-f-metric-${i}" aria-label="${t('ads.rules.form.metric')}" data-change="adsrule:redraw">${this.METRICS.map((m) => opt(m, t(`ads.rules.metric.${m}`), c.metric))}</select>
                            ${c.metric === 'rejected' ? '' : html`
                                <select class="form-input" id="adsrule-f-op-${i}" aria-label="${t('ads.rules.form.op')}">${this.OPS.map((o) => opt(o, t(`ads.rules.op.${this.OP_KEY[o]}`), c.op))}</select>
                                <input class="form-input" type="number" min="0" step="any" inputmode="decimal" id="adsrule-f-value-${i}" aria-label="${t('ads.rules.form.value')}" value="${c.value}">
                                <span class="form-hint">${this.MONEY_METRICS.includes(c.metric) ? this.currency() : c.metric === 'ctr' ? '%' : ''}</span>
                                <select class="form-input" id="adsrule-f-window-${i}" aria-label="${t('ads.rules.form.window')}">${this.WINDOWS.map((w) => opt(w, t(`ads.rules.window.${w}`), c.window))}</select>`}
                            ${d.conditions.length > 1 ? UI.button({ variant: 'ghost', size: 'sm', icon: 'x', label: t('ads.rules.form.removeCondition'), action: 'adsrule:removeCondition', data: { index: String(i) } }) : ''}
                        </div>
                        <p class="form-hint">${t(`ads.rules.metric.${c.metric}.hint`)}</p>
                    `)}
                    ${d.conditions.length < this.MAX_CONDITIONS ? UI.button({ variant: 'secondary', size: 'sm', icon: 'plus', label: t('ads.rules.form.addCondition'), action: 'adsrule:addCondition' }) : ''}
                </fieldset>
                <fieldset class="form-group fieldset-plain">
                    <legend class="form-label">${t('ads.rules.form.minData')}</legend>
                    <p class="form-hint">${t('ads.rules.form.minDataHint')}</p>
                    <div class="adsrule-cond">
                        <label class="form-label" for="adsrule-f-min-impressions">${t('ads.rules.form.minImpressions')}</label>
                        <input class="form-input" type="number" min="0" step="1" inputmode="numeric" id="adsrule-f-min-impressions" value="${d.minData.impressions ?? ''}">
                        <label class="form-label" for="adsrule-f-min-spend">${t('ads.rules.form.minSpend', { currency: this.currency() })}</label>
                        <input class="form-input" type="number" min="0" step="any" inputmode="decimal" id="adsrule-f-min-spend" value="${d.minData.spend ?? ''}">
                    </div>
                </fieldset>
                <fieldset class="form-group fieldset-plain">
                    <legend class="form-label">${t('ads.rules.form.then')}</legend>
                    ${this.EFFECTS.map((e) => html`
                        <div class="check-row"><input type="radio" name="adsrule-f-effect" id="adsrule-f-effect-${e}" value="${e}" data-change="adsrule:redraw" ${d.effect === e ? html.raw('checked') : ''}>
                            <div class="check-text"><label class="check-label" for="adsrule-f-effect-${e}">${t(`ads.rules.effect.${e}`)}</label>
                                <p class="form-hint">${t(`ads.rules.effect.${e}.hint`)}</p></div></div>`)}
                    ${d.effect === 'lower_budget' || d.effect === 'raise_budget' ? html`
                        <label class="form-label" for="adsrule-f-percent">${t('ads.rules.form.percent')}</label>
                        <input class="form-input" type="number" min="5" max="${d.effect === 'lower_budget' ? 90 : 100}" step="1" inputmode="numeric" id="adsrule-f-percent" value="${d.percent}">` : ''}
                    <div class="check-row"><input type="checkbox" id="adsrule-f-notify" ${d.notify ? html.raw('checked') : ''}>
                        <div class="check-text"><label class="check-label" for="adsrule-f-notify">${t('ads.rules.effect.notify')}</label></div></div>
                </fieldset>
                ${raises ? html`<p class="card adsrule-asks" id="adsrule-f-asks" role="note"><i data-lucide="sparkles" aria-hidden="true"></i> ${t('ads.rules.form.asksNote')}</p>` : ''}
                <p class="form-hint" id="adsrule-f-approve">${t('ads.rules.form.savingApproves')}</p>
                <div id="adsrule-f-error"></div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    ${UI.button({ variant: 'primary', icon: 'check', label: t('ads.rules.form.save'), action: 'adsrule:save', id: 'adsrule-f-save' })}
                </div>
            </div>
        `;
    },

    showFormError(text) {
        const box = document.getElementById('adsrule-f-error');
        if (box) box.innerHTML = esc(html`<p class="form-error" role="alert">${text}</p>`);
    },

    async save() {
        const d = this.readForm();
        const problem = this.problem(d);
        if (problem) return this.showFormError(t(`ads.rules.err.${problem}`));
        const body = this.toBody(d);
        try {
            const answer = d.id ? await API.updateAdsRule(d.id, body) : await API.createAdsRule(body);
            UI.closeModal();
            this.draft = null;
            if (answer && answer.rule && this.data) {
                const others = this.rules().filter((r) => r.id !== answer.rule.id);
                this.data.rules = d.id ? this.rules().map((r) => (r.id === answer.rule.id ? answer.rule : r)) : [...others, answer.rule];
            }
            this.paint();
            UI.toast(t(d.id ? 'ads.rules.saved' : 'ads.rules.created'), 'success');
        } catch (err) {
            this.showFormError(this.refusalText(err));
        }
    },

    // ─── Actions ─────────────────────────────────────────────────────────────

    find(id) {
        return this.rules().find((r) => String(r.id) === String(id)) || null;
    },

    useTemplate(id) {
        const tpl = this.templates().find((x) => x.id === id);
        if (!tpl) return;
        const d = this.toDraft(tpl.spec, t(`ads.rules.tpl.${id}`));
        if (tpl.needsValue) d.conditions = d.conditions.map((c) => ({ ...c, value: '' }));
        this.openForm(d);
    },

    async toggle(id) {
        const r = this.find(id);
        if (!r) return;
        try {
            const answer = await API.updateAdsRule(id, { enabled: !r.enabled });
            if (answer && answer.rule) this.data.rules = this.rules().map((x) => (x.id === id ? answer.rule : x));
            this.paint();
        } catch (err) {
            UI.toast(this.refusalText(err), 'error');
        }
    },

    remove(id) {
        const r = this.find(id);
        if (!r) return;
        UI.confirm({
            title: t('ads.rules.delete.title'), body: t('ads.rules.delete.body', { name: r.name }), confirmLabel: t('common.delete'),
            onConfirm: async () => {
                try {
                    await API.deleteAdsRule(id);
                    UI.closeModal();
                    this.data.rules = this.rules().filter((x) => x.id !== id);
                    delete this.runs[id];
                    this.paint();
                } catch (err) {
                    UI.toast(this.refusalText(err), 'error');
                }
            },
        });
    },

    async history(id) {
        if (this.runs[id]) {
            delete this.runs[id];
            return this.paint();
        }
        this.runs[id] = { state: 'loading', runs: [] };
        this.paint();
        try {
            const answer = await API.getAdsRuleRuns(id);
            if (!this.runs[id]) return;
            this.runs[id] = { state: 'ready', runs: answer && Array.isArray(answer.runs) ? answer.runs : [] };
        } catch {
            if (!this.runs[id]) return;
            this.runs[id] = { state: 'failed', runs: [] };
        }
        this.paint();
    },
};

UI.registerActions('adsrule', {
    new: () => AdsRulesPage.openForm(AdsRulesPage.blankDraft()),
    template: (el) => AdsRulesPage.useTemplate(el.dataset.id),
    edit: (el) => { const r = AdsRulesPage.find(el.dataset.id); if (r) AdsRulesPage.openForm(AdsRulesPage.toDraft(r)); },
    toggle: (el) => AdsRulesPage.toggle(el.dataset.id),
    remove: (el) => AdsRulesPage.remove(el.dataset.id),
    history: (el) => AdsRulesPage.history(el.dataset.id),
    save: () => AdsRulesPage.save(),
    redraw: () => AdsRulesPage.redrawForm(),
    // Another level lists other objects: the choice starts again from "all".
    level: () => { const d = AdsRulesPage.readForm(); d.objectIds = 'all'; UI.showModal(AdsRulesPage.formMarkup(d)); },
    scope: async () => {
        const d = AdsRulesPage.readForm();
        const some = document.getElementById('adsrule-f-scope-some');
        if (some && some.checked && d.objectIds === 'all') d.objectIds = [];
        if (d.objectIds !== 'all') await AdsRulesPage.loadObjects(d.level);
        UI.showModal(AdsRulesPage.formMarkup(d));
    },
    addCondition: () => {
        const d = AdsRulesPage.readForm();
        if (d.conditions.length < AdsRulesPage.MAX_CONDITIONS) d.conditions.push({ metric: 'spend', op: '>', value: '', window: 'today' });
        UI.showModal(AdsRulesPage.formMarkup(d));
    },
    removeCondition: (el) => {
        const d = AdsRulesPage.readForm();
        d.conditions.splice(Number(el.dataset.index), 1);
        UI.showModal(AdsRulesPage.formMarkup(d));
    },
});
