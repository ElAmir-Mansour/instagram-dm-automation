/**
 * Brand (#/brand): the workspace's logo and the "use my brand colours" switch, with a preview of where the logo lands (Brand Kit Phase 1).
 *
 *   GET   /api/profile                  { profile, version, stored, … }       (operator and owner; a viewer's is a 403)
 *   GET   /api/studio/settings          { settings }                          (the preview's ink, accent list and explainer title colour)
 *   POST  /api/upload                   { filename: 'logo.png', mime_type: 'image/png', base64_data } → { id, url }
 *   PATCH /api/profile                  { version, patch: { brand: { logos: { main: {…} } } } }       save the logo
 *                                       { version, patch: { brand: { logos: { main: null } } } }      remove it
 *                                       { version, patch: { brand: { use_brand_colours: true|false } } }
 *
 * WHO: the OWNER edits. An operator reads, with every control disabled (`brand.readOnly`). A viewer has no menu item, and a direct visit
 * shows `brand.forbidden` (the server answers their GET with 403, and the page does not even ask).
 *
 * THE LOGO is prepared in the browser (`brand_image.js`, loaded the first time it is needed): trimmed, measured, turned into a PNG. What
 * is held here before Save is a DRAFT: the processed picture, its measurements and an undo stack. Nothing is sent until "Save logo", and
 * leaving the page with a draft asks first (`canLeave`). The server re-reads the PNG's bytes (`checkLogoUpload`): its refusals arrive as
 * `BRAND_LOGO_INVALID` with machine codes in `problems` ("logo.not_png"), which become the sentences `brand.logoError.<code>`; a storage
 * failure is `BRAND_LOGO_UNREADABLE`. A 409 `PROFILE_VERSION_CONFLICT` reads the profile again and sends the SAME upload once more.
 *
 * THE PREVIEW is drawn in CSS by the same numbers as the Mac's templates (contract §5.3), scaled to a 200-px tile, with the plate rule
 * from `BrandImage.plateFor` (the Mac's rule, with the same nine test vectors). Every tile is a plain description (`tileModel`), turned into
 * CSS custom properties by `cssVars` and set from script after each hex value passed /^#[0-9A-F]{6}$/i. A saved logo's URL goes through
 * `safeUrl`, so a stored value that is not an http(s) or image URL draws nothing. Nothing a person typed reaches the markup unescaped.
 */
const BrandPage = {
    // ─── What the preview falls back to when the Studio settings did not load ──
    FALLBACK: { ink: '#08080A', accent: '#FFD60A', reel: '#FFD60A', title: '#FFD43B' },
    /** The pages a logo is shown on, in the logo card. */
    SWATCH: { dark: '#08080A', light: '#F7F6F2' },
    VIDEO: '#2B2E35',
    TILE_WIDTH: 200,
    /** The gap between a header logo and the signature that follows it (contract §5.3). */
    SIGNATURE_GAP: 18,

    /**
     * The five tiles, with the numbers of contract §5.3: the canvas, the logo's height and widest, and where its OUTER box (the plate,
     * when there is one) sits. `centreY` centres it vertically on a row; `top` is the outer box's top edge; `centre` centres it across.
     * `start` is the distance from the start edge, per direction (a carousel's TikTok box has the wide inset on the right).
     */
    TILES: [
        { key: 'carousel', label: 'brand.preview.carousel', w: 1080, h: 1350, surface: 'carousel', logoH: 52, maxW: 340, centreY: 100, start: { rtl: 92, ltr: 92 }, signature: true },
        { key: 'carouselTikTok', label: 'brand.preview.carouselTikTok', w: 1080, h: 1920, surface: 'carousel', logoH: 56, maxW: 360, centreY: 284, start: { rtl: 150, ltr: 84 }, signature: true },
        { key: 'infographic', label: 'brand.preview.infographic', w: 1080, h: 1350, surface: 'infographic', logoH: 48, maxW: 320, centreY: 1281, start: { rtl: 40, ltr: 40 }, signature: false },
        { key: 'explainer', label: 'brand.preview.explainer', w: 1080, h: 1920, surface: 'explainer', logoH: 56, maxW: 440, top: 1640, centre: true, signature: false },
        { key: 'reel', label: 'brand.preview.reel', w: 1080, h: 1920, surface: 'reel', logoH: 120, maxW: 560, top: 270, centre: true, signature: false },
    ],

    // ─── State ───────────────────────────────────────────────────────────────
    profile: null,
    version: null,
    settings: null,
    /** What has been prepared and not saved: `{ canvas, history, bgBase, tolerance, stats, problem, png }`, or null. */
    draft: null,
    /** 'ع' / 'EN' of the preview: 'ar' or 'en'. */
    previewLang: '',
    /** The request in flight: 'prepare' | 'save' | 'remove' | 'colours' | ''. */
    busy: '',
    /** The last refusal, per card. */
    errors: { logo: '', colours: '' },
    _seq: 0,
    _destroyed: false,
    /** The tile and swatch descriptions of the last paint, by element key (read by `applyVars`). */
    _models: null,

    resetTenantState() {
        this.profile = null;
        this.version = null;
        this.settings = null;
        this.draft = null;
        this.busy = '';
        this.errors = { logo: '', colours: '' };
        this._models = null;
    },

    /** The router asks before it leaves for another page: a prepared logo that was never saved would be lost. */
    canLeave() {
        return !this.draft;
    },

    discardChanges() {
        this.draft = null;
    },

    destroy() {
        this._destroyed = true;
    },

    alive(seq) {
        if (seq !== this._seq || this._destroyed || !document.getElementById('page-container')) return false;
        return typeof App === 'undefined' || !App.currentPage || App.currentPage === 'brand';
    },

    /** An owner edits; an operator reads. */
    canEdit() {
        return typeof App === 'undefined' || typeof App.canAdminister !== 'function' || App.canAdminister();
    },

    canRead() {
        return typeof App === 'undefined' || typeof App.canOperate !== 'function' || App.canOperate();
    },

    skeleton() {
        return html`${Motion.cardGrid(3, 3)}${Motion.busy()}`;
    },

    // ─── Loading ─────────────────────────────────────────────────────────────
    /** The image module (`brand_image.js`): already in, or fetched. Null when it could not be loaded. */
    async image() {
        if (typeof BrandImage !== 'undefined') return BrandImage;
        if (typeof App !== 'undefined' && typeof App.loadPageModule === 'function') return App.loadPageModule('brand_image');
        return null;
    },

    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const seq = ++this._seq;
        this._destroyed = false;
        if (!this.canRead()) {
            container.innerHTML = esc(html`<div class="surface pad-5">${UI.emptyState({ icon: 'lock', title: t('brand.forbidden') })}</div>`);
            UI.icons(container);
            return;
        }
        const gate = Motion.beginLoad(container, () => this.skeleton());
        const [profile, settings, image] = await Promise.allSettled([API.getProfile(), API.getStudioSettings(), this.image()]);
        gate.done();
        if (!this.alive(seq)) return;
        if (profile.status === 'rejected') {
            this.renderFailure(container, profile.reason);
            return;
        }
        const state = profile.value || {};
        if (!state.profile || typeof state.profile !== 'object' || !state.profile.brand) {
            this.renderFailure(container, new Error(t('brand.loadFailed')));
            return;
        }
        this.profile = state.profile;
        this.version = state.version === undefined ? null : state.version;
        // The preview's own inputs: a refusal falls back to the Studio's defaults rather than taking the page down with it.
        this.settings = settings.status === 'fulfilled' && settings.value && settings.value.settings ? settings.value.settings : null;
        if (image.status === 'rejected' || !image.value) {
            this.renderFailure(container, new Error(t('brand.loadFailed')));
            return;
        }
        if (!this.previewLang) this.previewLang = typeof I18N !== 'undefined' && I18N.lang === 'en' ? 'en' : 'ar';
        this.paint(container);
    },

    renderFailure(container, err) {
        if (err && err.status === 403) {
            container.innerHTML = esc(html`<div class="surface pad-5">${UI.emptyState({ icon: 'lock', title: t('brand.forbidden') })}</div>`);
            UI.icons(container);
            return;
        }
        UI.renderError(container, { title: t('brand.loadFailed'), message: (err && err.message) || t('error.unexpected') }, () => this.render());
    },

    // ─── Reading the profile (pure helpers, tested directly) ─────────────────
    /** The saved logo, or null: only the shape the server writes counts, so a stored value of another shape draws nothing. */
    savedLogo(profile) {
        const brand = profile && profile.brand;
        const main = brand && brand.logos && brand.logos.main;
        if (!main || typeof main !== 'object') return null;
        if (typeof main.url !== 'string' || !Number.isFinite(main.width) || !Number.isFinite(main.height) || main.width < 1 || main.height < 1) return null;
        return {
            url: main.url,
            width: main.width,
            height: main.height,
            alpha: main.alpha === true,
            tone: main.tone === 'light' ? 'light' : 'dark',
            colour: BrandImage.safeHex(main.colour, '#000000'),
        };
    },

    coloursOn(profile) {
        return !!(profile && profile.brand && profile.brand.use_brand_colours === true);
    },

    /** What the cards show a logo as: the draft, else the saved one. `{ url, width, height, alpha, tone, colour, draft }` or null. */
    shown() {
        const d = this.draft;
        if (d && d.png && !d.problem) {
            return {
                url: `data:image/png;base64,${d.png.base64}`, width: d.png.width, height: d.png.height,
                alpha: d.stats.alpha, tone: d.stats.tone, colour: d.stats.colour, draft: true,
            };
        }
        const saved = this.savedLogo(this.profile);
        return saved ? Object.assign({ draft: false }, saved) : null;
    },

    /** The colours each tile paints with: the brand's when the switch is on, else what the Studio uses today. */
    previewContext() {
        const brand = (this.profile && this.profile.brand) || {};
        const s = this.settings || {};
        const colours = this.coloursOn(this.profile) ? BrandImage.brandColours(brand.primary, brand.accent) : null;
        const primary = BrandImage.safeHex(brand.primary, BrandImage.DEFAULT_PRIMARY);
        const accent = BrandImage.safeHex(brand.accent, BrandImage.DEFAULT_ACCENT);
        const palette = s.brand && Array.isArray(s.brand.palette) ? s.brand.palette : [];
        return {
            colours,
            logo: this.shown(),
            ink: colours ? colours.carouselInk : BrandImage.safeHex(s.brand && s.brand.colors && s.brand.colors.ink, this.FALLBACK.ink),
            carouselAccent: colours ? colours.carouselAccent : BrandImage.safeHex(palette[0], this.FALLBACK.accent),
            reelAccent: colours ? colours.reelAccent : this.FALLBACK.reel,
            explainerTitle: colours ? colours.explainerTitle : BrandImage.safeHex(s.explainer && s.explainer.title_color, this.FALLBACK.title),
            // The infographic's page is the template's own rule (`lookFor`): the primary mixed 82% into black, or paper.
            infographicBg: brand.theme === 'light' ? '#F7F6F2' : BrandImage.mix(primary, '#000000', 0.82),
            infographicAccent: accent,
        };
    },

    // ─── The preview: one description per tile (pure) ────────────────────────
    /**
     * Where the logo goes on `tile`, in the canvas's own pixels, and what colours the tile has. `lang` is 'ar' or 'en'. With no logo the
     * box is a square placeholder, so the corner is still shown.
     */
    tileModel(tile, ctx, lang) {
        const BI = BrandImage;
        const logo = ctx.logo;
        const rtl = lang !== 'en';
        const bg = tile.surface === 'carousel' ? ctx.ink
            : tile.surface === 'infographic' ? ctx.infographicBg
                : tile.surface === 'explainer' ? '#000000' : null;
        const drawn = BI.logoBox(logo || { width: 1, height: 1 }, tile.logoH, tile.maxW);
        const plate = logo ? BI.plateFor(logo, bg) : null;
        const pad = plate ? Math.round(BI.PLATE_PADDING * drawn.height) : 0;
        const outerW = drawn.width + 2 * pad;
        const outerH = drawn.height + 2 * pad;
        const top = tile.centreY !== undefined ? Math.round(tile.centreY - outerH / 2) : tile.top;
        const start = tile.centre ? null : (rtl ? tile.start.rtl : tile.start.ltr);
        const surface = bg === null ? this.VIDEO : bg;
        const accent = tile.surface === 'carousel' ? ctx.carouselAccent
            : tile.surface === 'infographic' ? ctx.infographicAccent
                : tile.surface === 'explainer' ? ctx.explainerTitle : ctx.reelAccent;
        const darkSurface = BI.tone(surface) === 'dark';
        const model = {
            key: tile.key,
            label: tile.label,
            surfaceKind: tile.surface,
            dir: rtl ? 'rtl' : 'ltr',
            canvasW: tile.w,
            canvasH: tile.h,
            logo: logo !== null,
            // The logo's wordmark shape hides the carousel signature, a narrower one lets the signature follow it.
            wordmark: logo ? BI.isWordmark(logo) : false,
            drawn,
            outerW,
            outerH,
            pad,
            radius: plate ? Math.round(BI.PLATE_RADIUS * outerH) : 0,
            top,
            start,
            centre: tile.centre === true,
            plate: plate ? plate.colour : null,
            // Over a picture or a video the plate always has a soft shadow (contract §5.1: `background === null && plate`).
            shadow: bg === null && plate !== null,
            bg: surface,
            accent,
            bar: darkSurface ? BI.mix(surface, '#FFFFFF', 0.22) : BI.mix(surface, '#000000', 0.18),
            bar2: darkSurface ? BI.mix(surface, '#FFFFFF', 0.10) : BI.mix(surface, '#000000', 0.07),
            sigStart: null,
            sigTop: null,
            contentStart: start === null ? 0 : start,
            below: top + outerH + 22,
            dotLeft: start === null ? 0 : start + outerW + 14,
        };
        if (tile.signature && !model.wordmark) {
            model.sigStart = start + (logo ? outerW + this.SIGNATURE_GAP : 0);
            model.sigTop = Math.round(tile.centreY - 8);
        }
        return model;
    },

    /** The numbers and hex colours a model turns into custom properties: `[[name, value]]`, nothing that is not a finite number or a #RRGGBB. */
    cssVars(model, scale) {
        const out = [];
        const num = (name, v) => { if (typeof v === 'number' && Number.isFinite(v)) out.push([name, String(Math.round(v * 100000) / 100000)]); };
        const hex = (name, v) => { if (typeof v === 'string' && /^#[0-9A-F]{6}$/i.test(v)) out.push([name, v.toUpperCase()]); };
        num('--bp-k', scale);
        num('--bp-cw', this.TILE_WIDTH);
        num('--bp-ch', Math.round((this.TILE_WIDTH * model.canvasH) / model.canvasW));
        num('--bp-lt', model.top);
        if (model.start !== null) num('--bp-ls', model.start);
        num('--bp-lw', model.outerW);
        num('--bp-lh', model.outerH);
        num('--bp-iw', model.drawn.width);
        num('--bp-ih', model.drawn.height);
        num('--bp-lp', model.pad);
        num('--bp-lr', model.radius);
        num('--bp-cs', model.contentStart);
        num('--bp-below', model.below);
        num('--bp-dotl', model.dotLeft);
        if (model.sigStart !== null) { num('--bp-sigs', model.sigStart); num('--bp-sigt', model.sigTop); }
        hex('--bp-bg', model.bg);
        hex('--bp-plate', model.plate);
        hex('--bp-accent', model.accent);
        hex('--bp-bar', model.bar);
        hex('--bp-bar2', model.bar2);
        return out;
    },

    /** The same for a swatch in the logo card: the logo at its own size (scale 1) on a dark or a light page. */
    swatchModel(which, logo) {
        const BI = BrandImage;
        const bg = this.SWATCH[which === 'light' ? 'light' : 'dark'];
        const drawn = BI.logoBox(logo, 64, 220);
        const plate = BI.plateFor(logo, bg);
        const pad = plate ? Math.round(BI.PLATE_PADDING * drawn.height) : 0;
        return { which, bg, drawn, pad, radius: plate ? Math.round(BI.PLATE_RADIUS * (drawn.height + 2 * pad)) : 0, plate: plate ? plate.colour : null };
    },

    swatchVars(model) {
        const out = [];
        const num = (name, v) => { if (typeof v === 'number' && Number.isFinite(v)) out.push([name, String(v)]); };
        const hex = (name, v) => { if (typeof v === 'string' && /^#[0-9A-F]{6}$/i.test(v)) out.push([name, v.toUpperCase()]); };
        num('--bp-k', 1);
        num('--bp-iw', model.drawn.width);
        num('--bp-ih', model.drawn.height);
        num('--bp-lp', model.pad);
        num('--bp-lr', model.radius);
        hex('--bp-bg', model.bg);
        hex('--bp-plate', model.plate);
        return out;
    },

    /** Put the custom properties on the elements `paint` drew. The values were validated by `cssVars`/`swatchVars`; script is the only way they get there. */
    applyVars(root) {
        if (!root || typeof root.querySelectorAll !== 'function' || !this._models) return;
        const scale = this.TILE_WIDTH / 1080;
        root.querySelectorAll('[data-bp-tile]').forEach((el) => {
            const model = this._models.tiles[el.getAttribute('data-bp-tile')];
            if (!model) return;
            this.cssVars(model, scale).forEach(([name, value]) => el.style.setProperty(name, value));
        });
        root.querySelectorAll('[data-bp-swatch]').forEach((el) => {
            const model = this._models.swatches[el.getAttribute('data-bp-swatch')];
            if (!model) return;
            this.swatchVars(model).forEach(([name, value]) => el.style.setProperty(name, value));
        });
    },

    // ─── Painting ────────────────────────────────────────────────────────────
    paint(container) {
        const target = container || document.getElementById('page-container');
        if (!target) return;
        const focus = UI.captureFocus(target);
        this._models = { tiles: Object.create(null), swatches: Object.create(null) };
        target.innerHTML = esc(html`
            <div class="brand-page">
                ${this.canEdit() ? '' : html`<p class="brand-note" id="brand-readonly"><i data-lucide="lock" aria-hidden="true"></i><span>${t('brand.readOnly')}</span></p>`}
                <section class="surface pad-5 brand-card" id="brand-logo-card" aria-labelledby="brand-logo-title">${this.logoCardMarkup()}</section>
                <section class="surface pad-5 brand-card" id="brand-colours-card" aria-labelledby="brand-colours-title">${this.coloursCardMarkup()}</section>
                <section class="surface pad-5 brand-card" id="brand-preview-card" aria-labelledby="brand-preview-title">${this.previewCardMarkup()}</section>
            </div>
        `);
        UI.icons(target);
        this.applyVars(target);
        UI.restoreFocus(focus);
    },

    /** Redraw one card, leaving the others (and the focus in them) alone. */
    repaint(which) {
        const card = document.getElementById(`brand-${which}-card`);
        if (!card) return;
        const focus = UI.captureFocus(card);
        if (!this._models) this._models = { tiles: Object.create(null), swatches: Object.create(null) };
        card.innerHTML = esc(which === 'logo' ? this.logoCardMarkup() : which === 'colours' ? this.coloursCardMarkup() : this.previewCardMarkup());
        UI.icons(card);
        this.applyVars(card);
        UI.restoreFocus(focus);
    },

    errorMarkup(id, message) {
        return html`<div class="brand-error" id="${id}" role="alert">${message ? html`<p>${message}</p>` : ''}</div>`;
    },

    /** One logo, on a swatch page or in a tile: a plate (or none), the picture, never a flip. `url` goes through `safeUrl`. */
    pictureMarkup(url, altText) {
        return html`<img src="${safeUrl(url)}" alt="${altText}" decoding="async">`;
    },

    logoCardMarkup() {
        const edit = this.canEdit();
        const busy = this.busy;
        const working = busy !== '';
        const logo = this.shown();
        const saved = this.savedLogo(this.profile);
        const d = this.draft;
        const accept = '.svg,image/svg+xml,image/png,image/jpeg,image/webp';
        const choose = (label) => (edit
            ? html`<input class="sr-only file-input" id="brand-file" type="file" accept="${accept}" data-change="brand:file"${working ? html.raw(' disabled') : ''}>
                <label class="btn btn-secondary" for="brand-file"><i data-lucide="upload" aria-hidden="true"></i> ${label}</label>`
            : html`<button type="button" class="btn btn-secondary" disabled><i data-lucide="upload" aria-hidden="true"></i> ${label}</button>`);
        const head = html`
            <h2 class="section-title" id="brand-logo-title">${t('brand.logo.title')}</h2>
            <p class="form-hint">${t('brand.logo.lead')}</p>
        `;
        if (busy === 'prepare') {
            return html`${head}<p class="brand-note" role="status"><span class="spinner spinner-sm spinner-inline"></span> ${t('brand.logo.preparing')}</p>${this.errorMarkup('brand-logo-error', this.errors.logo)}`;
        }
        if (!logo && !d) {
            return html`
                ${head}
                <p class="brand-colours-text">${t('brand.logo.none')}</p>
                <div class="brand-choose">${choose(t('brand.logo.choose'))}</div>
                <p class="form-hint">${t('brand.logo.formats')}</p>
                ${this.errorMarkup('brand-logo-error', this.errors.logo)}
            `;
        }
        // Something to show: a draft that cannot be saved still shows its problem, over what was saved (if anything).
        const facts = logo
            ? t('brand.logo.facts', { width: logo.width, height: logo.height, background: t(logo.alpha ? 'brand.logo.transparent' : 'brand.logo.opaque') })
            : '';
        const swatches = logo ? ['dark', 'light'].map((which) => {
            this._models.swatches[which] = this.swatchModel(which, logo);
            return html`
                <figure class="brand-swatch">
                    <div class="bp-swatch-surface" data-bp-swatch="${which}">
                        <span class="bp-logo${this._models.swatches[which].plate ? ' bp-logo--plate' : ''}">${this.pictureMarkup(logo.url, which === 'dark' ? t('brand.logo.alt') : '')}</span>
                    </div>
                    <figcaption>${t(which === 'dark' ? 'brand.logo.onDark' : 'brand.logo.onLight')}</figcaption>
                </figure>`;
        }) : '';
        const showTools = d && edit && (d.stats.flat || d.bgBase);
        const canWhiten = d && edit && d.stats.alpha;
        return html`
            ${head}
            ${swatches ? html`<div class="brand-swatches">${swatches}</div>` : ''}
            ${facts ? html`<p class="brand-facts">${facts}</p>` : ''}
            ${d ? html`<p class="brand-note"><i data-lucide="info" aria-hidden="true"></i><span>${t('brand.logo.unsaved')}</span></p>` : ''}
            ${d && d.stats.flat && !d.bgBase ? html`<p class="form-hint">${t('brand.logo.flat')}</p>` : ''}
            ${showTools || canWhiten || (d && d.history.length > 0) ? html`
                <div class="brand-tools">
                    ${showTools ? html`
                        <button type="button" class="btn btn-secondary btn-sm" data-action="brand:removeBg"${working ? html.raw(' disabled') : ''}><i data-lucide="sparkles" aria-hidden="true"></i> ${t('brand.logo.removeBg')}</button>
                        <div class="brand-tolerance">
                            <label for="brand-tol">${t('brand.logo.tolerance')}</label>
                            <input type="range" id="brand-tol" min="0" max="80" step="1" value="${d.tolerance}" data-change="brand:tolerance"${working ? html.raw(' disabled') : ''}>
                        </div>` : ''}
                    ${canWhiten ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="brand:whiten"${working ? html.raw(' disabled') : ''}>${t('brand.logo.makeWhite')}</button>` : ''}
                    ${d && d.history.length > 0 ? html`<button type="button" class="btn btn-ghost btn-sm" data-action="brand:undo"${working ? html.raw(' disabled') : ''}><i data-lucide="undo-2" aria-hidden="true"></i> ${t('brand.logo.undo')}</button>` : ''}
                </div>` : ''}
            ${this.errorMarkup('brand-logo-error', this.errors.logo)}
            <div class="brand-actions">
                ${d ? UI.button({ variant: 'primary', icon: 'check', label: t('brand.logo.save'), action: 'brand:save', id: 'brand-save', busy: busy === 'save', disabled: !edit || working || !d.png || !!d.problem }) : ''}
                ${choose(t(saved || d ? 'brand.logo.replace' : 'brand.logo.choose'))}
                ${d ? html`<button type="button" class="btn btn-ghost" data-action="brand:cancel"${working ? html.raw(' disabled') : ''}>${t('common.cancel')}</button>` : ''}
                ${saved && !d ? UI.button({ variant: 'ghost', icon: 'trash-2', label: t('brand.logo.remove'), action: 'brand:remove', id: 'brand-remove', busy: busy === 'remove', disabled: !edit || working }) : ''}
            </div>
            <p class="form-hint">${t('brand.logo.formats')}</p>
        `;
    },

    coloursCardMarkup() {
        const edit = this.canEdit();
        const on = this.coloursOn(this.profile);
        const working = this.busy !== '';
        return html`
            <h2 class="section-title" id="brand-colours-title">${t('brand.colours.title')}</h2>
            <div class="switch-row brand-switch">
                <label class="switch" for="brand-colours-switch">
                    <span class="sr-only">${t('brand.colours.switch')}</span>
                    <input type="checkbox" id="brand-colours-switch" data-change="brand:colours" aria-describedby="brand-colours-lead"
                           ${on ? html.raw('checked') : ''} ${edit && !working ? '' : html.raw('disabled')}>
                    <span class="switch-track"></span>
                </label>
                <span class="switch-text"><span class="switch-label">${t('brand.colours.switch')}</span></span>
            </div>
            <p class="brand-colours-text" id="brand-colours-lead">${t('brand.colours.lead')}</p>
            <p class="brand-colours-text">${t('brand.colours.kept')}</p>
            <div class="brand-links">
                <a href="#/infographics">${t('brand.colours.where')}</a>
                <a href="#/studio">${t('brand.studioKit')}</a>
            </div>
            ${this.errorMarkup('brand-colours-error', this.errors.colours)}
            <p class="mbs-4">${UI.helpLink('brand', t('help.link.brand'))}</p>
        `;
    },

    previewCardMarkup() {
        const ctx = this.previewContext();
        const lang = this.previewLang === 'en' ? 'en' : 'ar';
        const tiles = this.TILES.map((tile) => {
            const model = this.tileModel(tile, ctx, lang);
            this._models.tiles[tile.key] = model;
            return this.tileMarkup(tile, model, ctx.logo);
        });
        const choice = (code, label) => html`<button type="button" class="btn btn-ghost btn-sm" data-action="brand:previewLang" data-lang="${code}" aria-pressed="${lang === code ? 'true' : 'false'}">${label}</button>`;
        return html`
            <div class="brand-preview-head">
                <h2 class="section-title" id="brand-preview-title">${t('brand.preview.title')}</h2>
                <div class="segmented brand-lang" role="group" aria-label="${t('brand.preview.language')}">${choice('ar', 'ع')}${choice('en', 'EN')}</div>
            </div>
            <div class="bp-strip">${tiles}</div>
        `;
    },

    tileMarkup(tile, model, logo) {
        const bars = {
            carousel: html`<span class="bp-bar bp-b1"></span><span class="bp-bar bp-b2"></span><span class="bp-bar bp-bar--accent bp-b3"></span><span class="bp-bar bp-bar--faint bp-b4"></span><span class="bp-bar bp-bar--faint bp-b5"></span>`,
            infographic: html`<span class="bp-bar bp-b1"></span><span class="bp-col bp-col1"></span><span class="bp-col bp-col2"></span><span class="bp-col bp-col3"></span><span class="bp-dot"></span><span class="bp-bar bp-bar--faint bp-b2"></span>`,
            explainer: html`<span class="bp-bar bp-b1"></span><span class="bp-pic"></span><span class="bp-bar bp-bar--faint bp-b2"></span><span class="bp-bar bp-bar--faint bp-b3"></span>`,
            reel: html`<span class="bp-bar bp-b1"></span><span class="bp-bar bp-b2"></span><span class="bp-band"></span>`,
        };
        const kinds = { carousel: 'bp-t-carousel', infographic: 'bp-t-infographic', explainer: 'bp-t-explainer', reel: 'bp-t-reel' };
        const kind = kinds[model.surfaceKind] || '';
        const place = model.centre ? 'bp-logo--centre' : 'bp-logo--start';
        const mark = logo
            ? html`<span class="bp-logo ${html.raw(place)}${model.plate ? html.raw(' bp-logo--plate') : ''}${model.shadow ? html.raw(' bp-logo--shadow') : ''}">${this.pictureMarkup(logo.url, '')}</span>`
            : html`<span class="bp-logo ${html.raw(place)} bp-logo--placeholder" aria-hidden="true"><span class="bp-ph"></span></span>`;
        const sig = model.sigStart !== null ? html`<span class="bp-bar bp-bar--faint bp-sig"></span>` : '';
        return html`
            <figure class="bp-tile" aria-label="${t(tile.label)}">
                <div class="bp-canvas ${html.raw(kind)}" dir="${model.dir}" data-bp-tile="${tile.key}">${bars[model.surfaceKind]}${sig}${mark}</div>
                <figcaption>${t(tile.label)}</figcaption>
                ${model.plate ? html`<p class="bp-tile-note">${t('brand.preview.plate')}</p>` : ''}
            </figure>
        `;
    },

    // ─── Errors ──────────────────────────────────────────────────────────────
    /** The sentence for a failure of the logo or the profile, in the interface language. */
    errorText(err) {
        if (err && typeof err.logoCode === 'string') {
            const key = `brand.logo.${err.logoCode}`;
            if (t(key) !== key) return t(key, err.params || {});
        }
        const body = err && err.body && typeof err.body === 'object' ? err.body : {};
        const code = (err && err.code) || body.code || '';
        if (code === 'BRAND_LOGO_UNREADABLE') return t('brand.logoError.unreadable');
        if (code === 'BRAND_LOGO_INVALID') {
            const problems = Array.isArray(body.problems) ? body.problems : [];
            for (const p of problems) {
                const m = /^logo\.([a-z_]+)$/.exec(String(p));
                if (!m) continue;
                const key = `brand.logoError.${m[1]}`;
                if (t(key) !== key) return t(key);
            }
        }
        return (err && err.message) || t('error.unexpected');
    },

    // ─── The draft ───────────────────────────────────────────────────────────
    /** Measure the draft's canvas, check its size, and encode the PNG: everything the card and Save need. */
    refreshDraft() {
        const d = this.draft;
        if (!d) return;
        const BI = BrandImage;
        d.stats = BI.measure(BI.imageOf(d.canvas));
        d.problem = BI.checkSize(d.stats.width, d.stats.height);
        d.png = null;
        if (d.problem) {
            this.errors.logo = t(`brand.logo.${d.problem.code}`, d.problem.params || {});
            return;
        }
        try {
            d.png = BI.toPng(d.canvas);
            this.errors.logo = '';
        } catch (err) {
            d.problem = { code: err.logoCode || 'unreadable' };
            this.errors.logo = this.errorText(err);
        }
    },

    async chooseFile(file) {
        if (!this.canEdit() || this.busy) return;
        this.busy = 'prepare';
        this.errors.logo = '';
        this.repaint('logo');
        try {
            const BI = await this.image();
            if (!BI) throw BrandImage.fail('unreadable');
            const first = BI.inspect(await BI.load(file));
            this.draft = { canvas: first.canvas, history: [], bgBase: null, tolerance: 24, stats: first.stats, problem: null, png: null };
            this.refreshDraft();
        } catch (err) {
            this.errors.logo = this.errorText(err);
        }
        this.busy = '';
        this.repaint('logo');
        this.repaint('preview');
    },

    removeBackground(tolerance) {
        const d = this.draft;
        if (!d || !this.canEdit()) return;
        const BI = BrandImage;
        const base = d.bgBase || d.canvas;
        const tol = Number.isFinite(tolerance) ? Math.min(80, Math.max(0, Math.round(tolerance))) : d.tolerance;
        const out = BI.removeBackground(BI.imageOf(base), tol);
        d.tolerance = tol;
        if (!out) {
            this.errors.logo = t('brand.logo.bgGone');
            return;
        }
        // The first removal is a step the person can undo; moving the slider afterwards redoes it from the same starting picture.
        if (!d.bgBase) { d.history.push(d.canvas); d.bgBase = d.canvas; }
        d.canvas = BI.canvasOf(out);
        this.refreshDraft();
    },

    whiten() {
        const d = this.draft;
        if (!d || !this.canEdit()) return;
        const BI = BrandImage;
        d.history.push(d.canvas);
        d.bgBase = null;
        d.canvas = BI.canvasOf(BI.whiten(BI.imageOf(d.canvas)));
        this.refreshDraft();
    },

    undo() {
        const d = this.draft;
        if (!d || d.history.length === 0) return;
        const previous = d.history.pop();
        if (d.bgBase && previous === d.bgBase) d.bgBase = null;
        d.canvas = previous;
        this.refreshDraft();
    },

    // ─── Saving ──────────────────────────────────────────────────────────────
    /** PATCH the profile; on a version conflict read it again and send the same patch once more. */
    async patchBrand(patch) {
        try {
            return await API.patchProfile(this.version, patch);
        } catch (err) {
            const code = (err && err.code) || (err && err.body && err.body.code) || '';
            if (!(err && err.status === 409 && code === 'PROFILE_VERSION_CONFLICT')) throw err;
            const fresh = await API.getProfile();
            this.profile = fresh.profile;
            this.version = fresh.version === undefined ? null : fresh.version;
            return API.patchProfile(this.version, patch);
        }
    },

    adopt(state) {
        if (state && state.profile && state.profile.brand) {
            this.profile = state.profile;
            this.version = state.version === undefined ? this.version : state.version;
        }
    },

    async save() {
        const d = this.draft;
        if (!this.canEdit() || this.busy || !d || !d.png || d.problem) return;
        this.busy = 'save';
        this.errors.logo = '';
        this.repaint('logo');
        try {
            const up = await API.uploadMedia({ filename: 'logo.png', mime_type: 'image/png', base64_data: d.png.base64 });
            if (!up || typeof up.url !== 'string') throw new Error(t('error.unexpected'));
            const main = { url: up.url, width: d.png.width, height: d.png.height, alpha: d.stats.alpha, tone: d.stats.tone, colour: d.stats.colour };
            this.adopt(await this.patchBrand({ brand: { logos: { main } } }));
            this.draft = null;
            UI.toast(t('brand.logo.saved'), 'success');
        } catch (err) {
            this.errors.logo = this.errorText(err);
        }
        this.busy = '';
        this.repaint('logo');
        this.repaint('preview');
    },

    remove() {
        if (!this.canEdit() || this.busy || !this.savedLogo(this.profile)) return;
        UI.confirm({
            title: t('brand.logo.remove'),
            body: t('brand.logo.removeConfirm'),
            confirmLabel: t('brand.logo.remove'),
            confirmIcon: 'trash-2',
            onConfirm: () => this.doRemove(),
        });
    },

    async doRemove() {
        this.busy = 'remove';
        this.errors.logo = '';
        this.repaint('logo');
        try {
            this.adopt(await this.patchBrand({ brand: { logos: { main: null } } }));
            UI.toast(t('brand.logo.removed'), 'success');
        } catch (err) {
            this.errors.logo = this.errorText(err);
        }
        this.busy = '';
        this.repaint('logo');
        this.repaint('preview');
    },

    async setColours(on, input) {
        if (!this.canEdit() || this.busy) { if (input) input.checked = !on; return; }
        this.busy = 'colours';
        this.errors.colours = '';
        try {
            this.adopt(await this.patchBrand({ brand: { use_brand_colours: on } }));
            UI.toast(t(on ? 'brand.colours.on' : 'brand.colours.off'), 'success');
        } catch (err) {
            if (input) input.checked = !on;
            this.errors.colours = this.errorText(err);
        }
        this.busy = '';
        this.repaint('colours');
        this.repaint('preview');
    },

    setPreviewLang(lang) {
        this.previewLang = lang === 'en' ? 'en' : 'ar';
        this.repaint('preview');
    },
};

UI.registerActions('brand', {
    file: (el) => {
        const file = el && el.files && el.files[0];
        if (!file) return;
        BrandPage.chooseFile(file).catch((err) => console.warn('Brand: the logo could not be prepared:', err))
            .finally(() => { el.value = ''; });
    },
    removeBg: () => { BrandPage.removeBackground(); BrandPage.repaint('logo'); BrandPage.repaint('preview'); },
    tolerance: (el) => { BrandPage.removeBackground(Number(el.value)); BrandPage.repaint('logo'); BrandPage.repaint('preview'); },
    whiten: () => { BrandPage.whiten(); BrandPage.repaint('logo'); BrandPage.repaint('preview'); },
    undo: () => { BrandPage.undo(); BrandPage.repaint('logo'); BrandPage.repaint('preview'); },
    cancel: () => { BrandPage.discardChanges(); BrandPage.errors.logo = ''; BrandPage.repaint('logo'); BrandPage.repaint('preview'); },
    save: () => { BrandPage.save().catch((err) => console.warn('Brand: save failed:', err)); },
    remove: () => BrandPage.remove(),
    colours: (el) => { BrandPage.setColours(!!el.checked, el).catch((err) => console.warn('Brand: the switch failed:', err)); },
    previewLang: (el) => BrandPage.setPreviewLang(el.getAttribute('data-lang')),
});
