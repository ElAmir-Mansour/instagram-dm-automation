/**
 * AI Agent Settings — configuration on one side, a live sandbox on the other.
 *
 * Both textareas hold Arabic prose that the model reads verbatim, so they get
 * the loose Arabic leading and `unicode-bidi: plaintext` (via `.user-content`)
 * rather than the tight UI line-height: a system prompt with a Latin URL in
 * the middle of an Arabic sentence has to keep that URL where it was typed.
 */
const AiSettingsPage = {
    render() {
        const container = document.getElementById('page-container');
        container.innerHTML = esc(html`
            <div class="ai-grid">
                <section class="surface ai-panel">
                    <div class="panel-head">
                        <i data-lucide="bot" aria-hidden="true"></i>
                        <h3>${t('ai.configTitle')}</h3>
                    </div>
                    <div id="ai-settings-error"></div>
                    <form id="ai-settings-form" data-submit="ai:saveSettings">
                        <div class="toggle-block">
                            <div>
                                <h4>${t('ai.enableTitle')}</h4>
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
                            <textarea id="system-prompt-text" class="field-textarea user-content" dir="auto" rows="8"
                                      aria-describedby="system-prompt-desc"
                                      placeholder="${t('ai.systemPromptPlaceholder')}" required></textarea>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="knowledge-base-text">${t('ai.knowledge')}</label>
                            <span class="field-desc" id="knowledge-base-desc">${t('ai.knowledgeDesc')}</span>
                            <textarea id="knowledge-base-text" class="field-textarea user-content" dir="auto" rows="10"
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
                                <label class="form-label" for="temp-slider" id="temp-label">
                                    ${t('ai.temperature', { value: '0.7' })}
                                </label>
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
                        <h3>${t('ai.sandboxTitle')}</h3>
                    </div>
                    <p class="panel-desc">${t('ai.sandboxDesc')}</p>

                    <div class="sandbox-shell">
                        <div class="sandbox-messages" id="sandbox-messages-container" role="log" aria-live="polite"
                             aria-label="${t('ai.sandboxTitle')}">
                            <div class="sandbox-welcome">
                                <div class="bot-avatar"><i data-lucide="bot" aria-hidden="true"></i></div>
                                <h4>${t('ai.sandboxWelcome')}</h4>
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
        `);

        UI.icons(container);
        this.loadSettings();
    },

    async loadSettings() {
        try {
            const settings = await API.getAiSettings();
            const temperature = settings.temperature != null ? settings.temperature : 0.7;

            document.getElementById('ai-active-toggle').checked = settings.is_active !== false;
            document.getElementById('system-prompt-text').value = settings.system_prompt || '';
            document.getElementById('knowledge-base-text').value = settings.knowledge_base || '';
            document.getElementById('model-selector').value = settings.model || 'gemini-2.5-flash';
            document.getElementById('temp-slider').value = temperature;
            this.updateTemperature(temperature);
        } catch (err) {
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
        const label = document.getElementById('temp-label');
        if (label) label.textContent = t('ai.temperature', { value: UI.formatNumber(Number(value)) });
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
                    <div class="typing-dots" role="status" aria-label="${t('ai.sandboxWaiting')}">
                        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                    </div>
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
                        <p dir="auto">${aiRes.text}</p>
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
                    ${aiRes.quick_replies.map((qr) => html`<span class="qr-pill" dir="auto">${qr && qr.title}</span>`)}
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
                                    <h5 class="sandbox-card-title" dir="auto">${el && el.title}</h5>
                                    ${el && el.subtitle ? html`<p class="sandbox-card-subtitle" dir="auto">${el.subtitle}</p>` : ''}
                                    <div class="stack gap-1">
                                        ${buttons.map((btn) => html`<span class="sandbox-card-btn" dir="auto">${btn && btn.title}</span>`)}
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
