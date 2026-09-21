/**
 * Shared UI foundation — HTML escaping, toasts, modals, formatting, delegated events.
 *
 * ─── Escaping contract (unchanged, and load-bearing) ─────────────────────────
 * `html` is a tagged template that escapes EVERY interpolated value through the
 * single `esc()` below. `esc()` is correct for element text AND for quoted
 * attribute values (it escapes & < > " ' and backtick), so every attribute in
 * templates built with `html` must be quoted — they all are.
 *
 * Values that are already trusted markup are wrapped in `SafeHtml`:
 *   - anything produced by `html` (so templates compose)
 *   - anything explicitly marked with `html.raw(...)` — only ever used on
 *     literals written in this codebase, never on server data.
 * Arrays are escaped element-wise and joined, so `${rows.map(r => html`...`)}`
 * works directly.
 *
 * IMPORTANT: HTML escaping does NOT make an inline `onclick="f('${value}')"`
 * safe — the HTML parser decodes &#39; back to a quote before the JS is parsed.
 * That is why this dashboard uses `data-action` + delegated handlers
 * (`UI.registerActions`) instead of inline event attributes. Do not reintroduce
 * inline handlers that interpolate data.
 */

class SafeHtml {
    constructor(value) { this.value = value; }
    toString() { return this.value; }
}

const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;',
};

/** Escape a value for element text or a quoted attribute. */
function esc(value) {
    if (value instanceof SafeHtml) return value.value;
    if (value === null || value === undefined || value === false) return '';
    if (Array.isArray(value)) return value.map(esc).join('');
    return String(value).replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}

/** Auto-escaping template tag. Returns SafeHtml so templates nest. */
function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) out += esc(values[i]) + strings[i + 1];
    return new SafeHtml(out);
}

/** Mark a literal written in this codebase as already-safe markup. */
html.raw = (value) => new SafeHtml(value === null || value === undefined ? '' : String(value));

/**
 * Allow-list a URL before putting it in href/src. Escaping alone does not stop
 * `javascript:` — every URL that came from the server goes through this.
 */
function safeUrl(value) {
    if (value === null || value === undefined) return '';
    const url = String(value).trim();
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (/^data:image\/(png|jpe?g|gif|webp|avif);/i.test(url)) return url;
    if (/^\/(?!\/)/.test(url)) return url; // site-relative, never protocol-relative
    return '';
}

const UI = {
    _modalSeq: 0,
    _lastFocus: null,
    _lastFocusKey: null,
    _onModalKeydown: null,
    _actions: Object.create(null),
    _guardBaseline: null,

    // ─── Focus across a re-render ───────────────────────────────────────────
    /**
     * Every page on this dashboard re-renders by writing `container.innerHTML`,
     * which destroys the element the operator was using — focus falls to
     * `<body>` and a keyboard user restarts from the skip link. The Activity
     * Log was the worst case: a filter change rebuilt the whole card, so the
     * `<select>` that fired the change no longer existed.
     *
     * The fix is one pair of calls around the re-render:
     *
     *     const focus = UI.captureFocus(container);
     *     container.innerHTML = esc(...);
     *     UI.restoreFocus(focus);
     *
     * The element is re-found by a STABLE key — its `id`, or `data-focus-key`
     * for things that are rebuilt per row — not by node identity, which the
     * re-render has already thrown away. Text selection and the caret are
     * carried over too, so a half-typed search term survives.
     */
    focusKey(el) {
        if (!el || el === document.body || el.nodeType !== 1) return null;
        if (el.id) return el.id;
        const own = el.dataset ? el.dataset.focusKey : null;
        return own || null;
    },

    /** Find an element by the key `focusKey()` produced. */
    elementByFocusKey(key) {
        if (!key) return null;
        const byId = document.getElementById(key);
        if (byId) return byId;
        try {
            return document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
        } catch {
            return null;
        }
    },

    /**
     * Remember what has focus inside `root`. Returns null when focus is
     * elsewhere, so a re-render triggered by a background poll never steals it.
     */
    captureFocus(root) {
        const active = document.activeElement;
        if (!active || !root || !root.contains(active)) return null;
        const key = UI.focusKey(active);
        if (!key) return null;
        const token = { key, start: null, end: null };
        // Only text-ish controls expose a caret; reading it on others throws.
        try {
            if (typeof active.selectionStart === 'number') {
                token.start = active.selectionStart;
                token.end = active.selectionEnd;
            }
        } catch { /* not a text control */ }
        return token;
    },

    /**
     * Put focus back. `fallbackKey` covers the case where the control the
     * operator used no longer exists at all — paging to the last page disables
     * "Next", deleting the last row removes its own button — and the honest
     * answer is a neighbour rather than `<body>`.
     */
    restoreFocus(token, fallbackKey) {
        const tryFocus = (el) => {
            if (!el || typeof el.focus !== 'function') return false;
            if (el.disabled) return false;
            // A hidden element cannot take focus; focus() would be a silent no-op.
            if (el.offsetParent === null && el !== document.documentElement) return false;
            el.focus({ preventScroll: true });
            return document.activeElement === el;
        };

        if (token && token.key) {
            const el = UI.elementByFocusKey(token.key);
            if (tryFocus(el)) {
                if (token.start !== null) {
                    try { el.setSelectionRange(token.start, token.end); } catch { /* not supported */ }
                }
                return true;
            }
        }

        if (fallbackKey && tryFocus(UI.elementByFocusKey(fallbackKey))) return true;
        if (!token) return false;

        // Last resort: the page region itself, which carries tabindex="-1".
        const main = document.getElementById('page-container');
        if (main && typeof main.focus === 'function') {
            main.focus({ preventScroll: true });
            return true;
        }
        return false;
    },

    // ─── Submit guards ──────────────────────────────────────────────────────
    /**
     * Disable a form's submit button and spin it while the request is out.
     * Returns the restore function. This is the only double-submit guard in the
     * dashboard: without it, Enter twice on a slow serverless cold start
     * created two campaigns, or two posts.
     */
    formBusy(form, label) {
        const btn = form && form.querySelector('button[type="submit"]');
        if (!btn) return () => {};
        if (btn.disabled) return null; // already in flight — caller must bail
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = UI.buttonSpinner(label);
        return () => {
            btn.disabled = false;
            btn.innerHTML = original;
            UI.icons(btn);
        };
    },

    /**
     * Mark a field as failing validation and point it at the message that says
     * why. `aria-invalid` alone is a state with no explanation; the pairing is
     * what makes an error reachable from the field.
     */
    markInvalid(field, describedById) {
        if (!field) return;
        field.setAttribute('aria-invalid', 'true');
        if (describedById) field.setAttribute('aria-describedby', describedById);
        if (typeof field.focus === 'function') field.focus();
    },

    clearInvalid(root) {
        if (!root) return;
        root.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
            el.removeAttribute('aria-invalid');
            // Only the strip's id is removed; a field's own description stays.
            const described = el.getAttribute('aria-describedby') || '';
            const kept = described.split(/\s+/).filter((id) => id && !id.endsWith('-error-strip')).join(' ');
            if (kept) el.setAttribute('aria-describedby', kept);
            else el.removeAttribute('aria-describedby');
        });
    },

    // ─── Bidi ───────────────────────────────────────────────────────────────
    /**
     * An always-Latin value (an ID, a token, a URL, a page id, a numeral pair)
     * inside Arabic copy. Without isolation the trailing punctuation of the
     * Arabic sentence jumps to the wrong end of the number — the classic
     * "(17841459652725922" bug. `<bdi>` isolates; `dir="ltr"` stops the
     * browser guessing from the first strong character.
     */
    ltr(value) {
        return html`<bdi class="ltr-text" dir="ltr">${value}</bdi>`;
    },

    /** A number formatted for the active locale, isolated the same way. */
    num(value) {
        return UI.ltr(UI.formatNumber(value));
    },

    formatNumber(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '—';
        try { return n.toLocaleString(I18N.locale()); } catch { return String(n); }
    },

    /** "72%" — the digits stay Latin and the sign stays attached. */
    formatPercent(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '—';
        return `${UI.formatNumber(n)}%`;
    },

    /**
     * Arabic normalisation, mirroring src/utils/arabic.ts exactly. Used by the
     * campaign keyword inspector so the dashboard's verdict about what a
     * keyword will match is the same verdict the webhook reaches.
     */
    normalizeArabic(text) {
        if (!text) return '';
        return String(text)
            .toLowerCase()
            .replace(/ـ/g, '')
            .replace(/[أإآ]/g, 'ا')
            .replace(/ة/g, 'ه')
            .replace(/[ىي]/g, 'ي')
            // Diacritics: fatha…kasra, shadda/sukun, the combining hamza and
            // maddah marks an NFD-decomposed alef leaves behind, and the
            // superscript alef. Written as escapes because combining marks are
            // invisible in source. Mirrors the class in src/utils/arabic.ts.
            .replace(/[\u064B-\u0650\u0651-\u0655\u0670]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    },

    /**
     * A row status (SENT / FAILED / PENDING / PUBLISHED / …) as a label. The
     * raw value is a database enum, not copy, so it never reached the catalog
     * and stayed English on an Arabic screen. Unknown values fall through
     * untranslated rather than disappearing.
     */
    statusLabel(value) {
        const key = `state.${String(value || '').toLowerCase()}`;
        const label = t(key);
        return label === key ? String(value || '—') : label;
    },

    // ─── Icons ───────────────────────────────────────────────────────────────
    /** lucide is a third-party CDN script: never let it take a page down. */
    icons(node) {
        try {
            if (!window.lucide || typeof lucide.createIcons !== 'function') return;
            lucide.createIcons(node ? { nodes: [node] } : undefined);
        } catch (err) {
            console.warn('Icon rendering failed:', err);
        }
    },

    // ─── Toast ───────────────────────────────────────────────────────────────
    /**
     * A toast used to be a 4500ms window with no way to hold it open, which is
     * fine for "Saved" and useless for the thing this dashboard most often has
     * to say: a Meta error, in full, in a sentence nobody reads in four and a
     * half seconds. So:
     *
     *   - an error gets 9s rather than 4.5s;
     *   - hovering or focusing the toast cancels the countdown and restarts it
     *     on the way out, which is the WCAG 2.2.1 escape hatch for anything
     *     that disappears on a timer;
     *   - there is a close button, so it can also be dismissed early — and its
     *     presence is what makes the toast focusable enough to pause at all.
     */
    toast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const icon = type === 'success' ? 'check-circle' : 'alert-circle';
        const lifetime = type === 'error' ? 9000 : 4500;

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const iconEl = document.createElement('i');
        iconEl.setAttribute('data-lucide', icon);

        const span = document.createElement('span');
        // Server messages and Meta error strings can be either script.
        span.setAttribute('dir', 'auto');
        span.textContent = message === null || message === undefined ? '' : String(message);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'modal-close';
        close.setAttribute('aria-label', t('common.dismiss'));
        const closeIcon = document.createElement('i');
        closeIcon.setAttribute('data-lucide', 'x');
        close.appendChild(closeIcon);

        toast.appendChild(iconEl);
        toast.appendChild(span);
        toast.appendChild(close);
        container.appendChild(toast);
        UI.icons(toast);

        let timer = null;
        const dismiss = () => {
            if (timer) { clearTimeout(timer); timer = null; }
            // A class, so the exit timing lives with the entrance timing in
            // styles.css and collapses with the rest under reduced motion.
            toast.classList.add('is-leaving');
            setTimeout(() => toast.remove(), 320);
        };
        const start = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(dismiss, lifetime);
        };
        const hold = () => { if (timer) { clearTimeout(timer); timer = null; } };

        close.addEventListener('click', dismiss);
        toast.addEventListener('pointerenter', hold);
        toast.addEventListener('pointerleave', start);
        toast.addEventListener('focusin', hold);
        toast.addEventListener('focusout', start);
        start();
    },

    // ─── Modal ───────────────────────────────────────────────────────────────
    showModal(markup) {
        const overlay = document.getElementById('modal-overlay');
        const content = document.getElementById('modal-content');
        if (!overlay || !content) return;

        if (overlay.classList.contains('hidden')) {
            UI._lastFocus = document.activeElement;
            // The node itself is not enough: the trigger is usually a button on
            // a card, and the re-render that follows a successful save destroys
            // it. The key survives the re-render; the node does not.
            UI._lastFocusKey = UI.focusKey(document.activeElement);
        }

        content.innerHTML = esc(markup);
        content.setAttribute('role', 'dialog');
        content.setAttribute('aria-modal', 'true');
        content.setAttribute('tabindex', '-1');

        const title = content.querySelector('.modal-title');
        if (title) {
            if (!title.id) title.id = `modal-title-${++UI._modalSeq}`;
            content.setAttribute('aria-labelledby', title.id);
        } else {
            content.removeAttribute('aria-labelledby');
        }

        overlay.classList.remove('hidden');
        UI.icons(content);
        UI._snapshotGuard(content);

        const focusables = UI._focusables(content);
        const preferred = content.querySelector(
            'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])'
        );
        (preferred || focusables.find((el) => !el.classList.contains('modal-close')) || content).focus();

        // Both of these are the OPERATOR asking to close, so both go through the
        // guarded path that can ask about unsaved work first. `closeModal()`
        // itself stays unguarded: App.navigate calls it inside a view
        // transition, which is no place for a confirm() dialog.
        overlay.onclick = (e) => { if (e.target === overlay) UI.requestCloseModal(); };

        if (UI._onModalKeydown) document.removeEventListener('keydown', UI._onModalKeydown, true);
        UI._onModalKeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                UI.requestCloseModal();
                return;
            }
            if (e.key !== 'Tab') return;
            const items = UI._focusables(content);
            if (items.length === 0) { e.preventDefault(); content.focus(); return; }
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || !content.contains(active))) {
                e.preventDefault(); last.focus();
            } else if (!e.shiftKey && (active === last || !content.contains(active))) {
                e.preventDefault(); first.focus();
            }
        };
        document.addEventListener('keydown', UI._onModalKeydown, true);
    },

    /**
     * Close unconditionally. Focus goes back to whatever opened the modal —
     * and if that element is gone, to the element carrying the same key, and
     * failing that to the page region.
     *
     * ORDER MATTERS at the call sites: a successful save must `render()` FIRST
     * and close AFTER. Closing first restored focus to the trigger button and
     * the re-render then destroyed it, which put focus on a button inside a
     * `display:none` overlay — i.e. on `<body>`.
     */
    closeModal() {
        const overlay = document.getElementById('modal-overlay');
        if (!overlay) return;
        overlay.classList.add('hidden');
        overlay.onclick = null;
        if (UI._onModalKeydown) {
            document.removeEventListener('keydown', UI._onModalKeydown, true);
            UI._onModalKeydown = null;
        }
        UI._guardBaseline = null;
        const restore = UI._lastFocus;
        const key = UI._lastFocusKey;
        UI._lastFocus = null;
        UI._lastFocusKey = null;
        if (restore && document.contains(restore) && typeof restore.focus === 'function'
            && restore.offsetParent !== null) {
            restore.focus();
            return;
        }
        UI.restoreFocus(key ? { key, start: null, end: null } : {}, null);
    },

    // ─── Unsaved-work guard ─────────────────────────────────────────────────
    /**
     * A modal field marked `data-guard-dirty` is one whose contents the
     * operator would be upset to lose — the campaign DM template is the
     * obvious one; it is the product. `showModal` records what those fields
     * started as, and an operator-initiated close compares before throwing the
     * edits away.
     *
     * Deliberately NOT wired into `closeModal()`: navigation closes the modal
     * from inside a view transition, and a synchronous confirm() there would
     * freeze the frame the browser is mid-way through capturing.
     */
    _snapshotGuard(content) {
        const fields = content ? content.querySelectorAll('[data-guard-dirty]') : [];
        if (!fields || fields.length === 0) { UI._guardBaseline = null; return; }
        UI._guardBaseline = new Map();
        fields.forEach((el, i) => {
            const key = el.id || `guard-${i}`;
            UI._guardBaseline.set(key, el.type === 'checkbox' ? String(el.checked) : String(el.value || ''));
        });
    },

    isModalDirty() {
        if (!UI._guardBaseline) return false;
        const content = document.getElementById('modal-content');
        if (!content) return false;
        const fields = content.querySelectorAll('[data-guard-dirty]');
        let dirty = false;
        fields.forEach((el, i) => {
            const key = el.id || `guard-${i}`;
            if (!UI._guardBaseline.has(key)) return;
            const now = el.type === 'checkbox' ? String(el.checked) : String(el.value || '');
            if (now !== UI._guardBaseline.get(key)) dirty = true;
        });
        return dirty;
    },

    /** The operator asked to close. Ask back if there is unsaved work. */
    requestCloseModal() {
        if (UI.isModalDirty() && !confirm(t('common.discardConfirm'))) return;
        UI.closeModal();
    },

    _focusables(root) {
        return Array.from(root.querySelectorAll(
            'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), ' +
            'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter((el) => el.offsetParent !== null || el === document.activeElement);
    },

    // ─── Error panel (every failed fetch gets one, with Retry) ───────────────
    renderError(container, options, onRetry) {
        if (!container) return;
        const {
            title = t('error.pageTitle'),
            message = t('error.unexpected'),
            hint = '',
            icon = 'alert-circle',
        } = options || {};

        container.innerHTML = esc(html`
            <div class="error-panel surface" role="alert">
                <div class="error-panel-icon"><i data-lucide="${icon}" aria-hidden="true"></i></div>
                <h3>${title}</h3>
                <p class="error-panel-message" dir="auto">${message}</p>
                ${hint ? html`<p class="error-panel-hint">${hint}</p>` : ''}
                <button type="button" class="btn btn-secondary btn-sm" data-retry-btn>
                    <i data-lucide="rotate-cw" aria-hidden="true"></i> ${t('common.retry')}
                </button>
            </div>
        `);
        UI.icons(container);

        const btn = container.querySelector('[data-retry-btn]');
        if (!btn) return;
        if (typeof onRetry === 'function') {
            btn.addEventListener('click', () => onRetry());
        } else {
            btn.remove();
        }
    },

    /**
     * Inline (non page-replacing) error strip, e.g. inside a modal.
     * `id` lets a field point at it with `aria-describedby`, which is the only
     * thing that connects "this field is invalid" to "here is why".
     */
    errorStrip(message, hint, id) {
        const stripId = id || `error-strip-${++UI._previewSeq}`;
        return html`
            <div class="inline-error" role="alert" id="${stripId}">
                <i data-lucide="alert-circle" aria-hidden="true"></i>
                <div>
                    <strong dir="auto">${message}</strong>
                    ${hint ? html`<span class="inline-error-hint">${hint}</span>` : ''}
                </div>
            </div>
        `;
    },

    // ─── Clipped content ────────────────────────────────────────────────────
    /**
     * `.template-preview` clips a DM template at 7.5em with no fade, no
     * scrollbar and no way in from the keyboard — so the operator cannot read
     * the rest of the message they are about to send to a customer. Rather
     * than a CSS-only affordance nobody can reach, the block gets a disclosure
     * that opens the full text in the modal (which already has a focus trap,
     * Escape, and focus restore).
     *
     * The button is rendered hidden and only revealed for blocks that are
     * ACTUALLY clipped — which is measured after paint by `revealClipped()`,
     * because character counts are not a reliable proxy for 7.5em of a
     * proportional Arabic face.
     */
    previewBlock(text, options) {
        const { label = '', arabic = false } = options || {};
        const id = `preview-${++UI._previewSeq}`;
        const value = text === null || text === undefined ? '' : String(text);
        return html`
            <div class="template-preview user-content" id="${id}" dir="auto"
                 ${arabic ? html.raw('lang="ar"') : ''}
                 data-preview-label="${label}">${value}</div>
            <button type="button" class="btn btn-secondary btn-sm hidden"
                    data-action="ui:showFullText" data-preview="${id}" data-clip-disclosure>
                <i data-lucide="chevrons-down-up" aria-hidden="true"></i> ${t('common.showFull')}
            </button>
        `;
    },

    _previewSeq: 0,

    /**
     * Post-paint measurement pass.
     *
     *   - a `.template-preview` taller than its box gets its disclosure button;
     *   - an element marked `data-clip-focus` whose text is cut off
     *     horizontally becomes focusable, so the full string — which IS in the
     *     DOM, just painted outside the box — is reachable without a `title`
     *     tooltip a keyboard user can never open.
     *
     * Only genuinely clipped elements are touched, so a log page with no
     * errors gains no extra tab stops.
     */
    revealClipped(root) {
        if (!root) return;
        root.querySelectorAll('[data-clip-disclosure]').forEach((btn) => {
            const target = document.getElementById(btn.dataset.preview || '');
            if (!target) return;
            const clipped = target.scrollHeight - target.clientHeight > 1;
            btn.classList.toggle('hidden', !clipped);
        });
        root.querySelectorAll('[data-clip-focus]').forEach((el) => {
            const clipped = el.scrollWidth - el.clientWidth > 1;
            if (clipped) {
                el.setAttribute('tabindex', '0');
            } else {
                el.removeAttribute('tabindex');
            }
        });
    },

    /**
     * A sender username comes straight off Meta — it is the exact field an
     * attacker controls by renaming their profile, so it is escaped as text and
     * percent-encoded before it goes anywhere near a URL. It is also a Latin
     * handle inside Arabic copy, hence the bdi isolation.
     */
    userCell(interaction) {
        const username = interaction.sender_username || '';
        const isFacebook = interaction.platform === 'facebook';
        const badge = isFacebook
            ? html`<span class="platform-tag fb">FB</span>`
            : html`<span class="platform-tag ig">IG</span>`;
        const handle = html`<bdi class="ltr-text" dir="ltr">@${username || '—'}</bdi>`;
        if (isFacebook || !username) {
            return html`<span class="username-link">${handle}</span>${badge}`;
        }
        return html`<a href="https://instagram.com/${html.raw(encodeURIComponent(username))}"
                       target="_blank" rel="noopener noreferrer"
                       class="username-link">${handle}</a>${badge}`;
    },

    // ─── Dates ───────────────────────────────────────────────────────────────
    /**
     * Every date goes through the active locale. For Arabic that is
     * `ar-u-nu-latn-ca-gregory`: Arabic month names, Latin numerals, Gregorian
     * calendar — a plain `ar` locale would render ٠٥ ذو الحجة and be wrong for
     * a business dashboard. Times are 24-hour, which removes the ص/م ambiguity
     * in a log column.
     */
    /**
     * Formatters are cached per locale+options.
     *
     * `Date.prototype.toLocaleString(locale, options)` constructs a fresh
     * `Intl.DateTimeFormat` on every call, and constructing one is by far the
     * expensive part. The activity log renders 15 rows with a date each, the
     * tenants table renders a relative age per row, and the post scheduler
     * formats a timestamp on every keystroke — all of which used to build a
     * formatter from scratch each time.
     */
    _fmtCache: new Map(),

    _formatter(options) {
        const key = `${I18N.locale()}|${JSON.stringify(options)}`;
        let fmt = UI._fmtCache.get(key);
        if (fmt === undefined) {
            try {
                fmt = new Intl.DateTimeFormat(I18N.locale(), options);
            } catch {
                fmt = null; // caller falls back to an ISO slice
            }
            UI._fmtCache.set(key, fmt);
        }
        return fmt;
    },

    _fmt(iso, options) {
        const d = UI._date(iso);
        if (!d) return '—';
        const fmt = UI._formatter(options);
        if (fmt) {
            try { return fmt.format(d); } catch { /* fall through */ }
        }
        return d.toISOString().slice(0, 16).replace('T', ' ');
    },

    /** "٤ مارس، 09:30" / "Mar 4, 09:30" */
    formatDate(iso) {
        return UI._fmt(iso, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    },

    /** Full stamp for scheduled posts. */
    formatDateTime(iso) {
        return UI._fmt(iso, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false,
        });
    },

    formatDay(iso) {
        return UI._fmt(iso, { year: 'numeric', month: 'short', day: 'numeric' });
    },

    /** Short axis label for charts. */
    formatDayShort(iso) {
        return UI._fmt(iso, { month: 'short', day: 'numeric' });
    },

    formatTime(iso) {
        const d = UI._date(iso);
        if (!d) return '';
        return UI._fmt(iso, { hour: '2-digit', minute: '2-digit', hour12: false });
    },

    /** "الجمعة ٤ مارس" — for the briefing header. */
    formatWeekday(iso) {
        return UI._fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' });
    },

    /**
     * "3d ago" plus a severity, for the columns where the operator has to see
     * that something is broken without doing date arithmetic in their head.
     * Returns { text, level: 'fresh' | 'warn' | 'stale', title }.
     */
    relativeAge(value, options) {
        const { warnMs = 6 * 60 * 60 * 1000, staleMs = 24 * 60 * 60 * 1000, neverText = t('common.never') } = options || {};
        const d = UI._date(value);
        if (!d) return { text: neverText, level: 'stale', title: t('common.nothingRecorded') };

        const diff = Date.now() - d.getTime();
        const abs = Math.abs(diff);
        const minute = 60000;
        const hour = 60 * minute;
        const day = 24 * hour;

        let unit;
        if (abs < minute) {
            return {
                text: t('common.justNow'),
                level: diff < 0 ? 'warn' : 'fresh',
                title: UI.formatDateTime(d),
            };
        }
        if (abs < hour) unit = t('common.minutes', { n: UI.formatNumber(Math.floor(abs / minute)) });
        else if (abs < day) unit = t('common.hours', { n: UI.formatNumber(Math.floor(abs / hour)) });
        else unit = t('common.days', { n: UI.formatNumber(Math.floor(abs / day)) });

        const text = diff < 0 ? t('common.inFuture', { value: unit }) : t('common.ago', { value: unit });

        // A future timestamp is a clock problem, not freshness — never green.
        const level = diff < 0 ? 'warn' : diff >= staleMs ? 'stale' : diff >= warnMs ? 'warn' : 'fresh';
        return { text, level, title: UI.formatDateTime(d) };
    },

    _date(iso) {
        if (!iso) return null;
        const d = iso instanceof Date ? iso : new Date(iso);
        return Number.isNaN(d.getTime()) ? null : d;
    },

    /**
     * Value for <input type="datetime-local">, which shows and submits LOCAL
     * wall time. `toISOString()` is UTC, so using it here shifts the field by
     * the whole UTC offset — for a UTC+3 creator, 3 hours earlier every render.
     */
    toLocalInputValue(value) {
        const d = UI._date(value);
        if (!d) return '';
        return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    },

    /** Parse a datetime-local value (local wall time) back to a UTC ISO string. */
    fromLocalInputValue(value) {
        if (!value) return null;
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    },

    /**
     * The next time the Vercel cron actually runs: 00:00 UTC, daily. Anything
     * scheduled before that instant publishes then, not at the minute the
     * operator picked. The scheduler UI shows this instead of pretending.
     */
    nextCronRun(fromIso) {
        const from = UI._date(fromIso) || new Date();
        const next = new Date(Date.UTC(
            from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 0, 0, 0, 0
        ));
        if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
        return next;
    },

    // ─── Misc ────────────────────────────────────────────────────────────────
    /**
     * Count up to `target`.
     *
     * `.stat-value` is `tabular-nums`, so every intermediate value occupies the
     * same width as the final one and the tile does not resize under its own
     * number as it tweens. Zero is written directly: a tween from 0 to 0 is a
     * frame budget spent on nothing.
     */
    animateCounter(el, target, duration = 900) {
        if (!el) return;
        const value = Number(target) || 0;
        const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced || value === 0) { el.textContent = UI.formatNumber(value); return; }
        let start = 0;
        const step = (timestamp) => {
            if (!start) start = timestamp;
            const progress = Math.min((timestamp - start) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = UI.formatNumber(Math.floor(eased * value));
            if (progress < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    },

    loader(label) {
        const text = label || t('common.loading');
        return esc(html`<div class="loader" role="status" aria-live="polite">
            <div class="spinner"></div><span class="sr-only">${text}</span>
        </div>`);
    },

    /** Small inline spinner used inside a button while it works. */
    buttonSpinner(label) {
        return esc(html`<span class="spinner spinner-sm spinner-inline"></span><span>${label || ''}</span>`);
    },

    // ─── Delegated events (replaces inline on* attributes) ───────────────────
    /**
     * Register handlers for a namespace. Markup then uses:
     *   data-action="ns:method"        (click)
     *   data-change="ns:method"        (change)
     *   data-submit="ns:method"        (submit)
     *   data-input="ns:method"         (input)
     * Handlers are called as fn(element, event).
     */
    registerActions(namespace, handlers) {
        UI._actions[namespace] = Object.assign(UI._actions[namespace] || {}, handlers);
    },

    _dispatch(event, attribute) {
        const el = event.target && event.target.closest
            ? event.target.closest(`[${attribute}]`)
            : null;
        if (!el) return;
        const key = el.getAttribute(attribute);
        if (!key) return;
        const [namespace, method] = key.split(':');
        const handler = UI._actions[namespace] && UI._actions[namespace][method];
        if (typeof handler !== 'function') {
            console.warn(`No handler registered for "${key}"`);
            return;
        }
        try {
            handler(el, event);
        } catch (err) {
            console.error(`Handler "${key}" failed:`, err);
            UI.toast(err && err.message ? err.message : t('common.error'), 'error');
        }
    },
};

UI.registerActions('ui', {
    /**
     * Every Cancel and every × in the dashboard points here, so the
     * unsaved-work question is asked once, in one place, for all of them.
     */
    closeModal: () => UI.requestCloseModal(),

    /**
     * Open a clipped preview in full. The text is read out of the DOM rather
     * than carried on the button, so nothing operator- or Meta-supplied ever
     * makes a second trip through an attribute.
     */
    showFullText: (el) => {
        const source = document.getElementById(el.dataset.preview || '');
        if (!source) return;
        const label = source.dataset.previewLabel || t('common.showFull');
        const isArabic = source.getAttribute('lang') === 'ar';
        UI.showModal(html`
            <div class="modal-header">
                <h2 class="modal-title">${label}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal"
                        aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <!-- .modal-content is the scroll container (overflow-y: auto) and
                 focus sits inside it on the Close button, so a long template
                 scrolls with the keyboard without a second scroller or an
                 extra tab stop here. -->
            <div class="user-content" dir="auto" ${isArabic ? html.raw('lang="ar"') : ''}>${source.textContent}</div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.close')}</button>
            </div>
        `);
    },
});

// One set of delegated listeners for the whole dashboard.
document.addEventListener('click', (e) => UI._dispatch(e, 'data-action'));
document.addEventListener('change', (e) => UI._dispatch(e, 'data-change'));
document.addEventListener('input', (e) => UI._dispatch(e, 'data-input'));
document.addEventListener('submit', (e) => UI._dispatch(e, 'data-submit'));

// ─── Backwards-compat alias ──────────────────────────────────────────────────
const Components = {
    showToast: (msg, type = 'success') => UI.toast(msg, type),
};
