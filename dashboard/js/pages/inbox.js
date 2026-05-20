/**
 * Live DM Inbox Page — Displays conversations, messages, templates, and controls AI agent.
 */
const InboxPage = {
    selectedConversationId: null,
    pollInterval: null,

    render() {
        const container = document.getElementById('page-container');
        container.innerHTML = `
            <div class="inbox-layout">
                <!-- Threads list -->
                <div class="inbox-sidebar glass-card">
                    <div class="sidebar-search">
                        <i data-lucide="search" class="search-icon"></i>
                        <input type="text" id="inbox-search" placeholder="Search conversations...">
                    </div>
                    <div class="threads-list" id="threads-container">
                        <div class="loading-state">
                            <div class="spinner"></div>
                            <p>Loading conversations...</p>
                        </div>
                    </div>
                </div>

                <!-- Chat Pane -->
                <div class="chat-pane glass-card" id="chat-pane-container">
                    <div class="empty-chat-state">
                        <i data-lucide="message-square" class="empty-icon"></i>
                        <h3>Select a Conversation</h3>
                        <p>Choose a contact from the sidebar to view history or send messages.</p>
                    </div>
                </div>
            </div>
        `;

        lucide.createIcons({ nodes: [container] });
        
        // Start Polling
        this.loadThreads();
        this.startPolling();

        // Attach cleanup event
        const self = this;
        const origNavigate = App.navigate;
        App.navigate = function(page) {
            self.stopPolling();
            App.navigate = origNavigate;
            App.navigate(page);
        };
    },

    startPolling() {
        this.stopPolling();
        this.pollInterval = setInterval(() => {
            this.loadThreads(true); // silent reload
            if (this.selectedConversationId) {
                this.loadMessages(this.selectedConversationId, true); // silent reload
            }
        }, 5000);
    },

    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    },

    async loadThreads(silent = false) {
        try {
            const result = await API.request('/conversations');
            const threads = result.data || [];
            
            const container = document.getElementById('threads-container');
            if (!container) return;

            if (threads.length === 0) {
                container.innerHTML = `
                    <div class="empty-threads">
                        <p>No conversations found yet.</p>
                    </div>
                `;
                return;
            }

            let html = '';
            threads.forEach(t => {
                const isActive = t.id === this.selectedConversationId ? 'active' : '';
                const lastMsg = t.last_message_text || 'No messages yet';
                const direction = t.last_message_direction === 'inbound' ? '📥' : '📤';
                const date = new Date(t.last_message_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                
                const botStatus = t.is_bot_active 
                    ? `<span class="badge badge-success-glow flex-center gap-1"><span class="dot-blink bg-success"></span>AI Active</span>`
                    : `<span class="badge badge-warning-glow">AI Paused</span>`;

                const username = t.username || `User ${t.instagram_user_id.slice(-4)}`;

                html += `
                    <div class="thread-item ${isActive}" onclick="InboxPage.selectThread('${t.id}')">
                        <div class="thread-info">
                            <div class="thread-header">
                                <span class="thread-username">@${username}</span>
                                <span class="thread-time">${date}</span>
                            </div>
                            <p class="thread-preview">${direction} ${lastMsg}</p>
                            <div class="thread-badges">
                                ${botStatus}
                            </div>
                        </div>
                    </div>
                `;
            });

            container.innerHTML = html;
        } catch (err) {
            console.error('Threads Load Error:', err);
            if (!silent) {
                document.getElementById('threads-container').innerHTML = `
                    <div class="error-state">Failed to load threads.</div>
                `;
            }
        }
    },

    selectThread(id) {
        this.selectedConversationId = id;
        this.loadThreads(true); // highlight active in list
        this.loadMessages(id);
    },

    async loadMessages(id, silent = false) {
        try {
            // Get messages
            const messages = await API.request(`/conversations/${id}/messages`);
            
            // Get conversation details to populate header (can search local list for simplicity)
            const threadResult = await API.request('/conversations');
            const thread = (threadResult.data || []).find((t) => t.id === id);
            if (!thread) return;

            const chatPane = document.getElementById('chat-pane-container');
            if (!chatPane) return;

            const username = thread.username || `User ${thread.instagram_user_id.slice(-4)}`;
            const botChecked = thread.is_bot_active ? 'checked' : '';

            // Generate messages container HTML
            let messagesHtml = '';
            messages.forEach(msg => {
                const isOut = msg.direction === 'outbound';
                const bubbleClass = isOut ? 'bubble-outbound' : 'bubble-inbound';
                const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                let structuredContent = '';

                // Handle quick replies render
                if (msg.raw_payload && typeof msg.raw_payload === 'string') {
                    try {
                        const payload = JSON.parse(msg.raw_payload);
                        
                        // If output contains quick replies
                        if (payload.quick_replies) {
                            structuredContent += `<div class="msg-quick-replies">`;
                            payload.quick_replies.forEach((qr) => {
                                structuredContent += `<span class="qr-pill">${qr.title}</span>`;
                            });
                            structuredContent += `</div>`;
                        }

                        // If output contains carousels (Generic Template)
                        if (payload.attachment?.payload?.elements) {
                            structuredContent += `<div class="msg-carousel">`;
                            payload.attachment.payload.elements.forEach((el) => {
                                let buttonsHtml = '';
                                if (el.buttons) {
                                    el.buttons.forEach((btn) => {
                                        buttonsHtml += `<span class="carousel-btn">${btn.title}</span>`;
                                    });
                                }
                                structuredContent += `
                                    <div class="carousel-card glass-card">
                                        ${el.image_url ? `<img src="${el.image_url}" class="carousel-card-img" />` : ''}
                                        <div class="carousel-card-body">
                                            <h4 class="carousel-card-title">${el.title}</h4>
                                            ${el.subtitle ? `<p class="carousel-card-desc">${el.subtitle}</p>` : ''}
                                            <div class="carousel-card-buttons">${buttonsHtml}</div>
                                        </div>
                                    </div>
                                `;
                            });
                            structuredContent += `</div>`;
                        }
                    } catch {}
                }

                messagesHtml += `
                    <div class="message-row ${isOut ? 'row-outbound' : 'row-inbound'}">
                        <div class="message-bubble ${bubbleClass}">
                            <p>${msg.text}</p>
                            ${structuredContent}
                            <span class="message-time">${time}</span>
                        </div>
                    </div>
                `;
            });

            // Update chat area
            chatPane.innerHTML = `
                <div class="chat-header">
                    <div class="chat-header-info">
                        <h3>@${username}</h3>
                        <span class="sub-text">Instagram User: ${thread.instagram_user_id}</span>
                    </div>
                    <div class="chat-header-actions">
                        <label class="toggle-switch">
                            <input type="checkbox" id="bot-toggle-input" ${botChecked} onchange="InboxPage.toggleBot('${id}', this.checked)">
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="toggle-label flex-center gap-1">
                            <i data-lucide="bot" style="width:16px;height:16px;"></i>
                            AI Assistant
                        </span>
                    </div>
                </div>

                <div class="chat-messages" id="chat-messages-container">
                    ${messagesHtml}
                </div>

                <div class="chat-input-area">
                    <form id="chat-send-form" onsubmit="InboxPage.sendMessage(event, '${id}')">
                        <textarea id="chat-input-text" placeholder="Type a manual reply... (This will automatically pause the AI Bot for this conversation)"></textarea>
                        <button type="submit" class="btn btn-primary flex-center gap-2">
                            <span>Send</span>
                            <i data-lucide="send" style="width:16px;height:16px;"></i>
                        </button>
                    </form>
                </div>
            `;

            lucide.createIcons({ nodes: [chatPane] });

            // Scroll to bottom
            const msgContainer = document.getElementById('chat-messages-container');
            if (msgContainer && !silent) {
                msgContainer.scrollTop = msgContainer.scrollHeight;
            }

        } catch (err) {
            console.error('Messages Load Error:', err);
            if (!silent) {
                document.getElementById('chat-pane-container').innerHTML = `
                    <div class="error-state">Failed to load chat history.</div>
                `;
            }
        }
    },

    async toggleBot(id, checked) {
        try {
            await API.request(`/conversations/${id}/toggle-bot`, {
                method: 'PUT',
                body: JSON.stringify({ is_bot_active: checked })
            });
            Components.showToast(
                checked ? 'AI Bot enabled for this chat thread.' : 'AI Bot paused. Manual response mode active.',
                checked ? 'success' : 'warning'
            );
            this.loadThreads(true);
        } catch (err) {
            console.error('Toggle Bot Error:', err);
            Components.showToast('Failed to change AI state.', 'error');
            document.getElementById('bot-toggle-input').checked = !checked;
        }
    },

    async sendMessage(e, id) {
        e.preventDefault();
        const input = document.getElementById('chat-input-text');
        const text = input.value.trim();
        if (!text) return;

        input.value = '';
        input.disabled = true;

        try {
            await API.request(`/conversations/${id}/messages`, {
                method: 'POST',
                body: JSON.stringify({ text })
            });

            Components.showToast('Message sent! AI auto-replies paused.', 'success');
            
            // Reload
            await this.loadMessages(id);
            await this.loadThreads(true);
        } catch (err) {
            console.error('Send Message Error:', err);
            Components.showToast('Failed to send message.', 'error');
            input.value = text;
        } finally {
            input.disabled = false;
            input.focus();
        }
    }
};
