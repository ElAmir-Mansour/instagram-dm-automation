/**
 * The ad builder, QUICK mode (Meta Ads Manager A4: T095): the dialog Posts' Boost button opens, with the post already chosen.
 *
 * Not a route (`routable: false`). Posts loads this module on first use (`App.loadPageModule('ads_builder')`, like `ice_breakers`) and calls
 * `AdsBuilder.openQuick({ post, platforms, settings, onCreated })`. If the module cannot be loaded, Posts opens the older Boost form instead.
 *
 * ─── What it does, in the order the owner meets it ──────────────────────────────────────────────────────────────────────────
 *   1. FILL     goal (Send messages is first, and the default when a message destination exists), the destinations, the countries, the
 *               daily budget, the days, and for a message ad the greeting and up to FOUR ice breakers. The post's caption is the ad's
 *               text and is shown, read only.
 *   2. CHECK    while typing, `API.checkAdsPolicy` runs after a 400 ms pause (never per keystroke; no Meta call). Findings are drawn on the
 *               text, the matched span inside an escaped <mark>, a block told from a warning by its word and its glyph as well as its
 *               colour, the reason and a compliant rewrite in the interface language. The panel is a polite live region, rewritten only
 *               when an answer lands.
 *   3. REVIEW   `API.validateAdsDraft(spec)`: Meta's own validation, the money check against the monthly cap, Meta's minimum budget, what
 *               the server found wrong or wants known, and, for each destination, whether the assistant that answers it is on.
 *   4. CREATE   `API.createAdsDraft(spec, confirmPolicyWarnings)`. The ad is created PAUSED: nothing is spent until Activate on #/ads.
 *
 * ─── The rules this file keeps ──────────────────────────────────────────────────────────────────────────────────────────────
 *   - Create can only send what was REVIEWED. Any change after a Review drops it (`touch`), so the spec Meta validated is the spec created.
 *   - Create is off while the text is blocked (live check or Review), while the server lists problems, while Meta refuses or the money does
 *     not fit, and while a warning has not been read: the tick "I have read the warnings" is what sends `confirmPolicyWarnings: true`.
 *   - The server decides (policy, caps, minimums, what Meta accepts); the checks here only save a round trip, and say which field.
 *   - A late answer for an older text or an older form never lands: every request carries the sequence it was asked in.
 *   - Everything a person wrote, and everything the server said, goes through the `html` tag. Nothing is interpolated into an attribute raw.
 */
const AdsBuilder = {
    /** The goals, in the order they are offered. 'leads' exists on the server and is refused in A4. */
    GOALS: Object.freeze(['messages', 'engagement', 'reach', 'traffic']),
    /** The message destinations, in the canonical order the spec lists them. */
    DESTINATIONS: Object.freeze(['instagram', 'messenger', 'whatsapp']),
    /** The states of the assistant behind a destination that deserve a warning (`on` has none). */
    BOT_ISSUES: Object.freeze(['off', 'test', 'sales_test', 'not_connected']),
    /** The server warnings that have a sentence of their own in both languages; any other shows the server's. */
    WARNING_CODES: Object.freeze(['UNTRACKED_LINK', 'NO_GREETING_ON_POST']),
    /** The countries the owner is most likely to target; any other ISO-2 code can be typed. */
    COUNTRIES: Object.freeze(['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'EG', 'JO', 'IQ', 'MA', 'US', 'GB']),
    /** Budget refusals that belong on the budget field. */
    BUDGET_CODES: Object.freeze(['OVER_MONTHLY_CAP', 'OVER_DAILY_MAX', 'BELOW_META_MINIMUM']),
    /** Where each form field lives, so an error can mark it. */
    FIELD_IDS: Object.freeze({
        platform: 'adsb-platform', goal: 'adsb-goal', destinations: 'adsb-dest-instagram', countries: 'adsb-countries', daily: 'adsb-daily',
        days: 'adsb-days', greeting: 'adsb-greeting', link: 'adsb-link', amount: 'adsb-daily', dailyBudget: 'adsb-daily',
    }),

    /**
     * Whether an ad built from a POST can carry its own greeting and ice breakers. It cannot: Meta refuses `page_welcome_message` on a post
     * creative (live check 2026-10-22, spec.ts POST_GREETING_PLACEMENT), so quick mode, which always boosts a post, hides those fields and
     * says the chat opens with Meta's greeting. Uploaded-media ads (A5) have them.
     */
    GREETING_ON_POST: false,

    /** How long typing must pause before the text is checked. */
    POLICY_DEBOUNCE_MS: 400,
    GREETING_MAX: 300,
    ICE_MAX: 4,
    ICE_TITLE_MAX: 80,
    ICE_RESPONSE_MAX: 300,
    DAYS_MAX: 30,
    /** How much text is kept either side of a highlighted span when a long caption is quoted. */
    CONTEXT_CHARS: 60,

    /** The open dialog's state, or null. */
    state: null,

    // ─── Opening ──────────────────────────────────────────────────────────────────────────

    /**
     * `post` is Posts' row (`id`, `caption`, `platform`), `platforms` the ones a new ad could still go to, `settings` GET /api/ads/settings
     * and `onCreated(answer)` is told when the draft exists.
     */
    openQuick(opts) {
        const o = opts || {};
        const post = o.post || {};
        const settings = o.settings || {};
        const platforms = (Array.isArray(o.platforms) ? o.platforms : []).filter((p) => p === 'instagram' || p === 'facebook');
        const platform = platforms.includes('instagram') ? 'instagram' : (platforms[0] || (post.platform === 'facebook' ? 'facebook' : 'instagram'));
        const available = this.availableDestinations(platform, settings);
        // A Facebook post cannot be a Messenger ad yet (the server says so), so it starts on a goal that works.
        const goal = available.length && platform !== 'facebook' ? 'messages' : 'engagement';
        const min = settings.account && Number(settings.account.minDailyBudget) > 0 ? Number(settings.account.minDailyBudget) : 0;
        const max = Number(this.maxDaily(settings));
        const start = Number.isFinite(max) && max > 0 ? Math.min(max, Math.max(5, min)) : Math.max(5, min);
        const countries = Array.isArray(settings.defaultCountries) && settings.defaultCountries.length
            ? settings.defaultCountries.map((c) => String(c).toUpperCase()).join(', ')
            : 'SA';
        if (this.state) this.dispose(this.state);
        const st = {
            post, platforms, platform, settings, onCreated: typeof o.onCreated === 'function' ? o.onCreated : null,
            currency: (settings.account && settings.account.currency) || '',
            goal,
            destinations: available.length ? [platform === 'instagram' && available.includes('instagram') ? 'instagram' : available[0]] : [],
            countries, daily: String(start), days: '3', greeting: t('adsBuilder.greeting.default'), ice: [], link: '',
            policy: null, review: null, ack: false, busy: false, reviewing: false,
            rev: 0, policySeq: 0, timer: null, orig: Object.create(null),
            // GET /ads/money: undefined while it is on its way, null when it could not be read, else its answer.
            money: undefined,
        };
        this.state = st;
        UI.showModal(this.formMarkup(st));
        // `showModal` runs the previous modal's close hook: this one's is set after it.
        UI._afterClose = () => this.dispose(st);
        this.syncGoal();
        this.syncCreate();
        this.checkPolicyNow();
        this.loadMoney(st);
    },

    /** The owner's max daily budget: `limits` since A1, the flat field before it. */
    maxDaily(settings) {
        const s = settings || {};
        const limits = s.limits && typeof s.limits === 'object' ? s.limits : null;
        return limits && limits.maxDailyBudget !== undefined ? limits.maxDailyBudget : s.maxDailyBudget;
    },

    /**
     * What is left of the month's cap, from `GET /ads/money` (Meta's spend plus what running campaigns can still spend). Asked once when
     * the dialog opens, never per keystroke; "over" is then worked out live. A failure is "unknown": Review asks the server again.
     */
    async loadMoney(st) {
        let answer = null;
        try {
            if (typeof API.getAdsMoney === 'function') answer = await API.getAdsMoney();
        } catch (err) { /* unknown */ }
        if (this.state !== st) return;
        st.money = answer && typeof answer === 'object' ? answer : null;
        this.paintSummary();
    },

    /** The dialog is gone (closed, or replaced by the next one): stop everything that could still write to it. */
    dispose(st) {
        if (!st) return;
        if (st.timer) { clearTimeout(st.timer); st.timer = null; }
        if (this.state === st) this.state = null;
    },

    /** The destinations a message ad could use for this post: the settings may say, else Instagram posts get all three, Facebook posts the other two. */
    availableDestinations(platform, settings) {
        const said = settings && Array.isArray(settings.messageDestinations) ? settings.messageDestinations.filter((d) => this.DESTINATIONS.includes(d)) : null;
        if (said) return this.DESTINATIONS.filter((d) => said.includes(d));
        return this.DESTINATIONS.filter((d) => d !== 'instagram' || platform === 'instagram');
    },

    // ─── Words and numbers ────────────────────────────────────────────────────────────────

    lang() { return typeof I18N !== 'undefined' && I18N.lang === 'ar' ? 'ar' : 'en'; },

    /** `12.5 USD` as one isolated run: a currency code never reorders an Arabic sentence. */
    money(amount, currency) {
        const n = Number(amount);
        if (amount === null || amount === undefined || !Number.isFinite(n)) return '—';
        return `⁦${UI.formatNumber(n)}${currency ? ` ${currency}` : ''}⁩`;
    },

    /** The words for a field the policy check or the server names. */
    fieldLabel(name) {
        const f = this.canonField(name);
        if (f === 'caption') return t('adsBuilder.field.caption');
        if (f === 'greeting') return t('adsBuilder.field.greeting');
        const m = /^iceBreakers\.(\d+)\.(title|response)$/.exec(f);
        if (m) return t(m[2] === 'title' ? 'adsBuilder.field.iceTitle' : 'adsBuilder.field.iceResponse', { n: Number(m[1]) + 1 });
        return String(name || '');
    },

    /** The server may name a field from the spec's root (`ads.0.message.greeting`, `primaryText`): the same field as the form's. */
    canonField(name) {
        const f = String(name || '').replace(/^ads\.\d+\.(?:message|copy)\./, '');
        return f === 'primaryText' ? 'caption' : f;
    },

    // ─── The form's content as the server sees it ─────────────────────────────────────────

    /** The ice breakers that carry anything, in order, trimmed. A blank row is dropped, here and in the spec, so indices agree everywhere. */
    iceRows(st) {
        return (st.ice || [])
            .map((r) => ({ title: String(r.title || '').trim(), response: String(r.response || '').trim() }))
            .filter((r) => r.title || r.response);
    },

    /** The text fields that are checked, by the names the server reports them under. */
    policyFields(st) {
        const fields = {};
        const caption = String(st.post && st.post.caption ? st.post.caption : '');
        if (caption.trim()) fields.caption = caption;
        if (st.goal === 'messages' && this.GREETING_ON_POST) {
            const greeting = String(st.greeting || '').trim();
            if (greeting) fields.greeting = greeting;
            this.iceRows(st).forEach((r, i) => {
                if (r.title) fields[`iceBreakers.${i}.title`] = r.title;
                if (r.response) fields[`iceBreakers.${i}.response`] = r.response;
            });
        }
        return fields;
    },

    /** The text a finding's offsets point into, or null when the form no longer has such a field. */
    fieldText(st, name) {
        const f = this.canonField(name);
        const fields = this.policyFields(st);
        return Object.prototype.hasOwnProperty.call(fields, f) ? fields[f] : null;
    },

    parseCountries(text) {
        const parts = String(text || '').split(/[\s,;،]+/).filter(Boolean).map((c) => c.toUpperCase());
        return { codes: [...new Set(parts.filter((c) => /^[A-Z]{2}$/.test(c)))], bad: parts.filter((c) => !/^[A-Z]{2}$/.test(c)) };
    },

    num(text) { return String(text).trim() === '' ? NaN : Number(text); },

    /** The CampaignSpec the form describes (docs: contracts/dashboard-api.md). Budget amounts are in major units; the ad is for one post. */
    buildSpec(st) {
        const daily = this.num(st.daily);
        const days = this.num(st.days);
        const now = Date.now();
        const countries = this.parseCountries(st.countries).codes;
        const snippet = String((st.post && st.post.caption) || '').replace(/\s+/g, ' ').trim().slice(0, 30);
        const name = `Boost · ${snippet || st.post.id}`;
        const ad = {
            adsetIndex: 0,
            name,
            creative: { source: 'post', postId: String(st.post.id), platform: st.platform },
            copy: { primaryText: String((st.post && st.post.caption) || '') },
        };
        if (st.goal === 'messages' && this.GREETING_ON_POST) {
            ad.message = {
                greeting: String(st.greeting || '').trim(),
                iceBreakers: this.iceRows(st).map((r) => (r.response ? { title: r.title, response: r.response } : { title: r.title })),
            };
        }
        if (st.goal === 'traffic') ad.link = { url: String(st.link || '').trim() };
        const spec = {
            name,
            goal: st.goal,
            specialCategory: 'none',
            budget: {
                home: 'adset', kind: 'lifetime', amount: Math.round(daily * days * 100) / 100,
                start: new Date(now).toISOString(), end: new Date(now + days * 24 * 3600 * 1000).toISOString(),
            },
            adsets: [{ name: countries.join(' ') || name, targeting: { countries, ageMin: 18, advantageAudience: true }, placements: 'automatic' }],
            ads: [ad],
        };
        if (st.goal === 'messages') spec.destinations = this.DESTINATIONS.filter((d) => st.destinations.includes(d));
        return spec;
    },

    /** The first reason the form cannot be sent, as `{ message, field, id? }`, or null. The server checks all of it again. */
    problemOf(st) {
        const settings = st.settings || {};
        const daily = this.num(st.daily);
        const days = this.num(st.days);
        if (!Number.isFinite(daily) || daily <= 0) return { message: t('adsBuilder.err.daily'), field: 'daily' };
        const maxDaily = Number(this.maxDaily(settings));
        if (Number.isFinite(maxDaily) && maxDaily > 0 && daily > maxDaily) {
            return { message: t('adsBuilder.err.overMax', { max: this.money(maxDaily, st.currency) }), field: 'daily' };
        }
        if (!Number.isInteger(days) || days < 1 || days > this.DAYS_MAX) return { message: t('adsBuilder.err.days', { max: this.DAYS_MAX }), field: 'days' };
        const countries = this.parseCountries(st.countries);
        if (!countries.codes.length || countries.bad.length) return { message: t('adsBuilder.err.countries'), field: 'countries' };
        if (st.goal === 'traffic') {
            if (st.platform === 'facebook') return { message: t('adsBuilder.err.trafficInstagram'), field: 'goal' };
            if (!/^https:\/\/[^\s/$.?#][^\s]*$/i.test(String(st.link || '').trim())) return { message: t('adsBuilder.err.link'), field: 'link' };
        }
        if (st.goal === 'messages') {
            if (!st.destinations.length) return { message: t('adsBuilder.err.destinations'), field: 'destinations' };
            if (!this.GREETING_ON_POST) return null;
            const greeting = String(st.greeting || '').trim();
            if (!greeting) return { message: t('adsBuilder.err.greeting'), field: 'greeting' };
            if (Array.from(greeting).length > this.GREETING_MAX) return { message: t('adsBuilder.err.greetingLong', { max: this.GREETING_MAX }), field: 'greeting' };
            const rows = (st.ice || []).map((r, i) => ({ i, title: String(r.title || '').trim(), response: String(r.response || '').trim() }));
            for (const r of rows) {
                if (!r.title && !r.response) continue;
                if (!r.title) return { message: t('adsBuilder.err.iceTitle', { n: r.i + 1 }), field: `ice-title-${r.i}` };
                if (Array.from(r.title).length > this.ICE_TITLE_MAX) return { message: t('adsBuilder.err.iceTitleLong', { n: r.i + 1, max: this.ICE_TITLE_MAX }), field: `ice-title-${r.i}` };
                if (Array.from(r.response).length > this.ICE_RESPONSE_MAX) return { message: t('adsBuilder.err.iceResponseLong', { n: r.i + 1, max: this.ICE_RESPONSE_MAX }), field: `ice-response-${r.i}` };
            }
        }
        return null;
    },

    // ─── Markup ───────────────────────────────────────────────────────────────────────────

    modalHeader(title) {
        return html`
            <div class="modal-header">
                <h2 class="modal-title">${title}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
        `;
    },

    platformLabel(p) { return p === 'facebook' ? 'Facebook' : 'Instagram'; },

    formMarkup(st) {
        const settings = st.settings || {};
        const min = settings.account && Number(settings.account.minDailyBudget) > 0 ? Number(settings.account.minDailyBudget) : 0;
        const max = this.maxDaily(settings);
        const caption = String((st.post && st.post.caption) || '').trim();
        return html`
            ${this.modalHeader(t('adsBuilder.title'))}
            <form id="adsb-form" class="post-composer" data-submit="adsb:review" novalidate>
                <p class="form-hint">${t('adsBuilder.intro')}</p>
                <div class="form-group">
                    <p class="form-label" id="adsb-caption-label">${t('adsBuilder.post.label')}</p>
                    <blockquote class="adsb-caption" id="adsb-caption" dir="auto" aria-labelledby="adsb-caption-label">${caption || t('adsBuilder.post.noCaption')}</blockquote>
                    <p class="form-hint">${t('adsBuilder.post.hint')}</p>
                </div>
                ${st.platforms.length > 1 ? html`
                    <div class="form-group">
                        <label class="form-label" for="adsb-platform">${t('adsBuilder.platform')}</label>
                        <select class="select" id="adsb-platform" data-field="platform" data-change="adsb:field">
                            ${st.platforms.map((p) => html`<option value="${p}" ${p === st.platform ? html.raw('selected') : ''}>${this.platformLabel(p)}</option>`)}
                        </select>
                    </div>
                ` : ''}
                <div class="form-group">
                    <div class="adsb-label-row">
                        <label class="form-label" for="adsb-goal">${t('adsBuilder.goal')}</label>
                        ${UI.helpLink('ads#create-message-ad', t('adsBuilder.help.goal'), { newTab: true })}
                    </div>
                    <select class="select" id="adsb-goal" data-field="goal" data-change="adsb:field" aria-describedby="adsb-goal-hint">
                        ${this.GOALS.map((g) => html`<option value="${g}" ${g === st.goal ? html.raw('selected') : ''}>${t(`adsBuilder.goal.${g}`)}</option>`)}
                    </select>
                    <p class="form-hint" id="adsb-goal-hint">${t('adsBuilder.goal.hint')}</p>
                </div>
                <div id="adsb-messages" class="adsb-messages">
                    <fieldset class="form-group fieldset-plain" id="adsb-dest-group" aria-describedby="adsb-dest-hint">
                        <legend class="form-label">${t('adsBuilder.destinations')}</legend>
                        <div class="adsb-dests">
                            ${this.DESTINATIONS.map((d) => html`
                                <div class="check-row check-row-tap">
                                    <input type="checkbox" id="adsb-dest-${d}" name="destination" value="${d}" data-change="adsb:dest" ${st.destinations.includes(d) ? html.raw('checked') : ''}>
                                    <div class="check-text"><label class="check-label" for="adsb-dest-${d}">${t(`adsBuilder.dest.${d}`)}</label></div>
                                </div>
                            `)}
                        </div>
                        <p class="form-hint" id="adsb-dest-hint">${t('adsBuilder.dest.hint')}</p>
                    </fieldset>
                    ${this.GREETING_ON_POST ? '' : html`<p class="form-hint" id="adsb-no-greeting">${t('adsBuilder.greeting.notOnPost')}</p>`}
                    <div class="${this.GREETING_ON_POST ? html.raw('') : html.raw('hidden')}" id="adsb-greeting-block">
                    <div class="form-group">
                        <label class="form-label" for="adsb-greeting">${t('adsBuilder.greeting')}</label>
                        <textarea class="field" id="adsb-greeting" rows="3" maxlength="${this.GREETING_MAX}" dir="auto" data-field="greeting" data-input="adsb:field"
                                  aria-describedby="adsb-greeting-hint">${st.greeting}</textarea>
                        <p class="form-hint" id="adsb-greeting-hint">${t('adsBuilder.greeting.hint', { max: this.GREETING_MAX })}</p>
                    </div>
                    <div class="form-group" id="adsb-ice">${this.iceMarkup(st)}</div>
                    </div>
                </div>
                <div class="form-group hidden" id="adsb-link-group">
                    <label class="form-label" for="adsb-link">${t('adsBuilder.link.label')}</label>
                    <input class="field field-mono" id="adsb-link" type="url" dir="ltr" inputmode="url" autocomplete="off" spellcheck="false" autocapitalize="off"
                           placeholder="https://" value="${st.link}" data-field="link" data-input="adsb:field" aria-describedby="adsb-link-hint">
                    <p class="form-hint" id="adsb-link-hint">${t('adsBuilder.link.hint')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label" for="adsb-countries">${t('adsBuilder.countries')}</label>
                    <input class="field field-mono" id="adsb-countries" type="text" dir="ltr" list="adsb-countries-list" autocomplete="off" spellcheck="false"
                           autocapitalize="characters" value="${st.countries}" data-field="countries" data-input="adsb:field" aria-describedby="adsb-countries-hint">
                    <datalist id="adsb-countries-list">${this.COUNTRIES.map((c) => html`<option value="${c}"></option>`)}</datalist>
                    <p class="form-hint" id="adsb-countries-hint">${t('adsBuilder.countries.hint')}</p>
                </div>
                <div class="adsb-row">
                    <div class="form-group">
                        <label class="form-label" for="adsb-daily">${t('adsBuilder.daily.label')} ${st.currency ? html`<span class="label-optional">${UI.ltr(st.currency)}</span>` : ''}</label>
                        <input class="field field-mono" id="adsb-daily" type="number" dir="ltr" inputmode="decimal" min="0" step="any" value="${st.daily}"
                               data-field="daily" data-input="adsb:field" data-change="adsb:commit" aria-describedby="adsb-daily-hint adsb-daily-error" required>
                        <p class="form-hint" id="adsb-daily-hint">${min > 0
                            ? t('adsBuilder.daily.hintMin', { max: this.money(max, st.currency), min: this.money(min, st.currency) })
                            : t('adsBuilder.daily.hint', { max: this.money(max, st.currency) })}</p>
                        <p class="form-hint text-danger" id="adsb-daily-error"></p>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="adsb-days">${t('adsBuilder.days.label')}</label>
                        <input class="field field-mono" id="adsb-days" type="number" dir="ltr" inputmode="numeric" min="1" max="${this.DAYS_MAX}" step="1" value="${st.days}"
                               data-field="days" data-input="adsb:field" data-change="adsb:commit" aria-describedby="adsb-days-hint" required>
                        <p class="form-hint" id="adsb-days-hint">${t('adsBuilder.days.hint', { max: this.DAYS_MAX })}</p>
                    </div>
                </div>
                <!-- Not a live region: it is rewritten on every keystroke. The total is read out once, when a field is left (commit). -->
                <div class="boost-summary surface" id="adsb-summary">${this.summaryMarkup(st)}</div>
                <section class="adsb-policy-box" aria-labelledby="adsb-policy-title">
                    <div class="adsb-label-row">
                        <h3 class="adsb-subtitle" id="adsb-policy-title">${t('adsBuilder.policy.title')}</h3>
                        ${UI.helpLink('ads#policy-check', t('adsBuilder.help.policy'), { newTab: true })}
                    </div>
                    <!-- Polite, and rewritten only when an answer lands (after the pause), never while the owner types. -->
                    <div id="adsb-policy" role="status" aria-live="polite"></div>
                </section>
                <div id="adsb-review"></div>
                <div id="adsb-error"></div>
                <p class="form-hint">${t('adsBuilder.safety')}</p>
                <div class="modal-actions">
                    ${UI.button({ variant: 'secondary', label: t('common.cancel'), action: 'ui:closeModal' })}
                    ${UI.button({ variant: 'secondary', type: 'submit', icon: 'check-circle', label: t('adsBuilder.review'), id: 'adsb-review-btn' })}
                    ${UI.button({ variant: 'primary', icon: 'trending-up', label: t('adsBuilder.create'), id: 'adsb-create', action: 'adsb:create', disabled: true })}
                </div>
            </form>
        `;
    },

    /** The ice breakers editor: one row per question, the add button, and the limit said when it is reached. */
    iceMarkup(st) {
        const full = st.ice.length >= this.ICE_MAX;
        return html`
            <fieldset class="fieldset-plain" aria-describedby="adsb-ice-hint">
                <legend class="form-label">${t('adsBuilder.iceBreakers')}</legend>
                <p class="form-hint" id="adsb-ice-hint">${t('adsBuilder.ice.hint', { max: this.ICE_MAX })}</p>
                ${st.ice.map((row, i) => html`
                    <div class="adsb-ice-row" data-ice-row="${i}">
                        <div class="adsb-ice-fields">
                            <label class="form-label" for="adsb-ice-title-${i}">${t('adsBuilder.ice.title', { n: i + 1 })}</label>
                            <input class="field" id="adsb-ice-title-${i}" type="text" dir="auto" maxlength="${this.ICE_TITLE_MAX}" value="${row.title}"
                                   data-index="${i}" data-part="title" data-input="adsb:iceField">
                            <label class="form-label" for="adsb-ice-response-${i}">${t('adsBuilder.iceReply')}<span class="sr-only"> (${t('adsBuilder.ice.title', { n: i + 1 })})</span> <span class="label-optional">${t('adsBuilder.ice.optional')}</span></label>
                            <input class="field" id="adsb-ice-response-${i}" type="text" dir="auto" maxlength="${this.ICE_RESPONSE_MAX}" value="${row.response}"
                                   data-index="${i}" data-part="response" data-input="adsb:iceField">
                        </div>
                        ${UI.button({
                            variant: 'ghost', size: 'sm', icon: 'x', ariaLabel: t('adsBuilder.ice.remove', { n: i + 1 }), title: t('adsBuilder.ice.remove', { n: i + 1 }),
                            action: 'adsb:iceRemove', data: { index: i }, focusKey: `adsb-ice-remove-${i}`,
                        })}
                    </div>
                `)}
                <div class="adsb-ice-add">
                    ${UI.button({
                        variant: 'secondary', size: 'sm', icon: 'plus', label: t('adsBuilder.ice.add'), action: 'adsb:iceAdd', disabled: full, focusKey: 'adsb-ice-add',
                    })}
                    ${full ? html`<span class="form-hint">${t('adsBuilder.ice.max', { max: this.ICE_MAX })}</span>` : ''}
                </div>
            </fieldset>
        `;
    },

    /** The live total (daily × days) and what is left of the month's cap. */
    summaryMarkup(st) {
        const settings = st.settings || {};
        const daily = this.num(st.daily);
        const days = this.num(st.days);
        const total = Number.isFinite(daily) && Number.isFinite(days) && daily > 0 && days > 0 ? daily * days : null;
        const money = (n) => this.money(n, st.currency);
        const lines = [html`<p><strong>${total === null
            ? t('adsBuilder.summary.unknown')
            : t('adsBuilder.summary.total', { daily: money(daily), days: t('boost.daysCount', { count: days }), total: money(total) })}</strong></p>`];
        const m = st.money;
        if (m && m.remaining !== null && m.remaining !== undefined && m.monthlyCap !== null && m.monthlyCap !== undefined) {
            const remaining = Math.max(0, Number(m.remaining) || 0);
            const over = total !== null && total > remaining;
            lines.push(html`<p class="${over ? html.raw('text-warning') : html.raw('form-hint')}">${t('adsBuilder.summary.remaining', { remaining: money(remaining), cap: money(m.monthlyCap) })}${over ? html` ${t('adsBuilder.summary.over')}` : ''}</p>`);
        } else if (m === undefined) {
            lines.push(html`<p class="form-hint">${t('adsBuilder.summary.checking')}</p>`);
        } else {
            lines.push(html`<p class="form-hint">${t('adsBuilder.summary.unknownCap')}</p>`);
        }
        return html`${lines}`;
    },

    // ─── Painting: one host at a time, so typing never loses its place ────────────────────

    host(id) { return document.getElementById(id); },

    write(id, markup) {
        const host = this.host(id);
        if (!host) return null;
        host.innerHTML = markup === '' ? '' : esc(markup);
        if (markup !== '') UI.icons(host);
        return host;
    },

    paintSummary() {
        const st = this.state;
        if (st) this.write('adsb-summary', this.summaryMarkup(st));
    },

    paintIce() {
        const st = this.state;
        if (st) this.write('adsb-ice', this.iceMarkup(st));
    },

    /** Messages fields for the message goal only, the link for traffic only; Link clicks is Instagram's, so it is off while Facebook is chosen. */
    syncGoal() {
        const st = this.state;
        if (!st) return;
        const messages = this.host('adsb-messages');
        if (messages) messages.classList.toggle('hidden', st.goal !== 'messages');
        const link = this.host('adsb-link-group');
        if (link) link.classList.toggle('hidden', st.goal !== 'traffic');
        const goal = this.host('adsb-goal');
        if (goal && goal.options) {
            const traffic = Array.from(goal.options).find((o) => o.value === 'traffic');
            if (traffic) traffic.disabled = st.platform === 'facebook';
        }
    },

    /** Create is on only for a Review that is still current and clean (and, with warnings, read). */
    canCreate(st) {
        const rv = st && st.review;
        if (!rv || st.busy || st.reviewing) return false;
        if (st.policy && st.policy.blocked) return false;
        const a = rv.answer;
        if (a.problems.length) return false;
        if (a.meta && a.meta.ok === false) return false;
        if (a.money && a.money.fits === false) return false;
        if (this.needsAck(st) && !st.ack) return false;
        return true;
    },

    /** Warnings that must be read: a policy warning, a server warning, or an assistant that will not answer. */
    needsAck(st) {
        const rv = st && st.review;
        if (!rv) return false;
        const warn = st.policy && Array.isArray(st.policy.findings) && st.policy.findings.some((f) => f.severity === 'warn');
        return !!(warn || rv.answer.warnings.length || this.botIssues(rv.answer).length);
    },

    botIssues(answer) {
        return (answer.bots || []).filter((b) => b && this.BOT_ISSUES.includes(b.state) && this.DESTINATIONS.includes(b.destination));
    },

    syncCreate() {
        const st = this.state;
        const create = this.host('adsb-create');
        if (!st || !create) return;
        create.disabled = !this.canCreate(st);
        if (st.busy) create.setAttribute('aria-busy', 'true'); else create.removeAttribute('aria-busy');
        const review = this.host('adsb-review-btn');
        if (review) review.disabled = st.busy || st.reviewing;
    },

    /** Swap a button's label for a spinner while its request is out, and back. */
    busyLabel(id, on, label) {
        const st = this.state;
        const btn = this.host(id);
        if (!st || !btn) return;
        if (on) {
            if (st.orig[id] === undefined) st.orig[id] = btn.innerHTML;
            btn.innerHTML = UI.buttonSpinner(label);
        } else if (st.orig[id] !== undefined) {
            btn.innerHTML = st.orig[id];
            delete st.orig[id];
            UI.icons(btn);
        }
    },

    /** The form changed: whatever was reviewed no longer describes it. */
    touch() {
        const st = this.state;
        if (!st) return;
        st.rev++;
        st.ack = false;
        if (st.review) {
            st.review = null;
            this.write('adsb-review', '');
        }
        this.clearErrors();
        this.syncCreate();
    },

    clearErrors() {
        this.write('adsb-error', '');
        this.write('adsb-daily-error', '');
        const form = this.host('adsb-form');
        if (form) UI.clearInvalid(form);
    },

    showError(message, fieldKey) {
        const stripId = 'adsb-error-strip';
        const form = this.host('adsb-form');
        if (form) UI.clearInvalid(form);
        const host = this.write('adsb-error', UI.errorStrip(message, '', stripId));
        const id = fieldKey ? (this.FIELD_IDS[fieldKey] || (/^ice-(?:title|response)-\d+$/.test(fieldKey) ? `adsb-${fieldKey}` : '')) : '';
        const input = id ? this.host(id) : null;
        if (input) UI.markInvalid(input, stripId);
        else if (host && typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
    },

    /** A budget refusal is said on the budget field, which points at it. */
    showBudgetError(message) {
        const note = this.write('adsb-daily-error', html`${message}`);
        const input = this.host('adsb-daily');
        if (input) UI.markInvalid(input, 'adsb-daily-error');
        else this.showError(message, 'daily');
    },

    // ─── The live policy check ────────────────────────────────────────────────────────────

    /** After the pause. Every keystroke moves the deadline; nothing is asked while the owner is still typing. */
    schedulePolicy() {
        const st = this.state;
        if (!st) return;
        if (st.timer) clearTimeout(st.timer);
        st.timer = setTimeout(() => { st.timer = null; if (this.state === st) this.checkPolicyNow(); }, this.POLICY_DEBOUNCE_MS);
    },

    async checkPolicyNow() {
        const st = this.state;
        if (!st || typeof API.checkAdsPolicy !== 'function') return;
        if (st.timer) { clearTimeout(st.timer); st.timer = null; }
        const fields = this.policyFields(st);
        const seq = ++st.policySeq;
        if (!Object.keys(fields).length) {
            st.policy = null;
            this.paintPolicy();
            this.syncCreate();
            return;
        }
        let answer = null;
        try {
            answer = await API.checkAdsPolicy(fields);
        } catch (err) {
            // The check is advice; the server runs it again at Review and at Create. A failed check says nothing and blocks nothing.
            return;
        }
        if (this.state !== st || st.policySeq !== seq || !answer || !Array.isArray(answer.findings)) return;
        st.policy = { blocked: !!answer.blocked, findings: answer.findings };
        this.paintPolicy();
        this.syncCreate();
    },

    /**
     * The findings, drawn on the text. Findings are grouped by the field they are in; the text is shown once with every span in a <mark>.
     * A span is only drawn where the text still says what the finding matched: if it does not (the form moved on), the matched words are
     * shown on their own rather than a wrong stretch of the text.
     */
    policyMarkup(st) {
        const policy = st.policy;
        if (!policy) return '';
        const lang = this.lang();
        const findings = Array.isArray(policy.findings) ? policy.findings : [];
        if (!findings.length) return html`<p class="adsb-clean"><i data-lucide="check-circle" aria-hidden="true"></i> <span class="text-success">${t('adsBuilder.policy.clean')}</span></p>`;
        const groups = [];
        for (const f of findings) {
            const key = this.canonField(f.field);
            let g = groups.find((x) => x.key === key);
            if (!g) { g = { key, field: f.field, items: [] }; groups.push(g); }
            g.items.push(f);
        }
        const head = policy.blocked ? t('adsBuilder.policy.blocked') : t('adsBuilder.policy.warnOnly');
        return html`
            <p class="${policy.blocked ? html.raw('text-danger') : html.raw('text-warning')}"><strong>${head}</strong></p>
            <ul class="adsb-fields">
                ${groups.map((g) => html`
                    <li class="adsb-field" data-field="${g.key}">
                        <p class="adsb-field-name">${this.fieldLabel(g.field)}</p>
                        ${this.snippetMarkup(this.fieldText(st, g.field), g.items)}
                        <ul class="adsb-findings">
                            ${g.items.map((f) => this.findingMarkup(f, lang))}
                        </ul>
                    </li>
                `)}
            </ul>
        `;
    },

    snippetMarkup(text, items) {
        const spans = [];
        const loose = [];
        for (const f of items) {
            const s = Number(f.start);
            const e = Number(f.end);
            if (typeof text === 'string' && Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > s && e <= text.length && text.slice(s, e) === f.match) spans.push({ start: s, end: e });
            else if (f.match) loose.push(String(f.match));
        }
        const out = [];
        if (spans.length) {
            spans.sort((a, b) => a.start - b.start || a.end - b.end);
            const merged = [];
            for (const s of spans) {
                const last = merged[merged.length - 1];
                if (last && s.start <= last.end) last.end = Math.max(last.end, s.end); else merged.push({ ...s });
            }
            const from = Math.max(0, merged[0].start - this.CONTEXT_CHARS);
            const to = Math.min(text.length, merged[merged.length - 1].end + this.CONTEXT_CHARS);
            const parts = [];
            if (from > 0) parts.push('…');
            let cursor = from;
            for (const s of merged) {
                if (s.start > cursor) parts.push(text.slice(cursor, s.start));
                parts.push(html`<mark class="adsb-mark">${text.slice(s.start, s.end)}</mark>`);
                cursor = s.end;
            }
            if (cursor < to) parts.push(text.slice(cursor, to));
            if (to < text.length) parts.push('…');
            out.push(html`<p class="adsb-snippet" dir="auto">${parts}</p>`);
        }
        if (loose.length) out.push(html`<p class="adsb-snippet" dir="auto">${[...new Set(loose)].map((m, i) => html`${i ? ' ' : ''}<mark class="adsb-mark">${m}</mark>`)}</p>`);
        return html`${out}`;
    },

    findingMarkup(f, lang) {
        const block = f.severity === 'block';
        const explain = f.explain && (f.explain[lang] || f.explain.en) ? (f.explain[lang] || f.explain.en) : '';
        const rewrite = f.rewrite && (f.rewrite[lang] || f.rewrite.en) ? (f.rewrite[lang] || f.rewrite.en) : '';
        return html`
            <li class="adsb-finding ${block ? html.raw('adsb-finding--block') : html.raw('adsb-finding--warn')}" data-severity="${block ? 'block' : 'warn'}" data-rule="${f.ruleId}">
                <span class="badge ${block ? html.raw('badge-danger') : html.raw('badge-warning')}"><i data-lucide="${block ? 'alert-circle' : 'alert-triangle'}" aria-hidden="true"></i> ${block ? t('adsBuilder.policy.blockBadge') : t('adsBuilder.policy.warnBadge')}</span>
                ${explain ? html`<p class="adsb-why" dir="auto">${explain}</p>` : ''}
                ${rewrite ? html`<p class="adsb-rewrite" dir="auto"><strong>${t('adsBuilder.policy.rewrite')}</strong> ${rewrite}</p>` : ''}
            </li>
        `;
    },

    paintPolicy() {
        const st = this.state;
        if (!st) return;
        this.write('adsb-policy', this.policyMarkup(st));
    },

    // ─── Review ───────────────────────────────────────────────────────────────────────────

    async review() {
        const st = this.state;
        if (!st || st.busy || st.reviewing) return;
        this.clearErrors();
        const problem = this.problemOf(st);
        if (problem) { this.showError(problem.message, problem.field); return; }
        if (typeof API.validateAdsDraft !== 'function') return;
        const spec = this.buildSpec(st);
        const rev = ++st.rev;
        st.policySeq++; // a live check still on its way describes an older text
        st.reviewing = true;
        this.busyLabel('adsb-review-btn', true, t('adsBuilder.review.checking'));
        this.syncCreate();
        let answer = null;
        let failure = null;
        try {
            answer = await API.validateAdsDraft(spec);
        } catch (err) {
            failure = err;
        }
        if (this.state !== st) return;
        st.reviewing = false;
        this.busyLabel('adsb-review-btn', false);
        if (st.rev !== rev) { this.syncCreate(); return; } // the form changed while Meta was being asked
        if (failure || !answer) {
            this.showError((failure && failure.message) || t('error.unexpected'), failure && failure.body && failure.body.field);
            this.syncCreate();
            return;
        }
        const normal = {
            policy: answer.policy && Array.isArray(answer.policy.findings) ? answer.policy : { blocked: false, findings: [] },
            money: answer.money || null,
            meta: answer.meta || null,
            problems: Array.isArray(answer.problems) ? answer.problems : [],
            warnings: Array.isArray(answer.warnings) ? answer.warnings : [],
            bots: Array.isArray(answer.bots) ? answer.bots : [],
        };
        st.review = { spec, answer: normal };
        st.policy = { blocked: !!normal.policy.blocked, findings: normal.policy.findings };
        this.paintPolicy();
        this.write('adsb-review', this.reviewMarkup(st));
        this.syncCreate();
    },

    /** A server warning in the interface language when it has a sentence here, else in the server's words. */
    warningText(w) {
        const key = `adsBuilder.warn.${w.code}`;
        if (this.WARNING_CODES.includes(w.code)) return t(key);
        return String(w.message || w.code || '');
    },

    botLink(destination) {
        return destination === 'whatsapp' ? '#/settings?s=whatsapp' : '#/ai_settings';
    },

    reviewMarkup(st) {
        const a = st.review.answer;
        const cur = (a.money && a.money.currency) || st.currency;
        const money = (n) => this.money(n, cur);
        const m = a.money;
        const lines = [];
        if (m) {
            const text = m.fits === false
                ? t('adsBuilder.review.moneyOver', { remaining: money(m.remaining) })
                : (m.remaining === null || m.remaining === undefined ? t('adsBuilder.review.moneyFitsNoCap') : t('adsBuilder.review.moneyFits', { remaining: money(m.remaining) }));
            lines.push(html`<p data-adsb="money" data-fits="${m.fits === false ? 'false' : 'true'}"><i data-lucide="${m.fits === false ? 'alert-circle' : 'check-circle'}" aria-hidden="true"></i> <span class="${m.fits === false ? html.raw('text-danger') : html.raw('text-success')}">${text}</span></p>`);
        }
        if (a.meta) {
            if (a.meta.minimumBudget !== null && a.meta.minimumBudget !== undefined) {
                lines.push(html`<p data-adsb="minimum"><i data-lucide="info" aria-hidden="true"></i> <span>${t('adsBuilder.review.minimum', { min: money(a.meta.minimumBudget) })}</span></p>`);
            }
            if (a.meta.ok === false) {
                lines.push(html`<p data-adsb="meta-error"><i data-lucide="alert-circle" aria-hidden="true"></i> <span class="text-danger" dir="auto">${t('adsBuilder.review.metaError', { error: a.meta.error || t('adsBuilder.review.metaNoReason') })}</span></p>`);
            } else if (a.meta.ok === true) {
                lines.push(html`<p data-adsb="meta-ok"><i data-lucide="check-circle" aria-hidden="true"></i> <span class="text-success">${t('adsBuilder.review.metaOk')}</span></p>`);
            }
        }
        const problems = a.problems.length ? html`
            <div class="adsb-block">
                <p class="text-danger"><strong>${t('adsBuilder.review.problems')}</strong></p>
                <ul>${a.problems.map((p) => html`<li data-adsb="problem" data-code="${p.code}" dir="auto">${p.message}</li>`)}</ul>
            </div>` : '';
        const warnings = a.warnings.length ? html`
            <div class="adsb-block">
                <p class="text-warning"><strong>${t('adsBuilder.review.warnings')}</strong></p>
                <ul>${a.warnings.map((w) => html`<li data-adsb="warning" data-code="${w.code}" dir="auto">${this.warningText(w)}</li>`)}</ul>
            </div>` : '';
        const issues = this.botIssues(a);
        const bots = issues.length ? html`
            <div class="adsb-block">
                <ul>${issues.map((b) => html`
                    <li data-adsb="bot" data-bot="${b.destination}" data-bot-state="${b.state}">
                        <i data-lucide="alert-triangle" aria-hidden="true"></i>
                        <span class="text-warning">${t(`adsBuilder.bot.${b.state}`, { destination: t(`adsBuilder.dest.${b.destination}`) })}</span>
                        <a href="${this.botLink(b.destination)}">${t('adsBuilder.bot.fix')}</a>
                    </li>`)}
                </ul>
            </div>` : '';
        const ack = this.needsAck(st) ? html`
            <div class="check-row check-row-tap adsb-ack">
                <input type="checkbox" id="adsb-ack" data-change="adsb:ack" ${st.ack ? html.raw('checked') : ''} aria-describedby="adsb-ack-hint">
                <div class="check-text">
                    <label class="check-label" for="adsb-ack">${t('adsBuilder.ack')}</label>
                    <p class="form-hint" id="adsb-ack-hint">${t('adsBuilder.ack.hint')}</p>
                </div>
            </div>` : '';
        return html`
            <section class="adsb-review surface" aria-labelledby="adsb-review-title">
                <h3 class="adsb-subtitle" id="adsb-review-title">${t('adsBuilder.review.title')}</h3>
                ${lines}
                ${problems}
                ${warnings}
                ${bots}
                ${ack}
            </section>
        `;
    },

    // ─── Create ───────────────────────────────────────────────────────────────────────────

    async create() {
        const st = this.state;
        if (!st || !this.canCreate(st)) return;
        this.clearErrors();
        const spec = st.review.spec; // what was reviewed, byte for byte
        const confirm = !!st.ack;
        st.busy = true;
        this.busyLabel('adsb-create', true, t('adsBuilder.create.busy'));
        this.syncCreate();
        let answer = null;
        let failure = null;
        try {
            answer = await API.createAdsDraft(spec, confirm);
        } catch (err) {
            failure = err;
        }
        if (this.state !== st) return;
        st.busy = false;
        this.busyLabel('adsb-create', false);
        if (failure) {
            this.createFailed(st, failure);
            this.syncCreate();
            return;
        }
        const onCreated = st.onCreated;
        this.created(st, answer, spec);
        if (onCreated) { try { onCreated(answer); } catch (err) { console.error('onCreated failed:', err); } }
    },

    createFailed(st, err) {
        const code = err && err.code;
        const body = err && err.body && typeof err.body === 'object' ? err.body : {};
        // POLICY_WARNINGS: the server found a warning this Review did not show (the caption changed meanwhile): drawn the same way.
        if ((code === 'POLICY_BLOCKED' || code === 'POLICY_WARNINGS') && Array.isArray(body.findings)) {
            st.policy = { blocked: code === 'POLICY_BLOCKED', findings: body.findings };
            this.paintPolicy();
            this.showError((err && err.message) || t('adsBuilder.err.policyBlocked'), '');
            return;
        }
        if (this.BUDGET_CODES.includes(code)) {
            this.showBudgetError((err && err.message) || t('error.unexpected'));
            return;
        }
        this.showError((err && err.message) || t('error.unexpected'), body.field);
    },

    /** The dialog after the draft exists: it is PAUSED, and nothing is spent until Activate on the Ads screen. */
    created(st, answer, spec) {
        const total = spec && spec.budget ? this.money(spec.budget.amount, st.currency) : null;
        const days = this.num(st.days);
        UI.showModal(html`
            ${this.modalHeader(t('adsBuilder.created.title'))}
            <p class="modal-body-text" dir="auto">${t('adsBuilder.created.body')}</p>
            ${total !== null && Number.isFinite(days) ? html`<p class="form-hint">${t('adsBuilder.created.hint', { total, days: t('boost.daysCount', { count: days }) })}</p>` : ''}
            <div class="modal-actions">
                ${UI._anchorButton({ href: '#/ads', label: t('adsBuilder.created.openAds'), icon: 'megaphone', variant: 'primary' })}
                ${UI.button({ variant: 'secondary', label: t('common.close'), action: 'ui:closeModal' })}
            </div>
        `);
        UI.toast(t('adsBuilder.created.toast'), 'success');
    },

    // ─── Field handlers ───────────────────────────────────────────────────────────────────

    /** Any simple field. `el.dataset.field` says which; the value goes into the state and the panels that depend on it are redrawn. */
    onField(el) {
        const st = this.state;
        if (!st || !el || !el.dataset) return;
        const name = el.dataset.field;
        const value = el.value === undefined || el.value === null ? '' : String(el.value);
        switch (name) {
            case 'goal':
                if (!this.GOALS.includes(value)) return;
                st.goal = value;
                if (value === 'messages' && !st.destinations.length) {
                    const first = this.availableDestinations(st.platform, st.settings)[0];
                    if (first) st.destinations = [first];
                    this.syncDestinations();
                }
                this.syncGoal();
                this.schedulePolicy();
                break;
            case 'platform':
                if (!st.platforms.includes(value)) return;
                st.platform = value;
                if (value === 'facebook' && st.goal === 'traffic') {
                    st.goal = 'engagement';
                    const goal = this.host('adsb-goal');
                    if (goal) goal.value = 'engagement';
                }
                this.syncGoal();
                break;
            case 'greeting':
                st.greeting = value;
                this.schedulePolicy();
                break;
            case 'countries': st.countries = value; break;
            case 'daily': st.daily = value; this.paintSummary(); break;
            case 'days': st.days = value; this.paintSummary(); break;
            case 'link': st.link = value; break;
            default: return;
        }
        this.touch();
    },

    syncDestinations() {
        const st = this.state;
        if (!st) return;
        for (const d of this.DESTINATIONS) {
            const box = this.host(`adsb-dest-${d}`);
            if (box) box.checked = st.destinations.includes(d);
        }
    },

    onDestination(el) {
        const st = this.state;
        if (!st || !el || !this.DESTINATIONS.includes(el.value)) return;
        const set = new Set(st.destinations);
        if (el.checked) set.add(el.value); else set.delete(el.value);
        st.destinations = this.DESTINATIONS.filter((d) => set.has(d));
        this.touch();
    },

    onIceField(el) {
        const st = this.state;
        if (!st || !el || !el.dataset) return;
        const row = st.ice[Number(el.dataset.index)];
        const part = el.dataset.part;
        if (!row || (part !== 'title' && part !== 'response')) return;
        row[part] = el.value === undefined || el.value === null ? '' : String(el.value);
        this.schedulePolicy();
        this.touch();
    },

    iceAdd() {
        const st = this.state;
        if (!st || st.ice.length >= this.ICE_MAX) return;
        st.ice.push({ title: '', response: '' });
        this.paintIce();
        const input = this.host(`adsb-ice-title-${st.ice.length - 1}`);
        if (input && typeof input.focus === 'function') input.focus();
        this.touch();
    },

    iceRemove(el) {
        const st = this.state;
        if (!st || !el || !el.dataset) return;
        const index = Number(el.dataset.index);
        if (!Number.isInteger(index) || index < 0 || index >= st.ice.length) return;
        st.ice.splice(index, 1);
        this.paintIce();
        const add = this.host('adsb-ice-add');
        void add;
        this.schedulePolicy();
        this.touch();
    },

    onAck(el) {
        const st = this.state;
        if (!st || !st.review) return;
        st.ack = !!(el && el.checked);
        this.syncCreate();
    },

    /** A budget or days field was left: the total is said once, for a screen reader, instead of on every digit. */
    commit() {
        const summary = this.host('adsb-summary');
        const said = summary && typeof summary.textContent === 'string' ? summary.textContent.replace(/\s+/g, ' ').trim() : '';
        if (said && typeof Motion !== 'undefined' && typeof Motion.announce === 'function') Motion.announce(said);
    },
};

UI.registerActions('adsb', {
    field: (el) => AdsBuilder.onField(el),
    dest: (el) => AdsBuilder.onDestination(el),
    iceField: (el) => AdsBuilder.onIceField(el),
    iceAdd: () => AdsBuilder.iceAdd(),
    iceRemove: (el) => AdsBuilder.iceRemove(el),
    ack: (el) => AdsBuilder.onAck(el),
    commit: () => AdsBuilder.commit(),
    review: (el, event) => { if (event && typeof event.preventDefault === 'function') event.preventDefault(); AdsBuilder.review(); },
    create: () => AdsBuilder.create(),
});
