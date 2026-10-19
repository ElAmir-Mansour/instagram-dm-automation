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

    /**
     * "72%" as text, wrapped in a left-to-right isolate (U+2066 … U+2069, the text form of `<bdi dir="ltr">`): the digits stay Latin and
     * the sign stays attached. Bare, "46%" inside an Arabic sentence shows as "%46" (OV-30), and the value goes through `t()` and into
     * attributes, where markup cannot follow, so the isolate is part of the string. '—' for a value that is not a number.
     */
    formatPercent(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '—';
        return `\u2066${UI.formatNumber(n)}%\u2069`;
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
     *   - an error gets 9s rather than 4.5s, a warning 7s;
     *   - hovering or focusing the toast cancels the countdown and restarts it
     *     on the way out, which is the WCAG 2.2.1 escape hatch for anything
     *     that disappears on a timer;
     *   - there is a close button, so it can also be dismissed early — and its
     *     presence is what makes the toast focusable enough to pause at all.
     *
     *   UI.toast(message)                          success
     *   UI.toast(message, 'error')                 the original signature, unchanged
     *   UI.toast(message, { type: 'warning' })     'success' | 'info' | 'warning' | 'error'
     *   UI.toast(message, { type: 'info', action: { label: t('ui.undo'), onClick } })
     *
     * ── Two live regions ──
     * Errors go to `#toast-alerts` (`role="alert"`, announced at once), everything
     * else to `#toast-container` (`role="status"`, announced politely). Both are in
     * index.html because a live region must exist in the accessibility tree before
     * its contents change. A page without the second region falls back to the first.
     *
     * ── The action button ──
     * A toast with a button is something to act on, not only to read, so it stays at
     * least 6 seconds (constitution III: an Undo is offered for at least that long).
     * Pressing it runs `onClick` and dismisses the toast.
     *
     * Returns `{ dismiss(), closed }` — `closed` resolves to 'action', 'dismissed' or
     * 'expired' once the toast is gone — or null when the page has no toast region.
     * `UI.undoToast` is built on it.
     */
    toast(message, arg) {
        const opts = typeof arg === 'string' ? { type: arg } : (arg && typeof arg === 'object' ? arg : {});
        // A table, not `toast ${type}`: the tone becomes a class name, and a value that
        // is not one of these four must not reach the attribute.
        const type = opts.type === undefined ? 'success' : (UI._TOAST_TONES[opts.type] ? opts.type : 'info');
        const tone = UI._TOAST_TONES[type];
        const container = (type === 'error' && document.getElementById('toast-alerts'))
            || document.getElementById('toast-container');
        if (!container) return null;

        const action = opts.action && opts.action.label && typeof opts.action.onClick === 'function' ? opts.action : null;
        let lifetime = Number.isFinite(opts.duration) && opts.duration > 0 ? opts.duration : tone.ms;
        if (action) lifetime = Math.max(lifetime, 6000);

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const iconEl = document.createElement('i');
        iconEl.setAttribute('data-lucide', tone.icon);

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
        let actionBtn = null;
        if (action) {
            actionBtn = document.createElement('button');
            actionBtn.type = 'button';
            actionBtn.className = 'toast-action';
            actionBtn.textContent = String(action.label);
            toast.appendChild(actionBtn);
        }
        toast.appendChild(close);
        container.appendChild(toast);
        UI.icons(toast);

        let timer = null;
        let leaving = false;
        let settle = () => {};
        const closed = new Promise((resolve) => { settle = resolve; });
        const dismiss = (reason) => {
            if (timer) { clearTimeout(timer); timer = null; }
            if (leaving) return;
            leaving = true;
            // A class, so the exit timing lives with the entrance timing in
            // styles.css and collapses with the rest under reduced motion.
            toast.classList.add('is-leaving');
            setTimeout(() => toast.remove(), 320);
            settle(reason);
        };
        const start = () => {
            if (leaving) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => dismiss('expired'), lifetime);
        };
        const hold = () => { if (timer) { clearTimeout(timer); timer = null; } };

        close.addEventListener('click', () => dismiss('dismissed'));
        if (actionBtn) {
            actionBtn.addEventListener('click', () => {
                try { action.onClick(); } catch (err) { console.error('Toast action failed:', err); }
                dismiss('action');
            });
        }
        toast.addEventListener('pointerenter', hold);
        toast.addEventListener('pointerleave', start);
        toast.addEventListener('focusin', hold);
        toast.addEventListener('focusout', start);
        start();
        return { dismiss: () => dismiss('dismissed'), closed };
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
            // The discard question (UI.confirm, stacked) has its own Escape and Tab trap.
            if (UI._confirmLayer) return;
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
        // A question drawn over this modal (navigation can close the modal under it) goes with it.
        UI._closeConfirmLayer(false);
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
     * The question is `UI.confirm` drawn as a second layer over the modal (`stack: true`),
     * not in place of it: replacing a modal's contents to ask about its dismissal would
     * destroy the very fields being asked about. It used to be the one native
     * `window.confirm()` left in the dashboard, which is browser chrome: unstyled,
     * untranslatable, and a different look from every other decision here.
     */
    requestCloseModal() {
        if (!UI.isModalDirty()) { UI.closeModal(); return; }
        if (UI._confirmLayer) return; // the question is already on screen
        UI.confirm({
            stack: true,
            title: t('ui.discard.title'),
            body: t('common.discardConfirm'),
            confirmLabel: t('ui.discard.confirm'),
            cancelLabel: t('ui.discard.keep'),
            onConfirm: () => UI.closeModal(),
        });
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

    /**
     * Full stamp for scheduled posts. With no options it is what it always was, in the browser's zone. Opt in (UX F4, PO-07 / PO-19):
     *   `weekday: true | 'short' | 'long'`  adds the day's name ("Thu, 23 Oct 2026, 19:00").
     *   `zone: true | 'Area/City'`          reads the time in the tenant's zone (`UI.zone()`) or the one named, and says which:
     *                                       "Thu, 23 Oct 2026, 19:00 (Riyadh)".
     */
    formatDateTime(iso, opts) {
        const o = opts || {};
        const options = {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false,
        };
        if (o.weekday) options.weekday = o.weekday === 'long' ? 'long' : 'short';
        const zone = o.zone ? UI.zone(typeof o.zone === 'string' ? o.zone : undefined) : '';
        if (zone) options.timeZone = zone;
        const text = UI._fmt(iso, options);
        if (!zone || text === '—') return text;
        return t('time.zoned', { time: text, city: UI.zoneCity(zone) });
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

    // ═══ UX F4 · Primitives A: error sentences, status pills, the tenant zone ════
    // One section on purpose (Dashboard UX overhaul, T014–T017): each primitive is the one place its pattern is built, so a screen
    // that needs it calls it rather than writing its own. Constitution I (bidi, zones), III (truthful states), V (one design system).

    // ─── Errors as a sentence ───────────────────────────────────────────────
    /**
     * An error as the person should read it: `{ sentence, next, details }`, all plain text.
     *
     *   sentence  what happened, in the interface language: `errors.<code>` when the server sent a `code` (`err.code`, from api.js) that
     *             the catalogue knows, else the server's own message (today's behaviour), else a generic line. Never empty.
     *   next      what to do about it: `errors.<code>.next` when the catalogue has one, else ''.
     *   details   what is behind the sentence, for the person who wants it or has to report it: the server's own words when they were
     *             replaced by a sentence, and the code with the HTTP status. '' when there is nothing more to say.
     *
     * The server's text reaches the screen untranslated only as the sentence's last-resort fallback or inside `details`.
     * `err.params` fill the `{placeholders}`; a string or number is isolated (first-strong) so a Latin value never reorders an Arabic
     * sentence, and anything else is dropped. `count` stays a number: it is how a plural family picks its form.
     */
    errorText(err) {
        const code = err && typeof err.code === 'string' ? err.code : '';
        let raw = '';
        if (typeof err === 'string') raw = err;
        else if (err && typeof err.message === 'string') raw = err.message;
        raw = raw.trim();

        let sentence = '';
        let next = '';
        if (code) {
            const params = UI._errorParams(err.params);
            const key = `errors.${code}`;
            const said = t(key, params);
            if (said !== key) {
                sentence = said;
                const nextKey = `${key}.next`;
                const todo = t(nextKey, params);
                if (todo !== nextKey) next = todo;
            }
        }
        const translated = sentence !== '';
        if (!translated) sentence = raw || t('common.error');

        const details = [];
        if (translated && raw && raw !== sentence) details.push(raw);
        if (code) details.push(err.status ? `${code} (HTTP ${err.status})` : code);
        return { sentence, next, details: details.join('\n') };
    },

    /** `err.params` as the `{placeholders}` of a sentence: strings and numbers isolated, `count` left a number, the rest dropped. */
    _errorParams(params) {
        const out = {};
        if (!params || typeof params !== 'object' || Array.isArray(params)) return out;
        for (const name of Object.keys(params)) {
            const value = params[name];
            if (name === 'count' && typeof value === 'number') out[name] = value;
            else if (typeof value === 'string' || typeof value === 'number') out[name] = `⁨${value}⁩`;
        }
        return out;
    },

    /**
     * `errorText` as markup, for an error strip, a modal or a toast-like panel: the sentence, the next step under it, and the details
     * folded behind a native "Details" disclosure (keyboard operable, no script). Everything goes through the escaping `html` tag;
     * `dir="auto"` lets the server's English sit left to right inside an Arabic page.
     */
    errorHtml(err) {
        const { sentence, next, details } = UI.errorText(err);
        return html`<div class="error-text">
            <strong class="error-sentence" dir="auto">${sentence}</strong>
            ${next ? html`<span class="error-next" dir="auto">${next}</span>` : ''}
            ${details ? html`<details class="error-details">
                <summary>${t('error.details')}</summary>
                <p class="error-details-text" dir="auto">${details}</p>
            </details>` : ''}
        </div>`;
    },

    /**
     * `errorText` as one line, for a toast: the sentence, then the next step. A toast cannot hold a disclosure, so the Details stay
     * behind (the full error is on whatever screen raised it). Never empty.
     */
    errorLine(err) {
        const { sentence, next } = UI.errorText(err);
        return next ? `${sentence} ${next}` : sentence;
    },

    /**
     * An error strip (the `.inline-error` box, with its alert icon and `role="alert"`) that holds `errorHtml`: the sentence, the next
     * step and the folded Details. The strip the Studio pages draw for a refusal or a failed job, so none of them prints
     * `err.message` (the server's English, or a worker's raw JSON) as the sentence. `id` names the strip for `aria-describedby`.
     */
    errorBox(err, id) {
        const stripId = id || `error-box-${++UI._previewSeq}`;
        return html`<div class="inline-error" role="alert" id="${stripId}">
            <i data-lucide="alert-circle" aria-hidden="true"></i>
            ${UI.errorHtml(err)}
        </div>`;
    },

    /**
     * The folded Details of an error on their own (`errorHtml`'s disclosure), for a line its caller has already worded (a sentence
     * wrapped around a stored failure) and that only needs the raw text kept behind it. '' when there is nothing behind the sentence.
     */
    errorDetails(err) {
        const { details } = UI.errorText(err);
        return details ? html`<details class="error-details">
            <summary>${t('error.details')}</summary>
            <p class="error-details-text" dir="auto">${details}</p>
        </details>` : '';
    },

    /** What Supabase Storage (or the worker reporting it) says when an object is over the file-size limit: a 413 in any of its spellings. */
    STORAGE_TOO_LARGE_TEXT: /payload too large|exceeded the maximum allowed size|"statusCode"\s*:\s*"?413\b|\bHTTP\s*413\b/i,

    /** Text that is not for a person: a JSON object, an HTTP status line, a socket error code, a stack frame, `[object Object]`. */
    TECHNICAL_TEXT: /\{\s*"[\w$.-]+"\s*:|"statusCode"|\bHTTP\s*[1-5]\d\d\b|\b(?:ECONN[A-Z]+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\b|\n\s+at\s+\S|\[object Object\]/i,

    /**
     * A failure that was STORED as text (a worker's error on a source, a clip, a draft, a lesson) as an error `errorText` / `errorHtml` can
     * read: `{ code?, message }`. The text itself is never changed, only what it is shown as:
     *
     *   - Storage's 413 ("storage answered HTTP 400 to the upload: {"statusCode":"413","error":"Payload too large"…}") is
     *     `STORAGE_FILE_TOO_LARGE`: a sentence that says what is wrong and what to do, the raw text behind Details.
     *   - Any other technical text (JSON, an HTTP status, a socket error, a stack) is `STUDIO_STEP_FAILED`: a plain "this step did not
     *     finish", the raw text behind Details. It is never the sentence.
     *   - A readable sentence the server wrote and has not given a code yet stays as it is, the sentence it is today (the contract
     *     `errorText` already has for an uncoded refusal).
     *
     * Empty text gives an error whose sentence is the generic `common.error`.
     */
    failureError(text) {
        const raw = typeof text === 'string' ? text.trim() : '';
        if (!raw) return { message: '' };
        if (UI.STORAGE_TOO_LARGE_TEXT.test(raw)) return { code: 'STORAGE_FILE_TOO_LARGE', message: raw };
        if (UI.TECHNICAL_TEXT.test(raw)) return { code: 'STUDIO_STEP_FAILED', message: raw };
        return { message: raw };
    },

    // ─── Status pills ───────────────────────────────────────────────────────
    /**
     * The status vocabulary (specs/001-dashboard-ux/data-model.md, "StatusPill vocabulary"): family → state → `[tone, glyph, busy?]`.
     * A pill is a glyph, a word and a tone, never colour alone: the glyph differs in SHAPE (● fine, ○ nothing to do, ▲ look at it,
     * ✕ broken, ◆ it is waiting for you, ◔ it is waiting for its time), and the word is `status.<family>.<state>`.
     * `busy` states are in progress, so their glyph pulses (not under reduced motion).
     */
    STATUS_PILLS: (() => {
        const family = (rows) => Object.freeze(Object.assign(Object.create(null), rows));
        return Object.freeze(Object.assign(Object.create(null), {
            post: family({
                scheduled: ['info', '◔'],
                publishing: ['info', '●', 'busy'],
                processing: ['info', '●', 'busy'],
                needs_you: ['accent', '◆'],
                held: ['warning', '▲'],
                overdue: ['warning', '▲'],
                failed: ['danger', '✕'],
                live: ['success', '●'],
                archived: ['neutral', '○'],
            }),
            campaign: family({
                live: ['success', '●'],
                dormant: ['warning', '▲'],
                failing: ['danger', '✕'],
                paused: ['neutral', '○'],
                ended: ['neutral', '○'],
                archived: ['neutral', '○'],
            }),
            content: family({
                making: ['info', '●', 'busy'],
                review: ['accent', '◆'],
                scheduled: ['info', '◔'],
                posted: ['success', '●'],
                failed: ['danger', '✕'],
            }),
            connection: family({
                fine: ['success', '●'],
                expiring: ['warning', '▲'],
                broken: ['danger', '✕'],
                not_set_up: ['neutral', '○'],
            }),
            assistant: family({
                on: ['success', '●'],
                off: ['neutral', '○'],
                paused_here: ['neutral', '○'],
                sales_test: ['info', '◔'],
                sales_live: ['success', '●'],
            }),
        }));
    })(),

    /** Tone → the class that paints it: the badge tones, which are token pairs `check:contrast` already measures. A lookup, never interpolation. */
    STATUS_TONE_CLASS: Object.freeze(Object.assign(Object.create(null), {
        success: 'badge-success', info: 'badge-info', warning: 'badge-warning',
        danger: 'badge-danger', neutral: 'badge-neutral', accent: 'badge-accent',
    })),

    /**
     * `UI.statusPill('post', 'held')` → `<span class="status-pill badge-warning">▲ Held</span>`.
     * `opts.label` replaces the word (a count, a platform), nothing else about the pill. `state` is read in lower case. A family or
     * state outside the vocabulary is drawn neutral with the state as written, not as a success and not as nothing: an unknown
     * status must never look healthy. `status.<family>.<state>.hint`, when the catalogue has one, says what it means for the person
     * and what to do about it; it is the pill's `title`.
     */
    statusPill(family, state, opts) {
        const o = opts || {};
        const name = String(state === null || state === undefined ? '' : state).toLowerCase();
        const row = UI.STATUS_PILLS[family] && UI.STATUS_PILLS[family][name];
        const [tone, glyph, busy] = row || ['neutral', '○'];

        let word = o.label;
        let hint = '';
        if (row) {
            const key = `status.${family}.${name}`;
            const said = t(key);
            if (!word) word = said === key ? name : said;
            const hintKey = `${key}.hint`;
            const hinted = t(hintKey);
            if (hinted !== hintKey) hint = hinted;
        }
        if (!word) word = String(state === null || state === undefined || state === '' ? '—' : state);

        return html`<span class="status-pill ${html.raw(UI.STATUS_TONE_CLASS[tone])}" data-tone="${tone}" data-status="${family}.${name}"${hint ? html` title="${hint}"` : ''}><span class="status-pill-glyph${busy ? html.raw(' is-busy') : ''}" aria-hidden="true">${glyph}</span>${word}</span>`;
    },

    // ─── The tenant's time zone (R-09) ──────────────────────────────────────
    /**
     * One zone for every time the dashboard shows or reads: the tenant's, which is `identity.timezone`, mirrored into
     * `studio_settings.schedule.timezone`. A screen that has read it says so with `UI.setZone(tz)`; every other screen then shows and
     * reads times in it without loading the setting itself. Until one has, times are in the browser's zone, which is what they were
     * before. These were two copies, in studio.js and monteur.js (ST-14).
     */
    _zone: '',

    /** Is `zone` an IANA name this browser can format in? */
    validZone(zone) {
        if (!zone || typeof zone !== 'string') return false;
        return UI._formatter({ timeZone: zone }) !== null;
    },

    /** This browser's zone, 'UTC' when it will not say. */
    deviceZone() {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
    },

    /**
     * Record the tenant's zone. A zone this browser cannot format, or none, leaves it UNSET (the browser's zone shows), which is also how
     * a tenant switch forgets the last one: `UI.setZone('')`. A screen whose answer lacks a zone should not call this with '', or it
     * would wipe the zone another screen read. Returns the zone now in force for the tenant ('' when unset).
     */
    setZone(zone) {
        UI._zone = UI.validZone(zone) ? zone : '';
        return UI._zone;
    },

    /**
     * The zone to show and read times in: `candidate` when it is a zone (a screen passing what it has just read from its own settings),
     * else the one `setZone` recorded, else the browser's.
     */
    zone(candidate) {
        if (UI.validZone(candidate)) return candidate;
        return UI._zone || UI.deviceZone();
    },

    /** "Riyadh" / «الرياض»: the city part of an IANA zone, in the interface language when the catalogue has it. `zone` defaults to `UI.zone()`. */
    zoneCity(zone) {
        const city = String(zone === undefined ? UI.zone() : (zone || 'UTC')).split('/').pop().replace(/_/g, ' ');
        const key = `studio.city.${city.replace(/\s+/g, '')}`;
        const named = t(key);
        return named && named !== key ? named : city;
    },

    /**
     * `value` (a Date, an ISO string or a timestamp) formatted by `opts` in the tenant's zone; '' when it is not a time. `opts` are
     * `Intl.DateTimeFormat` options plus `zone`, which overrides `UI.zone()` for this call. Formatters are cached by `_formatter`.
     */
    zoneFormat(value, opts) {
        const d = UI._date(value);
        if (!d) return '';
        const { zone, ...intl } = opts || {};
        const fmt = UI._formatter({ ...intl, timeZone: UI.zone(zone) });
        if (fmt) {
            try { return fmt.format(d); } catch { /* fall through */ }
        }
        return UI.formatDateTime(d);
    },

    /** What `zoneTime` shows unless told otherwise: weekday, day, month and a 24-hour clock, like the settings the times came from. */
    ZONE_TIME: Object.freeze({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),

    /** "Sun, 28 Sep, 19:00" in the tenant's zone. `opts` override `ZONE_TIME` field by field (and may carry `zone`). */
    zoneTime(value, opts) {
        return UI.zoneFormat(value, { ...UI.ZONE_TIME, ...opts });
    },

    /** Minutes `zone` is ahead of UTC at the instant `at` (ms). 0 for a zone the browser cannot read. */
    zoneOffsetMin(zone, at) {
        const when = new Date(Math.floor(Number(at) / 60000) * 60000);
        try {
            const f = new Intl.DateTimeFormat('en-US', {
                timeZone: zone, hourCycle: 'h23',
                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
            });
            const p = {};
            f.formatToParts(when).forEach((part) => { p[part.type] = part.value; });
            const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
            return Math.round((wall - when.getTime()) / 60000);
        } catch {
            return 0;
        }
    },

    /** An instant as `<input type="datetime-local">` shows it: the wall time in the tenant's zone (the inverse of `zoneInput`). '' for a non-time. */
    zoneInputValue(value, zone) {
        const d = UI._date(value);
        if (!d) return '';
        const offset = UI.zoneOffsetMin(UI.zone(zone), d.getTime());
        return new Date(d.getTime() + offset * 60000).toISOString().slice(0, 16);
    },

    /**
     * A `datetime-local` value (`YYYY-MM-DDTHH:MM`) read as wall time in the tenant's zone, back to an ISO instant; null when it is not
     * one. Not `fromLocalInputValue`, which reads it in the BROWSER's zone. The offset is looked up at the instant it produces, and
     * corrected once, so a time either side of a daylight-saving change lands on the right hour.
     */
    zoneInput(value, zone) {
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
        if (!m) return null;
        const at = UI.zone(zone);
        const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
        if (!Number.isFinite(wall)) return null;
        // `Date.UTC` rolls 02-31 over to 03-03; a wall time that is not on the calendar is not an instant.
        const back = new Date(wall);
        if (back.toISOString().slice(0, 16) !== `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`) return null;
        let utc = wall - UI.zoneOffsetMin(at, wall) * 60000;
        const corrected = wall - UI.zoneOffsetMin(at, utc) * 60000;
        if (corrected !== utc) utc = corrected;
        const d = new Date(utc);
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

    // ═════════════════════════════════════════════════════════════════════════
    // Shared patterns (UX foundation)
    // ═════════════════════════════════════════════════════════════════════════
    /**
     * What every screen builds its chrome from, written once (constitution V; audit SH-09,
     * SH-11 … SH-17, SH-33). A page moves onto these one story at a time: until it does, its own
     * markup keeps working and nothing here changes what it renders.
     *
     *   UI.pageHeader({ title, subtitle, back, actions, help })
     *   UI.card({ title, actions, body, tone })
     *   UI.emptyState({ icon, title, body, action, secondary, help })
     *   UI.confirm({ title, body, hint, confirmLabel, tone, requireText, onConfirm })
     *   UI.undoToast(message, { onUndo, seconds })                    -> Promise<boolean>
     *   UI.tabs(items, { mode, current })
     *   UI.secretField({ id, label, status, onReplace, onRemove, generate })
     *   UI.field({ id, label, hint, error, optional, control })
     *   UI.filterBar({ id, search, chips, sort, counts, value, onChange })
     *   UI.table({ id, columns, rows, sort, empty })  +  UI.pager({ id, page, total, onPage })
     *
     * (`UI.toast` keeps its place above, next to the modal code, with the new tones and the
     * action button.)
     *
     * ── The contract they share ──
     *   - A builder returns SafeHtml, written with the `html` tag, so a title, a label or a row
     *     value that came from the server is escaped. A string passed where markup is expected
     *     is TEXT, never markup; markup is passed as SafeHtml (`html\`…\``, another builder, or
     *     `html.raw` on a literal written in this codebase).
     *   - A class name that depends on a word (a tone, a variant, an alignment) comes from one
     *     of the null-prototype tables below, never from interpolation: a plain `{}` answers
     *     'constructor' with a function (see the note on BUTTON_VARIANTS).
     *   - No inline handlers. A callback (`onChange`, `onPage`, `onSort`, `onReplace`) lives in a
     *     bounded registry keyed by the element's `data-ui-id`, and the delegated handlers at the
     *     foot of this file look it up. Pass a stable `id`: a page that re-renders then replaces
     *     its entry, and focus can be put back by `UI.captureFocus` (ids and `data-focus-key`).
     *   - Logical CSS properties only, 44px targets, a visible focus ring, and every label from
     *     i18n in both languages.
     */

    /** The tones a toast can have: the icon (shape as well as colour) and how long it stays. */
    _TOAST_TONES: Object.assign(Object.create(null), {
        success: { icon: 'check-circle', ms: 4500 },
        info: { icon: 'info', ms: 4500 },
        warning: { icon: 'alert-triangle', ms: 7000 },
        error: { icon: 'alert-circle', ms: 9000 },
    }),
    /** A card's tone: its class and the glyph in its title, so the tone is never colour alone. */
    _CARD_TONES: Object.assign(Object.create(null), {
        info: { cls: 'ui-card--info', icon: 'info' },
        success: { cls: 'ui-card--success', icon: 'check-circle' },
        warning: { cls: 'ui-card--warning', icon: 'alert-triangle' },
        danger: { cls: 'ui-card--danger', icon: 'alert-circle' },
    }),
    /** Heading levels a header or a card may use. */
    _HEADING_TAGS: Object.assign(Object.create(null), { 2: 'h2', 3: 'h3', 4: 'h4' }),
    /** Where a saved secret came from, as the dictionary key that says it. */
    _SECRET_SOURCES: Object.assign(Object.create(null), {
        db: 'ui.secret.source.db',
        env: 'ui.secret.source.env',
    }),
    /** A column's alignment as a class (`.cell-num`: end-aligned, tabular figures). */
    _ALIGN: Object.assign(Object.create(null), { start: '', end: 'cell-num' }),

    _shared: Object.create(null),
    _sharedOrder: [],
    _sharedSeq: 0,
    /** The callback the open confirmation will run. Never written into the DOM. */
    _confirmPending: null,
    /** The confirmation drawn over an open modal (`stack: true`), if any. */
    _confirmLayer: null,

    // ─── Registry for callbacks ──────────────────────────────────────────────
    /**
     * Keep a builder's callbacks where its delegated handlers can find them. Bounded: a page
     * that never passes an `id` and re-renders on every keystroke would otherwise grow it
     * for the life of the tab, so the oldest entries go first (the newest is the live one).
     */
    _remember(id, entry) {
        const key = String(id);
        const old = UI._shared[key];
        if (old && old.timer) clearTimeout(old.timer);
        if (!old) UI._sharedOrder.push(key);
        UI._shared[key] = entry;
        while (UI._sharedOrder.length > 120) delete UI._shared[UI._sharedOrder.shift()];
        return entry;
    },

    /** The entry of the builder that rendered `el` (or an ancestor of it). */
    _recall(el) {
        const host = el && el.closest ? el.closest('[data-ui-id]') : null;
        const id = host ? host.getAttribute('data-ui-id') : null;
        return id ? UI._shared[id] || null : null;
    },

    /**
     * A link target: a hash route this app owns (`#/posts?view=live`), or what `safeUrl` allows.
     * '' for anything else. `safeUrl` alone refuses `#/…`, and escaping alone does not stop `javascript:`.
     */
    _href(value) {
        const v = value === null || value === undefined ? '' : String(value).trim();
        if (/^#\/[\p{L}\p{N}\-._~/?=&%#,:@+]*$/u.test(v)) return v;
        return safeUrl(v);
    },

    /** A link that looks like a button, its classes from the button tables. '' without a usable href. */
    _anchorButton(o) {
        const href = UI._href(o.href);
        if (!href) return '';
        const variant = BUTTON_VARIANTS[o.variant] !== undefined ? BUTTON_VARIANTS[o.variant] : BUTTON_VARIANTS.secondary;
        const classes = ['btn', variant, BUTTON_SIZES[o.size] || '', o.className || ''].filter(Boolean).join(' ');
        const external = /^https?:/i.test(href);
        return html`<a class="${classes}" href="${href}"${external ? html.raw(' target="_blank" rel="noopener noreferrer"') : ''}>${o.icon ? html`<i data-lucide="${o.icon}" aria-hidden="true"></i> ` : ''}${o.label}</a>`;
    },

    /** `{ label, action, data }` or `{ label, href }` as a button or a link. '' when it names neither. */
    _cta(spec, fallbackVariant) {
        if (!spec || !spec.label) return '';
        const variant = spec.variant || fallbackVariant;
        if (spec.href) return UI._anchorButton({ href: spec.href, label: spec.label, icon: spec.icon, variant, size: spec.size });
        if (!spec.action) return '';
        return UI.button({ variant, size: spec.size, label: spec.label, icon: spec.icon, action: spec.action, data: spec.data, id: spec.id });
    },

    /** `help` as `'slug#section'` or `{ target, label }`, through `UI.helpLink` (which renders nothing for a bad target). */
    _help(help) {
        if (!help) return '';
        if (typeof help === 'string') return UI.helpLink(help);
        return UI.helpLink(help.target, help.label);
    },

    // ─── Page header ─────────────────────────────────────────────────────────
    /**
     * The header inside a page: its title, a line that says what the screen is for, a way back,
     * the page's actions and a link to the help article that explains it. A detail view says WHICH
     * tenant, article or draft it shows (SH-09), and the page's one primary action sits here in
     * the same place on every screen instead of in a toolbar of its own.
     *
     *   UI.pageHeader({
     *     title: tenant.name,                                      text; isolated with dir="auto"
     *     subtitle: t('tenants.detail.subtitle'),
     *     back: { label: t('nav.tenants'), href: '#/tenants' },    or { label, action: 'ns:method', data }
     *     actions: UI.button({ variant: 'primary', … }),           SafeHtml; ONE primary per screen
     *     help: 'worker#security',                                 or { target, label }
     *   })
     *
     * The shell's own `#page-title` (an h1) is the page's name; this is an h2 (`level: 3` nests it).
     */
    pageHeader(options) {
        const o = options || {};
        const tag = html.raw(UI._HEADING_TAGS[o.level] || 'h2');
        const back = o.back && o.back.label
            ? (o.back.action
                ? UI.button({ variant: 'ghost', size: 'sm', icon: 'arrow-left', label: o.back.label, action: o.back.action, data: o.back.data, className: 'ui-page-back' })
                : UI._anchorButton({ href: o.back.href, label: o.back.label, icon: 'arrow-left', variant: 'ghost', size: 'sm', className: 'ui-page-back' }))
            : '';
        const help = UI._help(o.help);
        return html`
            <header class="ui-page-head">
                <div class="ui-page-head-main">
                    ${back}
                    <${tag} class="ui-page-head-title" dir="auto">${o.title}</${tag}>
                    ${o.subtitle ? html`<p class="ui-page-head-subtitle" dir="auto">${o.subtitle}</p>` : ''}
                    ${help}
                </div>
                ${o.actions ? html`<div class="ui-page-head-actions">${o.actions}</div>` : ''}
            </header>
        `;
    },

    // ─── Card ────────────────────────────────────────────────────────────────
    /**
     * One card: a head (title left, actions at the end) over a body, the same padding, title size
     * and action placement on every screen (SH-11: there were 32 card classes and 55 title ones).
     *
     *   UI.card({ title, actions, body, tone: 'warning', level: 2, solid: false, id, className })
     *
     * `tone` ('info' | 'success' | 'warning' | 'danger') tints the edge and puts a glyph in front
     * of the title, so it reads without colour. `solid` is for a card inside a scrolling grid
     * (DESIGN.md: cards in a grid are opaque; glass is for a lone panel). `body` and `actions` are
     * SafeHtml; a plain string is shown as text.
     */
    card(options) {
        const o = options || {};
        const tone = UI._CARD_TONES[o.tone] || null;
        const tag = html.raw(UI._HEADING_TAGS[o.level] || 'h2');
        const base = o.id ? String(o.id) : `ui-card-${++UI._sharedSeq}`;
        const titleId = `${base}-title`;
        const classes = ['surface', o.solid ? 'surface--solid' : '', 'ui-card', tone ? tone.cls : '', o.className || '']
            .filter(Boolean).join(' ');
        const title = o.title
            ? html`<${tag} class="card-title" id="${titleId}" dir="auto">${tone ? html`<i data-lucide="${tone.icon}" aria-hidden="true"></i> ` : ''}${o.title}</${tag}>`
            : '';
        const head = title || o.actions
            ? html`
                <div class="card-head">
                    ${title}
                    ${o.actions ? html`<div class="card-head-actions">${o.actions}</div>` : ''}
                </div>`
            : '';
        return html`
            <section class="${classes}"${o.id ? html` id="${o.id}"` : ''}${o.title ? html` aria-labelledby="${titleId}"` : ''}>
                ${head}
                <div class="card-body">${o.body}</div>
            </section>
        `;
    },

    // ─── Empty state ─────────────────────────────────────────────────────────
    /**
     * "Nothing here yet", and what to do about it (SH-12). Every empty state carries ONE next step:
     * "No campaigns yet" is itself the "New campaign" button, not a dead end.
     *
     *   UI.emptyState({
     *     icon: 'inbox', title, body,
     *     action: { label, action: 'ns:method', data } | { label, href: '#/campaigns' },   the next step
     *     secondary: { label, href },                       optional, quieter
     *     help: 'faq#setup',                                optional help article
     *   })
     *
     * With no `action`, `secondary` or `help` the markup is exactly what `Admin.emptyState` always
     * drew, which now delegates here. Whether a view is empty because nothing is configured or
     * because nothing has happened yet is the caller's to say (constitution III): they are two
     * different titles and, usually, two different actions.
     */
    emptyState(options) {
        const o = options || {};
        const glyph = o.icon ? html`<i data-lucide="${o.icon}" aria-hidden="true"></i>` : '';
        const body = o.body ? html`<p dir="auto">${o.body}</p>` : '';
        const actions = [UI._cta(o.action, 'primary'), UI._cta(o.secondary, 'ghost'), UI._help(o.help)].filter(Boolean);
        if (actions.length === 0) {
            return html`
            <div class="empty-state">
                ${glyph}
                <h3>${o.title}</h3>
                ${body}
            </div>
        `;
        }
        return html`
            <div class="empty-state">
                ${glyph}
                <h3>${o.title}</h3>
                ${body}
                <div class="empty-state-actions">${actions}</div>
            </div>
        `;
    },

    // ─── Confirm ─────────────────────────────────────────────────────────────
    /**
     * The styled confirmation: one look for every decision in the product. It moved here from
     * `Admin.confirm`, which is now an alias with the same behaviour.
     *
     * `window.confirm()` is a browser chrome dialog: it drops the product's visual identity, cannot
     * be translated, cannot be styled as dangerous, and appears at exactly the moment the operator
     * is deciding whether to destroy something. Nothing in the dashboard uses it.
     *
     *   title        heading
     *   body         what will happen, in one sentence
     *   hint         the consequence that is not obvious
     *   confirmLabel a VERB
     *   cancelLabel  the way out, when "Cancel" is not the honest word ("Keep editing")
     *   tone         'danger' (default) or 'primary'
     *   requireText  the operator must type this string to enable the button
     *   stack        draw it over the open modal instead of in place of it (the discard question)
     *   onCancel()   stacked only: runs when the question is answered "no" (Cancel, Escape, a click outside), so a caller
     *                waiting on the answer (the router's leave guard) hears it. In place of the modal, `UI._afterClose` does that.
     *   onConfirm()  runs after the button is pressed; a promise keeps the dialog open until it settles
     *
     * `tone` exists because not every confirmation is destructive. Extending the Meta token is
     * consequential and worth confirming, but it destroys nothing — dressing it in a red button would
     * be miscommunication, so the danger look is the default and the exception is opt-in.
     *
     * Use it for what cannot be taken back. For what can (a campaign, a draft, a scheduled post),
     * constitution III prefers no question at all and an Undo after (`UI.undoToast`).
     */
    confirm(options) {
        const o = options || {};
        UI._confirmPending = typeof o.onConfirm === 'function' ? o.onConfirm : null;
        // A question already on screen that this one replaces was not answered "yes": tell whoever asked it.
        if (o.stack) UI._answerCancel();
        UI._confirmCancel = o.stack && typeof o.onCancel === 'function' ? o.onCancel : null;
        const markup = UI._confirmMarkup(o, !!o.stack);
        if (o.stack) UI._openConfirmLayer(markup);
        else UI.showModal(markup);
    },

    _confirmMarkup(o, stacked) {
        const gated = !!o.requireText;
        const confirmIcon = o.confirmIcon === undefined ? 'trash-2' : o.confirmIcon;
        const confirmClass = `btn ${BUTTON_VARIANTS[o.tone === 'primary' ? 'primary' : 'danger']}`;
        const cancelClass = `btn ${BUTTON_VARIANTS.secondary}`;
        // In place of the modal, the way out is the modal's own close (which asks about unsaved work);
        // drawn over it, the way out closes only the question.
        const closeAction = stacked ? 'ui:cancelConfirm' : 'ui:closeModal';
        return html`
            <div class="modal-header">
                <h2 class="modal-title">${o.title}</h2>
                <button type="button" class="modal-close" data-action="${closeAction}" aria-label="${t('common.closeDialog')}">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </div>
            <p class="modal-body-text" dir="auto">${o.body}</p>
            ${o.hint ? html`<p class="form-hint">${o.hint}</p>` : ''}
            ${gated ? html`
                <div class="form-group mbs-4">
                    <label class="form-label" for="admin-confirm-echo">${o.requireHint || t('admin.confirmEcho')}</label>
                    <input class="field field-mono" id="admin-confirm-echo" type="text" dir="ltr"
                           autocomplete="off" spellcheck="false" data-input="ui:gateConfirm"
                           data-expect="${o.requireText}" aria-describedby="admin-confirm-echo-hint">
                    <p class="form-hint" id="admin-confirm-echo-hint">${t('admin.confirmEchoHint', { value: o.requireText })}</p>
                </div>
            ` : ''}
            <div id="admin-confirm-error"></div>
            <div class="modal-actions">
                <button type="button" class="${cancelClass}" data-action="${closeAction}">${o.cancelLabel || t('common.cancel')}</button>
                <button type="button" class="${confirmClass}" id="admin-confirm-btn"
                        data-action="ui:runConfirm" ${gated ? html.raw('disabled') : ''}>
                    <i data-lucide="${confirmIcon}" aria-hidden="true"></i> ${o.confirmLabel || t('common.delete')}
                </button>
            </div>
        `;
    },

    /** The typed-echo gate: the button turns on only on an exact match. */
    gateConfirm(input) {
        const btn = document.getElementById('admin-confirm-btn');
        if (!btn) return;
        btn.disabled = String(input.value || '').trim() !== String(input.dataset.expect || '');
    },

    /**
     * Run the confirmed action WITHOUT throwing the button away first.
     *
     * This used to be `UI.closeModal()` and then `fn()`. Closing first destroys the button the
     * operator just pressed, which meant every confirm-gated destructive action in the product —
     * delete campaign, delete post, publish now, cancel job, revoke a membership, revoke sessions,
     * grant platform_admin, GDPR erasure — had *zero* in-flight feedback. The dialog vanished,
     * nothing else changed, and the operator was left guessing for as long as the request took. On a
     * cold start that is seconds.
     *
     * Worse, the failure path was a toast fired at a screen that had already moved on: "publish now"
     * could fail and the only trace was a message four and a half seconds long, with the thing the
     * operator had been looking at already gone.
     *
     * So the order is the one `UI.closeModal`'s own docblock asks for — do the work, THEN close:
     *
     *   - the button goes busy and stays put, so the press is acknowledged;
     *   - success closes the dialog;
     *   - failure keeps it open, restores the button and puts the reason *inside* the dialog, next to
     *     the action that produced it, with the callback put back so the retry is one click.
     *
     * Escape and the close button stay live throughout: a slow request must never become a trap.
     *
     * ── What this must NOT break ──
     * Some callers paint optimistically the moment they are called and rely on that paint being
     * visible. `posts.js: deletePostConfirmed` removes the card and then returns a `Motion.optimistic`
     * promise; `publishNowConfirmed` greys the card's buttons and flips its status pill. Both still
     * work, because both do their painting SYNCHRONOUSLY before returning — the card disappears behind
     * the dialog exactly as it used to, and the dialog follows a moment later. And `Motion.optimistic`
     * resolves even on failure (it reverts and toasts internally), so those two keep their own error
     * handling and never see the in-modal strip.
     *
     * A synchronous callback — one that returns no promise — closes the dialog immediately. There is
     * nothing to wait for.
     */
    runConfirm(el) {
        const btn = (el && el.id === 'admin-confirm-btn') ? el : document.getElementById('admin-confirm-btn');
        const restore = UI.actionBusy(btn);
        // Already in flight: the second click of a double-click lands here and is a no-op, which is the
        // whole point of `actionBusy` returning null.
        //
        // This guard comes FIRST, before the pending callback is even read, and that ordering is the whole
        // fix. Read it first and the second click finds it already nulled by the first, falls into the
        // "nothing to confirm" branch below, and closes the dialog — out from under a request that is still
        // running. A double-click would have looked exactly like success.
        if (restore === null) return undefined;

        const layered = !!UI._confirmLayer;
        const done = () => {
            // Answered "yes": the cancel hook must never also run.
            if (layered) { UI._confirmCancel = null; UI._closeConfirmLayer(true); }
            else UI.closeModal();
        };

        const fn = UI._confirmPending;
        if (typeof fn !== 'function') {
            done();
            return undefined;
        }

        UI._confirmPending = null;
        UI.clearConfirmError();

        const recover = (err) => {
            // Put the callback back so the button the operator is looking at still does what it says.
            UI._confirmPending = fn;
            restore();
            UI.regateConfirm();
            UI.showConfirmError(err);
        };

        let result;
        try {
            result = fn();
        } catch (err) {
            recover(err);
            return undefined;
        }

        if (!result || typeof result.then !== 'function') {
            done();
            return undefined;
        }

        return result.then(() => { done(); }, recover);
    },

    /** Re-apply the typed-echo gate after a restore, in case the field changed. */
    regateConfirm() {
        const input = document.getElementById('admin-confirm-echo');
        if (input) UI.gateConfirm(input);
    },

    clearConfirmError() {
        const host = document.getElementById('admin-confirm-error');
        if (host) host.innerHTML = '';
    },

    /**
     * The reason, inside the dialog. Falls back to a toast if the dialog is no longer there — the
     * operator can close a slow confirm with Escape, and an error that arrives afterwards must still
     * be said out loud rather than written to an element that no longer exists.
     */
    showConfirmError(err) {
        const message = (err && err.message) || t('common.error');
        const host = document.getElementById('admin-confirm-error');
        if (!host) {
            UI.toast(message, 'error');
            return;
        }
        host.innerHTML = esc(UI.errorStrip(message, '', 'admin-confirm-error-strip'));
        UI.icons(host);
    },

    /**
     * Draw a confirmation OVER the open modal. The modal underneath is `inert`, so neither the keyboard
     * nor a screen reader reaches it, and what it holds (the very fields the question is about) is left
     * exactly as it was. Escape and the scrim answer "no"; Tab stays inside; focus starts on the way out.
     */
    _openConfirmLayer(markup) {
        UI._closeConfirmLayer(false);
        const underneath = document.getElementById('modal-overlay');
        const returnFocus = document.activeElement;

        const layer = document.createElement('div');
        layer.className = 'modal-overlay confirm-layer';
        const box = document.createElement('div');
        box.className = 'modal-content confirm-content';
        box.setAttribute('role', 'alertdialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('tabindex', '-1');
        box.innerHTML = esc(markup);
        const title = box.querySelector('.modal-title');
        if (title) {
            title.id = `confirm-title-${++UI._modalSeq}`;
            box.setAttribute('aria-labelledby', title.id);
        }
        layer.appendChild(box);
        document.body.appendChild(layer);
        UI.icons(box);
        if (underneath) underneath.setAttribute('inert', '');

        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                UI.cancelConfirm();
                return;
            }
            if (e.key !== 'Tab') return;
            const items = UI._focusables(box);
            if (items.length === 0) { e.preventDefault(); box.focus(); return; }
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || !box.contains(active))) {
                e.preventDefault(); last.focus();
            } else if (!e.shiftKey && (active === last || !box.contains(active))) {
                e.preventDefault(); first.focus();
            }
        };
        document.addEventListener('keydown', onKey, true);
        layer.addEventListener('click', (e) => { if (e.target === layer) UI.cancelConfirm(); });
        UI._confirmLayer = { layer, underneath, returnFocus, onKey };

        // The first button is the way out: a destructive question never starts on its destructive answer.
        const wayOut = box.querySelector('.modal-actions .btn');
        (wayOut || box).focus();
    },

    /** Remove the stacked question, if there is one. Idempotent. Returns whether one was open. */
    _closeConfirmLayer(restoreFocus) {
        const open = UI._confirmLayer;
        if (!open) return false;
        UI._confirmLayer = null;
        document.removeEventListener('keydown', open.onKey, true);
        if (open.layer && typeof open.layer.remove === 'function') open.layer.remove();
        if (open.underneath) open.underneath.removeAttribute('inert');
        const back = open.returnFocus;
        // Only where it can still take focus: after "discard" the modal it came from is gone.
        if (restoreFocus && back && typeof back.focus === 'function' && document.contains(back) && back.offsetParent !== null) {
            back.focus();
        }
        return true;
    },

    /** "No" to the stacked question: it closes, and the modal underneath is as it was. */
    cancelConfirm() {
        UI._confirmPending = null;
        UI._closeConfirmLayer(true);
        UI._answerCancel();
    },

    /** The stacked question's `onCancel`, run at most once. */
    _confirmCancel: null,
    _answerCancel() {
        const cancel = UI._confirmCancel;
        UI._confirmCancel = null;
        if (typeof cancel !== 'function') return;
        try { cancel(); } catch (err) { console.warn('confirm onCancel failed:', err); }
    },

    // ─── Undo toast ──────────────────────────────────────────────────────────
    /**
     * The reversible way to take a decision (constitution III): do not ask first, tell them it is
     * done and let them take it back. The toast stays for `seconds` (never under 6) and holds while it
     * is hovered or focused, like every toast. The promise settles when it is gone:
     *
     *   true   the person pressed Undo (`onUndo` has run)
     *   false  it expired or was dismissed: the decision stands, so the caller carries it out
     *
     *   removeRowFromScreen(id);
     *   const undone = await UI.undoToast(t('campaigns.deleted'), { onUndo: () => putRowBack(id) });
     *   if (!undone) await API.deleteCampaign(id);       // the real, irreversible request goes last
     *
     * Nothing has been sent until the promise settles, so closing the tab inside the window means it
     * never is: a caller whose action must not be lost flushes it on `pagehide`.
     * A page with no toast region cannot offer an Undo, so the promise settles `false` at once.
     */
    undoToast(message, options) {
        const o = options || {};
        const seconds = Math.max(6, Number(o.seconds) || 6);
        let undone = false;
        const handle = UI.toast(message, {
            type: o.type || 'info',
            duration: seconds * 1000,
            action: {
                label: o.label || t('ui.undo'),
                onClick: () => {
                    undone = true;
                    // Someone who pressed Undo does not want the action, so a failed `onUndo` is said out loud
                    // and the answer is still "undone": better a row left on screen than a surprise delete.
                    try {
                        const r = typeof o.onUndo === 'function' ? o.onUndo() : undefined;
                        if (r && typeof r.then === 'function') {
                            r.then(null, (err) => UI.toast((err && err.message) || t('common.error'), 'error'));
                        }
                    } catch (err) {
                        UI.toast((err && err.message) || t('common.error'), 'error');
                    }
                },
            },
        });
        if (!handle || !handle.closed) return Promise.resolve(false);
        return handle.closed.then(() => undone);
    },

    // ─── Tabs ────────────────────────────────────────────────────────────────
    /**
     * Two controls that look alike and behave differently, made to look different (SH-17).
     *
     *   mode 'link'    NAVIGATION. Each tab is an `<a href>` and the current one carries `aria-current`,
     *                  so the view survives a reload, Back and a shared link. Underline tabs.
     *   mode 'toggle'  A VIEW SWITCH inside the page. Each is a button with `aria-pressed`, and it does
     *                  not change the URL. A pill in a track.
     *
     *   UI.tabs([{ key: 'queue', label }, { key: 'live', label, count: 3 }],
     *           { mode: 'link', current: 'live', route: '#/posts', param: 'view', label: t('nav.posts') })
     *       → <a href="#/posts?view=live" aria-current="page">
     *   UI.tabs(items, { mode: 'toggle', current: 'live', action: 'posts:setView', label })
     *       → <button aria-pressed="true" data-action="posts:setView" data-key="live">
     *
     * An item may carry its own `href` (link mode) or `action` and `data` (toggle mode), and an `icon`.
     * The arrow keys, Home and End move focus between the tabs following the page's direction: in
     * Arabic the left arrow goes to the NEXT tab. Tab itself still reaches every one.
     */
    tabs(items, options) {
        const o = options || {};
        const mode = o.mode === 'toggle' ? 'toggle' : 'link';
        const list = (Array.isArray(items) ? items : []).filter((it) => it && it.key !== undefined && it.key !== null && it.label !== undefined);
        const label = o.label ? html` aria-label="${o.label}"` : '';
        const inner = (it) => html`${it.icon ? html`<i data-lucide="${it.icon}" aria-hidden="true"></i>` : ''}<span>${it.label}</span>${it.count !== undefined && it.count !== null ? html`<span class="ui-tab-count">${UI.num(it.count)}</span>` : ''}`;
        const current = (it) => o.current !== undefined && String(o.current) === String(it.key);

        if (mode === 'toggle') {
            return html`<div class="ui-tabs ui-tabs--toggle" role="group"${label} data-keydown="ui:tabsKey">${list.map((it) => {
                const action = it.action || o.action;
                return html`<button type="button" class="ui-tab" data-ui-tab aria-pressed="${current(it) ? 'true' : 'false'}"${action ? html` data-action="${action}"` : ''} data-key="${it.key}"${it.disabled ? html.raw(' disabled') : ''}>${inner(it)}</button>`;
            })}</div>`;
        }

        return html`<nav class="ui-tabs ui-tabs--link"${label} data-keydown="ui:tabsKey">${list.map((it) => {
            const raw = it.href !== undefined
                ? it.href
                : (o.route ? `${o.route}${o.param ? `?${o.param}=${encodeURIComponent(String(it.key))}` : ''}` : '');
            const href = UI._href(raw);
            if (!href) return '';
            return html`<a class="ui-tab" data-ui-tab href="${href}"${current(it) ? html.raw(' aria-current="page"') : ''}>${inner(it)}</a>`;
        })}</nav>`;
    },

    /** Is `el` laid out right to left? The element's own computed direction, else the document's. */
    _isRtl(el) {
        try {
            if (el && typeof getComputedStyle === 'function') {
                const dir = getComputedStyle(el).direction;
                if (dir) return dir === 'rtl';
            }
        } catch { /* no layout engine: use the attribute */ }
        const root = document.documentElement;
        const dir = root && (root.dir || (root.getAttribute && root.getAttribute('dir')));
        return dir === 'rtl';
    },

    /**
     * Arrow keys between tabs. Right is "next" in a left-to-right page and "previous" in a right-to-left
     * one; Home and End are the first and last in reading order. It only moves focus: pressing the tab
     * (Enter or Space on a button, Enter on a link) is what activates it.
     */
    tabsKey(host, event) {
        const key = event && event.key;
        const tabs = Array.from(host.querySelectorAll('[data-ui-tab]'))
            .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
        if (tabs.length < 2) return;
        const from = event.target && event.target.closest ? event.target.closest('[data-ui-tab]') : null;
        const at = tabs.indexOf(from);
        if (at < 0) return;
        const rtl = UI._isRtl(host);
        let to;
        if (key === 'ArrowRight') to = at + (rtl ? -1 : 1);
        else if (key === 'ArrowLeft') to = at + (rtl ? 1 : -1);
        else if (key === 'Home') to = 0;
        else if (key === 'End') to = tabs.length - 1;
        else return;
        event.preventDefault();
        tabs[(to + tabs.length) % tabs.length].focus();
    },

    // ─── Form field ──────────────────────────────────────────────────────────
    /**
     * The one form-field pattern (constitution V, SH-15): a label, an optional marker, a hint and an
     * inline error, wired so a screen reader can reach each one from the control.
     *
     *   UI.field({ id: 'camp-name', label: t('campaigns.name'), hint: t('campaigns.nameHint'),
     *              optional: false, error: problem,
     *              control: ({ attrs }) => html`<input class="field" name="name" ${attrs}>` })
     *
     *   - the label points at the control (`for`), and says "(optional)" when `optional` is set;
     *   - the hint is `aria-describedby`; with an `error`, the error is too, and the control gets
     *     `aria-invalid="true"` (the red ring in styles.css keys off it);
     *   - the error has a glyph as well as a colour and is announced when it appears.
     *
     * `control` is a function, called with `{ id, describedBy, invalid, attrs }` where `attrs` is the
     * id, `aria-describedby` and `aria-invalid` as ready-to-place SafeHtml attributes; or SafeHtml, in
     * which case the wiring is added to the first `<input>`, `<select>` or `<textarea>` in it (a
     * control that already has an id keeps it, and the label follows). A string is text.
     *
     * To show or clear an error after a submit, without re-rendering the form: `UI.setFieldError(el, message)`
     * and `UI.clearFieldError(el)`, which reuse `UI.markInvalid`.
     */
    field(options) {
        const o = options || {};
        let id = o.id ? String(o.id) : '';
        const wanted = !!o.error;
        const rawControl = o.control;

        // Which id does the control have? The caller's, else the one it already carries, else a new one.
        if (!id && rawControl instanceof SafeHtml) {
            const found = /<(?:input|select|textarea)\b[^>]*?\sid="([^"]*)"/i.exec(rawControl.value);
            if (found) id = found[1];
        }
        if (!id) id = `ui-field-${++UI._sharedSeq}`;

        const hintId = o.hint ? `${id}-hint` : '';
        const errorId = `${id}-error`;
        const describedBy = [hintId, wanted ? errorId : ''].filter(Boolean).join(' ');
        const wire = { id, describedBy, invalid: wanted };
        let control;
        if (typeof rawControl === 'function') {
            const attrs = html`${html` id="${id}"`}${describedBy ? html` aria-describedby="${describedBy}"` : ''}${wanted ? html.raw(' aria-invalid="true"') : ''}`;
            control = rawControl({ id, describedBy, invalid: wanted, attrs });
        } else {
            control = UI._wireControl(rawControl, wire);
        }

        return html`
            <div class="form-group ui-field${wanted ? ' has-error' : ''}" data-ui-field>
                <label class="form-label" for="${id}">${o.label}${o.optional ? html` <span class="label-optional">${t('common.optional')}</span>` : ''}</label>
                ${control}
                ${hintId ? html`<p class="form-hint" id="${hintId}">${o.hint}</p>` : ''}
                <p class="ui-field-error${wanted ? '' : ' hidden'}" id="${errorId}" role="alert" data-ui-field-error><i data-lucide="alert-circle" aria-hidden="true"></i> <span dir="auto">${o.error}</span></p>
            </div>
        `;
    },

    /** Add the id, `aria-describedby` and `aria-invalid` to the first form control in `control` (SafeHtml). */
    _wireControl(control, wire) {
        if (!(control instanceof SafeHtml)) return control === null || control === undefined ? '' : html`${control}`;
        const re = /<(input|select|textarea)\b([^>]*)>/i;
        const m = re.exec(control.value);
        if (!m) return control;
        let attrs = m[2];
        const trailing = /\/\s*$/.test(attrs) ? ' /' : '';
        attrs = attrs.replace(/\s*\/\s*$/, '');
        const hasId = /\sid="/i.test(` ${attrs}`);
        // `aria-invalid` is owned here: whatever the control said is replaced by what the field knows.
        attrs = attrs.replace(/\saria-invalid="[^"]*"/i, '');
        const had = /\saria-describedby="([^"]*)"/i.exec(attrs);
        let described = wire.describedBy;
        if (had) {
            attrs = attrs.replace(/\saria-describedby="[^"]*"/i, '');
            described = [had[1], wire.describedBy].filter(Boolean).join(' ');
        }
        const added = [
            hasId ? '' : ` id="${esc(wire.id)}"`,
            described ? ` aria-describedby="${esc(described)}"` : '',
            wire.invalid ? ' aria-invalid="true"' : '',
        ].join('');
        const tag = `<${m[1]}${attrs}${added}${trailing}>`;
        return html.raw(control.value.slice(0, m.index) + tag + control.value.slice(m.index + m[0].length));
    },

    /**
     * Show `message` under a field after the fact (a server refusal, a client check) and mark its control
     * invalid. `el` is the field's wrapper or anything inside it. The control takes focus, as with
     * `UI.markInvalid`, which this uses. Returns false when `el` is not inside a `UI.field`.
     */
    setFieldError(el, message, options) {
        const host = el && el.closest ? el.closest('[data-ui-field]') : null;
        const control = host ? host.querySelector('input, select, textarea') : null;
        const note = host ? host.querySelector('[data-ui-field-error]') : null;
        if (!host || !control || !note) return false;
        const span = note.querySelector('span');
        if (span) span.textContent = message === null || message === undefined ? '' : String(message);
        note.classList.remove('hidden');
        host.classList.add('has-error');
        const kept = String(control.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== note.id);
        const described = kept.concat(note.id).join(' ');
        if (options && options.focus === false) {
            control.setAttribute('aria-invalid', 'true');
            control.setAttribute('aria-describedby', described);
        } else {
            UI.markInvalid(control, described);
        }
        return true;
    },

    /** Take the error away again: the message, the red ring and the description that pointed at it. */
    clearFieldError(el) {
        const host = el && el.closest ? el.closest('[data-ui-field]') : null;
        const control = host ? host.querySelector('input, select, textarea') : null;
        const note = host ? host.querySelector('[data-ui-field-error]') : null;
        if (!host || !control || !note) return false;
        const span = note.querySelector('span');
        if (span) span.textContent = '';
        note.classList.add('hidden');
        host.classList.remove('has-error');
        control.removeAttribute('aria-invalid');
        const kept = String(control.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== note.id).join(' ');
        if (kept) control.setAttribute('aria-describedby', kept);
        else control.removeAttribute('aria-describedby');
        return true;
    },

    // ─── Secret field ────────────────────────────────────────────────────────
    /**
     * A key, a token or a client secret, handled the way constitution IV asks: written by the person,
     * write-only, never echoed back (SE-07). What it shows is what is TRUE:
     *
     *   saved          «محفوظ ••••ab12 · من قاعدة البيانات»   with Replace and Remove
     *   not saved      «غير محفوظ»                              with the input to fill
     *
     * There is never an empty field standing for a value that is stored: a field you could "clear and save"
     * implies the value would be wiped, and it would not. Replace reveals an input (and only then does one
     * exist in the page); Remove asks first and says what stops working.
     *
     *   UI.secretField({
     *     id: 'meta-token', label: t('settings.token'),
     *     status: { saved: true, last4: 'ab12', source: 'db' },      source: 'db' | 'env'
     *     onReplace: (value) => API.saveToken(value),                 may return a promise; a throw stays inline
     *     onRemove: () => API.removeToken(),                          omit it and there is no Remove
     *     generate: true,                                             or { bytes: 32 }: a random value + Copy
     *     hint: t('…'),                                               defaults to "write-only"
     *   })
     *
     * Only the last four characters of `last4` are ever drawn, whatever was passed. The typed value is
     * cleared from the page the moment `onReplace` settles. After a save the field redraws as «saved».
     */
    secretField(options) {
        const o = options || {};
        const id = String(o.id || `ui-secret-${++UI._sharedSeq}`);
        const status = o.status && typeof o.status === 'object' ? o.status : {};
        const saved = !!status.saved;
        const editing = !saved || !!o.editing;
        const entry = UI._remember(id, {
            kind: 'secret',
            id,
            saved,
            options: o,
            generate: !!o.generate,
            bytes: o.generate && typeof o.generate === 'object' ? o.generate.bytes : undefined,
            onReplace: o.onReplace,
            onRemove: o.onRemove,
        });
        const buttons = saved && !editing
            ? html`<div class="ui-secret-buttons">
                    ${UI.button({ variant: 'secondary', size: 'sm', label: t('ui.secret.replace'), action: 'ui:secretReplace', id: `${id}-replace` })}
                    ${typeof o.onRemove === 'function' ? UI.button({ variant: 'ghost', size: 'sm', label: t('ui.secret.remove'), action: 'ui:secretRemove', id: `${id}-remove` }) : ''}
                </div>`
            : '';
        return html`
            <div class="form-group ui-secret" id="${id}-field" role="group" aria-labelledby="${id}-label" data-ui-id="${id}">
                <span class="form-label" id="${id}-label">${o.label}</span>
                <div class="ui-secret-row">
                    <p class="ui-secret-state" id="${id}-state">${UI._secretState(status)}</p>
                    ${buttons}
                </div>
                ${editing ? UI._secretEdit(id, entry) : ''}
                <p class="form-hint" id="${id}-hint">${o.hint || t('ui.secret.writeOnly')}</p>
                <p class="ui-secret-error" id="${id}-error" role="alert" data-ui-secret-error></p>
            </div>
        `;
    },

    /** «Saved ••••ab12 · from the database», or «Not saved». The mask is isolated: Latin inside Arabic. */
    _secretState(status) {
        if (!status || !status.saved) {
            return html`<i data-lucide="lock" aria-hidden="true"></i> <span>${t('ui.secret.notSet')}</span>`;
        }
        const raw = status.last4;
        const last4 = typeof raw === 'string' || typeof raw === 'number' ? String(raw).slice(-4) : '';
        const sourceKey = UI._SECRET_SOURCES[status.source];
        return html`<i data-lucide="key-round" aria-hidden="true"></i> <span>${t('ui.secret.saved')}</span>${last4 ? html` ${UI.ltr(`••••${last4}`)}` : ''}${sourceKey ? html` <span class="ui-secret-source">· ${t(sourceKey)}</span>` : ''}`;
    },

    /** The input that takes a new value. It never carries a value of its own. */
    _secretEdit(id, entry) {
        return html`
            <div class="ui-secret-edit">
                <div class="field-row">
                    <input class="field field-mono" id="${id}" type="password" dir="ltr" autocomplete="new-password"
                           autocapitalize="off" spellcheck="false" placeholder="${t('ui.secret.newValue')}"
                           aria-labelledby="${id}-label" aria-describedby="${id}-hint ${id}-error">
                    ${entry.generate ? UI.button({ variant: 'secondary', icon: 'sparkles', label: t('ui.secret.generate'), action: 'ui:secretGenerate' }) : ''}
                </div>
                <div class="ui-secret-actions">
                    ${UI.button({ variant: 'secondary', size: 'sm', icon: 'check', label: t('common.save'), action: 'ui:secretSave', id: `${id}-save` })}
                    ${entry.generate ? UI.button({ variant: 'ghost', size: 'sm', icon: 'copy', label: t('common.copy'), action: 'ui:secretCopy' }) : ''}
                    ${entry.saved ? UI.button({ variant: 'ghost', size: 'sm', label: t('common.cancel'), action: 'ui:secretCancel', id: `${id}-cancel` }) : ''}
                </div>
            </div>
        `;
    },

    /** Redraw a secret field in place with `changes` (a status, or `editing`), and put focus where the person is. */
    _secretRedraw(el, changes, focusId) {
        const host = el && el.closest ? el.closest('[data-ui-id]') : null;
        const entry = UI._recall(el);
        if (!host || !entry) return;
        host.outerHTML = esc(UI.secretField(Object.assign({}, entry.options, changes)));
        const fresh = document.getElementById(`${entry.id}-field`);
        if (fresh) UI.icons(fresh);
        const target = focusId ? document.getElementById(focusId) : null;
        if (target && typeof target.focus === 'function') target.focus();
    },

    secretReplace(el) {
        const entry = UI._recall(el);
        if (entry) UI._secretRedraw(el, { editing: true }, entry.id);
    },

    secretCancel(el) {
        const entry = UI._recall(el);
        if (entry) UI._secretRedraw(el, { editing: false }, `${entry.id}-replace`);
    },

    /** Replace: validate, hand the value to `onReplace`, then wipe it from the page. */
    async secretSave(el) {
        const host = el && el.closest ? el.closest('[data-ui-id]') : null;
        const entry = UI._recall(el);
        if (!host || !entry || typeof entry.onReplace !== 'function') return undefined;
        const input = host.querySelector('input');
        const note = host.querySelector('[data-ui-secret-error]');
        const say = (message) => { if (note) note.textContent = message || ''; };
        const value = input ? String(input.value || '').trim() : '';
        say('');
        if (input) input.removeAttribute('aria-invalid');
        if (!value) {
            say(t('ui.secret.empty'));
            if (input) UI.markInvalid(input, `${entry.id}-hint ${entry.id}-error`);
            return undefined;
        }
        const restore = UI.actionBusy(el);
        if (restore === null) return undefined;
        try {
            await entry.onReplace(value);
        } catch (err) {
            restore();
            say((err && err.message) || t('common.error'));
            return undefined;
        }
        // The value does not stay in the page, and the field says what is stored now.
        if (input) input.value = '';
        restore();
        UI._secretRedraw(el, { editing: false, status: { saved: true, last4: value.slice(-4), source: 'db' } }, `${entry.id}-replace`);
        return undefined;
    },

    /** A random value from the platform's CSPRNG, as hex. Never `Math.random`: this is a credential. */
    randomSecret(bytes) {
        const n = Math.min(Math.max(Math.floor(Number(bytes) || 32), 16), 128);
        const source = typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' ? crypto : null;
        if (!source) throw new Error(t('common.error'));
        const buf = new Uint8Array(n);
        source.getRandomValues(buf);
        return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
    },

    secretGenerate(el) {
        const host = el && el.closest ? el.closest('[data-ui-id]') : null;
        const entry = UI._recall(el);
        const input = host ? host.querySelector('input') : null;
        if (!entry || !input) return;
        input.value = UI.randomSecret(entry.bytes);
        // Shown once, so it can be copied before it is saved: the one time a secret is in the page in clear.
        input.type = 'text';
        input.removeAttribute('aria-invalid');
        input.focus();
    },

    secretCopy(el) {
        const host = el && el.closest ? el.closest('[data-ui-id]') : null;
        const input = host ? host.querySelector('input') : null;
        const value = input ? String(input.value || '') : '';
        if (!value) return;
        const clip = typeof navigator !== 'undefined' && navigator.clipboard;
        if (!clip || typeof clip.writeText !== 'function') return;
        clip.writeText(value).then(
            () => UI.toast(t('common.copied')),
            (err) => UI.toast((err && err.message) || t('common.error'), 'error'),
        );
    },

    /** Remove: asks first, and says what stops working. */
    secretRemove(el) {
        const entry = UI._recall(el);
        if (!entry || typeof entry.onRemove !== 'function') return;
        UI.confirm({
            title: t('ui.secret.removeTitle'),
            body: t('ui.secret.removeBody'),
            confirmLabel: t('ui.secret.remove'),
            onConfirm: () => entry.onRemove(),
        });
    },

    // ─── Filter bar ──────────────────────────────────────────────────────────
    /**
     * The search, the filter chips and the sort that a list screen carries, in one control that looks and
     * behaves the same on every screen (CA-10, TN-05). Controlled: it draws what `value` says and calls
     * `onChange` with the whole next value; the page keeps the state and re-renders.
     *
     *   UI.filterBar({
     *     id: 'campaigns-filter',
     *     search: { label: t('campaigns.search'), placeholder },     or true
     *     chips: [{ key: '', label: t('common.all') }, { key: 'failed', label }],   one pressed at a time
     *     counts: { '': 40, failed: 3 },                              or `count` on a chip
     *     sort: { label, options: [{ key: 'recent', label }] },
     *     value: { q: '', filter: '', sort: 'recent' },
     *     onChange: (next) => { state = next; render(); },
     *   })
     *
     * Typing is debounced (250 ms; `debounceMs` changes it) so a list is not rebuilt per letter. The chips
     * are toggle buttons (`aria-pressed`) with a count; a count is what the caller knows, never a guess.
     *
     * When the page has `App.hashParams` (the router's helper) the state is also written into the hash as
     * `?q=…&filter=…&sort=…` with `history.replaceState`, so a filtered view survives a reload and can be
     * shared; `hash: false` opts out. Reading it back at first render is the page's job, from the same
     * three names.
     */
    filterBar(options) {
        const o = options || {};
        const id = String(o.id || `ui-filter-${++UI._sharedSeq}`);
        const value = Object.assign({ q: '', filter: '', sort: '' }, o.value && typeof o.value === 'object' ? o.value : {});
        UI._remember(id, {
            kind: 'filter',
            value,
            onChange: o.onChange,
            debounceMs: Number.isFinite(o.debounceMs) ? o.debounceMs : 250,
            hash: o.hash !== false,
            timer: null,
        });

        const search = o.search ? (typeof o.search === 'object' ? o.search : {}) : null;
        const chips = (Array.isArray(o.chips) ? o.chips : []).filter((c) => c && c.key !== undefined && c.key !== null && c.label !== undefined);
        const counts = o.counts && typeof o.counts === 'object' ? o.counts : {};
        const sort = o.sort && Array.isArray(o.sort.options) ? o.sort : (Array.isArray(o.sort) ? { options: o.sort } : null);
        const sortOptions = sort ? sort.options.filter((s) => s && s.key !== undefined && s.key !== null && s.label !== undefined) : [];

        const chip = (c) => {
            const pressed = String(value.filter || '') === String(c.key);
            const count = Object.hasOwn(counts, c.key) ? counts[c.key] : c.count;
            const hasCount = count !== undefined && count !== null;
            return html`<button type="button" class="chip ui-chip${pressed ? ' chip-accent' : ''}" aria-pressed="${pressed ? 'true' : 'false'}" data-action="ui:filterChip" data-key="${c.key}" data-focus-key="${id}-chip-${c.key}">${c.label}${hasCount ? html` <span class="ui-chip-count">${UI.num(count)}</span>` : ''}</button>`;
        };

        return html`
            <div class="filter-bar ui-filter" role="group" aria-label="${o.label || t('ui.filter.label')}" data-ui-id="${id}">
                ${search ? html`
                    <div class="ui-filter-search">
                        <label class="sr-only" for="${id}-search">${search.label || t('common.search')}</label>
                        <input class="field" type="search" id="${id}-search" value="${value.q}" dir="auto"
                               placeholder="${search.placeholder || search.label || t('common.search')}"
                               autocomplete="off" enterkeyhint="search" data-input="ui:filterSearch">
                    </div>` : ''}
                ${chips.length ? html`<div class="ui-filter-chips" role="group" aria-label="${o.chipsLabel || t('ui.filter.chips')}">${chips.map(chip)}</div>` : ''}
                ${sortOptions.length ? html`
                    <div class="ui-filter-sort">
                        <label class="sr-only" for="${id}-sort">${sort.label || t('ui.filter.sort')}</label>
                        <select class="select" id="${id}-sort" data-change="ui:filterSort">${sortOptions.map((s) => html`<option value="${s.key}"${String(value.sort || '') === String(s.key) ? html.raw(' selected') : ''}>${s.label}</option>`)}</select>
                    </div>` : ''}
            </div>
        `;
    },

    /** Tell the page, and the hash, what the filter is now. */
    _filterEmit(entry) {
        UI._mirrorToHash(entry.value, entry.hash);
        if (typeof entry.onChange !== 'function') return;
        try {
            entry.onChange(Object.assign({}, entry.value));
        } catch (err) {
            console.error('Filter change failed:', err);
            UI.toast(err && err.message ? err.message : t('common.error'), 'error');
        }
    },

    filterSearch(el) {
        const entry = UI._recall(el);
        if (!entry || entry.kind !== 'filter') return;
        entry.value = Object.assign({}, entry.value, { q: String(el.value || '') });
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.debounceMs > 0) {
            entry.timer = setTimeout(() => { entry.timer = null; UI._filterEmit(entry); }, entry.debounceMs);
        } else {
            UI._filterEmit(entry);
        }
    },

    filterChip(el) {
        const entry = UI._recall(el);
        if (!entry || entry.kind !== 'filter') return;
        entry.value = Object.assign({}, entry.value, { filter: String(el.getAttribute('data-key') || '') });
        UI._filterEmit(entry);
    },

    filterSort(el) {
        const entry = UI._recall(el);
        if (!entry || entry.kind !== 'filter') return;
        entry.value = Object.assign({}, entry.value, { sort: String(el.value || '') });
        UI._filterEmit(entry);
    },

    /**
     * Mirror `{ q, filter, sort }` into the hash's query when the router can read it back. The other
     * parameters of the hash are kept. `replaceState` does not fire `hashchange`, so nothing navigates.
     */
    _mirrorToHash(value, enabled) {
        if (enabled === false) return false;
        if (typeof App === 'undefined' || !App || typeof App.hashParams !== 'function') return false;
        try {
            const current = App.hashParams();
            const entries = current && typeof current.entries === 'function' ? Array.from(current.entries()) : Object.entries(current || {});
            const own = ['q', 'filter', 'sort'];
            const params = new URLSearchParams();
            for (const [k, v] of entries) {
                if (!own.includes(k) && v !== undefined && v !== null && v !== '') params.set(k, String(v));
            }
            for (const k of own) {
                if (value && value[k]) params.set(k, String(value[k]));
            }
            const hash = String(window.location.hash || '#/');
            const path = hash.split('?')[0];
            const query = params.toString();
            const next = query ? `${path}?${query}` : path;
            if (next !== hash) window.history.replaceState(window.history.state, '', next);
            return true;
        } catch {
            return false;
        }
    },

    // ─── Table and pager ─────────────────────────────────────────────────────
    /**
     * A table with sortable headers that becomes a list of cards on a phone (SH-33; DESIGN.md: tables become
     * `.log-cards` under 40rem). The same rows are drawn twice and CSS shows one, so a cell must not carry an id.
     *
     *   UI.table({
     *     id: 'jobs-table', caption: t('jobs.title'),
     *     columns: [
     *       { key: 'name', label, sortable: true },                           plain value, escaped, dir="auto"
     *       { key: 'status', label, render: (row) => statusPill(row), card: 'badge' },
     *       { key: 'when', label, sortable: true, sortValue: (row) => row.at, align: 'end' },
     *       { key: 'id', label, card: false },                                 left out of the card
     *     ],
     *     rows,
     *     sort: { key: 'when', dir: 'desc' },                                 or { …, server: true }: already sorted
     *     onSort: ({ key, dir }) => { sort = { key, dir }; render(); },
     *     empty: { icon, title, body, action } | SafeHtml | 'text',
     *   })
     *
     * Headers are buttons only when the column is `sortable` AND there is an `onSort`. The sorted column's
     * `th` carries `aria-sort` (the others `none`). Rows are sorted here unless `sort.server`, numbers as
     * numbers and text with the locale's collation; an empty value goes last in either direction.
     * In a card, the first column (or the ones marked `card: 'head'`) is the title, `card: 'badge'` sits at
     * its end (a status), and the rest are label and value pairs. `render(row, index)` returns SafeHtml; a
     * string is text. Only what a column renders can be markup, so a row value from the server cannot be.
     *
     * No rows draws `empty` alone, never a header over nothing. Say why it is empty: that is the caller's.
     */
    table(options) {
        const o = options || {};
        const id = String(o.id || `ui-table-${++UI._sharedSeq}`);
        const columns = (Array.isArray(o.columns) ? o.columns : []).filter((c) => c && c.key !== undefined && c.label !== undefined);
        const sort = o.sort && typeof o.sort === 'object' ? o.sort : null;
        const onSort = typeof o.onSort === 'function' ? o.onSort : null;
        const source = Array.isArray(o.rows) ? o.rows : [];
        if (onSort) UI._remember(id, { kind: 'table', sort, onSort });

        if (source.length === 0) {
            return html`<div class="ui-table ui-table--empty" data-ui-id="${id}">${UI._emptyMarkup(o.empty)}</div>`;
        }

        const rows = UI._sortRows(source, columns, sort);
        const head = columns.map((c) => {
            const interactive = !!c.sortable && !!onSort;
            const active = !!c.sortable && !!sort && sort.key === c.key;
            const ariaSort = active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : (interactive ? 'none' : '');
            const icon = active ? (sort.dir === 'desc' ? 'chevron-down' : 'chevron-up') : 'chevrons-up-down';
            const align = UI._ALIGN[c.align] || '';
            return html`<th scope="col"${ariaSort ? html` aria-sort="${ariaSort}"` : ''}${align ? html` class="${align}"` : ''}>${
                interactive
                    ? html`<button type="button" class="ui-sort" data-action="ui:tableSort" data-key="${c.key}">${c.label}<i data-lucide="${icon}" aria-hidden="true"></i></button>`
                    : c.label
            }</th>`;
        });
        const body = rows.map((row, i) => html`<tr>${columns.map((c) => UI._cell(c, row, i))}</tr>`);

        const inCard = columns.filter((c) => c.card !== false);
        let titleCols = inCard.filter((c) => c.card === 'head');
        if (titleCols.length === 0 && inCard.length > 0) titleCols = [inCard[0]];
        const badgeCols = inCard.filter((c) => c.card === 'badge' && !titleCols.includes(c));
        const fieldCols = inCard.filter((c) => !titleCols.includes(c) && !badgeCols.includes(c));
        const cards = rows.map((row, i) => html`
            <li class="log-card">
                <div class="log-card-head">
                    <span>${titleCols.map((c) => UI._cellContent(c, row, i))}</span>
                    ${badgeCols.length ? html`<span>${badgeCols.map((c) => UI._cellContent(c, row, i))}</span>` : ''}
                </div>
                ${fieldCols.length ? html`<dl class="ui-card-fields">${fieldCols.map((c) => html`<div class="ui-card-field"><dt class="text-meta">${c.label}</dt><dd>${UI._cellContent(c, row, i)}</dd></div>`)}</dl>` : ''}
            </li>
        `);

        return html`
            <div class="ui-table" data-ui-id="${id}">
                <div class="table-wrapper log-table">
                    <table class="data-table ui-table-grid">
                        ${o.caption ? html`<caption class="sr-only">${o.caption}</caption>` : ''}
                        <thead><tr>${head}</tr></thead>
                        <tbody>${body}</tbody>
                    </table>
                </div>
                <ul class="log-cards"${o.caption ? html` aria-label="${o.caption}"` : ''}>${cards}</ul>
            </div>
        `;
    },

    /** What a column shows for a row: its `render`, else the plain value (an em dash for nothing). */
    _cellContent(column, row, index) {
        if (typeof column.render === 'function') return column.render(row, index);
        const v = row ? row[column.key] : undefined;
        return v === null || v === undefined || v === '' ? '—' : v;
    },

    _cell(column, row, index) {
        const own = typeof column.render === 'function';
        const classes = [UI._ALIGN[column.align] || '', column.className || ''].filter(Boolean).join(' ');
        return html`<td${classes ? html` class="${classes}"` : ''}${own ? '' : html.raw(' dir="auto"')}>${UI._cellContent(column, row, index)}</td>`;
    },

    /** `empty` as markup: a SafeHtml as it is, an object as an empty state, a string as a line. Never nothing. */
    _emptyMarkup(empty) {
        if (empty instanceof SafeHtml) return empty;
        if (empty && typeof empty === 'object') return UI.emptyState(empty);
        return html`<p class="table-empty-cell">${typeof empty === 'string' && empty ? empty : t('ui.table.empty')}</p>`;
    },

    /** The rows in `sort` order: stable, numbers as numbers, text by the locale, empty values last either way. */
    _sortRows(rows, columns, sort) {
        const column = sort ? columns.find((c) => c.sortable && c.key === sort.key) : null;
        if (!column || sort.server) return rows;
        const read = (row) => (typeof column.sortValue === 'function' ? column.sortValue(row) : (row ? row[column.key] : undefined));
        const sign = sort.dir === 'desc' ? -1 : 1;
        let collator = null;
        try { collator = new Intl.Collator(I18N.locale(), { numeric: true, sensitivity: 'base' }); } catch { /* compared as text below */ }
        const empty = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));
        // By tag, not `instanceof`: a Date made in another frame is still a date.
        const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';
        return rows.map((row, index) => ({ row, index, value: read(row) })).sort((a, b) => {
            const ea = empty(a.value);
            const eb = empty(b.value);
            if (ea || eb) return ea && eb ? a.index - b.index : (ea ? 1 : -1);
            let order;
            if (typeof a.value === 'number' && typeof b.value === 'number') order = a.value - b.value;
            else if (isDate(a.value) && isDate(b.value)) order = a.value.getTime() - b.value.getTime();
            else {
                const x = String(a.value);
                const y = String(b.value);
                order = collator ? collator.compare(x, y) : (x < y ? -1 : x > y ? 1 : 0);
            }
            return order === 0 ? a.index - b.index : order * sign;
        }).map((x) => x.row);
    },

    /** A header was pressed: the same column flips direction, a new one starts ascending. */
    tableSort(el) {
        const entry = UI._recall(el);
        const key = el.getAttribute('data-key');
        if (!entry || entry.kind !== 'table' || !key || typeof entry.onSort !== 'function') return;
        const dir = entry.sort && entry.sort.key === key && entry.sort.dir !== 'desc' ? 'desc' : 'asc';
        entry.onSort({ key, dir });
    },

    /**
     * Page navigation, drawn the way Activity draws it. `total` is the number of PAGES. Nothing is drawn for
     * one page or none. The buttons have stable ids (`<id>-prev`, `<id>-next`) because they are what a keyboard
     * user is holding when the list is rebuilt under them.
     *
     *   UI.pager({ id: 'jobs-pager', page: 2, total: 9, onPage: (n) => { page = n; load(); } })
     */
    pager(options) {
        const o = options || {};
        const total = Math.max(0, Math.floor(Number(o.total) || 0));
        if (total <= 1) return '';
        const page = Math.min(Math.max(1, Math.floor(Number(o.page) || 1)), total);
        const id = String(o.id || `ui-pager-${++UI._sharedSeq}`);
        UI._remember(id, { kind: 'pager', total, onPage: o.onPage });
        return html`
            <nav class="pagination" aria-label="${o.label || t('ui.pager.label')}" data-ui-id="${id}">
                <button type="button" class="page-btn" id="${id}-prev"${page <= 1 ? html.raw(' disabled') : ''}
                        data-action="ui:pagerGo" data-page="${page - 1}">
                    <i data-lucide="chevron-left" aria-hidden="true"></i> ${t('ui.pager.prev')}
                </button>
                <span class="page-position">${t('ui.pager.position', { page: UI.formatNumber(page), total: UI.formatNumber(total) })}</span>
                <button type="button" class="page-btn" id="${id}-next"${page >= total ? html.raw(' disabled') : ''}
                        data-action="ui:pagerGo" data-page="${page + 1}">
                    ${t('ui.pager.next')} <i data-lucide="chevron-right" aria-hidden="true"></i>
                </button>
            </nav>
        `;
    },

    pagerGo(el) {
        const entry = UI._recall(el);
        const n = Number(el.getAttribute('data-page'));
        if (!entry || entry.kind !== 'pager' || typeof entry.onPage !== 'function') return;
        if (Number.isInteger(n) && n >= 1 && n <= entry.total) entry.onPage(n);
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

// ─── Shared patterns (UX foundation): their delegated handlers ───────────────────────────────────────────
// Every method is defined in the "Shared patterns" section of `UI` above; these are the names markup can call.
UI.registerActions('ui', {
    runConfirm: (el) => UI.runConfirm(el),
    gateConfirm: (el) => UI.gateConfirm(el),
    cancelConfirm: () => UI.cancelConfirm(),
    tabsKey: (el, event) => UI.tabsKey(el, event),
    filterSearch: (el) => UI.filterSearch(el),
    filterChip: (el) => UI.filterChip(el),
    filterSort: (el) => UI.filterSort(el),
    tableSort: (el) => UI.tableSort(el),
    pagerGo: (el) => UI.pagerGo(el),
    secretReplace: (el) => UI.secretReplace(el),
    secretCancel: (el) => UI.secretCancel(el),
    secretSave: (el) => UI.secretSave(el),
    secretGenerate: (el) => UI.secretGenerate(el),
    secretCopy: (el) => UI.secretCopy(el),
    secretRemove: (el) => UI.secretRemove(el),
});

// One set of delegated listeners for the whole dashboard.
document.addEventListener('click', (e) => UI._dispatch(e, 'data-action'));
document.addEventListener('change', (e) => UI._dispatch(e, 'data-change'));
document.addEventListener('input', (e) => UI._dispatch(e, 'data-input'));
document.addEventListener('submit', (e) => UI._dispatch(e, 'data-submit'));
// Arrow keys between tabs (`data-keydown="ui:tabsKey"`).
document.addEventListener('keydown', (e) => UI._dispatch(e, 'data-keydown'));

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
