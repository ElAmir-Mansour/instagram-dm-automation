/**
 * Campaigns Page — CRUD campaign management with glassmorphic cards.
 */
const CampaignsPage = {
    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader();

        try {
            const campaigns = await API.getCampaigns();
            container.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
                    <div>
                        <p style="font-size:13px;color:var(--text-secondary);">${campaigns.length} campaign${campaigns.length !== 1 ? 's' : ''}</p>
                    </div>
                    <div style="display:flex;gap:12px;">
                        <button class="btn btn-secondary btn-sm" onclick="CampaignsPage.triggerCSVSelect()">
                            <i data-lucide="upload"></i> Bulk Import CSV
                        </button>
                        <button class="btn btn-primary btn-sm" onclick="CampaignsPage.showCreateModal()">
                            <i data-lucide="plus"></i> New Campaign
                        </button>
                    </div>
                </div>
                <input type="file" id="csv-file-input" accept=".csv" style="display:none;" onchange="CampaignsPage.handleCSVSelect(event)">
                <div class="campaigns-grid" id="campaigns-list">
                    ${campaigns.length === 0 ? `
                        <div class="empty-state glass-card" style="grid-column:1/-1;">
                            <i data-lucide="megaphone"></i>
                            <h3>No Campaigns Yet</h3>
                            <p>Create campaigns or bulk import your courses from a CSV file to automate replies.</p>
                            <div style="display:flex;gap:12px;margin-top:16px;justify-content:center;">
                                <button class="btn btn-secondary btn-sm" onclick="CampaignsPage.triggerCSVSelect()">
                                    <i data-lucide="upload"></i> Bulk Import CSV
                                </button>
                                <button class="btn btn-primary btn-sm" onclick="CampaignsPage.showCreateModal()">
                                    <i data-lucide="plus"></i> Create Campaign
                                </button>
                            </div>
                        </div>
                    ` : campaigns.map(c => `
                        <div class="campaign-card glass-card" data-id="${c.id}" style="${c.is_active !== false ? '' : 'opacity:0.65;'}">
                            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                                <div style="display:flex;flex-wrap:wrap;gap:6px;max-width:70%;">
                                    ${c.trigger_keyword.split(',').map(k => k.trim()).filter(Boolean).map(k => `
                                        <span class="campaign-keyword" style="margin:0;padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:12px;display:inline-flex;align-items:center;gap:4px;">
                                            <i data-lucide="hash" style="width:10px;height:10px;"></i>
                                            ${this.escapeHtml(k)}
                                        </span>
                                    `).join('')}
                                </div>
                                <div style="display:flex;align-items:center;gap:8px;">
                                    <span style="font-size:11px;color:${c.is_active !== false ? 'var(--success)' : 'var(--text-muted)'};">${c.is_active !== false ? 'Active' : 'Paused'}</span>
                                    <label class="toggle-switch" style="transform:scale(0.8);margin:0;">
                                        <input type="checkbox" ${c.is_active !== false ? 'checked' : ''} onchange="CampaignsPage.toggleActive('${c.id}', this.checked)">
                                        <span class="toggle-slider"></span>
                                    </label>
                                </div>
                            </div>
                            <div class="campaign-template">${this.escapeHtml(c.dm_template)}</div>
                            ${c.public_reply_template ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">💬 Public: "${this.escapeHtml(c.public_reply_template)}"</div>` : ''}
                            ${c.post_id ? `<div style="font-size:11px;color:var(--accent);margin-bottom:12px;display:flex;align-items:center;gap:4px;"><i data-lucide="instagram" style="width:12px;height:12px;"></i> Post ID: ${this.escapeHtml(c.post_id)}</div>` : ''}
                            <div class="campaign-stats">
                                <div class="campaign-stat"><span class="dot green"></span> ${c.sent_count} sent</div>
                                <div class="campaign-stat"><span class="dot red"></span> ${c.failed_count} failed</div>
                                <div class="campaign-stat" style="color:var(--text-muted);">${c.total_interactions} total</div>
                            </div>
                            <div class="campaign-actions">
                                <button class="btn btn-secondary btn-sm" onclick="CampaignsPage.showEditModal('${c.id}')">
                                    <i data-lucide="pencil"></i> Edit
                                </button>
                                <button class="btn btn-danger btn-sm" onclick="CampaignsPage.confirmDelete('${c.id}', '${this.escapeHtml(c.trigger_keyword)}')">
                                    <i data-lucide="trash-2"></i> Delete
                                </button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
            lucide.createIcons({ nodes: [container] });
        } catch (err) {
            container.innerHTML = `<div class="empty-state"><i data-lucide="alert-circle"></i><h3>Error</h3><p>${err.message}</p></div>`;
            lucide.createIcons({ nodes: [container] });
        }
    },

    showCreateModal() {
        UI.showModal(`
            <div class="modal-header">
                <h2 class="modal-title">Create Campaign</h2>
                <button class="modal-close" onclick="UI.closeModal()"><i data-lucide="x"></i></button>
            </div>
            <form id="campaign-form" onsubmit="CampaignsPage.handleCreate(event)">
                <div class="form-group">
                    <label class="form-label">Trigger Keyword(s)</label>
                    <input class="form-input" name="trigger_keyword" placeholder="e.g. تم, كورس, كوبون" required>
                    <p class="form-hint">Separate multiple keywords with commas (e.g. "كورس, كوبون"). The bot triggers on any match.</p>
                </div>
                <div class="form-group">
                    <label class="form-label">DM Template</label>
                    <textarea class="form-textarea" name="dm_template" placeholder="The message sent to the user's DMs..." required></textarea>
                </div>
                <div class="form-group">
                    <label class="form-label">Public Reply (optional)</label>
                    <input class="form-input" name="public_reply_template" placeholder="e.g. تم الإرسال! 📩 | شوف الخاص! 🚀">
                    <p class="form-hint">Separate variations with "|" to rotate replies randomly and bypass spam filters.</p>
                </div>
                <div class="form-group">
                    <label class="form-label">Target Post ID (optional)</label>
                    <div style="display:flex; gap:8px;">
                        <input class="form-input" id="campaign-post-id" name="post_id" placeholder="e.g. 17841459652725922" style="flex:1;">
                        <button type="button" class="btn btn-secondary btn-sm" onclick="CampaignsPage.openPostPicker()" style="padding:0 12px; height: 45px;"><i data-lucide="image"></i> Pick Post</button>
                    </div>
                    <div id="post-picker-container" class="glass-card" style="display:none; margin-top:8px; max-height:200px; overflow-y:auto; padding:8px; border-color:var(--border-glass-hover);"></div>
                    <p class="form-hint">If specified, this campaign will only trigger on comments under this specific post.</p>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" onclick="UI.closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="plus"></i> Create</button>
                </div>
            </form>
        `);
    },

    async showEditModal(id) {
        const campaigns = await API.getCampaigns();
        const c = campaigns.find(x => x.id === id);
        if (!c) return;

        UI.showModal(`
            <div class="modal-header">
                <h2 class="modal-title">Edit Campaign</h2>
                <button class="modal-close" onclick="UI.closeModal()"><i data-lucide="x"></i></button>
            </div>
            <form id="campaign-form" onsubmit="CampaignsPage.handleEdit(event, '${id}')">
                <div class="form-group">
                    <label class="form-label">Trigger Keyword(s)</label>
                    <input class="form-input" name="trigger_keyword" value="${this.escapeHtml(c.trigger_keyword)}" placeholder="e.g. تم, كورس" required>
                    <p class="form-hint">Separate multiple keywords with commas.</p>
                </div>
                <div class="form-group">
                    <label class="form-label">DM Template</label>
                    <textarea class="form-textarea" name="dm_template" required>${this.escapeHtml(c.dm_template)}</textarea>
                </div>
                <div class="form-group">
                    <label class="form-label">Public Reply (optional)</label>
                    <input class="form-input" name="public_reply_template" value="${this.escapeHtml(c.public_reply_template || '')}" placeholder="e.g. Reply A | Reply B">
                    <p class="form-hint">Separate variations with "|" to rotate replies randomly.</p>
                </div>
                <div class="form-group">
                    <label class="form-label">Target Post ID (optional)</label>
                    <div style="display:flex; gap:8px;">
                        <input class="form-input" id="campaign-post-id" name="post_id" value="${this.escapeHtml(c.post_id || '')}" placeholder="e.g. 17841459652725922" style="flex:1;">
                        <button type="button" class="btn btn-secondary btn-sm" onclick="CampaignsPage.openPostPicker()" style="padding:0 12px; height: 45px;"><i data-lucide="image"></i> Pick Post</button>
                    </div>
                    <div id="post-picker-container" class="glass-card" style="display:none; margin-top:8px; max-height:200px; overflow-y:auto; padding:8px; border-color:var(--border-glass-hover);"></div>
                </div>
                <div class="form-group" style="display:flex;align-items:center;gap:12px;margin-top:16px;margin-bottom:8px;">
                    <label class="toggle-switch" style="margin:0;">
                        <input type="checkbox" name="is_active" ${c.is_active !== false ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="toggle-label" style="font-size:13px;color:var(--text-secondary);">Campaign Active</span>
                </div>
                <div class="modal-actions" style="margin-top:24px;">
                    <button type="button" class="btn btn-secondary" onclick="UI.closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="check"></i> Save</button>
                </div>
            </form>
        `);
    },

    async handleCreate(e) {
        e.preventDefault();
        const form = new FormData(e.target);
        try {
            await API.createCampaign({
                trigger_keyword: form.get('trigger_keyword'),
                dm_template: form.get('dm_template'),
                public_reply_template: form.get('public_reply_template') || null,
                post_id: form.get('post_id') || null,
            });
            UI.closeModal();
            UI.toast('Campaign created successfully!');
            this.render();
        } catch (err) { UI.toast(err.message, 'error'); }
    },

    async handleEdit(e, id) {
        e.preventDefault();
        const form = new FormData(e.target);
        try {
            await API.updateCampaign(id, {
                trigger_keyword: form.get('trigger_keyword'),
                dm_template: form.get('dm_template'),
                public_reply_template: form.get('public_reply_template') || null,
                post_id: form.get('post_id') || null,
                is_active: form.get('is_active') === 'on',
            });
            UI.closeModal();
            UI.toast('Campaign updated!');
            this.render();
        } catch (err) { UI.toast(err.message, 'error'); }
    },

    async toggleActive(id, isChecked) {
        try {
            await API.updateCampaign(id, { is_active: isChecked });
            UI.toast(isChecked ? 'Campaign activated.' : 'Campaign paused.');
            this.render();
        } catch (err) {
            UI.toast(err.message, 'error');
            this.render();
        }
    },

    confirmDelete(id, keyword) {
        UI.showModal(`
            <div class="modal-header">
                <h2 class="modal-title">Delete Campaign</h2>
                <button class="modal-close" onclick="UI.closeModal()"><i data-lucide="x"></i></button>
            </div>
            <p style="color:var(--text-secondary);font-size:14px;line-height:1.6;margin-bottom:8px;">
                Are you sure you want to delete the campaign with keyword <strong style="color:var(--accent);">"${keyword}"</strong>?
            </p>
            <p style="color:var(--text-muted);font-size:13px;margin-bottom:24px;">This will also delete all interaction history for this campaign.</p>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="UI.closeModal()">Cancel</button>
                <button class="btn btn-danger" onclick="CampaignsPage.handleDelete('${id}')"><i data-lucide="trash-2"></i> Delete</button>
            </div>
        `);
    },

    async handleDelete(id) {
        try {
            await API.deleteCampaign(id);
            UI.closeModal();
            UI.toast('Campaign deleted.');
            this.render();
        } catch (err) { UI.toast(err.message, 'error'); }
    },

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    },

    async openPostPicker() {
        const picker = document.getElementById('post-picker-container');
        const btn = document.querySelector('button[onclick="CampaignsPage.openPostPicker()"]');

        if (picker.style.display === 'block') {
            picker.style.display = 'none';
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px;margin:0;"></div> Loading...';

        try {
            const livePosts = await API.getLivePosts();
            picker.style.display = 'block';

            if (livePosts.length === 0) {
                picker.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:12px;">No published posts found.</div>`;
            } else {
                picker.innerHTML = livePosts.map(p => `
                    <div class="post-picker-item" onclick="CampaignsPage.selectPickedPost('${p.id}')" style="display:flex; gap:8px; padding:6px; border-radius:6px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.03); transition:background 0.2s;">
                        ${p.media_url ? `<img src="${p.media_url}" style="width:40px; height:40px; object-fit:cover; border-radius:4px; flex-shrink:0;">` : `<div style="width:40px;height:40px;border-radius:4px;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i data-lucide="${p.platform === 'facebook' ? 'facebook' : 'instagram'}" style="width:16px;height:16px;"></i></div>`}
                        <div style="overflow:hidden;">
                            <div style="font-size:11px; color:var(--accent); font-weight:600;">ID: ${p.id}</div>
                            <div style="font-size:11px; color:var(--text-secondary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${this.escapeHtml(p.caption || '(No caption)')}</div>
                        </div>
                    </div>
                `).join('');
                
                const items = picker.querySelectorAll('.post-picker-item');
                items.forEach(el => {
                    el.addEventListener('mouseenter', () => el.style.background = 'var(--bg-glass-hover)');
                    el.addEventListener('mouseleave', () => el.style.background = 'transparent');
                });
                lucide.createIcons({ nodes: [picker] });
            }
        } catch (err) {
            picker.style.display = 'block';
            picker.innerHTML = `<div style="font-size:12px; color:var(--danger); text-align:center; padding:12px;">Failed to load: ${err.message}</div>`;
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="image"></i> Pick Post';
            lucide.createIcons({ nodes: [btn] });
        }
    },

    selectPickedPost(id) {
        document.getElementById('campaign-post-id').value = id;
        document.getElementById('post-picker-container').style.display = 'none';
    },

    triggerCSVSelect() {
        document.getElementById('csv-file-input').click();
    },

    async handleCSVSelect(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const text = event.target.result;
                const rows = this.parseCSV(text);
                if (rows.length <= 1) {
                    UI.toast('The CSV file is empty or invalid.', 'error');
                    return;
                }

                const courseMap = {};
                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i];
                    if (row.length < 10) continue;
                    const courseId = row[0].trim();
                    if (!courseId) continue;
                    
                    const name = row[1]?.trim() || '';
                    const couponType = row[2]?.trim() || '';
                    const redemptions = parseInt(row[3]) || 0;
                    const code = row[4]?.trim() || '';
                    const startDate = row[5]?.trim() || '';
                    const endDate = row[6]?.trim() || '';
                    const url = row[9]?.trim() || '';
                    
                    if (!courseMap[courseId] || redemptions > courseMap[courseId].redemptions) {
                        courseMap[courseId] = {
                            id: courseId,
                            name,
                            couponType,
                            redemptions,
                            code,
                            startDate,
                            endDate,
                            url
                        };
                    }
                }

                const uniqueCourses = Object.values(courseMap);
                if (uniqueCourses.length === 0) {
                    UI.toast('No valid courses found in CSV.', 'error');
                    return;
                }

                this.showBulkImportModal(uniqueCourses);
            } catch (err) {
                UI.toast(`Error parsing CSV: ${err.message}`, 'error');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    },

    parseCSV(text) {
        const lines = [];
        let row = [""];
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            const next = text[i+1];
            if (c === '"') {
                if (inQuotes && next === '"') {
                    row[row.length - 1] += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (c === ',' && !inQuotes) {
                row.push("");
            } else if ((c === '\r' || c === '\n') && !inQuotes) {
                if (c === '\r' && next === '\n') i++;
                lines.push(row);
                row = [""];
            } else {
                row[row.length - 1] += c;
            }
        }
        if (row.length > 1 || row[0] !== "") {
            lines.push(row);
        }
        return lines;
    },

    showBulkImportModal(courses) {
        const COURSE_MAPPINGS = {
            "agentic ai": {
                triggerKeywords: "ذكاء, ذكاء اصطناعي, ايجنت, اجنت, ايجنتك, عميل ذكي, agentic, ai, agent, agents, agentic ai",
                dmTemplate: `أهلاً بك {username}! 👋\nسعيد جداً باهتمامك بدورة "Agentic AI: الدليل العملي لبناء ما تحتاجه بالذكاء الاصطناعي". 🤖🚀\n\nهذا هو رابط التسجيل المجاني المباشر الخاص بك (الكوبون مفعّل تلقائياً):\n🔗 {url}\n\n💡 الكوبون صالح لفترة محدودة ولـ 100 مقعد فقط. سارع بالتسجيل واستمتع بالرحلة التعليمية!\nإذا كان لديك أي استفسار، أنا هنا دائماً لمساعدتك. بالتوفيق! ✨`,
                publicReplies: "تم إرسال رابط الدورة والتفاصيل إلى الخاص بك يا {username}! تفقد رسائلك 📩🤖 | أهلاً بك {username}! شيك الخاص أرسلت لك كوبون التسجيل المجاني 🚀✨ | تم الإرسال على الخاص بنجاح! بالتوفيق في رحلتك التعليمية 🎓🌟"
            },
            "golang": {
                triggerKeywords: "جو, جولانج, كورس جو, لغة جو, go, golang, go lang, golang course",
                dmTemplate: `أهلاً بك {username}! 👋\nسعيد باهتمامك بتعلم لغة Go القوية مع دورة "GoLang Course: Learn Go in Arabic". 🐹🚀\n\nإليك رابط التسجيل المجاني المباشر الخاص بك (الكوبون مفعّل):\n🔗 {url}\n\n💡 الكوبون مخصص لـ 100 طالب وصالح لفترة محدودة. سجل الآن لتبدأ في بناء تطبيقات عالية الأداء!\nأراك داخل الدورة! 🎓✨`,
                publicReplies: "شيك الخاص يا {username}! أرسلت لك رابط الدورة المجاني 🐹📩 | تم إرسال كوبون لغة Go إلى الخاص بك بنجاح! بالتوفيق 🚀 | أهلاً {username}، تفقد صندوق الوارد للبدء فوراً! 🎓💡"
            },
            "swift": {
                triggerKeywords: "سويفت, ايفون, برمجة ايفون, تطبيقات ايفون, swift, swift programming, ios, swift arabic",
                dmTemplate: `أهلاً بك {username}! 👋\nخطوة رائعة لدخول عالم برمجة تطبيقات الآيفون والآيباد! 📱✨\nإليك رابط التسجيل المجاني المباشر في دورة "Swift Programming Language | in Arabic":\n🔗 {url}\n\n💡 الكوبون متاح لأول 100 مقعد فقط. لا تفوت الفرصة وابدأ الآن!\nبالتوفيق لك في مسيرتك البرمجية! 🚀`,
                publicReplies: "أهلاً بك {username}! تم إرسال رابط كورس سويفت على الخاص 📩📱 | شيك الخاص يا {username} لتجد كوبون الدورة المجاني! 🚀✨ | تم الإرسال بنجاح! بالتوفيق في برمجة تطبيقات iOS 🍏💡"
            },
            "css3": {
                triggerKeywords: "سي اس اس, css, css3, تصميم, تنسيق, ستايل, ويب, web design",
                dmTemplate: `أهلاً بك {username}! 👋\nهل أنت جاهز لتصميم مواقع ويب احترافية وجذابة؟ 🎨💻\nإليك رابط التسجيل المجاني المباشر في دورة "CSS3 For Beginners [In Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لفترة محدودة ومحدود بـ 100 عملية تسجيل.\nبالتوفيق وسأكون سعيداً برؤية تصميماتك! 🚀✨`,
                publicReplies: "تم إرسال كوبون كورس CSS3 إلى الخاص بك يا {username}! 🎨📩 | تفقد الخاص {username} لتجد رابط التسجيل المجاني! 💻✨ | أهلاً بك! تم الإرسال بنجاح، بالتوفيق في مسيرتك في تصميم الويب 🚀🌟"
            },
            "html5": {
                triggerKeywords: "اتش تي ام ال, html, html5, بناء موقع, ويب للمبتدئين, html beginners",
                dmTemplate: `أهلاً بك {username}! 👋\nأول خطوة في تطوير الويب تبدأ من هنا! 🌐💻\nإليك رابط التسجيل المجاني المباشر لدورة "HTML5 For Beginners [In Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لأول 100 طالب مسجل فقط. احجز مقعدك الآن!\nبالتوفيق لك في بدايتك الموفقة! 🚀✨`,
                publicReplies: "أرسلت لك رابط كورس HTML5 على الخاص يا {username}! 🌐📩 | تفقد رسائلك {username} للتسجيل في الدورة مجاناً! 🚀 | تم إرسال الكوبون بنجاح! بداية موفقة في تطوير الويب 💻✨"
            },
            "problem solving": {
                triggerKeywords: "حل مسائل, بروبلم, بروبلم سولفينج, سي شارب مسائل, logic, problem solving, c# problem",
                dmTemplate: `أهلاً بك {username}! 👋\nحل المسائل هو السلاح السري لكل مبرمج محترف! 🧠💻\nإليك رابط التسجيل المجاني في دورة "Problem Solving - with C# [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لـ 100 مقعد فقط. سجل الآن وابدأ بتدريب عقلك البرمجي!\nبالتوفيق لك! 🚀✨`,
                publicReplies: "تم إرسال رابط كورس حل المسائل على الخاص يا {username}! 🧠📩 | تفقد الخاص {username} لتجد الكوبون المجاني! 🚀✨ | تم الإرسال بنجاح! تمنياتي لك بالتوفيق في صقل مهاراتك المنطقية 💻🌟"
            },
            "java": {
                triggerKeywords: "جافا, كورس جافا, java, java for beginners, java course, java arabic",
                dmTemplate: `أهلاً بك {username}! 👋\nتعلم واحدة من أكثر لغات البرمجة طلباً واستخداماً في الشركات! ☕️🚀\nإليك رابط التسجيل المجاني المباشر في دورة "Java for Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون مخصص لـ 100 طالب وصالح لفترة محدودة. سجل الآن لتبني أساساً قوياً!\nبالتوفيق لك! 🎓✨`,
                publicReplies: "تم إرسال رابط كورس الجافا على الخاص يا {username}! ☕️📩 | شيك الخاص {username} للحصول على الكوبون المجاني 🚀 | تم الإرسال بنجاح! بالتوفيق في مسيرتك البرمجية 💻✨"
            },
            "python": {
                triggerKeywords: "بايثون, بايثون للمبتدئين, python, python arabic, python beginners, python course",
                dmTemplate: `أهلاً بك {username}! 👋\nالبداية الأسهل والأكثر متعة في عالم البرمجة هي لغة بايثون! 🐍🚀\nإليك رابط التسجيل المجاني لدورة "Python For Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لأول 100 طالب مسجل فقط. احجز مقعدك الآن!\nأتمنى لك رحلة ممتعة وموفقة! ✨`,
                publicReplies: "شيك الخاص يا {username}! أرسلت لك رابط كورس بايثون المجاني 🐍📩 | تم إرسال الكوبون إلى الخاص بك بنجاح! بالتوفيق 🚀 | أهلاً {username}، تفقد صندوق الوارد للبدء فوراً! 🎓💡"
            },
            "c#": {
                triggerKeywords: "سي شارب, كورس سي شارب, c#, csharp, c# beginners, csharp course",
                dmTemplate: `أهلاً بك {username}! 👋\nتعلم لغة C# القوية لبناء تطبيقات سطح المكتب، الألعاب، والمواقع! 🎮💻\nإليك رابط التسجيل المجاني المباشر لدورة "C# For Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لـ 100 مقعد فقط ولفترة محدودة. احرص على التسجيل الآن!\nبالتوفيق وسأكون سعيداً بمتابعة تقدمك! 🚀✨`,
                publicReplies: "تم إرسال رابط كورس سي شارب على الخاص يا {username}! 💻📩 | تفقد رسائل الخاص {username} لتجد الكوبون المجاني 🚀 | تم الإرسال بنجاح! بالتوفيق في مسيرتك البرمجية 🎓🌟"
            }
        };

        const campaignData = courses.map((course, index) => {
            const nameLower = course.name.toLowerCase();
            let mapping = null;
            for (const key in COURSE_MAPPINGS) {
                if (nameLower.includes(key)) {
                    mapping = COURSE_MAPPINGS[key];
                    break;
                }
            }

            let triggerKeywords = "";
            let dmTemplate = "";
            let publicReplies = "";
            let matched = false;

            if (mapping) {
                triggerKeywords = mapping.triggerKeywords;
                dmTemplate = mapping.dmTemplate.replace(/{url}/g, course.url);
                publicReplies = mapping.publicReplies;
                matched = true;
            } else {
                const cleanName = course.name.split('[')[0].split('|')[0].split('-')[0].trim();
                triggerKeywords = `${cleanName.split(' ')[0].toLowerCase()}, كورس, كوبون, رابط`;
                dmTemplate = `أهلاً بك {username}! 👋\nإليك رابط التسجيل المجاني لكورس "${cleanName}":\n🔗 ${course.url}\n\nسجل الآن قبل نفاد الكوبون! ✨`;
                publicReplies = `تم إرسال الرابط والتفاصيل على الخاص يا {username}! 📩 | تفقد الخاص {username} للحصول على كوبون الدورة! 🚀`;
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
                matched
            };
        });

        UI.showModal(`
            <div class="modal-header" style="padding-bottom:12px; border-bottom:1px solid var(--border-glass);">
                <h2 class="modal-title" style="font-size:18px;">Bulk Import Campaigns (${campaignData.length})</h2>
                <button class="modal-close" onclick="UI.closeModal()"><i data-lucide="x"></i></button>
            </div>
            <div style="max-height: 55vh; overflow-y: auto; padding: 16px 2px;" id="bulk-import-container">
                <p style="color:var(--text-secondary); font-size:13px; margin-bottom:16px; padding:0 4px; text-align:left;">
                    We found ${campaignData.length} courses in the CSV. Matched courses have predefined rich triggers and messages. Unmatched courses use generated generic campaigns.
                </p>
                <div style="display:flex; flex-direction:column; gap:16px;">
                    ${campaignData.map(c => `
                        <div class="glass-card" style="padding:16px; display:flex; flex-direction:column; gap:12px; background:rgba(255,255,255,0.015); border-color:${c.matched ? 'rgba(99, 102, 241, 0.15)' : 'var(--border-glass)'};">
                            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
                                <div style="display:flex; align-items:center; gap:8px;">
                                    <input type="checkbox" class="import-checkbox" data-index="${c.index}" checked style="width:16px; height:16px; accent-color:var(--accent); cursor:pointer;">
                                    <div style="text-align:left;">
                                        <h4 style="font-size:14px; font-weight:600; color:var(--text-primary);">${this.escapeHtml(c.name)}</h4>
                                        <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
                                            Coupon: <strong style="color:var(--success);">${c.couponCode}</strong> (${c.redemptions} redemptions)
                                        </div>
                                    </div>
                                </div>
                                ${c.matched ? `
                                    <span style="font-size:11px; padding:2px 8px; border-radius:12px; background:rgba(99, 102, 241, 0.1); color:var(--accent); border:1px solid rgba(99, 102, 241, 0.2); display:inline-flex; align-items:center; gap:4px; flex-shrink:0;">
                                        <i data-lucide="sparkles" style="width:10px; height:10px;"></i> Pre-mapped
                                    </span>
                                ` : `
                                    <span style="font-size:11px; padding:2px 8px; border-radius:12px; background:rgba(255, 255, 255, 0.05); color:var(--text-secondary); border:1px solid rgba(255, 255, 255, 0.1); flex-shrink:0;">
                                        Generated
                                    </span>
                                `}
                            </div>
                            
                            <div class="form-group" style="margin:0; text-align:left;">
                                <label class="form-label" style="font-size:11px; margin-bottom:4px; text-align:left; display:block;">Trigger Keyword(s)</label>
                                <input class="form-input" style="height:34px; font-size:12px; padding:6px 10px;" id="import-trigger-${c.index}" value="${this.escapeHtml(c.triggerKeywords)}">
                            </div>

                            <div class="form-group" style="margin:0; text-align:left;">
                                <label class="form-label" style="font-size:11px; margin-bottom:4px; text-align:left; display:block;">DM Template</label>
                                <textarea class="form-textarea" style="font-size:12px; padding:8px 10px; height:80px; min-height:80px; resize:vertical; line-height:1.4;" id="import-dm-${c.index}">${this.escapeHtml(c.dmTemplate)}</textarea>
                            </div>

                            <div class="form-group" style="margin:0; text-align:left;">
                                <label class="form-label" style="font-size:11px; margin-bottom:4px; text-align:left; display:block;">Public Reply (separated by |)</label>
                                <input class="form-input" style="height:34px; font-size:12px; padding:6px 10px;" id="import-public-${c.index}" value="${this.escapeHtml(c.publicReplies)}">
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="modal-actions" style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border-glass);">
                <button class="btn btn-secondary" onclick="UI.closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="CampaignsPage.executeBulkImport(${JSON.stringify(campaignData).replace(/"/g, '&quot;')})">
                    <i data-lucide="check"></i> Import Selected
                </button>
            </div>
        `);
        lucide.createIcons({ nodes: document.getElementById('bulk-import-container').parentNode });
    },

    async executeBulkImport(campaignData) {
        const checkboxes = document.querySelectorAll('.import-checkbox');
        const toImport = [];

        try {
            checkboxes.forEach(cb => {
                if (cb.checked) {
                    const idx = parseInt(cb.getAttribute('data-index'));
                    const original = campaignData.find(c => c.index === idx);
                    if (original) {
                        const trigger_keyword = document.getElementById(`import-trigger-${idx}`).value.trim();
                        const dm_template = document.getElementById(`import-dm-${idx}`).value.trim();
                        const public_reply_template = document.getElementById(`import-public-${idx}`).value.trim();

                        if (!trigger_keyword || !dm_template) {
                            UI.toast(`Trigger and DM Template are required for course: ${original.name}`, 'warning');
                            throw new Error('Validation failed');
                        }

                        toImport.push({
                            trigger_keyword,
                            dm_template,
                            public_reply_template: public_reply_template || null,
                            post_id: null
                        });
                    }
                }
            });
        } catch (e) {
            return;
        }

        if (toImport.length === 0) {
            UI.toast('No courses selected for import.', 'warning');
            return;
        }

        UI.showModal(`
            <div style="text-align:center; padding:32px 16px;">
                <div class="spinner" style="width:40px; height:40px; border-width:3px; margin:0 auto 16px auto;"></div>
                <h3>Importing Campaigns</h3>
                <p style="color:var(--text-secondary); font-size:13px; margin-top:8px;" id="import-progress-status">
                    Saving campaign 1 of ${toImport.length}...
                </p>
            </div>
        `);

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < toImport.length; i++) {
            const statusEl = document.getElementById('import-progress-status');
            if (statusEl) statusEl.textContent = `Saving campaign ${i + 1} of ${toImport.length}...`;
            
            try {
                await API.createCampaign(toImport[i]);
                successCount++;
            } catch (err) {
                console.error('Bulk Import error:', err);
                failCount++;
            }
        }

        UI.closeModal();
        if (failCount === 0) {
            UI.toast(`Successfully imported all ${successCount} campaigns!`);
        } else {
            UI.toast(`Import complete. ${successCount} succeeded, ${failCount} failed.`, 'warning');
        }

        this.render();
    }
};
