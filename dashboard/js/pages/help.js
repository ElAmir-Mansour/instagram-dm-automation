/**
 * Help Center — `#/help`, `#/help/<slug>` and `#/help/<slug>#<section>`.
 *
 * The articles are data (dashboard/js/help-content.js), loaded the first time this page
 * renders. This module is the reader around them: the article list, the search, the article
 * with its table of contents, and a "Was this helpful?" line that is presentational only:
 * there is no backend, and nothing is stored anywhere.
 *
 * ─── Routing ────────────────────────────────────────────────────────────────
 * App.pageFromHash() takes the first segment ("help"); everything after it is read here. A
 * second `#` inside the hash is the section anchor, so `#/help/worker#security` is a
 * shareable link to one section (`#/help/worker/security` is accepted too). App hands hash
 * changes inside this page to `onHashChange()`, which moves the reader without rebuilding
 * the page, so the search box keeps its text and its focus.
 *
 * ─── Layout ─────────────────────────────────────────────────────────────────
 * Mobile first: one column, where the route decides what shows — the list and the search
 * at `#/help`, the article at `#/help/<slug>` with "All articles" to go back. From 1100px the
 * list sits beside the article, on the right in Arabic and on the left in English, because
 * the grid follows the document's direction.
 *
 * ─── Safety ─────────────────────────────────────────────────────────────────
 * The hash is attacker-controllable: a slug or section is used only once it matches
 * [a-z0-9-] AND names a real article or section. Content strings are escaped first and only
 * then given their inline markup (**bold**, `code`, [[links]]), and a link is built only
 * to a slug that exists.
 */
const HelpPage = {
    /** `{ slug, section }` from the hash, validated but not yet resolved. */
    route: { slug: '', section: '' },
    /** The search box's text. Cleared when the page is left. */
    query: '',
    /** slug → 'yes' | 'no', for this visit only: the line is presentational. */
    feedback: Object.create(null),
    _contentPromise: null,
    _index: null,
    _indexLang: '',
    _announce: null,
    _seq: 0,
    /** `history.scrollRestoration` as it was before this page took over scrolling. */
    _restoration: undefined,

    SLUG_RE: /^[a-z0-9-]+$/,
    LINK_RE: /\[\[([a-z0-9-]+)(?:#([a-z0-9-]+))?(?:\|([^\]]+))?\]\]/g,
    CALLOUTS: Object.freeze({ tip: 'lightbulb', note: 'info', warn: 'alert-triangle' }),

    destroy() {
        this._seq++;
        this.query = '';
        if (this._announce && this._announce.cancel) this._announce.cancel();
        this.ownScroll(false);
    },

    /**
     * While this page is open it decides where the reader lands, so the browser's own
     * scroll restoration is switched off: on Back it restored the previous entry's
     * position AFTER the page had scrolled to the section, and the reader landed on the
     * wrong screen. The mode is stored per history entry, which is why it is set as soon
     * as the page renders, and put back when the page is left.
     */
    ownScroll(on) {
        try {
            if (typeof history === 'undefined' || !('scrollRestoration' in history)) return;
            if (on) {
                if (this._restoration === undefined) this._restoration = history.scrollRestoration;
                history.scrollRestoration = 'manual';
            } else if (this._restoration !== undefined) {
                history.scrollRestoration = this._restoration;
                this._restoration = undefined;
            }
        } catch { /* an embedded browser that refuses: the default is only less precise */ }
    },

    skeleton() {
        return html`
            ${Motion.cardGrid(2, 5)}
            ${Motion.busy()}
        `;
    },

    // ─── Content ─────────────────────────────────────────────────────────────
    content() {
        return typeof HelpContent !== 'undefined' ? HelpContent : null;
    },

    /**
     * Load help-content.js once. Resolves true when the articles are there. A failed
     * load is not cached, so Retry fetches again.
     */
    ensureContent() {
        if (this.content()) return Promise.resolve(true);
        if (!this._contentPromise) {
            this._contentPromise = new Promise((done) => {
                const script = document.createElement('script');
                const version = typeof App !== 'undefined' && App.ASSET_VERSION ? App.ASSET_VERSION : '';
                script.src = `/dashboard/js/help-content.js${version ? `?v=${version}` : ''}`;
                script.onload = () => done(!!this.content());
                script.onerror = () => {
                    this._contentPromise = null;
                    done(false);
                };
                document.head.appendChild(script);
            });
        }
        return this._contentPromise;
    },

    lang() {
        return I18N.lang === 'en' ? 'en' : 'ar';
    },

    /** `{ ar, en }` → the active language, falling back to the other one. */
    text(value) {
        if (!value) return '';
        if (typeof value === 'string') return value;
        return value[this.lang()] || value.ar || value.en || '';
    },

    articles() {
        const c = this.content();
        return c && Array.isArray(c.articles) ? c.articles : [];
    },

    groups() {
        const c = this.content();
        return c && Array.isArray(c.groups) ? c.groups : [];
    },

    article(slug) {
        return this.articles().find((a) => a.slug === slug) || null;
    },

    sectionOf(article, id) {
        return (article && id && (article.sections || []).find((s) => s.id === id)) || null;
    },

    body(section) {
        const b = (section && section.body) || {};
        return b[this.lang()] || b.ar || b.en || [];
    },

    // ─── Routing ─────────────────────────────────────────────────────────────
    /**
     * `#/help/worker#security` → `{ slug: 'worker', section: 'security' }`. Anything that is
     * not a plain lowercase slug is dropped here, before it can reach markup or a lookup.
     */
    parseRoute(hash) {
        let raw = String(hash || '').replace(/^#\/?/, '');
        let section = '';
        const anchor = raw.indexOf('#');
        if (anchor !== -1) {
            section = raw.slice(anchor + 1);
            raw = raw.slice(0, anchor);
        }
        const query = raw.indexOf('?');
        if (query !== -1) raw = raw.slice(0, query);
        const parts = raw.split('/').filter(Boolean);
        if (parts[0] !== 'help') return { slug: '', section: '' };
        let slug = parts[1] || '';
        if (!section && parts[2]) section = parts[2];
        try {
            slug = decodeURIComponent(slug).toLowerCase();
            section = decodeURIComponent(section).toLowerCase();
        } catch {
            return { slug: '', section: '' };
        }
        return {
            slug: this.SLUG_RE.test(slug) ? slug : '',
            section: this.SLUG_RE.test(section) ? section : '',
        };
    },

    /** The route against the content: which article and section it really names. */
    resolve(route) {
        const r = route || this.route;
        const article = r.slug ? this.article(r.slug) : null;
        const section = article ? this.sectionOf(article, r.section) : null;
        return { article, section, missing: !!r.slug && !article };
    },

    href(slug, section) {
        return `#/help/${slug}${section ? `#${section}` : ''}`;
    },

    /** The element a route should bring into view: a section, the article, or nothing. */
    routeTarget(route) {
        const { article, section } = this.resolve(route);
        if (section) return `help-s-${section.id}`;
        if (article) return 'help-article-title';
        return '';
    },

    // ─── Inline markup ───────────────────────────────────────────────────────
    /**
     * Escape first, then apply the three pieces of markup the content uses. Code spans
     * are split out before anything else, so nothing inside `…` is read as markup.
     */
    inline(value) {
        const parts = String(value === null || value === undefined ? '' : value).split(/(`[^`]+`)/);
        const out = parts.map((part) => {
            if (/^`[^`]+`$/.test(part)) return `<code dir="ltr">${esc(part.slice(1, -1))}</code>`;
            return esc(part)
                .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                .replace(this.LINK_RE, (match, slug, section, label) => this.linkHtml(slug, section, label));
        });
        return html.raw(out.join(''));
    },

    /** `label` arrives already escaped (it came out of esc()'s output). */
    linkHtml(slug, section, label) {
        const target = this.article(slug);
        const title = target ? esc(this.text(target.title)) : '';
        const text = label || title || esc(slug);
        if (!target) return text;
        const sec = this.sectionOf(target, section) ? section : '';
        return `<a class="help-inline-link" href="${this.href(slug, sec)}">${text}</a>`;
    },

    /** The same string with the markup taken out, for search and snippets. */
    plain(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(this.LINK_RE, (match, slug, section, label) => {
                const target = this.article(slug);
                return label || (target ? this.text(target.title) : slug);
            })
            .replace(/\*\*/g, '')
            .replace(/`/g, '');
    },

    blockText(block) {
        if (typeof block === 'string') return this.plain(block);
        if (!block || typeof block !== 'object') return '';
        if (Array.isArray(block)) return block.map((b) => this.blockText(b)).join(' · ');
        if (Array.isArray(block.ul)) return block.ul.map((i) => this.plain(i)).join(' · ');
        if (Array.isArray(block.ol)) return block.ol.map((i) => this.plain(i)).join(' · ');
        if (typeof block.code === 'string') return `${this.plain(block.caption || '')} ${block.code}`.trim();
        for (const kind of Object.keys(this.CALLOUTS)) {
            if (typeof block[kind] === 'string') return this.plain(block[kind]);
        }
        if (Array.isArray(block.dl)) return block.dl.map(([term, desc]) => `${this.plain(term)}: ${this.plain(desc)}`).join(' · ');
        if (Array.isArray(block.qa)) return block.qa.map(([q, a]) => `${this.plain(q)} ${this.blockText(a)}`).join(' · ');
        return '';
    },

    // ─── Search ──────────────────────────────────────────────────────────────
    /**
     * The dashboard's Arabic normalisation (UI.normalizeArabic, which mirrors the webhook's)
     * with a map from every output character back to its input position, so a match found
     * in normalised text can be highlighted in the text the reader sees.
     */
    normalizeMapped(value) {
        const src = String(value || '');
        let norm = '';
        const map = [];
        let space = true;
        for (let i = 0; i < src.length; i++) {
            let ch = src[i];
            if (/\s/.test(ch)) {
                if (!space) { norm += ' '; map.push(i); space = true; }
                continue;
            }
            if (/[\u0640\u064B-\u0655\u0670]/.test(ch)) continue;
            if (/[أإآ]/.test(ch)) ch = 'ا';
            else if (ch === 'ة') ch = 'ه';
            else if (ch === 'ى') ch = 'ي';
            else ch = ch.toLowerCase();
            for (let k = 0; k < ch.length; k++) { norm += ch[k]; map.push(i); }
            space = false;
        }
        return { norm, map };
    },

    tokens(query) {
        return this.normalizeMapped(query).norm.split(' ').filter(Boolean);
    },

    /** One entry per article head (title + summary) and one per section, for this language. */
    searchIndex() {
        const lang = this.lang();
        if (this._index && this._indexLang === lang) return this._index;
        const entries = [];
        this.articles().forEach((a, order) => {
            const title = this.text(a.title);
            const summary = this.text(a.summary);
            const head = `${title} · ${summary}`;
            entries.push({
                slug: a.slug, order, section: '', sectionTitle: '', title,
                text: summary, titleNorm: this.normalizeMapped(title).norm,
                summaryNorm: this.normalizeMapped(summary).norm, ...this.withNorm(head, summary),
            });
            (a.sections || []).forEach((s) => {
                const sectionTitle = this.text(s.title);
                const bodyText = this.blockText(this.body(s));
                entries.push({
                    slug: a.slug, order, section: s.id, sectionTitle, title,
                    text: bodyText, sectionNorm: this.normalizeMapped(sectionTitle).norm,
                    ...this.withNorm(`${sectionTitle} · ${bodyText}`, bodyText),
                });
            });
        });
        this._index = entries;
        this._indexLang = lang;
        return entries;
    },

    /** `all` is what a match is looked for in; `text` is what a snippet is cut from. */
    withNorm(all, text) {
        const mapped = this.normalizeMapped(text);
        return { allNorm: this.normalizeMapped(all).norm, norm: mapped.norm, map: mapped.map };
    },

    /**
     * Every article that contains ALL the query's words, anywhere in it, best first.
     * Each result links to the section that matches best, or to the article when its
     * title already says it all.
     */
    search(query) {
        const tokens = this.tokens(query);
        if (!tokens.length) return [];
        const index = this.searchIndex();
        const results = [];
        this.articles().forEach((a) => {
            const entries = index.filter((e) => e.slug === a.slug);
            if (!entries.length) return;
            const everything = entries.map((e) => e.allNorm).join(' ');
            if (!tokens.every((tk) => everything.includes(tk))) return;
            const head = entries[0];
            let score = 0;
            tokens.forEach((tk) => {
                if (head.titleNorm.includes(tk)) score += 10;
                if (head.summaryNorm.includes(tk)) score += 4;
            });
            let best = null;
            let bestScore = 0;
            entries.slice(1).forEach((e) => {
                const hits = tokens.filter((tk) => e.allNorm.includes(tk)).length;
                const titled = tokens.filter((tk) => e.sectionNorm.includes(tk)).length;
                const s = hits * 2 + titled * 3;
                if (s > bestScore) { best = e; bestScore = s; }
            });
            score += bestScore;
            const titleSaysAll = tokens.every((tk) => head.titleNorm.includes(tk));
            const use = titleSaysAll || !best ? head : best;
            results.push({
                slug: a.slug,
                order: head.order,
                score,
                title: head.title,
                section: use.section,
                sectionTitle: use.sectionTitle,
                href: this.href(a.slug, use.section),
                snippet: this.snippet(use, tokens),
            });
        });
        return results.sort((x, y) => (y.score - x.score) || (x.order - y.order));
    },

    /** A window of the matching text around the first hit, with every hit marked. */
    snippet(entry, tokens) {
        const text = entry.text || '';
        const { norm, map } = entry;
        let first = -1;
        tokens.forEach((tk) => {
            const at = norm.indexOf(tk);
            if (at !== -1 && (first === -1 || at < first)) first = at;
        });
        const start = first === -1 ? 0 : map[first];
        let from = Math.max(0, start - 50);
        let to = Math.min(text.length, start + 120);
        if (from > 0) {
            const space = text.indexOf(' ', from);
            if (space !== -1 && space < start) from = space + 1;
        }
        if (to < text.length) {
            const space = text.lastIndexOf(' ', to);
            if (space > start) to = space;
        }
        const ranges = [];
        tokens.forEach((tk) => {
            let at = norm.indexOf(tk);
            while (at !== -1) {
                const a = map[at];
                const b = map[at + tk.length - 1] + 1;
                if (a >= from && b <= to) ranges.push([a, b]);
                at = norm.indexOf(tk, at + tk.length);
            }
        });
        ranges.sort((x, y) => x[0] - y[0]);
        const merged = [];
        ranges.forEach((r) => {
            const last = merged[merged.length - 1];
            if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
            else merged.push(r.slice());
        });
        let out = from > 0 ? '…' : '';
        let at = from;
        merged.forEach(([a, b]) => {
            out += esc(text.slice(at, a)) + `<mark class="help-hit">${esc(text.slice(a, b))}</mark>`;
            at = b;
        });
        out += esc(text.slice(at, to)) + (to < text.length ? '…' : '');
        return html.raw(out);
    },

    // ─── Render ──────────────────────────────────────────────────────────────
    async render() {
        const container = document.getElementById('page-container');
        if (!container) return;
        const seq = ++this._seq;
        const gate = Motion.beginLoad(container, () => this.skeleton());
        const ok = await this.ensureContent();
        if (seq !== this._seq || !document.getElementById('page-container')) return;
        gate.done();
        if (!ok) {
            UI.renderError(container, { icon: 'wifi-off', title: t('help.loadFailed'), message: t('error.moduleFailed') }, () => this.render());
            return;
        }
        this.route = this.parseRoute(location.hash);
        this.ownScroll(true);
        container.innerHTML = esc(this.layoutMarkup());
        UI.icons(container);
        this.afterRoute({ initial: true });
    },

    /** App calls this for a hash change inside the page instead of re-rendering it. */
    onHashChange() {
        const previous = this.route.slug;
        this.route = this.parseRoute(location.hash);
        if (!document.getElementById('help-layout')) {
            this.render();
            return;
        }
        if (this.route.slug !== previous) {
            this.paintList();
            this.paintMain();
        }
        this.afterRoute({ initial: false });
    },

    view() {
        return this.resolve().article ? 'article' : 'index';
    },

    layoutMarkup() {
        return html`
            <div class="help-layout" id="help-layout" data-view="${this.view()}">
                <nav class="help-nav" id="help-nav" aria-label="${t('help.nav.label')}">
                    <div class="help-search" role="search">
                        <label class="sr-only" for="help-search">${t('help.search.label')}</label>
                        <div class="input-affix">
                            <i data-lucide="search" aria-hidden="true"></i>
                            <input class="field" type="search" id="help-search" value="${this.query}"
                                   placeholder="${t('help.search.placeholder')}" autocomplete="off" spellcheck="false"
                                   enterkeyhint="search" aria-controls="help-list" data-input="help:search">
                        </div>
                    </div>
                    <div class="help-list-host" id="help-list" tabindex="-1">${this.listMarkup()}</div>
                </nav>
                <div class="help-main" id="help-main">${this.mainMarkup()}</div>
            </div>
        `;
    },

    paintList() {
        const host = document.getElementById('help-list');
        if (!host) return;
        host.innerHTML = esc(this.listMarkup());
        UI.icons(host);
    },

    paintMain() {
        const host = document.getElementById('help-main');
        if (!host) return;
        host.innerHTML = esc(this.mainMarkup());
        UI.icons(host);
    },

    listMarkup() {
        if (this.tokens(this.query).length) return this.resultsMarkup(this.search(this.query));
        const current = this.resolve().article;
        const missing = this.resolve().missing;
        return html`
            ${missing ? html`<p class="help-notice" role="status">${t('help.notFound')}</p>` : ''}
            ${this.groups().map((g) => {
                const list = this.articles().filter((a) => a.group === g.id);
                if (!list.length) return '';
                return html`
                    <section class="help-group" aria-labelledby="help-g-${g.id}">
                        <h2 class="help-group-title" id="help-g-${g.id}">${this.text(g.title)}</h2>
                        <ul class="help-list" role="list">
                            ${list.map((a) => html`
                                <li>
                                    <a class="help-item" href="${this.href(a.slug)}"${current && current.slug === a.slug ? html.raw(' aria-current="page"') : ''}>
                                        <i data-lucide="${a.icon || 'file-text'}" aria-hidden="true"></i>
                                        <span class="help-item-text">
                                            <span class="help-item-title">${this.text(a.title)}</span>
                                            <span class="help-item-summary">${this.text(a.summary)}</span>
                                        </span>
                                    </a>
                                </li>
                            `)}
                        </ul>
                    </section>
                `;
            })}
        `;
    },

    resultsMarkup(results) {
        if (!results.length) {
            const trouble = this.article('troubleshooting');
            const faq = this.article('faq');
            return html`
                <div class="help-empty" role="status">
                    <p class="help-empty-title">${t('help.search.none', { query: this.query.trim() })}</p>
                    <p class="form-hint">${t('help.search.noneHint')}</p>
                    <div class="row row--wrap gap-2">
                        ${UI.button({ variant: 'secondary', size: 'sm', icon: 'x', label: t('help.search.clear'), action: 'help:clearSearch' })}
                        ${trouble ? html`<a class="btn btn-ghost btn-sm" href="${this.href(trouble.slug)}">${this.text(trouble.title)}</a>` : ''}
                        ${faq ? html`<a class="btn btn-ghost btn-sm" href="${this.href(faq.slug)}">${this.text(faq.title)}</a>` : ''}
                    </div>
                </div>
            `;
        }
        return html`
            <p class="help-results-count">${t('help.search.results', { count: results.length })}</p>
            <ul class="help-results" role="list">
                ${results.map((r) => html`
                    <li>
                        <a class="help-result" href="${r.href}">
                            <span class="help-result-title">${r.title}</span>
                            ${r.sectionTitle ? html`<span class="help-result-section">${t('help.search.inSection', { section: r.sectionTitle })}</span>` : ''}
                            <span class="help-result-snippet">${r.snippet}</span>
                        </a>
                    </li>
                `)}
            </ul>
        `;
    },

    mainMarkup() {
        const { article } = this.resolve();
        return article ? this.articleMarkup(article) : this.welcomeMarkup();
    },

    welcomeMarkup() {
        const c = this.content();
        const popular = ((c && c.popular) || []).map((slug) => this.article(slug)).filter(Boolean);
        return html`
            <section class="help-welcome surface" aria-labelledby="help-welcome-title">
                <h2 class="help-article-title" id="help-welcome-title">${t('help.welcome.title')}</h2>
                <p class="help-lede">${t('help.welcome.body')}</p>
                <h3 class="help-subhead">${t('help.welcome.popular')}</h3>
                <ul class="help-cards" role="list">
                    ${popular.map((a) => html`
                        <li>
                            <a class="help-card" href="${this.href(a.slug)}">
                                <i data-lucide="${a.icon || 'file-text'}" aria-hidden="true"></i>
                                <span class="help-card-title">${this.text(a.title)}</span>
                                <span class="help-card-summary">${this.text(a.summary)}</span>
                            </a>
                        </li>
                    `)}
                </ul>
            </section>
        `;
    },

    articleMarkup(article) {
        const sections = article.sections || [];
        const group = this.groups().find((g) => g.id === article.group);
        return html`
            <article class="help-article surface" id="help-article" aria-labelledby="help-article-title">
                <a class="help-back" href="#/help"><i data-lucide="arrow-left" aria-hidden="true"></i> ${t('help.all')}</a>
                <header class="help-article-head">
                    ${group ? html`<p class="help-kicker">${this.text(group.title)}</p>` : ''}
                    <h2 class="help-article-title" id="help-article-title" tabindex="-1">${this.text(article.title)}</h2>
                    <p class="help-lede">${this.text(article.summary)}</p>
                </header>
                ${sections.length > 1 ? html`
                    <nav class="help-toc" aria-labelledby="help-toc-title">
                        <h3 class="help-toc-title" id="help-toc-title">${t('help.toc')}</h3>
                        <ol class="help-toc-list">
                            ${sections.map((s) => html`<li><a href="${this.href(article.slug, s.id)}">${this.text(s.title)}</a></li>`)}
                        </ol>
                    </nav>
                ` : ''}
                ${sections.map((s) => this.sectionMarkup(article, s))}
                ${this.relatedMarkup(article)}
                ${this.feedbackMarkup(article)}
                ${this.nextMarkup(article)}
            </article>
        `;
    },

    sectionMarkup(article, section) {
        const title = this.text(section.title);
        return html`
            <section class="help-section" id="help-s-${section.id}" aria-labelledby="help-h-${section.id}">
                <h3 class="help-section-title" id="help-h-${section.id}" tabindex="-1">
                    <span>${title}</span>
                    <a class="help-anchor" href="${this.href(article.slug, section.id)}"
                       aria-label="${t('help.anchor', { section: title })}" title="${t('help.anchor', { section: title })}"><i data-lucide="link" aria-hidden="true"></i></a>
                </h3>
                ${this.body(section).map((block) => this.blockMarkup(block))}
            </section>
        `;
    },

    blockMarkup(block) {
        if (typeof block === 'string') return html`<p>${this.inline(block)}</p>`;
        if (!block || typeof block !== 'object') return '';
        if (Array.isArray(block)) return block.map((b) => this.blockMarkup(b));
        if (Array.isArray(block.ul)) return html`<ul class="help-ul">${block.ul.map((i) => html`<li>${this.inline(i)}</li>`)}</ul>`;
        if (Array.isArray(block.ol)) return html`<ol class="help-ol">${block.ol.map((i) => html`<li>${this.inline(i)}</li>`)}</ol>`;
        if (typeof block.code === 'string') {
            return html`
                <figure class="help-code">
                    ${block.caption ? html`<figcaption>${this.inline(block.caption)}</figcaption>` : ''}
                    <pre dir="ltr" translate="no"><code>${block.code}</code></pre>
                </figure>
            `;
        }
        for (const kind of Object.keys(this.CALLOUTS)) {
            if (typeof block[kind] !== 'string') continue;
            return html`
                <div class="help-callout help-callout--${kind}">
                    <i data-lucide="${this.CALLOUTS[kind]}" aria-hidden="true"></i>
                    <p><span class="sr-only">${t(`help.callout.${kind}`)} </span>${this.inline(block[kind])}</p>
                </div>
            `;
        }
        if (Array.isArray(block.dl)) {
            return html`
                <dl class="help-dl">
                    ${block.dl.map(([term, desc]) => html`
                        <div class="help-dl-row"><dt>${this.inline(term)}</dt><dd>${this.inline(desc)}</dd></div>
                    `)}
                </dl>
            `;
        }
        if (Array.isArray(block.qa)) {
            return html`
                <div class="help-qa">
                    ${block.qa.map(([question, answer]) => html`
                        <details class="help-qa-item">
                            <summary>${this.inline(question)}</summary>
                            <div class="help-qa-answer">${this.blockMarkup(Array.isArray(answer) ? answer : [answer])}</div>
                        </details>
                    `)}
                </div>
            `;
        }
        return '';
    },

    relatedMarkup(article) {
        const list = (article.related || []).map((slug) => this.article(slug)).filter(Boolean);
        if (!list.length) return '';
        return html`
            <nav class="help-related" aria-labelledby="help-related-title">
                <h3 class="help-subhead" id="help-related-title">${t('help.related')}</h3>
                <ul class="help-related-list" role="list">
                    ${list.map((a) => html`
                        <li><a class="help-related-link" href="${this.href(a.slug)}"><i data-lucide="${a.icon || 'file-text'}" aria-hidden="true"></i><span>${this.text(a.title)}</span></a></li>
                    `)}
                </ul>
            </nav>
        `;
    },

    /** Presentational only: it changes what this screen says, and nothing else. */
    feedbackMarkup(article) {
        const value = this.feedback[article.slug] || '';
        const button = (v, icon, label) => html`
            <button type="button" class="btn btn-secondary btn-sm" data-action="help:feedback" data-value="${v}"
                    data-slug="${article.slug}" aria-pressed="${value === v ? 'true' : 'false'}">
                <i data-lucide="${icon}" aria-hidden="true"></i> ${label}
            </button>
        `;
        return html`
            <div class="help-feedback" role="group" aria-labelledby="help-feedback-q">
                <p class="help-feedback-q" id="help-feedback-q">${t('help.feedback.question')}</p>
                <div class="row row--wrap gap-2">
                    ${button('yes', 'thumbs-up', t('help.feedback.yes'))}
                    ${button('no', 'thumbs-down', t('help.feedback.no'))}
                </div>
                <p class="help-feedback-thanks" id="help-feedback-thanks" role="status">${this.feedbackThanks(value)}</p>
            </div>
        `;
    },

    feedbackThanks(value) {
        if (value === 'yes') return t('help.feedback.thanksYes');
        if (value === 'no') return t('help.feedback.thanksNo');
        return '';
    },

    nextMarkup(article) {
        const list = this.articles();
        const at = list.findIndex((a) => a.slug === article.slug);
        const next = at !== -1 && at < list.length - 1 ? list[at + 1] : null;
        if (!next) return '';
        return html`
            <a class="help-next surface" href="${this.href(next.slug)}">
                <span class="help-next-label">${t('help.next')}</span>
                <span class="help-next-title">${this.text(next.title)}</span>
                <i data-lucide="arrow-right" aria-hidden="true"></i>
            </a>
        `;
    },

    /**
     * After a route lands: set the view, bring the target into view, and put focus on
     * it when the reader moved here from inside the page (a link, Back). The first paint
     * of a deep link only scrolls: stealing focus on page load is not ours to do.
     */
    afterRoute({ initial } = {}) {
        const layout = document.getElementById('help-layout');
        if (layout && typeof layout.setAttribute === 'function') layout.setAttribute('data-view', this.view());
        const { article, section } = this.resolve();
        const targetId = this.routeTarget(this.route);
        /** Kept for the tests and for debugging: where the last route asked to land. */
        this.lastTarget = targetId;
        const scrollTop = () => {
            if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
        };
        const run = () => {
            if (!article) {
                if (initial) return;
                scrollTop();
                const list = document.getElementById('help-list');
                if (list && typeof list.focus === 'function') list.focus({ preventScroll: true });
                return;
            }
            const target = targetId ? document.getElementById(targetId) : null;
            if (section && target && typeof target.scrollIntoView === 'function') {
                target.scrollIntoView({ block: 'start', behavior: Motion.reduced() ? 'auto' : 'smooth' });
                this.openMatches(target);
            } else {
                scrollTop();
            }
            if (!initial) {
                const focusId = section ? `help-h-${section.id}` : 'help-article-title';
                const el = document.getElementById(focusId);
                if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
            }
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else run();
        Motion.announce(article ? this.text(article.title) : t('help.all'));
    },

    /** Arriving from a search: open the answers in this section that contain its words. */
    openMatches(sectionEl) {
        const tokens = this.tokens(this.query);
        if (!tokens.length || !sectionEl || typeof sectionEl.querySelectorAll !== 'function') return;
        sectionEl.querySelectorAll('details').forEach((d) => {
            const norm = this.normalizeMapped(d.textContent || '').norm;
            if (tokens.every((tk) => norm.includes(tk))) d.open = true;
        });
    },

    // ─── Actions ─────────────────────────────────────────────────────────────
    onSearch(el) {
        this.query = String((el && el.value) || '');
        this.paintList();
        if (!this._announce) {
            this._announce = Motion.debounce(() => {
                if (!this.tokens(this.query).length) return;
                Motion.announce(t('help.search.results', { count: this.search(this.query).length }));
            }, 500);
        }
        this._announce();
    },

    clearSearch() {
        this.query = '';
        const input = document.getElementById('help-search');
        if (input) {
            input.value = '';
            if (typeof input.focus === 'function') input.focus();
        }
        this.paintList();
    },

    /** Say thank you, mark the choice, and nothing more: there is no backend for this. */
    setFeedback(el) {
        const slug = el && el.dataset ? el.dataset.slug : '';
        const value = el && el.dataset ? el.dataset.value : '';
        if (!this.article(slug) || (value !== 'yes' && value !== 'no')) return;
        this.feedback[slug] = value;
        const group = el.closest ? el.closest('.help-feedback') : null;
        if (group) {
            group.querySelectorAll('[data-action="help:feedback"]').forEach((b) => {
                b.setAttribute('aria-pressed', b.dataset.value === value ? 'true' : 'false');
            });
        }
        const thanks = document.getElementById('help-feedback-thanks');
        if (thanks) thanks.textContent = this.feedbackThanks(value);
    },
};

UI.registerActions('help', {
    search(el) { HelpPage.onSearch(el); },
    clearSearch() { HelpPage.clearSearch(); },
    feedback(el) { HelpPage.setFeedback(el); },
});
