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
    },

    /** What the server last gave us, to compare the fields against. */
    _saved: null,

    currentValues() {
        const prompt = document.getElementById('system-prompt-text');
        const knowledge = document.getElementById('knowledge-base-text');
        if (!prompt || !knowledge) return null;
        return { system_prompt: prompt.value, knowledge_base: knowledge.value };
    },

    isDirty() {
        const now = this.currentValues();
        if (!now || !this._saved) return false;
        return now.system_prompt !== this._saved.system_prompt
            || now.knowledge_base !== this._saved.knowledge_base;
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
                    <div id="ai-settings-error"></div>
                    <form id="ai-settings-form" data-submit="ai:saveSettings">
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
                                      placeholder="${t('ai.knowledgePlaceholder')}" required></textarea>
                        </div>

                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label" for="model-selector">${t('ai.model')}</label>
                                <select class="select" id="model-selector">
                                    <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                                    <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                                </select>
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
                                       data-input="ai:updateTemperature">
                            </div>
                        </div>

                        <div class="form-actions">
                            <button type="submit" id="save-settings-btn" class="btn btn-primary">
                                <i data-lucide="check" aria-hidden="true"></i>
                                <span>${t('common.saveChanges')}</span>
                            </button>
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
                                <button type="submit" id="sandbox-btn" class="btn btn-primary" aria-label="${t('ai.sandboxSend')}">
                                    <i data-lucide="send" aria-hidden="true"></i>
                                </button>
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

            toggle.checked = settings.is_active !== false;
            prompt.value = settings.system_prompt || '';
            knowledge.value = settings.knowledge_base || '';
            model.value = settings.model || 'gemini-2.5-flash';
            slider.value = temperature;
            this.updateTemperature(temperature);

            this._saved = {
                system_prompt: prompt.value,
                knowledge_base: knowledge.value,
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

    updateTemperature(value) {
        const out = document.getElementById('temp-value');
        if (out) out.textContent = UI.formatNumber(Number(value));
    },

    async saveSettings(form, event) {
        event.preventDefault();
        const btn = document.getElementById('save-settings-btn');
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = UI.buttonSpinner(t('common.saving'));

        const payload = {
            is_active: document.getElementById('ai-active-toggle').checked,
            system_prompt: document.getElementById('system-prompt-text').value,
            knowledge_base: document.getElementById('knowledge-base-text').value,
            model: document.getElementById('model-selector').value,
            temperature: parseFloat(document.getElementById('temp-slider').value),
        };

        try {
            await API.saveAiSettings(payload);
            // The fields are now what the server holds, so nothing is unsaved
            // and neither the reload guard nor destroy() should claim otherwise.
            this._saved = {
                system_prompt: payload.system_prompt,
                knowledge_base: payload.knowledge_base,
            };
            this._draft = null;
            UI.toast(t('ai.saved'), 'success');
        } catch (err) {
            console.error('Save Settings Error:', err);
            UI.toast(err.message || t('ai.saveFailed'), 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
            UI.icons(btn);
        }
    },

    async sendSandboxTest(form, event) {
        event.preventDefault();
        const input = document.getElementById('sandbox-user-input');
        const query = input.value.trim();
        if (!query) return;

        input.value = '';
        input.disabled = true;

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

        const payload = {
            system_prompt: document.getElementById('system-prompt-text').value,
            knowledge_base: document.getElementById('knowledge-base-text').value,
            user_message: query,
        };

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
                    <div class="sandbox-bubble bubble-error" dir="auto">${err.message || t('ai.errorReply')}</div>
                </div>
            `));
            container.scrollTop = container.scrollHeight;
        } finally {
            input.disabled = false;
            input.focus();
        }
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
});
