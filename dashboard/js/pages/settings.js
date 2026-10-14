/**
 * Settings — access token, webhook verify token, account info, TikTok, media
 * storage, public site, appearance.
 *
 * Every credential shown here is a Latin string sitting inside Arabic prose,
 * which is exactly where bidi goes wrong: an unisolated token preview drags
 * the sentence's punctuation to the wrong end. They all go through UI.ltr().
 */
const SettingsPage = {
    REQUIRED_SCOPES: [
        'pages_manage_engagement',
        'pages_messaging',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'instagram_content_publish',
        // Growth reads insights with these two (src/services/growth/common.ts);
        // without them the Growth screen reports numbers as missing.
        'instagram_manage_insights',
        'read_insights',
    ],

    /** The scopes above that only the Growth screen needs, tagged «للنمو». */
    GROWTH_SCOPES: ['instagram_manage_insights', 'read_insights'],

    /**
     * `t(key, params)` with ONE value isolated as Latin text, and the rest of
     * the sentence left to flow in the page's direction. `UI.ltr()` around the
     * whole translated sentence isolated the Arabic words too, so the sentence's
     * own punctuation landed at the wrong end.
     */
    ltrIn(key, params, name) {
        const MARK = '\u0000';
        const parts = t(key, Object.assign({}, params, { [name]: MARK })).split(MARK);
        if (parts.length !== 2) return t(key, params);
        return html`${parts[0]}${UI.ltr(params[name])}${parts[1]}`;
    },

    /**
     * Guards the write against landing after the operator has navigated away.
     * This page awaits TWO requests in series, so it owns the container for
     * longer than any other — and `#page-container` is refilled, never
     * replaced, so a late write lands on whatever page is there now. Same
     * `_seq`/`live()` shape as OverviewPage.
     */
    _seq: 0,

    destroy() {
        this._seq++;
        // The Page picker may still be open over the next screen; what it repaints on a change must not be this one.
        if (typeof MetaConnect !== 'undefined' && this._afterMeta && MetaConnect.afterChange === this._afterMeta) MetaConnect.afterChange = null;
    },

    skeleton() {
        return html`
            ${Motion.cardGrid(2, 5)}
            ${Motion.busy()}
        `;
    },

    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const focus = UI.captureFocus(container);
        const gate = Motion.beginLoad(container, () => this.skeleton());
        const seq = ++this._seq;
        const live = () => seq === this._seq && !!document.getElementById('page-container');

        // The access token status is the page — if it fails there is nothing to show.
        let tokenStatus;
        try {
            tokenStatus = await API.getTokenStatus();
        } catch (err) {
            if (!live()) return;
            gate.done();
            UI.renderError(container, { title: t('settings.errorTitle'), message: err.message }, () => this.render());
            return;
        }
        if (!live()) return;

        // The webhook verify token is loaded separately: a failure here used to
        // render "Not set" for a token that IS set, inviting the creator to
        // re-enter the one credential this project's docs say has already cost
        // hours of debugging.
        let webhookToken = null;
        let webhookError = null;
        try {
            webhookToken = await API.getWebhookToken();
        } catch (err) {
            webhookError = err;
        }

        // TikTok, loaded the same way and for the same reason: its failure
        // must not take the Meta settings down with it.
        let tiktok = null;
        let tiktokError = null;
        let tiktokApp = null;
        let tiktokAppError = null;
        // Media storage too — platform admins only, and isolated like the rest.
        let media = null;
        let mediaError = null;
        // The public site's contact channels: one set for the deployment, so
        // platform admins only, and isolated for the same reason.
        let site = null;
        let siteError = null;
        // Handoff alerts and echo takeover (DM plan S8): the deployment's too, so platform admins only, and isolated like the rest.
        let notify = null;
        let notifyError = null;
        // YouTube, isolated the same way.
        let youtube = null;
        let youtubeError = null;
        let youtubeApp = null;
        let youtubeAppError = null;
        let cleanup = null;
        // The onboarding settings (invite lifetime, role, sessions, the message): the deployment's, so platform admins only.
        let onboarding = null;
        let onboardingError = null;
        // Instagram & Facebook (P28), isolated the same way, with the module that draws the card (loaded on first use, and shared with the wizard).
        let meta = null;
        let metaError = null;
        let metaApp = null;
        let metaAppError = null;
        // The Instagram ice breakers and persistent menu (DM plan S13): the tenant OWNER's, so nobody else is asked (the server refuses them
        // anyway), and isolated like the rest. Reading them sends nothing to Instagram.
        let iceBreakers = null;
        let iceBreakersError = null;
        const [tt, ttApp, ms, st, yt, ytApp, cu, ob, mc, mcApp, mcModule, nt, ib, ibModule] = await Promise.allSettled([
            API.getTikTokConnection(),
            App.isAdmin() ? API.getTikTokAppSettings() : Promise.resolve(null),
            App.isAdmin() ? API.getMediaStorage() : Promise.resolve(null),
            App.isAdmin() ? API.getSiteSettings() : Promise.resolve(null),
            API.getYouTubeConnection(),
            App.isAdmin() ? API.getYouTubeAppSettings() : Promise.resolve(null),
            App.isAdmin() ? API.getMediaCleanup() : Promise.resolve(null),
            App.isAdmin() ? API.getOnboardingSettings() : Promise.resolve(null),
            API.getMetaConnection(),
            App.isAdmin() ? API.getMetaAppSettings() : Promise.resolve(null),
            App.loadPageModule('meta_connect'),
            App.isAdmin() ? API.getNotifySettings() : Promise.resolve(null),
            App.canAdminister() ? API.getIceBreakers() : Promise.resolve(null),
            App.canAdminister() ? App.loadPageModule('ice_breakers') : Promise.resolve(null),
        ]);
        if (ib.status === 'fulfilled') iceBreakers = ib.value; else iceBreakersError = ib.reason;
        // A card whose module could not be fetched is a card that says so, with Retry: never a blank section.
        if (!iceBreakersError && App.canAdminister() && !(ibModule.status === 'fulfilled' && ibModule.value)) iceBreakersError = new Error(t('iceb.moduleFailed'));
        if (mc.status === 'fulfilled') meta = mc.value; else metaError = mc.reason;
        if (mcApp.status === 'fulfilled') metaApp = mcApp.value; else metaAppError = mcApp.reason;
        // A card whose module could not be fetched is a card that says so, with Retry: never a blank section.
        if (!metaError && !(mcModule.status === 'fulfilled' && mcModule.value)) metaError = new Error(t('meta.moduleFailed'));
        // The clean-up block is extra: if it fails to load, the storage card shows without it.
        if (cu.status === 'fulfilled') cleanup = cu.value;
        if (yt.status === 'fulfilled') youtube = yt.value; else youtubeError = yt.reason;
        if (ytApp.status === 'fulfilled') youtubeApp = ytApp.value; else youtubeAppError = ytApp.reason;
        if (tt.status === 'fulfilled') tiktok = tt.value; else tiktokError = tt.reason;
        if (ttApp.status === 'fulfilled') tiktokApp = ttApp.value; else tiktokAppError = ttApp.reason;
        if (ms.status === 'fulfilled') media = ms.value; else mediaError = ms.reason;
        if (st.status === 'fulfilled') site = st.value; else siteError = st.reason;
        if (nt.status === 'fulfilled') notify = nt.value; else notifyError = nt.reason;
        if (ob.status === 'fulfilled') onboarding = ob.value; else onboardingError = ob.reason;

        if (!live()) return;
        gate.done();

        const isValid = tokenStatus.status === 'valid';
        const expiresAt = tokenStatus.expiresAt ? new Date(tokenStatus.expiresAt) : null;
        const daysLeft = expiresAt ? Math.ceil((expiresAt - Date.now()) / 86400000) : null;
        // The 90-day data-access window is the date that actually lapses on a
        // never-expiring page token. It was fetched and never shown.
        const dataAccessAt = tokenStatus.dataAccessExpiresAt ? new Date(tokenStatus.dataAccessExpiresAt) : null;
        const dataAccessDays = dataAccessAt && !Number.isNaN(dataAccessAt.getTime())
            ? Math.ceil((dataAccessAt - Date.now()) / 86400000) : null;
        // The token, extend and verify-token routes are owner-only on the server
        // (`canAdminister`); an operator who could see the forms only learned that
        // from a 403 after pasting a 200-character token.
        const canAdmin = App.canAdminister();
        const tokenReason = !isValid ? (tokenStatus.error || tokenStatus.message || '') : '';

        const missingScopes = isValid && Array.isArray(tokenStatus.scopes)
            ? this.REQUIRED_SCOPES.filter((scope) => !tokenStatus.scopes.includes(scope))
            : [];
        const webhookUrl = (webhookToken && webhookToken.webhookUrl) || `${location.origin}/webhook`;

        // When the fetch failed we do not know whether the token is set in the
        // environment, and the sentence that says so was being rendered with a
        // bare "." interpolated where the answer should be. There is no copy
        // for "unknown", so the sentence is simply not claimed.

        container.innerHTML = esc(html`
            ${missingScopes.length > 0 ? html`
                <div class="warning-card" role="alert">
                    <div class="row row--start gap-4">
                        <span class="stat-icon warning shrink-0"><i data-lucide="alert-triangle" aria-hidden="true"></i></span>
                        <div>
                            <h3 class="warning-card-title">${t('settings.missingScopesTitle')}</h3>
                            <p class="mbe-3">${t('settings.missingScopesBody')}</p>
                            <ul class="warning-card-list">
                                ${missingScopes.map((s) => html`<li>${this.ltrIn('settings.scopeRequired', {
                                    name: s, desc: t(`settings.scope.${s}`),
                                }, 'name')}${this.GROWTH_SCOPES.includes(s) ? html` <span class="badge badge-info">${t('settings.scopeForGrowth')}</span>` : ''}</li>`)}
                            </ul>
                        </div>
                    </div>
                </div>
            ` : ''}

            <section class="section">
                <h2 class="section-title">${t('settings.accessToken')}</h2>
                <div class="settings-card surface">
                    <div class="token-status">
                        <span class="health-pill ${isValid ? html.raw('health-fresh') : html.raw('health-stale')}">
                            <i data-lucide="${isValid ? 'check-circle' : 'alert-triangle'}" aria-hidden="true"></i>
                            ${isValid ? t('settings.valid') : t('settings.invalid')}
                        </span>
                        ${tokenStatus.type ? html`<span class="text-meta">${t('settings.tokenType', { type: tokenStatus.type })}</span>` : ''}
                    </div>
                    ${tokenReason ? html`<div class="mbe-4">${UI.errorStrip(t('settings.tokenProblem'), tokenReason)}</div>` : ''}
                    <p class="form-hint mbe-4">${UI.helpLink('connect-meta#token-health', t('help.link.tokenHealth'), { newTab: true })}</p>

                    ${expiresAt ? html`
                        <div class="row row--wrap gap-3 mbe-4">
                            <p class="token-info">
                                ${t('settings.expires', { date: UI.formatDay(expiresAt) })}
                                ${daysLeft !== null ? html`
                                    <span class="${daysLeft < 7 ? html.raw('text-warning') : ''}">
                                        ${daysLeft > 0
                                            ? t('settings.daysLeft', { count: daysLeft })
                                            : t('settings.expired')}
                                    </span>
                                ` : ''}
                            </p>
                            ${canAdmin ? UI.button({
                                variant: 'secondary', size: 'sm', icon: 'refresh-cw',
                                label: t('settings.extend'),
                                action: 'settings:extendToken', id: 'settings-extend',
                            }) : ''}
                        </div>
                    ` : html`
                        <p class="token-info mbe-4">${t('settings.expiresNever')}</p>
                    `}
                    ${dataAccessAt && dataAccessDays !== null ? html`
                        <p class="token-info mbe-4">
                            ${t('settings.dataAccessExpires', { date: UI.formatDay(dataAccessAt) })}
                            <span class="${dataAccessDays < 14 ? html.raw('text-warning') : ''}">
                                ${dataAccessDays > 0 ? t('settings.daysLeft', { count: dataAccessDays }) : t('settings.expired')}
                            </span>
                            <span class="form-hint">${t('settings.dataAccessHint')}</span>
                        </p>
                    ` : ''}

                    ${tokenStatus.scopes ? html`
                        <div class="mbe-4">
                            <p class="form-label">${t('settings.permissions')}</p>
                            <div class="scope-list">
                                ${tokenStatus.scopes.map((s) => html`<span class="chip">${UI.ltr(s)}</span>`)}
                            </div>
                        </div>
                    ` : ''}

                    ${canAdmin ? html`
                    <div class="settings-block">
                        <label class="form-label" for="settings-token-input">${t('settings.updateToken')}</label>
                        <p class="form-hint mbe-3">${t('settings.updateTokenHint')}</p>
                        <form id="token-form" data-submit="settings:handleTokenUpdate">
                            <!-- autocomplete/spellcheck off, matching the webhook
                                 field below and the confirm dialog's echo input.
                                 This one carried a live, never-expiring Meta Page
                                 Access Token in a plain spellchecked textarea:
                                 browsers with enhanced spell check send field
                                 contents to a remote service, and autofill will
                                 happily remember and re-offer a 200-character
                                 credential. The value is the one thing on this
                                 screen that must not leave the page by any route
                                 but the submit. -->
                            <textarea class="field-textarea field-mono" id="settings-token-input" name="token" dir="ltr"
                                      autocomplete="off" spellcheck="false" autocapitalize="off"
                                      placeholder="${t('settings.tokenPlaceholder')}" required></textarea>
                            <div class="form-actions">
                                ${UI.button({
                                    variant: 'primary', size: 'sm', type: 'submit', icon: 'key',
                                    label: t('settings.validateSave'), id: 'settings-token-submit',
                                })}
                            </div>
                        </form>
                    </div>
                    ` : html`<p class="form-hint">${t('settings.ownerOnlyMeta')}</p>`}
                </div>
            </section>

            <section class="section">
                <h2 class="section-title">${t('settings.webhookTitle')}</h2>
                <div class="settings-card surface">
                    ${webhookError ? html`
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div>
                                <strong dir="auto">${t('settings.webhookUnknown', { message: webhookError.message })}</strong>
                                <span class="inline-error-hint">${t('settings.webhookUnknownHint')}</span>
                            </div>
                        </div>
                        ${UI.button({
                            variant: 'secondary', size: 'sm', className: 'mbe-4',
                            icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render',
                        })}
                    ` : html`
                        <div class="token-status">
                            <span class="status-pill ${webhookToken.configuredInDatabase ? html.raw('sent') : html.raw('failed')}">
                                ${webhookToken.configuredInDatabase ? t('settings.webhookConfigured') : t('settings.webhookNotSet')}
                            </span>
                            ${webhookToken.configuredInDatabase ? html`
                                <span class="text-meta">${this.ltrIn('settings.webhookPreview', {
                                    preview: webhookToken.preview, count: Number(webhookToken.length) || 0,
                                }, 'preview')}</span>
                            ` : ''}
                        </div>
                    `}

                    <!-- The address Meta calls, beside the token Meta checks it
                         with: the two values pasted into the same Meta form. It
                         used to sit three sections down, under TikTok. -->
                    <div class="settings-copy-row mbe-4">
                        <span class="form-label">${t('settings.webhookUrl')}</span>
                        <code dir="ltr">${UI.ltr(webhookUrl)}</code>
                        ${UI.button({
                            variant: 'ghost', size: 'sm', icon: 'copy',
                            ariaLabel: t('setup.copyUrl'), title: t('setup.copyUrl'),
                            action: 'app:copyValue', data: { copy: webhookUrl },
                        })}
                    </div>

                    ${canAdmin && webhookToken && webhookToken.configuredInDatabase ? html`
                        <div class="row row--wrap gap-3 mbe-2">
                            ${UI.button({
                                variant: 'secondary', size: 'sm', icon: 'plug-zap',
                                label: t('settings.webhookTest'),
                                action: 'settings:testWebhook', id: 'settings-webhook-test',
                            })}
                            <span class="form-hint">${t('settings.webhookTestHint')}</span>
                        </div>
                        <div id="settings-webhook-test-result" class="mbe-4" aria-live="polite"></div>
                    ` : ''}

                    <p class="form-hint">${t('settings.webhookBody')} ${UI.helpLink('connect-meta#where', t('help.link.connectMetaWhere'), { newTab: true })}</p>
                    <p class="form-hint mbe-4">${t('settings.webhookBody2')}</p>

                    ${canAdmin ? html`
                    <form id="webhook-token-form" data-submit="settings:handleWebhookTokenUpdate">
                        <label class="form-label" for="settings-webhook-input">${t('settings.webhookLabel')}</label>
                        <input class="field field-mono" id="settings-webhook-input" name="token" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false"
                               placeholder="${t('settings.webhookPlaceholder')}" required>
                        <div class="form-actions">
                            <!-- Stable id: after a successful save the page
                                 re-renders and this button is destroyed, so it
                                 is what restoreFocus() re-finds. -->
                            ${UI.button({
                                variant: 'primary', size: 'sm', type: 'submit', icon: 'shield-check',
                                label: t('settings.webhookSave'), id: 'settings-webhook-submit',
                            })}
                        </div>
                    </form>
                    ` : html`<p class="form-hint">${t('settings.ownerOnlyMeta')}</p>`}
                </div>
            </section>

            <!-- Right after the webhook: the page ids are what Meta's
                 subscription screens ask about next. The webhook URL moved up
                 into the webhook section, beside its copy button. -->
            <section class="section">
                <h2 class="section-title">${t('settings.accountInfo')}</h2>
                <div class="settings-card surface stack gap-2">
                    <p class="token-info">${t('settings.igPageId')}: <strong>${UI.ltr(tokenStatus.instagramPageId || tokenStatus.pageId || '—')}</strong></p>
                    <p class="token-info">${t('settings.fbPageId')}: <strong>${UI.ltr(tokenStatus.facebookPageId || '—')}</strong></p>
                    <p class="token-info">${t('settings.accountStatus')}:
                        <strong class="${tokenStatus.isActive ? html.raw('text-success') : html.raw('text-danger')}">
                            ${tokenStatus.isActive ? t('settings.statusActive') : t('settings.statusInactive')}
                        </strong>
                    </p>
                </div>
            </section>

            ${this.metaSection({ meta, metaError, metaApp, metaAppError })}

            ${canAdmin ? this.iceBreakersSection(iceBreakers, iceBreakersError) : ''}

            ${this.tiktokSection({ tiktok, tiktokError, tiktokApp, tiktokAppError })}

            ${this.youtubeSection({ youtube, youtubeError, youtubeApp, youtubeAppError })}

            ${App.isAdmin() ? this.mediaStorageSection(media, mediaError, cleanup) : ''}

            ${App.isAdmin() ? this.siteSection(site, siteError) : ''}

            ${App.isAdmin() ? this.notifySection(notify, notifyError) : ''}

            ${App.isAdmin() ? this.onboardingSection(onboarding, onboardingError) : ''}


            <section class="section">
                <h2 class="section-title">${t('settings.appearance')}</h2>
                <div class="settings-card surface">
                    <div class="form-grid">
                        <div class="form-group">
                            <label class="form-label" for="settings-lang">${t('app.language')}</label>
                            <!-- Each option carries its own lang attribute so
                                 العربية is shaped by the Arabic face and "English" set in
                                 Inter, whichever language the interface is in. -->
                            <select class="select" id="settings-lang" data-change="app:setLanguage">
                                ${Object.keys(I18N.LANGS).map((code) => html`
                                    <option value="${code}" lang="${I18N.LANGS[code].htmlLang}"
                                            ${code === I18N.lang ? html.raw('selected') : ''}>${I18N.LANGS[code].label}</option>
                                `)}
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="settings-theme">${t('app.theme')}</label>
                            <select class="select" id="settings-theme" data-change="app:setTheme">
                                ${['auto', 'dark', 'light'].map((value) => html`
                                    <option value="${value}" ${value === App.currentTheme() ? html.raw('selected') : ''}>${t(`app.theme.${value}`)}</option>
                                `)}
                            </select>
                        </div>
                    </div>
                    <p class="form-hint">${t('settings.appearanceHint')}</p>
                </div>
            </section>
        `);

        UI.icons(container);
        UI.restoreFocus(focus);
        Motion.announce(`${t('nav.settings')} — ${t('common.loaded')}`);
        this.announceTikTokReturn();
        this.announceYouTubeReturn();
        this.announceMetaReturn().catch((err) => console.warn('Could not show the Meta return:', err));
    },

    // ─── Instagram ice breakers and persistent menu (DM plan S13) ─────────────

    /**
     * The card's words, editor and buttons are `IceBreakersCard`'s (`ice_breakers.js`, loaded on first use); this hands it the server's answer, or
     * says why there is none. Owner only: the caller does not ask for it otherwise.
     */
    iceBreakersSection(data, error) {
        // The error card is drawn HERE, not by the module: a module that could not be fetched is the very case it is for.
        if (error || !data || typeof IceBreakersCard === 'undefined') {
            const message = (error && error.message) || t('iceb.moduleFailed');
            return html`
                <section class="section" id="iceb-card">
                    <h2 class="section-title">${t('iceb.title')}</h2>
                    <div class="settings-card surface">
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div><strong dir="auto">${t('iceb.loadFailed', { message })}</strong></div>
                        </div>
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
                    </div>
                </section>
            `;
        }
        return IceBreakersCard.section(data);
    },

    // ─── Instagram & Facebook (P28) ──────────────────────────────────────────

    /**
     * The Connections card. The words, the Page picker and the actions are `MetaConnect`'s (`meta_connect.js`, shared with the wizard);
     * this only hands it what it needs and says what to repaint when something changed.
     */
    metaSection({ meta, metaError, metaApp, metaAppError }) {
        if (typeof MetaConnect === 'undefined') return this.metaFallback(metaError || new Error(t('meta.moduleFailed')));
        // After a Page is chosen or Meta is disconnected, this screen is read again. Dropped when the screen is left (`destroy`).
        this._afterMeta = this._afterMeta || (() => SettingsPage.render());
        MetaConnect.afterChange = this._afterMeta;
        return MetaConnect.settingsSection({
            meta, metaError, app: metaApp, appError: metaAppError, canAdminister: App.canAdminister(), isAdmin: App.isAdmin(),
        });
    },

    /** The card when its module could not be fetched: a sentence and Retry, never a blank section. */
    metaFallback(error) {
        return html`
            <section class="section" id="settings-meta">
                <h2 class="section-title">${t('meta.title')}</h2>
                <div class="settings-card surface">
                    <div class="inline-error" role="alert">
                        <i data-lucide="alert-circle" aria-hidden="true"></i>
                        <div><strong dir="auto">${t('meta.loadFailed', { message: (error && error.message) || '' })}</strong></div>
                    </div>
                    ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
                </div>
            </section>
        `;
    },

    /**
     * Back from Facebook's dialog: `#/settings?meta=connected|error|pick`. A pick opens the Page picker over this screen; the others
     * are said once, as a toast. The parameters are dropped from the address either way, so a reload does not say it again.
     */
    async announceMetaReturn() {
        if (typeof MetaConnect === 'undefined') return;
        const ret = MetaConnect.readReturn((name) => App.hashParam(name));
        if (!ret) return;
        try {
            history.replaceState(null, '', `${location.pathname}#/settings`);
        } catch {
            // Only the repeat-on-reload is lost.
        }
        if (ret.outcome === 'pick') {
            await MetaConnect.openPicker(ret.pick, 'settings');
            return;
        }
        MetaConnect.announce(ret);
    },

    /** Reasons Google's callback can send back, each with its own sentence. */
    YOUTUBE_RETURN_REASONS: ['denied', 'state_mismatch', 'state_expired', 'channel_in_use', 'no_channel', 'scope_missing',
        'redirect_mismatch', 'bad_client', 'exchange_failed', 'no_base_url'],

    /** Back from Google's consent screen: `#/settings?youtube=connected|error&reason=…`, said once. */
    announceYouTubeReturn() {
        const outcome = App.hashParam('youtube');
        if (!outcome) return;
        if (outcome === 'connected') {
            UI.toast(t('settings.youtube.connectedToast'), 'success');
        } else {
            const reason = App.hashParam('reason');
            const known = this.YOUTUBE_RETURN_REASONS.includes(reason);
            UI.toast(known ? t(`settings.youtube.return.${reason}`) : t('settings.youtube.return.generic'), 'error');
        }
        try {
            history.replaceState(null, '', `${location.pathname}#/settings`);
        } catch {
            // Only the repeat-on-reload is lost.
        }
    },

    youtubeSection({ youtube, youtubeError, youtubeApp, youtubeAppError }) {
        const isAdmin = App.isAdmin();
        const canAdminister = App.canAdminister();
        const c = youtube && youtube.connection;
        const connected = !!(c && c.connected);
        const needsReconnect = !!(c && c.status === 'invalid');
        const thumb = c ? safeUrl(c.thumbnailUrl) : '';
        // Only a Google app still in Testing hands out a refresh token with an end date (7 days).
        const refreshExpires = c && c.refreshExpiresAt ? new Date(c.refreshExpiresAt) : null;

        let body;
        if (youtubeError) {
            body = html`
                <div class="inline-error" role="alert">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    <div><strong dir="auto">${t('settings.youtube.loadFailed', { message: youtubeError.message })}</strong></div>
                </div>
                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
            `;
        } else if (!youtube.appConfigured) {
            body = html`<p class="form-hint">${isAdmin ? t('settings.youtube.notConfiguredAdmin') : t('settings.youtube.notConfiguredMember')}</p>`;
        } else if (connected || needsReconnect) {
            body = html`
                <div class="row row--start gap-3 mbe-4">
                    ${thumb
                        ? html`<img class="tiktok-avatar-lg" src="${thumb}" alt="" width="44" height="44">`
                        : html`<span class="stat-icon shrink-0"><i data-lucide="youtube" aria-hidden="true"></i></span>`}
                    <div class="stack gap-1">
                        <strong dir="auto">${c.channelTitle || t('settings.youtube.unnamed')}</strong>
                        <span class="health-pill ${needsReconnect ? html.raw('health-stale') : html.raw('health-fresh')}">
                            <i data-lucide="${needsReconnect ? 'alert-triangle' : 'check-circle'}" aria-hidden="true"></i>
                            ${needsReconnect ? t('settings.youtube.statusInvalid') : t('settings.youtube.statusActive')}
                        </span>
                    </div>
                </div>
                ${needsReconnect && c.lastError ? html`
                    <p class="form-hint text-warning mbe-3" dir="auto">${t('settings.youtube.lastError', { message: c.lastError })}</p>
                ` : ''}
                ${connected && !c.canUpload ? html`<p class="form-hint text-warning mbe-3">${t('settings.youtube.cannotUpload')}</p>` : ''}
                <p class="token-info mbe-2">${youtube.publicUploads ? t('settings.youtube.privacyPublic') : t('settings.youtube.privacyPrivate')}</p>
                ${this.youtubeVisibilityLine(youtube.visibility)}
                ${refreshExpires ? html`
                    <p class="form-hint text-warning mbe-3">${t('settings.youtube.testingExpiry', { date: UI.formatDay(refreshExpires) })}</p>
                ` : ''}
                ${canAdminister ? html`
                    <div class="row row--wrap gap-2">
                        ${UI.button({
                            variant: needsReconnect ? 'primary' : 'secondary', size: 'sm', icon: 'refresh-cw',
                            label: t('settings.youtube.reconnect'), action: 'settings:connectYouTube', id: 'settings-youtube-connect',
                        })}
                        ${UI.button({
                            variant: 'danger', size: 'sm', icon: 'unlink',
                            label: t('settings.youtube.disconnect'), action: 'settings:disconnectYouTube', id: 'settings-youtube-disconnect',
                        })}
                    </div>
                ` : html`<p class="form-hint">${t('settings.youtube.ownerOnly')}</p>`}
            `;
        } else {
            body = html`
                ${canAdminister ? UI.button({
                    variant: 'primary', size: 'sm', icon: 'link',
                    label: t('settings.youtube.connect'), action: 'settings:connectYouTube', id: 'settings-youtube-connect',
                }) : html`<p class="form-hint">${t('settings.youtube.ownerOnly')}</p>`}
                ${canAdminister ? html`<p class="form-hint mbs-2">${t('settings.youtube.unverifiedHint')}</p>` : ''}
            `;
        }

        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.youtube.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${t('settings.youtube.intro')}</p>
                    ${body}
                    ${isAdmin ? this.youtubeAppBlock(youtubeApp, youtubeAppError, !!(youtube && youtube.appConfigured)) : ''}
                </div>
            </section>
        `;
    },

    /** The daily check's verdict on the published Shorts (src/services/youtubeVisibility.ts). */
    youtubeVisibilityLine(v) {
        if (!v || !v.total) return '';
        if (v.flagged > 0) {
            return html`<p class="form-hint text-warning mbe-2">
                <i data-lucide="alert-triangle" aria-hidden="true"></i>
                ${t('settings.youtube.visibilityFlagged', { flagged: UI.formatNumber(v.flagged), total: UI.formatNumber(v.total) })}
            </p>`;
        }
        return html`<p class="token-info mbe-2">${v.checkedAt
            ? t('settings.youtube.visibilityOk', { total: UI.formatNumber(v.total), date: UI.formatDay(new Date(v.checkedAt)) })
            : t('settings.youtube.visibilityPending', { total: UI.formatNumber(v.total) })}</p>`;
    },

    /** The Google OAuth client — one for the whole deployment, so platform admins only. */
    youtubeAppBlock(app, error, configured) {
        if (error) {
            return html`<p class="form-hint text-warning" dir="auto">${t('settings.youtube.app.loadFailed', { message: error.message })}</p>`;
        }
        if (!app) return '';
        const secretHint = app.clientSecret.source === 'env'
            ? t('settings.tiktok.app.secretFromEnv')
            : (app.clientSecret.preview ? t('settings.tiktok.app.secretSet', { preview: app.clientSecret.preview }) : '');
        const reg = app.register;
        const row = (label, value) => html`
            <li>
                <span class="form-label">${label}</span>
                <code dir="ltr">${UI.ltr(value)}</code>
                ${UI.button({
                    variant: 'ghost', size: 'sm', icon: 'copy',
                    ariaLabel: t('setup.copyUrl'), title: t('setup.copyUrl'),
                    action: 'app:copyValue', data: { copy: value },
                })}
            </li>
        `;
        return html`
            <details class="settings-block" ${configured ? '' : html.raw('open')}>
                <summary class="form-label tiktok-app-summary">
                    <i data-lucide="chevron-down" aria-hidden="true"></i>
                    ${t('settings.youtube.app.title')}
                </summary>
                <p class="form-hint mbe-3">${t('settings.youtube.app.hint')}</p>
                ${reg ? html`
                    <p class="form-label">${t('settings.youtube.app.register')}</p>
                    <ul class="tiktok-register mbe-4">
                        ${row(t('settings.youtube.app.redirectUri'), reg.redirectUri)}
                        ${row(t('settings.tiktok.app.websiteUrl'), reg.homepageUrl)}
                        ${row(t('settings.tiktok.app.privacyUrl'), reg.privacyUrl)}
                        ${row(t('settings.tiktok.app.termsUrl'), reg.termsUrl)}
                        ${row(t('settings.tiktok.app.scopes'), (app.scopes || []).join(' '))}
                    </ul>
                ` : ''}
                <form id="youtube-app-form" data-submit="settings:saveYouTubeApp" data-redirect="${reg ? reg.redirectUri : ''}">
                    <div class="form-group">
                        <label class="form-label" for="youtube-json">${t('settings.youtube.app.json')}</label>
                        <input class="field" id="youtube-json" type="file" accept=".json,application/json" data-change="settings:readYouTubeJson">
                        <p class="form-hint" id="youtube-json-note" aria-live="polite">${t('settings.youtube.app.jsonHint')}</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="youtube-client-id">${t('settings.youtube.app.clientId')}</label>
                        <input class="field field-mono" id="youtube-client-id" name="clientId" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false" placeholder="123456789-abc.apps.googleusercontent.com"
                               value="${app.clientId.value || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="youtube-client-secret">${t('settings.youtube.app.clientSecret')}</label>
                        <input class="field field-mono" id="youtube-client-secret" name="clientSecret" type="password" dir="ltr"
                               autocomplete="new-password" spellcheck="false" placeholder="GOCSPX-…">
                        ${secretHint ? html`<p class="form-hint">${secretHint}</p>` : ''}
                    </div>
                    <div class="form-group">
                        <label class="check-row" for="youtube-public">
                            <input type="checkbox" id="youtube-public" name="publicUploads" ${app.publicUploads ? html.raw('checked') : ''}>
                            <span class="check-label">${t('settings.youtube.app.publicUploads')}</span>
                        </label>
                        <p class="form-hint">${t('settings.youtube.app.publicUploadsHint')}</p>
                    </div>
                    <div class="form-actions">
                        ${UI.button({
                            variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                            label: t('settings.youtube.app.save'), id: 'youtube-app-submit',
                        })}
                    </div>
                </form>
            </details>
        `;
    },

    /**
     * The JSON Google Cloud downloads for an OAuth client, read here in the browser: its client ID
     * and secret fill the two fields, and nothing is sent until Save. Says when the file's
     * redirect URIs do not include ours, which is the one mistake that fails every connect.
     */
    async readYouTubeJson(input) {
        const note = document.getElementById('youtube-json-note');
        const file = input && input.files && input.files[0];
        if (!file || !note) return;
        try {
            const parsed = JSON.parse(await file.text());
            const web = parsed.web || parsed.installed;
            if (!web || !web.client_id || !web.client_secret) throw new Error('shape');
            document.getElementById('youtube-client-id').value = web.client_id;
            document.getElementById('youtube-client-secret').value = web.client_secret;
            const form = document.getElementById('youtube-app-form');
            const expected = form ? form.dataset.redirect : '';
            const uris = Array.isArray(web.redirect_uris) ? web.redirect_uris : [];
            if (!parsed.web) note.textContent = t('settings.youtube.app.jsonNotWeb');
            else if (expected && !uris.includes(expected)) note.textContent = t('settings.youtube.app.jsonNoRedirect', { uri: expected });
            else note.textContent = t('settings.youtube.app.jsonRead');
        } catch {
            note.textContent = t('settings.youtube.app.jsonBad');
        } finally {
            // The file's contents are in the two fields now; the picker keeps nothing.
            input.value = '';
        }
    },

    async connectYouTube(btn) {
        if (!btn || btn.disabled) return;
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        try {
            const { url } = await API.startYouTubeConnect();
            window.location.href = url;
        } catch (err) {
            restore();
            UI.toast(err.message || t('settings.youtube.return.generic'), 'error');
        }
    },

    disconnectYouTube(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.youtube.disconnectTitle'),
            body: t('settings.youtube.disconnectBody'),
            hint: t('settings.youtube.disconnectHint'),
            confirmLabel: t('settings.youtube.disconnect'),
            confirmIcon: 'unlink',
            onConfirm: () => SettingsPage.disconnectYouTubeConfirmed(),
        });
    },

    async disconnectYouTubeConfirmed() {
        await API.disconnectYouTube();
        UI.toast(t('settings.youtube.disconnected'), 'success');
        await this.render();
    },

    async saveYouTubeApp(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const payload = {
            clientId: (data.get('clientId') || '').toString().trim(),
            publicUploads: data.get('publicUploads') === 'on',
        };
        // Blank means "leave it": the saved secret is never sent back to the page.
        const secret = (data.get('clientSecret') || '').toString().trim();
        if (secret) payload.clientSecret = secret;
        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveYouTubeAppSettings(payload);
            UI.toast(t('settings.youtube.app.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message, 'error');
        }
    },

    /** Reasons the OAuth callback can send back, each with its own sentence. */
    TIKTOK_RETURN_REASONS: ['denied', 'state_mismatch', 'state_expired', 'account_in_use', 'exchange_failed', 'no_base_url'],

    /**
     * Coming back from TikTok's consent screen: the callback redirects to
     * `#/settings?tiktok=connected|error&reason=…`. Say what happened once,
     * then drop the parameters so a reload does not say it again.
     */
    announceTikTokReturn() {
        const outcome = App.hashParam('tiktok');
        if (!outcome) return;
        if (outcome === 'connected') {
            UI.toast(t('settings.tiktok.connectedToast'), 'success');
        } else {
            const reason = App.hashParam('reason');
            const known = this.TIKTOK_RETURN_REASONS.includes(reason);
            UI.toast(known ? t(`settings.tiktok.return.${reason}`) : t('settings.tiktok.return.generic'), 'error');
        }
        try {
            history.replaceState(null, '', `${location.pathname}#/settings`);
        } catch {
            // Only the repeat-on-reload is lost.
        }
    },

    tiktokSection({ tiktok, tiktokError, tiktokApp, tiktokAppError }) {
        const isAdmin = App.isAdmin();
        const canAdminister = App.canAdminister();
        const c = tiktok && tiktok.connection;
        const connected = !!(c && c.connected);
        const needsReconnect = !!(c && c.status === 'invalid');
        const refreshExpires = c && c.refreshExpiresAt ? new Date(c.refreshExpiresAt) : null;
        const daysToReconnect = refreshExpires ? Math.ceil((refreshExpires - Date.now()) / 86400000) : null;
        const avatar = c ? safeUrl(c.avatarUrl) : '';
        // Direct Post is switched on for the app but this connection predates
        // it, so it lacks `video.publish` — posts stay inbox drafts until reconnect.
        const needsDirectScope = !!(c && c.directPostEnabled && !c.canDirectPost);

        let body;
        if (tiktokError) {
            body = html`
                <div class="inline-error" role="alert">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    <div><strong dir="auto">${t('settings.tiktok.loadFailed', { message: tiktokError.message })}</strong></div>
                </div>
                ${UI.button({
                    variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render',
                })}
            `;
        } else if (!tiktok.appConfigured) {
            body = html`
                <p class="form-hint">${isAdmin ? t('settings.tiktok.notConfiguredAdmin') : t('settings.tiktok.notConfiguredMember')}</p>
            `;
        } else if (connected || needsReconnect) {
            body = html`
                <div class="row row--start gap-3 mbe-4">
                    ${avatar
                        ? html`<img class="tiktok-avatar-lg" src="${avatar}" alt="" width="44" height="44">`
                        : html`<span class="stat-icon shrink-0"><i data-lucide="music-2" aria-hidden="true"></i></span>`}
                    <div class="stack gap-1">
                        <strong dir="auto">${c.displayName || t('settings.tiktok.unnamed')}</strong>
                        <span class="health-pill ${needsReconnect ? html.raw('health-stale') : html.raw('health-fresh')}">
                            <i data-lucide="${needsReconnect ? 'alert-triangle' : 'check-circle'}" aria-hidden="true"></i>
                            ${needsReconnect ? t('settings.tiktok.statusInvalid') : t('settings.tiktok.statusActive')}
                        </span>
                    </div>
                </div>
                ${needsReconnect && c.lastError ? html`
                    <p class="form-hint text-warning mbe-3" dir="auto">${t('settings.tiktok.lastError', { message: c.lastError })}</p>
                ` : ''}
                <p class="token-info mbe-2">${t('settings.tiktok.modeLine', { mode: this.tiktokModeLabel(c) })}</p>
                ${needsDirectScope ? html`
                    <p class="form-hint text-warning mbe-3">
                        <i data-lucide="alert-triangle" aria-hidden="true"></i>
                        ${t('settings.tiktok.reconnectForDirect')}
                    </p>
                ` : ''}
                ${connected && c.directPostEnabled && !c.audited && c.canDirectPost && !c.canUpload ? html`
                    <p class="form-hint mbe-3">${t('settings.tiktok.reconnectForDrafts')}</p>
                ` : ''}
                ${connected && !c.canUpload && !c.canDirectPost ? html`
                    <p class="form-hint text-warning mbe-3">${t('settings.tiktok.cannotUpload')}</p>
                ` : ''}
                ${refreshExpires ? html`
                    <p class="token-info mbe-2">
                        ${t('settings.tiktok.reconnectBy', { date: UI.formatDay(refreshExpires) })}
                        ${daysToReconnect !== null && daysToReconnect < 30 ? html`
                            <span class="text-warning">${t('settings.daysLeft', { count: Math.max(daysToReconnect, 0) })}</span>
                        ` : ''}
                    </p>
                ` : ''}
                ${tiktok.inbox ? html`
                    <p class="token-info mbe-4 ${tiktok.inbox.pending >= tiktok.inbox.limit ? html.raw('text-warning') : ''}">
                        ${t('posts.tiktok.inboxUsage', { pending: tiktok.inbox.pending, limit: tiktok.inbox.limit })}
                    </p>
                ` : ''}
                ${c.scopes && c.scopes.length ? html`
                    <div class="mbe-4">
                        <p class="form-label">${t('settings.permissions')}</p>
                        <div class="scope-list">${c.scopes.map((sc) => html`<span class="chip">${UI.ltr(sc)}</span>`)}</div>
                    </div>
                ` : ''}
                ${canAdminister ? html`
                    <div class="row row--wrap gap-2">
                        ${UI.button({
                            variant: needsReconnect ? 'primary' : 'secondary', size: 'sm', icon: 'refresh-cw',
                            label: t('settings.tiktok.reconnect'), action: 'settings:connectTikTok', id: 'settings-tiktok-connect',
                        })}
                        ${UI.button({
                            variant: 'danger', size: 'sm', icon: 'unlink',
                            label: t('settings.tiktok.disconnect'), action: 'settings:disconnectTikTok', id: 'settings-tiktok-disconnect',
                        })}
                    </div>
                ` : html`<p class="form-hint">${t('settings.tiktok.ownerOnly')}</p>`}
            `;
        } else {
            body = html`
                ${canAdminister ? UI.button({
                    variant: 'primary', size: 'sm', icon: 'link',
                    label: t('settings.tiktok.connect'), action: 'settings:connectTikTok', id: 'settings-tiktok-connect',
                }) : html`<p class="form-hint">${t('settings.tiktok.ownerOnly')}</p>`}
            `;
        }

        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.tiktok.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${this.tiktokIntro(c)} ${UI.helpLink('tiktok', t('help.link.tiktok'), { className: 'settings-tiktok-help' })}</p>
                    ${body}
                    ${isAdmin ? this.tiktokAppBlock(tiktokApp, tiktokAppError, !!(tiktok && tiktok.appConfigured), connected || needsReconnect) : ''}
                </div>
            </section>
        `;
    },

    /**
     * The mode posts go out in right now. Only the server decides it
     * (`postMode` is 'direct' iff the connection has `video.publish` AND the
     * admin has switched Direct Post on); this only names it.
     */
    tiktokModeLabel(c) {
        if (!c || c.postMode !== 'direct') return t('settings.tiktok.mode.inbox');
        if (c.audited) return t('settings.tiktok.mode.direct');
        return c.canUpload && c.canDirectPost ? t('settings.tiktok.mode.choose') : t('settings.tiktok.mode.directUnaudited');
    },

    /**
     * The section's opening sentence, true for the mode in force. Not connected
     * yet with Direct Post switched on: connecting will ask for `video.publish`,
     * so the direct sentence is the one that will be true.
     */
    tiktokIntro(c) {
        const direct = !!(c && (c.postMode === 'direct' || (c.directPostEnabled && !c.connected)));
        return direct ? t('settings.tiktok.introDirect') : t('settings.tiktok.introInbox');
    },

    /**
     * The TikTok app's own credentials — one set for the whole deployment, so
     * platform admins only. Open by default until the app is configured, since
     * until then it is the only thing in the section that does anything.
     */
    tiktokAppBlock(app, error, configured, accountConnected) {
        if (error) {
            return html`<p class="form-hint text-warning" dir="auto">${t('settings.tiktok.app.loadFailed', { message: error.message })}</p>`;
        }
        if (!app) return '';
        const reg = app.register;
        const secretNote = app.clientSecret.source === 'env'
            ? t('settings.tiktok.app.secretFromEnv')
            : (app.clientSecret.preview ? t('settings.tiktok.app.secretSet', { preview: app.clientSecret.preview }) : '');
        const row = (label, value) => html`
            <li>
                <span class="form-label">${label}</span>
                <code dir="ltr">${UI.ltr(value)}</code>
                ${UI.button({
                    variant: 'ghost', size: 'sm', icon: 'copy',
                    ariaLabel: t('setup.copyUrl'), title: t('setup.copyUrl'),
                    action: 'app:copyValue', data: { copy: value },
                })}
            </li>
        `;

        return html`
            <details class="settings-block" ${configured ? '' : html.raw('open')}>
                <summary class="form-label tiktok-app-summary">
                    <i data-lucide="chevron-down" aria-hidden="true"></i>
                    ${t('settings.tiktok.app.title')}
                </summary>
                <p class="form-hint mbe-3">${t('settings.tiktok.app.hint')}</p>

                ${reg ? html`
                    <p class="form-label">${t('settings.tiktok.app.register')}</p>
                    <ul class="tiktok-register mbe-4">
                        ${row(t('settings.tiktok.app.websiteUrl'), reg.websiteUrl)}
                        ${row(t('settings.tiktok.app.termsUrl'), reg.termsUrl)}
                        ${row(t('settings.tiktok.app.privacyUrl'), reg.privacyUrl)}
                        ${row(t('settings.tiktok.app.redirectUri'), reg.redirectUri)}
                        ${row(t('settings.tiktok.app.webhookUrl'), reg.webhookUrl)}
                        ${row(t('settings.tiktok.app.scopes'), (app.scopes || []).join(','))}
                    </ul>
                ` : ''}

                <form id="tiktok-app-form" data-submit="settings:saveTikTokApp">
                    <div class="form-group">
                        <label class="form-label" for="tiktok-client-key">${t('settings.tiktok.app.clientKey')}</label>
                        <input class="field field-mono" id="tiktok-client-key" name="clientKey" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false" autocapitalize="off"
                               value="${app.clientKey.value || ''}">
                    </div>
                    <div class="form-group">
                        <!-- Never prefilled: the secret is never sent back. Blank
                             means "keep what is saved". -->
                        <label class="form-label" for="tiktok-client-secret">${t('settings.tiktok.app.clientSecret')}</label>
                        <input class="field field-mono" id="tiktok-client-secret" name="clientSecret" type="password" dir="ltr"
                               autocomplete="new-password" spellcheck="false" autocapitalize="off">
                        ${secretNote ? html`<p class="form-hint">${UI.ltr(secretNote)}</p>` : ''}
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="tiktok-base-url">${t('settings.tiktok.app.baseUrl')}</label>
                        <input class="field field-mono" id="tiktok-base-url" name="publicBaseUrl" type="url" dir="ltr"
                               autocomplete="off" spellcheck="false"
                               placeholder="${app.publicBaseUrl.effective || 'https://'}"
                               value="${app.publicBaseUrl.saved || ''}">
                        <p class="form-hint">${t('settings.tiktok.app.baseUrlHint')}</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="tiktok-verify-name">
                            ${t('settings.tiktok.app.verifyName')} <span class="label-optional">${t('common.optional')}</span>
                        </label>
                        <input class="field field-mono" id="tiktok-verify-name" name="verificationFilename" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false" placeholder="tiktokXXXXXXXX.txt"
                               value="${app.verification.filename || ''}">
                        <label class="form-label mbs-3" for="tiktok-verify-content">${t('settings.tiktok.app.verifyContent')}</label>
                        <input class="field field-mono" id="tiktok-verify-content" name="verificationContent" type="text" dir="ltr"
                               autocomplete="off" spellcheck="false" placeholder="tiktok-developers-site-verification=…">
                        <p class="form-hint">${t('settings.tiktok.app.verifyHint')}</p>
                        ${app.verification.url ? html`<p class="form-hint">${UI.ltr(app.verification.url)}</p>` : ''}
                    </div>
                    <!-- Two facts only the admin can know, because they live in
                         TikTok's portal: whether Direct Post is on for the app,
                         and whether TikTok's audit has passed. -->
                    <fieldset class="form-group fieldset-plain">
                        <legend class="form-label">${t('settings.tiktok.app.directPostTitle')}</legend>
                        <div class="stack gap-3">
                            <div class="check-row">
                                <input type="checkbox" id="tiktok-direct-enabled" name="directPostEnabled"
                                       data-change="settings:previewDirectPost"
                                       data-saved="${app.directPostEnabled === true ? 'on' : 'off'}"
                                       data-connected="${accountConnected ? 'yes' : 'no'}"
                                       aria-describedby="tiktok-direct-consequence"
                                       ${app.directPostEnabled === true ? html.raw('checked') : ''}>
                                <span class="check-text">
                                    <label class="check-label" for="tiktok-direct-enabled">${t('settings.tiktok.app.directPostEnabled')}</label>
                                </span>
                            </div>
                            <div class="check-row">
                                <input type="checkbox" id="tiktok-audited" name="audited"
                                       ${app.audited === true ? html.raw('checked') : ''}>
                                <span class="check-text">
                                    <label class="check-label" for="tiktok-audited">${t('settings.tiktok.app.audited')}</label>
                                </span>
                            </div>
                        </div>
                        <!-- What saving THIS change will do, before it is saved.
                             Empty until the switch moves away from what is saved. -->
                        <p class="form-hint text-warning" id="tiktok-direct-consequence" aria-live="polite"></p>
                        <p class="form-hint">${t('settings.tiktok.app.directPostHint')}</p>
                    </fieldset>
                    <!-- A third fact only the admin can know, because it lives in
                         TikTok's portal: whether user.info.profile is approved. Off
                         keeps the authorise request exactly as it was. -->
                    <fieldset class="form-group fieldset-plain">
                        <legend class="form-label">${t('settings.tiktok.app.profileTitle')}</legend>
                        <div class="check-row">
                            <input type="checkbox" id="tiktok-profile-scope" name="profileScopeEnabled"
                                   aria-describedby="tiktok-profile-hint"
                                   ${app.profileScopeEnabled === true ? html.raw('checked') : ''}>
                            <span class="check-text">
                                <label class="check-label" for="tiktok-profile-scope">${t('settings.tiktok.app.profileScopeEnabled')}</label>
                            </span>
                        </div>
                        <p class="form-hint" id="tiktok-profile-hint">${t('settings.tiktok.app.profileHint')}</p>
                    </fieldset>
                    <div class="form-actions">
                        ${UI.button({
                            variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                            label: t('settings.tiktok.app.save'), id: 'tiktok-app-submit',
                        })}
                    </div>
                </form>
            </details>
        `;
    },

    /**
     * Where uploads are kept: one Supabase project for the whole deployment,
     * so platform admins only. The pill is Supabase's live answer, not the
     * saved config — a key that stopped working shows as not connected.
     */
    mediaStorageSection(ms, error, cleanup) {
        let body = '';
        if (error) {
            body = html`
                <div class="inline-error" role="alert">
                    <i data-lucide="alert-circle" aria-hidden="true"></i>
                    <div><strong dir="auto">${t('settings.media.loadFailed', { message: error.message })}</strong></div>
                </div>
                ${UI.button({
                    variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render',
                })}
            `;
        } else if (ms) {
            body = html`${this.mediaStorageStatus(ms)}${cleanup ? this.mediaCleanupBlock(cleanup) : ''}${this.mediaStorageForm(ms)}`;
        }
        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.media.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${t('settings.media.intro')}</p>
                    ${body}
                </div>
            </section>
        `;
    },

    /**
     * "Delete files once posted": the switch the daily sweep reads, and a button that applies the
     * same rule now. Instagram, Facebook and YouTube keep their own copy of what was posted.
     */
    mediaCleanupBlock(cleanup) {
        const p = cleanup.preview || { files: 0, bytes: 0 };
        return html`
            <div class="settings-block mbe-4">
                <label class="check-row" for="media-cleanup-on">
                    <input type="checkbox" id="media-cleanup-on" data-change="settings:toggleMediaCleanup"
                           aria-describedby="media-cleanup-hint" ${cleanup.on ? html.raw('checked') : ''}>
                    <span class="check-label">${t('settings.media.cleanupOn')}</span>
                </label>
                <p class="form-hint" id="media-cleanup-hint">${t('settings.media.cleanupHint')}</p>
                <p class="token-info mbs-2">
                    ${p.files > 0
                        ? t('settings.media.cleanupPreview', { files: UI.formatNumber(p.files), size: Admin.bytes(p.bytes) })
                        : t('settings.media.cleanupNothing')}
                </p>
                ${p.files > 0 ? UI.button({
                    variant: 'secondary', size: 'sm', icon: 'trash-2',
                    label: t('settings.media.cleanupNow'), action: 'settings:cleanUpMedia', id: 'media-cleanup-now',
                }) : ''}
            </div>
        `;
    },

    async toggleMediaCleanup(box) {
        if (!box) return;
        const on = box.checked;
        box.disabled = true;
        try {
            await API.setMediaCleanup(on);
            UI.toast(on ? t('settings.media.cleanupSavedOn') : t('settings.media.cleanupSavedOff'), 'success');
        } catch (err) {
            box.checked = !on;
            UI.toast(err.message, 'error');
        } finally {
            box.disabled = false;
        }
    },

    cleanUpMedia(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.media.cleanupTitle'),
            body: t('settings.media.cleanupBody'),
            hint: t('settings.media.cleanupConfirmHint'),
            confirmLabel: t('settings.media.cleanupNow'),
            confirmIcon: 'trash-2',
            onConfirm: () => SettingsPage.cleanUpMediaConfirmed(),
        });
    },

    /** A failure shows inside the confirm dialog, which stays open (Admin.runConfirm). */
    async cleanUpMediaConfirmed() {
        const out = await API.runMediaCleanup();
        UI.toast(t('settings.media.cleanupDone', { files: UI.formatNumber(out.files), size: Admin.bytes(out.bytes) }), 'success');
        await this.render();
    },

    mediaStorageStatus(ms) {
        const c = ms.connection;
        const connected = !!(c && c.ok);
        const pill = ms.backend !== 'supabase'
            ? { cls: 'health-stale', icon: 'database', text: t('settings.media.statusPostgres') }
            : connected
                ? { cls: 'health-fresh', icon: 'check-circle', text: t('settings.media.statusConnected') }
                : { cls: 'health-stale', icon: 'alert-triangle', text: t('settings.media.statusFailed') };
        const u = ms.usage;
        return html`
            <div class="token-status">
                <span class="health-pill ${html.raw(pill.cls)}">
                    <i data-lucide="${pill.icon}" aria-hidden="true"></i>
                    ${pill.text}
                </span>
                ${ms.url && ms.url.value ? html`<span class="text-meta">${UI.ltr(ms.url.value)}</span>` : ''}
            </div>
            ${c && !c.ok ? html`<p class="form-hint text-warning mbe-3" dir="auto">${c.error}</p>` : ''}
            <dl class="ops-facts mbe-4">
                ${Admin.field(t('settings.media.bucket'), connected && !c.bucketExists
                    ? t('settings.media.bucketMissing')
                    : UI.ltr(ms.bucket))}
                ${u ? html`
                    ${Admin.field(t('settings.media.used', { total: Admin.bytes(u.tierBytes) }), UI.ltr(Admin.bytes(u.storage.bytes)))}
                    ${Admin.field(t('settings.media.files'), UI.num(u.storage.files))}
                    ${u.database.files > 0 ? Admin.field(t('settings.media.inDatabase'), UI.ltr(Admin.bytes(u.database.bytes))) : ''}
                    ${u.queuedDeletions > 0 ? Admin.field(t('settings.media.queued'), UI.num(u.queuedDeletions)) : ''}
                ` : ''}
            </dl>
            ${u && u.database.files > 0 ? html`<p class="form-hint mbe-4">${t('settings.media.inDatabaseHint')}</p>` : ''}
            ${ms.usageError ? html`<p class="form-hint text-warning mbe-4" dir="auto">${t('settings.media.usageFailed', { message: ms.usageError })}</p>` : ''}
        `;
    },

    mediaStorageForm(ms) {
        const key = ms.key || {};
        const keyNote = key.source === 'database' && key.preview
            ? t('settings.media.keySaved', { preview: key.preview })
            : (key.source === 'env' ? t('settings.media.keyFromEnv') : '');
        const savedUrl = ms.url && ms.url.source === 'database' ? ms.url.value : '';
        const envUrl = ms.url && ms.url.source === 'env' ? ms.url.value : '';
        return html`
            <form id="media-storage-form" data-submit="settings:saveMediaStorage">
                <div class="form-group">
                    <label class="form-label" for="media-storage-url">${t('settings.media.url')}</label>
                    <input class="field field-mono" id="media-storage-url" name="url" type="url" dir="ltr"
                           autocomplete="off" spellcheck="false" autocapitalize="off" required
                           placeholder="${envUrl || 'https://abcd1234.supabase.co'}"
                           value="${savedUrl || ''}">
                    ${envUrl ? html`<p class="form-hint">${t('settings.media.urlFromEnv')}</p>` : ''}
                </div>
                <div class="form-group">
                    <!-- Never prefilled: the key is never sent back. Blank means
                         "keep what is saved". -->
                    <label class="form-label" for="media-storage-key">${t('settings.media.key')}</label>
                    <input class="field field-mono" id="media-storage-key" name="key" type="password" dir="ltr"
                           autocomplete="new-password" spellcheck="false" autocapitalize="off"
                           placeholder="sb_secret_…">
                    ${keyNote ? html`<p class="form-hint" dir="auto">${keyNote}</p>` : ''}
                    ${key.kind === 'legacy_jwt' ? html`<p class="form-hint text-warning">${t('settings.media.keyLegacy')}</p>` : ''}
                    <p class="form-hint">${t('settings.media.help')}</p>
                </div>
                <div class="form-actions">
                    ${UI.button({
                        variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                        label: t('settings.media.save'), id: 'media-storage-submit',
                    })}
                    ${savedUrl || key.source === 'database' ? UI.button({
                        variant: 'secondary', size: 'sm', icon: 'trash-2',
                        label: t('settings.media.remove'), action: 'settings:removeMediaStorage', id: 'media-storage-remove',
                    }) : ''}
                </div>
            </form>
        `;
    },

    /**
     * SE9: the Direct Post switch's consequence, live. Switching it on while an
     * account is connected means that account must reconnect to grant
     * `video.publish`; switching it off sends posts back to drafts at once.
     */
    previewDirectPost(box) {
        const out = document.getElementById('tiktok-direct-consequence');
        if (!out || !box) return;
        const wasOn = box.dataset.saved === 'on';
        const connected = box.dataset.connected === 'yes';
        let text = '';
        if (box.checked && !wasOn && connected) text = t('settings.tiktok.app.reconnectAfterSave');
        else if (!box.checked && wasOn) text = t('settings.tiktok.app.draftsAfterSave');
        out.textContent = text;
    },

    // ─── Webhook handshake ──────────────────────────────────────────────────
    /** Every reason the check route can answer with; anything else reads as unexpected. */
    HANDSHAKE_REASONS: ['ok', 'no_token', 'no_base_url', 'rejected', 'mismatch', 'unexpected', 'unreachable'],

    handshakeResult(r) {
        const result = r || {};
        const reason = this.HANDSHAKE_REASONS.includes(result.reason) ? result.reason : 'unexpected';
        const where = result.url ? this.ltrIn('settings.webhookTest.checked', { url: result.url }, 'url') : '';
        if (result.ok) {
            return html`
                <span class="health-pill health-fresh">
                    <i data-lucide="check-circle" aria-hidden="true"></i>
                    ${t('settings.webhookTest.ok')}
                </span>
                ${where ? html`<p class="form-hint">${where}</p>` : ''}
            `;
        }
        const status = Number.isFinite(Number(result.status)) && result.status !== null ? Number(result.status) : '';
        return UI.errorStrip(t(`settings.webhookTest.${reason}`, { status }), where, 'settings-webhook-test-strip');
    },

    /** «اختبر التحقق»: the server performs Meta's GET against the public webhook URL. */
    async testWebhook(btn) {
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        const host = document.getElementById('settings-webhook-test-result');
        if (host) host.innerHTML = '';
        try {
            const result = await API.checkWebhookHandshake();
            if (host) { host.innerHTML = esc(this.handshakeResult(result)); UI.icons(host); }
        } catch (err) {
            if (host) {
                host.innerHTML = esc(UI.errorStrip(t('settings.webhookTest.requestFailed'), (err && err.message) || '', 'settings-webhook-test-strip'));
                UI.icons(host);
            }
        } finally {
            restore();
        }
    },

    // ─── Public site ────────────────────────────────────────────────────────
    /**
     * The digits wa.me wants, exactly as the server normalises them
     * (src/services/appSettings.ts normaliseWhatsappNumber): Arabic-Indic
     * digits become Latin, spaces/dashes/brackets/dots go, a leading `+` or
     * `00` goes. '' when nothing is left; null when what is left is not a phone
     * number.
     */
    normaliseWhatsapp(value) {
        let digits = String(value || '')
            .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
            .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
            .replace(/[\s\-().]/g, '');
        if (!digits) return '';
        if (digits.startsWith('+')) digits = digits.slice(1);
        else if (digits.startsWith('00')) digits = digits.slice(2);
        return /^[1-9][0-9]{7,14}$/.test(digits) ? digits : null;
    },

    /** The line under the number field: the link the site will print, or why there is none. */
    whatsappPreview(value, fallback) {
        const typed = this.normaliseWhatsapp(value);
        if (typed === null) return html`<span class="text-warning">${t('settings.site.whatsappInvalid')}</span>`;
        const digits = typed || this.normaliseWhatsapp(fallback) || '';
        if (!digits) return t('settings.site.whatsappNone');
        const url = `https://wa.me/${digits}`;
        return html`${t('settings.site.whatsappPreview')} <a href="${url}" target="_blank" rel="noopener noreferrer">${UI.ltr(`wa.me/${digits}`)}</a>`;
    },

    previewWhatsapp(input) {
        const out = document.getElementById('site-whatsapp-preview');
        if (!out || !input) return;
        out.innerHTML = esc(this.whatsappPreview(input.value, input.dataset.fallback || ''));
    },

    /** Where a value comes from, when it is not saved here: the note under its field. */
    siteSourceNote(kind, value, source) {
        if (!value || source === 'database') return '';
        const key = source === 'default' ? `settings.site.${kind}FromDefault` : `settings.site.${kind}FromFallback`;
        return html`<p class="form-hint">${this.ltrIn(key, { value }, 'value')}</p>`;
    },

    siteSection(site, error) {
        if (error) {
            return html`
                <section class="section">
                    <h2 class="section-title">${t('settings.site.title')}</h2>
                    <div class="settings-card surface">
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div><strong dir="auto">${t('settings.site.loadFailed', { message: error.message })}</strong></div>
                        </div>
                        ${UI.button({
                            variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render',
                        })}
                    </div>
                </section>
            `;
        }
        if (!site) return '';
        const src = site.source || {};
        const saved = (field) => (src[field] === 'database' && site[field]) || '';
        const fallbackNumber = src.whatsappNumber && src.whatsappNumber !== 'database' ? (site.whatsappNumber || '') : '';
        const fallbackEmail = src.contactEmail && src.contactEmail !== 'database' ? (site.contactEmail || '') : '';
        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.site.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${t('settings.site.intro')}</p>
                    <div id="site-settings-error"></div>
                    <form id="site-settings-form" data-submit="settings:saveSiteSettings" novalidate>
                        <div class="form-group">
                            <label class="form-label" for="site-whatsapp">${t('settings.site.whatsapp')}</label>
                            <input class="field field-mono" id="site-whatsapp" name="whatsappNumber" type="tel" dir="ltr"
                                   inputmode="tel" autocomplete="off" spellcheck="false"
                                   placeholder="${fallbackNumber || '9665XXXXXXXX'}"
                                   value="${saved('whatsappNumber')}" data-fallback="${fallbackNumber}"
                                   data-input="settings:previewWhatsapp"
                                   aria-describedby="site-whatsapp-hint site-whatsapp-preview">
                            <p class="form-hint" id="site-whatsapp-hint">${t('settings.site.whatsappHint')}</p>
                            <p class="form-hint" id="site-whatsapp-preview" aria-live="polite">${this.whatsappPreview(saved('whatsappNumber'), fallbackNumber)}</p>
                            ${this.siteSourceNote('whatsapp', fallbackNumber, src.whatsappNumber)}
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="site-email">${t('settings.site.email')}</label>
                            <input class="field field-mono" id="site-email" name="contactEmail" type="email" dir="ltr"
                                   autocomplete="off" spellcheck="false" autocapitalize="off"
                                   placeholder="${fallbackEmail || 'name@example.com'}"
                                   value="${saved('contactEmail')}">
                            ${this.siteSourceNote('email', fallbackEmail, src.contactEmail)}
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="site-eid">
                                ${t('settings.site.eidExpire')} <span class="label-optional">${t('common.optional')}</span>
                            </label>
                            <input class="field" id="site-eid" name="eidCouponsExpire" type="date" dir="ltr"
                                   value="${saved('eidCouponsExpire')}" aria-describedby="site-eid-hint">
                            <p class="form-hint" id="site-eid-hint">${t('settings.site.eidHint')}</p>
                            ${this.siteSourceNote('eid', src.eidCouponsExpire !== 'database' ? site.eidCouponsExpire : '', src.eidCouponsExpire)}
                        </div>
                        <p class="form-hint">${t('settings.site.delayHint')}</p>
                        <div class="form-actions">
                            ${UI.button({
                                variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                                label: t('settings.site.save'), id: 'site-settings-submit',
                            })}
                        </div>
                    </form>
                </div>
            </section>
        `;
    },

    /** The field each input maps to, for marking the one a refusal names. */
    SITE_FIELDS: { whatsappNumber: 'site-whatsapp', contactEmail: 'site-email', eidCouponsExpire: 'site-eid' },

    showSiteError(field, message) {
        const host = document.getElementById('site-settings-error');
        const form = document.getElementById('site-settings-form');
        if (form) UI.clearInvalid(form);
        if (!host) { UI.toast(message, 'error'); return; }
        const stripId = 'site-settings-error-strip';
        host.innerHTML = esc(UI.errorStrip(message, '', stripId));
        UI.icons(host);
        const input = field && this.SITE_FIELDS[field] ? document.getElementById(this.SITE_FIELDS[field]) : null;
        if (input) UI.markInvalid(input, stripId);
        else if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    },

    async saveSiteSettings(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const read = (name) => (data.get(name) || '').toString().trim();
        const whatsapp = this.normaliseWhatsapp(read('whatsappNumber'));
        const email = read('contactEmail');
        const host = document.getElementById('site-settings-error');
        if (host) host.innerHTML = '';
        UI.clearInvalid(form);

        // Checked here first so the answer is in Arabic and on the field; the
        // server checks again and has the last word.
        if (whatsapp === null) { this.showSiteError('whatsappNumber', t('settings.site.invalid.whatsappNumber')); return; }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { this.showSiteError('contactEmail', t('settings.site.invalid.contactEmail')); return; }

        // All three are always sent: an emptied field is a real "clear it",
        // which hands the value back to its fallback.
        const payload = { whatsappNumber: whatsapp, contactEmail: email, eidCouponsExpire: read('eidCouponsExpire') };

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveSiteSettings(payload);
            UI.toast(t('settings.site.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            const field = err && err.body && err.body.field;
            const known = field && this.SITE_FIELDS[field];
            this.showSiteError(field, known ? t(`settings.site.invalid.${field}`) : ((err && err.message) || t('error.unexpected')));
        }
    },

    // ─── Handoff alerts and echo takeover (platform admin) ───────────────────────────────────────────────

    /** The field each input maps to, for marking the one a refusal names. */
    NOTIFY_FIELDS: { botToken: 'notify-token', chatId: 'notify-chat', enabled: 'notify-enabled', hotLeads: 'notify-hot', takeover: 'notify-echo', ownerAppIds: 'notify-app-ids' },

    /**
     * The four steps that make the bot, in the order the owner does them. @BotFather is a name typed in Latin letters, so it goes through
     * `ltrIn`: in an Arabic sentence a bare «@BotFather» would have its @ jump to the other end.
     */
    notifyHelp() {
        return html`
            <details class="settings-block mbe-4">
                <summary class="form-label">${t('settings.notify.help.title')}</summary>
                <ol class="stack gap-2 mbs-4">
                    <li>${this.ltrIn('settings.notify.help.step1', { bot: '@BotFather' }, 'bot')}</li>
                    <li>${t('settings.notify.help.step2')}</li>
                    <li>${t('settings.notify.help.step3')}</li>
                    <li>${this.ltrIn('settings.notify.help.step4', { bot: '@userinfobot' }, 'bot')}</li>
                </ol>
            </details>
        `;
    },

    notifySection(notify, error) {
        if (error || !notify) {
            if (!error) return '';
            return html`
                <section class="section">
                    <h2 class="section-title">${t('settings.notify.title')}</h2>
                    <div class="settings-card surface">
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div><strong dir="auto">${t('settings.notify.loadFailed', { message: error.message })}</strong></div>
                        </div>
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
                    </div>
                </section>
            `;
        }
        const tg = notify.telegram || {};
        const echo = notify.echo || {};
        const token = tg.botToken || {};
        const documented = (Array.isArray(echo.documentedAppIds) ? echo.documentedAppIds : []).join(', ');
        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.notify.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${t('settings.notify.intro')}</p>
                    ${this.notifyHelp()}
                    <div id="notify-settings-error"></div>
                    <form id="notify-settings-form" data-submit="settings:saveNotify" novalidate>
                        <div class="form-group">
                            <div class="check-row">
                                <input type="checkbox" id="notify-enabled" name="enabled" ${tg.enabled ? html.raw('checked') : ''}>
                                <span class="check-text"><label class="check-label" for="notify-enabled">${t('settings.notify.enabled')}</label></span>
                            </div>
                        </div>
                        <div class="form-group">
                            <!-- Never prefilled: the token is never sent back. Blank means "keep what is saved". -->
                            <label class="form-label" for="notify-token">${t('settings.notify.token')}</label>
                            <input class="field field-mono" id="notify-token" name="botToken" type="password" dir="ltr" maxlength="128"
                                   autocomplete="new-password" spellcheck="false" autocapitalize="off" placeholder="123456789:AA…"
                                   aria-describedby="notify-token-hint">
                            <p class="form-hint" id="notify-token-hint">${token.set
                                ? (token.last4 ? this.ltrIn('settings.notify.tokenSaved', { last4: token.last4 }, 'last4') : t('settings.notify.tokenSavedShort'))
                                : t('settings.notify.tokenNone')}</p>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="notify-chat">${t('settings.notify.chatId')}</label>
                            <input class="field field-mono" id="notify-chat" name="chatId" type="text" dir="ltr" maxlength="40"
                                   inputmode="numeric" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="123456789"
                                   value="${tg.chatId || ''}" aria-describedby="notify-chat-hint">
                            <p class="form-hint" id="notify-chat-hint">${t('settings.notify.chatIdHint')}</p>
                        </div>
                        <div class="form-group">
                            <div class="check-row">
                                <input type="checkbox" id="notify-hot" name="hotLeads" ${tg.hotLeads !== false ? html.raw('checked') : ''}>
                                <span class="check-text"><label class="check-label" for="notify-hot">${t('settings.notify.hotLeads')}</label></span>
                            </div>
                        </div>

                        <fieldset class="form-group fieldset-plain">
                            <legend class="form-label">${t('settings.notify.echo.title')}</legend>
                            <div class="check-row">
                                <input type="checkbox" id="notify-echo" name="takeover" aria-describedby="notify-echo-hint" ${echo.takeover ? html.raw('checked') : ''}>
                                <span class="check-text"><label class="check-label" for="notify-echo">${t('settings.notify.echo.takeover')}</label></span>
                            </div>
                            <p class="form-hint" id="notify-echo-hint">${t('settings.notify.echo.hint')}</p>
                            <div class="form-group mbs-4">
                                <label class="form-label" for="notify-app-ids">${t('settings.notify.echo.appIds')} <span class="label-optional">${t('common.optional')}</span></label>
                                <input class="field field-mono" id="notify-app-ids" name="ownerAppIds" type="text" dir="ltr" maxlength="300"
                                       autocomplete="off" spellcheck="false" placeholder="1217981644879628"
                                       value="${(Array.isArray(echo.ownerAppIds) ? echo.ownerAppIds : []).join(', ')}" aria-describedby="notify-app-ids-hint">
                                <p class="form-hint" id="notify-app-ids-hint">${this.ltrIn('settings.notify.echo.appIdsHint', { documented }, 'documented')}</p>
                            </div>
                        </fieldset>

                        <div class="form-actions">
                            ${UI.button({
                                variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                                label: t('settings.notify.save'), id: 'notify-settings-submit',
                            })}
                            ${UI.button({
                                variant: 'secondary', size: 'sm', icon: 'send',
                                label: t('settings.notify.test'), action: 'settings:testNotify', id: 'notify-test',
                            })}
                            ${token.set ? UI.button({
                                variant: 'secondary', size: 'sm', icon: 'trash-2',
                                label: t('settings.notify.removeToken'), action: 'settings:removeNotifyToken', id: 'notify-remove-token',
                            }) : ''}
                        </div>
                        <p class="form-hint">${t('settings.notify.testHint')}</p>
                        <div id="notify-test-result" aria-live="polite"></div>
                    </form>
                </div>
            </section>
        `;
    },

    showNotifyError(field, message) {
        const host = document.getElementById('notify-settings-error');
        const form = document.getElementById('notify-settings-form');
        if (form) UI.clearInvalid(form);
        if (!host) { UI.toast(message, 'error'); return; }
        const stripId = 'notify-settings-error-strip';
        host.innerHTML = esc(UI.errorStrip(message, '', stripId));
        UI.icons(host);
        const input = field && this.NOTIFY_FIELDS[field] ? document.getElementById(this.NOTIFY_FIELDS[field]) : null;
        if (input) UI.markInvalid(input, stripId);
        else if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    },

    async saveNotify(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const read = (name) => (data.get(name) || '').toString().trim();
        const host = document.getElementById('notify-settings-error');
        if (host) host.innerHTML = '';
        UI.clearInvalid(form);

        // A blank token is "keep it": it is never sent back to this page, so it cannot be re-sent. The two switches are always sent (a
        // cleared box is a real off), and so are the chat id and the app ids (an emptied field clears them).
        const telegram = { chatId: read('chatId'), enabled: data.get('enabled') !== null, hotLeads: data.get('hotLeads') !== null };
        const token = read('botToken');
        if (token) telegram.botToken = token;
        const payload = { telegram, echo: { takeover: data.get('takeover') !== null, ownerAppIds: read('ownerAppIds') } };

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveNotifySettings(payload);
            UI.toast(t('settings.notify.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            const field = err && err.body && err.body.field;
            const known = field && this.NOTIFY_FIELDS[field];
            this.showNotifyError(field, known ? t(`settings.notify.invalid.${field}`) : ((err && err.message) || t('error.unexpected')));
        }
    },

    /** What the server found when it tried the saved token and chat id: a strip that says so, in words, never the token. */
    notifyTestResult(r) {
        const result = r || {};
        if (result.ok) {
            return html`
                <span class="health-pill health-fresh">
                    <i data-lucide="check-circle" aria-hidden="true"></i>
                    ${t('settings.notify.test.ok')}
                </span>
            `;
        }
        const reason = ['not_configured', 'rejected', 'unreachable'].includes(result.reason) ? result.reason : 'unreachable';
        const status = Number.isFinite(Number(result.status)) && result.status !== null ? Number(result.status) : '';
        return UI.errorStrip(t(`settings.notify.test.${reason}`, { status }), result.description || '', 'notify-test-strip');
    },

    /** «أرسل رسالة تجريبية»: the server sends the message with what is SAVED, so a change has to be saved first (the card says so). */
    async testNotify(btn) {
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        const host = document.getElementById('notify-test-result');
        if (host) host.innerHTML = '';
        try {
            const result = await API.testNotify(I18N.lang === 'en' ? 'en' : 'ar');
            if (host) { host.innerHTML = esc(this.notifyTestResult(result)); UI.icons(host); }
        } catch (err) {
            if (host) {
                host.innerHTML = esc(UI.errorStrip(t('settings.notify.test.requestFailed'), (err && err.message) || '', 'notify-test-strip'));
                UI.icons(host);
            }
        } finally {
            restore();
        }
    },

    removeNotifyToken(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.notify.removeTitle'),
            body: t('settings.notify.removeBody'),
            hint: t('settings.notify.removeHint'),
            confirmLabel: t('settings.notify.removeToken'),
            confirmIcon: 'trash-2',
            onConfirm: () => SettingsPage.removeNotifyTokenConfirmed(),
        });
    },

    /** Alerts are switched off with the token: "on" with nothing to send with is refused by the server. */
    async removeNotifyTokenConfirmed() {
        await API.saveNotifySettings({ telegram: { botToken: null, enabled: false } });
        UI.toast(t('settings.notify.tokenRemoved'), 'success');
        await this.render();
    },

    // ─── Onboarding (platform admin): how invite links behave ─────────────────────────────────────────

    /** The field each input maps to, for marking the one a refusal names. */
    ONBOARDING_FIELDS: {
        inviteTtlDays: 'onboarding-ttl', resetTtlHours: 'onboarding-reset-ttl', sessionDays: 'onboarding-session-days',
        defaultRole: 'onboarding-role', inviterName: 'onboarding-inviter', whatsappText: 'onboarding-whatsapp', defaultRules: 'onboarding-rule-women',
        discoveryCreatorId: 'onboarding-discovery', youtubeApiKey: 'onboarding-yt-key',
    },

    onboardingSection(data, error) {
        if (error || !data) {
            return html`
                <section class="section">
                    <h2 class="section-title">${t('settings.onboarding.title')}</h2>
                    <div class="settings-card surface">
                        <div class="inline-error" role="alert">
                            <i data-lucide="alert-circle" aria-hidden="true"></i>
                            <div><strong dir="auto">${t('settings.onboarding.loadFailed', { message: (error && error.message) || '' })}</strong></div>
                        </div>
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'settings:render' })}
                    </div>
                </section>
            `;
        }
        const v = data.settings || {};
        const saved = data.saved || {};
        const limits = data.limits || {};
        const range = (key) => limits[key] || { min: 1, max: 90, fallback: 7 };
        const shown = (name, value) => (saved[name] ? value : '');
        const womenRule = Array.isArray(v.defaultRules) && v.defaultRules.includes('no_women_imagery');
        const defaults = data.whatsappDefaults || {};
        return html`
            <section class="section">
                <h2 class="section-title">${t('settings.onboarding.title')}</h2>
                <div class="settings-card surface">
                    <p class="form-hint mbe-4">${t('settings.onboarding.intro')}</p>
                    <div id="onboarding-settings-error"></div>
                    <form id="onboarding-settings-form" data-submit="settings:saveOnboardingSettings" novalidate>
                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label" for="onboarding-ttl">${t('settings.onboarding.inviteTtl')}</label>
                                <input class="field" id="onboarding-ttl" name="inviteTtlDays" type="number" inputmode="numeric" dir="ltr"
                                       min="${range('inviteTtlDays').min}" max="${range('inviteTtlDays').max}" step="1"
                                       placeholder="${range('inviteTtlDays').fallback}" value="${shown('inviteTtlDays', v.inviteTtlDays)}"
                                       aria-describedby="onboarding-ttl-hint">
                                <p class="form-hint" id="onboarding-ttl-hint">${t('settings.onboarding.inviteTtlHint', { days: range('inviteTtlDays').fallback })}</p>
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="onboarding-reset-ttl">${t('settings.onboarding.resetTtl')}</label>
                                <input class="field" id="onboarding-reset-ttl" name="resetTtlHours" type="number" inputmode="numeric" dir="ltr"
                                       min="${range('resetTtlHours').min}" max="${range('resetTtlHours').max}" step="1"
                                       placeholder="${range('resetTtlHours').fallback}" value="${shown('resetTtlHours', v.resetTtlHours)}"
                                       aria-describedby="onboarding-reset-ttl-hint">
                                <p class="form-hint" id="onboarding-reset-ttl-hint">${t('settings.onboarding.resetTtlHint', { hours: range('resetTtlHours').fallback })}</p>
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="onboarding-session-days">${t('settings.onboarding.sessionDays')}</label>
                                <input class="field" id="onboarding-session-days" name="sessionDays" type="number" inputmode="numeric" dir="ltr"
                                       min="${range('sessionDays').min}" max="${range('sessionDays').max}" step="1"
                                       placeholder="${range('sessionDays').fallback}" value="${shown('sessionDays', v.sessionDays)}"
                                       aria-describedby="onboarding-session-days-hint">
                                <p class="form-hint" id="onboarding-session-days-hint">${t('settings.onboarding.sessionDaysHint', { days: range('sessionDays').fallback })}</p>
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="onboarding-role">${t('settings.onboarding.role')}</label>
                                <select class="select" id="onboarding-role" name="defaultRole">
                                    ${Admin.TENANT_ROLES.map((role) => html`<option value="${role}" ${role === (v.defaultRole || 'owner') ? html.raw('selected') : ''}>${t(`roles.${role}`)}</option>`)}
                                </select>
                                <p class="form-hint">${t('settings.onboarding.roleHint')}</p>
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="onboarding-inviter">
                                ${t('settings.onboarding.inviter')} <span class="label-optional">${t('common.optional')}</span>
                            </label>
                            <input class="field" id="onboarding-inviter" name="inviterName" type="text" dir="auto" maxlength="80" autocomplete="off"
                                   value="${shown('inviterName', v.inviterName || '')}" aria-describedby="onboarding-inviter-hint">
                            <p class="form-hint" id="onboarding-inviter-hint">${t('settings.onboarding.inviterHint')}</p>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="onboarding-whatsapp">
                                ${t('settings.onboarding.whatsapp')} <span class="label-optional">${t('common.optional')}</span>
                            </label>
                            <textarea class="field-textarea" id="onboarding-whatsapp" name="whatsappText" rows="3" maxlength="600" dir="auto"
                                      placeholder="${defaults[I18N.lang] || defaults.ar || ''}" aria-describedby="onboarding-whatsapp-hint">${shown('whatsappText', v.whatsappText || '')}</textarea>
                            <p class="form-hint" id="onboarding-whatsapp-hint">${t('settings.onboarding.whatsappHint')}</p>
                        </div>
                        <fieldset class="onboarding-rules">
                            <legend class="form-label">${t('settings.onboarding.rules')}</legend>
                            <div class="check-row">
                                <input type="checkbox" id="onboarding-rule-women" name="rule" value="no_women_imagery" ${womenRule ? html.raw('checked') : ''}>
                                <div class="check-text">
                                    <label class="check-label" for="onboarding-rule-women">${t('settings.onboarding.ruleWomen')}</label>
                                    <p class="form-hint">${t('settings.onboarding.rulesHint')}</p>
                                </div>
                            </div>
                        </fieldset>
                        ${this.draftSourcesGroup(data.draftSources)}
                        <div class="form-actions">
                            ${UI.button({
                                variant: 'primary', size: 'sm', type: 'submit', icon: 'save',
                                label: t('settings.onboarding.save'), id: 'onboarding-settings-submit',
                            })}
                        </div>
                    </form>
                </div>
            </section>
        `;
    },

    /**
     * What reads a new tenant's public accounts (the profile draft, docs/onboarding/03 §1): the tenant whose connected Instagram account reads other
     * people's profiles, and the YouTube Data API key. The key is a secret and the server never sends it back: only whether one is set, where it
     * comes from and its last four characters. An empty key field means "leave it"; the tick removes it. Nothing is rendered for a server that
     * does not describe them (an older deployment), so the rest of the card works as before.
     */
    draftSourcesGroup(sources) {
        if (!sources || !sources.youtubeApiKey || !sources.discovery) return '';
        const key = sources.youtubeApiKey;
        const discovery = sources.discovery;
        const tenants = Array.isArray(sources.tenants) ? sources.tenants : [];
        const chosen = discovery.source === 'setting' ? discovery.creatorId : '';
        const keyHint = key.set
            ? t(key.source === 'env' ? 'settings.onboarding.ytKeyEnv' : 'settings.onboarding.ytKeySaved', { last4: key.last4 || '••••' })
            : t('settings.onboarding.ytKeyNone');
        return html`
            <fieldset class="onboarding-rules onboarding-sources">
                <legend class="form-label">${t('settings.onboarding.sources.title')}</legend>
                <p class="form-hint mbe-3">${t('settings.onboarding.sources.intro')}</p>
                <div class="form-group">
                    <label class="form-label" for="onboarding-discovery">${t('settings.onboarding.discovery')}</label>
                    <select class="select" id="onboarding-discovery" name="discoveryCreatorId" aria-describedby="onboarding-discovery-hint">
                        <option value="" ${chosen === '' ? html.raw('selected') : ''}>${t('settings.onboarding.discoveryOwner')}</option>
                        ${tenants.map((tenant) => html`<option value="${tenant.id}" ${tenant.id === chosen ? html.raw('selected') : ''}>${tenant.name || tenant.id}${tenant.connected ? '' : html` · ${t('settings.onboarding.notConnected')}`}</option>`)}
                    </select>
                    <p class="form-hint" id="onboarding-discovery-hint">${t('settings.onboarding.discoveryHint')}</p>
                    ${discovery.creatorId && !discovery.connected ? html`<p class="form-hint text-warning" role="status">${t('settings.onboarding.discoveryUnconnected')}</p>` : ''}
                </div>
                <div class="form-group">
                    <label class="form-label" for="onboarding-yt-key">${t('settings.onboarding.ytKey')}</label>
                    <input class="field field-mono" id="onboarding-yt-key" name="youtubeApiKey" type="password" dir="ltr" maxlength="256"
                           autocomplete="new-password" spellcheck="false" placeholder="AIza…" aria-describedby="onboarding-yt-key-hint">
                    <p class="form-hint" id="onboarding-yt-key-hint">${keyHint}</p>
                    <p class="form-hint">${t('settings.onboarding.ytKeyHint')}</p>
                    ${key.set && key.source === 'database' ? html`
                        <div class="check-row">
                            <input type="checkbox" id="onboarding-yt-key-clear" name="clearYoutubeApiKey">
                            <div class="check-text"><label class="check-label" for="onboarding-yt-key-clear">${t('settings.onboarding.ytKeyClear')}</label></div>
                        </div>
                    ` : ''}
                </div>
            </fieldset>
        `;
    },

    showOnboardingError(field, message) {
        const host = document.getElementById('onboarding-settings-error');
        const form = document.getElementById('onboarding-settings-form');
        if (form) UI.clearInvalid(form);
        if (!host) { UI.toast(message, 'error'); return; }
        const stripId = 'onboarding-settings-error-strip';
        host.innerHTML = esc(UI.errorStrip(message, '', stripId));
        UI.icons(host);
        const input = field && this.ONBOARDING_FIELDS[field] ? document.getElementById(this.ONBOARDING_FIELDS[field]) : null;
        if (input) UI.markInvalid(input, stripId);
        else if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    },

    async saveOnboardingSettings(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const read = (name) => (data.get(name) || '').toString().trim();
        const host = document.getElementById('onboarding-settings-error');
        if (host) host.innerHTML = '';
        UI.clearInvalid(form);

        // Every field is always sent: an emptied one is a real "back to the default". The rules are an explicit list, so an
        // unticked box is a deliberate "none" and not a missing field. The server checks again and has the last word.
        const payload = {
            inviteTtlDays: read('inviteTtlDays'),
            resetTtlHours: read('resetTtlHours'),
            sessionDays: read('sessionDays'),
            defaultRole: read('defaultRole'),
            inviterName: read('inviterName'),
            whatsappText: read('whatsappText'),
            defaultRules: data.getAll('rule').map((value) => value.toString()),
        };
        // The draft's sources (when the card has them): the reading tenant is always sent (empty is "the owner's tenant"); the key only when typed,
        // or `null` when the tick removes the saved one. A blank key field means "leave it": the saved key is never sent to the page, so never back.
        if (form.elements.discoveryCreatorId) payload.discoveryCreatorId = read('discoveryCreatorId');
        const youtubeKey = read('youtubeApiKey');
        if (youtubeKey) payload.youtubeApiKey = youtubeKey;
        else if (data.get('clearYoutubeApiKey')) payload.youtubeApiKey = null;
        if (payload.whatsappText && !payload.whatsappText.includes('{link}')) {
            this.showOnboardingError('whatsappText', t('settings.onboarding.invalid.whatsappText'));
            return;
        }

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveOnboardingSettings(payload);
            UI.toast(t('settings.onboarding.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            const field = err && err.body && err.body.field;
            const known = field && this.ONBOARDING_FIELDS[field];
            this.showOnboardingError(field, known ? t(`settings.onboarding.invalid.${field}`) : ((err && err.message) || t('error.unexpected')));
        }
    },

    async saveMediaStorage(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const payload = { url: (data.get('url') || '').toString().trim() };
        // A blank key means "leave it" — it is never sent back to the page.
        const key = (data.get('key') || '').toString().trim();
        if (key) payload.key = key;

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveMediaStorage(payload);
            UI.toast(t('settings.media.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message, 'error');
        }
    },

    removeMediaStorage(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.media.removeTitle'),
            body: t('settings.media.removeBody'),
            hint: t('settings.media.removeHint'),
            confirmLabel: t('settings.media.remove'),
            confirmIcon: 'trash-2',
            onConfirm: () => SettingsPage.removeMediaStorageConfirmed(),
        });
    },

    /** A refusal (409: files still in Storage) is shown inside the dialog, which stays open. */
    async removeMediaStorageConfirmed() {
        await API.removeMediaStorage();
        UI.toast(t('settings.media.removed'), 'success');
        await this.render();
    },

    /**
     * The session lives in localStorage, so the connect flow cannot be a plain
     * link: this asks the server (authenticated) for TikTok's authorise URL,
     * which also sets the single-use state cookie, and only then navigates.
     */
    async connectTikTok(btn) {
        if (!btn || btn.disabled) return;
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        try {
            const { url } = await API.startTikTokConnect();
            window.location.href = url;
        } catch (err) {
            restore();
            UI.toast(err.message || t('settings.tiktok.return.generic'), 'error');
        }
    },

    disconnectTikTok(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.tiktok.disconnectTitle'),
            body: t('settings.tiktok.disconnectBody'),
            hint: t('settings.tiktok.disconnectHint'),
            confirmLabel: t('settings.tiktok.disconnect'),
            confirmIcon: 'unlink',
            onConfirm: () => SettingsPage.disconnectTikTokConfirmed(),
        });
    },

    /**
     * A rejection here is shown inside the confirm dialog, which stays open
     * (Admin.runConfirm) — so no toast of its own on failure.
     */
    async disconnectTikTokConfirmed() {
        await API.disconnectTikTok();
        UI.toast(t('settings.tiktok.disconnected'), 'success');
        await this.render();
    },

    async saveTikTokApp(form, event) {
        event.preventDefault();
        const data = new FormData(form);
        const payload = {
            clientKey: (data.get('clientKey') || '').toString().trim(),
            publicBaseUrl: (data.get('publicBaseUrl') || '').toString().trim(),
            // Always sent, as booleans: an unticked box is a real "no", and
            // FormData would otherwise omit it.
            directPostEnabled: data.get('directPostEnabled') === 'on',
            audited: data.get('audited') === 'on',
            profileScopeEnabled: data.get('profileScopeEnabled') === 'on',
        };
        // A blank secret means "leave it", not "clear it" — it is never sent
        // back to the page, so the field is always blank on load.
        const secret = (data.get('clientSecret') || '').toString().trim();
        if (secret) payload.clientSecret = secret;
        const verifyName = (data.get('verificationFilename') || '').toString().trim();
        const verifyContent = (data.get('verificationContent') || '').toString().trim();
        if (verifyContent) {
            payload.verificationFilename = verifyName;
            payload.verificationContent = verifyContent;
        }

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            await API.saveTikTokAppSettings(payload);
            UI.toast(t('settings.tiktok.app.saved'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message, 'error');
        }
    },

    /**
     * Both token forms were unguarded: submit twice on a cold serverless start
     * and the second POST overwrote the first with the same credential — or,
     * worse, raced the extend endpoint. `UI.formBusy` disables the button and
     * returns null if it was ALREADY disabled, which is the double-submit.
     */
    async handleWebhookTokenUpdate(form, event) {
        event.preventDefault();
        const token = (new FormData(form).get('token') || '').toString().trim();
        if (!token) return;

        // Captured BEFORE the button is disabled: disabling the focused element
        // blurs it, so by the time render() runs there is nothing to remember.
        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // a submit is already in flight

        try {
            const result = await API.updateWebhookToken(token);
            UI.toast(result.message || t('settings.webhookSaved'), 'success');
            // render() replaces the form, so the restore would be writing to a
            // detached button — and it must not run before the re-render puts
            // a fresh, enabled one on screen.
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message || t('settings.webhookSaveFailed'), 'error');
        }
    },

    async handleTokenUpdate(form, event) {
        event.preventDefault();
        const token = (new FormData(form).get('token') || '').toString().trim();
        if (!token) return;

        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // a submit is already in flight

        try {
            const result = await API.updateToken(token);
            UI.toast(t('settings.tokenUpdated', {
                date: result.expiresAt ? UI.formatDay(result.expiresAt) : t('common.never'),
            }));
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            restore();
            UI.toast(err.message, 'error');
        }
    },

    /**
     * Ask first, in the product's own dialog — and NOT in red.
     *
     * Extending the token is consequential enough to confirm but destroys
     * nothing, so it passes tone: 'primary'. The hint carries the part that is
     * genuinely not obvious: Meta does not revoke the existing token when it
     * issues a new one.
     */
    extendToken(btn) {
        if (!btn || btn.disabled) return;
        Admin.confirm({
            title: t('settings.extendTitle'),
            body: t('settings.extendConfirm'),
            hint: t('settings.extendHint'),
            confirmLabel: t('settings.extend'),
            confirmIcon: 'key-round',
            tone: 'primary',
            onConfirm: () => SettingsPage.extendTokenConfirmed(btn),
        });
    },

    async extendTokenConfirmed(btn) {
        // Same reason as the two forms: disabling it blurs it, so the token is
        // taken first. `UI.actionBusy` replaces the hand-rolled version, which
        // set no `aria-busy` and called `buttonSpinner()` with no argument —
        // that falls back to "Loading", so the button both changed its label to
        // something meaningless and grew wide enough to shove the expiry line
        // beside it sideways. actionBusy keeps the button's own name for
        // assistive technology and pins the width it already had.
        const focus = UI.captureFocus(document.getElementById('page-container'));
        const restore = UI.actionBusy(btn);
        if (!restore) return; // already in flight

        try {
            await API.request('/settings/token/extend', { method: 'POST' });
            UI.toast(t('settings.extended'), 'success');
            await this.render();
            UI.restoreFocus(focus);
        } catch (err) {
            console.error(err);
            UI.toast(err.message || t('settings.extendFailed'), 'error');
            restore();
        }
    },
};

UI.registerActions('settings', {
    render: () => SettingsPage.render(),
    extendToken: (el) => SettingsPage.extendToken(el),
    handleTokenUpdate: (el, e) => SettingsPage.handleTokenUpdate(el, e),
    handleWebhookTokenUpdate: (el, e) => SettingsPage.handleWebhookTokenUpdate(el, e),
    connectTikTok: (el) => SettingsPage.connectTikTok(el),
    disconnectTikTok: (el) => SettingsPage.disconnectTikTok(el),
    saveTikTokApp: (el, e) => SettingsPage.saveTikTokApp(el, e),
    connectYouTube: (el) => SettingsPage.connectYouTube(el),
    disconnectYouTube: (el) => SettingsPage.disconnectYouTube(el),
    saveYouTubeApp: (el, e) => SettingsPage.saveYouTubeApp(el, e),
    readYouTubeJson: (el) => SettingsPage.readYouTubeJson(el),
    saveMediaStorage: (el, e) => SettingsPage.saveMediaStorage(el, e),
    toggleMediaCleanup: (el) => SettingsPage.toggleMediaCleanup(el),
    cleanUpMedia: (el) => SettingsPage.cleanUpMedia(el),
    removeMediaStorage: (el) => SettingsPage.removeMediaStorage(el),
    testWebhook: (el) => SettingsPage.testWebhook(el),
    previewDirectPost: (el) => SettingsPage.previewDirectPost(el),
    previewWhatsapp: (el) => SettingsPage.previewWhatsapp(el),
    saveSiteSettings: (el, e) => SettingsPage.saveSiteSettings(el, e),
    saveNotify: (el, e) => SettingsPage.saveNotify(el, e),
    testNotify: (el) => SettingsPage.testNotify(el),
    removeNotifyToken: (el) => SettingsPage.removeNotifyToken(el),
    saveOnboardingSettings: (el, e) => SettingsPage.saveOnboardingSettings(el, e),
});
