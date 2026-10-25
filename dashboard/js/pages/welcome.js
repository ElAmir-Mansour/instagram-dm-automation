/**
 * The setup wizard (`#/welcome`): where a tenant that has not finished setting up lands after accepting an invite, and
 * from every other route (plan P18; docs/onboarding/02 §3).
 *
 * It is NOT a page of the app. It renders into `#welcome-root` inside `#welcome-screen`, a sibling of the login and invite
 * screens: one task, no sidebar, a sticky bar at the bottom of a phone. `App.showWelcome()` opens it, the navigate gate
 * (`App.mustOnboard`) sends people to it, and `App.leaveWelcome()` is how it ends. W0 (choosing a password) is the invite page
 * (`invite.js`), before there is a session; this is W1 to W6.
 *
 * ─── The steps ──────────────────────────────────────────────────────────────
 * W1, W2 and W3 are forms with sensible defaults (the draft assist of P24 fills them on request). W4 (P28, connecting accounts) is on
 * only when the operator has switched "Connect with Facebook" on: until then the server leaves it out of the order. W5 (P25, the proof
 * samples) is `welcome_proof.js`: two samples written by the production builders for the person to judge, which says plainly when there
 * is no AI key and never stands in the way of finishing. W6 says what is on and what is waiting. Each is a seam:
 * `WelcomePage.register(id, def)` adds a step, and the server enabling it is all the shell needs; progress, Back and Next, autosave,
 * resume and the 409 path are the shell's and a step does not rewrite them.
 *
 * ─── Two kinds of save, which never meet ────────────────────────────────────
 *   - **Autosave** (800 ms after typing, and on blur): what was typed goes to `onboarding.steps[step].values`
 *     (`PUT /api/onboarding/steps/:step`). It never touches the profile, so it cannot bump its version or conflict with anyone.
 *   - **Continue** is the confirmation: `PATCH /api/profile { version, patch }`, then the step is marked done. When somebody
 *     else wrote the profile in between (an admin filling in for the tenant) the server answers 409; the page reloads that
 *     step from the server and shows the newer values, with a note saying so.
 *
 * ─── Escaping ───────────────────────────────────────────────────────────────
 * Every value a person or the server supplied (the tenant's name, what they typed, the operator's hints, the server's problem
 * list) reaches the page through `html`, in a quoted attribute or as text, and `view()` is pure so a test can feed it a payload
 * in each of them. The brand preview's colours are computed from validated `#RRGGBB` values and set as CSS custom properties
 * from script after the markup is painted, never interpolated into a `style` attribute.
 */
const WelcomePage = {
    // ─── The step registry: the seam ─────────────────────────────────────────
    //
    // `register(id, def)` adds or replaces a step. A step the server enables (`GET /api/onboarding` → `order`) and that has no
    // definition here is left out of the sequence and the progress count, so a server that is ahead of this file never
    // strands a tenant on a screen nobody can draw.
    //
    //   code, required      the plan's name (W1…) and whether it can be skipped (the server enforces it too)
    //   title, lead, next   i18n keys; `title` and `lead` may be functions of the state
    //   skippable           shows "Skip for now"
    //   initial(onb)        the form values: the autosaved draft, else the confirmed profile, else what the operator typed
    //   read(form, values)  the values the form shows now (from the DOM)
    //   problems(values)    [{ field, key }]: what is wrong, checked before anything is sent
    //   patch(values, profile)   what Continue sends to PATCH /api/profile ({} when there is nothing to send)
    //   fields(state)       the form's markup
    //   assist(state)       optional: a panel shown above the form, outside it (the draft assist on W1, `welcome_draft.js`)
    //   after(root, state)  wiring after the markup is painted
    STEPS: Object.create(null),

    register(id, def) {
        this.STEPS[id] = def;
    },

    // ─── Constants ───────────────────────────────────────────────────────────

    KINDS: ['educator', 'coach', 'shop', 'agency', 'creator'],
    REGISTERS: ['msa', 'gulf', 'egyptian', 'levantine', 'en'],
    /** The kind of thing a new offer is, by what the person does. An existing offer keeps the kind it has. */
    OFFER_KIND_FOR: { educator: 'program', coach: 'coaching', shop: 'product', agency: 'service', creator: 'other' },
    /** The English noun phrase the prompts call them, from what they do (`identity.role`), only while it is empty or one of these. */
    ROLE_FOR: { educator: 'educator', coach: 'coach', shop: 'shop owner', agency: 'agency', creator: 'content creator' },
    /** The countries offered: the Arab world first by use, then a few others. Names come from `Intl.DisplayNames`. */
    COUNTRY_CODES: ['SA', 'AE', 'EG', 'KW', 'QA', 'BH', 'OM', 'JO', 'LB', 'IQ', 'SY', 'PS', 'YE', 'LY', 'TN', 'DZ', 'MA', 'SD',
        'TR', 'US', 'GB', 'CA', 'DE', 'FR', 'ES', 'IT', 'MY', 'PK', 'IN', 'ID', 'NG', 'KE', 'ZA', 'AU'],
    /** Tone words are content, not interface: they are written into prompts, so they are in the language of the voice. */
    TONE_WORDS: {
        ar: ['ودّي', 'مباشر', 'مرح', 'احترافي', 'ملهم', 'هادئ'],
        en: ['Warm', 'Direct', 'Playful', 'Professional', 'Inspiring', 'Calm'],
    },
    MAX_TONE: 3,
    SAVE_DELAY_MS: 800,
    /** The preset rules a tenant sees on the last screen, with the i18n key that says each in plain words. */
    RULES: { no_women_imagery: 'welcome.rule.no_women_imagery' },
    /** A portrait is one of our own uploads (the profile's `UPLOAD_URL`): the page refuses to send anything else. */
    UPLOAD_URL: /^https:\/\/[^\s/]+\/api\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jpg)?$/i,

    // ─── State ───────────────────────────────────────────────────────────────

    state: null,
    _wired: false,
    _saveTimer: null,
    _saving: null,
    _vvHandler: null,
    _onFocusOut: null,
    _onKeyDown: null,

    freshState() {
        return {
            /** loading | ready | failed | forbidden */
            phase: 'loading',
            onb: null,
            step: 'about',
            values: {},
            /** field → i18n key, from the checks made before anything is sent. */
            errors: {},
            /** The server's own sentences, when it refused a save; shown as they are, escaped. */
            problems: [],
            /** '' | conflict | missing: the one note over the form. */
            notice: '',
            /** idle | saving | saved | error */
            save: 'idle',
            inApp: '',
            finishing: false,
            finishFailed: false,
            rulesOpen: false,
            portraitError: false,
            busy: false,
            tenants: [],
            tenantId: '',
            /** The connect step (P28): the three connections and the test comment. Null until the step is shown. */
            connect: null,
            /** The proof step (P25): the cards, and what is in flight on each. Null until the step is shown; `welcome_proof.js` owns it. */
            proof: null,
            /** The first comment campaign `complete` made (P25), or null: the last screen says so. */
            firstCampaign: null,
            /** What a return from a provider's consent screen said (`meta`, `reason`, `warn`, `pick`, `tiktok`, `youtube`): read from the address before the first paint rewrites it, used once. */
            returned: null,
        };
    },

    // ─── Pure helpers ────────────────────────────────────────────────────────

    /** The steps this page can show, in the server's order: switched on by the server and defined here. */
    stepOrder(onb) {
        const order = onb && Array.isArray(onb.order) ? onb.order : [];
        return order.filter((s) => s && s.enabled && this.STEPS[s.id]).map((s) => s.id);
    },

    /** The steps with something to fill in: the sequence without the last screen. */
    formSteps(onb) {
        return this.stepOrder(onb).filter((id) => id !== 'done');
    },

    isSettled(onb, id) {
        const entry = onb && onb.steps ? onb.steps[id] : null;
        return !!(entry && (entry.status === 'done' || entry.status === 'skipped'));
    },

    /** The furthest a person may go: the first step still open, or the last screen. */
    firstOpen(onb) {
        return this.formSteps(onb).find((id) => !this.isSettled(onb, id)) || 'done';
    },

    /** May this step be shown? Never past the first one still open: a required step is not skipped by typing the address. */
    reachable(onb, id) {
        const order = this.stepOrder(onb);
        const at = order.indexOf(id);
        if (at === -1) return false;
        if (onb && onb.status === 'completed') return true;
        return at <= order.indexOf(this.firstOpen(onb));
    },

    /** The step before this one that is shown, or null. */
    previousStep(onb, id) {
        const order = this.stepOrder(onb);
        const at = order.indexOf(id);
        return at > 0 ? order[at - 1] : null;
    },

    nextStep(onb, id) {
        const order = this.stepOrder(onb);
        const at = order.indexOf(id);
        return at >= 0 && at < order.length - 1 ? order[at + 1] : 'done';
    },

    /** `{ index, total }` over the steps with something to fill in (the last screen is not counted). 0 for the last screen. */
    progress(onb, id) {
        const steps = this.formSteps(onb);
        const at = steps.indexOf(id);
        return { index: at === -1 ? 0 : at + 1, total: steps.length };
    },

    /** Is the on-screen keyboard open? The page the keyboard resizes is the visual viewport, not the layout one. */
    keyboardOpen(innerHeight, viewportHeight) {
        return Number(innerHeight) - Number(viewportHeight) > 150;
    },

    isTimeZone(zone) {
        if (typeof zone !== 'string' || !zone) return false;
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: zone });
            return true;
        } catch {
            return false;
        }
    },

    /** The device's own time zone, if it says (the profile asks for one, and a person should not have to know it). */
    detectTimezone() {
        try {
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            return this.isTimeZone(zone) ? zone : '';
        } catch {
            return '';
        }
    },

    /** Every zone the browser knows, with the one chosen and UTC always among them. */
    timezones(chosen) {
        let list = [];
        try {
            if (typeof Intl.supportedValuesOf === 'function') list = Array.from(Intl.supportedValuesOf('timeZone'));
        } catch { list = []; }
        const set = new Set(list);
        set.add('UTC');
        if (this.isTimeZone(chosen)) set.add(chosen);
        return Array.from(set).sort();
    },

    /** `[{ code, name }]` in the interface's language, sorted by name. */
    countries() {
        let names = null;
        try { names = new Intl.DisplayNames([I18N.locale()], { type: 'region' }); } catch { names = null; }
        const label = (code) => {
            try { return (names && names.of(code)) || code; } catch { return code; }
        };
        return this.COUNTRY_CODES.map((code) => ({ code, name: label(code) }))
            .sort((a, b) => a.name.localeCompare(b.name, I18N.lang));
    },

    /** An address as people type it: "shop.example/x" becomes "https://shop.example/x". Anything else is left to be refused. */
    normaliseUrl(value) {
        const text = String(value || '').trim();
        if (!text) return '';
        return /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
    },

    isUrl(value) {
        return /^https?:\/\/\S+$/i.test(String(value || '')) && String(value).length <= 1000;
    },

    /** A handle without its @ and spaces, at most 32 characters (the profile's limit). */
    cleanHandle(value) {
        return String(value || '').trim().replace(/^@+/, '').replace(/\s+/g, '').slice(0, 32);
    },

    /** A site as it is printed on a graphic: no scheme, no trailing slash, at most 40 characters. */
    cleanSite(value) {
        return String(value || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '').slice(0, 40);
    },

    scriptOf(text) {
        return /[؀-ۿ]/.test(String(text || '')) ? 'ar' : 'en';
    },

    // ─── Colour (the brand step) ─────────────────────────────────────────────

    /** `#RRGGBB` in capitals, or `fallback`. The only way a colour from a form or the server reaches a preview. */
    safeHex(value, fallback) {
        const v = String(value === null || value === undefined ? '' : value).trim();
        return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : fallback;
    },

    hexToRgb(hex) {
        const n = parseInt(String(hex).slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    },

    rgbToHex(rgb) {
        return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    },

    /** `a` mixed with `b`, `weight` of the way (0 is a, 1 is b). */
    mix(a, b, weight) {
        const x = this.hexToRgb(a);
        const y = this.hexToRgb(b);
        return this.rgbToHex(x.map((c, i) => c + (y[i] - c) * weight));
    },

    luminance(hex) {
        const lin = (c) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        const [r, g, b] = this.hexToRgb(hex);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    },

    /** WCAG contrast ratio of two `#RRGGBB` colours, 1 to 21. */
    contrast(a, b) {
        const x = this.luminance(a);
        const y = this.luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    },

    DEFAULT_PRIMARY: '#0E3B5C',
    DEFAULT_ACCENT: '#F2A33A',

    /**
     * The page's colours for a brand: the infographic template's own rule (the Mac worker's `lookFor`, in its infographic brand module), so what
     * the preview shows is what the graphic is drawn with. Dark: the primary mixed 82% into black, text in the accent. Light:
     * paper, with the accent deepened 25% so it still reads on it.
     */
    brandLook(primary, accent, theme) {
        const p = this.safeHex(primary, this.DEFAULT_PRIMARY);
        const a = this.safeHex(accent, this.DEFAULT_ACCENT);
        if (theme === 'light') {
            return { bg: '#F7F6F2', ink: this.mix(p, '#000000', 0.45), muted: '#556270', accent: a, accentInk: this.mix(a, '#000000', 0.25) };
        }
        return { bg: this.mix(p, '#000000', 0.82), ink: '#EDEFF3', muted: '#A3ABB9', accent: a, accentInk: a };
    },

    /** The contrast of the highlight (as it is printed) on the page. At least 4.5 reads. */
    accentContrast(primary, accent, theme) {
        const look = this.brandLook(primary, accent, theme);
        return this.contrast(look.accentInk, look.bg);
    },

    /** The nearest accent that reads: the same colour pulled toward white on a dark page, toward black on a light one. */
    fixContrast(primary, accent, theme) {
        const a = this.safeHex(accent, this.DEFAULT_ACCENT);
        if (this.accentContrast(primary, a, theme) >= 4.5) return a;
        const toward = theme === 'light' ? '#000000' : '#FFFFFF';
        for (let i = 1; i <= 40; i += 1) {
            const next = this.mix(a, toward, i * 0.025);
            if (this.accentContrast(primary, next, theme) >= 4.5) return next;
        }
        return toward;
    },

    // ─── Register samples (content, not interface) ───────────────────────────

    /**
     * The same sentence in each register. It names the offer once the person has typed one («الرابط» until then), so the cards
     * differ by ear and not by topic. Returned in three parts so the offer's name, which is the person's text, can sit in its
     * own `<bdi>` and never reorder the punctuation around it.
     */
    registerSentence(register, offerName) {
        const name = String(offerName || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        const parts = {
            msa: ['أهلًا بك! أرسلنا لك رابط ', ' في الرسائل الخاصة', 'أهلًا بك! أرسلنا لك الرابط في الرسائل الخاصة'],
            gulf: ['هلا والله! ارسلنا لك رابط ', ' بالخاص', 'هلا والله! ارسلنا لك الرابط بالخاص'],
            egyptian: ['أهلًا بيك! بعتنالك لينك ', ' على الخاص', 'أهلًا بيك! بعتنالك اللينك على الخاص'],
            levantine: ['أهلين! بعتنالك رابط ', ' عالخاص', 'أهلين! بعتنالك الرابط عالخاص'],
            en: ['Hi! I’ve sent you the link to ', ' in your DMs.', 'Hi! I’ve sent you the link in your DMs.'],
        }[register];
        if (!parts) return { before: '', name: '', after: '' };
        return name ? { before: parts[0], name, after: parts[1] } : { before: parts[2], name: '', after: '' };
    },

    // ─── Values: the profile → a form, and a form → a patch ──────────────────

    /** The primary offer, or the first, or null. */
    primaryOffer(profile) {
        const offers = profile && Array.isArray(profile.offers) ? profile.offers : [];
        return offers.find((o) => o && o.primary) || offers[0] || null;
    },

    /** What the person typed into this step and has not confirmed yet (`onboarding.steps[id].values`), or null. */
    draftFor(onb, id) {
        const entry = onb && onb.steps ? onb.steps[id] : null;
        const draft = entry && entry.values;
        return draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : null;
    },

    text(value, max) {
        return typeof value === 'string' ? value.slice(0, max) : '';
    },

    aboutInitial(onb, preferProfile) {
        const profile = (onb && onb.profile) || {};
        const identity = profile.identity || {};
        const hints = (onb && onb.hints) || {};
        const offer = this.primaryOffer(profile) || {};
        const names = identity.display_name || {};
        const from = {
            name: this.text(names.ar || names.en || hints.name || '', 40),
            kind: this.KINDS.includes(identity.kind) ? identity.kind : '',
            niche: this.text(identity.niche, 120),
            offerName: this.text(offer.name, 200),
            orderVia: offer.order_via === 'dm' ? 'dm' : 'url',
            offerUrl: this.text(offer.url, 1000),
            price: this.text(offer.price, 60),
            country: /^[A-Z]{2}$/.test(identity.country || '') ? identity.country : '',
            timezone: this.isTimeZone(identity.timezone) ? identity.timezone : this.detectTimezone() || 'UTC',
        };
        const draft = preferProfile ? null : this.draftFor(onb, 'about');
        if (!draft) return from;
        const pick = (key, max) => (typeof draft[key] === 'string' ? draft[key].slice(0, max) : from[key]);
        return {
            name: pick('name', 40), kind: this.KINDS.includes(draft.kind) ? draft.kind : from.kind, niche: pick('niche', 120),
            offerName: pick('offerName', 200), orderVia: draft.orderVia === 'dm' ? 'dm' : draft.orderVia === 'url' ? 'url' : from.orderVia,
            offerUrl: pick('offerUrl', 1000), price: pick('price', 60), country: pick('country', 2),
            timezone: this.isTimeZone(draft.timezone) ? draft.timezone : from.timezone,
        };
    },

    /** What is wrong with the first step's values, as `[{ field, key }]`. Empty when it can be sent. */
    aboutProblems(values) {
        const v = values || {};
        const out = [];
        const name = String(v.name || '').trim();
        if (!name) out.push({ field: 'name', key: 'welcome.err.name' });
        else if (name.length > 40) out.push({ field: 'name', key: 'welcome.err.tooLong' });
        if (!this.KINDS.includes(v.kind)) out.push({ field: 'kind', key: 'welcome.err.kind' });
        const niche = String(v.niche || '').trim();
        if (!niche) out.push({ field: 'niche', key: 'welcome.err.niche' });
        else if (niche.length > 120) out.push({ field: 'niche', key: 'welcome.err.tooLong' });
        const offer = String(v.offerName || '').trim();
        if (!offer) out.push({ field: 'offerName', key: 'welcome.err.offer' });
        else if (offer.length > 200) out.push({ field: 'offerName', key: 'welcome.err.tooLong' });
        if (v.orderVia === 'url' && !this.isUrl(this.normaliseUrl(v.offerUrl))) out.push({ field: 'offerUrl', key: 'welcome.err.url' });
        if (String(v.price || '').trim().length > 60) out.push({ field: 'price', key: 'welcome.err.tooLong' });
        if (!this.isTimeZone(v.timezone)) out.push({ field: 'timezone', key: 'welcome.err.timezone' });
        return out;
    },

    /** What Continue sends for the first step: the identity, and the primary offer replaced in place (what else it holds stays). */
    aboutPatch(values, profile) {
        const v = values || {};
        const p = profile || {};
        const current = p.identity || {};
        const name = String(v.name || '').trim();
        const kind = v.kind;
        const identity = {
            display_name: { [this.scriptOf(name)]: name },
            kind,
            niche: String(v.niche || '').trim(),
            country: /^[A-Z]{2}$/.test(v.country || '') ? v.country : null,
            timezone: v.timezone,
        };
        if (!current.brand_name) identity.brand_name = name.slice(0, 80);
        const roles = Object.values(this.ROLE_FOR);
        if (!current.role || roles.includes(current.role)) identity.role = this.ROLE_FOR[kind];

        const offers = Array.isArray(p.offers) ? p.offers.slice() : [];
        let at = offers.findIndex((o) => o && o.primary);
        if (at === -1 && offers.length > 0) at = 0;
        const base = at >= 0 ? offers[at] : { id: 'main', kind: this.OFFER_KIND_FOR[kind], facts: [], bullets: [], keyword: '' };
        const orderVia = v.orderVia === 'dm' ? 'dm' : 'url';
        const offer = {
            ...base,
            kind: base.kind === 'other' && !String(base.name || '').trim() ? this.OFFER_KIND_FOR[kind] : base.kind,
            name: String(v.offerName || '').trim(),
            order_via: orderVia,
            url: orderVia === 'url' ? this.normaliseUrl(v.offerUrl) : '',
            price: String(v.price || '').trim(),
            primary: true,
        };
        if (at >= 0) offers[at] = offer;
        else offers.push(offer);
        return { identity, offers };
    },

    voiceInitial(onb, preferProfile) {
        const profile = (onb && onb.profile) || {};
        const language = profile.language || {};
        const voice = profile.voice || {};
        const register = language.primary === 'en' ? 'en' : (this.REGISTERS.includes(language.register) ? language.register : 'msa');
        const from = { register, tone: Array.isArray(voice.tone) ? voice.tone.filter((w) => typeof w === 'string' && w).slice(0, this.MAX_TONE) : [] };
        const draft = preferProfile ? null : this.draftFor(onb, 'voice');
        if (!draft) return from;
        return {
            register: this.REGISTERS.includes(draft.register) ? draft.register : from.register,
            tone: Array.isArray(draft.tone) ? draft.tone.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim().slice(0, 30)).slice(0, this.MAX_TONE) : from.tone,
        };
    },

    voiceProblems(values) {
        return this.REGISTERS.includes((values || {}).register) ? [] : [{ field: 'register', key: 'welcome.err.register' }];
    },

    /** The language and register, and the tone words. Switching language moves the digits and the address to that language's defaults. */
    voicePatch(values, profile) {
        const v = values || {};
        const current = (profile && profile.language) || {};
        const language = {};
        const voice = { tone: (Array.isArray(v.tone) ? v.tone : []).map((w) => String(w).trim().slice(0, 30)).filter(Boolean).slice(0, this.MAX_TONE) };
        if (v.register === 'en') {
            language.primary = 'en';
            if (current.primary !== 'en') {
                language.digits = 'latin';
                voice.address = 'neutral';
            }
        } else {
            language.primary = 'ar';
            language.register = v.register;
            if (current.primary !== 'ar') {
                language.digits = 'arabic-indic';
                voice.address = 'masc';
            }
        }
        return { language, voice };
    },

    brandInitial(onb, preferProfile) {
        const profile = (onb && onb.profile) || {};
        const brand = profile.brand || {};
        const socials = profile.socials || {};
        const hints = (onb && onb.hints) || {};
        const from = {
            primary: this.safeHex(brand.primary, this.DEFAULT_PRIMARY),
            accent: this.safeHex(brand.accent, this.DEFAULT_ACCENT),
            theme: brand.theme === 'light' ? 'light' : 'dark',
            handle: this.cleanHandle(socials.handle || hints.instagramUsername || ''),
            site: this.cleanSite(socials.site || hints.websiteUrl || ''),
            portraitUrl: typeof brand.portrait_url === 'string' && this.UPLOAD_URL.test(brand.portrait_url) ? brand.portrait_url : '',
        };
        const draft = preferProfile ? null : this.draftFor(onb, 'brand');
        if (!draft) return from;
        return {
            primary: this.safeHex(draft.primary, from.primary),
            accent: this.safeHex(draft.accent, from.accent),
            theme: draft.theme === 'light' ? 'light' : draft.theme === 'dark' ? 'dark' : from.theme,
            handle: typeof draft.handle === 'string' ? this.cleanHandle(draft.handle) : from.handle,
            site: typeof draft.site === 'string' ? this.cleanSite(draft.site) : from.site,
            portraitUrl: typeof draft.portraitUrl === 'string' && (draft.portraitUrl === '' || this.UPLOAD_URL.test(draft.portraitUrl)) ? draft.portraitUrl : from.portraitUrl,
        };
    },

    brandProblems(values) {
        const v = values || {};
        const out = [];
        if (!/^#[0-9a-fA-F]{6}$/.test(String(v.primary || '').trim())) out.push({ field: 'primary', key: 'welcome.err.colour' });
        if (!/^#[0-9a-fA-F]{6}$/.test(String(v.accent || '').trim())) out.push({ field: 'accent', key: 'welcome.err.colour' });
        if (String(v.handle || '').replace(/^@+/, '').length > 32) out.push({ field: 'handle', key: 'welcome.err.tooLong' });
        if (String(v.site || '').length > 40) out.push({ field: 'site', key: 'welcome.err.tooLong' });
        return out;
    },

    brandPatch(values, profile) {
        const v = values || {};
        const brand = {
            primary: this.safeHex(v.primary, this.DEFAULT_PRIMARY),
            accent: this.safeHex(v.accent, this.DEFAULT_ACCENT),
            theme: v.theme === 'light' ? 'light' : 'dark',
        };
        const had = profile && profile.brand && typeof profile.brand.portrait_url === 'string' ? profile.brand.portrait_url : '';
        const now = typeof v.portraitUrl === 'string' && this.UPLOAD_URL.test(v.portraitUrl) ? v.portraitUrl : '';
        if (now !== had) brand.portrait_url = now || null;
        return { brand, socials: { handle: this.cleanHandle(v.handle), site: this.cleanSite(v.site) } };
    },

    /** The words that go into a draft: only what the step's form holds, flat. */
    draftPayload(values) {
        const out = {};
        Object.keys(values || {}).forEach((key) => {
            const value = values[key];
            if (typeof value === 'string') out[key] = value.slice(0, 1000);
            else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
            else if (Array.isArray(value)) out[key] = value.filter((w) => typeof w === 'string').slice(0, 10).map((w) => w.slice(0, 30));
        });
        return out;
    },

    // ─── Rendering (pure) ────────────────────────────────────────────────────

    /** An error line for a field, or nothing. */
    fieldError(state, field, id) {
        const key = state.errors && state.errors[field];
        return key ? html`<p class="welcome-error" id="${id}" role="alert">${t(key)}</p>` : '';
    },

    invalidAttrs(state, field, id) {
        return state.errors && state.errors[field] ? html.raw(` aria-invalid="true" aria-describedby="${id}"`) : '';
    },

    /** A radio card: the input is the control, the body is what is drawn. `sample` is content in its own language. */
    choice(name, value, checked, title, hint, sample) {
        return html`
            <label class="welcome-choice">
                <input class="welcome-choice-input" type="radio" name="${name}" value="${value}" ${checked ? html.raw('checked') : ''}>
                <span class="welcome-choice-body">
                    <span class="welcome-choice-title">${title}</span>
                    ${hint ? html`<span class="welcome-choice-hint">${hint}</span>` : ''}
                    ${sample || ''}
                </span>
            </label>
        `;
    },

    aboutFields(state) {
        const v = state.values || {};
        const err = (field) => this.fieldError(state, field, `welcome-err-${field}`);
        const bad = (field) => this.invalidAttrs(state, field, `welcome-err-${field}`);
        const countries = this.countries();
        const zones = this.timezones(v.timezone);
        return html`
            <div class="form-group">
                <label class="form-label" for="welcome-name">${t('welcome.about.name')}</label>
                <input class="field" id="welcome-name" name="name" type="text" maxlength="40" autocomplete="organization"
                       value="${v.name || ''}" ${bad('name')}>
                ${err('name')}
            </div>

            <fieldset class="fieldset-plain form-group" role="radiogroup" aria-labelledby="welcome-kind-legend" ${bad('kind')}>
                <legend class="form-label" id="welcome-kind-legend">${t('welcome.about.kind')}</legend>
                ${err('kind')}
                <div class="welcome-choices">
                    ${this.KINDS.map((kind) => this.choice('kind', kind, v.kind === kind, t(`welcome.kind.${kind}`), t(`welcome.kind.${kind}.hint`)))}
                </div>
            </fieldset>

            <div class="form-group">
                <label class="form-label" for="welcome-niche">${t('welcome.about.niche')}</label>
                <input class="field" id="welcome-niche" name="niche" type="text" maxlength="120"
                       placeholder="${t('welcome.about.nichePlaceholder')}" value="${v.niche || ''}" ${bad('niche')}>
                ${err('niche')}
            </div>

            <div class="form-group">
                <label class="form-label" for="welcome-offer">${t('welcome.about.offer')}</label>
                <input class="field" id="welcome-offer" name="offerName" type="text" maxlength="200"
                       placeholder="${t('welcome.about.offerPlaceholder')}" value="${v.offerName || ''}"
                       aria-describedby="welcome-offer-hint" ${bad('offerName')}>
                <p class="form-hint" id="welcome-offer-hint">${t('welcome.about.offerHint')}</p>
                ${err('offerName')}
            </div>

            <fieldset class="fieldset-plain form-group" role="radiogroup" aria-labelledby="welcome-via-legend">
                <legend class="form-label" id="welcome-via-legend">${t('welcome.about.orderVia')}</legend>
                <div class="welcome-choices welcome-choices-pair">
                    ${this.choice('orderVia', 'url', v.orderVia !== 'dm', t('welcome.orderVia.url'), '')}
                    ${this.choice('orderVia', 'dm', v.orderVia === 'dm', t('welcome.orderVia.dm'), '')}
                </div>
            </fieldset>

            <div class="form-group ${v.orderVia === 'dm' ? html.raw('hidden') : ''}" id="welcome-url-group">
                <label class="form-label" for="welcome-url">${t('welcome.about.url')}</label>
                <input class="field" id="welcome-url" name="offerUrl" type="text" dir="ltr" inputmode="url" autocapitalize="none"
                       spellcheck="false" placeholder="example.com/shop" value="${v.offerUrl || ''}"
                       aria-describedby="welcome-url-hint" ${bad('offerUrl')}>
                <p class="form-hint" id="welcome-url-hint">${t('welcome.about.urlHint')}</p>
                ${err('offerUrl')}
            </div>

            <div class="form-group">
                <label class="form-label" for="welcome-price">${t('welcome.about.price')}</label>
                <input class="field" id="welcome-price" name="price" type="text" maxlength="60"
                       placeholder="${t('welcome.about.pricePlaceholder')}" value="${v.price || ''}" ${bad('price')}>
                ${err('price')}
            </div>

            <div class="form-group">
                <label class="form-label" for="welcome-country">${t('welcome.about.country')}</label>
                <select class="select" id="welcome-country" name="country">
                    <option value="">${t('welcome.about.countryNone')}</option>
                    ${countries.map((c) => html`<option value="${c.code}" ${v.country === c.code ? html.raw('selected') : ''}>${c.name}</option>`)}
                </select>
            </div>

            <div class="form-group">
                <label class="form-label" for="welcome-timezone">${t('welcome.about.timezone')}</label>
                <select class="select welcome-timezone" id="welcome-timezone" name="timezone"
                        aria-describedby="welcome-timezone-hint" ${bad('timezone')}>
                    ${zones.map((zone) => html`<option value="${zone}" ${v.timezone === zone ? html.raw('selected') : ''}>${zone}</option>`)}
                </select>
                <p class="form-hint" id="welcome-timezone-hint">${t('welcome.about.timezoneHint')}</p>
                ${err('timezone')}
            </div>
        `;
    },

    /** One register's example, in its own language and direction. */
    registerSample(register, offerName) {
        const s = this.registerSentence(register, offerName);
        const isEn = register === 'en';
        return html`<span class="welcome-choice-sample" lang="${isEn ? 'en' : 'ar'}" dir="${isEn ? 'ltr' : 'rtl'}">${s.before}${s.name ? html`<bdi dir="auto" class="welcome-sample-name">${s.name}</bdi>` : ''}${s.after}</span>`;
    },

    /** The chips under the register cards: the words picked, then suggestions in the voice's language that are not picked yet. */
    toneChips(state) {
        const v = state.values || {};
        const picked = Array.isArray(v.tone) ? v.tone : [];
        const words = this.TONE_WORDS[v.register === 'en' ? 'en' : 'ar'];
        const lang = v.register === 'en' ? 'en' : 'ar';
        const suggestions = words.filter((w) => !picked.includes(w));
        const full = picked.length >= this.MAX_TONE;
        return html`
            <div class="welcome-tones" role="group" aria-labelledby="welcome-tone-legend">
                ${picked.map((word) => html`
                    <button type="button" class="chip chip-accent welcome-chip" aria-pressed="true" data-action="welcome:toggleTone" data-word="${word}"
                            aria-label="${t('welcome.voice.toneRemove', { word })}">
                        <span lang="${this.scriptOf(word)}" dir="auto">${word}</span>
                        <i data-lucide="x" aria-hidden="true"></i>
                    </button>
                `)}
                ${suggestions.map((word) => html`
                    <button type="button" class="chip welcome-chip" aria-pressed="false" data-action="welcome:toggleTone" data-word="${word}"
                            ${full ? html.raw('disabled') : ''}>
                        <span lang="${lang}" dir="auto">${word}</span>
                    </button>
                `)}
            </div>
            <div class="welcome-tone-add field-row">
                <label class="sr-only" for="welcome-tone-add">${t('welcome.voice.toneAdd')}</label>
                <input class="field" id="welcome-tone-add" type="text" maxlength="30" autocomplete="off"
                       placeholder="${t('welcome.voice.toneAdd')}" ${full ? html.raw('disabled') : ''}>
                <button type="button" class="btn btn-secondary" data-action="welcome:addTone" ${full ? html.raw('disabled') : ''}>
                    <i data-lucide="plus" aria-hidden="true"></i> ${t('welcome.voice.toneAddButton')}
                </button>
            </div>
            ${full ? html`<p class="form-hint">${t('welcome.voice.toneMax')}</p>` : ''}
        `;
    },

    voiceFields(state) {
        const v = state.values || {};
        const offerName = ((state.onb && state.onb.profile && this.primaryOffer(state.onb.profile)) || {}).name || '';
        const typed = typeof v.offerName === 'string' ? v.offerName : offerName;
        const err = this.fieldError(state, 'register', 'welcome-err-register');
        return html`
            <fieldset class="fieldset-plain form-group" role="radiogroup" aria-labelledby="welcome-register-legend"
                      ${state.errors && state.errors.register ? html.raw('aria-describedby="welcome-err-register"') : ''}>
                <legend class="sr-only" id="welcome-register-legend">${t('welcome.voice.title')}</legend>
                ${err}
                <div class="welcome-choices">
                    ${this.REGISTERS.map((register) => this.choice('register', register, v.register === register,
                        t(`welcome.register.${register}`), '', this.registerSample(register, typed)))}
                </div>
            </fieldset>

            <div class="form-group">
                <p class="form-label" id="welcome-tone-legend">${t('welcome.voice.tone')}</p>
                <div id="welcome-tone">${this.toneChips(state)}</div>
            </div>
        `;
    },

    /** The name the tenant confirmed on the first step (or the operator typed): what the preview and the footer print. */
    profileName(onb) {
        const profile = (onb && onb.profile) || {};
        const names = (profile.identity && profile.identity.display_name) || {};
        const hints = (onb && onb.hints) || {};
        return String(names.ar || names.en || hints.name || '');
    },

    /** The brand preview: an infographic footer and a carousel cover, in the colours the form holds. Coloured from script (`applyPreview`). */
    brandPreview(state) {
        const v = state.values || {};
        const shown = this.profileName(state.onb).slice(0, 40);
        const initial = Array.from(shown)[0] || '';
        const photo = v.portraitUrl ? safeUrl(v.portraitUrl) : '';
        const handle = this.cleanHandle(v.handle);
        const site = this.cleanSite(v.site);
        return html`
            <div class="welcome-preview" id="welcome-preview" role="group" aria-label="${t('welcome.brand.preview')}" tabindex="0">
                <figure class="pv-card pv-footer">
                    <figcaption class="pv-caption">${t('welcome.brand.previewFooter')}</figcaption>
                    <div class="pv-footer-row">
                        <span class="pv-portrait" aria-hidden="true">${photo ? html`<img src="${photo}" alt="" width="40" height="40">` : html`<span>${initial}</span>`}</span>
                        <span class="pv-footer-text">
                            <span class="pv-name" dir="auto">${shown}</span>
                            <span class="pv-meta">
                                ${handle ? html`<bdi dir="ltr" class="pv-handle">@${handle}</bdi>` : ''}
                                ${site ? html`<bdi dir="ltr" class="pv-site">${site}</bdi>` : ''}
                            </span>
                        </span>
                    </div>
                </figure>
                <figure class="pv-card pv-cover">
                    <figcaption class="pv-caption">${t('welcome.brand.previewCover')}</figcaption>
                    <p class="pv-headline">${t('welcome.brand.sampleA')} <span class="pv-keyword">${t('welcome.brand.sampleB')}</span></p>
                    <p class="pv-cover-foot"><span dir="auto">${shown}</span>${handle ? html` <bdi dir="ltr">@${handle}</bdi>` : ''}</p>
                </figure>
            </div>
        `;
    },

    /** The words of the readout: the ratio, and whether the highlight reads on the page. */
    contrastText(v) {
        const ratio = this.accentContrast(v.primary, v.accent, v.theme);
        return `${t('welcome.brand.contrast', { ratio: ratio.toFixed(1) })} · ${ratio >= 4.5 ? t('welcome.brand.contrastGood') : t('welcome.brand.contrastLow')}`;
    },

    /**
     * The readout beside the highlight colour: the ratio, whether it reads, and the one-tap fix. Every part is always in the
     * markup and `updateContrast` only changes text and classes, because a button that is REPLACED between a finger going down
     * and coming up (a field losing focus repaints the readout) never receives the tap.
     */
    contrastMarkup(v) {
        const ok = this.accentContrast(v.primary, v.accent, v.theme) >= 4.5;
        return html`
            <div class="welcome-contrast ${ok ? html.raw('is-ok') : html.raw('is-low')}" id="welcome-contrast">
                <i data-lucide="check-circle" class="welcome-contrast-ok" aria-hidden="true"></i>
                <i data-lucide="alert-triangle" class="welcome-contrast-low" aria-hidden="true"></i>
                <span data-contrast-text>${this.contrastText(v)}</span>
                <button type="button" class="btn btn-secondary btn-sm welcome-contrast-fix" data-action="welcome:fixContrast">${t('welcome.brand.fix')}</button>
            </div>
            <span class="sr-only" id="welcome-contrast-state" role="status">${ok ? t('welcome.brand.contrastGood') : t('welcome.brand.contrastLow')}</span>
        `;
    },

    /** Update the readout in place (see `contrastMarkup`). */
    updateContrast(v) {
        const box = document.getElementById('welcome-contrast');
        if (!box) return;
        const ok = this.accentContrast(v.primary, v.accent, v.theme) >= 4.5;
        box.classList.toggle('is-ok', ok);
        box.classList.toggle('is-low', !ok);
        const text = box.querySelector('[data-contrast-text]');
        if (text) text.textContent = this.contrastText(v);
        const state = document.getElementById('welcome-contrast-state');
        const said = ok ? t('welcome.brand.contrastGood') : t('welcome.brand.contrastLow');
        // Only when the verdict changes: the live region must not read out every digit of a ratio as somebody types.
        if (state && state.textContent !== said) state.textContent = said;
    },

    colourField(state, field, label, value) {
        const v = state.values || {};
        const picker = this.safeHex(value, field === 'accent' ? this.DEFAULT_ACCENT : this.DEFAULT_PRIMARY);
        const id = `welcome-${field}`;
        return html`
            <div class="form-group">
                <label class="form-label" for="${id}">${label}</label>
                <div class="welcome-colour">
                    <input class="welcome-swatch" type="color" id="${id}-picker" data-colour-for="${field}" value="${picker.toLowerCase()}"
                           aria-label="${label}">
                    <input class="field" id="${id}" name="${field}" type="text" dir="ltr" maxlength="7" autocomplete="off" spellcheck="false"
                           autocapitalize="characters" value="${v[field] || ''}" ${this.invalidAttrs(state, field, `welcome-err-${field}`)}>
                </div>
                ${this.fieldError(state, field, `welcome-err-${field}`)}
            </div>
        `;
    },

    brandFields(state) {
        const v = state.values || {};
        return html`
            ${this.brandPreview(state)}

            <fieldset class="fieldset-plain form-group" role="radiogroup" aria-labelledby="welcome-theme-legend">
                <legend class="form-label" id="welcome-theme-legend">${t('welcome.brand.theme')}</legend>
                <div class="welcome-choices welcome-choices-pair">
                    ${this.choice('theme', 'dark', v.theme !== 'light', t('welcome.brand.themeDark'), '')}
                    ${this.choice('theme', 'light', v.theme === 'light', t('welcome.brand.themeLight'), '')}
                </div>
            </fieldset>

            ${this.colourField(state, 'primary', t('welcome.brand.primary'), v.primary)}
            ${this.colourField(state, 'accent', t('welcome.brand.accent'), v.accent)}
            <div class="form-group" id="welcome-contrast-slot">${this.contrastMarkup(v)}</div>

            <div class="form-group">
                <label class="form-label" for="welcome-handle">${t('welcome.brand.handle')}</label>
                <input class="field" id="welcome-handle" name="handle" type="text" dir="ltr" maxlength="33" autocapitalize="none"
                       spellcheck="false" autocomplete="off" value="${v.handle || ''}" aria-describedby="welcome-handle-hint"
                       ${this.invalidAttrs(state, 'handle', 'welcome-err-handle')}>
                <p class="form-hint" id="welcome-handle-hint">${t('welcome.brand.handleHint')}</p>
                ${this.fieldError(state, 'handle', 'welcome-err-handle')}
            </div>

            <div class="form-group">
                <label class="form-label" for="welcome-site">${t('welcome.brand.site')}</label>
                <input class="field" id="welcome-site" name="site" type="text" dir="ltr" maxlength="60" inputmode="url" autocapitalize="none"
                       spellcheck="false" autocomplete="off" value="${v.site || ''}" ${this.invalidAttrs(state, 'site', 'welcome-err-site')}>
                ${this.fieldError(state, 'site', 'welcome-err-site')}
            </div>

            <div class="form-group">
                <p class="form-label" id="welcome-portrait-label">${t('welcome.brand.portrait')}</p>
                <p class="form-hint welcome-portrait-hint">${t('welcome.brand.portraitHint')}</p>
                <div class="welcome-portrait-actions">
                    <input class="sr-only welcome-file-input" id="welcome-portrait" type="file" accept="image/png,image/jpeg,image/webp"
                           data-change="welcome:portrait" aria-describedby="welcome-portrait-label">
                    <label class="btn btn-secondary welcome-file" for="welcome-portrait">
                        <i data-lucide="image-plus" aria-hidden="true"></i>
                        <span>${v.portraitUrl ? t('welcome.brand.portraitChange') : t('welcome.brand.portraitChoose')}</span>
                    </label>
                    ${v.portraitUrl ? html`
                        <button type="button" class="btn btn-ghost" data-action="welcome:removePortrait">
                            <i data-lucide="trash-2" aria-hidden="true"></i> ${t('welcome.brand.portraitRemove')}
                        </button>
                    ` : ''}
                </div>
                ${state.portraitError ? html`<p class="welcome-error" role="alert">${t('welcome.brand.portraitFailed')}</p>` : ''}
            </div>
        `;
    },

    /** The sample replies on the last screen: ready when the person went through them, waiting (and honest about it) when they skipped. */
    doneProofItem(onb) {
        const entry = onb && onb.steps ? onb.steps.proof : null;
        const done = !!(entry && entry.status === 'done');
        return html`
            <li class="welcome-done-item ${done ? html.raw('is-ready') : html.raw('is-waiting')}">
                <i data-lucide="${done ? 'check-circle' : 'hourglass'}" aria-hidden="true"></i>
                <div>
                    <strong>${t('welcome.done.proofTitle')}</strong>
                    <p>${done ? t('welcome.done.proofDone') : t('welcome.done.proofSkipped')}</p>
                </div>
            </li>
        `;
    },

    /** The last screen: what is ready, what is waiting, and the content rules in plain words. */
    doneFields(state) {
        const onb = state.onb || {};
        const profile = onb.profile || {};
        const rules = profile.content && Array.isArray(profile.content.rules) ? profile.content.rules : [];
        const known = Object.keys(this.RULES);
        const open = !!state.rulesOpen;
        return html`
            <ul class="welcome-done-list">
                <li class="welcome-done-item is-ready">
                    <i data-lucide="check-circle" aria-hidden="true"></i>
                    <div>
                        <strong>${t('welcome.done.ready')}</strong>
                        <p>${t('welcome.done.profile')}</p>
                    </div>
                </li>
                <li class="welcome-done-item is-waiting">
                    <i data-lucide="hourglass" aria-hidden="true"></i>
                    <div>
                        <strong>${t('welcome.done.connectTitle')}</strong>
                        <p>${this.stepOrder(onb).includes('connect') ? t('welcome.done.connectSettings') : t('welcome.done.connect')}</p>
                    </div>
                </li>
                ${this.stepOrder(onb).includes('proof') ? this.doneProofItem(onb) : html`
                    <li class="welcome-done-item is-waiting">
                        <i data-lucide="hourglass" aria-hidden="true"></i>
                        <div>
                            <strong>${t('welcome.done.proofTitle')}</strong>
                            <p>${t('welcome.done.proof')}</p>
                        </div>
                    </li>
                `}
                ${state.firstCampaign ? html`
                    <li class="welcome-done-item is-ready">
                        <i data-lucide="check-circle" aria-hidden="true"></i>
                        <div>
                            <strong>${t('welcome.done.campaignTitle')}</strong>
                            <p>${t('welcome.done.campaign')}</p>
                        </div>
                    </li>
                ` : ''}
            </ul>
            <p class="form-hint">${UI.helpLink('onboarding#after', t('help.link.onboardingAfter'), { newTab: true })}</p>

            <section class="welcome-rules" aria-labelledby="welcome-rules-title">
                <div class="welcome-rules-head">
                    <h2 class="welcome-subtitle" id="welcome-rules-title">${t('welcome.done.rules')}</h2>
                    <button type="button" class="welcome-link" data-action="welcome:toggleRules" aria-expanded="${open ? 'true' : 'false'}"
                            aria-controls="welcome-rules-body">${open ? t('welcome.done.rulesDone') : t('welcome.done.rulesChange')}</button>
                </div>
                <div id="welcome-rules-body">
                    ${open ? html`
                        ${known.map((rule) => html`
                            <div class="check-row">
                                <input type="checkbox" id="welcome-rule-${rule}" data-change="welcome:toggleRule" data-rule="${rule}" ${rules.includes(rule) ? html.raw('checked') : ''}>
                                <div class="check-text">
                                    <label class="check-label" for="welcome-rule-${rule}">${t(this.RULES[rule])}</label>
                                </div>
                            </div>
                        `)}
                        <p class="form-hint">${t('welcome.done.rulesHint')}</p>
                    ` : html`
                        ${rules.filter((r) => known.includes(r)).length
                            ? html`<ul class="welcome-rule-list">${rules.filter((r) => known.includes(r)).map((rule) => html`<li>${t(this.RULES[rule])}</li>`)}</ul>`
                            : html`<p class="welcome-muted">${t('welcome.done.rulesNone')}</p>`}
                    `}
                </div>
            </section>
        `;
    },

    // ─── The seam's own definitions ──────────────────────────────────────────

    defineSteps() {
        const P = this;
        /** Every named control of the form, as text; a radio contributes the checked one. */
        const formValues = (form) => {
            const out = {};
            if (!form) return out;
            const data = new FormData(form);
            data.forEach((value, key) => { if (typeof value === 'string') out[key] = value; });
            return out;
        };
        this.register('about', {
            code: 'W1', required: true, skippable: false,
            title: () => t('welcome.about.title'), lead: () => t('welcome.about.lead'), next: 'welcome.next',
            initial: (onb, preferProfile) => P.aboutInitial(onb, preferProfile),
            read: (form, previous) => {
                const f = formValues(form);
                if (!form) return previous || {};
                return {
                    name: (f.name || '').trim(), kind: f.kind || '', niche: (f.niche || '').trim(), offerName: (f.offerName || '').trim(),
                    orderVia: f.orderVia === 'dm' ? 'dm' : 'url', offerUrl: (f.offerUrl || '').trim(), price: (f.price || '').trim(),
                    country: f.country || '', timezone: f.timezone || '',
                };
            },
            problems: (v) => P.aboutProblems(v),
            patch: (v, profile) => P.aboutPatch(v, profile),
            fields: (state) => P.aboutFields(state),
            assist: (state) => P.assist('about', state),
            after: (root, state) => P.assistAfter('about', root, state),
        });
        this.register('voice', {
            code: 'W2', required: true, skippable: false,
            title: () => t('welcome.voice.title'), lead: () => t('welcome.voice.lead'), next: 'welcome.voice.next',
            initial: (onb, preferProfile) => P.voiceInitial(onb, preferProfile),
            read: (form, previous) => {
                const f = formValues(form);
                const prev = previous || {};
                return { register: f.register || prev.register || '', tone: Array.isArray(prev.tone) ? prev.tone : [] };
            },
            problems: (v) => P.voiceProblems(v),
            patch: (v, profile) => P.voicePatch(v, profile),
            fields: (state) => P.voiceFields(state),
        });
        this.register('brand', {
            code: 'W3', required: false, skippable: true,
            title: () => t('welcome.brand.title'), lead: () => t('welcome.brand.lead'), next: 'welcome.brand.next',
            initial: (onb, preferProfile) => P.brandInitial(onb, preferProfile),
            read: (form, previous) => {
                const f = formValues(form);
                const prev = previous || {};
                if (!form) return prev;
                return {
                    primary: (f.primary || '').trim(), accent: (f.accent || '').trim(), theme: f.theme === 'light' ? 'light' : 'dark',
                    handle: (f.handle || '').trim(), site: (f.site || '').trim(), portraitUrl: prev.portraitUrl || '',
                };
            },
            problems: (v) => P.brandProblems(v),
            patch: (v, profile) => P.brandPatch(v, profile),
            fields: (state) => P.brandFields(state),
            after: () => P.applyPreview(),
        });
        // W4 (P28): on only when the operator has switched "Connect with Facebook" on (the server lists it as enabled; until then it is not in
        // the order and this definition is never used). Nothing to send to the profile: Continue and Skip only mark the step.
        this.register('connect', {
            code: 'W4', required: false, skippable: true,
            title: () => t('welcome.connect.title'), lead: () => t('welcome.connect.lead'), next: 'welcome.connect.next',
            initial: () => ({}),
            read: () => ({}),
            problems: () => [],
            patch: () => ({}),
            fields: (state) => P.connectFields(state),
        });
        // W5 (P25): the proof samples. Nothing to send to the profile: a verdict is its own write (`welcome_proof.js`), and Continue and Skip only
        // mark the step. With no AI key, a failed round or the day's limit it says so and still lets the person carry on.
        this.register('proof', {
            code: 'W5', required: false, skippable: true,
            title: () => t('welcome.proof.title'), lead: () => t('welcome.proof.lead'), next: 'welcome.proof.next',
            initial: () => ({}),
            read: () => ({}),
            problems: () => [],
            patch: () => ({}),
            fields: (state) => P.proofFields(state),
        });
        // The last screen has no form and nothing to send: it finishes the setup (`enterDone`) and says what is waiting.
        this.register('done', {
            code: 'W6', required: false, skippable: false,
            title: () => t('welcome.done.title'), lead: () => t('welcome.done.lead'), next: 'welcome.done.go', last: true,
            initial: () => ({}),
            read: () => ({}),
            problems: () => [],
            patch: () => ({}),
            fields: (state) => P.doneFields(state),
        });
    },

    // ─── The connect step, W4 (P28) ──────────────────────────────────────────
    //
    // Three cards (Instagram & Facebook, TikTok, YouTube), each with where it stands and the one button; after Meta connects, the test
    // comment: "ask a friend to comment *test* on your latest post, from another account". The step is optional and never blocks the
    // wizard: Skip and Continue only mark it, and nothing here is needed to finish.
    //
    // The Meta words, the Page picker and Connect itself are `MetaConnect`'s (`meta_connect.js`, shared with Settings, loaded when the step
    // opens); a flow that began here comes back with `return_to=welcome`, to this step (`#/welcome?step=connect&meta=…`), where the outcome is
    // read before the first paint rewrites the address (`readReturn`) and said as a note that stays on screen.

    CHECK_EVERY_MS: 5000,
    /** After this long without a comment the check stops asking and says so: the person can carry on, or ask again. */
    CHECK_GIVE_UP_MS: 10 * 60 * 1000,
    /** The reasons a person can do something about, per platform; every other one reads as one friendly sentence (the operator-facing ones are Settings'). */
    TENANT_RETURN_REASONS: {
        tiktok: ['denied', 'state_mismatch', 'state_expired', 'account_in_use'],
        youtube: ['denied', 'state_mismatch', 'state_expired', 'channel_in_use', 'no_channel', 'scope_missing'],
    },
    _checkTimer: null,
    _checking: false,

    blankConnect() {
        return {
            phase: 'loading', meta: null, metaError: null, tiktok: null, youtube: null, notice: null,
            check: { phase: 'idle', count: 0, latestAt: '', startedAt: 0 },
        };
    },

    /** Where a flow that began here returns to: this step. A platform admin filling the wizard in for somebody goes back to Settings (the wizard has no `mode=behalf` to return to). */
    connectReturnTo() {
        return typeof App !== 'undefined' && App.hashParam('mode') === 'behalf' ? 'settings' : 'welcome';
    },

    /** The raw parameters of a return trip, or null: read from the address before it is rewritten. Validated where they are used. */
    readConnectReturn() {
        if (typeof App === 'undefined') return null;
        const out = {};
        let any = false;
        ['meta', 'reason', 'warn', 'pick', 'tiktok', 'youtube'].forEach((name) => {
            const value = App.hashParam(name);
            if (value) { out[name] = value; any = true; }
        });
        return any ? out : null;
    },

    /** The words under a card's name, and what kind it is. Pure: a test feeds it every state. */
    metaCard(c) {
        const resp = c.meta;
        const returnTo = this.connectReturnTo();
        if (c.metaError || !resp) {
            return {
                id: 'meta', icon: 'instagram', title: t('welcome.connect.meta.title'), kind: 'none', status: t('welcome.connect.failed'), detail: '',
                action: UI.button({ variant: 'secondary', full: true, icon: 'rotate-cw', label: t('common.retry'), action: 'welcome:retryConnect', id: 'connect-meta-retry' }),
            };
        }
        const ready = typeof MetaConnect !== 'undefined';
        const state = ready ? MetaConnect.connectionState(resp) : 'none';
        const conn = resp.connection || {};
        const title = t('welcome.connect.meta.title');
        if (state === 'ok') {
            const who = conn.instagramUsername ? MetaConnect.handle(conn.instagramUsername) : (conn.pageName ? html`<span dir="auto">${conn.pageName}</span>` : '');
            return {
                id: 'meta', icon: 'instagram', title, kind: 'ok', status: html`${t('welcome.connect.connectedAs')} ${who}`,
                detail: conn.via === 'login' && !conn.webhookSubscribed ? t('meta.webhook.offHint') : '', action: '',
            };
        }
        if (state === 'attention') {
            const note = MetaConnect.attentionReason(conn) === 'invalid' ? t('meta.attention.invalid') : t('meta.attention.expiringSoon');
            return {
                id: 'meta', icon: 'instagram', title, kind: 'attention', status: t('welcome.connect.attention'), detail: note,
                action: ready && MetaConnect.canStart(resp) ? MetaConnect.connectButton(resp, { returnTo, variant: 'primary', full: true, id: 'connect-meta-button' }) : '',
            };
        }
        const startable = ready && MetaConnect.canStart(resp);
        return {
            id: 'meta', icon: 'instagram', title, kind: 'none', status: t('welcome.connect.notConnected'),
            detail: startable ? t('welcome.connect.meta.hint') : t('welcome.connect.meta.unavailable'),
            action: startable ? MetaConnect.connectButton(resp, { returnTo, variant: 'primary', full: true, id: 'connect-meta-button' }) : '',
            manual: true,
        };
    },

    /** TikTok and YouTube share one shape. A platform the operator has not set up is left out: there is nothing a tenant can do about it. */
    providerCard(c, platform) {
        const resp = c[platform];
        if (!resp || resp.appConfigured !== true) return null;
        const conn = resp.connection || {};
        const youtube = platform === 'youtube';
        const base = {
            id: platform, icon: youtube ? 'youtube' : 'music-2',
            title: t(youtube ? 'welcome.connect.youtube.title' : 'welcome.connect.tiktok.title'),
        };
        const name = youtube ? conn.channelTitle : conn.displayName;
        const button = (label, variant) => UI.button({
            variant, full: true, icon: 'link', label, action: youtube ? 'welcome:connectYouTube' : 'welcome:connectTikTok', id: `connect-${platform}-button`,
        });
        if (conn.connected && conn.status !== 'invalid') {
            return {
                ...base, kind: 'ok',
                status: html`${t('welcome.connect.connectedAs')} ${name ? html`<span dir="auto">${name}</span>` : t(youtube ? 'settings.youtube.unnamed' : 'settings.tiktok.unnamed')}`,
                detail: '', action: '',
            };
        }
        if (conn.status === 'invalid') {
            return {
                ...base, kind: 'attention', status: t('welcome.connect.attention'),
                detail: t(youtube ? 'settings.youtube.statusInvalid' : 'settings.tiktok.statusInvalid'),
                action: button(t('welcome.connect.reconnect'), 'primary'),
            };
        }
        return {
            ...base, kind: 'none', status: t('welcome.connect.notConnected'),
            detail: t(youtube ? 'welcome.connect.youtube.hint' : 'welcome.connect.tiktok.hint'),
            action: button(t('welcome.connect.connect'), 'secondary'),
        };
    },

    cardView(card) {
        const icon = { ok: 'check-circle', attention: 'alert-triangle', none: 'circle-dashed' }[card.kind] || 'circle-dashed';
        return html`
            <li class="connect-card surface" id="connect-card-${card.id}" data-state="${card.kind}">
                <div class="connect-card-head">
                    <span class="stat-icon shrink-0"><i data-lucide="${card.icon}" aria-hidden="true"></i></span>
                    <div class="connect-card-text">
                        <h2 class="connect-card-title">${card.title}</h2>
                        <p class="connect-card-status is-${card.kind}"><i data-lucide="${icon}" aria-hidden="true"></i> <span>${card.status}</span></p>
                    </div>
                </div>
                ${card.detail ? html`<p class="form-hint connect-card-detail">${card.detail}</p>` : ''}
                ${card.manual ? html`<p class="form-hint connect-card-detail">${t('welcome.connect.manual')}</p>` : ''}
                ${card.action || ''}
            </li>
        `;
    },

    /** The note that stays on screen after a return from a provider: it connected (and what is missing), or why it did not. */
    connectNotice(c) {
        const n = c.notice;
        if (!n) return '';
        const icon = n.kind === 'success' ? 'check-circle' : 'alert-triangle';
        return html`
            <div class="meta-notice is-${n.kind}" role="${n.kind === 'danger' ? 'alert' : 'status'}" id="connect-notice">
                <i data-lucide="${icon}" aria-hidden="true"></i>
                <span>${n.text}${(n.extra || []).map((line) => html` <span class="meta-notice-more">${line}</span>`)}</span>
            </div>
        `;
    },

    /** Is Meta connected? The test comment is only asked for once it is. */
    metaConnected(c) {
        return !!(c && c.meta && c.meta.connection && c.meta.connection.connected);
    },

    /** The part of the test comment that changes: waiting, received (green), or given up. This is all a poll repaints. */
    checkStateView(c) {
        const check = (c && c.check) || { phase: 'idle' };
        if (check.phase === 'received') {
            return html`
                <p class="connect-check-state is-ready" role="status">
                    <i data-lucide="check-circle" aria-hidden="true"></i>
                    <span>${t('welcome.connect.check.received')}${check.latestAt ? html` <span class="connect-check-time">${UI.formatDateTime(check.latestAt)}</span>` : ''}</span>
                </p>
            `;
        }
        if (check.phase === 'timeout') {
            return html`
                <p class="connect-check-state is-waiting" role="status">
                    <i data-lucide="info" aria-hidden="true"></i><span>${t('welcome.connect.check.timeout')}</span>
                </p>
                ${UI.button({ variant: 'secondary', icon: 'refresh-cw', label: t('welcome.connect.check.again'), action: 'welcome:checkAgain', id: 'connect-check-again', full: true })}
            `;
        }
        return html`
            <p class="connect-check-state is-waiting" role="status">
                <i data-lucide="hourglass" aria-hidden="true"></i><span>${t('welcome.connect.check.waiting')}</span>
            </p>
        `;
    },

    /** The test comment. Waiting turns green when a comment job for this tenant exists (`GET /api/meta/comment-check`). */
    checkView(c) {
        return html`
            <section class="connect-check surface" id="connect-check" aria-labelledby="connect-check-title">
                <h2 class="welcome-subtitle" id="connect-check-title">${t('welcome.connect.check.title')}</h2>
                <p class="connect-check-ask">${t('welcome.connect.check.ask')}</p>
                <div id="connect-check-state" aria-live="polite">${this.checkStateView(c)}</div>
                <p class="form-hint">${t('welcome.connect.check.hint')}</p>
            </section>
        `;
    },

    /** The whole step. Pure, like every other: the state decides, and a test can give it a payload in every field. */
    connectFields(state) {
        const c = state.connect;
        if (!c || c.phase === 'loading') return html`<div class="welcome-loading">${html.raw(UI.loader(t('welcome.loading')))}</div>`;
        if (c.phase === 'failed') {
            return html`
                <div class="welcome-problems" role="alert"><p>${t('welcome.connect.loadFailed')}</p></div>
                <button type="button" class="btn btn-secondary btn-full" data-action="welcome:retryConnect"><i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('common.retry')}</button>
            `;
        }
        const cards = [this.metaCard(c), this.providerCard(c, 'tiktok'), this.providerCard(c, 'youtube')].filter(Boolean);
        return html`
            ${this.connectNotice(c)}
            <ul class="connect-list">${cards.map((card) => this.cardView(card))}</ul>
            ${this.metaConnected(c) ? this.checkView(c) : ''}
        `;
    },

    // ─── Running the connect step ────────────────────────────────────────────

    /** Open the step: read the three connections (and the module that draws the first), then say what the return trip said, if there was one. */
    async enterConnect() {
        this.stopCheck();
        const returned = this.state.returned;
        this.state.returned = null;
        this.state.connect = this.blankConnect();
        this.paint(false);
        const [meta, tiktok, youtube, module] = await Promise.allSettled([
            API.getMetaConnection(), API.getTikTokConnection(), API.getYouTubeConnection(),
            typeof App !== 'undefined' && App.loadPageModule ? App.loadPageModule('meta_connect') : Promise.resolve(null),
        ]);
        // Left for another step (or the page closed) while it loaded: nothing here is wanted any more.
        if (this.state.step !== 'connect' || !this.state.connect) return;
        const c = this.state.connect;
        if (meta.status === 'fulfilled') c.meta = meta.value; else c.metaError = meta.reason;
        if (tiktok.status === 'fulfilled') c.tiktok = tiktok.value;
        if (youtube.status === 'fulfilled') c.youtube = youtube.value;
        const moduleReady = module.status === 'fulfilled' && module.value && typeof MetaConnect !== 'undefined';
        if (!moduleReady) c.metaError = c.metaError || new Error('module');
        c.phase = c.meta || c.tiktok || c.youtube ? 'ready' : 'failed';
        if (moduleReady) MetaConnect.afterChange = () => WelcomePage.reloadConnect();
        this.readOutcome(c, returned, moduleReady);
        this.paint(false);
        if (moduleReady && returned && returned.meta === 'pick') this.openPickFromReturn(returned);
        this.startCheck();
    },

    /** Turn what a return trip said into the note (and nothing else: a pick opens its modal separately). */
    readOutcome(c, returned, moduleReady) {
        if (!returned) return;
        const meta = moduleReady ? MetaConnect.readReturn((name) => returned[name] || '') : null;
        if (meta && meta.outcome === 'connected') {
            c.notice = {
                kind: meta.warnings.length ? 'warning' : 'success', text: t('welcome.connect.metaConnected'),
                extra: meta.warnings.map((w) => t(`meta.warning.${w}`)),
            };
        } else if (meta && meta.outcome === 'error') {
            c.notice = { kind: 'danger', text: MetaConnect.reasonText(meta.reason) };
        }
        for (const platform of ['tiktok', 'youtube']) {
            const outcome = returned[platform];
            if (outcome !== 'connected' && outcome !== 'error') continue;
            const name = t(platform === 'youtube' ? 'welcome.connect.youtube.title' : 'welcome.connect.tiktok.title');
            if (outcome === 'connected') {
                c.notice = { kind: 'success', text: t('welcome.connect.providerConnected', { name }) };
            } else {
                const reason = this.TENANT_RETURN_REASONS[platform].includes(returned.reason) ? returned.reason : '';
                c.notice = { kind: 'danger', text: reason ? t(`settings.${platform}.return.${reason}`) : t('welcome.connect.return.generic', { name }) };
            }
        }
    },

    openPickFromReturn(returned) {
        if (typeof MetaConnect === 'undefined') return Promise.resolve();
        return MetaConnect.openPicker(returned.pick, this.connectReturnTo());
    },

    /** The connection changed under the step (a Page was chosen in the picker): read it again, repaint, and start watching for the test comment. */
    async reloadConnect() {
        if (this.state.step !== 'connect' || !this.state.connect) return;
        try {
            const resp = await API.getMetaConnection();
            if (this.state.step !== 'connect' || !this.state.connect) return;
            this.state.connect.meta = resp;
            this.state.connect.metaError = null;
        } catch (err) {
            if (err && err.status === 401) return;
        }
        this.paint(false);
        this.startCheck();
    },

    // ─── The test comment ────────────────────────────────────────────────────

    /** Watch for the test comment, once Meta is connected: a quiet poll that stops when it arrives, when the step is left, or after ten minutes. */
    startCheck() {
        this.stopCheck();
        const c = this.state && this.state.connect;
        if (!c || c.phase !== 'ready' || !this.metaConnected(c)) return;
        if (c.check.phase === 'received') return;
        c.check.phase = 'waiting';
        c.check.startedAt = Date.now();
        this.paintCheck();
        this.pollCheck();
        this._checkTimer = setInterval(() => this.pollCheck(), this.CHECK_EVERY_MS);
    },

    stopCheck() {
        if (this._checkTimer !== null) clearInterval(this._checkTimer);
        this._checkTimer = null;
    },

    /** "Ask again" after the check gave up: start the watch over. */
    restartCheck() {
        const c = this.state && this.state.connect;
        if (!c) return;
        c.check = { phase: 'idle', count: 0, latestAt: '', startedAt: 0 };
        this.startCheck();
    },

    async pollCheck() {
        const c = this.state && this.state.connect;
        if (!c || this.state.step !== 'connect' || this._checking) return;
        // A hidden tab asks nobody: the poll resumes on its own when the person comes back.
        if (typeof document !== 'undefined' && document.hidden) return;
        this._checking = true;
        try {
            const res = await API.getMetaCommentCheck();
            if (this.state.connect !== c || this.state.step !== 'connect') return;
            if (res && res.received === true) {
                c.check = { phase: 'received', count: Number(res.count) || 0, latestAt: typeof res.latestAt === 'string' ? res.latestAt : '', startedAt: c.check.startedAt };
                this.stopCheck();
                this.paintCheck();
                if (typeof Motion !== 'undefined' && Motion.announce) Motion.announce(t('welcome.connect.check.received'));
            } else if (Date.now() - c.check.startedAt > this.CHECK_GIVE_UP_MS) {
                c.check.phase = 'timeout';
                this.stopCheck();
                this.paintCheck();
            }
        } catch (err) {
            // A failed look is not an answer: the next tick asks again. A dead session stops the poll.
            if (err && err.status === 401) this.stopCheck();
        } finally {
            this._checking = false;
        }
    },

    /** Only the check's own region: the cards (and any button the person is on) are not repainted by a poll. */
    paintCheck() {
        const c = this.state && this.state.connect;
        const host = document.getElementById('connect-check-state');
        if (!c || !host) return;
        host.innerHTML = esc(this.checkStateView(c));
        UI.icons(host);
    },

    /** TikTok and YouTube: the same round trip as Settings', with `returnTo` so it comes back here. The address is checked before it is followed. */
    async connectProvider(btn, platform) {
        if (!btn || btn.disabled) return;
        const restore = UI.actionBusy(btn);
        if (!restore) return;
        try {
            const returnTo = this.connectReturnTo();
            const { url } = await (platform === 'youtube' ? API.startYouTubeConnect(returnTo) : API.startTikTokConnect(returnTo));
            if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new Error(t('welcome.err.generic'));
            window.location.href = url;
        } catch (err) {
            restore();
            UI.toast((err && err.message) || t('welcome.err.generic'), 'error');
        }
    },

    // ─── The draft assist (P24): optional, and in its own file ───────────────

    /** The assist panel of a step, or nothing: `welcome_draft.js` may not be loaded (a page that could not fetch it is the plain form). */
    assist(id, state) {
        return typeof WelcomeDraft !== 'undefined' ? WelcomeDraft.panel(id, state) : '';
    },

    assistAfter(id, root, state) {
        if (typeof WelcomeDraft !== 'undefined') WelcomeDraft.afterPaint(this, id, root, state);
    },

    /** Load the assist before the first step is drawn. Never fatal. */
    async loadAssist() {
        try {
            if (typeof App !== 'undefined' && App.loadPageModule) await App.loadPageModule('welcome_draft');
        } catch { /* the plain form */ }
        try {
            if (typeof App !== 'undefined' && App.loadPageModule) await App.loadPageModule('welcome_proof');
        } catch { /* the proof step then says the samples are not available, and the person carries on */ }
    },

    // ─── The proof step, W5 (P25): `welcome_proof.js` draws and runs it ──────

    /** The step's fields: the module's, or the plain "not available" when it could not be loaded. */
    proofFields(state) {
        if (typeof WelcomeProof !== 'undefined') return WelcomeProof.fields(state);
        return html`
            <section class="proof-message">
                <h2 class="welcome-subtitle">${t('welcome.proof.unavailableTitle')}</h2>
                <p class="welcome-lead">${t('welcome.proof.unavailable')}</p>
            </section>
        `;
    },

    async enterProof() {
        if (typeof WelcomeProof === 'undefined') return;
        await WelcomeProof.enter(this);
    },

    // ─── Rendering the screen (pure) ─────────────────────────────────────────

    /** The mark, and the controls that belong to the screen and not to a step: the language, the workspace, sign out. */
    topBar(state) {
        const tenants = state.tenants || [];
        return html`
            <header class="welcome-top">
                <div class="welcome-brand">
                    <span class="logo-mark" aria-hidden="true">${UI.brandMark()}</span>
                    <span class="welcome-brand-name">${t('app.name')}</span>
                </div>
                <div class="welcome-tools">
                    ${tenants.length > 1 ? html`
                        <div class="chip-select welcome-tenant">
                            <i data-lucide="building-2" aria-hidden="true"></i>
                            <label class="sr-only" for="welcome-tenant-select">${t('app.tenant')}</label>
                            <select id="welcome-tenant-select" data-change="welcome:switchTenant">
                                ${tenants.map((tenant) => html`<option value="${tenant.id}" ${String(tenant.id) === String(state.tenantId) ? html.raw('selected') : ''}>${tenant.name || tenant.id}</option>`)}
                            </select>
                        </div>
                    ` : ''}
                    <button type="button" class="lang-toggle" data-lang-toggle lang="en" dir="ltr" aria-label="Switch language"
                            data-action="app:toggleLanguage">English</button>
                    <button type="button" class="welcome-link welcome-signout" data-action="welcome:signOut">${t('welcome.signOut')}</button>
                </div>
            </header>
        `;
    },

    /** Where the person is: an `<ol>` of segments, the current one marked, and the words. Nothing for the last screen. */
    progressView(state) {
        const onb = state.onb;
        const steps = this.formSteps(onb);
        const { index, total } = this.progress(onb, state.step);
        if (!index) return '';
        return html`
            <nav class="welcome-progress" aria-label="${t('welcome.progress.label')}">
                <p class="welcome-count">${t('welcome.progress.count', { n: index, total })} · ${t(`welcome.step.${state.step}`)}</p>
                <ol class="welcome-steps">
                    ${steps.map((id, i) => html`
                        <li class="welcome-segment ${i < index - 1 || this.isSettled(onb, id) ? html.raw('is-done') : ''} ${id === state.step ? html.raw('is-current') : ''}"
                            ${id === state.step ? html.raw('aria-current="step"') : ''}>
                            <span class="sr-only">${t(`welcome.step.${id}`)}</span>
                        </li>
                    `)}
                </ol>
            </nav>
        `;
    },

    notice(state) {
        if (state.notice === 'conflict') return html`<div class="welcome-notice" role="status"><i data-lucide="info" aria-hidden="true"></i><p>${t('welcome.conflict')}</p></div>`;
        if (state.notice === 'missing') return html`<div class="welcome-notice" role="status"><i data-lucide="info" aria-hidden="true"></i><p>${t('welcome.missing')}</p></div>`;
        return '';
    },

    problemList(state) {
        const list = Array.isArray(state.problems) ? state.problems : [];
        if (!list.length) return '';
        return html`
            <div class="welcome-problems" role="alert">
                <p>${t('welcome.invalid')}</p>
                <ul>${list.slice(0, 10).map((p) => html`<li dir="auto">${p}</li>`)}</ul>
            </div>
        `;
    },

    /** The saved / saving / not-saved words, in the live region of the bar. */
    saveText(save) {
        if (save === 'saving') return t('welcome.save.saving');
        if (save === 'saved') return t('welcome.save.saved');
        if (save === 'error') return t('welcome.save.error');
        return '';
    },

    /** The sticky bar: Back and the save state in a row, "Skip" beside them, and the one primary action full width below. */
    barView(state) {
        const onb = state.onb;
        const def = this.STEPS[state.step];
        const back = this.previousStep(onb, state.step);
        const last = !!(def && def.last);
        return html`
            <footer class="welcome-bar">
                <div class="welcome-bar-row">
                    ${back && !last ? html`<button type="button" class="welcome-link" data-action="welcome:back"><i data-lucide="arrow-left" aria-hidden="true"></i> ${t('welcome.back')}</button>` : html`<span></span>`}
                    <span class="welcome-save" id="welcome-save" role="status" aria-live="polite">${this.saveText(state.save)}</span>
                    ${def && def.skippable ? html`<button type="button" class="welcome-link" data-action="welcome:skip">${t('welcome.skip')}</button>` : html`<span></span>`}
                </div>
                ${last
                    ? html`<button type="button" class="btn btn-primary btn-full" id="welcome-next" data-action="welcome:goDashboard" ${state.finishing || state.finishFailed ? html.raw('disabled') : ''}>${t(def.next)} <i data-lucide="arrow-right" aria-hidden="true"></i></button>`
                    : html`<button type="submit" form="welcome-form" class="btn btn-primary btn-full" id="welcome-next">${def ? t(def.next) : t('welcome.next')} <i data-lucide="arrow-right" aria-hidden="true"></i></button>`}
            </footer>
        `;
    },

    messageCard(title, body, actions) {
        return html`
            <h1 class="welcome-title" id="welcome-title" tabindex="-1">${title}</h1>
            <p class="welcome-lead">${body}</p>
            ${actions || ''}
        `;
    },

    /** One step's card. */
    stepCard(state) {
        const def = this.STEPS[state.step];
        if (!def) return this.messageCard(t('welcome.failed.title'), t('welcome.failed.body'));
        const last = !!def.last;
        const title = typeof def.title === 'function' ? def.title(state) : t(def.title);
        const lead = typeof def.lead === 'function' ? def.lead(state) : t(def.lead);
        if (last) {
            const finishing = state.finishing;
            return html`
                <h1 class="welcome-title" id="welcome-title" tabindex="-1">${title}</h1>
                ${finishing ? html`<div class="welcome-finishing">${html.raw(UI.loader(t('welcome.done.finishing')))}<p class="welcome-lead">${t('welcome.done.finishing')}</p></div>`
                    : state.finishFailed ? html`
                        <div class="welcome-problems" role="alert"><p>${t('welcome.done.failed')}</p></div>
                        <button type="button" class="btn btn-secondary btn-full" data-action="welcome:retryFinish"><i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('common.retry')}</button>
                    ` : html`
                        <p class="welcome-lead">${lead}</p>
                        ${this.notice(state)}
                        ${def.fields(state)}
                    `}
            `;
        }
        return html`
            <h1 class="welcome-title" id="welcome-title" tabindex="-1">${title}</h1>
            <p class="welcome-lead">${lead}</p>
            ${this.notice(state)}
            ${this.problemList(state)}
            ${typeof def.assist === 'function' ? def.assist(state) : ''}
            <form id="welcome-form" class="welcome-form" data-submit="welcome:submit" data-input="welcome:onInput" data-change="welcome:onInput"
                  novalidate autocomplete="off">
                ${def.fields(state)}
            </form>
        `;
    },

    /** Everything the screen shows for a state. No DOM, no network: a test feeds it a payload in every field. */
    view(state) {
        const s = state || this.freshState();
        let card;
        let bar = '';
        if (s.phase === 'loading') {
            card = html`
                <h1 class="welcome-title" id="welcome-title" tabindex="-1">${t('welcome.loading')}</h1>
                <div class="welcome-loading">${html.raw(UI.loader(t('welcome.loading')))}</div>
            `;
        } else if (s.phase === 'failed') {
            card = this.messageCard(t('welcome.failed.title'), t('welcome.failed.body'), html`
                <button type="button" class="btn btn-primary btn-full" data-action="welcome:retry"><i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('common.retry')}</button>
            `);
        } else if (s.phase === 'forbidden') {
            card = this.messageCard(t('welcome.forbidden.title'), t('welcome.forbidden.body'), html`
                <button type="button" class="btn btn-primary btn-full" data-action="welcome:goDashboard">${t('welcome.done.go')}</button>
            `);
        } else {
            card = this.stepCard(s);
            bar = this.barView(s);
        }
        return html`
            ${this.topBar(s)}
            ${s.phase === 'ready' ? this.progressView(s) : ''}
            <main class="welcome-card surface" id="welcome-main">
                ${UI.inAppHint(s.inApp)}
                ${card}
            </main>
            ${bar}
        `;
    },

    // ─── Running ─────────────────────────────────────────────────────────────

    root() {
        return document.getElementById('welcome-root');
    },

    screen() {
        return document.getElementById('welcome-screen');
    },

    /** Paint the state, and put the screen reader where a new step begins. `focus`: move to the heading (a step change, not a keystroke). */
    paint(focus) {
        const root = this.root();
        if (!root) return;
        root.innerHTML = esc(this.view(this.state));
        UI.icons(root);
        if (typeof App !== 'undefined' && App.renderLanguageToggle) App.renderLanguageToggle();
        const def = this.state.phase === 'ready' ? this.STEPS[this.state.step] : null;
        if (def && typeof def.after === 'function') def.after(root, this.state);
        if (focus) {
            const heading = document.getElementById('welcome-title');
            if (heading && typeof heading.focus === 'function') {
                heading.focus({ preventScroll: true });
                if (typeof Motion !== 'undefined' && Motion.announce) Motion.announce(heading.textContent || '');
            }
            try { window.scrollTo(0, 0); } catch { /* no layout engine */ }
        }
    },

    /** The save state, in place: the bar is not repainted for it, so what is being typed keeps its focus. */
    setSave(save) {
        this.state.save = save;
        const el = document.getElementById('welcome-save');
        if (el) el.textContent = this.saveText(save);
    },

    /** Called by `App.showWelcome()` each time the wizard opens. */
    async start() {
        this.defineSteps();
        this.wire();
        this.state = this.freshState();
        this.state.inApp = UI.inAppBrowser();
        const session = (typeof App !== 'undefined' && App.session) || null;
        this.state.tenants = session && Array.isArray(session.tenants) ? session.tenants : [];
        this.state.tenantId = session && session.tenantId ? session.tenantId : '';
        this.paint(true);
        await this.loadAssist();
        await this.load();
    },

    /** Called when the wizard is left: timers stop and every listener it added comes off, so opening it again does not double them. */
    destroy() {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        this.stopCheck();
        if (typeof MetaConnect !== 'undefined' && MetaConnect.afterChange) MetaConnect.afterChange = null;
        if (typeof WelcomeDraft !== 'undefined') WelcomeDraft.stop();
        if (typeof WelcomeProof !== 'undefined') WelcomeProof.stop();
        const root = this.root();
        if (root && this._onFocusOut) root.removeEventListener('focusout', this._onFocusOut);
        if (root && this._onKeyDown) root.removeEventListener('keydown', this._onKeyDown);
        this._onFocusOut = null;
        this._onKeyDown = null;
        const vv = typeof window !== 'undefined' ? window.visualViewport : null;
        if (vv && this._vvHandler) vv.removeEventListener('resize', this._vvHandler);
        this._vvHandler = null;
        const screen = this.screen();
        if (screen) screen.classList.remove('kb-open');
        this._wired = false;
    },

    /** The listeners that are not `data-*` actions: blur saves, Enter in the tone box adds a word, and the keyboard hides the bar. */
    wire() {
        const root = this.root();
        if (!root || this._wired) return;
        this._wired = true;
        this._onFocusOut = (e) => {
            const target = e.target;
            if (target && target.closest && target.closest('#welcome-form') && this._saveTimer) this.flush();
        };
        this._onKeyDown = (e) => {
            if (e.key === 'Enter' && e.target && e.target.id === 'welcome-tone-add') {
                e.preventDefault();
                this.addTone();
            }
        };
        root.addEventListener('focusout', this._onFocusOut);
        root.addEventListener('keydown', this._onKeyDown);
        const vv = window.visualViewport;
        if (vv) {
            this._vvHandler = () => {
                const screen = this.screen();
                if (screen) screen.classList.toggle('kb-open', this.keyboardOpen(window.innerHeight, vv.height));
            };
            vv.addEventListener('resize', this._vvHandler);
        }
    },

    /** Read the setup, and open at the step the person was on (the address's `step`, if it is one they may see). */
    async load() {
        this.state.phase = 'loading';
        try {
            const onb = await API.getOnboarding();
            this.state.onb = onb;
            if (!onb.canEdit) {
                this.state.phase = 'forbidden';
                this.paint(true);
                return;
            }
            this.state.phase = 'ready';
            // What a return from a provider's consent screen said, before the first paint rewrites the address to `?step=…`.
            this.state.returned = this.readConnectReturn();
            const asked = typeof App !== 'undefined' ? App.hashParam('step') : '';
            const want = asked && this.reachable(onb, asked) ? asked : (this.stepOrder(onb).includes(onb.step) ? onb.step : this.firstOpen(onb));
            await this.show(want, { replace: true });
        } catch (err) {
            if (err && err.status === 401) return;
            this.state.phase = 'failed';
            this.paint(true);
        }
    },

    retry() {
        return this.load();
    },

    /** Show a step: its values, its form, and tell the server it is on screen (which is where the person resumes). */
    async show(id, options) {
        const opts = options || {};
        const onb = this.state.onb;
        const order = this.stepOrder(onb);
        const target = order.includes(id) ? id : (order[0] || 'done');
        const def = this.STEPS[target];
        // Whatever the step being left was watching (the test comment) stops with it.
        this.stopCheck();
        this.state.step = target;
        this.state.values = def.initial(onb, !!opts.preferProfile);
        this.state.errors = {};
        this.state.problems = [];
        this.state.notice = opts.notice || '';
        this.state.save = 'idle';
        this.state.portraitError = false;
        this.state.rulesOpen = false;
        this.state.finishing = false;
        this.state.finishFailed = false;
        this.syncHash(target, !!opts.replace);
        this.paint(true);
        if (target === 'done') {
            this.enterDone();
            return;
        }
        // The connect step reads the three connections as it opens (and says what a return trip said). Never fatal: it paints its own failure.
        if (target === 'connect') this.enterConnect().catch(() => {});
        // The proof step asks for its samples as it opens (once: a round that finds both there is free). Never fatal: it paints its own failure.
        if (target === 'proof') this.enterProof().catch(() => {});
        // Fire and forget: a missed note about where the person is costs nothing but the resume point.
        if (onb.status !== 'completed') API.saveOnboardingStep(target, { viewed: true }).catch(() => {});
    },

    /** The address follows the step, so the phone's Back button moves between steps. `replace` for the first paint. */
    syncHash(id, replace) {
        const keepMode = typeof App !== 'undefined' && App.hashParam('mode') === 'behalf' ? '&mode=behalf' : '';
        const want = `#/welcome?step=${encodeURIComponent(id)}${keepMode}`;
        if (location.hash === want) return;
        try {
            if (replace) history.replaceState(null, '', want);
            else history.pushState(null, '', want);
        } catch { /* a sandbox without history: the page still works, Back just leaves it */ }
    },

    /** Back, forward or an edited address: show what the address asks for, if the person may see it. */
    onHashChange() {
        if (!this.state || this.state.phase !== 'ready') return;
        const asked = App.hashParam('step');
        if (!asked || asked === this.state.step) return;
        if (this.reachable(this.state.onb, asked)) this.show(asked, { replace: true });
        else this.syncHash(this.state.step, true);
    },

    /** The form's values now, from the DOM; the state's own when no form is on screen. */
    collect() {
        const def = this.STEPS[this.state.step];
        if (!def) return this.state.values;
        const form = document.getElementById('welcome-form');
        const values = def.read(form, this.state.values);
        // What the page holds beyond the inputs (tone words, the portrait) is carried over by `read`.
        this.state.values = Object.assign({}, this.state.values, values);
        return this.state.values;
    },

    // ─── Autosave ────────────────────────────────────────────────────────────

    scheduleSave() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => { this._saveTimer = null; this.saveDraft(); }, this.SAVE_DELAY_MS);
    },

    /** Save now what is waiting to be saved: before Back, Skip and Continue, and when a field loses focus. */
    async flush() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
            await this.saveDraft();
        }
        if (this._saving) await this._saving;
    },

    /** One save at a time, in order: a slow one cannot land after a newer one. */
    saveDraft() {
        const step = this.state.step;
        const def = this.STEPS[step];
        if (!def || def.last || this.state.phase !== 'ready') return Promise.resolve();
        const payload = this.draftPayload(this.collect());
        const run = async () => {
            this.setSave('saving');
            try {
                const saved = await API.saveOnboardingStep(step, { values: payload });
                if (saved && saved.steps && this.state.onb) this.state.onb.steps = saved.steps;
                this.setSave('saved');
            } catch (err) {
                if (err && err.status === 401) return;
                this.setSave('error');
            }
        };
        this._saving = (this._saving || Promise.resolve()).then(run, run);
        return this._saving;
    },

    // ─── Continue, Back, Skip ────────────────────────────────────────────────

    /** The form was submitted (Next, or Enter in a field). */
    async submit(event) {
        if (event) event.preventDefault();
        if (this.state.busy) return;
        const button = document.getElementById('welcome-next');
        const restore = UI.actionBusy(button);
        if (!restore) return;
        this.state.busy = true;
        try {
            await this.flush();
            const def = this.STEPS[this.state.step];
            const values = this.collect();
            const problems = def.problems(values);
            if (problems.length) {
                this.showProblems(problems);
                return;
            }
            const patch = def.patch(values, this.state.onb.profile);
            if (Object.keys(patch).length > 0) {
                const outcome = await this.saveProfile(patch);
                if (outcome !== 'ok') return;
            }
            const marked = await API.saveOnboardingStep(this.state.step, { status: 'done' });
            this.takeSteps(marked);
            await this.show(this.nextStep(this.state.onb, this.state.step));
        } catch (err) {
            if (err && err.status === 401) return;
            this.failed(err);
        } finally {
            this.state.busy = false;
            // The screen may have changed under the button; restore only if it is still the one that was busy.
            if (document.getElementById('welcome-next') === button) restore();
        }
    },

    /**
     * PATCH the profile with what Continue confirms. Returns 'ok', or why the step stays: the profile moved while the
     * person was typing (the step is reloaded from the server and the newer values shown), or the server refused the answers.
     */
    async saveProfile(patch) {
        try {
            const saved = await API.patchProfile(this.state.onb.version, patch);
            const onb = this.state.onb;
            onb.profile = saved.profile;
            onb.version = saved.version;
            onb.stored = saved.stored;
            onb.missing = saved.activationMissing || [];
            return 'ok';
        } catch (err) {
            const code = err && err.body && err.body.code;
            if (err && err.status === 409 && code === 'PROFILE_VERSION_CONFLICT') {
                await this.reloadAfterConflict();
                return 'conflict';
            }
            if (err && err.status === 400 && code === 'PROFILE_INVALID') {
                this.state.problems = err.body && Array.isArray(err.body.problems) ? err.body.problems.map(String) : [];
                if (!this.state.problems.length) this.state.problems = [String(err.message || '')];
                this.paint(true);
                return 'invalid';
            }
            throw err;
        }
    },

    /** Somebody else wrote the profile: read it again and show that step with the newer values, and a note that says so. */
    async reloadAfterConflict() {
        const fresh = await API.getOnboarding();
        // Keep the step the person was on; what changed is the profile and its version.
        this.state.onb = fresh;
        const step = this.state.step;
        await this.show(this.stepOrder(fresh).includes(step) ? step : this.firstOpen(fresh), { replace: true, preferProfile: true, notice: 'conflict' });
        // What is on screen is now the newer profile's: keep it as the draft, or the older typing would come back on the next visit.
        await this.saveDraft();
    },

    takeSteps(response) {
        if (!response || !this.state.onb) return;
        if (response.steps) this.state.onb.steps = response.steps;
        if (response.status) this.state.onb.status = response.status;
        if (response.step) this.state.onb.step = response.step;
    },

    /** Say what is wrong where the person is looking, and put focus on the first field that is wrong. */
    showProblems(problems) {
        this.state.errors = {};
        problems.forEach((p) => { this.state.errors[p.field] = p.key; });
        this.state.problems = [];
        this.paint(false);
        const first = document.querySelector('#welcome-form [aria-invalid="true"]') || document.querySelector('#welcome-form fieldset[aria-describedby]');
        const focusable = first && first.tagName === 'FIELDSET' ? first.querySelector('input') : first;
        if (focusable && typeof focusable.focus === 'function') focusable.focus();
        if (typeof Motion !== 'undefined' && Motion.announce) Motion.announce(t('welcome.invalid'));
    },

    failed(err) {
        const message = err && err.body && typeof err.body.error === 'string' ? err.body.error : '';
        const text = err && err.status === 403 ? t('welcome.forbidden.title') : (err && err.isNetworkError ? t('welcome.save.error') : (message || t('welcome.err.generic')));
        UI.toast(text, 'error');
    },

    async back() {
        const prev = this.previousStep(this.state.onb, this.state.step);
        if (!prev) return;
        await this.flush();
        this.collect();
        await this.show(prev, { replace: true });
    },

    async skip(button) {
        if (this.state.busy) return;
        const restore = UI.actionBusy(button);
        if (!restore) return;
        this.state.busy = true;
        try {
            await this.flush();
            const marked = await API.saveOnboardingStep(this.state.step, { status: 'skipped' });
            this.takeSteps(marked);
            await this.show(this.nextStep(this.state.onb, this.state.step));
        } catch (err) {
            if (err && err.status === 401) return;
            this.failed(err);
        } finally {
            this.state.busy = false;
            if (document.body.contains(button)) restore();
        }
    },

    // ─── The last screen ─────────────────────────────────────────────────────

    /** Finish the setup (idempotent on the server) as the last screen opens. A refusal sends the person back to the step that fixes it. */
    async enterDone() {
        const onb = this.state.onb;
        if (onb.status === 'completed') {
            this.paint(false);
            return;
        }
        this.state.finishing = true;
        this.paint(false);
        try {
            const finished = await API.completeOnboarding();
            // The campaign Finish created (switched off), when it made one: the last screen says so.
            this.state.firstCampaign = finished && finished.campaign && finished.campaign.created ? finished.campaign : null;
            onb.status = 'completed';
            this.state.finishing = false;
            this.paint(false);
        } catch (err) {
            this.state.finishing = false;
            if (err && err.status === 401) return;
            const body = err && err.body;
            if (err && err.status === 409 && body && body.code === 'ONBOARDING_INCOMPLETE') {
                const fix = this.stepOrder(onb).includes(body.fixStep) ? body.fixStep : this.firstOpen(onb);
                await this.show(fix === 'done' ? this.stepOrder(onb)[0] : fix, { replace: true, notice: 'missing' });
                return;
            }
            this.state.finishFailed = true;
            this.paint(false);
        }
    },

    retryFinish() {
        this.state.finishFailed = false;
        return this.enterDone();
    },

    /** Tick or untick a content rule on the last screen: the profile's own save, with the same conflict answer. */
    async toggleRule(box) {
        const rule = box.dataset.rule;
        if (!rule || !this.RULES[rule]) return;
        const onb = this.state.onb;
        const current = onb.profile && onb.profile.content && Array.isArray(onb.profile.content.rules) ? onb.profile.content.rules : [];
        const next = box.checked ? Array.from(new Set(current.concat(rule))) : current.filter((r) => r !== rule);
        box.disabled = true;
        try {
            const saved = await API.patchProfile(onb.version, { content: { rules: next } });
            onb.profile = saved.profile;
            onb.version = saved.version;
            UI.toast(t('welcome.saved'));
        } catch (err) {
            box.checked = !box.checked;
            const code = err && err.body && err.body.code;
            if (err && err.status === 409 && code === 'PROFILE_VERSION_CONFLICT') {
                try { this.state.onb = await API.getOnboarding(); } catch { /* the toast below says it */ }
                UI.toast(t('welcome.conflict'), 'error');
            } else if (!(err && err.status === 401)) {
                this.failed(err);
            }
        } finally {
            box.disabled = false;
        }
    },

    // ─── The brand step ──────────────────────────────────────────────────────

    /** Paint the colours of the preview from the form's values: CSS custom properties, set from script, from validated hex only. */
    applyPreview() {
        const preview = document.getElementById('welcome-preview');
        if (!preview || !preview.style) return;
        const v = this.collect();
        const look = this.brandLook(v.primary, v.accent, v.theme);
        preview.style.setProperty('--pv-bg', look.bg);
        preview.style.setProperty('--pv-ink', look.ink);
        preview.style.setProperty('--pv-muted', look.muted);
        preview.style.setProperty('--pv-accent', look.accentInk);
        preview.style.setProperty('--pv-ring', look.accent);
        this.updateContrast(v);
        // The native picker follows the typed code.
        ['primary', 'accent'].forEach((field) => {
            const picker = document.getElementById(`welcome-${field}-picker`);
            if (picker && /^#[0-9a-fA-F]{6}$/.test(String(v[field]))) picker.value = String(v[field]).toLowerCase();
        });
    },

    /** One typed-in change in the form: the order-via toggle, the preview, and a save a moment from now. */
    onInput(el, event) {
        const target = event && event.target;
        if (!target) return;
        if (target.name === 'orderVia') {
            const group = document.getElementById('welcome-url-group');
            if (group) group.classList.toggle('hidden', target.value === 'dm');
        }
        if (target.name === 'register') {
            this.state.values.register = target.value;
            this.paintTone();
        }
        if (this.state.step === 'brand') this.applyPreview();
        // The proof step has no form values: what is typed in its edit box is a draft of a verdict, kept by `welcome_proof.js`.
        if (this.state.step === 'proof') return;
        this.scheduleSave();
        this.setSave('idle');
    },

    /** The native colour picker was used: put its value in the text field, which is the value of record. */
    onColour(picker) {
        const field = picker.dataset.colourFor;
        const text = document.getElementById(`welcome-${field}`);
        if (!text) return;
        text.value = picker.value.toUpperCase();
        this.applyPreview();
        this.scheduleSave();
    },

    /** One tap: pull the highlight colour to the nearest one that reads on the chosen page. */
    fixContrastNow() {
        const v = this.collect();
        const fixed = this.fixContrast(v.primary, v.accent, v.theme);
        const text = document.getElementById('welcome-accent');
        if (text) text.value = fixed;
        this.applyPreview();
        this.scheduleSave();
    },

    /** Upload a portrait: squared and shrunk in the browser, kept as one of our uploads, and shown on the preview. */
    async uploadPortrait(input) {
        const file = input.files && input.files[0];
        if (!file) return;
        this.state.portraitError = false;
        try {
            const dataUrl = await this.squareJpeg(file);
            const res = await API.uploadMedia({ filename: 'portrait.jpg', mime_type: 'image/jpeg', base64_data: dataUrl });
            if (!res || typeof res.url !== 'string' || !this.UPLOAD_URL.test(res.url)) throw new Error('upload');
            this.collect();
            this.state.values.portraitUrl = res.url;
            this.repaintBrand();
            this.scheduleSave();
        } catch (err) {
            if (err && err.status === 401) return;
            this.state.portraitError = true;
            this.repaintBrand();
        } finally {
            input.value = '';
        }
    },

    removePortrait() {
        this.collect();
        this.state.values.portraitUrl = '';
        this.state.portraitError = false;
        this.repaintBrand();
        this.scheduleSave();
    },

    /** Repaint the brand step keeping what is typed, and focus where it was. */
    repaintBrand() {
        const focus = UI.captureFocus(this.root());
        this.paint(false);
        UI.restoreFocus(focus);
    },

    squareJpeg(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('read'));
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error('decode'));
                img.onload = () => {
                    const side = Math.min(img.naturalWidth, img.naturalHeight);
                    const canvas = document.createElement('canvas');
                    canvas.width = 512;
                    canvas.height = 512;
                    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 512, 512);
                    resolve(canvas.toDataURL('image/jpeg', 0.9));
                };
                img.src = String(reader.result);
            };
            reader.readAsDataURL(file);
        });
    },

    // ─── The voice step ──────────────────────────────────────────────────────

    /** The tone box and chips only: a tap on a chip must not repaint the register cards under it. */
    paintTone() {
        const holder = document.getElementById('welcome-tone');
        if (!holder) return;
        const focus = UI.captureFocus(holder);
        holder.innerHTML = esc(this.toneChips(this.state));
        UI.icons(holder);
        UI.restoreFocus(focus);
    },

    toggleTone(button) {
        const word = button.dataset.word;
        if (!word) return;
        const tone = Array.isArray(this.state.values.tone) ? this.state.values.tone.slice() : [];
        const at = tone.indexOf(word);
        if (at >= 0) tone.splice(at, 1);
        else if (tone.length < this.MAX_TONE) tone.push(word);
        this.state.values.tone = tone;
        this.paintTone();
        this.scheduleSave();
    },

    addTone() {
        const input = document.getElementById('welcome-tone-add');
        if (!input) return;
        const word = input.value.trim().replace(/\s+/g, ' ').slice(0, 30);
        const tone = Array.isArray(this.state.values.tone) ? this.state.values.tone.slice() : [];
        if (word && !tone.includes(word) && tone.length < this.MAX_TONE) {
            tone.push(word);
            this.state.values.tone = tone;
            this.paintTone();
            this.scheduleSave();
        }
        const next = document.getElementById('welcome-tone-add');
        if (next) { next.value = ''; if (!next.disabled) next.focus(); }
    },

    // ─── Leaving ─────────────────────────────────────────────────────────────

    signOut() {
        App.logout();
    },

    switchTenant(select) {
        return App.switchTenant(select.value);
    },

    goDashboard() {
        return App.leaveWelcome();
    },
};

WelcomePage.defineSteps();

/** Run an async handler without leaving a rejection behind: a refusal is a toast. */
const welcomeRun = (promise) => {
    if (promise && typeof promise.catch === 'function') {
        promise.catch((err) => UI.toast((err && err.message) || t('error.unexpected'), 'error'));
    }
};

UI.registerActions('welcome', {
    submit: (el, e) => { e.preventDefault(); welcomeRun(WelcomePage.submit(e)); },
    onInput: (el, e) => {
        // The native colour picker lives inside the form: its change is the text field's.
        const target = e && e.target;
        if (target && target.dataset && target.dataset.colourFor) { WelcomePage.onColour(target); return; }
        WelcomePage.onInput(el, e);
    },
    back: () => welcomeRun(WelcomePage.back()),
    skip: (el) => welcomeRun(WelcomePage.skip(el)),
    retry: () => welcomeRun(WelcomePage.retry()),
    retryFinish: () => welcomeRun(WelcomePage.retryFinish()),
    toggleTone: (el) => WelcomePage.toggleTone(el),
    addTone: () => WelcomePage.addTone(),
    fixContrast: () => WelcomePage.fixContrastNow(),
    portrait: (el) => welcomeRun(WelcomePage.uploadPortrait(el)),
    removePortrait: () => WelcomePage.removePortrait(),
    toggleRules: () => { WelcomePage.state.rulesOpen = !WelcomePage.state.rulesOpen; WelcomePage.paint(false); },
    toggleRule: (el) => welcomeRun(WelcomePage.toggleRule(el)),
    connectTikTok: (el) => welcomeRun(WelcomePage.connectProvider(el, 'tiktok')),
    connectYouTube: (el) => welcomeRun(WelcomePage.connectProvider(el, 'youtube')),
    retryConnect: () => welcomeRun(WelcomePage.enterConnect()),
    checkAgain: () => WelcomePage.restartCheck(),
    signOut: () => WelcomePage.signOut(),
    switchTenant: (el) => welcomeRun(WelcomePage.switchTenant(el)),
    goDashboard: () => welcomeRun(WelcomePage.goDashboard()),
});
