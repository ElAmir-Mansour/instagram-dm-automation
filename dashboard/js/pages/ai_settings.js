/**
 * AI Agent Settings — configuration on one side, a live sandbox on the other.
 *
 * Both textareas hold Arabic prose that the model reads verbatim, so they get
 * the loose Arabic leading and `unicode-bidi: plaintext` (via `.user-content`)
 * rather than the tight UI line-height: a system prompt with a Latin URL in
 * the middle of an Arabic sentence has to keep that URL where it was typed.
 *
 * Under both sits the "Meta vision (beta)" card (docs/specs/005-muse-sees T038): the owner's switches for the assistant reading what people send
 * (photos, reels, story mentions), who it answers (people he picks from his recent Instagram conversations, or everyone) and its daily cap. It is the
 * OWNER's (`POST /api/settings/ai/muse` is `canAdminister`), it has its own Save and its own unsaved note, and its state is the `muse` block of the
 * same `GET /api/settings/ai` the form loads from: `undefined` (a server that predates it) hides the card, `null` (the server could not read it) shows why
 * and offers nothing to save, so a card that failed to load is never saved over his real choice.
 *
 * Inside the card, below its own Save, is the video library (docs/specs/005-muse-sees T057): what the agent remembers of each reel the owner published, an "Index my
 * reels" button with what it costs, and the details of one reel (what is said, what is on screen, its moments, its hook, a caption). It has no draft and no Save: every
 * button is a request of its own (`/api/settings/ai/muse/library`, the OWNER's, reads included), and the list is asked for again while a reel waits, because there is no
 * progress route.
 */
const AiSettingsPage = {
    /**
     * This screen has no data of its own to wait for — the form's shape is
     * fixed and loadSettings() only fills in values — so the shell IS the
     * skeleton. App.navigate paints it inside the view transition and render()
     * finds it already there, which is why the page appears in one motion
     * instead of cross-fading to a placeholder and then snapping to a form.
     */
    skeleton() {
        return this.shell();
    },

    /**
     * Guards `loadSettings()` against landing after the operator has navigated
     * away. It writes by element id with no null checks, so a response that
     * arrived one tick after a navigation threw a TypeError on
     * `getElementById('ai-active-toggle').checked` and the whole fill was lost.
     */
    _seq: 0,

    /** The dirty prompt/knowledge text, parked across a navigation. */
    _draft: null,

    /** Set by `discardChanges()`: the person was asked, and said to lose the edits, so `destroy()` must not park them. */
    _discarded: false,

    /**
     * May this session change the agent? `POST /settings/ai`, `POST /settings/ai/test` and `POST /settings/sales-variants` are `canOperate` on the
     * server (the follow-up delay's route is a platform admin's, who always acts as owner), while `GET /settings/ai` is open to every role: a
     * viewer reads this page and has no live control on it, instead of learning it from an English 403 toast. Optimistic like `App.tenantRole()`:
     * where the shell cannot answer (a test harness, a page before the session has loaded) the session is an operator's.
     */
    canEdit() {
        return typeof App === 'undefined' || typeof App.canOperate !== 'function' || App.canOperate();
    },

    render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        if (!container.querySelector('.ai-grid')) {
            container.innerHTML = esc(this.shell());
            UI.icons(container);
        }
        Motion.clearSkeleton(container);

        // The two textareas hold the product: a half-written system prompt is
        // work nobody wants to retype. The router asks `canLeave()` before it
        // changes page, and its one shared `beforeunload` asks it for a reload,
        // a closed tab and the language switch: this page binds no handler of its own.
        this.loadSettings();
    },

    /**
     * False while something on this screen is unsaved: the router then asks before another page replaces it, and the shell's
     * `beforeunload` asks before a reload. The page's own idea of "unsaved" (`hasUnsavedChanges`), the one the note beside Save counts:
     * the two texts, the switch, the model, the temperature, the engine, the sales choice, the follow-up delay and the A/B wordings.
     */
    canLeave() {
        return !this.hasUnsavedChanges() && !this.museDirty();
    },

    /** Called after the person agreed to lose the edits (`App.discardCurrent`): the parked draft would bring them back. */
    discardChanges() {
        this._discarded = true;
        this._draft = null;
    },

    destroy() {
        this._seq++;
        // The library is asked for again on the next visit, and its poll stops with this page.
        this.museLibraryStop();
        // Navigation is already happening by the time this runs (the router has asked, if it was going to), so the honest
        // move for a LOGOUT or a tenant switch, which never ask, is to keep the
        // text and restore it the next time this screen opens. That is
        // announced THEN rather than now: on logout App.resetTenantState()
        // clears the draft immediately after this, and a "your draft is safe"
        // toast would have been a lie. A person who was asked and said "discard" is not given the draft back.
        if (this.isDirty() && !this._discarded) this._draft = this.currentValues();
        this._discarded = false;
    },

    resetTenantState() {
        // Another tenant's prompt must never be handed to this one.
        this._draft = null;
        this._saved = null;
        this._routeView = undefined;
        this._variants = undefined;
        this._muse = undefined;
        this._musePicker = null;
        this.museLibraryStop();
    },

    /** What the server last gave us, to compare the fields against. */
    _saved: null,

    /**
     * What `GET /api/admin/ai` said about the "dm" route, for the hint under the engine picker. `undefined`: not asked yet.
     * `null`: not available (the signed-in person is not a platform admin, whose endpoint this is, or the call failed): the
     * hint is only a hint, so it is then silent and never an error. Asked once per visit to this screen.
     */
    _routeView: undefined,

    /**
     * The follow-up delay, from `GET /api/settings/sales-followup` (S9): `{ minutes, min, max, defaultMinutes }`. It is one value for the whole
     * deployment with a platform admin's route of its own, so it is read, shown and saved by a platform admin only. `undefined`: not asked yet.
     * `null`: not available (not a platform admin, or the call failed): the field then stays out of the way. Asked once per visit to this screen.
     */
    _followup: undefined,

    /**
     * The A/B wording experiment (DM plan S14), from `GET /api/settings/sales-variants`: `{ limits, enabled, rows, savedCanon }`. It is the TENANT's own and any role
     * may read it, so unlike the follow-up it is asked for whoever is signed in; `undefined`: not asked yet, `null`: not available (an older server, or the call
     * failed), and the block then stays out of the way. `rows` is the editor's own copy: a row with nothing typed is legal here and dropped when saving, and a
     * row that came from the server (`saved`) can only be retired (a share of 0), never removed, so a slot is never given to a different wording.
     * `savedCanon` is what the server holds, in the form `variantsCanon` gives a draft, so "unsaved" is a comparison.
     */
    _variants: undefined,

    VARIANT_SLOTS: ['A', 'B', 'C'],

    currentValues() {
        const prompt = document.getElementById('system-prompt-text');
        const knowledge = document.getElementById('knowledge-base-text');
        if (!prompt || !knowledge) return null;
        return { system_prompt: prompt.value, knowledge_base: knowledge.value };
    },

    /** The switch, the model, the temperature and the reply engine — the rest of what Save writes. */
    currentSettings() {
        const toggle = document.getElementById('ai-active-toggle');
        const model = document.getElementById('model-selector');
        const slider = document.getElementById('temp-slider');
        if (!toggle || !model || !slider) return null;
        const settings = { is_active: !!toggle.checked, model: model.value, temperature: String(slider.value) };
        // Present only when the form has them, so a screen that predates the picker is read as it always was.
        const engine = document.getElementById('engine-selector');
        if (engine) settings.engine = engine.value === 'providers' ? 'providers' : 'gemini';
        const fallback = document.getElementById('gemini-fallback-toggle');
        if (fallback) settings.gemini_fallback = !!fallback.checked;
        // The sales turn's switch and its test senders (DM plan S6): present only when the form has them, like the engine's.
        const sales = document.getElementById('sales-mode-selector');
        if (sales) settings.sales_mode = this.salesMode();
        if (document.getElementById('sales-test-senders')) settings.sales_test_senders = this.testSenders().join('\n');
        return settings;
    },

    /**
     * The two texts are what a reload would lose (and what the draft keeps);
     * the switch, the model and the temperature are unsaved too, and the note
     * beside Save counts them.
     */
    isDirty() {
        const now = this.currentValues();
        if (!now || !this._saved) return false;
        return now.system_prompt !== this._saved.system_prompt
            || now.knowledge_base !== this._saved.knowledge_base;
    },

    hasUnsavedChanges() {
        if (this.isDirty() || this.followupDirty() || this.variantsDirty()) return true;
        const now = this.currentSettings();
        const saved = this._saved && this._saved.settings;
        if (!now || !saved) return false;
        return now.is_active !== saved.is_active || now.model !== saved.model || now.temperature !== saved.temperature
            || now.engine !== saved.engine || now.gemini_fallback !== saved.gemini_fallback
            || now.sales_mode !== saved.sales_mode || now.sales_test_senders !== saved.sales_test_senders;
    },

    /** The follow-up delay on screen differs from the one saved. False when the field is not there (not an admin, not loaded). */
    followupDirty() {
        const el = document.getElementById('sales-followup-minutes');
        return !!(el && this._followup && String(el.value).trim() !== String(this._followup.minutes));
    },

    /** AI6: «تغييرات غير محفوظة» beside Save, while there are any. */
    refreshDirty() {
        const note = document.getElementById('ai-unsaved-note');
        if (note) note.classList.toggle('hidden', !this.hasUnsavedChanges());
    },

    shell() {
        // A viewer reads: the switches, pickers, slider and buttons are disabled, and the text boxes are read-only, so the prompt can still be
        // read, selected and copied. An operator's markup is what it always was: both are '' for them.
        const editable = this.canEdit();
        const off = editable ? '' : html.raw(' disabled');
        const lock = editable ? '' : html.raw(' readonly');
        return html`
            <div class="ai-grid">
                <section class="surface ai-panel">
                    <!-- The outline used to jump h1 → h3 → h4. The tags stay
                         because the stylesheet scopes their type to the
                         element (.panel-head h3, .toggle-block h4); aria-level
                         fixes the level a screen reader reports without
                         touching a single pixel. -->
                    <div class="panel-head">
                        <i data-lucide="bot" aria-hidden="true"></i>
                        <h3 aria-level="2">${t('ai.configTitle')}</h3>
                    </div>
                    <p class="form-hint mbe-3">${UI.helpLink('dm-assistant', t('help.link.dmAssistant'), { newTab: true })} · ${UI.helpLink('ai-usage', t('help.link.aiUsage'), { newTab: true })}</p>
                    ${editable ? '' : html`<p class="form-hint mbe-3" id="ai-readonly-note" role="note"><i data-lucide="eye" aria-hidden="true"></i> ${t('ai.readOnly')}</p>`}
                    <div id="ai-settings-error"></div>
                    <form id="ai-settings-form" data-submit="ai:saveSettings"
                          data-input="ai:refreshDirty" data-change="ai:refreshDirty">
                        <div class="toggle-block">
                            <div>
                                <h4 aria-level="3">${t('ai.enableTitle')}</h4>
                                <p>${t('ai.enableDesc')}</p>
                            </div>
                            <label class="switch" for="ai-active-toggle">
                                <span class="sr-only">${t('ai.enableLabel')}</span>
                                <input type="checkbox" id="ai-active-toggle" checked${off}>
                                <span class="switch-track"></span>
                            </label>
                        </div>

                        <hr class="divider">

                        <div class="form-group">
                            <label class="form-label" for="system-prompt-text">
                                <span>${t('ai.systemPrompt')}</span>
                                <span class="badge badge-info">${t('ai.arabicBadge')}</span>
                            </label>
                            <span class="field-desc" id="system-prompt-desc">${t('ai.systemPromptDesc')}</span>
                            <!-- lang="ar": the prompt and the knowledge base ARE
                                 the product and are always Arabic. With the
                                 English UI they sat in a lang="en" document, so
                                 a screen reader read Arabic with an English
                                 voice — unintelligible, not merely wrong. -->
                            <textarea id="system-prompt-text" class="field-textarea user-content" dir="auto" lang="ar" rows="8"
                                      aria-describedby="system-prompt-desc"
                                      placeholder="${t('ai.systemPromptPlaceholder')}" required${lock}></textarea>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="knowledge-base-text">${t('ai.knowledge')}</label>
                            <span class="field-desc" id="knowledge-base-desc">${t('ai.knowledgeDesc')}</span>
                            <textarea id="knowledge-base-text" class="field-textarea user-content" dir="auto" lang="ar" rows="10"
                                      aria-describedby="knowledge-base-desc"
                                      placeholder="${t('ai.knowledgePlaceholder')}"${lock}></textarea>
                        </div>

                        <!-- The reply engine: Gemini is the call the bot has always made; AI providers goes through the layer
                             the operator configures in Operations (purpose "dm"). The model and temperature below are Gemini's. -->
                        <div class="form-group">
                            <label class="form-label" for="engine-selector">${t('ai.engine')}</label>
                            <select class="select" id="engine-selector" data-change="ai:engineChanged"
                                    aria-describedby="engine-desc engine-route-hint"${off}>
                                <option value="gemini">${t('ai.engineGemini')}</option>
                                <option value="providers">${t('ai.engineProviders')}</option>
                            </select>
                            <span class="field-desc" id="engine-desc">${t('ai.engineDesc')}</span>
                            <p class="form-hint hidden" id="engine-route-hint" role="status" aria-live="polite"></p>
                        </div>

                        <div class="toggle-block hidden" id="fallback-block">
                            <div>
                                <h4 aria-level="3">${t('ai.fallbackTitle')}</h4>
                                <p>${t('ai.fallbackDesc')}</p>
                            </div>
                            <label class="switch" for="gemini-fallback-toggle">
                                <span class="sr-only">${t('ai.fallbackLabel')}</span>
                                <input type="checkbox" id="gemini-fallback-toggle" data-change="ai:fallbackChanged" checked${off}>
                                <span class="switch-track"></span>
                            </label>
                        </div>

                        <!-- The sales assistant (DM plan S6): Off is today's replies, Test answers only the listed senders, On everyone. It writes
                             through the same "dm" route as the engine above, whichever engine is picked. The IDs are numbers, so the box is LTR. -->
                        <div class="form-group">
                            <label class="form-label" for="sales-mode-selector">${t('ai.sales')}</label>
                            <select class="select" id="sales-mode-selector" data-change="ai:salesChanged" aria-describedby="sales-desc"${off}>
                                <option value="off">${t('ai.salesOff')}</option>
                                <option value="test">${t('ai.salesTest')}</option>
                                <option value="on">${t('ai.salesOn')}</option>
                            </select>
                            <span class="field-desc" id="sales-desc">${t('ai.salesDesc')}</span>
                        </div>

                        <div class="form-group hidden" id="sales-senders-block">
                            <label class="form-label" for="sales-test-senders">${t('ai.salesSenders')}</label>
                            <span class="field-desc" id="sales-senders-desc">${t('ai.salesSendersDesc')}</span>
                            <textarea id="sales-test-senders" class="field-textarea" dir="ltr" lang="en" rows="3" inputmode="numeric"
                                      spellcheck="false" autocomplete="off" data-input="ai:salesChanged"
                                      aria-describedby="sales-senders-desc sales-senders-hint"
                                      placeholder="${t('ai.salesSendersPlaceholder')}"${lock}></textarea>
                            <p class="form-hint hidden" id="sales-senders-hint" role="status" aria-live="polite"></p>
                        </div>

                        <!-- The one follow-up nudge, hours after a link (DM plan S9): a platform admin's setting for the whole deployment, so the
                             block stays hidden until the screen has read it (it never does for anyone else) and the sales assistant is not Off. -->
                        <div class="form-group hidden" id="sales-followup-block">
                            <label class="form-label" for="sales-followup-minutes">${t('ai.salesFollowup')}</label>
                            <span class="field-desc" id="sales-followup-desc">${t('ai.salesFollowupDesc')}</span>
                            <input class="field" id="sales-followup-minutes" type="number" inputmode="numeric" dir="ltr" lang="en" min="0" max="1320" step="1"
                                   autocomplete="off" data-input="ai:salesChanged" aria-describedby="sales-followup-desc sales-followup-hint"${lock}>
                            <p class="form-hint hidden" id="sales-followup-hint" role="status" aria-live="polite"></p>
                        </div>

                        <!-- The A/B wording experiment (DM plan S14): up to three variants of how the sales assistant opens and offers the link. It is the
                             tenant's own and any role may read it, so the block stays hidden until the screen has read it (never, for a server that lacks it)
                             and the sales assistant is not Off. The variants are drawn into the list by paintVariants(). -->
                        <div class="form-group hidden" id="sales-variants-block">
                            <div class="toggle-block">
                                <div>
                                    <h4 aria-level="3">${t('ai.variants')}</h4>
                                    <p id="sales-variants-desc">${t('ai.variantsDesc')}</p>
                                </div>
                                <label class="switch" for="sales-variants-enabled">
                                    <span class="sr-only">${t('ai.variantsRun')}</span>
                                    <input type="checkbox" id="sales-variants-enabled" data-change="ai:variantsChanged" aria-describedby="sales-variants-desc sales-variants-hint"${off}>
                                    <span class="switch-track"></span>
                                </label>
                            </div>
                            <div class="variant-list" id="sales-variants-list"></div>
                            <div class="variant-actions">
                                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'plus', label: t('ai.variantAdd'), action: 'ai:addVariant', id: 'sales-variant-add', disabled: !editable })}
                            </div>
                            <p class="form-hint">${t('ai.variantsRetire')}</p>
                            <p class="form-hint hidden" id="sales-variants-hint" role="status" aria-live="polite"></p>
                        </div>

                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label" for="model-selector">${t('ai.model')}</label>
                                <!-- Exactly SUPPORTED_MODELS in src/services/ai.ts, the
                                     default first; screens.test.ts fails if they drift.
                                     This still offered Gemini 1.5 Flash after Google
                                     stopped serving it, and choosing it would have
                                     failed every DM. -->
                                <select class="select" id="model-selector" aria-describedby="model-selector-hint"${off}>
                                    <option value="gemini-2.5-flash">Gemini 2.5 Flash ${t('ai.defaultModel')}</option>
                                    <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                                    <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
                                </select>
                                <span class="field-desc" id="model-selector-hint">${t('ai.modelHint')}</span>
                            </div>
                            <div class="form-group">
                                <!-- The label used to be rewritten on every
                                     arrow key ("Temperature: 0.8"), so the
                                     slider's accessible NAME changed as you
                                     used it and the announcement was the name
                                     rather than the value. The label is now
                                     static and the number lives in an <output>
                                     outside it — the range input already
                                     announces its own value natively. -->
                                <div class="row row--between gap-2">
                                    <label class="form-label" for="temp-slider">${t('ai.temperatureLabel')}</label>
                                    <output class="text-meta" id="temp-value" for="temp-slider">0.7</output>
                                </div>
                                <input type="range" id="temp-slider" min="0" max="1" step="0.1" value="0.7"
                                       data-input="ai:updateTemperature" aria-describedby="temp-anchors"${off}>
                                <!-- AI5: what the two ends mean. A bare 0–1 slider said
                                     nothing about which end stops the agent improvising. -->
                                <span class="field-desc" id="temp-anchors">${t('ai.temperatureAnchors')}</span>
                            </div>
                        </div>

                        <div class="form-actions ai-save-row">
                            ${UI.button({
                                variant: 'primary', type: 'submit', icon: 'check',
                                label: t('common.saveChanges'), id: 'save-settings-btn', disabled: !editable,
                            })}
                            <span class="unsaved-note hidden" id="ai-unsaved-note" role="status">${t('ai.unsaved')}</span>
                        </div>
                    </form>
                </section>

                <section class="surface ai-sandbox">
                    <div class="panel-head">
                        <i data-lucide="terminal" aria-hidden="true"></i>
                        <h3 aria-level="2">${t('ai.sandboxTitle')}</h3>
                    </div>
                    <p class="panel-desc">${t('ai.sandboxDesc')}</p>

                    <div class="sandbox-shell">
                        <!-- aria-relevant="additions": the default is
                             "additions text", which also announces text
                             CHANGES inside bubbles that are already there. -->
                        <div class="sandbox-messages" id="sandbox-messages-container" role="log" aria-live="polite"
                             aria-relevant="additions" aria-label="${t('ai.sandboxTitle')}">
                            <div class="sandbox-welcome">
                                <div class="bot-avatar"><i data-lucide="bot" aria-hidden="true"></i></div>
                                <h4 aria-level="3">${t('ai.sandboxWelcome')}</h4>
                                <p dir="auto">${t('ai.sandboxWelcomeBody')}</p>
                            </div>
                        </div>
                        <div class="sandbox-composer">
                            <form id="sandbox-send-form" data-submit="ai:sendSandboxTest">
                                <label class="sr-only" for="sandbox-user-input">${t('ai.sandboxLabel')}</label>
                                <input type="text" class="field" id="sandbox-user-input" dir="auto"
                                       placeholder="${t('ai.sandboxPlaceholder')}"${off}>
                                ${UI.button({
                                    variant: 'primary', type: 'submit', icon: 'send',
                                    ariaLabel: t('ai.sandboxSend'), id: 'sandbox-btn', disabled: !editable,
                                })}
                            </form>
                        </div>
                    </div>
                </section>

                ${this.museShell()}
            </div>
        `;
    },

    async loadSettings() {
        const seq = ++this._seq;
        try {
            const settings = await API.getAiSettings();
            // The operator has left; these elements belong to another page now.
            if (seq !== this._seq) return;
            const temperature = settings.temperature != null ? settings.temperature : 0.7;

            const toggle = document.getElementById('ai-active-toggle');
            const prompt = document.getElementById('system-prompt-text');
            const knowledge = document.getElementById('knowledge-base-text');
            const model = document.getElementById('model-selector');
            const slider = document.getElementById('temp-slider');
            if (!toggle || !prompt || !knowledge || !model || !slider) return;

            // The catch below disables Save so an empty form cannot be written
            // over a real prompt — and nothing ever turned it back on. A failed
            // load followed by a successful Retry therefore left the operator
            // looking at their actual system prompt above a dead Save button,
            // with no way out but a full page reload. Re-enabling belongs here,
            // with the fill that makes the form safe to submit again.
            // (Never for a viewer: Save was drawn disabled, and a load must not hand it back.)
            const saveBtn = document.getElementById('save-settings-btn');
            if (saveBtn) saveBtn.disabled = !this.canEdit();

            toggle.checked = settings.is_active !== false;
            prompt.value = settings.system_prompt || '';
            knowledge.value = settings.knowledge_base || '';
            // No fallback literal: the server sends the model the agent actually runs on (a
            // stored one it no longer supports comes back as the default), so the value is
            // always one of the options. The old `|| 'gemini-2.5-flash'` was a second copy of
            // the default, free to drift from the server's.
            model.value = settings.model;
            slider.value = temperature;
            this.updateTemperature(temperature);

            // Optional: a server that predates the engine (or a row from before v37) sends neither, which is Gemini with the
            // fallback on, the behaviour it always had.
            const engine = document.getElementById('engine-selector');
            if (engine) engine.value = settings.engine === 'providers' ? 'providers' : 'gemini';
            const fallback = document.getElementById('gemini-fallback-toggle');
            if (fallback) fallback.checked = settings.gemini_fallback !== false;
            // Optional too: a server that predates the sales turn (or a row from before v39) sends neither, which is Off with no senders.
            const sales = document.getElementById('sales-mode-selector');
            if (sales) sales.value = ['test', 'on'].includes(settings.sales_mode) ? settings.sales_mode : 'off';
            const senders = document.getElementById('sales-test-senders');
            if (senders) senders.value = Array.isArray(settings.sales_test_senders) ? settings.sales_test_senders.join('\n') : '';
            this._routeView = undefined;
            this._followup = undefined;
            this._variants = undefined;
            this.syncEngine();
            this.syncSales();
            // The Meta vision card's own block of the same answer (`muse`): absent hides the card, null says it could not be read.
            this.adoptMuse(settings.muse);

            this._saved = {
                system_prompt: prompt.value,
                knowledge_base: knowledge.value,
                settings: this.currentSettings(),
            };

            // An unsaved draft from before a navigation outranks the server's
            // copy — it is the newer of the two, and it is the one the operator
            // was in the middle of writing.
            if (this._draft) {
                prompt.value = this._draft.system_prompt;
                knowledge.value = this._draft.knowledge_base;
                this._draft = null;
                UI.toast(t('ai.draftRestored'), 'success');
            }

            this.refreshDirty();
            Motion.announce(`${t('nav.ai_settings')} — ${t('common.loaded')}`);
        } catch (err) {
            if (seq !== this._seq) return;
            console.error('AI Settings Load Error:', err);
            // An unloaded form full of empty fields would otherwise look like
            // "no prompt configured", and saving it would wipe the real one.
            const host = document.getElementById('ai-settings-error');
            if (host) {
                UI.renderError(
                    host,
                    {
                        title: t('ai.loadErrorTitle'),
                        message: err.message,
                        hint: t('ai.loadErrorHint'),
                    },
                    () => { host.innerHTML = ''; this.loadSettings(); }
                );
            }
            const saveBtn = document.getElementById('save-settings-btn');
            if (saveBtn) saveBtn.disabled = true;
        }
    },

    /**
     * A provider's name, a model id or an error code is Latin text dropped into a sentence that may be Arabic: unisolated, the
     * bidi algorithm lets the sentence's own punctuation and the hyphens and digits of an id (`claude-opus-5-5`) reorder around
     * it. First-strong isolates (U+2068 .. U+2069) keep the run whole and in its own direction, in either language.
     */
    isolate(value) {
        return `\u2068${String(value)}\u2069`;
    },

    /** The engine on screen. */
    engineValue() {
        const el = document.getElementById('engine-selector');
        return el && el.value === 'providers' ? 'providers' : 'gemini';
    },

    /** Whether the Gemini fallback switch is on, on screen. */
    fallbackOn() {
        const el = document.getElementById('gemini-fallback-toggle');
        return !el || !!el.checked;
    },

    /** The sales mode on screen: off, test or on. Anything else (a form that lacks the picker) is off. */
    salesMode() {
        const el = document.getElementById('sales-mode-selector');
        return el && (el.value === 'test' || el.value === 'on') ? el.value : 'off';
    },

    /** Whether the AI providers layer writes replies now: the engine is AI providers, or the sales assistant is on (it always uses the layer). */
    usesProviders() {
        return this.engineValue() === 'providers' || this.salesMode() !== 'off';
    },

    /** The test senders on screen: one ID per entry, trimmed and each once, in the order typed. Commas, spaces and lines all separate. */
    testSenders() {
        const el = document.getElementById('sales-test-senders');
        const out = [];
        String(el ? el.value : '').split(/[\s,;\u060C]+/).forEach((part) => {
            const id = part.trim();
            if (id && !out.includes(id)) out.push(id);
        });
        return out;
    },

    /**
     * What is wrong with the senders on screen, as a hint: the first entry that is not an ID (IDs are 5 to 32 digits), too many, or none while
     * Test is chosen (then nobody gets sales replies). Pure over its arguments. null: nothing to say. The server checks again and refuses a bad one.
     */
    sendersHint(mode, senders) {
        const bad = senders.find((id) => !/^\d{5,32}$/.test(id));
        if (bad !== undefined) return { tone: 'warning', text: t('ai.salesSendersInvalid', { value: this.isolate(bad.slice(0, 40)) }) };
        if (senders.length > 20) return { tone: 'warning', text: t('ai.salesSendersMany', { max: 20 }) };
        if (mode === 'test' && senders.length === 0) return { tone: 'warning', text: t('ai.salesSendersEmpty') };
        return null;
    },

    /** Shows the senders box only in Test mode, and says what is wrong with it. Written as text, so nothing in it is ever markup. */
    syncSales() {
        const mode = this.salesMode();
        const block = document.getElementById('sales-senders-block');
        if (block) block.classList.toggle('hidden', mode !== 'test');
        const hintEl = document.getElementById('sales-senders-hint');
        if (hintEl) {
            const hint = mode === 'test' ? this.sendersHint(mode, this.testSenders()) : null;
            hintEl.textContent = hint ? hint.text : '';
            hintEl.classList.toggle('hidden', !hint);
            hintEl.classList.toggle('text-warning', !!hint);
        }
        // The follow-up delay: asked for once the sales assistant is on (Test or On), and shown only to the platform admin who may change it.
        if (mode !== 'off') this.loadFollowup();
        const followupBlock = document.getElementById('sales-followup-block');
        if (followupBlock) followupBlock.classList.toggle('hidden', mode === 'off' || !this._followup);
        const followupHint = document.getElementById('sales-followup-hint');
        if (followupHint) {
            const hint = this._followup ? this.followupHint(this.followupMinutes()) : null;
            followupHint.textContent = hint ? hint.text : '';
            followupHint.classList.toggle('hidden', !hint);
            followupHint.classList.toggle('text-warning', !!hint && hint.tone === 'warning');
        }
        // The wording experiment: asked for once the sales assistant is on (Test or On), whoever is signed in, and shown once it has been read.
        if (mode !== 'off') this.loadVariants();
        const variantsBlock = document.getElementById('sales-variants-block');
        if (variantsBlock) variantsBlock.classList.toggle('hidden', mode === 'off' || !this._variants);
        this.paintVariantsHint();
        // The fallback switch and the route hint mean something whenever the layer writes replies, which Sales On and Test do too.
        this.syncEngine();
    },

    // ─── The wording experiment (DM plan S14) ────────────────────────────────────────────────

    /** The first slot no row holds, or null when all are used. */
    freeVariantSlot(rows) {
        const taken = new Set(rows.map((r) => r.id));
        return this.VARIANT_SLOTS.find((id) => !taken.has(id)) || null;
    },

    blankVariant(id) {
        return { id, label: '', weight: 50, opening: '', cta: '', saved: false };
    },

    /** Whitespace of any kind as one space, as the server squashes it: what is compared and what is sent. */
    squash(value) {
        return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
    },

    /** A row with nothing typed (no name, no wording) is not a variant: it is dropped when saving. Its share alone does not make it one. */
    variantBlank(row) {
        return this.squash(row.label) === '' && this.squash(row.opening) === '' && this.squash(row.cta) === '';
    },

    /** The editor's rows from a config the server sent (`saved`), padded with blank ones to the two a comparison needs. Slots that are not ours are dropped. */
    variantRowsFrom(config) {
        const list = config && Array.isArray(config.variants) ? config.variants : [];
        const rows = list.filter((v) => v && this.VARIANT_SLOTS.includes(v.id)).map((v) => ({
            id: v.id, label: this.squash(v.label), weight: Number.isInteger(v.weight) ? v.weight : 0,
            opening: this.squash(v.opening), cta: this.squash(v.cta), saved: true,
        }));
        while (rows.length < 2) {
            const id = this.freeVariantSlot(rows);
            if (!id) break;
            rows.push(this.blankVariant(id));
        }
        return rows.sort((a, b) => this.VARIANT_SLOTS.indexOf(a.id) - this.VARIANT_SLOTS.indexOf(b.id));
    },

    /** What the server takes for these rows: blank rows left out, texts squashed, a share kept as typed when it is not a number (the check names it). */
    variantsPayloadOf(enabled, rows) {
        const variants = rows.filter((r) => !this.variantBlank(r)).map((r) => {
            const typed = String(r.weight === undefined || r.weight === null ? '' : r.weight).trim();
            return {
                id: r.id, label: this.squash(r.label), weight: /^\d{1,3}$/.test(typed) ? Number(typed) : typed,
                opening: this.squash(r.opening), cta: this.squash(r.cta),
            };
        });
        return { enabled: !!enabled, variants };
    },

    /** One string for a payload, so "unsaved changes" is a comparison. */
    variantsCanon(payload) {
        return JSON.stringify([payload.enabled, payload.variants.map((v) => [v.id, v.label, v.weight, v.opening, v.cta])]);
    },

    /** Copies what is typed into the rows and the switch. A field that is not on the page keeps what the row has. */
    syncVariantRows() {
        const state = this._variants;
        if (!state) return;
        const read = (id, fallback) => {
            const el = document.getElementById(id);
            return el && typeof el.value === 'string' ? el.value : fallback;
        };
        state.rows.forEach((row) => {
            row.label = read(`sales-variant-${row.id}-label`, row.label);
            row.weight = read(`sales-variant-${row.id}-weight`, row.weight);
            row.opening = read(`sales-variant-${row.id}-opening`, row.opening);
            row.cta = read(`sales-variant-${row.id}-cta`, row.cta);
        });
        const toggle = document.getElementById('sales-variants-enabled');
        if (toggle) state.enabled = !!toggle.checked;
    },

    /** The experiment on screen, as the server takes it. null when the block is not there (not read, or not available). */
    variantsDraft() {
        if (!this._variants) return null;
        this.syncVariantRows();
        return this.variantsPayloadOf(this._variants.enabled, this._variants.rows);
    },

    /** The experiment on screen differs from the one saved. False when the block is not there. */
    variantsDirty() {
        const draft = this.variantsDraft();
        return !!draft && this.variantsCanon(draft) !== this._variants.savedCanon;
    },

    /**
     * What is wrong with this payload, as the code the server would answer with, or null. The cheap checks only: whether a text carries a link or a number
     * is the server's to say (it answers `VARIANTS_INVALID` with the field and code, and `variantsProblemText` words it). A draft that is switched off may
     * be half written: only a running experiment needs two variants with a share.
     */
    variantsProblem(payload) {
        const limits = (this._variants && this._variants.limits) || { label: 40, text: 300, weight: 100 };
        const seen = new Set();
        for (const v of payload.variants) {
            if (v.label === '') return 'label_missing';
            if (Array.from(v.label).length > limits.label) return 'label_long';
            if (seen.has(v.label.toLowerCase())) return 'label_duplicate';
            seen.add(v.label.toLowerCase());
            if (!Number.isInteger(v.weight) || v.weight < 0 || v.weight > limits.weight) return 'weight_invalid';
            if (Array.from(v.opening).length > limits.text || Array.from(v.cta).length > limits.text) return 'text_long';
        }
        if (payload.enabled) {
            if (payload.variants.length < 2) return 'too_few';
            if (payload.variants.filter((v) => v.weight > 0).length < 2) return 'weights_one_arm';
        }
        return null;
    },

    /** The words for a problem code, in the page's language; a code this page does not know says the generic line. */
    variantsProblemText(code) {
        const known = ['too_few', 'weights_one_arm', 'label_missing', 'label_long', 'label_duplicate', 'weight_invalid', 'text_long', 'text_link', 'text_number'];
        const limits = (this._variants && this._variants.limits) || { label: 40, text: 300, weight: 100 };
        const max = code === 'label_long' ? limits.label : code === 'weight_invalid' ? limits.weight : limits.text;
        return t(`ai.variantsProblem.${known.includes(code) ? code : 'other'}`, { max });
    },

    /** The server's refusal of a save as words, or '' when the error is not one. */
    variantsErrorText(err) {
        const body = err && err.body;
        if (!body || body.code !== 'VARIANTS_INVALID' || !Array.isArray(body.problems) || !body.problems[0]) return '';
        return this.variantsProblemText(String(body.problems[0].code || ''));
    },

    /** "A 50% · B 30% · C 20%": how new conversations are shared out, from the shares on screen. Empty when nothing has a share. */
    variantsSplit(payload) {
        const arms = payload.variants.filter((v) => typeof v.weight === 'number' && v.weight > 0);
        const total = arms.reduce((n, v) => n + v.weight, 0);
        if (total <= 0) return '';
        return arms.map((v) => `${v.id} ${UI.formatPercent(Math.round((100 * v.weight) / total))}`).join(' · ');
    },

    /** The line under the block: what is wrong, else how conversations are split while it runs. Written as text, so nothing in it is ever markup. */
    paintVariantsHint() {
        const el = document.getElementById('sales-variants-hint');
        if (!el) return;
        const draft = this.variantsDraft();
        let hint = null;
        if (draft) {
            const problem = this.variantsProblem(draft);
            if (problem) hint = { tone: 'warning', text: this.variantsProblemText(problem) };
            else if (draft.enabled && this.variantsSplit(draft)) hint = { tone: 'muted', text: t('ai.variantsSplit', { split: this.isolate(this.variantsSplit(draft)) }) };
        }
        el.textContent = hint ? hint.text : '';
        el.classList.toggle('hidden', !hint);
        el.classList.toggle('text-warning', !!hint && hint.tone === 'warning');
    },

    /** One variant's card. Everything typed is an attribute value or element text of the `html` tag, which escapes it. */
    variantCard(row, canRemove, limits) {
        const field = (name) => `sales-variant-${row.id}-${name}`;
        // Read-only for a viewer, like the rest of the form; '' for an operator.
        const lock = this.canEdit() ? '' : html.raw(' readonly');
        return html`
            <fieldset class="variant-card" data-slot="${row.id}">
                <legend class="variant-card-title">${t('ai.variantSlot', { slot: this.isolate(row.id) })}</legend>
                <div class="form-grid">
                    <div class="form-group">
                        <label class="form-label" for="${field('label')}">${t('ai.variantName')}</label>
                        <input class="field" id="${field('label')}" type="text" maxlength="${limits.label}" dir="auto" autocomplete="off"
                               value="${row.label}" placeholder="${t('ai.variantNamePlaceholder')}" data-input="ai:variantsChanged"${lock}>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="${field('weight')}">${t('ai.variantShare')}</label>
                        <input class="field" id="${field('weight')}" type="number" inputmode="numeric" dir="ltr" lang="en" min="0" max="${limits.weight}" step="1"
                               autocomplete="off" value="${row.weight}" data-input="ai:variantsChanged"${lock}>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label" for="${field('opening')}">${t('ai.variantOpening')}</label>
                    <textarea class="field-textarea variant-text" id="${field('opening')}" rows="2" maxlength="${limits.text}" dir="auto"
                              placeholder="${t('ai.variantOpeningPlaceholder')}" data-input="ai:variantsChanged"${lock}>${row.opening}</textarea>
                </div>
                <div class="form-group">
                    <label class="form-label" for="${field('cta')}">${t('ai.variantCta')}</label>
                    <textarea class="field-textarea variant-text" id="${field('cta')}" rows="2" maxlength="${limits.text}" dir="auto"
                              placeholder="${t('ai.variantCtaPlaceholder')}" data-input="ai:variantsChanged"${lock}>${row.cta}</textarea>
                </div>
                ${canRemove ? UI.button({ variant: 'ghost', size: 'sm', icon: 'trash-2', label: t('ai.variantRemove', { slot: this.isolate(row.id) }), action: 'ai:removeVariant', data: { slot: row.id } }) : ''}
            </fieldset>
        `;
    },

    /** Draws the switch, the variants and the hint from the rows. Typing never calls this (it would take the caret), adding and removing do. */
    paintVariants() {
        const state = this._variants;
        const list = document.getElementById('sales-variants-list');
        if (!state || !list) return;
        const editable = this.canEdit();
        list.innerHTML = esc(state.rows.map((row) => this.variantCard(row, editable && !row.saved && state.rows.length > 2, state.limits)));
        UI.icons(list);
        const toggle = document.getElementById('sales-variants-enabled');
        if (toggle) toggle.checked = state.enabled;
        const add = document.getElementById('sales-variant-add');
        if (add) add.disabled = !editable || state.rows.length >= state.limits.max;
        this.paintVariantsHint();
    },

    /** Asks for the experiment once per visit. Never an error: a server without it simply has no block. */
    async loadVariants() {
        if (this._variants !== undefined) return;
        this._variants = null;
        const seq = this._seq;
        try {
            const got = await API.getSalesVariants();
            if (got && got.config && Array.isArray(got.config.variants)) {
                const l = got.limits || {};
                const limits = {
                    max: Number.isInteger(l.max) ? l.max : 3, label: Number.isInteger(l.label) ? l.label : 40,
                    text: Number.isInteger(l.text) ? l.text : 300, weight: Number.isInteger(l.weight) ? l.weight : 100,
                };
                const rows = this.variantRowsFrom(got.config);
                const enabled = got.config.enabled === true;
                this._variants = { limits, enabled, rows, savedCanon: this.variantsCanon(this.variantsPayloadOf(enabled, rows)) };
            }
        } catch (err) {
            this._variants = null;
        }
        // The operator left while it was in flight: those elements belong to another page now.
        if (seq !== this._seq) return;
        this.paintVariants();
        this.syncSales();
        this.refreshDirty();
    },

    /** What the server answered to a save is now what is on screen and what is saved. */
    adoptVariants(got) {
        if (!this._variants || !got || !got.config) return;
        const rows = this.variantRowsFrom(got.config);
        const enabled = got.config.enabled === true;
        this._variants = { ...this._variants, enabled, rows, savedCanon: this.variantsCanon(this.variantsPayloadOf(enabled, rows)) };
        this.paintVariants();
    },

    variantsChanged() {
        this.paintVariantsHint();
        this.refreshDirty();
    },

    addVariant() {
        const state = this._variants;
        if (!state || !this.canEdit()) return;
        this.syncVariantRows();
        const id = state.rows.length < state.limits.max ? this.freeVariantSlot(state.rows) : null;
        if (!id) return;
        state.rows.push(this.blankVariant(id));
        state.rows.sort((a, b) => this.VARIANT_SLOTS.indexOf(a.id) - this.VARIANT_SLOTS.indexOf(b.id));
        this.paintVariants();
        const label = document.getElementById(`sales-variant-${id}-label`);
        if (label && typeof label.focus === 'function') label.focus();
        this.refreshDirty();
    },

    /** Only a variant nobody has saved can be removed: a saved one may already hold conversations, and its slot must not be given to other wording. */
    removeVariant(slot) {
        const state = this._variants;
        if (!state || !this.canEdit()) return;
        this.syncVariantRows();
        const row = state.rows.find((r) => r.id === slot);
        if (!row || row.saved || state.rows.length <= 2) return;
        state.rows = state.rows.filter((r) => r.id !== slot);
        this.paintVariants();
        this.refreshDirty();
    },

    /**
     * The follow-up delay on screen: a whole number of minutes from `min` to `max` (0 turns follow-ups off), or `null` for anything else (empty,
     * a decimal, out of range). The server checks again and refuses a bad one.
     */
    followupMinutes() {
        const el = document.getElementById('sales-followup-minutes');
        const text = String(el ? el.value : '').trim();
        if (!/^\d{1,4}$/.test(text)) return null;
        const minutes = Number(text);
        const limits = this._followup || { min: 0, max: 1320 };
        return minutes >= limits.min && minutes <= limits.max ? minutes : null;
    },

    /** What to tell the operator about the delay on screen: a warning for a value the server would refuse, a note for 0 (off). Pure over its argument. */
    followupHint(minutes) {
        const max = this._followup ? this._followup.max : 1320;
        if (minutes === null) return { tone: 'warning', text: t('ai.salesFollowupInvalid', { max }) };
        if (minutes === 0) return { tone: 'muted', text: t('ai.salesFollowupOff') };
        return null;
    },

    /** Asks for the follow-up delay once per visit, and only of a platform admin (the endpoint is theirs; anyone else gets no field). Never an error. */
    async loadFollowup() {
        if (this._followup !== undefined) return;
        this._followup = null;
        if (!(typeof App !== 'undefined' && typeof App.isAdmin === 'function' && App.isAdmin())) return;
        const seq = this._seq;
        try {
            const got = await API.getSalesFollowup();
            if (got && Number.isInteger(got.minutes)) {
                this._followup = {
                    minutes: got.minutes,
                    min: Number.isInteger(got.min) ? got.min : 0,
                    max: Number.isInteger(got.max) ? got.max : 1320,
                    defaultMinutes: Number.isInteger(got.defaultMinutes) ? got.defaultMinutes : 240,
                };
            }
        } catch (err) {
            this._followup = null;
        }
        // The operator left while it was in flight: those elements belong to another page now.
        if (seq !== this._seq) return;
        const input = document.getElementById('sales-followup-minutes');
        if (input && this._followup) input.value = String(this._followup.minutes);
        this.syncSales();
        this.refreshDirty();
    },

    /**
     * What the "dm" route would do right now, from `GET /api/admin/ai` (`view`), as a short hint for the operator who picked AI
     * providers: a muted line when a route is saved, a warning when no provider can answer (no key) or no route is saved (the
     * first provider with a key then answers, whatever it is). Pure. `null` when `view` is not what it should be: a hint is
     * never worth an error.
     */
    routeHint(view, fallbackOn) {
        const purposes = view && Array.isArray(view.purposes) ? view.purposes : null;
        const dm = purposes && purposes.find((p) => p && p.purpose === 'dm');
        const resolved = dm && dm.resolved;
        if (!resolved) return null;
        if (resolved.error) return { tone: 'warning', text: t(fallbackOn ? 'ai.engineNoRouteOn' : 'ai.engineNoRouteOff') };
        const providers = Array.isArray(view.providers) ? view.providers : [];
        const found = providers.find((p) => p && p.id === resolved.provider);
        const params = {
            provider: this.isolate((found && found.label) || resolved.provider), model: this.isolate(resolved.model), effort: this.isolate(resolved.effort),
        };
        if (resolved.source === 'saved') return { tone: 'muted', text: t('ai.engineSavedRoute', params) };
        return { tone: 'warning', text: t('ai.engineDefaultRoute', params) };
    },

    /** Paints the hint under the picker for the state on screen; written as text, so nothing in it is ever markup. */
    showRouteHint() {
        const el = document.getElementById('engine-route-hint');
        if (!el) return;
        const hint = this.usesProviders() ? this.routeHint(this._routeView, this.fallbackOn()) : null;
        el.textContent = hint ? hint.text : '';
        el.classList.toggle('hidden', !hint);
        el.classList.toggle('text-warning', !!hint && hint.tone === 'warning');
    },

    /** Asks the layer's status once per visit, and only of a platform admin (the endpoint is theirs; anyone else gets no hint). */
    async loadRouteStatus() {
        const seq = this._seq;
        if (this._routeView === undefined) {
            this._routeView = null;
            if (typeof App !== 'undefined' && typeof App.isAdmin === 'function' && App.isAdmin()) {
                try {
                    this._routeView = await API.getAdminAi();
                } catch (err) {
                    this._routeView = null;
                }
            }
        }
        // The operator left while it was in flight: those elements belong to another page now.
        if (seq !== this._seq) return;
        this.showRouteHint();
    },

    /**
     * Shows the fallback switch only while AI providers is the engine (it means nothing for Gemini), and asks for the route
     * status the first time it is wanted.
     */
    syncEngine() {
        const providers = this.usesProviders();
        const block = document.getElementById('fallback-block');
        if (block) block.classList.toggle('hidden', !providers);
        if (providers) this.loadRouteStatus();
        else this.showRouteHint();
    },

    engineChanged() {
        this.syncEngine();
        this.refreshDirty();
    },

    fallbackChanged() {
        this.showRouteHint();
        this.refreshDirty();
    },

    salesChanged() {
        this.syncSales();
        this.refreshDirty();
    },

    updateTemperature(value) {
        const out = document.getElementById('temp-value');
        if (out) out.textContent = UI.formatNumber(Number(value));
        // The slider's own data-input wins the delegated lookup over the form's,
        // so it reports the change itself.
        this.refreshDirty();
    },

    // ─── Meta vision (beta): the owner's card (docs/specs/005-muse-sees T038) ────────────────────────────────

    /** The switches, in the order the card draws them. */
    MUSE_SWITCHES: Object.freeze(['dm_media', 'voice', 'memory']),
    /** The control each switch is. */
    MUSE_CONTROLS: Object.freeze({ dm_media: 'muse-dm-media', voice: 'muse-voice', memory: 'muse-memory' }),
    /** The switches whose feature is not live yet (voice ships in P3): the server stores them and nothing reads them, and the card says so. Video memory is live. */
    MUSE_SOON: Object.freeze({ dm_media: false, voice: true, memory: false }),
    /** A sender id as the server takes it (`SENDER_ID` in src/services/dmSales/mode.ts): the picker offers only threads whose id is one, so nothing else is ever sent. */
    MUSE_SENDER: /^\d{5,32}$/,
    /** The picker's list is the inbox's own, at the inbox's page size: the newest threads, filtered to Instagram's here. */
    MUSE_PICKER_LIMIT: 100,
    /** Longest handle or name the card draws; the stylesheet wraps the rest. */
    MUSE_TEXT_MAX: 100,

    /**
     * The card's state. `undefined`: nothing adopted yet. `{ status: 'unavailable' }`: the server did not send the block (hide the card). `{ status: 'failed' }`:
     * it sent `null` (it could not read the settings: say so, draw nothing live, save nothing). `{ status: 'ready', ... }`: `saved` and `draft` are
     * `{ switches, who: 'list' | 'everyone', ids, capText }` (`draft` is what is on screen, `saved` what the server holds), `people` maps a sender id to
     * `{ username, name }` for the names the card knows, and the rest is what the server said about the key and the spend.
     */
    _muse: undefined,

    /** The picker: whether it is open, how the list of recent conversations stands (`idle`, `loading`, `ready`, `failed`), its rows and what is typed in its search. */
    _musePicker: null,

    musePickerState() {
        if (!this._musePicker) this._musePicker = { open: false, status: 'idle', rows: [], term: '' };
        return this._musePicker;
    },

    /**
     * May this session change Meta vision? `POST /settings/ai/muse` is the OWNER's (`canAdminister`): switching it on decides whether a customer's media goes to
     * Meta's models, and the cap is his money. An operator may run the agent and still reads the card; a viewer reads everything. Optimistic like `canEdit`:
     * where the shell cannot answer (a test harness, a page before the session has loaded) the session is an owner's.
     */
    canEditMuse() {
        const owner = typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
        return this.canEdit() && owner;
    },

    /** A string, trimmed, at most `MUSE_TEXT_MAX` characters; '' for anything that is not text. */
    museText(value) {
        return typeof value === 'string' ? Array.from(value.trim()).slice(0, this.MUSE_TEXT_MAX).join('') : '';
    },

    /** The card, as the shell draws it: controls where an owner changes things, locked for everyone else, and every value filled in by `paintMuse` once the answer is in. */
    museShell() {
        const mayEdit = this.canEditMuse();
        const off = mayEdit ? '' : html.raw(' disabled');
        const lock = mayEdit ? '' : html.raw(' readonly');
        // An operator can change the agent and not this: the viewer's note (`ai.readOnly`) is not theirs to read.
        const ownerOnly = this.canEdit() && !mayEdit;
        const row = (name) => html`
            <div class="toggle-block">
                <div>
                    <h4 aria-level="3">${t(`muse.${this.museKey(name)}`)}${this.MUSE_SOON[name] ? html` <span class="badge badge-neutral muse-soon">${t('muse.soon')}</span>` : ''}</h4>
                    <p id="${this.MUSE_CONTROLS[name]}-desc">${t(`muse.${this.museKey(name)}Desc`)}${this.MUSE_SOON[name] ? html` ${t('muse.soonNote')}` : ''}</p>
                </div>
                <label class="switch" for="${this.MUSE_CONTROLS[name]}">
                    <span class="sr-only">${t(`muse.${this.museKey(name)}`)}</span>
                    <input type="checkbox" id="${this.MUSE_CONTROLS[name]}" aria-describedby="${this.MUSE_CONTROLS[name]}-desc"${off}>
                    <span class="switch-track"></span>
                </label>
            </div>
        `;
        return html`
            <section class="surface ai-panel muse-card" id="muse-card" aria-labelledby="muse-title">
                <div class="panel-head">
                    <i data-lucide="eye" aria-hidden="true"></i>
                    <h3 id="muse-title" aria-level="2">${t('muse.title')}</h3>
                    <span class="badge badge-info">${t('muse.beta')}</span>
                </div>
                <p class="form-hint mbe-3">${t('muse.intro')} ${UI.helpLink('ai-usage#meta-vision', t('help.link.metaVision'), { newTab: true })}</p>
                ${ownerOnly ? html`<p class="form-hint mbe-3" id="muse-owner-note" role="note"><i data-lucide="eye" aria-hidden="true"></i> ${t('muse.ownerOnly')}</p>` : ''}
                <div id="muse-error"></div>
                <div class="muse-status" id="muse-status" role="status" aria-live="polite"></div>

                <div class="muse-body" id="muse-form" data-input="muse:changed" data-change="muse:changed">
                    ${this.MUSE_SWITCHES.map((name) => row(name))}

                    <hr class="divider">

                    <div class="form-group">
                        <label class="form-label" for="muse-who">${t('muse.who')}</label>
                        <select class="select" id="muse-who" data-change="muse:whoChanged" aria-describedby="muse-who-desc muse-who-hint"${off}>
                            <option value="list">${t('muse.whoList')}</option>
                            <option value="everyone">${t('muse.whoEveryone')}</option>
                        </select>
                        <span class="field-desc" id="muse-who-desc">${t('muse.whoDesc')}</span>
                        <p class="form-hint hidden" id="muse-everyone-note">${t('muse.whoEveryoneNote')}</p>
                        <p class="form-hint hidden" id="muse-who-hint" role="status" aria-live="polite"></p>
                    </div>

                    <div class="muse-people-block hidden" id="muse-people-block">
                        <p class="form-label" id="muse-people-label">${t('muse.people')}</p>
                        <ul class="growth-chips muse-people" id="muse-people-list" aria-labelledby="muse-people-label"></ul>
                        <div>
                            ${UI.button({ variant: 'secondary', size: 'sm', icon: 'user-plus', label: t('muse.add'), action: 'muse:togglePicker', id: 'muse-picker-open', disabled: !mayEdit })}
                        </div>
                        <div class="muse-picker hidden" id="muse-picker" role="group" aria-labelledby="muse-picker-title" data-keydown="muse:pickerKey">
                            <h4 class="muse-picker-title" id="muse-picker-title" aria-level="3">${t('muse.pickerTitle')}</h4>
                            <label class="sr-only" for="muse-picker-search">${t('muse.pickerSearch')}</label>
                            <input class="field" id="muse-picker-search" type="search" dir="auto" autocomplete="off" spellcheck="false" data-input="muse:pickerSearch"
                                   placeholder="${t('muse.pickerSearch')}" aria-controls="muse-picker-list"${off}>
                            <p class="form-hint" id="muse-picker-note" role="status" aria-live="polite"></p>
                            <ul class="muse-choices" id="muse-picker-list"></ul>
                        </div>
                    </div>

                    <hr class="divider">

                    <div class="form-group">
                        <label class="form-label" for="muse-daily-usd">${t('muse.cap')}</label>
                        <span class="field-desc" id="muse-cap-desc">${t('muse.capDesc')}</span>
                        <input class="field muse-cap" id="muse-daily-usd" type="number" inputmode="decimal" dir="ltr" lang="en" min="0" max="50" step="0.01"
                               autocomplete="off" aria-describedby="muse-cap-desc muse-spent muse-cap-hint"${lock}>
                        <p class="form-hint" id="muse-spent"></p>
                        <p class="form-hint hidden" id="muse-cap-hint" role="status" aria-live="polite"></p>
                    </div>

                    <div class="form-actions">
                        ${UI.button({ variant: 'primary', icon: 'check', label: t('muse.save'), action: 'muse:save', id: 'muse-save-btn', disabled: !mayEdit })}
                        <span class="unsaved-note hidden" id="muse-unsaved-note" role="status">${t('ai.unsaved')}</span>
                    </div>
                </div>

                ${this.museLibraryShell()}
            </section>
        `;
    },

    /** The dictionary's word for a switch: `dm_media` is "dmMedia". */
    museKey(name) {
        return name === 'dm_media' ? 'dmMedia' : name;
    },

    // ─── What the server said, and what is on screen ───

    /** The card's state from the server's `muse` block (see `_muse`). */
    museStateFrom(view) {
        const sw = view.switches && typeof view.switches === 'object' ? view.switches : {};
        const allow = Array.isArray(view.allowSenders) ? view.allowSenders.filter((id) => typeof id === 'string') : [];
        const everyone = allow.includes('*');
        const ids = everyone ? [] : allow.filter((id) => this.MUSE_SENDER.test(id));
        const cap = typeof view.dailyUsd === 'number' && Number.isFinite(view.dailyUsd) ? view.dailyUsd : null;
        const limits = view.limits && typeof view.limits === 'object' ? view.limits : {};
        const saved = {
            switches: { dm_media: sw.dm_media === true, voice: sw.voice === true, memory: sw.memory === true },
            who: everyone ? 'everyone' : 'list',
            ids,
            capText: cap === null ? '' : String(cap),
        };
        const people = new Map();
        (Array.isArray(view.people) ? view.people : []).forEach((person) => {
            if (!person || typeof person.id !== 'string' || !this.MUSE_SENDER.test(person.id)) return;
            people.set(person.id, { username: this.museText(person.username).replace(/^@/, ''), name: this.museText(person.name) });
        });
        return {
            status: 'ready',
            saved,
            draft: { switches: { ...saved.switches }, who: saved.who, ids: [...saved.ids], capText: saved.capText },
            people,
            spentToday: typeof view.spentToday === 'number' && Number.isFinite(view.spentToday) ? view.spentToday : null,
            keyReady: view.keyReady === true ? true : view.keyReady === false ? false : null,
            model: view.route && typeof view.route.model === 'string' ? this.museText(view.route.model) : '',
            max: Number.isInteger(limits.dailyUsdMax) ? limits.dailyUsdMax : 50,
            maxPeople: Number.isInteger(limits.allowSendersMax) ? limits.allowSendersMax : 50,
        };
    },

    /** Takes the server's answer as the card's state and draws it: the load, and a save's answer. The picker stays as it is when `keepPicker`. */
    adoptMuse(view, keepPicker) {
        if (view === undefined) this._muse = { status: 'unavailable' };
        else if (!view || typeof view !== 'object' || Array.isArray(view)) this._muse = { status: 'failed' };
        else this._muse = this.museStateFrom(view);
        if (!keepPicker) this._musePicker = null;
        this.paintMuse();
    },

    /** Copies what is on screen into the draft. A control that is not on the page keeps what the draft has. */
    syncMuseDraft() {
        const m = this._muse;
        if (!m || m.status !== 'ready') return;
        this.MUSE_SWITCHES.forEach((name) => {
            const el = document.getElementById(this.MUSE_CONTROLS[name]);
            if (el) m.draft.switches[name] = !!el.checked;
        });
        const who = document.getElementById('muse-who');
        if (who) m.draft.who = who.value === 'everyone' ? 'everyone' : 'list';
        const cap = document.getElementById('muse-daily-usd');
        if (cap && typeof cap.value === 'string') m.draft.capText = cap.value;
    },

    /** The cap as a number of dollars: a whole number or one with one or two decimals, from 0 to the server's maximum. `null` for anything else (empty, a letter, three decimals, out of range). */
    museCap(text) {
        const raw = String(text === undefined || text === null ? '' : text).trim();
        if (!/^\d{1,2}(\.\d{1,2})?$/.test(raw)) return null;
        const n = Number(raw);
        const max = this._muse && this._muse.max ? this._muse.max : 50;
        return n >= 0 && n <= max ? n : null;
    },

    /** One string for a state, so "unsaved" is a comparison. The list counts only while it is the one that answers, and a cap that is not a number is kept as typed so it differs. */
    museCanon(d) {
        const cap = this.museCap(d.capText);
        return JSON.stringify([d.switches.dm_media, d.switches.voice, d.switches.memory, d.who, d.who === 'list' ? d.ids : [], cap === null ? `?${String(d.capText).trim()}` : cap]);
    },

    /** The card on screen differs from what the server holds. False when there is no card to differ (not loaded, failed, hidden). */
    museDirty() {
        const m = this._muse;
        if (!m || m.status !== 'ready') return false;
        this.syncMuseDraft();
        return this.museCanon(m.draft) !== this.museCanon(m.saved);
    },

    /** What the server takes for the card as it stands. Every field, every time: what is on screen is what is saved. */
    musePayload() {
        const d = this._muse.draft;
        return {
            switches: { dm_media: d.switches.dm_media, voice: d.switches.voice, memory: d.switches.memory },
            allow_senders: d.who === 'everyone' ? ['*'] : [...d.ids],
            daily_usd: this.museCap(d.capText),
        };
    },

    // ─── Drawing it ───

    /** "$0.42", isolated so the sign stays on the number in an Arabic sentence; a sum under a cent says so. */
    museMoney(n) {
        if (n > 0 && n < 0.01) return t('muse.lessThanCent');
        return `⁦$${n.toFixed(2)}⁩`;
    },

    /** Every part of the card from the state: the controls' values and whether they are live, the key line, the people, the hints and the spend. */
    paintMuse() {
        const m = this._muse;
        const card = document.getElementById('muse-card');
        if (card) card.classList.toggle('hidden', !m || m.status === 'unavailable');
        if (!m || m.status === 'unavailable') return;
        const ready = m.status === 'ready';
        // A card that could not load shows nothing as chosen and lets nothing be saved: what it would send is not what he saved.
        const live = ready && this.canEditMuse();
        const put = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
        this.MUSE_SWITCHES.forEach((name) => put(this.MUSE_CONTROLS[name], (el) => { el.checked = ready && m.draft.switches[name]; el.disabled = !live; }));
        put('muse-who', (el) => { el.value = ready ? m.draft.who : 'list'; el.disabled = !live; });
        put('muse-daily-usd', (el) => { el.value = ready ? m.draft.capText : ''; el.readOnly = !live; });
        put('muse-save-btn', (el) => { el.disabled = !live; });
        put('muse-picker-open', (el) => { el.disabled = !live; });
        put('muse-picker-search', (el) => { el.disabled = !live; });
        put('muse-error', (el) => {
            el.innerHTML = ready ? '' : esc(html`
                ${UI.errorStrip(t('muse.loadErrorTitle'), t('muse.loadErrorHint'), 'muse-error-strip')}
                <p>${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'muse:reload', id: 'muse-reload' })}</p>
            `);
            UI.icons(el);
        });
        this.paintMuseStatus();
        this.paintMusePeople();
        this.paintMuseHints();
        this.paintMuseSpent();
        this.paintMusePicker();
        this.paintMuseLibrary();
        this.refreshMuseDirty();
        // The owner's library is asked for once per visit, the first time the card is ready: it is read with the switch off as well, so what was watched stays viewable.
        if (ready && this.museOwner() && this.museLibState().status === 'idle') this.loadMuseLibrary();
    },

    /** The key line: whether a Meta key can answer (the gate's own question) and which model it would read with; what to do when none can. */
    paintMuseStatus() {
        const el = document.getElementById('muse-status');
        if (!el) return;
        const m = this._muse;
        if (!m || m.status !== 'ready') {
            el.innerHTML = '';
            return;
        }
        let line;
        if (m.keyReady === true) {
            line = html`<span class="badge badge-success"><i data-lucide="check-circle" aria-hidden="true"></i>${t('muse.key.ready')}</span>${m.model ? html` <span class="muse-status-note">${t('muse.key.model', { model: this.isolate(m.model) })}</span>` : ''}`;
        } else if (m.keyReady === false) {
            line = html`<span class="badge badge-warning"><i data-lucide="alert-triangle" aria-hidden="true"></i>${t('muse.key.notReady')}</span> <span class="muse-status-note">${t('muse.key.notReadyHint')}</span>`;
        } else {
            line = html`<span class="badge badge-neutral"><i data-lucide="info" aria-hidden="true"></i>${t('muse.key.unknown')}</span>`;
        }
        el.innerHTML = esc(line);
        UI.icons(el);
    },

    /** A person as the inbox names a sender nobody has looked up: "User 3051", from the last four of the id. */
    musePersonLabel(id) {
        const known = this._muse && this._muse.people ? this._muse.people.get(id) : null;
        if (known && known.username) return `@${known.username}`;
        if (known && known.name) return known.name;
        return t('inbox.anonUser', { id: id.slice(-4) });
    },

    /** One person on the list: the handle the inbox shows (else the name, else "User 3051"), the name beside a handle, and a remove button only where it can be used. */
    musePersonChip(id, editable) {
        const known = this._muse.people.get(id);
        const label = this.musePersonLabel(id);
        const sub = known && known.username && known.name ? known.name : '';
        const remove = t('muse.remove', { name: this.isolate(label) });
        return html`
            <li class="chip growth-chip" data-person="${id}">
                <span class="user-content" dir="auto">${label}</span>
                ${sub ? html`<span class="muse-person-sub user-content" dir="auto">${sub}</span>` : ''}
                ${editable ? html`
                    <button type="button" class="growth-chip-x" data-action="muse:removePerson" data-id="${id}" data-focus-key="muse-person-${id}"
                            aria-label="${remove}" title="${remove}"><i data-lucide="x" aria-hidden="true"></i></button>
                ` : ''}
            </li>
        `;
    },

    /** The people block (the list, and the picker's button) while the answer is "only these people", the everyone note while it is everyone. */
    paintMusePeople() {
        const m = this._muse;
        const ready = !!m && m.status === 'ready';
        const everyone = ready && m.draft.who === 'everyone';
        const block = document.getElementById('muse-people-block');
        if (block) block.classList.toggle('hidden', !ready || everyone);
        const note = document.getElementById('muse-everyone-note');
        if (note) note.classList.toggle('hidden', !everyone);
        const list = document.getElementById('muse-people-list');
        if (!list) return;
        if (!ready || everyone) {
            list.innerHTML = '';
            return;
        }
        const editable = this.canEditMuse();
        list.innerHTML = esc(m.draft.ids.map((id) => this.musePersonChip(id, editable)));
        UI.icons(list);
    },

    /** The lines under "who" and under the cap. Written as text, so nothing in them is ever markup. */
    paintMuseHints() {
        const m = this._muse;
        const ready = !!m && m.status === 'ready';
        const who = document.getElementById('muse-who-hint');
        if (who) {
            let text = '';
            if (ready && m.draft.who === 'list') {
                if (m.draft.ids.length === 0) text = t('muse.whoNobody');
                else if (m.draft.ids.length >= m.maxPeople) text = t('muse.limit', { max: m.maxPeople });
            }
            who.textContent = text;
            who.classList.toggle('hidden', !text);
            who.classList.toggle('text-warning', !!text);
        }
        const cap = document.getElementById('muse-cap-hint');
        if (cap) {
            const bad = ready && this.museCap(m.draft.capText) === null;
            cap.textContent = bad ? t('muse.capInvalid', { max: m.max }) : '';
            cap.classList.toggle('hidden', !bad);
            cap.classList.toggle('text-warning', bad);
        }
    },

    /** "Spent today: $0.42 of $3.00": the sum the gate's cap counts, against the cap the server holds (the draft is not what is enforced). */
    paintMuseSpent() {
        const el = document.getElementById('muse-spent');
        if (!el) return;
        const m = this._muse;
        if (!m || m.status !== 'ready') {
            el.textContent = '';
            return;
        }
        const cap = this.museCap(m.saved.capText);
        el.textContent = m.spentToday === null
            ? t('muse.spentUnknown')
            : t('muse.spent', { spent: this.museMoney(m.spentToday), cap: cap === null ? '—' : this.museMoney(cap) });
    },

    /** The note beside the card's Save: unsaved edits. */
    refreshMuseDirty() {
        const note = document.getElementById('muse-unsaved-note');
        if (note) note.classList.toggle('hidden', !this.museDirty());
    },

    // ─── Changing it ───

    /** Typing, a switch: the draft follows the screen, and the lines that depend on it. Nothing is redrawn (it would take the caret). */
    museChanged() {
        this.syncMuseDraft();
        this.paintMuseStatus();
        this.paintMuseHints();
        this.refreshMuseDirty();
    },

    /** "Only these people" or "Everyone": the list and the picker are for the first only. */
    museWhoChanged() {
        this.syncMuseDraft();
        this.paintMusePeople();
        this.paintMuseHints();
        this.paintMusePicker();
        this.refreshMuseDirty();
    },

    // ─── The picker: people from his recent Instagram conversations ───

    /** The rows of the inbox's own list that the card can offer: Instagram threads with an id the server takes, newest first (the server's order), each once. */
    musePickerRowsFrom(result) {
        const list = result && Array.isArray(result.data) ? result.data : [];
        const rows = [];
        list.forEach((row) => {
            if (!row || typeof row !== 'object' || row.platform !== 'instagram') return;
            const id = typeof row.instagram_user_id === 'string' ? row.instagram_user_id.trim() : '';
            if (!this.MUSE_SENDER.test(id) || rows.some((r) => r.id === id)) return;
            rows.push({ id, username: this.museText(row.username).replace(/^@/, ''), name: this.museText(row.profile_name), at: row.last_message_at || '' });
        });
        return rows;
    },

    /** What the picker offers now: the loaded threads that are not on the list yet and match what is typed (name, handle), in the order loaded. */
    museChoices() {
        const m = this._muse;
        const p = this.musePickerState();
        const term = p.term.trim().toLocaleLowerCase();
        return p.rows.filter((row) => !m.draft.ids.includes(row.id)
            && (!term || `${row.username} ${row.name}`.toLocaleLowerCase().includes(term)));
    },

    /** Asks for the recent threads once per open (again after a failure, or when `again`). A late answer, or one for a page that was left, is dropped. */
    async loadMusePicker(again) {
        const p = this.musePickerState();
        if (p.status === 'loading' || (p.status === 'ready' && !again)) return;
        p.status = 'loading';
        this.paintMusePicker();
        const page = this._seq;
        let result = null;
        let failed = false;
        try {
            result = await API.getRecentConversations();
        } catch (err) {
            console.error('Meta vision picker load error:', err);
            failed = true;
        }
        if (page !== this._seq || p !== this._musePicker) return;
        p.rows = failed ? [] : this.musePickerRowsFrom(result);
        p.status = failed ? 'failed' : 'ready';
        this.paintMusePicker();
    },

    /** The panel and its list for the picker's state. Choices are buttons; everything typed or named by a person goes through `html` as text. */
    paintMusePicker() {
        const m = this._muse;
        const p = this.musePickerState();
        const open = !!m && m.status === 'ready' && m.draft.who === 'list' && p.open;
        const panel = document.getElementById('muse-picker');
        if (panel) panel.classList.toggle('hidden', !open);
        const toggle = document.getElementById('muse-picker-open');
        if (toggle) {
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            toggle.setAttribute('aria-controls', 'muse-picker');
        }
        const list = document.getElementById('muse-picker-list');
        const note = document.getElementById('muse-picker-note');
        if (!open || !list) return;
        const full = m.draft.ids.length >= m.maxPeople;
        let message = '';
        let retry = false;
        let choices = [];
        if (p.status === 'loading') message = t('muse.pickerLoading');
        else if (p.status === 'failed') { message = t('muse.pickerFailed'); retry = true; }
        else if (full) message = t('muse.limit', { max: m.maxPeople });
        else {
            choices = this.museChoices();
            if (p.rows.length === 0) message = t('muse.pickerNone');
            else if (choices.length === 0) message = p.term.trim() ? t('muse.pickerNoMatch', { term: this.isolate(p.term.trim().slice(0, 40)) }) : t('muse.pickerNone');
            else message = t('muse.pickerNote', { count: this.MUSE_PICKER_LIMIT });
        }
        if (note) {
            note.textContent = message;
            note.classList.toggle('text-warning', p.status === 'failed');
        }
        list.innerHTML = esc([
            retry ? html`<li>${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'muse:retryPicker', id: 'muse-picker-retry' })}</li>` : '',
            choices.map((row) => this.musePickerChoice(row)),
        ]);
        UI.icons(list);
    },

    /** One thread in the picker: the handle the inbox shows (else the name, else "User 3051"), with the name and how long ago they wrote beneath it. */
    musePickerChoice(row) {
        const label = row.username ? `@${row.username}` : (row.name || t('inbox.anonUser', { id: row.id.slice(-4) }));
        const age = row.at ? UI.relativeAge(row.at, { neverText: '' }).text : '';
        const sub = [row.username ? row.name : '', age].filter(Boolean).join(' · ');
        return html`
            <li>
                <button type="button" class="muse-choice" data-action="muse:addPerson" data-id="${row.id}" aria-label="${t('muse.pickerAdd', { name: this.isolate(label) })}">
                    <span class="user-content" dir="auto">${label}</span>
                    ${sub ? html`<span class="muse-choice-sub user-content" dir="auto">${sub}</span>` : ''}
                </button>
            </li>
        `;
    },

    /** Opens or closes the picker; opening asks for the threads. */
    museTogglePicker() {
        const m = this._muse;
        if (!m || m.status !== 'ready' || !this.canEditMuse()) return;
        const p = this.musePickerState();
        p.open = !p.open;
        this.paintMusePicker();
        if (!p.open) return;
        const search = document.getElementById('muse-picker-search');
        if (search && typeof search.focus === 'function') search.focus();
        this.loadMusePicker(false);
    },

    /** Escape closes the picker and gives the focus back to the button that opened it. */
    musePickerKey(event) {
        if (!event || event.key !== 'Escape') return;
        const p = this.musePickerState();
        if (!p.open) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        p.open = false;
        this.paintMusePicker();
        const toggle = document.getElementById('muse-picker-open');
        if (toggle && typeof toggle.focus === 'function') toggle.focus();
    },

    musePickerSearch(el) {
        const p = this.musePickerState();
        p.term = el && typeof el.value === 'string' ? el.value : '';
        this.paintMusePicker();
    },

    /** Puts a person from the picker on the list: the sender id of that thread, and the names the picker knew for it. Only ids of this shape, at most the server's limit, each once. */
    museAddPerson(id) {
        const m = this._muse;
        if (!m || m.status !== 'ready' || !this.canEditMuse()) return;
        if (!this.MUSE_SENDER.test(String(id)) || m.draft.ids.includes(id) || m.draft.ids.length >= m.maxPeople) return;
        const row = this.musePickerState().rows.find((r) => r.id === id);
        if (row && !m.people.has(id)) m.people.set(id, { username: row.username, name: row.name });
        m.draft.ids.push(id);
        this.paintMusePeople();
        this.paintMuseHints();
        this.paintMusePicker();
        this.refreshMuseDirty();
        const search = document.getElementById('muse-picker-search');
        if (search && typeof search.focus === 'function') search.focus();
    },

    /** Takes a person off the list. The focus goes to the button that adds one, which is always there. */
    museRemovePerson(id) {
        const m = this._muse;
        if (!m || m.status !== 'ready' || !this.canEditMuse()) return;
        const at = m.draft.ids.indexOf(id);
        if (at < 0) return;
        m.draft.ids.splice(at, 1);
        this.paintMusePeople();
        this.paintMuseHints();
        this.paintMusePicker();
        this.refreshMuseDirty();
        const add = document.getElementById('muse-picker-open');
        if (add && typeof add.focus === 'function') add.focus();
    },

    // ─── Saving it ───

    /**
     * Save, with the card's own button. Nothing is sent for a session that is not the owner's (the server refuses it as well), for a card that did not load, or for a cap
     * the server would refuse: that one is stopped here with its hint on screen. What the server answers is what is on screen and what is saved.
     */
    async museSave(button) {
        if (!this.canEditMuse()) return;
        const m = this._muse;
        if (!m || m.status !== 'ready') return;
        this.syncMuseDraft();
        if (this.museCap(m.draft.capText) === null) {
            this.paintMuseHints();
            UI.toast(t('muse.capInvalid', { max: m.max }), 'error');
            return;
        }
        const restore = UI.actionBusy(button, t('common.saving'));
        if (!restore) return; // already in flight
        const page = this._seq;
        try {
            const got = await API.saveMuseSettings(this.musePayload());
            if (page !== this._seq) return;
            this.adoptMuse(got, true);
            UI.toast(t('muse.saved'), 'success');
        } catch (err) {
            console.error('Save Meta vision error:', err);
            UI.toast((err && err.message) || t('muse.saveFailed'), 'error');
            if (page === this._seq) this.refreshMuseDirty();
        } finally {
            restore();
        }
    },

    /** Asks again for the card's block only, so a failed card can recover without touching the agent's form above it. */
    async museReload() {
        const page = this._seq;
        let view = null;
        try {
            const got = await API.getAiSettings();
            view = got ? got.muse : undefined;
        } catch (err) {
            console.error('Meta vision reload error:', err);
        }
        if (page !== this._seq) return;
        this.adoptMuse(view);
    },

    // ─── Meta vision: the video library (docs/specs/005-muse-sees T057) ────────────────────────────────

    /**
     * What watching a reel costs and takes, in the card's words: a reel of the live run of 2026-10-29 cost about two cents and about 40 seconds, and the owner has about
     * seventy (about $1.50 in all). They are said as "about", never promised; what one reel really cost is in its details.
     */
    MUSE_REEL_USD: 0.0215,
    MUSE_REEL_SECONDS: 40,
    MUSE_SAMPLE_REELS: 70,
    MUSE_SAMPLE_USD: 1.5,
    /** How often the list is asked for again while a reel waits (there is no progress route), and how many times: a page left open for hours is not asked forever. */
    MUSE_POLL_MS: 20000,
    MUSE_POLL_MAX: 180,
    /** The longest a summary is drawn in the list: the stylesheet shows two lines of it, and the details hold the rest. */
    MUSE_SUMMARY_MAX: 400,
    /** A reel's id as the routes take it (a uuid), and the states a row can be in. */
    MUSE_REEL_ID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    MUSE_REEL_STATUSES: Object.freeze(['ok', 'pending', 'failed']),
    /** The refusals the library routes answer with, each with its own sentence in `muse.lib.e.<CODE>`; any other shows the server's words. */
    MUSE_LIB_ERRORS: Object.freeze(['MUSE_MEMORY_OFF', 'AI_NOT_CONFIGURED', 'META_NOT_CONNECTED', 'TOKEN_INVALID', 'META_UNAVAILABLE', 'META_ERROR', 'REEL_NOT_FOUND', 'NO_MEDIA_ID']),
    /** Why a reel could not be watched (`result.error`), each with its own sentence in `muse.lib.fail.<code>`. */
    MUSE_LIB_FAILURES: Object.freeze([
        'too_large', 'fetch_failed', 'expired_url', 'timeout', 'no_media_url', 'not_a_video', 'not_found', 'graph_auth', 'graph_unavailable', 'graph_failed', 'provider_error', 'bad_output',
    ]),

    /**
     * The library's state, made on first use (`museLibState`); `undefined` before the card asks. `status`: `idle` (not asked), `loading`, `ready` or `failed`. `rows`: the list as the
     * server gave it, cleaned. `error`: why the last ask failed. `busy`: "Index my reels" is in flight. `again`: the reels whose "Watch again" is in flight. `open`: a reel's id to its
     * details (`{ status: 'loading' | 'ready' | 'failed', result }`). `notice`: what the last press came to (`{ kind, text }`). `polls`: how many times the list was asked for again by
     * itself since the last press. `timer`: the next of those.
     */
    _museLib: undefined,

    museLibState() {
        if (!this._museLib) this._museLib = { status: 'idle', rows: [], error: '', busy: false, again: new Set(), open: new Map(), notice: null, polls: 0, timer: null };
        return this._museLib;
    },

    /** Stops the poll and forgets the library: a new visit asks again, and another tenant never sees this one's reels. */
    museLibraryStop() {
        const lib = this._museLib;
        if (lib && lib.timer) clearTimeout(lib.timer);
        this._museLib = undefined;
    },

    /** The library's routes are the OWNER's, reads included (`requireTenantRole('owner')`): to anyone else the section is not drawn. Optimistic like `canEdit`. */
    museOwner() {
        return typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
    },

    /** One line of what the server or a model wrote: control characters out, white space one space, at most `max` characters. '' for anything that is not text. */
    museLine(value, max) {
        if (typeof value !== 'string') return '';
        return Array.from(value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
    },

    /** Text that keeps its line breaks (what is said in a reel): control characters out, one space between words, no blank lines, at most `max` characters. */
    museBlock(value, max) {
        if (typeof value !== 'string') return '';
        const lines = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, ' ').split('\n');
        return Array.from(lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')).slice(0, max).join('');
    },

    /** A second as the "m:ss" a person reads on a video's timeline, which is how the assistant says it too: 13 is "0:13", 65 is "1:05". */
    museClock(second) {
        const whole = Number.isFinite(second) && second > 0 ? Math.floor(second) : 0;
        return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
    },

    /** The list as the server gave it, as rows the card draws: only a row with a uuid, each once; a state it does not know is a failure; a link only if it is https. */
    museReelsFrom(result) {
        const rows = [];
        (Array.isArray(result) ? result : []).forEach((r) => {
            if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !this.MUSE_REEL_ID.test(r.id) || rows.some((x) => x.id === r.id)) return;
            const link = safeUrl(r.permalink);
            rows.push({
                id: r.id,
                mediaId: typeof r.ig_media_id === 'string' ? r.ig_media_id : '',
                status: this.MUSE_REEL_STATUSES.includes(r.status) ? r.status : 'failed',
                summary: this.museLine(r.summary, this.MUSE_SUMMARY_MAX),
                postedAt: typeof r.posted_at === 'string' ? r.posted_at : '',
                hook: Number.isFinite(r.hook_score) ? Math.round(r.hook_score) : null,
                error: typeof r.error === 'string' ? r.error : '',
                link: /^https:\/\//i.test(link) ? link : '',
                usd: Number.isFinite(r.usd) ? r.usd : null,
                model: this.museText(r.model),
            });
        });
        return rows;
    },

    /** The sentence for a reel that could not be watched, from the reason the server stored; a reason it has no sentence for is shown as its code. */
    museFailureText(code) {
        if (this.MUSE_LIB_FAILURES.includes(code)) return t(`muse.lib.fail.${code}`);
        return code ? t('muse.lib.fail.other', { code: this.isolate(this.museText(code)) }) : t('muse.lib.fail.unknown');
    },

    /** What a refused press says: the sentence for the server's code in the interface language, else the server's own words. */
    museLibError(err) {
        const code = err && typeof err.code === 'string' ? err.code : '';
        if (this.MUSE_LIB_ERRORS.includes(code)) return t(`muse.lib.e.${code}`);
        return (err && typeof err.message === 'string' && err.message) || t('muse.lib.indexFailed');
    },

    /** What "Index my reels" came to, from the 202's counts: how many were queued and about what that costs, or why none were. */
    museQueuedNotice(got) {
        const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
        const queued = n(got && got.queued);
        const extra = got && got.truncated === true ? ` ${t('muse.lib.truncated')}` : '';
        if (queued > 0) {
            return { kind: 'ok', text: `${t('muse.lib.queued', { queued, cost: this.museMoney(queued * this.MUSE_REEL_USD), seconds: this.MUSE_REEL_SECONDS })}${extra}` };
        }
        if (n(got && got.deduped) > 0) return { kind: 'info', text: `${t('muse.lib.queuedAlready')}${extra}` };
        if (n(got && got.listed) === 0) return { kind: 'info', text: `${t('muse.lib.noReels')}${extra}` };
        return { kind: 'info', text: `${t('muse.lib.allWatched')}${extra}` };
    },

    // ─── What the section shows ───

    /** The section's markup: drawn hidden, and made visible for an owner once the card is ready (`paintMuseLibrary`). It sits inside the card and outside its form: nothing here is a draft. */
    museLibraryShell() {
        const owner = this.museOwner();
        return html`
            <section class="muse-library hidden" id="muse-library" aria-labelledby="muse-library-title">
                <hr class="divider">
                <div class="muse-library-body">
                    <h4 id="muse-library-title" aria-level="3">${t('muse.lib.title')}</h4>
                    <p class="form-hint">${t('muse.lib.intro')} ${UI.helpLink('ai-usage#video-memory', t('help.link.videoMemory'), { newTab: true })}</p>
                    <div class="muse-library-actions">
                        ${UI.button({ variant: 'primary', icon: 'film', label: t('muse.lib.index'), action: 'muse:indexAll', id: 'muse-index-btn', disabled: true })}
                        ${UI.button({ variant: 'secondary', icon: 'refresh-cw', label: t('muse.lib.refresh'), action: 'muse:refreshLibrary', id: 'muse-library-refresh', disabled: !owner })}
                    </div>
                    <p class="form-hint" id="muse-library-estimate"></p>
                    <p class="form-hint text-warning hidden" id="muse-library-hint" role="note"></p>
                    <p class="form-hint hidden" id="muse-library-notice" role="status" aria-live="polite"></p>
                    <p class="form-hint muse-library-count" id="muse-library-count" role="status" aria-live="polite"></p>
                    <ul class="muse-reels" id="muse-library-list" aria-label="${t('muse.lib.title')}"></ul>
                </div>
            </section>
        `;
    },

    /**
     * The section from the state: drawn for an owner when the card is ready. "Index my reels" works only while the SAVED switch is on (the server reads what is saved, and answers
     * 409 for the rest), so while it is not the button is off and a line says why.
     */
    paintMuseLibrary() {
        const m = this._muse;
        const visible = !!m && m.status === 'ready' && this.museOwner();
        const box = document.getElementById('muse-library');
        if (box) box.classList.toggle('hidden', !visible);
        if (!visible) return;
        const lib = this.museLibState();
        const memoryOn = m.saved.switches.memory === true;
        const put = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
        put('muse-index-btn', (el) => { el.disabled = !memoryOn || lib.busy; });
        put('muse-library-refresh', (el) => { el.disabled = lib.status === 'loading'; });
        put('muse-library-estimate', (el) => {
            el.textContent = t('muse.lib.estimate', {
                cost: this.museMoney(this.MUSE_REEL_USD), seconds: this.MUSE_REEL_SECONDS, total: this.museMoney(this.MUSE_SAMPLE_USD), reels: this.MUSE_SAMPLE_REELS,
            });
        });
        put('muse-library-hint', (el) => {
            el.textContent = memoryOn ? '' : t('muse.lib.memoryOff');
            el.classList.toggle('hidden', memoryOn);
        });
        put('muse-library-notice', (el) => {
            const notice = lib.notice;
            el.textContent = notice ? notice.text : '';
            el.classList.toggle('hidden', !notice);
            el.classList.toggle('text-warning', !!notice && notice.kind === 'error');
        });
        this.paintMuseLibraryList();
    },

    /** The counts and the list: what is loading, what failed, what is empty, else a line of numbers and a row a reel. A refresh that failed with a list on screen keeps the list. */
    paintMuseLibraryList() {
        const list = document.getElementById('muse-library-list');
        const count = document.getElementById('muse-library-count');
        if (!list || !count) return;
        const lib = this.museLibState();
        let line;
        if (lib.status === 'failed') line = lib.error || t('muse.lib.loadFailed');
        else if (lib.status === 'idle' || (lib.status === 'loading' && lib.rows.length === 0)) line = t('muse.lib.loading');
        else if (lib.rows.length === 0) line = t('muse.lib.empty');
        else {
            const n = (status) => lib.rows.filter((r) => r.status === status).length;
            line = t('muse.lib.count', { total: lib.rows.length, ok: n('ok'), pending: n('pending'), failed: n('failed') });
            if (lib.error) line = `${line} ${t('muse.lib.refreshFailed')}`;
        }
        count.textContent = line;
        count.classList.toggle('text-warning', lib.status === 'failed' || !!lib.error);
        list.innerHTML = lib.status === 'failed' ? '' : esc(lib.rows.map((row) => this.museReelRow(row, lib)));
        UI.icons(list);
    },

    /** One reel: its state, date and summary (or why it could not be watched), and what can be done with it. Everything a model or the server wrote is text, never markup. */
    museReelRow(row, lib) {
        const m = this._muse;
        const memoryOn = !!m && m.status === 'ready' && m.saved.switches.memory === true;
        const date = row.postedAt ? UI.formatDay(row.postedAt) : t('muse.lib.undated');
        const look = {
            ok: ['badge-success', 'check-circle', 'muse.lib.status.ok'],
            pending: ['badge-neutral', 'hourglass', 'muse.lib.status.pending'],
            failed: ['badge-warning', 'alert-triangle', 'muse.lib.status.failed'],
        }[row.status];
        let text;
        if (row.status === 'ok') text = row.summary || t('muse.lib.noSummary');
        else if (row.status === 'pending') text = t('muse.lib.waiting');
        else text = t('muse.lib.couldNot', { reason: this.museFailureText(row.error) });
        const entry = lib.open.get(row.id);
        const detailId = `muse-detail-${row.id}`;
        const again = !memoryOn || !row.mediaId || row.status === 'pending' || lib.again.has(row.id);
        return html`
            <li class="muse-reel" data-reel="${row.id}">
                <div class="muse-reel-head">
                    <span class="badge ${look[0]}"><i data-lucide="${look[1]}" aria-hidden="true"></i>${t(look[2])}</span>
                    <span class="muse-reel-date">${date}</span>
                    ${row.hook !== null ? html`<span class="muse-reel-hook">${t('muse.lib.hook', { score: row.hook })}</span>` : ''}
                </div>
                <p class="muse-reel-summary user-content" dir="auto">${text}</p>
                <div class="muse-reel-actions">
                    ${row.status === 'ok' ? html`
                        <button type="button" class="btn btn-ghost btn-sm" id="muse-toggle-${row.id}" data-action="muse:toggleReel" data-id="${row.id}"
                                aria-expanded="${entry ? 'true' : 'false'}" aria-controls="${detailId}"
                                aria-label="${t(entry ? 'muse.lib.hideOf' : 'muse.lib.detailsOf', { date })}"><i data-lucide="chevron-down" aria-hidden="true"></i> ${t(entry ? 'muse.lib.hide' : 'muse.lib.details')}</button>
                    ` : ''}
                    ${UI.button({
                        variant: 'ghost', size: 'sm', icon: 'rotate-cw', label: t('muse.lib.again'), ariaLabel: t('muse.lib.againOf', { date }), action: 'muse:reindexReel', data: { id: row.id }, disabled: again,
                    })}
                    ${row.link ? html`<a class="btn btn-ghost btn-sm" href="${row.link}" target="_blank" rel="noopener noreferrer" aria-label="${t('muse.lib.openOf', { date })}"><i data-lucide="external-link" aria-hidden="true"></i> ${t('muse.lib.open')}</a>` : ''}
                </div>
                ${entry ? this.museReelDetail(row, entry, detailId) : ''}
            </li>
        `;
    },

    /** What the agent remembers of one reel, from the row's `result`: what it is about, what is said, what is on screen, the moments, the topics, the hook and a caption. */
    museReelDetail(row, entry, id) {
        if (entry.status === 'loading') return html`<div class="muse-reel-detail" id="${id}"><p class="form-hint">${t('muse.lib.detailLoading')}</p></div>`;
        if (entry.status === 'failed') return html`<div class="muse-reel-detail" id="${id}"><p class="form-hint text-warning">${t('muse.lib.detailFailed')}</p></div>`;
        const r = entry.result && typeof entry.result === 'object' && !Array.isArray(entry.result) ? entry.result : {};
        const lines = (v, each, most) => (Array.isArray(v) ? v : []).map((x) => this.museLine(x, each)).filter(Boolean).slice(0, most);
        const moments = (Array.isArray(r.key_moments) ? r.key_moments : [])
            .filter((x) => x && typeof x === 'object' && Number.isFinite(x.second) && x.second >= 0)
            .map((x) => ({ second: x.second, what: this.museLine(x.what, 300) }))
            .filter((x) => x.what)
            .slice(0, 15);
        const summary = this.museLine(r.summary, 800);
        const narration = this.museBlock(r.narration, 6000);
        const screen = lines(r.seen_on_screen, 200, 15);
        const topics = lines(r.topics, 80, 12);
        const hook = this.museLine(r.hook_first_3s, 400);
        const score = Number.isFinite(r.hook_score) ? Math.round(r.hook_score) : null;
        const caption = this.museBlock(r.caption_ar, 1000);
        const cover = Number.isFinite(r.cover_second) && r.cover_second >= 0 ? { second: r.cover_second, reason: this.museLine(r.cover_reason, 300) } : null;
        const section = (key, body) => (body ? html`<section class="muse-detail-section"><h5 aria-level="4">${t(key)}</h5>${body}</section>` : '');
        const empty = !summary && !narration && screen.length === 0 && moments.length === 0 && topics.length === 0 && !hook && !caption;
        return html`
            <div class="muse-reel-detail" id="${id}">
                ${empty ? html`<p class="form-hint">${t('muse.lib.d.nothing')}</p>` : ''}
                ${section('muse.lib.d.summary', summary ? html`<p class="user-content" dir="auto">${summary}</p>` : '')}
                ${section('muse.lib.d.narration', narration ? html`<p class="muse-narration user-content" dir="auto">${narration}</p>` : '')}
                ${section('muse.lib.d.screen', screen.length ? html`<ul class="muse-notes">${screen.map((x) => html`<li class="user-content" dir="auto">${x}</li>`)}</ul>` : '')}
                ${section('muse.lib.d.moments', moments.length ? html`<ul class="muse-notes muse-moments">${moments.map((x) => html`<li><span class="muse-clock ltr-text" dir="ltr">${this.museClock(x.second)}</span> <span class="user-content" dir="auto">${x.what}</span></li>`)}</ul>` : '')}
                ${section('muse.lib.d.topics', topics.length ? html`<ul class="growth-chips muse-topics">${topics.map((x) => html`<li class="chip growth-chip"><span class="user-content" dir="auto">${x}</span></li>`)}</ul>` : '')}
                ${section('muse.lib.d.hook', hook || score !== null ? html`
                    ${hook ? html`<p class="user-content" dir="auto">${hook}</p>` : ''}
                    ${score !== null ? html`<p class="form-hint">${t('muse.lib.hook', { score })}</p>` : ''}
                ` : '')}
                ${section('muse.lib.d.caption', caption ? html`<p class="muse-narration user-content" dir="auto">${caption}</p>` : '')}
                ${section('muse.lib.d.cover', cover ? html`<p class="user-content" dir="auto">${t('muse.lib.d.coverAt', { clock: this.museClock(cover.second) })}${cover.reason ? html` ${cover.reason}` : ''}</p>` : '')}
                ${row.model ? html`<p class="form-hint">${row.usd !== null ? t('muse.lib.d.by', { model: this.isolate(row.model), cost: this.museMoney(row.usd) }) : t('muse.lib.d.model', { model: this.isolate(row.model) })}</p>` : ''}
            </div>
        `;
    },

    // ─── Asking, and pressing ───

    /**
     * Asks for the list. The first ask (or a press on Refresh) shows "loading"; a poll is quiet, and one that fails keeps the list it has and says so beside the counts. A late answer,
     * or one for a page that was left or a library that was forgotten, is dropped. When a reel is still waiting the next ask is scheduled.
     */
    async loadMuseLibrary(opts) {
        const lib = this.museLibState();
        const quiet = !!(opts && opts.quiet);
        if (lib.status === 'loading') return;
        if (!quiet || lib.status === 'idle') {
            lib.status = 'loading';
            this.paintMuseLibrary();
        }
        const page = this._seq;
        let result = null;
        let failure = '';
        try {
            result = await API.getMuseLibrary();
        } catch (err) {
            console.error('Video library load error:', err);
            failure = (err && typeof err.message === 'string' && err.message) || t('muse.lib.loadFailed');
        }
        if (page !== this._seq || lib !== this._museLib) return;
        if (failure) {
            lib.status = lib.rows.length ? 'ready' : 'failed';
            lib.error = failure;
        } else {
            lib.rows = this.museReelsFrom(result);
            lib.status = 'ready';
            lib.error = '';
        }
        this.paintMuseLibrary();
        this.museLibrarySchedule();
    },

    /** The next ask, while a reel waits: not forever (`MUSE_POLL_MAX`), not twice, and not for a page that was left. */
    museLibrarySchedule() {
        const lib = this._museLib;
        if (!lib) return;
        if (lib.timer) {
            clearTimeout(lib.timer);
            lib.timer = null;
        }
        if (!lib.rows.some((r) => r.status === 'pending') || lib.polls >= this.MUSE_POLL_MAX) return;
        const page = this._seq;
        lib.timer = setTimeout(() => {
            lib.timer = null;
            if (page !== this._seq || lib !== this._museLib) return;
            lib.polls += 1;
            this.loadMuseLibrary({ quiet: true });
        }, this.MUSE_POLL_MS);
    },

    /** Refresh: asks for the list again now, and starts the polls over. */
    museRefreshLibrary() {
        if (!this.museOwner()) return;
        const lib = this.museLibState();
        lib.polls = 0;
        lib.notice = null;
        return this.loadMuseLibrary();
    },

    /**
     * "Index my reels": queues every published reel that has no notes. Nothing is sent unless the SAVED switch is on (the server answers 409 for the rest, and the button is off
     * then), by anyone but the owner, or twice at once. What the server counted is what is said, and the list is asked for at once, so the reels show as waiting.
     */
    async museIndexAll(button) {
        const m = this._muse;
        if (!m || m.status !== 'ready' || !this.museOwner() || m.saved.switches.memory !== true) return;
        const lib = this.museLibState();
        if (lib.busy) return;
        const restore = UI.actionBusy(button, t('muse.lib.indexing'));
        if (!restore) return; // already in flight
        lib.busy = true;
        lib.notice = null;
        const page = this._seq;
        try {
            const got = await API.indexMuseLibrary();
            if (page !== this._seq || lib !== this._museLib) return;
            lib.notice = this.museQueuedNotice(got);
            lib.polls = 0;
            await this.loadMuseLibrary({ quiet: true });
        } catch (err) {
            console.error('Index my reels error:', err);
            if (page === this._seq && lib === this._museLib) lib.notice = { kind: 'error', text: this.museLibError(err) };
        } finally {
            lib.busy = false;
            restore();
            if (lib === this._museLib) this.paintMuseLibrary();
        }
    },

    /** "Watch again" on one reel: queues it, whatever its state. A reel whose notes are good keeps them until the new ones replace them, which is what the notice says. */
    async museReindexReel(id) {
        const m = this._muse;
        const lib = this.museLibState();
        const row = lib.rows.find((r) => r.id === id);
        if (!m || m.status !== 'ready' || !this.museOwner() || m.saved.switches.memory !== true || !row || !row.mediaId || row.status === 'pending' || lib.again.has(id)) return;
        lib.again.add(id);
        lib.notice = null;
        this.paintMuseLibrary();
        const page = this._seq;
        try {
            const got = await API.reindexMuseReel(id);
            if (page !== this._seq || lib !== this._museLib) return;
            lib.notice = { kind: 'ok', text: got && got.queued === false ? t('muse.lib.alreadyQueued') : t(row.status === 'ok' ? 'muse.lib.queuedOneKept' : 'muse.lib.queuedOne') };
            lib.polls = 0;
            lib.again.delete(id);
            await this.loadMuseLibrary({ quiet: true });
        } catch (err) {
            console.error('Watch again error:', err);
            if (page === this._seq && lib === this._museLib) lib.notice = { kind: 'error', text: this.museLibError(err) };
        } finally {
            if (lib === this._museLib) {
                lib.again.delete(id);
                this.paintMuseLibrary();
            }
        }
    },

    /** Opens or closes one reel's details; opening asks for them. The focus stays on the button that was pressed, which is drawn again with the list. */
    async museToggleReel(id) {
        if (!this.museOwner() || !this.MUSE_REEL_ID.test(String(id))) return;
        const lib = this.museLibState();
        const refocus = () => {
            const el = document.getElementById(`muse-toggle-${id}`);
            if (el && typeof el.focus === 'function') el.focus();
        };
        if (lib.open.has(id)) {
            lib.open.delete(id);
            this.paintMuseLibraryList();
            refocus();
            return;
        }
        const entry = { status: 'loading', result: null };
        lib.open.set(id, entry);
        this.paintMuseLibraryList();
        refocus();
        const page = this._seq;
        try {
            const result = await API.getMuseReel(id);
            if (page !== this._seq || lib !== this._museLib || lib.open.get(id) !== entry) return;
            entry.result = result;
            entry.status = 'ready';
        } catch (err) {
            console.error('Video library reel error:', err);
            if (page !== this._seq || lib !== this._museLib || lib.open.get(id) !== entry) return;
            entry.status = 'failed';
        }
        this.paintMuseLibraryList();
        refocus();
    },

    async saveSettings(form, event) {
        event.preventDefault();
        // The server refuses a viewer's save (`canOperate`); nothing is sent, and no toast quotes its 403.
        if (!this.canEdit()) return;
        // The only double-submit guard in the dashboard (see components.js);
        // this form is never replaced on success, so restore() runs in
        // `finally` rather than being skipped on the happy path.
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // already in flight

        const payload = {
            is_active: document.getElementById('ai-active-toggle').checked,
            system_prompt: document.getElementById('system-prompt-text').value,
            knowledge_base: document.getElementById('knowledge-base-text').value,
            model: document.getElementById('model-selector').value,
            temperature: parseFloat(document.getElementById('temp-slider').value),
        };
        // The engine and the fallback switch, when the form has them. Sent every time, so what is on screen is what is saved.
        if (document.getElementById('engine-selector')) payload.engine = this.engineValue();
        if (document.getElementById('gemini-fallback-toggle')) payload.gemini_fallback = this.fallbackOn();
        // The sales mode and its test senders, when the form has them. Sent every time, so what is on screen is what is saved; a bad ID
        // is stopped here with the hint on screen (the server refuses it as well).
        if (document.getElementById('sales-mode-selector')) {
            payload.sales_mode = this.salesMode();
            payload.sales_test_senders = this.testSenders();
            const problem = this.sendersHint('on', payload.sales_test_senders);
            if (problem) {
                this.syncSales();
                UI.toast(problem.text, 'error');
                restore();
                return;
            }
        }

        // The follow-up delay (S9), when this screen has it (a platform admin) and it changed: checked here, before anything is saved, so a typo
        // does not leave the agent saved and the delay not. It has a route of its own and is saved right after the agent's settings.
        let followup = null;
        if (this.followupDirty()) {
            const minutes = this.followupMinutes();
            if (minutes === null) {
                this.syncSales();
                UI.toast(this.followupHint(null).text, 'error');
                restore();
                return;
            }
            followup = { minutes };
        }

        // The wording experiment (S14), when this screen has it and it changed: checked here for what can be told without the server, before anything
        // is saved, so a typo does not leave the agent saved and the experiment not. It has a route of its own and is saved right after the agent's settings.
        let variants = null;
        if (this.variantsDirty()) {
            const draft = this.variantsDraft();
            const problem = this.variantsProblem(draft);
            if (problem) {
                this.syncSales();
                UI.toast(this.variantsProblemText(problem), 'error');
                restore();
                return;
            }
            variants = draft;
        }

        try {
            await API.saveAiSettings(payload);
            // The fields are now what the server holds, so nothing is unsaved
            // and neither the reload guard nor destroy() should claim otherwise.
            this._saved = {
                system_prompt: payload.system_prompt,
                knowledge_base: payload.knowledge_base,
                settings: this.currentSettings(),
            };
            this._draft = null;
            if (followup) {
                await API.saveSalesFollowup(followup);
                this._followup = { ...this._followup, minutes: followup.minutes };
            }
            if (variants) {
                this.adoptVariants(await API.saveSalesVariants(variants));
            }
            this.refreshDirty();
            UI.toast(t('ai.saved'), 'success');
        } catch (err) {
            console.error('Save Settings Error:', err);
            UI.toast(this.variantsErrorText(err) || err.message || t('ai.saveFailed'), 'error');
            // Whatever did save is no longer unsaved: the note beside Save says what is still left.
            this.refreshDirty();
        } finally {
            restore();
        }
    },

    /**
     * Run one message through the current (unsaved) prompt.
     *
     * Two things were wrong with how this handled being in flight.
     *
     * The submit BUTTON was never disabled — only the text field was — so a
     * second click sent a second request and appended a second "waiting" bubble
     * that the first response then orphaned, because the reply handler only
     * removes the loader it created itself. `UI.formBusy` is the guard the rest
     * of the dashboard uses and returning null is the double-click no-op. The
     * empty label is deliberate: this button is icon-only with its name in
     * `aria-label`, exactly like the inbox composer's.
     *
     * And disabling the input blurred it, because disabling the focused element
     * drops focus to `<body>`; the `finally` then pulled focus back, so every
     * test bounced the operator out of the page and back in. The field stays
     * enabled — the same rule the inbox composer is written to, for the same
     * reason — and focus is only restored when the round trip is what took it
     * away.
     */
    async sendSandboxTest(form, event) {
        event.preventDefault();
        // `POST /settings/ai/test` is `canOperate` too: a test spends the agent's model, so a viewer does not run one.
        if (!this.canEdit()) return;
        const input = document.getElementById('sandbox-user-input');
        const query = input.value.trim();
        if (!query) return;

        const restore = UI.formBusy(form, '');
        if (!restore) return; // already in flight

        input.value = '';

        const container = document.getElementById('sandbox-messages-container');
        const welcome = container.querySelector('.sandbox-welcome');
        if (welcome) welcome.remove();

        container.insertAdjacentHTML('beforeend', esc(html`
            <div class="sandbox-msg msg-user">
                <div class="sandbox-bubble bubble-user" dir="auto">${query}</div>
            </div>
        `));
        container.scrollTop = container.scrollHeight;

        const loadingId = `loading-${Date.now()}`;
        container.insertAdjacentHTML('beforeend', esc(html`
            <div class="sandbox-msg msg-bot" id="${loadingId}">
                <div class="bot-avatar-sm"><i data-lucide="bot" aria-hidden="true"></i></div>
                <div class="sandbox-bubble bubble-bot">
                    <!-- This used to be a role="status" nested INSIDE the log's
                         own live region, so "waiting" was announced twice. The
                         log announces the addition; the dots are decoration and
                         the sr-only text is what it reads. -->
                    <div class="typing-dots" aria-hidden="true">
                        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                    </div>
                    <span class="sr-only">${t('ai.sandboxWaiting')}</span>
                </div>
            </div>
        `));
        UI.icons(container);
        container.scrollTop = container.scrollHeight;

        // AI1: the model and temperature ON SCREEN, so the test runs what the
        // operator is about to save — it used to run the saved pair.
        const payload = this.sandboxPayload(query);

        try {
            const aiRes = await API.testAiSettings(payload);
            const loader = document.getElementById(loadingId);
            if (loader) loader.remove();

            container.insertAdjacentHTML('beforeend', esc(html`
                <div class="sandbox-msg msg-bot">
                    <div class="bot-avatar-sm"><i data-lucide="bot" aria-hidden="true"></i></div>
                    <div class="sandbox-bubble bubble-bot">
                        <!-- The model answers in Arabic because the prompt is
                             Arabic — that is the whole product. -->
                        <p dir="auto" lang="ar">${aiRes.text}</p>
                        ${this.structuredPreview(aiRes)}
                        ${this.sandboxVia(aiRes) ? html`<p class="${aiRes.fell_back ? 'form-hint text-warning' : 'form-hint'}">${this.sandboxVia(aiRes)}</p>` : ''}
                    </div>
                </div>
            `));

            UI.icons(container);
            container.scrollTop = container.scrollHeight;
        } catch (err) {
            console.error('Sandbox API Error:', err);
            const loader = document.getElementById(loadingId);
            if (loader) loader.remove();
            container.insertAdjacentHTML('beforeend', esc(html`
                <div class="sandbox-msg msg-error">
                    <div class="sandbox-bubble bubble-error" dir="auto">${this.sandboxErrorText(err)}</div>
                </div>
            `));
            container.scrollTop = container.scrollHeight;
        } finally {
            restore();
            // Focus is only reclaimed when the busy button dropped it on the
            // floor — submitting by clicking Send disables the focused button,
            // which sends focus to <body>. Tabbing to the prompt textarea while
            // the model thinks is a perfectly ordinary thing to do, and yanking
            // the caret out of it a second later is not, so anything still
            // focused is left alone.
            const lost = !document.activeElement || document.activeElement === document.body;
            if (lost && input && typeof input.focus === 'function') input.focus();
        }
    },

    /** What the sandbox sends: the draft texts, the message, and the model/temperature on screen. */
    sandboxPayload(query) {
        const value = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
        const payload = {
            system_prompt: value('system-prompt-text'),
            knowledge_base: value('knowledge-base-text'),
            user_message: query,
        };
        const model = value('model-selector');
        if (model) payload.model = model;
        const temperature = parseFloat(value('temp-slider'));
        if (Number.isFinite(temperature)) payload.temperature = temperature;
        // The engine on screen too, so the test runs what is about to be saved.
        if (document.getElementById('engine-selector')) {
            payload.engine = this.engineValue();
            payload.gemini_fallback = this.fallbackOn();
        }
        return payload;
    },

    /** Which engine wrote a test reply, and that AI providers failed when Gemini answered in its place; '' for a server that does not say. */
    sandboxVia(aiRes) {
        if (!aiRes || !aiRes.engine) return '';
        if (aiRes.fell_back) return t('ai.sandboxViaFallback', { reason: this.isolate(aiRes.fallback_reason || '') });
        return t(aiRes.engine === 'providers' ? 'ai.sandboxViaProviders' : 'ai.sandboxViaGemini');
    },

    /**
     * What the test box says when a test fails: the server's own words, or a generic line when it sent none. There is no "the agent is
     * off" case to word: the box answers while the assistant is off (`decideAgent`, `isSandbox`), so a 409 here is never that.
     */
    sandboxErrorText(err) {
        return (err && err.message) || t('ai.errorReply');
    },

    /** Quick replies and carousels come back from Gemini — model output, escaped. */
    structuredPreview(aiRes) {
        const parts = [];

        if (aiRes.message_type === 'quick_reply' && Array.isArray(aiRes.quick_replies)) {
            parts.push(html`
                <div class="msg-quick-replies">
                    ${aiRes.quick_replies.map((qr) => html`<span class="qr-pill" dir="auto" lang="ar">${qr && qr.title}</span>`)}
                </div>
            `);
        }

        if (aiRes.message_type === 'carousel' && Array.isArray(aiRes.carousel_elements)) {
            parts.push(html`
                <div class="sandbox-carousel">
                    ${aiRes.carousel_elements.map((el) => {
                        const image = safeUrl(el && el.image_url);
                        const buttons = Array.isArray(el && el.buttons) ? el.buttons : [];
                        return html`
                            <div class="sandbox-card">
                                ${image ? html`<img src="${image}" class="sandbox-card-img" alt="${(el && el.title) || ''}">` : ''}
                                <div class="sandbox-card-body">
                                    <h5 class="sandbox-card-title" dir="auto" lang="ar">${el && el.title}</h5>
                                    ${el && el.subtitle ? html`<p class="sandbox-card-subtitle" dir="auto" lang="ar">${el.subtitle}</p>` : ''}
                                    <div class="stack gap-1">
                                        ${buttons.map((btn) => html`<span class="sandbox-card-btn" dir="auto" lang="ar">${btn && btn.title}</span>`)}
                                    </div>
                                </div>
                            </div>
                        `;
                    })}
                </div>
            `);
        }

        return parts;
    },
};

UI.registerActions('ai', {
    saveSettings: (el, e) => AiSettingsPage.saveSettings(el, e),
    sendSandboxTest: (el, e) => AiSettingsPage.sendSandboxTest(el, e),
    updateTemperature: (el) => AiSettingsPage.updateTemperature(el.value),
    refreshDirty: () => AiSettingsPage.refreshDirty(),
    engineChanged: () => AiSettingsPage.engineChanged(),
    fallbackChanged: () => AiSettingsPage.fallbackChanged(),
    salesChanged: () => AiSettingsPage.salesChanged(),
    variantsChanged: () => AiSettingsPage.variantsChanged(),
    addVariant: () => AiSettingsPage.addVariant(),
    removeVariant: (el) => AiSettingsPage.removeVariant(el && el.dataset ? el.dataset.slot : ''),
});

// Meta vision (beta): the owner's card under the form.
UI.registerActions('muse', {
    changed: () => AiSettingsPage.museChanged(),
    whoChanged: () => AiSettingsPage.museWhoChanged(),
    togglePicker: () => AiSettingsPage.museTogglePicker(),
    pickerKey: (el, e) => AiSettingsPage.musePickerKey(e),
    pickerSearch: (el) => AiSettingsPage.musePickerSearch(el),
    retryPicker: () => AiSettingsPage.loadMusePicker(true),
    addPerson: (el) => AiSettingsPage.museAddPerson(el && el.dataset ? el.dataset.id : ''),
    removePerson: (el) => AiSettingsPage.museRemovePerson(el && el.dataset ? el.dataset.id : ''),
    save: (el) => AiSettingsPage.museSave(el),
    reload: () => AiSettingsPage.museReload(),
    // The video library inside the card.
    indexAll: (el) => AiSettingsPage.museIndexAll(el),
    refreshLibrary: () => AiSettingsPage.museRefreshLibrary(),
    toggleReel: (el) => AiSettingsPage.museToggleReel(el && el.dataset ? el.dataset.id : ''),
    reindexReel: (el) => AiSettingsPage.museReindexReel(el && el.dataset ? el.dataset.id : ''),
});
