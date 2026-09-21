/**
 * Campaigns Page — CRUD campaign management with glassmorphic cards.
 */
const CampaignsPage = {
    campaigns: [],
    pendingImport: null,

    async render() {
        const container = document.getElementById('page-container');
        container.innerHTML = UI.loader('Loading campaigns…');

        try {
            this.campaigns = await API.getCampaigns();
        } catch (err) {
            UI.renderError(
                container,
                { title: 'Could not load campaigns', message: err.message },
                () => this.render()
            );
            return;
        }

        const campaigns = this.campaigns;

        container.innerHTML = esc(html`
            <div class="page-toolbar">
                <p class="page-toolbar-count">${campaigns.length} campaign${campaigns.length !== 1 ? 's' : ''}</p>
                <div style="display:flex;gap:12px;">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="campaigns:triggerCSVSelect">
                        <i data-lucide="upload" aria-hidden="true"></i> Bulk Import CSV
                    </button>
                    <button type="button" class="btn btn-primary btn-sm" data-action="campaigns:showCreateModal">
                        <i data-lucide="plus" aria-hidden="true"></i> New Campaign
                    </button>
                </div>
            </div>
            <label class="sr-only" for="csv-file-input">Campaign CSV file</label>
            <input type="file" id="csv-file-input" accept=".csv" style="display:none;" data-change="campaigns:handleCSVSelect">
            <div class="campaigns-grid" id="campaigns-list">
                ${campaigns.length === 0 ? html`
                    <div class="empty-state glass-card" style="grid-column:1/-1;">
                        <i data-lucide="megaphone" aria-hidden="true"></i>
                        <h3>No Campaigns Yet</h3>
                        <p>Create campaigns or bulk import your courses from a CSV file to automate replies.</p>
                        <div style="display:flex;gap:12px;margin-top:16px;justify-content:center;">
                            <button type="button" class="btn btn-secondary btn-sm" data-action="campaigns:triggerCSVSelect">
                                <i data-lucide="upload" aria-hidden="true"></i> Bulk Import CSV
                            </button>
                            <button type="button" class="btn btn-primary btn-sm" data-action="campaigns:showCreateModal">
                                <i data-lucide="plus" aria-hidden="true"></i> Create Campaign
                            </button>
                        </div>
                    </div>
                ` : campaigns.map((c) => this.renderCard(c))}
            </div>
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
        const keywords = String(c.trigger_keyword || '').split(',').map((k) => k.trim()).filter(Boolean);

        return html`
            <div class="campaign-card glass-card" data-id="${c.id}" style="${isActive ? '' : html.raw('opacity:0.65;')}">
                <div class="campaign-card-head">
                    <div class="campaign-keyword-list">
                        ${keywords.map((k) => html`
                            <span class="campaign-keyword-chip" dir="auto">
                                <i data-lucide="hash" style="width:10px;height:10px;" aria-hidden="true"></i>
                                ${k}
                            </span>
                        `)}
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;">
                        <span class="campaign-state" style="color:${isActive ? html.raw('var(--success)') : html.raw('var(--text-muted)')};">
                            ${isActive ? 'Active' : 'Paused'}
                        </span>
                        <label class="toggle-switch" style="transform:scale(0.8);margin:0;">
                            <span class="sr-only">Campaign active</span>
                            <input type="checkbox" ${isActive ? html.raw('checked') : ''}
                                   data-change="campaigns:toggleActive" data-id="${c.id}">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>
                <div class="campaign-template" dir="auto">${c.dm_template}</div>
                ${c.public_reply_template ? html`
                    <div class="campaign-public-reply" dir="auto">💬 Public: "${c.public_reply_template}"</div>
                ` : ''}
                ${c.post_id ? html`
                    <div class="campaign-post-id">
                        <i data-lucide="instagram" style="width:12px;height:12px;" aria-hidden="true"></i> Post ID: ${c.post_id}
                    </div>
                ` : ''}
                <div class="campaign-stats">
                    <div class="campaign-stat"><span class="dot green" aria-hidden="true"></span> ${c.sent_count} sent</div>
                    <div class="campaign-stat"><span class="dot red" aria-hidden="true"></span> ${c.failed_count} failed</div>
                    <div class="campaign-stat" style="color:var(--text-muted);">${c.total_interactions} total</div>
                </div>
                <div class="campaign-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="campaigns:showEditModal" data-id="${c.id}">
                        <i data-lucide="pencil" aria-hidden="true"></i> Edit
                    </button>
                    <button type="button" class="btn btn-danger btn-sm"
                            data-action="campaigns:confirmDelete" data-id="${c.id}" data-keyword="${c.trigger_keyword}">
                        <i data-lucide="trash-2" aria-hidden="true"></i> Delete
                    </button>
                </div>
            </div>
        `;
    },

    showCreateModal() {
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">Create Campaign</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="Close dialog">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <form id="campaign-form" data-submit="campaigns:handleCreate">
                <div class="form-group">
                    <label class="form-label" for="campaign-trigger">Trigger Keyword(s)</label>
                    <input class="form-input arabic-text" id="campaign-trigger" name="trigger_keyword" dir="auto"
                           placeholder="e.g. تم, كورس, كوبون" required>
                    <p class="form-hint" dir="auto">Separate multiple keywords with commas (e.g. "كورس, كوبون"). The bot triggers on any match.</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="campaign-dm">DM Template</label>
                    <textarea class="form-textarea arabic-text" id="campaign-dm" name="dm_template" dir="auto"
                              placeholder="The message sent to the user's DMs..." required></textarea>
                </div>
                <div class="form-group">
                    <label class="form-label" for="campaign-public">Public Reply (optional)</label>
                    <input class="form-input arabic-text" id="campaign-public" name="public_reply_template" dir="auto"
                           placeholder="e.g. تم الإرسال! 📩 | شوف الخاص! 🚀">
                    <p class="form-hint">Separate variations with "|" to rotate replies randomly and bypass spam filters.</p>
                </div>
                ${this.postIdField('')}
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">Cancel</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="plus" aria-hidden="true"></i> Create</button>
                </div>
            </form>
        `);
    },

    postIdField(value) {
        return html`
            <div class="form-group">
                <label class="form-label" for="campaign-post-id">Target Post ID (optional)</label>
                <div style="display:flex; gap:8px;">
                    <input class="form-input" id="campaign-post-id" name="post_id" value="${value}"
                           placeholder="e.g. 17841459652725922" style="flex:1;">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="campaigns:openPostPicker"
                            style="padding:0 12px; height:45px;">
                        <i data-lucide="image" aria-hidden="true"></i> Pick Post
                    </button>
                </div>
                <div id="post-picker-container" class="glass-card post-picker" style="display:none;"></div>
                <p class="form-hint">If specified, this campaign will only trigger on comments under this specific post.</p>
            </div>
        `;
    },

    showEditModal(id) {
        const c = this.campaigns.find((x) => x.id === id);
        if (!c) return;

        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">Edit Campaign</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="Close dialog">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <form id="campaign-form" data-submit="campaigns:handleEdit" data-id="${c.id}">
                <div class="form-group">
                    <label class="form-label" for="campaign-trigger">Trigger Keyword(s)</label>
                    <input class="form-input arabic-text" id="campaign-trigger" name="trigger_keyword" dir="auto"
                           value="${c.trigger_keyword}" placeholder="e.g. تم, كورس" required>
                    <p class="form-hint">Separate multiple keywords with commas.</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="campaign-dm">DM Template</label>
                    <textarea class="form-textarea arabic-text" id="campaign-dm" name="dm_template" dir="auto" required>${c.dm_template}</textarea>
                </div>
                <div class="form-group">
                    <label class="form-label" for="campaign-public">Public Reply (optional)</label>
                    <input class="form-input arabic-text" id="campaign-public" name="public_reply_template" dir="auto"
                           value="${c.public_reply_template || ''}" placeholder="e.g. Reply A | Reply B">
                    <p class="form-hint">Separate variations with "|" to rotate replies randomly.</p>
                </div>
                ${this.postIdField(c.post_id || '')}
                <div class="form-group form-toggle-inline">
                    <label class="toggle-switch" style="margin:0;">
                        <span class="sr-only">Campaign active</span>
                        <input type="checkbox" name="is_active" ${c.is_active !== false ? html.raw('checked') : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                    <span class="toggle-label" style="font-size:13px;color:var(--text-secondary);">Campaign Active</span>
                </div>
                <div class="modal-actions" style="margin-top:24px;">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">Cancel</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="check" aria-hidden="true"></i> Save</button>
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
            UI.toast('Campaign created successfully.');
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
            UI.toast('Campaign updated.');
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
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">Delete Campaign</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="Close dialog">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <p style="color:var(--text-secondary);font-size:14px;line-height:1.6;margin-bottom:8px;">
                Are you sure you want to delete the campaign with keyword
                <strong style="color:var(--accent);" dir="auto">"${keyword}"</strong>?
            </p>
            <p style="color:var(--text-muted);font-size:13px;margin-bottom:24px;">This will also delete all interaction history for this campaign.</p>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-action="ui:closeModal">Cancel</button>
                <button type="button" class="btn btn-danger" data-action="campaigns:handleDelete" data-id="${id}">
                    <i data-lucide="trash-2" aria-hidden="true"></i> Delete
                </button>
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

    // ─── Post picker ─────────────────────────────────────────────────────────
    async openPostPicker(btn) {
        const picker = document.getElementById('post-picker-container');
        if (!picker) return;

        if (picker.style.display === 'block') {
            picker.style.display = 'none';
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px;margin:0;"></div> Loading...';

        try {
            const livePosts = await API.getLivePosts();
            picker.style.display = 'block';

            if (!livePosts || livePosts.length === 0) {
                picker.innerHTML = esc(html`<div class="post-picker-empty">No published posts found.</div>`);
            } else {
                picker.innerHTML = esc(html`
                    ${livePosts.map((p) => {
                        const media = safeUrl(p.media_url);
                        return html`
                            <button type="button" class="post-picker-item" data-action="campaigns:selectPickedPost" data-id="${p.id}">
                                ${media
                                    ? html`<img src="${media}" alt="Thumbnail of post ${p.id}">`
                                    : html`<span class="post-picker-placeholder"><i data-lucide="${p.platform === 'facebook' ? 'facebook' : 'instagram'}" aria-hidden="true"></i></span>`}
                                <span class="post-picker-body">
                                    <span class="post-picker-id">ID: ${p.id}</span>
                                    <span class="post-picker-caption" dir="auto">${p.caption || '(No caption)'}</span>
                                </span>
                            </button>
                        `;
                    })}
                `);
                UI.icons(picker);
            }
        } catch (err) {
            picker.style.display = 'block';
            picker.innerHTML = esc(html`<div class="post-picker-error">Failed to load: ${err.message}</div>`);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="image"></i> Pick Post';
            UI.icons(btn);
        }
    },

    selectPickedPost(id) {
        const input = document.getElementById('campaign-post-id');
        if (input) input.value = id;
        const picker = document.getElementById('post-picker-container');
        if (picker) picker.style.display = 'none';
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
                    UI.toast('The CSV file is empty or invalid.', 'error');
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
                    UI.toast('No valid courses found in CSV.', 'error');
                    return;
                }

                this.showBulkImportModal(uniqueCourses);
            } catch (err) {
                UI.toast(`Error parsing CSV: ${err.message}`, 'error');
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

    COURSE_MAPPINGS: {
        'agentic ai': {
            triggerKeywords: 'ذكاء, ذكاء اصطناعي, ايجنت, اجنت, ايجنتك, عميل ذكي, agentic, ai, agent, agents, agentic ai',
            dmTemplate: `أهلاً بك {username}! 👋\nسعيد جداً باهتمامك بدورة "Agentic AI: الدليل العملي لبناء ما تحتاجه بالذكاء الاصطناعي". 🤖🚀\n\nهذا هو رابط التسجيل المجاني المباشر الخاص بك (الكوبون مفعّل تلقائياً):\n🔗 {url}\n\n💡 الكوبون صالح لفترة محدودة ولـ 100 مقعد فقط. سارع بالتسجيل واستمتع بالرحلة التعليمية!\nإذا كان لديك أي استفسار، أنا هنا دائماً لمساعدتك. بالتوفيق! ✨`,
            publicReplies: 'تم إرسال رابط الدورة والتفاصيل إلى الخاص بك يا {username}! تفقد رسائلك 📩🤖 | أهلاً بك {username}! شيك الخاص أرسلت لك كوبون التسجيل المجاني 🚀✨ | تم الإرسال على الخاص بنجاح! بالتوفيق في رحلتك التعليمية 🎓🌟',
        },
        golang: {
            triggerKeywords: 'جو, جولانج, كورس جو, لغة جو, go, golang, go lang, golang course',
            dmTemplate: `أهلاً بك {username}! 👋\nسعيد باهتمامك بتعلم لغة Go القوية مع دورة "GoLang Course: Learn Go in Arabic". 🐹🚀\n\nإليك رابط التسجيل المجاني المباشر الخاص بك (الكوبون مفعّل):\n🔗 {url}\n\n💡 الكوبون مخصص لـ 100 طالب وصالح لفترة محدودة. سجل الآن لتبدأ في بناء تطبيقات عالية الأداء!\nأراك داخل الدورة! 🎓✨`,
            publicReplies: 'شيك الخاص يا {username}! أرسلت لك رابط الدورة المجاني 🐹📩 | تم إرسال كوبون لغة Go إلى الخاص بك بنجاح! بالتوفيق 🚀 | أهلاً {username}، تفقد صندوق الوارد للبدء فوراً! 🎓💡',
        },
        swift: {
            triggerKeywords: 'سويفت, ايفون, برمجة ايفون, تطبيقات ايفون, swift, swift programming, ios, swift arabic',
            dmTemplate: `أهلاً بك {username}! 👋\nخطوة رائعة لدخول عالم برمجة تطبيقات الآيفون والآيباد! 📱✨\nإليك رابط التسجيل المجاني المباشر في دورة "Swift Programming Language | in Arabic":\n🔗 {url}\n\n💡 الكوبون متاح لأول 100 مقعد فقط. لا تفوت الفرصة وابدأ الآن!\nبالتوفيق لك في مسيرتك البرمجية! 🚀`,
            publicReplies: 'أهلاً بك {username}! تم إرسال رابط كورس سويفت على الخاص 📩📱 | شيك الخاص يا {username} لتجد كوبون الدورة المجاني! 🚀✨ | تم الإرسال بنجاح! بالتوفيق في برمجة تطبيقات iOS 🍏💡',
        },
        css3: {
            triggerKeywords: 'سي اس اس, css, css3, تصميم, تنسيق, ستايل, ويب, web design',
            dmTemplate: `أهلاً بك {username}! 👋\nهل أنت جاهز لتصميم مواقع ويب احترافية وجذابة؟ 🎨💻\nإليك رابط التسجيل المجاني المباشر في دورة "CSS3 For Beginners [In Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لفترة محدودة ومحدود بـ 100 عملية تسجيل.\nبالتوفيق وسأكون سعيداً برؤية تصميماتك! 🚀✨`,
            publicReplies: 'تم إرسال كوبون كورس CSS3 إلى الخاص بك يا {username}! 🎨📩 | تفقد الخاص {username} لتجد رابط التسجيل المجاني! 💻✨ | أهلاً بك! تم الإرسال بنجاح، بالتوفيق في مسيرتك في تصميم الويب 🚀🌟',
        },
        html5: {
            triggerKeywords: 'اتش تي ام ال, html, html5, بناء موقع, ويب للمبتدئين, html beginners',
            dmTemplate: `أهلاً بك {username}! 👋\nأول خطوة في تطوير الويب تبدأ من هنا! 🌐💻\nإليك رابط التسجيل المجاني المباشر لدورة "HTML5 For Beginners [In Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لأول 100 طالب مسجل فقط. احجز مقعدك الآن!\nبالتوفيق لك في بدايتك الموفقة! 🚀✨`,
            publicReplies: 'أرسلت لك رابط كورس HTML5 على الخاص يا {username}! 🌐📩 | تفقد رسائلك {username} للتسجيل في الدورة مجاناً! 🚀 | تم إرسال الكوبون بنجاح! بداية موفقة في تطوير الويب 💻✨',
        },
        'problem solving': {
            triggerKeywords: 'حل مسائل, بروبلم, بروبلم سولفينج, سي شارب مسائل, logic, problem solving, c# problem',
            dmTemplate: `أهلاً بك {username}! 👋\nحل المسائل هو السلاح السري لكل مبرمج محترف! 🧠💻\nإليك رابط التسجيل المجاني في دورة "Problem Solving - with C# [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لـ 100 مقعد فقط. سجل الآن وابدأ بتدريب عقلك البرمجي!\nبالتوفيق لك! 🚀✨`,
            publicReplies: 'تم إرسال رابط كورس حل المسائل على الخاص يا {username}! 🧠📩 | تفقد الخاص {username} لتجد الكوبون المجاني! 🚀✨ | تم الإرسال بنجاح! تمنياتي لك بالتوفيق في صقل مهاراتك المنطقية 💻🌟',
        },
        java: {
            triggerKeywords: 'جافا, كورس جافا, java, java for beginners, java course, java arabic',
            dmTemplate: `أهلاً بك {username}! 👋\nتعلم واحدة من أكثر لغات البرمجة طلباً واستخداماً في الشركات! ☕️🚀\nإليك رابط التسجيل المجاني المباشر في دورة "Java for Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون مخصص لـ 100 طالب وصالح لفترة محدودة. سجل الآن لتبني أساساً قوياً!\nبالتوفيق لك! 🎓✨`,
            publicReplies: 'تم إرسال رابط كورس الجافا على الخاص يا {username}! ☕️📩 | شيك الخاص {username} للحصول على الكوبون المجاني 🚀 | تم الإرسال بنجاح! بالتوفيق في مسيرتك البرمجية 💻✨',
        },
        python: {
            triggerKeywords: 'بايثون, بايثون للمبتدئين, python, python arabic, python beginners, python course',
            dmTemplate: `أهلاً بك {username}! 👋\nالبداية الأسهل والأكثر متعة في عالم البرمجة هي لغة بايثون! 🐍🚀\nإليك رابط التسجيل المجاني لدورة "Python For Beginners [in Arabic]":\n🔗 {url}\n\n💡 الكوبون صالح لأول 100 طالب مسجل فقط. احجز مقعدك الآن!\nأتمنى لك رحلة ممتعة وموفقة! ✨`,
            publicReplies: 'شيك الخاص يا {username}! أرسلت لك رابط كورس بايثون المجاني 🐍📩 | تم إرسال الكوبون إلى الخاص بك بنجاح! بالتوفيق 🚀 | أهلاً {username}، تفقد صندوق الوارد للبدء فوراً! 🎓💡',
        },
        'c#': {
            triggerKeywords: 'سي شارب, كورس سي شارب, c#, csharp, c# beginners, csharp course',
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
            <div class="modal-header" style="padding-bottom:12px; border-bottom:1px solid var(--border-glass);">
                <h2 class="modal-title" style="font-size:18px;">Bulk Import Campaigns (${campaignData.length})</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="Close dialog">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <div class="bulk-import-scroll" id="bulk-import-container">
                <p class="bulk-import-intro">
                    We found ${campaignData.length} courses in the CSV. Matched courses have predefined rich
                    triggers and messages. Unmatched courses use generated generic campaigns.
                </p>
                <div style="display:flex; flex-direction:column; gap:16px;">
                    ${campaignData.map((c) => html`
                        <div class="glass-card bulk-import-row" style="border-color:${c.matched ? html.raw('rgba(99, 102, 241, 0.15)') : html.raw('var(--border-glass)')};">
                            <div class="bulk-import-row-head">
                                <div style="display:flex; align-items:flex-start; gap:8px;">
                                    <input type="checkbox" class="import-checkbox" id="import-check-${c.index}"
                                           data-index="${c.index}" checked>
                                    <div>
                                        <label class="bulk-import-name" for="import-check-${c.index}" dir="auto">${c.name}</label>
                                        <div class="bulk-import-coupon">
                                            Coupon: <strong>${c.couponCode}</strong> (${c.redemptions} redemptions)
                                        </div>
                                    </div>
                                </div>
                                ${c.matched
                                    ? html`<span class="bulk-import-tag matched"><i data-lucide="sparkles" style="width:10px;height:10px;" aria-hidden="true"></i> Pre-mapped</span>`
                                    : html`<span class="bulk-import-tag">Generated</span>`}
                            </div>

                            <div class="form-group" style="margin:0;">
                                <label class="form-label bulk-import-label" for="import-trigger-${c.index}">Trigger Keyword(s)</label>
                                <input class="form-input bulk-import-input arabic-text" dir="auto"
                                       id="import-trigger-${c.index}" value="${c.triggerKeywords}">
                            </div>

                            <div class="form-group" style="margin:0;">
                                <label class="form-label bulk-import-label" for="import-dm-${c.index}">DM Template</label>
                                <textarea class="form-textarea bulk-import-textarea arabic-text" dir="auto"
                                          id="import-dm-${c.index}">${c.dmTemplate}</textarea>
                            </div>

                            <div class="form-group" style="margin:0;">
                                <label class="form-label bulk-import-label" for="import-public-${c.index}">Public Reply (separated by |)</label>
                                <input class="form-input bulk-import-input arabic-text" dir="auto"
                                       id="import-public-${c.index}" value="${c.publicReplies}">
                            </div>
                        </div>
                    `)}
                </div>
            </div>
            <div class="modal-actions" style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border-glass);">
                <button type="button" class="btn btn-secondary" data-action="ui:closeModal">Cancel</button>
                <button type="button" class="btn btn-primary" data-action="campaigns:executeBulkImport">
                    <i data-lucide="check" aria-hidden="true"></i> Import Selected
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
                UI.toast(`Trigger and DM Template are required for course: ${original.name}`, 'error');
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
            UI.toast('No courses selected for import.', 'error');
            return;
        }

        UI.showModal(html`
            <div class="import-progress" role="status" aria-live="polite">
                <div class="spinner" style="width:40px; height:40px; border-width:3px; margin:0 auto 16px auto;"></div>
                <h3 class="modal-title">Importing Campaigns</h3>
                <p id="import-progress-status">Saving campaign 1 of ${toImport.length}...</p>
            </div>
        `);

        let successCount = 0;
        let failCount = 0;
        let lastError = '';

        for (let i = 0; i < toImport.length; i++) {
            const statusEl = document.getElementById('import-progress-status');
            if (statusEl) statusEl.textContent = `Saving campaign ${i + 1} of ${toImport.length}...`;

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
            UI.toast(`Successfully imported all ${successCount} campaigns.`);
        } else {
            UI.toast(`Import complete. ${successCount} succeeded, ${failCount} failed. Last error: ${lastError}`, 'error');
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
    openPostPicker: (el) => CampaignsPage.openPostPicker(el),
    selectPickedPost: (el) => CampaignsPage.selectPickedPost(el.dataset.id),
    triggerCSVSelect: () => CampaignsPage.triggerCSVSelect(),
    handleCSVSelect: (el) => CampaignsPage.handleCSVSelect(el),
    executeBulkImport: () => CampaignsPage.executeBulkImport(),
});
