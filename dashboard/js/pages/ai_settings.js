/**
 * AI Agent Settings Page — Manages agent configuration, system prompts, knowledge base, and sandbox.
 */
const AiSettingsPage = {
    render() {
        const container = document.getElementById('page-container');
        container.innerHTML = `
            <div class="settings-grid">
                <!-- Config Panel -->
                <div class="glass-card settings-main-panel">
                    <div class="panel-header-badge">
                        <i data-lucide="bot"></i>
                        <h3>Agent Configuration</h3>
                    </div>
                    <form id="ai-settings-form" class="settings-form" onsubmit="AiSettingsPage.saveSettings(event)">
                        <!-- Global Toggle -->
                        <div class="form-toggle-row">
                            <div>
                                <h4 class="toggle-title">Enable AI Sales Agent</h4>
                                <p class="toggle-desc">Automatically reply to incoming Instagram direct messages using Gemini.</p>
                            </div>
                            <label class="toggle-switch">
                                <input type="checkbox" id="ai-active-toggle" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>

                        <hr class="divider" />

                        <!-- Brand Instructions / System Prompt -->
                        <div class="form-group">
                            <label class="form-label" for="system-prompt-text">
                                <span>Brand Voice & Instructions (System Prompt)</span>
                                <span class="badge badge-info-glow">Arabic Recommended</span>
                            </label>
                            <span class="field-desc">Define who the AI is, how it behaves, and guidelines for talking to prospects.</span>
                            <textarea id="system-prompt-text" rows="8" placeholder="e.g. أنت مساعد ذكي للاستاذ الأمير منصور..." required></textarea>
                        </div>

                        <!-- Knowledge Base -->
                        <div class="form-group">
                            <label class="form-label" for="knowledge-base-text">
                                <span>Business Knowledge Base & FAQs</span>
                            </label>
                            <span class="field-desc">Provide course links, product names, pricing, and answers to common questions.</span>
                            <textarea id="knowledge-base-text" rows="10" placeholder="e.g. كورسات اليوديمي المتاحة..." required></textarea>
                        </div>

                        <!-- Technical Settings -->
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
                                <input type="range" id="temp-slider" min="0" max="1" step="0.1" value="0.7" oninput="document.getElementById('temp-val').innerText = this.value">
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
                        <i data-lucide="terminal"></i>
                        <h3>Agent Sandbox Simulator</h3>
                    </div>
                    <p class="section-desc">Test your system prompt and FAQs in real-time. This queries Gemini without sending any messages to Instagram.</p>

                    <div class="sandbox-chat-container">
                        <div class="sandbox-messages" id="sandbox-messages-container">
                            <div class="sandbox-welcome">
                                <div class="bot-avatar"><i data-lucide="bot"></i></div>
                                <h4>Test your Sales Bot here!</h4>
                                <p>Type an inquiry (e.g. "هل تقدم كورسات برمجة؟") to preview how the AI responds and structures quick replies or carousels.</p>
                            </div>
                        </div>
                        <div class="sandbox-input-row">
                            <form id="sandbox-send-form" onsubmit="AiSettingsPage.sendSandboxTest(event)">
                                <input type="text" id="sandbox-user-input" placeholder="Type a test message...">
                                <button type="submit" id="sandbox-btn" class="btn btn-primary">
                                    <i data-lucide="send" style="width:16px;height:16px;"></i>
                                </button>
                            </form>
                        </div>
                    </div>
                </div>
            </div>
        `;

        lucide.createIcons({ nodes: [container] });
        this.loadSettings();
    },

    async loadSettings() {
        try {
            const settings = await API.request('/settings/ai');
            
            document.getElementById('ai-active-toggle').checked = settings.is_active !== false;
            document.getElementById('system-prompt-text').value = settings.system_prompt || '';
            document.getElementById('knowledge-base-text').value = settings.knowledge_base || '';
            document.getElementById('model-selector').value = settings.model || 'gemini-2.5-flash';
            document.getElementById('temp-slider').value = settings.temperature || 0.7;
            document.getElementById('temp-val').innerText = settings.temperature || 0.7;
        } catch (err) {
            console.error('AI Settings Load Error:', err);
            Components.showToast('Failed to load AI settings.', 'error');
        }
    },

    async saveSettings(e) {
        e.preventDefault();
        const btn = document.getElementById('save-settings-btn');
        btn.disabled = true;
        btn.innerText = 'Saving...';

        const payload = {
            is_active: document.getElementById('ai-active-toggle').checked,
            system_prompt: document.getElementById('system-prompt-text').value,
            knowledge_base: document.getElementById('knowledge-base-text').value,
            model: document.getElementById('model-selector').value,
            temperature: parseFloat(document.getElementById('temp-slider').value)
        };

        try {
            await API.request('/settings/ai', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            Components.showToast('AI Agent Settings saved successfully!', 'success');
        } catch (err) {
            console.error('Save Settings Error:', err);
            Components.showToast('Failed to save settings.', 'error');
        } finally {
            btn.disabled = false;
            btn.innerText = 'Save Changes';
        }
    },

    async sendSandboxTest(e) {
        e.preventDefault();
        const input = document.getElementById('sandbox-user-input');
        const query = input.value.trim();
        if (!query) return;

        input.value = '';
        input.disabled = true;

        const container = document.getElementById('sandbox-messages-container');
        
        // Remove welcome message if exists
        const welcome = container.querySelector('.sandbox-welcome');
        if (welcome) welcome.remove();

        // 1. Add User Message
        container.innerHTML += `
            <div class="sandbox-msg msg-user">
                <div class="sandbox-bubble bubble-user">${query}</div>
            </div>
        `;
        container.scrollTop = container.scrollHeight;

        // 2. Add Loading Indicator
        const loadingId = 'loading-' + Date.now();
        container.innerHTML += `
            <div class="sandbox-msg msg-bot" id="${loadingId}">
                <div class="bot-avatar-sm"><i data-lucide="bot" style="width:14px;height:14px;"></i></div>
                <div class="sandbox-bubble bubble-bot">
                    <div class="typing-dots">
                        <span class="dot"></span>
                        <span class="dot"></span>
                        <span class="dot"></span>
                    </div>
                </div>
            </div>
        `;
        lucide.createIcons({ nodes: [container] });
        container.scrollTop = container.scrollHeight;

        // Collect current (unsaved) prompts to simulate accurately
        const payload = {
            system_prompt: document.getElementById('system-prompt-text').value,
            knowledge_base: document.getElementById('knowledge-base-text').value,
            user_message: query
        };

        try {
            const aiRes = await API.request('/settings/ai/test', {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            // Remove loading indicator
            document.getElementById(loadingId).remove();

            // Format Structured Displays (Quick Replies & Carousels)
            let structuredHtml = '';
            if (aiRes.message_type === 'quick_reply' && aiRes.quick_replies) {
                structuredHtml += `<div class="sandbox-quick-replies">`;
                aiRes.quick_replies.forEach(qr => {
                    structuredHtml += `<span class="sandbox-qr-pill">${qr.title}</span>`;
                });
                structuredHtml += `</div>`;
            }

            if (aiRes.message_type === 'carousel' && aiRes.carousel_elements) {
                structuredHtml += `<div class="sandbox-carousel">`;
                aiRes.carousel_elements.forEach(el => {
                    let buttonsHtml = '';
                    if (el.buttons) {
                        el.buttons.forEach(btn => {
                            buttonsHtml += `<span class="sandbox-card-btn">${btn.title}</span>`;
                        });
                    }
                    structuredHtml += `
                        <div class="sandbox-card glass-card">
                            ${el.image_url ? `<img src="${el.image_url}" class="sandbox-card-img" />` : ''}
                            <div class="sandbox-card-body">
                                <h5 class="sandbox-card-title">${el.title}</h5>
                                ${el.subtitle ? `<p class="sandbox-card-subtitle">${el.subtitle}</p>` : ''}
                                <div class="sandbox-card-buttons">${buttonsHtml}</div>
                            </div>
                        </div>
                    `;
                });
                structuredHtml += `</div>`;
            }

            // 3. Render AI Response
            container.innerHTML += `
                <div class="sandbox-msg msg-bot">
                    <div class="bot-avatar-sm"><i data-lucide="bot" style="width:14px;height:14px;"></i></div>
                    <div class="sandbox-bubble bubble-bot">
                        <p>${aiRes.text}</p>
                        ${structuredHtml}
                    </div>
                </div>
            `;

            lucide.createIcons({ nodes: [container] });
            container.scrollTop = container.scrollHeight;

        } catch (err) {
            console.error('Sandbox API Error:', err);
            document.getElementById(loadingId).remove();
            container.innerHTML += `
                <div class="sandbox-msg msg-error">
                    <div class="sandbox-bubble bubble-error">Error obtaining response. Please check your API key in .env.</div>
                </div>
            `;
            container.scrollTop = container.scrollHeight;
        } finally {
            input.disabled = false;
            input.focus();
        }
    }
};
