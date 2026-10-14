/**
 * The draft assist on the wizard's first step (W1), P24: "Fill it for me from my Instagram and website".
 *
 * It is NOT a step. It plugs into the wizard's own seam (`WelcomePage.register`, whose step definitions may carry an `assist(state)` panel
 * shown above the form and an `after(root, state)` that wires it) and uses the draft client (`draft_client.js`, loaded here on demand) for
 * everything that talks to the server. The wizard loads this file on start; a page that cannot is the plain form it was.
 *
 * ─── What the person sees ───────────────────────────────────────────────────
 *   no draft yet        two small fields (their Instagram and website, filled in with what the operator typed) and "Fill it for me"
 *   being made          what it is doing, and "Start without waiting": the panel folds into one line and the form below is theirs
 *   ready               a suggestion for each EMPTY field of the form, with where it came from and "Use this" / "Not this"
 *   no AI key           a short "we'll fill this in later" and what was found without one (the handle, the site, the colours)
 *   could not be read   one sentence, and the two fields again
 * The form below is never locked, never repainted for the draft, and nothing here reaches the profile: "Use this" puts the value in the
 * form's field, which is what Next later confirms (the wizard's own rule: nothing reaches the profile until Next).
 *
 * ─── Never over what they typed ─────────────────────────────────────────────
 * A suggestion exists only for a field that is EMPTY at that moment. Typing in a field takes its suggestion away at once; a field the
 * wizard filled in from the operator's hints, from the profile or from an earlier visit is not empty and is not offered over. There is no
 * button that replaces text.
 *
 * ─── Escaping ───────────────────────────────────────────────────────────────
 * A draft came from a bio, a web page and a model. Every value reaches the page through `html` as text (`<bdi dir="auto">`) and reaches
 * a field through its `.value` or `.checked`: never as markup.
 */
const WelcomeDraft = {
    STEP: 'about',
    /** The form's fields a draft can suggest for, in the order the form shows them. */
    FIELDS: ['name', 'kind', 'niche', 'offerName', 'offerUrl', 'price', 'country'],
    /** The DOM id of each text field, and the longest value its input takes. */
    INPUT_ID: { name: 'welcome-name', niche: 'welcome-niche', offerName: 'welcome-offer', offerUrl: 'welcome-url', price: 'welcome-price', country: 'welcome-country' },
    MAX: { name: 40, niche: 120, offerName: 200, price: 60 },
    /** The form's own label for each field, so a suggestion is named as the form names it. */
    LABEL: {
        name: 'welcome.about.name', kind: 'welcome.about.kind', niche: 'welcome.about.niche', offerName: 'welcome.about.offer',
        offerUrl: 'welcome.about.url', price: 'welcome.about.price', country: 'welcome.about.country',
    },

    page: null,
    client: null,
    DC: null,
    _attaching: null,
    s: null,

    fresh() {
        return {
            /** idle (not read yet) | off (no draft here: the plain form) | none | working | retrying | ready | needs_key | failed */
            phase: 'idle',
            view: null,
            handle: '',
            site: '',
            dismissed: [],
            /** An i18n key, or ''. */
            error: '',
            busy: false,
            /** "Start without waiting" was pressed: the panel is one line. */
            compact: false,
        };
    },

    // ─── Pure ────────────────────────────────────────────────────────────────

    /** The i18n key that says where a fact came from, by the id of its source. */
    sourceKey(id) {
        const source = String(id || '');
        if (source === 'bio') return 'welcome.draft.src.bio';
        if (/^p\d+$/.test(source)) return 'welcome.draft.src.post';
        if (/^site\d+$/.test(source)) return 'welcome.draft.src.site';
        if (/^yt/.test(source)) return 'welcome.draft.src.youtube';
        if (source === 'typed') return 'welcome.draft.src.typed';
        return 'welcome.draft.src.guess';
    },

    /**
     * The suggestions for the form as it is now: `[{ field, value, display, why, evidence, check }]`. Only from a model's draft (a prefill has
     * nothing for these fields), only for a field that is empty, never one that was dismissed. `value` is what goes in the field; `display` is
     * what is shown (a kind and a country by name); `why` is an i18n key; `evidence` is a quote from the source, as text; `check` says the
     * checker flagged it for a person to look at.
     */
    suggestionsFor(view, values, dismissed) {
        if (!this.DC || !view || !view.draft) return [];
        const P = this.page;
        const by = {};
        this.DC.fieldsOf(view).filter((f) => f.source === 'draft').forEach((f) => { by[f.key] = f; });
        const v = values || {};
        const skip = Array.isArray(dismissed) ? dismissed : [];
        const empty = (field) => String(v[field] || '').trim() === '' && !skip.includes(field);
        const out = [];
        const add = (field, from, value, display, provenance) => {
            if (!from || typeof value !== 'string' || value.trim() === '' || !empty(field)) return;
            const proof = (provenance || from.provenance || [])[0] || null;
            out.push({
                field,
                value: value.trim(),
                display: display === undefined ? value.trim() : display,
                why: this.sourceKey(proof && proof.source),
                evidence: proof && proof.source !== 'inferred' && typeof proof.evidence === 'string' ? proof.evidence.slice(0, 90) : '',
                check: Array.isArray(from.flags) && from.flags.length > 0,
            });
        };

        const named = by['identity.display_name.ar'] || by['identity.display_name.en'];
        if (named) add('name', named, String(named.value || '').slice(0, this.MAX.name));
        const kind = by['identity.kind'];
        if (kind && P.KINDS.includes(kind.value)) add('kind', kind, kind.value, t(`welcome.kind.${kind.value}`));
        const niche = by['identity.niche'];
        if (niche) add('niche', niche, String(niche.value || '').slice(0, this.MAX.niche));

        const offers = by.offers;
        if (offers && Array.isArray(offers.value) && offers.value.length > 0) {
            const at = Math.max(0, offers.value.findIndex((o) => o && o.primary));
            const offer = offers.value[at] || {};
            const proofs = offers.provenance.filter((p) => String(p.path).startsWith(`offers[${at}]`));
            if (typeof offer.name === 'string') add('offerName', offers, offer.name.slice(0, this.MAX.offerName), undefined, proofs);
            if (typeof offer.url === 'string' && v.orderVia !== 'dm' && P.isUrl(P.normaliseUrl(offer.url))) add('offerUrl', offers, offer.url, undefined, proofs);
            if (typeof offer.price === 'string') add('price', offers, offer.price.slice(0, this.MAX.price), undefined, proofs);
        }
        const country = by['identity.country'];
        if (country && /^[A-Z]{2}$/.test(country.value) && P.COUNTRY_CODES.includes(country.value)) {
            const named = P.countries().find((c) => c.code === country.value);
            add('country', country, country.value, named ? named.name : country.value);
        }
        return out;
    },

    /** What was found without an assistant (a missing AI key): `{ handle, site, colours }`, each as text or empty. */
    foundOf(view) {
        const fields = this.DC && view ? this.DC.fieldsOf(view) : [];
        const by = {};
        fields.forEach((f) => { by[f.key] = f; });
        const text = (key) => (by[key] && typeof by[key].value === 'string' ? by[key].value : '');
        return {
            handle: text('socials.handle').replace(/^@+/, '').slice(0, 40),
            site: text('socials.site').slice(0, 60),
            colours: [text('brand.primary'), text('brand.accent')].filter((c) => /^#[0-9A-Fa-f]{6}$/.test(c)).map((c) => c.toUpperCase()),
        };
    },

    /** The note for a refusal of the start, as an i18n key. */
    errorKey(err) {
        const body = err && err.body;
        if (err && err.status === 400 && body && body.code === 'INVALID_INPUT') return body.field === 'instagram' ? 'welcome.draft.err.instagram' : body.field === 'website' ? 'welcome.draft.err.website' : 'welcome.draft.err.generic';
        if (err && err.status === 400 && body && body.code === 'NO_INPUTS') return 'welcome.draft.err.none';
        if (err && err.status === 429) return 'welcome.draft.err.limit';
        return err && err.isNetworkError ? 'welcome.draft.err.network' : 'welcome.draft.err.generic';
    },

    // ─── Rendering (pure) ────────────────────────────────────────────────────

    /** The panel for a step, or nothing. Always the same empty container when there is nothing to say, so it can be filled later. */
    panel(id, state) {
        if (id !== this.STEP) return '';
        return html`<section class="welcome-assist" id="welcome-assist" aria-labelledby="welcome-assist-title">${this.body(state)}</section>`;
    },

    status(text) {
        return html`<p class="welcome-muted welcome-assist-status" role="status"><i data-lucide="info" aria-hidden="true"></i> <span>${text}</span></p>`;
    },

    inputs() {
        const s = this.s;
        return html`
            <div class="form-group">
                <label class="form-label" for="welcome-draft-handle">${t('welcome.draft.handle')}</label>
                <input class="field" id="welcome-draft-handle" type="text" dir="ltr" inputmode="text" autocapitalize="none" spellcheck="false" maxlength="120"
                       placeholder="@username" value="${s.handle}" data-input="welcomeDraft:field" data-field="handle" autocomplete="off">
            </div>
            <div class="form-group">
                <label class="form-label" for="welcome-draft-site">${t('welcome.draft.site')}</label>
                <input class="field" id="welcome-draft-site" type="text" dir="ltr" inputmode="url" autocapitalize="none" spellcheck="false" maxlength="300"
                       placeholder="example.com" value="${s.site}" data-input="welcomeDraft:field" data-field="site" autocomplete="off">
            </div>
            <button type="button" class="btn btn-secondary btn-full" data-action="welcomeDraft:start" ${s.busy ? html.raw('disabled') : ''}>
                <i data-lucide="zap" aria-hidden="true"></i> ${t(s.busy ? 'welcome.draft.starting' : 'welcome.draft.start')}
            </button>
            <p class="form-hint">${t('welcome.draft.privacy')}</p>
        `;
    },

    /** The suggestions, as the list. Its own function: it is what is repainted when a field is typed in. */
    list(values) {
        const s = this.s;
        const items = this.suggestionsFor(s.view, values, s.dismissed);
        if (items.length === 0) return html`<p class="welcome-muted">${t('welcome.draft.nothing')}</p>`;
        return html`
            <ul class="welcome-suggest-list">
                ${items.map((item) => html`
                    <li class="welcome-suggest surface">
                        <p class="welcome-suggest-label">${t(this.LABEL[item.field])}</p>
                        <p class="welcome-suggest-value"><bdi dir="auto">${item.display}</bdi></p>
                        <p class="welcome-suggest-why">${t(item.why)}${item.evidence ? html` <bdi dir="auto" class="welcome-suggest-quote">«${item.evidence}»</bdi>` : ''}</p>
                        ${item.check ? html`<p class="welcome-suggest-check">${t('welcome.draft.check')}</p>` : ''}
                        <div class="welcome-suggest-actions">
                            <button type="button" class="btn btn-secondary btn-sm" data-action="welcomeDraft:use" data-field="${item.field}">
                                <i data-lucide="check" aria-hidden="true"></i> ${t('welcome.draft.use')}
                            </button>
                            <button type="button" class="btn btn-ghost btn-sm" data-action="welcomeDraft:dismiss" data-field="${item.field}">${t('welcome.draft.dismiss')}</button>
                        </div>
                    </li>
                `)}
            </ul>
        `;
    },

    /** The panel's inside, by where the draft is. `values` are the form's, for what to suggest. */
    body(state) {
        const s = this.s;
        if (!s || s.phase === 'idle' || s.phase === 'off') return '';
        const values = (state && state.values) || {};
        const heading = (key) => html`<h2 class="welcome-subtitle" id="welcome-assist-title">${t(key)}</h2>`;
        const error = s.error ? html`<p class="welcome-error" role="alert">${t(s.error)}</p>` : '';

        if (s.phase === 'working' || s.phase === 'retrying') {
            const step = this.DC ? this.DC.phaseOf(s.view).step : null;
            const text = t(s.phase === 'retrying' ? 'welcome.draft.retrying' : step === 'drafting' ? 'welcome.draft.writing' : 'welcome.draft.reading');
            if (s.compact) return html`<span class="sr-only" id="welcome-assist-title">${t('welcome.draft.title')}</span>${this.status(t('welcome.draft.later'))}`;
            return html`
                ${heading('welcome.draft.title')}
                <div class="welcome-assist-working">${html.raw(UI.loader(text))}<p class="welcome-muted">${text}</p></div>
                <button type="button" class="btn btn-secondary btn-full" data-action="welcomeDraft:skipWaiting">${t('welcome.draft.skip')}</button>
                <p class="form-hint">${t('welcome.draft.skipHint')}</p>
            `;
        }
        if (s.phase === 'ready') {
            return html`
                ${heading('welcome.draft.readyTitle')}
                <p class="welcome-muted">${t(s.view && s.view.partial ? 'welcome.draft.partial' : 'welcome.draft.readyLead')}</p>
                <div id="welcome-suggest" aria-live="polite">${this.list(values)}</div>
            `;
        }
        if (s.phase === 'needs_key') {
            const found = this.foundOf(s.view);
            const parts = [found.handle ? `@${found.handle}` : '', found.site, found.colours.join(' ')].filter(Boolean);
            return html`
                ${heading('welcome.draft.title')}
                ${this.status(t('welcome.draft.noKey'))}
                ${parts.length ? html`<p class="welcome-muted">${t('welcome.draft.found')} <bdi dir="ltr">${parts.join(' · ')}</bdi></p>` : ''}
            `;
        }
        // none, and failed: say what happened, and offer the two fields again.
        const failed = s.phase === 'failed';
        const kind = failed && s.view && s.view.error ? s.view.error.kind : '';
        return html`
            ${heading('welcome.draft.title')}
            ${failed ? this.status(t(kind === 'no_source' ? 'welcome.draft.noSource' : 'welcome.draft.failed')) : html`<p class="welcome-muted">${t('welcome.draft.lead')}</p>`}
            ${error}
            ${this.inputs()}
        `;
    },

    // ─── Running ─────────────────────────────────────────────────────────────

    el(id) {
        return document.getElementById(id);
    },

    /** Repaint the whole panel (the draft moved, or a button was pressed). */
    repaintPanel() {
        const holder = this.el('welcome-assist');
        if (!holder || !this.page) return;
        const focus = UI.captureFocus(holder);
        holder.innerHTML = esc(this.body(this.page.state));
        UI.icons(holder);
        UI.restoreFocus(focus);
    },

    /** Only the list: the form was typed in, so what is still empty may have changed; the panel's own fields keep their focus. */
    repaintSuggestions() {
        const holder = this.el('welcome-suggest');
        if (!holder || !this.page || !this.s) return;
        holder.innerHTML = esc(this.list(this.page.collect()));
        UI.icons(holder);
    },

    /** The wizard painted a step: wire the form to the list, and read the draft once per session. */
    afterPaint(page, id, root, state) {
        if (id !== this.STEP) return;
        this.page = page;
        if (!this.s) this.s = this.fresh();
        const form = this.el('welcome-form');
        if (form) {
            const refresh = () => this.repaintSuggestions();
            form.addEventListener('input', refresh);
            form.addEventListener('change', refresh);
        }
        if (!this._attaching) this._attaching = this.attach(state);
    },

    /** Load the client, read the draft there is (the operator's, made when the tenant was created), and watch it if it is on its way. */
    async attach(state) {
        const s = this.s;
        const hints = (state && state.onb && state.onb.hints) || {};
        s.handle = typeof hints.instagramUsername === 'string' ? hints.instagramUsername.slice(0, 120) : '';
        s.site = typeof hints.websiteUrl === 'string' ? hints.websiteUrl.slice(0, 300) : '';
        try {
            this.DC = await App.loadPageModule('draft_client');
            if (!this.DC) throw new Error('no draft client');
            this.client = this.DC.create();
            this.client.onChange(() => this.sync());
            await this.client.refresh(true);
        } catch {
            // No draft here (an older server, a tenant whose wizard is over, a database without the table): the plain form, with nothing said.
            s.phase = 'off';
            this.repaintPanel();
            return;
        }
        this.sync();
        const phase = s.phase;
        if (phase === 'working' || phase === 'retrying') this.watch();
    },

    /** The panel for where the client's view is now. */
    sync() {
        const s = this.s;
        if (!s || !this.DC || s.phase === 'off') return;
        const before = s.phase;
        const info = this.DC.phaseOf(this.client.view);
        s.view = this.client.view;
        s.phase = info.phase === 'superseded' ? 'none' : info.phase;
        if (s.phase !== 'working' && s.phase !== 'retrying') s.compact = false;
        this.repaintPanel();
        if (before !== s.phase && s.phase === 'ready' && typeof Motion !== 'undefined' && Motion.announce) Motion.announce(t('welcome.draft.readyAnnounce'));
    },

    watch() {
        this.client.watch(() => undefined, (err) => {
            // Gone for good (the session ended, the wizard is over): stop saying anything.
            if (this.s) { this.s.phase = 'off'; this.repaintPanel(); }
            void err;
        });
    },

    /** Fill it for me: start a draft from the two fields. Both are always sent: an emptied field is a real "not this one". */
    async start() {
        const s = this.s;
        if (!s || !this.client || s.busy) return;
        const handle = this.el('welcome-draft-handle');
        const site = this.el('welcome-draft-site');
        if (handle) s.handle = String(handle.value || '');
        if (site) s.site = String(site.value || '');
        s.busy = true;
        s.error = '';
        this.repaintPanel();
        try {
            await this.client.start({ instagram: s.handle.trim(), website: s.site.trim() });
            s.dismissed = [];
            this.sync();
            this.watch();
        } catch (err) {
            if (err && err.status === 401) return;
            s.error = this.errorKey(err);
        } finally {
            s.busy = false;
            this.repaintPanel();
        }
    },

    /** "Start without waiting": the panel folds into one line and the form is theirs; the suggestions arrive on their own. */
    skipWaiting() {
        const s = this.s;
        if (!s || !this.client) return;
        s.compact = true;
        this.client.startWithoutWaiting(() => { s.compact = false; this.repaintPanel(); });
        this.repaintPanel();
        const field = this.el('welcome-name');
        if (field && typeof field.focus === 'function') field.focus();
    },

    /** Put a suggestion in its field, if the field is still empty. The wizard's own save and Next take it from there. */
    use(field) {
        const s = this.s;
        const page = this.page;
        if (!s || !page || !this.FIELDS.includes(field)) return;
        const now = page.collect();
        const item = this.suggestionsFor(s.view, now, s.dismissed).find((x) => x.field === field);
        // It is gone if the field was typed in since the list was drawn: nothing is ever put over text.
        if (!item) { this.repaintSuggestions(); return; }
        if (field === 'kind') {
            const radio = document.querySelector(`#welcome-form input[name="kind"][value="${item.value}"]`);
            if (radio) radio.checked = true;
        } else {
            const input = this.el(this.INPUT_ID[field]);
            if (input) input.value = item.value;
        }
        page.collect();
        page.scheduleSave();
        page.setSave('idle');
        this.repaintSuggestions();
        if (typeof Motion !== 'undefined' && Motion.announce) Motion.announce(t('welcome.draft.used'));
    },

    dismiss(field) {
        const s = this.s;
        if (!s || !this.FIELDS.includes(field)) return;
        if (!s.dismissed.includes(field)) s.dismissed.push(field);
        this.repaintSuggestions();
    },

    /** The wizard is left: the polling stops and the next session starts from a clean state. */
    stop() {
        if (this.client) this.client.stop();
        this.client = null;
        this.DC = null;
        this.page = null;
        this._attaching = null;
        this.s = this.fresh();
    },
};

WelcomeDraft.s = WelcomeDraft.fresh();

UI.registerActions('welcomeDraft', {
    start: () => { const run = WelcomeDraft.start(); if (run && run.catch) run.catch(() => undefined); },
    skipWaiting: () => WelcomeDraft.skipWaiting(),
    use: (el) => WelcomeDraft.use(el.dataset.field),
    dismiss: (el) => WelcomeDraft.dismiss(el.dataset.field),
    field: (el) => {
        const s = WelcomeDraft.s;
        if (!s || !el || !el.dataset) return;
        const value = String((el.value !== undefined ? el.value : '') || '');
        if (el.dataset.field === 'handle') s.handle = value;
        if (el.dataset.field === 'site') s.site = value;
    },
});
