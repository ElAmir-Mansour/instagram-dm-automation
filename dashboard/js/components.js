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

/**
 * The button vocabulary `UI.button()` may spell, as LOOKUP TABLES rather than
 * string interpolation. `btn-${variant}` would put whatever the caller passed
 * inside a `class` attribute; a table can only ever yield a class this
 * stylesheet actually defines.
 *
 * Null-prototype on purpose: a plain `{}` answers `'constructor'` with a
 * function, so `TABLE[o.variant] || fallback` on an object literal happily
 * writes `class="btn function Object() { [native code] }"` for a variant read
 * off a server payload. The prototype is the whole gap, so it is removed.
 */
const BUTTON_VARIANTS = Object.assign(Object.create(null), {
    primary: 'btn-primary',
    secondary: 'btn-secondary',
    danger: 'btn-danger',
    ghost: 'btn-ghost',
});
const BUTTON_SIZES = Object.assign(Object.create(null), { sm: 'btn-sm', md: '' });
const BUTTON_TYPES = Object.assign(Object.create(null), {
    button: 'button', submit: 'submit', reset: 'reset',
});
/** `data-*` names only: lowercase, digits and hyphens, starting with a letter. */
const DATA_KEY = /^[a-z][a-z0-9-]*$/;

const UI = {
    _modalSeq: 0,
    _lastFocus: null,
    _lastFocusKey: null,
    _onModalKeydown: null,
    /** Called once when the open modal is closed or replaced (`ProfileAsk` resolves "not answered" from it). Cleared when it runs. */
    _afterClose: null,
    _actions: Object.create(null),
    _guardBaseline: null,

    // ─── The brand mark ─────────────────────────────────────────────────────
    /**
     * Kufi «رد» (DESIGN.md section 4): the master geometry, which lands every edge on a whole pixel at 32 and 64. The tile and the glyph are
     * `.mark-tile` and `.mark-glyph`, painted from --mark-tile and --mark-glyph, so the mark follows the theme (Cardamom in dark, Ink in light).
     * Put it inside `.logo-mark` or `.login-mark`, which size it. The same markup is in index.html for the login and the sidebar, which are
     * painted before any script runs; scripts/build-brand-icons.test.mjs reads them all against the kit's file.
     */
    brandMark() {
        return html.raw('<svg viewBox="0 0 256 256" aria-hidden="true" focusable="false"><rect class="mark-tile" width="256" height="256" rx="64"/><path class="mark-glyph" d="M72 56H136V152H40V120H104V88H72ZM168 56H200V178.51L158.51 220H113.25L168 165.25Z"/></svg>');
    },

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
     * `formBusy` for a button that is not a form submit.
     *
     * Every async `data-action` handler in this dashboard had to hand-roll this,
     * and about nine of them simply did not: `await API.something()` straight
     * from the click, with nothing disabled in between. On a Vercel cold start
     * that window is seconds long and the button looks completely idle, so the
     * operator clicks it again and two requests go out. `revokeMembership` and
     * `revokeSessions` in users.js were the clearest cases.
     *
     * The contract is `formBusy`'s, deliberately, so the two are interchangeable
     * in a reader's head:
     *
     *   - no element        -> a no-op restore, so callers never branch on null
     *                          for "there was nothing to disable"
     *   - already in flight -> **null**, and the caller MUST bail. This is the
     *                          double-click guard; returning a restore here
     *                          would let the second click through.
     *   - otherwise         -> restore(), which puts the label, the icons and
     *                          the width back exactly as they were.
     *
     * ── The label, and the width ──
     * Called with no label, the button keeps its own text for assistive
     * technology but hides it visually and shows just a spinner, and its width
     * is pinned to what it was. Both halves of that are needed and each fixes a
     * different thing: a spinner on its own leaves the button with NO accessible
     * name, and a spinner beside the label makes the button ~24px wider, which
     * shoves the rest of the row sideways at the exact moment the operator is
     * watching it. The measured `min-inline-size` cannot stop that on its own —
     * a minimum only prevents shrinking.
     *
     * Pass an explicit string (`t('common.saving')`) when the verb itself should
     * change; that behaves exactly like `formBusy` and shows the text, so a
     * longer verb may widen the button. Pass `''` for a bare spinner on an
     * icon-only control that carries its name in `aria-label`.
     */
    actionBusy(el, label) {
        if (!el) return () => {};
        // `disabled` covers the caller that disabled it for its own reasons;
        // `aria-busy` covers a second call landing on a button this already owns.
        if (el.disabled || (el.getAttribute && el.getAttribute('aria-busy') === 'true')) return null;

        const original = el.innerHTML;
        const originalLabel = (el.textContent || '').trim();
        const style = el.style || {};
        const previousMinInline = style.minInlineSize || '';
        try {
            const width = el.offsetWidth;
            if (width > 0) style.minInlineSize = `${width}px`;
        } catch { /* no layout engine here; the width simply is not pinned */ }

        el.disabled = true;
        if (el.setAttribute) el.setAttribute('aria-busy', 'true');
        const ownLabel = label === undefined;
        el.innerHTML = UI.buttonSpinner(ownLabel ? originalLabel : label, ownLabel);

        return () => {
            el.disabled = false;
            if (el.removeAttribute) el.removeAttribute('aria-busy');
            style.minInlineSize = previousMinInline;
            el.innerHTML = original;
            UI.icons(el);
        };
    },

    /**
     * The one place a button's markup is built.
     *
     * There are 88 `class="btn btn-…"` strings hand-written across 17 distinct
     * variant spellings in this dashboard, which is how `.btn-danger` ended up
     * on things that delete nothing and how an icon-only button ended up
     * without an `aria-label`. This is the seam: a call here cannot spell a
     * variant that has no CSS, cannot forget `type="button"` (which submits the
     * enclosing form), and cannot interpolate a value into markup unescaped.
     *
     *   UI.button({ variant: 'danger', icon: 'trash-2', label: t('common.delete'),
     *               action: 'campaigns:confirmDelete', data: { id: c.id } })
     *
     * | option     | what it does                                               |
     * |------------|------------------------------------------------------------|
     * | variant    | 'primary' | 'secondary' | 'danger' | 'ghost' (default 2nd) |
     * | size       | 'sm' for the compact row button; omit for the default      |
     * | label      | the visible text — a VERB, per DESIGN.md                   |
     * | icon       | a lucide name, rendered as `<i data-lucide>` before the label |
     * | action     | the `data-action="ns:method"` this dispatches on click      |
     * | busy       | renders the in-flight state: spinner, `aria-busy`, disabled |
     * | disabled   | the `disabled` attribute                                   |
     * | full       | `.btn-full` — the full-width form button                   |
     * | type       | 'button' (default), 'submit' or 'reset'                     |
     * | data       | extra `data-*` attributes, `{ id: 3 }` -> `data-id="3"`    |
     * | ariaLabel  | the accessible name when there is no visible label          |
     * | focusKey   | `data-focus-key`, so focus survives the next re-render      |
     * | id, title, className — as named                                         |
     *
     * ── Escaping ──
     * `variant`, `size` and `type` are looked up in the tables above rather than
     * interpolated, so they can only ever be a class this stylesheet defines —
     * a value arriving from the server cannot become `class="btn btn-x" onload=…`
     * no matter what it says. Everything else goes through `html`, which escapes
     * it. `html.raw` appears only on the bare boolean attributes, which are
     * literals written here.
     *
     * @returns {SafeHtml}
     */
    button(options) {
        const o = options || {};
        const variantClass = BUTTON_VARIANTS[o.variant] !== undefined
            ? BUTTON_VARIANTS[o.variant]
            : BUTTON_VARIANTS.secondary;
        const sizeClass = BUTTON_SIZES[o.size] || '';
        const type = BUTTON_TYPES[o.type] || BUTTON_TYPES.button;

        const classes = ['btn', variantClass, sizeClass, o.full ? 'btn-full' : '', o.className || '']
            .filter(Boolean).join(' ');

        // A busy button is disabled too. The CSS says busy implies
        // non-interactive; the markup has to agree, or a keyboard user can
        // still fire the action the spinner says is already running.
        const busy = !!o.busy;
        const disabled = busy || !!o.disabled;

        const data = o.data && typeof o.data === 'object' ? o.data : {};
        const dataAttrs = Object.keys(data)
            .filter((key) => {
                if (data[key] === undefined || data[key] === null) return false;
                if (DATA_KEY.test(key)) return true;
                // Loud, because a silently dropped `data-id` breaks the handler
                // somewhere else entirely. `focusKey` is the usual mistake: the
                // attribute is `data-focus-key`, so the key is too.
                console.warn(`UI.button: ignoring data key "${key}" — data-* names are lowercase and hyphenated.`);
                return false;
            })
            .map((key) => html` data-${html.raw(key)}="${data[key]}"`);

        // Every entry carries its own leading space and an omitted one is '',
        // which `esc()` drops when it walks the array — so the tag comes out with
        // exactly the attributes that were asked for and no blank filler between
        // them. An interpolated `''` would otherwise leave the template's own
        // newlines and indentation inside the tag.
        const attrs = [
            html` type="${type}"`,
            html` class="${classes}"`,
            o.id ? html` id="${o.id}"` : '',
            o.action ? html` data-action="${o.action}"` : '',
            o.focusKey ? html` data-focus-key="${o.focusKey}"` : '',
            o.ariaLabel ? html` aria-label="${o.ariaLabel}"` : '',
            o.title ? html` title="${o.title}"` : '',
            busy ? html.raw(' aria-busy="true"') : '',
            disabled ? html.raw(' disabled') : '',
            ...dataAttrs,
        ];

        let body;
        if (busy) body = html.raw(UI.buttonSpinner(o.label));
        else if (o.icon && o.label) body = html`<i data-lucide="${o.icon}" aria-hidden="true"></i> ${o.label}`;
        else if (o.icon) body = html`<i data-lucide="${o.icon}" aria-hidden="true"></i>`;
        else body = html`${o.label}`;

        return html`<button${attrs}>${body}</button>`;
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

    // ─── In-app browsers ────────────────────────────────────────────────────
    /**
     * Which app's built-in browser is this page open in? '' when none (or when it cannot tell).
     *
     * A link tapped inside Instagram, Facebook or WhatsApp opens in that app's own web view, not in Safari or Chrome. Google
     * refuses its sign-in there (`disallowed_useragent`), which would break connecting YouTube later in the setup, and
     * a session kept in a web view is not the one the person's browser holds. So the invite page and the wizard say so,
     * once, and offer the way out (`inAppHint`). Detection is the user agent's own word for it, and nothing else: a
     * web view that does not say is not detected, and nothing breaks for it.
     */
    inAppBrowser(userAgent) {
        let ua = userAgent;
        if (ua === undefined) {
            try { ua = navigator.userAgent; } catch { ua = ''; }
        }
        ua = String(ua || '');
        if (/Instagram/i.test(ua)) return 'instagram';
        if (/FBAN|FBAV|FB_IAB|FBIOS/.test(ua)) return 'facebook';
        if (/WhatsApp/i.test(ua)) return 'whatsapp';
        return '';
    },

    /** The one-line note for a person in an app's web view: what is wrong with it and how to leave. '' for none, or once dismissed. */
    inAppHint(app) {
        if (app !== 'instagram' && app !== 'facebook' && app !== 'whatsapp') return '';
        let dismissed = false;
        try { dismissed = sessionStorage.getItem('inapp_hint_dismissed') === '1'; } catch { dismissed = false; }
        if (dismissed) return '';
        return html`
            <div class="inapp-hint" role="note" data-inapp-hint>
                <i data-lucide="external-link" aria-hidden="true"></i>
                <p class="inapp-hint-text">
                    <strong>${t('inapp.title', { app: t(`inapp.app.${app}`) })}</strong>
                    ${' '}${t('inapp.body')}
                </p>
                <button type="button" class="icon-btn inapp-hint-close" data-action="ui:dismissInAppHint"
                        aria-label="${t('common.close')}" title="${t('common.close')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
        `;
    },

    // ─── Contextual help ────────────────────────────────────────────────────
    /**
     * A small link into the Help Center, next to the control it explains.
     *
     * `target` is `'slug'` or `'slug#section'`, written as a literal at every
     * call site so `src/dashboard/help.test.ts` can find each one and check
     * that the article and the section exist. Anything else renders nothing:
     * a help link to nowhere is worse than no link.
     *
     * `label` is the visible text (an i18n string naming the topic, so two
     * links on one screen never share the name "Learn more").
     *   - `iconOnly`: a "?" beside a status pill, named by `label`.
     *   - `newTab`: for links inside a modal or an unsaved form, where leaving
     *     the page would drop what the operator typed. The session token is in
     *     localStorage, so the new tab opens signed in.
     */
    helpLink(target, label, opts) {
        const o = opts || {};
        const m = /^([a-z0-9-]+)(?:#([a-z0-9-]+))?$/.exec(String(target || ''));
        if (!m) return '';
        const href = `#/help/${m[1]}${m[2] ? `#${m[2]}` : ''}`;
        const text = label || t('help.link.learnMore');
        const name = o.newTab ? `${text} ${t('help.link.newTab')}` : text;
        const cls = `help-link${o.iconOnly ? ' help-link--icon' : ''}${o.className ? ` ${o.className}` : ''}`;
        return html`<a class="${cls}" href="${href}"${o.newTab ? html.raw(' target="_blank" rel="noopener"') : ''}${o.iconOnly ? html` aria-label="${name}" title="${text}"` : ''}><i data-lucide="circle-help" aria-hidden="true"></i>${o.iconOnly ? '' : html`<span>${text}</span>`}${o.newTab && !o.iconOnly ? html`<span class="sr-only"> ${t('help.link.newTab')}</span>` : ''}</a>`;
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

    // ─── Held posts (CP12) ──────────────────────────────────────────────────
    /**
     * Why a PENDING scheduled post is held rather than simply waiting for its
     * time, or null. Both holds are written by the publisher and released by
     * the next sweep (CLAUDE.md, "Publishing and DM safety"):
     *
     *   'ig_processing' — Instagram was still processing the reel when the
     *     poll budget ran out; the container is kept as
     *     `external_publish_id = 'IGC:<id>'` (IG_CONTAINER_PREFIX, src/routes/api.ts).
     *   'tiktok_limit' — TikTok's five pending inbox shares; the row is back at
     *     PENDING with TikTokInboxFullError's message, which starts
     *     "Waiting for TikTok:" (src/services/tiktokPublish.ts).
     *
     * A PENDING row with any other note is NOT held: a FAILED row edited back
     * to PENDING keeps its old error, and goes out at its time like any other.
     */
    HELD_IG_PREFIX: 'IGC:',
    HELD_TIKTOK_PREFIX: 'Waiting for TikTok:',

    heldReason(post) {
        if (!post || post.status !== 'PENDING') return null;
        const container = post.external_publish_id;
        if (typeof container === 'string' && container.startsWith(UI.HELD_IG_PREFIX)) return 'ig_processing';
        const note = post.error_log;
        if (post.platform === 'tiktok' && typeof note === 'string' && note.startsWith(UI.HELD_TIKTOK_PREFIX)) return 'tiktok_limit';
        return null;
    },

    /** A scheduled post's status: `statusLabel`, except that a held row says it is held. */
    postStatusLabel(post) {
        return UI.heldReason(post) ? t('state.held') : UI.statusLabel(post && post.status);
    },

    // ─── Meta errors in one line (V5, A5) ───────────────────────────────────
    /**
     * The common Meta codes, explained in the interface's language. One copy:
     * Activity explains a row's error with it, Analytics explains the grouped
     * reasons (A5). Codes as the pipeline writes them: `(Code: 190)`
     * (src/services/instagram.ts), `(Code 10903)` (src/webhook/errors.ts).
     * Permanent ones there: 100, 190, 200, 10903; 4/17/32/613 throttle.
     */
    META_ERROR_KEYS: Object.freeze({
        4: 'activity.err.rateLimit',
        10: 'activity.err.permission',
        17: 'activity.err.rateLimit',
        32: 'activity.err.rateLimit',
        100: 'activity.err.noPrivateReply',
        190: 'activity.err.token',
        200: 'activity.err.permission',
        613: 'activity.err.rateLimit',
        10900: 'activity.err.alreadyReplied',
        10903: 'activity.err.blocked',
    }),

    /** The one-liner for a Meta error code, or '' when it is not a common one. */
    metaErrorText(code) {
        const key = UI.META_ERROR_KEYS[Number(code)];
        return key ? t(key) : '';
    },

    /** The one-liner for a raw `error_log`, or '' when no common code is in it. */
    explainMetaError(raw) {
        const text = String(raw || '');
        if (!text) return '';
        const codes = [...text.matchAll(/\bCode:?\s*(\d+)/gi)].map((m) => Number(m[1]));
        // The pipeline's own wording for these carries no code of its own
        // (and Instagram reports the second as -1).
        if (/already had its private reply|already has a reply/i.test(text)) codes.unshift(10900);
        if (/won't accept a private reply/i.test(text)) codes.unshift(100);
        for (const code of codes) {
            const line = UI.metaErrorText(code);
            if (line) return line;
        }
        return '';
    },

    /**
     * The reasons GET /api/stats/failures names that are not a Meta code: the
     * pipeline's own refusals (src/services/failureReasons.ts).
     */
    FAILURE_REASON_KEYS: Object.freeze({
        already_replied: 'activity.err.alreadyReplied',
        recipient_cap: 'activity.err.recipientCap',
        quota_hourly: 'activity.err.quotaHourly',
        quota_app: 'activity.err.quotaApp',
    }),

    /** A reason code from /stats/failures as a sentence, or '' when there is none to give. */
    failureReasonText(code) {
        const value = String(code === null || code === undefined ? '' : code);
        if (/^-?\d+$/.test(value)) return UI.metaErrorText(value);
        const key = UI.FAILURE_REASON_KEYS[value];
        return key ? t(key) : '';
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
        // A modal that is replaced is closed as far as whoever opened it is concerned.
        UI._runAfterClose();

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
        UI._runAfterClose();
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

    _runAfterClose() {
        const done = UI._afterClose;
        UI._afterClose = null;
        if (typeof done === 'function') {
            try { done(); } catch (err) { console.error('afterClose failed:', err); }
        }
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

    /**
     * The operator asked to close. Ask back if there is unsaved work.
     *
     * The one deliberate `window.confirm()` left in the dashboard. `Admin.confirm`
     * works by calling `UI.showModal`, and this runs while a modal is already open —
     * confirming a modal's dismissal by replacing its contents would destroy the very
     * fields being asked about. Replacing this needs a second modal layer, which is a
     * larger change than the problem justifies.
     */
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
    /**
     * The IG / FB tag: a tint with the literal letters (DESIGN §3), so it reads
     * whatever its hue. '' for anything else — a conversation written before
     * v26 has no platform, and a guess would be worse than nothing.
     */
    platformTag(platform) {
        if (platform === 'facebook') return html`<span class="platform-tag fb">FB</span>`;
        if (platform === 'instagram') return html`<span class="platform-tag ig">IG</span>`;
        return '';
    },

    userCell(interaction) {
        const username = interaction.sender_username || '';
        const isFacebook = interaction.platform === 'facebook';
        const badge = UI.platformTag(isFacebook ? 'facebook' : 'instagram');
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

    /**
     * Small inline spinner used inside a button while it works.
     *
     * `hideLabel` keeps the label for assistive technology but takes it out of
     * the flex row (`.sr-only` is absolutely positioned), so the busy content is
     * NARROWER than what it replaced. That is what lets a button hold its exact
     * width while it works: pinning `min-inline-size` only stops a button
     * shrinking, and a button that keeps its label and gains a spinner grows by
     * the spinner plus the gap — about 24px of layout shift, in the direction
     * `min-inline-size` cannot see.
     */
    buttonSpinner(label, hideLabel) {
        const text = html`<span${hideLabel ? html.raw(' class="sr-only"') : ''}>${label || ''}</span>`;
        return esc(html`<span class="spinner spinner-sm spinner-inline"></span>${text}`);
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
    /** The in-app-browser note is told once per tab: closing it is remembered, and it stays closed across steps and reloads. */
    dismissInAppHint: (el) => {
        try { sessionStorage.setItem('inapp_hint_dismissed', '1'); } catch { /* the note simply shows again on the next screen */ }
        const note = el && el.closest ? el.closest('[data-inapp-hint]') : null;
        if (note) note.remove();
    },

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

// ─── ProfileAsk: the one-field sheet an agent opens when it lacks something it writes from (P30) ─────────────

/**
 * An agent asks for what it needs the FIRST time it is switched on, and never before (docs/onboarding/02 §4). The server agrees: a
 * switch-on route answers `409 PROFILE_INCOMPLETE` with the `missing` profile paths (`api.js` catches that, opens this sheet, and sends
 * the same request again once it is answered). A person who finished the wizard is never asked for what it already collected: the sheet
 * holds only the fields that are missing and that have no step of their own in the wizard.
 *
 *   ProfileAsk.require(['presenter'], { agent: 'monteur' })   →  Promise<boolean>   true: saved, false: closed, or nothing it can ask
 *
 * It writes the profile the way the wizard does, `PATCH /api/profile { version, patch }`, so a 409 from somebody else's write in between
 * reloads the sheet with what is there now instead of overwriting it. Only the owner writes the profile, so anyone else is told to ask them.
 * Everything typed is rendered through `html` (escaped), and every request is built from the form's own named fields.
 */
const ProfileAsk = {
    /** What this sheet can ask for: the paths `agentGate.ts` names that the wizard has no step for. */
    FIELDS: ['voice.samples', 'dm.handoff', 'presenter', 'audience.description'],
    /** How many sample boxes there are, and how long one may be (`PROFILE_LIMITS`: 5 samples of 2200). */
    SAMPLE_SLOTS: 3,
    SAMPLES_KEPT: 5,
    SAMPLE_MAX: 2200,
    /** The profile's own limits (`PROFILE_LIMITS`: handoffWhen, handoffMessage, audienceDescription, presenterName); a test holds them equal. */
    HANDOFF_WHEN_MAX: 300,
    HANDOFF_MESSAGE_MAX: 1000,
    AUDIENCE_MAX: 600,
    NAME_MAX: 40,
    PRONOUNS: ['he', 'she', 'they'],
    ON_CAMERA: ['face', 'voice', 'mixed'],
    /** Which words introduce the sheet, by agent: a fixed table, so a name from a response never builds a key. */
    LEAD: Object.assign(Object.create(null), {
        studio: 'profileAsk.lead.studio', monteur: 'profileAsk.lead.monteur', coach: 'profileAsk.lead.coach', dm: 'profileAsk.lead.dm',
    }),

    /** The one sheet that is open, if any: `{ asks, agent, profile, version, note, error, promise, resolve }`. */
    _open: null,

    askable(fields) {
        return (Array.isArray(fields) ? fields : []).filter((path) => this.FIELDS.includes(path));
    },

    /** The shared answer while a sheet is open: two requests refused at once ask once. */
    require(fields, options) {
        if (this._open) return this._open.promise;
        const asks = this.askable(fields);
        if (asks.length === 0) return Promise.resolve(false);
        if (typeof App !== 'undefined' && typeof App.canAdminister === 'function' && !App.canAdminister()) {
            UI.toast(t('profileAsk.ownerOnly'), 'error');
            return Promise.resolve(false);
        }
        const agent = options && typeof options.agent === 'string' ? options.agent : '';
        const state = { asks, agent, profile: {}, version: null, note: '', error: '', promise: null, resolve: null };
        state.promise = new Promise((resolve) => { state.resolve = resolve; });
        this._open = state;
        this._load(state, false).then((ok) => {
            if (!ok) this._finish(state, false);
        });
        return state.promise;
    },

    /** Read the profile (and the version a save must send back), then draw the sheet. False when it could not be read. */
    async _load(state, reloaded) {
        try {
            const read = await API.getProfile();
            state.profile = (read && read.profile) || {};
            state.version = read && read.version !== undefined ? read.version : null;
        } catch (err) {
            UI.toast((err && err.message) || t('profileAsk.loadFailed'), 'error');
            return false;
        }
        if (this._open !== state) return false;
        state.note = reloaded ? t('profileAsk.changed') : '';
        // Drawing this same sheet again is not closing it: its own close hook must not run.
        if (reloaded) UI._afterClose = null;
        UI.showModal(this.sheet(state));
        // `showModal` runs the previous modal's close hook: this one's is set after it.
        UI._afterClose = () => this._finish(state, false);
        return true;
    },

    _finish(state, saved) {
        if (this._open !== state) return;
        this._open = null;
        state.resolve(saved);
    },

    // ─── The sheet ───────────────────────────────────────────────────────

    sheet(state) {
        const lead = this.LEAD[state.agent];
        return html`
            <div class="modal-header">
                <h2 class="modal-title">${t('profileAsk.title')}</h2>
                <button type="button" class="modal-close" data-action="ui:closeModal" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <form id="profile-ask-form" data-submit="profileAsk:save" novalidate>
                <p class="form-hint profile-ask-lead">${lead ? t(lead) : t('profileAsk.lead')}</p>
                ${state.note ? UI.errorStrip(state.note, '', 'profile-ask-note') : ''}
                ${state.asks.map((path) => this.fieldset(path, state.profile))}
                ${state.error ? UI.errorStrip(state.error, '', 'profile-ask-error') : ''}
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-action="ui:closeModal">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary"><i data-lucide="check" aria-hidden="true"></i> ${t('profileAsk.save')}</button>
                </div>
            </form>
        `;
    },

    fieldset(path, profile) {
        const p = profile || {};
        const text = (v) => (typeof v === 'string' ? v : '');
        if (path === 'voice.samples') {
            const have = Array.isArray(p.voice && p.voice.samples) ? p.voice.samples : [];
            return html`
                <fieldset class="fieldset-plain form-group">
                    <legend class="form-label">${t('profileAsk.samples.label')}</legend>
                    <p class="form-hint">${t('profileAsk.samples.hint')}</p>
                    ${Array.from({ length: this.SAMPLE_SLOTS }, (_, i) => html`
                        <label class="sr-only" for="ask-sample-${i}">${t('profileAsk.samples.n', { n: i + 1 })}</label>
                        <textarea class="field-textarea user-content" id="ask-sample-${i}" name="sample${i}" dir="auto" rows="4"
                                  maxlength="${this.SAMPLE_MAX}" placeholder="${t('profileAsk.samples.n', { n: i + 1 })}">${text(have[i])}</textarea>
                    `)}
                </fieldset>
            `;
        }
        if (path === 'dm.handoff') {
            const handoff = (p.dm && p.dm.handoff) || {};
            return html`
                <fieldset class="fieldset-plain form-group">
                    <legend class="form-label">${t('profileAsk.handoff.label')}</legend>
                    <label class="form-label" for="ask-handoff-when">${t('profileAsk.handoff.when')}</label>
                    <textarea class="field-textarea user-content" id="ask-handoff-when" name="handoffWhen" dir="auto" rows="3"
                              maxlength="${this.HANDOFF_WHEN_MAX}" placeholder="${t('profileAsk.handoff.whenPlaceholder')}">${text(handoff.when)}</textarea>
                    <label class="form-label" for="ask-handoff-message">${t('profileAsk.handoff.message')}</label>
                    <textarea class="field-textarea user-content" id="ask-handoff-message" name="handoffMessage" dir="auto" rows="3"
                              maxlength="${this.HANDOFF_MESSAGE_MAX}" placeholder="${t('profileAsk.handoff.messagePlaceholder')}">${text(handoff.message)}</textarea>
                </fieldset>
            `;
        }
        if (path === 'presenter') {
            const who = p.presenter || {};
            const pronouns = this.PRONOUNS.includes(who.pronouns) ? who.pronouns : 'they';
            const camera = this.ON_CAMERA.includes(who.on_camera) ? who.on_camera : 'face';
            return html`
                <fieldset class="fieldset-plain form-group">
                    <legend class="form-label">${t('profileAsk.presenter.label')}</legend>
                    <p class="form-hint">${t('profileAsk.presenter.hint')}</p>
                    <label class="form-label" for="ask-presenter-name">${t('profileAsk.presenter.name')} <span class="label-optional">${t('common.optional')}</span></label>
                    <input class="field" id="ask-presenter-name" name="presenterName" dir="auto" autocomplete="off"
                           maxlength="${this.NAME_MAX}" value="${text(who.name)}">
                    <label class="form-label" for="ask-presenter-pronouns">${t('profileAsk.presenter.pronouns')}</label>
                    <select class="select" id="ask-presenter-pronouns" name="presenterPronouns">
                        ${this.PRONOUNS.map((v) => html`<option value="${v}" ${v === pronouns ? html.raw('selected') : ''}>${t(`profileAsk.pronouns.${v}`)}</option>`)}
                    </select>
                    <label class="form-label" for="ask-presenter-camera">${t('profileAsk.presenter.camera')}</label>
                    <select class="select" id="ask-presenter-camera" name="presenterCamera">
                        ${this.ON_CAMERA.map((v) => html`<option value="${v}" ${v === camera ? html.raw('selected') : ''}>${t(`profileAsk.camera.${v}`)}</option>`)}
                    </select>
                </fieldset>
            `;
        }
        // audience.description
        return html`
            <div class="form-group">
                <label class="form-label" for="ask-audience">${t('profileAsk.audience.label')}</label>
                <textarea class="field-textarea user-content" id="ask-audience" name="audience" dir="auto" rows="3"
                          maxlength="${this.AUDIENCE_MAX}" placeholder="${t('profileAsk.audience.placeholder')}">${text(p.audience && p.audience.description)}</textarea>
                <p class="form-hint">${t('profileAsk.audience.hint')}</p>
            </div>
        `;
    },

    // ─── What a save sends ───────────────────────────────────────────────

    /**
     * The patch for what the form holds, or the key of the first thing wrong with it. Pure (it reads `values`, the form's own named
     * fields) so a test can hold every patch it builds against the real profile validator.
     */
    buildPatch(asks, values, profile) {
        const v = values || {};
        const clean = (key, max) => String(v[key] === undefined || v[key] === null ? '' : v[key]).trim().slice(0, max);
        const patch = {};
        for (const path of asks) {
            if (path === 'voice.samples') {
                const typed = [];
                for (let i = 0; i < this.SAMPLE_SLOTS; i++) {
                    const sample = clean(`sample${i}`, this.SAMPLE_MAX);
                    if (sample) typed.push(sample);
                }
                if (typed.length === 0) return { error: 'profileAsk.err.samples' };
                // What was already beyond the boxes stays: the sheet shows three, the profile holds up to five.
                const have = Array.isArray(profile && profile.voice && profile.voice.samples) ? profile.voice.samples : [];
                patch.voice = { samples: typed.concat(have.slice(this.SAMPLE_SLOTS)).slice(0, this.SAMPLES_KEPT) };
            } else if (path === 'dm.handoff') {
                const when = clean('handoffWhen', this.HANDOFF_WHEN_MAX);
                const message = clean('handoffMessage', this.HANDOFF_MESSAGE_MAX);
                if (!when || !message) return { error: 'profileAsk.err.handoff' };
                patch.dm = { handoff: { when, message } };
            } else if (path === 'presenter') {
                const pronouns = this.PRONOUNS.includes(v.presenterPronouns) ? v.presenterPronouns : '';
                const camera = this.ON_CAMERA.includes(v.presenterCamera) ? v.presenterCamera : '';
                if (!pronouns || !camera) return { error: 'profileAsk.err.presenter' };
                patch.presenter = { name: clean('presenterName', this.NAME_MAX), pronouns, on_camera: camera };
            } else if (path === 'audience.description') {
                const description = clean('audience', this.AUDIENCE_MAX);
                if (!description) return { error: 'profileAsk.err.audience' };
                patch.audience = { description };
            }
        }
        return { patch };
    },

    async save(form, event) {
        if (event && event.preventDefault) event.preventDefault();
        const state = this._open;
        if (!state) return;
        const values = this._read(form);
        const built = this.buildPatch(state.asks, values, state.profile);
        if (built.error) {
            state.error = t(built.error);
            this._redraw(state, values);
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (restore === null) return;
        try {
            await API.patchProfile(state.version, built.patch);
        } catch (err) {
            restore();
            const body = err && err.body;
            if (body && body.code === 'PROFILE_VERSION_CONFLICT') {
                // Somebody wrote in between: show what is there now, and say so.
                state.error = '';
                await this._load(state, true);
                return;
            }
            const problems = body && Array.isArray(body.problems) && body.problems.length ? body.problems.slice(0, 3).join(' ') : '';
            state.error = problems || (err && err.message) || t('profileAsk.saveFailed');
            this._redraw(state, values);
            return;
        }
        UI.toast(t('profileAsk.saved'));
        this._finish(state, true);
        UI._afterClose = null;
        UI.closeModal();
    },

    _read(form) {
        const values = {};
        new FormData(form).forEach((value, key) => { values[key] = value; });
        return values;
    },

    /** Redraw in place with what the person typed kept: the error is the only thing that changes. */
    _redraw(state, typed) {
        const merged = JSON.parse(JSON.stringify(state.profile || {}));
        if (state.asks.includes('voice.samples')) {
            merged.voice = merged.voice || {};
            merged.voice.samples = [0, 1, 2].map((i) => String(typed[`sample${i}`] || ''));
        }
        if (state.asks.includes('dm.handoff')) {
            merged.dm = merged.dm || {};
            merged.dm.handoff = { when: String(typed.handoffWhen || ''), message: String(typed.handoffMessage || '') };
        }
        if (state.asks.includes('presenter')) {
            merged.presenter = { name: String(typed.presenterName || ''), pronouns: typed.presenterPronouns, on_camera: typed.presenterCamera };
        }
        if (state.asks.includes('audience.description')) {
            merged.audience = merged.audience || {};
            merged.audience.description = String(typed.audience || '');
        }
        UI._afterClose = null;
        UI.showModal(this.sheet({ ...state, profile: merged }));
        UI._afterClose = () => this._finish(state, false);
    },
};

UI.registerActions('profileAsk', {
    save: (form, event) => ProfileAsk.save(form, event),
});

// ─── Backwards-compat alias ──────────────────────────────────────────────────
const Components = {
    showToast: (msg, type = 'success') => UI.toast(msg, type),
};
