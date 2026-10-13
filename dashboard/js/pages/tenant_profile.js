/**
 * Tenant profile — the platform admin fills a tenant's Creator Profile in on their behalf (P19).
 *
 * Not a page: `tenant_detail.js` loads this file the first time the admin presses "Open the profile", the way the Help
 * Center loads its articles, so the profile (up to 128 KB) is never fetched for a tenant nobody is filling in, and a
 * failure here cannot take the tenant screen down with it.
 *
 *   GET   /api/admin/tenants/:id/profile              { profile, version, stored, activationMissing, isPlatformOwner, onboarding }
 *   PATCH /api/admin/tenants/:id/profile              { version, patch, confirm_remove_owner_rule? }  → the same as GET
 *
 * ─── One form per profile section ───────────────────────────────────────────
 * Identity, language and register, voice, audience, offers, content rules and socials: each its own `<form>` with its own
 * Save. A save sends ONLY the paths that changed (`changedPaths` → `buildPatch`), together with the version the profile
 * was read at, and the server merges them like `PATCH /api/profile` does (an object merges key by key, a list is replaced
 * whole, `null` removes from the maps keyed by name). Saving one section leaves the others' unsaved edits exactly as typed.
 *
 * ─── Values, not markup, are the state ──────────────────────────────────────
 * Everything is a flat map `path → value` (`valuesOf(profile)`), a value being the canonical form of what the control
 * shows: text trimmed on one line, a list one entry per line, a choice its token, an empty optional field `''`.
 *   render(values)          values → markup, through the `html` tag only
 *   snapshot(root)          the DOM → plain control snapshots
 *   fromSnapshots(…)        snapshots → values (pure)
 * Because `valuesOf(profile)` and the reading of an untouched form are the same canonical values, an untouched form has no
 * changed path: nothing is sent that the admin did not change. `tenant_profile.test.ts` renders a profile and reads it back.
 *
 * ─── A conflict loses nothing ───────────────────────────────────────────────
 * A 409 `PROFILE_VERSION_CONFLICT` means someone else saved first. The forms are NOT re-rendered: the admin's edits stay
 * on screen, a banner says the profile changed elsewhere, and Save waits for a reload. "Reload and keep my edits" fetches
 * the latest and puts the still-changed fields back on top of it.
 *
 * ─── The owner's rule ───────────────────────────────────────────────────────
 * Taking `no_women_imagery` off the platform owner's profile is refused by the server (409 `OWNER_RULE_LOCKED`) unless
 * confirmed; the dialog asks, and only a yes sends `confirm_remove_owner_rule: true`. The server is the lock, this is the question.
 *
 * ─── Escaping ───────────────────────────────────────────────────────────────
 * A value reaches the page only through the `html` tag (which escapes element text and quoted attributes), never by
 * concatenation, and never into an inline handler: every control is wired by `data-action` / `data-submit`.
 * `<textarea>` content starts with a newline, which the HTML parser drops, so a value that begins with one survives.
 */
const TenantProfile = {

    // ─── What a profile holds ───────────────────────────────────────────────
    // The closed lists are the server's (src/services/profile/types.ts); tenant_profile.test.ts holds the two equal.
    ENUMS: {
        kind: ['educator', 'coach', 'shop', 'agency', 'creator'],
        register: ['msa', 'gulf', 'egyptian', 'levantine'],
        digits: ['arabic-indic', 'latin'],
        lang: ['ar', 'en'],
        level: ['beginner', 'intermediate', 'advanced', 'mixed'],
        emoji: ['none', 'light', 'rich'],
        address: ['masc', 'fem', 'plural', 'neutral'],
        domain: ['tech', 'general'],
        offerKind: ['course', 'coaching', 'program', 'product', 'service', 'community', 'event', 'other'],
        orderVia: ['url', 'dm'],
        rule: ['no_women_imagery'],
        social: ['instagram', 'youtube', 'linkedin', 'x', 'tiktok', 'facebook', 'github'],
        surface: ['dm', 'comments', 'carousel', 'reels', 'infographic', 'coach'],
    },

    /** The server's limits that a control can show (`PROFILE_LIMITS`): the server still decides. */
    LIMITS: { displayName: 40, brandName: 80, role: 40, niche: 120, handle: 32, site: 40, link: 500, offerName: 200, offerUrl: 1000, offerPrice: 60, offerKeyword: 80, offers: 10 },

    SECTIONS: ['identity', 'language', 'voice', 'audience', 'offers', 'content', 'socials'],

    /** The rule the server locks on the platform owner's profile. */
    OWNER_RULE: 'no_women_imagery',

    /**
     * Every control that is one path of the profile, in the order a section shows them.
     *   type      text | select | textarea | lines (one per line) | samples (blocks split by a line holding only ---) | checks
     *   enum      the ENUMS list a select or checks draws from
     *   empty     'null': an empty control means null (a clear), for a field that is null or absent when it has no value
     *   transform 'upper' | 'lower': what a list entry is made before it is compared and sent
     *   wide      full width; the rest sit in a grid
     *   hint      a `tenantProfile.h.<path>` sentence under it
     *   group     'surfaces' and 'links' are drawn by their own blocks, not in the section's list
     */
    FIELDS: [
        { path: 'identity.display_name.ar', section: 'identity', type: 'text', max: 40, dir: 'rtl' },
        { path: 'identity.display_name.en', section: 'identity', type: 'text', max: 40, dir: 'ltr' },
        { path: 'identity.brand_name', section: 'identity', type: 'text', max: 80 },
        { path: 'identity.kind', section: 'identity', type: 'select', enum: 'kind', empty: 'null' },
        { path: 'identity.role', section: 'identity', type: 'text', max: 40, dir: 'ltr', hint: true },
        { path: 'identity.niche', section: 'identity', type: 'text', max: 120, hint: true },
        { path: 'identity.country', section: 'identity', type: 'text', max: 2, dir: 'ltr', empty: 'null', transform: 'upper', hint: true },
        { path: 'identity.timezone', section: 'identity', type: 'text', dir: 'ltr', zones: true, hint: true },

        { path: 'language.primary', section: 'language', type: 'select', enum: 'lang' },
        { path: 'language.register', section: 'language', type: 'select', enum: 'register', empty: 'null', hint: true },
        { path: 'language.digits', section: 'language', type: 'select', enum: 'digits' },

        { path: 'voice.guide', section: 'voice', type: 'textarea', wide: true, rows: 6, hint: true },
        { path: 'voice.tone', section: 'voice', type: 'lines', wide: true, rows: 3, hint: true },
        { path: 'voice.samples', section: 'voice', type: 'samples', wide: true, rows: 7, hint: true },
        { path: 'voice.use_words', section: 'voice', type: 'lines', wide: true, rows: 3, hint: true },
        { path: 'voice.avoid_words', section: 'voice', type: 'lines', wide: true, rows: 3, hint: true },
        { path: 'voice.emoji', section: 'voice', type: 'select', enum: 'emoji' },
        { path: 'voice.address', section: 'voice', type: 'select', enum: 'address', hint: true },

        { path: 'audience.description', section: 'audience', type: 'textarea', wide: true, rows: 4 },
        { path: 'audience.level', section: 'audience', type: 'select', enum: 'level', empty: 'null' },
        { path: 'audience.timezone', section: 'audience', type: 'text', dir: 'ltr', zones: true, empty: 'null', hint: true },
        { path: 'audience.pains', section: 'audience', type: 'lines', wide: true, rows: 3, hint: true },
        { path: 'audience.goals', section: 'audience', type: 'lines', wide: true, rows: 3, hint: true },
        { path: 'audience.countries', section: 'audience', type: 'lines', wide: true, rows: 2, transform: 'upper', hint: true },
        { path: 'audience.languages', section: 'audience', type: 'lines', wide: true, rows: 2, transform: 'lower', hint: true },

        { path: 'content.domain', section: 'content', type: 'select', enum: 'domain', hint: true },
        { path: 'content.pillars', section: 'content', type: 'lines', wide: true, rows: 3, hint: true },
        { path: 'content.never_mention', section: 'content', type: 'lines', wide: true, rows: 3, hint: true },
        { path: 'content.rules', section: 'content', type: 'checks', enum: 'rule', wide: true, hint: true },
        { path: 'content.custom_rules', section: 'content', type: 'lines', wide: true, rows: 3, hint: true },

        { path: 'socials.handle', section: 'socials', type: 'text', max: 32, dir: 'ltr' },
        { path: 'socials.site', section: 'socials', type: 'text', max: 40, dir: 'ltr' },
        { path: 'socials.platforms', section: 'socials', type: 'checks', enum: 'social', wide: true },
    ],

    /** `language.surfaces.<surface>.language|register`: a choice per surface, empty meaning "the profile's own" (the entry is removed). */
    surfaceFields() {
        return this.ENUMS.surface.flatMap((surface) => ['language', 'register'].map((part) => ({
            path: `language.surfaces.${surface}.${part}`, section: 'language', group: 'surfaces', type: 'select',
            enum: part === 'language' ? 'lang' : 'register', empty: 'null', surface, part,
        })));
    },

    /** `socials.links.<platform>`: an https address per platform, empty meaning none (the entry is removed). */
    linkFields() {
        return this.ENUMS.social.map((platform) => ({
            path: `socials.links.${platform}`, section: 'socials', group: 'links', type: 'text', max: 500, dir: 'ltr', empty: 'null', platform,
        }));
    },

    /** Every field, the maps' entries included, and the index by path. Built once. */
    allFields() {
        if (!this._all) {
            this._all = [...this.FIELDS, ...this.surfaceFields(), ...this.linkFields()];
            this._byPath = Object.fromEntries(this._all.map((f) => [f.path, f]));
        }
        return this._all;
    },

    fieldFor(path) {
        this.allFields();
        return this._byPath[path] || null;
    },

    // ─── Canonical values (pure) ────────────────────────────────────────────
    /** One line, trimmed: what a text input holds (the browser strips line breaks from it). */
    oneLine(v) { return String(v === null || v === undefined ? '' : v).replace(/[\r\n]/g, '').trim(); },

    /** Newlines as `\n`, trimmed: what a textarea holds. */
    block(v) { return String(v === null || v === undefined ? '' : v).replace(/\r\n?/g, '\n').trim(); },

    /** What a list entry is made before it is compared and sent. */
    entry(field, v) {
        const text = this.oneLine(v);
        if (field.transform === 'upper') return text.toUpperCase();
        if (field.transform === 'lower') return text.toLowerCase();
        return text;
    },

    /** The text a `lines` textarea is split from, as a list. */
    linesOf(field, text) {
        return String(text === null || text === undefined ? '' : text).split(/\r?\n/).map((s) => this.entry(field, s)).filter(Boolean);
    },

    /** Samples are blocks of text that may hold line breaks themselves, so a line holding only `---` separates them. */
    samplesOf(text) {
        return String(text === null || text === undefined ? '' : text).split(/^[ \t]*-{3,}[ \t]*$/m).map((s) => this.block(s)).filter(Boolean);
    },

    /** The value of a path as the profile holds it, or undefined. Only ever walks the registry's own paths. */
    getPath(root, path) {
        return path.split('.').reduce((node, key) => (node !== null && typeof node === 'object' ? node[key] : undefined), root);
    },

    /** The canonical value of `field` for what the profile holds (`raw`). */
    valueOf(field, raw) {
        switch (field.type) {
            case 'text': return this.entry(field, raw);
            case 'textarea': return this.block(raw);
            case 'select': return raw === null || raw === undefined ? '' : String(raw);
            case 'lines': return (Array.isArray(raw) ? raw : []).map((v) => this.entry(field, v)).filter(Boolean);
            case 'samples': return (Array.isArray(raw) ? raw : []).map((v) => this.block(v)).filter(Boolean);
            case 'checks': return (Array.isArray(raw) ? raw : []).map(String);
            default: return raw;
        }
    },

    /** An offer as the form holds it: the fields a person edits, and the campaign carried along untouched. */
    offerOf(o) {
        const offer = o && typeof o === 'object' ? o : {};
        const out = {
            id: String(offer.id === undefined ? '' : offer.id),
            kind: String(offer.kind === undefined ? 'other' : offer.kind),
            name: this.oneLine(offer.name),
            order_via: String(offer.order_via === undefined ? 'url' : offer.order_via),
            url: this.oneLine(offer.url),
            price: this.oneLine(offer.price),
            facts: (Array.isArray(offer.facts) ? offer.facts : []).map((v) => this.oneLine(v)).filter(Boolean),
            bullets: (Array.isArray(offer.bullets) ? offer.bullets : []).map((v) => this.oneLine(v)).filter(Boolean),
            keyword: this.oneLine(offer.keyword),
            primary: offer.primary === true,
        };
        if (offer.campaign !== undefined) out.campaign = JSON.parse(JSON.stringify(offer.campaign));
        return out;
    },

    /** The flat map `path → canonical value` for a profile, `offers` included. */
    valuesOf(profile) {
        const values = {};
        for (const field of this.allFields()) values[field.path] = this.valueOf(field, this.getPath(profile, field.path));
        values.offers = (profile && Array.isArray(profile.offers) ? profile.offers : []).map((o) => this.offerOf(o));
        return values;
    },

    /** A new offer: primary when it is the only one, and never an id another offer holds. */
    blankOffer(offers) {
        const taken = new Set(offers.map((o) => o.id));
        let id;
        do { id = `offer-${Math.random().toString(36).slice(2, 10)}`; } while (taken.has(id));
        return {
            id, kind: 'product', name: '', order_via: 'url', url: '', price: '', facts: [], bullets: [], keyword: '', primary: offers.length === 0,
        };
    },

    // ─── Reading the form ───────────────────────────────────────────────────
    /**
     * The controls under `root` as plain snapshots, so reading is pure and testable without a DOM:
     *   fields  [{ path, value, checked }]   one per `[data-tp-path]` control (a checkbox is one per option)
     *   offers  null when `root` holds no offers block, else [{ id, kind, name, order_via, url, price, keyword, facts, bullets, primary }]
     */
    snapshot(root) {
        const fields = [...root.querySelectorAll('[data-tp-path]')].map((el) => ({
            path: el.getAttribute('data-tp-path'), value: el.value, checked: el.type === 'checkbox' ? el.checked : undefined,
        }));
        const block = root.querySelector('[data-tp-offers]');
        if (!block) return { fields, offers: null };
        const offers = [...block.querySelectorAll('[data-offer-id]')].map((card) => {
            const read = (key) => {
                const el = card.querySelector(`[data-tp-offer="${key}"]`);
                return el ? el.value : '';
            };
            const primary = card.querySelector('[data-tp-offer="primary"]');
            return {
                id: card.getAttribute('data-offer-id') || '',
                kind: read('kind'), name: read('name'), order_via: read('order_via'), url: read('url'), price: read('price'),
                keyword: read('keyword'), facts: read('facts'), bullets: read('bullets'), primary: !!(primary && primary.checked),
            };
        });
        return { fields, offers };
    },

    /**
     * The values a snapshot holds. A path the snapshot does not mention keeps `base`'s value (another section's, or one with no control).
     * Choices that are lists keep the stored order of what stays chosen, and add what is newly chosen after it, so ticking one
     * more platform does not reorder the others.
     */
    fromSnapshots(snap, base) {
        const values = {};
        const seen = {};
        for (const control of snap.fields) {
            const field = this.fieldFor(control.path);
            if (!field) continue;
            if (field.type === 'checks') {
                const ticked = seen[field.path] || (seen[field.path] = []);
                if (control.checked) ticked.push(String(control.value));
                continue;
            }
            switch (field.type) {
                case 'text': values[field.path] = this.entry(field, control.value); break;
                case 'textarea': values[field.path] = this.block(control.value); break;
                case 'select': values[field.path] = String(control.value === undefined || control.value === null ? '' : control.value); break;
                case 'lines': values[field.path] = this.linesOf(field, control.value); break;
                case 'samples': values[field.path] = this.samplesOf(control.value); break;
                default: break;
            }
        }
        for (const path of Object.keys(seen)) {
            const before = Array.isArray(base[path]) ? base[path] : [];
            values[path] = [...before.filter((v) => seen[path].includes(v)), ...seen[path].filter((v) => !before.includes(v))];
        }
        if (snap.offers) {
            const known = new Map((base.offers || []).map((o) => [o.id, o]));
            values.offers = snap.offers.map((o) => {
                const offer = {
                    id: o.id, kind: String(o.kind), name: this.oneLine(o.name), order_via: String(o.order_via), url: this.oneLine(o.url), price: this.oneLine(o.price),
                    facts: this.linesOf({}, o.facts), bullets: this.linesOf({}, o.bullets), keyword: this.oneLine(o.keyword), primary: o.primary === true,
                };
                const before = known.get(o.id);
                if (before && before.campaign !== undefined) offer.campaign = JSON.parse(JSON.stringify(before.campaign));
                return offer;
            });
        }
        return Object.assign({}, base, values);
    },

    // ─── What changed (pure) ────────────────────────────────────────────────
    /** Key order does not matter to a profile (JSONB reorders keys), so it must not matter to "changed". */
    canon(v) {
        if (Array.isArray(v)) return v.map((x) => this.canon(x));
        if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, this.canon(v[k])]));
        return v;
    },

    same(a, b) { return JSON.stringify(this.canon(a)) === JSON.stringify(this.canon(b)); },

    /** The paths whose value differs between `base` and `current`, optionally only a section's (`offers` is the offers section's). */
    changedPaths(base, current, section) {
        const paths = this.allFields().filter((f) => !section || f.section === section).map((f) => f.path);
        if (!section || section === 'offers') paths.push('offers');
        return paths.filter((path) => !this.same(base[path], current[path]));
    },

    /** What `value` is in a patch: an empty optional field is `null` (the server clears it, or removes the entry from its map). */
    patchValue(field, value) {
        if (field && field.empty === 'null' && value === '') return null;
        return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : value;
    },

    /** `{ identity: { niche } }` for the paths named, and nothing else: the paths are the registry's own, never user input. */
    buildPatch(current, paths) {
        const patch = {};
        for (const path of paths) {
            const field = this.fieldFor(path);
            const value = path === 'offers' ? JSON.parse(JSON.stringify(current.offers)) : this.patchValue(field, current[path]);
            const keys = path.split('.');
            let node = patch;
            for (let i = 0; i < keys.length - 1; i++) {
                if (!Object.prototype.hasOwnProperty.call(node, keys[i])) node[keys[i]] = {};
                node = node[keys[i]];
            }
            node[keys[keys.length - 1]] = value;
        }
        return patch;
    },

    // ─── Markup (pure: values → SafeHtml) ───────────────────────────────────
    idFor(path) { return `tp-${String(path).replace(/[^A-Za-z0-9]+/g, '-')}`; },

    /** What a select option or a checkbox says: `tenantProfile.o.<list>.<value>`, and "not set" for the empty one. */
    optionLabel(list, value) {
        return value === '' ? t(list === 'surfaceInherit' ? 'tenantProfile.o.inherit' : 'tenantProfile.o.none') : t(`tenantProfile.o.${list}.${value}`);
    },

    timezones() {
        if (!this._zones) {
            try { this._zones = Intl.supportedValuesOf('timeZone'); } catch { this._zones = []; }
        }
        return this._zones;
    },

    /** One select. `inherit`: its empty option reads "same as the profile". */
    selectMarkup(id, path, list, value, options) {
        const o = options || {};
        const values = o.empty ? ['', ...this.ENUMS[list]] : this.ENUMS[list];
        return html`<select class="select" id="${id}" data-tp-path="${path}"${o.describedBy ? html` aria-describedby="${o.describedBy}"` : ''}>${
            values.map((v) => html`<option value="${v}"${v === value ? html.raw(' selected') : ''}>${this.optionLabel(v === '' && o.inherit ? 'surfaceInherit' : list, v)}</option>`)
        }</select>`;
    },

    /** The control of one field, with the value it starts at. */
    controlMarkup(field, value, describedBy) {
        const id = this.idFor(field.path);
        const aria = describedBy ? html` aria-describedby="${describedBy}"` : '';
        switch (field.type) {
            case 'select':
                return this.selectMarkup(id, field.path, field.enum, value, { empty: field.empty === 'null', describedBy });
            case 'textarea':
                return html`<textarea class="field-textarea" id="${id}" data-tp-path="${field.path}" dir="auto" rows="${field.rows || 4}"${aria}>
${value}</textarea>`;
            case 'lines':
                return html`<textarea class="field-textarea" id="${id}" data-tp-path="${field.path}" dir="auto" rows="${field.rows || 3}"${aria}>
${(value || []).join('\n')}</textarea>`;
            case 'samples':
                return html`<textarea class="field-textarea" id="${id}" data-tp-path="${field.path}" dir="auto" rows="${field.rows || 6}"${aria}>
${(value || []).join('\n---\n')}</textarea>`;
            default:
                return html`<input class="field${field.dir === 'ltr' ? html.raw(' field-mono') : ''}" id="${id}" type="text" data-tp-path="${field.path}" value="${value}" dir="${field.dir || 'auto'}" autocomplete="off" spellcheck="false"${field.max ? html` maxlength="${field.max}"` : ''}${field.zones ? html.raw(' list="tp-timezones"') : ''}${aria}>`;
        }
    },

    /** A labelled field of a section, with its hint. */
    fieldMarkup(field, values) {
        const id = this.idFor(field.path);
        const hintId = `${id}-hint`;
        const hint = field.hint ? t(`tenantProfile.h.${field.path}`) : '';
        const owner = field.path === 'content.rules' && this.state && this.state.isPlatformOwner === true;
        const describedBy = [field.hint ? hintId : '', owner ? `${id}-owner` : ''].filter(Boolean).join(' ');
        const label = t(`tenantProfile.f.${field.path}`);

        if (field.type === 'checks') {
            const chosen = Array.isArray(values[field.path]) ? values[field.path] : [];
            return html`
                <fieldset class="form-group fieldset-plain"${describedBy ? html` aria-describedby="${describedBy}"` : ''}>
                    <legend class="form-label">${label}</legend>
                    <div class="tp-checks">
                        ${this.ENUMS[field.enum].map((v) => html`
                            <label class="check-row" for="${id}-${v}">
                                <input type="checkbox" id="${id}-${v}" data-tp-path="${field.path}" value="${v}"${chosen.includes(v) ? html.raw(' checked') : ''}>
                                <span class="check-label">${t(`tenantProfile.o.${field.enum}.${v}`)}</span>
                            </label>
                        `)}
                    </div>
                    ${hint ? html`<p class="form-hint" id="${hintId}">${hint}</p>` : ''}
                    ${owner ? html`<p class="form-hint text-warning" id="${id}-owner">${t('tenantProfile.ownerRuleHint')}</p>` : ''}
                </fieldset>
            `;
        }
        return html`
            <div class="form-group">
                <label class="form-label" for="${id}">${label}</label>
                ${this.controlMarkup(field, values[field.path], describedBy)}
                ${hint ? html`<p class="form-hint" id="${hintId}">${hint}</p>` : ''}
            </div>
        `;
    },

    /** A section's own fields: the short ones in a grid, the long ones full width. */
    fieldsMarkup(section, values) {
        const own = this.FIELDS.filter((f) => f.section === section);
        const short = own.filter((f) => !f.wide);
        const wide = own.filter((f) => f.wide);
        return html`
            ${short.length ? html`<div class="tp-grid">${short.map((f) => this.fieldMarkup(f, values))}</div>` : ''}
            ${wide.map((f) => this.fieldMarkup(f, values))}
        `;
    },

    /** Language: a choice of language, register and digits, then which surfaces speak differently. */
    languageMarkup(values) {
        const rows = this.ENUMS.surface.map((surface) => {
            const lang = this.fieldFor(`language.surfaces.${surface}.language`);
            const reg = this.fieldFor(`language.surfaces.${surface}.register`);
            const nameId = `tp-surface-${surface}`;
            // Each select is named by its own visible label and described by the surface it belongs to, so a screen reader hears both.
            const one = (field, list, label) => html`
                <div>
                    <label class="tp-surface-label" for="${this.idFor(field.path)}">${label}</label>
                    ${this.selectMarkup(this.idFor(field.path), field.path, list, values[field.path], { empty: true, inherit: true, describedBy: nameId })}
                </div>
            `;
            return html`
                <div class="tp-surface">
                    <span class="tp-surface-name" id="${nameId}">${t(`tenantProfile.o.surface.${surface}`)}</span>
                    ${one(lang, 'lang', t('tenantProfile.f.language.primary'))}
                    ${one(reg, 'register', t('tenantProfile.f.language.register'))}
                </div>
            `;
        });
        return html`
            ${this.fieldsMarkup('language', values)}
            <fieldset class="form-group fieldset-plain" aria-describedby="tp-surfaces-hint">
                <legend class="form-label">${t('tenantProfile.surfaces')}</legend>
                <div class="tp-surfaces">${rows}</div>
                <p class="form-hint" id="tp-surfaces-hint">${t('tenantProfile.surfacesHint')}</p>
            </fieldset>
        `;
    },

    /** Socials: the handle and site, which platforms the infographics list, and a link per platform. */
    socialsMarkup(values) {
        const links = this.linkFields().map((field) => html`
            <div class="form-group">
                <label class="form-label" for="${this.idFor(field.path)}">${t(`tenantProfile.o.social.${field.platform}`)}</label>
                ${this.controlMarkup(field, values[field.path], 'tp-links-hint')}
            </div>
        `);
        return html`
            ${this.fieldsMarkup('socials', values)}
            <fieldset class="form-group fieldset-plain">
                <legend class="form-label">${t('tenantProfile.links')}</legend>
                <div class="tp-grid">${links}</div>
                <p class="form-hint" id="tp-links-hint">${t('tenantProfile.linksHint')}</p>
            </fieldset>
        `;
    },

    /** One offer's card. The id rides in `data-offer-id` (escaped), and is how the campaign is carried over on save. */
    offerMarkup(offer, index) {
        const n = index + 1;
        const id = (key) => `tp-offer-${index}-${key}`;
        const input = (key, max, dir) => html`<input class="field${dir === 'ltr' ? html.raw(' field-mono') : ''}" id="${id(key)}" type="text" data-tp-offer="${key}" value="${offer[key]}" dir="${dir || 'auto'}" maxlength="${max}" autocomplete="off" spellcheck="false">`;
        const select = (key, list) => html`<select class="select" id="${id(key)}" data-tp-offer="${key}">${
            this.ENUMS[list].map((v) => html`<option value="${v}"${v === offer[key] ? html.raw(' selected') : ''}>${t(`tenantProfile.o.${list}.${v}`)}</option>`)
        }</select>`;
        const lines = (key, rows) => html`<textarea class="field-textarea" id="${id(key)}" data-tp-offer="${key}" dir="auto" rows="${rows}">
${offer[key].join('\n')}</textarea>`;
        return html`
            <fieldset class="tp-offer" data-offer-id="${offer.id}">
                <legend class="tp-offer-legend">${t('tenantProfile.offerN', { n })}</legend>
                <div class="tp-grid">
                    <div class="form-group"><label class="form-label" for="${id('kind')}">${t('tenantProfile.f.offer.kind')}</label>${select('kind', 'offerKind')}</div>
                    <div class="form-group"><label class="form-label" for="${id('name')}">${t('tenantProfile.f.offer.name')}</label>${input('name', 200)}</div>
                    <div class="form-group"><label class="form-label" for="${id('order_via')}">${t('tenantProfile.f.offer.order_via')}</label>${select('order_via', 'orderVia')}</div>
                    <div class="form-group"><label class="form-label" for="${id('url')}">${t('tenantProfile.f.offer.url')}</label>${input('url', 1000, 'ltr')}</div>
                    <div class="form-group"><label class="form-label" for="${id('price')}">${t('tenantProfile.f.offer.price')}</label>${input('price', 60)}</div>
                    <div class="form-group"><label class="form-label" for="${id('keyword')}">${t('tenantProfile.f.offer.keyword')}</label>${input('keyword', 80)}</div>
                </div>
                <div class="form-group"><label class="form-label" for="${id('facts')}">${t('tenantProfile.f.offer.facts')}</label>${lines('facts', 3)}</div>
                <div class="form-group"><label class="form-label" for="${id('bullets')}">${t('tenantProfile.f.offer.bullets')}</label>${lines('bullets', 3)}</div>
                <div class="row row--between row--wrap gap-3">
                    <label class="check-row" for="${id('primary')}">
                        <input type="radio" name="tp-offer-primary" id="${id('primary')}" data-tp-offer="primary" value="${offer.id}"${offer.primary ? html.raw(' checked') : ''}>
                        <span class="check-label">${t('tenantProfile.f.offer.primary')}</span>
                    </label>
                    ${offer.campaign !== undefined ? html`<span class="chip">${t('tenantProfile.offerCampaign')}</span>` : ''}
                    <button type="button" class="btn btn-ghost btn-sm" data-action="tenantProfile:removeOffer" aria-label="${t('tenantProfile.removeOfferN', { n })}">
                        <i data-lucide="trash-2" aria-hidden="true"></i> ${t('tenantProfile.removeOffer')}
                    </button>
                </div>
            </fieldset>
        `;
    },

    offersMarkup(values) {
        const offers = values.offers || [];
        return html`
            <div data-tp-offers>
                <p class="form-hint mbe-4" id="tp-offers-hint">${offers.length === 0 ? t('tenantProfile.offersNone') : t('tenantProfile.offersHint')}</p>
                ${offers.map((o, i) => this.offerMarkup(o, i))}
            </div>
            <div class="mbe-4">
                ${UI.button({
                    variant: 'secondary', size: 'sm', icon: 'plus', label: t('tenantProfile.addOffer'), action: 'tenantProfile:addOffer',
                    disabled: offers.length >= this.LIMITS.offers,
                })}
            </div>
        `;
    },

    /** The inside of a section: its heading and its form. */
    sectionMarkup(section, values) {
        const titleId = `tp-${section}-title`;
        const name = t(`tenantProfile.section.${section}`);
        let fields;
        if (section === 'language') fields = this.languageMarkup(values);
        else if (section === 'socials') fields = this.socialsMarkup(values);
        else if (section === 'offers') fields = this.offersMarkup(values);
        else fields = this.fieldsMarkup(section, values);
        const locked = !!this.conflict;
        return html`
            <h3 class="tp-section-title" id="${titleId}" tabindex="-1">${name}</h3>
            <form class="tp-form" data-tp-section="${section}" data-submit="tenantProfile:save" aria-labelledby="${titleId}" novalidate>
                ${fields}
                <div class="tp-problems" data-tp-problems role="alert" tabindex="-1"></div>
                <div class="form-actions">
                    ${UI.button({ variant: 'primary', size: 'sm', type: 'submit', icon: 'check', label: t('tenantProfile.save', { section: name }), disabled: locked })}
                    ${UI.button({ variant: 'ghost', size: 'sm', icon: 'rotate-cw', label: t('tenantProfile.discard'), action: 'tenantProfile:discard', data: { section } })}
                </div>
            </form>
        `;
    },

    /** Version, onboarding and what is still missing: the strip above the forms. */
    metaMarkup(state) {
        const known = ['invited', 'in_progress', 'completed'];
        const status = known.includes(state.onboarding && state.onboarding.status) ? state.onboarding.status : 'completed';
        const filledByAdmin = !!(state.onboarding && state.onboarding.filledBy === 'admin');
        const missing = Array.isArray(state.activationMissing) ? state.activationMissing : [];
        const version = state.version === null || state.version === undefined
            ? t('tenantProfile.versionNone') : t('tenantProfile.version', { version: state.version });
        return html`
            <div class="alert-card alert-info" role="note">
                <span class="alert-icon"><i data-lucide="info" aria-hidden="true"></i></span>
                <div>
                    <h3>${t('tenantProfile.onBehalf', { name: this.tenantName })}</h3>
                    <p>${status === 'completed' ? t('tenantProfile.noteCompleted') : t('tenantProfile.noteWizard')}</p>
                </div>
            </div>
            <div class="row row--wrap gap-2 mbs-4">
                <span class="chip">${version}</span>
                <span class="chip">${t(`tenantProfile.onboarding.${status}`)}</span>
                ${filledByAdmin ? html`<span class="chip chip-accent">${t('tenantProfile.filledByAdmin')}</span>` : ''}
                ${state.isPlatformOwner === true ? html`<span class="chip chip-accent">${t('tenantProfile.platformOwner')}</span>` : ''}
            </div>
            ${missing.length ? html`
                <p class="form-hint mbs-4">${t('tenantProfile.missing')}
                    ${missing.map((p) => html` <code class="tp-missing" dir="ltr">${p}</code>`)}
                </p>
            ` : ''}
        `;
    },

    /** The conflict banner: the profile moved under the admin's hands, their edits are still in the forms. */
    conflictMarkup(conflict) {
        const known = conflict.currentVersion !== null && conflict.currentVersion !== undefined;
        return html`
            <div class="alert-card alert-warning">
                <span class="alert-icon"><i data-lucide="alert-triangle" aria-hidden="true"></i></span>
                <div>
                    <h3 id="tp-conflict-title" tabindex="-1">${t('tenantProfile.conflictTitle')}</h3>
                    <p>${known ? t('tenantProfile.conflictBody', { version: conflict.currentVersion }) : t('tenantProfile.conflictBodyNone')}</p>
                    <div class="row row--wrap gap-2">
                        ${UI.button({ variant: 'primary', size: 'sm', icon: 'rotate-cw', label: t('tenantProfile.reloadKeep'), action: 'tenantProfile:reloadKeep' })}
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('tenantProfile.reloadDiscard'), action: 'tenantProfile:reloadDiscard' })}
                    </div>
                </div>
            </div>
        `;
    },

    /** The whole editor for `values`. */
    render(values) {
        return html`
            <div class="tp" data-tp-root>
                <div id="tp-meta">${this.metaMarkup(this.state)}</div>
                <div id="tp-status" role="alert">${this.conflict ? this.conflictMarkup(this.conflict) : ''}</div>
                <datalist id="tp-timezones">${this.timezones().map((z) => html`<option value="${z}"></option>`)}</datalist>
                ${this.SECTIONS.map((s) => html`<section class="tp-section" data-tp-wrap="${s}">${this.sectionMarkup(s, values)}</section>`)}
            </div>
        `;
    },

    // ─── Running it ─────────────────────────────────────────────────────────
    host: null,
    tenantId: null,
    tenantName: '',
    /** What the server last answered: `{ profile, version, stored, activationMissing, isPlatformOwner, onboarding }`. */
    state: null,
    /** `valuesOf(state.profile)`: what "changed" is measured against. */
    base: null,
    /** Set by a 409 `PROFILE_VERSION_CONFLICT`: `{ currentVersion }`. Saving waits for a reload. */
    conflict: null,
    _seq: 0,

    /** Still the editor on screen? The admin may have moved to another tenant while a request was out. */
    live(seq) { return seq === this._seq && !!this.host && this.host.isConnected !== false; },

    async mount(host, tenant) {
        this.host = host;
        this.tenantId = tenant.id;
        this.tenantName = tenant.name || '';
        this.conflict = null;
        this.state = null;
        this.base = null;
        const seq = ++this._seq;
        host.innerHTML = esc(html`<p class="form-hint" role="status">${t('common.loading')}</p>`);
        try {
            const state = await API.getAdminTenantProfile(this.tenantId);
            if (!this.live(seq)) return;
            this.adopt(state);
            this.paintAll(this.base);
        } catch (err) {
            if (!this.live(seq)) return;
            this.paintLoadFailure(err);
        }
    },

    unmount() {
        this._seq += 1;
        this.host = null;
        this.state = null;
        this.base = null;
        this.conflict = null;
    },

    adopt(state) {
        this.state = state;
        this.base = this.valuesOf(state.profile);
        this.conflict = null;
    },

    paintLoadFailure(err) {
        this.host.innerHTML = esc(html`
            <div class="alert-card alert-danger" role="alert">
                <span class="alert-icon"><i data-lucide="alert-triangle" aria-hidden="true"></i></span>
                <div>
                    <h3>${t('tenantProfile.loadFailed')}</h3>
                    <p dir="auto">${(err && err.message) || t('common.error')}</p>
                    ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'tenantProfile:retry' })}
                </div>
            </div>
        `);
        UI.icons(this.host);
    },

    paintAll(values) {
        this.host.innerHTML = esc(this.render(values));
        UI.icons(this.host);
        Motion.announce(`${t('tenantProfile.title')} — ${t('common.loaded')}`);
    },

    /** Re-render one section from `values`, leaving every other section's form (and its unsaved edits) alone. */
    paintSection(section, values) {
        const wrap = this.host.querySelector(`[data-tp-wrap="${section}"]`);
        if (!wrap) return null;
        wrap.innerHTML = esc(this.sectionMarkup(section, values));
        UI.icons(wrap);
        return wrap;
    },

    paintMeta() {
        const meta = this.host.querySelector('#tp-meta');
        if (!meta) return;
        meta.innerHTML = esc(this.metaMarkup(this.state));
        UI.icons(meta);
    },

    /** Every section's values as the forms hold them now: `base`, with each control read over it. */
    readAll() {
        return this.fromSnapshots(this.snapshot(this.host), this.base);
    },

    // ─── Saving ─────────────────────────────────────────────────────────────
    showProblems(form, problems) {
        const box = form.querySelector('[data-tp-problems]');
        if (!box) return;
        box.innerHTML = esc(html`
            <div class="alert-card alert-danger">
                <span class="alert-icon"><i data-lucide="alert-triangle" aria-hidden="true"></i></span>
                <div>
                    <h3>${t('tenantProfile.problemsTitle')}</h3>
                    <ul class="tp-problem-list">${problems.map((p) => html`<li dir="auto">${p}</li>`)}</ul>
                </div>
            </div>
        `);
        UI.icons(box);
        box.focus();
    },

    clearProblems(form) {
        const box = form.querySelector('[data-tp-problems]');
        if (box) box.innerHTML = '';
    },

    showConflict(currentVersion) {
        this.conflict = { currentVersion: currentVersion === undefined ? null : currentVersion };
        const status = this.host.querySelector('#tp-status');
        if (status) {
            status.innerHTML = esc(this.conflictMarkup(this.conflict));
            UI.icons(status);
        }
        // Saving at the version that lost would only lose again: it waits for a reload. The edits stay.
        this.host.querySelectorAll('.tp-form button[type="submit"]').forEach((b) => { b.disabled = true; });
        const title = this.host.querySelector('#tp-conflict-title');
        if (title) title.focus();
    },

    /**
     * Save one section: only its changed paths, with the version the profile was read at.
     * `options.confirmOwnerRule` is set by the dialog the owner's rule asks (`OWNER_RULE_LOCKED`) and nothing else.
     */
    async save(form, event, options) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (this.conflict || !this.state) return;
        const section = form.getAttribute('data-tp-section');
        const current = this.fromSnapshots(this.snapshot(form), this.base);
        const paths = this.changedPaths(this.base, current, section);
        this.clearProblems(form);
        if (paths.length === 0) {
            UI.toast(t('tenantProfile.noChanges'));
            return;
        }
        const body = { version: this.state.version, patch: this.buildPatch(current, paths) };
        if (options && options.confirmOwnerRule === true) body.confirm_remove_owner_rule = true;

        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return; // already in flight
        const seq = this._seq;
        try {
            const state = await API.updateAdminTenantProfile(this.tenantId, body);
            // Put the button back before anything is drawn: if the section cannot be found to redraw, Save must not stay busy.
            restore();
            if (!this.live(seq)) return;
            this.adopt(state);
            this.paintMeta();
            const wrap = this.paintSection(section, this.base);
            const title = wrap && wrap.querySelector('.tp-section-title');
            if (title) title.focus();
            const name = t(`tenantProfile.section.${section}`);
            UI.toast(t('tenantProfile.saved', { section: name }));
            Motion.announce(t('tenantProfile.saved', { section: name }));
        } catch (err) {
            restore();
            if (!this.live(seq)) return;
            this.saveFailed(form, err);
        }
    },

    saveFailed(form, err) {
        const body = (err && err.body) || {};
        if (err && err.status === 409 && body.code === 'PROFILE_VERSION_CONFLICT') {
            this.showConflict(body.currentVersion);
            return;
        }
        if (err && err.status === 409 && body.code === 'OWNER_RULE_LOCKED') {
            Admin.confirm({
                title: t('tenantProfile.ownerLockedTitle'),
                body: t('tenantProfile.ownerLockedBody'),
                hint: t('tenantProfile.ownerLockedHint'),
                confirmLabel: t('tenantProfile.ownerLockedConfirm'),
                confirmIcon: 'alert-triangle',
                onConfirm: () => this.save(form, null, { confirmOwnerRule: true }),
            });
            return;
        }
        if (err && err.status === 400 && Array.isArray(body.problems) && body.problems.length) {
            this.showProblems(form, body.problems);
            return;
        }
        const message = (err && err.message) || t('tenantProfile.saveFailed');
        this.showProblems(form, [message]);
        UI.toast(message, 'error');
    },

    /** Put one section back to what the server holds, dropping its unsaved edits. */
    discard(section) {
        this.paintSection(section, this.base);
    },

    // ─── Reloading ──────────────────────────────────────────────────────────
    /**
     * Fetch the latest. With `keep`, the paths the admin had changed come back on top of it (and are the only thing that does),
     * so what someone else saved is shown and what the admin typed is not lost; without it, the forms start over.
     */
    async reload(keep) {
        const mine = keep && this.base ? this.readAll() : null;
        const pending = mine ? this.changedPaths(this.base, mine) : [];
        const seq = this._seq;
        try {
            const state = await API.getAdminTenantProfile(this.tenantId);
            if (!this.live(seq)) return;
            this.adopt(state);
            const values = Object.assign({}, this.base);
            for (const path of pending) values[path] = mine[path];
            this.paintAll(values);
            UI.toast(pending.length ? t('tenantProfile.reloadedKept') : t('tenantProfile.reloaded'));
        } catch (err) {
            if (!this.live(seq)) return;
            UI.toast((err && err.message) || t('tenantProfile.loadFailed'), 'error');
        }
    },

    // ─── Offers ─────────────────────────────────────────────────────────────
    /** The offers as the form holds them, changed by `change`, drawn again with everything else in the section as typed. */
    editOffers(el, change) {
        const form = el.closest('form');
        const values = this.fromSnapshots(this.snapshot(form), this.base);
        const offers = values.offers.slice();
        const result = change(offers, el);
        if (!result) return null;
        this.paintSection('offers', Object.assign({}, values, { offers: result }));
        return result;
    },

    addOffer(el) {
        const added = this.editOffers(el, (offers) => (offers.length >= this.LIMITS.offers ? null : [...offers, this.blankOffer(offers)]));
        if (!added) return;
        const field = this.host.querySelector(`#tp-offer-${added.length - 1}-name`);
        if (field) field.focus();
    },

    removeOffer(el) {
        const card = el.closest('[data-offer-id]');
        const id = card ? card.getAttribute('data-offer-id') : null;
        const kept = this.editOffers(el, (offers) => {
            const left = offers.filter((o) => o.id !== id);
            // An offer list with offers needs exactly one primary: the first stays one if the primary was the one removed.
            if (left.length > 0 && !left.some((o) => o.primary)) left[0] = Object.assign({}, left[0], { primary: true });
            return left;
        });
        if (!kept) return;
        const add = this.host.querySelector('[data-action="tenantProfile:addOffer"]');
        if (add && !add.disabled) add.focus();
    },
};

UI.registerActions('tenantProfile', {
    save: (el, e) => Admin.report(TenantProfile.save(el, e)),
    discard: (el) => TenantProfile.discard(el.getAttribute('data-section')),
    addOffer: (el) => TenantProfile.addOffer(el),
    removeOffer: (el) => TenantProfile.removeOffer(el),
    reloadKeep: () => Admin.report(TenantProfile.reload(true)),
    reloadDiscard: () => Admin.report(TenantProfile.reload(false)),
    retry: () => Admin.report(TenantProfile.mount(TenantProfile.host, { id: TenantProfile.tenantId, name: TenantProfile.tenantName })),
});
