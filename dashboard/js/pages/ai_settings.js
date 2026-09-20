/**
 * AI Agent Settings Page — agent configuration, system prompts, knowledge base, sandbox.
 */
const AiSettingsPage = {
    render() {
        const container = document.getElementById('page-container');
        container.innerHTML = esc(html`
            <div class="settings-grid" data-pane="config">
                <!-- Config Panel -->
                <div class="glass-card settings-main-panel">
                    <div class="panel-header-badge">
                        <i data-lucide="bot" aria-hidden="true"></i>
                        <h3>Agent Configuration</h3>
                    </div>
                    <div id="ai-settings-error"></div>
                    <form id="ai-settings-form" class="settings-form" data-submit="ai:saveSettings">
                        <div class="form-toggle-row">
                            <div>
                                <h4 class="toggle-title">Enable AI Sales Agent</h4>
                                <p class="toggle-desc">Automatically reply to incoming Instagram direct messages using Gemini.</p>
                            </div>
                            <label class="toggle-switch" for="ai-active-toggle">
                                <span class="sr-only">Enable AI sales agent</span>
                                <input type="checkbox" id="ai-active-toggle" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>

                        <hr class="divider" />

                        <div class="form-group">
                            <label class="form-label" for="system-prompt-text">
                                <span>Brand Voice &amp; Instructions (System Prompt)</span>
                                <span class="badge badge-info-glow">Arabic Recommended</span>
                            </label>
                            <span class="field-desc" id="system-prompt-desc">Define who the AI is, how it behaves, and guidelines for talking to prospects.</span>
                            <textarea id="system-prompt-text" class="arabic-text" dir="auto" rows="8"
                                      aria-describedby="system-prompt-desc"
                                      placeholder="e.g. أنت مساعد ذكي للاستاذ الأمير منصور..." required></textarea>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="knowledge-base-text">
                                <span>Business Knowledge Base &amp; FAQs</span>
                            </label>
                            <span class="field-desc" id="knowledge-base-desc">Provide course links, product names, pricing, and answers to common questions.</span>
                            <textarea id="knowledge-base-text" class="arabic-text" dir="auto" rows="10"
                                      aria-describedby="knowledge-base-desc"
                                      placeholder="e.g. كورسات اليوديمي المتاحة..." required></textarea>
                        </div>

                        <div class="settings-advanced-row">
                            <div class="form-group">
                                <label class="form-label" for="model-selector">Model</label>
                                <select id="model-selector">
                                    <option value="gemini-2.5-flash">Gemini 2.5 Flash (Fastest)</option>
                                    <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                                </select>
                            </div>

                            <div class="form-group">
                                <label class="form-label" for="temp-slider">Temperature: <span id="temp-val">0.7</span></label>
                                <input type="range" id="temp-slider" min="0" max="1" step="0.1" value="0.7"
                                       data-input="ai:updateTemperature">
                            </div>
                        </div>

                        <div class="form-actions">
                            <button type="submit" id="save-settings-btn" class="btn btn-primary">
                                <span>Save Changes</span>
                            </button>
                        </div>
                    </form>
                </div>

                <!-- Sandbox Simulator -->
                <div class="glass-card settings-sandbox-panel">
                    <div class="panel-header-badge">
                        <i data-lucide="terminal" aria-hidden="true"></i>
                        <h3>Agent Sandbox Simulator</h3>
                    </div>
                    <p class="section-desc">Test your system prompt and FAQs in real-time. This queries Gemini without sending any messages to Instagram.</p>

                    <div class="sandbox-chat-container">
                        <div class="sandbox-messages" id="sandbox-messages-container" role="log" aria-live="polite" aria-label="Sandbox conversation">
                            <div class="sandbox-welcome">
                                <div class="bot-avatar"><i data-lucide="bot" aria-hidden="true"></i></div>
                                <h4>Test your Sales Bot here!</h4>
                                <p dir="auto">Type an inquiry (e.g. "هل تقدم كورسات برمجة؟") to preview how the AI responds and structures quick replies or carousels.</p>
                            </div>
                        </div>
                        <div class="sandbox-input-row">
                            <form id="sandbox-send-form" data-submit="ai:sendSandboxTest">
                                <label class="sr-only" for="sandbox-user-input">Test message</label>
                                <input type="text" id="sandbox-user-input" class="arabic-text" dir="auto" placeholder="Type a test message...">
                                <button type="submit" id="sandbox-btn" class="btn btn-primary" aria-label="Send test message">
                                    <i data-lucide="send" style="width:16px;height:16px;" aria-hidden="true"></i>
                                </button>
                            </form>
                        </div>
                    </div>
                </div>
            </div>
        `);

        UI.icons(container);
        this.loadSettings();
    },

    async loadSettings() {
        try {
            const settings = await API.getAiSettings();

            document.getElementById('ai-active-toggle').checked = settings.is_active !== false;
            document.getElementById('system-prompt-text').value = settings.system_prompt || '';
            document.getElementById('knowledge-base-text').value = settings.knowledge_base || '';
            document.getElementById('model-selector').value = settings.model || 'gemini-2.5-flash';
            document.getElementById('temp-slider').value = settings.temperature != null ? settings.temperature : 0.7;
            document.getElementById('temp-val').textContent = settings.temperature != null ? settings.temperature : 0.7;
        } catch (err) {
            console.error('AI Settings Load Error:', err);
            // An unloaded form full of empty fields would otherwise look like
            // "no prompt configured", and saving it would wipe the real one.
            const host = document.getElementById('ai-settings-error');
            if (host) {
                UI.renderError(
                    host,
                    {
                        title: 'Could not load the saved AI settings',
                        message: err.message,
                        hint: 'The fields below are EMPTY, not your saved values — do not save until this loads.',
                    },
                    () => { host.innerHTML = ''; this.loadSettings(); }
                );
            }
            const saveBtn = document.getElementById('save-settings-btn');
            if (saveBtn) saveBtn.disabled = true;
        }
    },

    updateTemperature(value) {
        document.getElementById('temp-val').textContent = value;
    },

    async saveSettings(form, event) {
        event.preventDefault();
        const btn = document.getElementById('save-settings-btn');
        btn.disabled = true;
        btn.textContent = 'Saving...';

        const payload = {
            is_active: document.getElementById('ai-active-toggle').checked,
            system_prompt: document.getElementById('system-prompt-text').value,
            knowledge_base: document.getElementById('knowledge-base-text').value,
            model: document.getElementById('model-selector').value,
            temperature: parseFloat(document.getElementById('temp-slider').value),
        };

        try {
            await API.saveAiSettings(payload);
            UI.toast('AI Agent Settings saved successfully.', 'success');
        } catch (err) {
            console.error('Save Settings Error:', err);
            UI.toast(err.message || 'Failed to save settings.', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Changes';
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
                <div class="bot-avatar-sm"><i data-lucide="bot" style="width:14px;height:14px;" aria-hidden="true"></i></div>
                <div class="sandbox-bubble bubble-bot">
                    <div class="typing-dots" role="status" aria-label="Waiting for the AI response">
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
                    <div class="bot-avatar-sm"><i data-lucide="bot" style="width:14px;height:14px;" aria-hidden="true"></i></div>
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
                    <div class="sandbox-bubble bubble-error" dir="auto">${err.message || 'Error obtaining response.'}</div>
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
                <div class="sandbox-quick-replies">
                    ${aiRes.quick_replies.map((qr) => html`<span class="sandbox-qr-pill" dir="auto">${qr && qr.title}</span>`)}
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
                            <div class="sandbox-card glass-card">
                                ${image ? html`<img src="${image}" class="sandbox-card-img" alt="${(el && el.title) || 'Carousel image'}">` : ''}
                                <div class="sandbox-card-body">
                                    <h5 class="sandbox-card-title" dir="auto">${el && el.title}</h5>
                                    ${el && el.subtitle ? html`<p class="sandbox-card-subtitle" dir="auto">${el.subtitle}</p>` : ''}
                                    <div class="sandbox-card-buttons">
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
