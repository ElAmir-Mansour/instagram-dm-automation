/**
 * Shared UI foundation — HTML escaping, toasts, modals, formatting, delegated events.
 *
 * ─── Escaping contract ───────────────────────────────────────────────────────
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
    /** One locale for every date in the app, independent of browser locale. */
    LOCALE: 'en-US',

    _modalSeq: 0,
    _lastFocus: null,
    _onModalKeydown: null,
    _actions: Object.create(null),

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
    toast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const icon = type === 'success' ? 'check-circle' : 'alert-circle';
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        const iconEl = document.createElement('i');
        iconEl.setAttribute('data-lucide', icon);
        const span = document.createElement('span');
        span.textContent = message === null || message === undefined ? '' : String(message);
        toast.appendChild(iconEl);
        toast.appendChild(span);
        container.appendChild(toast);
        UI.icons(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    },

    // ─── Modal ───────────────────────────────────────────────────────────────
    showModal(markup) {
        const overlay = document.getElementById('modal-overlay');
        const content = document.getElementById('modal-content');
        if (!overlay || !content) return;

        if (!overlay.classList.contains('hidden')) {
            // Replacing an open modal — keep the focus we stashed the first time.
        } else {
            UI._lastFocus = document.activeElement;
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

        const focusables = UI._focusables(content);
        const preferred = content.querySelector(
            'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])'
        );
        (preferred || focusables.find((el) => !el.classList.contains('modal-close')) || content).focus();

        overlay.onclick = (e) => { if (e.target === overlay) UI.closeModal(); };

        if (UI._onModalKeydown) document.removeEventListener('keydown', UI._onModalKeydown, true);
        UI._onModalKeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                UI.closeModal();
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

    closeModal() {
        const overlay = document.getElementById('modal-overlay');
        if (!overlay) return;
        overlay.classList.add('hidden');
        overlay.onclick = null;
        if (UI._onModalKeydown) {
            document.removeEventListener('keydown', UI._onModalKeydown, true);
            UI._onModalKeydown = null;
        }
        const restore = UI._lastFocus;
        UI._lastFocus = null;
        if (restore && document.contains(restore) && typeof restore.focus === 'function') {
            restore.focus();
        }
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
            title = 'Could not load this page',
            message = 'Unexpected error.',
            hint = '',
            icon = 'alert-circle',
        } = options || {};

        container.innerHTML = esc(html`
            <div class="error-panel glass-card" role="alert">
                <div class="error-panel-icon"><i data-lucide="${icon}"></i></div>
                <h3>${title}</h3>
                <p class="error-panel-message">${message}</p>
                ${hint ? html`<p class="error-panel-hint">${hint}</p>` : ''}
                <button type="button" class="btn btn-secondary btn-sm" data-retry-btn>
                    <i data-lucide="rotate-cw"></i> Retry
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

    /** Inline (non page-replacing) error strip, e.g. inside a modal. */
    errorStrip(message, hint) {
        return html`
            <div class="inline-error" role="alert">
                <i data-lucide="alert-circle"></i>
                <div>
                    <strong>${message}</strong>
                    ${hint ? html`<span class="inline-error-hint">${hint}</span>` : ''}
                </div>
            </div>
        `;
    },

    /**
     * A sender username comes straight off Meta — it is the exact field an
     * attacker controls by renaming their profile, so it is escaped as text and
     * percent-encoded before it goes anywhere near a URL.
     */
    userCell(interaction) {
        const username = interaction.sender_username || '';
        const isFacebook = interaction.platform === 'facebook';
        const badge = isFacebook
            ? html`<span class="platform-badge fb">FB</span>`
            : html`<span class="platform-badge ig">IG</span>`;
        if (isFacebook || !username) {
            return html`<span class="username-link" dir="auto">@${username || '—'}</span>${badge}`;
        }
        return html`<a href="https://instagram.com/${html.raw(encodeURIComponent(username))}"
                       target="_blank" rel="noopener noreferrer"
                       class="username-link" dir="auto">@${username}</a>${badge}`;
    },

    // ─── System status badge ────────────────────────────────────────────────
    /** Driven by real API outcomes (see api.js), not hardcoded in the markup. */
    setSystemStatus(state) {
        const el = document.getElementById('status-indicator');
        if (!el) return;
        const label = el.querySelector('[data-status-label]');
        const map = {
            online: { cls: 'status-online', text: 'System Online' },
            degraded: { cls: 'status-degraded', text: 'Server Errors' },
            offline: { cls: 'status-offline', text: 'Cannot Reach Server' },
        };
        const next = map[state] || map.online;
        el.className = `status-badge ${next.cls}`;
        if (label) label.textContent = next.text;
        el.setAttribute('aria-label', next.text);
    },

    // ─── Dates ───────────────────────────────────────────────────────────────
    /** "Mar 4, 09:30" — used for every timestamp in tables and cards. */
    formatDate(iso) {
        const d = UI._date(iso);
        if (!d) return '—';
        return d.toLocaleDateString(UI.LOCALE, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    },

    /** "Mar 4, 2026, 09:30" — full stamp for scheduled posts. */
    formatDateTime(iso) {
        const d = UI._date(iso);
        if (!d) return '—';
        return d.toLocaleString(UI.LOCALE, {
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    },

    /** "Mar 4, 2026" */
    formatDay(iso) {
        const d = UI._date(iso);
        if (!d) return '—';
        return d.toLocaleDateString(UI.LOCALE, { year: 'numeric', month: 'short', day: 'numeric' });
    },

    /** "09:30" */
    formatTime(iso) {
        const d = UI._date(iso);
        if (!d) return '';
        return d.toLocaleTimeString(UI.LOCALE, { hour: '2-digit', minute: '2-digit' });
    },

    /**
     * "3d ago" plus a severity, for the columns where the operator has to see
     * that something is broken without doing date arithmetic in their head.
     * Returns { text, level: 'fresh' | 'warn' | 'stale', title }.
     */
    relativeAge(value, options) {
        const { warnMs = 6 * 60 * 60 * 1000, staleMs = 24 * 60 * 60 * 1000, neverText = 'Never' } = options || {};
        const d = UI._date(value);
        if (!d) return { text: neverText, level: 'stale', title: 'Nothing recorded yet.' };

        const diff = Date.now() - d.getTime();
        const abs = Math.abs(diff);
        const minute = 60000;
        const hour = 60 * minute;
        const day = 24 * hour;

        let text;
        if (abs < minute) text = 'just now';
        else if (abs < hour) text = `${Math.floor(abs / minute)}m`;
        else if (abs < day) text = `${Math.floor(abs / hour)}h`;
        else text = `${Math.floor(abs / day)}d`;
        if (abs >= minute) text = diff < 0 ? `in ${text}` : `${text} ago`;

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

    // ─── Misc ────────────────────────────────────────────────────────────────
    animateCounter(el, target, duration = 1200) {
        if (!el) return;
        const value = Number(target) || 0;
        let start = 0;
        const step = (timestamp) => {
            if (!start) start = timestamp;
            const progress = Math.min((timestamp - start) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = Math.floor(eased * value).toLocaleString(UI.LOCALE);
            if (progress < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    },

    loader(label = 'Loading…') {
        return esc(html`<div class="loader" role="status" aria-live="polite">
            <div class="spinner"></div><span class="sr-only">${label}</span>
        </div>`);
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
            UI.toast(err && err.message ? err.message : 'Something went wrong.', 'error');
        }
    },
};

UI.registerActions('ui', {
    closeModal: () => UI.closeModal(),
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
