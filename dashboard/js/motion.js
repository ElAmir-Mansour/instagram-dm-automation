/**
 * Motion — the interaction layer.
 *
 * `tokens.css` owns the *values* (durations, easings) and already collapses
 * every `--motion-*` token to 1ms under `prefers-reduced-motion: reduce`.
 * Everything in this file is therefore expressed in those tokens, or asks
 * `Motion.reduced()` before animating in JS, so the OS setting is honoured in
 * exactly one place instead of thirty.
 *
 * Five things live here:
 *
 * 1.  VIEW TRANSITIONS. `Motion.transition(update)` runs a DOM mutation inside
 *     `document.startViewTransition()` where the browser has it (same-document
 *     transitions are Baseline since October 2025 — Chrome 111, Safari 18,
 *     Firefox 144) and runs it directly everywhere else. The fallback is not a
 *     polyfill: it is the current behaviour, unchanged.
 *
 *     The transition is a cross-fade plus a small VERTICAL rise. Nothing slides
 *     horizontally, because a slide that reads as "forward" in Arabic reads as
 *     "back" in English and this app ships both. Vertical motion is the only
 *     direction that means the same thing in an RTL and an LTR document.
 *
 * 2.  LOADING GATES. A skeleton that is painted and replaced inside 100ms reads
 *     as a flicker, not as speed (NN/g's 2025 guidance puts the break-even for
 *     a skeleton over blank space at ~500ms; the 300ms floor for showing *any*
 *     loading state is the widely-cited number). `Motion.beginLoad()` therefore
 *     schedules the skeleton instead of painting it, and `gate.done()` cancels
 *     it if the data won a race it usually wins. Page NAVIGATION is the one
 *     exception: `App.navigate` paints the skeleton immediately, because there
 *     the alternative is not blank space, it is the previous page's content
 *     vanishing.
 *
 * 3.  SKELETONS. Shapes, not spinners — and shapes that match the real layout
 *     row-for-row, so the content that lands does not move anything.
 *
 * 4.  SCHEDULING. `debounce` for per-keystroke work that must not be on the
 *     typing path, `coalesce` for "at most once per frame", `idle` for work
 *     that can wait for a gap.
 *
 * 5.  KEYED LIST PATCHING. `Motion.patchList()` updates a list in place:
 *     unchanged rows are not touched, moved rows are moved with `moveBefore()`
 *     where it exists (Chrome 133+) so focus survives the move, and nothing
 *     ever replaces a scroll container's `innerHTML`. This is what makes the
 *     inbox's 5-second poll invisible.
 */
const Motion = {

    // ─── Reduced motion ─────────────────────────────────────────────────────
    _reducedQuery: null,

    /** Live, not cached at boot: the operator can flip the OS setting mid-session. */
    reduced() {
        try {
            if (!Motion._reducedQuery && window.matchMedia) {
                Motion._reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
            }
            return !!(Motion._reducedQuery && Motion._reducedQuery.matches);
        } catch {
            return false;
        }
    },

    // ─── View transitions ───────────────────────────────────────────────────
    supportsViewTransitions() {
        return typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
    },

    /**
     * Run `update` as a view transition, or just run it.
     *
     * Resolves when the DOM is updated — NOT when the animation finishes — so
     * callers can get on with fetching. `html.is-transitioning` is set for the
     * duration so JS-driven CSS transitions (the nav indicator) can stand down
     * and let the browser morph their snapshots instead of animating twice.
     */
    transition(update) {
        if (typeof update !== 'function') return Promise.resolve();
        if (!Motion.supportsViewTransitions() || Motion.reduced()) {
            try { update(); } catch (err) { console.error('Transition update failed:', err); }
            return Promise.resolve();
        }

        const root = document.documentElement;
        let vt;
        try {
            root.classList.add('is-transitioning');
            vt = document.startViewTransition(() => { update(); });
        } catch (err) {
            // Any refusal (an overlapping transition, a named-element clash)
            // must never cost the user the navigation itself.
            root.classList.remove('is-transitioning');
            console.warn('View transition refused, updating directly:', err);
            try { update(); } catch (inner) { console.error('Transition update failed:', inner); }
            return Promise.resolve();
        }

        // `vt.ready` rejects when a transition is superseded — which rapid navigation does
        // routinely. Nothing is wrong: `update()` still ran and `finished` still settles. But
        // an unhandled rejection here logs a permanent AbortError that masks real errors.
        if (vt.ready && typeof vt.ready.catch === 'function') vt.ready.catch(() => {});

        const clear = () => root.classList.remove('is-transitioning');
        if (vt.finished && typeof vt.finished.then === 'function') {
            vt.finished.then(clear, clear);
        } else {
            clear();
        }
        return vt.updateCallbackDone.then(() => undefined, (err) => {
            console.error('Transition update failed:', err);
        });
    },

    // ─── Loading gates ──────────────────────────────────────────────────────
    /** Containers currently showing a skeleton that a gate has not yet cleared. */
    _skeletons: new WeakSet(),

    /**
     * Declare that `container` is already showing its skeleton — used by
     * `App.navigate`, which paints it inside the view transition so the page
     * swap is one motion instead of two.
     */
    markSkeleton(container) {
        if (container) Motion._skeletons.add(container);
    },

    isSkeleton(container) {
        return !!container && Motion._skeletons.has(container);
    },

    /**
     * For a page that fills the skeleton it was given in place instead of
     * replacing it — the Overview, whose four regions arrive separately — so a
     * later `beginLoad()` on the same container does not think a skeleton is
     * still up.
     */
    clearSkeleton(container) {
        if (container) Motion._skeletons.delete(container);
    },

    /**
     * Schedule a skeleton for `container` unless one is already up.
     * Returns a handle whose `done()` cancels the pending paint; call it before
     * writing real content, on every path including the error one.
     */
    beginLoad(container, markup, options) {
        const { delay = 150 } = options || {};
        if (!container) return { done() {} };

        if (Motion._skeletons.has(container)) {
            return { done() { Motion._skeletons.delete(container); } };
        }

        let timer = setTimeout(() => {
            timer = null;
            try {
                container.innerHTML = esc(typeof markup === 'function' ? markup() : markup);
                Motion._skeletons.add(container);
                UI.icons(container);
            } catch (err) {
                console.warn('Skeleton render failed:', err);
            }
        }, delay);

        return {
            done() {
                if (timer) { clearTimeout(timer); timer = null; }
                Motion._skeletons.delete(container);
            },
        };
    },

    // ─── Skeletons ──────────────────────────────────────────────────────────
    /**
     * Widths come from a fixed set of classes rather than an interpolated
     * `style` attribute: `esc()` is correct for a quoted attribute, but a
     * hand-built inline style is a position worth not having at all.
     */
    _WIDTHS: { xs: 'skel-w-xs', sm: 'skel-w-sm', md: 'skel-w-md', lg: 'skel-w-lg', full: 'skel-w-full' },

    line(width) {
        const cls = Motion._WIDTHS[width] || Motion._WIDTHS.full;
        return html`<span class="skel skel-line ${html.raw(cls)}"></span>`;
    },

    _times(n, fn) {
        const out = [];
        const count = Math.max(0, Math.min(Number(n) || 0, 60));
        for (let i = 0; i < count; i++) out.push(fn(i));
        return out;
    },

    /**
     * Skeletons are built from the REAL component classes — `.stat-card`,
     * `.data-table`, `.chart-card` — with skeleton lines standing in for the
     * text. That is what makes them the right height: the box comes from the
     * component, not from the skeleton, so when the data lands and the text
     * replaces the lines, nothing above or below it moves.
     */
    statsGrid(count) {
        return html`
            <div class="stats-grid" aria-hidden="true">
                ${Motion._times(count || 4, () => html`
                    <div class="stat-card surface">
                        <div class="stat-header"><span class="stat-label">${Motion.line('lg')}</span></div>
                        <p class="stat-value">${Motion.line('sm')}</p>
                        <p class="stat-sub">${Motion.line('md')}</p>
                    </div>
                `)}
            </div>
        `;
    },

    /** `rows` matches the page's own page size, so the table height is final. */
    tableRows(rows, cols) {
        const columns = Math.max(1, Math.min(Number(cols) || 4, 12));
        return html`
            <tbody aria-hidden="true">
                ${Motion._times(rows || 8, () => html`
                    <tr>
                        ${Motion._times(columns, (c) => html`<td>${Motion.line(c === 0 ? 'md' : 'sm')}</td>`)}
                    </tr>
                `)}
            </tbody>
        `;
    },

    tableCard(rows, headers) {
        const cols = Array.isArray(headers) ? headers : [];
        return html`
            <div class="table-card surface">
                <div class="table-wrapper">
                    <table class="data-table">
                        <thead><tr>${cols.map((label) => html`<th scope="col">${label}</th>`)}</tr></thead>
                        ${Motion.tableRows(rows, cols.length || 4)}
                    </table>
                </div>
            </div>
        `;
    },

    cardGrid(count, lines) {
        return html`
            <div class="card-grid" aria-hidden="true">
                ${Motion._times(count || 4, () => html`
                    <div class="surface skel-card skel-card-tall skel-stack">
                        <span>${Motion.line('sm')}</span>
                        ${Motion._times(lines || 3, () => html`<span>${Motion.line('full')}</span>`)}
                        <span>${Motion.line('md')}</span>
                    </div>
                `)}
            </div>
        `;
    },

    chartGrid(count) {
        return html`
            <div class="chart-grid" aria-hidden="true">
                ${Motion._times(count || 2, () => html`
                    <div class="chart-card surface">
                        <div class="chart-card-header"><span class="chart-card-title">${Motion.line('lg')}</span></div>
                        <!-- Sized to the SVG charts that replace this, not to the 260px
                             canvas it used to reserve. A skeleton taller than its content
                             makes the whole page jump upward the moment data lands, which
                             is worse than no skeleton. -->
                        <div class="chart-skel"><span class="skel skel-block"></span></div>
                    </div>
                `)}
            </div>
        `;
    },

    toolbar() {
        return html`
            <div class="page-toolbar" aria-hidden="true">
                <p class="page-toolbar-count">${Motion.line('full')}</p>
                <div class="toolbar-actions"><span class="skel skel-btn"></span></div>
            </div>
        `;
    },

    threadRows(count) {
        return html`
            <div aria-hidden="true">
                ${Motion._times(count || 7, () => html`
                    <div class="thread-item skel-thread">
                        <span class="thread-top"><span class="thread-name">${Motion.line('full')}</span></span>
                        <span class="thread-preview">${Motion.line('full')}</span>
                    </div>
                `)}
            </div>
        `;
    },

    /**
     * The one skeleton a screen reader should hear, because it is the page's
     * whole answer and it is worth announcing when it arrives. Everything else
     * is `aria-hidden` — a skeleton has no content to read out.
     */
    busy(label) {
        return html`<span class="sr-only" role="status" aria-live="polite">${label || t('common.loading')}</span>`;
    },

    /**
     * The other half of `busy()`: say that the wait is OVER.
     *
     * `busy()` announces "loading" and then the skeleton is replaced by the
     * real content in silence — a screen-reader user is told the page started
     * and never told it finished. This cannot be solved from inside the page
     * markup, because the live region that would carry the message is itself
     * destroyed by the same `innerHTML` write that lands the content: a live
     * region only announces changes to a region that was ALREADY in the
     * accessibility tree.
     *
     * So there is exactly one permanent region, outside `#page-container`,
     * and pages write their arrival into it — a count where they have one
     * ("15 results", "8 campaigns"), which is more use than "loaded".
     */
    _announcer: null,

    announcer() {
        if (Motion._announcer && document.contains(Motion._announcer)) return Motion._announcer;
        let el = document.getElementById('motion-announcer');
        if (!el) {
            el = document.createElement('div');
            el.id = 'motion-announcer';
            el.className = 'sr-only';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            document.body.appendChild(el);
        }
        Motion._announcer = el;
        return el;
    },

    /**
     * A zero-width space (U+200B), written as a code point rather than as an
     * escape so that nothing invisible is ever pasted into this file.
     */
    _NUDGE: String.fromCharCode(0x200B),

    announce(message) {
        const text = message === null || message === undefined ? '' : String(message);
        if (!text) return;
        const el = Motion.announcer();
        // Identical consecutive text is not a CHANGE, so it is not announced.
        // The nudge makes the second one a change without being audible or
        // visible — paging twice to the same count still says it twice.
        el.textContent = el.textContent === text ? text + Motion._NUDGE : text;
    },

    // ─── Scheduling ─────────────────────────────────────────────────────────
    /**
     * Trailing debounce. Used for per-keystroke work heavy enough to be felt:
     * the campaign keyword inspector (which runs the webhook's own Arabic
     * normalisation against a 60-word corpus per keyword) and the media-URL
     * preview (which starts an image load).
     */
    debounce(fn, ms) {
        let timer = null;
        const wait = Number(ms) || 150;
        const wrapped = function (...args) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; fn.apply(this, args); }, wait);
        };
        wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
        return wrapped;
    },

    /** At most once per frame, with the latest arguments. */
    coalesce(fn) {
        let handle = null;
        let pending = null;
        return function (...args) {
            pending = args;
            if (handle !== null) return;
            handle = requestAnimationFrame(() => {
                handle = null;
                const next = pending;
                pending = null;
                fn.apply(this, next || []);
            });
        };
    },

    /**
     * Work that can wait for a gap. `scheduler.postTask` where it exists,
     * `requestIdleCallback` next (absent in Safari), `setTimeout` last.
     */
    idle(fn, timeout) {
        const ms = Number(timeout) || 500;
        try {
            if (window.scheduler && typeof window.scheduler.postTask === 'function') {
                window.scheduler.postTask(fn, { priority: 'background' });
                return;
            }
            if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(fn, { timeout: ms });
                return;
            }
        } catch { /* fall through */ }
        setTimeout(fn, 0);
    },

    // ─── Keyed list patching ────────────────────────────────────────────────
    /**
     * Reconcile `container`'s children against `items` without replacing the
     * container's contents.
     *
     *   key(item)        → stable identity
     *   signature(item)  → changes only when the row's visible content changes
     *   create()         → an empty row element
     *   update(el, item) → write the row's attributes and inner markup
     *
     * `update` runs only for rows whose signature moved, so a poll that changes
     * nothing touches no DOM at all: no reflow, no scroll reset, no flash.
     * Moves use `moveBefore()` where available (Chrome 133+), which is an
     * atomic move rather than a remove-then-insert and therefore keeps focus,
     * running animations and pointer capture on the row.
     */
    patchList(container, items, opts) {
        if (!container || !opts) return 0;

        const existing = new Map();
        Array.from(container.children).forEach((el) => {
            const k = el.dataset ? el.dataset.rowKey : null;
            if (k === undefined || k === null) el.remove();
            else existing.set(k, el);
        });

        const active = document.activeElement;
        const hadFocus = !!active && container.contains(active);
        const focusedRow = hadFocus && active.closest ? active.closest('[data-row-key]') : null;

        const wanted = [];
        items.forEach((item) => {
            const k = String(opts.key(item));
            let el = existing.get(k);
            if (el) {
                existing.delete(k);
            } else {
                el = opts.create();
                el.dataset.rowKey = k;
                el.dataset.rowSig = '\u0000'; // never equal to a real signature
            }
            const sig = String(opts.signature(item));
            if (el.dataset.rowSig !== sig) {
                opts.update(el, item);
                el.dataset.rowSig = sig;
                UI.icons(el);
            }
            wanted.push(el);
        });

        /**
         * If the row holding focus is one of the rows about to go, focus has
         * nowhere to land and the browser drops it to `<body>`.
         *
         * In the inbox this is not an edge case: the 5-second poll and every
         * search keystroke re-filter the list, so a keyboard user who has
         * arrowed down to a conversation gets thrown to the top of the
         * document in the middle of reading it. Remember where the row WAS and
         * hand focus to whichever row takes that position.
         */
        let orphanIndex = -1;
        if (focusedRow && focusedRow.parentNode === container && existing.has(focusedRow.dataset.rowKey)
            && existing.get(focusedRow.dataset.rowKey) === focusedRow) {
            orphanIndex = Array.prototype.indexOf.call(container.children, focusedRow);
        }

        existing.forEach((el) => el.remove());

        const canMove = typeof container.moveBefore === 'function';
        let ref = container.firstElementChild;
        wanted.forEach((el) => {
            if (el === ref) { ref = ref.nextElementSibling; return; }
            if (canMove && el.isConnected && el.parentNode === container) {
                try { container.moveBefore(el, ref); return; } catch { /* fall through */ }
            }
            container.insertBefore(el, ref);
        });

        // insertBefore() on a connected node is a remove-then-insert, which
        // blurs it. moveBefore() does not, but it is not everywhere yet.
        if (hadFocus && document.activeElement !== active
            && active && container.contains(active) && typeof active.focus === 'function') {
            active.focus({ preventScroll: true });
        } else if (orphanIndex >= 0 && wanted.length > 0) {
            const heir = wanted[Math.min(orphanIndex, wanted.length - 1)];
            const target = Motion._firstFocusable(heir);
            if (target) target.focus({ preventScroll: true });
        }

        return wanted.length;
    },

    /** The row element itself when it is focusable, else its first control. */
    _firstFocusable(row) {
        if (!row) return null;
        if (typeof row.focus === 'function' && !row.disabled
            && (row.tabIndex >= 0 || /^(a|button|input|select|textarea)$/i.test(row.tagName))) {
            return row;
        }
        return row.querySelector('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    },

    // ─── Optimistic mutations ───────────────────────────────────────────────
    /**
     * Apply `apply()` now, send `send()`, and run `revert()` if the server says
     * no. The UI is allowed to be ahead of the server; it is never allowed to
     * stay wrong.
     *
     * `revert` gets the error so it can decide how loudly to fail. Returns the
     * settled result so callers can chain a reconcile.
     */
    async optimistic({ apply, send, revert, onError }) {
        if (typeof apply === 'function') apply();
        try {
            return await send();
        } catch (err) {
            try { if (typeof revert === 'function') revert(err); } catch (e) { console.error('Rollback failed:', e); }
            if (typeof onError === 'function') onError(err);
            else UI.toast((err && err.message) || t('common.error'), 'error');
            return null;
        }
    },
};
