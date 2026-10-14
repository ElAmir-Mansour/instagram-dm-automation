/**
 * AI Agent Settings — configuration on one side, a live sandbox on the other.
 *
 * Both textareas hold Arabic prose that the model reads verbatim, so they get
 * the loose Arabic leading and `unicode-bidi: plaintext` (via `.user-content`)
 * rather than the tight UI line-height: a system prompt with a Latin URL in
 * the middle of an Arabic sentence has to keep that URL where it was typed.
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

    _onBeforeUnload: null,

    render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        if (!container.querySelector('.ai-grid')) {
            container.innerHTML = esc(this.shell());
            UI.icons(container);
        }
        Motion.clearSkeleton(container);

        // The two textareas hold the product: a half-written system prompt is
        // work nobody wants to retype. A reload or a tab close is caught here;
        // an in-app navigation is caught in destroy(), which cannot cancel the
        // navigation but CAN keep the text and hand it back.
        if (!this._onBeforeUnload) {
            this._onBeforeUnload = (e) => {
                if (!this.isDirty()) return undefined;
                e.preventDefault();
                e.returnValue = '';
                return '';
            };
            window.addEventListener('beforeunload', this._onBeforeUnload);
        }

        this.loadSettings();
    },

    destroy() {
        this._seq++;
        if (this._onBeforeUnload) {
            window.removeEventListener('beforeunload', this._onBeforeUnload);
            this._onBeforeUnload = null;
        }
        // Navigation is already happening by the time this runs, so the honest
        // move is not a confirm() that cannot be honoured — it is to keep the
        // text and restore it the next time this screen opens. That is
        // announced THEN rather than now: on logout App.resetTenantState()
        // clears the draft immediately after this, and a "your draft is safe"
        // toast would have been a lie.
        if (this.isDirty()) this._draft = this.currentValues();
    },

    resetTenantState() {
        // Another tenant's prompt must never be handed to this one.
        this._draft = null;
        this._saved = null;
        this._routeView = undefined;
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
        if (this.isDirty() || this.followupDirty()) return true;
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
                    <p class="form-hint mbe-3">${UI.helpLink('ai-usage', t('help.link.aiUsage'), { newTab: true })}</p>
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
                                <input type="checkbox" id="ai-active-toggle" checked>
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
                                      placeholder="${t('ai.systemPromptPlaceholder')}" required></textarea>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="knowledge-base-text">${t('ai.knowledge')}</label>
                            <span class="field-desc" id="knowledge-base-desc">${t('ai.knowledgeDesc')}</span>
                            <textarea id="knowledge-base-text" class="field-textarea user-content" dir="auto" lang="ar" rows="10"
                                      aria-describedby="knowledge-base-desc"
                                      placeholder="${t('ai.knowledgePlaceholder')}"></textarea>
                        </div>

                        <!-- The reply engine: Gemini is the call the bot has always made; AI providers goes through the layer
                             the operator configures in Operations (purpose "dm"). The model and temperature below are Gemini's. -->
                        <div class="form-group">
                            <label class="form-label" for="engine-selector">${t('ai.engine')}</label>
                            <select class="select" id="engine-selector" data-change="ai:engineChanged"
                                    aria-describedby="engine-desc engine-route-hint">
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
                                <input type="checkbox" id="gemini-fallback-toggle" data-change="ai:fallbackChanged" checked>
                                <span class="switch-track"></span>
                            </label>
                        </div>

                        <!-- The sales assistant (DM plan S6): Off is today's replies, Test answers only the listed senders, On everyone. It writes
                             through the same "dm" route as the engine above, whichever engine is picked. The IDs are numbers, so the box is LTR. -->
                        <div class="form-group">
                            <label class="form-label" for="sales-mode-selector">${t('ai.sales')}</label>
                            <select class="select" id="sales-mode-selector" data-change="ai:salesChanged" aria-describedby="sales-desc">
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
                                      placeholder="${t('ai.salesSendersPlaceholder')}"></textarea>
                            <p class="form-hint hidden" id="sales-senders-hint" role="status" aria-live="polite"></p>
                        </div>

                        <!-- The one follow-up nudge, hours after a link (DM plan S9): a platform admin's setting for the whole deployment, so the
                             block stays hidden until the screen has read it (it never does for anyone else) and the sales assistant is not Off. -->
                        <div class="form-group hidden" id="sales-followup-block">
                            <label class="form-label" for="sales-followup-minutes">${t('ai.salesFollowup')}</label>
                            <span class="field-desc" id="sales-followup-desc">${t('ai.salesFollowupDesc')}</span>
                            <input class="field" id="sales-followup-minutes" type="number" inputmode="numeric" dir="ltr" lang="en" min="0" max="1320" step="1"
                                   autocomplete="off" data-input="ai:salesChanged" aria-describedby="sales-followup-desc sales-followup-hint">
                            <p class="form-hint hidden" id="sales-followup-hint" role="status" aria-live="polite"></p>
                        </div>

                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label" for="model-selector">${t('ai.model')}</label>
                                <!-- Exactly SUPPORTED_MODELS in src/services/ai.ts, the
                                     default first; screens.test.ts fails if they drift.
                                     This still offered Gemini 1.5 Flash after Google
                                     stopped serving it, and choosing it would have
                                     failed every DM. -->
                                <select class="select" id="model-selector" aria-describedby="model-selector-hint">
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
                                       data-input="ai:updateTemperature" aria-describedby="temp-anchors">
                                <!-- AI5: what the two ends mean. A bare 0–1 slider said
                                     nothing about which end stops the agent improvising. -->
                                <span class="field-desc" id="temp-anchors">${t('ai.temperatureAnchors')}</span>
                            </div>
                        </div>

                        <div class="form-actions ai-save-row">
                            ${UI.button({
                                variant: 'primary', type: 'submit', icon: 'check',
                                label: t('common.saveChanges'), id: 'save-settings-btn',
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
                                       placeholder="${t('ai.sandboxPlaceholder')}">
                                ${UI.button({
                                    variant: 'primary', type: 'submit', icon: 'send',
                                    ariaLabel: t('ai.sandboxSend'), id: 'sandbox-btn',
                                })}
                            </form>
                        </div>
                    </div>
                </section>
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
            const saveBtn = document.getElementById('save-settings-btn');
            if (saveBtn) saveBtn.disabled = false;

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
            this.syncEngine();
            this.syncSales();

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
        // The fallback switch and the route hint mean something whenever the layer writes replies, which Sales On and Test do too.
        this.syncEngine();
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

    async saveSettings(form, event) {
        event.preventDefault();
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
            this.refreshDirty();
            UI.toast(t('ai.saved'), 'success');
        } catch (err) {
            console.error('Save Settings Error:', err);
            UI.toast(err.message || t('ai.saveFailed'), 'error');
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

    /** AI3: the 409 "agent is turned off" arrived as raw English. */
    sandboxErrorText(err) {
        if (err && err.status === 409) return t('ai.sandboxAgentOff');
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
});
