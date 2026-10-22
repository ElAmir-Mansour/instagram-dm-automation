/**
 * Ads → Create (`#/ads_create`): the FULL ad builder (Meta Ads Manager A5, task T111). Boost on Posts is the builder's QUICK mode
 * (`ads_builder.js`, a dialog); this is the same `CampaignSpec`, every part of it, one step at a time.
 *
 * ─── The eight steps, the same whatever the goal (spec Story 4) ─────────────────────────────────────────────────────────────
 *   1. goal         messages, engagement, reach or traffic (lead ads are shown, locked until A10). Only what is valid for the goal is
 *                   offered later, each choice with one plain sentence.
 *   2. destination  messages: Instagram / Messenger / WhatsApp. Traffic: one of the owner's offers as a TRACKED link (the default, so
 *                   clicks are counted), or a free address (warned). Engagement and reach run on the post itself.
 *   3. creative     a published post, or an upload: signed straight to Storage (`PUT` with a progress bar, never through this app: Vercel
 *                   takes 4.5 MB), then handed to Meta (`/creatives/from-media`). A video needs a cover (its first frame is black). An
 *                   optional 9:16 version for Stories, for uploads only (Meta does not customise an existing post).
 *   4. copy         primary text (Feed cuts it at 125 characters), headline, the button; a message ad's greeting and ice breakers.
 *                   Checked by the policy check after a pause, as in quick mode.
 *   5. audience     countries, cities with a radius, age, gender, languages, interests, Meta's Advantage audience (minimum age 18–25, no
 *                   maximum), the special category (which narrows targeting).
 *   6. placements   automatic (recommended) or chosen; Instagram Explore and Messenger Stories are never offered (Meta removed them).
 *   7. budget       on the campaign or the ad set, daily or total, start and end; a schedule (days and hours) only with a total budget.
 *                   The money rule (`/ads/money`) and Meta's minimum are shown beside the amount.
 *   8. review       `/drafts/validate`: the policy findings, Meta's own validation, the money, the reach estimate and a preview per
 *                   placement (Meta's iframe, or an "approximate preview" drawn here when Meta will not preview for this token). Create
 *                   sends exactly what was reviewed, PAUSED.
 *
 * ─── The rules this file keeps (the same as quick mode) ───────────────────────────────────────────────────────────────────────
 *   - The server decides (policy, caps, minimums, what Meta accepts); the checks here only say which field before a round trip.
 *   - Create sends only what was REVIEWED: any change after Review drops it.
 *   - Everything typed, and everything the server or Meta said, goes through `html`. Meta's preview is never inserted as markup: only its
 *     iframe address is taken, and only when it is on www.facebook.com.
 *   - No image of a person is ever drawn here: the mock's avatar is the Page's initial (owner rule).
 */
const AdsCreatePage = {
    STEPS: Object.freeze(['goal', 'destination', 'creative', 'copy', 'audience', 'placements', 'budget', 'review']),
    /** The goals, in the order offered. `leads` is shown locked. */
    GOALS: Object.freeze(['messages', 'traffic', 'engagement', 'reach', 'leads']),
    LOCKED_GOALS: Object.freeze(['leads']),
    DESTINATIONS: Object.freeze(['instagram', 'messenger', 'whatsapp']),
    /** What each goal may optimise for, the default first (spec.ts OPTIMIZATION_CHOICES). */
    OPTIMIZATION: Object.freeze({
        messages: ['CONVERSATIONS'], engagement: ['POST_ENGAGEMENT', 'THRUPLAY'], reach: ['REACH', 'IMPRESSIONS'], traffic: ['LINK_CLICKS', 'LANDING_PAGE_VIEWS'],
    }),
    /** The buttons a link-click ad may carry. A message ad's button is its destination's; a post's is its own. */
    CTAS: Object.freeze(['LEARN_MORE', 'SIGN_UP', 'SUBSCRIBE', 'SHOP_NOW', 'GET_OFFER']),
    /** The positions offered (spec.ts PLACEMENT_OPTIONS). No Explore, no video feeds, no Messenger Stories: Meta removed them. */
    PLACEMENTS: Object.freeze({
        instagram: ['stream', 'story', 'reels', 'profile_feed', 'ig_search'],
        facebook: ['feed', 'story', 'facebook_reels', 'marketplace', 'search'],
    }),
    SPECIAL: Object.freeze(['none', 'employment', 'financial', 'housing', 'political']),
    IMAGE_TYPES: Object.freeze(['image/jpeg', 'image/png']),
    VIDEO_TYPES: Object.freeze(['video/mp4', 'video/quicktime']),
    IMAGE_MAX: 30 * 1024 * 1024,
    VIDEO_MAX: 50 * 1024 * 1024,
    FEED_CUT: 125,
    RADIUS_MIN: 17,
    RADIUS_MAX: 80,
    SEARCH_DEBOUNCE_MS: 350,
    POLICY_DEBOUNCE_MS: 400,
    ICE_MAX: 4,
    /** The help section of each step. */
    HELP: Object.freeze({
        goal: 'ads#builder', destination: 'ads#builder', creative: 'ads#creatives', copy: 'ads#policy-check', audience: 'ads#targeting',
        placements: 'ads#targeting', budget: 'ads#budgets-and-schedule', review: 'ads#builder',
    }),

    /** 'loading' | 'ready' | 'forbidden' | 'disabled' | 'unconfigured' | 'failed' */
    view: 'loading',
    state: null,
    _seq: 0,

    // ─── The state ────────────────────────────────────────────────────────────────────────

    /** A fresh builder. `preset` (from quick mode, or `{ spec }` from an AI proposal's "Edit in builder") fills any part of it. */
    fresh(preset) {
        const p = preset || {};
        const now = new Date(Date.now() + 15 * 60_000);
        const end = new Date(now.getTime() + 5 * 86_400_000);
        const st = {
            step: 0,
            name: p.name || '',
            goal: p.goal && this.GOALS.includes(p.goal) && !this.LOCKED_GOALS.includes(p.goal) ? p.goal : 'traffic',
            destinations: ['instagram'],
            optimization: '',
            link: { mode: 'offer', offerId: '', url: '' },
            source: p.postId ? 'post' : 'media',
            postId: p.postId || '',
            platform: p.platform || 'instagram',
            media: null, cover: null, vertical: null, verticalCover: null, wantVertical: false,
            primaryText: '', headline: '', cta: 'LEARN_MORE',
            greeting: '', ice: [],
            countries: (p.countries && p.countries.length ? p.countries : ['EG', 'SA']).join(', '),
            cities: [], ageMin: '18', ageMax: '', gender: 'all', locales: [], interests: [], advantage: true, includeAudiences: [], excludeAudiences: [],
            special: 'none',
            placementMode: 'automatic', placements: { instagram: [], facebook: [] },
            home: 'adset', kind: 'lifetime', amount: p.amount ? String(p.amount) : '', start: this.localInput(now), end: this.localInput(end),
            scheduled: false, days: [0, 1, 2, 3, 4, 5, 6], fromHour: '18', toHour: '23',
            policy: null, policySeq: 0, policyTimer: null,
            review: null, reviewing: false, ack: false, busy: false, rev: 0,
            search: { type: null, q: '', items: [], seq: 0, timer: null },
            errors: Object.create(null),
        };
        if (p.spec && typeof p.spec === 'object') this.applySpec(st, p.spec);
        if (p.proposalId) st.proposalId = String(p.proposalId);
        return st;
    },

    /**
     * A whole `CampaignSpec` (an AI proposal, A7) laid over a fresh builder: the first ad set's audience and the first ad's creative and copy,
     * which is all a proposal drafts. Anything it does not name keeps the builder's default; the owner reviews every step before Create.
     */
    applySpec(st, spec) {
        const set = Array.isArray(spec.adsets) && spec.adsets[0] ? spec.adsets[0] : null;
        const ad = Array.isArray(spec.ads) && spec.ads[0] ? spec.ads[0] : null;
        if (typeof spec.name === 'string') st.name = spec.name;
        if (spec.goal && this.GOALS.includes(spec.goal) && !this.LOCKED_GOALS.includes(spec.goal)) st.goal = spec.goal;
        if (Array.isArray(spec.destinations) && spec.destinations.length) st.destinations = spec.destinations.filter((d) => this.DESTINATIONS.includes(d));
        if (['none', 'employment', 'financial', 'housing', 'political'].includes(spec.specialCategory)) st.special = spec.specialCategory;
        const b = spec.budget || {};
        if (b.home === 'campaign' || b.home === 'adset') st.home = b.home;
        if (b.kind === 'daily' || b.kind === 'lifetime') st.kind = b.kind;
        if (typeof b.amount === 'number' && b.amount > 0) st.amount = String(b.amount);
        const startAt = Date.parse(b.start);
        if (Number.isFinite(startAt) && startAt > Date.now()) st.start = this.localInput(new Date(startAt));
        const endAt = Date.parse(b.end);
        if (Number.isFinite(endAt)) st.end = this.localInput(new Date(endAt));
        if (set && set.targeting) {
            const tg = set.targeting;
            if (Array.isArray(tg.countries) && tg.countries.length) st.countries = tg.countries.join(', ');
            if (Number.isFinite(tg.ageMin)) st.ageMin = String(tg.ageMin);
            st.ageMax = Number.isFinite(tg.ageMax) ? String(tg.ageMax) : '';
            st.gender = Array.isArray(tg.genders) && tg.genders.length === 1 ? (tg.genders[0] === 1 ? 'men' : 'women') : 'all';
            st.advantage = tg.advantageAudience !== false;
            if (Array.isArray(tg.includeAudiences)) st.includeAudiences = tg.includeAudiences.map(String);
            if (Array.isArray(tg.excludeAudiences)) st.excludeAudiences = tg.excludeAudiences.map(String);
        }
        if (set && set.placements === 'automatic') st.placementMode = 'automatic';
        if (ad) {
            if (ad.creative && ad.creative.source === 'post') {
                st.source = 'post';
                st.postId = String(ad.creative.postId || '');
                st.platform = ad.creative.platform === 'facebook' ? 'facebook' : 'instagram';
            }
            const copy = ad.copy || {};
            if (typeof copy.primaryText === 'string') st.primaryText = copy.primaryText;
            if (typeof copy.headline === 'string') st.headline = copy.headline;
            if (typeof copy.cta === 'string' && copy.cta) st.cta = copy.cta;
            if (ad.message) {
                st.greeting = typeof ad.message.greeting === 'string' ? ad.message.greeting : '';
                st.ice = (Array.isArray(ad.message.iceBreakers) ? ad.message.iceBreakers : []).slice(0, this.ICE_MAX || 4).map((x) => ({ title: String((x && x.title) || '') }));
            }
            if (ad.link && ad.link.trackedOfferId) st.link = { mode: 'offer', offerId: String(ad.link.trackedOfferId), url: '' };
            else if (ad.link && ad.link.url) st.link = { mode: 'url', offerId: '', url: String(ad.link.url) };
        }
    },

    /** `YYYY-MM-DDTHH:MM` in local time, for a datetime-local input. */
    localInput(d) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    // ─── Page lifecycle ───────────────────────────────────────────────────────────────────

    async render() {
        if (typeof App !== 'undefined' && typeof App.loadPageCss === 'function' && typeof App.entryOf === 'function') {
            await App.loadPageCss('ads', App.entryOf('ads'));
        }
        if (typeof App !== 'undefined' && typeof App.loadPageModule === 'function') {
            // The tab bar and quick mode's policy drawing are shared: both modules are loaded with this one.
            try { await App.loadPageModule('ads_campaigns'); } catch (err) { /* the bar is optional */ }
            try { await App.loadPageModule('ads_builder'); } catch (err) { /* findings fall back to plain text */ }
        }
        return this.load();
    },

    destroy() {
        this._seq++;
        this.dispose();
    },

    dispose() {
        const st = this.state;
        if (st) {
            if (st.policyTimer) clearTimeout(st.policyTimer);
            if (st.search.timer) clearTimeout(st.search.timer);
            [st.media, st.cover, st.vertical, st.verticalCover].forEach((m) => { if (m && m.preview && typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(m.preview); });
        }
        this.state = null;
    },

    host(id) {
        return document.getElementById(id || 'page-container');
    },

    /** The settings (money, currency), the minimum, the owner's offers and the published posts, read once. */
    async load() {
        const container = this.host();
        if (!container) return false;
        const seq = ++this._seq;
        let settings;
        try {
            settings = await API.getAdsSettings();
        } catch (err) {
            if (seq !== this._seq) return false;
            this.view = err && err.status === 404 ? 'disabled' : err && err.status === 403 ? 'forbidden' : 'failed';
            this.failure = err;
            this.paint();
            return false;
        }
        if (seq !== this._seq) return false;
        if (!settings || settings.configured === false) {
            this.view = 'unconfigured';
            this.paint();
            return false;
        }
        const [min, profile, posts] = await Promise.all([
            API.getAdsMinimumBudgets().catch(() => null),
            API.getProfile().catch(() => null),
            API.getScheduledPosts().catch(() => []),
        ]);
        if (seq !== this._seq) return false;
        this.settings = settings;
        this.currency = (settings.account && settings.account.currency) || (min && min.currency) || '';
        this.minimum = min && min.byGoal ? min.byGoal : {};
        this.offers = (profile && profile.profile && Array.isArray(profile.profile.offers) ? profile.profile.offers : []).filter((o) => o && o.id && o.url);
        this.posts = (Array.isArray(posts) ? posts : []).filter((p) => p && p.status === 'PUBLISHED' && p.published_post_id);
        this.dispose();
        this.state = this.fresh(this.preset || null);
        this.preset = null;
        if (this.offers.length) { if (!this.state.link.offerId) this.state.link.offerId = String(this.offers[0].id); } else this.state.link.mode = 'url';
        this.view = 'ready';
        this.paint();
        this.loadMoney();
        return true;
    },

    /** Opened with a preset (quick mode's "more options", or `{ spec, proposalId }` from an AI proposal's "Edit in builder"). */
    openWith(preset) {
        this.preset = preset || null;
        if (typeof location !== 'undefined') location.hash = '#/ads_create';
    },

    // ─── Painting ─────────────────────────────────────────────────────────────────────────

    paint() {
        const container = this.host();
        if (!container) return;
        const focus = UI.captureFocus ? UI.captureFocus(container) : null;
        container.innerHTML = esc(this.markup());
        UI.icons(container);
        if (focus && UI.restoreFocus) UI.restoreFocus(focus);
        this.mountAudiencePickers();
    },

    /** One region, redrawn in place (a step's panel, the policy, the money line). */
    write(id, markup) {
        const host = this.host(id);
        if (!host) return null;
        host.innerHTML = markup === '' ? '' : esc(markup);
        if (markup !== '') UI.icons(host);
        return host;
    },

    markup() {
        const header = UI.pageHeader({ title: t('adsCreate.title'), subtitle: t('adsCreate.subtitle') });
        const tabs = typeof AdsTabs !== 'undefined' && this.view !== 'forbidden' && this.view !== 'disabled' ? AdsTabs.markup('create') : '';
        if (this.view === 'loading') return html`${tabs}${header}${typeof Motion !== 'undefined' ? Motion.busy() : ''}`;
        if (this.view === 'forbidden') return html`${header}${UI.emptyState({ icon: 'lock', title: t('ads.owner.title'), body: t('ads.owner.body') })}`;
        if (this.view === 'disabled') return html`${header}${UI.emptyState({ icon: 'lock', title: t('ads.disabled.title'), body: t('ads.disabled.body') })}`;
        if (this.view === 'unconfigured') {
            return html`${tabs}${header}${UI.emptyState({
                icon: 'megaphone', title: t('ads.notConfigured.title'), body: t('ads.notConfigured.body'),
                action: { label: t('ads.notConfigured.cta'), href: '#/settings?s=ads', icon: 'settings' },
            })}`;
        }
        if (this.view === 'failed') {
            return html`${tabs}${header}${UI.emptyState({ icon: 'alert-circle', title: t('ads.loadFailed'), body: (this.failure && this.failure.message) || t('error.unexpected') })}`;
        }
        const st = this.state;
        return html`
            <div id="adsc-page" class="ads-page adsc-page">
                ${tabs}
                ${header}
                <p class="form-hint" id="adsc-paused-note"><i data-lucide="info" aria-hidden="true"></i> ${t('adsCreate.pausedNote')}</p>
                <div id="adsc-stepper">${this.stepperMarkup(st)}</div>
                <section class="surface adsc-step" id="adsc-step" aria-labelledby="adsc-step-title">
                    ${this.stepMarkup(st)}
                </section>
                <div class="adsc-nav" id="adsc-nav">${this.navMarkup(st)}</div>
            </div>
        `;
    },

    stepperMarkup(st) {
        return html`
            <ol class="adsc-stepper" aria-label="${t('adsCreate.steps.label')}">
                ${this.STEPS.map((key, i) => html`
                    <li class="adsc-stepper-item ${i === st.step ? html.raw('is-current') : i < st.step ? html.raw('is-done') : ''}" data-step="${key}"
                        ${i === st.step ? html.raw('aria-current="step"') : ''}>
                        <span class="adsc-stepper-n" aria-hidden="true">${i + 1}</span>
                        <span>${t(`adsCreate.step.${key}`)}</span>
                    </li>`)}
            </ol>
        `;
    },

    navMarkup(st) {
        const last = st.step === this.STEPS.length - 1;
        const back = st.step > 0 ? UI.button({ variant: 'ghost', icon: 'chevron-left', label: t('adsCreate.back'), action: 'adsc:back', focusKey: 'adsc-back' }) : '';
        const next = last
            ? UI.button({ variant: 'primary', icon: 'check', label: t('adsCreate.create'), action: 'adsc:create', focusKey: 'adsc-create', disabled: !this.canCreate(st), busy: st.busy })
            : UI.button({ variant: 'primary', icon: 'chevron-right', label: t('adsCreate.next'), action: 'adsc:next', focusKey: 'adsc-next' });
        return html`${back}${next}<p class="form-error" id="adsc-error" role="alert" aria-live="assertive"></p>`;
    },

    stepMarkup(st) {
        const key = this.STEPS[st.step];
        const body = {
            goal: () => this.goalMarkup(st), destination: () => this.destinationMarkup(st), creative: () => this.creativeMarkup(st),
            copy: () => this.copyMarkup(st), audience: () => this.audienceMarkup(st), placements: () => this.placementsMarkup(st),
            budget: () => this.budgetMarkup(st), review: () => this.reviewStepMarkup(st),
        }[key]();
        return html`
            <div class="adsc-step-head">
                <h3 class="adsb-subtitle" id="adsc-step-title">${st.step + 1}. ${t(`adsCreate.step.${key}`)}</h3>
                ${UI.helpLink(this.HELP[key], t(`adsCreate.help.${key}`))}
            </div>
            ${body}
        `;
    },

    repaintStep() {
        const st = this.state;
        if (!st) return;
        this.write('adsc-step', this.stepMarkup(st));
        const nav = this.host('adsc-nav');
        if (nav) { nav.innerHTML = esc(this.navMarkup(st)); UI.icons(nav); }
        this.write('adsc-stepper', this.stepperMarkup(st));
        this.mountAudiencePickers();
    },

    /** The include / exclude pickers of the audience step (A8, `AdsAudiencePicker` in ads_audiences.js, loaded on first use). */
    async mountAudiencePickers() {
        const st = this.state;
        if (!st || this.STEPS[st.step] !== 'audience' || !this.host('adsc-aud-include')) return;
        if (typeof AdsAudiencePicker === 'undefined' && typeof App !== 'undefined' && typeof App.loadPageModule === 'function') {
            try { await App.loadPageModule('ads_audiences'); } catch { return; }
        }
        if (typeof AdsAudiencePicker === 'undefined' || this.state !== st) return;
        AdsAudiencePicker.mount(this.host('adsc-aud-include'), { mode: 'include', value: st.includeAudiences, onChange: (ids) => { st.includeAudiences = ids; } });
        const exclude = this.host('adsc-aud-exclude');
        if (exclude) AdsAudiencePicker.mount(exclude, { mode: 'exclude', value: st.excludeAudiences, onChange: (ids) => { st.excludeAudiences = ids; } });
    },

    // ─── Small markup helpers ─────────────────────────────────────────────────────────────

    radio(name, value, current, label, hint, opts) {
        const o = opts || {};
        const id = `adsc-${name}-${value}`;
        return html`
            <div class="check-row check-row-tap adsc-choice">
                <input type="radio" name="adsc-${name}" id="${id}" value="${value}" data-change="adsc:field" data-field="${name}"
                    ${current === value ? html.raw('checked') : ''} ${o.disabled ? html.raw('disabled') : ''} ${hint ? html`aria-describedby="${id}-hint"` : ''}>
                <div class="check-text">
                    <label class="check-label" for="${id}">${label}${o.badge ? html` <span class="badge">${o.badge}</span>` : ''}</label>
                    ${hint ? html`<p class="form-hint" id="${id}-hint">${hint}</p>` : ''}
                </div>
            </div>
        `;
    },

    checkbox(id, label, checked, attrs, hint) {
        return html`
            <div class="check-row check-row-tap adsc-choice">
                <input type="checkbox" id="${id}" ${attrs} ${checked ? html.raw('checked') : ''} ${hint ? html`aria-describedby="${id}-hint"` : ''}>
                <div class="check-text">
                    <label class="check-label" for="${id}">${label}</label>
                    ${hint ? html`<p class="form-hint" id="${id}-hint">${hint}</p>` : ''}
                </div>
            </div>
        `;
    },

    fieldError(name) {
        const st = this.state;
        const message = st && st.errors[name];
        return html`<p class="form-error" id="adsc-err-${name}" role="alert">${message || ''}</p>`;
    },

    money(amount, currency) {
        const n = Number(amount);
        if (amount === null || amount === undefined || amount === '' || !Number.isFinite(n)) return '—';
        const cur = currency === undefined ? this.currency : currency;
        return `⁦${UI.formatNumber(n)}${cur ? ` ${cur}` : ''}⁩`;
    },

    // ─── 1. Goal ──────────────────────────────────────────────────────────────────────────

    goalMarkup(st) {
        return html`
            <fieldset class="adsc-fieldset">
                <legend class="sr-only">${t('adsCreate.step.goal')}</legend>
                ${this.GOALS.map((g) => this.radio('goal', g, st.goal, t(`adsCreate.goal.${g}`), t(`adsCreate.goal.${g}.hint`),
        { disabled: this.LOCKED_GOALS.includes(g), badge: this.LOCKED_GOALS.includes(g) ? t('adsCreate.goal.locked') : '' }))}
            </fieldset>
            <div class="form-group">
                <label class="form-label" for="adsc-name">${t('adsCreate.name')}</label>
                <input type="text" class="form-input" id="adsc-name" maxlength="200" value="${st.name}" data-input="adsc:field" data-field="name" dir="auto"
                    aria-describedby="adsc-name-hint">
                <p class="form-hint" id="adsc-name-hint">${t('adsCreate.name.hint')}</p>
                ${this.fieldError('name')}
            </div>
        `;
    },

    // ─── 2. Destination ───────────────────────────────────────────────────────────────────

    destinationMarkup(st) {
        const opt = this.OPTIMIZATION[st.goal] || [];
        const optimization = opt.length > 1 ? html`
            <div class="form-group">
                <label class="form-label" for="adsc-optimization">${t('adsCreate.optimization')}</label>
                <select class="form-input" id="adsc-optimization" data-change="adsc:field" data-field="optimization">
                    ${opt.map((o, i) => html`<option value="${i === 0 ? '' : o}" ${(st.optimization || '') === (i === 0 ? '' : o) ? html.raw('selected') : ''}>${t(`adsCreate.opt.${o}`)}</option>`)}
                </select>
                <p class="form-hint">${t(`adsCreate.opt.${st.optimization || opt[0]}.hint`)}</p>
            </div>` : '';
        if (st.goal === 'messages') {
            return html`
                <fieldset class="adsc-fieldset">
                    <legend class="form-label">${t('adsCreate.dest.legend')}</legend>
                    ${this.DESTINATIONS.map((d) => this.checkbox(`adsc-dest-${d}`, t(`adsBuilder.dest.${d}`), st.destinations.includes(d),
            html`data-change="adsc:destination" value="${d}"`, t(`adsCreate.dest.${d}.hint`)))}
                </fieldset>
                ${this.fieldError('destinations')}
                <p class="form-hint">${t('adsCreate.dest.botNote')}</p>
            `;
        }
        if (st.goal === 'traffic') {
            const offers = this.offers || [];
            return html`
                <fieldset class="adsc-fieldset">
                    <legend class="form-label">${t('adsCreate.link.legend')}</legend>
                    ${this.radio('linkMode', 'offer', st.link.mode, t('adsCreate.link.offer'), t('adsCreate.link.offer.hint'), { disabled: !offers.length })}
                    ${st.link.mode === 'offer' && offers.length ? html`
                        <div class="form-group adsc-indent">
                            <label class="form-label" for="adsc-offer">${t('adsCreate.link.which')}</label>
                            <select class="form-input" id="adsc-offer" data-change="adsc:field" data-field="offerId">
                                ${offers.map((o) => html`<option value="${o.id}" ${String(o.id) === st.link.offerId ? html.raw('selected') : ''}>${o.name || o.url}</option>`)}
                            </select>
                        </div>` : ''}
                    ${!offers.length ? html`<p class="form-hint adsc-indent">${t('adsCreate.link.noOffers')} <a href="#/tenant_profile">${t('adsCreate.link.addOffer')}</a></p>` : ''}
                    ${this.radio('linkMode', 'url', st.link.mode, t('adsCreate.link.url'), t('adsCreate.link.url.hint'))}
                    ${st.link.mode === 'url' ? html`
                        <div class="form-group adsc-indent">
                            <label class="form-label" for="adsc-url">${t('adsCreate.link.address')}</label>
                            <input type="url" class="form-input" id="adsc-url" dir="ltr" placeholder="https://" value="${st.link.url}" data-input="adsc:field" data-field="url">
                            <p class="form-hint text-warning">${t('adsCreate.link.untracked')}</p>
                            ${this.fieldError('url')}
                        </div>` : ''}
                </fieldset>
                ${optimization}
            `;
        }
        return html`<p class="form-hint">${t(`adsCreate.dest.onPost.${st.goal}`)}</p>${optimization}`;
    },

    // ─── 3. Creative ──────────────────────────────────────────────────────────────────────

    /** Engagement and reach run on a post; messages and traffic may use a post or an upload (spec.ts validateCreative). */
    uploadsAllowed(st) {
        return st.goal === 'messages' || st.goal === 'traffic';
    },

    /** A Facebook post works only for engagement and reach (Messenger and link-click buttons need an Instagram post or an upload). */
    postPlatforms(st) {
        return st.goal === 'engagement' || st.goal === 'reach' ? ['instagram', 'facebook'] : ['instagram'];
    },

    platformsOf(post) {
        const raw = String((post && post.published_post_id) || '');
        const out = [];
        if (/(?:^|\s)IG:[^\s|]+/.test(raw)) out.push('instagram');
        if (/(?:^|\s)FB:[^\s|]+/.test(raw)) out.push('facebook');
        return out;
    },

    creativeMarkup(st) {
        const uploads = this.uploadsAllowed(st);
        const source = uploads ? st.source : 'post';
        return html`
            ${uploads ? html`
                <fieldset class="adsc-fieldset">
                    <legend class="form-label">${t('adsCreate.creative.legend')}</legend>
                    ${this.radio('source', 'media', source, t('adsCreate.creative.upload'), t('adsCreate.creative.upload.hint'))}
                    ${this.radio('source', 'post', source, t('adsCreate.creative.post'), t('adsCreate.creative.post.hint'))}
                </fieldset>` : html`<p class="form-hint">${t('adsCreate.creative.postOnly')}</p>`}
            ${source === 'post' ? this.postPickerMarkup(st) : this.uploadMarkup(st)}
        `;
    },

    postPickerMarkup(st) {
        const allowed = this.postPlatforms(st);
        const posts = (this.posts || []).filter((p) => this.platformsOf(p).some((x) => allowed.includes(x)));
        if (!posts.length) return html`<p class="form-hint" id="adsc-no-posts">${t('adsCreate.creative.noPosts')}</p>`;
        return html`
            <div class="form-group">
                <label class="form-label" for="adsc-post">${t('adsCreate.creative.whichPost')}</label>
                <select class="form-input" id="adsc-post" data-change="adsc:field" data-field="postId">
                    <option value="">${t('adsCreate.creative.choosePost')}</option>
                    ${posts.map((p) => html`<option value="${p.id}" ${String(p.id) === st.postId ? html.raw('selected') : ''}>${String(p.caption || p.id).slice(0, 80)}</option>`)}
                </select>
                ${this.fieldError('postId')}
            </div>
            ${allowed.length > 1 ? html`
                <div class="form-group">
                    <label class="form-label" for="adsc-platform">${t('adsCreate.creative.platform')}</label>
                    <select class="form-input" id="adsc-platform" data-change="adsc:field" data-field="platform">
                        ${allowed.map((p) => html`<option value="${p}" ${p === st.platform ? html.raw('selected') : ''}>${t(`adsCreate.platform.${p}`)}</option>`)}
                    </select>
                </div>` : ''}
            <p class="form-hint">${t('adsCreate.creative.noVerticalOnPost')}</p>
        `;
    },

    /** One upload slot: its file input, its progress and its state. `slot`: media | cover | vertical | verticalCover. */
    slotMarkup(st, slot, label, accept, hint) {
        const m = st[slot];
        const status = m ? m.status : 'empty';
        const progress = m && status === 'uploading' ? html`
            <progress class="adsc-progress" id="adsc-progress-${slot}" max="100" value="${m.progress || 0}" aria-label="${t('adsCreate.upload.progress', { name: m.name })}"></progress>` : '';
        const line = m ? html`<p class="form-hint" id="adsc-status-${slot}" data-status="${status}" dir="auto">${t(`adsCreate.upload.${status}`, { name: m.name })}</p>` : '';
        return html`
            <div class="form-group adsc-slot" data-slot="${slot}">
                <label class="form-label" for="adsc-file-${slot}">${label}</label>
                <input type="file" class="form-input" id="adsc-file-${slot}" accept="${accept}" data-change="adsc:file" data-slot="${slot}" aria-describedby="adsc-file-${slot}-hint">
                <p class="form-hint" id="adsc-file-${slot}-hint">${hint}</p>
                ${progress}
                ${line}
                ${this.fieldError(slot)}
            </div>
        `;
    },

    uploadMarkup(st) {
        const isVideo = st.media && st.media.kind === 'video';
        const verticalIsVideo = st.vertical && st.vertical.kind === 'video';
        const images = this.IMAGE_TYPES.join(',');
        const any = this.IMAGE_TYPES.concat(this.VIDEO_TYPES).join(',');
        const vertical = st.goal === 'traffic' ? html`
            ${this.checkbox('adsc-want-vertical', t('adsCreate.vertical.toggle'), !!st.wantVertical, html`data-change="adsc:wantVertical"`, t('adsCreate.vertical.hint'))}
            ${st.wantVertical ? html`
                ${this.slotMarkup(st, 'vertical', t('adsCreate.vertical.file'), any, t('adsCreate.vertical.file.hint'))}
                ${verticalIsVideo ? this.slotMarkup(st, 'verticalCover', t('adsCreate.cover.verticalFile'), images, t('adsCreate.cover.hint')) : ''}` : ''}
        ` : html`<p class="form-hint">${t('adsCreate.vertical.trafficOnly')}</p>`;
        return html`
            ${this.slotMarkup(st, 'media', t('adsCreate.upload.file'), any, t('adsCreate.upload.limits'))}
            ${isVideo ? this.slotMarkup(st, 'cover', t('adsCreate.cover.file'), images, t('adsCreate.cover.hint')) : ''}
            ${vertical}
        `;
    },

    /** Client-side limits first (the server checks again): the type, and the size Storage takes. */
    fileProblem(file, slot) {
        if (!file) return t('adsCreate.upload.none');
        const imageOnly = slot === 'cover' || slot === 'verticalCover';
        const isImage = this.IMAGE_TYPES.includes(file.type);
        const isVideo = this.VIDEO_TYPES.includes(file.type);
        if (imageOnly ? !isImage : !(isImage || isVideo)) return t(imageOnly ? 'adsCreate.upload.badCover' : 'adsCreate.upload.badType');
        if (file.size > (isImage ? this.IMAGE_MAX : this.VIDEO_MAX)) return t(isImage ? 'adsCreate.upload.imageTooBig' : 'adsCreate.upload.videoTooBig');
        return null;
    },

    /** Sign → PUT with progress → done. Meta is told about it later (`prepare`), when the main file and its cover are both there. */
    async onFile(el) {
        const st = this.state;
        if (!st || !el || !el.dataset) return;
        const slot = el.dataset.slot;
        const file = el.files && el.files[0];
        const problem = this.fileProblem(file, slot);
        st.errors[slot] = problem;
        if (problem) { this.repaintStep(); return; }
        const kind = this.IMAGE_TYPES.includes(file.type) ? 'image' : 'video';
        // A local address for the approximate preview; nothing is uploaded by it.
        let preview = null;
        try { preview = URL.createObjectURL(file); } catch (err) { preview = null; }
        const entry = { name: file.name, kind, status: 'uploading', progress: 0, mediaId: null, preview, ready: false };
        st[slot] = entry;
        this.touch();
        this.repaintStep();
        try {
            const signed = await API.signAdsUpload({ filename: file.name, mime: file.type, size: file.size });
            await this.put(signed.upload, file, (pct) => {
                entry.progress = pct;
                const bar = this.host(`adsc-progress-${slot}`);
                if (bar) bar.value = pct;
            });
            entry.mediaId = signed.mediaId;
            entry.status = 'uploaded';
        } catch (err) {
            if (this.state !== st || st[slot] !== entry) return;
            entry.status = 'failed';
            st.errors[slot] = (err && err.message) || t('adsCreate.upload.failed');
            this.repaintStep();
            return;
        }
        if (this.state !== st || st[slot] !== entry) return;
        await this.prepareReady(st);
        this.repaintStep();
    },

    /** The PUT to Storage, with progress. XHR, because fetch has no upload progress. */
    put(upload, file, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(upload.method || 'PUT', upload.url);
            const headers = upload.headers || {};
            Object.keys(headers).forEach((k) => xhr.setRequestHeader(k, headers[k]));
            if (xhr.upload) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
            xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(t('adsCreate.upload.failed'))));
            xhr.onerror = () => reject(new Error(t('adsCreate.upload.failed')));
            xhr.send(file);
        });
    },

    /** Hand every uploaded main file to Meta once what it needs is there (a video waits for its cover). */
    async prepareReady(st) {
        const pairs = [['media', 'cover'], ['vertical', 'verticalCover']];
        for (const [slot, coverSlot] of pairs) {
            const m = st[slot];
            if (!m || m.status !== 'uploaded' || !m.mediaId) continue;
            const cover = st[coverSlot];
            if (m.kind === 'video' && !(cover && cover.mediaId)) continue;
            m.status = 'preparing';
            this.repaintStep();
            try {
                await API.prepareAdsMedia({ mediaId: m.mediaId, kind: m.kind, ...(m.kind === 'video' ? { coverMediaId: cover.mediaId } : {}) });
                m.status = m.kind === 'video' ? 'processing' : 'ready';
            } catch (err) {
                m.status = 'failed';
                st.errors[slot] = (err && err.message) || t('adsCreate.upload.failed');
            }
        }
        // A cover finished on its own, after its video: the video can go to Meta now.
        for (const coverSlot of ['cover', 'verticalCover']) {
            const c = st[coverSlot];
            if (c && c.status === 'uploaded' && c.mediaId) c.status = 'ready';
        }
    },

    // ─── 4. Copy ──────────────────────────────────────────────────────────────────────────

    copyMarkup(st) {
        const fromPost = st.source === 'post' || !this.uploadsAllowed(st);
        const count = st.primaryText.length;
        const text = fromPost ? html`<p class="form-hint">${t('adsCreate.copy.postCaption')}</p>` : html`
            <div class="form-group">
                <label class="form-label" for="adsc-primary">${t('adsCreate.copy.primary')}</label>
                <textarea class="form-input" id="adsc-primary" rows="5" maxlength="2200" dir="auto" data-input="adsc:field" data-field="primaryText"
                    aria-describedby="adsc-primary-count">${st.primaryText}</textarea>
                <p class="form-hint" id="adsc-primary-count">${t('adsCreate.copy.count', { count: UI.formatNumber(count), cut: UI.formatNumber(this.FEED_CUT) })}</p>
                ${this.fieldError('primaryText')}
            </div>
            <div class="form-group">
                <label class="form-label" for="adsc-headline">${t('adsCreate.copy.headline')}</label>
                <input type="text" class="form-input" id="adsc-headline" maxlength="255" dir="auto" value="${st.headline}" data-input="adsc:field" data-field="headline">
            </div>`;
        const cta = st.goal === 'traffic' ? html`
            <div class="form-group">
                <label class="form-label" for="adsc-cta">${t('adsCreate.copy.cta')}</label>
                <select class="form-input" id="adsc-cta" data-change="adsc:field" data-field="cta">
                    ${this.CTAS.map((c) => html`<option value="${c}" ${c === st.cta ? html.raw('selected') : ''}>${t(`adsCreate.cta.${c}`)}</option>`)}
                </select>
            </div>` : '';
        const message = st.goal === 'messages' ? html`
            <div class="form-group">
                <label class="form-label" for="adsc-greeting">${t('adsCreate.copy.greeting')}</label>
                <textarea class="form-input" id="adsc-greeting" rows="2" maxlength="300" dir="auto" data-input="adsc:field" data-field="greeting">${st.greeting}</textarea>
                <p class="form-hint">${t('adsCreate.copy.greeting.hint')}</p>
            </div>
            <fieldset class="adsc-fieldset">
                <legend class="form-label">${t('adsCreate.copy.ice')}</legend>
                ${st.ice.map((row, i) => html`
                    <div class="adsc-ice">
                        <label class="sr-only" for="adsc-ice-${i}">${t('adsCreate.copy.iceN', { n: i + 1 })}</label>
                        <input type="text" class="form-input" id="adsc-ice-${i}" maxlength="80" dir="auto" value="${row.title}" data-input="adsc:ice" data-index="${i}">
                        ${UI.button({ variant: 'ghost', size: 'sm', icon: 'x', label: t('adsCreate.remove'), action: 'adsc:iceRemove', data: { index: i } })}
                    </div>`)}
                ${st.ice.length < this.ICE_MAX ? UI.button({ variant: 'secondary', size: 'sm', icon: 'plus', label: t('adsCreate.copy.iceAdd'), action: 'adsc:iceAdd' }) : ''}
            </fieldset>` : '';
        return html`
            ${text}${cta}${message}
            <div id="adsc-policy" class="adsb-policy" aria-live="polite">${this.policyMarkup(st)}</div>
        `;
    },

    policyFields(st) {
        const fields = {};
        if (st.source === 'media' && this.uploadsAllowed(st)) {
            if (st.primaryText.trim()) fields.primaryText = st.primaryText;
            if (st.headline.trim()) fields.headline = st.headline;
        }
        if (st.goal === 'messages') {
            if (st.greeting.trim()) fields.greeting = st.greeting;
            st.ice.forEach((row, i) => { if (row.title.trim()) fields[`iceBreakers.${i}.title`] = row.title; });
        }
        return fields;
    },

    schedulePolicy() {
        const st = this.state;
        if (!st) return;
        if (st.policyTimer) clearTimeout(st.policyTimer);
        st.policyTimer = setTimeout(() => { st.policyTimer = null; if (this.state === st) this.checkPolicy(); }, this.POLICY_DEBOUNCE_MS);
    },

    async checkPolicy() {
        const st = this.state;
        if (!st || typeof API.checkAdsPolicy !== 'function') return;
        const fields = this.policyFields(st);
        const seq = ++st.policySeq;
        if (!Object.keys(fields).length) { st.policy = null; this.write('adsc-policy', ''); return; }
        let answer;
        try { answer = await API.checkAdsPolicy(fields); } catch (err) { return; }
        if (this.state !== st || st.policySeq !== seq || !answer || !Array.isArray(answer.findings)) return;
        st.policy = { blocked: !!answer.blocked, findings: answer.findings };
        this.write('adsc-policy', this.policyMarkup(st));
    },

    /** The findings, with quick mode's drawing when it is loaded (the matched words marked, the reason, a compliant rewrite). */
    policyMarkup(st) {
        const policy = st.policy;
        if (!policy) return '';
        const findings = policy.findings || [];
        if (!findings.length) return html`<p class="adsb-clean"><i data-lucide="check-circle" aria-hidden="true"></i> <span class="text-success">${t('adsBuilder.policy.clean')}</span></p>`;
        const lang = typeof I18N !== 'undefined' && I18N.lang === 'ar' ? 'ar' : 'en';
        const draw = (f) => (typeof AdsBuilder !== 'undefined' && AdsBuilder.findingMarkup
            ? AdsBuilder.findingMarkup(f, lang)
            : html`<li data-severity="${f.severity}">${f.match}</li>`);
        return html`
            <p class="${policy.blocked ? html.raw('text-danger') : html.raw('text-warning')}"><strong>${policy.blocked ? t('adsBuilder.policy.blocked') : t('adsBuilder.policy.warnOnly')}</strong></p>
            <ul class="adsb-findings">
                ${findings.map((f) => html`<li class="adsc-finding-match" dir="auto"><mark class="adsb-mark">${f.match}</mark></li>${draw(f)}`)}
            </ul>
        `;
    },

    // ─── 5. Audience ──────────────────────────────────────────────────────────────────────

    audienceMarkup(st) {
        const special = st.special !== 'none';
        const advantage = st.advantage && !special;
        const chips = (list, kind) => list.map((x, i) => html`
            <span class="chip adsc-chip">${x.name}${x.radiusKm ? ` · ${x.radiusKm} km` : ''}
                <button type="button" class="chip-remove" data-action="adsc:unpick" data-kind="${kind}" data-index="${i}" aria-label="${t('adsCreate.removeName', { name: x.name })}"><i data-lucide="x" aria-hidden="true"></i></button>
            </span>`);
        return html`
            <div class="form-group">
                <label class="form-label" for="adsc-countries">${t('adsCreate.aud.countries')}</label>
                <input type="text" class="form-input" id="adsc-countries" dir="ltr" value="${st.countries}" data-input="adsc:field" data-field="countries" aria-describedby="adsc-countries-hint">
                <p class="form-hint" id="adsc-countries-hint">${t('adsCreate.aud.countries.hint')}</p>
                ${this.fieldError('countries')}
            </div>
            ${this.searchMarkup(st, 'adgeolocation', 'cities', t('adsCreate.aud.cities'), t('adsCreate.aud.cities.hint'))}
            <div class="adsc-chips">${chips(st.cities, 'cities')}</div>
            ${st.cities.length ? html`
                <div class="form-group">
                    <label class="form-label" for="adsc-radius">${t('adsCreate.aud.radius')}</label>
                    <input type="number" class="form-input" id="adsc-radius" min="${special ? 25 : this.RADIUS_MIN}" max="${this.RADIUS_MAX}" value="${st.cities[0].radiusKm}" data-change="adsc:field" data-field="radius">
                    <p class="form-hint">${t('adsCreate.aud.radius.hint', { min: special ? 25 : this.RADIUS_MIN, max: this.RADIUS_MAX })}</p>
                </div>` : ''}
            <div class="adsc-row">
                <div class="form-group">
                    <label class="form-label" for="adsc-age-min">${t('adsCreate.aud.ageMin')}</label>
                    <input type="number" class="form-input" id="adsc-age-min" min="18" max="${advantage ? 25 : 65}" value="${st.ageMin}" data-change="adsc:field" data-field="ageMin" ${special ? html.raw('disabled') : ''}>
                    ${this.fieldError('ageMin')}
                </div>
                ${advantage || special ? '' : html`
                    <div class="form-group">
                        <label class="form-label" for="adsc-age-max">${t('adsCreate.aud.ageMax')}</label>
                        <input type="number" class="form-input" id="adsc-age-max" min="18" max="65" value="${st.ageMax}" placeholder="65" data-change="adsc:field" data-field="ageMax">
                        ${this.fieldError('ageMax')}
                    </div>`}
                <div class="form-group">
                    <label class="form-label" for="adsc-gender">${t('adsCreate.aud.gender')}</label>
                    <select class="form-input" id="adsc-gender" data-change="adsc:field" data-field="gender" ${special ? html.raw('disabled') : ''}>
                        ${['all', 'men', 'women'].map((g) => html`<option value="${g}" ${g === st.gender ? html.raw('selected') : ''}>${t(`adsCreate.aud.gender.${g}`)}</option>`)}
                    </select>
                </div>
            </div>
            ${this.checkbox('adsc-advantage', t('adsCreate.aud.advantage'), advantage, html`data-change="adsc:advantage" ${special ? html.raw('disabled') : ''}`, t('adsCreate.aud.advantage.hint'))}
            ${this.searchMarkup(st, 'adlocale', 'locales', t('adsCreate.aud.languages'), t('adsCreate.aud.languages.hint'))}
            <div class="adsc-chips">${chips(st.locales, 'locales')}</div>
            ${special ? html`<p class="form-hint">${t('adsCreate.aud.noInterestsSpecial')}</p>` : html`
                ${this.searchMarkup(st, 'adinterest', 'interests', t('adsCreate.aud.interests'), t('adsCreate.aud.interests.hint'))}
                <div class="adsc-chips">${chips(st.interests, 'interests')}</div>`}
            <div id="adsc-aud-include" class="adsc-audiences"></div>
            ${special ? '' : html`<div id="adsc-aud-exclude" class="adsc-audiences"></div>`}
            <div class="form-group">
                <label class="form-label" for="adsc-special">${t('adsCreate.aud.special')}</label>
                <select class="form-input" id="adsc-special" data-change="adsc:field" data-field="special" aria-describedby="adsc-special-hint">
                    ${this.SPECIAL.map((c) => html`<option value="${c}" ${c === st.special ? html.raw('selected') : ''} ${c === 'political' ? html.raw('disabled') : ''}>${t(`adsCreate.special.${c}`)}</option>`)}
                </select>
                <p class="form-hint ${special ? html.raw('text-warning') : ''}" id="adsc-special-hint">${t(special ? 'adsCreate.special.warn' : 'adsCreate.special.hint')}</p>
            </div>
        `;
    },

    /** A search box for Meta's targeting catalogue, with its results as buttons. */
    searchMarkup(st, type, kind, label, hint) {
        const open = st.search.type === type;
        const items = open ? st.search.items : [];
        return html`
            <div class="form-group adsc-search">
                <label class="form-label" for="adsc-search-${kind}">${label}</label>
                <input type="search" class="form-input" id="adsc-search-${kind}" dir="auto" value="${open ? st.search.q : ''}" data-input="adsc:search" data-type="${type}"
                    aria-describedby="adsc-search-${kind}-hint" aria-controls="adsc-results-${kind}" autocomplete="off">
                <p class="form-hint" id="adsc-search-${kind}-hint">${hint}</p>
                <ul class="adsc-results" id="adsc-results-${kind}" aria-live="polite">
                    ${items.map((x, i) => html`<li><button type="button" class="btn btn-ghost btn-sm" data-action="adsc:pick" data-kind="${kind}" data-index="${i}">
                        <i data-lucide="plus" aria-hidden="true"></i> <span dir="auto">${x.name}</span>${x.region ? html` <span class="form-hint">${x.region}</span>` : ''}
                        ${x.sizeLower ? html` <span class="form-hint">${t('adsCreate.aud.size', { lower: UI.formatNumber(x.sizeLower), upper: UI.formatNumber(x.sizeUpper) })}</span>` : ''}
                    </button></li>`)}
                </ul>
            </div>
        `;
    },

    onSearch(el) {
        const st = this.state;
        if (!st || !el || !el.dataset) return;
        const type = el.dataset.type;
        const q = String(el.value || '');
        st.search.type = type;
        st.search.q = q;
        if (st.search.timer) clearTimeout(st.search.timer);
        if (q.trim().length < 2) { st.search.items = []; return; }
        st.search.timer = setTimeout(async () => {
            const seq = ++st.search.seq;
            let answer;
            try { answer = await API.searchAdsTargeting(type, q.trim()); } catch (err) { return; }
            if (this.state !== st || st.search.seq !== seq || st.search.type !== type) return;
            st.search.items = answer && Array.isArray(answer.items) ? answer.items.slice(0, 10) : [];
            const kind = type === 'adgeolocation' ? 'cities' : type === 'adlocale' ? 'locales' : 'interests';
            const list = this.host(`adsc-results-${kind}`);
            const fresh = this.searchMarkup(st, type, kind, '', '');
            if (list) {
                // Only the result list is redrawn: the search box keeps its focus and its caret.
                const m = /<ul class="adsc-results"[^>]*>([\s\S]*)<\/ul>/.exec(esc(fresh));
                list.innerHTML = m ? m[1] : '';
                UI.icons(list);
            }
        }, this.SEARCH_DEBOUNCE_MS);
    },

    pick(el) {
        const st = this.state;
        if (!st || !el || !el.dataset) return;
        const item = st.search.items[Number(el.dataset.index)];
        const kind = el.dataset.kind;
        if (!item || !['cities', 'locales', 'interests'].includes(kind)) return;
        const list = st[kind];
        if (list.some((x) => String(x.id) === String(item.id))) return;
        if (kind === 'cities') list.push({ id: item.id, name: item.name, radiusKm: list.length ? list[0].radiusKm : (st.special !== 'none' ? 25 : 25) });
        else list.push({ id: item.id, name: item.name });
        st.search = { type: null, q: '', items: [], seq: st.search.seq + 1, timer: null };
        this.touch();
        this.repaintStep();
    },

    unpick(el) {
        const st = this.state;
        if (!st || !el || !el.dataset) return;
        const list = st[el.dataset.kind];
        if (!Array.isArray(list)) return;
        list.splice(Number(el.dataset.index), 1);
        this.touch();
        this.repaintStep();
    },

    // ─── 6. Placements ────────────────────────────────────────────────────────────────────

    placementsMarkup(st) {
        const manual = st.placementMode === 'manual';
        return html`
            <fieldset class="adsc-fieldset">
                <legend class="sr-only">${t('adsCreate.step.placements')}</legend>
                ${this.radio('placementMode', 'automatic', st.placementMode, t('adsCreate.pl.automatic'), t('adsCreate.pl.automatic.hint'))}
                ${this.radio('placementMode', 'manual', st.placementMode, t('adsCreate.pl.manual'), t('adsCreate.pl.manual.hint'))}
            </fieldset>
            ${manual ? html`
                ${['instagram', 'facebook'].map((platform) => html`
                    <fieldset class="adsc-fieldset adsc-indent">
                        <legend class="form-label">${t(`adsCreate.platform.${platform}`)}</legend>
                        ${this.PLACEMENTS[platform].map((pos) => this.checkbox(`adsc-pl-${platform}-${pos}`, t(`adsCreate.pl.${platform}.${pos}`), st.placements[platform].includes(pos),
            html`data-change="adsc:placement" data-platform="${platform}" value="${pos}"`))}
                    </fieldset>`)}
                <p class="form-hint">${t('adsCreate.pl.removed')}</p>
                ${this.fieldError('placements')}` : ''}
        `;
    },

    // ─── 7. Budget and schedule ───────────────────────────────────────────────────────────

    budgetMarkup(st) {
        const min = this.minimumFor(st);
        const days = this.days(st);
        return html`
            <fieldset class="adsc-fieldset">
                <legend class="form-label">${t('adsCreate.budget.home')}</legend>
                ${this.radio('home', 'adset', st.home, t('adsCreate.budget.home.adset'), t('adsCreate.budget.home.adset.hint'))}
                ${this.radio('home', 'campaign', st.home, t('adsCreate.budget.home.campaign'), t('adsCreate.budget.home.campaign.hint'))}
            </fieldset>
            <fieldset class="adsc-fieldset">
                <legend class="form-label">${t('adsCreate.budget.kind')}</legend>
                ${this.radio('kind', 'lifetime', st.kind, t('adsCreate.budget.lifetime'), t('adsCreate.budget.lifetime.hint'))}
                ${this.radio('kind', 'daily', st.kind, t('adsCreate.budget.daily'), t('adsCreate.budget.daily.hint'))}
            </fieldset>
            <div class="form-group">
                <label class="form-label" for="adsc-amount">${t(st.kind === 'daily' ? 'adsCreate.budget.amountDaily' : 'adsCreate.budget.amountTotal', { currency: this.currency || '' })}</label>
                <input type="number" class="form-input" id="adsc-amount" min="0" step="0.01" dir="ltr" value="${st.amount}" data-input="adsc:field" data-field="amount" aria-describedby="adsc-money">
                ${this.fieldError('amount')}
            </div>
            <div class="adsc-row">
                <div class="form-group">
                    <label class="form-label" for="adsc-start">${t('adsCreate.budget.start')}</label>
                    <input type="datetime-local" class="form-input" id="adsc-start" value="${st.start}" data-change="adsc:field" data-field="start">
                    ${this.fieldError('start')}
                </div>
                <div class="form-group">
                    <label class="form-label" for="adsc-end">${t(st.kind === 'lifetime' ? 'adsCreate.budget.endRequired' : 'adsCreate.budget.endOptional')}</label>
                    <input type="datetime-local" class="form-input" id="adsc-end" value="${st.end}" data-change="adsc:field" data-field="end">
                    ${this.fieldError('end')}
                </div>
            </div>
            <div id="adsc-money" class="adsc-money" aria-live="polite">${this.moneyMarkup(st, min, days)}</div>
            ${st.kind === 'lifetime' ? html`
                ${this.checkbox('adsc-scheduled', t('adsCreate.schedule.toggle'), st.scheduled, html`data-change="adsc:scheduled"`, t('adsCreate.schedule.hint'))}
                ${st.scheduled ? html`
                    <fieldset class="adsc-fieldset adsc-indent">
                        <legend class="form-label">${t('adsCreate.schedule.days')}</legend>
                        <div class="adsc-days">${[0, 1, 2, 3, 4, 5, 6].map((d) => this.checkbox(`adsc-day-${d}`, t(`adsCreate.day.${d}`), st.days.includes(d), html`data-change="adsc:day" value="${d}"`))}</div>
                        <div class="adsc-row">
                            <div class="form-group">
                                <label class="form-label" for="adsc-from">${t('adsCreate.schedule.from')}</label>
                                <input type="number" class="form-input" id="adsc-from" min="0" max="23" value="${st.fromHour}" data-change="adsc:field" data-field="fromHour">
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="adsc-to">${t('adsCreate.schedule.to')}</label>
                                <input type="number" class="form-input" id="adsc-to" min="1" max="24" value="${st.toHour}" data-change="adsc:field" data-field="toHour">
                            </div>
                        </div>
                        ${this.fieldError('schedule')}
                    </fieldset>` : ''}` : html`<p class="form-hint">${t('adsCreate.schedule.needsTotal')}</p>`}
        `;
    },

    /** Whole days between start and end (at least 1), or null without an end. */
    days(st) {
        const s = Date.parse(st.start);
        const e = Date.parse(st.end);
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
        return Math.max(1, Math.ceil((e - s) / 86_400_000));
    },

    minimumFor(st) {
        const m = this.minimum && Number(this.minimum[st.goal]);
        return Number.isFinite(m) && m > 0 ? m : null;
    },

    /** The candidate the money rule weighs: a total is `lifetime:<total>:<days>`; a daily budget runs to its end, or a month. */
    candidate(st) {
        const amount = Number(st.amount);
        if (!Number.isFinite(amount) || amount <= 0) return null;
        const days = this.days(st);
        if (st.kind === 'lifetime') return days ? `lifetime:${amount}:${days}` : null;
        return `daily:${amount}:${days || 30}`;
    },

    async loadMoney() {
        const st = this.state;
        if (!st || typeof API.getAdsMoney !== 'function') return;
        let answer = null;
        try { answer = await API.getAdsMoney(); } catch (err) { answer = null; }
        if (this.state !== st) return;
        this.moneyAnswer = answer;
        this.write('adsc-money', this.moneyMarkup(st, this.minimumFor(st), this.days(st)));
    },

    /** Live, from the one answer: the total against what is left, the daily max, Meta's minimum. Every figure excludes tax. */
    moneyMarkup(st, min, days) {
        const amount = Number(st.amount);
        const a = this.moneyAnswer || {};
        const lines = [];
        const perDay = st.kind === 'daily' ? amount : (days ? amount / days : NaN);
        const total = st.kind === 'daily' ? amount * (days || 30) : amount;
        if (Number.isFinite(total) && total > 0) {
            lines.push(html`<p data-adsc="total">${t(st.kind === 'daily' ? 'adsCreate.money.dailyTotal' : 'adsCreate.money.total', { total: this.money(total), perDay: this.money(Math.round(perDay * 100) / 100), days: days || 30 })}</p>`);
        }
        if (a.remaining !== null && a.remaining !== undefined) {
            const over = Number.isFinite(total) && total > Number(a.remaining);
            lines.push(html`<p data-adsc="remaining" data-fits="${over ? 'false' : 'true'}" class="${over ? html.raw('text-danger') : ''}">${t(over ? 'adsCreate.money.over' : 'adsCreate.money.remaining', { remaining: this.money(a.remaining) })}</p>`);
        }
        if (a.maxDailyBudget && Number.isFinite(perDay) && perDay > Number(a.maxDailyBudget)) {
            lines.push(html`<p class="text-danger" data-adsc="overDaily">${t('adsCreate.money.overDaily', { max: this.money(a.maxDailyBudget) })}</p>`);
        }
        if (min !== null) {
            const below = Number.isFinite(perDay) && perDay > 0 && perDay < min;
            lines.push(html`<p data-adsc="minimum" class="${below ? html.raw('text-danger') : ''}">${t(below ? 'adsCreate.money.belowMin' : 'adsCreate.money.min', { min: this.money(min) })}</p>`);
        }
        if (st.kind === 'daily') lines.push(html`<p class="form-hint">${t('adsCreate.money.overspend')}</p>`);
        lines.push(html`<p class="form-hint ads-tax-note">${t('ads.tax.note')}</p>`);
        return html`${lines}`;
    },

    // ─── 8. Review ────────────────────────────────────────────────────────────────────────

    reviewStepMarkup(st) {
        return html`
            <p class="form-hint">${t('adsCreate.review.intro')}</p>
            ${UI.button({ variant: 'secondary', icon: 'search', label: t('adsCreate.review.run'), action: 'adsc:review', focusKey: 'adsc-review', busy: st.reviewing })}
            <div id="adsc-review" aria-live="polite">${st.review ? this.reviewMarkup(st) : ''}</div>
        `;
    },

    async review() {
        const st = this.state;
        if (!st || st.reviewing) return;
        const spec = this.buildSpec(st);
        const rev = ++st.rev;
        st.reviewing = true;
        st.review = null;
        this.repaintStep();
        let answer = null;
        let failure = null;
        try { answer = await API.validateAdsDraft(spec); } catch (err) { failure = err; }
        if (this.state !== st) return;
        st.reviewing = false;
        if (st.rev !== rev) { this.repaintStep(); return; }
        if (failure || !answer) {
            st.review = { spec, failure: failure || new Error(t('error.unexpected')) };
        } else {
            st.review = { spec, answer };
            if (answer.policy && Array.isArray(answer.policy.findings)) st.policy = { blocked: !!answer.policy.blocked, findings: answer.policy.findings };
        }
        this.repaintStep();
    },

    reviewMarkup(st) {
        const r = st.review;
        if (r.failure) {
            const unavailable = r.failure.status === 404;
            return html`<p class="text-danger" data-adsc="review-failed" dir="auto">${unavailable ? t('adsCreate.review.unavailable') : (r.failure.message || t('error.unexpected'))}</p>
                ${this.previewsMarkup(st, [])}`;
        }
        const a = r.answer;
        const problems = Array.isArray(a.problems) ? a.problems : [];
        const warnings = Array.isArray(a.warnings) ? a.warnings : [];
        const m = a.money;
        const lines = [];
        if (m) {
            lines.push(html`<p data-adsc="money" data-fits="${m.fits === false ? 'false' : 'true'}" class="${m.fits === false ? html.raw('text-danger') : html.raw('text-success')}">
                ${m.fits === false ? t('adsBuilder.review.moneyOver', { remaining: this.money(m.remaining) }) : (m.remaining === null || m.remaining === undefined ? t('adsBuilder.review.moneyFitsNoCap') : t('adsBuilder.review.moneyFits', { remaining: this.money(m.remaining) }))}</p>`);
        }
        if (a.meta) {
            if (a.meta.minimumBudget !== null && a.meta.minimumBudget !== undefined) lines.push(html`<p data-adsc="minimum">${t('adsBuilder.review.minimum', { min: this.money(a.meta.minimumBudget) })}</p>`);
            lines.push(a.meta.ok
                ? html`<p data-adsc="meta-ok" class="text-success">${t('adsBuilder.review.metaOk')}</p>`
                : html`<p data-adsc="meta-error" class="text-danger" dir="auto">${t('adsBuilder.review.metaError', { error: a.meta.error || t('adsBuilder.review.metaNoReason') })}</p>`);
        }
        lines.push(a.estimate
            ? html`<p data-adsc="estimate">${t('adsCreate.review.estimate', { lower: UI.formatNumber(a.estimate.lower), upper: UI.formatNumber(a.estimate.upper) })}</p>`
            : html`<p data-adsc="estimate" class="form-hint">${t('adsCreate.review.noEstimate')}</p>`);
        const needsAck = this.needsAck(st);
        return html`
            <div class="adsb-review">
                ${lines}
                ${problems.length ? html`<div class="adsb-block"><p class="text-danger"><strong>${t('adsBuilder.review.problems')}</strong></p>
                    <ul>${problems.map((p) => html`<li data-adsc="problem" data-field="${p.field}" dir="auto">${p.message}</li>`)}</ul></div>` : ''}
                ${warnings.length ? html`<div class="adsb-block"><p class="text-warning"><strong>${t('adsBuilder.review.warnings')}</strong></p>
                    <ul>${warnings.map((w) => html`<li data-adsc="warning" dir="auto">${w.message || w.code}</li>`)}</ul></div>` : ''}
                <div class="adsb-policy">${this.policyMarkup(st)}</div>
                ${this.previewsMarkup(st, Array.isArray(a.previews) ? a.previews : [])}
                ${needsAck ? this.checkbox('adsc-ack', t('adsBuilder.ack'), st.ack, html`data-change="adsc:ack"`, t('adsBuilder.ack.hint')) : ''}
            </div>
        `;
    },

    needsAck(st) {
        return !!(st.policy && !st.policy.blocked && st.policy.findings && st.policy.findings.length);
    },

    canCreate(st) {
        const r = st.review;
        if (!r || !r.answer || st.busy || st.reviewing) return false;
        const a = r.answer;
        if (a.policy && a.policy.blocked) return false;
        if (Array.isArray(a.problems) && a.problems.length) return false;
        if (!a.meta || a.meta.ok !== true) return false;
        if (a.money && a.money.fits === false) return false;
        if (this.needsAck(st) && !st.ack) return false;
        return true;
    },

    // ─── Previews ─────────────────────────────────────────────────────────────────────────

    /** Meta's iframe address, only when it is Meta's preview page on www.facebook.com; anything else is not shown. */
    previewSrc(markup) {
        const m = /src="(https:\/\/www\.facebook\.com\/[^"<>\s]+)"/.exec(String(markup || ''));
        if (!m) return null;
        const src = m[1].replace(/&amp;/g, '&');
        try {
            const u = new URL(src);
            return u.hostname === 'www.facebook.com' ? u.toString() : null;
        } catch (err) {
            return null;
        }
    },

    /** The placements previewed when the server gave none (the review failed): the feed and the vertical frame. */
    previewsMarkup(st, previews) {
        const list = previews.length ? previews : [{ placement: 'instagram_feed', frame: '4:5', html: null }, { placement: 'instagram_reels', frame: '9:16', html: null }];
        return html`
            <div class="adsc-previews" id="adsc-previews">
                ${list.map((p) => {
        const src = p.html ? this.previewSrc(p.html) : null;
        return html`
                    <figure class="adsc-preview" data-placement="${p.placement}" data-frame="${p.frame}">
                        <figcaption class="form-label">${t(`adsCreate.preview.${p.placement}`)}</figcaption>
                        ${src ? html`<iframe class="adsc-preview-frame adsc-frame-${p.frame === '9:16' ? '916' : '45'}" src="${src}" title="${t(`adsCreate.preview.${p.placement}`)}"
                            loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>` : this.mockPreview(st, p.frame)}
                    </figure>`;
    })}
            </div>
        `;
    },

    /** The text a feed shows: cut at 125 characters (on a word when there is one), and whether "…more" follows. */
    feedText(text) {
        const s = String(text || '');
        if (s.length <= this.FEED_CUT) return { text: s, cut: false };
        const head = s.slice(0, this.FEED_CUT);
        const space = head.lastIndexOf(' ');
        return { text: (/\s/.test(s.charAt(this.FEED_CUT)) || space <= 0 ? head : head.slice(0, space)).trimEnd(), cut: true };
    },

    /**
     * The approximate preview (research R11), drawn here when Meta will not preview for this token: the picture cropped to the placement's
     * frame, the Page's name and its initial (never a photo of a person), the text cut where the feed cuts it, the headline, the button; for a
     * message ad, the greeting bubble and the ice breakers. Labelled as approximate.
     */
    mockPreview(st, frame) {
        const vertical = frame === '9:16';
        const slot = vertical && st.vertical ? st.vertical : st.media;
        const coverSlot = vertical && st.vertical ? st.verticalCover : st.cover;
        const post = st.source === 'post' ? (this.posts || []).find((p) => String(p.id) === st.postId) : null;
        const picture = post ? (post.thumbnail_url || post.media_url) : slot ? (slot.kind === 'video' ? coverSlot && coverSlot.preview : slot.preview) : null;
        const safe = picture ? safeUrl(picture) : null;
        const page = (this.settings && this.settings.account && this.settings.account.name) || t('adsCreate.preview.page');
        const text = this.feedText(st.source === 'post' ? (post && post.caption) : st.primaryText);
        const cta = st.goal === 'traffic' ? t(`adsCreate.cta.${st.cta}`) : st.goal === 'messages' ? t('adsCreate.preview.sendMessage') : '';
        return html`
            <div class="adsc-mock adsc-frame-${vertical ? '916' : '45'}" data-mock="true">
                <p class="adsc-mock-label badge">${t('adsCreate.preview.approximate')}</p>
                <div class="adsc-mock-head"><span class="adsc-mock-avatar" aria-hidden="true">${String(page).trim().charAt(0).toUpperCase()}</span> <span dir="auto">${page}</span></div>
                <div class="adsc-mock-media">${safe ? html`<img src="${safe}" alt="" loading="lazy">` : html`<i data-lucide="image" aria-hidden="true"></i>`}</div>
                <p class="adsc-mock-text" dir="auto" data-cut="${text.cut ? 'true' : 'false'}">${text.text}${text.cut ? html`<span class="adsc-mock-more">${t('adsCreate.preview.more')}</span>` : ''}</p>
                ${st.headline && st.source !== 'post' ? html`<p class="adsc-mock-headline" dir="auto"><strong>${st.headline}</strong></p>` : ''}
                ${cta ? html`<span class="btn btn-sm btn-secondary adsc-mock-cta">${cta}</span>` : ''}
                ${st.goal === 'messages' && st.greeting ? html`
                    <div class="adsc-mock-chat">
                        <p class="adsc-mock-bubble" dir="auto">${st.greeting}</p>
                        <div class="adsc-mock-ice">${st.ice.filter((r) => r.title.trim()).map((r) => html`<span class="chip" dir="auto">${r.title}</span>`)}</div>
                    </div>` : ''}
            </div>
        `;
    },

    // ─── The spec ─────────────────────────────────────────────────────────────────────────

    countries(st) {
        return String(st.countries || '').split(/[\s,،]+/).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
    },

    isoOf(local) {
        const ms = Date.parse(local);
        return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
    },

    /** The `CampaignSpec` (contracts/dashboard-api.md), exactly. */
    buildSpec(st) {
        const special = st.special !== 'none';
        const advantage = st.advantage && !special;
        const targeting = {
            countries: this.countries(st),
            ageMin: special ? 18 : Math.round(Number(st.ageMin) || 18),
            advantageAudience: advantage,
        };
        if (!advantage && !special && st.ageMax !== '' && Number(st.ageMax)) targeting.ageMax = Math.round(Number(st.ageMax));
        if (!special && st.gender !== 'all') targeting.genders = [st.gender === 'men' ? 1 : 2];
        if (st.cities.length) targeting.cities = st.cities.map((c) => ({ key: String(c.id), radiusKm: Number(c.radiusKm) }));
        if (st.locales.length) targeting.locales = st.locales.map((l) => Number(l.id)).filter(Number.isFinite);
        if (!special && st.interests.length) targeting.interests = st.interests.map((i) => ({ id: String(i.id), name: i.name }));
        // Saved audiences (A8): our ids; the server checks each is usable and sends Meta its id. A special category cannot exclude.
        if (st.includeAudiences.length) targeting.includeAudiences = st.includeAudiences.slice();
        if (!special && st.excludeAudiences.length) targeting.excludeAudiences = st.excludeAudiences.slice();
        const adset = {
            name: targeting.countries.join('+') || 'Ad set',
            targeting,
            placements: st.placementMode === 'automatic' ? 'automatic' : {
                ...(st.placements.instagram.length ? { instagram: st.placements.instagram.slice() } : {}),
                ...(st.placements.facebook.length ? { facebook: st.placements.facebook.slice() } : {}),
            },
        };
        if (st.optimization) adset.optimization = st.optimization;
        if (st.kind === 'lifetime' && st.scheduled) {
            adset.schedule = [{ days: st.days.slice().sort(), startHour: Number(st.fromHour), endHour: Number(st.toHour) }];
        }
        const usePost = st.source === 'post' || !this.uploadsAllowed(st);
        const creative = usePost
            ? { source: 'post', postId: st.postId, platform: this.postPlatforms(st).includes(st.platform) ? st.platform : 'instagram' }
            : {
                source: 'media', mediaId: st.media && st.media.mediaId,
                ...(st.cover && st.cover.mediaId ? { coverMediaId: st.cover.mediaId } : {}),
                ...(st.goal === 'traffic' && st.wantVertical && st.vertical && st.vertical.mediaId ? { verticalMediaId: st.vertical.mediaId } : {}),
                ...(st.goal === 'traffic' && st.wantVertical && st.verticalCover && st.verticalCover.mediaId ? { verticalCoverMediaId: st.verticalCover.mediaId } : {}),
            };
        const ad = {
            adsetIndex: 0,
            name: st.name || t('adsCreate.defaultName'),
            creative,
            copy: { primaryText: usePost ? '' : st.primaryText, ...(st.headline && !usePost ? { headline: st.headline } : {}), ...(st.goal === 'traffic' ? { cta: st.cta } : {}) },
        };
        if (st.goal === 'traffic') ad.link = st.link.mode === 'offer' && st.link.offerId ? { trackedOfferId: st.link.offerId } : { url: st.link.url.trim() };
        if (st.goal === 'messages' && (st.greeting.trim() || st.ice.length)) {
            ad.message = { greeting: st.greeting.trim(), iceBreakers: st.ice.filter((r) => r.title.trim()).map((r) => ({ title: r.title.trim() })) };
        }
        const spec = {
            name: st.name || t('adsCreate.defaultName'),
            goal: st.goal,
            specialCategory: st.special,
            budget: { home: st.home, kind: st.kind, amount: Number(st.amount), start: this.isoOf(st.start), ...(st.end ? { end: this.isoOf(st.end) } : {}) },
            adsets: [adset],
            ads: [ad],
        };
        if (st.goal === 'messages') spec.destinations = this.DESTINATIONS.filter((d) => st.destinations.includes(d));
        return spec;
    },

    /** What is wrong with a step before moving on: `{ field, message }` or null. The server checks everything again. */
    stepProblem(st) {
        const key = this.STEPS[st.step];
        const bad = (field, message) => ({ field, message });
        if (key === 'goal' && !st.name.trim()) return bad('name', t('adsCreate.err.name'));
        if (key === 'destination') {
            if (st.goal === 'messages' && !st.destinations.length) return bad('destinations', t('adsCreate.err.destinations'));
            if (st.goal === 'traffic' && st.link.mode === 'url' && !/^https:\/\/\S+\.\S+/.test(st.link.url.trim())) return bad('url', t('adsCreate.err.url'));
        }
        if (key === 'creative') {
            if (st.source === 'post' || !this.uploadsAllowed(st)) { if (!st.postId) return bad('postId', t('adsCreate.err.post')); }
            else {
                if (!st.media || !st.media.mediaId) return bad('media', t('adsCreate.err.media'));
                if (st.media.kind === 'video' && !(st.cover && st.cover.mediaId)) return bad('cover', t('adsCreate.err.cover'));
                if (['uploading', 'preparing', 'failed'].includes(st.media.status)) return bad('media', t('adsCreate.err.notReady'));
            }
        }
        if (key === 'copy' && st.source === 'media' && this.uploadsAllowed(st) && !st.primaryText.trim()) return bad('primaryText', t('adsCreate.err.primary'));
        if (key === 'audience') {
            if (!this.countries(st).length) return bad('countries', t('adsCreate.err.countries'));
            const min = Number(st.ageMin);
            if (st.advantage && st.special === 'none' && (min < 18 || min > 25)) return bad('ageMin', t('adsCreate.err.advantageAge'));
            if (st.ageMax !== '' && Number(st.ageMax) < min) return bad('ageMax', t('adsCreate.err.ageMax'));
        }
        if (key === 'placements' && st.placementMode === 'manual' && !st.placements.instagram.length && !st.placements.facebook.length) return bad('placements', t('adsCreate.err.placements'));
        if (key === 'budget') {
            const amount = Number(st.amount);
            if (!Number.isFinite(amount) || amount <= 0) return bad('amount', t('adsCreate.err.amount'));
            if (!Number.isFinite(Date.parse(st.start))) return bad('start', t('adsCreate.err.start'));
            if (st.kind === 'lifetime' && !st.end) return bad('end', t('adsCreate.err.endRequired'));
            if (st.end && !this.days(st)) return bad('end', t('adsCreate.err.endAfter'));
            if (st.kind === 'lifetime' && st.scheduled && (!st.days.length || Number(st.toHour) <= Number(st.fromHour))) return bad('schedule', t('adsCreate.err.schedule'));
            const min = this.minimumFor(st);
            const days = this.days(st);
            const perDay = st.kind === 'daily' ? amount : (days ? amount / days : amount);
            if (min !== null && perDay < min) return bad('amount', t('adsCreate.money.belowMin', { min: this.money(min) }));
        }
        return null;
    },

    // ─── Handlers ─────────────────────────────────────────────────────────────────────────

    /** Any change after a Review drops it: Create sends only what was reviewed. */
    touch() {
        const st = this.state;
        if (!st) return;
        st.rev++;
        if (st.review) { st.review = null; st.ack = false; }
    },

    next() {
        const st = this.state;
        if (!st) return;
        const problem = this.stepProblem(st);
        st.errors = Object.create(null);
        if (problem) {
            st.errors[problem.field] = problem.message;
            this.repaintStep();
            const input = this.host(`adsc-${problem.field}`) || this.host(`adsc-err-${problem.field}`);
            if (input && input.focus) input.focus();
            return;
        }
        st.step = Math.min(this.STEPS.length - 1, st.step + 1);
        this.repaintStep();
        if (this.STEPS[st.step] === 'copy') this.checkPolicy();
        if (this.STEPS[st.step] === 'review') this.review();
        const title = this.host('adsc-step-title');
        if (title && title.focus) { title.setAttribute('tabindex', '-1'); title.focus(); }
    },

    back() {
        const st = this.state;
        if (!st || st.step === 0) return;
        st.step--;
        st.errors = Object.create(null);
        this.repaintStep();
    },

    onField(el) {
        const st = this.state;
        if (!st || !el || !el.dataset) return;
        const name = el.dataset.field;
        const value = el.value === undefined || el.value === null ? '' : String(el.value);
        let repaint = false;
        switch (name) {
            case 'goal':
                if (!this.GOALS.includes(value) || this.LOCKED_GOALS.includes(value)) return;
                st.goal = value; st.optimization = '';
                if (!this.postPlatforms(st).includes(st.platform)) st.platform = 'instagram';
                break;
            case 'name': st.name = value; break;
            case 'optimization': st.optimization = value; repaint = true; break;
            case 'linkMode': st.link.mode = value === 'url' ? 'url' : 'offer'; repaint = true; break;
            case 'offerId': st.link.offerId = value; break;
            case 'url': st.link.url = value; break;
            case 'source': st.source = value === 'post' ? 'post' : 'media'; repaint = true; break;
            case 'postId': st.postId = value; break;
            case 'platform': st.platform = value; break;
            case 'primaryText': {
                st.primaryText = value;
                const count = this.host('adsc-primary-count');
                if (count) count.textContent = t('adsCreate.copy.count', { count: UI.formatNumber(value.length), cut: UI.formatNumber(this.FEED_CUT) });
                this.schedulePolicy();
                break;
            }
            case 'headline': st.headline = value; this.schedulePolicy(); break;
            case 'cta': st.cta = this.CTAS.includes(value) ? value : 'LEARN_MORE'; break;
            case 'greeting': st.greeting = value; this.schedulePolicy(); break;
            case 'countries': st.countries = value; break;
            case 'radius': st.cities.forEach((c) => { c.radiusKm = Math.min(this.RADIUS_MAX, Math.max(this.RADIUS_MIN, Math.round(Number(value) || 25))); }); break;
            case 'ageMin': st.ageMin = value; break;
            case 'ageMax': st.ageMax = value; break;
            case 'gender': st.gender = ['all', 'men', 'women'].includes(value) ? value : 'all'; break;
            case 'special':
                if (!this.SPECIAL.includes(value) || value === 'political') return;
                st.special = value;
                if (value !== 'none') { st.ageMin = '18'; st.ageMax = ''; st.gender = 'all'; st.interests = []; st.cities.forEach((c) => { c.radiusKm = Math.max(25, c.radiusKm); }); }
                repaint = true;
                break;
            case 'placementMode': st.placementMode = value === 'manual' ? 'manual' : 'automatic'; repaint = true; break;
            case 'home': st.home = value === 'campaign' ? 'campaign' : 'adset'; break;
            case 'kind': st.kind = value === 'daily' ? 'daily' : 'lifetime'; if (st.kind === 'daily') st.scheduled = false; repaint = true; break;
            case 'amount': st.amount = value; this.write('adsc-money', this.moneyMarkup(st, this.minimumFor(st), this.days(st))); break;
            case 'start': case 'end': st[name] = value; this.write('adsc-money', this.moneyMarkup(st, this.minimumFor(st), this.days(st))); break;
            case 'fromHour': case 'toHour': st[name] = value; break;
            default: return;
        }
        this.touch();
        if (repaint || name === 'goal') this.repaintStep();
    },

    onDestination(el) {
        const st = this.state;
        if (!st || !el || !this.DESTINATIONS.includes(el.value)) return;
        const set = new Set(st.destinations);
        if (el.checked) set.add(el.value); else set.delete(el.value);
        st.destinations = this.DESTINATIONS.filter((d) => set.has(d));
        this.touch();
    },

    onPlacement(el) {
        const st = this.state;
        if (!st || !el || !el.dataset) return;
        const platform = el.dataset.platform;
        if (!this.PLACEMENTS[platform] || !this.PLACEMENTS[platform].includes(el.value)) return;
        const list = st.placements[platform].filter((p) => p !== el.value);
        if (el.checked) list.push(el.value);
        st.placements[platform] = this.PLACEMENTS[platform].filter((p) => list.includes(p));
        this.touch();
    },

    onAdvantage(el) {
        const st = this.state;
        if (!st) return;
        st.advantage = !!el.checked;
        if (st.advantage) { st.ageMax = ''; if (Number(st.ageMin) > 25) st.ageMin = '25'; }
        this.touch();
        this.repaintStep();
    },

    onDay(el) {
        const st = this.state;
        if (!st) return;
        const d = Number(el.value);
        st.days = st.days.filter((x) => x !== d);
        if (el.checked) st.days.push(d);
        this.touch();
    },

    onToggle(el, key) {
        const st = this.state;
        if (!st) return;
        st[key] = !!el.checked;
        this.touch();
        this.repaintStep();
    },

    onIce(el) {
        const st = this.state;
        if (!st || !el || !el.dataset) return;
        const row = st.ice[Number(el.dataset.index)];
        if (!row) return;
        row.title = String(el.value || '');
        this.schedulePolicy();
        this.touch();
    },

    iceAdd() {
        const st = this.state;
        if (!st || st.ice.length >= this.ICE_MAX) return;
        st.ice.push({ title: '' });
        this.touch();
        this.repaintStep();
    },

    iceRemove(el) {
        const st = this.state;
        if (!st || !el || !el.dataset) return;
        st.ice.splice(Number(el.dataset.index), 1);
        this.touch();
        this.repaintStep();
        this.schedulePolicy();
    },

    onAck(el) {
        const st = this.state;
        if (!st) return;
        st.ack = !!el.checked;
        const nav = this.host('adsc-nav');
        if (nav) { nav.innerHTML = esc(this.navMarkup(st)); UI.icons(nav); }
    },

    async create() {
        const st = this.state;
        if (!st || !this.canCreate(st)) return;
        st.busy = true;
        this.repaintStep();
        let answer = null;
        let failure = null;
        try { answer = await API.createAdsDraft(st.review.spec, !!st.ack); } catch (err) { failure = err; }
        if (this.state !== st) return;
        st.busy = false;
        if (failure) {
            const error = this.host('adsc-error');
            this.repaintStep();
            const host = this.host('adsc-error') || error;
            if (host) host.textContent = this.failureText(failure);
            return;
        }
        UI.toast(t('adsCreate.created'), 'success');
        if (answer && typeof location !== 'undefined') location.hash = '#/ads_campaigns';
    },

    /** The server's code in the interface language where there is a sentence for it, else the server's own. */
    failureText(err) {
        const code = err && (err.code || (err.body && err.body.code));
        if (code === 'RATE_LIMITED' && err.body && err.body.retryAt) return t('adsCreate.err.rateLimited', { time: UI.formatTime(err.body.retryAt) });
        if (code === 'VIDEO_PROCESSING') return t('adsCreate.err.videoProcessing');
        return (err && err.message) || t('error.unexpected');
    },
};

UI.registerActions('adsc', {
    next: () => AdsCreatePage.next(),
    back: () => AdsCreatePage.back(),
    field: (el) => AdsCreatePage.onField(el),
    destination: (el) => AdsCreatePage.onDestination(el),
    placement: (el) => AdsCreatePage.onPlacement(el),
    advantage: (el) => AdsCreatePage.onAdvantage(el),
    day: (el) => AdsCreatePage.onDay(el),
    scheduled: (el) => AdsCreatePage.onToggle(el, 'scheduled'),
    wantVertical: (el) => AdsCreatePage.onToggle(el, 'wantVertical'),
    file: (el) => AdsCreatePage.onFile(el),
    search: (el) => AdsCreatePage.onSearch(el),
    pick: (el) => AdsCreatePage.pick(el),
    unpick: (el) => AdsCreatePage.unpick(el),
    ice: (el) => AdsCreatePage.onIce(el),
    iceAdd: () => AdsCreatePage.iceAdd(),
    iceRemove: (el) => AdsCreatePage.iceRemove(el),
    ack: (el) => AdsCreatePage.onAck(el),
    review: () => AdsCreatePage.review(),
    create: () => AdsCreatePage.create(),
});
